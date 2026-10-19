/**
 * Verification ladder, Lean tools and publication, end to end. Run after `npm run e2e`
 * (it reuses the finished project of that scenario), with the same data directory:
 *
 *   NOESIS_DATA_DIR=./data-test API=http://127.0.0.1:4399/api npx tsx scripts/e2e-publication.ts
 *
 * The Lean part runs only when the Lean environment is installed.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { LeanCheck, Note, Project, PublicationVersion } from '../shared/types.ts'

const API = process.env.API ?? 'http://127.0.0.1:4399/api'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${url}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

const projects = await call<Project[]>('GET', '/projects')
const project = projects.find(p => p.status === 'finished') ?? projects[0]
if (!project) throw new Error('Aucun projet : lance d\'abord npm run e2e')
const pid = project.id

// ── verification ladder
const notes = await call<Note[]>('GET', `/projects/${pid}/notes`)
const finding = notes.find(n => n.type === 'finding')!
check('le verdict « supported » avec calcul donne le niveau « computed »', finding.assurance?.level === 'computed', finding.assurance?.level)
check('l\'historique ne contient que des événements réels', (finding.assurance?.history ?? []).every(e => e.by !== 'verifier'), String(finding.assurance?.history.length))

// ── human review
const reviewed = await call<Note>('POST', `/projects/${pid}/notes/${finding.slug}/review`, { verdict: 'approved', target: 'result', comment: 'relu en test' })
check('relecture humaine enregistrée', reviewed.assurance?.humanReview?.verdict === 'approved' && reviewed.assurance.level === 'computed')

// ── reasoning summary
const summary = await call<{ file: string }>('POST', `/projects/${pid}/reasoning-summary`)
const ws = path.resolve(process.env.NOESIS_DATA_DIR ?? './data-test', 'projects', pid, 'workspace')
const summaryText = fs.readFileSync(path.join(ws, summary.file), 'utf8')
check('résumé du raisonnement écrit', summary.file === 'reports/_resume-raisonnement.md' && summaryText.includes('## 1. Cadrage'), summary.file)
check('le résumé reprend la question d\'origine', summaryText.includes('Question d\'origine'))

// ── Lean (direct tool call on the same database)
const { leanStatus } = await import('../server/services/lean.ts')
const lean = await leanStatus(true)
if (lean.available) {
  const { getProject, updateProject } = await import('../server/store/projects.ts')
  const { leanTools } = await import('../server/tools/builtin/lean.ts')
  const { toolsFor } = await import('../server/tools/registry.ts')
  check('outils Lean masqués quand la formalisation est désactivée', !toolsFor('lead', getProject(pid)!).some(t => t.category === 'formal'))
  updateProject(pid, { config: { formal: 'preferred' } })
  const p = getProject(pid)!
  check('outils Lean proposés quand la formalisation est activée', toolsFor('theorist', p).some(t => t.name === 'lean_check'))
  fs.mkdirSync(path.join(ws, 'lean', 'seuil'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lean', 'seuil', 'Challenge.lean'), 'import Mathlib\n\nnamespace Seuil\ntheorem amgm (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by sorry\nend Seuil\n')
  fs.writeFileSync(path.join(ws, 'lean', 'seuil', 'Solution.lean'), 'import Mathlib\n\nnamespace Seuil\ntheorem amgm (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by nlinarith [sq_nonneg (a - b)]\nend Seuil\n')
  const tool = leanTools.find(t => t.name === 'lean_check')!
  const ctx = { project: p, agent: { id: 'theo_test', projectId: pid, role: 'theorist', name: 'test', status: 'tool', steps: 0, createdAt: Date.now() }, workspace: ws, signal: new AbortController().signal, runtime: {} as never, toolRunId: 't', toolCallId: 't' } as Parameters<typeof tool.execute>[1]
  const out = await tool.execute({ challenge: 'lean/seuil/Challenge.lean', solution: 'lean/seuil/Solution.lean', theorems: ['Seuil.amgm'], note_slug: finding.slug }, ctx)
  const text = typeof out === 'string' ? out : out.content
  check('lean_check accepte la preuve et le signale', text.startsWith('ACCEPTÉ'), text.split('\n')[0])
  const after = await call<Note>('GET', `/projects/${pid}/notes/${finding.slug}`)
  check('la note passe au niveau « formal »', after.assurance?.level === 'formal' && after.assurance.lean?.status === 'proved')
  const checks = await call<LeanCheck[]>('GET', `/projects/${pid}/lean-checks`)
  check('vérification archivée', checks.length === 1 && fs.existsSync(path.join(ws, checks[0].solutionFile)) && fs.existsSync(path.join(ws, 'lean', 'checks', checks[0].id, 'comparator.log')))
  const sorry = await tool.execute({ challenge: 'lean/seuil/Challenge.lean', solution: 'lean/seuil/Challenge.lean', theorems: ['Seuil.amgm'] }, ctx).then(() => 'accepté', (e: Error) => e.message)
  check('une solution avec sorry est refusée avant Comparator', sorry.includes('sorry'), sorry.slice(0, 80))
} else {
  console.log(`(Lean indisponible : ${lean.error} — partie formelle sautée)`)
}

// ── versioned publication
const v1 = await call<PublicationVersion>('POST', `/projects/${pid}/publications`, { note: 'première version' })
check('export v1', v1.version === 1 && ['manuscript.tex', 'references.bib', 'README.md', 'reasoning-summary.tex'].every(f => v1.files.includes(f)), v1.files.join(', '))
const tex = fs.readFileSync(path.join(ws, v1.dir, 'manuscript.tex'), 'utf8')
check('manuscrit LaTeX complet', tex.includes('\\begin{document}') && tex.includes('\\end{document}') && !tex.includes('\u0000'))
if (lean.available) {
  const yaml = fs.readFileSync(path.join(ws, v1.dir, 'formalization.yaml'), 'utf8')
  check('formalization.yaml (schéma v0.4) avec le résultat formel', yaml.includes('version: v0.4') && yaml.includes('comparator_config:') && yaml.includes('Seuil.amgm'))
  check('fichiers Lean copiés dans la publication', v1.files.some(f => f.endsWith('Solution.lean')))
}
const v2 = await call<PublicationVersion>('POST', `/projects/${pid}/publications`, { note: 'correction' })
const v1Again = (await call<PublicationVersion[]>('GET', `/projects/${pid}/publications`)).find(v => v.version === 1)
check('une nouvelle version ne touche pas l\'ancienne', v2.version === 2 && v1Again?.note === 'première version' && fs.existsSync(path.join(ws, 'publication', 'CHANGELOG.md')))

console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK')
process.exit(failures ? 1 : 0)
