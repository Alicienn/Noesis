import { Check, Eye, EyeOff, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import type { GlobalSettings } from '@shared/types'
import { api } from '../../lib/api'
import { useApp } from '../../store/app'
import { Button, Input, Spinner, cx } from '../../components/ui'

export const MASK = '••••'
export const isMasked = (v?: string): boolean => Boolean(v?.includes(MASK))

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function toastError(title: string, error: unknown): void {
  useApp.getState().toast({ title, body: errorText(error), level: 'error' })
}

/**
 * Local draft of one or more slices of GlobalSettings, with dirty tracking
 * and a save helper that PUTs only those slices.
 */
export function useSettingsDraft<K extends keyof GlobalSettings>(keys: readonly K[]) {
  type Slice = Pick<GlobalSettings, K>
  const [draft, setDraft] = useState<Slice>()
  const [saved, setSaved] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const keyList = keys.join(',')

  const adopt = useCallback((s: GlobalSettings): Slice => {
    const slice = Object.fromEntries(keyList.split(',').map(k => [k, s[k as K]])) as Slice
    setDraft(slice)
    setSaved(JSON.stringify(slice))
    return slice
  }, [keyList])

  useEffect(() => {
    api.settings().then(adopt).catch(e => setLoadError(errorText(e)))
  }, [adopt])

  /** Save the draft (or an explicit patch, e.g. one with unchanged secrets removed). */
  const save = async (patch?: Partial<GlobalSettings>, label = 'Paramètres enregistrés'): Promise<boolean> => {
    if (!draft) return false
    setSaving(true)
    try {
      const next = await api.saveSettings(patch ?? draft)
      adopt(next)
      useApp.getState().toast({ title: label, level: 'success' })
      return true
    } catch (error) {
      toastError('Enregistrement impossible', error)
      return false
    } finally {
      setSaving(false)
    }
  }

  const dirty = draft !== undefined && JSON.stringify(draft) !== saved
  const original = saved ? (JSON.parse(saved) as Slice) : undefined
  return { draft, setDraft, save, saving, dirty, loadError, original }
}

export function SectionHeader({ kicker, title, children, actions }: { kicker: string; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-ink-750 pb-5">
      <div className="min-w-0 max-w-2xl">
        <div className="kicker mb-1.5">{kicker}</div>
        <h2 className="display text-[28px] font-semibold leading-tight text-paper">{title}</h2>
        {children ? <p className="mt-2 text-[13px] leading-relaxed text-ink-300">{children}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function SaveButton({ dirty, saving, onClick, label = 'Enregistrer' }: { dirty: boolean; saving: boolean; onClick: () => void; label?: string }) {
  return (
    <Button variant={dirty ? 'primary' : 'outline'} onClick={onClick} disabled={!dirty} loading={saving}>
      {saving ? null : dirty ? <Save className="size-4" /> : <Check className="size-4" />}
      {dirty ? label : 'À jour'}
    </Button>
  )
}

export function Loading({ error }: { error?: string }) {
  return (
    <div className="flex items-center gap-2 py-16 text-[13px] text-ink-400">
      {error ? <span className="text-brick">Chargement impossible : {error}</span> : <><Spinner /> Chargement…</>}
    </div>
  )
}

/** Password field that keeps a server-masked value untouched until the user types a new one. */
export function SecretInput({ value, onChange, placeholder, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false)
  const masked = isMasked(value)
  return (
    <div className={cx('relative', className)}>
      <Input
        {...rest}
        type={shown || masked ? 'text' : 'password'}
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        onFocus={e => masked && e.currentTarget.select()}
        onChange={e => onChange(e.target.value)}
        className={cx('pr-9 font-mono text-[12.5px]', masked && 'text-ink-400')}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShown(s => !s)}
        title={shown ? 'Masquer' : 'Afficher'}
        disabled={masked}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-ink-500 hover:text-ink-200 disabled:opacity-30 cursor-pointer"
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  )
}

/** Like `Field`, but a <div>: for groups of buttons that must not be activated by clicking the label text. */
export function FieldGroup({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-[12.5px] font-medium text-ink-200">{label}</span>
      {children}
      {hint ? <span className="text-[11.5px] leading-snug text-ink-400">{hint}</span> : null}
    </div>
  )
}

/** Small explanatory callout. */
export function Note({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: 'neutral' | 'amber' | 'brick' | 'teal'; icon?: ReactNode }) {
  return (
    <div className={cx(
      'flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] leading-relaxed',
      tone === 'neutral' && 'border-ink-750 bg-ink-850 text-ink-300',
      tone === 'amber' && 'border-amber/30 bg-amber-soft text-amber',
      tone === 'brick' && 'border-brick/30 bg-brick-soft text-brick',
      tone === 'teal' && 'border-teal/30 bg-teal-soft text-teal',
    )}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  )
}

/** Parse an optional numeric input ('' → undefined). */
export function numOrUndef(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
