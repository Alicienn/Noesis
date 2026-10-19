import fs from 'node:fs'
import path from 'node:path'
import type { Source, SourceStatus } from '../../shared/types.ts'
import { all, ftsQuery, get, run, tx } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { newId, now, safeJsonParse, slugify } from '../core/util.ts'
import { workspaceDir } from '../config.ts'
import { isPdf, pdfToText } from '../services/pdf.ts'

/**
 * Source library: papers, web pages, PDFs. Full texts are chunked (with page
 * numbers) into an FTS5 index so agents can search *inside* everything they
 * have read, and cite page numbers.
 */

interface Row {
  id: string
  project_id: string
  kind: string
  title: string
  authors: string
  year: number | null
  venue: string | null
  doi: string | null
  arxiv_id: string | null
  url: string | null
  pdf_url: string | null
  abstract: string | null
  citation_key: string
  status: string
  pages: number | null
  chars: number | null
  notes: string | null
  citations: number | null
  text_path: string | null
  origin: string | null
  file: string | null
  created_at: number
}

function fromRow(r: Row): Source {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as Source['kind'],
    title: r.title,
    authors: safeJsonParse(r.authors, []),
    year: r.year ?? undefined,
    venue: r.venue ?? undefined,
    doi: r.doi ?? undefined,
    arxivId: r.arxiv_id ?? undefined,
    url: r.url ?? undefined,
    pdfUrl: r.pdf_url ?? undefined,
    abstract: r.abstract ?? undefined,
    citationKey: r.citation_key,
    status: r.status as SourceStatus,
    pages: r.pages ?? undefined,
    chars: r.chars ?? undefined,
    notes: r.notes ?? undefined,
    citations: r.citations ?? undefined,
    origin: r.origin === 'human' ? 'human' : undefined,
    file: r.file ?? undefined,
    createdAt: r.created_at,
  }
}

export function listSources(projectId: string): Source[] {
  return all<Row>('SELECT * FROM sources WHERE project_id = ? ORDER BY created_at DESC', projectId).map(fromRow)
}

export function getSource(projectId: string, idOrKey: string): Source | undefined {
  const r = get<Row>('SELECT * FROM sources WHERE project_id = ? AND (id = ? OR citation_key = ?)', projectId, idOrKey, idOrKey)
  return r ? fromRow(r) : undefined
}

/**
 * Resolve how agents actually refer to sources: citation key, id, "RFC 9000",
 * a DOI, an arXiv id, a URL, or (part of) the title.
 */
export function resolveSource(projectId: string, ref: string): Source | undefined {
  const r = ref.trim().replace(/^\[|\]$/g, '')
  if (!r) return undefined
  const direct = getSource(projectId, r)
  if (direct) return direct
  const lower = r.toLowerCase()
  const rfc = lower.match(/^rfc[\s-]?(\d{3,5})$/)?.[1]
  const all = listSources(projectId)
  if (rfc) return all.find(s => s.citationKey === `rfc${rfc}` || new RegExp(`\\brfc[\\s-]?${rfc}\\b`, 'i').test(`${s.title} ${s.url ?? ''}`))
  const doi = lower.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/, '')
  if (/^10\.\d+\//.test(doi)) return all.find(s => s.doi?.toLowerCase() === doi)
  const arxiv = lower.replace(/^arxiv:/, '').replace(/v\d+$/, '')
  if (/^\d{4}\.\d{4,5}$/.test(arxiv)) return all.find(s => s.arxivId === arxiv)
  if (/^https?:/.test(lower)) return all.find(s => s.url?.toLowerCase() === lower || s.pdfUrl?.toLowerCase() === lower)
  return all.find(s => s.citationKey.toLowerCase() === lower) ?? (lower.length > 8 ? all.find(s => s.title.toLowerCase().includes(lower)) : undefined)
}

export function findExisting(projectId: string, s: { doi?: string; arxivId?: string; url?: string }): Source | undefined {
  if (s.doi) {
    const r = get<Row>('SELECT * FROM sources WHERE project_id = ? AND lower(doi) = lower(?)', projectId, s.doi)
    if (r) return fromRow(r)
  }
  if (s.arxivId) {
    const r = get<Row>('SELECT * FROM sources WHERE project_id = ? AND arxiv_id = ?', projectId, s.arxivId.replace(/v\d+$/, ''))
    if (r) return fromRow(r)
  }
  if (s.url) {
    const r = get<Row>('SELECT * FROM sources WHERE project_id = ? AND url = ?', projectId, s.url)
    if (r) return fromRow(r)
  }
  return undefined
}

function makeKey(projectId: string, s: { authors?: string[]; year?: number; title: string; url?: string; arxivId?: string; origin?: string }): string {
  let base: string
  const rfc = `${s.title} ${s.url ?? ''}`.match(/\brfc[\s-]?(\d{3,5})\b/i)?.[1]
  const last = (s.authors?.[0] ?? '').split(/[ ,]+/).filter(Boolean).pop() ?? ''
  const word = slugify(s.title).split('-').find(w => w.length > 3 && !/^(https?|www|html|page)$/.test(w)) ?? 'doc'
  if (rfc) base = `rfc${rfc}`
  else if (last && slugify(last, 20) !== 'note') base = `${slugify(last, 20)}${s.year ?? ''}${word}`
  else if (s.arxivId) base = `arxiv${s.arxivId.replace(/\D/g, '')}`
  else if (s.origin === 'human') base = `doc-${word}`
  else {
    // no author: name it after the site (wikipedia-quic, ietf-slides…) rather than a meaningless "note…"
    let site = 'web'
    try {
      site = new URL(s.url ?? '').hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0] || 'web'
    } catch {
      // keep "web"
    }
    base = `${site}-${word}`
  }
  base = base.replace(/[^a-z0-9-]/gi, '').toLowerCase()
  let key = base
  let i = 0
  while (get('SELECT 1 FROM sources WHERE project_id = ? AND citation_key = ?', projectId, key)) key = `${base}${String.fromCharCode(98 + i++)}`
  return key
}

export type SourceInput = Partial<Omit<Source, 'id' | 'projectId' | 'citationKey' | 'createdAt'>> & { title: string }

export function upsertSource(projectId: string, input: SourceInput): Source {
  const existing = findExisting(projectId, { doi: input.doi, arxivId: input.arxivId, url: input.kind === 'web' ? input.url : undefined })
  if (existing) {
    run(
      `UPDATE sources SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, arxiv_id = ?, url = ?, pdf_url = ?, abstract = ?, citations = ? WHERE id = ?`,
      input.title || existing.title,
      JSON.stringify(input.authors?.length ? input.authors : existing.authors),
      input.year ?? existing.year ?? null,
      input.venue ?? existing.venue ?? null,
      input.doi ?? existing.doi ?? null,
      input.arxivId?.replace(/v\d+$/, '') ?? existing.arxivId ?? null,
      existing.url ?? input.url ?? null,
      input.pdfUrl ?? existing.pdfUrl ?? null,
      input.abstract ?? existing.abstract ?? null,
      input.citations ?? existing.citations ?? null,
      existing.id,
    )
    return publish(getSource(projectId, existing.id)!)
  }
  const id = newId('src')
  run(
    `INSERT INTO sources (id, project_id, kind, title, authors, year, venue, doi, arxiv_id, url, pdf_url, abstract, citation_key, status, citations, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, projectId, input.kind ?? 'paper', input.title.trim() || 'Sans titre', JSON.stringify(input.authors ?? []), input.year ?? null,
    input.venue ?? null, input.doi ?? null, input.arxivId?.replace(/v\d+$/, '') ?? null, input.url ?? null, input.pdfUrl ?? null,
    input.abstract ?? null, makeKey(projectId, input), input.status ?? 'metadata', input.citations ?? null, input.notes ?? null, now(),
  )
  return publish(getSource(projectId, id)!)
}

export function setSourceStatus(projectId: string, id: string, status: SourceStatus, notes?: string): Source {
  run('UPDATE sources SET status = ?, notes = COALESCE(?, notes) WHERE id = ?', status, notes ?? null, id)
  return publish(getSource(projectId, id)!)
}

export function updateSourceNotes(projectId: string, id: string, notes: string): Source {
  run('UPDATE sources SET notes = ? WHERE id = ?', notes, id)
  return publish(getSource(projectId, id)!)
}

export function deleteSource(projectId: string, id: string): void {
  const s = getSource(projectId, id)
  if (!s) return
  run('DELETE FROM chunks_fts WHERE source_id = ?', s.id)
  run('DELETE FROM sources WHERE id = ?', s.id)
  for (const ext of ['pdf', 'md', 'txt']) {
    fs.rmSync(path.join(workspaceDir(projectId), 'sources', `${s.citationKey}.${ext}`), { force: true })
  }
  // the original of a document provided by the human lives in inputs/
  if (s.origin === 'human' && s.file?.startsWith('inputs/')) fs.rmSync(path.join(workspaceDir(projectId), s.file), { force: true })
}

function publish(s: Source): Source {
  bus.publish(s.projectId, { type: 'source.upserted', source: s })
  return s
}

// ───────────────────────────── Full text ─────────────────────────────

const CHUNK = 1800

/** Stores the text (with page markers), chunks it, and indexes it. */
export function storeFullText(projectId: string, sourceId: string, pages: string[], ext: 'md' | 'txt' = 'txt'): Source {
  const s = getSource(projectId, sourceId)
  if (!s) throw new Error('Source introuvable')
  const body = pages.length > 1 ? pages.map((p, i) => `\n\n=== [page ${i + 1}] ===\n\n${p}`).join('') : pages[0] ?? ''
  const file = path.join(workspaceDir(projectId), 'sources', `${s.citationKey}.${ext}`)
  fs.writeFileSync(file, body.trim(), 'utf8')
  tx(() => {
    run('DELETE FROM chunks_fts WHERE source_id = ?', s.id)
    let index = 0
    pages.forEach((page, pi) => {
      for (let off = 0; off < page.length; off += CHUNK - 200) {
        const text = page.slice(off, off + CHUNK)
        if (text.trim().length < 40) continue
        run('INSERT INTO chunks_fts (text, source_id, project_id, chunk_index, page) VALUES (?, ?, ?, ?, ?)', text, s.id, projectId, index++, pages.length > 1 ? pi + 1 : 0)
      }
    })
    const chars = pages.reduce((n, p) => n + p.length, 0)
    run("UPDATE sources SET status = 'full_text', pages = ?, chars = ?, text_path = ? WHERE id = ?", pages.length > 1 ? pages.length : null, chars, file, s.id)
  })
  return publish(getSource(projectId, s.id)!)
}

/** Save a PDF into the library and extract + index its text. */
export async function attachPdf(projectId: string, sourceId: string, buffer: Uint8Array): Promise<Source> {
  if (!isPdf(buffer)) throw new Error('Le fichier reçu n\'est pas un PDF (paywall, captcha ou page HTML ?)')
  const s = getSource(projectId, sourceId)
  if (!s) throw new Error('Source introuvable')
  fs.writeFileSync(path.join(workspaceDir(projectId), 'sources', `${s.citationKey}.pdf`), buffer)
  const { pages, title } = await pdfToText(buffer)
  if (title && (s.title === 'Sans titre' || s.title.endsWith('.pdf'))) run('UPDATE sources SET title = ? WHERE id = ?', title, s.id)
  const textChars = pages.reduce((n, p) => n + p.trim().length, 0)
  if (textChars < 200) {
    storeFullText(projectId, s.id, pages)
    return setSourceStatus(projectId, s.id, 'full_text', 'Peu de texte extractible (PDF scanné ?). Un OCR peut être nécessaire.')
  }
  return storeFullText(projectId, s.id, pages)
}

export function readSourceText(projectId: string, idOrKey: string): { source: Source; text: string } {
  const s = resolveSource(projectId, idOrKey)
  if (!s) throw new Error(`Source introuvable: ${idOrKey}`)
  const row = get<{ text_path: string | null }>('SELECT text_path FROM sources WHERE id = ?', s.id)
  if (!row?.text_path || !fs.existsSync(row.text_path)) {
    return { source: s, text: '' }
  }
  return { source: s, text: fs.readFileSync(row.text_path, 'utf8') }
}

export interface ChunkHit {
  sourceId: string
  citationKey: string
  title: string
  page: number
  snippet: string
  text: string
}

export function searchChunks(projectId: string, query: string, limit = 8, sourceId?: string): ChunkHit[] {
  const rows = all<{ source_id: string; page: number; snip: string; text: string }>(
    `SELECT source_id, page, snippet(chunks_fts, 0, '«', '»', '…', 40) AS snip, text FROM chunks_fts
     WHERE chunks_fts MATCH ? AND project_id = ? ${sourceId ? 'AND source_id = ?' : ''} ORDER BY bm25(chunks_fts) LIMIT ?`,
    ...(sourceId ? [ftsQuery(query), projectId, sourceId, limit] : [ftsQuery(query), projectId, limit]),
  )
  return rows.map(r => {
    const s = getSource(projectId, r.source_id)
    return { sourceId: r.source_id, citationKey: s?.citationKey ?? '?', title: s?.title ?? '?', page: r.page, snippet: r.snip, text: r.text }
  })
}

export function sourceToText(s: Source): string {
  const parts = [
    `[${s.citationKey}] ${s.title}`,
    s.authors.length ? `  auteurs: ${s.authors.slice(0, 6).join(', ')}${s.authors.length > 6 ? ' et al.' : ''}` : '',
    `  ${[s.year, s.venue, s.doi ? `doi:${s.doi}` : '', s.arxivId ? `arXiv:${s.arxivId}` : '', s.citations !== undefined ? `${s.citations} citations` : ''].filter(Boolean).join(' · ')}`,
    `  statut: ${s.status}${s.pages ? ` (${s.pages} pages)` : ''}${s.url ? ` · ${s.url}` : ''}`,
  ]
  return parts.filter(Boolean).join('\n')
}
