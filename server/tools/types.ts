import type { AgentInstance, AgentRole, HumanRequest, Project, RequestKind, Verification } from '../../shared/types.ts'

/**
 * Services the orchestrator lends to tools. Tools never import the
 * orchestrator directly (no cycles, easy to test with a fake runtime).
 */
export interface AgentRuntime {
  /** Run a sub-agent to completion and return its (compressed) report. */
  delegate(params: { task: string; role: AgentRole; context?: string; maxSteps?: number; parent: AgentInstance; signal: AbortSignal }): Promise<string>
  /** Adversarial verification of a claim by the verifier agent. */
  verify(params: { claim: string; kind: string; context?: string; noteSlug?: string; parent: AgentInstance; signal: AbortSignal; maxSteps?: number }): Promise<{ verification: Verification; report: string }>
  /** Pairwise Elo tournament over hypotheses. */
  tournament(params: { rounds: number; parent: AgentInstance; signal: AbortSignal }): Promise<string>
  /** Create a request in the human inbox; if `wait`, resolves with the answer. */
  askHuman(params: { kind: RequestKind; title: string; body: string; options?: string[]; blocking: boolean; payload?: Record<string, unknown>; sourceId?: string; agent: AgentInstance; signal: AbortSignal; timeoutMs?: number }): Promise<HumanRequest>
  /** Post a message on the inter-agent bus. */
  sendMessage(params: { from: string; to: string; content: string; kind?: 'info' | 'reply' | 'report' | 'suggestion' }): void
  /** Lead only: end the autonomous run. */
  finish(params: { agent: AgentInstance; summary: string }): void
  /**
   * Audit a report (citations, note statuses, numbers, deliverables). With
   * `final`, also counts the attempt and appends the database-generated annex
   * when the report is accepted. Returns whether finishing may proceed.
   */
  auditReport(params: { file?: string; agent: AgentInstance; signal: AbortSignal; final?: boolean; contested?: string[] }): Promise<{ text: string; accept: boolean; file?: string }>
}

export interface ToolContext {
  project: Project
  agent: AgentInstance
  workspace: string
  signal: AbortSignal
  runtime: AgentRuntime
  toolRunId: string
  toolCallId: string
}

export interface ToolOutput {
  content: string
  status?: 'ok' | 'error'
  /** Tool asked to stop the agent loop after this result (finish / submit). */
  stop?: boolean
}

export type ToolCategory = 'memory' | 'plan' | 'hypotheses' | 'web' | 'literature' | 'files' | 'exec' | 'formal' | 'human' | 'agents' | 'report' | 'mcp'

export interface ToolDef {
  name: string
  description: string
  category: ToolCategory
  parameters: Record<string, unknown>
  /** Roles allowed to use the tool. Undefined = every role except supervisor. */
  roles?: AgentRole[]
  /** Safe to run concurrently with other calls of the same batch. */
  parallel?: boolean
  /**
   * Timeout override in ms. Undefined = project default (toolTimeoutSec);
   * 0 = no timeout (tools that legitimately wait for the human).
   * A function receives the project default and may extend it.
   */
  timeoutMs?: number | ((defaultMs: number) => number)
  /** Needs human approval in 'ask' mode. */
  sensitive?: boolean
  /** Offered to agents only while this returns true (e.g. an optional backend is installed). */
  available?: () => boolean
  /** In 'smart' mode: return a reason to require approval for these args. */
  risk?: (args: Record<string, unknown>, ctx: ToolContext) => string | undefined
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolOutput>
}

// tiny JSON-schema helpers to keep tool declarations readable
export const S = {
  str: (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra }),
  num: (description: string, extra: Record<string, unknown> = {}) => ({ type: 'number', description, ...extra }),
  int: (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra }),
  bool: (description: string) => ({ type: 'boolean', description }),
  enum: (values: readonly string[], description: string) => ({ type: 'string', enum: values, description }),
  arr: (items: Record<string, unknown>, description: string) => ({ type: 'array', items, description }),
  obj: (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false }),
}

export function argStr(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key]
  if (typeof v === 'string') return v
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback
    throw new Error(`Paramètre requis manquant: ${key}`)
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

export function argNum(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

export function argBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key]
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

export function argList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // comma separated
    }
    return v.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}
