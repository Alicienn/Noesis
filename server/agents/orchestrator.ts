import fs from 'node:fs'
import path from 'node:path'
import type { AgentInstance, AgentRole, HumanRequest, Project, RoleModelConfig, Source, Verification } from '../../shared/types.ts'
import { ROLE_LABELS } from '../../shared/types.ts'
import { all } from '../db/database.ts'
import { bus, log } from '../core/events.ts'
import { healthSnapshot } from '../core/health.ts'
import { academicStatus } from '../services/academic.ts'
import { errorMessage, extractJson, Semaphore } from '../core/util.ts'
import { chat, ModelNotConfiguredError, requireModel } from '../llm/client.ts'
import type { ResolvedModel } from '../llm/providers.ts'
import { createNote, downgradeAssurance, getNote, listNotes, noteToText, recordAssurance, setStatementReview, setVerification, similarNotes, supersedeNote, updateNote } from '../memory/notes.ts'
import { effectiveModels } from '../settings.ts'
import { getBlock, setBlock } from '../store/blocks.ts'
import {
  agentMessages, appendMessage, createAgent, getAgent, hasUndelivered, listAgents, projectTokenSpend, sendBusMessage, updateAgent,
} from '../store/conversation.ts'
import { listHypotheses, recordMatch } from '../store/hypotheses.ts'
import { getProject, publishProject, requireProject, setProjectStatus, touchProject } from '../store/projects.ts'
import { createRequest, listRequests, pendingBlockingFor, resolveRequest, waitForRequest } from '../store/requests.ts'
import { notify } from '../services/notify.ts'
import { toolsFor } from '../tools/registry.ts'
import type { AgentRuntime } from '../tools/types.ts'
import { coreMemorySection, episodesSection, memoryOverview, providedDocumentsSection } from './context.ts'
import { listProvided, openedProvided } from '../store/documents.ts'
import { loadPrompt, principles, render, roleInstructions, today } from './prompts.ts'
import { AgentLoop } from './runner.ts'
import { auditReport, findReport, formatAudit } from './audit.ts'
import { generateReasoningSummary } from './publication.ts'
import { workspaceDir } from '../config.ts'
import { leanReady, prewarmLean, releaseLeanKeepalive } from '../services/lean.ts'

/**
 * The Orchestrator owns every running research session:
 *  - the lead agent loop (autonomous or interactive),
 *  - sub-agents (delegate), verifier runs, hypothesis tournaments,
 *  - the Supervisor that periodically reviews the lead and messages it,
 *  - automatic verification of important findings,
 *  - the Librarian ("sleep-time") memory consolidation,
 *  - the human-in-the-loop requests (questions, approvals, PDFs).
 */

interface ProjectRun {
  controller: AbortController
  promise: Promise<void>
  semaphore: Semaphore
  supervising: boolean
  consolidating: boolean
  lastSupervisedStep: number
  lastConsolidatedStep: number
  /** Supervision also runs on a clock: the lead can sit in one long delegation for many minutes. */
  lastSupervisedAt: number
  /** finish_research calls refused by the report audit */
  finishAttempts?: number
  /** audits run on the final report, and how many times each blocking issue came back */
  audits?: number
  seenIssues?: Map<string, number>
  clock?: NodeJS.Timeout
  finishSummary?: string
}

const SUPERVISE_EVERY_MS = 12 * 60_000

const SUB_ROLES: AgentRole[] = ['scout', 'experimenter', 'theorist', 'critic']

class Orchestrator implements AgentRuntime {
  private runs = new Map<string, ProjectRun>()
  private verifySem = new Map<string, Semaphore>()
  private verifyQueue = new Map<string, number>()
  private background = new Map<string, AbortController>()

  // ───────────────────────────── lifecycle ─────────────────────────────

  isRunning(projectId: string): boolean {
    return this.runs.has(projectId)
  }

  leadId(projectId: string): string {
    return `lead_${projectId}`
  }

  ensureLead(project: Project): AgentInstance {
    return getAgent(this.leadId(project.id)) ?? createAgent({ projectId: project.id, role: 'lead', name: 'Noesis' })
  }

  start(projectId: string, opts: { message?: string } = {}): void {
    const project = requireProject(projectId)
    const lead = this.ensureLead(project)
    if (opts.message) sendBusMessage({ projectId, from: 'human', to: lead.id, kind: 'info', content: opts.message })
    if (this.runs.has(projectId)) return
    // fail fast with a clear message when no model is configured
    const models = effectiveModels(project.config)
    try {
      requireModel(models.lead.model, 'chercheur principal')
    } catch (error) {
      setProjectStatus(projectId, 'error')
      log(projectId, 'error', errorMessage(error))
      notify(projectId, 'Configuration requise', errorMessage(error), 'error', 'error')
      throw error
    }
    const controller = new AbortController()
    const run: ProjectRun = {
      controller,
      promise: Promise.resolve(),
      semaphore: new Semaphore(project.config.maxParallelAgents),
      supervising: false,
      consolidating: false,
      lastSupervisedStep: 0,
      lastConsolidatedStep: 0,
      lastSupervisedAt: Date.now(),
    }
    this.runs.set(projectId, run)
    setProjectStatus(projectId, 'running')
    if ((project.config.formal ?? 'off') !== 'off') prewarmLean()
    run.clock = setInterval(() => {
      const p = getProject(projectId)
      if (!p || p.config.supervisorEvery <= 0 || run.supervising) return
      if (Date.now() - run.lastSupervisedAt >= SUPERVISE_EVERY_MS) void this.supervise(projectId, run, 'Revue périodique (temps écoulé)')
    }, 60_000)
    run.promise = this.runLead(projectId, run).finally(() => {
      clearInterval(run.clock)
      this.runs.delete(projectId)
      if (![...this.runs.keys()].some(id => (getProject(id)?.config.formal ?? 'off') !== 'off')) releaseLeanKeepalive()
      touchProject(projectId)
      publishProject(projectId)
    })
  }

  stop(projectId: string, status: 'paused' | 'idle' = 'paused'): void {
    const run = this.runs.get(projectId)
    if (run) run.controller.abort()
    this.background.get(projectId)?.abort()
    this.background.delete(projectId)
    for (const a of listAgents(projectId)) {
      if (['thinking', 'tool', 'waiting'].includes(a.status)) updateAgent(a.id, { status: a.role === 'lead' ? 'idle' : 'stopped', finished: a.role !== 'lead' })
    }
    // blocking requests (approvals, blocking questions) are moot once the run stops
    for (const r of listRequests(projectId, 'pending')) {
      if (r.blocking) resolveRequest(r.id, 'Annulée (session mise en pause)', 'dismissed')
    }
    setProjectStatus(projectId, status)
  }

  /** Human message from the chat box. Starts (or wakes) the lead. */
  sendHuman(projectId: string, content: string): void {
    const project = requireProject(projectId)
    const lead = this.ensureLead(project)
    if (this.runs.has(projectId)) {
      sendBusMessage({ projectId, from: 'human', to: lead.id, kind: 'info', content })
      return
    }
    this.start(projectId, { message: content })
  }

  private async runLead(projectId: string, run: ProjectRun): Promise<void> {
    const project = requireProject(projectId)
    const lead = this.ensureLead(project)
    const models = effectiveModels(project.config)
    const model = requireModel(models.lead.model, 'chercheur principal')
    const utility = this.optionalModel(models.utility.model) ?? model
    const initial = agentMessages(lead.id, 1).length === 0 && !hasUndelivered(lead.id)
    if (initial) {
      await this.extractDeliverables(projectId, run.controller.signal)
      const provided = listProvided(projectId)
      appendMessage({
        projectId, agentId: lead.id, role: 'user', meta: { origin: 'system' },
        content: `${project.config.mode === 'autonomous'
          ? 'Démarre la recherche. Commence par cadrer la question et établir un plan détaillé, puis avance de façon autonome.'
          : 'Session interactive ouverte. Présente brièvement comment tu comptes aborder la question, puis attends les instructions ou commence le cadrage.'}${provided.length ? `\n\nL'humain a joint ${provided.length} document(s) (voir <documents_fournis>) : prends-en connaissance pendant le cadrage et tiens-en compte dans le plan, sans t'y limiter.` : ''}`,
      })
    } else if (!hasUndelivered(lead.id)) {
      // resuming after a pause, an error or a server restart
      appendMessage({
        projectId, agentId: lead.id, role: 'user', meta: { origin: 'system' },
        content: 'Reprise de la session après une interruption. Les actions en cours au moment de l\'arrêt n\'ont pas abouti. Relis ton plan et ta mémoire de travail, puis continue à partir de la prochaine action.',
      })
    }
    const startSpend = projectTokenSpend(projectId)
    const loop = new AgentLoop({
      projectId,
      agentId: lead.id,
      model,
      utilityModel: utility,
      roleConfig: models.lead,
      tools: toolsFor('lead', project),
      buildSystem: () => this.leadSystemPrompt(projectId),
      maxSteps: project.config.maxSteps,
      signal: run.controller.signal,
      runtime: this,
      tailReminder: ({ step, tokens }) => this.leadReminder(projectId, step, tokens, model),
      onNoToolReply: (_content, streak) => {
        const p = requireProject(projectId)
        if (hasUndelivered(lead.id)) return 'continue'
        if (p.config.mode === 'interactive') return 'stop'
        if (streak >= 3) return 'stop'
        appendMessage({
          projectId, agentId: lead.id, role: 'user', meta: { origin: 'system' },
          content: streak === 1
            ? 'Continue la recherche de façon autonome en utilisant tes outils (prochaine action du plan). Si le travail est réellement terminé et le rapport final écrit, appelle finish_research.'
            : 'Tu n\'as appelé aucun outil deux fois de suite. Agis maintenant (outil) ou termine avec finish_research. Sinon la session sera mise en pause.',
        })
        return 'continue'
      },
      onStepDone: step => {
        const p = getProject(projectId)
        if (!p) return 'stop'
        run.semaphore.setMax(p.config.maxParallelAgents)
        if (p.config.supervisorEvery > 0 && step - run.lastSupervisedStep >= p.config.supervisorEvery) {
          run.lastSupervisedStep = step
          void this.supervise(projectId, run)
        } else if (this.detectLoop(lead.id)) {
          run.lastSupervisedStep = step
          void this.supervise(projectId, run, 'Boucle suspectée : appels d\'outils identiques répétés.')
        }
        if (step - run.lastConsolidatedStep >= 30) {
          run.lastConsolidatedStep = step
          void this.consolidate(projectId)
        }
        if (p.config.maxTokens > 0 && projectTokenSpend(projectId) - startSpend > p.config.maxTokens) {
          log(projectId, 'warn', 'Budget de tokens atteint — pause')
          return 'stop'
        }
        return 'continue'
      },
    })

    try {
      const res = await loop.run()
      const p = requireProject(projectId)
      switch (res.reason) {
        case 'finished':
          setProjectStatus(projectId, 'finished')
          notify(projectId, 'Recherche terminée', run.finishSummary?.slice(0, 240) ?? 'Le chercheur principal a conclu.', 'success', 'runFinished')
          void this.consolidate(projectId).then(() => this.reasoningSummary(projectId)).catch(error => log(projectId, 'warn', `Résumé du raisonnement non généré : ${errorMessage(error)}`))
          break
        case 'idle':
          setProjectStatus(projectId, p.config.mode === 'interactive' ? 'idle' : 'paused')
          if (p.config.mode === 'autonomous') notify(projectId, 'Recherche en pause', 'L\'agent ne progresse plus sans instruction. Donne-lui une direction.', 'warn', 'runFinished')
          break
        case 'max_steps':
          setProjectStatus(projectId, 'paused')
          notify(projectId, 'Limite d\'étapes atteinte', `${p.config.maxSteps} étapes. Relance pour continuer.`, 'warn', 'runFinished')
          break
        case 'budget':
          setProjectStatus(projectId, 'paused')
          notify(projectId, 'Budget atteint', 'Le budget de tokens du run est épuisé.', 'warn', 'runFinished')
          break
        case 'aborted':
          if (p.status === 'running' || p.status === 'waiting_human') setProjectStatus(projectId, 'paused')
          break
        default:
          setProjectStatus(projectId, 'idle')
      }
      updateAgent(lead.id, { status: 'idle' })
    } catch (error) {
      const msg = errorMessage(error)
      log(projectId, 'error', `Run interrompu : ${msg}`, lead.id)
      updateAgent(lead.id, { status: 'error' })
      appendMessage({ projectId, agentId: lead.id, role: 'user', content: `Erreur système : ${msg}`, meta: { origin: 'system', error: true } })
      setProjectStatus(projectId, 'error')
      notify(projectId, 'Erreur', msg.slice(0, 240), 'error', 'error')
    }
  }

  /**
   * Turn the question into an explicit checklist of deliverables and
   * constraints, written into the mission block (always in context). Observed:
   * a final report silently answered a narrower question and skipped half of
   * the requested deliverables; the audit checks this list at the end.
   */
  private async extractDeliverables(projectId: string, signal: AbortSignal): Promise<void> {
    const project = requireProject(projectId)
    const mission = getBlock(projectId, 'mission')
    if (!mission || mission.value.includes('## Livrables exigés')) return
    let model: ResolvedModel
    try {
      model = this.modelFor(project, 'utility').model
    } catch {
      return
    }
    try {
      const res = await chat(model, {
        messages: [
          { role: 'system', content: 'Extrais de la question de recherche la liste exhaustive des LIVRABLES attendus et des CONTRAINTES imposées, une ligne courte chacune, fidèle au texte (n\'ajoute rien, ne fusionne pas des demandes distinctes, n\'omets pas les sous-points d\'une énumération). Réponds UNIQUEMENT en JSON : {"deliverables": ["…"], "constraints": ["…"]}' },
          { role: 'user', content: project.question },
        ],
        temperature: 0,
        maxTokens: 2000,
        signal,
        projectId,
        agentId: 'deliverables',
        retries: 1,
      })
      const out = extractJson<{ deliverables?: string[]; constraints?: string[] }>(res.content)
      if (!out?.deliverables?.length) return
      const lines = [
        '\n\n## Livrables exigés (vérifiés par l\'audit final)',
        ...out.deliverables.slice(0, 15).map(d => `- [ ] ${d}`),
        ...(out.constraints?.length ? ['## Contraintes', ...out.constraints.slice(0, 10).map(c => `- ${c}`)] : []),
        'Tout livrable non réalisé doit être déclaré comme tel dans le rapport final, avec la raison.',
      ]
      setBlock(projectId, 'mission', `${mission.value}${lines.join('\n')}`.slice(0, Math.max(mission.limit, 6000)), { force: true })
    } catch (error) {
      if (!signal.aborted) log(projectId, 'warn', `Extraction des livrables impossible : ${errorMessage(error)}`)
    }
  }

  private optionalModel(ref: string | undefined): ResolvedModel | undefined {
    try {
      return ref ? requireModel(ref, 'utilitaire') : undefined
    } catch {
      return undefined
    }
  }

  private modelFor(project: Project, kind: 'supervisor' | 'verifier' | 'subagent' | 'utility'): { model: ResolvedModel; config: RoleModelConfig } {
    const models = effectiveModels(project.config)
    const cfg = models[kind]
    const chain: RoleModelConfig[] = kind === 'subagent' ? [cfg, models.lead] : kind === 'utility' ? [cfg, models.subagent, models.lead] : [cfg, models.lead]
    for (const c of chain) {
      const m = this.optionalModel(c.model || undefined)
      if (m) return { model: m, config: c }
    }
    throw new ModelNotConfiguredError(`Aucun modèle configuré pour ${kind}`)
  }

  // ───────────────────────────── prompts ─────────────────────────────

  private leadSystemPrompt(projectId: string): string {
    const project = requireProject(projectId)
    const lead = this.ensureLead(project)
    const base = render(loadPrompt('lead'), {
      date: today(),
      domain: project.domain || 'non précisé',
      question: project.question,
      principles: principles(),
      mode: project.config.mode === 'autonomous' ? 'AUTONOME' : 'INTERACTIF',
      mode_instructions: project.config.mode === 'autonomous'
        ? 'Tu avances seul, étape après étape, sans attendre de validation. L\'humain peut intervenir à tout moment ; ses messages sont prioritaires.'
        : 'Tu travailles en dialogue avec l\'humain : réalise ce qu\'il demande (avec autant d\'étapes et d\'outils que nécessaire), puis rends-lui la main par une réponse sans appel d\'outil.',
      custom_instructions: project.config.customInstructions ? `<instructions_specifiques>\n${project.config.customInstructions}\n</instructions_specifiques>` : '',
    })
    return [base, coreMemorySection(project), providedDocumentsSection(project), memoryOverview(project), episodesSection(lead)].filter(Boolean).join('\n\n')
  }

  private leadReminder(projectId: string, step: number, tokens: number, model: ResolvedModel): string {
    const project = requireProject(projectId)
    const plan = getBlock(projectId, 'plan')?.value ?? ''
    const next = plan.split('\n').find(l => /^\s*[-*]\s*\[ \]/.test(l))?.replace(/^\s*[-*]\s*\[ \]\s*/, '')
    const pending = listRequests(projectId, 'pending')
    const running = listAgents(projectId).filter(a => a.role !== 'lead' && ['thinking', 'tool', 'waiting'].includes(a.status))
    const todo = this.pendingDuties(projectId)
    return `<rappel_etat>étape ${step + 1}${project.config.maxSteps ? `/${project.config.maxSteps}` : ''} · contexte ≈ ${Math.round(tokens / 1000)}k/${Math.round(model.contextWindow / 1000)}k tokens${next ? ` · prochaine action du plan : ${next.slice(0, 160)}` : ''}${pending.length ? ` · ${pending.length} demande(s) humaine(s) en attente` : ''}${running.length ? ` · ${running.length} agent(s) en arrière-plan` : ''}${todo.length ? `\nÀ traiter :\n${todo.map(t => `- ${t}`).join('\n')}` : ''}</rappel_etat>`
  }

  /**
   * Housekeeping the lead tends to forget (observed in real runs): refuted notes
   * left active, hypotheses never updated, stale working memory, unverified key findings.
   */
  private pendingDuties(projectId: string): string[] {
    const duties: string[] = []
    const notes = listNotes(projectId, { limit: 1000 })
    const refuted = notes.filter(n => n.verification?.verdict === 'refuted' && n.verification.at >= n.updatedAt - 5_000)
    if (refuted.length) duties.push(`${refuted.length} note(s) RÉFUTÉE(S) encore active(s) : ${refuted.slice(0, 5).map(n => `[[${n.slug}]]`).join(' ')} → corrige (memory_update) ou invalide (memory_supersede), et revois ce qui en dépend.`)
    const unverified = notes.filter(n => n.type === 'finding' && n.importance >= 4 && !n.verification)
    if (unverified.length >= 2) duties.push(`${unverified.length} résultat(s) importants non vérifiés (ex. [[${unverified[0].slug}]]) → verify_claim sur les plus centraux.`)
    const project = getProject(projectId)
    if (project && project.config.formal && project.config.formal !== 'off' && leanReady()) {
      const unreviewed = notes.filter(n => n.assurance?.level === 'formal' && !n.assurance.lean?.statementReview)
      if (unreviewed.length) duties.push(`${unreviewed.length} preuve(s) Lean acceptée(s) dont l'énoncé n'a pas été relu (${unreviewed.slice(0, 3).map(n => `[[${n.slug}]]`).join(' ')}) → verify_claim(kind="formalization", note_slug=…, context=<Challenge.lean>).`)
      if (project.config.formal === 'required') {
        const informal = notes.filter(n => n.type === 'finding' && n.importance >= 5 && n.assurance?.level !== 'formal')
        if (informal.length) duties.push(`Formalisation EXIGÉE : ${informal.length} résultat(s) central(aux) pas encore prouvé(s) en Lean (${informal.slice(0, 3).map(n => `[[${n.slug}]]`).join(' ')}) → protocole Challenge/Solution puis lean_check (ou délègue à un theorist).`)
      }
    }
    const hyps = listHypotheses(projectId).filter(h => h.status === 'proposed' || h.status === 'testing')
    const stale = hyps.filter(h => h.evidence.length === 0 && Date.now() - h.createdAt > 20 * 60_000)
    if (stale.length) duties.push(`${stale.length} hypothèse(s) sans aucune preuve depuis leur création (${stale.slice(0, 3).map(h => h.id).join(', ')}) → hypothesis_update avec les résultats obtenus (pour/contre, statut).`)
    const working = getBlock(projectId, 'working')
    if (working && Date.now() - working.updatedAt > 30 * 60_000) duties.push('Mémoire de travail inchangée depuis plus de 30 min → core_memory_edit(label="working") avec le focus actuel.')
    const provided = listProvided(projectId)
    if (provided.length) {
      const opened = openedProvided(projectId, provided)
      const ignored = provided.filter(d => !opened.has(d.id) && Date.now() - d.createdAt > 15 * 60_000)
      if (ignored.length) duties.push(`${ignored.length} document(s) fourni(s) par l'humain jamais ouvert(s) depuis plus de 15 min (${ignored.slice(0, 4).map(d => `[${d.citationKey}]`).join(' ')}) → survole-les (source_search / source_read) ou délègue leur lecture, et intègre ce qui est pertinent.`)
    }
    return duties
  }

  private subagentSystemPrompt(projectId: string, agentId: string, role: AgentRole, maxSteps: number): string {
    const project = requireProject(projectId)
    const agent = getAgent(agentId)!
    const base = render(loadPrompt('subagent'), {
      name: agent.name,
      role_label: ROLE_LABELS[role].toLowerCase(),
      role_instructions: roleInstructions(role),
      date: today(),
      project_title: project.title,
      question: project.question,
      principles: principles(),
      max_steps: maxSteps,
    })
    return [base, ['theorist', 'experimenter', 'critic'].includes(role) ? formalSection(project) : '', coreMemorySection(project, { includeBlocks: ['mission', 'human', 'lessons'] }), providedDocumentsSection(project, { max: 15, audience: 'subagent' }), memoryOverview(project, 10), episodesSection(agent, 1)].filter(Boolean).join('\n\n')
  }

  // ───────────────────────────── AgentRuntime: delegate ─────────────────────────────

  async delegate(params: { task: string; role: AgentRole; context?: string; maxSteps?: number; parent: AgentInstance; signal: AbortSignal }): Promise<string> {
    const { parent, signal } = params
    const role = SUB_ROLES.includes(params.role) ? params.role : 'scout'
    const project = requireProject(parent.projectId)
    const { model, config } = this.modelFor(project, 'subagent')
    const run = this.runs.get(project.id)
    const release = run ? await run.semaphore.acquire() : () => {}
    const count = listAgents(project.id).filter(a => a.role === role).length + 1
    const agent = createAgent({ projectId: project.id, role, name: `${ROLE_LABELS[role]} #${count}`, parentId: parent.id, task: params.task, model: model.ref })
    const maxSteps = params.maxSteps ?? 25
    try {
      appendMessage({
        projectId: project.id, agentId: agent.id, role: 'user', meta: { origin: 'agent', from: parent.id },
        content: `# Mission\n${params.task}${params.context ? `\n\n# Contexte fourni par le chercheur principal\n${params.context}` : ''}`,
      })
      const loop = new AgentLoop({
        projectId: project.id,
        agentId: agent.id,
        model,
        utilityModel: this.optionalModel(effectiveModels(project.config).utility.model),
        roleConfig: config,
        tools: toolsFor(role, project),
        buildSystem: () => this.subagentSystemPrompt(project.id, agent.id, role, maxSteps),
        maxSteps,
        signal,
        runtime: this,
        tailReminder: ({ step }) => (step >= maxSteps - 3 ? `<rappel>Il te reste ${Math.max(0, maxSteps - step)} étape(s) : rends ton rapport avec submit_result très bientôt.</rappel>` : undefined),
        onNoToolReply: () => 'stop',
      })
      const res = await loop.run()
      let report = res.result
      if (res.reason !== 'submitted' && res.reason !== 'aborted') {
        // out of budget (or stopped talking): one last turn where the only possible action is submit_result
        const fin = await this.finalTurn(project.id, agent.id, model, config, role, 'submit_result', signal,
          'Ton budget d\'étapes est épuisé. Rends MAINTENANT ton rapport condensé avec submit_result, à partir de ce que tu as établi (résultats, preuves, sources, incertitudes, ce qui reste à faire). Aucun autre outil n\'est disponible.')
        if (fin.reason === 'submitted' && fin.result.length > 50) report = fin.result
        else if (report.length < 200) report = await this.forceReport(project.id, agent.id, model, signal)
      }
      updateAgent(agent.id, { status: res.reason === 'aborted' ? 'stopped' : 'done', result: report, finished: true })
      return `## Rapport de ${agent.name} (${agent.id})\n${report || '(rapport vide)'}`
    } catch (error) {
      updateAgent(agent.id, { status: signal.aborted ? 'stopped' : 'error', result: errorMessage(error), finished: true })
      if (signal.aborted) throw error
      return `Le sous-agent ${agent.name} a échoué : ${errorMessage(error)}`
    } finally {
      release()
    }
  }

  /**
   * One extra step whose only available tool is the "submit" tool of the role.
   * Replaces guessing a verdict/report from free text when an agent runs out of
   * budget (observed: verdicts guessed as SUPPORTED on reports saying the opposite).
   */
  private async finalTurn(projectId: string, agentId: string, model: ResolvedModel, config: RoleModelConfig, role: AgentRole, toolName: 'submit_result' | 'submit_verdict', signal: AbortSignal, instruction: string): Promise<{ reason: string; result: string }> {
    const project = requireProject(projectId)
    const tool = toolsFor(role, project).find(t => t.name === toolName)
    if (!tool || signal.aborted) return { reason: 'none', result: '' }
    appendMessage({ projectId, agentId, role: 'user', content: instruction, meta: { origin: 'system' } })
    try {
      const loop = new AgentLoop({
        projectId,
        agentId,
        model,
        roleConfig: config,
        tools: [tool],
        buildSystem: () => role === 'verifier'
          ? render(loadPrompt('verifier'), { date: today(), project_title: project.title, kind: 'general', principles: principles(), max_steps: 1 })
          : this.subagentSystemPrompt(projectId, agentId, role, 1),
        maxSteps: 2,
        signal,
        runtime: this,
        onNoToolReply: () => 'stop',
      })
      return await loop.run()
    } catch (error) {
      if (signal.aborted) throw error
      return { reason: 'error', result: '' }
    }
  }

  /** Budget exhausted: ask for a final condensed report without tools. */
  private async forceReport(projectId: string, agentId: string, model: ResolvedModel, signal: AbortSignal): Promise<string> {
    const transcript = agentMessages(agentId, 60)
      .map(m => (m.role === 'tool' ? `[${m.name}] ${m.content.slice(0, 1500)}` : `[${m.role}] ${m.content.slice(0, 2500)}`))
      .join('\n\n')
    try {
      const res = await chat(model, {
        messages: [
          { role: 'system', content: 'Tu es un sous-agent de recherche dont le budget est épuisé. Rédige maintenant ton rapport final condensé à partir de ton travail ci-dessous : résultats clés, preuves (sources, notes, fichiers), confiance, incertitudes. Pas de remplissage.' },
          { role: 'user', content: transcript.slice(-120_000) },
        ],
        temperature: 0.2,
        signal,
        projectId,
        agentId,
      })
      return res.content.trim()
    } catch (error) {
      return `(rapport non produit : ${errorMessage(error)})`
    }
  }

  // ───────────────────────────── AgentRuntime: verify ─────────────────────────────

  async verify(params: { claim: string; kind: string; context?: string; noteSlug?: string; parent: AgentInstance; signal: AbortSignal; maxSteps?: number }): Promise<{ verification: Verification; report: string }> {
    const { parent, signal } = params
    const project = requireProject(parent.projectId)
    const { model, config } = this.modelFor(project, 'verifier')
    const run = this.runs.get(project.id)
    const release = run ? await run.semaphore.acquire() : () => {}
    const n = listAgents(project.id).filter(a => a.role === 'verifier').length + 1
    const agent = createAgent({ projectId: project.id, role: 'verifier', name: `Vérificateur #${n}`, parentId: parent.id, task: params.claim, model: model.ref })
    const maxSteps = params.maxSteps ?? 20
    // a formalization review judges the Lean statement, not the truth of the note: the note's own verdict is left alone
    // (only when the note has a Lean formalization; otherwise the verdict is the note's own, as for any claim)
    const formalization = params.kind === 'formalization' && Boolean(params.noteSlug && getNote(project.id, params.noteSlug)?.assurance?.lean)
    if (params.noteSlug && !formalization) setVerification(project.id, params.noteSlug, { verdict: 'pending', confidence: 0, summary: 'Vérification en cours…', at: Date.now() })
    try {
      const note = params.noteSlug ? getNote(project.id, params.noteSlug) : undefined
      appendMessage({
        projectId: project.id, agentId: agent.id, role: 'user', meta: { origin: 'agent', from: parent.id },
        content: `# Affirmation à vérifier (${params.kind})\n${params.claim}${params.context ? `\n\n# Éléments fournis par l'auteur\n${params.context}` : ''}${note ? `\n\n# Note concernée\n${noteToText(note)}` : ''}`,
      })
      const loop = new AgentLoop({
        projectId: project.id,
        agentId: agent.id,
        model,
        roleConfig: config,
        tools: toolsFor('verifier', project),
        buildSystem: () => [
          render(loadPrompt('verifier'), { date: today(), project_title: project.title, kind: params.kind, principles: principles(), max_steps: maxSteps }),
          memoryOverview(requireProject(project.id), 8),
        ].join('\n\n'),
        maxSteps,
        signal,
        runtime: this,
        tailReminder: ({ step }) => (step >= maxSteps - 3 ? '<rappel>Rends ton verdict avec submit_verdict maintenant.</rappel>' : undefined),
        onNoToolReply: () => 'stop',
      })
      const res = await loop.run()
      type Raw = { verdict?: string; confidence?: number; summary?: string; issues?: string[] }
      let raw = res.reason === 'submitted' ? extractJson<Raw>(res.result) : undefined
      if (!raw?.verdict && res.reason !== 'aborted') {
        const fin = await this.finalTurn(project.id, agent.id, model, config, 'verifier', 'submit_verdict', signal,
          'Ton budget d\'étapes est épuisé. Rends MAINTENANT ton verdict avec submit_verdict à partir de ce que tu as établi. Si tu n\'as pas pu conclure, verdict="uncertain" en expliquant ce qui manque. Aucun autre outil n\'est disponible.')
        if (fin.reason === 'submitted') raw = extractJson<Raw>(fin.result)
      }
      if (!raw?.verdict) {
        // never guess a verdict from keywords: an unreadable conclusion is "uncertain"
        raw = { verdict: 'uncertain', confidence: 0.2, summary: `Le vérificateur n'a pas rendu de verdict structuré. Dernières conclusions : ${res.result.slice(0, 1200) || '(aucune)'}`, issues: [] }
      }
      const verdict = (['supported', 'refuted', 'uncertain'].includes(raw.verdict ?? '') ? raw.verdict : 'uncertain') as Verification['verdict']
      const verification: Verification = {
        verdict,
        confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.5))),
        summary: String(raw.summary ?? ''),
        issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
        at: Date.now(),
      }
      if (params.noteSlug && formalization) {
        setStatementReview(project.id, params.noteSlug, { verdict, by: agent.id, summary: verification.summary })
      } else if (params.noteSlug) {
        setVerification(project.id, params.noteSlug, verification)
        // a confident refutation immediately lowers the note's weight; the lead still decides to fix or supersede it
        const target = getNote(project.id, params.noteSlug)
        if (target && verdict === 'refuted' && verification.confidence >= 0.6) {
          updateNote(project.id, target.slug, { confidence: Math.min(target.confidence, 0.25), tags: [...new Set([...target.tags, 'réfutée'])] })
          downgradeAssurance(project.id, target.slug, agent.id, verification.summary.slice(0, 300))
        } else if (target && verdict === 'supported') {
          // « computed » only when the verifier really ran something (database, not its own claim)
          const ran = all<{ n: number }>("SELECT COUNT(*) AS n FROM tool_runs WHERE agent_id = ? AND status = 'ok' AND tool IN ('python', 'bash', 'lean_run', 'lean_check')", agent.id)[0]?.n ?? 0
          recordAssurance(project.id, target.slug, {
            level: ran > 0 ? 'computed' : 'reviewed',
            by: agent.id,
            detail: `${ran > 0 ? `Vérifié avec ${ran} exécution(s) de code` : 'Vérifié par relecture (aucun calcul exécuté)'} — confiance ${Math.round(verification.confidence * 100)} %. ${verification.summary.slice(0, 240)}`,
          })
        }
      }
      updateAgent(agent.id, { status: 'done', result: `${verdict} (${Math.round(verification.confidence * 100)}%) — ${verification.summary}`, finished: true })
      const report = `## ${formalization ? "Fidélité de l'énoncé Lean" : 'Verdict du vérificateur'} : ${verdict.toUpperCase()} (confiance ${Math.round(verification.confidence * 100)}%)\n${verification.summary}${verification.issues?.length ? `\n\nProblèmes relevés :\n${verification.issues.map(i => `- ${i}`).join('\n')}` : ''}${params.noteSlug ? `\n(Verdict attaché à [[${params.noteSlug}]])` : ''}`
      return { verification, report }
    } catch (error) {
      updateAgent(agent.id, { status: signal.aborted ? 'stopped' : 'error', result: errorMessage(error), finished: true })
      if (params.noteSlug && !formalization) setVerification(project.id, params.noteSlug, { verdict: 'uncertain', confidence: 0, summary: `Vérification interrompue : ${errorMessage(error)}`, at: Date.now() })
      if (signal.aborted) throw error
      const verification: Verification = { verdict: 'uncertain', confidence: 0, summary: errorMessage(error), at: Date.now() }
      return { verification, report: `Vérification impossible : ${errorMessage(error)}` }
    } finally {
      release()
    }
  }

  /** Auto-verify important new findings in the background; result goes to the lead's inbox. */
  scheduleAutoVerify(projectId: string, noteSlug: string): void {
    const run = this.runs.get(projectId)
    if (!run) return
    // Auto-verification was ~75 % of all tokens in real runs: cap the backlog.
    // Skipped findings stay "non vérifiées" and the lead is reminded of them.
    const queued = this.verifyQueue.get(projectId) ?? 0
    if (queued >= 3) {
      log(projectId, 'info', `Auto-vérification de [[${noteSlug}]] différée (file pleine) — le chercheur principal peut la demander via verify_claim`)
      return
    }
    this.verifyQueue.set(projectId, queued + 1)
    const sem = this.verifySem.get(projectId) ?? new Semaphore(1)
    this.verifySem.set(projectId, sem)
    void (async () => {
      const release = await sem.acquire()
      try {
        const note = getNote(projectId, noteSlug)
        if (!note || note.verification || run.controller.signal.aborted) return
        const lead = this.ensureLead(requireProject(projectId))
        const kind = /\$|∫|∑|theorem|théorème|lemme|preuve|proof|équation/i.test(note.content) ? 'math' : note.sourceIds.length ? 'citation' : 'general'
        const { verification, report } = await this.verify({ claim: `${note.title}\n\n${note.content}`, kind, noteSlug: note.slug, parent: lead, signal: run.controller.signal, maxSteps: 14 })
        sendBusMessage({
          projectId, from: 'verifier', to: lead.id,
          kind: verification.verdict === 'refuted' ? 'warning' : 'verification',
          content: `Vérification automatique de [[${note.slug}]] :\n${report}${verification.verdict === 'refuted' ? '\n→ Corrige ou invalide cette note (memory_supersede) et revois ce qui en dépend.' : ''}`,
        })
      } catch (error) {
        if (!run.controller.signal.aborted) log(projectId, 'warn', `Auto-vérification échouée : ${errorMessage(error)}`)
      } finally {
        this.verifyQueue.set(projectId, Math.max(0, (this.verifyQueue.get(projectId) ?? 1) - 1))
        release()
      }
    })()
  }

  // ───────────────────────────── AgentRuntime: tournament ─────────────────────────────

  async tournament(params: { rounds: number; parent: AgentInstance; signal: AbortSignal }): Promise<string> {
    const project = requireProject(params.parent.projectId)
    const active = listHypotheses(project.id).filter(h => !['refuted', 'abandoned'].includes(h.status))
    if (active.length < 2) return 'Il faut au moins 2 hypothèses actives pour un tournoi.'
    const { model, config } = this.modelFor(project, 'verifier')
    const lines: string[] = []
    for (let r = 0; r < params.rounds; r++) {
      if (params.signal.aborted) break
      const pool = listHypotheses(project.id).filter(h => !['refuted', 'abandoned'].includes(h.status))
      // pair the least-played hypothesis with its closest Elo neighbour
      const a = [...pool].sort((x, y) => x.matches - y.matches)[0]
      const b = pool.filter(h => h.id !== a.id).sort((x, y) => Math.abs(x.elo - a.elo) - Math.abs(y.elo - a.elo) + (Math.random() - 0.5) * 40)[0]
      const fmt = (h: typeof a): string => `${h.statement}\nJustification: ${h.rationale || '—'}\nPlan de test: ${h.testPlan || '—'}\nPreuves pour: ${h.evidence.filter(e => e.stance === 'for').map(e => e.text).join(' | ') || '—'}\nPreuves contre: ${h.evidence.filter(e => e.stance === 'against').map(e => e.text).join(' | ') || '—'}`
      try {
        const res = await chat(model, {
          messages: [
            { role: 'system', content: loadPrompt('tournament') },
            { role: 'user', content: `Question de recherche : ${project.question}\n\n${memoryOverview(project, 10)}\n\n## Hypothèse A\n${fmt(a)}\n\n## Hypothèse B\n${fmt(b)}` },
          ],
          temperature: config.temperature ?? 0.2,
          signal: params.signal,
          projectId: project.id,
          agentId: 'tournament',
        })
        const verdict = extractJson<{ winner?: string; reason?: string }>(res.content)
        const w = verdict?.winner === 'A' ? 'a' : verdict?.winner === 'B' ? 'b' : 'draw'
        recordMatch(project.id, a.id, b.id, w)
        lines.push(`- ${a.id} vs ${b.id} → ${w === 'a' ? a.id : w === 'b' ? b.id : 'nul'} : ${verdict?.reason ?? ''}`)
      } catch (error) {
        if (params.signal.aborted) throw error
        lines.push(`- duel ${a.id}/${b.id} échoué : ${errorMessage(error)}`)
      }
    }
    const standings = listHypotheses(project.id).filter(h => !['refuted', 'abandoned'].includes(h.status))
    return `Tournoi (${lines.length} duels) :\n${lines.join('\n')}\n\nClassement :\n${standings.map((h, i) => `${i + 1}. ${h.id} Elo ${h.elo} (${h.matches} duels) — ${h.statement.slice(0, 160)}`).join('\n')}`
  }

  // ───────────────────────────── AgentRuntime: human & bus ─────────────────────────────

  async askHuman(params: { kind: HumanRequest['kind']; title: string; body: string; options?: string[]; blocking: boolean; payload?: Record<string, unknown>; sourceId?: string; agent: AgentInstance; signal: AbortSignal; timeoutMs?: number }): Promise<HumanRequest> {
    const req = createRequest({
      projectId: params.agent.projectId,
      agentId: params.agent.id,
      kind: params.kind,
      title: params.title,
      body: params.body,
      options: params.options?.length ? params.options : undefined,
      blocking: params.blocking,
      payload: params.payload,
      sourceId: params.sourceId,
    })
    if (!params.blocking) return req
    updateAgent(params.agent.id, { status: 'waiting' })
    setProjectStatus(params.agent.projectId, 'waiting_human')
    // an unanswered request expires instead of blocking a background agent until its own timeout
    const expiry = params.timeoutMs ? setTimeout(() => {
      if (listRequests(params.agent.projectId, 'pending').some(r => r.id === req.id)) {
        resolveRequest(req.id, `Sans réponse de l'humain après ${Math.round(params.timeoutMs! / 60_000)} min`, 'dismissed')
      }
    }, params.timeoutMs) : undefined
    try {
      return await waitForRequest(req.id, params.signal)
    } finally {
      clearTimeout(expiry)
      if (!params.signal.aborted) {
        const stillBlocked = listAgents(params.agent.projectId).some(a => pendingBlockingFor(a.id).length > 0)
        if (!stillBlocked && this.runs.has(params.agent.projectId)) setProjectStatus(params.agent.projectId, 'running')
      }
    }
  }

  sendMessage(params: { from: string; to: string; content: string; kind?: 'info' | 'reply' | 'report' | 'suggestion' }): void {
    const from = getAgent(params.from)
    if (!from) return
    sendBusMessage({ projectId: from.projectId, from: params.from, to: params.to, kind: params.kind ?? 'info', content: params.content })
  }

  async auditReport(params: { file?: string; agent: AgentInstance; signal: AbortSignal; final?: boolean; contested?: string[] }): Promise<{ text: string; accept: boolean; file?: string }> {
    const project = requireProject(params.agent.projectId)
    const file = findReport(project.id, params.file)
    if (!file) {
      const run = this.runs.get(project.id)
      if (params.final && run) run.finishAttempts = (run.finishAttempts ?? 0) + 1
      // a definitively blocked lead may close without a report, but only after being asked once
      const accept = Boolean(params.final && run && run.finishAttempts! >= 2)
      return { text: accept ? 'Clôture sans rapport final (l\'agent s\'est déclaré bloqué).' : 'Aucun rapport trouvé dans reports/ : écris d\'abord le rapport final avec write_report. Si tu es définitivement bloqué, rappelle finish_research en l\'expliquant dans le bilan.', accept }
    }
    let model: ResolvedModel | undefined
    try {
      model = this.modelFor(project, 'verifier').model
    } catch {
      model = undefined
    }
    const result = await auditReport(project, file, model, params.signal)
    const run = this.runs.get(project.id)
    let accept = result.blocking === 0
    let note = ''
    const contested = (params.contested ?? []).map(c => c.trim()).filter(Boolean)
    const blockingIssues = result.issues.filter(i => i.source !== 'critique' && i.severity !== 'mineur')
    if (run) {
      run.audits = (run.audits ?? 0) + 1
      run.seenIssues ??= new Map()
      for (const i of blockingIssues) run.seenIssues.set(`${i.kind}|${i.detail}`, (run.seenIssues.get(`${i.kind}|${i.detail}`) ?? 0) + 1)
    }
    // the same issue coming back again and again: either a false positive or a fix that does not work
    const recurring = run ? blockingIssues.filter(i => (run.seenIssues!.get(`${i.kind}|${i.detail}`) ?? 0) >= 3) : []
    if (!accept && recurring.length) {
      note += `\n\n**Ces points reviennent pour la 3e fois ou plus** : ${recurring.slice(0, 4).map(i => `« ${i.detail.slice(0, 90)} »`).join(' ; ')}. Arrête de réécrire le rapport pour eux. Si c'est un faux positif de l'audit, appelle finish_research avec contested=[« point : justification vérifiable »] : la clôture sera acceptée et ta justification consignée en annexe pour l'humain.`
    }
    if (params.final && run) {
      run.finishAttempts = (run.finishAttempts ?? 0) + 1
      if (!accept && contested.length && (run.audits ?? 0) >= 2) {
        // a justified objection after at least one audit: accept, and show the objection to the human
        accept = true
        note += '\n\n(Clôture acceptée : les points contestés et leurs justifications sont consignés en annexe du rapport.)'
      } else if (!accept && run.finishAttempts > 2) {
        // never trap the lead forever: after two refusals the report is accepted, with the audit attached
        accept = true
        note += '\n\n(Clôture acceptée après deux refus : les problèmes restants sont consignés dans l\'audit joint au rapport.)'
      }
    }
    const text = formatAudit(result) + note
    if (params.final && accept) {
      const body = fs.readFileSync(file, 'utf8').split('\n---\n\n## Annexes générées par Noesis')[0].trimEnd()
      const facts = result.issues.filter(i => i.source !== 'critique' && i.severity !== 'mineur')
      const opinions = result.issues.filter(i => i.source === 'critique')
      const sections = [
        facts.length ? `\n\n### D. Problèmes non résolus relevés par l'audit (contrôles contre la base)\n${facts.map(i => `- **${i.severity}** — ${i.kind} : ${i.detail}`).join('\n')}` : '',
        contested.length ? `\n\n### E. Points contestés par l'agent (justifications non vérifiées par Noesis)\n${contested.map(c => `- ${c}`).join('\n')}` : '',
        opinions.length ? `\n\n### ${contested.length ? 'F' : 'E'}. Réserves de l'auditeur (avis d'un modèle relecteur)\n${opinions.map(i => `- ${i.kind} : ${i.detail}`).join('\n')}` : '',
      ]
      fs.writeFileSync(file, `${body}${result.annex}${sections.join('')}\n`, 'utf8')
      bus.publish(project.id, { type: 'files.changed' })
    }
    return { text, accept, file: path.relative(workspaceDir(project.id), file).replace(/\\/g, '/') }
  }

  finish(params: { agent: AgentInstance; summary: string }): void {
    const run = this.runs.get(params.agent.projectId)
    if (run) run.finishSummary = params.summary
    sendBusMessage({ projectId: params.agent.projectId, from: params.agent.id, to: 'human', kind: 'report', content: params.summary })
  }

  private docBatches = new Map<string, Source[]>()

  /**
   * The human dropped documents into the project. While a run is active the lead
   * is told (batched: dropping 30 files yields one message); otherwise the
   * <documents_fournis> section of its prompt is enough.
   */
  onDocumentsProvided(projectId: string, sources: Source[]): void {
    const batch = this.docBatches.get(projectId)
    if (batch) {
      batch.push(...sources)
      return
    }
    this.docBatches.set(projectId, [...sources])
    setTimeout(() => {
      const done = this.docBatches.get(projectId) ?? []
      this.docBatches.delete(projectId)
      const project = getProject(projectId)
      if (!done.length || !project || !this.runs.has(projectId)) return
      const lead = this.ensureLead(project)
      const list = done.slice(0, 25).map(s => `- [${s.citationKey}] ${s.title}${s.file ? ` (${s.file})` : ''}`).join('\n')
      sendBusMessage({
        projectId, from: 'human', to: lead.id, kind: 'info',
        content: `J'ai ajouté ${done.length} document(s) en contexte :\n${list}${done.length > 25 ? `\n… et ${done.length - 25} autre(s) (source_list origin="human")` : ''}\nTiens-en compte (survole-les, intègre ce qui est pertinent au plan), sans abandonner ta propre recherche.`,
      })
    }, 4000)
  }

  /** Called by the API when the human answers a non-blocking request. */
  onRequestResolved(req: HumanRequest): void {
    if (req.blocking) return
    const project = getProject(req.projectId)
    if (!project) return
    const lead = this.ensureLead(project)
    const text = req.kind === 'pdf'
      ? `Le document demandé (${req.title}) ${req.status === 'resolved' ? `est disponible${req.sourceId ? ' dans la bibliothèque (source_read)' : ''}. ${req.response ?? ''}` : 'ne sera pas fourni par l\'humain.'}`
      : `Réponse de l'humain à « ${req.title} » : ${req.status === 'resolved' ? req.response : '(ignorée)'}`
    sendBusMessage({ projectId: project.id, from: 'human', to: lead.id, kind: 'info', content: text })
  }

  // ───────────────────────────── Supervisor ─────────────────────────────

  private detectLoop(agentId: string): boolean {
    const recent = agentMessages(agentId, 24).filter(m => m.role === 'assistant' && m.toolCalls?.length)
    const sigs = recent.flatMap(m => m.toolCalls!.map(tc => `${tc.name}:${tc.arguments}`)).slice(-12)
    const counts = new Map<string, number>()
    for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1)
    return [...counts.values()].some(c => c >= 3)
  }

  /** Per-tool error rates over the last 150 calls of every agent, plus open circuits. */
  private toolHealthDigest(projectId: string): string {
    const rows = all<{ tool: string; status: string; result: string | null }>(
      'SELECT tool, status, substr(result, 1, 160) AS result FROM tool_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 150', projectId,
    )
    const by = new Map<string, { n: number; err: number; last?: string }>()
    for (const r of rows) {
      const s = by.get(r.tool) ?? { n: 0, err: 0 }
      s.n++
      if (r.status !== 'ok') {
        s.err++
        s.last ??= r.result?.replace(/\s+/g, ' ') ?? ''
      }
      by.set(r.tool, s)
    }
    const lines = [...by].filter(([, s]) => s.err > 0).sort((a, b) => b[1].err - a[1].err)
      .map(([tool, s]) => `- ${tool} : ${s.err}/${s.n} échecs${s.last ? ` — ex. « ${s.last.slice(0, 140)} »` : ''}`)
    const down = healthSnapshot(projectId).filter(h => h.disabled).map(h => h.tool)
    const academic = academicStatus().map(a => `${a.backend} (${a.minutesLeft} min : ${a.reason.slice(0, 60)})`)
    return [
      lines.join('\n') || 'Aucun échec récent.',
      down.length ? `Outils désactivés temporairement : ${down.join(', ')}` : '',
      academic.length ? `Bases académiques en pause : ${academic.join(' ; ')}` : '',
    ].filter(Boolean).join('\n')
  }

  /** Sub-agents and verifications at a glance (to spot over-delegation or ignored refutations). */
  private teamDigest(projectId: string): string {
    const agents = listAgents(projectId).filter(a => !['lead', 'supervisor', 'librarian'].includes(a.role))
    const byRole = new Map<string, number>()
    for (const a of agents) byRole.set(a.role, (byRole.get(a.role) ?? 0) + 1)
    const verdicts = listNotes(projectId, { includeInactive: true, limit: 1000 }).filter(n => n.verification && n.verification.verdict !== 'pending')
    const count = (v: string): number => verdicts.filter(n => n.verification!.verdict === v).length
    return `Sous-agents lancés : ${[...byRole].map(([r, n]) => `${r} ×${n}`).join(', ') || 'aucun'} · actifs : ${agents.filter(a => ['thinking', 'tool', 'waiting'].includes(a.status)).length}\nVerdicts : ${count('supported')} vérifiés, ${count('refuted')} réfutés, ${count('uncertain')} incertains`
  }

  async supervise(projectId: string, run?: ProjectRun, trigger?: string): Promise<void> {
    const r = run ?? this.runs.get(projectId)
    if (r?.supervising) return
    if (r) r.supervising = true
    const project = requireProject(projectId)
    const lead = this.ensureLead(project)
    let sup: AgentInstance | undefined
    try {
      const { model, config } = this.modelFor(project, 'supervisor')
      sup = getAgent(`sup_${projectId}`) ?? createAgent({ id: `sup_${projectId}`, projectId, role: 'supervisor', name: 'Superviseur', model: model.ref })
      updateAgent(sup.id, { status: 'thinking', model: model.ref })
      const recent = agentMessages(lead.id, 40)
      const trajectory = recent.map(m => {
        if (m.role === 'assistant') return `[lead] ${m.content.slice(0, 700)}${m.toolCalls?.length ? `\n  → ${m.toolCalls.map(tc => `${tc.name}(${tc.arguments.slice(0, 200)})`).join('\n  → ')}` : ''}`
        if (m.role === 'tool') return `  ← ${m.name} [${m.meta?.toolStatus ?? 'ok'}] ${m.content.slice(0, 300).replace(/\n/g, ' ')}`
        return `[${m.meta?.origin ?? m.role}] ${m.content.slice(0, 500)}`
      }).join('\n')
      const toolMsgs = recent.filter(m => m.role === 'tool')
      const errRate = toolMsgs.length ? toolMsgs.filter(m => m.meta?.toolStatus === 'error').length / toolMsgs.length : 0
      const notes = listNotes(projectId, { limit: 15 }).map(n => `- ${noteToText(n, false)}`).join('\n')
      if (r) r.lastSupervisedAt = Date.now()
      const input = [
        `# Question\n${project.question}`,
        coreMemorySection(project, { includeBlocks: ['mission', 'plan', 'working', 'lessons', 'human'] }),
        providedDocumentsSection(project, { max: 20 }),
        `# Statistiques\nétapes du lead : ${lead.steps} · taux d'erreur d'outils récent (lead) : ${Math.round(errRate * 100)}% · notes : ${listNotes(projectId).length} · hypothèses : ${listHypotheses(projectId).length}${trigger ? `\nDéclencheur : ${trigger}` : ''}`,
        `# Santé des outils (tous agents confondus)\n${this.toolHealthDigest(projectId)}`,
        `# Équipe et vérifications\n${this.teamDigest(projectId)}`,
        `# Points en suspens détectés automatiquement\n${this.pendingDuties(projectId).map(d => `- ${d}`).join('\n') || '(aucun)'}`,
        `# Notes principales\n${notes || '(aucune)'}`,
        `# Trajectoire récente du chercheur principal\n${trajectory}`,
      ].join('\n\n')
      const res = await chat(model, {
        messages: [{ role: 'system', content: loadPrompt('supervisor') }, { role: 'user', content: input }],
        temperature: config.temperature ?? 0.2,
        projectId,
        agentId: sup.id,
        signal: r?.controller.signal,
      })
      const out = extractJson<{ status?: string; severity?: string; assessment?: string; suggestions?: string[]; message_to_lead?: string; lessons?: string[]; alert_human?: string }>(res.content)
      if (!out) throw new Error('Réponse du superviseur non JSON')
      const severity = out.severity === 'critical' ? 'critical' : out.severity === 'warn' ? 'warning' : 'suggestion'
      const body = [
        `Diagnostic (${out.status ?? '?'}) : ${out.assessment ?? ''}`,
        out.suggestions?.length ? `Suggestions :\n${out.suggestions.map(s => `- ${s}`).join('\n')}` : '',
        out.message_to_lead ? `Message : ${out.message_to_lead}` : '',
      ].filter(Boolean).join('\n')
      appendMessage({ projectId, agentId: sup.id, role: 'assistant', content: body, meta: { status: out.status, severity: out.severity } })
      const worth = out.severity !== 'info' || (out.suggestions?.length ?? 0) > 0 || Boolean(out.message_to_lead)
      if (worth && this.runs.has(projectId)) sendBusMessage({ projectId, from: 'supervisor', to: lead.id, kind: severity, content: body })
      if (out.lessons?.length) this.addLessons(projectId, out.lessons)
      if (out.severity === 'critical') notify(projectId, 'Alerte du superviseur', out.assessment ?? '', 'warn', 'supervisorCritical')
      if (out.alert_human?.trim()) {
        // something only the human can fix (API key, quota, paywalled key source…)
        sendBusMessage({ projectId, from: 'supervisor', to: 'human', kind: 'warning', content: out.alert_human })
        notify(projectId, 'Le superviseur a besoin de toi', out.alert_human.slice(0, 220), 'warn', 'supervisorCritical')
      }
      updateAgent(sup.id, { status: 'idle', steps: sup.steps + 1 })
    } catch (error) {
      if (sup) updateAgent(sup.id, { status: 'idle' })
      if (!(r?.controller.signal.aborted)) log(projectId, 'warn', `Supervision échouée : ${errorMessage(error)}`)
    } finally {
      if (r) r.supervising = false
    }
  }

  private addLessons(projectId: string, lessons: string[]): void {
    const block = getBlock(projectId, 'lessons')
    if (!block) return
    let value = block.value
    for (const l of lessons) {
      const line = `- ${l.trim()}`
      if (!value.includes(l.trim().slice(0, 40))) value = value ? `${value}\n${line}` : line
    }
    // keep within limit: drop oldest lines
    const lines = value.split('\n')
    while (lines.join('\n').length > block.limit && lines.length > 1) lines.shift()
    setBlock(projectId, 'lessons', lines.join('\n'))
  }

  // ───────────────────────────── Publication ─────────────────────────────

  /** Abridged reasoning summary (reports/_resume-raisonnement.md), written with the lead's model. */
  async reasoningSummary(projectId: string, signal?: AbortSignal): Promise<string> {
    const project = requireProject(projectId)
    const models = effectiveModels(project.config)
    const model = this.optionalModel(models.lead.model) ?? this.modelFor(project, 'utility').model
    const { file } = await generateReasoningSummary(project, model, signal)
    return path.relative(workspaceDir(projectId), file).replace(/\\/g, '/')
  }

  // ───────────────────────────── Librarian (sleep-time consolidation) ─────────────────────────────

  async consolidate(projectId: string): Promise<string> {
    const run = this.runs.get(projectId)
    if (run?.consolidating) return 'Consolidation déjà en cours.'
    if (run) run.consolidating = true
    const project = requireProject(projectId)
    let lib: AgentInstance | undefined
    try {
      const { model } = this.modelFor(project, 'utility')
      lib = getAgent(`lib_${projectId}`) ?? createAgent({ id: `lib_${projectId}`, projectId, role: 'librarian', name: 'Bibliothécaire', model: model.ref })
      updateAgent(lib.id, { status: 'thinking' })
      const recent = listNotes(projectId, { limit: 1000 }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 25)
      if (recent.length < 3) {
        updateAgent(lib.id, { status: 'idle' })
        return 'Pas assez de notes pour consolider.'
      }
      const neighbours = new Map<string, string>()
      for (const n of recent) for (const s of similarNotes(projectId, `${n.title} ${n.content.slice(0, 200)}`, n.id, 3)) neighbours.set(s.slug, noteToText(s))
      for (const n of recent) neighbours.delete(n.slug)
      const input = `# Question\n${project.question}\n\n# Notes récentes\n${recent.map(n => noteToText(n).slice(0, 1800)).join('\n\n')}\n\n# Notes proches existantes\n${[...neighbours.values()].map(t => t.slice(0, 1200)).join('\n\n') || '(aucune)'}`
      const res = await chat(model, {
        messages: [{ role: 'system', content: loadPrompt('librarian') }, { role: 'user', content: input }],
        temperature: 0.1,
        projectId,
        agentId: lib.id,
        signal: run?.controller.signal,
      })
      const out = extractJson<{ operations?: Array<Record<string, any>> }>(res.content)
      const done: string[] = []
      for (const op of out?.operations ?? []) {
        try {
          switch (op.op) {
            case 'link':
              if (getNote(projectId, op.a) && getNote(projectId, op.b)) {
                updateNote(projectId, op.a, { links: [op.b] })
                done.push(`lien [[${op.a}]] ↔ [[${op.b}]]`)
              }
              break
            case 'supersede':
              if (getNote(projectId, op.slug)) {
                supersedeNote(projectId, op.slug, op.by || undefined, String(op.reason ?? 'consolidation'))
                done.push(`invalidée [[${op.slug}]]`)
              }
              break
            case 'merge':
              if (getNote(projectId, op.keep) && getNote(projectId, op.drop) && op.keep !== op.drop) {
                if (op.content) updateNote(projectId, op.keep, { content: String(op.content) })
                supersedeNote(projectId, op.drop, op.keep, 'doublon fusionné par le bibliothécaire')
                done.push(`fusion [[${op.drop}]] → [[${op.keep}]]`)
              }
              break
            case 'insight': {
              const n = createNote(projectId, { title: String(op.title), content: String(op.content), type: 'insight', links: op.links ?? [], importance: op.importance ?? 3 }, lib.id)
              done.push(`synthèse [[${n.slug}]]`)
              break
            }
            case 'adjust':
              if (getNote(projectId, op.slug)) {
                updateNote(projectId, op.slug, { type: op.type, importance: op.importance, tags: op.tags })
                done.push(`ajustée [[${op.slug}]]`)
              }
              break
            case 'lesson':
              if (op.text) this.addLessons(projectId, [String(op.text)])
              break
          }
        } catch {
          // skip invalid operation
        }
      }
      const summary = done.length ? `Consolidation : ${done.join(', ')}` : 'Consolidation : rien à changer.'
      appendMessage({ projectId, agentId: lib.id, role: 'assistant', content: summary })
      updateAgent(lib.id, { status: 'idle', steps: lib.steps + 1 })
      return summary
    } catch (error) {
      if (lib) updateAgent(lib.id, { status: 'idle' })
      log(projectId, 'warn', `Consolidation échouée : ${errorMessage(error)}`)
      return `Consolidation échouée : ${errorMessage(error)}`
    } finally {
      if (run) run.consolidating = false
    }
  }
}

export const orchestrator = new Orchestrator()

/** Lean guidance for agents that may formalize, according to the project's policy. */
export function formalSection(project: Project): string {
  const policy = project.config.formal ?? 'off'
  if (policy === 'off') return ''
  if (!leanReady()) {
    return '<formalisation_lean>\nLa formalisation Lean est demandée pour ce projet, mais l\'environnement Lean n\'est pas installé ou pas prêt sur cette machine : les outils Lean sont indisponibles. Mentionne-le dans les limites du rapport ; n\'affirme jamais qu\'un résultat est formellement prouvé.\n</formalisation_lean>'
  }
  return render(loadPrompt('lean'), {
    policy: policy === 'required' ? 'EXIGÉE' : 'recommandée quand c\'est pertinent',
    policy_detail: policy === 'required'
      ? 'Ici la formalisation est EXIGÉE : le résultat principal doit atteindre le niveau « Prouvé en Lean », énoncé relu, avant le rapport final. Si c\'est impossible, le rapport l\'explique précisément (ce qui manque dans Mathlib, quelle étape résiste).'
      : 'Formalise le résultat principal quand c\'est faisable en un temps raisonnable ; sinon le niveau « contrôlé par calcul » reste honorable s\'il est annoncé comme tel.',
  })
}

/** React to new important findings (auto-verification). */
export function startOrchestratorHooks(): void {
  bus.subscribeAll((projectId, event) => {
    if (event.type !== 'note.upserted') return
    const n = event.note
    if (n.createdAt !== n.updatedAt || n.verification || n.status !== 'active') return
    if (n.type !== 'finding' || n.importance < 4) return
    if (n.createdBy === 'librarian' || n.createdBy.startsWith('veri')) return
    const project = getProject(projectId)
    if (!project?.config.autoVerify || !orchestrator.isRunning(projectId)) return
    orchestrator.scheduleAutoVerify(projectId, n.slug)
  })
}
