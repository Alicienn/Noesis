import { RotateCcw, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_PROJECT_CONFIG } from '@shared/types'
import type { GlobalSettings, PermissionMode, ProjectConfig, RunMode } from '@shared/types'
import { api } from '../../lib/api'
import { Badge, Button, Field, Input, Panel, Select, Textarea, Toggle } from '../../components/ui'
import { Loading, SaveButton, SectionHeader, errorText, useSettingsDraft } from './shared'

type Health = Awaited<ReturnType<typeof api.health>>

const PERMISSION_HINT: Record<PermissionMode, string> = {
  smart: 'Approbation pour les actions risquées.',
  ask: 'Approbation pour tout shell / Python.',
  auto: 'Tout est exécuté sans demander.',
}

export function DefaultsSection() {
  const { draft, setDraft, save, saving, dirty, loadError } = useSettingsDraft(['defaults', 'shell'] as const)
  const [health, setHealth] = useState<Health>()
  const [healthError, setHealthError] = useState<string>()

  const loadHealth = (): void => {
    api.health().then(setHealth).catch(e => setHealthError(errorText(e)))
  }
  useEffect(loadHealth, [])

  const setDefaults = (patch: Partial<ProjectConfig>): void => setDraft(d => d && { ...d, defaults: { ...d.defaults, ...patch } })
  const setShell = (patch: Partial<GlobalSettings['shell']>): void => setDraft(d => d && { ...d, shell: { ...d.shell, ...patch } })
  const int = (v: string): number => Math.max(0, Math.round(Number(v) || 0))

  const submit = async (): Promise<void> => {
    if (await save(undefined, 'Défauts & système enregistrés')) loadHealth()
  }

  return (
    <>
      <SectionHeader
        kicker="06 · Système"
        title="Défauts & système"
        actions={<SaveButton dirty={dirty} saving={saving} onClick={() => void submit()} />}
      >
        Valeurs appliquées aux nouveaux projets (chacun reste modifiable ensuite), et environnement d'exécution des agents.
      </SectionHeader>

      {!draft ? <Loading error={loadError} /> : (
        <div className="flex flex-col gap-5">
          <Panel
            kicker="Nouveaux projets"
            title="Configuration par défaut"
            bodyClassName="flex flex-col gap-5 p-5"
            actions={(
              <Button size="sm" variant="ghost" onClick={() => setDefaults({ ...DEFAULT_PROJECT_CONFIG, models: draft.defaults.models })} title="Rétablir les valeurs d'usine">
                <RotateCcw className="size-3.5" />Valeurs d'usine
              </Button>
            )}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Mode" hint={draft.defaults.mode === 'autonomous' ? 'L\'agent avance seul jusqu\'au rapport final.' : 'L\'agent rend la main après chaque tâche.'}>
                <Select value={draft.defaults.mode} onChange={e => setDefaults({ mode: e.target.value as RunMode })}>
                  <option value="autonomous">Autonome</option>
                  <option value="interactive">Interactif</option>
                </Select>
              </Field>
              <Field label="Permissions" hint={PERMISSION_HINT[draft.defaults.permission]}>
                <Select value={draft.defaults.permission} onChange={e => setDefaults({ permission: e.target.value as PermissionMode })}>
                  <option value="smart">Intelligent</option>
                  <option value="ask">Toujours demander</option>
                  <option value="auto">Automatique</option>
                </Select>
              </Field>
              <Field label="Agents parallèles max" hint="Sous-agents actifs en même temps.">
                <Input type="number" min={1} max={12} value={draft.defaults.maxParallelAgents} onChange={e => setDefaults({ maxParallelAgents: Math.max(1, int(e.target.value)) })} className="font-mono" />
              </Field>
              <Field label="Timeout d'une action (min)" hint="Arrêt automatique d'un outil trop long. Délégations et vérifications ont un budget plus large.">
                <Input type="number" min={1} max={600} value={Math.round((draft.defaults.toolTimeoutSec ?? 1800) / 60)} onChange={e => setDefaults({ toolTimeoutSec: Math.max(1, int(e.target.value)) * 60 })} className="font-mono" />
              </Field>
              <Field label="Étapes max" hint="Étapes du chercheur principal par lancement. 0 = illimité.">
                <Input type="number" min={0} value={draft.defaults.maxSteps} onChange={e => setDefaults({ maxSteps: int(e.target.value) })} className="font-mono" />
              </Field>
              <Field label="Budget de tokens" hint="Arrêt au-delà de cette consommation. 0 = illimité.">
                <Input type="number" min={0} step={100000} value={draft.defaults.maxTokens} onChange={e => setDefaults({ maxTokens: int(e.target.value) })} className="font-mono" />
              </Field>
              <Field label="Supervision toutes les" hint="Nombre d'étapes entre deux revues du superviseur. 0 = désactivé.">
                <Input type="number" min={0} value={draft.defaults.supervisorEvery} onChange={e => setDefaults({ supervisorEvery: int(e.target.value) })} className="font-mono" />
              </Field>
              <Field label="Compaction à (% du contexte)" hint="Résumé automatique de la conversation à ce seuil.">
                <Input
                  type="number"
                  min={30}
                  max={95}
                  value={Math.round(draft.defaults.compactAt * 100)}
                  onChange={e => setDefaults({ compactAt: Math.min(95, Math.max(30, int(e.target.value))) / 100 })}
                  className="font-mono"
                />
              </Field>
              <Field label="Résultats d'outils conservés" hint="Les plus récents restent intacts ; les anciens sont allégés.">
                <Input type="number" min={0} value={draft.defaults.keepToolResults} onChange={e => setDefaults({ keepToolResults: int(e.target.value) })} className="font-mono" />
              </Field>
              <div className="flex items-end pb-1">
                <Toggle checked={draft.defaults.autoVerify} onChange={v => setDefaults({ autoVerify: v })} label="Vérification automatique" hint="Les résultats importants passent par le vérificateur." />
              </div>
            </div>
            <Field label="Instructions personnalisées" hint="Ajoutées au prompt système du chercheur principal de chaque nouveau projet.">
              <Textarea rows={4} value={draft.defaults.customInstructions} onChange={e => setDefaults({ customInstructions: e.target.value })} placeholder="Ex : privilégie les sources primaires, rédige en français, cite systématiquement les DOI…" />
            </Field>
          </Panel>

          <Panel kicker="Exécution" title="Shell & Python" bodyClassName="flex flex-col gap-4 p-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Shell préféré" hint="Auto : Git Bash s'il est installé, sinon PowerShell.">
                <Select value={draft.shell.preferred} onChange={e => setShell({ preferred: e.target.value as GlobalSettings['shell']['preferred'] })}>
                  <option value="auto">Automatique</option>
                  <option value="bash">Bash</option>
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">cmd</option>
                </Select>
              </Field>
              <Field label="Interpréteur Python" hint="Commande ou chemin complet (ex. C:\Python312\python.exe, ou un venv).">
                <Input value={draft.shell.pythonPath} onChange={e => setShell({ pythonPath: e.target.value })} placeholder="python" spellCheck={false} className="font-mono text-[12.5px]" />
              </Field>
            </div>
            <SystemInfo health={health} error={healthError} />
          </Panel>
        </div>
      )}
    </>
  )
}

function SystemInfo({ health, error }: { health?: Health; error?: string }) {
  return (
    <div className="rounded-lg border border-ink-750 bg-ink-925/60 px-4 py-3">
      <div className="kicker mb-2 flex items-center gap-1.5"><Terminal className="size-3" />Détecté sur cette machine</div>
      {error ? <p className="text-[12px] text-brick">{error}</p> : !health ? <p className="text-[12px] text-ink-500">…</p> : (
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-ink-400">Shell</dt>
          <dd className="min-w-0 truncate"><Badge tone="sky">{health.shell.kind}</Badge> <span className="font-mono text-[11.5px] text-ink-300" title={health.shell.path}>{health.shell.path}</span></dd>
          <dt className="text-ink-400">Moteurs de recherche</dt>
          <dd className="flex flex-wrap gap-1">
            {health.searchProviders.length ? health.searchProviders.map(p => <Badge key={p} tone="teal">{p}</Badge>) : <span className="text-ink-500">aucun (DuckDuckGo en secours)</span>}
          </dd>
        </dl>
      )}
    </div>
  )
}
