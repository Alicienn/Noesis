import type { AgentInstance, ChatMessage, Project } from '../../shared/types.ts'
import { estimateTokens } from '../core/util.ts'
import type { LlmMessage } from '../llm/types.ts'
import { listBlocks } from '../store/blocks.ts'
import { listHypotheses } from '../store/hypotheses.ts'
import { listNotes, listEpisodes, noteToText } from '../memory/notes.ts'
import { listSources } from '../store/sources.ts'
import { listRequests } from '../store/requests.ts'
import { listProvided, openedProvided } from '../store/documents.ts'

/**
 * Context engineering for every LLM step.
 *
 * Layout (stable prefix first, for prompt caching; volatile state last, to
 * fight "lost in the middle" / context rot):
 *   [system]  role prompt + core memory blocks + memory overview + last episode summaries
 *   [history] live messages, with old bulky tool results cleared
 *   [tail]    an ephemeral state reminder appended to the last message
 */

export interface BuiltContext {
  messages: LlmMessage[]
  tokens: number
}

const CLEAR_MIN_CHARS = 1200

export function coreMemorySection(project: Project, opts: { includeBlocks?: string[] } = {}): string {
  const blocks = listBlocks(project.id).filter(b => !opts.includeBlocks || opts.includeBlocks.includes(b.label))
  const parts = blocks.map(b => `<bloc label="${b.label}" taille="${b.value.length}/${b.limit}">\n${b.value || '(vide)'}\n</bloc>`)
  return `<memoire_centrale>\nCes blocs sont toujours visibles. Modifie-les avec core_memory_edit / update_plan.\n${parts.join('\n')}\n</memoire_centrale>`
}

export function memoryOverview(project: Project, maxNotes = 18): string {
  const notes = listNotes(project.id, { limit: 400 })
  const top = notes.slice(0, maxNotes)
  const counts = new Map<string, number>()
  for (const n of notes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1)
  const hyps = listHypotheses(project.id).filter(h => h.status !== 'abandoned').slice(0, 8)
  const sources = listSources(project.id)
  const full = sources.filter(s => s.status === 'full_text').length
  const pending = listRequests(project.id, 'pending')
  const lines: string[] = ['<apercu_memoire>']
  lines.push(`Mémoire long terme : ${notes.length} notes actives (${[...counts].map(([t, c]) => `${t}: ${c}`).join(', ') || 'aucune'}). Utilise memory_search / memory_read pour le contenu.`)
  if (top.length) lines.push('Notes les plus importantes :', ...top.map(n => `- ${noteToText(n, false)}`))
  if (hyps.length) lines.push('Hypothèses (par Elo) :', ...hyps.map(h => `- ${h.id} [${h.status}] Elo ${h.elo} : ${h.statement.slice(0, 200)}`))
  lines.push(`Bibliothèque : ${sources.length} sources (${full} en texte intégral${sources.filter(s => s.status === 'requested').length ? `, ${sources.filter(s => s.status === 'requested').length} PDF demandés à l'humain` : ''}).`)
  if (pending.length) lines.push(`Demandes en attente auprès de l'humain : ${pending.map(r => `${r.id} (${r.kind}) ${r.title}`).join(' ; ')}`)
  lines.push('</apercu_memoire>')
  return lines.join('\n')
}

/**
 * Documents the human dropped into the project. They are context to take into
 * account — not the scope of the research, nor established truth.
 */
export function providedDocumentsSection(project: Project, opts: { max?: number; audience?: 'lead' | 'subagent' } = {}): string {
  const docs = listProvided(project.id)
  if (!docs.length) return ''
  const max = opts.max ?? 40
  const opened = openedProvided(project.id, docs)
  const unopened = docs.filter(d => !opened.has(d.id)).length
  const size = (d: (typeof docs)[number]): string => (d.pages ? `${d.pages} p.` : d.chars ? `${d.chars >= 10_000 ? `${Math.round(d.chars / 1000)}k` : d.chars} car.` : 'pas de texte indexé')
  // unopened documents first: they are the ones that still need attention
  const ordered = [...docs.filter(d => !opened.has(d.id)), ...docs.filter(d => opened.has(d.id))]
  const lines = ordered.slice(0, max).map(d => `- [${d.citationKey}] ${d.title.slice(0, 120)} — ${(d.venue ?? '').replace(/^Document fourni · /, '')}, ${size(d)} · ${d.file ?? ''}${d.notes ? ` · ⚠ ${d.notes.slice(0, 160)}` : ''} · ${opened.has(d.id) ? 'consulté' : 'PAS ENCORE OUVERT'}`)
  const more = docs.length > max ? `… et ${docs.length - max} autre(s) : source_list(origin="human").` : ''
  const rules = opts.audience === 'subagent'
    ? 'Consulte ceux qui concernent ta tâche (source_search / source_read) et cite-les avec leur clé. Ce sont des éléments de contexte, pas des vérités établies ni les seules sources à lire.'
    : [
      'Statut : du CONTEXTE à prendre en compte, pas le périmètre exclusif de la recherche.',
      '- Prends-en connaissance tôt (survol ciblé : source_search, source_read avec section/pattern ou max_chars réduit) et intègre ce qui est pertinent au plan, aux hypothèses et au rapport ; cite-les avec leur clé [clé].',
      '- Ce ne sont ni les seules sources à lire ni des vérités établies : poursuis ta propre recherche bibliographique, confronte-les à la littérature et vérifie leurs affirmations comme pour toute autre source. Signale tout désaccord avec la littérature.',
      '- Les originaux sont dans inputs/ : données, tableurs, code ou notebooks s\'exploitent directement avec python/bash. Tu peux confier leur lecture à un scout et leur exploitation à un experimenter.',
    ].join('\n')
  return `<documents_fournis nombre="${docs.length}" non_ouverts="${unopened}">\nL'humain a fourni ${docs.length} document(s) en entrée de la recherche.\n${rules}\n${lines.join('\n')}${more ? `\n${more}` : ''}\n</documents_fournis>`
}

export function episodesSection(agent: AgentInstance, keep = 2): string {
  const episodes = listEpisodes(agent.projectId, agent.id).slice(-keep)
  if (!episodes.length) return ''
  return `<historique_compacte>\nLes échanges plus anciens ont été retirés du contexte et résumés ci-dessous (le plus récent est cumulatif). Détails exacts : recall_history.\n${episodes.map(e => `<episode date="${new Date(e.createdAt).toLocaleString('fr-FR')}">\n${e.summary}\n</episode>`).join('\n')}\n</historique_compacte>`
}

function originPrefix(m: ChatMessage): string {
  const o = m.meta?.origin
  if (o === 'human') return '[Humain] '
  if (o === 'supervisor') return '[Superviseur] '
  if (o === 'verifier') return '[Vérificateur] '
  if (o === 'agent') return `[Message de ${m.meta?.from ?? 'agent'}] `
  if (o === 'system') return '[Système] '
  return ''
}

/**
 * Convert stored messages to wire messages, clearing old bulky tool results
 * (Anthropic "context editing" idea). The full outputs remain in the DB and
 * are reachable through recall_history.
 */
export interface HistoryPolicy {
  /** Always keep at least this many most recent tool results verbatim. */
  keep: number
  /** Beyond that, keep older results while their total size fits this budget. */
  budgetChars?: number
}

export function toWireHistory(history: ChatMessage[], policy: HistoryPolicy | number): LlmMessage[] {
  const { keep, budgetChars = 0 } = typeof policy === 'number' ? { keep: policy } : policy
  const toolIdx = history.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0)
  // walk back from the newest result: the first `keep` always stay, then as many as the budget allows
  let keepFrom = 0
  let used = 0
  for (let k = toolIdx.length - 1, n = 0; k >= 0; k--, n++) {
    used += history[toolIdx[k]].content.length
    if (n >= keep && used > budgetChars) {
      keepFrom = toolIdx[k] + 1
      break
    }
  }
  // Drop orphan tool results / dangling tool calls (can happen after crashes)
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const m of history) {
    if (m.role === 'assistant') m.toolCalls?.forEach(tc => callIds.add(tc.id))
    if (m.role === 'tool' && m.toolCallId) resultIds.add(m.toolCallId)
  }
  const out: LlmMessage[] = []
  history.forEach((m, i) => {
    if (m.role === 'tool') {
      if (!m.toolCallId || !callIds.has(m.toolCallId)) return
      let content = m.content
      if (i < keepFrom && content.length > CLEAR_MIN_CHARS) {
        content = `[Résultat effacé du contexte (${content.length} caractères) — outil ${m.name ?? '?'}. Les informations importantes doivent être en mémoire; sinon recall_history ou relance l'outil.]\nDébut: ${content.slice(0, 280).replace(/\n/g, ' ')}…`
      }
      out.push({ role: 'tool', content, toolCallId: m.toolCallId, name: m.name })
      return
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls?.filter(tc => resultIds.has(tc.id))
      out.push({
        role: 'assistant',
        content: m.content,
        reasoning: m.reasoning,
        reasoningSignature: typeof m.meta?.signature === 'string' ? m.meta.signature : undefined,
        toolCalls: calls?.length ? calls : undefined,
      })
      return
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: `${originPrefix(m)}${m.content}` })
    }
  })
  return out
}

export function buildMessages(system: string, history: ChatMessage[], policy: HistoryPolicy | number, tailReminder?: string): BuiltContext {
  const wire = toWireHistory(history, policy)
  const messages: LlmMessage[] = [{ role: 'system', content: system }, ...wire]
  if (messages.length === 1) messages.push({ role: 'user', content: 'Commence.' })
  if (tailReminder) {
    const last = messages[messages.length - 1]
    if (last.role === 'assistant') messages.push({ role: 'user', content: tailReminder })
    else messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${tailReminder}` }
  }
  const tokens = messages.reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(m.reasoning) + (m.toolCalls?.reduce((k, t) => k + estimateTokens(t.arguments) + 10, 0) ?? 0) + 4, 0)
  return { messages, tokens }
}
