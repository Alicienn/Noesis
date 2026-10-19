import { DOMParser, parseHTML } from 'linkedom'
import { getSettings } from '../settings.ts'
import { BROWSER_UA, fetchBytes } from './fetch.ts'

/**
 * Scholarly retrieval: arXiv, Semantic Scholar, OpenAlex, Crossref, Europe PMC,
 * CORE, Unpaywall. Results are normalised into `Paper`. Every backend is
 * optional and failures are collected rather than thrown, so one rate-limited
 * API never blinds the agent.
 */

export interface Paper {
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  arxivId?: string
  s2Id?: string
  openAlexId?: string
  url?: string
  pdfUrl?: string
  abstract?: string
  citations?: number
  source: string
}

const T = (ms = 25_000): AbortSignal => AbortSignal.timeout(ms)

function polite(): string {
  const email = getSettings().search.contactEmail
  return email ? `mailto=${encodeURIComponent(email)}` : ''
}

// ───────────────────────────── arXiv ─────────────────────────────

let lastArxiv = 0
async function arxivThrottle(): Promise<void> {
  const wait = lastArxiv + 3100 - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastArxiv = Date.now()
}

export async function searchArxiv(query: string, n = 10, opts: { idList?: string[]; sort?: 'relevance' | 'submittedDate' } = {}): Promise<Paper[]> {
  await arxivThrottle()
  const params = new URLSearchParams({ start: '0', max_results: String(n), sortBy: opts.sort ?? 'relevance' })
  if (opts.idList?.length) params.set('id_list', opts.idList.join(','))
  else params.set('search_query', /\b(ti|au|abs|cat|all):/.test(query) ? query : arxivQuery(query))
  const r = await fetch(`https://export.arxiv.org/api/query?${params}`, { signal: T(), headers: { 'user-agent': 'Noesis/1.0' } })
  if (!r.ok) throw new Error(`arXiv HTTP ${r.status}`)
  const xml = await r.text()
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const out: Paper[] = []
  for (const e of doc.querySelectorAll('entry')) {
    const idUrl = e.querySelector('id')?.textContent ?? ''
    const arxivId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')
    if (!arxivId || idUrl.includes('api/errors')) continue
    const published = e.querySelector('published')?.textContent ?? ''
    const doi = e.querySelector('doi')?.textContent ?? undefined
    out.push({
      title: clean(e.querySelector('title')?.textContent),
      authors: [...e.querySelectorAll('author name')].map(a => clean(a.textContent)),
      year: published ? Number(published.slice(0, 4)) : undefined,
      venue: `arXiv ${e.querySelector('category')?.getAttribute('term') ?? ''}`.trim(),
      arxivId,
      doi,
      url: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      abstract: clean(e.querySelector('summary')?.textContent),
      source: 'arxiv',
    })
  }
  return out
}

/** arXiv treats bare words loosely; AND the significant terms instead. */
function arxivQuery(q: string): string {
  const terms = q.replace(/[:"()]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !/^(and|or|the|of|for|with|des|les|une|pour)$/i.test(t)).slice(0, 8)
  return terms.length ? terms.map(t => `all:${t}`).join(' AND ') : `all:${q}`
}

// ───────────────────────────── Semantic Scholar ─────────────────────────────

const S2_FIELDS = 'title,authors,year,venue,abstract,externalIds,openAccessPdf,citationCount,url'

function s2Headers(): Record<string, string> {
  const key = getSettings().search.semanticScholarKey
  return key ? { 'x-api-key': key } : {}
}

function fromS2(p: any): Paper {
  return {
    title: p.title ?? '',
    authors: (p.authors ?? []).map((a: any) => a.name),
    year: p.year ?? undefined,
    venue: p.venue || undefined,
    doi: p.externalIds?.DOI,
    arxivId: p.externalIds?.ArXiv,
    s2Id: p.paperId,
    url: p.url,
    pdfUrl: p.openAccessPdf?.url || undefined,
    abstract: p.abstract ?? undefined,
    citations: p.citationCount ?? undefined,
    source: 'semantic_scholar',
  }
}

export async function searchSemanticScholar(query: string, n = 10, yearRange?: string): Promise<Paper[]> {
  const params = new URLSearchParams({ query, limit: String(Math.min(n, 100)), fields: S2_FIELDS })
  if (yearRange) params.set('year', yearRange)
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, { signal: T(), headers: s2Headers() })
  if (r.status === 429) throw new Error('Semantic Scholar: limite de débit (429) — ajoute une clé API dans les paramètres')
  if (!r.ok) throw new Error(`Semantic Scholar HTTP ${r.status}`)
  const j = (await r.json()) as any
  return (j.data ?? []).map(fromS2)
}

/** Paper id forms accepted by S2: DOI:..., ARXIV:..., CorpusId:..., or S2 id. */
function s2Id(ref: { doi?: string; arxivId?: string; s2Id?: string }): string | undefined {
  if (ref.s2Id) return ref.s2Id
  if (ref.doi) return `DOI:${ref.doi}`
  if (ref.arxivId) return `ARXIV:${ref.arxivId}`
  return undefined
}

export async function s2Graph(ref: { doi?: string; arxivId?: string; s2Id?: string }, direction: 'citations' | 'references', n = 20): Promise<Paper[]> {
  const id = s2Id(ref)
  if (!id) throw new Error('Il faut un DOI, un identifiant arXiv ou Semantic Scholar')
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}/${direction}?limit=${n}&fields=${S2_FIELDS}`, { signal: T(), headers: s2Headers() })
  if (!r.ok) throw new Error(`Semantic Scholar HTTP ${r.status}`)
  const j = (await r.json()) as any
  return (j.data ?? []).map((x: any) => fromS2(x.citingPaper ?? x.citedPaper ?? x))
}

// ───────────────────────────── OpenAlex ─────────────────────────────

function openAlexParams(): string {
  const s = getSettings().search
  return [polite(), s.openAlexKey ? `api_key=${encodeURIComponent(s.openAlexKey)}` : ''].filter(Boolean).join('&')
}

function invertedToText(inv: Record<string, number[]> | null | undefined): string | undefined {
  if (!inv) return undefined
  const words: string[] = []
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w
  return words.join(' ')
}

function fromOpenAlex(w: any): Paper {
  const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : undefined
  const arxivLoc = (w.locations ?? []).find((l: any) => /arxiv\.org/.test(l?.landing_page_url ?? ''))
  return {
    title: w.title ?? w.display_name ?? '',
    authors: (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
    year: w.publication_year ?? undefined,
    venue: w.primary_location?.source?.display_name ?? undefined,
    doi,
    arxivId: arxivLoc ? String(arxivLoc.landing_page_url).split('/abs/')[1]?.replace(/v\d+$/, '') : undefined,
    openAlexId: String(w.id ?? '').split('/').pop(),
    url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
    pdfUrl: w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? undefined,
    abstract: invertedToText(w.abstract_inverted_index),
    citations: w.cited_by_count ?? undefined,
    source: 'openalex',
  }
}

export async function searchOpenAlex(query: string, n = 10, filter?: string): Promise<Paper[]> {
  const params = [`search=${encodeURIComponent(query)}`, `per-page=${Math.min(n, 50)}`, filter ? `filter=${encodeURIComponent(filter)}` : '', openAlexParams()].filter(Boolean).join('&')
  const r = await fetch(`https://api.openalex.org/works?${params}`, { signal: T() })
  if (!r.ok) throw new Error(`OpenAlex HTTP ${r.status}${r.status === 429 ? ' (budget quotidien épuisé — ajoute une clé API)' : ''}`)
  const j = (await r.json()) as any
  return (j.results ?? []).map(fromOpenAlex)
}

export async function openAlexByDoi(doi: string): Promise<Paper | undefined> {
  const r = await fetch(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?${openAlexParams()}`, { signal: T() })
  if (!r.ok) return undefined
  return fromOpenAlex(await r.json())
}

export async function openAlexGraph(ref: { doi?: string; openAlexId?: string }, direction: 'citations' | 'references', n = 20): Promise<Paper[]> {
  let id = ref.openAlexId
  if (!id && ref.doi) id = (await openAlexByDoi(ref.doi))?.openAlexId
  if (!id) throw new Error('Œuvre introuvable sur OpenAlex')
  const filter = direction === 'citations' ? `cites:${id}` : `cited_by:${id}`
  const r = await fetch(`https://api.openalex.org/works?filter=${filter}&per-page=${n}&sort=cited_by_count:desc&${openAlexParams()}`, { signal: T() })
  if (!r.ok) throw new Error(`OpenAlex HTTP ${r.status}`)
  const j = (await r.json()) as any
  return (j.results ?? []).map(fromOpenAlex)
}

// ───────────────────────────── Crossref / Europe PMC / CORE ─────────────────────────────

function fromCrossref(it: any): Paper {
  const year = it.issued?.['date-parts']?.[0]?.[0] ?? it.published?.['date-parts']?.[0]?.[0]
  return {
    title: (it.title ?? [''])[0],
    authors: (it.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')),
    year,
    venue: (it['container-title'] ?? [])[0],
    doi: it.DOI,
    url: it.URL,
    pdfUrl: (it.link ?? []).find((l: any) => l['content-type'] === 'application/pdf')?.URL,
    abstract: it.abstract ? String(it.abstract).replace(/<[^>]+>/g, '') : undefined,
    citations: it['is-referenced-by-count'],
    source: 'crossref',
  }
}

export async function searchCrossref(query: string, n = 10): Promise<Paper[]> {
  const r = await fetch(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${n}&${polite()}`, { signal: T() })
  if (!r.ok) throw new Error(`Crossref HTTP ${r.status}`)
  const j = (await r.json()) as any
  return (j.message?.items ?? []).map(fromCrossref)
}

export async function crossrefByDoi(doi: string): Promise<Paper | undefined> {
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}?${polite()}`, { signal: T() })
  if (!r.ok) return undefined
  const j = (await r.json()) as any
  return j.message ? fromCrossref(j.message) : undefined
}

export async function searchEuropePmc(query: string, n = 10): Promise<Paper[]> {
  const r = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${n}`, { signal: T() })
  if (!r.ok) throw new Error(`Europe PMC HTTP ${r.status}`)
  const j = (await r.json()) as any
  return (j.resultList?.result ?? []).map((x: any) => ({
    title: x.title ?? '',
    authors: (x.authorString ?? '').split(', ').filter(Boolean),
    year: x.pubYear ? Number(x.pubYear) : undefined,
    venue: x.journalInfo?.journal?.title,
    doi: x.doi,
    url: x.doi ? `https://doi.org/${x.doi}` : `https://europepmc.org/article/${x.source}/${x.id}`,
    pdfUrl: (x.fullTextUrlList?.fullTextUrl ?? []).find((u: any) => u.documentStyle === 'pdf' && u.availabilityCode === 'OA')?.url,
    abstract: x.abstractText ? String(x.abstractText).replace(/<[^>]+>/g, '') : undefined,
    citations: x.citedByCount,
    source: 'europepmc',
  }))
}

export async function searchCore(query: string, n = 10): Promise<Paper[]> {
  // CORE answers without a key at a low rate; a key raises the limit
  const key = getSettings().search.coreKey
  const r = await fetch(`https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${n}`, { signal: T(), headers: key ? { authorization: `Bearer ${key}` } : {} })
  if (!r.ok) throw new Error(`CORE HTTP ${r.status}`)
  const j = (await r.json()) as any
  return (j.results ?? []).map((x: any) => ({
    title: x.title ?? '',
    authors: (x.authors ?? []).map((a: any) => a.name),
    year: x.yearPublished,
    doi: x.doi,
    url: x.links?.find((l: any) => l.type === 'display')?.url,
    pdfUrl: x.downloadUrl || undefined,
    abstract: x.abstract,
    source: 'core',
  }))
}

// ───────────────────────────── Aggregated search ─────────────────────────────

export type AcademicBackend = 'arxiv' | 'semantic_scholar' | 'openalex' | 'crossref' | 'europepmc' | 'core'

/**
 * Backends out of budget / rate-limited are put aside instead of being asked
 * (and failing) on every call. OpenAlex's keyless budget is daily.
 */
const backendCooldown = new Map<string, { until: number; reason: string }>()

export function cooledDown(backend: string): string | undefined {
  const c = backendCooldown.get(backend)
  return c && c.until > Date.now() ? c.reason : undefined
}

export function coolDown(backend: string, error: string): void {
  const budget = /budget|insufficient/i.test(error)
  const rate = /429|limite de débit|rate/i.test(error)
  const ms = budget ? 3 * 3600_000 : rate ? 3 * 60_000 : /HTTP 5\d\d|fetch failed|timeout|ECONN/i.test(error) ? 5 * 60_000 : 0
  if (ms) backendCooldown.set(backend, { until: Date.now() + ms, reason: error.slice(0, 120) })
}

export function academicStatus(): Array<{ backend: string; reason: string; minutesLeft: number }> {
  return [...backendCooldown].filter(([, c]) => c.until > Date.now()).map(([backend, c]) => ({ backend, reason: c.reason, minutesLeft: Math.ceil((c.until - Date.now()) / 60_000) }))
}

const searchCache = new Map<string, { at: number; papers: Paper[] }>()

async function runBackend(b: AcademicBackend, query: string, n: number, yearFrom?: number): Promise<Paper[]> {
  const key = `${b}|${n}|${yearFrom ?? ''}|${query}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.papers
  let papers: Paper[] = []
  switch (b) {
    case 'arxiv': papers = await searchArxiv(query, n); break
    case 'semantic_scholar': papers = await searchSemanticScholar(query, n, yearFrom ? `${yearFrom}-` : undefined); break
    case 'openalex': papers = await searchOpenAlex(query, n, yearFrom ? `from_publication_date:${yearFrom}-01-01` : undefined); break
    case 'crossref': papers = await searchCrossref(query, n); break
    case 'europepmc': papers = await searchEuropePmc(query, n); break
    case 'core': papers = await searchCore(query, n); break
  }
  searchCache.set(key, { at: Date.now(), papers })
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!)
  return papers
}

/** Over-quoted, over-long queries return nothing on most engines: keep the 7 most telling words. */
export function relaxQuery(query: string): string {
  const stop = /^(the|and|or|of|for|with|on|in|a|an|to|de|des|les|la|le|et|pour|sur|un|une|du|via|using|based)$/i
  const words = query.replace(/["“”()]/g, ' ').replace(/\b(site|OR|AND):?\S*/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stop.test(w) && !/^\d{4}$/.test(w))
  return [...new Set(words)].slice(0, 7).join(' ')
}

export async function searchPapers(query: string, opts: { n?: number; backends?: AcademicBackend[]; yearFrom?: number } = {}): Promise<{ papers: Paper[]; errors: string[]; relaxed?: string }> {
  const n = opts.n ?? 10
  const requested = opts.backends?.length ? opts.backends : (['openalex', 'semantic_scholar', 'arxiv', 'crossref', 'core'] as AcademicBackend[])
  const errors: string[] = []
  let backends = requested.filter(b => {
    const reason = cooledDown(b)
    if (reason) errors.push(`${b}: ignoré temporairement (${reason})`)
    return !reason
  })
  // everything requested is down: fall back to the backends that still answer
  if (!backends.length) backends = (['arxiv', 'crossref', 'core', 'europepmc'] as AcademicBackend[]).filter(b => !cooledDown(b))
  const ask = async (q: string): Promise<Paper[]> => {
    const lists = await Promise.all(backends.map(async b => {
      try {
        return await runBackend(b, q, n, opts.yearFrom)
      } catch (error) {
        const msg = (error as Error).message
        errors.push(`${b}: ${msg}`)
        coolDown(b, msg)
        return []
      }
    }))
    return mergePapers(lists.flat())
  }
  let papers = await ask(query)
  let relaxed: string | undefined
  if (!papers.length) {
    const simpler = relaxQuery(query)
    if (simpler && simpler !== query) {
      relaxed = simpler
      papers = await ask(simpler)
    }
  }
  return { papers: papers.slice(0, n * 2), errors, relaxed }
}

// ───────────────────────────── Known-item lookup ─────────────────────────────

function titleSimilarity(a: string, b: string): number {
  const wa = new Set(normTitle(a).split(' ').filter(w => w.length > 2))
  const wb = new Set(normTitle(b).split(' ').filter(w => w.length > 2))
  if (!wa.size || !wb.size) return 0
  let common = 0
  for (const w of wa) if (wb.has(w)) common++
  return common / Math.max(wa.size, wb.size)
}

/**
 * Find ONE specific paper from its title (+ authors / year). Agents spent
 * dozens of calls hunting known papers with keyword searches; Crossref's
 * bibliographic matcher and arXiv title search are made for this.
 */
export async function lookupPaper(title: string, opts: { authors?: string; year?: number } = {}): Promise<{ matches: Array<Paper & { score: number }>; errors: string[] }> {
  const errors: string[] = []
  const biblio = [title, opts.authors, opts.year].filter(Boolean).join(' ')
  const tries: Array<Promise<Paper[]>> = [
    (async () => {
      const r = await fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(biblio)}&rows=6&${polite()}`, { signal: T() })
      if (!r.ok) throw new Error(`Crossref HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.message?.items ?? []).map(fromCrossref)
    })(),
    searchArxiv(`ti:"${title.replace(/"/g, '')}"`, 4),
  ]
  if (!cooledDown('openalex')) {
    tries.push((async () => {
      const r = await fetch(`https://api.openalex.org/works?filter=${encodeURIComponent(`title.search:${title.replace(/[,:]/g, ' ')}`)}&per-page=5&${openAlexParams()}`, { signal: T() })
      if (!r.ok) {
        const msg = `OpenAlex HTTP ${r.status}${r.status === 429 ? ' budget' : ''}`
        coolDown('openalex', msg)
        throw new Error(msg)
      }
      return ((await r.json()) as any).results?.map(fromOpenAlex) ?? []
    })())
  }
  const settled = await Promise.allSettled(tries)
  const papers: Paper[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') papers.push(...s.value)
    else errors.push((s.reason as Error).message)
  }
  const authorHint = (opts.authors ?? '').toLowerCase().split(/[\s,;]+/).filter(w => w.length > 2)
  const scored = mergePapers(papers).map(p => {
    let score = titleSimilarity(title, p.title)
    if (opts.year && p.year && Math.abs(p.year - opts.year) <= 1) score += 0.1
    if (authorHint.length && p.authors.some(a => authorHint.some(h => a.toLowerCase().includes(h)))) score += 0.15
    return { ...p, score: Math.round(score * 100) / 100 }
  })
  return { matches: scored.filter(p => p.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 5), errors }
}

// ───────────────────────────── OpenCitations (free citation graph) ─────────────────────────────

/** Citation graph by DOI via OpenCitations (COCI + Meta): no key, no budget. */
export async function openCitationsGraph(doi: string, direction: 'citations' | 'references', n = 20): Promise<Paper[]> {
  const r = await fetch(`https://opencitations.net/index/coci/api/v1/${direction}/${encodeURIComponent(doi)}`, { signal: T(30_000) })
  if (!r.ok) throw new Error(`OpenCitations HTTP ${r.status}`)
  const rows = (await r.json()) as Array<{ citing: string; cited: string }>
  const dois = [...new Set(rows.map(x => (direction === 'citations' ? x.citing : x.cited)).filter(Boolean))].slice(0, n)
  if (!dois.length) return []
  const meta = await fetch(`https://opencitations.net/meta/api/v1/metadata/${dois.map(d => `doi:${d}`).join('__')}`, { signal: T(30_000) })
  if (!meta.ok) return dois.map(d => ({ title: `doi:${d}`, authors: [], doi: d, url: `https://doi.org/${d}`, source: 'opencitations' }))
  const items = (await meta.json()) as Array<{ id: string; title: string; author: string; pub_date: string; venue: string }>
  return items.map(it => {
    const d = it.id.match(/doi:(\S+)/)?.[1]
    return {
      title: it.title || `doi:${d}`,
      authors: (it.author ?? '').split(';').map(a => a.replace(/\[.*?\]/g, '').split(',').reverse().join(' ').trim()).filter(Boolean),
      year: it.pub_date ? Number(it.pub_date.slice(0, 4)) : undefined,
      venue: it.venue?.replace(/\[.*?\]/g, '').trim() || undefined,
      doi: d,
      url: d ? `https://doi.org/${d}` : undefined,
      source: 'opencitations',
    }
  })
}

/** Merge duplicates across backends (same DOI / arXiv id / normalised title). */
export function mergePapers(papers: Paper[]): Paper[] {
  const out: Paper[] = []
  const key = (p: Paper): string[] => [p.doi?.toLowerCase(), p.arxivId, normTitle(p.title)].filter(Boolean) as string[]
  for (const p of papers) {
    if (!p.title) continue
    const keys = key(p)
    const existing = out.find(o => key(o).some(k => keys.includes(k)))
    if (!existing) {
      out.push({ ...p })
      continue
    }
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && (existing as any)[k] === undefined) (existing as any)[k] = v
    }
    if ((p.citations ?? 0) > (existing.citations ?? 0)) existing.citations = p.citations
    existing.source = [...new Set(`${existing.source},${p.source}`.split(','))].join(',')
  }
  return out
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

// ───────────────────────────── Open-access PDF resolution ─────────────────────────────

export async function unpaywall(doi: string): Promise<string[]> {
  const email = getSettings().search.contactEmail || 'noesis@example.org'
  const r = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, { signal: T() })
  if (!r.ok) return []
  const j = (await r.json()) as any
  const urls = [j.best_oa_location?.url_for_pdf, ...(j.oa_locations ?? []).map((l: any) => l.url_for_pdf)].filter(Boolean)
  return [...new Set(urls as string[])]
}

/** Look for <meta name="citation_pdf_url"> on a landing page (most publishers & repositories). */
export async function landingPagePdf(url: string): Promise<string | undefined> {
  try {
    const { buffer, contentType, finalUrl } = await fetchBytes(url, { accept: 'text/html' })
    if (contentType.includes('pdf')) return finalUrl
    const { document } = parseHTML(new TextDecoder().decode(buffer))
    const meta = document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute('content')
    if (meta) return new URL(meta, finalUrl).toString()
    const link = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') ?? '').find(h => /\.pdf($|\?)/i.test(h))
    return link ? new URL(link, finalUrl).toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Preprints and repository copies found by title: many "paywalled" papers
 * (ACM, IEEE) have an arXiv version or an institutional copy indexed by CORE.
 */
async function copiesByTitle(title: string): Promise<string[]> {
  const out: string[] = []
  const [arxiv, core] = await Promise.allSettled([
    searchArxiv(`ti:"${title.replace(/"/g, '').slice(0, 200)}"`, 3),
    cooledDown('core') ? Promise.resolve([] as Paper[]) : searchCore(`title:"${title.replace(/"/g, '')}"`, 5),
  ])
  for (const s of [arxiv, core]) {
    if (s.status !== 'fulfilled') continue
    for (const p of s.value) {
      if (titleSimilarity(title, p.title) < 0.8) continue
      if (p.arxivId) out.push(`https://arxiv.org/pdf/${p.arxivId}`)
      if (p.pdfUrl) out.push(p.pdfUrl)
    }
  }
  return out
}

/** Ordered list of candidate PDF URLs for a paper. */
export async function pdfCandidates(p: { doi?: string; arxivId?: string; pdfUrl?: string; url?: string; s2Id?: string; title?: string }): Promise<string[]> {
  const out: string[] = []
  if (p.arxivId) out.push(`https://arxiv.org/pdf/${p.arxivId}`)
  if (p.pdfUrl) out.push(p.pdfUrl)
  if (p.doi) {
    const [ua, oa] = await Promise.all([unpaywall(p.doi).catch(() => []), openAlexByDoi(p.doi).catch(() => undefined)])
    out.push(...ua)
    if (oa?.pdfUrl) out.push(oa.pdfUrl)
    if (oa?.arxivId) out.push(`https://arxiv.org/pdf/${oa.arxivId}`)
    if (/^10\.48550\/arxiv\./i.test(p.doi)) out.push(`https://arxiv.org/pdf/${p.doi.split(/arxiv\./i)[1]}`)
  }
  if (!p.arxivId && p.title && p.title.length > 15) out.push(...await copiesByTitle(p.title).catch(() => []))
  if ((p.doi || p.arxivId || p.s2Id) && !cooledDown('semantic_scholar')) {
    try {
      const id = p.s2Id ?? (p.doi ? `DOI:${p.doi}` : `ARXIV:${p.arxivId}`)
      const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=openAccessPdf`, { signal: T(10_000), headers: s2Headers() })
      if (r.ok) {
        const j = (await r.json()) as any
        if (j.openAccessPdf?.url) out.push(j.openAccessPdf.url)
      }
    } catch {
      // ignore
    }
  }
  const landing = p.url ?? (p.doi ? `https://doi.org/${p.doi}` : undefined)
  if (landing && !/arxiv\.org\/(abs|pdf)/.test(landing)) {
    const found = await landingPagePdf(landing)
    if (found) out.push(found)
  }
  return [...new Set(out.filter(u => /^https?:/.test(u)))]
}

export { BROWSER_UA }
