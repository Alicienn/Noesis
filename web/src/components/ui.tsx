import { clsx } from 'clsx'
import { X } from 'lucide-react'
import { useEffect } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export const cx = clsx

type Variant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle'

export function Button({ variant = 'outline', size = 'md', className, children, loading, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 select-none whitespace-nowrap',
        'disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
        variant === 'primary' && 'bg-amber text-ink-950 hover:bg-[#f7c463] shadow-[0_0_0_1px_#f2b544,0_6px_20px_-8px_#f2b544aa]',
        variant === 'outline' && 'border border-ink-700 text-ink-100 hover:border-ink-500 hover:bg-ink-850',
        variant === 'ghost' && 'text-ink-300 hover:text-ink-100 hover:bg-ink-850',
        variant === 'subtle' && 'bg-ink-800 text-ink-100 hover:bg-ink-750',
        variant === 'danger' && 'border border-brick/50 text-brick hover:bg-brick-soft',
        className,
      )}
    >
      {loading ? <Spinner className="size-3.5" /> : null}
      {children}
    </button>
  )
}

export function IconButton({ className, title, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      title={title}
      aria-label={title}
      className={cx(
        'inline-flex size-8 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100 cursor-pointer disabled:opacity-40',
        active && 'bg-ink-800 text-amber',
        className,
      )}
    >
      {children}
    </button>
  )
}

const fieldBase = 'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 text-[13.5px] text-ink-100 placeholder:text-ink-500 transition-colors focus:border-amber/70 focus:outline-none focus:ring-2 focus:ring-amber/15 disabled:opacity-50'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(fieldBase, 'h-9', className)} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(fieldBase, 'py-2 leading-relaxed resize-y', className)} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(fieldBase, 'h-9 pr-8 cursor-pointer appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 12 12%27%3E%3Cpath d=%27M3 4.5l3 3 3-3%27 stroke=%27%23808898%27 fill=%27none%27 stroke-width=%271.5%27/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_10px_center] bg-no-repeat', className)}>
      {children}
    </select>
  )
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-3 cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors', checked ? 'bg-amber border-amber' : 'bg-ink-800 border-ink-600')}
      >
        <span className={cx('absolute top-0.5 size-3.5 rounded-full transition-all', checked ? 'left-[18px] bg-ink-950' : 'left-0.5 bg-ink-400')} />
      </button>
      {label || hint ? (
        <span className="flex flex-col">
          {label ? <span className="text-[13.5px] text-ink-100">{label}</span> : null}
          {hint ? <span className="text-[12px] text-ink-400">{hint}</span> : null}
        </span>
      ) : null}
    </label>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1.5', className)}>
      <span className="text-[12.5px] font-medium text-ink-200">{label}</span>
      {children}
      {hint ? <span className="text-[11.5px] leading-snug text-ink-400">{hint}</span> : null}
    </label>
  )
}

const BADGE_TONES = {
  neutral: 'bg-ink-800 text-ink-300 border-ink-700',
  amber: 'bg-amber-soft text-amber border-amber/30',
  teal: 'bg-teal-soft text-teal border-teal/30',
  brick: 'bg-brick-soft text-brick border-brick/30',
  sky: 'bg-sky-soft text-sky border-sky/30',
  moss: 'bg-[#a3c46c1f] text-moss border-moss/30',
  rose: 'bg-[#d98bb01f] text-rose border-rose/30',
} as const

export type Tone = keyof typeof BADGE_TONES

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-px font-mono text-[10.5px] uppercase tracking-wider whitespace-nowrap', BADGE_TONES[tone], className)}>
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin text-current', className ?? 'size-4')} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/75 p-4 pt-[8vh] backdrop-blur-sm" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={cx('w-full animate-rise overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-[0_30px_80px_-20px_#000]', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-ink-750 px-5 py-4">
          <div>
            <h2 className="display text-[19px] text-paper">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[12.5px] text-ink-400">{subtitle}</p> : null}
          </div>
          <IconButton title="Fermer" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-ink-750 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon ? <div className="mb-1 text-ink-500">{icon}</div> : null}
      <div className="display text-[17px] text-ink-200">{title}</div>
      {children ? <div className="max-w-md text-[13px] text-ink-400">{children}</div> : null}
    </div>
  )
}

export function Panel({ title, kicker, actions, children, className, bodyClassName }: { title?: ReactNode; kicker?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('overflow-hidden rounded-xl border border-ink-750 bg-ink-900/80', className)}>
      {title || actions || kicker ? (
        <header className="flex items-center justify-between gap-3 border-b border-ink-750 px-4 py-2.5">
          <div className="min-w-0">
            {kicker ? <div className="kicker">{kicker}</div> : null}
            {title ? <h3 className="truncate text-[13.5px] font-semibold text-ink-100">{title}</h3> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode; count?: number }> }) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-ink-750 bg-ink-900 p-[3px]">
      {items.map(it => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={cx('flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors cursor-pointer', value === it.value ? 'bg-ink-800 text-ink-100 shadow-[0_1px_2px_#0006]' : 'text-ink-400 hover:text-ink-200')}
        >
          {it.label}
          {it.count !== undefined ? <span className="font-mono text-[10.5px] text-ink-500">{it.count}</span> : null}
        </button>
      ))}
    </div>
  )
}
