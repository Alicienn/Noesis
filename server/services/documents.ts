import path from 'node:path'
import zlib from 'node:zlib'
import type { Source } from '../../shared/types.ts'
import { htmlToMarkdown } from './fetch.ts'
import { isPdf, pdfToText } from './pdf.ts'
import { convertWithMarkitdown, markitdownHandles, markitdownPages } from './markitdown.ts'

/**
 * Text extraction for documents the human drops into a project: PDF, Office
 * (docx/pptx/xlsx), OpenDocument, EPUB, HTML, notebooks, and anything textual
 * (markdown, LaTeX, code, CSV, JSON…). Pure JS — no external converter.
 * Each "page" is a PDF page, a slide or a spreadsheet tab, so agents can cite it.
 */

export interface ExtractedDocument {
  kind: Source['kind']
  /** Human-readable format label (PDF, Word, CSV…). */
  format: string
  pages: string[]
  title?: string
  authors?: string[]
  /** Something the agent should know (scanned PDF, binary file, truncated…). */
  note?: string
  markdown?: boolean
}

/** Text beyond this is not indexed (the original stays available to bash/python). */
export const MAX_INDEXED_CHARS = 3_000_000

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'org', 'tex', 'bib', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml',
  'py', 'ipy', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'scala', 'rs', 'go', 'rb', 'php', 'swift', 'r', 'jl',
  'm', 'f90', 'f', 'hs', 'ml', 'lean', 'v', 'coq', 'thy', 'sage', 'mpl', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'lua', 'pl', 'proto', 'graphql',
  'log', 'diff', 'patch', 'srt', 'vtt', 'svg', 'gp', 'dot', 'mmd', 'asn', 'asn1', 'pcapng.txt',
])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic'])
const DATA_EXT = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xlsx', 'ods', 'parquet', 'npy', 'npz', 'h5', 'hdf5', 'mat', 'pcap', 'pcapng', 'sqlite', 'db'])

const FORMAT_LABEL: Record<string, string> = {
  docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', xls: 'Excel', msg: 'Outlook', epub: 'EPUB', ipynb: 'Notebook Jupyter', html: 'HTML', htm: 'HTML',
  zip: 'Archive ZIP', mp3: 'Audio', wav: 'Audio', m4a: 'Audio', jpg: 'Image', jpeg: 'Image', png: 'Image', rtf: 'RTF', odt: 'OpenDocument',
}

/**
 * `file` (the stored original) lets MarkItDown handle the formats it does best;
 * the built-in extractor is the fallback, and always handles PDF (page numbers).
 */
export async function extractDocument(buffer: Uint8Array, filename: string, file?: string): Promise<ExtractedDocument> {
  const ext = path.extname(filename).slice(1).toLowerCase()
  const dataKind: Source['kind'] = DATA_EXT.has(ext) ? 'dataset' : 'other'
  try {
    if (ext === 'pdf' || isPdf(buffer)) {
      const { pages, title } = await pdfToText(buffer)
      const chars = pages.reduce((n, p) => n + p.trim().length, 0)
      return { kind: 'pdf', format: 'PDF', pages, title, note: chars < 200 ? 'Peu de texte extractible (PDF scanné ?) : un OCR serait nécessaire.' : undefined }
    }
    if (file && markitdownHandles(filename)) {
      const md = await convertWithMarkitdown(file).catch(() => undefined)
      if (md && md.markdown.replace(/\s/g, '').length > 20) {
        const meta = isZip(buffer) ? (() => {
          try {
            return officeMeta(readZip(buffer))
          } catch {
            return {}
          }
        })() : {}
        const kind: Source['kind'] = ext === 'epub' ? 'book' : ['html', 'htm'].includes(ext) ? 'web' : dataKind === 'dataset' || ext === 'xls' ? 'dataset' : 'other'
        return { kind, format: `${FORMAT_LABEL[ext] ?? ext.toUpperCase()} · MarkItDown`, markdown: true, pages: markitdownPages(md.markdown, ext), title: meta.title ?? md.title, authors: meta.authors }
      }
    }
    if (isZip(buffer)) {
      const zip = readZip(buffer)
      if (ext === 'docx' || zip.has('word/document.xml')) return { kind: 'other', format: 'Word', markdown: true, ...officeMeta(zip), pages: [docxText(zip)] }
      if (ext === 'pptx' || zip.has('ppt/presentation.xml')) return { kind: 'other', format: 'PowerPoint', ...officeMeta(zip), pages: pptxSlides(zip) }
      if (ext === 'xlsx' || zip.has('xl/workbook.xml')) return { kind: 'dataset', format: 'Excel', ...officeMeta(zip), ...xlsxSheets(zip) }
      if (ext === 'epub' || zip.has('META-INF/container.xml')) return { kind: 'book', format: 'EPUB', markdown: true, ...epub(zip) }
      if (zip.has('content.xml')) return { kind: ext === 'ods' ? 'dataset' : 'other', format: 'OpenDocument', ...odfMeta(zip), pages: [odfText(zip.get('content.xml') ?? '')] }
      return { kind: dataKind, format: 'Archive ZIP', pages: [], note: `Archive contenant ${zip.size} fichier(s) : ${[...zip.keys()].slice(0, 30).join(', ')}${zip.size > 30 ? '…' : ''}. Décompresse-la avec bash/python pour l'exploiter.` }
    }
    if (IMAGE_EXT.has(ext)) return { kind: 'other', format: 'Image', pages: [], note: 'Image : pas de texte extractible. Analyse-la avec python (PIL, OCR…) si elle est utile.' }
    if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
      const { title, markdown } = htmlToMarkdown(decodeText(buffer), `file:///${encodeURIComponent(filename)}`)
      return { kind: 'web', format: 'HTML', markdown: true, pages: [markdown], title: title || undefined }
    }
    if (ext === 'ipynb') return { kind: 'other', format: 'Notebook Jupyter', markdown: true, pages: [notebook(decodeText(buffer))] }
    if (ext === 'rtf') return { kind: 'other', format: 'RTF', pages: [rtf(decodeText(buffer))] }
    if (TEXT_EXT.has(ext) || looksTextual(buffer)) {
      const text = decodeText(buffer)
      const md = ['md', 'markdown'].includes(ext)
      const title = md ? text.match(/^#\s+(.+)$/m)?.[1]?.trim() : ext === 'tex' ? text.match(/\\title\{([^}]+)\}/)?.[1]?.trim() : undefined
      return { kind: dataKind, format: ext ? ext.toUpperCase() : 'Texte', markdown: md, pages: [text], title }
    }
    return { kind: dataKind, format: ext ? ext.toUpperCase() : 'Binaire', pages: [], note: 'Fichier binaire : pas de texte extractible. Exploite-le avec bash/python si besoin.' }
  } catch (error) {
    return { kind: dataKind, format: ext ? ext.toUpperCase() : 'Fichier', pages: [], note: `Extraction du texte impossible (${(error as Error).message}). Le fichier original reste exploitable avec bash/python.` }
  }
}

/** Keep the index bounded: very large texts are truncated (the original file stays intact). */
export function capPages(pages: string[]): { pages: string[]; truncated: boolean } {
  let total = 0
  const out: string[] = []
  for (const p of pages) {
    if (total + p.length > MAX_INDEXED_CHARS) {
      out.push(p.slice(0, Math.max(0, MAX_INDEXED_CHARS - total)))
      return { pages: out.filter(x => x.length), truncated: true }
    }
    out.push(p)
    total += p.length
  }
  return { pages: out, truncated: false }
}

// ───────────────────────────── text helpers ─────────────────────────────

function looksTextual(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, 8192)
  if (!sample.length) return true
  let odd = 0
  for (const b of sample) {
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) odd++
  }
  return odd / sample.length < 0.02
}

function decodeText(buffer: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '')
  const bad = (utf8.match(/�/g) ?? []).length
  // legacy Windows files: fall back to cp1252 when UTF-8 decoding clearly fails
  return bad > 20 && bad > utf8.length / 2000 ? new TextDecoder('windows-1252').decode(buffer) : utf8
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return ENTITIES[e] ?? m
  })
}

const tidy = (s: string): string => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

// ───────────────────────────── ZIP (Office, ODF, EPUB) ─────────────────────────────

function isZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
}

/** Minimal ZIP reader (central directory, stored + deflate) returning text entries. */
function readZip(buffer: Uint8Array): Map<string, string> {
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('archive ZIP invalide')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map<string, string>()
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || !/\.(xml|xhtml|html?|rels|opf|ncx|txt)$/i.test(name)) {
      files.set(name, '')
      continue
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) continue
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + compressed)
    try {
      const raw = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : undefined
      files.set(name, raw ? raw.toString('utf8') : '')
    } catch {
      files.set(name, '')
    }
  }
  return files
}

function officeMeta(zip: Map<string, string>): { title?: string; authors?: string[] } {
  const core = zip.get('docProps/core.xml') ?? ''
  const title = unescapeXml(core.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1] ?? '').trim()
  const creator = unescapeXml(core.match(/<dc:creator>([^<]*)<\/dc:creator>/)?.[1] ?? '').trim()
  return { title: title || undefined, authors: creator ? [creator] : undefined }
}

function odfMeta(zip: Map<string, string>): { title?: string; authors?: string[] } {
  const meta = zip.get('meta.xml') ?? ''
  const title = unescapeXml(meta.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1] ?? '').trim()
  const creator = unescapeXml(meta.match(/<(?:dc:creator|meta:initial-creator)>([^<]*)</)?.[1] ?? '').trim()
  return { title: title || undefined, authors: creator ? [creator] : undefined }
}

/** Word: paragraphs, headings as markdown, tables as pipe rows. */
function docxText(zip: Map<string, string>): string {
  const xml = zip.get('word/document.xml') ?? ''
  const paragraph = (p: string): string => {
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? ''
    const level = style.match(/(?:heading|titre)\s*(\d)/i)?.[1] ?? (/^title$/i.test(style) ? '1' : '')
    // only visible runs: <w:t>, tabs and breaks (field codes like HYPERLINK are skipped)
    const text = unescapeXml([...p.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '').matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)].map(m => (m[2] ? (m[2] === 'tab' ? '\t' : '\n') : m[1])).join(''))
    const bullet = /<w:numPr>/.test(p) ? '- ' : ''
    return level && text.trim() ? `${'#'.repeat(Number(level))} ${text.trim()}` : `${bullet}${text}`
  }
  const out: string[] = []
  const blocks = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? []
  for (const b of blocks) {
    if (b.startsWith('<w:tbl>')) {
      const rows = (b.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map(r => `| ${(r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(c => (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(paragraph).join(' ').trim().replace(/\|/g, '\\|')).join(' | ')} |`)
      if (rows.length) out.push('', rows[0], `|${' --- |'.repeat((rows[0].match(/ \| /g)?.length ?? 0) + 1)}`, ...rows.slice(1), '')
    } else {
      out.push(paragraph(b))
    }
  }
  return tidy(out.join('\n'))
}

function pptxSlides(zip: Map<string, string>): string[] {
  const slides = [...zip.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  return slides.map(k => {
    const xml = zip.get(k) ?? ''
    const notes = zip.get(k.replace('slides/slide', 'notesSlides/notesSlide')) ?? ''
    const text = (x: string): string => tidy(unescapeXml(x.replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n').replace(/<[^>]+>/g, '')))
    const body = text(xml)
    const speaker = notes ? text(notes).replace(/^\d+\s*$/m, '').trim() : ''
    return speaker ? `${body}\n\n[Notes de l'orateur]\n${speaker}` : body
  })
}

function xlsxSheets(zip: Map<string, string>): { pages: string[]; note?: string } {
  const shared = (zip.get('xl/sharedStrings.xml')?.match(/<si>[\s\S]*?<\/si>/g) ?? []).map(si => unescapeXml(si.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')))
  const workbook = zip.get('xl/workbook.xml') ?? ''
  const names = [...workbook.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(m => unescapeXml(m[1]))
  const sheets = [...zip.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  let truncated = false
  const pages = sheets.map((k, i) => {
    const rows = (zip.get(k) ?? '').match(/<row[ >][\s\S]*?<\/row>/g) ?? []
    if (rows.length > 5000) truncated = true
    const lines = rows.slice(0, 5000).map(r => (r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []).map(c => {
      const v = c.match(/<v>([^<]*)<\/v>/)?.[1]
      if (/t="s"/.test(c) && v !== undefined) return shared[Number(v)] ?? ''
      if (/t="inlineStr"/.test(c)) return unescapeXml(c.replace(/<[^>]+>/g, ''))
      return v !== undefined ? unescapeXml(v) : ''
    }).join('\t'))
    return `## Feuille « ${names[i] ?? `Feuille ${i + 1}`} » (${rows.length} lignes)\n\n${lines.join('\n')}`
  })
  return { pages, note: truncated ? 'Feuilles tronquées à 5000 lignes dans l\'index : lis le fichier original avec python (pandas.read_excel) pour l\'intégralité.' : undefined }
}

function odfText(xml: string): string {
  const body = xml.replace(/<text:h[^>]*text:outline-level="(\d)"[^>]*>/g, (_m, l: string) => `\n${'#'.repeat(Number(l))} `)
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<table:table-cell[^>]*>/g, '\t')
    .replace(/<[^>]+>/g, '')
  return tidy(unescapeXml(body))
}

function epub(zip: Map<string, string>): { pages: string[]; title?: string; authors?: string[] } {
  const opfPath = (zip.get('META-INF/container.xml') ?? '').match(/full-path="([^"]+)"/)?.[1] ?? [...zip.keys()].find(k => k.endsWith('.opf')) ?? ''
  const opf = zip.get(opfPath) ?? ''
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map([...opf.matchAll(/<item [^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)].map(m => [m[1], m[2]]))
  for (const m of opf.matchAll(/<item [^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)) manifest.set(m[2], m[1])
  const spine = [...opf.matchAll(/<itemref [^>]*idref="([^"]+)"/g)].map(m => manifest.get(m[1])).filter(Boolean) as string[]
  const order = spine.length ? spine.map(h => base + decodeURIComponent(h)) : [...zip.keys()].filter(k => /\.x?html?$/i.test(k)).sort()
  const pages = order.map(k => zip.get(k) ?? '').filter(Boolean).map(html => htmlToMarkdown(html, 'file:///book').markdown).filter(t => t.trim())
  const title = unescapeXml(opf.match(/<dc:title[^>]*>([^<]*)</)?.[1] ?? '').trim()
  const authors = [...opf.matchAll(/<dc:creator[^>]*>([^<]*)</g)].map(m => unescapeXml(m[1]).trim()).filter(Boolean)
  return { pages, title: title || undefined, authors: authors.length ? authors : undefined }
}

function notebook(json: string): string {
  const nb = JSON.parse(json) as { cells?: Array<{ cell_type: string; source: string | string[]; outputs?: Array<{ text?: string | string[]; data?: Record<string, string | string[]> }> }>; metadata?: { kernelspec?: { language?: string } } }
  const lang = nb.metadata?.kernelspec?.language ?? 'python'
  const join = (s: string | string[] | undefined): string => (Array.isArray(s) ? s.join('') : s ?? '')
  return tidy((nb.cells ?? []).map(c => {
    if (c.cell_type === 'markdown') return join(c.source)
    if (c.cell_type !== 'code') return join(c.source)
    const out = (c.outputs ?? []).map(o => join(o.text ?? o.data?.['text/plain'])).join('\n').trim()
    return `\`\`\`${lang}\n${join(c.source)}\n\`\`\`${out ? `\n\nSortie :\n\`\`\`\n${out.slice(0, 3000)}${out.length > 3000 ? '\n…' : ''}\n\`\`\`` : ''}`
  }).join('\n\n'))
}

function rtf(text: string): string {
  return tidy(text
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, ''))
}
