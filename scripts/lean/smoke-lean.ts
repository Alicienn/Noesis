/**
 * Smoke test of the formal-verification backend (no LLM):
 *   NOESIS_DATA_DIR=./data-test npx tsx scripts/lean/smoke-lean.ts
 * Requires the Lean environment (scripts/lean/setup-wsl.sh).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { leanStatus, runComparator, runLeanFile, searchMathlib } from '../../server/services/lean.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noesis-lean-'))
const write = (name: string, text: string): string => {
  const f = path.join(dir, name)
  fs.writeFileSync(f, text, 'utf8')
  return f
}

const status = await leanStatus(true)
check('environnement Lean prêt', status.available, status.error ?? `${status.leanVersion} · Mathlib ${status.mathlib}`)
if (!status.available) process.exit(1)

const good = write('Good.lean', 'import Mathlib\n\ntheorem two_sq (x : ℝ) : 0 ≤ x ^ 2 := by positivity\n#check two_sq\n')
let r = await runLeanFile({ projectId: 'smoke', file: good, displayPath: 'lean/Good.lean' })
check('lean_run : fichier correct', r.ok && r.sorries === 0, `${Math.round(r.durationMs / 1000)} s`)
check('lean_run : sortie #check reçue', r.output.includes('two_sq'), r.output.slice(0, 120))

const bad = write('Bad.lean', 'import Mathlib\n\ntheorem oops (n : ℕ) : n + 1 = n := by simp\n')
r = await runLeanFile({ projectId: 'smoke', file: bad, displayPath: 'lean/Bad.lean' })
check('lean_run : erreur détectée', !r.ok && r.output.includes('lean/Bad.lean'), r.output.split('\n')[0])

const partial = write('Partial.lean', 'import Mathlib\n\ntheorem later (n : ℕ) : n ≤ n ^ 2 := by sorry\n')
r = await runLeanFile({ projectId: 'smoke', file: partial, displayPath: 'lean/Partial.lean' })
check('lean_run : sorry compté', r.ok && r.sorries === 1)

const found = await searchMathlib('theorem add_pow_le_pow_mul_pow_of_sq_le_sq|theorem sq_nonneg')
check('lean_search : Mathlib consultable', found.includes('sq_nonneg'), found.split('\n')[0])

const challenge = write('Challenge.lean', 'import Mathlib\n\nnamespace Smoke\ntheorem sum_sq (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by sorry\nend Smoke\n')
const solution = write('Solution.lean', 'import Mathlib\n\nnamespace Smoke\ntheorem sum_sq (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by nlinarith [sq_nonneg (a - b)]\nend Smoke\n')
let c = await runComparator({ projectId: 'smoke', checkId: 'ok1', challenge, solution, theorems: ['Smoke.sum_sq'], definitions: [] })
check('lean_check : preuve correcte acceptée', c.ok, `${Math.round(c.durationMs / 1000)} s`)
if (!c.ok) console.log(c.output.slice(-1500))

const weaker = write('Weaker.lean', 'import Mathlib\n\nnamespace Smoke\ntheorem sum_sq (a b : ℝ) (h : a = b) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by subst h; nlinarith [sq_nonneg a]\nend Smoke\n')
c = await runComparator({ projectId: 'smoke', checkId: 'weak1', challenge, solution: weaker, theorems: ['Smoke.sum_sq'], definitions: [] })
check('lean_check : énoncé affaibli rejeté', !c.ok, c.output.split('\n').filter(l => /mismatch|differ|not|error/i.test(l))[0]?.slice(0, 140) ?? '')

const native = write('Native.lean', 'import Mathlib\n\nnamespace Smoke\ntheorem sum_sq (a b : ℝ) : 2 * a * b ≤ a ^ 2 + b ^ 2 := by\n  have : (2:ℕ) + 2 = 4 := by native_decide\n  nlinarith [sq_nonneg (a - b)]\nend Smoke\n')
c = await runComparator({ projectId: 'smoke', checkId: 'native1', challenge, solution: native, theorems: ['Smoke.sum_sq'], definitions: [] })
check('lean_check : axiome non standard (native_decide) rejeté', !c.ok)

fs.rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK')
process.exit(failures ? 1 : 0)
