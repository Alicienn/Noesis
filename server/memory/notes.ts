import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { Assurance, AssuranceEvent, AssuranceLevel, Episode, HumanReview, Note, NoteType, Verification } from '../../shared/types.ts'
import { ASSURANCE_LABELS, ASSURANCE_LEVELS } from '../../shared/types.ts'
import { all, ftsQuery, get, run } from '../db/database.ts'
import { bus, log } from '../core/events.ts'
import { newId, now, safeJsonParse, slugify } from '../core/util.ts'
import { workspaceDir } from '../config.ts'
import { embed } from '../llm/client.ts'
import { effectiveModels } from '../settings.ts'
import { getProject } from '../store/projects.ts'

/**
 * Long-term memory = atomic, typed, linked notes (A-MEM / Zettelkasten).
 *  - SQLite is the source of truth, FTS5 gives BM25 lexical search.
 *  - Optional embeddings give semantic search; both are fused with RRF.
 *  - Contradicted notes are *superseded* (Graphiti-style), never deleted, so the
 *    history of what we believed and why is kept.
 *  - Every note is mirrored to workspace/memory/notes/<slug>.md with YAML
 *    front-matter, and MEMORY.md is a regenerated index (Claude-Code style).
 */

export const NOTE_TYPES: NoteType[] = ['finding', 'fact', 'hypothesis', 'method', 'question', 'idea', 'dead_end', 'definition', 'insight', 'todo']

interface NoteRow {
  id: string
  project_id: string
  slug: string
  title: string
  type: string
  content: string
  tags: string
  confidence: number
  importance: number
  links: string
  source_ids: string
  verification: string | null
  assurance: string | null
  status: string
  superseded_by: string | null
  embedding: Uint8Array | null
  created_by: string
  created_at: number
  updated_at: number
  access_count: number
}

function fromRow(r: NoteRow): Note {
  return {
    id: r.id,
    projectId: r.project_id,
    slug: r.slug,
    title: r.title,
    type: r.type as NoteType,
    content: r.content,
    tags: safeJsonParse(r.tags, []),
    confidence: r.confidence,
    importance: r.importance,
    links: safeJsonParse(r.links, []),
    sourceIds: safeJsonParse(r.source_ids, []),
    verification: safeJsonParse<Verification | undefined>(r.verification, undefined),
    assurance: readAssurance(r),
    status: r.status as Note['status'],
    supersededBy: r.superseded_by ?? undefined,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    accessCount: r.access_count,
  }
}

const COLS = 'id, project_id, slug, title, type, content, tags, confidence, importance, links, source_ids, verification, assurance, status, superseded_by, created_by, created_at, updated_at, access_count'

export function getNote(projectId: string, idOrSlug: string): Note | undefined {
  const row = get<NoteRow>(`SELECT ${COLS} FROM notes WHERE project_id = ? AND (id = ? OR slug = ?)`, projectId, idOrSlug, idOrSlug)
  return row ? fromRow(row) : undefined
}

export function listNotes(projectId: string, opts: { type?: NoteType; includeInactive?: boolean; limit?: number } = {}): Note[] {
  const where = ['project_id = ?']
  const params: Array<string | number> = [projectId]
  if (opts.type) {
    where.push('type = ?')
    params.push(opts.type)
  }
  if (!opts.includeInactive) where.push("status = 'active'")
  params.push(opts.limit ?? 5000)
  return all<NoteRow>(`SELECT ${COLS} FROM notes WHERE ${where.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`, ...params).map(fromRow)
}

function uniqueSlug(projectId: string, base: string, excludeId?: string): string {
  let slug = base
  let i = 2
  while (true) {
    const row = get<{ id: string }>('SELECT id FROM notes WHERE project_id = ? AND slug = ?', projectId, slug)
    if (!row || row.id === excludeId) return slug
    slug = `${base}-${i++}`
  }
}

function indexFts(note: Note): void {
  run('DELETE FROM notes_fts WHERE note_id = ?', note.id)
  if (note.status !== 'active') return
  run('INSERT INTO notes_fts (title, content, tags, note_id, project_id) VALUES (?, ?, ?, ?, ?)', note.title, note.content, note.tags.join(' '), note.id, note.projectId)
}

export interface NoteInput {
  title: string
  content: string
  type?: NoteType
  tags?: string[]
  confidence?: number
  importance?: number
  links?: string[]
  sourceIds?: string[]
}

export function createNote(projectId: string, input: NoteInput, createdBy: string): Note {
  const id = newId('note')
  const t = now()
  const type = NOTE_TYPES.includes(input.type as NoteType) ? (input.type as NoteType) : 'finding'
  const slug = uniqueSlug(projectId, slugify(input.title))
  const links = resolveLinks(projectId, input.links ?? [])
  run(
    `INSERT INTO notes (id, project_id, slug, title, type, content, tags, confidence, importance, links, source_ids, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id, projectId, slug, input.title.trim(), type, input.content.trim(), JSON.stringify(normTags(input.tags)),
    clamp(input.confidence ?? 0.6, 0, 1), Math.round(clamp(input.importance ?? 3, 1, 5)), JSON.stringify(links),
    JSON.stringify(input.sourceIds ?? []), createdBy, t, t,
  )
  const note = getNote(projectId, id)!
  // bidirectional links (Zettelkasten)
  for (const target of links) addLink(projectId, target, note.slug)
  afterChange(note)
  return note
}

export function updateNote(projectId: string, idOrSlug: string, patch: Partial<NoteInput> & { append?: string }): Note {
  const note = getNote(projectId, idOrSlug)
  if (!note) throw new Error(`Note introuvable: ${idOrSlug}`)
  const content = patch.append ? `${note.content}\n\n${patch.append.trim()}` : patch.content ?? note.content
  const links = patch.links ? resolveLinks(projectId, [...note.links, ...patch.links]) : note.links
  const title = patch.title ?? note.title
  run(
    `UPDATE notes SET title = ?, type = ?, content = ?, tags = ?, confidence = ?, importance = ?, links = ?, source_ids = ?, updated_at = ? WHERE id = ?`,
    title,
    patch.type && NOTE_TYPES.includes(patch.type) ? patch.type : note.type,
    content,
    JSON.stringify(patch.tags ? normTags(patch.tags) : note.tags),
    clamp(patch.confidence ?? note.confidence, 0, 1),
    Math.round(clamp(patch.importance ?? note.importance, 1, 5)),
    JSON.stringify([...new Set(links)]),
    JSON.stringify(patch.sourceIds ? [...new Set([...note.sourceIds, ...patch.sourceIds])] : note.sourceIds),
    now(),
    note.id,
  )
  if (patch.links) for (const target of links) addLink(projectId, target, note.slug)
  const updated = getNote(projectId, note.id)!
  afterChange(updated, Boolean(patch.content || patch.append || patch.title))
  return updated
}

/** Graphiti-style invalidation: mark a note superseded by a newer one. */
export function supersedeNote(projectId: string, oldIdOrSlug: string, newIdOrSlug: string | undefined, reason: string): Note {
  const old = getNote(projectId, oldIdOrSlug)
  if (!old) throw new Error(`Note introuvable: ${oldIdOrSlug}`)
  const replacement = newIdOrSlug ? getNote(projectId, newIdOrSlug) : undefined
  // the replacement may be written right after: keep the slug, the link resolves once it exists
  const replacedBy = replacement?.slug ?? newIdOrSlug?.trim().replace(/^\[\[|\]\]$/g, '') ?? null
  run(
    "UPDATE notes SET status = 'superseded', superseded_by = ?, content = ?, updated_at = ? WHERE id = ?",
    replacedBy || null,
    `${old.content}\n\n---\n**Invalidée** le ${new Date().toISOString().slice(0, 10)} : ${reason}${replacedBy ? ` → remplacée par [[${replacedBy}]]` : ''}`,
    now(),
    old.id,
  )
  const updated = getNote(projectId, old.id)!
  afterChange(updated)
  return updated
}

export function archiveNote(projectId: string, idOrSlug: string): void {
  const note = getNote(projectId, idOrSlug)
  if (!note) return
  run("UPDATE notes SET status = 'archived', updated_at = ? WHERE id = ?", now(), note.id)
  afterChange(getNote(projectId, note.id)!)
}

export function deleteNote(projectId: string, idOrSlug: string): void {
  const note = getNote(projectId, idOrSlug)
  if (!note) return
  run('DELETE FROM notes WHERE id = ?', note.id)
  run('DELETE FROM notes_fts WHERE note_id = ?', note.id)
  try {
    fs.rmSync(notePath(note), { force: true })
  } catch {
    // ignore
  }
  bus.publish(projectId, { type: 'note.deleted', id: note.id })
  scheduleIndex(projectId)
}

export function setVerification(projectId: string, idOrSlug: string, verification: Verification): Note | undefined {
  const note = getNote(projectId, idOrSlug)
  if (!note) return undefined
  run('UPDATE notes SET verification = ?, updated_at = ? WHERE id = ?', JSON.stringify(verification), now(), note.id)
  const updated = getNote(projectId, note.id)!
  afterChange(updated, false)
  return updated
}

// ───────────────────────────── Verification ladder ─────────────────────────────

export function assuranceRank(level: AssuranceLevel | undefined): number {
  return ASSURANCE_LEVELS.indexOf(level ?? 'claimed')
}

/** Notes verified before the ladder existed: a supported verdict counts as « reviewed ». */
function readAssurance(r: NoteRow): Assurance | undefined {
  const stored = safeJsonParse<Assurance | undefined>(r.assurance, undefined)
  if (stored) return stored
  const v = safeJsonParse<Verification | undefined>(r.verification, undefined)
  if (v?.verdict !== 'supported') return undefined
  // derived, not recorded: no history entry (the verdict itself is shown next to it)
  return { level: 'reviewed', history: [] }
}

function writeAssurance(note: Note, assurance: Assurance): Note {
  run('UPDATE notes SET assurance = ?, updated_at = ? WHERE id = ?', JSON.stringify(assurance), now(), note.id)
  const updated = getNote(note.projectId, note.id)!
  afterChange(updated, false)
  return updated
}

/** Positive evidence raises the level (never lowers it); the event is kept in the history. */
export function recordAssurance(projectId: string, idOrSlug: string, event: Omit<AssuranceEvent, 'at'>, lean?: Assurance['lean']): Note | undefined {
  const note = getNote(projectId, idOrSlug)
  if (!note) return undefined
  const current = note.assurance ?? { level: 'claimed' as AssuranceLevel, history: [] }
  const level = assuranceRank(event.level) > assuranceRank(current.level) ? event.level : current.level
  return writeAssurance(note, { ...current, level, lean: lean ?? current.lean, history: [...current.history, { ...event, at: now() }].slice(-30) })
}

/**
 * A refutation drops a non-formal result back to « claimed ». A Lean proof is not
 * undone by an LLM verdict: the conflict usually means the Lean statement does not
 * say what the note says, so it is flagged instead.
 */
export function downgradeAssurance(projectId: string, idOrSlug: string, by: string, reason: string): Note | undefined {
  const note = getNote(projectId, idOrSlug)
  if (!note?.assurance) return note
  const formal = note.assurance.level === 'formal'
  const detail = formal ? `Réfutation contre une preuve Lean acceptée : vérifier que l'énoncé Lean dit bien ce que dit la note. ${reason}` : `Réfutée : ${reason}`
  const level: AssuranceLevel = formal ? 'formal' : 'claimed'
  return writeAssurance(note, {
    ...note.assurance,
    level,
    history: [...note.assurance.history, { level, by, at: now(), detail: detail.slice(0, 400) }].slice(-30),
  })
}

export function setLeanAssurance(projectId: string, idOrSlug: string, lean: NonNullable<Assurance['lean']>): Note | undefined {
  const note = getNote(projectId, idOrSlug)
  if (!note) return undefined
  const current = note.assurance ?? { level: 'claimed' as AssuranceLevel, history: [] }
  return writeAssurance(note, { ...current, lean })
}

/**
 * Review of the Lean statement's faithfulness (verify_claim kind="formalization").
 * A refuted statement means the proof proves something else: the note loses the formal level.
 */
export function setStatementReview(projectId: string, idOrSlug: string, review: { verdict: Verification['verdict']; by: string; summary: string }): Note | undefined {
  const note = getNote(projectId, idOrSlug)
  if (!note?.assurance?.lean) return note
  const assurance: Assurance = { ...note.assurance, lean: { ...note.assurance.lean, statementReview: { ...review, summary: review.summary.slice(0, 600), at: now() } } }
  if (review.verdict === 'refuted' && assurance.level === 'formal') {
    const fallback = assurance.history.filter(e => e.level !== 'formal').reduce<AssuranceLevel>((best, e) => (assuranceRank(e.level) > assuranceRank(best) ? e.level : best), 'claimed')
    assurance.level = fallback
    assurance.history = [...assurance.history, { level: fallback, by: review.by, at: now(), detail: `Énoncé Lean jugé infidèle à la note : la preuve Lean ne porte pas sur ce résultat. ${review.summary.slice(0, 200)}` }].slice(-30)
  }
  return writeAssurance(note, assurance)
}

export function setHumanReview(projectId: string, idOrSlug: string, review: Omit<HumanReview, 'at'>): Note {
  const note = getNote(projectId, idOrSlug)
  if (!note) throw new Error(`Note introuvable: ${idOrSlug}`)
  const current = note.assurance ?? { level: 'claimed' as AssuranceLevel, history: [] }
  return writeAssurance(note, { ...current, humanReview: { ...review, at: now() } })
}

/** One-line description of the level, for prompts, the Markdown mirror and report annexes. */
export function assuranceText(note: Note): string {
  const a = note.assurance
  const parts = [ASSURANCE_LABELS[a?.level ?? 'claimed']]
  if (a?.lean && a.level !== 'formal') parts.push(`Lean : ${a.lean.status === 'proved' ? 'prouvé' : a.lean.status === 'running' ? 'en cours' : 'échec'}`)
  if (a?.level === 'formal') parts.push(a.lean?.statementReview?.verdict === 'supported' ? 'énoncé relu' : 'fidélité de l\'énoncé non relue')
  if (a?.humanReview) parts.push(`${a.humanReview.verdict === 'approved' ? 'approuvé' : 'rejeté'} par l'humain${a.humanReview.target === 'lean_statement' ? ' (énoncé Lean)' : ''}`)
  return parts.join(' · ')
}

export function touchNotes(ids: string[]): void {
  for (const id of ids) run('UPDATE notes SET access_count = access_count + 1 WHERE id = ?', id)
}

function addLink(projectId: string, targetSlug: string, linkSlug: string): void {
  const target = getNote(projectId, targetSlug)
  if (!target || target.links.includes(linkSlug) || target.slug === linkSlug) return
  run('UPDATE notes SET links = ? WHERE id = ?', JSON.stringify([...target.links, linkSlug]), target.id)
  const updated = getNote(projectId, target.id)!
  writeMirror(updated)
  bus.publish(projectId, { type: 'note.upserted', note: updated })
}

function resolveLinks(projectId: string, links: string[]): string[] {
  const out: string[] = []
  for (const l of links) {
    const clean = l.replace(/^\[\[|\]\]$/g, '').trim()
    const n = getNote(projectId, clean) ?? getNote(projectId, slugify(clean))
    if (n) out.push(n.slug)
  }
  return [...new Set(out)]
}

function afterChange(note: Note, reembed = true): void {
  indexFts(note)
  writeMirror(note)
  bus.publish(note.projectId, { type: 'note.upserted', note })
  scheduleIndex(note.projectId)
  if (reembed && note.status === 'active') void embedNote(note)
}

// ───────────────────────────── Markdown mirror ─────────────────────────────

function notePath(note: Note): string {
  return path.join(workspaceDir(note.projectId), 'memory', 'notes', `${note.slug}.md`)
}

function writeMirror(note: Note): void {
  try {
    const fm = {
      id: note.id,
      title: note.title,
      type: note.type,
      status: note.status,
      tags: note.tags,
      confidence: note.confidence,
      importance: note.importance,
      links: note.links,
      sources: note.sourceIds,
      verification: note.verification?.verdict,
      assurance: note.assurance?.level ?? 'claimed',
      superseded_by: note.supersededBy,
      created: new Date(note.createdAt).toISOString(),
      updated: new Date(note.updatedAt).toISOString(),
    }
    const body = `---\n${YAML.stringify(fm).trim()}\n---\n\n# ${note.title}\n\n${note.content}\n${note.links.length ? `\n## Liens\n${note.links.map(l => `- [[${l}]]`).join('\n')}\n` : ''}`
    fs.mkdirSync(path.dirname(notePath(note)), { recursive: true })
    fs.writeFileSync(notePath(note), body, 'utf8')
  } catch {
    // best-effort
  }
}

const indexTimers = new Map<string, NodeJS.Timeout>()

function scheduleIndex(projectId: string): void {
  clearTimeout(indexTimers.get(projectId))
  indexTimers.set(projectId, setTimeout(() => writeIndex(projectId), 800))
}

/** MEMORY.md: compact index of every active note, grouped by type. */
export function writeIndex(projectId: string): void {
  try {
    const notes = listNotes(projectId)
    const groups = new Map<string, Note[]>()
    for (const n of notes) groups.set(n.type, [...(groups.get(n.type) ?? []), n])
    const lines = ['# Index de la mémoire', '', `_${notes.length} notes actives — généré automatiquement_`, '']
    for (const type of NOTE_TYPES) {
      const g = groups.get(type)
      if (!g?.length) continue
      lines.push(`## ${type}`, '')
      for (const n of g) {
        const v = n.verification ? ` [${n.verification.verdict}]` : ''
        const a = n.assurance && n.assurance.level !== 'claimed' ? ` {${ASSURANCE_LABELS[n.assurance.level]}}` : ''
        lines.push(`- [${n.title}](notes/${n.slug}.md) — imp ${n.importance}, conf ${n.confidence.toFixed(2)}${v}${a}`)
      }
      lines.push('')
    }
    fs.writeFileSync(path.join(workspaceDir(projectId), 'memory', 'MEMORY.md'), lines.join('\n'), 'utf8')
  } catch {
    // ignore
  }
}

// ───────────────────────────── Embeddings ─────────────────────────────

function embeddingModel(projectId: string): string | undefined {
  const project = getProject(projectId)
  if (!project) return undefined
  const ref = effectiveModels(project.config).embedding.model
  return ref || undefined
}

function toBlob(v: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(v).buffer)
}

function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b)
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}

async function embedNote(note: Note): Promise<void> {
  const model = embeddingModel(note.projectId)
  if (!model) return
  try {
    const [vector] = await embed(model, [`${note.title}\n${note.tags.join(', ')}\n${note.content}`.slice(0, 8000)])
    if (vector) run('UPDATE notes SET embedding = ? WHERE id = ?', toBlob(vector), note.id)
  } catch (error) {
    log(note.projectId, 'warn', `Embedding échoué pour ${note.slug}: ${(error as Error).message}`)
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// ───────────────────────────── Search ─────────────────────────────

export interface NoteHit {
  note: Note
  score: number
  snippet: string
}

/**
 * Hybrid search: BM25 (FTS5) + cosine similarity (if embeddings), fused with
 * Reciprocal Rank Fusion, lightly boosted by importance.
 */
export async function searchNotes(projectId: string, query: string, opts: { limit?: number; type?: NoteType; includeInactive?: boolean } = {}): Promise<NoteHit[]> {
  const limit = opts.limit ?? 10
  const scores = new Map<string, number>()
  const snippets = new Map<string, string>()
  const K = 60

  const lexical = all<{ note_id: string; snip: string }>(
    `SELECT note_id, snippet(notes_fts, 1, '«', '»', '…', 24) AS snip FROM notes_fts
     WHERE notes_fts MATCH ? AND project_id = ? ORDER BY bm25(notes_fts, 5.0, 1.0, 2.0) LIMIT 40`,
    ftsQuery(query), projectId,
  )
  lexical.forEach((r, i) => {
    scores.set(r.note_id, (scores.get(r.note_id) ?? 0) + 1 / (K + i))
    snippets.set(r.note_id, r.snip)
  })

  const model = embeddingModel(projectId)
  if (model) {
    try {
      const [qv] = await embed(model, [query])
      if (qv) {
        const q = new Float32Array(qv)
        const rows = all<{ id: string; embedding: Uint8Array }>("SELECT id, embedding FROM notes WHERE project_id = ? AND status = 'active' AND embedding IS NOT NULL", projectId)
        rows
          .map(r => ({ id: r.id, sim: cosine(q, fromBlob(r.embedding)) }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 40)
          .forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (K + i)))
      }
    } catch (error) {
      log(projectId, 'warn', `Recherche sémantique indisponible: ${(error as Error).message}`)
    }
  }

  const hits: NoteHit[] = []
  for (const [id, score] of scores) {
    const note = getNote(projectId, id)
    if (!note) continue
    if (!opts.includeInactive && note.status !== 'active') continue
    if (opts.type && note.type !== opts.type) continue
    hits.push({ note, score: score * (1 + note.importance * 0.05), snippet: snippets.get(id) ?? note.content.slice(0, 200) })
  }
  hits.sort((a, b) => b.score - a.score)
  const top = hits.slice(0, limit)
  touchNotes(top.map(h => h.note.id))
  return top
}

/** Notes lexically similar to a text — used for auto-linking & dedup hints. */
export function similarNotes(projectId: string, text: string, excludeId?: string, limit = 5): Note[] {
  const rows = all<{ note_id: string }>(
    'SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? AND project_id = ? ORDER BY bm25(notes_fts, 5.0, 1.0, 2.0) LIMIT ?',
    ftsQuery(text), projectId, limit + 1,
  )
  return rows.map(r => getNote(projectId, r.note_id)).filter((n): n is Note => Boolean(n) && n!.id !== excludeId).slice(0, limit)
}

// ───────────────────────────── Episodes ─────────────────────────────

export function createEpisode(projectId: string, agentId: string, summary: string, messageCount: number): Episode {
  const id = newId('ep')
  const t = now()
  run('INSERT INTO episodes (id, project_id, agent_id, summary, message_count, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, projectId, agentId, summary, messageCount, t)
  const episode: Episode = { id, projectId, agentId, summary, messageCount, createdAt: t }
  try {
    const file = path.join(workspaceDir(projectId), 'memory', 'episodes', `${new Date(t).toISOString().replace(/[:.]/g, '-')}_${agentId}.md`)
    fs.writeFileSync(file, `# Épisode ${new Date(t).toLocaleString('fr-FR')} — ${agentId}\n\n${summary}\n`, 'utf8')
  } catch {
    // ignore
  }
  bus.publish(projectId, { type: 'episode.created', episode })
  return episode
}

export function listEpisodes(projectId: string, agentId?: string): Episode[] {
  const rows = agentId
    ? all<any>('SELECT * FROM episodes WHERE project_id = ? AND agent_id = ? ORDER BY created_at', projectId, agentId)
    : all<any>('SELECT * FROM episodes WHERE project_id = ? ORDER BY created_at', projectId)
  return rows.map(r => ({ id: r.id, projectId: r.project_id, agentId: r.agent_id, summary: r.summary, messageCount: r.message_count, createdAt: r.created_at }))
}

// ───────────────────────────── helpers ─────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo))
}

function normTags(tags?: string[]): string[] {
  return [...new Set((tags ?? []).map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))].slice(0, 12)
}

export function noteToText(n: Note, full = true): string {
  const v = n.verification ? ` | vérif: ${n.verification.verdict} (${Math.round(n.verification.confidence * 100)}%)` : ''
  const a = n.assurance && n.assurance.level !== 'claimed' ? ` | niveau: ${assuranceText(n)}` : ''
  const head = `[[${n.slug}]] (${n.type}, imp ${n.importance}, conf ${n.confidence.toFixed(2)}${v}${a}${n.status !== 'active' ? `, ${n.status}` : ''}) ${n.title}`
  if (!full) return head
  return `${head}\ntags: ${n.tags.join(', ') || '—'} | liens: ${n.links.map(l => `[[${l}]]`).join(' ') || '—'} | sources: ${n.sourceIds.join(', ') || '—'}\n${n.content}`
}

