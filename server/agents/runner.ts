import fs from 'node:fs'
import path from 'node:path'
import type { AgentInstance, ChatMessage, Project, RoleModelConfig } from '../../shared/types.ts'
import { bus, log } from '../core/events.ts'
import { errorMessage, estimateTokens, extractJson, parseToolArgs, truncateMiddle } from '../core/util.ts'
import { chat } from '../llm/client.ts'
import type { ResolvedModel } from '../llm/providers.ts'
import type { LlmResult } from '../llm/types.ts'
import { createEpisode, createNote, listEpisodes, listNotes } from '../memory/notes.ts'
import {
  agentContextMessages, appendMessage, createToolRun, finishToolRun, getAgent, markCompacted, setToolRunStatus, takeUndelivered, updateAgent,
} from '../store/conversation.ts'
import { getProject } from '../store/projects.ts'
import { toLlmTools } from '../tools/registry.ts'
import type { AgentRuntime, ToolDef, ToolOutput } from '../tools/types.ts'
import { buildMessages } from './context.ts'
import { loadPrompt } from './prompts.ts'
import { workspaceDir } from '../config.ts'
import { isCircuitOpen, recordToolOutcome, takeNewOutages, toolHealthSection } from '../core/health.ts'
import { notify } from '../services/notify.ts'

/**
 * Generic agent loop shared by the lead, sub-agents and the verifier:
 *   deliver inbox → (compact) → LLM step (streamed) → tools (parallel where safe,
 *   with human approval when required) → repeat.
 */

export type StopReason = 'submitted' | 'finished' | 'idle' | 'max_steps' | 'aborted' | 'budget' | 'error'

export interface LoopOptions {
  projectId: string
  agentId: string
  model: ResolvedModel
  roleConfig: RoleModelConfig
  tools: ToolDef[]
  buildSystem: () => string
  maxSteps: number
  signal: AbortSignal
  runtime: AgentRuntime
  /** Compaction model (cheap); falls back to the agent's own model. */
  utilityModel?: ResolvedModel
  /** Text appended to the last message each step (state reminder). */
  tailReminder?: (ctx: { step: number; tokens: number }) => string | undefined
  /** What to do when the model answers without calling a tool. */
  onNoToolReply: (content: string, streak: number) => 'continue' | 'stop'
  /** Hook after every completed step (lead: supervisor, budget…). Return 'stop' to end. */
  onStepDone?: (step: number) => 'continue' | 'stop' | Promise<'continue' | 'stop'>
}

export interface LoopResult {
  reason: StopReason
  result: string
}

const MAX_TOOL_OUTPUT = 24_000

/** Running tool calls, so the human can stop one without stopping the agent. */
const activeCalls = new Map<string, { controller: AbortController; reason?: 'user' | 'timeout' }>()

/** Abort one running tool call (the agent receives an "interrupted" result and continues). */
export function cancelToolRun(runId: string): boolean {
  const entry = activeCalls.get(runId)
  if (!entry) return false
  entry.reason = 'user'
  entry.controller.abort()
  return true
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}
const APPROVE_RE = /^\s*(approuv|approve|oui|yes|ok|accept|autoris|valid)/i
const SUBAGENT_APPROVAL_MS = 10 * 60_000

export class AgentLoop {
  private step = 0
  private noToolStreak = 0

  constructor(private readonly o: LoopOptions) {}

  private get agent(): AgentInstance {
    return getAgent(this.o.agentId)!
  }

  private get project(): Project {
    return getProject(this.o.projectId)!
  }

  async run(): Promise<LoopResult> {
    const { signal } = this.o
    let lastText = ''
    try {
      while (true) {
        if (signal.aborted) return { reason: 'aborted', result: lastText }
        if (this.o.maxSteps > 0 && this.step >= this.o.maxSteps) return { reason: 'max_steps', result: lastText }

        this.deliverInbox()
        // tools whose circuit is open (repeated infrastructure failures) are hidden for a while
        const tools = this.o.tools.filter(t => !isCircuitOpen(this.o.projectId, t.name))
        const history = { keep: this.project.config.keepToolResults, budgetChars: this.toolResultBudgetChars() }
        const system = (): string => [this.o.buildSystem(), toolHealthSection(this.o.projectId)].filter(Boolean).join('\n\n')
        let built = buildMessages(system(), agentContextMessages(this.o.agentId), history)
        const toolTokens = estimateTokens(JSON.stringify(toLlmTools(tools)))
        if (built.tokens + toolTokens > this.o.model.contextWindow * this.project.config.compactAt) {
          await this.compact()
          built = buildMessages(system(), agentContextMessages(this.o.agentId), history)
        }
        const reminder = this.o.tailReminder?.({ step: this.step, tokens: built.tokens + toolTokens })
        if (reminder) built = buildMessages(system(), agentContextMessages(this.o.agentId), history, reminder)

        updateAgent(this.o.agentId, { status: 'thinking', model: this.o.model.ref })
        const result = await this.callModel(built.messages, tools)
        this.step++
        updateAgent(this.o.agentId, { steps: (this.agent.steps ?? 0) + 1 })
        bus.publish(this.o.projectId, {
          type: 'usage',
          agentId: this.o.agentId,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          contextTokens: result.usage.promptTokens || built.tokens + toolTokens,
          contextWindow: this.o.model.contextWindow,
        })

        const assistant = appendMessage({
          projectId: this.o.projectId,
          agentId: this.o.agentId,
          role: 'assistant',
          content: result.content,
          reasoning: result.reasoning || undefined,
          toolCalls: result.toolCalls,
          meta: {
            model: this.o.model.ref,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            ...(result.reasoningSignature ? { signature: result.reasoningSignature } : {}),
            finishReason: result.finishReason,
          },
        })
        if (result.content.trim()) lastText = result.content.trim()

        if (result.toolCalls.length > 0) {
          this.noToolStreak = 0
          const outcome = await this.runTools(assistant)
          if (outcome.stop) return { reason: outcome.reason ?? 'submitted', result: outcome.result ?? lastText }
        } else {
          this.noToolStreak++
          if (result.finishReason === 'length' && !result.content.trim()) {
            appendMessage({ projectId: this.o.projectId, agentId: this.o.agentId, role: 'user', content: 'Ta réponse a été coupée (limite de tokens). Sois plus concis ou découpe le travail.', meta: { origin: 'system' } })
            continue
          }
          const decision = this.o.onNoToolReply(result.content, this.noToolStreak)
          if (decision === 'stop') return { reason: 'idle', result: lastText }
        }

        if (this.o.onStepDone) {
          const d = await this.o.onStepDone(this.step)
          if (d === 'stop') return { reason: 'budget', result: lastText }
        }
      }
    } catch (error) {
      if (signal.aborted || errorMessage(error) === 'aborted') return { reason: 'aborted', result: lastText }
      throw error
    } finally {
      bus.publish(this.o.projectId, { type: 'llm.done', agentId: this.o.agentId })
    }
  }

  /**
   * How much recent tool output stays verbatim in context. Clearing by count
   * alone (old behaviour) made agents re-read the same file 3× after a couple
   * of parallel batches, even with a huge context window: budget by size.
   */
  private toolResultBudgetChars(): number {
    return Math.floor(this.o.model.contextWindow * 0.3 * 3.6)
  }

  /** Messages from the bus (human, supervisor, verifier, other agents) become user turns. */
  private deliverInbox(): void {
    for (const m of takeUndelivered(this.o.agentId)) {
      const origin = m.from === 'human' ? 'human' : m.from === 'supervisor' ? 'supervisor' : m.from.startsWith('veri') ? 'verifier' : m.from === 'system' ? 'system' : 'agent'
      appendMessage({
        projectId: this.o.projectId,
        agentId: this.o.agentId,
        role: 'user',
        content: m.content,
        meta: { origin, from: m.from, busId: m.id, kind: m.kind },
      })
    }
  }

  private async callModel(messages: Parameters<typeof chat>[1]['messages'], tools: ToolDef[]): Promise<LlmResult> {
    const { projectId, agentId } = this.o
    let buffer = { text: '', reasoning: '' }
    let timer: NodeJS.Timeout | undefined
    const flush = (): void => {
      if (buffer.reasoning) bus.publish(projectId, { type: 'llm.delta', agentId, kind: 'reasoning', delta: buffer.reasoning })
      if (buffer.text) bus.publish(projectId, { type: 'llm.delta', agentId, kind: 'text', delta: buffer.text })
      buffer = { text: '', reasoning: '' }
      timer = undefined
    }
    const schedule = (): void => {
      if (!timer) timer = setTimeout(flush, 70)
    }
    try {
      return await chat(this.o.model, {
        messages,
        tools: tools.length ? toLlmTools(tools) : undefined,
        temperature: this.o.roleConfig.temperature,
        maxTokens: this.o.roleConfig.maxTokens || undefined,
        reasoningEffort: this.o.roleConfig.reasoningEffort || undefined,
        signal: this.o.signal,
        projectId,
        agentId,
        onRetry: (attempt, error, delay) => {
          // discard what was streamed before the failure
          buffer = { text: '', reasoning: '' }
          bus.publish(projectId, { type: 'llm.done', agentId })
          log(projectId, 'warn', `Appel LLM échoué (tentative ${attempt}) : ${error} — nouvel essai dans ${Math.round(delay / 1000)} s`, agentId)
        },
      }, {
        onText: d => {
          buffer.text += d
          schedule()
        },
        onReasoning: d => {
          buffer.reasoning += d
          schedule()
        },
        onToolCallDelta: (index, name, argsDelta) => {
          bus.publish(projectId, { type: 'llm.toolcall.delta', agentId, index, name, argsDelta })
        },
      })
    } finally {
      if (timer) clearTimeout(timer)
      flush()
      bus.publish(projectId, { type: 'llm.done', agentId })
    }
  }

  private async runTools(assistant: ChatMessage): Promise<{ stop: boolean; reason?: StopReason; result?: string }> {
    const calls = assistant.toolCalls ?? []
    const byName = new Map(this.o.tools.map(t => [t.name, t]))
    // Consecutive parallel-safe calls run concurrently; others sequentially, in order.
    const groups: Array<typeof calls> = []
    for (const c of calls) {
      const parallel = byName.get(c.name)?.parallel === true
      const last = groups[groups.length - 1]
      if (parallel && last && last.every(x => byName.get(x.name)?.parallel)) last.push(c)
      else groups.push([c])
    }
    let stop: { stop: boolean; reason?: StopReason; result?: string } = { stop: false }
    for (const group of groups) {
      const outputs = await Promise.all(group.map(c => this.executeCall(c, byName.get(c.name))))
      group.forEach((c, i) => {
        const out = outputs[i]
        appendMessage({
          projectId: this.o.projectId,
          agentId: this.o.agentId,
          role: 'tool',
          content: out.content,
          toolCallId: c.id,
          name: c.name,
          meta: { toolStatus: out.interrupted ?? (out.denied ? 'denied' : out.status === 'error' ? 'error' : 'ok'), durationMs: out.durationMs, truncated: out.truncated },
        })
        if (!out.denied && !out.interrupted) recordToolOutcome(this.o.projectId, c.name, out.status !== 'error', out.content)
        if (out.stop && !stop.stop) {
          stop = { stop: true, reason: c.name === 'finish_research' ? 'finished' : 'submitted', result: c.name === 'finish_research' ? undefined : out.content }
        }
      })
      if (this.o.signal.aborted) break
    }
    for (const outage of takeNewOutages(this.o.projectId)) {
      notify(this.o.projectId, `Outil en panne : ${outage.tool}`, `${outage.error.slice(0, 160)} — les agents l'évitent pendant 15 min. ${outage.tool === 'web_search' ? 'Configure un moteur (Paramètres → Recherche).' : ''}`, 'warn', 'error')
    }
    return stop
  }

  private async executeCall(call: { id: string; name: string; arguments: string }, tool: ToolDef | undefined): Promise<ToolOutput & { durationMs?: number; truncated?: boolean; denied?: boolean; interrupted?: 'cancelled' | 'timeout' }> {
    const started = Date.now()
    if (!tool) {
      const names = this.o.tools.map(t => t.name).join(', ')
      return { content: `Erreur: outil inconnu « ${call.name} ». Outils disponibles: ${names}`, status: 'error' }
    }
    if (isCircuitOpen(this.o.projectId, tool.name)) {
      return { content: `Outil ${tool.name} temporairement désactivé (pannes répétées, voir <etat_des_outils>). Utilise une alternative.`, status: 'error' }
    }
    let args: Record<string, unknown>
    try {
      args = parseToolArgs(call.arguments)
    } catch (error) {
      return { content: `Erreur: ${errorMessage(error)}. Renvoie des arguments JSON valides.`, status: 'error' }
    }
    const run = createToolRun({ projectId: this.o.projectId, agentId: this.o.agentId, toolCallId: call.id, tool: call.name, args })
    const project = this.project
    // Each call gets its own abort signal: stopping it (human or timeout) must not stop the agent.
    const callCtl = new AbortController()
    const entry: { controller: AbortController; reason?: 'user' | 'timeout' } = { controller: callCtl }
    const onParentAbort = (): void => callCtl.abort()
    this.o.signal.addEventListener('abort', onParentAbort, { once: true })
    const ctx = {
      project,
      agent: this.agent,
      workspace: workspaceDir(project.id),
      signal: callCtl.signal,
      runtime: this.o.runtime,
      toolRunId: run.id,
      toolCallId: call.id,
    }
    updateAgent(this.o.agentId, { status: 'tool' })

    // ── permission gate ──
    const mode = project.config.permission
    let reason: string | undefined
    if (mode === 'ask' && (tool.sensitive || tool.risk?.(args, ctx))) reason = tool.risk?.(args, ctx) ?? 'mode « demander » : action sensible'
    else if (mode === 'smart') reason = tool.risk?.(args, ctx)
    if (reason) {
      setToolRunStatus(run.id, 'waiting_approval')
      const preview = call.name === 'bash' ? String(args.command) : call.name === 'python' ? String(args.code).slice(0, 3000) : JSON.stringify(args, null, 2).slice(0, 3000)
      const req = await this.o.runtime.askHuman({
        kind: 'approval',
        title: `Autoriser ${call.name} ? (${reason})`,
        body: preview,
        options: ['Approuver', 'Refuser'],
        blocking: true,
        payload: { tool: call.name, args, reason },
        agent: this.agent,
        signal: this.o.signal,
        // background agents (verifiers, sub-agents) do not wait forever on an approval nobody sees
        timeoutMs: this.agent.role === 'lead' ? undefined : SUBAGENT_APPROVAL_MS,
      })
      updateAgent(this.o.agentId, { status: 'tool' })
      if (req.status !== 'resolved' || !APPROVE_RE.test(req.response ?? '')) {
        const msg = req.response?.startsWith('Sans réponse')
          ? `Action non autorisée : ${req.response}. Choisis une approche qui ne demande pas d'approbation.`
          : `Action refusée par l'humain${req.response ? ` : « ${req.response} »` : ''}. Choisis une autre approche.`
        finishToolRun(run.id, 'denied', msg, Date.now() - started)
        return { content: msg, status: 'error', denied: true }
      }
      setToolRunStatus(run.id, 'running')
    }

    const defaultMs = (project.config.toolTimeoutSec || 1800) * 1000
    const timeoutMs = typeof tool.timeoutMs === 'function' ? tool.timeoutMs(defaultMs) : tool.timeoutMs ?? defaultMs
    const timer = timeoutMs > 0 ? setTimeout(() => {
      entry.reason = 'timeout'
      callCtl.abort()
    }, timeoutMs) : undefined
    const aborted = new Promise<never>((_, reject) => {
      callCtl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    aborted.catch(() => {})
    activeCalls.set(run.id, entry)

    try {
      // A tool that ignores its signal (sync work, stuck socket…) is abandoned, never awaited forever.
      const raw = await Promise.race([tool.execute(args, ctx), aborted])
      const out: ToolOutput = typeof raw === 'string' ? { content: raw, status: 'ok' } : raw
      let content = out.content ?? ''
      let truncated = false
      if (content.length > MAX_TOOL_OUTPUT) {
        const file = path.join(ctx.workspace, 'artifacts', `tool_${run.id}.txt`)
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content, 'utf8')
        } catch {
          // ignore
        }
        const t = truncateMiddle(content, MAX_TOOL_OUTPUT)
        const rel = `artifacts/tool_${run.id}.txt`
        content = `${t.text}\n\n[Sortie tronquée. Texte complet (${out.content.length} caractères) dans le fichier « ${rel} » du workspace. Pour y chercher : file_grep(pattern, path="${rel}") ; pour le lire : file_read(path="${rel}", offset=N). Chemin relatif au workspace : inutile de le chercher ailleurs sur le disque.]`
        truncated = true
      }
      finishToolRun(run.id, out.status === 'error' ? 'error' : 'ok', content, Date.now() - started)
      return { ...out, content, durationMs: Date.now() - started, truncated }
    } catch (error) {
      const msg = errorMessage(error)
      const elapsed = Date.now() - started
      if (this.o.signal.aborted) {
        finishToolRun(run.id, 'error', 'Interrompu', elapsed)
        return { content: 'Interrompu.', status: 'error' }
      }
      if (entry.reason === 'user') {
        const text = `Action interrompue manuellement par l'humain après ${fmtMs(elapsed)} (elle était trop longue ou mal engagée). Ne la relance pas à l'identique : change d'approche ou cible mieux.`
        finishToolRun(run.id, 'cancelled', text, elapsed)
        return { content: text, status: 'error', durationMs: elapsed, interrupted: 'cancelled' }
      }
      if (entry.reason === 'timeout') {
        const text = `Délai dépassé : ${call.name} a été arrêté après ${fmtMs(elapsed)}. Découpe le travail, réduis le périmètre (ex. pas de recherche sur tout le disque) ou augmente le timeout de l'outil si c'est légitime.`
        finishToolRun(run.id, 'timeout', text, elapsed)
        return { content: text, status: 'error', durationMs: elapsed, interrupted: 'timeout' }
      }
      finishToolRun(run.id, 'error', `Erreur: ${msg}`, elapsed)
      return { content: `Erreur lors de ${call.name}: ${msg}`, status: 'error', durationMs: elapsed }
    } finally {
      if (timer) clearTimeout(timer)
      activeCalls.delete(run.id)
      this.o.signal.removeEventListener('abort', onParentAbort)
    }
  }

  /**
   * Compaction: summarise the oldest part of the live context into a
   * cumulative episode (+ flush durable facts into notes), then hide those
   * messages from the context. Never splits a tool call from its results.
   */
  async compact(): Promise<void> {
    const history = agentContextMessages(this.o.agentId)
    if (history.length < 6) return
    const window = this.o.model.contextWindow
    let keepTokens = 0
    let cut = history.length
    while (cut > 1 && keepTokens < window * 0.22) {
      cut--
      keepTokens += estimateTokens(history[cut].content) + estimateTokens(history[cut].reasoning)
    }
    while (cut < history.length && history[cut].role === 'tool') cut++
    if (cut < 2) cut = Math.min(history.length - 1, 2)
    while (cut < history.length && history[cut].role === 'tool') cut++
    const old = history.slice(0, cut)
    if (old.length < 2) return

    updateAgent(this.o.agentId, { status: 'thinking' })
    log(this.o.projectId, 'info', `Compaction du contexte : ${old.length} messages → résumé d'épisode`, this.o.agentId)
    const previous = listEpisodes(this.o.projectId, this.o.agentId).slice(-1)[0]
    const model = this.o.utilityModel ?? this.o.model
    const budgetChars = Math.floor(model.contextWindow * 0.55 * 3.6)
    const transcript = renderTranscript(old, Math.max(800, Math.floor(budgetChars / Math.max(10, old.length))))
    const existing = listNotes(this.o.projectId, { limit: 200 }).map(n => `- ${n.title}`).join('\n')
    const input = [
      previous ? `<resume_precedent>\n${previous.summary}\n</resume_precedent>` : '',
      `<notes_existantes>\n${existing || '(aucune)'}\n</notes_existantes>`,
      `<echanges_a_compacter>\n${truncateMiddle(transcript, budgetChars).text}\n</echanges_a_compacter>`,
    ].join('\n\n')
    let summary = ''
    try {
      const res = await chat(model, {
        messages: [
          { role: 'system', content: loadPrompt('compaction') },
          { role: 'user', content: input },
        ],
        temperature: 0.1,
        maxTokens: 6000,
        signal: this.o.signal,
        projectId: this.o.projectId,
        agentId: `${this.o.agentId}:compaction`,
      })
      const parsed = extractJson<{ summary?: string; notes?: Array<{ title: string; content: string; type?: string; importance?: number; tags?: string[] }> }>(res.content)
      summary = parsed?.summary?.trim() || res.content.trim()
      for (const n of parsed?.notes ?? []) {
        if (!n?.title || !n?.content) continue
        try {
          createNote(this.o.projectId, { title: n.title, content: n.content, type: n.type as any, importance: n.importance, tags: n.tags }, 'librarian')
        } catch {
          // ignore malformed
        }
      }
    } catch (error) {
      if (this.o.signal.aborted) throw error
      log(this.o.projectId, 'warn', `Compaction via LLM échouée (${errorMessage(error)}) — résumé dégradé`, this.o.agentId)
      summary = `${previous ? `${previous.summary}\n\n` : ''}(Résumé dégradé) Derniers messages de l'agent :\n${old.filter(m => m.role === 'assistant' && m.content).slice(-12).map(m => `- ${m.content.slice(0, 400)}`).join('\n')}`
    }
    createEpisode(this.o.projectId, this.o.agentId, summary, old.length)
    markCompacted(old.map(m => m.id))
    appendMessage({
      projectId: this.o.projectId,
      agentId: this.o.agentId,
      role: 'user',
      content: 'Le contexte a été compacté : les échanges anciens sont résumés dans <historique_compacte> (prompt système). Vérifie que ton plan et ta mémoire de travail sont à jour, puis continue.',
      meta: { origin: 'compaction' },
    })
  }
}

function renderTranscript(messages: ChatMessage[], perToolChars: number): string {
  return messages.map(m => {
    if (m.role === 'assistant') {
      const calls = m.toolCalls?.map(tc => `→ ${tc.name}(${tc.arguments.slice(0, 600)})`).join('\n') ?? ''
      return `[assistant]\n${m.content}${calls ? `\n${calls}` : ''}`
    }
    if (m.role === 'tool') return `[résultat ${m.name}]\n${truncateMiddle(m.content, perToolChars).text}`
    return `[${m.meta?.origin ?? m.role}]\n${m.content}`
  }).join('\n\n')
}
