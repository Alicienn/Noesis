import { Bell, Cpu, Plug, Search, Server, Sigma, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { cx } from '../components/ui'
import { DefaultsSection } from './settings/Defaults'
import { LeanSection } from './settings/Lean'
import { NotificationsSection } from './settings/Notifications'
import { ProvidersSection } from './settings/Providers'
import { RolesSection } from './settings/Roles'
import { SearchSection } from './settings/Search'
import { ToolsSection } from './settings/Tools'

interface SectionDef {
  path: string
  label: string
  hint: string
  icon: ReactNode
  element: ReactNode
}

const SECTIONS: SectionDef[] = [
  { path: 'providers', label: 'Providers', hint: 'Endpoints, clés, modèles', icon: <Server className="size-4" />, element: <ProvidersSection /> },
  { path: 'roles', label: 'Rôles & modèles', hint: 'Qui pense avec quoi', icon: <Cpu className="size-4" />, element: <RolesSection /> },
  { path: 'search', label: 'Recherche & sources', hint: 'Web et littérature', icon: <Search className="size-4" />, element: <SearchSection /> },
  { path: 'lean', label: 'Vérification formelle', hint: 'Lean, Mathlib, Comparator', icon: <Sigma className="size-4" />, element: <LeanSection /> },
  { path: 'tools', label: 'Outils & MCP', hint: 'Serveurs et catalogue', icon: <Plug className="size-4" />, element: <ToolsSection /> },
  { path: 'notifications', label: 'Notifications', hint: 'Quand te déranger', icon: <Bell className="size-4" />, element: <NotificationsSection /> },
  { path: 'system', label: 'Défauts & système', hint: 'Projets, shell, Python', icon: <SlidersHorizontal className="size-4" />, element: <DefaultsSection /> },
]

export function Settings() {
  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 pb-20 pt-10">
        <header className="animate-rise">
          <div className="kicker mb-2">Configuration · laboratoire</div>
          <h1 className="display text-[44px] font-semibold leading-[1.05] text-paper">Paramètres</h1>
          <p className="mt-3 max-w-xl text-[14px] text-ink-300">
            Branche tes modèles, choisis qui fait quoi, ouvre les sources et les outils — tout est enregistré localement.
          </p>
        </header>

        <div className="mt-9 grid grid-cols-[210px_minmax(0,1fr)] items-start gap-8">
          <nav className="sticky top-6 flex flex-col gap-0.5 animate-rise" aria-label="Sections des paramètres">
            {SECTIONS.map((s, i) => (
              <NavLink
                key={s.path}
                to={`/settings/${s.path}`}
                className={({ isActive }) => cx(
                  'group relative flex items-start gap-2.5 rounded-md px-3 py-2 transition-colors',
                  isActive ? 'bg-ink-850 text-ink-100' : 'text-ink-300 hover:bg-ink-900 hover:text-ink-100',
                )}
              >
                {({ isActive }) => (
                  <>
                    <span className={cx('absolute inset-y-2 left-0 w-px rounded-full transition-colors', isActive ? 'bg-amber' : 'bg-transparent')} />
                    <span className={cx('mt-0.5 transition-colors', isActive ? 'text-amber' : 'text-ink-500 group-hover:text-ink-300')}>{s.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-tight">{s.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-tight text-ink-500">{s.hint}</span>
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-ink-600">{String(i + 1).padStart(2, '0')}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="min-w-0 animate-rise">
            <Routes>
              <Route index element={<Navigate to="providers" replace />} />
              {SECTIONS.map(s => <Route key={s.path} path={`${s.path}/*`} element={s.element} />)}
              <Route path="*" element={<Navigate to="/settings/providers" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </div>
  )
}
