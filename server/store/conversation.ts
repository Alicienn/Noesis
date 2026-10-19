import type { AgentInstance, AgentRole, AgentStatus, BusMessage, ChatMessage, ToolRun } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { newId, now, safeJsonParse } from '../core/util.ts'

// ───────────────────────────── Agents ─────────────────────────────

interface AgentRow {
  id: string
  project_id: string
  parent_id: string | null
  role: string
  name: string
  status: string
  task: string | null
  model: string | null
  result: string | null
  steps: number
  created_at: number
  finished_at: number | null
}

function agentFromRow(r: AgentRow): AgentInstance {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id ?? undefined,
    role: r.role as AgentRole,
    name: r.name,
    status: r.status as AgentStatus,
    task: r.task ?? undefined,
    model: r.model ?? undefined,
    result: r.result ?? undefined,
    steps: r.steps,
    createdAt: r.created_at,
    finishedAt: r.finished_at ?? undefined,
  }
}

export function createAgent(input: { id?: string; projectId: string; role: AgentRole; name: string; parentId?: string; task?: string; model?: string }): AgentInstance {
  const id = input.id ?? (input.role === 'lead' ? `lead_${input.projectId}` : newId(input.role.slice(0, 4)))
  run(
    `INSERT OR IGNORE INTO agents (id, project_id, parent_id, role, name, status, task, model, steps, created_at)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, 0, ?)`,
    id, input.projectId, input.parentId ?? null, input.role, input.name, input.task ?? null, input.model ?? null, now(),
  )
  const agent = getAgent(id)!
  bus.publish(input.projectId, { type: 'agent.updated', agent })
  return agent
}

export function getAgent(id: string): AgentInstance | undefined {
  const row = get<AgentRow>('SELECT * FROM agents WHERE id = ?', id)
  return row ? agentFromRow(row) : undefined
}

export function listAgents(projectId: string): AgentInstance[] {
  return all<AgentRow>('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at', projectId).map(agentFromRow)
}

export function updateAgent(id: string, patch: Partial<Pick<AgentInstance, 'status' | 'result' | 'model' | 'steps' | 'task'>> & { finished?: boolean }): AgentInstance | undefined {
  const a = getAgent(id)
  if (!a) return undefined
  run(
    'UPDATE agents SET status = ?, result = ?, model = ?, steps = ?, task = ?, finished_at = ? WHERE id = ?',
    patch.status ?? a.status,
    patch.result ?? a.result ?? null,
    patch.model ?? a.model ?? null,
    patch.steps ?? a.steps,
    patch.task ?? a.task ?? null,
    patch.finished ? now() : a.finishedAt ?? null,
    id,
  )
  const updated = getAgent(id)!
  bus.publish(a.projectId, { type: 'agent.updated', agent: updated })
  return updated
}

// ───────────────────────────── Messages ─────────────────────────────

interface MessageRow {
  id: string
  project_id: string
  agent_id: string
  seq: number
  role: string
  content: string
  reasoning: string | null
  tool_calls: string | null
  tool_call_id: string | null
  name: string | null
  meta: string | null
  compacted: number
  created_at: number
}

function messageFromRow(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    role: r.role as ChatMessage['role'],
    content: r.content,
    reasoning: r.reasoning ?? undefined,
    toolCalls: safeJsonParse(r.tool_calls, undefined),
    toolCallId: r.tool_call_id ?? undefined,
    name: r.name ?? undefined,
    meta: safeJsonParse(r.meta, undefined),
    compacted: r.compacted === 1,
    createdAt: r.created_at,
  }
}

export function appendMessage(input: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
  const id = newId('msg')
  const seqRow = get<{ s: number | null }>('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?', input.agentId)
  run(
    `INSERT INTO messages (id, project_id, agent_id, seq, role, content, reasoning, tool_calls, tool_call_id, name, meta, compacted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.agentId,
    (seqRow?.s ?? 0) + 1,
    input.role,
    input.content ?? '',
    input.reasoning ?? null,
    input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
    input.toolCallId ?? null,
    input.name ?? null,
    input.meta ? JSON.stringify(input.meta) : null,
    input.compacted ? 1 : 0,
    now(),
  )
  const message = getMessage(id)!
  bus.publish(input.projectId, { type: 'message.created', message })
  return message
}

export function getMessage(id: string): ChatMessage | undefined {
  const row = get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)
  return row ? messageFromRow(row) : undefined
}

/** Live (non-compacted) context of one agent, in order. */
export function agentContextMessages(agentId: string): ChatMessage[] {
  return all<MessageRow>('SELECT * FROM messages WHERE agent_id = ? AND compacted = 0 ORDER BY seq', agentId).map(messageFromRow)
}

export function agentMessages(agentId: string, limit = 2000): ChatMessage[] {
  return all<MessageRow>('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', agentId, limit).map(messageFromRow)
}

export function markCompacted(ids: string[]): void {
  for (const id of ids) run('UPDATE messages SET compacted = 1 WHERE id = ?', id)
}

export function updateMessageMeta(id: string, meta: Record<string, unknown>): void {
  const m = getMessage(id)
  if (!m) return
  run('UPDATE messages SET meta = ? WHERE id = ?', JSON.stringify({ ...(m.meta ?? {}), ...meta }), id)
  bus.publish(m.projectId, { type: 'message.updated', message: getMessage(id)! })
}

// ───────────────────────────── Tool runs ─────────────────────────────

interface ToolRunRow {
  id: string
  project_id: string
  agent_id: string
  tool_call_id: string
  tool: string
  args: string
  status: string
  result: string | null
  duration_ms: number | null
  created_at: number
}

function toolRunFromRow(r: ToolRunRow): ToolRun {
  return {
    id: r.id,
    projectId: r.project_id,
    agentId: r.agent_id,
    toolCallId: r.tool_call_id,
    tool: r.tool,
    args: safeJsonParse(r.args, {}),
    status: r.status as ToolRun['status'],
    result: r.result ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    createdAt: r.created_at,
  }
}

export function createToolRun(input: { projectId: string; agentId: string; toolCallId: string; tool: string; args: Record<string, unknown> }): ToolRun {
  const id = newId('run')
  run(
    'INSERT INTO tool_runs (id, project_id, agent_id, tool_call_id, tool, args, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, input.projectId, input.agentId, input.toolCallId, input.tool, JSON.stringify(input.args), 'running', now(),
  )
  const r = getToolRun(id)!
  bus.publish(input.projectId, { type: 'tool.updated', run: r })
  return r
}

export function getToolRun(id: string): ToolRun | undefined {
  const row = get<ToolRunRow>('SELECT * FROM tool_runs WHERE id = ?', id)
  return row ? toolRunFromRow(row) : undefined
}

export function finishToolRun(id: string, status: ToolRun['status'], result: string, durationMs?: number): ToolRun {
  run('UPDATE tool_runs SET status = ?, result = ?, duration_ms = ? WHERE id = ?', status, result, durationMs ?? null, id)
  const r = getToolRun(id)!
  bus.publish(r.projectId, { type: 'tool.updated', run: r })
  return r
}

export function setToolRunStatus(id: string, status: ToolRun['status']): void {
  run('UPDATE tool_runs SET status = ? WHERE id = ?', status, id)
  const r = getToolRun(id)
  if (r) bus.publish(r.projectId, { type: 'tool.updated', run: r })
}

export function listToolRuns(projectId: string, limit = 500): ToolRun[] {
  return all<ToolRunRow>('SELECT * FROM (SELECT * FROM tool_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at', projectId, limit).map(toolRunFromRow)
}

export function toolRunByCallId(callId: string): ToolRun | undefined {
  const row = get<ToolRunRow>('SELECT * FROM tool_runs WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1', callId)
  return row ? toolRunFromRow(row) : undefined
}

// ───────────────────────────── Agent bus ─────────────────────────────

interface BusRow {
  id: string
  project_id: string
  sender: string
  recipient: string
  kind: string
  content: string
  delivered: number
  created_at: number
}

function busFromRow(r: BusRow): BusMessage {
  return {
    id: r.id,
    projectId: r.project_id,
    from: r.sender,
    to: r.recipient,
    kind: r.kind as BusMessage['kind'],
    content: r.content,
    createdAt: r.created_at,
  }
}

/** Inter-agent message. Delivered to the recipient's context at its next step. */
export function sendBusMessage(input: Omit<BusMessage, 'id' | 'createdAt'>): BusMessage {
  const id = newId('bus')
  run(
    'INSERT INTO bus_messages (id, project_id, sender, recipient, kind, content, delivered, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
    id, input.projectId, input.from, input.to, input.kind, input.content, now(),
  )
  const message = busFromRow(get<BusRow>('SELECT * FROM bus_messages WHERE id = ?', id)!)
  bus.publish(input.projectId, { type: 'bus.message', message })
  return message
}

export function takeUndelivered(recipient: string): BusMessage[] {
  const rows = all<BusRow>('SELECT * FROM bus_messages WHERE recipient = ? AND delivered = 0 ORDER BY created_at', recipient)
  for (const r of rows) run('UPDATE bus_messages SET delivered = 1 WHERE id = ?', r.id)
  return rows.map(busFromRow)
}

export function hasUndelivered(recipient: string): boolean {
  return (get<{ n: number }>('SELECT COUNT(*) AS n FROM bus_messages WHERE recipient = ? AND delivered = 0', recipient)?.n ?? 0) > 0
}

export function listBus(projectId: string, limit = 300): BusMessage[] {
  return all<BusRow>('SELECT * FROM (SELECT * FROM bus_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at', projectId, limit).map(busFromRow)
}

// ───────────────────────────── Usage ─────────────────────────────

export function agentUsage(agentId: string): { promptTokens: number; completionTokens: number } {
  const r = get<{ p: number; c: number }>('SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c FROM usage WHERE agent_id = ?', agentId)
  return { promptTokens: r?.p ?? 0, completionTokens: r?.c ?? 0 }
}

export function projectTokenSpend(projectId: string): number {
  const r = get<{ t: number }>('SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) AS t FROM usage WHERE project_id = ?', projectId)
  return r?.t ?? 0
}
