import { Check, CheckCircle2, FileUp, Hand, HelpCircle, Lock, MessageSquareReply, ShieldAlert, X, XCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { HumanRequest, RequestKind } from '@shared/types'
import { api } from '../lib/api'
import { fmtAgo, fmtBytes } from '../lib/format'
import { useApp } from '../store/app'
import { Markdown } from './Markdown'
import { Badge, Button, Spinner, Textarea, cx } from './ui'
import type { Tone } from './ui'

const KIND: Record<RequestKind, { label: string; tone: Tone; icon: ReactNode }> = {
  approval: { label: 'approbation', tone: 'amber', icon: <ShieldAlert className="size-4" /> },
  question: { label: 'question', tone: 'sky', icon: <HelpCircle className="size-4" /> },
  pdf: { label: 'pdf', tone: 'teal', icon: <FileUp className="size-4" /> },
  info: { label: 'info', tone: 'neutral', icon: <Hand className="size-4" /> },
  access: { label: 'accès', tone: 'rose', icon: <Lock className="size-4" /> },
}

type Busy = false | string
type OnDone = (status: HumanRequest['status'], response?: string) => void

/** Actionable card for a request an agent addressed to the human. */
export function RequestCard({ request, projectTitle, compact }: { request: HumanRequest; projectTitle?: string; compact?: boolean }) {
  const [done, setDoneState] = useState<{ status: HumanRequest['status']; response?: string } | null>(null)
  const setDone: OnDone = (status, response) => setDoneState({ status, response })
  const status = done?.status ?? request.status
  const kind = KIND[request.kind] ?? KIND.question

  if (status !== 'pending') return <ResolvedCard request={done ? { ...request, status, response: done.response ?? request.response, resolvedAt: request.resolvedAt ?? Date.now() } : request} status={status} projectTitle={projectTitle} />

  return (
    <article
      className={cx(
        'relative overflow-hidden rounded-lg border bg-ink-900 animate-rise',
        request.blocking ? 'border-rose/40' : 'border-ink-750',
      )}
    >
      {request.blocking ? <div className="shimmer pointer-events-none absolute inset-x-0 top-0 h-px" /> : null}
      <div className={cx('flex flex-col gap-3', compact ? 'p-3' : 'p-4')}>
        <CardHeader request={request} projectTitle={projectTitle} icon={kind.icon} />
        {request.kind === 'approval' ? (
          <ApprovalBody request={request} onDone={setDone} />
        ) : request.kind === 'pdf' ? (
          <PdfBody request={request} onDone={setDone} />
        ) : (
          <QuestionBody request={request} onDone={setDone} compact={compact} />
        )}
      </div>
    </article>
  )
}

function CardHeader({ request, projectTitle, icon }: { request: HumanRequest; projectTitle?: string; icon: ReactNode }) {
  const kind = KIND[request.kind] ?? KIND.question
  return (
    <header className="flex items-start gap-3">
      <div className={cx('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border', request.blocking ? 'border-rose/40 bg-[#d98bb01f] text-rose' : 'border-ink-700 bg-ink-850 text-ink-300')}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={kind.tone}>{kind.label}</Badge>
          {request.blocking ? <Badge tone="rose">bloquant</Badge> : null}
          {projectTitle ? <span className="truncate text-[11.5px] text-amber/80">{projectTitle}</span> : null}
          <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px] text-ink-500">
            <span className="truncate" title={request.agentId}>{shortAgent(request.agentId)}</span>
            <span>·</span>
            <span title={new Date(request.createdAt).toLocaleString('fr-FR')}>{fmtAgo(request.createdAt)}</span>
          </span>
        </div>
        <h3 className="mt-1.5 text-[14px] font-semibold leading-snug text-paper">{request.title}</h3>
      </div>
    </header>
  )
}

function shortAgent(id: string): string {
  const m = /^(lead|sup|lib)_/.exec(id)
  if (m) return { lead: 'principal', sup: 'superviseur', lib: 'bibliothécaire' }[m[1] as 'lead' | 'sup' | 'lib']
  return id.length > 18 ? `${id.slice(0, 16)}…` : id
}

/** Shared resolve helper: calls the API, toasts, and flips the card to its final state. */
function useResolve(request: HumanRequest, onDone: OnDone) {
  const toast = useApp(s => s.toast)
  const [busy, setBusy] = useState<Busy>(false)
  const resolve = async (key: string, response: string, status: 'resolved' | 'dismissed' = 'resolved', successTitle = 'Réponse envoyée'): Promise<void> => {
    setBusy(key)
    try {
      await api.resolve(request.id, response, status)
      toast({ title: successTitle, body: request.title, level: status === 'dismissed' ? 'info' : 'success' })
      onDone(status, response)
    } catch (error) {
      toast({ title: 'Action impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return { busy, resolve }
}

function ApprovalBody({ request, onDone }: { request: HumanRequest; onDone: OnDone }) {
  const { busy, resolve } = useResolve(request, onDone)
  const [comment, setComment] = useState('')
  const [showComment, setShowComment] = useState(false)
  const reason = typeof request.payload?.reason === 'string' ? request.payload.reason : undefined
  const tool = typeof request.payload?.tool === 'string' ? request.payload.tool : undefined
  const suffix = comment.trim() ? ` — ${comment.trim()}` : ''

  return (
    <div className="flex flex-col gap-3 pl-11">
      {reason ? (
        <div className="flex items-start gap-2 text-[12.5px] text-ink-300">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber" />
          <span><span className="text-ink-400">Motif :</span> {reason}</span>
        </div>
      ) : null}
      {request.body ? (
        <div className="overflow-hidden rounded-xl border border-amber/25 bg-ink-950">
          {tool ? <div className="border-b border-ink-800 px-3 py-1 font-mono text-[10.5px] uppercase tracking-wider text-ink-500">{tool}</div> : null}
          <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink-100">{request.body}</pre>
        </div>
      ) : null}
      {showComment ? (
        <Textarea rows={2} value={comment} onChange={e => setComment(e.target.value)} placeholder="Commentaire transmis à l'agent (optionnel)…" autoFocus />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" loading={busy === 'ok'} disabled={Boolean(busy)} onClick={() => void resolve('ok', `Approuver${suffix}`, 'resolved', 'Action approuvée')}>
          <Check className="size-3.5" /> Approuver
        </Button>
        <Button variant="danger" size="sm" loading={busy === 'no'} disabled={Boolean(busy)} onClick={() => void resolve('no', `Refuser${suffix}`, 'resolved', 'Action refusée')}>
          <X className="size-3.5" /> Refuser
        </Button>
        {!showComment ? (
          <Button variant="ghost" size="sm" onClick={() => setShowComment(true)}>
            <MessageSquareReply className="size-3.5" /> Ajouter un commentaire
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function QuestionBody({ request, onDone, compact }: { request: HumanRequest; onDone: OnDone; compact?: boolean }) {
  const { busy, resolve } = useResolve(request, onDone)
  const [answer, setAnswer] = useState('')
  const send = (): void => {
    if (answer.trim()) void resolve('answer', answer.trim())
  }
  return (
    <div className="flex flex-col gap-3 pl-11">
      {request.body ? <Markdown text={request.body} className={compact ? 'text-[13px]' : undefined} /> : null}
      {request.options?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {request.options.map((opt, i) => (
            <Button key={opt} size="sm" variant={i === 0 ? 'subtle' : 'outline'} loading={busy === `opt${i}`} disabled={Boolean(busy)} onClick={() => void resolve(`opt${i}`, opt)}>
              {opt}
            </Button>
          ))}
        </div>
      ) : null}
      <Textarea
        rows={compact ? 2 : 3}
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={request.options?.length ? 'Ou réponds librement…' : 'Ta réponse…'}
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" loading={busy === 'answer'} disabled={Boolean(busy) || !answer.trim()} onClick={send}>
          <MessageSquareReply className="size-3.5" /> Répondre
        </Button>
        <Button variant="ghost" size="sm" loading={busy === 'dismiss'} disabled={Boolean(busy)} onClick={() => void resolve('dismiss', 'Ignoré par l\'humain', 'dismissed', 'Demande ignorée')}>
          Ignorer
        </Button>
        <span className="ml-auto hidden font-mono text-[10.5px] text-ink-500 sm:inline">Ctrl + Entrée</span>
      </div>
    </div>
  )
}

function PdfBody({ request, onDone }: { request: HumanRequest; onDone: OnDone }) {
  const toast = useApp(s => s.toast)
  const { busy, resolve } = useResolve(request, onDone)
  const [uploading, setUploading] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const upload = async (file: File): Promise<void> => {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast({ title: 'Format non pris en charge', body: 'Dépose un fichier PDF.', level: 'warn' })
      return
    }
    setUploading(file)
    try {
      const source = await api.uploadPdf(request.projectId, file, { requestId: request.id })
      toast({ title: 'PDF transmis', body: source.title || file.name, level: 'success' })
      onDone('resolved', `PDF fourni : ${file.name}`)
    } catch (error) {
      toast({ title: 'Envoi impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setUploading(null)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void upload(file)
  }

  return (
    <div className="flex flex-col gap-3 pl-11">
      {request.body ? <Markdown text={request.body} /> : null}
      <div
        data-own-drop
        role="button"
        tabIndex={0}
        onClick={() => !uploading && input.current?.click()}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={e => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cx(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-5 text-center transition-colors',
          over ? 'border-teal bg-teal-soft' : 'border-ink-600 bg-ink-925 hover:border-teal/60',
          uploading && 'pointer-events-none',
        )}
      >
        {uploading ? (
          <>
            <Spinner className="size-5 text-teal" />
            <span className="text-[12.5px] text-ink-200">Envoi de {uploading.name} · {fmtBytes(uploading.size)}</span>
          </>
        ) : (
          <>
            <FileUp className={cx('size-5', over ? 'text-teal' : 'text-ink-400')} />
            <span className="text-[12.5px] text-ink-200">Dépose le PDF ici ou <span className="text-teal underline underline-offset-2">parcours tes fichiers</span></span>
            <span className="text-[11px] text-ink-500">Il sera indexé comme source et l'agent reprendra sa lecture.</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void upload(file)
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" loading={busy === 'na'} disabled={Boolean(busy) || Boolean(uploading)} onClick={() => void resolve('na', 'Indisponible', 'dismissed', 'Marqué indisponible')}>
          <XCircle className="size-3.5" /> Indisponible
        </Button>
      </div>
    </div>
  )
}

function ResolvedCard({ request, status, projectTitle }: { request: HumanRequest; status: HumanRequest['status']; projectTitle?: string }) {
  const kind = KIND[request.kind] ?? KIND.question
  const dismissed = status === 'dismissed'
  return (
    <article className="flex items-start gap-3 rounded-lg border border-ink-750 bg-ink-900/60 px-3.5 py-2.5 opacity-80">
      {dismissed ? <XCircle className="mt-0.5 size-4 shrink-0 text-ink-500" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-teal" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={kind.tone}>{kind.label}</Badge>
          <Badge tone={dismissed ? 'neutral' : 'teal'}>{dismissed ? 'ignorée' : 'résolue'}</Badge>
          {projectTitle ? <span className="truncate text-[11.5px] text-amber/70">{projectTitle}</span> : null}
          <span className="ml-auto font-mono text-[10.5px] text-ink-500">{fmtAgo(request.resolvedAt ?? request.createdAt)}</span>
        </div>
        <div className="mt-1 truncate text-[13px] text-ink-200" title={request.title}>{request.title}</div>
        {request.response ? (
          <div className="mt-1 flex items-start gap-1.5 text-[12.5px] text-ink-400">
            <MessageSquareReply className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-3 whitespace-pre-wrap">{request.response}</span>
          </div>
        ) : null}
      </div>
    </article>
  )
}
