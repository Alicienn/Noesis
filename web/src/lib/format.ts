import type { AgentRole, AgentStatus, AssuranceLevel, HypothesisStatus, NoteType, ProjectStatus, SourceStatus } from '@shared/types'
import type { Tone } from '../components/ui'

export function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDate(t: number): string {
  return new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function fmtAgo(t: number): string {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'à l\'instant'
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`
  return `il y a ${Math.round(s / 86400)} j`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} Ko`
  return `${(n / 1048576).toFixed(1)} Mo`
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: Tone; live?: boolean }> = {
  idle: { label: 'Au repos', tone: 'neutral' },
  running: { label: 'En recherche', tone: 'amber', live: true },
  waiting_human: { label: 'Attend l\'humain', tone: 'rose', live: true },
  paused: { label: 'En pause', tone: 'sky' },
  finished: { label: 'Terminé', tone: 'teal' },
  error: { label: 'Erreur', tone: 'brick' },
}

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: Tone; live?: boolean }> = {
  idle: { label: 'inactif', tone: 'neutral' },
  thinking: { label: 'réfléchit', tone: 'amber', live: true },
  tool: { label: 'outil', tone: 'sky', live: true },
  waiting: { label: 'attend', tone: 'rose', live: true },
  done: { label: 'terminé', tone: 'teal' },
  error: { label: 'erreur', tone: 'brick' },
  stopped: { label: 'arrêté', tone: 'neutral' },
}

export const ROLE_TONE: Record<AgentRole, Tone> = {
  lead: 'amber',
  supervisor: 'rose',
  verifier: 'teal',
  scout: 'sky',
  experimenter: 'moss',
  theorist: 'amber',
  critic: 'brick',
  librarian: 'neutral',
}

export const NOTE_TYPE: Record<NoteType, { label: string; tone: Tone }> = {
  finding: { label: 'résultat', tone: 'amber' },
  fact: { label: 'fait', tone: 'sky' },
  hypothesis: { label: 'hypothèse', tone: 'rose' },
  method: { label: 'méthode', tone: 'moss' },
  question: { label: 'question', tone: 'neutral' },
  idea: { label: 'idée', tone: 'rose' },
  dead_end: { label: 'impasse', tone: 'brick' },
  definition: { label: 'définition', tone: 'teal' },
  insight: { label: 'synthèse', tone: 'amber' },
  todo: { label: 'à faire', tone: 'neutral' },
}

export const HYP_STATUS: Record<HypothesisStatus, { label: string; tone: Tone }> = {
  proposed: { label: 'proposée', tone: 'neutral' },
  testing: { label: 'en test', tone: 'amber' },
  supported: { label: 'soutenue', tone: 'teal' },
  refuted: { label: 'réfutée', tone: 'brick' },
  abandoned: { label: 'abandonnée', tone: 'neutral' },
}

export const SOURCE_STATUS: Record<SourceStatus, { label: string; tone: Tone }> = {
  metadata: { label: 'métadonnées', tone: 'neutral' },
  full_text: { label: 'texte intégral', tone: 'teal' },
  requested: { label: 'demandé', tone: 'rose' },
  failed: { label: 'inaccessible', tone: 'brick' },
}

export const VERDICT_TONE: Record<string, Tone> = { supported: 'teal', refuted: 'brick', uncertain: 'amber', pending: 'neutral' }
export const VERDICT_LABEL: Record<string, string> = { supported: 'vérifié', refuted: 'réfuté', uncertain: 'incertain', pending: 'en vérification' }

/** Verification ladder: claimed → reviewed → computed → formal (Lean). */
export const ASSURANCE_TONE: Record<AssuranceLevel, Tone> = { claimed: 'neutral', reviewed: 'sky', computed: 'teal', formal: 'moss' }
export const ASSURANCE_SHORT: Record<AssuranceLevel, string> = { claimed: 'affirmé', reviewed: 'relu', computed: 'calculé', formal: 'Lean ✓' }

/** Human-friendly one-liner for a tool call (shown in transcript & activity). */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const s = (k: string): string => String(args[k] ?? '')
  switch (name) {
    case 'web_search': return `Recherche web « ${s('query')} »`
    case 'paper_search': return `Recherche d'articles « ${s('query')} »`
    case 'fetch_url': return `Lecture de ${s('url')}`
    case 'paper_add': return `Ajout de l'article ${s('doi') || s('arxiv_id')}`
    case 'paper_citations': return `Graphe de citations (${s('direction')}) de ${s('ref')}`
    case 'paper_fetch_pdf': return `Récupération du PDF ${s('key')}`
    case 'request_pdf': return `Demande de PDF à l'humain`
    case 'source_read': return `Lecture de ${s('key')}${args.page_from ? ` p.${s('page_from')}-${s('page_to') || '…'}` : ''}`
    case 'source_search': return `Recherche dans les sources « ${s('query')} »`
    case 'source_annotate': return `Fiche de lecture ${s('key')}`
    case 'source_list': return 'Liste des sources'
    case 'memory_write': return `Nouvelle note « ${s('title')} »`
    case 'memory_update': return `Mise à jour de [[${s('slug')}]]`
    case 'memory_search': return `Recherche en mémoire « ${s('query')} »`
    case 'memory_read': return `Lecture de [[${s('slug')}]]`
    case 'memory_supersede': return `Invalidation de [[${s('slug')}]]`
    case 'memory_list': return 'Liste des notes'
    case 'recall_history': return `Rappel de l'historique « ${s('query')} »`
    case 'core_memory_edit': return `Mémoire centrale · ${s('label')}`
    case 'update_plan': return 'Mise à jour du plan'
    case 'hypothesis_add': return `Hypothèse : ${s('statement').slice(0, 90)}`
    case 'hypothesis_update': return `Hypothèse ${s('id')} → ${s('status') || 'preuve ajoutée'}`
    case 'hypothesis_list': return 'Liste des hypothèses'
    case 'hypothesis_tournament': return `Tournoi d'hypothèses (${s('rounds') || 6} duels)`
    case 'python': return `Python${args.name ? ` · ${s('name')}` : ''}`
    case 'bash': return `$ ${s('command').slice(0, 120)}`
    case 'lean_run': return `Lean · ${s('file') || s('name') || 'compilation'}`
    case 'lean_search': return `Recherche Mathlib « ${s('pattern')} »`
    case 'lean_check': return `Comparator · ${String(args.theorems ?? '').slice(0, 80)}`
    case 'prior_results': return args.import ? `Import d'un résultat (${s('slug')})` : `Résultats d'autres projets « ${s('query')} »`
    case 'file_read': return `Lecture ${s('path')}`
    case 'file_write': return `Écriture ${s('path')}`
    case 'file_edit': return `Édition ${s('path')}`
    case 'file_list': return `Liste ${s('path') || 'workspace'}`
    case 'file_grep': return `grep « ${s('pattern')} »`
    case 'delegate': return `Délégation → ${s('role')} : ${s('task').slice(0, 100)}`
    case 'verify_claim': return `Vérification (${s('kind') || 'general'}) : ${s('claim').slice(0, 100)}`
    case 'send_message': return `Message → ${s('to')}`
    case 'ask_human': return `Question à l'humain`
    case 'notify_human': return `Notification : ${s('title')}`
    case 'write_report': return `Rapport « ${s('title')} »`
    case 'finish_research': return 'Fin de la recherche'
    case 'submit_result': return 'Rapport rendu'
    case 'submit_verdict': return `Verdict : ${s('verdict')}`
    default: return name.startsWith('mcp__') ? `MCP ${name.split('__').slice(1).join(' · ')}` : name
  }
}
