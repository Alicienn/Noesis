import type { GlobalSettings, ModelAssignments, ProjectConfig } from '../shared/types.ts'
import { DEFAULT_PROJECT_CONFIG } from '../shared/types.ts'
import { get, run } from './db/database.ts'
import { bus } from './core/events.ts'

const KEY = 'settings'

const emptyRole = { model: '' as const }

export const DEFAULT_SETTINGS: GlobalSettings = {
  models: {
    lead: { ...emptyRole, temperature: 0.4 },
    supervisor: { ...emptyRole, temperature: 0.2 },
    verifier: { ...emptyRole, temperature: 0.1 },
    subagent: { ...emptyRole, temperature: 0.4 },
    utility: { ...emptyRole, temperature: 0.2 },
    embedding: { model: '' },
  },
  search: {
    order: ['searxng', 'tavily', 'brave', 'exa', 'serper', 'jina', 'bing', 'duckduckgo'],
    readers: ['jina', 'defuddle', 'puremd', 'markdown_new'],
    searxngUrl: '',
    contactEmail: '',
  },
  mcpServers: [],
  notifications: {
    windowsToast: true,
    browser: true,
    sound: true,
    on: {
      humanRequest: true,
      approval: true,
      runFinished: true,
      error: true,
      finding: false,
      supervisorCritical: true,
    },
  },
  defaults: DEFAULT_PROJECT_CONFIG,
  shell: { preferred: 'auto', pythonPath: 'python' },
  documents: { markitdown: true },
  lean: { enabled: true, distro: 'Ubuntu', workspace: '~/noesis-lean', timeoutSec: 900 },
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch as T
  if (typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out as T
}

let cache: GlobalSettings | undefined

export function getSettings(): GlobalSettings {
  if (cache) return cache
  const row = get<{ value: string }>('SELECT value FROM kv WHERE key = ?', KEY)
  const stored = row ? JSON.parse(row.value) : {}
  cache = deepMerge(DEFAULT_SETTINGS, stored)
  // engines added in later versions must appear in a previously saved order
  for (const id of DEFAULT_SETTINGS.search.order) if (!cache.search.order.includes(id)) cache.search.order.push(id)
  return cache
}

export function updateSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  const next = deepMerge(getSettings(), patch)
  // arrays are replaced wholesale by deepMerge; that's intended (order, mcpServers)
  run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(next))
  cache = next
  bus.publish('*', { type: 'log', level: 'info', message: 'settings.updated' })
  return next
}

/** Secrets never leave the server in clear. */
export function publicSettings(): GlobalSettings {
  const s = structuredClone(getSettings())
  const mask = (v?: string): string | undefined => (v ? `${v.slice(0, 3)}••••${v.slice(-3)}` : v)
  s.search.tavilyKey = mask(s.search.tavilyKey)
  s.search.braveKey = mask(s.search.braveKey)
  s.search.exaKey = mask(s.search.exaKey)
  s.search.serperKey = mask(s.search.serperKey)
  s.search.jinaKey = mask(s.search.jinaKey)
  s.search.semanticScholarKey = mask(s.search.semanticScholarKey)
  s.search.openAlexKey = mask(s.search.openAlexKey)
  s.search.coreKey = mask(s.search.coreKey)
  return s
}

/** Masked secrets coming back from the UI must not overwrite real ones. */
export function stripMaskedSecrets(patch: Partial<GlobalSettings>): Partial<GlobalSettings> {
  if (!patch.search) return patch
  const search = { ...patch.search } as Record<string, unknown>
  for (const [k, v] of Object.entries(search)) {
    if (typeof v === 'string' && v.includes('••••')) delete search[k]
  }
  return { ...patch, search: search as unknown as GlobalSettings['search'] }
}

/** Effective model assignment for a project (project overrides → global). */
export function effectiveModels(config: ProjectConfig): ModelAssignments {
  const global = getSettings().models
  const o = config.models ?? {}
  const pick = <K extends keyof ModelAssignments>(k: K): ModelAssignments[K] => {
    const override = o[k] as { model?: string } | undefined
    return (override?.model ? { ...global[k], ...override } : global[k]) as ModelAssignments[K]
  }
  return {
    lead: pick('lead'),
    supervisor: pick('supervisor'),
    verifier: pick('verifier'),
    subagent: pick('subagent'),
    utility: pick('utility'),
    embedding: pick('embedding'),
  }
}
