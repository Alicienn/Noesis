import {
  AlertTriangle, Bot, BookOpen, Brain, Check, ChevronRight, Code2, FileText, FlaskConical, Globe, Hand, Lightbulb, Loader2, MessageSquare,
  Network, Plug, Search, ShieldCheck, Sparkles, Square, Terminal, User, X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatMessage, ToolCall, ToolRun } from '@shared/types'
import { describeCall, fmtDuration, fmtTime } from '../lib/format'
import { useProject } from '../store/project'
import type { LiveStream } from '../store/project'
import { api } from '../lib/api'
import { Markdown } from './Markdown'
import { cx } from './ui'

const TOOL_ICON: Array<[RegExp, ReactNode]> = [
  [/^(web_search|fetch_url)$/, <Globe key="g" className="size-3.5" />],
  [/^(paper_|source_|request_pdf)/, <BookOpen key="b" className="size-3.5" />],
  [/^(memory_|core_memory|recall_history)/, <Brain key="m" className="size-3.5" />],
  [/^update_plan$/, <FileText key="p" className="size-3.5" />],
  [/^hypothesis_/, <Lightbulb key="h" className="size-3.5" />],
  [/^python$/, <Code2 key="py" className="size-3.5" />],
  [/^bash$/, <Terminal key="t" className="size-3.5" />],
  [/^file_/, <FileText key="f" className="size-3.5" />],
  [/^delegate$/, <Network key="d" className="size-3.5" />],
  [/^verify_claim|submit_verdict$/, <ShieldCheck key="v" className="size-3.5" />],
  [/^(ask_human|notify_human)$/, <Hand key="a" className="size-3.5" />],
  [/^(write_report|finish_research|submit_result)$/, <Sparkles key="r" className="size-3.5" />],
  [/^send_message$/, <MessageSquare key="s" className="size-3.5" />],
  [/^mcp__/, <Plug key="mcp" className="size-3.5" />],
]

function toolIcon(name: string): ReactNode {
  return TOOL_ICON.find(([re]) => re.test(name))?.[1] ?? <FlaskConical className="size-3.5" />
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export interface TranscriptProps {
  messages: ChatMessage[]
  toolRuns: Record<string, ToolRun>
  live?: LiveStream
  /** Show supervisor / verifier / agent messages inline (Lab shows them in the margin instead). */
  showBusInline?: boolean
  onNoteClick?: (slug: string) => void
  onAgentClick?: (agentId: string) => void
  /** Compact density for side panels. */
  compact?: boolean
}

export const Transcript = memo(function Transcript({ messages, toolRuns, live, showBusInline = true, onNoteClick, onAgentClick, compact }: TranscriptProps) {
  const results = useMemo(() => {
    const map = new Map<string, ChatMessage>()
    for (const m of messages) if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m)
    return map
  }, [messages])
  const runsByCall = useMemo(() => {
    const map = new Map<string, ToolRun>()
    for (const r of Object.values(toolRuns)) map.set(r.toolCallId, r)
    return map
  }, [toolRuns])

  return (
    <div className={cx('flex flex-col', compact ? 'gap-3' : 'gap-5')}>
      {messages.map(m => {
        if (m.role === 'tool' || m.role === 'system') return null
        if (m.role === 'user') return <UserEntry key={m.id} m={m} showBus={showBusInline} onNoteClick={onNoteClick} />
        return <AssistantEntry key={m.id} m={m} results={results} runs={runsByCall} onNoteClick={onNoteClick} onAgentClick={onAgentClick} compact={compact} />
      })}
      {live ? <LiveEntry live={live} /> : null}
    </div>
  )
})

function Gutter({ time, children, tone = 'text-ink-500' }: { time?: number; children: ReactNode; tone?: string }) {
  return (
    <div className={cx('flex w-14 shrink-0 flex-col items-end gap-1 pt-0.5 font-mono text-[10px]', tone)}>
      {children}
      {time ? <span className="text-ink-600">{fmtTime(time)}</span> : null}
    </div>
  )
}

function UserEntry({ m, showBus, onNoteClick }: { m: ChatMessage; showBus: boolean; onNoteClick?: (s: string) => void }) {
  const origin = m.meta?.origin
  if (origin === 'system' || origin === 'compaction') {
    if (m.meta?.error) {
      return (
        <div className="flex items-start gap-2 rounded-md border border-brick/40 bg-brick-soft px-3 py-2 text-[12.5px] text-brick animate-rise">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{m.content}</span>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-ink-500">
        <span className="h-px flex-1 bg-ink-750" />
        <span className="max-w-[70%] truncate italic" title={m.content}>{origin === 'compaction' ? '⟲ Contexte compacté — résumé enregistré en épisode' : m.content}</span>
        <span className="h-px flex-1 bg-ink-750" />
      </div>
    )
  }
  if (origin && origin !== 'human') {
    if (!showBus) return null
    const tone = origin === 'supervisor' ? 'border-rose/20 bg-[#d98bb00c] text-rose' : origin === 'verifier' ? 'border-teal/20 bg-[#5fb8a50c] text-teal' : 'border-sky/20 bg-[#7fa8de0c] text-sky'
    const label = origin === 'supervisor' ? 'Superviseur' : origin === 'verifier' ? 'Vérificateur' : `Agent ${String(m.meta?.from ?? '')}`
    return (
      <div className={cx('ml-14 rounded-xl border px-3.5 py-2.5 animate-rise', tone)}>
        <div className="kicker !text-current">{label}</div>
        <Markdown text={m.content} small onNoteClick={onNoteClick} className="prose-compact !text-ink-300" />
      </div>
    )
  }
  return (
    <div className="flex gap-3 animate-rise">
      <Gutter time={m.createdAt} tone="text-amber">
        <User className="size-3.5" />
      </Gutter>
      <div className="min-w-0 flex-1 rounded-lg border border-amber/25 bg-amber-soft/40 px-3.5 py-2.5">
        <div className="kicker mb-1 !text-amber/80">Humain</div>
        <Markdown text={m.content} onNoteClick={onNoteClick} />
      </div>
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const words = text.trim().split(/\s+/).length
  return (
    <div className="mb-2">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-[11.5px] italic text-ink-400 hover:text-ink-200 cursor-pointer">
        <ChevronRight className={cx('size-3 transition-transform', open && 'rotate-90')} />
        {live ? <Loader2 className="size-3 animate-spin text-amber" /> : <Brain className="size-3" />}
        Raisonnement · {words} mots
      </button>
      {open ? (
        <div className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap border-l border-ink-700 pl-3 text-[13px] leading-relaxed text-ink-400">{text}</div>
      ) : live ? (
        <div className="mt-1 line-clamp-2 pl-[18px] text-[12.5px] text-ink-500">{text.slice(-280)}</div>
      ) : null}
    </div>
  )
}

function AssistantEntry({ m, results, runs, onNoteClick, onAgentClick, compact }: {
  m: ChatMessage
  results: Map<string, ChatMessage>
  runs: Map<string, ToolRun>
  onNoteClick?: (s: string) => void
  onAgentClick?: (id: string) => void
  compact?: boolean
}) {
  return (
    <div className="flex gap-3 animate-rise">
      {compact ? null : (
        <Gutter time={m.createdAt}>
          <Bot className="size-3.5 text-ink-400" />
        </Gutter>
      )}
      <div className="min-w-0 flex-1">
        {m.reasoning ? <Reasoning text={m.reasoning} /> : null}
        {m.content.trim() ? <Markdown text={m.content} onNoteClick={onNoteClick} small={compact} /> : null}
        {m.toolCalls?.length ? (
          <div className={cx('flex flex-col gap-1.5', m.content.trim() && 'mt-2.5')}>
            {m.toolCalls.map(tc => (
              <ToolCard key={tc.id} call={tc} result={results.get(tc.id)} run={runs.get(tc.id)} onNoteClick={onNoteClick} onAgentClick={onAgentClick} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ToolCard({ call, result, run, onNoteClick, onAgentClick }: { call: ToolCall; result?: ChatMessage; run?: ToolRun; onNoteClick?: (s: string) => void; onAgentClick?: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const args = useMemo(() => safeArgs(call.arguments), [call.arguments])
  const status = run?.status ?? (result ? (result.meta?.toolStatus ?? 'ok') : 'running')
  const [stopping, setStopping] = useState(false)
  const stop = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!run) return
    setStopping(true)
    try {
      await api.cancelToolRun(run.id)
    } catch {
      setStopping(false)
    }
  }
  const content = result?.content ?? run?.result ?? ''
  const subagent = call.name === 'delegate' ? content.match(/\((\w{4}_[a-z0-9]{12})\)/)?.[1] : undefined
  const isReport = ['delegate', 'verify_claim', 'submit_result', 'finish_research'].includes(call.name)
  const figures = useMemo(() => {
    if (status !== 'ok' || !['python', 'bash', 'file_write'].includes(call.name)) return []
    const text = `${String(args.code ?? args.command ?? args.path ?? '')}
${content}`
    return [...new Set([...text.matchAll(/(?:^|[\s'"(=])((?:artifacts|reports|scratch)\/[\w\-./]+\.(?:png|jpe?g|gif|svg|webp))/gi)].map(m => m[1]))].slice(0, 6)
  }, [status, call.name, args, content])

  const statusEl = status === 'running'
    ? <Loader2 className="size-3.5 animate-spin text-amber" />
    : status === 'waiting_approval'
      ? <span className="flex items-center gap-1 font-mono text-[10px] uppercase text-rose"><Hand className="size-3" />approbation</span>
      : status === 'ok'
        ? <Check className="size-3.5 text-teal" />
        : status === 'denied'
          ? <span className="font-mono text-[10px] uppercase text-rose">refusé</span>
          : status === 'cancelled'
            ? <span className="font-mono text-[10px] uppercase text-amber">interrompu</span>
            : status === 'timeout'
              ? <span className="font-mono text-[10px] uppercase text-amber">délai dépassé</span>
              : <X className="size-3.5 text-brick" />

  return (
    <div className={cx('group overflow-hidden rounded-md border transition-colors', status === 'error' ? 'border-brick/30 bg-brick-soft/30' : status === 'waiting_approval' ? 'border-rose/40 bg-[#d98bb012]' : status === 'running' ? 'border-amber/25 bg-ink-900/80' : 'border-ink-750 bg-ink-900/70 hover:border-ink-700')}>
      <div role="button" tabIndex={0} onClick={() => setOpen(o => !o)} onKeyDown={e => e.key === 'Enter' && setOpen(o => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer">
        <span className={cx('shrink-0', status === 'running' ? 'text-amber' : 'text-ink-400')}>{toolIcon(call.name)}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-200" title={describeCall(call.name, args)}>{describeCall(call.name, args)}</span>
        {status === 'running' && run ? <Elapsed since={run.createdAt} /> : run?.durationMs !== undefined ? <span className="font-mono text-[10px] text-ink-500">{fmtDuration(run.durationMs)}</span> : null}
        {statusEl}
        {status === 'running' && run ? (
          <button
            onClick={e => void stop(e)}
            disabled={stopping}
            title="Arrêter cette action (l'agent continue avec une autre approche)"
            className="flex h-5 items-center gap-1 rounded-md border border-ink-600 px-1.5 font-mono text-[10px] uppercase text-ink-300 transition-colors hover:border-brick hover:text-brick disabled:opacity-50 cursor-pointer"
          >
            <Square className="size-2.5 fill-current" />{stopping ? '…' : 'stop'}
          </button>
        ) : null}
        <ChevronRight className={cx('size-3 text-ink-500 transition-transform', open && 'rotate-90')} />
      </div>
      {isReport && content && status !== 'running' && !open ? (
        <div className="border-t border-ink-750/70 px-3 py-2">
          <div className="line-clamp-4"><Markdown text={content} small onNoteClick={onNoteClick} className="prose-compact" /></div>
          {subagent && onAgentClick ? <button onClick={() => onAgentClick(subagent)} className="mt-1 text-[11.5px] text-sky hover:underline cursor-pointer">Voir le travail du sous-agent →</button> : null}
        </div>
      ) : null}
      {figures.length ? <Figures paths={figures} /> : null}
      {open ? (
        <div className="border-t border-ink-750 bg-ink-950/60">
          <ArgsView name={call.name} args={args} raw={call.arguments} />
          {content ? (
            <div className="border-t border-ink-800 px-3 py-2">
              <div className="kicker mb-1">Résultat{result?.meta?.truncated ? ' (tronqué)' : ''}</div>
              {isReport ? <Markdown text={content} small onNoteClick={onNoteClick} className="prose-compact" /> : <ResultText text={content} />}
              {subagent && onAgentClick ? <button onClick={() => onAgentClick(subagent)} className="mt-2 text-[11.5px] text-sky hover:underline cursor-pointer">Voir le travail du sous-agent →</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Live "running for 1 min 12 s" counter. */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const ms = Math.max(0, Date.now() - since)
  const long = ms > 120_000
  return <span className={cx('font-mono text-[10px] tabular-nums', long ? 'text-amber' : 'text-ink-400', className)} title="Temps écoulé">{fmtDuration(Math.floor(ms / 1000) * 1000)}</span>
}

function Figures({ paths }: { paths: string[] }) {
  const projectId = useProject(s => s.id)
  const [zoom, setZoom] = useState<string | null>(null)
  if (!projectId) return null
  return (
    <div className="flex flex-wrap gap-2 border-t border-ink-750/70 px-3 py-2">
      {paths.map(p => (
        <button key={p} onClick={() => setZoom(p)} className="group overflow-hidden rounded-md border border-ink-700 bg-paper/95 cursor-zoom-in" title={p}>
          <img src={api.fileUrl(projectId, p)} alt={p} className="h-28 w-auto max-w-[260px] object-contain transition-transform group-hover:scale-[1.02]" onError={e => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }} />
        </button>
      ))}
      {zoom ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 p-8 backdrop-blur-sm cursor-zoom-out" onClick={() => setZoom(null)}>
          <img src={api.fileUrl(projectId, zoom)} alt={zoom} className="max-h-full max-w-full rounded-lg bg-paper shadow-2xl" />
        </div>
      ) : null}
    </div>
  )
}

function ArgsView({ name, args, raw }: { name: string; args: Record<string, unknown>; raw: string }) {
  if (name === 'python' && typeof args.code === 'string') return <Code lang="python" code={args.code} />
  if (name === 'bash' && typeof args.command === 'string') return <Code lang="bash" code={`$ ${args.command}`} />
  if (['memory_write', 'write_report'].includes(name) && typeof args.content === 'string') {
    return (
      <div className="max-h-80 overflow-y-auto px-3 py-2">
        <div className="kicker mb-1">{String(args.title ?? '')}</div>
        <Markdown text={args.content} small />
      </div>
    )
  }
  let pretty = raw
  try {
    pretty = JSON.stringify(JSON.parse(raw || '{}'), null, 2)
  } catch {
    // keep raw
  }
  return <Code lang="json" code={pretty} />
}

function Code({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="prose-noesis px-3 py-2">
      <pre className="!my-0 max-h-80 !bg-transparent !border-0 !p-0"><code className={`language-${lang}`}>{code}</code></pre>
    </div>
  )
}

function ResultText({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const long = text.length > 2400
  return (
    <div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-300">{full || !long ? text : `${text.slice(0, 2400)}…`}</pre>
      {long ? <button onClick={() => setFull(f => !f)} className="mt-1 text-[11px] text-amber hover:underline cursor-pointer">{full ? 'Réduire' : `Tout afficher (${text.length} caractères)`}</button> : null}
    </div>
  )
}

function LiveEntry({ live }: { live: LiveStream }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.round((Date.now() - live.startedAt) / 1000)
  return (
    <div className="flex gap-3">
      <Gutter>
        <span className="relative flex size-3.5 items-center justify-center">
          <span className="absolute inline-flex size-3 animate-ping rounded-full bg-amber/40" />
          <span className="size-2 rounded-full bg-amber" />
        </span>
        <span className="text-amber/70">{elapsed}s</span>
      </Gutter>
      <div className="min-w-0 flex-1">
        {live.reasoning ? <Reasoning text={live.reasoning} live={!live.text} /> : null}
        {live.text ? <Markdown text={live.text} /> : null}
        {!live.text && !live.reasoning && live.toolCalls.length === 0 ? (
          <div className="flex items-center gap-2 text-[12.5px] italic text-ink-400"><Search className="size-3.5 animate-pulse-soft text-amber" />Réflexion en cours…</div>
        ) : null}
        {live.toolCalls.length ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {live.toolCalls.map((c, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-dashed border-amber/30 px-2.5 py-1.5 text-[12.5px] text-ink-300">
                <span className="text-amber">{toolIcon(c.name)}</span>
                <span className="truncate">{describeCall(c.name, safeArgs(c.args))}</span>
                <Loader2 className="ml-auto size-3.5 animate-spin text-amber" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Keeps a scroll container pinned to the bottom while the user is near it. */
export function useStickToBottom(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}
