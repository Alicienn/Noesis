import { ArrowUpRight, BellRing, ChevronDown, History, Inbox as InboxIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { HumanRequest, Project } from '@shared/types'
import { RequestCard } from '../components/RequestCard'
import { Badge, Empty, Spinner, cx } from '../components/ui'
import { StatusDot } from '../layout/AppShell'
import { api } from '../lib/api'
import { useApp } from '../store/app'

interface Group {
  projectId: string
  project?: Project
  requests: HumanRequest[]
}

const byPriority = (a: HumanRequest, b: HumanRequest): number => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt

export function Inbox() {
  const inbox = useApp(s => s.inbox)
  const projects = useApp(s => s.projects)

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, HumanRequest[]>()
    for (const r of inbox) map.set(r.projectId, [...(map.get(r.projectId) ?? []), r])
    return [...map.entries()]
      .map(([projectId, requests]) => ({ projectId, project: projects.find(p => p.id === projectId), requests: requests.sort(byPriority) }))
      .sort((a, b) => Number(b.requests[0].blocking) - Number(a.requests[0].blocking) || a.requests[0].createdAt - b.requests[0].createdAt)
  }, [inbox, projects])

  const blocking = inbox.filter(r => r.blocking).length

  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-16 pt-10">
        <header className="animate-rise">
          <div className="kicker mb-2">Laboratoire · demandes des agents</div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="display text-[40px] font-semibold leading-[1.05] text-paper">
              Boîte de <span className="text-amber">réception</span>
            </h1>
            <div className="flex items-stretch gap-px overflow-hidden rounded-lg border border-ink-750 bg-ink-750">
              <Stat value={inbox.length} label="en attente" />
              <Stat value={blocking} label="bloquantes" accent={blocking > 0} />
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-[14px] text-ink-300">
            Quand un agent a besoin de toi — une question, l'autorisation d'exécuter une commande, un PDF introuvable en accès libre — la demande arrive ici.
            Les demandes <span className="text-rose">bloquantes</span> mettent l'agent en pause jusqu'à ta réponse.
          </p>
          <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-400">
            <BellRing className="size-3.5 text-amber" />
            Une notification Windows est envoyée à chaque nouvelle demande (réglable dans Paramètres → Notifications).
          </div>
        </header>

        <div className="mt-8 flex flex-col gap-8">
          {groups.length === 0 ? (
            <div className="rounded-xl border border-ink-750 bg-ink-900/70">
              <Empty icon={<InboxIcon className="size-8" />} title="Rien en attente">
                Les agents travaillent en autonomie. Tu seras prévenu dès qu'ils auront besoin de toi.
              </Empty>
            </div>
          ) : (
            groups.map(g => <ProjectGroup key={g.projectId} group={g} />)
          )}
        </div>

        <RecentHistory projects={projects} />
      </div>
    </div>
  )
}

function Stat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="bg-ink-900 px-5 py-3">
      <div className={cx('display text-[26px] leading-none', accent ? 'text-rose' : 'text-paper')}>{value}</div>
      <div className="kicker mt-1.5">{label}</div>
    </div>
  )
}

function ProjectGroup({ group }: { group: Group }) {
  const title = group.project?.title ?? group.projectId
  return (
    <section className="animate-rise">
      <div className="mb-3 flex items-center gap-2.5 border-b border-ink-750 pb-2">
        {group.project ? <StatusDot status={group.project.status} /> : null}
        <Link to={`/p/${group.projectId}`} className="group flex min-w-0 items-center gap-1.5 text-ink-100 hover:text-amber">
          <h2 className="display truncate text-[19px]">{title}</h2>
          <ArrowUpRight className="size-3.5 shrink-0 text-ink-500 transition-colors group-hover:text-amber" />
        </Link>
        {group.project?.domain ? <span className="kicker hidden !text-amber/60 sm:inline">{group.project.domain}</span> : null}
        <Badge className="ml-auto">{group.requests.length} en attente</Badge>
      </div>
      <div className="flex flex-col gap-3">
        {group.requests.map(r => <RequestCard key={r.id} request={r} />)}
      </div>
    </section>
  )
}

/** Lazily loaded list of the latest answered / dismissed requests across projects. */
function RecentHistory({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<HumanRequest[] | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (!next || items || loading) return
    setLoading(true)
    try {
      const lists = await Promise.all(projects.map(p => api.requests(p.id).catch(() => [] as HumanRequest[])))
      setItems(lists.flat().filter(r => r.status !== 'pending').sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt)).slice(0, 25))
    } finally {
      setLoading(false)
    }
  }

  const titleOf = (id: string): string | undefined => projects.find(p => p.id === id)?.title

  return (
    <section className="mt-12">
      <button onClick={() => void toggle()} className="flex w-full items-center gap-2 border-b border-ink-750 pb-2 text-left text-ink-300 hover:text-ink-100 cursor-pointer">
        <History className="size-4 text-ink-500" />
        <span className="kicker !text-inherit">Historique récent</span>
        <ChevronDown className={cx('ml-auto size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-[12.5px] text-ink-400"><Spinner className="size-3.5" /> Chargement…</div>
          ) : items && items.length === 0 ? (
            <div className="py-4 text-[12.5px] text-ink-500">Aucune demande traitée pour l'instant.</div>
          ) : (
            items?.map(r => <RequestCard key={r.id} request={r} projectTitle={titleOf(r.projectId)} compact />)
          )}
        </div>
      ) : null}
    </section>
  )
}
