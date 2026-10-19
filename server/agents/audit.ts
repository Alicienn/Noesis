import fs from 'node:fs'
import path from 'node:path'
import type { Note, Project, Source } from '../../shared/types.ts'
import { all } from '../db/database.ts'
import { extractJson } from '../core/util.ts'
import { chat } from '../llm/client.ts'
import type { ResolvedModel } from '../llm/providers.ts'
import { assuranceText, getNote, listNotes } from '../memory/notes.ts'
import { listSources, resolveSource } from '../store/sources.ts'
import { workspaceDir } from '../config.ts'
import { loadPrompt } from './prompts.ts'

/**
 * Final-report audit. Observed failure: the lead wrote the trust layer of its
 * report itself — "all key results independently verified, confidence 1.00",
 * a bibliography with papers never read or not in the library, a title made
 * up, numbers coming from refuted notes. This module checks the report against
 * the database (deterministic) and against the question (LLM critic), and
 * generates the appendices from the database instead of trusting the model.
 */

export type Severity = 'bloquant' | 'majeur' | 'mineur'

export interface AuditIssue {
  severity: Severity
  kind: string
  detail: string
  /**
   * 'base' = checked against the database (deterministic, can block the closing);
   * 'critique' = opinion of the LLM critic (non-deterministic: it changes from one
   * run to the next, so it never blocks — it is shown and written in the annex).
   */
  source?: 'base' | 'critique'
}

export interface AuditResult {
  file: string
  issues: AuditIssue[]
  critic?: {
    deliverables: Array<{ item: string; status: string; comment?: string }>
    scope?: string
    contradictions?: string[]
    overclaims?: string[]
    unsupported?: string[]
    verdict?: string
  }
  annex: string
  blocking: number
}

/** The report to audit: explicit path, else the most recent markdown file in reports/. */
export function findReport(projectId: string, file?: string): string | undefined {
  const dir = path.join(workspaceDir(projectId), 'reports')
  if (file) {
    const p = path.resolve(dir, file.replace(/^reports[\\/]/, ''))
    return fs.existsSync(p) ? p : undefined
  }
  if (!fs.existsSync(dir)) return undefined
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  files.sort((a, b) => b.t - a.t)
  return files[0] ? path.join(dir, files[0].f) : undefined
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 3))
}

function similarity(a: string, b: string): number {
  const wa = words(a)
  const wb = words(b)
  if (!wa.size || !wb.size) return 0
  let common = 0
  for (const w of wa) if (wb.has(w)) common++
  return common / Math.min(wa.size, wb.size)
}

const READ_STATUS: Record<string, string> = { full_text: 'lu (texte intégral)', metadata: 'NON LU (métadonnées seules)', requested: 'NON LU (demandé, non reçu)', failed: 'NON LU (inaccessible)' }

/** Deterministic checks of citations, note links and numbers against the database. */
export function checkReport(projectId: string, text: string): { issues: AuditIssue[]; cited: Source[]; notes: Note[] } {
  const issues: AuditIssue[] = []
  const cleaned = text.replace(/```[\s\S]*?```/g, '')

  // ── citation keys: [key] or [key, p.3] — but not markdown links [text](url) nor checkboxes
  const keys = new Map<string, number>()
  // (?<!\[) / (?!\]) : a [[note-link]] is not a citation
  for (const m of cleaned.matchAll(/(?<!\[)\[([A-Za-z][\w-]{3,60})(?:,\s*(?:p\.?|§|section)\s*[\w.-]+)?\](?![(\]])/g)) {
    if (/^(x|ok|note|todo)$/i.test(m[1])) continue
    keys.set(m[1], (keys.get(m[1]) ?? 0) + 1)
  }
  const cited: Source[] = []
  for (const key of keys.keys()) {
    const s = resolveSource(projectId, key)
    if (!s) {
      issues.push({ severity: 'bloquant', kind: 'citation absente', detail: `[${key}] n'existe pas dans la bibliothèque : référence inventée ou jamais consultée. Retire-la ou ajoute la source (paper_lookup) et lis-la.` })
      continue
    }
    cited.push(s)
    if (s.status !== 'full_text') {
      issues.push({ severity: 'majeur', kind: 'source non lue', detail: `[${key}] est citée mais son texte n'a jamais été lu (${READ_STATUS[s.status]}). Signale-le explicitement (« d'après le résumé ») ou retire les affirmations qui en dépendent.` })
    }
  }

  // ── reference list entries: "[key] Authors. "Title"…" → title must match the library
  for (const line of cleaned.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\[([\w-]+)\][^"“«]*["“«]([^"”»]{12,})["”»]/)
    if (!m) continue
    const s = resolveSource(projectId, m[1])
    if (s && similarity(m[2], s.title) < 0.5) {
      issues.push({ severity: 'bloquant', kind: 'titre erroné', detail: `[${m[1]}] est présenté sous le titre « ${m[2].slice(0, 90)} » alors que la source s'intitule « ${s.title.slice(0, 90)} ».` })
    }
  }

  // ── note links [[slug]]: existence, invalidation, verdict vs wording
  const notes: Note[] = []
  const miswritten: string[] = []
  const lines = cleaned.split('\n')
  for (const m of cleaned.matchAll(/\[\[([^\]\n]{2,120})\]\]/g)) {
    const slug = m[1].trim()
    if (notes.some(n => n.slug === slug)) continue
    const note = getNote(projectId, slug)
    if (!note) {
      const source = resolveSource(projectId, slug)
      if (source) {
        // a source key written as a note link: count it as a citation, ask for the right syntax
        if (!cited.some(s => s.id === source.id)) cited.push(source)
        miswritten.push(slug)
        continue
      }
      issues.push({ severity: 'majeur', kind: 'note introuvable', detail: `[[${slug}]] ne correspond à aucune note.` })
      continue
    }
    notes.push(note)
    const ctxLine = lines.find(l => l.includes(`[[${slug}]]`)) ?? ''
    const claimsVerified = /vérifi|confirm|verified/i.test(ctxLine)
    if (note.status !== 'active') {
      issues.push({ severity: 'bloquant', kind: 'note invalidée', detail: `Le rapport s'appuie sur [[${slug}]], qui a été invalidée${note.supersededBy ? ` (remplacée par [[${note.supersededBy}]])` : ''}.` })
    } else if (note.verification?.verdict === 'refuted') {
      issues.push({ severity: 'bloquant', kind: 'note réfutée', detail: `[[${slug}]] a été RÉFUTÉE par le vérificateur (${note.verification.summary.slice(0, 160)}) mais le rapport l'utilise.` })
    } else if (claimsVerified && (!note.verification || note.verification.verdict !== 'supported')) {
      issues.push({ severity: 'majeur', kind: 'vérification affirmée à tort', detail: `Le rapport présente [[${slug}]] comme vérifiée alors que son statut réel est : ${note.verification?.verdict ?? 'non vérifiée'}.` })
    } else if (claimsVerified && note.verification && note.verification.confidence < 0.6) {
      issues.push({ severity: 'mineur', kind: 'vérification faible', detail: `[[${slug}]] est « vérifiée » avec une confiance de ${Math.round(note.verification.confidence * 100)} % seulement.` })
    }
    // "formally proved / checked in Lean" is only true at the formal level, with a faithful statement.
    // Judged on the clause around the link: a line often cites several notes with different statuses.
    // links are removed: a slug like « …-en-lean-…-prouves » is a name, not a claim
    const clause = clauseAround(ctxLine, `[[${slug}]]`).replace(/\[\[[^\]]*\]\]/g, ' ')
    if (note.status === 'active' && /\bLean\b|lean_check|comparator|formellement|formalis|formally|machine-check/i.test(clause) && /prouv|démontr|proved|lean_check|comparator/i.test(clause)) {
      if (note.assurance?.level !== 'formal') {
        issues.push({ severity: 'majeur', kind: 'preuve formelle affirmée à tort', detail: `Le rapport présente [[${slug}]] comme prouvée en Lean, mais son niveau réel est « ${assuranceText(note)} ».` })
      } else if (note.assurance.lean?.statementReview?.verdict !== 'supported') {
        issues.push({ severity: 'mineur', kind: 'énoncé Lean non relu', detail: `[[${slug}]] est prouvée en Lean, mais la fidélité de son énoncé n'a pas été relue (verify_claim kind="formalization") : précise-le dans le rapport.` })
      }
    }
  }

  if (miswritten.length) {
    issues.push({ severity: 'mineur', kind: 'syntaxe de citation', detail: `${miswritten.length} clé(s) de source écrite(s) comme des liens de note (${miswritten.slice(0, 4).map(k => `[[${k}]]`).join(', ')}) : elles sont comptées comme citations, mais la syntaxe correcte est [${miswritten[0]}].` })
  }

  // ── blanket verification claims are never acceptable: the appendix states the real status
  if (/tous les résultats (clés )?(ont été )?vérifiés|all (key )?results (were )?(independently )?verified/i.test(cleaned)) {
    issues.push({ severity: 'majeur', kind: 'vérification globale affirmée', detail: 'Le rapport affirme que tous les résultats ont été vérifiés : remplace cette phrase par un renvoi à l\'annexe « État réel des vérifications » générée automatiquement.' })
  }

  // ── numbers coming from refuted / invalidated notes (and not from a valid one)
  const allNotes = listNotes(projectId, { includeInactive: true, limit: 5000 })
  // a note replaced by a newer version is not "wrong": only refuted ones and those invalidated without replacement
  const isBad = (n: Note): boolean => n.verification?.verdict === 'refuted' || (n.status !== 'active' && !n.supersededBy)
  const isGood = (n: Note): boolean => n.status === 'active' && n.verification?.verdict !== 'refuted'
  const flagged = new Set<string>()
  // "4,17 %" and "4.17%" are the same number
  const norm = (s: string): string => s.replace(/(\d),(\d)/g, '$1.$2').replace(/(\d)\s+%/g, '$1%')
  const normalized = new Map(allNotes.map(n => [n.id, norm(n.content)]))
  // "6%" must not match inside "36%" or "0.6%"
  const contains = (n: Note, value: string): boolean => new RegExp(`(?<![\\d.])${value.replace(/[.%]/g, c => `\\${c}`)}`).test(normalized.get(n.id)!)
  for (const m of cleaned.matchAll(/~?\d+(?:[.,]\d+)?\s?%/g)) {
    const value = norm(m[0].replace(/[~\s]/g, ''))
    if (flagged.has(value)) continue
    // the same number in a valid note (e.g. the corrected v2) is legitimate, whatever the wording around it
    if (allNotes.some(n => isGood(n) && contains(n, value))) continue
    const paragraph = cleaned.slice(Math.max(0, (m.index ?? 0) - 200), (m.index ?? 0) + 200)
    const best = (pred: (n: Note) => boolean): { note?: Note; score: number } => {
      let note: Note | undefined
      let score = 0
      for (const n of allNotes) {
        if (!pred(n) || !contains(n, value)) continue
        const s = similarity(paragraph, n.content)
        if (s > score) {
          score = s
          note = n
        }
      }
      return { note, score }
    }
    const bad = best(isBad)
    if (bad.note && bad.score > 0.25) {
      flagged.add(value)
      issues.push({ severity: 'majeur', kind: 'chiffre issu d\'une note réfutée', detail: `« ${value} » semble provenir de [[${bad.note.slug}]] (${bad.note.verification?.verdict === 'refuted' ? 'réfutée' : 'invalidée'}) et d'aucune note valide.` })
    }
  }

  // ── percentages without any citation nearby
  let unsourced = 0
  for (const line of lines) {
    if (!/\d\s?%/.test(line) || /^\s*\|/.test(line)) continue
    if (/\[[\w-]{4,}|\[\[|calcul|script|python|\bRFC\s?\d/i.test(line)) continue
    if (++unsourced <= 4) issues.push({ severity: 'mineur', kind: 'chiffre sans source', detail: `« ${line.trim().slice(0, 140)} »` })
  }
  return { issues, cited, notes }
}

/**
 * The part of a line that belongs to one citation: from the previous separator
 * (« ; », end of sentence, table cell, opening parenthesis, list marker) to the link itself.
 * Text after the link usually describes the next citation.
 */
export function clauseAround(line: string, link: string): string {
  const at = line.indexOf(link)
  if (at < 0) return line
  const lastSep = (s: string): number => Math.max(s.lastIndexOf(';'), s.lastIndexOf('. '), s.lastIndexOf('|'), s.lastIndexOf('('), s.lastIndexOf(' : '), s.lastIndexOf(']]'))
  const before = line.slice(0, at)
  let cut = lastSep(before)
  // "Claim sentence. [[slug]]" / "claim : [[slug]]": the link closes the preceding clause
  if (cut >= 0 && !before.slice(cut + 1).replace(/[\s*_:.]/g, '')) cut = lastSep(before.slice(0, cut))
  return line.slice(cut + 1, at + link.length)
}

/** Appendix written by the harness from the database, never by the model. */
export function buildAnnex(projectId: string, cited: Source[], notes: Note[]): string {
  const verifRows = notes.map(n => {
    const v = n.verification
    const status = n.status !== 'active' ? `invalidée${n.supersededBy ? ` → [[${n.supersededBy}]]` : ''}` : v ? `${v.verdict === 'supported' ? 'vérifiée' : v.verdict === 'refuted' ? 'RÉFUTÉE' : v.verdict === 'pending' ? 'en cours' : 'incertaine'} (${Math.round(v.confidence * 100)} %)` : 'non vérifiée'
    return `| [[${n.slug}]] | ${n.title.replace(/\|/g, '/').slice(0, 70)} | ${status} | ${n.status === 'active' ? assuranceText(n).replace(/\|/g, '/') : '—'} |`
  })
  const bib = cited.map(s => `- [${s.citationKey}] ${s.authors.slice(0, 3).join(', ')}${s.authors.length > 3 ? ' et al.' : ''} (${s.year ?? 's.d.'}). *${s.title}*${s.venue ? `. ${s.venue}` : ''}${s.doi ? `. doi:${s.doi}` : s.url ? `. ${s.url}` : ''} — **${READ_STATUS[s.status]}**`)
  const sources = listSources(projectId)
  const failedTools = all<{ tool: string; n: number; err: number }>(
    // code-running tools fail as part of normal iteration (compile errors, exceptions): not an outage
    "SELECT tool, COUNT(*) AS n, SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS err FROM tool_runs WHERE project_id = ? AND tool NOT IN ('python', 'bash', 'lean_run', 'lean_check', 'lean_search') GROUP BY tool HAVING err * 2 >= n AND n >= 5",
    projectId,
  )
  const unverified = listNotes(projectId).filter(n => n.type === 'finding' && n.importance >= 4 && (!n.verification || n.verification.verdict !== 'supported'))
  return [
    '\n\n---\n\n## Annexes générées par Noesis (depuis la base, non rédigées par l\'agent)\n',
    '### A. État réel des vérifications des notes citées\n',
    verifRows.length ? `| Note | Titre | Verdict | Niveau de vérification |\n|---|---|---|---|\n${verifRows.join('\n')}` : '_Le rapport ne cite aucune note de la mémoire : ses affirmations ne sont pas reliées à des résultats vérifiables._',
    '\n### B. Bibliographie citée (métadonnées de la bibliothèque)\n',
    bib.length ? bib.join('\n') : '_Aucune source de la bibliothèque n\'est citée._',
    '\n### C. Limites du processus de recherche\n',
    `- Bibliothèque : ${sources.length} sources, dont ${sources.filter(s => s.status === 'full_text').length} lues en texte intégral et ${sources.filter(s => s.status === 'failed' || s.status === 'requested').length} inaccessibles.`,
    `- Résultats importants non vérifiés ou non confirmés : ${unverified.length}${unverified.length ? ` (${unverified.slice(0, 6).map(n => `[[${n.slug}]]`).join(', ')})` : ''}.`,
    failedTools.length ? `- Outils majoritairement en échec pendant la session : ${failedTools.map(t => `${t.tool} (${t.err}/${t.n})`).join(', ')} — la couverture de la recherche en a été réduite.` : '- Aucun outil de recherche majoritairement en échec.',
    '- Rapport produit par des agents IA : les conclusions doivent être relues par un expert avant tout usage.',
  ].join('\n')
}

export function formatAudit(r: AuditResult): string {
  const base = r.issues.filter(i => i.source !== 'critique')
  const by = (s: Severity): AuditIssue[] => base.filter(i => i.severity === s)
  const out: string[] = [`# Audit du rapport ${path.basename(r.file)}`]
  out.push(r.blocking
    ? `\n**La clôture est bloquée** par les contrôles faits contre la base : chaque problème BLOQUANT bloque, et 4 problèmes MAJEURS ou plus bloquent aussi. Les « réserves de l'auditeur » plus bas ne bloquent jamais.`
    : `\n**Rien ne bloque la clôture.** Les points restants sont à corriger si c'est simple ; sinon, ils seront consignés en annexe du rapport.`)
  for (const s of ['bloquant', 'majeur', 'mineur'] as Severity[]) {
    const list = by(s)
    if (list.length) out.push(`\n## ${s.toUpperCase()} (${list.length})\n${list.map(i => `- [${i.kind}] ${i.detail}`).join('\n')}`)
  }
  if (r.critic) {
    out.push('\n---\n# Réserves de l\'auditeur (avis d\'un modèle, indicatives : elles ne bloquent pas la clôture et figureront en annexe si elles restent)')
    const c = r.critic
    const missing = c.deliverables.filter(d => d.status !== 'couvert')
    if (missing.length) out.push(`\n## Livrables de la question non (entièrement) traités\n${missing.map(d => `- ${d.status.toUpperCase()} : ${d.item}${d.comment ? ` — ${d.comment}` : ''}`).join('\n')}`)
    if (c.scope) out.push(`\n## Périmètre\n${c.scope}`)
    if (c.contradictions?.length) out.push(`\n## Contradictions internes\n${c.contradictions.map(x => `- ${x}`).join('\n')}`)
    if (c.overclaims?.length) out.push(`\n## Surinterprétations\n${c.overclaims.map(x => `- ${x}`).join('\n')}`)
    if (c.unsupported?.length) out.push(`\n## Affirmations sans appui\n${c.unsupported.map(x => `- ${x}`).join('\n')}`)
    if (c.verdict) out.push(`\nVerdict de l'auditeur : **${c.verdict}**`)
  }
  if (out.length === 1) out.push('\nAucun problème détecté.')
  return out.join('\n')
}

/** Full audit: deterministic checks + LLM critic (when a model is available). */
export async function auditReport(project: Project, file: string, model: ResolvedModel | undefined, signal?: AbortSignal): Promise<AuditResult> {
  const text = fs.readFileSync(file, 'utf8').split('\n---\n\n## Annexes générées par Noesis')[0]
  const { issues, cited, notes } = checkReport(project.id, text)
  let critic: AuditResult['critic']
  if (model) {
    const state = listNotes(project.id, { includeInactive: true, limit: 400 })
      .filter(n => n.verification || n.status !== 'active')
      .map(n => `- [[${n.slug}]] ${n.status !== 'active' ? 'INVALIDÉE' : n.verification?.verdict ?? ''}`)
      .slice(0, 120).join('\n')
    try {
      const res = await chat(model, {
        messages: [
          { role: 'system', content: loadPrompt('report_audit') },
          { role: 'user', content: `# Question de recherche\n${project.question}\n\n# État de la base (notes vérifiées / réfutées / invalidées)\n${state || '(aucune)'}\n\n# Rapport\n${text.slice(0, 90_000)}` },
        ],
        temperature: 0.1,
        signal,
        projectId: project.id,
        agentId: 'report-audit',
      })
      critic = extractJson(res.content)
      for (const d of critic?.deliverables ?? []) {
        if (d.status === 'absent') issues.push({ source: 'critique', severity: 'majeur', kind: 'livrable absent', detail: `${d.item}${d.comment ? ` — ${d.comment}` : ''} (à traiter, ou à déclarer explicitement comme non réalisé dans les limites)` })
      }
      for (const c of critic?.contradictions ?? []) issues.push({ source: 'critique', severity: 'majeur', kind: 'contradiction', detail: c })
      if (critic?.scope) issues.push({ source: 'critique', severity: 'majeur', kind: 'périmètre', detail: critic.scope })
    } catch {
      // the deterministic checks still stand
    }
  }
  // only database facts can block: the critic's opinions vary between runs and would make the target move forever
  const base = issues.filter(i => i.source !== 'critique')
  const blocking = base.filter(i => i.severity === 'bloquant').length + (base.filter(i => i.severity === 'majeur').length >= 4 ? 1 : 0)
  return { file, issues, critic, annex: buildAnnex(project.id, cited, notes), blocking }
}
