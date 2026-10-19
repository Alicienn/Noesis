import type { ToolCall } from '../../shared/types.ts'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  /** Anthropic thinking signature, needed to replay thinking blocks. */
  reasoningSignature?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
}

export interface LlmTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Ask for a JSON object answer when the endpoint supports it. */
  json?: boolean
  signal?: AbortSignal
}

export interface LlmStreamHandlers {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCallDelta?: (index: number, name: string | undefined, argsDelta: string | undefined) => void
}

export interface LlmUsage {
  /** All input tokens of the call, cached ones included. */
  promptTokens: number
  completionTokens: number
  /** Input tokens served from the provider's prefix cache (DeepSeek hit, OpenAI cached, Anthropic cache read). */
  cachedTokens?: number
  /** Input tokens written to the cache (Anthropic cache creation). */
  cacheWriteTokens?: number
}

export interface LlmResult {
  content: string
  reasoning: string
  reasoningSignature?: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: LlmUsage
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
  }
  get retryable(): boolean {
    return this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500
  }
}
