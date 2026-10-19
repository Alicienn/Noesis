import type { ModelRef } from '../../shared/types.ts'
import { run } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { tokenTotals } from '../store/usage.ts'
import { errorMessage, now, sleep } from '../core/util.ts'
import { anthropicChat } from './anthropic.ts'
import { openaiChat, openaiEmbed } from './openai.ts'
import { resolveModel } from './providers.ts'
import type { ResolvedModel } from './providers.ts'
import { LlmHttpError } from './types.ts'
import type { LlmRequest, LlmResult, LlmStreamHandlers } from './types.ts'

export interface ChatOptions extends Omit<LlmRequest, 'model'> {
  /** For usage accounting. */
  projectId?: string
  agentId?: string
  /** Called before each retry so the UI can show it. */
  onRetry?: (attempt: number, error: string, delayMs: number) => void
  retries?: number
}

export class ModelNotConfiguredError extends Error {}

/** Reasoning models may think silently for minutes before the first token. */
const FIRST_OUTPUT_TIMEOUT_MS = 15 * 60_000
const STALL_TIMEOUT_MS = 5 * 60_000

export function requireModel(ref: ModelRef | undefined, purpose: string): ResolvedModel {
  const resolved = resolveModel(ref)
  if (!resolved) {
    throw new ModelNotConfiguredError(
      `Aucun modèle configuré pour « ${purpose} ». Ajoute un provider et choisis un modèle dans Paramètres → Modèles.`,
    )
  }
  return resolved
}

/**
 * One LLM call with streaming, protocol dispatch, exponential backoff on
 * transient failures (429/5xx/network) and usage accounting.
 */
export async function chat(resolved: ResolvedModel, options: ChatOptions, handlers: LlmStreamHandlers = {}): Promise<LlmResult> {
  const { provider, model } = resolved
  const request: LlmRequest = { ...options, model: model.id }
  // Some endpoints default to a tiny output budget (4k): long reports and tool
  // arguments would be cut. Ask for a generous budget; adaptBody() lowers it
  // automatically if the endpoint refuses.
  if (!request.maxTokens) request.maxTokens = model.maxTokens ? Math.min(model.maxTokens, 32_000) : 16_384
  const retries = options.retries ?? 5
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new Error('aborted')
    let emitted = false
    // Watchdog: a stream that stops sending data without closing would hang the
    // agent forever. Abort it (and retry) after a long silence.
    const attemptCtl = new AbortController()
    const onOuterAbort = (): void => attemptCtl.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    let stalled = false
    let watchdog: NodeJS.Timeout | undefined
    const arm = (ms: number): void => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        stalled = true
        attemptCtl.abort()
      }, ms)
    }
    arm(FIRST_OUTPUT_TIMEOUT_MS)
    const alive = (): void => {
      emitted = true
      arm(STALL_TIMEOUT_MS)
    }
    const guarded: LlmStreamHandlers = {
      onText: d => {
        alive()
        handlers.onText?.(d)
      },
      onReasoning: d => {
        alive()
        handlers.onReasoning?.(d)
      },
      onToolCallDelta: (i, n, a) => {
        alive()
        handlers.onToolCallDelta?.(i, n, a)
      },
    }
    try {
      const attemptRequest = { ...request, signal: attemptCtl.signal }
      const result = provider.protocol === 'anthropic'
        ? await anthropicChat(provider, attemptRequest, guarded)
        : await openaiChat(provider, attemptRequest, guarded)
      if (options.projectId) {
        run(
          'INSERT INTO usage (project_id, agent_id, model, prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          options.projectId,
          options.agentId ?? '',
          resolved.ref,
          result.usage.promptTokens,
          result.usage.completionTokens,
          result.usage.cachedTokens ?? 0,
          result.usage.cacheWriteTokens ?? 0,
          now(),
        )
        // every call (supervisor, verifier, utility…) refreshes the live counters, not only lead steps
        const event = {
          type: 'tokens' as const,
          projectId: options.projectId,
          agentId: options.agentId ?? '',
          totals: tokenTotals(options.projectId),
          call: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, cachedTokens: result.usage.cachedTokens ?? 0, cacheWriteTokens: result.usage.cacheWriteTokens ?? 0, calls: 1 },
        }
        bus.publish(options.projectId, event)
        bus.publish('*', event) // project cards on the home page
      }
      return result
    } catch (error) {
      lastError = stalled ? new Error(`${provider.name} : flux muet depuis trop longtemps, appel relancé`) : error
      if (options.signal?.aborted) throw error
      const transient = stalled || (error instanceof LlmHttpError ? error.retryable : isNetworkError(error))
      // A stream that already produced output and then broke is retried too —
      // the caller discards partial output on retry.
      if (!transient || attempt === retries) break
      const delay = Math.min(60_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 500)
      options.onRetry?.(attempt + 1, errorMessage(lastError) + (emitted ? ' (flux interrompu)' : ''), delay)
      await sleep(delay, options.signal)
    } finally {
      clearTimeout(watchdog)
      options.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function isNetworkError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase()
  return /fetch failed|econnreset|etimedout|socket|network|terminated|other side closed|und_err/.test(msg)
}

/** Convenience: non-streaming single answer as text. */
export async function complete(resolved: ResolvedModel, options: ChatOptions): Promise<string> {
  const result = await chat(resolved, options)
  return result.content.trim()
}

export async function embed(ref: ModelRef, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const resolved = requireModel(ref, 'embeddings')
  if (resolved.provider.protocol !== 'openai') throw new Error('Les embeddings nécessitent un endpoint OpenAI-compatible')
  return openaiEmbed(resolved.provider, resolved.model.id, inputs, signal)
}
