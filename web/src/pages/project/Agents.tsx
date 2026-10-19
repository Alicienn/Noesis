import { ArrowRight, Bot, ChevronRight, Cpu, Stethoscope, Footprints, Gauge, Network, RefreshCw, ScrollText, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ROLE_LABELS } from '@shared/types'
import type { AgentInstance, AgentRole, AgentStatus, BusMessage } from '@shared/types'
import { Markdown } from '../../components/Markdown'
import { NoteDrawer } from '../../components/NoteDrawer'
import { DiagnosticsView } from './Diagnostics'
import { Transcript, useStickToBottom } from '../../components/Transcript'
import { Badge, Empty, IconButton, Spinner, Tabs, cx } from '../../components/ui'
import type { Tone } from '../../components/ui'
import { api } from '../../lib/api'
import type { UsageRow } from '../../lib/api'
import { AGENT_STATUS, ROLE_TONE, fmtAgo, fmtDate, fmtTime, fmtTokens } from '../../lib/format'
import { useProject } from '../../store/project'
import { usePersistentState } from '../../lib/persist'

type Tab = 'agents' | 'bus' | 'usage' | 'diag' | 'logs'

const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-ink-500', amber: 'bg-amber', teal: 'bg-teal', brick: 'bg-brick', sky: 'bg-sky', moss: 'bg-moss', rose: 'bg-rose',
}

const ROLE_ORDER: AgentRole[] = ['lead', 'scout', 'experimenter', 'theorist', 'critic', 'verifier', 'supervisor', 'librarian']

function shortModel(model?: string): string {
  if (!model) return ''
  const id = model.includes('::') ? model.split('::').slice(1).join('::') : model
  return id.split('/').pop() ?? id
}

function AgentDot({ status, className }: { status: AgentStatus; className?: string }) {
  const s = AGENT_STATUS[status]
  return <span title={s.label} className={cx('inline-block size-2 shrink-0 rounded-full', TONE_BG[s.tone], s.live && 'animate-pulse-soft', className)} />
}

export function Agents() {
  const agents = useProject(s => s.agents)
  const bus = useProject(s => s.bus)
  const logs = useProject(s => s.logs)
  const [tab, setTab] = useState<Tab>('agents')
  const [, setParams] = useSearchParams()
  const openAgent = useCallback((id: string) => {
    setParams({ agent: id }, { replace: true })
    setTab('agents')
  }, [setParams])
  const running = agents.filter(a => AGENT_STATUS[a.status].live).length

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-750 bg-ink-925 px-5 py-2.5">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'agents', label: <><Users className="size-3.5" />Agents</>, count: agents.length },
            { value: 'bus', label: <><Network className="size-3.5" />Bus inter-agents</>, count: bus.length },
            { value: 'usage', label: <><Gauge className="size-3.5" />Consommation</> },
            { value: 'diag', label: <><Stethoscope className="size-3.5" />Diagnostic</> },
            { value: 'logs', label: <><ScrollText className="size-3.5" />Journal</>, count: logs.length },
          ]}
        />
        {running ? (
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-amber">
            <span className="size-1.5 rounded-full bg-amber animate-pulse-soft" />
            {running} agent{running > 1 ? 's' : ''} actif{running > 1 ? 's' : ''}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'agents' ? <AgentsView /> : tab === 'bus' ? <BusView onOpenAgent={openAgent} /> : tab === 'usage' ? <UsageView /> : tab === 'diag' ? <DiagnosticsView /> : <LogsView />}
      </div>
    </div>
  )
}

// ───────────────────────────── Agents tree + detail ─────────────────────────────

interface TreeNode {
  agent: AgentInstance
  children: TreeNode[]
}

function buildTree(agents: AgentInstance[]): TreeNode[] {
  const ids = new Set(agents.map(a => a.id))
  const kids = new Map<string, AgentInstance[]>()
  const roots: AgentInstance[] = []
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a])
    else roots.push(a)
  }
  const make = (a: AgentInstance): TreeNode => ({ agent: a, children: (kids.get(a.id) ?? []).sort((x, y) => x.createdAt - y.createdAt).map(make) })
  return roots
    .sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || x.createdAt - y.createdAt)
    .map(make)
}

function AgentsView() {
  const pid = useProject(s => s.id)!
  const agents = useProject(s => s.agents)
  const [params, setParams] = useSearchParams()
  const tree = useMemo(() => buildTree(agents), [agents])
  const [hideDone, setHideDone] = usePersistentState('agents.hideDone', false)
  const finishedCount = agents.filter(a => !PERMANENT.has(a.role) && !AGENT_STATUS[a.status].live).length

  const requested = params.get('agent')
  const selectedId = requested && agents.some(a => a.id === requested) ? requested : agents.find(a => a.id === `lead_${pid}`)?.id ?? agents[0]?.id
  const selected = agents.find(a => a.id === selectedId)
  const visibleTree = useMemo(() => (hideDone ? pruneFinished(tree, selectedId) : tree), [hideDone, tree, selectedId])

  const select = useCallback((id: string) => {
    setParams(p => {
      const next = new URLSearchParams(p)
      next.set('agent', id)
      return next
    }, { replace: true })
  }, [setParams])

  if (agents.length === 0) {
    return (
      <div className="graph-paper h-full">
        <Empty icon={<Bot className="size-8" />} title="Aucun agent pour l'instant">
          Lance la recherche : le chercheur principal apparaîtra ici, puis les sous-agents qu'il délègue.
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[330px] shrink-0 flex-col border-r border-ink-750 bg-ink-925">
        <div className="flex items-center justify-between border-b border-ink-750 px-4 py-2">
          <span className="kicker">Équipe · {agents.length}</span>
          {finishedCount ? (
            <button onClick={() => setHideDone(v => !v)} className="text-[11px] text-ink-400 hover:text-amber cursor-pointer">
              {hideDone ? `Afficher les ${finishedCount} terminés` : 'Masquer les terminés'}
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visibleTree.map(n => <TreeItem key={n.agent.id} node={n} depth={0} selectedId={selectedId} onSelect={select} />)}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {selected ? <AgentDetail key={selected.id} agent={selected} onSelect={select} /> : null}
      </div>
    </div>
  )
}

/** Agents that always exist (not tasks): never hidden. */
const PERMANENT = new Set<AgentRole>(['lead', 'supervisor', 'librarian'])

function pruneFinished(nodes: TreeNode[], keepId?: string): TreeNode[] {
  return nodes
    .map(n => ({ ...n, children: pruneFinished(n.children, keepId) }))
    .filter(n => PERMANENT.has(n.agent.role) || AGENT_STATUS[n.agent.status].live || n.agent.id === keepId || n.children.length > 0)
}

function TreeItem({ node, depth, selectedId, onSelect }: { node: TreeNode; depth: number; selectedId?: string; onSelect: (id: string) => void }) {
  const a = node.agent
  const st = AGENT_STATUS[a.status]
  const active = a.id === selectedId
  // finished children are folded by default to keep the tree readable
  const doneKids = node.children.filter(c => !AGENT_STATUS[c.agent.status].live && c.agent.id !== selectedId && c.children.length === 0)
  const [showDone, setShowDone] = useState(false)
  const shownKids = showDone || doneKids.length <= 1 ? node.children : node.children.filter(c => !doneKids.includes(c))
  return (
    <div className={cx(depth > 0 && 'ml-3 border-l border-ink-750 pl-2')}>
      <button
        onClick={() => onSelect(a.id)}
        className={cx(
          'group my-0.5 flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors cursor-pointer',
          active ? 'border-amber/40 bg-ink-850' : 'border-transparent hover:bg-ink-875',
        )}
      >
        <div className="flex items-center gap-2">
          <AgentDot status={a.status} />
          <span className={cx('min-w-0 flex-1 truncate text-[13px]', active ? 'text-paper' : 'text-ink-100')}>{a.name}</span>
          <Badge tone={ROLE_TONE[a.role]} className="!text-[9.5px]">{a.role}</Badge>
        </div>
        <div className="flex items-center gap-2 pl-4 font-mono text-[10.5px] text-ink-500">
          <span className={cx(st.live && 'text-amber')}>{st.label}</span>
          <span>·</span>
          <span>{a.steps} ét.</span>
          {a.model ? <><span>·</span><span className="truncate" title={a.model}>{shortModel(a.model)}</span></> : null}
        </div>
        {a.task && a.role !== 'lead' ? <div className="line-clamp-2 pl-4 text-[11.5px] leading-snug text-ink-400">{a.task.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').slice(0, 240)}</div> : null}
      </button>
      {shownKids.map(c => <TreeItem key={c.agent.id} node={c} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />)}
      {doneKids.length > 1 ? (
        <button onClick={() => setShowDone(v => !v)} className="ml-3 mt-0.5 flex items-center gap-1.5 border-l border-ink-750 py-1 pl-3 text-[11px] text-ink-500 hover:text-ink-200 cursor-pointer">
          <ChevronRight className={cx('size-3 transition-transform', showDone && 'rotate-90')} />
          {showDone ? 'Replier' : `${doneKids.length} sous-agents terminés`}
        </button>
      ) : null}
    </div>
  )
}

function AgentDetail({ agent, onSelect }: { agent: AgentInstance; onSelect: (id: string) => void }) {
  const navigate = useNavigate()
  const pid = useProject(s => s.id)!
  const messages = useProject(s => s.messages[agent.id])
  const toolRuns = useProject(s => s.toolRuns)
  const live = useProject(s => s.live[agent.id])
  const loadAgentMessages = useProject(s => s.loadAgentMessages)
  const [loading, setLoading] = useState(false)
  const lastStatus = useRef<AgentStatus | null>(null)

  // load once if absent, then refresh whenever the agent changes state
  useEffect(() => {
    const first = lastStatus.current === null
    if (lastStatus.current === agent.status) return
    lastStatus.current = agent.status
    if (first && useProject.getState().messages[agent.id]) return
    setLoading(true)
    loadAgentMessages(agent.id).catch(() => undefined).finally(() => setLoading(false))
  }, [agent.id, agent.status, loadAgentMessages])

  const agentRuns = useMemo(() => Object.fromEntries(Object.entries(toolRuns).filter(([, r]) => r.agentId === agent.id)), [toolRuns, agent.id])
  const list = messages ?? []
  const scrollRef = useStickToBottom(`${list.length}:${live?.text.length ?? 0}:${live?.reasoning.length ?? 0}:${live?.toolCalls.length ?? 0}`)
  const st = AGENT_STATUS[agent.status]
  const [noteSlug, setNoteSlug] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col">
      <NoteDrawer slug={noteSlug} onClose={() => setNoteSlug(null)} onNavigate={setNoteSlug} />
      <header className="border-b border-ink-750 bg-ink-900 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ROLE_TONE[agent.role]}>{ROLE_LABELS[agent.role]}</Badge>
          <Badge tone={st.tone}><AgentDot status={agent.status} className="size-1.5" />{st.label}</Badge>
          {loading ? <Spinner className="size-3.5 text-ink-500" /> : null}
          <span className="ml-auto font-mono text-[10.5px] text-ink-500" title={fmtDate(agent.createdAt)}>créé {fmtAgo(agent.createdAt)}</span>
        </div>
        <h2 className="display mt-2 text-[24px] leading-tight text-paper">{agent.name}</h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-400">
          {agent.model ? <span className="flex items-center gap-1.5 font-mono" title={agent.model}><Cpu className="size-3.5" />{shortModel(agent.model)}</span> : null}
          <span className="flex items-center gap-1.5"><Footprints className="size-3.5" />{agent.steps} étapes</span>
          {agent.parentId ? (
            <button onClick={() => onSelect(agent.parentId!)} className="flex items-center gap-1 hover:text-amber cursor-pointer">
              <ArrowRight className="size-3.5 rotate-180" />parent : <span className="font-mono">{agent.parentId}</span>
            </button>
          ) : null}
          {agent.finishedAt ? <span>terminé {fmtAgo(agent.finishedAt)}</span> : null}
        </div>
      </header>
      <div ref={scrollRef} className="graph-paper min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-5">
          {agent.task ? (
            <section className="rounded-lg border border-ink-750 bg-ink-900/90 px-4 py-3">
              <div className="kicker mb-1.5">Mission</div>
              <div className="max-h-56 overflow-y-auto pr-1"><Markdown text={agent.task} small className="text-[13px]" /></div>
            </section>
          ) : null}
          {list.length === 0 && !live ? (
            loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-ink-400"><Spinner className="size-4" />Chargement du fil…</div>
            ) : (
              <Empty title="Fil vide">Cet agent n'a encore rien produit.</Empty>
            )
          ) : (
            <Transcript
              compact
              showBusInline
              messages={list}
              toolRuns={agentRuns}
              live={live}
              onAgentClick={onSelect}
              onNoteClick={setNoteSlug}
            />
          )}
          {agent.result ? (
            <section className="rounded-lg border border-teal/30 bg-ink-900/95 px-4 py-3">
              <div className="kicker mb-1.5 !text-teal">Résultat rendu</div>
              <Markdown text={agent.result} className="text-[13.5px]" />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────── Bus ─────────────────────────────

const BUS_TONE: Record<BusMessage['kind'], Tone> = {
  suggestion: 'sky', warning: 'amber', critical: 'brick', info: 'neutral', report: 'teal', verification: 'teal', reply: 'moss',
}

function useAgentName(): (id: string) => string {
  const agents = useProject(s => s.agents)
  return useCallback((id: string) => {
    if (id === 'human') return 'Humain'
    return agents.find(a => a.id === id)?.name ?? id
  }, [agents])
}

function BusView({ onOpenAgent }: { onOpenAgent: (id: string) => void }) {
  const bus = useProject(s => s.bus)
  const agents = useProject(s => s.agents)
  const name = useAgentName()
  const ref = useStickToBottom(bus.length)

  const agentLink = (id: string) => (
    <button onClick={() => agents.some(a => a.id === id) && onOpenAgent(id)} className="truncate font-medium text-ink-100 hover:text-amber cursor-pointer" title={id}>{name(id)}</button>
  )

  return (
    <div ref={ref} className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-6">
        {bus.length === 0 ? (
          <Empty icon={<Network className="size-8" />} title="Aucun échange">
            Les suggestions du superviseur, verdicts des vérificateurs et messages entre agents s'afficheront ici.
          </Empty>
        ) : null}
        {bus.map(m => (
          <article key={m.id} className={cx('rounded-lg border bg-ink-900/95 px-4 py-3', m.kind === 'critical' ? 'border-brick/40' : 'border-ink-750')}>
            <header className="mb-1.5 flex flex-wrap items-center gap-2 text-[12.5px]">
              {agentLink(m.from)}
              <ArrowRight className="size-3.5 shrink-0 text-ink-500" />
              {agentLink(m.to)}
              <Badge tone={BUS_TONE[m.kind]}>{m.kind}</Badge>
              <span className="ml-auto font-mono text-[10.5px] text-ink-500" title={fmtDate(m.createdAt)}>{fmtTime(m.createdAt)}</span>
            </header>
            <Markdown text={m.content} small className="text-[13px]" />
          </article>
        ))}
      </div>
    </div>
  )
}

// ───────────────────────────── Usage ─────────────────────────────

function UsageView() {
  const pid = useProject(s => s.id)!
  const name = useAgentName()
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setRows(await api.usage(pid))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [pid])

  useEffect(() => {
    void load()
  }, [load])

  const sorted = useMemo(() => (rows ?? []).map(r => ({ ...r, total: r.promptTokens + r.completionTokens })).sort((a, b) => b.total - a.total), [rows])
  const max = Math.max(1, ...sorted.map(r => r.total))
  const totals = sorted.reduce((a, r) => ({ calls: a.calls + r.calls, prompt: a.prompt + r.promptTokens, completion: a.completion + r.completionTokens, cached: a.cached + (r.cachedTokens ?? 0) }), { calls: 0, prompt: 0, completion: 0, cached: 0 })
  const hit = (cached: number, prompt: number): string => (cached > 0 && prompt > 0 ? `${Math.round((cached / prompt) * 100)} %` : '—')
  // the live counters refresh after every call: follow them instead of a stale snapshot
  const calls = useProject(s => s.project?.stats?.calls)
  useEffect(() => {
    if (calls) void load()
  }, [calls, load])

  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="flex flex-wrap items-stretch gap-2">
            {[
              { k: 'appels', v: String(totals.calls) },
              { k: 'prompt', v: fmtTokens(totals.prompt) },
              { k: 'dont cache', v: hit(totals.cached, totals.prompt) },
              { k: 'complétion', v: fmtTokens(totals.completion) },
              { k: 'total', v: fmtTokens(totals.prompt + totals.completion) },
            ].map(s => (
              <div key={s.k} className="rounded-xl border border-ink-750 bg-ink-900 px-4 py-2.5">
                <div className="display text-[22px] leading-none text-paper">{s.v}</div>
                <div className="kicker mt-1">{s.k}</div>
              </div>
            ))}
          </div>
          <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
          </IconButton>
        </div>
        {error ? <div className="mb-3 rounded-md border border-brick/30 bg-brick-soft px-3 py-2 text-[12.5px] text-brick">{error}</div> : null}
        <div className="overflow-x-auto rounded-lg border border-ink-750 bg-ink-900/95">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-ink-750 text-left">
                {['Agent', 'Modèle', 'Appels', 'Prompt', 'Cache', 'Complétion', 'Total', ''].map((h, i) => (
                  <th key={i} className={cx('kicker px-3 py-2 font-normal', i >= 2 && i <= 6 && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows === null ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-400"><Spinner className="mx-auto size-4" /></td></tr>
              ) : sorted.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-400">Aucun appel de modèle enregistré.</td></tr>
              ) : (
                sorted.map(r => (
                  <tr key={`${r.agentId}|${r.model}`} className="border-b border-ink-800 last:border-0 hover:bg-ink-875">
                    <td className="max-w-[200px] truncate px-3 py-2 text-ink-100" title={r.agentId}>{name(r.agentId)}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 font-mono text-[11.5px] text-ink-300" title={r.model}>{shortModel(r.model)}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-300">{r.calls}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-300">{fmtTokens(r.promptTokens)}</td>
                    <td className={cx('px-3 py-2 text-right font-mono', (r.cachedTokens ?? 0) > 0 ? 'text-teal' : 'text-ink-500')} title={`${fmtTokens(r.cachedTokens ?? 0)} tokens d'entrée servis depuis le cache`}>{hit(r.cachedTokens ?? 0, r.promptTokens)}</td>
                    <td className="px-3 py-2 text-right font-mono text-ink-300">{fmtTokens(r.completionTokens)}</td>
                    <td className="px-3 py-2 text-right font-mono text-paper">{fmtTokens(r.total)}</td>
                    <td className="w-[28%] px-3 py-2">
                      <div className="flex h-2 overflow-hidden rounded-full bg-ink-800" title={`${Math.round((r.total / max) * 100)} % du plus gros consommateur`}>
                        <div className="h-full bg-teal/80" style={{ width: `${((r.cachedTokens ?? 0) / max) * 100}%` }} />
                        <div className="h-full bg-amber/80" style={{ width: `${((r.promptTokens - (r.cachedTokens ?? 0)) / max) * 100}%` }} />
                        <div className="h-full bg-ink-200/80" style={{ width: `${(r.completionTokens / max) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[11px] text-ink-500">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber/80" />prompt</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-teal/80" />complétion</span>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────── Logs ─────────────────────────────

const LOG_COLOR: Record<string, string> = { info: 'text-ink-300', warn: 'text-amber', error: 'text-brick' }

function LogsView() {
  const logs = useProject(s => s.logs)
  const name = useAgentName()
  const ref = useStickToBottom(logs.length)

  return (
    <div ref={ref} className="h-full overflow-y-auto bg-ink-950 px-5 py-4 font-mono text-[12px] leading-relaxed">
      {logs.length === 0 ? (
        <div className="font-sans">
          <Empty icon={<ScrollText className="size-8" />} title="Journal vide">
            Les événements techniques (compactions, erreurs de providers, reprises…) de cette session s'afficheront ici.
          </Empty>
        </div>
      ) : null}
      {logs.map((l, i) => (
        <div key={i} className="flex gap-3 border-b border-ink-900 py-0.5 hover:bg-ink-900">
          <span className="shrink-0 text-ink-600">{new Date(l.at).toLocaleTimeString('fr-FR')}</span>
          <span className={cx('w-11 shrink-0 uppercase', LOG_COLOR[l.level] ?? 'text-ink-300')}>{l.level}</span>
          {l.agentId ? <span className="max-w-[160px] shrink-0 truncate text-ink-500" title={l.agentId}>{name(l.agentId)}</span> : null}
          <span className={cx('min-w-0 flex-1 whitespace-pre-wrap break-words', l.level === 'error' ? 'text-brick' : l.level === 'warn' ? 'text-amber/90' : 'text-ink-200')}>{l.message}</span>
        </div>
      ))}
    </div>
  )
}
