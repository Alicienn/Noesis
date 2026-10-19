/**
 * End-to-end test against a running Noesis server + the mock LLM.
 *   npx tsx scripts/mock-llm.ts &
 *   NOESIS_PORT=4399 npx tsx server/index.ts &
 *   API=http://127.0.0.1:4399/api npx tsx scripts/e2e-mock.ts
 */
const API = process.env.API ?? 'http://127.0.0.1:4399/api'
const PROTOCOL = (process.env.PROTOCOL ?? 'openai') as 'openai' | 'anthropic'
const MOCK = process.env.MOCK ?? (PROTOCOL === 'anthropic' ? 'http://127.0.0.1:4398' : 'http://127.0.0.1:4398/v1')
const COMPACT = process.env.COMPACT === '1'

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

const { models } = await call<{ models: Array<{ id: string; contextWindow?: number }> }>('POST', '/providers/discover', { protocol: PROTOCOL, baseURL: MOCK, apiKey: 'test-key' })
assert(models.length === 3 && models.some(m => m.contextWindow === 64000), `discovery: ${models.map(m => m.id).join(', ')}`)
const provider = await call('POST', '/providers', { name: `Mock ${PROTOCOL}`, protocol: PROTOCOL, baseURL: MOCK, apiKey: 'test-key', models })
assert(provider.apiKey?.includes('••••') && provider.hasKey, 'API key masked in responses')
const ref = (id: string): string => `${provider.id}::${id}`
const test = await call('POST', '/providers/test', { model: ref('mock-researcher') })
assert(test.answer === 'pong', `model test: ${test.answer} (${test.latencyMs} ms)`)

await call('PUT', '/settings', {
  models: {
    lead: { model: ref('mock-researcher') }, supervisor: { model: ref('mock-fast') }, verifier: { model: ref('mock-fast') },
    subagent: { model: ref('mock-fast') }, utility: { model: ref('mock-fast') }, embedding: { model: PROTOCOL === 'openai' ? ref('mock-embed') : '' },
  },
  notifications: { windowsToast: false },
})

const project = await call('POST', '/projects', { title: 'E2E', question: 'Quel est le seuil du code de surface ?', domain: 'physique', config: { supervisorEvery: 3, permission: 'smart', ...(COMPACT ? { compactAt: 0.03 } : {}) } })
await call('POST', `/projects/${project.id}/start`)

const started = Date.now()
let approvals = 0
while (Date.now() - started < 120_000) {
  await new Promise(r => setTimeout(r, 700))
  const reqs = await call<any[]>('GET', `/projects/${project.id}/requests`)
  for (const r of reqs.filter(r => r.status === 'pending' && r.kind === 'approval')) {
    approvals++
    await call('POST', `/requests/${r.id}/resolve`, { response: 'Refuser' })
  }
  const snap = await call('GET', `/projects/${project.id}`)
  if (['finished', 'error', 'paused', 'idle'].includes(snap.project.status) && Date.now() - started > 3000) break
}

const snap = await call('GET', `/projects/${project.id}`)
console.log(`\nstatus: ${snap.project.status} · steps: ${snap.project.stats.steps} · tokens: ${snap.project.stats.promptTokens}`)
assert(snap.project.status === 'finished', 'run finished via finish_research')
assert(approvals === 1, `approval requested for risky bash (${approvals})`)
const denied = snap.toolRuns.find((r: any) => r.tool === 'bash')
assert(denied?.status === 'denied', `risky command denied (${denied?.status})`)
const roles = snap.agents.map((a: any) => `${a.role}:${a.status}`)
console.log('agents:', roles.join(', '))
assert(snap.agents.some((a: any) => a.role === 'scout' && a.status === 'done'), 'scout sub-agent completed')
assert(snap.agents.some((a: any) => a.role === 'experimenter' && a.status === 'done'), 'experimenter sub-agent completed in parallel')
assert(snap.agents.some((a: any) => a.role === 'verifier'), 'verifier ran (auto-verification)')
assert(snap.agents.some((a: any) => a.role === 'supervisor'), 'supervisor ran')
assert(snap.bus.some((b: any) => b.from === 'supervisor'), 'supervisor messaged the lead')
const notes = await call<any[]>('GET', `/projects/${project.id}/notes`)
const finding = notes.find(n => n.type === 'finding')
assert(finding?.verification?.verdict === 'supported', `finding verified: ${finding?.verification?.verdict}`)
const hyps = await call<any[]>('GET', `/projects/${project.id}/hypotheses`)
assert(hyps.length === 2 && hyps.some(h => h.matches > 0), `tournament Elo: ${hyps.map(h => h.elo).join('/')}`)
const files = await call<any[]>('GET', `/projects/${project.id}/files?path=reports`)
assert(files.some(f => f.name.endsWith('.md')), 'report written')
const finishes = snap.toolRuns.filter((r: any) => r.tool === 'finish_research')
assert(finishes.length === 2 && finishes[0].status === 'error' && /citation absente/.test(finishes[0].result ?? ''), `audit refused the first report with an invented citation (${finishes.map((f: any) => f.status).join(',')})`)
const report = await (await fetch(`${API}/projects/${project.id}/files/raw?path=reports/rapport-final.md`)).text()
assert(report.includes('Annexes générées par Noesis') && report.includes('seuil-circuit-level-1'), 'accepted report carries the database-generated annex')
const blocks2 = await call<any[]>('GET', `/projects/${project.id}/blocks`)
assert(blocks2.find(b => b.label === 'mission')?.value.includes('Livrables exigés'), 'deliverables extracted into the mission block')
const blocks = await call<any[]>('GET', `/projects/${project.id}/blocks`)
assert(blocks.find(b => b.label === 'lessons')?.value.includes('source primaire'), 'supervisor lesson stored in core memory')
if (COMPACT) {
  const eps = await call<any[]>('GET', `/projects/${project.id}/episodes`)
  assert(eps.length > 0, `compaction produced ${eps.length} episode(s)`)
}
const semantic = await call<any[]>('GET', `/projects/${project.id}/notes?q=${encodeURIComponent('seuil circuit')}`)
assert(semantic.length > 0, 'hybrid memory search works')
console.log('\nlead transcript:')
for (const m of snap.messages) console.log(`  [${m.role}${m.name ? `:${m.name}` : ''}${m.meta?.origin ? `/${m.meta.origin}` : ''}] ${String(m.content).replace(/\s+/g, ' ').slice(0, 110)}`)
