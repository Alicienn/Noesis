/**
 * Cancel & timeout of a long tool action (needs mock LLM + server, settings from e2e-mock.ts).
 *   API=http://127.0.0.1:4399/api npx tsx scripts/e2e-cancel.ts
 */
const API = process.env.API ?? 'http://127.0.0.1:4399/api'

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json()
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`)
  return j as T
}
const assert = (cond: unknown, msg: string): void => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`)
  if (!cond) process.exitCode = 1
}
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function runUntil(projectId: string, pred: (snap: any) => boolean, ms = 60_000): Promise<any> {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const snap = await call('GET', `/projects/${projectId}`)
    if (pred(snap)) return snap
    await wait(500)
  }
  return call('GET', `/projects/${projectId}`)
}

// 1. manual stop
{
  const p = await call('POST', '/projects', { title: 'Cancel', question: 'TEST_LONG_ACTION', config: { permission: 'auto', supervisorEvery: 0 } })
  await call('POST', `/projects/${p.id}/start`)
  const snap = await runUntil(p.id, s => s.toolRuns.some((r: any) => r.tool === 'bash' && r.status === 'running'))
  const run = snap.toolRuns.find((r: any) => r.tool === 'bash')
  assert(run?.status === 'running', 'long bash action is running')
  await wait(1500)
  const started = Date.now()
  await call('POST', `/tool-runs/${run.id}/cancel`)
  const end = await runUntil(p.id, s => s.project.status === 'finished', 30_000)
  const after = end.toolRuns.find((r: any) => r.id === run.id)
  assert(after?.status === 'cancelled', `action marked cancelled (${after?.status})`)
  assert(Date.now() - started < 15_000, `agent resumed quickly (${Date.now() - started} ms)`)
  assert(end.project.status === 'finished', 'agent continued and finished after the stop')
  const toolMsg = end.messages.find((m: any) => m.role === 'tool' && m.name === 'bash')
  assert(/interrompue manuellement/.test(toolMsg?.content ?? ''), 'agent was told the action was stopped by the human')
}

// 2. timeout
{
  const p = await call('POST', '/projects', { title: 'Timeout', question: 'TEST_HANG', config: { permission: 'auto', supervisorEvery: 0, toolTimeoutSec: 3 } })
  await call('POST', `/projects/${p.id}/start`)
  const started = Date.now()
  const end = await runUntil(p.id, s => s.project.status === 'finished', 60_000)
  const run = end.toolRuns.find((r: any) => r.tool === 'fetch_url')
  assert(run?.status === 'timeout', `hanging action stopped by the timeout (${run?.status}, ${run?.durationMs} ms)`)
  assert(Date.now() - started < 20_000, 'timeout fired close to the configured 3 s')
  assert(end.project.status === 'finished', 'agent continued after the timeout')
}

// 3. verifier that never concludes by itself → forced final turn returns a real verdict (no keyword guessing)
{
  const p = await call('POST', '/projects', { title: 'STALL', question: 'Quel est le seuil du code de surface ?', config: { permission: 'auto', supervisorEvery: 0 } })
  await call('POST', `/projects/${p.id}/start`)
  await runUntil(p.id, s => s.project.status === 'finished', 120_000)
  // auto-verification runs in background: wait for its verdict
  let note: any
  for (let i = 0; i < 60 && !(note?.verification && note.verification.verdict !== 'pending'); i++) {
    note = (await call<any[]>('GET', `/projects/${p.id}/notes`)).find(n => n.type === 'finding')
    await wait(500)
  }
  assert(note?.verification?.verdict === 'supported' && note.verification.confidence === 0.85, `stalled verifier forced to submit a structured verdict (${note?.verification?.verdict} ${note?.verification?.confidence})`)
  const verifier = (await call('GET', `/projects/${p.id}`)).agents.find((a: any) => a.role === 'verifier')
  assert(verifier?.steps >= 14, `verifier used its auto-verification budget of 14 steps (${verifier?.steps})`)
}

// 4. a contested audit point: refused once, then accepted with the objection written in the annex
{
  const p = await call('POST', '/projects', { title: 'Contest', question: 'TEST_CONTEST', config: { permission: 'auto', supervisorEvery: 0 } })
  await call('POST', `/projects/${p.id}/start`)
  const end = await runUntil(p.id, s => ['finished', 'error', 'paused'].includes(s.project.status), 60_000)
  const finishes = end.toolRuns.filter((r: any) => r.tool === 'finish_research').map((r: any) => r.status)
  assert(end.project.status === 'finished' && finishes.join(',') === 'error,ok', `contested point: refused then accepted (${finishes.join(',')})`)
  const report = await (await fetch(`${API}/projects/${p.id}/files/raw?path=reports/rapport.md`)).text()
  assert(report.includes('Points contestés par l\'agent') && report.includes('clé de test volontaire'), 'objection written in the report annex for the human')
}
