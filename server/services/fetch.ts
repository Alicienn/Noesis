import type { ReaderId } from '../../shared/types.ts'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
// @ts-expect-error — no types published
import { gfm } from 'turndown-plugin-gfm'
import { isPdf, pdfToText } from './pdf.ts'

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const MAX_BYTES = 40 * 1024 * 1024

export interface FetchedDoc {
  url: string
  finalUrl: string
  contentType: string
  title: string
  /** markdown for HTML, plain text for PDFs, raw for text/json */
  text: string
  pdf?: { pages: string[]; buffer: Uint8Array }
  /** Set when the page is an error / anti-bot / login wall rather than content. */
  blocked?: string
  /** How the content was obtained: local conversion or a reader service. */
  via?: string
}

const BLOCK_TITLES: Array<[RegExp, string]> = [
  [/just a moment|attention required|(checking|verifying) (your |the )?browser|checking if the site connection is secure|one moment,? please|security check|ddos-guard|verify (you are|that you are) (a )?human|are you a robot|robot check|captcha|making sure you'?re not a bot|access to this page has been denied/i, 'protection anti-bot (Cloudflare ou équivalent)'],
  [/^\s*(403|401)\b|forbidden|access denied|unauthori[sz]ed/i, 'accès refusé (403/401)'],
  [/^\s*404\b|not found|page introuvable|cannot be found|n'existe pas/i, 'page introuvable (404)'],
  [/wayback machine/i, 'page d\'archive Wayback sans le contenu'],
  [/rate limit|too many requests|^\s*429\b/i, 'limite de débit du site (réessayer plus tard)'],
  [/^google scholar$|^google$/i, 'page de résultats d\'un moteur, pas un document'],
  [/sign in|log ?in|connexion|subscribe to read|purchase (this )?article|buy (this )?article/i, 'mur de connexion / paywall'],
]

/** Recognise error pages, captchas and paywalls so they are never taken for content. */
export function detectBlockedPage(title: string, text: string): string | undefined {
  if (text.length > 8000) return undefined
  for (const [re, reason] of BLOCK_TITLES) if (re.test(title.trim())) return reason
  const head = text.slice(0, 1500)
  if (/enable javascript and cookies|cf-browser-verification|cf-chl|please complete the security check|unusual traffic from your computer/i.test(head)) return 'protection anti-bot (Cloudflare ou équivalent)'
  if (text.trim().length < 200) return 'page quasi vide (contenu chargé en JavaScript ou bloqué)'
  return undefined
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.use(gfm)
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button', 'nav', 'footer'] as any)
// keep math written as MathJax/KaTeX annotations
turndown.addRule('mathAnnotation', {
  filter: (node: any) => node.nodeName === 'MATH' || (node.classList?.contains?.('katex') ?? false),
  replacement: (_content: string, node: any) => {
    const tex = node.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent ?? node.getAttribute?.('alttext')
    return tex ? ` $${tex}$ ` : node.textContent ?? ''
  },
})

export async function fetchBytes(url: string, opts: { signal?: AbortSignal; accept?: string; headers?: Record<string, string> } = {}): Promise<{ buffer: Uint8Array; contentType: string; finalUrl: string; status: number }> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': BROWSER_UA,
      accept: opts.accept ?? 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      'accept-language': 'fr,en;q=0.8',
      ...(opts.headers ?? {}),
    },
    signal: opts.signal ?? AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${url}`)
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`Document trop volumineux (${Math.round(declared / 1e6)} Mo)`)
  const ab = await response.arrayBuffer()
  if (ab.byteLength > MAX_BYTES) throw new Error('Document trop volumineux')
  return { buffer: new Uint8Array(ab), contentType: response.headers.get('content-type') ?? '', finalUrl: response.url || url, status: response.status }
}

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html)
  const title = document.querySelector('title')?.textContent?.trim() ?? ''
  // arXiv / journals expose metadata; Readability strips it, keep a header
  const metaAbstract = document.querySelector('meta[name="citation_abstract"], meta[name="description"]')?.getAttribute('content') ?? ''
  // Readability mutates the DOM: measure and keep the full body first
  const container = document.querySelector('main, article') ?? document.body
  const fullHtml = container?.innerHTML ?? html
  const fullTextLength = (container?.textContent ?? '').length
  let contentHtml = ''
  try {
    const reader = new Readability(document as unknown as Document, { charThreshold: 300 })
    const article = reader.parse()
    // Long technical documents (RFCs, specs, docs) lose whole sections to
    // Readability's "main content" heuristic: keep the full body instead.
    const kept = article?.textContent?.length ?? 0
    const longDocument = fullTextLength > 60_000 || (fullTextLength > 20_000 && kept < fullTextLength * 0.6)
    contentHtml = longDocument ? fullHtml : article?.content ?? ''
  } catch {
    contentHtml = ''
  }
  if (!contentHtml) contentHtml = fullHtml
  let markdown = turndown.turndown(contentHtml)
  markdown = absolutize(markdown, url)
    .replace(/\]\(([^)\s]+) "[^"]*"\)/g, ']($1)') // drop link titles
    .replace(/\[\\\[(\d+)\\\]\]\(#[^)]*\)/g, '[$1]') // wiki footnote refs
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (metaAbstract && !markdown.includes(metaAbstract.slice(0, 60))) markdown = `> ${metaAbstract}\n\n${markdown}`
  return { title, markdown }
}

function absolutize(md: string, base: string): string {
  return md.replace(/\]\((\/[^)\s]*)\)/g, (_m, p: string) => {
    try {
      return `](${new URL(p, base).toString()})`
    } catch {
      return `](${p})`
    }
  })
}

// ───────────────────────────── Reader services (URL → markdown) ─────────────────────────────

/**
 * Public "prefix the URL" services that return any page as markdown. They run
 * a real browser, so they read JavaScript-rendered pages and sites that block
 * our IP — but they see the URLs we read, hence the opt-out in settings.
 */
export type { ReaderId }

export const READERS: Record<ReaderId, { label: string; endpoint: (url: string) => string }> = {
  jina: { label: 'Jina Reader (r.jina.ai)', endpoint: u => `https://r.jina.ai/${u}` },
  defuddle: { label: 'Defuddle (defuddle.md)', endpoint: u => `https://defuddle.md/${u}` },
  puremd: { label: 'pure.md', endpoint: u => `https://pure.md/${u}` },
  markdown_new: { label: 'markdown.new', endpoint: u => `https://markdown.new/${u}` },
}

export const DEFAULT_READERS: ReaderId[] = ['jina', 'defuddle', 'puremd', 'markdown_new']

/** Title from "Title: …" (Jina, markdown.new) or YAML front-matter (Defuddle, pure.md). */
function readerTitle(text: string, fallback: string): string {
  const line = text.match(/^Title:\s*(.+)$/m)?.[1]
  if (line) return line.trim()
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1]
  const t = fm?.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1]
  return t?.trim() || fallback
}

export async function readViaService(id: ReaderId, url: string, opts: { signal?: AbortSignal; jinaKey?: string } = {}): Promise<FetchedDoc | undefined> {
  const reader = READERS[id]
  const response = await fetch(reader.endpoint(url), {
    headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', ...(id === 'jina' && opts.jinaKey ? { authorization: `Bearer ${opts.jinaKey}` } : {}) },
    signal: opts.signal ?? AbortSignal.timeout(60_000),
  })
  if (!response.ok) return undefined
  const text = (await response.text()).trim()
  if (text.startsWith('{') && /"error"/.test(text.slice(0, 200))) return undefined
  const title = readerTitle(text, url)
  return { url, finalUrl: url, contentType: 'text/markdown', title, text, blocked: detectBlockedPage(title, text), via: id }
}

/** Try reader services in order; the first one returning real content wins. */
async function readerChain(url: string, readers: ReaderId[], opts: { signal?: AbortSignal; jinaKey?: string }): Promise<{ doc?: FetchedDoc; blockedDoc?: FetchedDoc; tried: string[] }> {
  const tried: string[] = []
  let best: FetchedDoc | undefined
  let blockedDoc: FetchedDoc | undefined
  for (const id of readers) {
    if (opts.signal?.aborted) break
    try {
      const doc = await readViaService(id, url, opts)
      if (doc && !doc.blocked) {
        // a substantial page wins at once; an app shell (a few hundred chars) only if nothing better comes
        if (doc.text.length > 1500) return { doc, tried }
        if (!best || doc.text.length > best.text.length) best = doc
        tried.push(`${id}: contenu court (${doc.text.length} car.)`)
      } else {
        if (doc?.blocked) blockedDoc ??= doc
        tried.push(`${id}: ${doc ? doc.blocked : 'échec'}`)
      }
    } catch (error) {
      tried.push(`${id}: ${(error as Error).message}`)
    }
  }
  return { doc: best && best.text.length > 300 ? best : undefined, blockedDoc, tried }
}

export interface FetchOptions {
  signal?: AbortSignal
  jinaKey?: string
  /** Reader services allowed as fallback, in order ([] = local conversion only). */
  readers?: ReaderId[]
  /** Force a reader service instead of the local conversion. */
  via?: 'auto' | 'local' | ReaderId
}

/**
 * Fetch any URL and return readable text. PDFs are extracted; HTML is
 * converted locally to markdown. When the local result is blocked, empty or
 * JavaScript-only, reader services are tried in turn.
 */
export async function fetchDocument(url: string, opts: FetchOptions = {}): Promise<FetchedDoc> {
  const readers = opts.readers ?? DEFAULT_READERS
  if (opts.via && opts.via !== 'auto' && opts.via !== 'local') {
    const doc = await readViaService(opts.via, url, opts)
    if (!doc) throw new Error(`${READERS[opts.via].label} n'a pas pu lire ${url}`)
    return doc
  }
  const allowReaders = opts.via !== 'local' && readers.length > 0
  let res: Awaited<ReturnType<typeof fetchBytes>>
  try {
    res = await fetchBytes(url, { signal: opts.signal })
  } catch (error) {
    if (allowReaders) {
      const { doc, blockedDoc, tried } = await readerChain(url, readers, opts)
      if (doc) return doc
      // the readers saw a wall (captcha, paywall…): report it as such so the agent gets the right advice
      if (blockedDoc) return { ...blockedDoc, blocked: `${blockedDoc.blocked} (accès direct : ${(error as Error).message} ; lecteurs : ${tried.join(' | ')})` }
      throw new Error(`${(error as Error).message} ; lecteurs externes : ${tried.join(' | ') || 'aucun'}`)
    }
    throw error
  }
  const ct = res.contentType.toLowerCase()
  if (ct.includes('pdf') || isPdf(res.buffer)) {
    const { pages, title } = await pdfToText(res.buffer)
    return {
      url,
      finalUrl: res.finalUrl,
      contentType: 'application/pdf',
      title: title ?? url.split('/').pop() ?? 'document.pdf',
      text: pages.map((p, i) => `=== [page ${i + 1}] ===\n${p}`).join('\n\n'),
      pdf: { pages, buffer: res.buffer },
    }
  }
  const raw = new TextDecoder(charsetOf(ct)).decode(res.buffer)
  if (ct.includes('html') || /^\s*<(!doctype|html)/i.test(raw)) {
    const { title, markdown } = htmlToMarkdown(raw, res.finalUrl)
    const local: FetchedDoc = { url, finalUrl: res.finalUrl, contentType: 'text/html', title, text: markdown, blocked: detectBlockedPage(title, markdown), via: 'local' }
    // blocked, empty or JavaScript-rendered page: a real browser (reader service) may see the content
    if (allowReaders && (local.blocked || markdown.length < 800)) {
      const { doc, tried } = await readerChain(url, readers, opts)
      if (doc && doc.text.length > markdown.length) return doc
      if (local.blocked) local.blocked = `${local.blocked} (lecteurs externes aussi en échec : ${tried.join(' | ')})`
    }
    return local
  }
  return { url, finalUrl: res.finalUrl, contentType: ct || 'text/plain', title: url, text: raw, via: 'local' }
}

function charsetOf(ct: string): string {
  const m = ct.match(/charset=([\w-]+)/i)
  try {
    if (m) {
      new TextDecoder(m[1])
      return m[1]
    }
  } catch {
    // ignore
  }
  return 'utf-8'
}
