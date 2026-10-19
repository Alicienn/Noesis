/**
 * Scripted OpenAI-compatible LLM for end-to-end tests of the harness without
 * spending tokens. It recognises each agent by its system prompt and plays a
 * deterministic research scenario exercising every subsystem.
 *
 * Usage: npx tsx scripts/mock-llm.ts   (listens on :4398, base URL http://127.0.0.1:4398/v1)
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 4398)

type Msg = { role: string; content: string | null; tool_calls?: unknown[] }
type Call = { name: string; args: Record<string, unknown> }
type Turn = { text?: string; reasoning?: string; calls?: Call[] }

function leadTurn(step: number): Turn {
  switch (step) {
    case 0: return {
      reasoning: 'Je dois d\'abord cadrer la question et vérifier la mémoire.',
      text: 'Je cadre la question et je vérifie ce que la mémoire contient déjà.',
      calls: [
        { name: 'update_plan', args: { plan: '- [ ] État de l\'art sur le seuil\n- [ ] Simulation jouet\n- [ ] Vérification\n- [ ] Rapport' } },
        { name: 'memory_search', args: { query: 'seuil code de surface' } },
      ],
    }
    case 1: return { text: 'Recherche bibliographique initiale.', calls: [{ name: 'paper_search', args: { query: 'surface code threshold', n: 3, backends: ['arxiv'] } }] }
    case 2: return {
      text: 'Je délègue en parallèle une revue de littérature et une simulation.',
      calls: [
        { name: 'delegate', args: { role: 'scout', task: 'Trouver les estimations du seuil du code de surface.', max_steps: 4 } },
        { name: 'delegate', args: { role: 'experimenter', task: 'Simuler un code de répétition jouet.', max_steps: 4 } },
      ],
    }
    case 3: return { text: 'Petit calcul de contrôle.', calls: [{ name: 'python', args: { code: 'p=0.01\nprint("p_L ~", 0.1*(p/0.0103)**((5+1)/2))' } }] }
    case 4: return { text: 'Je consigne le résultat central (il sera vérifié automatiquement).', calls: [{ name: 'memory_write', args: { title: 'Seuil circuit-level ≈ 1 %', content: 'Le seuil du code de surface sous bruit dépolarisant circuit-level est ≈ 1 % (Fowler 2012).', type: 'finding', importance: 5, confidence: 0.8, sources: [] } }] }
    case 5: return {
      text: 'Deux hypothèses concurrentes.',
      calls: [
        { name: 'hypothesis_add', args: { statement: 'Le seuil dépend surtout du décodeur', test_plan: 'MWPM vs UF' } },
        { name: 'hypothesis_add', args: { statement: 'Le seuil dépend surtout du modèle de bruit', test_plan: 'code capacity vs circuit' } },
      ],
    }
    case 6: return { text: 'Tournoi pour prioriser.', calls: [{ name: 'hypothesis_tournament', args: { rounds: 2 } }] }
    case 7: return { text: 'Commande risquée pour tester l\'approbation.', calls: [{ name: 'bash', args: { command: 'git push origin main' } }] }
    // first draft cites a reference that is not in the library: the audit must refuse to finish
    case 8: return { text: 'Rédaction du rapport.', calls: [{ name: 'write_report', args: { title: 'Rapport final', filename: 'rapport-final', content: '# Rapport\n\nLe seuil est ≈ 1 % [[seuil-circuit-level-1]] selon [inventee2020seuil]. Tous les résultats ont été vérifiés.' } }] }
    case 9: return { text: 'Terminé.', calls: [{ name: 'finish_research', args: { summary: 'Seuil ≈ 1 %.' } }] }
    case 10: return { text: 'Je corrige le rapport selon l\'audit.', calls: [{ name: 'write_report', args: { title: 'Rapport final', filename: 'rapport-final', content: '# Rapport\n\nLe seuil est ≈ 1 % [[seuil-circuit-level-1]].\n\n## Livrables\n- Estimation du seuil : réalisé.' } }] }
    case 11: return { text: 'Terminé.', calls: [{ name: 'finish_research', args: { summary: 'Seuil ≈ 1 %, rapport audité.' } }] }
    default: return { text: 'Rien de plus.' }
  }
}

let leadStep = 0

/** Minimal report so the finish audit has something to accept. */
const SHORT_REPORT: Call = { name: 'write_report', args: { title: 'Rapport', filename: 'rapport', content: '# Rapport\n\nTest technique sans résultat.\n\n## Livrables\n- Aucun (test).' } }

function respond(messages: Msg[], toolNames: string[] = []): Turn | { json: unknown } | { plain: string } {
  const system = String(messages.find(m => m.role === 'system')?.content ?? '')
  const assistantCount = messages.filter(m => m.role === 'assistant').length
  const lastUser = String([...messages].reverse().find(m => m.role === 'user')?.content ?? '')
  if (lastUser.includes('pong')) return { plain: 'pong' }
  if (system.includes('chercheur principal d\'un laboratoire') && system.includes('TEST_HANG')) {
    if (assistantCount === 0) return { text: 'Lecture d\'une page qui ne répond pas.', calls: [{ name: 'fetch_url', args: { url: `http://127.0.0.1:${PORT}/hang` } }] }
    return { text: 'Tant pis.', calls: [SHORT_REPORT, { name: 'finish_research', args: { summary: 'ok' } }] }
  }
  if (system.includes('chercheur principal d\'un laboratoire') && system.includes('TEST_LONG_ACTION')) {
    // scenario for cancel / timeout tests: one very long command, then finish
    if (assistantCount === 0) return { text: 'Commande longue.', calls: [{ name: 'bash', args: { command: 'sleep 300', timeout_s: 600 } }] }
    return { text: 'Je change d\'approche.', calls: [SHORT_REPORT, { name: 'finish_research', args: { summary: 'ok' } }] }
  }
  if (system.includes('chercheur principal d\'un laboratoire') && system.includes('TEST_CONTEST')) {
    // an audit point the lead considers a false positive: audit, refused finish, then contested finish
    const report: Call = { name: 'write_report', args: { title: 'Rapport', filename: 'rapport', content: '# Rapport\n\nRésultat tiré de [inventee2020seuil].\n\n## Livrables\n- Aucun (test).' } }
    if (assistantCount === 0) return { text: 'Rapport puis audit.', calls: [report, { name: 'report_audit', args: {} }] }
    if (assistantCount === 1) return { text: 'Je tente de clôturer.', calls: [{ name: 'finish_research', args: { summary: 'ok' } }] }
    return { text: 'Faux positif selon moi.', calls: [{ name: 'finish_research', args: { summary: 'ok', contested: ['[inventee2020seuil] : clé de test volontaire, pas une référence réelle'] } }] }
  }
  if (system.includes('chercheur principal d\'un laboratoire') && system.includes('TEST_DOCS')) {
    // documents provided by the human: visible in the prompt, readable, and announced mid-run
    const seen = system.match(/<documents_fournis nombre="(\d+)" non_ouverts="(\d+)"/)
    const tag = `DOCS_SEEN=${seen?.[1] ?? 0} UNOPENED=${seen?.[2] ?? 0}`
    if (assistantCount === 0) return { text: `${tag} Je survole les documents fournis.`, calls: [{ name: 'source_list', args: { origin: 'human' } }, { name: 'source_search', args: { query: 'seuil code surface' } }] }
    if (assistantCount === 1) return { text: `${tag} J'attends un peu.`, calls: [{ name: 'bash', args: { command: 'sleep 9' } }] }
    const announced = messages.some(m => m.role === 'user' && String(m.content).includes('J\'ai ajouté'))
    return { text: `${tag} ANNOUNCED=${announced}`, calls: [SHORT_REPORT, { name: 'finish_research', args: { summary: 'ok' } }] }
  }
  if (system.includes('chercheur principal d\'un laboratoire')) {
    // after compaction the visible history shrinks, so keep our own step counter
    if (assistantCount === 0 && !system.includes('<historique_compacte>')) leadStep = 0
    return leadTurn(leadStep++)
  }
  if (system.includes('Tu es le **Superviseur**')) {
    return { json: { status: 'on_track', severity: 'warn', assessment: 'Progression correcte mais aucune source primaire lue.', suggestions: ['Lire Fowler 2012 en détail'], message_to_lead: 'Pense à lire la source primaire.', lessons: ['Toujours lire la source primaire avant de conclure'] } }
  }
  if (system.includes('auditeur méthodologique')) return { json: { deliverables: [{ item: 'Estimer le seuil', status: 'couvert' }], contradictions: [], overclaims: [], unsupported: [], verdict: 'conforme' } }
  if (system.includes('LIVRABLES attendus')) return { json: { deliverables: ['Estimer le seuil du code de surface'], constraints: [] } }
  if (system.includes('module de compaction')) return { json: { summary: '## État\nRésumé de test.', notes: [] } }
  if (system.includes('**Bibliothécaire**')) return { json: { operations: [{ op: 'lesson', text: 'Consolider régulièrement' }] } }
  if (system.includes('résumé abrégé du raisonnement')) {
    const first = /^1\. /m.test(lastUser) ? [1] : []
    return { json: { title: 'Seuil du code de surface', sections: [{ heading: 'Cadrage et littérature', paragraphs: ['La recherche part de la littérature sur le seuil.'], excerpts: first }, { heading: 'Vérification', paragraphs: ['Le seuil est contrôlé par un calcul.'], excerpts: [] }] } }
  }
  if (system.includes('juge dans un tournoi')) return { json: { debate: 'A plus testable.', winner: 'A', reason: 'test' } }
  if (system.includes('Tu es le **Vérificateur**') && system.includes('STALL') && toolNames.length > 1) {
    // a verifier that never concludes by itself: exercises the forced final turn
    return { text: 'Encore un calcul.', calls: [{ name: 'python', args: { code: 'print(1)' } }] }
  }
  if (system.includes('Tu es le **Vérificateur**')) {
    if (assistantCount === 0) return { text: 'Je recalcule.', calls: [{ name: 'python', args: { code: 'print(0.0103 > 0.009)' } }] }
    return { calls: [{ name: 'submit_verdict', args: { verdict: 'supported', confidence: 0.85, summary: 'Valeur cohérente avec la littérature.', issues: ['Dépend du décodeur'] } }] }
  }
  if (system.includes('t\'a confié une mission')) {
    if (assistantCount === 0) return { text: 'Je consulte la mémoire.', calls: [{ name: 'memory_search', args: { query: 'seuil' } }] }
    return { calls: [{ name: 'submit_result', args: { report: 'Seuil ≈ 1 % (circuit-level), ≈ 10 % (code capacity).' } }] }
  }
  if (system.includes('budget est épuisé')) return { plain: 'Rapport forcé de test.' }
  return { plain: 'ok' }
}

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

const server = http.createServer((req, res) => {
  if (req.url === '/hang') return // never answers: exercises tool timeouts
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-researcher', context_length: 64000 }, { id: 'mock-fast', context_length: 32000 }, { id: 'mock-embed' }] }))
    return
  }
  if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const input: string[] = JSON.parse(body).input
      const vec = (s: string): number[] => Array.from({ length: 16 }, (_, i) => [...s].reduce((a, c, j) => a + ((c.charCodeAt(0) * (j + 1) * (i + 3)) % 97), 0) % 13)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: input.map((s, index) => ({ index, embedding: vec(s) })) }))
    })
    return
  }
  if (req.method === 'POST' && req.url?.endsWith('/messages')) {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => void anthropic(JSON.parse(body), res))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', async () => {
    const payload = JSON.parse(body)
    const out = respond(payload.messages, (payload.tools ?? []).map((t: any) => t.function?.name))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'mock', object: 'chat.completion.chunk', model: payload.model }
    const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
    const streamText = async (text: string, field: 'content' | 'reasoning_content'): Promise<void> => {
      for (const piece of text.match(/.{1,12}/gs) ?? []) {
        sse(res, { ...base, choices: [{ index: 0, delta: { [field]: piece } }] })
        await delay(15)
      }
    }
    if ('json' in out) await streamText(JSON.stringify(out.json), 'content')
    else if ('plain' in out) await streamText(out.plain, 'content')
    else {
      if (out.reasoning) await streamText(out.reasoning, 'reasoning_content')
      if (out.text) await streamText(out.text, 'content')
      for (const [i, c] of (out.calls ?? []).entries()) {
        const args = JSON.stringify(c.args)
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: 'function', function: { name: c.name, arguments: '' } }] } }] })
        for (const piece of args.match(/.{1,20}/gs) ?? []) {
          sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: piece } }] } }] })
        }
      }
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'calls' in out && out.calls?.length ? 'tool_calls' : 'stop' }] })
    sse(res, { ...base, choices: [], usage: { prompt_tokens: Math.round(1200 + body.length / 4), completion_tokens: 80, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: Math.round(176 + body.length / 4) } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

/** Minimal Anthropic Messages streaming, same scenario. */
async function anthropic(payload: any, res: http.ServerResponse): Promise<void> {
  const msgs: Msg[] = [{ role: 'system', content: String(payload.system ?? '') }]
  for (const m of payload.messages ?? []) {
    const text = (m.content as any[]).filter(b => b.type === 'text').map(b => b.text).join('\n')
    msgs.push({ role: m.role, content: text })
  }
  const out = respond(msgs, (payload.tools ?? []).map((t: any) => t.name))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (type: string, data: Record<string, unknown>): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }
  ev('message_start', { message: { id: 'msg_mock', usage: { input_tokens: 300, cache_read_input_tokens: 512, cache_creation_input_tokens: 88, output_tokens: 1 } } })
  let index = 0
  const textBlock = (text: string): void => {
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
    for (const piece of text.match(/.{1,16}/gs) ?? []) ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
    ev('content_block_stop', { index })
    index++
  }
  if ('json' in out) textBlock(JSON.stringify(out.json))
  else if ('plain' in out) textBlock(out.plain)
  else {
    if (out.text) textBlock(out.text)
    for (const c of out.calls ?? []) {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${Date.now()}_${index}`, name: c.name, input: {} } })
      for (const piece of JSON.stringify(c.args).match(/.{1,20}/gs) ?? []) ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } })
      ev('content_block_stop', { index })
      index++
    }
  }
  ev('message_delta', { delta: { stop_reason: 'calls' in out && out.calls?.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 60 } })
  ev('message_stop', {})
  res.end()
}

server.listen(PORT, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${PORT}/v1`))
