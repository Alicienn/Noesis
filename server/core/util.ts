import { customAlphabet } from 'nanoid'

const alphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)

/** Short, sortable-enough, URL-safe ids with a readable prefix. */
export function newId(prefix: string): string {
  return `${prefix}_${alphabet()}`
}

export function now(): number {
  return Date.now()
}

export function slugify(text: string, max = 60): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s || 'note'
}

/** Rough token estimate (works across tokenizers well enough for budgeting). */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.6)
}

export function truncateMiddle(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.7)
  const tail = max - head
  const omitted = text.length - max
  return {
    text: `${text.slice(0, head)}\n\n… [${omitted} caractères omis] …\n\n${text.slice(text.length - tail)}`,
    truncated: true,
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
      return `${error.message} (${cause.message})`
    }
    return error.message
  }
  return String(error)
}

export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * Parse tool-call arguments produced by a model. Models sometimes wrap JSON in
 * code fences or leave trailing commas; be forgiving before giving up.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim()
  if (!text) return {}
  const attempts = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, ''),
    text.replace(/,\s*([}\]])/g, '$1'),
  ]
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // try next
    }
  }
  throw new Error(`Arguments JSON invalides: ${text.slice(0, 200)}`)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

/** Extract the first JSON object from free text (models love prose around JSON). */
export function extractJson<T = Record<string, unknown>>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1)) as T
    } catch {
      // continue
    }
  }
  return undefined
}

export class Semaphore {
  private queue: Array<() => void> = []
  private active = 0
  constructor(private max: number) {}
  setMax(max: number): void {
    this.max = Math.max(1, max)
    this.drain()
  }
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
      return () => this.release()
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.active++
        resolve(() => this.release())
      })
    })
  }
  private release(): void {
    this.active--
    this.drain()
  }
  private drain(): void {
    while (this.active < this.max && this.queue.length > 0) this.queue.shift()?.()
  }
}
