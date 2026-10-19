import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DiscoveredModel } from '@shared/types'
import { fmtTokens } from '../../lib/format'
import { Badge, Button, Modal, cx } from '../../components/ui'

/** Pick which discovered models to adopt. Already-adopted ones start unchecked. */
export function DiscoverModal({ models, adopted, endpoint, onClose, onAdd }: {
  models: DiscoveredModel[]
  adopted: Set<string>
  endpoint: string
  onClose: () => void
  onAdd: (picked: DiscoveredModel[]) => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return models.filter(m => terms.every(t => `${m.id} ${m.name ?? ''} ${m.ownedBy ?? ''}`.toLowerCase().includes(t)))
  }, [models, query])

  const toggle = (id: string): void => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const selectFiltered = (): void => setSelected(prev => new Set([...prev, ...filtered.filter(m => !adopted.has(m.id)).map(m => m.id)]))

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title="Modèles disponibles"
      subtitle={<>{models.length} modèle{models.length > 1 ? 's' : ''} exposé{models.length > 1 ? 's' : ''} par <span className="font-mono">{endpoint}</span></>}
      footer={(
        <div className="flex w-full items-center gap-2">
          <span className="mr-auto font-mono text-[11.5px] text-ink-400">{selected.size} sélectionné{selected.size > 1 ? 's' : ''}</span>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={selected.size === 0} onClick={() => onAdd(models.filter(m => selected.has(m.id)))}>
            Ajouter la sélection{selected.size ? ` (${selected.size})` : ''}
          </Button>
        </div>
      )}
    >
      <div className="sticky -top-4 z-10 -mx-5 -mt-4 mb-2 border-b border-ink-750 bg-ink-900 px-5 pb-3 pt-4">
        <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-925 px-3 focus-within:border-amber/70">
          <Search className="size-3.5 text-ink-500" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filtrer par id ou nom (plusieurs mots possibles)…"
            className="h-9 flex-1 bg-transparent text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
          <span className="font-mono text-[10.5px] text-ink-500">{filtered.length}/{models.length}</span>
        </div>
        <div className="mt-2 flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={selectFiltered} disabled={filtered.length === 0}>Tout sélectionner (filtrés)</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>Tout désélectionner</Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-[12.5px] text-ink-400">Aucun modèle ne correspond à « {query} ».</p>
      ) : (
        <ul className="flex flex-col">
          {filtered.map(m => {
            const isAdopted = adopted.has(m.id)
            const checked = selected.has(m.id)
            return (
              <li key={m.id}>
                <label className={cx('flex items-center gap-3 rounded-md px-2 py-1.5 cursor-pointer transition-colors', checked ? 'bg-amber-soft' : 'hover:bg-ink-850')}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(m.id)} className="size-3.5 shrink-0 accent-[#f2b544]" />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate font-mono text-[12.5px]', isAdopted ? 'text-ink-400' : 'text-ink-100')}>{m.id}</span>
                    {m.name || m.ownedBy ? (
                      <span className="block truncate text-[11px] text-ink-500">{[m.name, m.ownedBy].filter(Boolean).join(' · ')}</span>
                    ) : null}
                  </span>
                  {isAdopted ? <Badge>déjà ajouté</Badge> : null}
                  <span className="w-16 shrink-0 text-right font-mono text-[11px] text-ink-400" title="Fenêtre de contexte">
                    {m.contextWindow ? fmtTokens(m.contextWindow) : '—'}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
