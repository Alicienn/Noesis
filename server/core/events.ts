import { EventEmitter } from 'node:events'
import type { ServerEvent } from '../../shared/types.ts'

type Listener = (event: ServerEvent) => void

/**
 * In-process pub/sub. Every module publishes here; the SSE route forwards
 * events to browsers, the notifier listens for the interesting ones.
 * `projectId === '*'` is the global channel (settings, project list...).
 */
class EventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  publish(projectId: string, event: ServerEvent): void {
    this.emitter.emit(`p:${projectId}`, event)
    this.emitter.emit('any', projectId, event)
  }

  subscribe(projectId: string, listener: Listener): () => void {
    const key = `p:${projectId}`
    this.emitter.on(key, listener)
    return () => this.emitter.off(key, listener)
  }

  subscribeAll(listener: (projectId: string, event: ServerEvent) => void): () => void {
    this.emitter.on('any', listener)
    return () => this.emitter.off('any', listener)
  }
}

export const bus = new EventBus()

export function log(projectId: string, level: 'info' | 'warn' | 'error', message: string, agentId?: string): void {
  const stamp = new Date().toISOString().slice(11, 19)
  const line = `[${stamp}] [${projectId}]${agentId ? ` [${agentId}]` : ''} ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  bus.publish(projectId, { type: 'log', level, message, agentId })
}
