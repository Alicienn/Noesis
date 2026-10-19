import type { FastifyReply, FastifyRequest } from 'fastify'
import { bus } from '../core/events.ts'

/** Server-Sent Events stream for one project (or '*' for global events). */
export function sseHandler(req: FastifyRequest, reply: FastifyReply, projectId: string): void {
  reply.hijack()
  const res = reply.raw
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  })
  res.write('retry: 2000\n\n')
  const send = (data: unknown): void => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  const unsubscribe = bus.subscribe(projectId, send)
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  req.raw.on('close', () => {
    clearInterval(ping)
    unsubscribe()
  })
}
