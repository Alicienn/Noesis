import type { AgentRole, Project, ToolDescriptor } from '../../shared/types.ts'
import type { LlmTool } from '../llm/types.ts'
import { collabTools } from './builtin/collab.ts'
import { hypothesisTools } from './builtin/hypotheses.ts'
import { leanTools } from './builtin/lean.ts'
import { memoryTools } from './builtin/memory.ts'
import { priorTools } from './builtin/prior.ts'
import { researchTools } from './builtin/research.ts'
import { systemTools } from './builtin/system.ts'
import { mcpTools } from './mcp.ts'
import type { ToolDef } from './types.ts'

/**
 * Central tool registry. Adding a capability = adding a ToolDef to a module
 * and listing the module here (or exposing it through an MCP server).
 */
const BUILTIN: ToolDef[] = [...memoryTools, ...priorTools, ...hypothesisTools, ...researchTools, ...systemTools, ...leanTools, ...collabTools]

/** Default tool sets per role (sub-agents get a focused toolbox). */
const ROLE_CATEGORIES: Record<AgentRole, string[] | 'all'> = {
  lead: 'all',
  scout: ['memory', 'web', 'literature', 'files', 'report', 'agents'],
  experimenter: ['memory', 'files', 'exec', 'formal', 'web', 'literature', 'report', 'agents', 'mcp'],
  theorist: ['memory', 'files', 'exec', 'formal', 'literature', 'report', 'agents', 'mcp'],
  critic: ['memory', 'literature', 'files', 'exec', 'formal', 'web', 'report'],
  verifier: ['memory', 'literature', 'files', 'exec', 'formal', 'web', 'report', 'mcp'],
  librarian: ['memory', 'report'],
  supervisor: [],
}

/** Tools sub-agents must not use even within allowed categories. */
// core memory belongs to the lead: a sub-agent overwriting `plan` or `working` erases the lead's state
const SUBAGENT_DENY = new Set(['update_plan', 'core_memory_edit', 'finish_research', 'ask_human', 'notify_human', 'delegate', 'hypothesis_tournament'])

export function allTools(): ToolDef[] {
  return [...BUILTIN, ...mcpTools()]
}

export function getTool(name: string): ToolDef | undefined {
  return allTools().find(t => t.name === name)
}

export function toolsFor(role: AgentRole, project: Project): ToolDef[] {
  const cats = ROLE_CATEGORIES[role]
  const disabled = new Set(project.config.disabledTools)
  return allTools().filter(t => {
    if (disabled.has(t.name)) return false
    if (t.available && !t.available()) return false
    // formalization switched off for this project (Réglages → Formalisation Lean)
    if (t.category === 'formal' && (project.config.formal ?? 'off') === 'off') return false
    if (t.roles && !t.roles.includes(role)) return false
    if (!t.roles && role === 'supervisor') return false
    if (role !== 'lead' && SUBAGENT_DENY.has(t.name)) return false
    if (cats === 'all') return true
    return cats.includes(t.category)
  })
}

export function toLlmTools(tools: ToolDef[]): LlmTool[] {
  return tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

export function describeTools(): ToolDescriptor[] {
  return allTools().map(t => ({
    name: t.name,
    description: t.description,
    category: t.category,
    source: t.category === 'mcp' ? 'mcp' : 'builtin',
    parameters: t.parameters,
  }))
}
