import { getSettings } from '../../settings.ts'
import { webSearch } from '../../services/search.ts'
import { DEFAULT_READERS, fetchDocument } from '../../services/fetch.ts'
import type { FetchOptions } from '../../services/fetch.ts'
import {
  coolDown, cooledDown, crossrefByDoi, lookupPaper, mergePapers, openAlexByDoi, openAlexGraph, openCitationsGraph, pdfCandidates, s2Graph, searchArxiv, searchPapers,
} from '../../services/academic.ts'
import type { AcademicBackend, Paper } from '../../services/academic.ts'
import { fetchBytes } from '../../services/fetch.ts'
import { isPdf } from '../../services/pdf.ts'
import {
  attachPdf, getSource, listSources, readSourceText, resolveSource, searchChunks, setSourceStatus, sourceToText, storeFullText, upsertSource, updateSourceNotes,
} from '../../store/sources.ts'
import type { Source } from '../../../shared/types.ts'
import { errorMessage } from '../../core/util.ts'
import { argBool, argList, argNum, argStr, S } from '../types.ts'
import type { ToolContext, ToolDef } from '../types.ts'

function paperLine(p: Paper, i: number): string {
  const ids = [p.doi ? `doi:${p.doi}` : '', p.arxivId ? `arXiv:${p.arxivId}` : ''].filter(Boolean).join(' ')
  const abs = p.abstract ? `\n   ${p.abstract.replace(/\s+/g, ' ').slice(0, 420)}${p.abstract.length > 420 ? '…' : ''}` : ''
  return `${i + 1}. ${p.title} (${p.year ?? 's.d.'}) — ${p.authors.slice(0, 4).join(', ')}${p.authors.length > 4 ? ' et al.' : ''}\n   ${[p.venue, ids, p.citations !== undefined ? `${p.citations} cit.` : '', p.pdfUrl ? 'PDF libre' : ''].filter(Boolean).join(' · ')}${abs}`
}

function toSourceInput(p: Paper): Parameters<typeof upsertSource>[1] {
  return {
    kind: 'paper', title: p.title, authors: p.authors, year: p.year, venue: p.venue, doi: p.doi, arxivId: p.arxivId,
    url: p.url, pdfUrl: p.pdfUrl, abstract: p.abstract, citations: p.citations,
  }
}

// ───────── fetch_url helpers: short cache (pagination re-reads the same page), anchors, search ─────────

const docCache = new Map<string, { at: number; doc: Awaited<ReturnType<typeof fetchDocument>> }>()

async function cachedFetch(url: string, signal: AbortSignal, via: FetchOptions['via'] = 'auto'): Promise<Awaited<ReturnType<typeof fetchDocument>>> {
  const key = `${via}|${url}`
  const hit = docCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.doc
  const { jinaKey, readers } = getSettings().search
  const doc = await fetchDocument(url, { signal, jinaKey, readers: readers ?? DEFAULT_READERS, via })
  docCache.set(key, { at: Date.now(), doc })
  if (docCache.size > 30) docCache.delete(docCache.keys().next().value!)
  return doc
}

/**
 * Find where an URL fragment points in converted text. Handles numbered
 * sections (#section-17.3 → a line starting with "17.3."), page anchors
 * (#page=12) and slug anchors (#short-header-packets → matching heading).
 */
export function locateFragment(text: string, fragment: string): number {
  const page = fragment.match(/^page=(\d+)/)?.[1]
  if (page) {
    const i = text.indexOf(`[page ${page}]`)
    if (i >= 0) return Math.max(0, text.lastIndexOf('\n', i))
  }
  const num = fragment.match(/(\d+(?:\.\d+)*)/)?.[1]
  if (num && /^(section|sec|s|appendix)?-?\d/i.test(fragment)) {
    // "17.3.  Title", "### 17.3 Title", "[17.3.](#section-17.3) Title"
    const re = new RegExp(`(^|\\n)[#*\\s\\[]*${num.replace(/\./g, '\\.')}\\.?\\]?(\\([^)]*\\))?\\s+\\S`, 'g')
    const hits = [...text.matchAll(re)].map(m => (m.index ?? 0) + (m[1] ? 1 : 0))
    // A table of contents is a run of numbered headings; the real section is followed by prose.
    const tocLike = (i: number): boolean => {
      const next = text.slice(i, i + 600).split('\n').slice(1, 8).filter(l => l.trim())
      const headings = next.filter(l => /^[#*\s[]*\d+(\.\d+)*\.?\]?/.test(l)).length
      return headings >= 3 || /(\.\s?){4,}\s*\d+\s*$/.test(text.slice(i, i + 200).split('\n')[0])
    }
    const body = hits.filter(i => !tocLike(i))
    if (body.length) return body[0]
    if (hits.length) return hits[hits.length - 1]
  }
  const words = fragment.toLowerCase().split(/[-_\s]+/).filter(w => w.length > 2)
  if (words.length) {
    const lines = text.split('\n')
    let pos = 0
    for (const line of lines) {
      const l = line.toLowerCase()
      if (/^\s*(#|\d+(\.\d+)*\.?\s)/.test(line) && words.every(w => l.includes(w))) return pos
      pos += line.length + 1
    }
  }
  return -1
}

/** Passages of `text` around each match of `pattern`, with their offsets. */
export function searchInText(text: string, pattern: string, budget: number): string {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'gi')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  }
  const matches = [...text.matchAll(re)].map(m => m.index ?? 0)
  if (!matches.length) return `Aucune occurrence de « ${pattern} ».`
  const window = Math.max(600, Math.min(3000, Math.floor(budget / Math.min(matches.length, 8))))
  const parts: string[] = []
  let lastEnd = -1
  for (const at of matches) {
    if (parts.length >= 8) break
    const start = Math.max(0, at - Math.floor(window / 3))
    if (start < lastEnd) continue
    const end = Math.min(text.length, start + window)
    parts.push(`── offset ${start} ──\n${text.slice(start, end)}`)
    lastEnd = end
  }
  return `${matches.length} occurrence(s) de « ${pattern} »${matches.length > parts.length ? ` (${parts.length} passages affichés)` : ''}. Pour lire la suite d'un passage : fetch_url(url, offset=…).\n\n${parts.join('\n\n')}`
}

/** Try every open-access route to get the PDF of a source. */
export async function acquirePdf(ctx: Pick<ToolContext, 'project' | 'signal'>, source: Source): Promise<{ ok: boolean; message: string; source: Source }> {
  const candidates = await pdfCandidates({ doi: source.doi, arxivId: source.arxivId, pdfUrl: source.pdfUrl, url: source.url, title: source.title })
  const tried: string[] = []
  for (const url of candidates) {
    if (ctx.signal.aborted) break
    try {
      const { buffer, contentType } = await fetchBytes(url, { accept: 'application/pdf,*/*;q=0.5', signal: ctx.signal })
      if (!isPdf(buffer)) {
        tried.push(`${url} → pas un PDF (${contentType || 'type inconnu'})`)
        continue
      }
      const updated = await attachPdf(ctx.project.id, source.id, buffer)
      return { ok: true, message: `PDF récupéré depuis ${url} — ${updated.pages ?? '?'} pages, ${updated.chars ?? 0} caractères indexés.`, source: updated }
    } catch (error) {
      tried.push(`${url} → ${errorMessage(error)}`)
    }
  }
  const s = setSourceStatus(ctx.project.id, source.id, 'failed', `Aucun PDF libre trouvé. Essais: ${tried.join(' ; ') || 'aucun candidat'}`)
  return {
    ok: false,
    message: `Impossible d'obtenir le PDF en accès libre (arXiv, Unpaywall, OpenAlex, CORE, page éditeur essayés).${tried.length ? `\nEssais:\n- ${tried.slice(0, 6).join('\n- ')}` : ' Aucun lien libre connu.'}\n`
      + `→ Ne réessaie pas paper_fetch_pdf sur cette source. Si le document est important : request_pdf(key="${source.citationKey}", reason=…) — l'humain le fournira. Sinon travaille avec le résumé (source_read) et signale que le texte intégral n'a pas été lu.`,
    source: s,
  }
}

export const researchTools: ToolDef[] = [
  {
    name: 'web_search',
    category: 'web',
    description: 'Recherche web générale (moteurs configurés, puis Bing / DuckDuckGo sans clé). Pour la littérature scientifique, préfère paper_search ; pour un article précis, paper_lookup. Requêtes courtes (3-8 mots), sans multiplier les guillemets. Si la recherche échoue pour une raison technique, ne la répète pas : change d\'outil.',
    parameters: S.obj({ query: S.str('Requête'), n: S.int('Nombre de résultats (défaut 8)') }, ['query']),
    parallel: true,
    execute: async (args, ctx) => {
      const { provider, results, errors } = await webSearch(argStr(args, 'query'), Math.min(20, argNum(args, 'n', 8)), ctx.signal)
      if (!results.length) return { content: `Aucun résultat.${errors.length ? `\nErreurs: ${errors.join(' | ')}` : ''}`, status: 'error' }
      return `[moteur: ${provider}]\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.published ? ` (${r.published})` : ''}\n   ${r.snippet.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`
    },
  },
  {
    name: 'fetch_url',
    category: 'web',
    description: 'Télécharge une page web ou un PDF et renvoie son contenu lisible (markdown / texte). Long contenu paginé avec offset. Une ancre (#section-17.3) positionne la lecture sur la section correspondante. search="motif" renvoie seulement les passages qui contiennent le motif (avec leur offset) — idéal pour trouver une section dans un long document (RFC, spec). save_as_source=true l\'ajoute à la bibliothèque (texte indexé, citable).',
    parameters: S.obj({
      url: S.str('URL http(s), éventuellement avec #ancre'),
      offset: S.int('Position de départ en caractères (pagination)'),
      max_chars: S.int('Taille max renvoyée (défaut 15000)'),
      search: S.str('Ne renvoyer que les passages contenant ce texte ou cette expression régulière'),
      via: S.enum(['auto', 'local', 'jina', 'defuddle', 'puremd', 'markdown_new'], 'auto (défaut) : conversion locale, puis lecteurs externes si la page est bloquée, vide ou rendue en JavaScript. Forcer un lecteur (ex. jina) pour une page dynamique mal convertie.'),
      save_as_source: S.bool('Ajouter à la bibliothèque de sources'),
    }, ['url']),
    parallel: true,
    execute: async (args, ctx) => {
      const url = argStr(args, 'url')
      const via = (typeof args.via === 'string' ? args.via : 'auto') as FetchOptions['via']
      const doc = await cachedFetch(url.replace(/#.*$/, ''), ctx.signal, via)
      if (doc.blocked) {
        return {
          status: 'error',
          content: `Contenu inaccessible : ${doc.blocked} (titre « ${doc.title.slice(0, 80)} »). Rien n'a été enregistré.\n`
            + '→ Ne réessaie pas cette URL ni ses variantes du même site. Pour un article : paper_lookup(titre) puis paper_fetch_pdf (trouve les préprints arXiv / copies institutionnelles), sinon request_pdf. Pour une page : cherche une autre source.',
        }
      }
      const max = Math.min(40_000, argNum(args, 'max_chars', 15_000))
      const fragment = url.includes('#') ? decodeURIComponent(url.split('#')[1]) : ''
      let offset = Math.max(0, argNum(args, 'offset', 0))
      let located = ''
      if (fragment && args.offset === undefined) {
        const at = locateFragment(doc.text, fragment)
        if (at >= 0) {
          offset = at
          located = ` · positionné sur « #${fragment} » (offset ${at})`
        } else {
          located = ` · ancre « #${fragment} » introuvable dans le texte, lecture depuis le début (essaie search=)`
        }
      }
      if (typeof args.search === 'string' && args.search.trim()) {
        return `# ${doc.title}\nURL: ${doc.finalUrl} · ${doc.text.length} caractères\n\n${searchInText(doc.text, args.search, max)}`
      }
      let saved = ''
      if (argBool(args, 'save_as_source', false)) {
        const arxivId = doc.finalUrl.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?$/)?.[1]
        const s = upsertSource(ctx.project.id, { kind: doc.pdf ? 'pdf' : 'web', title: doc.title || url, url: doc.finalUrl, arxivId })
        if (doc.pdf) await attachPdf(ctx.project.id, s.id, doc.pdf.buffer)
        else storeFullText(ctx.project.id, s.id, [doc.text], 'md')
        saved = `\n[Enregistré dans la bibliothèque: ${s.citationKey}]`
      }
      const slice = doc.text.slice(offset, offset + max)
      const more = offset + max < doc.text.length ? `\n\n[… ${doc.text.length - offset - max} caractères restants — rappelle fetch_url avec offset=${offset + max}]` : ''
      const through = doc.via && doc.via !== 'local' ? ` · lu via ${doc.via}` : ''
      return `# ${doc.title}\nURL: ${doc.finalUrl} · ${doc.contentType} · ${doc.text.length} caractères${through}${located}${saved}\n\n${slice}${more}`
    },
  },
  {
    name: 'paper_search',
    category: 'literature',
    description: 'Recherche THÉMATIQUE d\'articles (OpenAlex, Semantic Scholar, arXiv, Crossref, CORE ; les bases en panne sont sautées automatiquement). Requête courte de 3 à 7 mots-clés techniques en anglais, sans guillemets multiples, sans noms d\'auteurs ni années (sinon 0 résultat). Pour retrouver UN article précis dont tu connais le titre, utilise paper_lookup. add = numéros des résultats à ajouter à la bibliothèque (ex. [1,3]).',
    parameters: S.obj({
      query: S.str('3 à 7 mots-clés (anglais). Pour arXiv seul, syntaxe ti:/au:/abs:/cat: possible.'),
      backends: S.arr({ type: 'string', enum: ['arxiv', 'semantic_scholar', 'openalex', 'crossref', 'europepmc', 'core'] }, 'Bases à interroger (défaut : toutes celles disponibles)'),
      n: S.int('Résultats par base (défaut 8)'),
      year_from: S.int('Année minimale'),
      add: S.arr({ type: 'integer' }, 'Numéros (1, 2…) des résultats pertinents à ajouter à la bibliothèque'),
    }, ['query']),
    parallel: true,
    execute: async (args, ctx) => {
      const { papers, errors, relaxed } = await searchPapers(argStr(args, 'query'), {
        n: Math.min(25, argNum(args, 'n', 8)),
        backends: argList(args, 'backends') as AcademicBackend[],
        yearFrom: typeof args.year_from === 'number' ? args.year_from : undefined,
      })
      const sorted = papers.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0))
      let added = ''
      // `add: true` used to dump every hit (dozens of off-topic papers) into the library: only explicit picks now
      const picks = Array.isArray(args.add) ? args.add.map(Number).filter(i => i >= 1 && i <= sorted.length) : args.add === true ? [1, 2, 3].filter(i => i <= sorted.length) : []
      if (picks.length) {
        const keys = picks.map(i => upsertSource(ctx.project.id, toSourceInput(sorted[i - 1])).citationKey)
        added = `\n[Ajoutés à la bibliothèque: ${keys.join(', ')}]`
      }
      const note = relaxed ? `(0 résultat pour la requête exacte — résultats pour la version simplifiée « ${relaxed} ». Utilise des requêtes courtes.)\n` : ''
      if (!sorted.length) return { content: `Aucun article trouvé.${errors.length ? ` Erreurs: ${errors.join(' | ')}` : ''}\n→ Raccourcis la requête (3-5 mots-clés) ou, pour un article précis, utilise paper_lookup(title=…).`, status: 'error' }
      return `${note}${sorted.map(paperLine).join('\n')}${errors.length ? `\n(avertissements: ${errors.join(' | ')})` : ''}${added}`
    },
  },
  {
    name: 'paper_lookup',
    category: 'literature',
    description: 'Retrouve UN article précis à partir de son titre (même approximatif), avec auteurs/année en option — bien plus fiable que paper_search pour un article connu (Crossref, arXiv, OpenAlex). Renvoie les meilleures correspondances avec un score ; add=true ajoute la meilleure à la bibliothèque et tente de récupérer son PDF.',
    parameters: S.obj({
      title: S.str('Titre de l\'article (ou l\'essentiel du titre)'),
      authors: S.str('Nom(s) d\'auteur(s), optionnel'),
      year: S.int('Année, optionnel'),
      add: S.bool('Ajouter la meilleure correspondance à la bibliothèque (+ PDF libre si possible)'),
    }, ['title']),
    parallel: true,
    execute: async (args, ctx) => {
      const { matches, errors } = await lookupPaper(argStr(args, 'title'), {
        authors: typeof args.authors === 'string' ? args.authors : undefined,
        year: typeof args.year === 'number' ? args.year : undefined,
      })
      if (!matches.length) return { status: 'error', content: `Aucune correspondance fiable.${errors.length ? ` (${errors.join(' | ')})` : ''} Vérifie le titre ; l'article n'est peut-être pas indexé (rapport technique, thèse) → essaie web_search avec le titre exact.` }
      let added = ''
      if (argBool(args, 'add', false)) {
        const best = upsertSource(ctx.project.id, toSourceInput(matches[0]))
        added = `\n[Ajouté : ${best.citationKey}]`
        if (best.status !== 'full_text') added += `\n${(await acquirePdf(ctx, best)).message}`
      }
      return `${matches.map((m, i) => `${paperLine(m, i)}\n   correspondance ${Math.round(m.score * 100)} %`).join('\n')}${added}`
    },
  },
  {
    name: 'paper_add',
    category: 'literature',
    description: 'Ajoute un article à la bibliothèque à partir d\'un DOI ou d\'un identifiant arXiv (métadonnées complètes récupérées automatiquement). fetch_pdf=true tente aussi de récupérer et indexer le PDF en accès libre.',
    parameters: S.obj({ doi: S.str('DOI'), arxiv_id: S.str('Identifiant arXiv'), fetch_pdf: S.bool('Récupérer le PDF (défaut true)') }),
    execute: async (args, ctx) => {
      let paper: Paper | undefined
      const doi = typeof args.doi === 'string' ? args.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim() : undefined
      const arxivId = typeof args.arxiv_id === 'string' ? args.arxiv_id.replace(/^arxiv:/i, '').trim() : undefined
      if (arxivId) paper = (await searchArxiv('', 1, { idList: [arxivId] }))[0]
      if (!paper && doi) {
        const [oa, cr] = await Promise.all([openAlexByDoi(doi).catch(() => undefined), crossrefByDoi(doi).catch(() => undefined)])
        paper = mergePapers([oa, cr].filter(Boolean) as Paper[])[0]
      }
      if (!paper) throw new Error('Article introuvable (vérifie le DOI / identifiant arXiv).')
      const source = upsertSource(ctx.project.id, toSourceInput(paper))
      let pdfMsg = ''
      if (argBool(args, 'fetch_pdf', true) && source.status !== 'full_text') pdfMsg = `\n${(await acquirePdf(ctx, source)).message}`
      return `Ajouté: ${sourceToText(getSource(ctx.project.id, source.id)!)}${pdfMsg}`
    },
  },
  {
    name: 'paper_citations',
    category: 'literature',
    description: 'Exploration du graphe de citations (« snowballing ») : articles qui citent (citations = travaux plus récents) ou sont cités par (references = fondations) un article donné. Méthode la plus efficace pour une revue de littérature : part de 1-3 articles clés et explore dans les deux sens. Sources : Semantic Scholar, OpenAlex, OpenCitations (sans clé, via DOI).',
    parameters: S.obj({
      ref: S.str('Clé de citation de la bibliothèque, DOI ou identifiant arXiv'),
      direction: S.enum(['citations', 'references'], 'citations = qui le cite; references = ce qu\'il cite'),
      n: S.int('Nombre max (défaut 15)'),
    }, ['ref', 'direction']),
    parallel: true,
    execute: async (args, ctx) => {
      const ref = argStr(args, 'ref')
      const lib = resolveSource(ctx.project.id, ref)
      const doi = lib?.doi ?? (/^10\./.test(ref) ? ref : undefined)
      const arxivId = lib?.arxivId ?? (/^\d{4}\.\d{4,5}/.test(ref) ? ref : undefined)
      const direction = argStr(args, 'direction') === 'references' ? 'references' : 'citations'
      const n = Math.min(50, argNum(args, 'n', 15))
      let papers: Paper[] = []
      const errors: string[] = []
      if (!doi && !arxivId) return { status: 'error', content: 'Il faut une source avec DOI ou identifiant arXiv (utilise paper_lookup pour obtenir le DOI).' }
      const attempts: Array<[string, () => Promise<Paper[]>]> = [
        ['semantic_scholar', () => s2Graph({ doi, arxivId }, direction, n)],
        ...(doi ? [['openalex', () => openAlexGraph({ doi }, direction, n)] as [string, () => Promise<Paper[]>]] : []),
        ...(doi ? [['opencitations', () => openCitationsGraph(doi, direction, n)] as [string, () => Promise<Paper[]>]] : []),
      ]
      for (const [name, run] of attempts) {
        if (papers.length) break
        const down = cooledDown(name)
        if (down) {
          errors.push(`${name}: ignoré (${down})`)
          continue
        }
        try {
          papers = await run()
        } catch (error) {
          errors.push(`${name}: ${errorMessage(error)}`)
          coolDown(name, errorMessage(error))
        }
      }
      if (!papers.length) return { content: `Rien trouvé. ${errors.join(' | ')}`, status: 'error' }
      return papers.sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0)).map(paperLine).join('\n')
    },
  },
  {
    name: 'paper_fetch_pdf',
    category: 'literature',
    description: 'Tente de récupérer le PDF en accès libre d\'une source de la bibliothèque (arXiv, Unpaywall, OpenAlex, Semantic Scholar, page éditeur) puis l\'indexe. En cas d\'échec, utilise request_pdf.',
    parameters: S.obj({ key: S.str('Clé de citation ou id de source') }, ['key']),
    execute: async (args, ctx) => {
      const s = resolveSource(ctx.project.id, argStr(args, 'key'))
      if (!s) throw new Error('Source introuvable')
      if (s.status === 'full_text') return `Le texte intégral de ${s.citationKey} est déjà disponible (source_read).`
      const r = await acquirePdf(ctx, s)
      return { content: r.message, status: r.ok ? 'ok' : 'error' }
    },
  },
  {
    name: 'request_pdf',
    category: 'literature',
    description: 'Demande à l\'humain de fournir un document que tu n\'arrives pas à obtenir (paywall, accès institutionnel). Une notification est envoyée; l\'humain téléversera le PDF. Non bloquant par défaut: continue sur d\'autres pistes, tu seras prévenu à réception.',
    parameters: S.obj({
      key: S.str('Clé de la source dans la bibliothèque (si déjà ajoutée)'),
      title: S.str('Titre du document (si pas dans la bibliothèque)'),
      doi: S.str('DOI (optionnel)'),
      url: S.str('URL connue (optionnel)'),
      reason: S.str('Pourquoi ce document est important pour la recherche'),
      blocking: S.bool('Attendre la réponse avant de continuer (défaut false)'),
    }, ['reason']),
    timeoutMs: 0,
    execute: async (args, ctx) => {
      let source = typeof args.key === 'string' ? resolveSource(ctx.project.id, args.key) : undefined
      if (!source) {
        const title = argStr(args, 'title', '')
        if (!title && !args.doi) throw new Error('Fournis key, ou title/doi')
        source = upsertSource(ctx.project.id, { kind: 'paper', title: title || String(args.doi), doi: typeof args.doi === 'string' ? args.doi : undefined, url: typeof args.url === 'string' ? args.url : undefined })
      }
      setSourceStatus(ctx.project.id, source.id, 'requested')
      const blocking = argBool(args, 'blocking', false)
      const req = await ctx.runtime.askHuman({
        kind: 'pdf',
        title: `PDF demandé : ${source.title}`,
        body: `${argStr(args, 'reason')}\n\n${sourceToText(source)}${source.doi ? `\nhttps://doi.org/${source.doi}` : ''}`,
        blocking,
        sourceId: source.id,
        agent: ctx.agent,
        signal: ctx.signal,
      })
      if (blocking) return req.status === 'resolved' ? `L'humain a répondu: ${req.response ?? ''}. ${getSource(ctx.project.id, source.id)?.status === 'full_text' ? 'Le PDF est disponible (source_read).' : ''}` : 'Demande ignorée par l\'humain.'
      return `Demande envoyée (${req.id}). Continue tes autres pistes; tu recevras un message quand le PDF sera disponible.`
    },
  },
  {
    name: 'source_list',
    category: 'literature',
    description: 'Liste compacte des sources de la bibliothèque (une ligne chacune), filtrable par statut, par origine ou par texte. Statuts : full_text (lisible), metadata (résumé seul), requested (demandé à l\'humain), failed (inaccessible). 📎 = document fourni par l\'humain (original dans inputs/).',
    parameters: S.obj({
      status: S.enum(['full_text', 'metadata', 'requested', 'failed'], 'Filtrer par statut'),
      origin: S.enum(['human'], 'human = seulement les documents fournis par l\'humain'),
      query: S.str('Filtrer par texte (titre, auteur, clé, nom de fichier)'),
    }),
    parallel: true,
    execute: async (args, ctx) => {
      const all = listSources(ctx.project.id)
      const q = typeof args.query === 'string' ? args.query.toLowerCase() : ''
      const list = all
        .filter(s => !args.status || s.status === args.status)
        .filter(s => args.origin !== 'human' || s.origin === 'human')
        .filter(s => !q || `${s.title} ${s.authors.join(' ')} ${s.citationKey} ${s.file ?? ''}`.toLowerCase().includes(q))
      if (!list.length) return all.length ? 'Aucune source ne correspond au filtre.' : 'Bibliothèque vide.'
      const counts = ['full_text', 'metadata', 'requested', 'failed'].map(st => `${st}: ${all.filter(s => s.status === st).length}`).join(', ')
      const lines = list.slice(0, 80).map(s => `[${s.citationKey}] ${s.origin === 'human' ? '📎' : ''}${s.status === 'full_text' ? '📄' : s.status === 'requested' ? '⏳' : s.status === 'failed' ? '✗' : '·'} ${s.title.slice(0, 110)} (${s.origin === 'human' ? s.file ?? 'fourni' : s.year ?? 's.d.'}${s.authors[0] ? `, ${s.authors[0].split(' ').pop()}` : ''}${s.pages ? `, ${s.pages} p.` : ''})`)
      return `${all.length} sources (${counts})${list.length > 80 ? ` — 80 premières affichées, filtre pour affiner` : ''}\n${lines.join('\n')}`
    },
  },
  {
    name: 'source_read',
    category: 'literature',
    description: 'Lit le texte intégral d\'une source. Trois façons de viser juste au lieu de paginer à l\'aveugle : section="17.3" (va directement à la section numérotée), pattern="Short Header" (passages contenant ce texte, avec leur offset), ou page_from/page_to pour un PDF. Sinon lecture par offset. La référence peut être la clé, « RFC 9000 », un DOI ou un identifiant arXiv.',
    parameters: S.obj({
      key: S.str('Clé de citation, « RFC 9000 », DOI, arXiv id ou id'),
      section: S.str('Numéro de section à atteindre (ex. 17.3, 4.2.1)'),
      pattern: S.str('Texte ou expression régulière à localiser dans le document'),
      page_from: S.int('Première page (PDF)'),
      page_to: S.int('Dernière page (PDF)'),
      offset: S.int('Offset en caractères'),
      max_chars: S.int('Max caractères (défaut 12000)'),
    }, ['key']),
    parallel: true,
    execute: async (args, ctx) => {
      const { source, text } = readSourceText(ctx.project.id, argStr(args, 'key'))
      const max = Math.min(40_000, argNum(args, 'max_chars', 12_000))
      if (!text) {
        return { content: `${sourceToText(source)}\n\nPas de texte intégral.${source.abstract ? `\nRésumé: ${source.abstract}` : ''}\n→ paper_fetch_pdf (une fois), sinon request_pdf.`, status: 'error' }
      }
      if (typeof args.pattern === 'string' && args.pattern.trim()) {
        return `${source.citationKey} — recherche dans ${text.length} caractères\n\n${searchInText(text, args.pattern, max)}`
      }
      let offset = Math.max(0, argNum(args, 'offset', 0))
      let located = ''
      if (typeof args.section === 'string' && args.section.trim()) {
        const at = locateFragment(text, `section-${args.section.trim().replace(/^§\s*/, '')}`)
        if (at < 0) return { status: 'error', content: `Section ${args.section} introuvable dans ${source.citationKey}. Essaie pattern="${args.section}" ou un mot du titre de la section.` }
        offset = at
        located = ` · section ${args.section}`
      } else if (typeof args.page_from === 'number' && source.pages) {
        const from = Math.max(1, args.page_from)
        const to = Math.min(source.pages, typeof args.page_to === 'number' ? args.page_to : from + 4)
        const parts = text.split(/\n*=== \[page (\d+)\] ===\n*/)
        const pages: string[] = []
        for (let i = 1; i < parts.length; i += 2) {
          const n = Number(parts[i])
          if (n >= from && n <= to) pages.push(`=== [page ${n}] ===\n${parts[i + 1]}`)
        }
        const joined = pages.join('\n\n')
        return `${source.citationKey} — pages ${from}-${to}/${source.pages}\n\n${joined.slice(0, max)}${joined.length > max ? '\n[… tronqué, réduis la plage de pages]' : ''}`
      }
      const slice = text.slice(offset, offset + max)
      return `${source.citationKey} — caractères ${offset}-${offset + slice.length}/${text.length}${source.pages ? ` (${source.pages} pages)` : ''}${located}\n\n${slice}${offset + max < text.length ? `\n\n[… suite: offset=${offset + max}]` : ''}`
    },
  },
  {
    name: 'source_search',
    category: 'literature',
    description: 'Recherche DANS les documents de la bibliothèque. Par défaut, recherche par pertinence (BM25) : passages avec numéro de page, pour citer précisément. exact=true cherche une expression exacte (chiffre, nom de champ, phrase) — à utiliser pour vérifier qu\'une source dit bien quelque chose.',
    parameters: S.obj({
      query: S.str('Requête (mots-clés) ou expression exacte'),
      key: S.str('Limiter à une source (clé, « RFC 9000 », DOI…)'),
      exact: S.bool('Recherche d\'expression exacte (insensible à la casse)'),
      n: S.int('Nombre de passages (défaut 6)'),
    }, ['query']),
    parallel: true,
    execute: async (args, ctx) => {
      const query = argStr(args, 'query')
      const src = typeof args.key === 'string' ? resolveSource(ctx.project.id, args.key) : undefined
      if (typeof args.key === 'string' && !src) return { status: 'error', content: `Source « ${args.key} » introuvable. source_list(query=…) pour retrouver sa clé.` }
      if (argBool(args, 'exact', false)) {
        const targets = src ? [src] : listSources(ctx.project.id).filter(s => s.status === 'full_text')
        const out: string[] = []
        for (const s of targets) {
          const { text } = readSourceText(ctx.project.id, s.id)
          if (!text || !text.toLowerCase().includes(query.toLowerCase())) continue
          out.push(`### [${s.citationKey}] ${s.title}\n${searchInText(text, query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 4000)}`)
          if (out.length >= 5) break
        }
        return out.length ? out.join('\n\n') : `« ${query} » n'apparaît dans aucune ${src ? `partie de ${src.citationKey}` : 'source en texte intégral'}.`
      }
      const hits = searchChunks(ctx.project.id, query, Math.min(20, argNum(args, 'n', 6)), src?.id)
      if (!hits.length) return 'Aucun passage trouvé.'
      return hits.map(h => `[${h.citationKey}${h.page ? `, p.${h.page}` : ''}] ${h.title}\n${h.text.replace(/\s+/g, ' ').slice(0, 900)}`).join('\n\n')
    },
  },
  {
    name: 'source_annotate',
    category: 'literature',
    description: 'Enregistre ta fiche de lecture sur une source (résumé, contributions, méthodes, limites, pertinence pour la question).',
    parameters: S.obj({ key: S.str('Clé de citation'), notes: S.str('Fiche de lecture markdown') }, ['key', 'notes']),
    execute: async (args, ctx) => {
      const s = resolveSource(ctx.project.id, argStr(args, 'key'))
      if (!s) throw new Error('Source introuvable')
      updateSourceNotes(ctx.project.id, s.id, argStr(args, 'notes'))
      return `Fiche de lecture enregistrée pour ${s.citationKey}.`
    },
  },
]
