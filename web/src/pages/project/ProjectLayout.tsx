import { BookOpen, Brain, FileText, FlaskConical, Lightbulb, PackageCheck, Pause, Play, Settings2, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, Route, Routes, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { AGENT_STATUS, describeCall, fmtTokens, PROJECT_STATUS } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'
import { useShallow } from 'zustand/react/shallow'
import { Badge, Button, Spinner, cx } from '../../components/ui'
import { StatusDot } from '../../layout/AppShell'
import { Elapsed } from '../../components/Transcript'
import { ProjectDropOverlay, UploadTray } from '../../components/Documents'
import { TokenMeter } from '../../components/TokenMeter'
import { Lab } from './Lab'
import { Memory } from './Memory'
import { Hypotheses } from './Hypotheses'
import { Sources } from './Sources'
import { Agents } from './Agents'
import { Files } from './Files'
import { Publication } from './Publication'
import { ProjectSettings } from './ProjectSettings'

export function ProjectLayout() {
  const { id } = useParams<{ id: string }>()
  const open = useProject(s => s.open)
  const project = useProject(s => s.project)
  const loading = useProject(s => s.loading)
  const error = useProject(s => s.error)
  const counts = useProject(useShallow(s => ({
    notes: Object.values(s.notes).filter(n => n.status === 'active').length,
    hypotheses: Object.keys(s.hypotheses).length,
    sources: Object.keys(s.sources).length,
    agents: s.agents.filter(a => ['thinking', 'tool', 'waiting'].includes(a.status)).length,
  })))

  useEffect(() => {
    if (id) return open(id)
  }, [id, open])

  if (error) return <div className="p-10 text-brick">Erreur : {error}</div>
  if (loading || !project || project.id !== id) {
    return <div className="flex h-full items-center justify-center text-ink-400"><Spinner className="size-6 text-amber" /></div>
  }

  return (
    <div className="flex h-full flex-col">
      <Header />
      <Instruments />
      <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-2.5 pt-1">
        <Tab to="" icon={<FlaskConical className="size-3.5" />} label="Laboratoire" end />
        <Tab to="memory" icon={<Brain className="size-3.5" />} label="Mémoire" count={counts.notes} />
        <Tab to="hypotheses" icon={<Lightbulb className="size-3.5" />} label="Hypothèses" count={counts.hypotheses} />
        <Tab to="sources" icon={<BookOpen className="size-3.5" />} label="Sources" count={counts.sources} />
        <Tab to="agents" icon={<Users className="size-3.5" />} label="Agents" count={counts.agents} />
        <Tab to="files" icon={<FileText className="size-3.5" />} label="Fichiers & rapports" />
        <Tab to="publication" icon={<PackageCheck className="size-3.5" />} label="Publication" />
        <Tab to="settings" icon={<Settings2 className="size-3.5" />} label="Réglages" />
      </nav>
      <div className="min-h-0 flex-1 px-2 pb-2">
        <Routes>
          <Route index element={<Lab />} />
          <Route path="memory" element={<Pane><Memory /></Pane>} />
          <Route path="hypotheses" element={<Pane><Hypotheses /></Pane>} />
          <Route path="sources" element={<Pane><Sources /></Pane>} />
          <Route path="agents" element={<Pane><Agents /></Pane>} />
          <Route path="files" element={<Pane><Files /></Pane>} />
          <Route path="publication" element={<Pane><Publication /></Pane>} />
          <Route path="settings" element={<Pane><ProjectSettings /></Pane>} />
        </Routes>
      </div>
      <ProjectDropOverlay projectId={project.id} />
      <UploadTray projectId={project.id} />
    </div>
  )
}

/** Rounded surface that holds a project tab, inset from the sheet edges. */
function Pane({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-hidden rounded-xl border border-ink-750/80 bg-ink-925">{children}</div>
}

function Tab({ to, icon, label, count, end }: { to: string; icon: ReactNode; label: string; count?: number; end?: boolean }) {
  const id = useProject(s => s.id)
  return (
    <NavLink
      to={`/p/${id}${to ? `/${to}` : ''}`}
      end={end}
      className={({ isActive }) => cx(
        'flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors [&>svg]:transition-colors',
        isActive ? 'bg-ink-800 text-ink-100 shadow-[inset_0_0_0_1px_var(--color-ink-700)] [&>svg]:text-amber' : 'text-ink-400 hover:bg-ink-875 hover:text-ink-200',
      )}
    >
      {icon}
      {label}
      {count ? <span className="font-mono text-[10px] text-ink-500">{count}</span> : null}
    </NavLink>
  )
}

function Header() {
  const project = useProject(s => s.project)!
  const toast = useApp(s => s.toast)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const st = PROJECT_STATUS[project.status]
  const active = project.status === 'running' || project.status === 'waiting_human'

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      if (active) await api.pause(project.id)
      else await api.start(project.id)
    } catch (error) {
      toast({ title: 'Impossible de lancer', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="flex items-start gap-6 px-6 pb-3 pt-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <Badge tone={st.tone}><StatusDot status={project.status} className="size-1.5" />{st.label}</Badge>
          {project.domain ? <span className="kicker !text-amber/70">{project.domain}</span> : null}
          <span className="kicker">· {project.config.mode === 'autonomous' ? 'autonome' : 'interactif'} · permissions {project.config.permission === 'smart' ? 'intelligentes' : project.config.permission === 'ask' ? 'sur demande' : 'automatiques'}</span>
        </div>
        <h1 className="display mt-1.5 truncate text-[26px] font-normal leading-tight text-paper">{project.title}</h1>
        <p onClick={() => setExpanded(e => !e)} className={cx('mt-1 max-w-4xl cursor-pointer text-[12.5px] leading-relaxed text-ink-300', !expanded && 'line-clamp-1')} title="Cliquer pour déplier">
          {project.question}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-1">
        <Button variant={active ? 'outline' : 'primary'} onClick={() => void toggle()} loading={busy}>
          {active ? <><Pause className="size-4" /> Mettre en pause</> : <><Play className="size-4" /> {project.status === 'idle' && !project.stats?.steps ? 'Lancer la recherche' : 'Reprendre'}</>}
        </Button>
      </div>
    </header>
  )
}

/** The instrument strip: live telemetry of the research session. */
function Instruments() {
  const project = useProject(s => s.project)!
  const agents = useProject(s => s.agents)
  const usage = useProject(s => s.usage)
  const toolRuns = useProject(s => s.toolRuns)
  const requests = useProject(s => s.requests)
  const leadId = `lead_${project.id}`
  const lead = agents.find(a => a.id === leadId)
  const u = usage[leadId]
  const ctx = u?.contextWindow ? Math.min(1, u.contextTokens / u.contextWindow) : 0
  const compactAt = project.config.compactAt
  const activeAgents = agents.filter(a => a.id !== leadId && ['thinking', 'tool', 'waiting'].includes(a.status))
  const pending = requests.filter(r => r.status === 'pending').length
  const lastRun = useMemo(() => Object.values(toolRuns).filter(r => r.agentId === leadId).sort((a, b) => b.createdAt - a.createdAt)[0], [toolRuns, leadId])
  const activity = lead && ['thinking', 'tool', 'waiting'].includes(lead.status)
    ? lead.status === 'thinking' ? 'Réflexion…' : lead.status === 'waiting' ? 'Attend une réponse humaine' : lastRun ? describeCall(lastRun.tool, lastRun.args) : 'Outil en cours'
    : project.status === 'finished' ? 'Recherche terminée' : project.status === 'paused' ? 'En pause' : project.status === 'error' ? 'Arrêtée sur une erreur' : 'En attente'
  const liveStream = useProject(s => s.live[leadId])
  const since = lead?.status === 'tool' && lastRun?.status === 'running' ? lastRun.createdAt : lead?.status === 'thinking' ? liveStream?.startedAt : undefined

  return (
    <div className="flex items-stretch gap-2 px-4 pb-2 text-[11.5px] max-[1100px]:flex-wrap">
      <Cell label="Activité du chercheur principal" className="min-w-[220px] flex-[2.2]">
        <div className="flex min-w-0 items-center gap-2">
          {lead && AGENT_STATUS[lead.status].live ? <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-amber" /> : null}
          <span className="truncate text-ink-200" title={activity}>{activity}</span>
          {since ? <Elapsed since={since} className="ml-auto shrink-0" /> : null}
        </div>
      </Cell>
      <Cell label={`Contexte · compaction à ${Math.round(compactAt * 100)} %`} className="min-w-[200px] flex-[1.4]">
        <div className="flex items-center gap-2">
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
            <div className={cx('h-full rounded-full transition-all duration-700', ctx > compactAt * 0.9 ? 'bg-brick' : ctx > compactAt * 0.6 ? 'bg-amber' : 'bg-teal')} style={{ width: `${ctx * 100}%` }} />
            <div className="absolute inset-y-0 w-px bg-ink-300/60" style={{ left: `${compactAt * 100}%` }} />
          </div>
          <span className="font-mono text-ink-300">{u ? `${fmtTokens(u.contextTokens)}/${fmtTokens(u.contextWindow)}` : '—'}</span>
        </div>
      </Cell>
      <Cell label="Étapes"><Num v={lead?.steps ?? 0} suffix={project.config.maxSteps ? `/${project.config.maxSteps}` : ''} /></Cell>
      <Cell label="Tokens" className="min-w-[210px] flex-[1.6]"><TokenMeter /></Cell>
      <Cell label="Agents actifs">
        <div className="flex items-center gap-1.5">
          <Num v={activeAgents.length} />
          <div className="flex -space-x-0.5">
            {activeAgents.slice(0, 6).map(a => <span key={a.id} title={`${a.name} — ${AGENT_STATUS[a.status].label}`} className="size-2 animate-pulse-soft rounded-full border border-ink-900 bg-sky" />)}
          </div>
        </div>
      </Cell>
      <Cell label="Demandes"><Num v={pending} tone={pending ? 'text-rose' : undefined} /></Cell>
    </div>
  )
}

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex min-w-[96px] flex-1 flex-col justify-center gap-1.5 rounded-xl border border-ink-750/70 bg-ink-900/70 px-3.5 py-2.5', className)}>
      <span className="kicker truncate whitespace-nowrap !text-[9.5px]" title={label}>{label}</span>
      {children}
    </div>
  )
}

function Num({ v, suffix, tone }: { v: number | string; suffix?: string; tone?: string }) {
  return <span className={cx('font-mono text-[15px] leading-none text-paper', tone)}>{v}<span className="text-[11px] text-ink-500">{suffix}</span></span>
}
