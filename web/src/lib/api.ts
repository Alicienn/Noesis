import type {
  AgentInstance, ChatMessage, CoreBlock, DiscoveredModel, Episode, FileEntry, GlobalSettings, HumanRequest, Hypothesis, LeanCheck, LeanStatus, ModelInfo, Note,
  Project, ProjectConfig, ProjectSnapshot, Protocol, ProviderConfig, PublicationVersion, Source, ToolDescriptor,
} from '@shared/types'

export class ApiError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const r = await fetch(`/api${path}`, init)
  const text = await r.text()
  const data = text ? JSON.parse(text) : undefined
  if (!r.ok) throw new ApiError(data?.error ?? `HTTP ${r.status}`)
  return data as T
}

export type PublicProvider = ProviderConfig & { hasKey: boolean }
export interface MarkitdownStatus { available: boolean; version?: string; python: string; error?: string; checkedAt: number }
export type ModelEntry = ModelInfo & { ref: string; providerId: string; providerName: string }
export interface GraphData {
  nodes: Array<{ id: string; label: string; kind: 'note' | 'source'; type: string; importance: number; status: string; verdict?: string }>
  links: Array<{ source: string; target: string; kind: string }>
}
export interface UsageRow { agentId: string; model: string; promptTokens: number; completionTokens: number; cachedTokens?: number; cacheWriteTokens?: number; calls: number }
export interface Diagnostics {
  tools: Array<{ tool: string; calls: number; errors: number; avgMs: number; roles: Record<string, number>; lastError?: string }>
  unused: string[]
  health: Array<{ tool: string; calls: number; failures: number; consecutive: number; disabled: boolean; lastError?: string }>
  academic: Array<{ backend: string; reason: string; minutesLeft: number }>
  tokensByRole: Array<{ role: string; calls: number; promptTokens: number; completionTokens: number; cachedTokens?: number }>
  repeated: Array<{ agent: string; tool: string; args: string; count: number }>
  verdicts: { supported: number; refuted: number; uncertain: number; refutedActive: Array<{ slug: string; title: string }> }
  agents: { byRole: Record<string, number>; exhausted: number }
  warnings: Array<{ level: 'warn' | 'info'; text: string }>
}

export const api = {
  health: () => req<{ ok: boolean; shell: { kind: string; path: string }; searchProviders: string[] }>('GET', '/health'),

  settings: () => req<GlobalSettings>('GET', '/settings'),
  saveSettings: (patch: Partial<GlobalSettings>) => req<GlobalSettings>('PUT', '/settings', patch),
  markitdown: (refresh = false) => req<MarkitdownStatus>('GET', `/markitdown${refresh ? '?refresh=1' : ''}`),
  installMarkitdown: () => req<{ ok: boolean; log: string; status: MarkitdownStatus }>('POST', '/markitdown/install'),

  providers: () => req<PublicProvider[]>('GET', '/providers'),
  createProvider: (p: Partial<ProviderConfig>) => req<PublicProvider>('POST', '/providers', p),
  updateProvider: (id: string, p: Partial<ProviderConfig> & { echoReasoning?: boolean | null }) => req<PublicProvider>('PUT', `/providers/${id}`, p),
  deleteProvider: (id: string) => req('DELETE', `/providers/${id}`),
  discover: (p: { protocol: Protocol; baseURL: string; apiKey?: string; providerId?: string }) => req<{ models: DiscoveredModel[] }>('POST', '/providers/discover', p),
  testModel: (model: string) => req<{ ok: boolean; latencyMs: number; answer: string; reasoning: boolean }>('POST', '/providers/test', { model }),
  models: () => req<ModelEntry[]>('GET', '/models'),

  tools: () => req<ToolDescriptor[]>('GET', '/tools'),
  mcpStatus: () => req<Record<string, { connected: boolean; tools: number; error?: string }>>('GET', '/mcp/status'),
  mcpRefresh: () => req<Record<string, { connected: boolean; tools: number; error?: string }>>('POST', '/mcp/refresh'),
  testSearch: (query: string) => req<{ provider: string; results: Array<{ title: string; url: string; snippet: string }>; errors: string[] }>('POST', '/search/test', { query }),
  inbox: () => req<HumanRequest[]>('GET', '/inbox'),

  projects: () => req<Project[]>('GET', '/projects'),
  createProject: (p: { title: string; question: string; domain?: string; config?: Partial<ProjectConfig>; start?: boolean }) => req<Project>('POST', '/projects', p),
  project: (id: string) => req<ProjectSnapshot>('GET', `/projects/${id}`),
  updateProject: (id: string, p: { title?: string; question?: string; domain?: string; config?: Partial<ProjectConfig> }) => req<Project>('PATCH', `/projects/${id}`, p),
  deleteProject: (id: string) => req('DELETE', `/projects/${id}`),
  start: (id: string) => req('POST', `/projects/${id}/start`),
  pause: (id: string) => req('POST', `/projects/${id}/pause`),
  send: (id: string, content: string) => req('POST', `/projects/${id}/message`, { content }),
  supervise: (id: string) => req('POST', `/projects/${id}/supervise`),
  consolidate: (id: string) => req<{ result: string }>('POST', `/projects/${id}/consolidate`),
  agentMessages: (id: string, agentId: string) => req<{ messages: ChatMessage[]; usage: { promptTokens: number; completionTokens: number } }>('GET', `/projects/${id}/agents/${agentId}/messages`),
  usage: (id: string) => req<UsageRow[]>('GET', `/projects/${id}/usage`),
  diagnostics: (id: string) => req<Diagnostics>('GET', `/projects/${id}/diagnostics`),

  notes: (id: string, opts: { q?: string; all?: boolean } = {}) => req<Note[]>('GET', `/projects/${id}/notes?${new URLSearchParams({ ...(opts.q ? { q: opts.q } : {}), ...(opts.all ? { all: '1' } : {}) })}`),
  createNote: (id: string, n: Partial<Note>) => req<Note>('POST', `/projects/${id}/notes`, n),
  updateNote: (id: string, slug: string, patch: Record<string, unknown>) => req<Note>('PATCH', `/projects/${id}/notes/${slug}`, patch),
  deleteNote: (id: string, slug: string) => req('DELETE', `/projects/${id}/notes/${slug}`),
  episodes: (id: string) => req<Episode[]>('GET', `/projects/${id}/episodes`),
  blocks: (id: string) => req<CoreBlock[]>('GET', `/projects/${id}/blocks`),
  setBlock: (id: string, label: string, value: string) => req<CoreBlock>('PUT', `/projects/${id}/blocks/${label}`, { value }),
  graph: (id: string) => req<GraphData>('GET', `/projects/${id}/graph`),

  hypotheses: (id: string) => req<Hypothesis[]>('GET', `/projects/${id}/hypotheses`),
  createHypothesis: (id: string, h: { statement: string; rationale?: string; testPlan?: string }) => req<Hypothesis>('POST', `/projects/${id}/hypotheses`, h),
  updateHypothesis: (id: string, hid: string, patch: Partial<Hypothesis>) => req<Hypothesis>('PATCH', `/projects/${id}/hypotheses/${hid}`, patch),
  deleteHypothesis: (id: string, hid: string) => req('DELETE', `/projects/${id}/hypotheses/${hid}`),

  sources: (id: string) => req<Source[]>('GET', `/projects/${id}/sources`),
  addSource: (id: string, s: { doi?: string; arxivId?: string; url?: string; title?: string; fetchPdf?: boolean }) => req<Source>('POST', `/projects/${id}/sources`, s),
  uploadPdf: (id: string, file: File, extra: { requestId?: string; sourceId?: string; title?: string } = {}) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(extra)) if (v) fd.append(k, v)
    fd.append('file', file)
    return req<Source>('POST', `/projects/${id}/sources/upload`, fd)
  },
  fetchSourcePdf: (id: string, sid: string) => req<{ ok: boolean; message: string; source: Source }>('POST', `/projects/${id}/sources/${sid}/fetch`),
  sourceText: (id: string, sid: string) => req<{ source: Source; text: string }>('GET', `/projects/${id}/sources/${sid}/text`),
  deleteSource: (id: string, sid: string) => req('DELETE', `/projects/${id}/sources/${sid}`),
  sourcePdfUrl: (id: string, sid: string) => `/api/projects/${id}/sources/${sid}/pdf`,

  cancelToolRun: (runId: string) => req<{ ok: boolean }>('POST', `/tool-runs/${runId}/cancel`),

  requests: (id: string) => req<HumanRequest[]>('GET', `/projects/${id}/requests`),
  resolve: (rid: string, response: string, status: 'resolved' | 'dismissed' = 'resolved') => req<HumanRequest>('POST', `/requests/${rid}/resolve`, { response, status }),

  files: (id: string, path = '') => req<FileEntry[]>('GET', `/projects/${id}/files?path=${encodeURIComponent(path)}`),
  fileUrl: (id: string, path: string) => `/api/projects/${id}/files/raw?path=${encodeURIComponent(path)}`,
  fileText: async (id: string, path: string) => {
    const r = await fetch(`/api/projects/${id}/files/raw?path=${encodeURIComponent(path)}`)
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`)
    return r.text()
  },
  saveFile: (id: string, path: string, content: string) => req('PUT', `/projects/${id}/files`, { path, content }),

  lean: (refresh = false) => req<LeanStatus>('GET', `/lean${refresh ? '?refresh=1' : ''}`),
  installLean: () => req<LeanStatus>('POST', '/lean/install'),
  leanChecks: (id: string, note?: string) => req<LeanCheck[]>('GET', `/projects/${id}/lean-checks${note ? `?note=${encodeURIComponent(note)}` : ''}`),
  reviewNote: (id: string, slug: string, body: { verdict: 'approved' | 'rejected'; target: 'result' | 'lean_statement'; comment?: string }) => req<Note>('POST', `/projects/${id}/notes/${encodeURIComponent(slug)}/review`, body),
  reasoningSummary: (id: string) => req<{ file: string }>('POST', `/projects/${id}/reasoning-summary`),
  publications: (id: string) => req<PublicationVersion[]>('GET', `/projects/${id}/publications`),
  publish: (id: string, note?: string) => req<PublicationVersion>('POST', `/projects/${id}/publications`, { note }),
}

export type { AgentInstance }
