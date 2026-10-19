import { parseHTML } from 'linkedom'
import type { SearchProviderId, SearchSettings } from '../../shared/types.ts'
import { getSettings } from '../settings.ts'
import { BROWSER_UA } from './fetch.ts'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  published?: string
}

type Provider = (q: string, n: number, s: SearchSettings, signal?: AbortSignal) => Promise<SearchResult[]>

const timeout = (signal?: AbortSignal): AbortSignal => signal ?? AbortSignal.timeout(25_000)

const providers: Record<SearchProviderId, { available: (s: SearchSettings) => boolean; run: Provider }> = {
  searxng: {
    available: s => Boolean(s.searxngUrl),
    run: async (q, n, s, signal) => {
      const url = `${s.searxngUrl!.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json`
      const r = await fetch(url, { signal: timeout(signal), headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.results ?? []).slice(0, n).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? '', published: x.publishedDate }))
    },
  },
  tavily: {
    available: s => Boolean(s.tavilyKey),
    run: async (q, n, s, signal) => {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        signal: timeout(signal),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.tavilyKey}` },
        body: JSON.stringify({ query: q, max_results: n, search_depth: 'advanced' }),
      })
      if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: x.content ?? '', published: x.published_date }))
    },
  },
  brave: {
    available: s => Boolean(s.braveKey),
    run: async (q, n, s, signal) => {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(n, 20)}`, {
        signal: timeout(signal),
        headers: { accept: 'application/json', 'X-Subscription-Token': s.braveKey! },
      })
      if (!r.ok) throw new Error(`Brave HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.web?.results ?? []).map((x: any) => ({ title: x.title, url: x.url, snippet: stripTags(x.description ?? ''), published: x.age }))
    },
  },
  exa: {
    available: s => Boolean(s.exaKey),
    run: async (q, n, s, signal) => {
      const r = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        signal: timeout(signal),
        headers: { 'content-type': 'application/json', 'x-api-key': s.exaKey! },
        body: JSON.stringify({ query: q, numResults: n, contents: { text: { maxCharacters: 600 } } }),
      })
      if (!r.ok) throw new Error(`Exa HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.results ?? []).map((x: any) => ({ title: x.title ?? x.url, url: x.url, snippet: x.text ?? '', published: x.publishedDate }))
    },
  },
  serper: {
    available: s => Boolean(s.serperKey),
    run: async (q, n, s, signal) => {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        signal: timeout(signal),
        headers: { 'content-type': 'application/json', 'X-API-KEY': s.serperKey! },
        body: JSON.stringify({ q, num: n }),
      })
      if (!r.ok) throw new Error(`Serper HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.organic ?? []).map((x: any) => ({ title: x.title, url: x.link, snippet: x.snippet ?? '', published: x.date }))
    },
  },
  jina: {
    available: s => Boolean(s.jinaKey),
    run: async (q, n, s, signal) => {
      const r = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(q)}`, {
        signal: timeout(signal),
        headers: { accept: 'application/json', authorization: `Bearer ${s.jinaKey}`, 'X-Respond-With': 'no-content' },
      })
      if (!r.ok) throw new Error(`Jina HTTP ${r.status}`)
      const j = (await r.json()) as any
      return (j.data ?? []).slice(0, n).map((x: any) => ({ title: x.title, url: x.url, snippet: x.description ?? '' }))
    },
  },
  bing: {
    available: () => true,
    run: async (q, n, _s, signal) => {
      const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&mkt=en-US&cc=US&count=${Math.min(n + 2, 20)}`, {
        signal: timeout(signal),
        headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' },
      })
      if (!r.ok) throw new Error(`Bing HTTP ${r.status}`)
      const { document } = parseHTML(await r.text())
      const out: SearchResult[] = []
      for (const li of document.querySelectorAll('li.b_algo')) {
        const a = li.querySelector('h2 a')
        const href = decodeBingUrl(a?.getAttribute('href') ?? '')
        if (!a || !/^https?:/.test(href)) continue
        out.push({ title: a.textContent?.trim() ?? href, url: href, snippet: li.querySelector('.b_caption p, p')?.textContent?.trim() ?? '' })
        if (out.length >= n) break
      }
      if (!out.length && /captcha|challenge/i.test(document.title ?? '')) throw new Error('Bing a demandé un captcha')
      return out
    },
  },
  duckduckgo: {
    available: () => true,
    run: async (q, n, _s, signal) => {
      const r = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        signal: timeout(signal),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BROWSER_UA, accept: 'text/html' },
        body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
      })
      if (!r.ok) throw new Error(`DuckDuckGo HTTP ${r.status}`)
      const html = await r.text()
      const { document } = parseHTML(html)
      const out: SearchResult[] = []
      for (const el of document.querySelectorAll('.result')) {
        const a = el.querySelector('a.result__a')
        if (!a) continue
        let href = a.getAttribute('href') ?? ''
        const uddg = href.match(/[?&]uddg=([^&]+)/)
        if (uddg) href = decodeURIComponent(uddg[1])
        if (href.startsWith('//')) href = `https:${href}`
        if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue
        out.push({ title: a.textContent?.trim() ?? href, url: href, snippet: el.querySelector('.result__snippet')?.textContent?.trim() ?? '' })
        if (out.length >= n) break
      }
      if (out.length === 0 && /anomaly|captcha/i.test(html)) throw new Error('DuckDuckGo a bloqué la requête (anti-bot). Configure SearXNG, Tavily, Brave, Exa ou Serper.')
      return out
    },
  },
}

/** Bing wraps results as /ck/a?…&u=a1<base64url(target)> */
function decodeBingUrl(href: string): string {
  const u = href.match(/[?&]u=a1([^&]+)/)?.[1]
  if (!u) return href
  try {
    return Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {
    return href
  }
}

/** Providers that just failed for infrastructure reasons are skipped for a while. */
const cooldown = new Map<SearchProviderId, number>()

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

export function availableSearchProviders(): SearchProviderId[] {
  const s = getSettings().search
  return s.order.filter(id => providers[id]?.available(s))
}

/** Try configured providers in order; first non-empty answer wins. */
export async function webSearch(query: string, n = 8, signal?: AbortSignal): Promise<{ provider: string; results: SearchResult[]; errors: string[] }> {
  const s = getSettings().search
  const errors: string[] = []
  // keyless fallbacks always come last, even if the saved order predates them
  const order = [...s.order, ...(['bing', 'duckduckgo'] as SearchProviderId[]).filter(x => !s.order.includes(x))]
  for (const id of order) {
    const p = providers[id]
    if (!p?.available(s)) continue
    if ((cooldown.get(id) ?? 0) > Date.now()) {
      errors.push(`${id}: ignoré (en panne récemment)`)
      continue
    }
    try {
      const results = await p.run(query, n, s, signal)
      if (results.length > 0) return { provider: id, results: dedupe(results), errors }
      errors.push(`${id}: aucun résultat`)
    } catch (error) {
      const msg = (error as Error).message
      errors.push(`${id}: ${msg}`)
      // blocked / unreachable / rate-limited: stop hammering it for 10 min
      if (!signal?.aborted) cooldown.set(id, Date.now() + 10 * 60_000)
    }
  }
  return { provider: 'none', results: [], errors }
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return results.filter(r => {
    const k = r.url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
