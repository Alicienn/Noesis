import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { LeanCheck, Note, Project, PublicationVersion, Source } from '../../shared/types.ts'
import { ASSURANCE_LABELS } from '../../shared/types.ts'
import { all } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { extractJson } from '../core/util.ts'
import { workspaceDir } from '../config.ts'
import { chat } from '../llm/client.ts'
import type { ResolvedModel } from '../llm/providers.ts'
import { assuranceText, listEpisodes, listNotes } from '../memory/notes.ts'
import { STANDARD_AXIOMS, leanStatusCached } from '../services/lean.ts'
import { bibKey, latexDocument, markdownToLatex, toBibtex } from '../services/latex.ts'
import { getBlock } from '../store/blocks.ts'
import { listBus } from '../store/conversation.ts'
import { listHypotheses } from '../store/hypotheses.ts'
import { listChecks } from '../store/leanChecks.ts'
import { listSources } from '../store/sources.ts'
import { findReport } from './audit.ts'
import { loadPrompt } from './prompts.ts'

/**
 * Publication layer, after openai/math:
 *  - an abridged reasoning summary (narrative of the trajectory, with verbatim
 *    excerpts copied from the database by id — the model picks them, it never writes them);
 *  - a versioned bundle: LaTeX manuscript + BibTeX, the reasoning summary,
 *    formalization.yaml (mathlib-initiative schema v0.4) with the Comparator
 *    checks, and a README mapping each result to its verification level.
 *    Corrections become new versions; earlier ones stay untouched.
 */

export const SUMMARY_FILE = '_resume-raisonnement.md'

// ───────────────────────────── reasoning summary ─────────────────────────────

interface Excerpt {
  id: number
  text: string
  agent: string
  at: number
}

/** Short sentences from the agents' own words (answers and reasoning streams), spread over the whole run. */
function excerptCandidates(projectId: string, max = 160): Excerpt[] {
  const rows = all<{ agent_id: string; content: string; reasoning: string | null; created_at: number }>(
    "SELECT agent_id, content, reasoning, created_at FROM messages WHERE project_id = ? AND role = 'assistant' ORDER BY created_at",
    projectId,
  )
  const pool: Omit<Excerpt, 'id'>[] = []
  for (const r of rows) {
    for (const text of [r.reasoning ?? '', r.content]) {
      for (const s of text.split(/(?<=[.!?…])\s+|\n+/)) {
        const t = s.trim()
        if (t.length < 25 || t.length > 260) continue
        if (/^[-*#|>]|```|\]\(|^\d+\.\s/.test(t)) continue
        if (!/(donc|mais|pourtant|cependant|essayons|piste|idée|erreur|faux|contre-exemple|marche|échoue|bloqu|aha|clé|astuce|suffit|implique|vérifi|because|but|wait|so |idea|fails|works|key|trick|counterexample|hmm|actually)/i.test(t)) continue
        pool.push({ text: t, agent: r.agent_id, at: r.created_at })
      }
    }
  }
  if (pool.length <= max) return pool.map((e, i) => ({ ...e, id: i + 1 }))
  const step = pool.length / max
  return Array.from({ length: max }, (_, i) => ({ ...pool[Math.floor(i * step)], id: i + 1 }))
}

function agentLabel(agentId: string): string {
  if (agentId.startsWith('lead_')) return 'chercheur principal'
  if (agentId.startsWith('sup_')) return 'superviseur'
  return agentId.replace(/_[a-z0-9]{12}$/, '')
}

export async function generateReasoningSummary(project: Project, model: ResolvedModel, signal?: AbortSignal): Promise<{ file: string; markdown: string }> {
  const notes = listNotes(project.id, { includeInactive: true, limit: 2000 })
  const findings = notes.filter(n => n.type === 'finding' && n.status === 'active').sort((a, b) => b.importance - a.importance).slice(0, 15)
  const deadEnds = notes.filter(n => n.type === 'dead_end').slice(0, 15)
  const superseded = notes.filter(n => n.status === 'superseded').slice(0, 12)
  const episodes = listEpisodes(project.id)
  const supervisor = listBus(project.id).filter(m => m.from === 'supervisor' && ['warning', 'critical', 'suggestion'].includes(m.kind)).slice(-12)
  const hyps = listHypotheses(project.id)
  const excerpts = excerptCandidates(project.id)
  const input = [
    `# Question\n${project.question.slice(0, 4000)}`,
    `# Plan final\n${getBlock(project.id, 'plan')?.value ?? ''}`,
    `# Épisodes (résumés chronologiques)\n${episodes.map((e, i) => `## Épisode ${i + 1} (${agentLabel(e.agentId)})\n${e.summary.slice(0, 2500)}`).join('\n\n') || '(aucun)'}`,
    `# Résultats\n${findings.map(n => `- [[${n.slug}]] ${n.title} — ${assuranceText(n)}${n.verification ? ` · verdict ${n.verification.verdict}` : ''}`).join('\n') || '(aucun)'}`,
    `# Impasses\n${deadEnds.map(n => `- ${n.title} : ${n.content.slice(0, 300)}`).join('\n') || '(aucune)'}`,
    `# Notes invalidées (ce qu'on a cru puis abandonné)\n${superseded.map(n => `- ${n.title} : ${n.content.split('**Invalidée**')[1]?.slice(0, 250) ?? ''}`).join('\n') || '(aucune)'}`,
    `# Hypothèses\n${hyps.map(h => `- (${h.status}, Elo ${h.elo}) ${h.statement.slice(0, 200)}`).join('\n') || '(aucune)'}`,
    `# Interventions du superviseur\n${supervisor.map(m => `- ${m.content.slice(0, 300)}`).join('\n') || '(aucune)'}`,
    `# Extraits verbatim disponibles (choisis-les par numéro)\n${excerpts.map(e => `${e.id}. [${agentLabel(e.agent)}] ${e.text}`).join('\n')}`,
  ].join('\n\n').slice(0, 120_000)
  const res = await chat(model, {
    messages: [{ role: 'system', content: loadPrompt('reasoning_summary') }, { role: 'user', content: input }],
    temperature: 0.2,
    maxTokens: 6000,
    signal,
    projectId: project.id,
    agentId: 'publication',
  })
  const out = extractJson<{ title?: string; sections?: Array<{ heading?: string; paragraphs?: string[]; excerpts?: number[] }> }>(res.content)
  if (!out?.sections?.length) throw new Error('Le modèle n\'a pas rendu de résumé structuré')
  const byId = new Map(excerpts.map(e => [e.id, e]))
  const used = new Set<number>()
  const md: string[] = [
    `# ${out.title?.trim() || project.title} — résumé du raisonnement`,
    '',
    '_Résumé abrégé de la trajectoire des agents, généré par Noesis. Les extraits verbatim sont recopiés tels quels depuis la base ; le reste est une narration et peut simplifier._',
    '',
    '## Question d\'origine (extraits)',
    '',
    ...project.question.slice(0, 2500).split('\n').map(l => `> ${l}`),
    project.question.length > 2500 ? '> […]' : '',
  ]
  out.sections.slice(0, 8).forEach((s, i) => {
    md.push('', `## ${i + 1}. ${s.heading?.trim() || 'Étape'}`, '')
    for (const p of s.paragraphs ?? []) md.push(p.trim(), '')
    for (const id of s.excerpts ?? []) {
      const e = byId.get(Number(id))
      if (!e || used.has(e.id)) continue
      used.add(e.id)
      md.push(`> **Extrait verbatim** — ${agentLabel(e.agent)}, ${new Date(e.at).toLocaleString('fr-FR')}`, '>', `> ${e.text}`, '')
    }
  })
  md.push('## État des résultats à la fin', '', ...(findings.length ? findings.map(n => `- [[${n.slug}]] ${n.title} — **${assuranceText(n)}**`) : ['_Aucun résultat consigné._']))
  const markdown = md.join('\n').replace(/\n{3,}/g, '\n\n')
  const file = path.join(workspaceDir(project.id), 'reports', SUMMARY_FILE)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${markdown}\n`, 'utf8')
  bus.publish(project.id, { type: 'files.changed' })
  return { file, markdown }
}

// ───────────────────────────── versioned export ─────────────────────────────

function publicationRoot(projectId: string): string {
  return path.join(workspaceDir(projectId), 'publication')
}

export function listPublications(projectId: string): PublicationVersion[] {
  const root = publicationRoot(projectId)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .filter(d => /^v\d+$/.test(d))
    .map(d => {
      const dir = path.join(root, d)
      let meta: { createdAt?: number; note?: string } = {}
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'))
      } catch {
        // older or partial version
      }
      const files: string[] = []
      const walk = (p: string, rel: string): void => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(p, e.name), `${rel}${e.name}/`)
          else files.push(`${rel}${e.name}`)
        }
      }
      walk(dir, '')
      return { version: Number(d.slice(1)), dir: `publication/${d}`, createdAt: meta.createdAt ?? fs.statSync(dir).mtimeMs, files: files.sort(), note: meta.note }
    })
    .sort((a, b) => b.version - a.version)
}

function citedKeys(text: string, sources: Source[]): Set<string> {
  const keys = new Set(sources.map(s => s.citationKey))
  const out = new Set<string>()
  for (const m of text.matchAll(/\[([^\]\n]{1,200})\]/g)) {
    for (const part of m[1].split(/\s*;\s*/)) {
      const k = part.split(',')[0].trim()
      if (keys.has(k)) out.add(k)
    }
  }
  return out
}

function modelsUsed(projectId: string): string[] {
  return all<{ model: string }>('SELECT DISTINCT model FROM usage WHERE project_id = ?', projectId).map(r => r.model.split('::').pop() ?? r.model).filter(Boolean)
}

function formalizationYaml(project: Project, manuscriptTitle: string, proved: Array<{ check: LeanCheck; note?: Note }>, sorryCount: number): string {
  const status = leanStatusCached()
  const reviewedByAgent = proved.length > 0 && proved.every(p => p.note?.assurance?.lean?.statementReview?.verdict === 'supported')
  const humanApproved = proved.filter(p => p.note?.assurance?.humanReview?.target === 'lean_statement' && p.note.assurance.humanReview.verdict === 'approved')
  const doc = {
    version: 'v0.4',
    project: {
      name: project.title,
      description: `Formalisations Lean 4 des résultats principaux du projet Noesis « ${project.title} ». Chaque résultat est vérifié par Comparator (énoncé du challenge identique, axiomes standard uniquement, noyau Lean).`,
      authors: ['Noesis (agents IA)'],
      license: 'Apache-2.0',
    },
    sources: [{
      title: manuscriptTitle,
      authors: ['Noesis (agents IA)'],
      id: 'manuscript.tex',
      type: 'original-proof',
      relationship: 'formalizes',
    }],
    related_formalizations: [{ id: 'https://github.com/leanprover-community/mathlib4', relationship: 'builds-on', note: status?.mathlib ? `Mathlib ${status.mathlib}` : undefined }],
    automation: {
      methods: [{
        method: 'autonomous',
        models: modelsUsed(project.id),
        framework: 'Noesis',
        tool_setup: `Équipe d'agents (chercheur principal, théoricien, vérificateur) ; Lean ${/version ([^,)\s]+)/.exec(status?.leanVersion ?? '')?.[1] ?? '4'} + Mathlib ${status?.mathlib ?? ''} ; vérification par leanprover/comparator dans un bac à sable landrun.`,
      }],
    },
    status: {
      scope: proved.length ? 'Partial progress.' : 'No formalized result.',
      sorry_count: sorryCount,
      axioms: STANDARD_AXIOMS,
      main_results: proved.map(p => ({
        declaration: p.check.theorems.join(', '),
        file: `lean/${p.check.id}/Solution.lean`,
        sorry_count: 0,
        axioms: p.check.permittedAxioms,
        comparator_config: `lean/${p.check.id}/config.json`,
      })),
    },
    alignment: proved.map(p => ({
      statement: p.note ? p.note.title : p.check.theorems.join(', '),
      note: p.note ? `[[${p.note.slug}]]` : undefined,
      declaration: p.check.theorems.join(', '),
      challenge: `lean/${p.check.id}/Challenge.lean`,
      statement_review: p.note?.assurance?.lean?.statementReview ? `${p.note.assurance.lean.statementReview.verdict} (agent vérificateur)` : 'non relu',
      human_review: p.note?.assurance?.humanReview ? `${p.note.assurance.humanReview.verdict} : ${p.note.assurance.humanReview.comment}` : undefined,
    })),
    review: {
      status: reviewedByAgent ? 'agent-reviewed' : 'unchecked',
      reviewers: humanApproved.length ? ['agent vérificateur Noesis', 'utilisateur humain (énoncés approuvés)'] : reviewedByAgent ? ['agent vérificateur Noesis'] : [],
      notes: `Fidélité des énoncés : ${proved.filter(p => p.note?.assurance?.lean?.statementReview?.verdict === 'supported').length}/${proved.length} relue(s) par l'agent vérificateur, ${humanApproved.length}/${proved.length} approuvée(s) par l'humain.`,
    },
    acknowledgements: 'Lean 4, Mathlib, Lake, Comparator, lean4export, landrun.',
  }
  const clean = JSON.parse(JSON.stringify(doc))
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/mathlib-initiative/formalization.yaml/main/schema/formalization.schema.json\n# Généré par Noesis. Chemins relatifs à ce fichier.\n${YAML.stringify(clean)}`
}

export function exportPublication(project: Project, opts: { note?: string } = {}): PublicationVersion {
  const ws = workspaceDir(project.id)
  const reportFile = findReport(project.id)
  if (!reportFile) throw new Error('Aucun rapport dans reports/ : rien à publier.')
  const reportMd = fs.readFileSync(reportFile, 'utf8')
  const sources = listSources(project.id)
  const versions = listPublications(project.id)
  const version = (versions[0]?.version ?? 0) + 1
  const dir = path.join(publicationRoot(project.id), `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const date = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })

  // manuscript + bibliography
  const summaryPath = path.join(ws, 'reports', SUMMARY_FILE)
  const summaryMd = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : undefined
  const cited = citedKeys(`${reportMd}\n${summaryMd ?? ''}`, sources)
  const bibSources = sources.filter(s => cited.has(s.citationKey))
  fs.writeFileSync(path.join(dir, 'references.bib'), `${toBibtex(bibSources)}\n`, 'utf8')
  const keys = bibSources.map(s => s.citationKey)
  const manuscript = markdownToLatex(reportMd, { keys })
  const title = manuscript.title ?? project.title
  fs.writeFileSync(path.join(dir, 'manuscript.tex'), latexDocument({ title, author: 'Noesis (agents IA) — relu par : à compléter', date, body: manuscript.body, bibliography: bibSources.length ? 'references' : undefined }), 'utf8')
  fs.writeFileSync(path.join(dir, 'manuscript.md'), reportMd, 'utf8')
  if (summaryMd) {
    const s = markdownToLatex(summaryMd, { keys })
    fs.writeFileSync(path.join(dir, 'reasoning-summary.tex'), latexDocument({ title: s.title ?? `${title} — résumé du raisonnement`, author: 'Noesis', date, body: s.body, bibliography: bibSources.length ? 'references' : undefined }), 'utf8')
    fs.writeFileSync(path.join(dir, 'reasoning-summary.md'), summaryMd, 'utf8')
  }

  // Lean: proved checks of active notes, copied with their Comparator config
  const notes = listNotes(project.id, { includeInactive: true, limit: 5000 })
  const noteBySlug = new Map(notes.map(n => [n.slug, n]))
  const proved = listChecks(project.id)
    .filter(c => c.status === 'proved')
    .filter((c, i, arr) => !c.noteSlug || arr.findIndex(o => o.noteSlug === c.noteSlug) === i) // newest per note
    .map(check => ({ check, note: check.noteSlug ? noteBySlug.get(check.noteSlug) : undefined }))
    .filter(p => !p.note || p.note.status === 'active')
  for (const { check } of proved) {
    const src = path.join(ws, 'lean', 'checks', check.id)
    const dst = path.join(dir, 'lean', check.id)
    fs.mkdirSync(dst, { recursive: true })
    for (const f of ['Challenge.lean', 'Solution.lean', 'comparator.log']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f))
    fs.writeFileSync(path.join(dst, 'config.json'), JSON.stringify({ challenge_module: 'Challenge', solution_module: 'Solution', theorem_names: check.theorems, definition_names: check.definitions, permitted_axioms: check.permittedAxioms }, null, 2), 'utf8')
  }
  if (proved.length) fs.writeFileSync(path.join(dir, 'formalization.yaml'), formalizationYaml(project, title, proved, 0), 'utf8')

  // README: the "manuscript map" of this family of results
  const findings = notes.filter(n => n.status === 'active' && ['finding', 'insight'].includes(n.type)).sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt)
  const counts = (['formal', 'computed', 'reviewed', 'claimed'] as const).map(l => `${ASSURANCE_LABELS[l]} : ${findings.filter(n => (n.assurance?.level ?? 'claimed') === l).length}`)
  const readme = [
    `# ${title}`,
    '',
    `Version ${version} — ${date}${opts.note ? ` — ${opts.note}` : ''}.${version > 1 ? ` Les versions précédentes restent dans \`publication/v1…v${version - 1}\` et ne sont jamais modifiées.` : ' Une correction créera une version 2 ; celle-ci ne sera jamais modifiée.'}`,
    '',
    '## Question',
    '',
    project.question.slice(0, 3000),
    '',
    '## Contenu',
    '',
    '- `manuscript.tex` / `manuscript.md` — rapport final (LaTeX : `latexmk -lualatex manuscript.tex`)',
    '- `references.bib` — bibliographie des sources citées (métadonnées de la bibliothèque)',
    summaryMd ? '- `reasoning-summary.tex` / `.md` — résumé abrégé du raisonnement des agents, avec extraits verbatim' : undefined,
    proved.length ? `- \`formalization.yaml\` — catalogue des formalisations (schéma mathlib-initiative v0.4)\n- \`lean/<id>/\` — Challenge.lean (énoncé), Solution.lean (preuve), config.json : \`lake env comparator lean/<id>/config.json\` dans un projet Lake avec Mathlib` : undefined,
    '',
    '## Résultats et niveau de vérification',
    '',
    counts.join(' · '),
    '',
    '| Résultat | Niveau | Détail |',
    '|---|---|---|',
    ...findings.slice(0, 60).map(n => `| ${n.title.replace(/\|/g, '/')} | ${ASSURANCE_LABELS[n.assurance?.level ?? 'claimed']} | ${assuranceText(n).replace(/\|/g, '/')} |`),
    '',
    '## Avertissement',
    '',
    'Résultats produits par des agents IA. Seuls les résultats « Prouvé en Lean » dont l\'énoncé a été relu sont garantis par une vérification mécanique ; les autres peuvent contenir des erreurs et doivent être relus par un expert.',
    '',
    '## Citer',
    '',
    '```bibtex',
    `@misc{noesis-${bibKey(project.id)}-v${version},`,
    `  title = {${title.replace(/[{}]/g, '')}},`,
    '  author = {Noesis},',
    `  year = {${new Date().getFullYear()}},`,
    `  note = {Version ${version}}`,
    '}',
    '```',
  ].filter((l): l is string => l !== undefined).join('\n')
  fs.writeFileSync(path.join(dir, 'README.md'), `${readme}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version, createdAt: Date.now(), note: opts.note, report: path.relative(ws, reportFile).replace(/\\/g, '/') }, null, 2), 'utf8')
  // changelog across versions
  const changelog = path.join(publicationRoot(project.id), 'CHANGELOG.md')
  const prev = fs.existsSync(changelog) ? fs.readFileSync(changelog, 'utf8') : '# Historique des versions\n'
  fs.writeFileSync(changelog, `${prev.trimEnd()}\n\n- **v${version}** — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${opts.note || 'export'} (${findings.length} résultats, ${proved.length} preuve(s) Lean)\n`, 'utf8')
  bus.publish(project.id, { type: 'files.changed' })
  return listPublications(project.id).find(v => v.version === version)!
}

