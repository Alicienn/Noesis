import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getSettings } from '../settings.ts'

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  shell: string
}

const MAX_CAPTURE = 2_000_000

let cachedShell: { kind: 'bash' | 'powershell' | 'cmd' | 'sh'; path: string } | undefined

export function detectShell(): { kind: 'bash' | 'powershell' | 'cmd' | 'sh'; path: string } {
  const pref = getSettings().shell.preferred
  if (cachedShell && pref === 'auto') return cachedShell
  if (process.platform !== 'win32') return (cachedShell = { kind: 'bash', path: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh' })
  const gitBash = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].find(p => fs.existsSync(p))
  if ((pref === 'auto' || pref === 'bash') && gitBash) return (cachedShell = { kind: 'bash', path: gitBash })
  if (pref === 'cmd') return { kind: 'cmd', path: 'cmd.exe' }
  const pwsh = spawnSync('where', ['pwsh'], { encoding: 'utf8' }).stdout?.split(/\r?\n/)[0]?.trim()
  return (cachedShell = { kind: 'powershell', path: pwsh || 'powershell.exe' })
}

export function resetShellCache(): void {
  cachedShell = undefined
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }
}

export function execCommand(command: string, opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; stdin?: string }): Promise<ExecResult> {
  const sh = detectShell()
  const args = sh.kind === 'bash' || sh.kind === 'sh'
    ? ['-lc', command]
    : sh.kind === 'powershell'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]
      : ['/d', '/s', '/c', command]
  return execFile(sh.path, args, { ...opts, shellLabel: sh.kind })
}

export function execFile(file: string, args: string[], opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; stdin?: string; shellLabel?: string }): Promise<ExecResult> {
  const started = Date.now()
  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', MPLBACKEND: 'Agg', ...(opts.env ?? {}) },
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8')
    })
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin)
    }
    child.stdin.end()
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, opts.timeoutMs ?? 120_000)
    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code: number | null, err?: Error): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: code,
        stdout,
        stderr: err ? `${stderr}\n${err.message}` : stderr,
        timedOut,
        durationMs: Date.now() - started,
        shell: opts.shellLabel ?? path.basename(file),
      })
    }
    child.on('error', err => finish(-1, err))
    child.on('close', code => finish(code))
  })
}

// ───────────────────────────── Risk assessment ─────────────────────────────

const RISKY: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*(\s\/|\s~|\s\*|\s\.\.|[A-Z]:)/i, 'suppression récursive large'],
  [/\b(rmdir|rd)\s+\/s\b/i, 'suppression récursive (Windows)'],
  [/\bRemove-Item\b.*-Recurse/i, 'suppression récursive (PowerShell)'],
  [/\b(del|erase)\s+\/[sq]/i, 'suppression de masse (Windows)'],
  [/\b(format|mkfs|diskpart|fdisk|dd\s+if=)/i, 'opération disque'],
  [/\b(shutdown|reboot|halt|poweroff|Stop-Computer|Restart-Computer)\b/i, 'arrêt système'],
  [/\b(reg\s+(add|delete)|Set-ItemProperty\s+.*HKLM|bcdedit|schtasks|sc\s+(create|delete|config))\b/i, 'modification système'],
  [/\b(git\s+push|npm\s+publish|twine\s+upload|gh\s+(pr|release|repo)\s+(create|delete))\b/i, 'publication externe'],
  [/\bcurl\b.*\s(-X\s*(POST|PUT|DELETE)|--data|-d\s)/i, 'requête HTTP sortante avec données'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork bomb'],
  [/\b(chmod|chown)\s+-R\s+.*\//, 'permissions récursives'],
  [/\bInvoke-WebRequest\b.*-Method\s+(Post|Put|Delete)/i, 'requête HTTP sortante avec données'],
  [/(^|\s)(sudo|runas)\s/i, 'élévation de privilèges'],
  [/\b(ssh|scp|rsync)\s/i, 'connexion distante'],
  [/>\s*\/dev\/sd|\\\\\.\\PhysicalDrive/i, 'écriture disque brute'],
]

export function assessRisk(command: string, workspace: string): string | undefined {
  for (const [re, label] of RISKY) if (re.test(command)) return label
  // absolute paths outside workspace being written
  const writesOutside = /(>|>>|\b(cp|mv|Copy-Item|Move-Item|Out-File|Set-Content)\b)[^\n]*([A-Z]:\\|\/[a-z]\/|~\/)/i.test(command)
  if (writesOutside) {
    const ws = workspace.replace(/\\/g, '/').toLowerCase()
    const norm = command.replace(/\\/g, '/').toLowerCase()
    if (!norm.includes(ws)) return 'écriture hors du workspace'
  }
  return undefined
}

export function formatExec(r: ExecResult, maxChars: number): string {
  const parts: string[] = []
  parts.push(`[${r.shell}] exit=${r.exitCode}${r.timedOut ? ' (TIMEOUT — processus tué)' : ''} · ${r.durationMs} ms`)
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.floor(n * 0.4))}\n… [${s.length - n} caractères omis] …\n${s.slice(s.length - Math.floor(n * 0.6))}` : s)
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${cut(r.stdout.trimEnd(), maxChars)}`)
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${cut(r.stderr.trimEnd(), Math.floor(maxChars / 2))}`)
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(aucune sortie)')
  return parts.join('\n')
}
