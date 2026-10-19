import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getSettings } from '../settings.ts'
import { execFile } from './shell.ts'

/**
 * Microsoft MarkItDown (github.com/microsoft/markitdown), used when installed in
 * the configured Python: better Office tables, plus formats the built-in
 * extractor cannot read (legacy .xls, Outlook .msg, audio transcription,
 * image metadata, ZIP contents). The built-in extractor stays the fallback.
 */

export interface MarkitdownStatus {
  available: boolean
  version?: string
  python: string
  error?: string
  checkedAt: number
}

let cached: MarkitdownStatus | undefined
const TTL = 5 * 60_000

const python = (): string => getSettings().shell.pythonPath || 'python'

export async function markitdownStatus(force = false): Promise<MarkitdownStatus> {
  const py = python()
  if (!force && cached && cached.python === py && Date.now() - cached.checkedAt < TTL) return cached
  const r = await execFile(py, ['-c', 'import markitdown, sys; sys.stdout.write(getattr(markitdown, "__version__", "?"))'], { cwd: os.tmpdir(), timeoutMs: 30_000, shellLabel: 'python' })
  cached = r.exitCode === 0
    ? { available: true, version: r.stdout.trim() || '?', python: py, checkedAt: Date.now() }
    : { available: false, python: py, error: /No module named/.test(r.stderr) ? 'non installé' : (r.stderr.trim().split('\n').pop() ?? 'Python introuvable').slice(0, 300), checkedAt: Date.now() }
  return cached
}

export const markitdownEnabled = (): boolean => getSettings().documents?.markitdown !== false

/** Formats where MarkItDown is tried before the built-in extractor (PDF keeps the page-aware built-in path). */
const PREFERRED = new Set(['docx', 'pptx', 'xlsx', 'xls', 'msg', 'epub', 'ipynb', 'html', 'htm', 'zip', 'mp3', 'wav', 'm4a', 'jpg', 'jpeg', 'png', 'rtf', 'odt'])

export function markitdownHandles(filename: string): boolean {
  return PREFERRED.has(path.extname(filename).slice(1).toLowerCase())
}

const SCRIPT = [
  'import sys',
  'from markitdown import MarkItDown',
  'r = MarkItDown(enable_plugins=False).convert(sys.argv[1])',
  'open(sys.argv[2], "w", encoding="utf-8").write(r.markdown or "")',
  'sys.stdout.write(r.title or "")',
].join('\n')

/** Convert a file to markdown, or undefined when MarkItDown is unavailable or fails. */
export async function convertWithMarkitdown(file: string, signal?: AbortSignal): Promise<{ markdown: string; title?: string } | undefined> {
  if (!markitdownEnabled() || !(await markitdownStatus()).available) return undefined
  const out = path.join(os.tmpdir(), `noesis-md-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
  try {
    const r = await execFile(python(), ['-c', SCRIPT, file, out], { cwd: path.dirname(file), timeoutMs: 300_000, signal, shellLabel: 'python' })
    if (r.exitCode !== 0 || !fs.existsSync(out)) return undefined
    const markdown = fs.readFileSync(out, 'utf8').trim()
    return markdown ? { markdown, title: r.stdout.trim() || undefined } : undefined
  } finally {
    fs.rmSync(out, { force: true })
  }
}

/** pip install "markitdown[all]" into the configured Python (triggered from the settings page). */
export async function installMarkitdown(): Promise<{ ok: boolean; log: string; status: MarkitdownStatus }> {
  const r = await execFile(python(), ['-m', 'pip', 'install', '--upgrade', 'markitdown[all]'], { cwd: os.tmpdir(), timeoutMs: 15 * 60_000, shellLabel: 'python' })
  const status = await markitdownStatus(true)
  const log = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-25).join('\n')
  return { ok: r.exitCode === 0 && status.available, log, status }
}

/** Split MarkItDown output back into "pages": slides and spreadsheet tabs stay citable. */
export function markitdownPages(markdown: string, ext: string): string[] {
  if (ext === 'pptx') {
    const parts = markdown.split(/\n?<!-- Slide number: \d+ -->\n?/).map(p => p.trim()).filter(Boolean)
    if (parts.length > 1) return parts
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const parts = markdown.split(/\n(?=## )/).map(p => p.trim()).filter(Boolean)
    if (parts.length > 1) return parts
  }
  return [markdown]
}
