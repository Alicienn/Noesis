import type { ProviderConfig, ToolCall } from '../../shared/types.ts'
import { readSse } from './sse.ts'
import { LlmHttpError } from './types.ts'
import type { LlmMessage, LlmRequest, LlmResult, LlmStreamHandlers, LlmUsage } from './types.ts'

/** Anthropic Messages API (and compatible gateways). */

export function anthropicUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  return /\/v1$/.test(b) ? `${b}/${path}` : `${b}/v1/${path}`
}

export function anthropicHeaders(provider: ProviderConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {}),
    ...(provider.headers ?? {}),
  }
}

const EFFORT_BUDGET = { low: 4000, medium: 12000, high: 32000 } as const

function toWire(messages: LlmMessage[], thinking: boolean): { system: string; messages: unknown[] } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  const push = (role: 'user' | 'assistant', block: unknown): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(vide)' })
    } else if (m.role === 'assistant') {
      if (thinking && m.reasoning && m.reasoningSignature) {
        push('assistant', { type: 'thinking', thinking: m.reasoning, signature: m.reasoningSignature })
      }
      if (m.content) push('assistant', { type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(tc.arguments || '{}')
        } catch {
          input = {}
        }
        push('assistant', { type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      if (!m.content && !(m.toolCalls?.length)) push('assistant', { type: 'text', text: '…' })
    } else {
      push('user', { type: 'text', text: m.content || '…' })
    }
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: 'Commence.' }] })
  return { system, messages: out }
}

export async function anthropicChat(provider: ProviderConfig, req: LlmRequest, handlers: LlmStreamHandlers = {}): Promise<LlmResult> {
  const thinking = Boolean(req.reasoningEffort)
  const { system, messages } = toWire(req.messages, thinking)
  const budget = req.reasoningEffort ? EFFORT_BUDGET[req.reasoningEffort] : 0
  const maxTokens = Math.max(req.maxTokens ?? 16000, budget + 4000)
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages,
    stream: true,
  }
  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  if (thinking) body.thinking = { type: 'enabled', budget_tokens: budget }
  else if (req.temperature !== undefined) body.temperature = req.temperature

  let response: Response
  for (let attempt = 0; ; attempt++) {
    response = await fetch(anthropicUrl(provider.baseURL, 'messages'), {
      method: 'POST',
      headers: anthropicHeaders(provider),
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (response.ok && response.body) break
    const text = await response.text().catch(() => '')
    // "max_tokens: 16384 > 8192, which is the maximum allowed…" → retry with the allowed value
    const allowed = text.match(/max_tokens:\s*\d+\s*>\s*(\d+)/)?.[1]
    if (response.status === 400 && allowed && attempt < 2) {
      body.max_tokens = Number(allowed)
      if (body.thinking && budget >= Number(allowed)) body.thinking = { type: 'enabled', budget_tokens: Math.floor(Number(allowed) / 2) }
      continue
    }
    throw new LlmHttpError(`${provider.name}: HTTP ${response.status} — ${text.slice(0, 600)}`, response.status, text)
  }
  if (!response.body) throw new Error('Réponse sans corps')

  let content = ''
  let reasoning = ''
  let signature = ''
  let finishReason = ''
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
  const blocks = new Map<number, { type: string; call?: ToolCall }>()
  const calls: ToolCall[] = []

  for await (const frame of readSse(response.body, req.signal)) {
    let ev: Record<string, any>
    try {
      ev = JSON.parse(frame.data)
    } catch {
      continue
    }
    switch (ev.type) {
      case 'message_start':
        usage.cachedTokens = ev.message?.usage?.cache_read_input_tokens ?? 0
        usage.cacheWriteTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0
        usage.promptTokens = (ev.message?.usage?.input_tokens ?? 0) + usage.cachedTokens + usage.cacheWriteTokens
        break
      case 'content_block_start': {
        const cb = ev.content_block ?? {}
        if (cb.type === 'tool_use') {
          const call: ToolCall = { id: cb.id, name: cb.name, arguments: '' }
          calls.push(call)
          blocks.set(ev.index, { type: 'tool_use', call })
          handlers.onToolCallDelta?.(calls.length - 1, cb.name, undefined)
        } else {
          blocks.set(ev.index, { type: cb.type })
        }
        break
      }
      case 'content_block_delta': {
        const d = ev.delta ?? {}
        if (d.type === 'text_delta') {
          content += d.text
          handlers.onText?.(d.text)
        } else if (d.type === 'thinking_delta') {
          reasoning += d.thinking
          handlers.onReasoning?.(d.thinking)
        } else if (d.type === 'signature_delta') {
          signature += d.signature
        } else if (d.type === 'input_json_delta') {
          const block = blocks.get(ev.index)
          if (block?.call) {
            block.call.arguments += d.partial_json
            handlers.onToolCallDelta?.(calls.indexOf(block.call), undefined, d.partial_json)
          }
        }
        break
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason
        if (ev.usage?.output_tokens) usage.completionTokens = ev.usage.output_tokens
        break
      case 'error':
        throw new LlmHttpError(`${provider.name}: ${JSON.stringify(ev.error).slice(0, 500)}`, 529, frame.data)
    }
  }
  for (const c of calls) if (!c.arguments) c.arguments = '{}'
  return {
    content,
    reasoning,
    reasoningSignature: signature || undefined,
    toolCalls: calls,
    finishReason: finishReason === 'tool_use' ? 'tool_calls' : finishReason,
    usage,
  }
}
