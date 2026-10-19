import { AlertTriangle, CheckCircle2, FlaskConical, Inbox, Info, LayoutGrid, Plus, Settings2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { PROJECT_STATUS } from '../lib/format'
import { useApp } from '../store/app'
import { cx } from '../components/ui'

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="17" fill="none" stroke="#f2b544" strokeWidth="3" />
      <circle cx="32" cy="32" r="6" fill="#f2b544" />
      <path d="M32 7v9M32 48v9M7 32h9M48 32h9" stroke="#5fb8a5" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

export function StatusDot({ status, className }: { status: keyof typeof PROJECT_STATUS; className?: string }) {
  const s = PROJECT_STATUS[status]
  const color = { neutral: 'bg-ink-500', amber: 'bg-amber', rose: 'bg-rose', sky: 'bg-sky', teal: 'bg-teal', brick: 'bg-brick', moss: 'bg-moss' }[s.tone]
  return <span title={s.label} className={cx('inline-block size-2 shrink-0 rounded-full', color, s.live && 'animate-pulse-soft', className)} />
}

function NavItem({ to, icon, label, badge }: { to: string; icon: ReactNode; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) => cx(
        'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] transition-colors',
        isActive ? 'bg-ink-850 text-ink-100 shadow-[inset_0_0_0_1px_var(--color-ink-750)]' : 'text-ink-300 hover:bg-ink-900 hover:text-ink-100',
      )}
    >
      <span className="text-ink-400 group-hover:text-ink-200">{icon}</span>
      <span className="flex-1">{label}</span>
      {badge ? <span className="rounded-full bg-rose px-1.5 font-mono text-[10.5px] font-semibold text-ink-950">{badge}</span> : null}
    </NavLink>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const projects = useApp(s => s.projects)
  const inbox = useApp(s => s.inbox)
  const connected = useApp(s => s.connected)
  const navigate = useNavigate()

  return (
    <div className="flex h-full bg-ink-950">
      <aside className="flex w-[244px] shrink-0 flex-col">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <Logo className="size-7" />
          <div className="leading-none">
            <div className="display text-[21px] font-medium text-paper">Noesis</div>
            <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.2em] text-ink-500">research harness</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2.5">
          <NavItem to="/" icon={<LayoutGrid className="size-4" />} label="Projets" />
          <NavItem to="/inbox" icon={<Inbox className="size-4" />} label="Boîte de réception" badge={inbox.length} />
          <NavItem to="/settings" icon={<Settings2 className="size-4" />} label="Paramètres" />
        </nav>
        <div className="mt-5 flex items-center justify-between px-4">
          <span className="kicker">Recherches</span>
          <button onClick={() => navigate('/?new=1')} title="Nouveau projet" className="rounded-lg p-1 text-ink-400 hover:bg-ink-850 hover:text-amber cursor-pointer">
            <Plus className="size-3.5" />
          </button>
        </div>
        <div className="mt-1.5 flex-1 overflow-y-auto px-2.5 pb-3">
          {projects.length === 0 ? <p className="px-2.5 py-2 text-[12px] text-ink-500">Aucun projet pour l'instant.</p> : null}
          {projects.map(p => (
            <NavLink
              key={p.id}
              to={`/p/${p.id}`}
              className={({ isActive }) => cx('flex items-center gap-2.5 rounded-xl px-3 py-1.5 text-[12.5px] transition-colors', isActive ? 'bg-ink-850 text-ink-100 shadow-[inset_0_0_0_1px_var(--color-ink-750)]' : 'text-ink-300 hover:bg-ink-900')}
            >
              <StatusDot status={p.status} />
              <span className="flex-1 truncate">{p.title}</span>
              {p.stats?.pendingRequests ? <span className="font-mono text-[10px] text-rose">{p.stats.pendingRequests}</span> : null}
            </NavLink>
          ))}
        </div>
        <div className="mx-2.5 mb-2.5 flex items-center gap-2 rounded-xl bg-ink-900/70 px-3 py-2 text-[11px] text-ink-500">
          <span className={cx('size-1.5 rounded-full', connected ? 'bg-teal' : 'bg-brick animate-pulse-soft')} />
          {connected ? 'Connecté au laboratoire' : 'Connexion au serveur…'}
          <FlaskConical className="ml-auto size-3.5" />
        </div>
      </aside>
      <div className="min-w-0 flex-1 py-2 pr-2">
        <main className="relative h-full overflow-hidden rounded-2xl border border-ink-750/80 bg-ink-925 shadow-[0_18px_50px_-24px_#000]">{children}</main>
      </div>
      <Toasts />
    </div>
  )
}

function Toasts() {
  const toasts = useApp(s => s.toasts)
  const dismiss = useApp(s => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] flex-col gap-2">
      {toasts.map(t => {
        const Icon = t.level === 'success' ? CheckCircle2 : t.level === 'info' ? Info : AlertTriangle
        const color = t.level === 'success' ? 'text-teal' : t.level === 'error' ? 'text-brick' : t.level === 'warn' ? 'text-amber' : 'text-sky'
        return (
          <div key={t.id} className="pointer-events-auto flex animate-rise gap-3 rounded-2xl border border-ink-700 bg-ink-850/95 p-3 shadow-[0_16px_40px_-12px_#000] backdrop-blur">
            <Icon className={cx('mt-0.5 size-4 shrink-0', color)} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink-100">{t.title}</div>
              {t.body ? <div className="mt-0.5 line-clamp-3 text-[12px] text-ink-300">{t.body}</div> : null}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-ink-500 hover:text-ink-200 cursor-pointer"><X className="size-3.5" /></button>
          </div>
        )
      })}
    </div>
  )
}
