import { Check, ChevronDown, Cpu, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelEntry } from '../lib/api'
import { fmtTokens } from '../lib/format'
import { cx } from './ui'

/** Searchable model selector over every model of every configured provider. */
export function ModelPicker({ models, value, onChange, placeholder = 'Choisir un modèle…', allowEmpty, emptyLabel = 'Hériter / aucun' }: {
  models: ModelEntry[]
  value: string
  onChange: (ref: string) => void
  placeholder?: string
  allowEmpty?: boolean
  emptyLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = models.find(m => m.ref === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    setTimeout(() => inputRef.current?.focus(), 0)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return models.filter(m => terms.every(t => `${m.id} ${m.name ?? ''} ${m.providerName}`.toLowerCase().includes(t)))
  }, [models, query])

  const options = allowEmpty ? [null, ...filtered] : filtered

  const pick = (m: ModelEntry | null): void => {
    onChange(m?.ref ?? '')
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cx('flex h-9 w-full items-center gap-2 rounded-md border bg-ink-900 px-3 text-left text-[13px] transition-colors cursor-pointer', open ? 'border-amber/70' : 'border-ink-700 hover:border-ink-500')}
      >
        <Cpu className="size-3.5 shrink-0 text-ink-500" />
        {selected ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink-100">{selected.id}</span>
            <span className="truncate text-[11.5px] text-ink-500">{selected.providerName}</span>
          </span>
        ) : value ? (
          <span className="flex-1 truncate font-mono text-[12.5px] text-brick" title="Ce modèle n'existe plus dans les providers">{value.split('::')[1] ?? value} (introuvable)</span>
        ) : (
          <span className="flex-1 truncate text-ink-500">{allowEmpty ? emptyLabel : placeholder}</span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-ink-500" />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 z-40 mt-1 animate-rise overflow-hidden rounded-lg border border-ink-700 bg-ink-875 shadow-[0_20px_50px_-12px_#000]">
          <div className="flex items-center gap-2 border-b border-ink-750 px-3">
            <Search className="size-3.5 text-ink-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => {
                setQuery(e.target.value)
                setCursor(0)
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCursor(c => Math.min(options.length - 1, c + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCursor(c => Math.max(0, c - 1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  if (options[cursor] !== undefined) pick(options[cursor])
                } else if (e.key === 'Escape') setOpen(false)
              }}
              placeholder={`Rechercher parmi ${models.length} modèles…`}
              className="h-9 flex-1 bg-transparent text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {models.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12.5px] text-ink-400">Aucun modèle. Ajoute un provider dans Paramètres → Providers.</div>
            ) : options.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12.5px] text-ink-400">Aucun résultat</div>
            ) : (
              options.map((m, i) => (
                <button
                  key={m?.ref ?? '__empty'}
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(m)}
                  className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left cursor-pointer', i === cursor && 'bg-ink-800')}
                >
                  <Check className={cx('size-3.5 shrink-0', (m?.ref ?? '') === value ? 'text-amber' : 'text-transparent')} />
                  {m ? (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-100">{m.id}</span>
                      {m.contextWindow ? <span className="font-mono text-[10.5px] text-ink-500">{fmtTokens(m.contextWindow)}</span> : null}
                      <span className="max-w-[40%] truncate text-[11px] text-ink-500">{m.providerName}</span>
                    </>
                  ) : (
                    <span className="text-[12.5px] italic text-ink-400">{emptyLabel}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
