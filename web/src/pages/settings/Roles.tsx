import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ModelAssignments, RoleModelConfig } from '@shared/types'
import { api } from '../../lib/api'
import type { ModelEntry } from '../../lib/api'
import { fmtTokens } from '../../lib/format'
import { ModelPicker } from '../../components/ModelPicker'
import { Badge, Field, Input, Select } from '../../components/ui'
import { FieldGroup, Loading, Note, SaveButton, SectionHeader, errorText, numOrUndef, useSettingsDraft } from './shared'

type ChatRole = Exclude<keyof ModelAssignments, 'embedding'>

const CHAT_ROLES: Array<{ key: ChatRole; label: string; purpose: string; advice: string; inherit?: string }> = [
  {
    key: 'lead',
    label: 'Chercheur principal',
    purpose: 'Planifie, lit, calcule, délègue et rédige le rapport. C\'est lui qui porte la recherche.',
    advice: 'Le meilleur modèle de raisonnement dont tu disposes, avec une grande fenêtre de contexte.',
  },
  {
    key: 'supervisor',
    label: 'Superviseur',
    purpose: 'Relit périodiquement la trajectoire du chercheur et signale boucles, dérives et oublis.',
    advice: 'Un modèle rapide et économique suffit ; il lit beaucoup mais écrit peu.',
    inherit: 'Hériter du chercheur principal',
  },
  {
    key: 'verifier',
    label: 'Vérificateur',
    purpose: 'Contre-vérifie les résultats importants : calculs, citations, preuves.',
    advice: 'Un modèle de raisonnement solide, idéalement d\'une autre famille que le principal.',
    inherit: 'Hériter du chercheur principal',
  },
  {
    key: 'subagent',
    label: 'Sous-agents',
    purpose: 'Éclaireurs, expérimentateurs, théoriciens et critiques lancés en parallèle.',
    advice: 'Bon rapport qualité/prix : ils travaillent souvent à plusieurs en même temps.',
    inherit: 'Hériter du chercheur principal',
  },
  {
    key: 'utility',
    label: 'Utilitaire (compaction, mémoire, tournois)',
    purpose: 'Résume le contexte, consolide la mémoire et arbitre les tournois d\'hypothèses.',
    advice: 'Le plus rapide et le moins cher possible, mais fiable pour suivre des consignes.',
    inherit: 'Hériter (sous-agents → principal)',
  },
]

export function RolesSection() {
  const { draft, setDraft, save, saving, dirty, loadError } = useSettingsDraft(['models'] as const)
  const [loaded, setModels] = useState<ModelEntry[]>()
  const models = loaded ?? []
  const [modelsError, setModelsError] = useState<string>()

  useEffect(() => {
    api.models().then(setModels).catch(e => setModelsError(errorText(e)))
  }, [])

  const setRole = (key: ChatRole, patch: Partial<RoleModelConfig>): void =>
    setDraft(d => d && { models: { ...d.models, [key]: { ...d.models[key], ...patch } } })

  return (
    <>
      <SectionHeader
        kicker="02 · Rôles"
        title="Rôles & modèles"
        actions={<SaveButton dirty={dirty} saving={saving} onClick={() => void save(undefined, 'Modèles des rôles enregistrés')} />}
      >
        Chaque famille d'agents peut penser avec un modèle différent. Ces choix valent pour tous les projets, qui peuvent ensuite les surcharger.
      </SectionHeader>

      {!draft ? <Loading error={loadError} /> : (
        <div className="flex flex-col gap-3">
          {modelsError ? <Note tone="brick" icon={<AlertTriangle className="size-3.5" />}>Liste des modèles indisponible : {modelsError}</Note> : null}
          {loaded && loaded.length === 0 ? (
            <Note tone="amber" icon={<AlertTriangle className="size-3.5" />}>
              Aucun modèle disponible pour l'instant.{' '}
              <Link to="/settings/providers" className="inline-flex items-center gap-1 underline underline-offset-2">Configure un provider <ArrowRight className="size-3" /></Link>
            </Note>
          ) : null}

          {CHAT_ROLES.map((r, i) => (
            <RoleCard key={r.key} index={i + 1} role={r} config={draft.models[r.key]} models={models} onChange={p => setRole(r.key, p)} />
          ))}

          <section className="rounded-xl border border-ink-750 bg-ink-900 p-5">
            <RoleHeading index={6} label="Embeddings (recherche sémantique, optionnel)" />
            <p className="mt-1 text-[12.5px] text-ink-300">Active la recherche hybride (mots-clés + sens) dans la mémoire et les sources. Sans modèle, la recherche reste lexicale.</p>
            <p className="mt-0.5 text-[12px] text-ink-500">Un modèle exposant <span className="font-mono">/embeddings</span> (ex. text-embedding-3-small, nomic-embed-text via Ollama).</p>
            <FieldGroup label="Modèle" className="mt-4 max-w-md">
              <ModelPicker
                models={models}
                value={draft.models.embedding.model}
                onChange={ref => setDraft(d => d && { models: { ...d.models, embedding: { model: ref } } })}
                allowEmpty
                emptyLabel="Désactivé"
              />
            </FieldGroup>
          </section>
        </div>
      )}
    </>
  )
}

function RoleHeading({ index, label }: { index: number; label: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-mono text-[10.5px] text-ink-600">{String(index).padStart(2, '0')}</span>
      <h3 className="display text-[18px] text-paper">{label}</h3>
    </div>
  )
}

function RoleCard({ index, role, config, models, onChange }: {
  index: number
  role: (typeof CHAT_ROLES)[number]
  config: RoleModelConfig
  models: ModelEntry[]
  onChange: (p: Partial<RoleModelConfig>) => void
}) {
  const selected = models.find(m => m.ref === config.model)
  return (
    <section className="rounded-xl border border-ink-750 bg-ink-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <RoleHeading index={index} label={role.label} />
        {selected?.contextWindow ? <Badge tone="sky">{fmtTokens(selected.contextWindow)} contexte</Badge> : null}
      </div>
      <p className="mt-1 text-[12.5px] text-ink-300">{role.purpose}</p>
      <p className="mt-0.5 text-[12px] text-ink-500"><span className="text-amber/80">Conseil —</span> {role.advice}</p>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_110px_130px_150px]">
        <FieldGroup label="Modèle">
          <ModelPicker
            models={models}
            value={config.model}
            onChange={ref => onChange({ model: ref })}
            allowEmpty={Boolean(role.inherit)}
            emptyLabel={role.inherit}
          />
        </FieldGroup>
        <Field label="Température">
          <Input type="number" min={0} max={2} step={0.05} value={config.temperature ?? ''} placeholder="défaut" onChange={e => onChange({ temperature: numOrUndef(e.target.value) })} className="font-mono text-[12.5px]" />
        </Field>
        <Field label="Tokens max">
          <Input type="number" min={0} step={256} value={config.maxTokens ?? ''} placeholder="auto" onChange={e => onChange({ maxTokens: numOrUndef(e.target.value) })} className="font-mono text-[12.5px]" />
        </Field>
        <Field label="Effort de raisonnement">
          <Select value={config.reasoningEffort ?? ''} onChange={e => onChange({ reasoningEffort: e.target.value as RoleModelConfig['reasoningEffort'] })}>
            <option value="">Par défaut</option>
            <option value="low">Faible</option>
            <option value="medium">Moyen</option>
            <option value="high">Élevé</option>
          </Select>
        </Field>
      </div>
    </section>
  )
}
