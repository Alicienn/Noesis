import { AlertTriangle, ArrowLeft, CheckCircle2, DownloadCloud, Plus, Save, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import type { DiscoveredModel, ModelInfo, Protocol, ProviderConfig } from '@shared/types'
import { api } from '../../lib/api'
import type { PublicProvider } from '../../lib/api'
import { fmtDuration } from '../../lib/format'
import { useApp } from '../../store/app'
import { Badge, Button, Field, IconButton, Input, Panel, Select, Spinner, Tabs, cx } from '../../components/ui'
import { DiscoverModal } from './DiscoverModal'
import { FieldGroup, Note, SecretInput, SectionHeader, errorText, isMasked, numOrUndef, toastError } from './shared'

const PRESETS: Array<{ label: string; url: string; protocol: Protocol }> = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1', protocol: 'openai' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com', protocol: 'openai' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', protocol: 'openai' },
  { label: 'Anthropic', url: 'https://api.anthropic.com', protocol: 'anthropic' },
  { label: 'Groq', url: 'https://api.groq.com/openai/v1', protocol: 'openai' },
  { label: 'Mistral', url: 'https://api.mistral.ai/v1', protocol: 'openai' },
  { label: 'Together', url: 'https://api.together.xyz/v1', protocol: 'openai' },
  { label: 'Ollama', url: 'http://localhost:11434/v1', protocol: 'openai' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1', protocol: 'openai' },
  { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai' },
]

type Echo = 'auto' | 'on' | 'off'

const echoOf = (v?: boolean): Echo => (v === undefined ? 'auto' : v ? 'on' : 'off')

/** Trim ids, drop empty rows and duplicates (first occurrence wins). */
function cleanModels(rows: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const r of rows) {
    const id = r.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: r.name?.trim() || undefined, contextWindow: r.contextWindow, maxTokens: r.maxTokens })
  }
  return out
}

export function ProviderForm({ initial, onSaved, onClose }: { initial?: PublicProvider; onSaved: (p: PublicProvider) => void; onClose: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [protocol, setProtocol] = useState<Protocol>(initial?.protocol ?? 'openai')
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [echo, setEcho] = useState<Echo>(echoOf(initial?.echoReasoning))
  const [models, setModels] = useState<ModelInfo[]>(initial?.models ?? [])
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string>()
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null)
  const [saving, setSaving] = useState(false)

  const storedKey = initial?.apiKey ?? ''
  const keyChanged = apiKey !== storedKey
  /** Key to send for discovery / save: only a freshly typed one. */
  const typedKey = keyChanged && !isMasked(apiKey) ? apiKey.trim() : undefined

  const applyPreset = (p: (typeof PRESETS)[number]): void => {
    setBaseURL(p.url)
    setProtocol(p.protocol)
    if (!name.trim() || PRESETS.some(x => x.label === name.trim())) setName(p.label)
  }

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    setDiscoverError(undefined)
    try {
      const res = await api.discover({ protocol, baseURL: baseURL.trim(), apiKey: typedKey || undefined, providerId: initial?.id })
      if (res.models.length === 0) setDiscoverError('L\'endpoint a répondu, mais sans aucun modèle. Saisis-les à la main.')
      else setDiscovered(res.models)
    } catch (error) {
      setDiscoverError(errorText(error))
    } finally {
      setDiscovering(false)
    }
  }

  const adopt = (picked: DiscoveredModel[]): void => {
    setModels(rows => {
      const existing = new Set(rows.map(r => r.id.trim()))
      const fresh = picked
        .filter(m => !existing.has(m.id))
        .map(({ id, name: label, contextWindow, maxTokens }) => ({ id, name: label, contextWindow, maxTokens }))
      return [...rows, ...fresh]
    })
    setDiscovered(null)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const body: Partial<ProviderConfig> = { name: name.trim(), protocol, baseURL: baseURL.trim(), models: cleanModels(models) }
      let saved: PublicProvider
      if (initial) {
        saved = await api.updateProvider(initial.id, {
          ...body,
          ...(keyChanged && !isMasked(apiKey) ? { apiKey: apiKey.trim() } : {}),
          // `null` resets to auto server-side; the client's intersection type narrows it away.
          echoReasoning: (echo === 'auto' ? null : echo === 'on') as boolean,
        })
      } else {
        saved = await api.createProvider({
          ...body,
          ...(typedKey ? { apiKey: typedKey } : {}),
          ...(echo === 'auto' ? {} : { echoReasoning: echo === 'on' }),
        })
      }
      useApp.getState().toast({ title: `Provider « ${saved.name} » enregistré`, body: `${saved.models.length} modèle(s) disponible(s) pour les rôles.`, level: 'success' })
      onSaved(saved)
    } catch (error) {
      toastError('Enregistrement impossible', error)
    } finally {
      setSaving(false)
    }
  }

  const canSave = Boolean(name.trim() && baseURL.trim())
  const savedIds = new Set(initial?.models.map(m => m.id))

  return (
    <>
      <SectionHeader
        kicker={initial ? '01 · Providers · édition' : '01 · Providers · nouveau'}
        title={initial ? initial.name : 'Nouveau provider'}
        actions={(
          <>
            <Button variant="ghost" onClick={onClose}><ArrowLeft className="size-4" />Retour</Button>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving}>{saving ? null : <Save className="size-4" />}Enregistrer</Button>
          </>
        )}
      >
        Renseigne l'endpoint, puis récupère la liste des modèles avec les valeurs saisies — inutile d'enregistrer avant.
      </SectionHeader>

      <div className="flex flex-col gap-5">
        <Panel kicker="Connexion" title="Endpoint & authentification" bodyClassName="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Nom">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="DeepSeek, OpenRouter, Ollama local…" autoFocus={!initial} />
            </Field>
            <Field label="Protocole" hint={protocol === 'anthropic' ? 'Base URL sans /v1 : le chemin /v1/messages est ajouté automatiquement.' : 'Le chemin /chat/completions est ajouté à la base URL.'}>
              <Select value={protocol} onChange={e => setProtocol(e.target.value as Protocol)}>
                <option value="openai">OpenAI Chat Completions (compatible)</option>
                <option value="anthropic">Anthropic Messages</option>
              </Select>
            </Field>
          </div>

          <Field label="Base URL">
            <Input value={baseURL} onChange={e => setBaseURL(e.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} className="font-mono text-[12.5px]" />
          </Field>
          <div className="-mt-2 flex flex-wrap gap-1.5">
            {PRESETS.map(p => {
              const active = baseURL.trim().replace(/\/+$/, '') === p.url
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  title={p.url}
                  className={cx(
                    'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors cursor-pointer',
                    active ? 'border-amber/60 bg-amber-soft text-amber' : 'border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100',
                  )}
                >
                  {p.label}
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field
              label="Clé API"
              hint={isMasked(storedKey) && !keyChanged
                ? 'Clé enregistrée (masquée). Laisse tel quel pour la conserver, ou tape une nouvelle clé.'
                : initial?.hasKey && apiKey === '' ? 'Le champ vide supprimera la clé enregistrée.' : 'Facultative pour les serveurs locaux (Ollama, LM Studio).'}
            >
              <SecretInput value={apiKey} onChange={setApiKey} placeholder="sk-…" />
            </Field>
            <FieldGroup label="Renvoyer reasoning_content (DeepSeek thinking + outils)" hint="Auto : décidé selon le modèle. Force-le si l'endpoint exige (ou refuse) le raisonnement renvoyé dans les tours d'outils.">
              <div className="self-start">
                <Tabs<Echo>
                  value={echo}
                  onChange={setEcho}
                  items={[{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'Toujours' }, { value: 'off', label: 'Jamais' }]}
                />
              </div>
            </FieldGroup>
          </div>
        </Panel>

        <Panel
          kicker="Modèles"
          title={`${models.length} modèle${models.length > 1 ? 's' : ''} adopté${models.length > 1 ? 's' : ''}`}
          bodyClassName="flex flex-col gap-3 p-5"
          actions={(
            <>
              <Button size="sm" variant="ghost" onClick={() => setModels(rows => [...rows, { id: '' }])}><Plus className="size-3.5" />Ajouter manuellement</Button>
              <Button size="sm" variant="subtle" onClick={() => void discover()} disabled={!baseURL.trim()} loading={discovering}>
                {discovering ? null : <DownloadCloud className="size-3.5" />}Récupérer les modèles
              </Button>
            </>
          )}
        >
          {discoverError ? <Note tone="brick" icon={<AlertTriangle className="size-3.5" />}>{discoverError}</Note> : null}
          <ModelRows models={models} onChange={setModels} providerId={initial?.id} savedIds={savedIds} />
        </Panel>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Retour à la liste</Button>
          <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving}>{saving ? null : <Save className="size-4" />}Enregistrer</Button>
        </div>
      </div>

      {discovered ? (
        <DiscoverModal
          models={discovered}
          adopted={new Set(models.map(m => m.id.trim()))}
          endpoint={baseURL.trim()}
          onClose={() => setDiscovered(null)}
          onAdd={adopt}
        />
      ) : null}
    </>
  )
}

type TestState =
  | { status: 'loading' }
  | { status: 'ok'; latencyMs: number; answer: string; reasoning: boolean }
  | { status: 'error'; message: string }

function ModelRows({ models, onChange, providerId, savedIds }: {
  models: ModelInfo[]
  onChange: (rows: ModelInfo[]) => void
  providerId?: string
  savedIds: Set<string>
}) {
  const [tests, setTests] = useState<Record<string, TestState>>({})

  const patch = (i: number, p: Partial<ModelInfo>): void => onChange(models.map((m, j) => (j === i ? { ...m, ...p } : m)))
  const remove = (i: number): void => onChange(models.filter((_, j) => j !== i))

  const test = async (id: string): Promise<void> => {
    if (!providerId) return
    setTests(t => ({ ...t, [id]: { status: 'loading' } }))
    try {
      const r = await api.testModel(`${providerId}::${id}`)
      setTests(t => ({ ...t, [id]: { status: 'ok', latencyMs: r.latencyMs, answer: r.answer, reasoning: r.reasoning } }))
    } catch (error) {
      setTests(t => ({ ...t, [id]: { status: 'error', message: errorText(error) } }))
    }
  }

  if (models.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-700 px-4 py-8 text-center text-[12.5px] text-ink-400">
        Aucun modèle. Clique sur <span className="text-ink-200">Récupérer les modèles</span> pour interroger l'endpoint, ou ajoute-les à la main.
      </div>
    )
  }

  const grid = 'grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_100px_100px_auto] items-center gap-2'
  return (
    <div className="flex flex-col">
      <div className={cx(grid, 'px-1 pb-1.5')}>
        <span className="kicker">Identifiant</span>
        <span className="kicker">Nom affiché</span>
        <span className="kicker">Contexte</span>
        <span className="kicker">Sortie max</span>
        <span className="w-[104px]" />
      </div>
      <div className="flex flex-col divide-y divide-ink-750 rounded-lg border border-ink-750 bg-ink-925/60">
        {models.map((m, i) => {
          const id = m.id.trim()
          const state = id ? tests[id] : undefined
          const testable = Boolean(providerId && id && savedIds.has(id))
          return (
            <div key={i} className="px-2 py-1.5">
              <div className={grid}>
                <Input value={m.id} onChange={e => patch(i, { id: e.target.value })} placeholder="model-id" spellCheck={false} className="h-8 font-mono text-[12px]" />
                <Input value={m.name ?? ''} onChange={e => patch(i, { name: e.target.value })} placeholder="—" className="h-8 text-[12.5px]" />
                <Input type="number" min={0} value={m.contextWindow ?? ''} onChange={e => patch(i, { contextWindow: numOrUndef(e.target.value) })} placeholder="auto" className="h-8 font-mono text-[12px]" />
                <Input type="number" min={0} value={m.maxTokens ?? ''} onChange={e => patch(i, { maxTokens: numOrUndef(e.target.value) })} placeholder="auto" className="h-8 font-mono text-[12px]" />
                <div className="flex w-[104px] items-center justify-end gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void test(id)}
                    disabled={!testable || state?.status === 'loading'}
                    title={testable ? 'Envoie « pong » au modèle' : 'Enregistre d\'abord le provider avec ce modèle'}
                  >
                    {state?.status === 'loading' ? <Spinner className="size-3" /> : <Zap className="size-3" />}Tester
                  </Button>
                  <IconButton title="Retirer" onClick={() => remove(i)} className="size-7 hover:!text-brick"><Trash2 className="size-3.5" /></IconButton>
                </div>
              </div>
              {state && state.status !== 'loading' ? <TestResult state={state} /> : null}
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-500">Contexte et sortie max vides : Noesis estime à partir du nom du modèle.</p>
    </div>
  )
}

function TestResult({ state }: { state: Exclude<TestState, { status: 'loading' }> }) {
  if (state.status === 'error') {
    return (
      <div className="mt-1.5 flex items-start gap-1.5 px-1 text-[11.5px] text-brick">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        <span className="break-words">{state.message}</span>
      </div>
    )
  }
  return (
    <div className="mt-1.5 flex items-center gap-2 px-1 text-[11.5px] text-teal">
      <CheckCircle2 className="size-3 shrink-0" />
      <span className="font-mono">{fmtDuration(state.latencyMs)}</span>
      <span className="min-w-0 truncate text-ink-300">« {state.answer.trim() || '(réponse vide)'} »</span>
      {state.reasoning ? <Badge tone="moss">raisonnement</Badge> : null}
    </div>
  )
}
