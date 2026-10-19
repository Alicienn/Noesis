import type { FastifyInstance } from 'fastify'
import type { GlobalSettings, ModelInfo, Protocol } from '../../shared/types.ts'
import { errorMessage } from '../core/util.ts'
import { chat } from '../llm/client.ts'
import { createProvider, deleteProvider, discoverModels, getProvider, listProviders, publicProvider, resolveModel, updateProvider } from '../llm/providers.ts'
import { getSettings, publicSettings, stripMaskedSecrets, updateSettings } from '../settings.ts'
import { listRequests } from '../store/requests.ts'
import { availableSearchProviders, webSearch } from '../services/search.ts'
import { detectShell, resetShellCache } from '../services/shell.ts'
import { installMarkitdown, markitdownStatus } from '../services/markitdown.ts'
import { leanStatus, startLeanInstall } from '../services/lean.ts'
import { mcpStatus, refreshMcp } from '../tools/mcp.ts'
import { describeTools } from '../tools/registry.ts'
import { sseHandler } from './sse.ts'

export async function globalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, version: '1.0.0', shell: detectShell(), searchProviders: availableSearchProviders() }))

  // ── settings ──
  app.get('/api/settings', async () => publicSettings())
  app.put<{ Body: Partial<GlobalSettings> }>('/api/settings', async req => {
    const before = JSON.stringify(getSettings().mcpServers)
    updateSettings(stripMaskedSecrets(req.body))
    resetShellCache()
    if (JSON.stringify(getSettings().mcpServers) !== before) void refreshMcp()
    return publicSettings()
  })

  // ── providers ──
  app.get('/api/providers', async () => listProviders().map(publicProvider))

  app.post<{ Body: { name: string; protocol: Protocol; baseURL: string; apiKey?: string; headers?: Record<string, string>; models?: ModelInfo[]; echoReasoning?: boolean | null } }>('/api/providers', async req => {
    return publicProvider(createProvider(req.body))
  })

  app.put<{ Params: { id: string }; Body: { name?: string; protocol?: Protocol; baseURL?: string; apiKey?: string; headers?: Record<string, string>; models?: ModelInfo[]; echoReasoning?: boolean | null } }>('/api/providers/:id', async req => {
    const body = { ...req.body }
    if (typeof body.apiKey === 'string' && body.apiKey.includes('••••')) delete body.apiKey
    return publicProvider(updateProvider(req.params.id, body))
  })

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async req => {
    deleteProvider(req.params.id)
    return { ok: true }
  })

  /** Probe an endpoint with the form's *current* values (DeepSeek-Harness style). */
  app.post<{ Body: { protocol: Protocol; baseURL: string; apiKey?: string; providerId?: string; headers?: Record<string, string> } }>('/api/providers/discover', async (req, reply) => {
    try {
      let apiKey = req.body.apiKey
      if ((!apiKey || apiKey.includes('••••')) && req.body.providerId) apiKey = getProvider(req.body.providerId)?.apiKey
      const models = await discoverModels({ protocol: req.body.protocol, baseURL: req.body.baseURL, apiKey, headers: req.body.headers })
      return { models }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.post<{ Body: { model: string } }>('/api/providers/test', async (req, reply) => {
    const resolved = resolveModel(req.body.model)
    if (!resolved) return reply.code(400).send({ error: 'Modèle introuvable' })
    const started = Date.now()
    try {
      const res = await chat(resolved, {
        messages: [{ role: 'user', content: 'Réponds uniquement par le mot: pong' }],
        maxTokens: 400,
        retries: 0,
        signal: AbortSignal.timeout(60_000),
      })
      return { ok: true, latencyMs: Date.now() - started, answer: res.content.slice(0, 200), reasoning: Boolean(res.reasoning), usage: res.usage }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.get('/api/models', async () => listProviders().flatMap(p => p.models.map(m => ({ ref: `${p.id}::${m.id}`, providerId: p.id, providerName: p.name, ...m }))))

  // ── tools / MCP / search ──
  app.get('/api/tools', async () => describeTools())
  app.get('/api/mcp/status', async () => mcpStatus())
  app.post('/api/mcp/refresh', async () => {
    await refreshMcp()
    return mcpStatus()
  })
  // ── document conversion (Microsoft MarkItDown) ──
  app.get<{ Querystring: { refresh?: string } }>('/api/markitdown', async req => markitdownStatus(req.query.refresh === '1'))
  app.post('/api/markitdown/install', async () => installMarkitdown())

  app.get<{ Querystring: { refresh?: string } }>('/api/lean', async req => leanStatus(req.query.refresh === '1'))
  app.post('/api/lean/install', async (_req, reply) => {
    const r = startLeanInstall()
    return r.started ? leanStatus() : reply.code(409).send({ error: r.reason })
  })

  app.post<{ Body: { query: string } }>('/api/search/test', async req => webSearch(req.body.query || 'quantum error correction surface code threshold', 5))

  // ── global inbox & events ──
  app.get('/api/inbox', async () => listRequests(undefined, 'pending'))
  app.get('/api/events', (req, reply) => sseHandler(req, reply, '*'))
}
