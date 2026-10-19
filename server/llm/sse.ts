/**
 * Minimal Server-Sent-Events reader for fetch() bodies. Yields `{event, data}`
 * frames; tolerant to CRLF and to providers that omit the blank-line terminator
 * on the last frame.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = (): void => {
    reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const parsed = parseFrame(frame)
        if (parsed) yield parsed
      }
    }
    buffer += decoder.decode()
    const parsed = parseFrame(buffer.replace(/\r\n/g, '\n'))
    if (parsed) yield parsed
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

function parseFrame(frame: string): { event?: string; data: string } | undefined {
  if (!frame.trim()) return undefined
  let event: string | undefined
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) return undefined
  return { event, data: data.join('\n') }
}

/**
 * Splits `<think>…</think>` sections out of a content stream (open models
 * served by vLLM / llama.cpp / Ollama often inline their reasoning).
 */
export class ThinkTagSplitter {
  private inThink = false
  private pending = ''

  push(chunk: string, onText: (s: string) => void, onReasoning: (s: string) => void): void {
    let text = this.pending + chunk
    this.pending = ''
    while (text.length > 0) {
      const tag = this.inThink ? '</think>' : '<think>'
      const idx = text.indexOf(tag)
      if (idx === -1) {
        // keep a possible partial tag at the end
        const keep = partialSuffix(text, tag)
        const emit = text.slice(0, text.length - keep)
        if (emit) (this.inThink ? onReasoning : onText)(emit)
        this.pending = text.slice(text.length - keep)
        return
      }
      const before = text.slice(0, idx)
      if (before) (this.inThink ? onReasoning : onText)(before)
      this.inThink = !this.inThink
      text = text.slice(idx + tag.length)
    }
  }

  flush(onText: (s: string) => void, onReasoning: (s: string) => void): void {
    if (this.pending) (this.inThink ? onReasoning : onText)(this.pending)
    this.pending = ''
  }
}

function partialSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(text.length - n))) return n
  }
  return 0
}
