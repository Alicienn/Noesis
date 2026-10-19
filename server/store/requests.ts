import type { HumanRequest, RequestKind } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { newId, now, safeJsonParse } from '../core/util.ts'

/**
 * Human inbox: questions, PDF requests, approvals. A blocking request parks
 * the calling agent on a promise that resolves when the human answers.
 */

interface RequestRow {
  id: string
  project_id: string
  agent_id: string
  kind: string
  title: string
  body: string
  options: string | null
  blocking: number
  status: string
  response: string | null
  payload: string | null
  source_id: string | null
  created_at: number
  resolved_at: number | null
}

function fromRow(r: RequestRow): HumanRequest {
  return {
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    kind: r.kind as RequestKind,
    title: r.title,
    body: r.body,
    options: safeJsonParse(r.options, undefined),
    blocking: r.blocking === 1,
    status: r.status as HumanRequest['status'],
    response: r.response ?? undefined,
    payload: safeJsonParse(r.payload, undefined),
    sourceId: r.source_id ?? undefined,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? undefined,
  }
}

const waiters = new Map<string, Array<(r: HumanRequest) => void>>()

export function createRequest(input: Omit<HumanRequest, 'id' | 'createdAt' | 'status' | 'response' | 'resolvedAt'>): HumanRequest {
  const id = newId('req')
  run(
    `INSERT INTO requests (id, project_id, agent_id, kind, title, body, options, blocking, status, payload, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id, input.projectId, input.agentId, input.kind, input.title, input.body,
    input.options ? JSON.stringify(input.options) : null, input.blocking ? 1 : 0,
    input.payload ? JSON.stringify(input.payload) : null, input.sourceId ?? null, now(),
  )
  const request = getRequest(id)!
  bus.publish(input.projectId, { type: 'request.upserted', request })
  bus.publish('*', { type: 'request.upserted', request })
  return request
}

export function getRequest(id: string): HumanRequest | undefined {
  const row = get<RequestRow>('SELECT * FROM requests WHERE id = ?', id)
  return row ? fromRow(row) : undefined
}

export function listRequests(projectId?: string, status?: HumanRequest['status']): HumanRequest[] {
  const where: string[] = []
  const params: string[] = []
  if (projectId) {
    where.push('project_id = ?')
    params.push(projectId)
  }
  if (status) {
    where.push('status = ?')
    params.push(status)
  }
  const sql = `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`
  return all<RequestRow>(sql, ...params).map(fromRow)
}

export function resolveRequest(id: string, response: string, status: 'resolved' | 'dismissed' = 'resolved'): HumanRequest {
  const current = getRequest(id)
  if (!current) throw new Error('Requête introuvable')
  run('UPDATE requests SET status = ?, response = ?, resolved_at = ? WHERE id = ?', status, response, now(), id)
  const request = getRequest(id)!
  bus.publish(request.projectId, { type: 'request.upserted', request })
  bus.publish('*', { type: 'request.upserted', request })
  const list = waiters.get(id)
  waiters.delete(id)
  list?.forEach(fn => fn(request))
  return request
}

/** Wait for a human answer. Rejects when `signal` aborts (run stopped). */
export function waitForRequest(id: string, signal?: AbortSignal): Promise<HumanRequest> {
  const current = getRequest(id)
  if (current && current.status !== 'pending') return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const list = waiters.get(id) ?? []
    const fn = (r: HumanRequest): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = (): void => {
      const l = waiters.get(id)
      if (l) waiters.set(id, l.filter(x => x !== fn))
      reject(new Error('aborted'))
    }
    list.push(fn)
    waiters.set(id, list)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function pendingBlockingFor(agentId: string): HumanRequest[] {
  return all<RequestRow>("SELECT * FROM requests WHERE agent_id = ? AND status = 'pending' AND blocking = 1", agentId).map(fromRow)
}
