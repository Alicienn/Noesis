/**
 * Benchmark built from the Comparator challenges of github.com/openai/math (Apache-2.0).
 *
 *   npx tsx scripts/lean/openai-math.ts fetch [n]        download n challenges that only import Mathlib (default 20)
 *   npx tsx scripts/lean/openai-math.ts check            compile their statements against the shared Mathlib (toolchain compatibility)
 *   API=http://127.0.0.1:4317/api npx tsx scripts/lean/openai-math.ts propose <Name> [--required]
 *                                                       create a Noesis "problem" project from one challenge
 *
 * Their library is pinned to Lean/Mathlib v4.34.1, ours to v4.34.0: `check` tells which statements still compile.
 * Only the statements (Challenge files) are used, never their proofs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(here, 'benchmarks', 'openai-math')
const RAW = 'https://raw.githubusercontent.com/openai/math/main'
const TREE = 'https://api.github.com/repos/openai/math/git/trees/main?recursive=1'

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'user-agent': 'noesis-benchmark' } })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return r.text()
}

async function fetchChallenges(n: number): Promise<void> {
  const tree = JSON.parse(await getText(TREE)) as { tree: Array<{ path: string }> }
  const names = tree.tree.map(t => t.path).filter(p => /^lean\/ComparatorChallenges\/[^/]+\.json$/.test(p)).map(p => path.basename(p, '.json'))
  fs.mkdirSync(DIR, { recursive: true })
  let kept = 0
  for (const name of names) {
    if (kept >= n) break
    const lean = await getText(`${RAW}/lean/ComparatorChallenges/${name}.lean`)
    const imports = [...lean.matchAll(/^import\s+(\S+)/gm)].map(m => m[1])
    // other dependencies of their library (PrimeNumberTheoremAnd, Carleson…) are not installed here
    if (imports.some(i => i !== 'Mathlib' && !i.startsWith('Mathlib.'))) continue
    const config = await getText(`${RAW}/lean/ComparatorChallenges/${name}.json`)
    fs.writeFileSync(path.join(DIR, `${name}.lean`), lean, 'utf8')
    fs.writeFileSync(path.join(DIR, `${name}.json`), config, 'utf8')
    kept++
    console.log(`✔ ${name}`)
  }
  fs.writeFileSync(path.join(DIR, 'NOTICE.md'), `Comparator challenges copied from https://github.com/openai/math (lean/ComparatorChallenges), licensed under the Apache License 2.0.\nCopyright OpenAI. Unmodified statement files, used as a benchmark for Noesis. Downloaded ${new Date().toISOString().slice(0, 10)}.\n`, 'utf8')
  console.log(`\n${kept} défi(s) dans ${path.relative(process.cwd(), DIR)}`)
}

async function check(): Promise<void> {
  const { leanStatus, runLeanFile } = await import('../../server/services/lean.ts')
  const status = await leanStatus(true)
  if (!status.available) throw new Error(`Environnement Lean indisponible : ${status.error}`)
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.lean')) : []
  if (!files.length) throw new Error('Aucun défi : lance d\'abord `fetch`.')
  let ok = 0
  for (const f of files) {
    const r = await runLeanFile({ projectId: 'bench', file: path.join(DIR, f), displayPath: f })
    const good = r.ok && r.sorries > 0
    if (good) ok++
    console.log(`${good ? '✔' : '✘'} ${f} — ${Math.round(r.durationMs / 1000)} s${good ? `, ${r.sorries} sorry` : `\n   ${r.output.split('\n').find(l => /error/.test(l))?.slice(0, 200) ?? r.output.slice(0, 200)}`}`)
  }
  console.log(`\n${ok}/${files.length} énoncés compilent avec Mathlib ${status.mathlib}`)
}

async function propose(name: string, required: boolean): Promise<void> {
  const api = process.env.API ?? 'http://127.0.0.1:4317/api'
  const lean = fs.readFileSync(path.join(DIR, `${name}.lean`), 'utf8')
  const config = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as { theorem_names: string[]; definition_names?: string[] }
  const question = [
    'Donne une solution complète et rigoureuse au problème suivant, formulé comme un énoncé Lean 4 / Mathlib. Même si le problème est réputé ouvert, l\'intention est que tu le résolves.',
    'La solution peut être une preuve de l\'énoncé, ou — si l\'énoncé est faux — une réfutation rigoureuse (preuve de la négation). Les énumérations exhaustives et les preuves assistées par ordinateur sont déconseillées dans la rédaction finale.',
    '',
    '# Problème',
    `L'énoncé à prouver est le(s) théorème(s) ${config.theorem_names.join(', ')} du fichier lean/challenge/Challenge.lean (copié ci-dessous). Commence par le traduire en mathématiques usuelles.`,
    '',
    '```lean',
    lean.trim(),
    '```',
    '',
    '# Portée',
    `Le livrable formel est un fichier lean/challenge/Solution.lean qui redéclare le même énoncé et le prouve, accepté par lean_check(challenge="lean/challenge/Challenge.lean", solution="lean/challenge/Solution.lean", theorems=${JSON.stringify(config.theorem_names)}${config.definition_names?.length ? `, definitions=${JSON.stringify(config.definition_names)}` : ''}). Source : défi « ${name} » de github.com/openai/math (Apache-2.0).`,
  ].join('\n')
  const res = await fetch(`${api}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `openai/math · ${name}`, domain: 'Mathématiques', question, config: { kind: 'problem', formal: required ? 'required' : 'preferred' } }),
  })
  if (!res.ok) throw new Error(`Création impossible : HTTP ${res.status} ${await res.text()}`)
  const project = (await res.json()) as { id: string }
  await fetch(`${api}/projects/${project.id}/files`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'lean/challenge/Challenge.lean', content: lean }) })
  console.log(`Projet créé : ${project.id} — ouvre http://127.0.0.1:4317/p/${project.id} et lance la recherche.`)
}

const [cmd, arg, flag] = process.argv.slice(2)
try {
  if (cmd === 'fetch') await fetchChallenges(Number(arg) || 20)
  else if (cmd === 'check') await check()
  else if (cmd === 'propose' && arg) await propose(arg, flag === '--required')
  else console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
process.exit(0)
