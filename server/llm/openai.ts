import type { ProviderConfig, ToolCall } from '../../shared/types.ts'
import { readSse, ThinkTagSplitter } from './sse.ts'
import { LlmHttpError } from './types.ts'
import type { LlmMessage, LlmRequest, LlmResult, LlmStreamHandlers, LlmUsage } from './types.ts'

/**
 * OpenAI Chat Completions (and every compatible gateway: DeepSeek, OpenRouter,
 * Groq, Together, Mistral, vLLM, Ollama, LM Studio, Gemini-compat...).
 *
 * Endpoints disagree on optional parameters, so a 400 that names one of them
 * makes us drop / rename it and retry once — the user never has to know which
 * dialect a gateway speaks.
 */

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function authHeaders(provider: ProviderConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.baseURL.includes('openrouter.ai') ? { 'HTTP-Referer': 'https://github.com/noesis', 'X-Title': 'Noesis' } : {}),
    ...(provider.headers ?? {}),
  }
}

function shouldEchoReasoning(provider: ProviderConfig): boolean {
  if (provider.echoReasoning !== undefined) return provider.echoReasoning
  return /deepseek/i.test(provider.baseURL)
}

function toWireMessages(messages: LlmMessage[], provider: ProviderConfig): unknown[] {
  const echo = shouldEchoReasoning(provider)
  // Reasoning only matters inside the current tool-use chain (after the last user turn).
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })
  return messages.map((m, i) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content || '(vide)' }
    }
    if (m.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') }
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        }))
      }
      if (echo && i > lastUser && m.reasoning) out.reasoning_content = m.reasoning
      return out
    }
    return { role: m.role, content: m.content }
  })
}

interface Body {
  [k: string]: unknown
}

function buildBody(provider: ProviderConfig, req: LlmRequest, stream: boolean): Body {
  const isOpenAI = /api\.openai\.com/.test(provider.baseURL)
  const body: Body = {
    model: req.model,
    messages: toWireMessages(req.messages, provider),
    stream,
  }
  if (stream) body.stream_options = { include_usage: true }
  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    body.tool_choice = 'auto'
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.maxTokens) body[isOpenAI ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort
  if (req.json) body.response_format = { type: 'json_object' }
  return body
}

/** Adjust the body after a 400 that complains about a parameter. Returns false when nothing to try. */
function adaptBody(body: Body, errorText: string): boolean {
  const t = errorText.toLowerCase()
  const tryDrop = (key: string): boolean => {
    if (key in body && t.includes(key)) {
      delete body[key]
      return true
    }
    return false
  }
  if (t.includes('reasoning_content') && Array.isArray(body.messages)) {
    const msgs = body.messages as Array<Record<string, unknown>>
    if (msgs.some(m => 'reasoning_content' in m)) {
      for (const m of msgs) delete m.reasoning_content
      return true
    }
  }
  if (tryDrop('stream_options')) return true
  if (tryDrop('reasoning_effort')) return true
  if (tryDrop('response_format')) return true
  if (tryDrop('temperature')) return true
  if ('max_tokens' in body && t.includes('max_tokens') && t.includes('max_completion_tokens')) {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
    return true
  }
  if ('max_completion_tokens' in body && t.includes('max_completion_tokens')) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
    return true
  }
  if (tryDrop('tool_choice')) return true
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (key in body && /max_tokens|max_completion_tokens|maximum.*tokens|too many tokens|output tokens/.test(t)) {
      const current = Number(body[key])
      if (current > 8192) body[key] = 8192
      else if (current > 4096) body[key] = 4096
      else delete body[key]
      return true
    }
  }
  return false
}

async function post(provider: ProviderConfig, body: Body, signal?: AbortSignal): Promise<Response> {
  const url = joinUrl(provider.baseURL, 'chat/completions')
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal,
    })
    if (response.ok) return response
    const text = await response.text().catch(() => '')
    if (response.status === 400 || response.status === 422) {
      if (adaptBody(body, text)) continue
    }
    throw new LlmHttpError(`${provider.name}: HTTP ${response.status} — ${text.slice(0, 600)}`, response.status, text)
  }
  throw new LlmHttpError(`${provider.name}: requête refusée après adaptations`, 400, '')
}

export async function openaiChat(provider: ProviderConfig, req: LlmRequest, handlers: LlmStreamHandlers = {}): Promise<LlmResult> {
  const body = buildBody(provider, req, true)
  const response = await post(provider, body, req.signal)
  const contentType = response.headers.get('content-type') ?? ''

  // Some gateways ignore stream=true and answer with a plain JSON body.
  if (contentType.includes('application/json')) {
    const json = (await response.json()) as Record<string, any>
    return fromNonStreaming(json, handlers)
  }
  if (!response.body) throw new Error('Réponse sans corps')

  let content = ''
  let reasoning = ''
  let finishReason = ''
  let usage: LlmUsage = { promptTokens: 0, completionTokens: 0 }
  const calls = new Map<number, ToolCall>()
  const splitter = new ThinkTagSplitter()
  const onText = (s: string): void => {
    content += s
    handlers.onText?.(s)
  }
  const onReasoning = (s: string): void => {
    reasoning += s
    handlers.onReasoning?.(s)
  }

  for await (const frame of readSse(response.body, req.signal)) {
    if (frame.data === '[DONE]') break
    let chunk: Record<string, any>
    try {
      chunk = JSON.parse(frame.data)
    } catch {
      continue
    }
    if (chunk.error) {
      throw new LlmHttpError(`${provider.name}: ${JSON.stringify(chunk.error).slice(0, 500)}`, 500, frame.data)
    }
    if (chunk.usage) usage = readUsage(chunk.usage, usage)
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? choice.message ?? {}
    const r = delta.reasoning_content ?? delta.reasoning ?? delta.thinking
    if (typeof r === 'string' && r) onReasoning(r)
    if (typeof delta.content === 'string' && delta.content) splitter.push(delta.content, onText, onReasoning)
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : calls.size
        let call = calls.get(index)
        if (!call) {
          call = { id: tc.id ?? '', name: '', arguments: '' }
          calls.set(index, call)
        }
        if (tc.id) call.id = tc.id
        const name = tc.function?.name
        const args = tc.function?.arguments
        if (name) call.name += name
        if (typeof args === 'string') call.arguments += args
        else if (args && typeof args === 'object') call.arguments += JSON.stringify(args)
        handlers.onToolCallDelta?.(index, name, typeof args === 'string' ? args : undefined)
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  splitter.flush(onText, onReasoning)

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }))
    .filter(c => c.name)
  return { content, reasoning, toolCalls, finishReason, usage }
}

function fromNonStreaming(json: Record<string, any>, handlers: LlmStreamHandlers): LlmResult {
  const msg = json.choices?.[0]?.message ?? {}
  let content = ''
  let reasoning = typeof (msg.reasoning_content ?? msg.reasoning) === 'string' ? (msg.reasoning_content ?? msg.reasoning) : ''
  const splitter = new ThinkTagSplitter()
  splitter.push(typeof msg.content === 'string' ? msg.content : '', s => (content += s), s => (reasoning += s))
  splitter.flush(s => (content += s), s => (reasoning += s))
  if (reasoning) handlers.onReasoning?.(reasoning)
  if (content) handlers.onText?.(content)
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? '',
    arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
  }))
  return {
    content,
    reasoning,
    toolCalls,
    finishReason: json.choices?.[0]?.finish_reason ?? 'stop',
    usage: readUsage(json.usage ?? {}, { promptTokens: 0, completionTokens: 0 }),
  }
}

/**
 * Usage across OpenAI-compatible providers, prefix-cache hits included:
 * DeepSeek `prompt_cache_hit_tokens`, OpenAI `prompt_tokens_details.cached_tokens`,
 * OpenRouter/others `cached_tokens` or `cache_read_input_tokens`.
 */
function readUsage(u: Record<string, any>, prev: LlmUsage): LlmUsage {
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens
  const written = u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens
  return {
    promptTokens: u.prompt_tokens ?? u.input_tokens ?? prev.promptTokens,
    completionTokens: u.completion_tokens ?? u.output_tokens ?? prev.completionTokens,
    cachedTokens: typeof cached === 'number' ? cached : prev.cachedTokens,
    cacheWriteTokens: typeof written === 'number' ? written : prev.cacheWriteTokens,
  }
}

export async function openaiEmbed(provider: ProviderConfig, model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  const response = await fetch(joinUrl(provider.baseURL, 'embeddings'), {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({ model, input: inputs }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new LlmHttpError(`embeddings HTTP ${response.status}: ${text.slice(0, 300)}`, response.status, text)
  }
  const json = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> }
  return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}
