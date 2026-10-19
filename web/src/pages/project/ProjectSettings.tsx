import { AlertTriangle, Brain, Cpu, Eye, Gauge, Save, ShieldCheck, Sliders, Trash2, Wrench, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FormalPolicy, GlobalSettings, ModelAssignments, PermissionMode, Project, ProjectConfig, ProjectKind, RoleModelConfig, RunMode, ToolDescriptor } from '@shared/types'
import { DEFAULT_PROJECT_CONFIG } from '@shared/types'
import { ModelPicker } from '../../components/ModelPicker'
import { Button, Field, Input, Modal, Panel, Select, Spinner, Textarea, Toggle, cx } from '../../components/ui'
import { api } from '../../lib/api'
import type { ModelEntry } from '../../lib/api'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

interface Draft {
  title: string
  domain: string
  question: string
  config: ProjectConfig
}

type ModelRole = Exclude<keyof ModelAssignments, 'embedding'>

const MODEL_ROLES: Array<{ key: ModelRole; label: string; hint: string }> = [
  { key: 'lead', label: 'Chercheur principal', hint: 'Planifie, délègue, rédige. Le modèle le plus capable.' },
  { key: 'supervisor', label: 'Superviseur', hint: 'Relit périodiquement le travail et recadre.' },
  { key: 'verifier', label: 'Vérificateur', hint: 'Contre-vérifie les résultats importants.' },
  { key: 'subagent', label: 'Sous-agents', hint: 'Éclaireurs, expérimentateurs, théoriciens, critiques.' },
  { key: 'utility', label: 'Utilitaire', hint: 'Compaction, consolidation mémoire, titres. Rapide et économique.' },
]

const PERMISSIONS: Array<{ value: PermissionMode; label: string; icon: ReactNode; text: string }> = [
  { value: 'smart', label: 'Intelligent', icon: <ShieldCheck className="size-4" />, text: 'Demande ton approbation uniquement pour les actions jugées risquées (suppression, réseau, installation…).' },
  { value: 'ask', label: 'Toujours demander', icon: <Eye className="size-4" />, text: 'Chaque commande shell ou script Python attend ton feu vert dans la boîte de réception.' },
  { value: 'auto', label: 'Automatique', icon: <Zap className="size-4" />, text: 'Tout est exécuté sans confirmation. À réserver aux environnements jetables.' },
]

function toDraft(p: Project): Draft {
  return { title: p.title, domain: p.domain, question: p.question, config: { ...DEFAULT_PROJECT_CONFIG, ...p.config } }
}

export function ProjectSettings() {
  const pid = useProject(s => s.id)!
  const project = useProject(s => s.project)
  const toast = useApp(s => s.toast)
  const [baseline, setBaseline] = useState<Draft>()
  const [draft, setDraft] = useState<Draft>()
  const [saving, setSaving] = useState(false)

  // initialise once per project — later project.updated events (stats) must not clobber the draft
  useEffect(() => {
    if (!project || project.id !== pid) return
    setBaseline(b => b ?? toDraft(project))
    setDraft(d => d ?? toDraft(project))
  }, [project, pid])

  const dirty = useMemo(() => Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline)), [draft, baseline])

  if (!draft) {
    return <div className="graph-paper flex h-full items-center justify-center"><Spinner className="size-5 text-ink-400" /></div>
  }

  const setConfig = (patch: Partial<ProjectConfig>): void => setDraft(d => (d ? { ...d, config: { ...d.config, ...patch } } : d))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const p = await api.updateProject(pid, { title: draft.title.trim() || draft.question.slice(0, 60), domain: draft.domain.trim(), question: draft.question.trim(), config: draft.config })
      const next = toDraft(p)
      setBaseline(next)
      setDraft(next)
      void useApp.getState().loadProjects()
      toast({ title: 'Paramètres enregistrés', body: 'Ils s\'appliquent dès la prochaine étape des agents.', level: 'success' })
    } catch (error) {
      toast({ title: 'Enregistrement impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-28 pt-8">
        <header className="mb-7 animate-rise">
          <div className="kicker mb-2">Projet · configuration</div>
          <h1 className="display text-[34px] font-semibold leading-tight text-paper">Paramètres <span className="text-amber">du projet</span></h1>
          <p className="mt-2 max-w-2xl text-[13.5px] text-ink-300">Ces réglages surchargent les valeurs par défaut globales pour cette recherche uniquement.</p>
        </header>

        <div className="flex flex-col gap-5">
          <GeneralSection draft={draft} setDraft={setDraft} />
          <RunSection config={draft.config} setConfig={setConfig} />
          <ModelsSection config={draft.config} setConfig={setConfig} />
          <ToolsSection config={draft.config} setConfig={setConfig} />
          <InstructionsSection config={draft.config} setConfig={setConfig} />
          <ActionsSection pid={pid} />
          <DangerZone pid={pid} title={project?.title ?? draft.title} />
        </div>
      </div>

      <div className={cx('pointer-events-none sticky bottom-0 z-10 transition-all duration-200', dirty ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0')}>
        <div className="mx-auto max-w-4xl px-8 pb-5">
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-amber/40 bg-ink-875/95 px-4 py-2.5 shadow-[0_20px_50px_-15px_#000] backdrop-blur">
            <span className="size-1.5 rounded-full bg-amber animate-pulse-soft" />
            <span className="text-[13px] text-ink-200">Modifications non enregistrées</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setDraft(baseline)} disabled={saving}>Annuler</Button>
            <Button variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={!dirty || !draft.question.trim()}>
              <Save className="size-3.5" /> Enregistrer
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────── Sections ─────────────────────────────

function GeneralSection({ draft, setDraft }: { draft: Draft; setDraft: (fn: (d: Draft | undefined) => Draft | undefined) => void }) {
  const set = (patch: Partial<Draft>): void => setDraft(d => (d ? { ...d, ...patch } : d))
  return (
    <Panel kicker="Identité" title="Question de recherche">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Titre"><Input value={draft.title} onChange={e => set({ title: e.target.value })} /></Field>
          <Field label="Domaine"><Input value={draft.domain} onChange={e => set({ domain: e.target.value })} placeholder="Mathématiques, physique…" /></Field>
        </div>
        <Field label="Question" hint="Modifier la question met aussi à jour le bloc « mission » de la mémoire centrale.">
          <Textarea rows={5} value={draft.question} onChange={e => set({ question: e.target.value })} />
        </Field>
      </div>
    </Panel>
  )
}

function NumField({ label, hint, value, onChange, min = 0, max, step, suffix }: { label: string; hint?: ReactNode; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={e => {
            const n = Number(e.target.value)
            onChange(Number.isFinite(n) ? n : 0)
          }}
          className={suffix ? 'pr-10' : undefined}
        />
        {suffix ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-ink-500">{suffix}</span> : null}
      </div>
    </Field>
  )
}

type SetConfig = (patch: Partial<ProjectConfig>) => void

function RunSection({ config, setConfig }: { config: ProjectConfig; setConfig: SetConfig }) {
  return (
    <Panel kicker="Exécution" title={<span className="flex items-center gap-2"><Sliders className="size-4 text-amber" />Déroulement & garde-fous</span>}>
      <div className="flex flex-col gap-5">
        <Field label="Mode" hint={config.mode === 'autonomous' ? 'L\'agent avance seul jusqu\'au rapport final, sans rendre la main.' : 'L\'agent rend la main après chaque tâche et attend tes instructions.'}>
          <Select value={config.mode} onChange={e => setConfig({ mode: e.target.value as RunMode })} className="sm:max-w-xs">
            <option value="autonomous">Autonome</option>
            <option value="interactive">Interactif</option>
          </Select>
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Type de question" hint={config.kind === 'problem' ? 'Problème posé : résolution ou réfutation rigoureuse, énoncé figé (protocole dédié dans le prompt du chercheur principal).' : 'Recherche ouverte : exploration, état de l\'art, résultats nouveaux.'}>
            <Select value={config.kind ?? 'research'} onChange={e => setConfig({ kind: e.target.value as ProjectKind })}>
              <option value="research">Recherche ouverte</option>
              <option value="problem">Problème posé (prouver ou réfuter)</option>
            </Select>
          </Field>
          <Field label="Formalisation Lean" hint={(config.formal ?? 'off') === 'off' ? 'Outils Lean masqués pour ce projet.' : config.formal === 'required' ? 'Le résultat principal doit être prouvé en Lean (Comparator) avant le rapport final.' : 'Formalisation du résultat principal quand c\'est faisable.'}>
            <Select value={config.formal ?? 'off'} onChange={e => setConfig({ formal: e.target.value as FormalPolicy })}>
              <option value="off">Désactivée</option>
              <option value="preferred">Si pertinent</option>
              <option value="required">Exigée</option>
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-200">Permissions</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PERMISSIONS.map(p => {
              const active = config.permission === p.value
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setConfig({ permission: p.value })}
                  className={cx(
                    'flex flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left transition-colors cursor-pointer',
                    active ? 'border-amber/60 bg-amber-soft' : 'border-ink-700 bg-ink-900 hover:border-ink-500',
                  )}
                >
                  <span className={cx('flex items-center gap-2 text-[13px] font-medium', active ? 'text-amber' : 'text-ink-100')}>{p.icon}{p.label}</span>
                  <span className="text-[11.5px] leading-snug text-ink-400">{p.text}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumField label="Étapes max" hint="Par lancement, 0 = illimité." value={config.maxSteps} onChange={v => setConfig({ maxSteps: v })} />
          <NumField label="Budget de tokens" hint="Arrêt au-delà, 0 = illimité." value={config.maxTokens} step={100000} onChange={v => setConfig({ maxTokens: v })} />
          <NumField label="Supervision toutes les" hint="Étapes du principal, 0 = désactivée." value={config.supervisorEvery} suffix="ét." onChange={v => setConfig({ supervisorEvery: v })} />
          <NumField
            label="Compaction à"
            hint="Part de la fenêtre de contexte avant résumé."
            value={Math.round(config.compactAt * 100)}
            min={20}
            max={95}
            suffix="%"
            onChange={v => setConfig({ compactAt: Math.min(0.95, Math.max(0.2, v / 100)) })}
          />
          <NumField label="Résultats d'outils conservés" hint="Les plus récents restent intacts en contexte." value={config.keepToolResults} onChange={v => setConfig({ keepToolResults: v })} />
          <NumField label="Agents en parallèle" hint="Sous-agents simultanés au maximum." value={config.maxParallelAgents} min={1} max={12} onChange={v => setConfig({ maxParallelAgents: Math.max(1, v) })} />
          <NumField label="Timeout d'une action (min)" hint="Durée max d'un outil avant arrêt automatique (délégations et vérifications ont un budget plus large)." value={Math.round((config.toolTimeoutSec ?? 1800) / 60)} min={1} max={600} onChange={v => setConfig({ toolTimeoutSec: Math.max(1, v) * 60 })} />
        </div>

        <div className="rounded-md border border-ink-750 bg-ink-875 px-3 py-3">
          <Toggle
            checked={config.autoVerify}
            onChange={v => setConfig({ autoVerify: v })}
            label="Vérification automatique"
            hint="Les résultats marqués importants sont contre-vérifiés par un agent vérificateur indépendant."
          />
        </div>
      </div>
    </Panel>
  )
}

function ModelsSection({ config, setConfig }: { config: ProjectConfig; setConfig: SetConfig }) {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [global, setGlobal] = useState<GlobalSettings['models']>()
  useEffect(() => {
    api.models().then(setModels).catch(() => undefined)
    api.settings().then(s => setGlobal(s.models)).catch(() => undefined)
  }, [])

  const setModel = (role: ModelRole, ref: string): void => {
    const next: Partial<ModelAssignments> = { ...(config.models ?? {}) }
    if (ref) next[role] = { ...(next[role] ?? {}), model: ref } as RoleModelConfig
    else delete next[role]
    setConfig({ models: next })
  }

  const inherited = (role: ModelRole): string => {
    const ref = global?.[role]?.model || (role === 'subagent' ? global?.lead.model : '')
    if (!ref) return 'non défini'
    return models.find(m => m.ref === ref)?.id ?? ref.split('::').pop() ?? ref
  }

  return (
    <Panel kicker="Modèles" title={<span className="flex items-center gap-2"><Cpu className="size-4 text-amber" />Surcharges par rôle</span>}>
      <p className="mb-4 text-[12.5px] text-ink-400">Laisse vide pour hériter de l'affectation globale (Paramètres → Rôles).</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {MODEL_ROLES.map(r => (
          <Field key={r.key} label={r.label} hint={<>{r.hint} <span className="text-ink-500">Global : <span className="font-mono">{inherited(r.key)}</span></span></>}>
            <ModelPicker models={models} value={config.models?.[r.key]?.model ?? ''} onChange={ref => setModel(r.key, ref)} allowEmpty emptyLabel="Hériter du global" />
          </Field>
        ))}
      </div>
    </Panel>
  )
}

function ToolsSection({ config, setConfig }: { config: ProjectConfig; setConfig: SetConfig }) {
  const [tools, setTools] = useState<ToolDescriptor[] | null>(null)
  useEffect(() => {
    api.tools().then(setTools).catch(() => setTools([]))
  }, [])

  const groups = useMemo(() => {
    const map = new Map<string, ToolDescriptor[]>()
    for (const t of tools ?? []) map.set(t.category, [...(map.get(t.category) ?? []), t])
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr'))
  }, [tools])

  const disabled = new Set(config.disabledTools)
  const setEnabled = (names: string[], enabled: boolean): void => {
    const next = new Set(config.disabledTools)
    for (const n of names) {
      if (enabled) next.delete(n)
      else next.add(n)
    }
    setConfig({ disabledTools: [...next].sort() })
  }

  return (
    <Panel
      kicker="Outils"
      title={<span className="flex items-center gap-2"><Wrench className="size-4 text-amber" />Outils disponibles</span>}
      actions={tools ? <span className="font-mono text-[11px] text-ink-500">{(tools.length - tools.filter(t => disabled.has(t.name)).length)}/{tools.length} actifs</span> : null}
    >
      {tools === null ? (
        <div className="flex justify-center py-6"><Spinner className="size-4 text-ink-400" /></div>
      ) : tools.length === 0 ? (
        <div className="py-4 text-center text-[12.5px] text-ink-400">Aucun outil exposé par le serveur.</div>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map(([cat, list]) => {
            const allOn = list.every(t => !disabled.has(t.name))
            return (
              <div key={cat}>
                <div className="mb-2 flex items-center gap-2 border-b border-ink-800 pb-1">
                  <span className="kicker">{cat}</span>
                  <button type="button" onClick={() => setEnabled(list.map(t => t.name), !allOn)} className="ml-auto text-[11px] text-ink-500 hover:text-amber cursor-pointer">
                    {allOn ? 'tout désactiver' : 'tout activer'}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                  {list.map(t => {
                    const on = !disabled.has(t.name)
                    return (
                      <label key={t.name} title={t.description} className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-ink-850">
                        <input type="checkbox" checked={on} onChange={e => setEnabled([t.name], e.target.checked)} className="mt-1 size-3.5 shrink-0 cursor-pointer accent-[#f2b544]" />
                        <span className="min-w-0">
                          <span className={cx('block font-mono text-[12px]', on ? 'text-ink-100' : 'text-ink-500 line-through')}>
                            {t.name}{t.source === 'mcp' ? <span className="ml-1.5 text-[10px] text-sky">MCP</span> : null}
                          </span>
                          <span className="line-clamp-1 text-[11.5px] text-ink-500">{t.description}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

function InstructionsSection({ config, setConfig }: { config: ProjectConfig; setConfig: SetConfig }) {
  return (
    <Panel kicker="Consignes" title="Instructions personnalisées">
      <Field label="Ajoutées au prompt système du chercheur principal" hint="Contraintes de méthode, style du rapport, sources à privilégier, langages autorisés…">
        <Textarea
          rows={6}
          value={config.customInstructions}
          onChange={e => setConfig({ customInstructions: e.target.value })}
          placeholder="Ex : Privilégie les preuves formelles aux simulations. Rédige le rapport final en français, avec une section « limites »."
          className="font-mono text-[12.5px]"
        />
      </Field>
    </Panel>
  )
}

function ActionsSection({ pid }: { pid: string }) {
  const toast = useApp(s => s.toast)
  const [busy, setBusy] = useState<'supervise' | 'consolidate' | null>(null)

  const supervise = async (): Promise<void> => {
    setBusy('supervise')
    try {
      await api.supervise(pid)
      toast({ title: 'Supervision effectuée', body: 'Le rapport du superviseur est visible dans le bus inter-agents.', level: 'success' })
    } catch (error) {
      toast({ title: 'Supervision impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const consolidate = async (): Promise<void> => {
    setBusy('consolidate')
    try {
      const { result } = await api.consolidate(pid)
      toast({ title: 'Mémoire consolidée', body: result.slice(0, 400), level: 'success' })
    } catch (error) {
      toast({ title: 'Consolidation impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel kicker="Maintenance" title={<span className="flex items-center gap-2"><Gauge className="size-4 text-amber" />Actions manuelles</span>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ActionCard
          icon={<Eye className="size-4" />}
          title="Lancer la supervision maintenant"
          text="Le superviseur relit le travail récent et envoie ses remarques au chercheur principal."
          button={<Button size="sm" onClick={() => void supervise()} loading={busy === 'supervise'} disabled={busy !== null}>Superviser</Button>}
        />
        <ActionCard
          icon={<Brain className="size-4" />}
          title="Consolider la mémoire"
          text="Le bibliothécaire fusionne les doublons, relie les notes et met à jour la mémoire centrale."
          button={<Button size="sm" onClick={() => void consolidate()} loading={busy === 'consolidate'} disabled={busy !== null}>Consolider</Button>}
        />
      </div>
    </Panel>
  )
}

function ActionCard({ icon, title, text, button }: { icon: ReactNode; title: string; text: string; button: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-875 p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink-100"><span className="text-amber">{icon}</span>{title}</div>
      <p className="flex-1 text-[12px] leading-snug text-ink-400">{text}</p>
      <div>{button}</div>
    </div>
  )
}

function DangerZone({ pid, title }: { pid: string; title: string }) {
  const navigate = useNavigate()
  const toast = useApp(s => s.toast)
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const phrase = title.trim() || 'supprimer'

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.deleteProject(pid)
      setOpen(false)
      navigate('/')
      void useApp.getState().loadProjects()
      void useApp.getState().loadInbox()
      toast({ title: 'Projet supprimé', body: title, level: 'info' })
    } catch (error) {
      toast({ title: 'Suppression impossible', body: (error as Error).message, level: 'error' })
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-brick/40 bg-ink-900/80">
      <header className="flex items-center gap-2 border-b border-brick/25 px-4 py-2.5">
        <AlertTriangle className="size-4 text-brick" />
        <h3 className="text-[13.5px] font-semibold text-brick">Zone dangereuse</h3>
      </header>
      <div className="flex flex-wrap items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-ink-100">Supprimer le projet</div>
          <div className="text-[12px] text-ink-400">Efface définitivement les conversations, la mémoire, les sources et tout le workspace.</div>
        </div>
        <Button variant="danger" onClick={() => setOpen(true)}><Trash2 className="size-4" /> Supprimer le projet</Button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width="max-w-md"
        title="Supprimer ce projet ?"
        subtitle="Cette action est irréversible."
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy} disabled={confirmText.trim() !== phrase}>
              <Trash2 className="size-4" /> Supprimer définitivement
            </Button>
          </>
        )}
      >
        <Field label={<>Tape <span className="font-mono text-brick">{phrase}</span> pour confirmer</>}>
          <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </section>
  )
}
