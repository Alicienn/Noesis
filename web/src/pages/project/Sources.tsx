import { BookOpen, Download, ExternalLink, FileText, FileUp, Library, Link2, Paperclip, Plus, Quote, Search, Trash2, UploadCloud, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HumanRequest, Source, SourceStatus } from '@shared/types'
import { Markdown } from '../../components/Markdown'
import { Badge, Button, Empty, IconButton, Input, Spinner, Tabs, cx } from '../../components/ui'
import { api } from '../../lib/api'
import { fmtAgo, SOURCE_STATUS } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'
import { useUploads } from '../../store/uploads'
import { DocumentDropzone } from '../../components/Documents'

const upsertSource = (s: Source): void => {
  if (s?.id) useProject.setState(st => ({ sources: { ...st.sources, [s.id]: s } }))
}

// ───────────────────────────── smart input detection ─────────────────────────────

type Detected = { kind: 'doi'; value: string } | { kind: 'arxiv'; value: string } | { kind: 'url'; value: string }

function detect(raw: string): Detected | null {
  const s = raw.trim()
  if (!s) return null
  const doi = s.match(/(?:doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[^\s"<>]+)/i)
  if (doi && (!/^https?:/i.test(s) || /doi\.org/i.test(s))) return { kind: 'doi', value: doi[1].replace(/[.,;]+$/, '') }
  const arxivUrl = s.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:\.pdf)?(?:v\d+)?$/i)
  if (arxivUrl) return { kind: 'arxiv', value: arxivUrl[1] }
  const arxiv = s.match(/^(?:arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i)
  if (arxiv) return { kind: 'arxiv', value: arxiv[1] }
  if (/^https?:\/\/\S+$/i.test(s)) return { kind: 'url', value: s }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return { kind: 'url', value: `https://${s}` }
  return null
}

const DETECT_LABEL: Record<Detected['kind'], string> = { doi: 'DOI', arxiv: 'arXiv', url: 'URL' }

// ───────────────────────────── helpers ─────────────────────────────

function PdfPicker({ multiple, onFiles, children }: { multiple?: boolean; onFiles: (files: File[]) => void; children: (open: () => void) => ReactNode }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="application/pdf,.pdf"
        multiple={multiple}
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
      {children(() => ref.current?.click())}
    </>
  )
}

function useUploader(): { upload: (files: File[], extra?: { requestId?: string; sourceId?: string }) => Promise<void>; busy: boolean } {
  const projectId = useProject(s => s.id)!
  const toast = useApp(s => s.toast)
  const [busy, setBusy] = useState(false)
  const upload = useCallback(async (files: File[], extra: { requestId?: string; sourceId?: string } = {}) => {
    setBusy(true)
    for (const file of files) {
      try {
        const s = await api.uploadPdf(projectId, file, extra)
        upsertSource(s)
        toast({ title: 'PDF ajouté', body: `${s.citationKey} · ${s.pages ?? '?'} pages`, level: 'success' })
      } catch (error) {
        toast({ title: `Échec : ${file.name}`, body: (error as Error).message, level: 'error' })
      }
    }
    setBusy(false)
  }, [projectId, toast])
  return { upload, busy }
}

const authorsLine = (a: string[]): string => (a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', '))

// ───────────────────────────── page ─────────────────────────────

export function Sources() {
  const sources = useProject(s => s.sources)
  const requests = useProject(s => s.requests)
  const [status, setStatus] = useState<SourceStatus | 'all' | 'provided'>('all')
  const [q, setQ] = useState('')
  const [readerId, setReaderId] = useState<string | null>(null)

  const all = useMemo(() => Object.values(sources).sort((a, b) => b.createdAt - a.createdAt), [sources])
  const pending = useMemo(() => requests.filter(r => r.kind === 'pdf' && r.status === 'pending'), [requests])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of all) c[s.status] = (c[s.status] ?? 0) + 1
    return c
  }, [all])
  const provided = useMemo(() => all.filter(s => s.origin === 'human').length, [all])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter(s => (status === 'all' || (status === 'provided' ? s.origin === 'human' : s.status === status)) && (!needle || [s.title, s.citationKey, s.authors.join(' '), s.venue ?? '', s.doi ?? '', s.file ?? '', String(s.year ?? '')].join(' ').toLowerCase().includes(needle)))
  }, [all, status, q])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 animate-rise">
          <div>
            <div className="kicker mb-1.5 flex items-center gap-1.5"><Library className="size-3" />Bibliothèque</div>
            <h1 className="display text-[32px] font-semibold leading-tight text-paper">Sources</h1>
          </div>
          <div className="flex gap-4 font-mono text-[11px] text-ink-500">
            <span>{all.length} sources</span>
            <span className="text-teal/80">{counts.full_text ?? 0} en texte intégral</span>
            {provided ? <span className="text-amber/80">{provided} fournis par toi</span> : null}
          </div>
        </header>

        {pending.length ? (
          <div className="mb-5 flex flex-col gap-3">
            {pending.map(r => <PdfRequestCallout key={r.id} request={r} />)}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
          <AddSource />
          <DropZone />
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Tabs<SourceStatus | 'all' | 'provided'>
            value={status}
            onChange={setStatus}
            items={[
              { value: 'all', label: 'Toutes', count: all.length },
              ...(provided ? [{ value: 'provided' as const, label: 'Fournies', count: provided }] : []),
              ...(Object.keys(SOURCE_STATUS) as SourceStatus[]).map(s => ({ value: s, label: SOURCE_STATUS[s].label, count: counts[s] ?? 0 })),
            ]}
          />
          <div className="relative w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-500" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filtrer (titre, auteur, clé…)" className="h-8 pl-8 text-[12.5px]" />
          </div>
        </div>

        <div className="mt-3 overflow-hidden rounded-lg border border-ink-750 bg-ink-900">
          {shown.length ? (
            <ul className="divide-y divide-ink-800">
              {shown.map(s => <SourceRow key={s.id} source={s} onOpen={() => setReaderId(s.id)} />)}
            </ul>
          ) : (
            <Empty icon={<BookOpen className="size-7" />} title={all.length ? 'Aucune source ne correspond' : 'Bibliothèque vide'}>
              {all.length ? 'Modifie le filtre ou la recherche.' : 'Les agents y ajoutent les articles trouvés ; tu peux aussi ajouter un DOI, un identifiant arXiv, une URL ou déposer tes propres documents.'}
            </Empty>
          )}
        </div>
      </div>
      {readerId ? <Reader sourceId={readerId} onClose={() => setReaderId(null)} /> : null}
    </div>
  )
}

// ───────────────────────────── add & upload ─────────────────────────────

function AddSource() {
  const projectId = useProject(s => s.id)!
  const toast = useApp(s => s.toast)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const d = detect(value)

  const add = async (): Promise<void> => {
    if (!d) return
    setBusy(true)
    try {
      const body = d.kind === 'doi' ? { doi: d.value } : d.kind === 'arxiv' ? { arxivId: d.value } : { url: d.value }
      const s = await api.addSource(projectId, { ...body, fetchPdf: true })
      upsertSource(s)
      setValue('')
      toast({
        title: 'Source ajoutée',
        body: `${s.citationKey} — ${s.status === 'full_text' ? 'texte intégral récupéré' : 'métadonnées seulement'}`,
        level: s.status === 'full_text' ? 'success' : 'info',
      })
    } catch (error) {
      toast({ title: 'Ajout impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-ink-750 bg-ink-900 p-4">
      <div className="kicker mb-1">Ajouter</div>
      <p className="mb-3 text-[12.5px] text-ink-400">DOI, identifiant arXiv ou URL — les métadonnées et le PDF en accès libre sont récupérés automatiquement.</p>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void add() }}>
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-500" />
          <Input value={value} onChange={e => setValue(e.target.value)} placeholder="10.1038/… · 2401.12345 · https://…" className="pl-8 pr-20 font-mono text-[12.5px]" disabled={busy} />
          {value.trim() ? (
            <span className="absolute right-2 top-1/2 -translate-y-1/2">
              {d ? <Badge tone="amber">{DETECT_LABEL[d.kind]}</Badge> : <Badge tone="brick">inconnu</Badge>}
            </span>
          ) : null}
        </div>
        <Button type="submit" variant="primary" loading={busy} disabled={!d}>{!busy ? <Plus className="size-4" /> : null}Ajouter</Button>
      </form>
      {busy ? <div className="mt-2 text-[11.5px] text-ink-500">Recherche des métadonnées et du PDF… (jusqu'à 2 min)</div> : null}
    </section>
  )
}

function DropZone() {
  const projectId = useProject(s => s.id)!
  const enqueue = useUploads(s => s.enqueue)
  return (
    <section className="flex flex-col rounded-lg border border-ink-750 bg-ink-900 p-4">
      <div className="kicker mb-1 flex items-center gap-1.5"><Paperclip className="size-3" />Documents de contexte</div>
      <p className="mb-3 text-[12.5px] text-ink-400">Tous formats, sans limite. Les agents en tiennent compte en plus de leur propre recherche.</p>
      <DocumentDropzone compact className="flex-1" onFiles={files => void enqueue(projectId, files)} />
    </section>
  )
}

function PdfRequestCallout({ request: r }: { request: HumanRequest }) {
  const sources = useProject(s => s.sources)
  const toast = useApp(s => s.toast)
  const { upload, busy } = useUploader()
  const [dismissing, setDismissing] = useState(false)
  const src = r.sourceId ? sources[r.sourceId] : undefined
  const doi = src?.doi ?? (typeof r.payload?.doi === 'string' ? r.payload.doi : undefined) ?? r.body.match(/doi\.org\/(10\.[^\s)]+)/i)?.[1]

  const dismiss = async (): Promise<void> => {
    setDismissing(true)
    try {
      await api.resolve(r.id, 'Indisponible', 'dismissed')
      useProject.setState(s => ({ requests: s.requests.map(x => (x.id === r.id ? { ...x, status: 'dismissed' as const } : x)) }))
    } catch (error) {
      toast({ title: 'Action impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-amber/40 bg-amber-soft/50 p-4 animate-rise">
      <div className="shimmer pointer-events-none absolute inset-x-0 top-0 h-px" />
      <div className="flex items-start gap-3">
        <FileUp className="mt-0.5 size-5 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-paper">{r.title}</h3>
            {r.blocking ? <Badge tone="rose">bloquant</Badge> : null}
            <span className="text-[11px] text-ink-400">{fmtAgo(r.createdAt)} · {r.agentId}</span>
          </div>
          <Markdown text={r.body} small className="mt-1.5 text-ink-200" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PdfPicker onFiles={files => void upload(files.slice(0, 1), { requestId: r.id })}>
              {open => <Button size="sm" variant="primary" loading={busy} onClick={open}>{!busy ? <UploadCloud className="size-3.5" /> : null}Téléverser le PDF</Button>}
            </PdfPicker>
            {doi ? (
              <a href={`https://doi.org/${doi}`} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-ink-700 px-2.5 text-[12.5px] text-ink-100 hover:border-ink-500">
                <ExternalLink className="size-3.5" />doi:{doi}
              </a>
            ) : null}
            <Button size="sm" variant="ghost" loading={dismissing} onClick={dismiss}>Indisponible</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────── list ─────────────────────────────

function LinkIcon({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] text-ink-400 hover:bg-ink-800 hover:text-amber">
      {label}<ExternalLink className="size-2.5" />
    </a>
  )
}

function SourceRow({ source: s, onOpen }: { source: Source; onOpen: () => void }) {
  const projectId = useProject(st => st.id)!
  const toast = useApp(st => st.toast)
  const { upload, busy: uploading } = useUploader()
  const [fetching, setFetching] = useState(false)
  const st = SOURCE_STATUS[s.status]

  const fetchPdf = async (): Promise<void> => {
    setFetching(true)
    try {
      const r = await api.fetchSourcePdf(projectId, s.id)
      upsertSource(r.source)
      toast({ title: r.ok ? 'PDF récupéré' : 'PDF introuvable', body: r.message, level: r.ok ? 'success' : 'warn' })
    } catch (error) {
      toast({ title: 'Récupération impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setFetching(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!confirm(`Supprimer la source « ${s.title} » ?`)) return
    try {
      await api.deleteSource(projectId, s.id)
      useProject.setState(x => {
        const next = { ...x.sources }
        delete next[s.id]
        return { sources: next }
      })
    } catch (error) {
      toast({ title: 'Suppression impossible', body: (error as Error).message, level: 'error' })
    }
  }

  return (
    <li className="group flex cursor-pointer items-start gap-4 px-4 py-3 transition-colors hover:bg-ink-875" onClick={onOpen}>
      <div className="w-36 shrink-0 pt-0.5">
        <div className="truncate font-mono text-[12px] text-amber" title={s.citationKey}>{s.citationKey}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <Badge tone={st.tone}>{st.label}</Badge>
          {s.origin === 'human' ? <Badge tone="amber" title="Document fourni par toi"><Paperclip className="size-2.5" />fourni</Badge> : null}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] leading-snug text-ink-100 group-hover:text-paper">{s.title}</div>
        <div className="mt-0.5 truncate text-[12px] text-ink-400">
          {s.origin === 'human' && s.file ? <span className="mr-1.5 font-mono text-[11px] text-ink-300">{s.file}</span> : null}
          {s.authors.length ? authorsLine(s.authors) : s.origin === 'human' ? null : <span className="italic text-ink-500">auteurs inconnus</span>}
          {s.year ? <span className="text-ink-300"> · {s.year}</span> : null}
          {s.venue ? <span className="italic"> · {s.venue}</span> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
          {s.pages ? <span className="font-mono">{s.pages} p.</span> : null}
          {s.citations !== undefined ? <span className="flex items-center gap-1 font-mono"><Quote className="size-2.5" />{s.citations}</span> : null}
          {s.notes ? <span className="flex items-center gap-1 text-teal/80"><FileText className="size-3" />fiche de lecture</span> : null}
          <span className="flex items-center">
            {s.doi ? <LinkIcon href={`https://doi.org/${s.doi}`} label="DOI" /> : null}
            {s.arxivId ? <LinkIcon href={`https://arxiv.org/abs/${s.arxivId}`} label="arXiv" /> : null}
            {s.url ? <LinkIcon href={s.url} label="URL" /> : null}
            {s.file ? <LinkIcon href={`/api/projects/${projectId}/files/raw?path=${encodeURIComponent(s.file)}`} label="original" /> : null}
          </span>
        </div>
        {s.origin === 'human' && s.notes ? <div className="mt-1 line-clamp-2 text-[11.5px] text-amber/80">⚠ {s.notes}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1" onClick={e => e.stopPropagation()}>
        {s.status !== 'full_text' && s.origin !== 'human' ? (
          <Button size="sm" variant="ghost" loading={fetching} onClick={fetchPdf} title="Chercher un PDF en accès libre">{!fetching ? <Download className="size-3.5" /> : null}Récupérer le PDF</Button>
        ) : null}
        <PdfPicker onFiles={files => void upload(files.slice(0, 1), { sourceId: s.id })}>
          {open => (
            <IconButton title="Téléverser un PDF pour cette source" onClick={open} disabled={uploading}>
              {uploading ? <Spinner className="size-3.5" /> : <UploadCloud className="size-4" />}
            </IconButton>
          )}
        </PdfPicker>
        <IconButton title="Supprimer" onClick={remove} className="hover:!text-brick"><Trash2 className="size-4" /></IconButton>
      </div>
    </li>
  )
}

// ───────────────────────────── reader ─────────────────────────────

type View = 'pdf' | 'text'

function Reader({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const projectId = useProject(s => s.id)!
  const s = useProject(st => st.sources[sourceId])
  const [hasPdf, setHasPdf] = useState<boolean | null>(null)
  const [view, setView] = useState<View>('pdf')
  const [text, setText] = useState<string | null>(null)
  const [textError, setTextError] = useState('')
  const pdfUrl = api.sourcePdfUrl(projectId, sourceId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    fetch(pdfUrl, { method: 'HEAD' })
      .then(r => { if (!cancelled) setHasPdf(r.ok) })
      .catch(() => { if (!cancelled) setHasPdf(false) })
    return () => { cancelled = true }
  }, [pdfUrl, s?.status])

  const effective: View = hasPdf ? view : 'text'

  useEffect(() => {
    if (hasPdf === null || effective !== 'text' || text !== null) return
    let cancelled = false
    api.sourceText(projectId, sourceId)
      .then(r => { if (!cancelled) setText(r.text) })
      .catch(e => { if (!cancelled) { setText(''); setTextError((e as Error).message) } })
    return () => { cancelled = true }
  }, [hasPdf, effective, text, projectId, sourceId])

  if (!s) return null

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-ink-950/80 p-4 backdrop-blur-sm" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="flex w-full max-w-[1400px] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-[0_30px_80px_-20px_#000] animate-rise">
        <aside className="flex w-[380px] shrink-0 flex-col border-r border-ink-750">
          <div className="flex items-start gap-2 border-b border-ink-750 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12px] text-amber">{s.citationKey}</div>
              <h2 className="display mt-1 text-[19px] leading-snug text-paper">{s.title}</h2>
              <div className="mt-1.5 text-[12px] text-ink-400">{authorsLine(s.authors)}{s.year ? ` · ${s.year}` : ''}</div>
              {s.venue ? <div className="text-[12px] italic text-ink-500">{s.venue}</div> : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone={SOURCE_STATUS[s.status].tone}>{SOURCE_STATUS[s.status].label}</Badge>
                {s.pages ? <Badge>{s.pages} pages</Badge> : null}
                {s.citations !== undefined ? <Badge>{s.citations} citations</Badge> : null}
              </div>
              <div className="mt-2 flex flex-wrap -ml-1.5">
                {s.doi ? <LinkIcon href={`https://doi.org/${s.doi}`} label="DOI" /> : null}
                {s.arxivId ? <LinkIcon href={`https://arxiv.org/abs/${s.arxivId}`} label="arXiv" /> : null}
                {s.url ? <LinkIcon href={s.url} label="URL" /> : null}
                {hasPdf ? <LinkIcon href={pdfUrl} label="PDF" /> : null}
              </div>
            </div>
            <IconButton title="Fermer (Échap)" onClick={onClose}><X className="size-4" /></IconButton>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="kicker mb-1.5">Résumé</div>
            {s.abstract ? <p className="text-[13px] leading-relaxed text-ink-200">{s.abstract}</p> : <p className="text-[12.5px] italic text-ink-500">Pas de résumé.</p>}
            <div className="kicker mb-1.5 mt-6 flex items-center gap-1.5"><FileText className="size-3" />Fiche de lecture de l'agent</div>
            {s.notes ? <Markdown text={s.notes} small /> : <p className="text-[12.5px] italic text-ink-500">Aucune annotation pour l'instant.</p>}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-ink-750 px-4">
            <Tabs<View>
              value={effective}
              onChange={setView}
              items={[
                ...(hasPdf ? [{ value: 'pdf' as const, label: 'PDF' }] : []),
                { value: 'text', label: 'Texte extrait' },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 bg-ink-925">
            {hasPdf === null ? (
              <div className="flex h-full items-center justify-center text-amber"><Spinner /></div>
            ) : effective === 'pdf' ? (
              <iframe src={pdfUrl} title={s.title} className="h-full w-full border-0 bg-ink-950" />
            ) : (
              <TextView text={text} error={textError} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TextView({ text, error }: { text: string | null; error: string }) {
  const parts = useMemo(() => {
    if (!text) return []
    const split = text.split(/\n*=== \[page (\d+)\] ===\n*/)
    const out: Array<{ page?: number; body: string }> = []
    if (split[0].trim()) out.push({ body: split[0] })
    for (let i = 1; i < split.length; i += 2) out.push({ page: Number(split[i]), body: split[i + 1] ?? '' })
    return out
  }, [text])

  if (text === null) return <div className="flex h-full items-center justify-center text-amber"><Spinner /></div>
  if (!text.trim()) {
    return (
      <Empty icon={<FileText className="size-7" />} title="Pas de texte intégral">
        {error || 'Le texte n\'a pas encore été extrait. Récupère ou téléverse le PDF.'}
      </Empty>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        {parts.map((p, i) => (
          <div key={i}>
            {p.page !== undefined ? (
              <div className="sticky top-0 z-10 -mx-2 mb-3 mt-6 flex items-center gap-3 bg-ink-925/95 px-2 py-1.5 backdrop-blur-sm first:mt-0">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-amber">page {p.page}</span>
                <span className="h-px flex-1 bg-ink-750" />
              </div>
            ) : null}
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-[1.75] text-ink-200">{p.body.trim()}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
