/**
 * Smoke test of the built-in tools without any LLM (real network).
 * Usage: npm test   (uses ./data-test unless NOESIS_DATA_DIR is set)
 */
import path from 'node:path'
import type { AgentRuntime, ToolContext } from '../server/tools/types.ts'

// never touch the real data directory from a test
process.env.NOESIS_DATA_DIR ??= path.resolve('data-test')
const { createProject } = await import('../server/store/projects.ts')
const { createAgent } = await import('../server/store/conversation.ts')
const { workspaceDir } = await import('../server/config.ts')
const { getTool } = await import('../server/tools/registry.ts')

const project = createProject({ title: 'Smoke', question: 'Test des outils', domain: 'test' })
const agent = createAgent({ projectId: project.id, role: 'lead', name: 'Noesis' })
const runtime = new Proxy({}, { get: () => async () => { throw new Error('runtime not available in smoke test') } }) as unknown as AgentRuntime
const ctx: ToolContext = { project, agent, workspace: workspaceDir(project.id), signal: new AbortController().signal, runtime, toolRunId: 'x', toolCallId: 'x' }

let failures = 0
async function t(name: string, args: Record<string, unknown>, expect?: (out: string, status: string) => boolean): Promise<void> {
  const started = Date.now()
  try {
    const out = await getTool(name)!.execute(args, ctx)
    const text = typeof out === 'string' ? out : out.content
    const status = typeof out === 'string' ? 'ok' : out.status ?? 'ok'
    const pass = expect ? expect(text, status) : status === 'ok'
    if (!pass) failures++
    console.log(`\n${pass ? '✔' : '✘'} ${name} ${JSON.stringify(args).slice(0, 80)} (${Date.now() - started} ms, ${status})\n${text.slice(0, 420)}`)
  } catch (error) {
    // tools signal errors by throwing; the agent receives the message
    const msg = (error as Error).message
    const pass = expect ? expect(msg, 'thrown') : false
    if (!pass) failures++
    console.log(`\n${pass ? '✔' : '✘'} ${name} (${Date.now() - started} ms, erreur levée)\n${msg.slice(0, 300)}`)
  }
}

await t('memory_write', { title: 'Seuil du code de surface', content: 'Le seuil est d\'environ 1% pour le bruit dépolarisant circuit-level.', type: 'fact', importance: 4, tags: ['qec'] })
await t('memory_search', { query: 'seuil surface' }, o => o.includes('seuil-du-code-de-surface'))
await t('memory_read', { slug: 'seuil-code-surface' }, o => o.includes('Notes proches'))
await t('python', { code: 'import sympy as sp\nx=sp.symbols("x")\nprint(sp.integrate(sp.exp(-x**2),(x,-sp.oo,sp.oo)))' }, o => o.includes('sqrt(pi)'))
await t('web_search', { query: 'QUIC transport protocol RFC 9000', n: 3 })
await t('paper_search', { query: 'surface code threshold decoder', n: 3 })
await t('paper_search', { query: '"Recursive Network Architecture" "RNA" "Touch" "ISI" "protocol" "stack" 2008', n: 3 }, (o, s) => s === 'ok' || o.includes('Raccourcis'))
await t('paper_lookup', { title: 'Is it still possible to extend TCP?', authors: 'Honda', year: 2011, add: true }, o => /still possible to extend TCP/i.test(o))
await t('paper_citations', { ref: '10.1145/2068816.2068834', direction: 'citations', n: 5 })
await t('paper_add', { arxiv_id: '1208.0928' }, o => o.includes('full_text'))
await t('source_read', { key: 'arXiv:1208.0928', pattern: 'threshold of' }, o => o.includes('occurrence'))
await t('source_search', { query: 'per-step threshold', exact: true }, o => o.includes('fowler'))
await t('fetch_url', { url: 'https://www.rfc-editor.org/rfc/rfc9000.txt', save_as_source: true, max_chars: 300 })
await t('source_read', { key: 'RFC 9000', section: '17.3', max_chars: 400 }, o => /17\.3\.\s+Short Header Packets/.test(o))
await t('fetch_url', { url: 'https://dl.acm.org/doi/10.1145/3098822.3098842', save_as_source: true }, (o, s) => s === 'error' && /anti-bot|refusé|inaccessible/.test(o))
await t('source_list', {}, o => !/just a moment/i.test(o))
await t('file_grep', { pattern: 'Short Header Packets', path: 'sources' }, o => o.includes('17.3'))
console.log(`\n${failures ? `✘ ${failures} échec(s)` : '✔ tous les outils répondent'}\nworkspace: ${workspaceDir(project.id)}`)
process.exit(failures ? 1 : 0)
