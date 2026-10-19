import fs from 'node:fs'
import path from 'node:path'
import type { Source } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { workspaceDir } from '../config.ts'
import { capPages, extractDocument } from '../services/documents.ts'
import { getSource, setSourceStatus, storeFullText, upsertSource } from './sources.ts'

/**
 * Documents the human provides as input context. The original file is kept in
 * the workspace (inputs/) so bash/python can use it (data, code…); its text is
 * extracted and indexed in the library like any other source.
 */

/** Files above this size are stored but not parsed (bash/python can still read them). */
const MAX_PARSE_BYTES = 150 * 1024 * 1024

export function inputsDir(projectId: string): string {
  const dir = path.join(workspaceDir(projectId), 'inputs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).normalize('NFC')
  const clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
  return clean.slice(-150) || 'document'
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`
  return candidate
}

export function findByHash(projectId: string, hash: string): Source | undefined {
  const row = get<{ id: string }>('SELECT id FROM sources WHERE project_id = ? AND hash = ?', projectId, hash)
  return row ? getSource(projectId, row.id) : undefined
}

export interface IngestResult {
  source: Source
  duplicate: boolean
  format: string
}

/**
 * Register an uploaded file (already written to `tmpPath`) as a provided document.
 * A file whose content is already in the project is not added twice.
 */
export async function ingestProvidedFile(projectId: string, params: { filename: string; tmpPath: string; hash: string; size: number }): Promise<IngestResult> {
  const { filename, tmpPath, hash, size } = params
  const existing = findByHash(projectId, hash)
  if (existing) {
    fs.rmSync(tmpPath, { force: true })
    return { source: existing, duplicate: true, format: '' }
  }
  const dir = inputsDir(projectId)
  const name = uniquePath(dir, safeName(filename))
  fs.renameSync(tmpPath, path.join(dir, name))
  const rel = `inputs/${name}`

  const extracted = size <= MAX_PARSE_BYTES
    ? await extractDocument(new Uint8Array(fs.readFileSync(path.join(dir, name))), name, path.join(dir, name))
    : { kind: 'dataset' as const, format: path.extname(name).slice(1).toUpperCase() || 'Fichier', pages: [] as string[], note: `Fichier volumineux (${Math.round(size / 1048576)} Mo) : non indexé. Exploite-le avec bash/python (${rel}).` }
  const { pages, truncated } = capPages(extracted.pages)
  const text = pages.join('\n\n').trim()
  const title = extracted.title && extracted.title.length > 3 && !/^(untitled|sans titre|document\d*|microsoft word.*)$/i.test(extracted.title) ? extracted.title : name.replace(/\.[^.]+$/, '')
  const excerpt = text.replace(/[#*_>`|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 420)

  let source = upsertSource(projectId, {
    kind: extracted.kind,
    title,
    authors: extracted.authors,
    abstract: excerpt ? `${excerpt}${text.length > 420 ? '…' : ''}` : undefined,
    venue: `Document fourni · ${extracted.format}`,
    origin: 'human',
    status: 'metadata',
  })
  run("UPDATE sources SET origin = 'human', file = ?, hash = ? WHERE id = ?", rel, hash, source.id)
  if (text) source = storeFullText(projectId, source.id, pages, extracted.markdown ? 'md' : 'txt')
  const notes = [
    extracted.note,
    truncated ? `Texte tronqué dans l'index (trop long) : l'original complet est ${rel}.` : '',
  ].filter(Boolean).join(' ')
  // also republishes the source now that origin/file are set
  source = setSourceStatus(projectId, source.id, text ? 'full_text' : 'metadata', notes || undefined)
  return { source, duplicate: false, format: extracted.format }
}

export function listProvided(projectId: string): Source[] {
  return all<{ id: string }>("SELECT id FROM sources WHERE project_id = ? AND origin = 'human' ORDER BY created_at ASC", projectId)
    .map(r => getSource(projectId, r.id)!)
    .filter(Boolean)
}

/** Which provided documents an agent has actually opened (source_read / source_search / file_read…). */
export function openedProvided(projectId: string, docs: Source[]): Set<string> {
  if (!docs.length) return new Set()
  const rows = all<{ args: string }>(
    "SELECT args FROM tool_runs WHERE project_id = ? AND tool IN ('source_read', 'source_search', 'file_read', 'file_grep', 'python', 'bash')",
    projectId,
  )
  const opened = new Set<string>()
  for (const d of docs) {
    const needles = [d.citationKey, d.file ? path.basename(d.file) : ''].filter(Boolean).map(n => n.toLowerCase())
    if (rows.some(r => needles.some(n => r.args.toLowerCase().includes(n)))) opened.add(d.id)
  }
  return opened
}
