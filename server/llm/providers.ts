import type { DiscoveredModel, ModelInfo, ModelRef, Protocol, ProviderConfig } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { newId, now, safeJsonParse } from '../core/util.ts'
import { anthropicHeaders, anthropicUrl } from './anthropic.ts'
import { joinUrl } from './openai.ts'

interface ProviderRow {
  id: string
  name: string
  protocol: string
  base_url: string
  api_key: string | null
  headers: string | null
  models: string
  echo_reasoning: number | null
  created_at: number
}

function fromRow(r: ProviderRow): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol as Protocol,
    baseURL: r.base_url,
    apiKey: r.api_key ?? undefined,
    headers: safeJsonParse(r.headers, undefined),
    models: safeJsonParse<ModelInfo[]>(r.models, []),
    echoReasoning: r.echo_reasoning === null ? undefined : r.echo_reasoning === 1,
    createdAt: r.created_at,
  }
}

export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 3)}••••${key.slice(-4)}`
}

/** Provider as the browser may see it. */
export function publicProvider(p: ProviderConfig): ProviderConfig & { hasKey: boolean } {
  return { ...p, apiKey: maskKey(p.apiKey), hasKey: Boolean(p.apiKey) }
}

export function listProviders(): ProviderConfig[] {
  return all<ProviderRow>('SELECT * FROM providers ORDER BY created_at').map(fromRow)
}

export function getProvider(id: string): ProviderConfig | undefined {
  const row = get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id)
  return row ? fromRow(row) : undefined
}

export interface ProviderInput {
  name: string
  protocol: Protocol
  baseURL: string
  /** `undefined` keeps the stored key; '' clears it. */
  apiKey?: string
  headers?: Record<string, string>
  models?: ModelInfo[]
  echoReasoning?: boolean | null
}

export function createProvider(input: ProviderInput): ProviderConfig {
  const id = newId('prv')
  run(
    `INSERT INTO providers (id, name, protocol, base_url, api_key, headers, models, echo_reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim() || 'Provider',
    input.protocol,
    normalizeBaseUrl(input.baseURL),
    input.apiKey?.trim() || null,
    input.headers ? JSON.stringify(input.headers) : null,
    JSON.stringify(input.models ?? []),
    input.echoReasoning === undefined || input.echoReasoning === null ? null : input.echoReasoning ? 1 : 0,
    now(),
  )
  return getProvider(id)!
}

export function updateProvider(id: string, input: Partial<ProviderInput>): ProviderConfig {
  const current = getProvider(id)
  if (!current) throw new Error('Provider introuvable')
  const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey.trim() || undefined
  run(
    `UPDATE providers SET name = ?, protocol = ?, base_url = ?, api_key = ?, headers = ?, models = ?, echo_reasoning = ? WHERE id = ?`,
    input.name ?? current.name,
    input.protocol ?? current.protocol,
    normalizeBaseUrl(input.baseURL ?? current.baseURL),
    apiKey ?? null,
    JSON.stringify(input.headers ?? current.headers ?? null),
    JSON.stringify(input.models ?? current.models),
    input.echoReasoning === undefined
      ? (current.echoReasoning === undefined ? null : current.echoReasoning ? 1 : 0)
      : input.echoReasoning === null ? null : input.echoReasoning ? 1 : 0,
    id,
  )
  return getProvider(id)!
}

export function deleteProvider(id: string): void {
  run('DELETE FROM providers WHERE id = ?', id)
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

export function parseModelRef(ref: ModelRef): { providerId: string; modelId: string } | undefined {
  const idx = ref.indexOf('::')
  if (idx <= 0) return undefined
  return { providerId: ref.slice(0, idx), modelId: ref.slice(idx + 2) }
}

export interface ResolvedModel {
  ref: ModelRef
  provider: ProviderConfig
  model: ModelInfo
  contextWindow: number
}

export function resolveModel(ref: ModelRef | undefined): ResolvedModel | undefined {
  if (!ref) return undefined
  const parsed = parseModelRef(ref)
  if (!parsed) return undefined
  const provider = getProvider(parsed.providerId)
  if (!provider) return undefined
  const model = provider.models.find(m => m.id === parsed.modelId) ?? { id: parsed.modelId }
  return { ref, provider, model, contextWindow: model.contextWindow ?? guessContextWindow(model.id) }
}

/** Sensible defaults when an endpoint does not disclose capacities. */
export function guessContextWindow(modelId: string): number {
  const id = modelId.toLowerCase()
  if (/claude/.test(id)) return 200_000
  if (/gemini/.test(id)) return 1_000_000
  if (/gpt-5|gpt-4\.1|o3|o4/.test(id)) return 400_000
  if (/gpt-4o|gpt-4-turbo/.test(id)) return 128_000
  if (/deepseek/.test(id)) return 128_000
  if (/qwen3|kimi|glm-4\.[5-9]|minimax/.test(id)) return 128_000
  if (/llama-3\.[1-3]|mistral-large|mixtral/.test(id)) return 128_000
  return 64_000
}

// ───────────────────────────── Discovery ─────────────────────────────

const MAX_LISTING_BYTES = 8 * 1024 * 1024

function posInt(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  return undefined
}

function str(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

/**
 * Ask an endpoint which models it serves. Mirrors the DeepSeek-Harness
 * behaviour: probe with the form's *current* values (key typed but not saved
 * included), return candidates for the user to pick from — never write config.
 */
export async function discoverModels(params: {
  protocol: Protocol
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}): Promise<DiscoveredModel[]> {
  const base = normalizeBaseUrl(params.baseURL)
  if (!base) throw new Error('Renseigne une base URL')
  const key = params.apiKey?.trim()
  if (key && /[^\x21-\x7e]/.test(key)) throw new Error('La clé API contient des caractères invalides (espace, retour ligne…)')

  const url = params.protocol === 'anthropic' ? `${anthropicUrl(base, 'models')}?limit=1000` : joinUrl(base, 'models')
  const fakeProvider: ProviderConfig = {
    id: 'probe', name: 'probe', protocol: params.protocol, baseURL: base, apiKey: key, headers: params.headers, models: [], createdAt: 0,
  }
  const headers = params.protocol === 'anthropic'
    ? anthropicHeaders(fakeProvider)
    : { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(params.headers ?? {}) }

  let response: Response
  try {
    response = await fetch(url, { headers, signal: params.signal ?? AbortSignal.timeout(20_000) })
  } catch (error) {
    throw new Error(`Impossible de joindre ${url} (${(error as Error).message})`)
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ' — vérifie la clé API' : response.status === 404 ? ' — cet endpoint n\'expose pas /models, saisis les modèles à la main' : ''
    throw new Error(`${url} a répondu ${response.status}${hint}`)
  }
  const text = await response.text()
  if (text.length > MAX_LISTING_BYTES) throw new Error('Réponse /models trop volumineuse')
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${url} n'a pas répondu en JSON`)
  }
  // OpenAI: {data:[...]}; Ollama native: {models:[...]}; some: bare array
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  if (list.length === 0 && !Array.isArray(body?.data)) throw new Error('Aucune liste de modèles dans la réponse; saisis les modèles à la main')
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const entry of list) {
    const rawId = str(entry?.id, entry?.name, entry?.model)
    if (!rawId) continue
    const id = rawId.replace(/^models\//, '')
    if (seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      name: str(entry?.display_name, entry?.name !== rawId ? entry?.name : undefined),
      contextWindow: posInt(entry?.context_window, entry?.context_length, entry?.max_model_len, entry?.top_provider?.context_length, entry?.inputTokenLimit, entry?.max_input_tokens),
      maxTokens: posInt(entry?.max_output_tokens, entry?.max_tokens, entry?.top_provider?.max_completion_tokens, entry?.outputTokenLimit),
      ownedBy: str(entry?.owned_by),
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
