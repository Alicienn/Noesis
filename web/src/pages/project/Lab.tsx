import {
  AlertTriangle, ArrowDown, ArrowUp, CheckSquare, ChevronRight, Eye, Network, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Play, RotateCcw, ShieldCheck, Sparkles, Square,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AgentInstance, BusMessage, Note } from '@shared/types'
import { ROLE_LABELS } from '@shared/types'
import { api } from '../../lib/api'
import { AGENT_STATUS, fmtAgo, fmtTime, HYP_STATUS, NOTE_TYPE, ROLE_TONE, VERDICT_LABEL, VERDICT_TONE } from '../../lib/format'
import { usePersistentState } from '../../lib/persist'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'
import { Markdown } from '../../components/Markdown'
import { NoteDrawer } from '../../components/NoteDrawer'
import { RequestCard } from '../../components/RequestCard'
import { Elapsed, Transcript, useStickToBottom } from '../../components/Transcript'
import { Badge, Button, Empty, IconButton, Textarea, cx } from '../../components/ui'
import { AssuranceBadge } from '../../components/Assurance'
import { fileKind } from '../../components/Documents'

const LIVE = new Set(['thinking', 'tool', 'waiting'])

/**
 * The laboratory: the lead's notebook in the middle, the research state on
 * the left, and the "marginalia" — supervisor, verifier, sub-agents, human
 * requests — in the right margin. Both side columns can be folded away.
 */
export function Lab() {
  const [noteSlug, setNoteSlug] = useState<string | null>(null)
  const [left, setLeft] = usePersistentState('lab.left', true)
  const [right, setRight] = usePersistentState('lab.right', true)
  const cols = `${left ? '290px ' : ''}minmax(0,1fr)${right ? ' 340px' : ''}`
  return (
    <div className="grid h-full gap-2 max-[900px]:!grid-cols-1" style={{ gridTemplateColumns: cols }}>
      {left ? <StateColumn onNote={setNoteSlug} /> : null}
      <Notebook
        onNote={setNoteSlug}
        toolbar={(
          <>
            <IconButton title={left ? 'Masquer la colonne de gauche' : 'Afficher le plan et la mémoire'} onClick={() => setLeft(v => !v)}>
              {left ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
            </IconButton>
            <span className="flex-1" />
            <IconButton title={right ? 'Masquer la marge' : 'Afficher l\'équipe et la marge'} onClick={() => setRight(v => !v)}>
              {right ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            </IconButton>
          </>
        )}
      />
      {right ? <Margin onNote={setNoteSlug} /> : null}
      <NoteDrawer slug={noteSlug} onClose={() => setNoteSlug(null)} onNavigate={setNoteSlug} />
    </div>
  )
}

// ───────────────────────────── left: research state ─────────────────────────────

type PlanLine = { kind: 'item'; checked: boolean; text: string; depth: number } | { kind: 'heading'; text: string } | { kind: 'text'; text: string }

/**
 * Agents write plans in many shapes ("- [ ] a", "1. [x] a", several "[x] …"
 * on one line, headings…). Normalise everything into readable lines.
 */
export function parsePlan(plan: string): PlanLine[] {
  const out: PlanLine[] = []
  for (const raw of plan.split('\n')) {
    if (!raw.trim()) continue
    const boxes = raw.match(/\[[ xX]\]/g)?.length ?? 0
    const parts = boxes > 1 ? raw.split(/(?=\[[ xX]\]\s)/).filter(p => p.trim()) : [raw]
    for (const part of parts) {
      const item = part.match(/^(\s*)(?:[-*+]|\d+[.)])?\s*\[([ xX])\]\s*(.*)$/)
      if (item) {
        out.push({ kind: 'item', checked: item[2] !== ' ', text: item[3].trim(), depth: Math.min(3, Math.floor(item[1].length / 2)) })
        continue
      }
      const heading = part.match(/^\s*#{1,6}\s*(.*)$/)
      if (heading) out.push({ kind: 'heading', text: heading[1].replace(/\*\*/g, '') })
      else out.push({ kind: 'text', text: part.trim() })
    }
  }
  return out
}

function StateColumn({ onNote }: { onNote: (s: string) => void }) {
  const blocks = useProject(s => s.blocks)
  const notes = useProject(s => s.notes)
  const hypotheses = useProject(s => s.hypotheses)
  const sources = useProject(s => s.sources)
  const projectId = useProject(s => s.id)
  const navigate = useNavigate()
  const provided = useMemo(() => Object.values(sources).filter(s => s.origin === 'human').sort((a, b) => a.createdAt - b.createdAt), [sources])
  const plan = blocks.find(b => b.label === 'plan')?.value ?? ''
  const working = blocks.find(b => b.label === 'working')?.value ?? ''
  const lines = useMemo(() => parsePlan(plan), [plan])
  const items = lines.filter((l): l is Extract<PlanLine, { kind: 'item' }> => l.kind === 'item')
  const done = items.filter(i => i.checked).length
  const next = items.find(i => !i.checked)
  const recent = useMemo(() => Object.values(notes).filter(n => n.status === 'active').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7), [notes])
  const topHyps = useMemo(() => Object.values(hypotheses).filter(h => h.status !== 'abandoned').sort((a, b) => b.elo - a.elo).slice(0, 4), [hypotheses])

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-ink-750/80 bg-ink-900/60 max-[900px]:hidden">
      <Section title="Plan de recherche" aside={items.length ? `${done}/${items.length}` : undefined}>
        {items.length ? (
          <div className="mb-3 h-1 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-amber transition-all duration-700" style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
        ) : null}
        {lines.length ? (
          <ul className="flex flex-col gap-1.5">
            {lines.map((l, i) => {
              if (l.kind === 'heading') return <li key={i} className="mt-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-400 first:mt-0">{l.text}</li>
              if (l.kind === 'text') return <li key={i}><Markdown text={l.text} small className="prose-compact !text-[12px] !text-ink-400" onNoteClick={onNote} /></li>
              const isNext = l === next
              return (
                <li
                  key={i}
                  className={cx('flex items-start gap-2 rounded-md px-1 py-0.5 text-[12.5px] leading-snug', l.checked ? 'text-ink-500' : isNext ? 'bg-amber-soft text-paper' : 'text-ink-300')}
                  style={{ marginLeft: l.depth * 12 }}
                >
                  {l.checked ? <CheckSquare className="mt-0.5 size-3.5 shrink-0 text-teal" /> : <Square className={cx('mt-0.5 size-3.5 shrink-0', isNext ? 'text-amber' : 'text-ink-600')} />}
                  <span className={cx(l.checked && 'line-through decoration-ink-600')}>{l.text}</span>
                </li>
              )
            })}
          </ul>
        ) : <p className="text-[12px] text-ink-500">Aucun plan pour l'instant.</p>}
      </Section>

      {working.trim() ? (
        <Section title="Mémoire de travail" collapsible storageKey="lab.working">
          <div className="max-h-64 overflow-y-auto pr-1">
            <Markdown text={working} small className="prose-compact !text-ink-300" onNoteClick={onNote} />
          </div>
        </Section>
      ) : null}

      <Section title="Dernières notes" collapsible storageKey="lab.notes">
        {recent.length ? (
          <ul className="flex flex-col gap-2">
            {recent.map(n => <NoteLine key={n.id} note={n} onClick={() => onNote(n.slug)} />)}
          </ul>
        ) : <p className="text-[12px] text-ink-500">La mémoire long terme est vide.</p>}
      </Section>

      <Section title="Documents fournis" collapsible storageKey="lab.docs" aside={provided.length || undefined}>
        {provided.length ? (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
            {provided.map(d => {
              const k = fileKind(d.file ?? d.title)
              return (
                <li key={d.id}>
                  <button onClick={() => navigate(`/p/${projectId}/sources`)} className="group flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left cursor-pointer hover:bg-ink-850" title={`${d.title}${d.notes ? `
⚠ ${d.notes}` : ''}`}>
                    <span className={cx('shrink-0', k.tone)}>{k.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-200 group-hover:text-amber">{d.title}</span>
                    {d.notes ? <AlertTriangle className="size-3 shrink-0 text-amber/70" /> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
        <p className={cx('text-[11.5px] leading-snug text-ink-500', provided.length && 'mt-2')}>Glisse des fichiers ou des dossiers n'importe où sur la page pour les joindre au contexte.</p>
      </Section>

      <Section title="Hypothèses en tête" collapsible storageKey="lab.hyps" last>
        {topHyps.length ? (
          <ul className="flex flex-col gap-2.5">
            {topHyps.map((h, i) => (
              <li key={h.id} className="flex gap-2">
                <span className="w-4 shrink-0 text-[14px] font-semibold leading-none text-amber/80">{i + 1}</span>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-[12.5px] leading-snug text-ink-200">{h.statement}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge tone={HYP_STATUS[h.status].tone}>{HYP_STATUS[h.status].label}</Badge>
                    <span className="font-mono text-[10px] text-ink-500">Elo {h.elo}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12px] text-ink-500">Aucune hypothèse formulée.</p>}
      </Section>
    </aside>
  )
}

/** Side-panel section with an optional fold, remembered per browser. */
function Section({ title, aside, children, collapsible, storageKey, last }: { title: string; aside?: ReactNode; children: ReactNode; collapsible?: boolean; storageKey?: string; last?: boolean }) {
  const [open, setOpen] = usePersistentState(storageKey ?? `lab.section.${title}`, true)
  const shown = !collapsible || open
  return (
    <section className={cx('px-4 py-3.5', !last && 'border-b border-ink-750')}>
      <div className="flex items-center justify-between gap-2">
        {collapsible ? (
          <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 kicker hover:!text-ink-200 cursor-pointer">
            <ChevronRight className={cx('size-3 transition-transform', shown && 'rotate-90')} />{title}
          </button>
        ) : <span className="kicker">{title}</span>}
        {aside ? <span className="font-mono text-[10.5px] text-ink-400">{aside}</span> : null}
      </div>
      {shown ? <div className="mt-2.5">{children}</div> : null}
    </section>
  )
}

function NoteLine({ note, onClick }: { note: Note; onClick: () => void }) {
  const t = NOTE_TYPE[note.type]
  return (
    <li>
      <button onClick={onClick} className="group w-full text-left cursor-pointer">
        <div className="flex items-center gap-1.5">
          <Badge tone={t.tone}>{t.label}</Badge>
          {note.verification ? <Badge tone={VERDICT_TONE[note.verification.verdict]}>{VERDICT_LABEL[note.verification.verdict]}</Badge> : null}
          <AssuranceBadge note={note} />
        </div>
        <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-ink-200 group-hover:text-amber">{note.title}</div>
      </button>
    </li>
  )
}

// ───────────────────────────── center: the notebook ─────────────────────────────

function Notebook({ onNote, toolbar }: { onNote: (s: string) => void; toolbar: ReactNode }) {
  const id = useProject(s => s.id)!
  const project = useProject(s => s.project)!
  const leadId = `lead_${id}`
  const messages = useProject(s => s.messages[leadId]) ?? []
  const toolRuns = useProject(s => s.toolRuns)
  const live = useProject(s => s.live[leadId])
  const navigate = useNavigate()
  const scrollRef = useStickToBottom(`${messages.length}:${live?.text.length ?? 0}:${live?.reasoning.length ?? 0}:${live?.toolCalls.length ?? 0}`)
  const [away, setAway] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 500)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef])

  return (
    <section className="graph-paper relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-ink-750/80">
      <div className="flex items-center gap-1 border-b border-ink-750/60 bg-ink-925/70 px-2 py-1 backdrop-blur">{toolbar}</div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-6 pb-10 pt-6">
          {messages.length === 0 && !live ? (
            <Empty icon={<Sparkles className="size-8" />} title="Le carnet est vierge">
              Lance la recherche avec le bouton en haut à droite, ou écris une première consigne ci-dessous. Le chercheur principal commencera par cadrer la question et établir un plan.
            </Empty>
          ) : (
            <Transcript
              messages={messages}
              toolRuns={toolRuns}
              live={live}
              showBusInline={false}
              onNoteClick={onNote}
              onAgentClick={agentId => navigate(`/p/${id}/agents?agent=${agentId}`)}
            />
          )}
        </div>
      </div>
      {away ? (
        <button
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
          className="absolute bottom-[132px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-ink-600 bg-ink-850/95 px-3 py-1.5 text-[12px] text-ink-200 shadow-lg backdrop-blur transition-colors hover:border-amber/60 hover:text-amber cursor-pointer"
        >
          <ArrowDown className="size-3.5" />Dernière activité
        </button>
      ) : null}
      <ResumeBanner />
      <Composer projectId={id} running={project.status === 'running' || project.status === 'waiting_human'} />
    </section>
  )
}

/**
 * Tells the human when the main research is not running anymore (paused,
 * crashed, finished) or looks stuck, with a one-click resume.
 */
function ResumeBanner() {
  const project = useProject(s => s.project)!
  const id = project.id
  const leadId = `lead_${id}`
  const messages = useProject(s => s.messages[leadId]) ?? []
  const toolRuns = useProject(s => s.toolRuns)
  const live = useProject(s => s.live[leadId])
  const logs = useProject(s => s.logs)
  const toast = useApp(s => s.toast)
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  const steps = project.stats?.steps ?? messages.filter(m => m.role === 'assistant').length
  const runningTool = Object.values(toolRuns).some(r => r.status === 'running' || r.status === 'waiting_approval')
  const lastActivity = Math.max(
    messages[messages.length - 1]?.createdAt ?? 0,
    ...Object.values(toolRuns).map(r => r.createdAt),
    live?.startedAt ?? 0,
  )
  const idleMin = lastActivity ? Math.floor((Date.now() - lastActivity) / 60_000) : 0
  const lastError = [...messages].reverse().find(m => m.meta?.error)?.content ?? [...logs].reverse().find(l => l.level === 'error')?.message

  const act = async (restart: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (restart) await api.pause(id)
      await api.start(id)
    } catch (error) {
      toast({ title: 'Reprise impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  let tone = 'border-sky/40 bg-sky-soft text-sky'
  let icon: ReactNode = <Play className="size-4" />
  let text: ReactNode
  let action: { label: string; restart: boolean } | undefined
  if (project.status === 'error') {
    tone = 'border-brick/40 bg-brick-soft text-brick'
    icon = <AlertTriangle className="size-4" />
    text = <>La recherche s'est arrêtée sur une erreur{lastError ? <> : <span className="text-ink-300">{lastError.replace(/^Erreur système : /, '').slice(0, 220)}</span></> : '.'}</>
    action = { label: 'Reprendre la recherche', restart: false }
  } else if (project.status === 'paused' && steps > 0) {
    text = 'La recherche est en pause (arrêt manuel, limite atteinte ou redémarrage du serveur). Elle reprendra là où elle s\'est arrêtée.'
    action = { label: 'Reprendre la recherche', restart: false }
  } else if (project.status === 'finished') {
    tone = 'border-teal/40 bg-teal-soft text-teal'
    icon = <Sparkles className="size-4" />
    text = 'Recherche terminée. Tu peux la relancer pour approfondir (donne une consigne ci-dessous ou reprends directement).'
    action = { label: 'Relancer', restart: false }
  } else if (project.status === 'running' && !runningTool && !live && idleMin >= 10) {
    tone = 'border-amber/40 bg-amber-soft text-amber'
    icon = <AlertTriangle className="size-4" />
    text = `Aucune activité depuis ${idleMin} min : la session semble bloquée.`
    action = { label: 'Relancer la session', restart: true }
  } else if (project.status === 'idle' && steps > 0 && project.config.mode === 'autonomous') {
    text = 'La recherche est à l\'arrêt.'
    action = { label: 'Reprendre la recherche', restart: false }
  }
  if (!text || !action) return null

  return (
    <div className="px-6 pb-2">
      <div className={cx('mx-auto flex max-w-[880px] items-center gap-3 rounded-lg border px-3.5 py-2.5 animate-rise', tone)}>
        <span className="shrink-0">{icon}</span>
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-200">{text}</p>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void act(action.restart)}>
          {action.restart ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}{action.label}
        </Button>
      </div>
    </div>
  )
}

function Composer({ projectId, running }: { projectId: string; running: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useApp(s => s.toast)

  const send = async (): Promise<void> => {
    const content = text.trim()
    if (!content) return
    setBusy(true)
    try {
      await api.send(projectId, content)
      setText('')
    } catch (error) {
      toast({ title: 'Message non envoyé', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="px-4 pb-3 pt-2">
      <div className="mx-auto flex max-w-[880px] items-end gap-2 rounded-2xl border border-ink-700 bg-ink-900/95 p-1.5 pl-1 shadow-[0_14px_40px_-18px_#000] backdrop-blur transition-colors focus-within:border-amber/50">
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKey}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={running ? 'Intervenir dans la recherche (pris en compte à la prochaine étape)…' : 'Donner une consigne et lancer / reprendre la recherche…'}
          className="min-h-[38px] resize-none !border-0 !bg-transparent !ring-0"
        />
        <Button variant="primary" onClick={() => void send()} loading={busy} disabled={!text.trim()} className="h-[38px] w-[38px] shrink-0 !rounded-xl !px-0" title="Envoyer (Entrée)">
          <ArrowUp className="size-4" />
        </Button>
      </div>
      <div className="mx-auto mt-1.5 max-w-[880px] px-3 text-[10.5px] text-ink-500">
        Entrée pour envoyer · Maj+Entrée pour un retour à la ligne · {running ? 'l\'agent lira ton message à sa prochaine étape' : 'l\'envoi relance la session'}
      </div>
    </div>
  )
}

// ───────────────────────────── right: marginalia ─────────────────────────────

function Margin({ onNote }: { onNote: (s: string) => void }) {
  const requests = useProject(s => s.requests)
  const bus = useProject(s => s.bus)
  const [showAll, setShowAll] = useState(false)
  const pending = requests.filter(r => r.status === 'pending').sort((a, b) => Number(b.blocking) - Number(a.blocking))
  const notes = bus.filter(b => b.from !== 'human').slice().reverse()
  const visible = showAll ? notes : notes.slice(0, 12)
  const project = useProject(s => s.project)!

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-ink-750/80 bg-ink-900/60 max-[900px]:hidden">
      {pending.length ? (
        <section className="border-b border-ink-750 px-4 py-3.5">
          <span className="kicker !text-rose">En attente de toi · {pending.length}</span>
          <div className="mt-2.5 flex flex-col gap-2.5">
            {pending.map(r => <RequestCard key={r.id} request={r} compact />)}
          </div>
        </section>
      ) : null}

      <Team />

      <section className="flex-1 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <span className="kicker">Marginalia</span>
          {project.config.supervisorEvery > 0 ? <span className="text-[10.5px] text-ink-500">superviseur / {project.config.supervisorEvery} étapes</span> : null}
        </div>
        {notes.length ? (
          <div className="mt-3 flex flex-col gap-4">
            {visible.map(m => <Marginalia key={m.id} m={m} onNote={onNote} />)}
            {notes.length > visible.length ? (
              <button onClick={() => setShowAll(true)} className="text-left text-[11.5px] text-ink-400 hover:text-amber cursor-pointer">Afficher les {notes.length - visible.length} plus anciennes…</button>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-500">Les remarques du superviseur, les verdicts du vérificateur et les messages des agents s'inscriront ici, en marge du carnet.</p>
        )}
      </section>
    </aside>
  )
}

/** Active sub-agents first; finished ones folded into a collapsible group. */
function Team() {
  const id = useProject(s => s.id)!
  const agents = useProject(s => s.agents)
  const navigate = useNavigate()
  const [showDone, setShowDone] = usePersistentState('lab.team.showDone', false)
  const subs = agents.filter(a => !['lead', 'supervisor', 'librarian'].includes(a.role)).sort((a, b) => b.createdAt - a.createdAt)
  const active = subs.filter(a => LIVE.has(a.status))
  const finished = subs.filter(a => !LIVE.has(a.status))
  const open = (a: AgentInstance): void => {
    void navigate(`/p/${id}/agents?agent=${a.id}`)
  }

  return (
    <section className="border-b border-ink-750 px-4 py-3.5">
      <div className="flex items-center justify-between">
        <span className="kicker">Équipe{active.length ? <span className="ml-1.5 !text-amber">· {active.length} au travail</span> : null}</span>
        <button onClick={() => navigate(`/p/${id}/agents`)} className="text-[11px] text-ink-400 hover:text-amber cursor-pointer">tout voir</button>
      </div>
      {subs.length === 0 ? <p className="mt-2 text-[12px] text-ink-500">Aucun sous-agent lancé pour l'instant.</p> : null}
      {active.length ? (
        <ul className="mt-2.5 flex flex-col gap-1">
          {active.map(a => <AgentLine key={a.id} agent={a} onClick={() => open(a)} />)}
        </ul>
      ) : null}
      {finished.length ? (
        <div className="mt-2">
          <button onClick={() => setShowDone(v => !v)} className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[11.5px] text-ink-400 hover:bg-ink-850 hover:text-ink-200 cursor-pointer">
            <ChevronRight className={cx('size-3 transition-transform', showDone && 'rotate-90')} />
            {finished.length} terminé{finished.length > 1 ? 's' : ''}
            <span className="ml-auto flex gap-0.5">
              {finished.slice(0, 10).map(a => <span key={a.id} className={cx('size-1.5 rounded-full', a.status === 'done' ? 'bg-teal' : a.status === 'error' ? 'bg-brick' : 'bg-ink-600')} />)}
            </span>
          </button>
          {showDone ? (
            <ul className="mt-1 flex flex-col gap-1 opacity-80">
              {finished.map(a => <AgentLine key={a.id} agent={a} onClick={() => open(a)} />)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function AgentLine({ agent: a, onClick }: { agent: AgentInstance; onClick: () => void }) {
  const st = AGENT_STATUS[a.status]
  const live = LIVE.has(a.status)
  return (
    <li>
      <button onClick={onClick} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ink-850 cursor-pointer">
        <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', live ? 'animate-pulse-soft bg-amber' : a.status === 'done' ? 'bg-teal' : a.status === 'error' ? 'bg-brick' : 'bg-ink-600')} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <Badge tone={ROLE_TONE[a.role]}>{ROLE_LABELS[a.role].split(' ')[0]}</Badge>
            <span className="truncate text-[11px] text-ink-500">{st.label} · {a.steps} ét.</span>
            {live ? <Elapsed since={a.createdAt} className="ml-auto" /> : null}
          </span>
          {a.task ? <span className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-300">{a.task.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').slice(0, 220)}</span> : null}
        </span>
      </button>
    </li>
  )
}

function Marginalia({ m, onNote }: { m: BusMessage; onNote: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const who = m.from === 'supervisor' ? { label: 'Superviseur', card: 'border-rose/20 bg-[#d98bb00c]', color: 'text-rose', icon: <Eye className="size-3" /> }
    : m.from.startsWith('veri') ? { label: 'Vérificateur', card: 'border-teal/20 bg-[#5fb8a50c]', color: 'text-teal', icon: <ShieldCheck className="size-3" /> }
      : m.to === 'human' ? { label: 'Bilan', card: 'border-amber/25 bg-[#f2b5440f]', color: 'text-amber', icon: <Sparkles className="size-3" /> }
        : { label: m.from, card: 'border-sky/20 bg-[#7fa8de0c]', color: 'text-sky', icon: <Network className="size-3" /> }
  const severity = m.kind === 'critical' ? 'critique' : m.kind === 'warning' ? 'attention' : null
  const long = m.content.length > 360
  return (
    <div className={cx('rounded-xl border px-3 py-2.5 animate-rise', who.card)}>
      <div className={cx('flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider', who.color)}>
        {who.icon}{who.label}
        {severity ? <Badge tone={m.kind === 'critical' ? 'brick' : 'amber'}>{severity}</Badge> : null}
        <span className="ml-auto normal-case tracking-normal text-ink-600" title={fmtAgo(m.createdAt)}>{fmtTime(m.createdAt)}</span>
      </div>
      <div className={cx('mt-1', !open && long && 'line-clamp-[8]')}>
        <Markdown text={m.content} small onNoteClick={onNote} className="prose-compact marginalia !text-[12.5px] !text-ink-300" />
      </div>
      {long ? <button onClick={() => setOpen(o => !o)} className="mt-1 text-[11px] text-ink-500 hover:text-ink-200 cursor-pointer">{open ? 'réduire' : 'lire la suite'}</button> : null}
    </div>
  )
}
