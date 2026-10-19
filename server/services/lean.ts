import fs from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { LeanSettings, LeanStatus } from '../../shared/types.ts'
import { ROOT_DIR } from '../config.ts'
import { Semaphore, newId } from '../core/util.ts'
import { DEFAULT_SETTINGS, getSettings } from '../settings.ts'
import { execFile } from './shell.ts'
import type { ExecResult } from './shell.ts'

/**
 * Formal verification backend: Lean 4 + Mathlib + Comparator
 * (github.com/leanprover/comparator), the judge used by openai/math.
 *
 * Everything runs in Linux — inside WSL on Windows, since Comparator sandboxes
 * the proof build with landrun (Linux Landlock). One shared Lake workspace with
 * a prebuilt Mathlib serves every project (~10 GB once, not per project).
 * scripts/lean/setup-wsl.sh installs it; this module drives it.
 */

export const DEFAULT_LEAN_SETTINGS: LeanSettings = DEFAULT_SETTINGS.lean!

/** Axioms a Comparator check may use: the three of Lean's standard library, nothing else (no sorryAx). */
export const STANDARD_AXIOMS = ['propext', 'Quot.sound', 'Classical.choice']

const IS_WIN = process.platform === 'win32'

export function leanSettings(): LeanSettings {
  return { ...DEFAULT_LEAN_SETTINGS, ...(getSettings().lean ?? {}) }
}

/** `~/x` → `"$HOME/x"` (quoted, safe to paste in a bash script). */
function shWorkspace(): string {
  const ws = leanSettings().workspace.trim() || DEFAULT_LEAN_SETTINGS.workspace
  return `"${ws.replace(/^~(?=\/|$)/, '$HOME').replace(/"/g, '')}"`
}

/** C:\Users\a\b → /mnt/c/Users/a/b (WSL view of a Windows path). */
export function toLinuxPath(p: string): string {
  if (!IS_WIN) return p
  const abs = path.resolve(p)
  const m = /^([A-Za-z]):\\(.*)$/.exec(abs)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : abs.replace(/\\/g, '/')
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const PRELUDE = 'export PATH="$HOME/.elan/bin:$HOME/.local/bin:$HOME/.local/go/bin:$PATH"\nexport LC_ALL=C.UTF-8\n'

/**
 * Run a bash script in the Linux environment. The script is sent on stdin
 * (no Windows command-line quoting). Long jobs run in their own process group
 * so that a cancel or a timeout kills lake/lean/comparator, not just wsl.exe.
 */
export async function linuxExec(script: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult> {
  const job = newId('job')
  const body = [
    PRELUDE,
    'mkdir -p /tmp/noesis-jobs',
    `cat > /tmp/noesis-jobs/${job}.sh <<'NOESIS_SCRIPT_EOF'`,
    `echo $$ > /tmp/noesis-jobs/${job}.pid`,
    script,
    'NOESIS_SCRIPT_EOF',
    `setsid --wait bash /tmp/noesis-jobs/${job}.sh`,
    'code=$?',
    `rm -f /tmp/noesis-jobs/${job}.sh /tmp/noesis-jobs/${job}.pid`,
    'exit $code',
  ].join('\n')
  const kill = (): void => {
    void spawnLinux(`p=$(cat /tmp/noesis-jobs/${job}.pid 2>/dev/null) && { kill -TERM -- -$p 2>/dev/null; sleep 3; kill -KILL -- -$p 2>/dev/null; }; rm -f /tmp/noesis-jobs/${job}.*`, 30_000)
  }
  opts.signal?.addEventListener('abort', kill, { once: true })
  const timer = setTimeout(kill, opts.timeoutMs)
  try {
    return await spawnLinux(body, opts.timeoutMs + 30_000, opts.signal)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', kill)
  }
}

async function spawnLinux(script: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  const r = IS_WIN
    ? await execFile('wsl.exe', ['-d', leanSettings().distro || 'Ubuntu', '--', 'bash', '-s'], { cwd: ROOT_DIR, timeoutMs, signal, stdin: `${script}\n`, env: { WSL_UTF8: '1' }, shellLabel: 'wsl' })
    : await execFile('bash', ['-s'], { cwd: ROOT_DIR, timeoutMs, signal, stdin: `${script}\n`, shellLabel: 'bash' })
  // wsl.exe's own messages may still be UTF-16
  return { ...r, stdout: r.stdout.replace(/\0/g, ''), stderr: r.stderr.replace(/\0/g, '') }
}

// ───────────────────────────── status ─────────────────────────────

let status: LeanStatus | undefined
let statusPromise: Promise<LeanStatus> | undefined
const install: NonNullable<LeanStatus['install']> = { running: false, log: '' }

/** Synchronous readiness, used to decide whether the Lean tools are offered to agents. */
export function leanReady(): boolean {
  return Boolean(status?.available && leanSettings().enabled)
}

export function leanStatusCached(): LeanStatus | undefined {
  return status ? { ...status, install: { ...install } } : undefined
}

export async function leanStatus(force = false): Promise<LeanStatus> {
  if (!force && status && Date.now() - status.checkedAt < 10 * 60_000) return { ...status, install: { ...install } }
  statusPromise ??= probe().finally(() => {
    statusPromise = undefined
  })
  status = await statusPromise
  return { ...status, install: { ...install } }
}

async function probe(): Promise<LeanStatus> {
  const ws = shWorkspace()
  const base: LeanStatus = { available: false, comparator: false, landrun: false, lean4export: false, workspace: leanSettings().workspace, distro: IS_WIN ? leanSettings().distro : undefined, checkedAt: Date.now() }
  const script = [
    `cd ${ws} 2>/dev/null || { echo "NO_WORKSPACE"; exit 0; }`,
    'echo "LEAN=$(lean --version 2>/dev/null | head -1)"',
    'test -f .lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean && echo "MATHLIB=$(git -C .lake/packages/mathlib describe --tags --always 2>/dev/null)"',
    'command -v comparator >/dev/null && echo COMPARATOR=1',
    'command -v landrun >/dev/null && echo LANDRUN=1',
    'command -v lean4export >/dev/null && echo LEAN4EXPORT=1',
  ].join('\n')
  let r: ExecResult
  try {
    r = await spawnLinux(PRELUDE + script, 60_000)
  } catch (error) {
    return { ...base, error: (error as Error).message }
  }
  if (r.exitCode !== 0 && !r.stdout.includes('LEAN=') && !r.stdout.includes('NO_WORKSPACE')) {
    const msg = `${r.stderr} ${r.stdout}`.trim()
    return { ...base, error: IS_WIN ? `WSL ou la distribution « ${leanSettings().distro} » est introuvable (${msg.slice(0, 160) || 'wsl.exe a échoué'})` : msg.slice(0, 200) }
  }
  const out = r.stdout
  const get = (k: string): string | undefined => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() || undefined
  const s: LeanStatus = {
    ...base,
    leanVersion: get('LEAN'),
    mathlib: get('MATHLIB'),
    comparator: out.includes('COMPARATOR=1'),
    landrun: out.includes('LANDRUN=1'),
    lean4export: out.includes('LEAN4EXPORT=1'),
  }
  if (out.includes('NO_WORKSPACE')) return { ...s, error: 'Environnement Lean non installé' }
  if (!s.leanVersion) return { ...s, error: 'Lean introuvable (elan non installé)' }
  if (!s.mathlib) return { ...s, error: 'Mathlib précompilée absente de l\'espace partagé' }
  if (!s.comparator || !s.landrun || !s.lean4export) return { ...s, available: false, error: 'Comparator, landrun ou lean4export manquant' }
  return { ...s, available: true }
}

/** Runs scripts/lean/setup-wsl.sh in the background; progress is read through leanStatus(). */
export function startLeanInstall(): { started: boolean; reason?: string } {
  if (install.running) return { started: false, reason: 'Installation déjà en cours' }
  install.running = true
  install.ok = undefined
  install.startedAt = Date.now()
  install.finishedAt = undefined
  install.log = ''
  const script = toLinuxPath(path.join(ROOT_DIR, 'scripts', 'lean', 'setup-wsl.sh'))
  const ws = leanSettings().workspace.replace(/^~(?=\/|$)/, '$HOME')
  void (async () => {
    try {
      const r = await linuxExec(`NOESIS_LEAN_WORKSPACE="${ws}" bash ${shQuote(script)} 2>&1 | tr '\\r' '\\n' | grep -v '^Downloaded: ' | tee /tmp/noesis-lean-install.log\nexit \${PIPESTATUS[0]}`, { timeoutMs: 4 * 3600_000 })
      install.log = tail(r.stdout + r.stderr, 60)
      install.ok = r.exitCode === 0 && r.stdout.includes('NOESIS_LEAN_READY')
    } catch (error) {
      install.log += `\n${(error as Error).message}`
      install.ok = false
    } finally {
      install.running = false
      install.finishedAt = Date.now()
      await leanStatus(true).catch(() => undefined)
    }
  })()
  void pollInstallLog()
  return { started: true }
}

async function pollInstallLog(): Promise<void> {
  while (install.running) {
    await new Promise(r => setTimeout(r, 5000))
    if (!install.running) break
    const r = await spawnLinux('tail -n 40 /tmp/noesis-lean-install.log 2>/dev/null', 20_000).catch(() => undefined)
    if (r?.stdout) install.log = r.stdout.trim()
  }
}

function tail(text: string, lines: number): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}

// ───────────────────────────── jobs ─────────────────────────────

/** Mathlib imports take several GB of RAM each: few concurrent Lean processes. */
const leanSem = new Semaphore(2)
/** Comparator runs `lake build` in the shared workspace: one at a time. */
const comparatorSem = new Semaphore(1)

export function leanId(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '')
}

export interface LeanRunResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  output: string
  sorries: number
  durationMs: number
}

/**
 * Elaborate one Lean file against Mathlib (`lake env lean`). The file is copied
 * into Scratch/<project>/ of the shared workspace; errors refer to the original path.
 */
export async function runLeanFile(opts: { projectId: string; file: string; displayPath: string; timeoutSec?: number; signal?: AbortSignal }): Promise<LeanRunResult> {
  const release = await leanSem.acquire()
  try {
    const name = `${leanId(path.basename(opts.file, '.lean')) || 'File'}_${Date.now().toString(36)}`
    const rel = `Scratch/P${leanId(opts.projectId)}/${name}.lean`
    const timeout = Math.min(opts.timeoutSec ?? leanSettings().timeoutSec, 3600)
    prewarmLean()
    const script = [
      `cd ${shWorkspace()}`,
      `mkdir -p "$(dirname ${rel})" && cp ${shQuote(toLinuxPath(opts.file))} ${rel}`,
      // cached LEAN_PATH skips `lake env` (1 to 10 s); fall back to it when the cache is gone
      `if [ -s ${LEAN_PATH_CACHE} ]; then LEAN_PATH="$(cat ${LEAN_PATH_CACHE})" timeout -k 10 ${timeout} lean ${rel} 2>&1; else timeout -k 10 ${timeout} lake env lean ${rel} 2>&1; fi`,
      'code=$?',
      `rm -f ${rel}`,
      'exit $code',
    ].join('\n')
    const r = await linuxExec(script, { timeoutMs: (timeout + 60) * 1000, signal: opts.signal })
    const output = r.stdout.split(rel).join(opts.displayPath).trim()
    return {
      ok: r.exitCode === 0 && !/: error[:(]/.test(output),
      exitCode: r.exitCode,
      timedOut: r.exitCode === 124 || r.timedOut,
      output,
      sorries: (output.match(/declaration uses [`']sorry[`']/g) ?? []).length,
      durationMs: r.durationMs,
    }
  } finally {
    release()
  }
}

export interface ComparatorResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  output: string
  durationMs: number
}

/**
 * Comparator: builds Challenge and Solution in a landrun sandbox, exports both
 * with lean4export, checks that each theorem of the Solution has exactly the
 * Challenge's statement, uses only permitted axioms, and replays it in the kernel.
 */
export async function runComparator(opts: { projectId: string; checkId: string; challenge: string; solution: string; theorems: string[]; definitions: string[]; timeoutSec?: number; signal?: AbortSignal }): Promise<ComparatorResult> {
  const release = await comparatorSem.acquire()
  prewarmLean()
  try {
    const dir = `Checks/P${leanId(opts.projectId)}/C${leanId(opts.checkId)}`
    const mod = dir.replace(/\//g, '.')
    const config = {
      challenge_module: `${mod}.Challenge`,
      solution_module: `${mod}.Solution`,
      theorem_names: opts.theorems,
      definition_names: opts.definitions,
      permitted_axioms: STANDARD_AXIOMS,
      enable_nanoda: false,
    }
    const timeout = Math.min(opts.timeoutSec ?? leanSettings().timeoutSec, 3600)
    const script = [
      `cd ${shWorkspace()}`,
      `rm -rf ${dir} && mkdir -p ${dir}`,
      `cp ${shQuote(toLinuxPath(opts.challenge))} ${dir}/Challenge.lean`,
      `cp ${shQuote(toLinuxPath(opts.solution))} ${dir}/Solution.lean`,
      `cat > ${dir}/config.json <<'NOESIS_JSON_EOF'\n${JSON.stringify(config, null, 2)}\nNOESIS_JSON_EOF`,
      `timeout -k 10 ${timeout} lake env comparator ${dir}/config.json 2>&1`,
    ].join('\n')
    const r = await linuxExec(script, { timeoutMs: (timeout + 60) * 1000, signal: opts.signal })
    return { ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.exitCode === 124 || r.timedOut, output: r.stdout.trim(), durationMs: r.durationMs }
  } finally {
    release()
  }
}

/** grep in the Mathlib sources of the shared workspace (lemma names, statements). */
export async function searchMathlib(pattern: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<string> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 150)
  const script = [
    `cd ${shWorkspace()}/.lake/packages/mathlib || exit 3`,
    `cat > /tmp/noesis-jobs/pattern.$$ <<'NOESIS_PATTERN_EOF'\n${pattern.replace(/\n/g, ' ')}\nNOESIS_PATTERN_EOF`,
    `grep -rnE --include='*.lean' -f /tmp/noesis-jobs/pattern.$$ Mathlib | head -n ${limit}`,
    'rm -f /tmp/noesis-jobs/pattern.$$',
  ].join('\n')
  const r = await linuxExec(script, { timeoutMs: 120_000, signal: opts.signal })
  if (r.exitCode === 3) throw new Error('Mathlib introuvable dans l\'espace Lean partagé')
  return r.stdout.trim()
}

const LEAN_PATH_CACHE = '/tmp/noesis-leanpath'
let keepalive: ChildProcess | undefined
let warming: Promise<void> | undefined

/**
 * `import Mathlib` reads ~5 GB of .olean files: ~45 s from a cold disk cache,
 * ~4 s warm. WSL shuts its VM down when idle, dropping the cache, so while
 * formal work is going on we keep the VM alive and pre-read Mathlib once.
 */
export function prewarmLean(): void {
  if (!leanReady()) return
  if (IS_WIN && !keepalive) {
    keepalive = spawn('wsl.exe', ['-d', leanSettings().distro || 'Ubuntu', '--', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' })
    // never keeps Node alive by itself (CLI scripts must be able to exit)
    keepalive.unref()
    keepalive.on('exit', () => {
      keepalive = undefined
    })
    process.once('exit', () => keepalive?.kill())
  }
  warming ??= linuxExec([
    `cd ${shWorkspace()}`,
    `lake env printenv LEAN_PATH > ${LEAN_PATH_CACHE}.tmp && mv ${LEAN_PATH_CACHE}.tmp ${LEAN_PATH_CACHE}`,
    'nice -n 10 find .lake/packages -name "*.olean" -print0 | nice -n 10 xargs -0 cat > /dev/null',
  ].join('\n'), { timeoutMs: 15 * 60_000 }).then(() => undefined, () => {
    warming = undefined
  })
}

/** Stop keeping WSL awake (no formal work running anymore). */
export function releaseLeanKeepalive(): void {
  keepalive?.kill()
  keepalive = undefined
  warming = undefined
}

/** Ensure the status is known at startup (tools are offered only when ready). */
export function warmLeanStatus(): void {
  void leanStatus(true).catch(() => undefined)
}

/** True when the repository ships the setup script (used by the settings page). */
export function setupScriptPresent(): boolean {
  return fs.existsSync(path.join(ROOT_DIR, 'scripts', 'lean', 'setup-wsl.sh'))
}
