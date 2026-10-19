import { KeyRound, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { PublicProvider } from '../../lib/api'
import { useApp } from '../../store/app'
import { Badge, Button, Empty, IconButton } from '../../components/ui'
import { ProviderForm } from './ProviderForm'
import { Loading, SectionHeader, errorText, toastError } from './shared'

export const PROTOCOL_LABEL = { openai: 'OpenAI', anthropic: 'Anthropic' } as const

export function ProvidersSection() {
  const [providers, setProviders] = useState<PublicProvider[]>()
  const [loadError, setLoadError] = useState<string>()
  /** `null` = list view, `'new'` = creation form, otherwise the provider being edited. */
  const [editing, setEditing] = useState<PublicProvider | 'new' | null>(null)
  /** Bumped after each save so the form re-initialises from the stored (masked) values. */
  const [formVersion, setFormVersion] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    try {
      setProviders(await api.providers())
    } catch (error) {
      setLoadError(errorText(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (p: PublicProvider): Promise<void> => {
    if (!confirm(`Supprimer le provider « ${p.name} » ? Les rôles qui utilisent ses modèles devront être réassignés.`)) return
    try {
      await api.deleteProvider(p.id)
      useApp.getState().toast({ title: `Provider « ${p.name} » supprimé`, level: 'success' })
      await load()
    } catch (error) {
      toastError('Suppression impossible', error)
    }
  }

  if (editing) {
    return (
      <ProviderForm
        key={editing === 'new' ? 'new' : `${editing.id}:${formVersion}`}
        initial={editing === 'new' ? undefined : editing}
        onSaved={p => {
          setEditing(p)
          setFormVersion(v => v + 1)
          void load()
        }}
        onClose={() => setEditing(null)}
      />
    )
  }

  return (
    <>
      <SectionHeader
        kicker="01 · Providers"
        title="Fournisseurs de modèles"
        actions={<Button variant="primary" onClick={() => setEditing('new')}><Plus className="size-4" />Ajouter un provider</Button>}
      >
        Tout endpoint compatible OpenAI Chat Completions ou Anthropic Messages : cloud, routeur ou serveur local.
        Les clés restent sur ta machine et ne reviennent jamais en clair dans le navigateur.
      </SectionHeader>

      {!providers ? <Loading error={loadError} /> : providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-600 bg-ink-900/40">
          <Empty icon={<Server className="size-7" />} title="Aucun provider configuré">
            Ajoute DeepSeek, OpenAI, OpenRouter, Anthropic, Ollama… puis récupère leurs modèles en un clic.
            <div className="mt-4"><Button variant="primary" onClick={() => setEditing('new')}><Plus className="size-4" />Ajouter un provider</Button></div>
          </Empty>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {providers.map((p, i) => <ProviderCard key={p.id} provider={p} delay={i} onEdit={() => setEditing(p)} onDelete={() => void remove(p)} />)}
        </div>
      )}
    </>
  )
}

function ProviderCard({ provider: p, delay, onEdit, onDelete }: { provider: PublicProvider; delay: number; onEdit: () => void; onDelete: () => void }) {
  const preview = p.models.slice(0, 4)
  return (
    <article
      style={{ animationDelay: `${Math.min(delay, 8) * 40}ms` }}
      className="group flex animate-rise flex-col rounded-xl border border-ink-750 bg-ink-900 p-4 transition-colors hover:border-ink-600"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="display truncate text-[18px] text-paper">{p.name}</h3>
            <Badge tone={p.protocol === 'anthropic' ? 'rose' : 'sky'}>{PROTOCOL_LABEL[p.protocol]}</Badge>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-400" title={p.baseURL}>{p.baseURL}</div>
        </div>
        <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100">
          <IconButton title="Modifier" onClick={onEdit}><Pencil className="size-3.5" /></IconButton>
          <IconButton title="Supprimer" onClick={onDelete} className="hover:!text-brick"><Trash2 className="size-3.5" /></IconButton>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {p.hasKey
          ? <Badge tone="teal"><KeyRound className="size-3" />clé {p.apiKey}</Badge>
          : <Badge>sans clé</Badge>}
        <Badge tone={p.models.length ? 'amber' : 'neutral'}>{p.models.length} modèle{p.models.length > 1 ? 's' : ''}</Badge>
        {p.echoReasoning !== undefined ? <Badge tone="moss">reasoning {p.echoReasoning ? 'renvoyé' : 'non renvoyé'}</Badge> : null}
      </div>

      <button type="button" onClick={onEdit} className="mt-3 flex flex-wrap gap-1 border-t border-ink-750 pt-3 text-left cursor-pointer">
        {preview.length === 0 ? <span className="text-[12px] italic text-ink-500">Aucun modèle adopté — clique pour en récupérer.</span> : null}
        {preview.map(m => <span key={m.id} className="max-w-full truncate rounded-md bg-ink-850 px-1.5 py-0.5 font-mono text-[11px] text-ink-300">{m.id}</span>)}
        {p.models.length > preview.length ? <span className="px-1 py-0.5 font-mono text-[11px] text-ink-500">+{p.models.length - preview.length}</span> : null}
      </button>
    </article>
  )
}
