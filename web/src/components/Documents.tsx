import {
  Check, ChevronDown, Copy, File as FileIcon, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, FolderOpen, Paperclip, Presentation, RotateCcw, UploadCloud, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fmtBytes } from '../lib/format'
import { isActive, useUploads } from '../store/uploads'
import type { UploadItem } from '../store/uploads'
import { Spinner, cx } from './ui'

/**
 * Documents provided as input context: drop zone (files and whole folders),
 * pending list for the new-project modal, page-wide drop overlay and upload tray.
 */

// ───────────────────────────── files & folders ─────────────────────────────

const JUNK = /^(\.ds_store|thumbs\.db|desktop\.ini|\._.*)$/i

/** Flatten a drop: files plus the content of dropped folders (recursively). */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .filter(i => i.kind === 'file')
    .map(i => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null)
  if (!entries.length || entries.every(e => !e)) return Array.from(dt.files).filter(f => !JUNK.test(f.name))
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>(resolve => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)))
      if (file && !JUNK.test(file.name)) out.push(file)
      return
    }
    if (!entry.isDirectory || entry.name.startsWith('.')) return
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries returns batches (≈100): keep reading until empty
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>(resolve => reader.readEntries(resolve, () => resolve([])))
      if (!batch.length) break
      for (const child of batch) await walk(child)
    }
  }
  for (const e of entries) if (e) await walk(e)
  return out
}

const hasFiles = (e: DragEvent | React.DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')

export function fileKind(name: string): { icon: ReactNode; tone: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const cls = 'size-4'
  if (ext === 'pdf') return { icon: <FileText className={cls} />, tone: 'text-brick' }
  if (['doc', 'docx', 'odt', 'rtf', 'md', 'markdown', 'txt', 'tex', 'epub', 'html', 'htm'].includes(ext)) return { icon: <FileText className={cls} />, tone: 'text-sky' }
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return { icon: <Presentation className={cls} />, tone: 'text-amber' }
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv', 'json', 'jsonl', 'parquet', 'h5', 'npy', 'mat'].includes(ext)) return { icon: <FileSpreadsheet className={cls} />, tone: 'text-moss' }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff'].includes(ext)) return { icon: <FileImage className={cls} />, tone: 'text-rose' }
  if (['zip', 'tar', 'gz', '7z', 'rar', 'xz'].includes(ext)) return { icon: <FileArchive className={cls} />, tone: 'text-ink-300' }
  if (['py', 'ipynb', 'js', 'ts', 'c', 'cpp', 'h', 'rs', 'go', 'java', 'r', 'jl', 'm', 'sh', 'lean', 'sql'].includes(ext)) return { icon: <FileCode className={cls} />, tone: 'text-teal' }
  return { icon: <FileIcon className={cls} />, tone: 'text-ink-400' }
}

// ───────────────────────────── drop zone ─────────────────────────────

const FORMATS = 'PDF · Word · PowerPoint · Excel · Markdown · LaTeX · HTML · EPUB · code · CSV/JSON · notebooks'

export function DocumentDropzone({ onFiles, compact, disabled, className }: { onFiles: (files: File[]) => void; compact?: boolean; disabled?: boolean; className?: string }) {
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [reading, setReading] = useState(false)
  const depth = useRef(0)

  const pick = (list: FileList | null): void => {
    const picked = Array.from(list ?? []).filter(f => !JUNK.test(f.name))
    if (picked.length) onFiles(picked)
  }

  return (
    <div
      data-own-drop
      onDragEnter={e => {
        if (!hasFiles(e) || disabled) return
        e.preventDefault()
        depth.current++
        setOver(true)
      }}
      onDragOver={e => {
        if (!hasFiles(e) || disabled) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setOver(false)
      }}
      onDrop={async e => {
        if (!hasFiles(e) || disabled) return
        e.preventDefault()
        e.stopPropagation()
        depth.current = 0
        setOver(false)
        setReading(true)
        try {
          const dropped = await filesFromDrop(e.dataTransfer)
          if (dropped.length) onFiles(dropped)
        } finally {
          setReading(false)
        }
      }}
      className={cx(
        'group relative isolate overflow-hidden rounded-xl border border-dashed text-center transition-all duration-200',
        compact ? 'px-4 py-5' : 'px-6 py-8',
        over ? 'scale-[1.01] border-amber bg-amber-soft shadow-[0_0_0_4px_#f2b54414]' : 'border-ink-600 bg-ink-925/60 hover:border-ink-500',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <div className={cx('pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 graph-paper', over && 'opacity-60')} />
      <input ref={files} type="file" multiple className="hidden" onChange={e => { pick(e.target.files); e.target.value = '' }} />
      <input ref={folder} type="file" multiple className="hidden" {...{ webkitdirectory: '', directory: '' }} onChange={e => { pick(e.target.files); e.target.value = '' }} />

      <DocStack active={over} compact={compact} />
      <div className={cx('font-medium text-paper', compact ? 'mt-2.5 text-[13px]' : 'mt-3.5 text-[14.5px]')}>
        {reading ? <span className="inline-flex items-center gap-2"><Spinner className="size-3.5 text-amber" />Lecture du dossier…</span> : over ? 'Lâche pour joindre au contexte' : 'Glisse tes documents ici'}
      </div>
      <div className="mt-1 text-[11.5px] text-ink-400">
        <button type="button" onClick={() => files.current?.click()} className="cursor-pointer text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber">choisir des fichiers</button>
        {' '}ou{' '}
        <button type="button" onClick={() => folder.current?.click()} className="inline-flex cursor-pointer items-center gap-1 text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"><FolderOpen className="size-3" />un dossier</button>
        {' '}· sans limite de nombre
      </div>
      {!compact ? <div className="mx-auto mt-3 max-w-md font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-ink-500">{FORMATS}</div> : null}
    </div>
  )
}

/** Three paper sheets that fan out when something is dragged over. */
function DocStack({ active, compact }: { active: boolean; compact?: boolean }) {
  const size = compact ? 'h-10 w-8' : 'h-12 w-10'
  const sheet = 'absolute inset-0 rounded-[5px] border transition-all duration-300 ease-out'
  return (
    <div className={cx('relative mx-auto', size)}>
      <div className={cx(sheet, 'border-ink-600 bg-ink-850', active ? '-translate-x-4 -rotate-[14deg]' : '-translate-x-1 -rotate-6 group-hover:-translate-x-2 group-hover:-rotate-[9deg]')} />
      <div className={cx(sheet, 'border-ink-600 bg-ink-800', active ? 'translate-x-4 rotate-[14deg]' : 'translate-x-1 rotate-6 group-hover:translate-x-2 group-hover:rotate-[9deg]')} />
      <div className={cx(sheet, 'flex items-center justify-center border-amber/60 bg-ink-900', active ? '-translate-y-2' : 'group-hover:-translate-y-0.5')}>
        <UploadCloud className={cx('size-4 transition-colors', active ? 'text-amber' : 'text-ink-300')} />
      </div>
    </div>
  )
}

// ───────────────────────────── pending list (before the project exists) ─────────────────────────────

export function PendingFiles({ files, onRemove, onClear }: { files: File[]; onRemove: (i: number) => void; onClear: () => void }) {
  const total = useMemo(() => files.reduce((n, f) => n + f.size, 0), [files])
  if (!files.length) return null
  return (
    <div className="mt-2 rounded-lg border border-ink-750 bg-ink-925">
      <div className="flex items-center justify-between border-b border-ink-750 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-300"><Paperclip className="size-3 text-amber" />{files.length} document{files.length > 1 ? 's' : ''} · {fmtBytes(total)}</span>
        <button type="button" onClick={onClear} className="cursor-pointer text-[11px] text-ink-500 hover:text-brick">tout retirer</button>
      </div>
      <ul className="max-h-40 overflow-y-auto py-1">
        {files.map((f, i) => {
          const k = fileKind(f.name)
          return (
            <li key={`${f.name}-${i}`} className="group flex items-center gap-2 px-3 py-1 text-[12px] animate-rise" style={{ animationDelay: `${Math.min(i, 10) * 20}ms` }}>
              <span className={k.tone}>{k.icon}</span>
              <span className="min-w-0 flex-1 truncate text-ink-200" title={(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}>{f.name}</span>
              <span className="font-mono text-[10.5px] text-ink-500">{fmtBytes(f.size)}</span>
              <button type="button" onClick={() => onRemove(i)} title="Retirer" className="cursor-pointer rounded-md p-0.5 text-ink-600 opacity-0 transition-opacity hover:text-brick group-hover:opacity-100"><X className="size-3.5" /></button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ───────────────────────────── page-wide drop overlay ─────────────────────────────

/**
 * Drop files anywhere on a project page. Elements marked data-own-drop (a PDF
 * request, the Sources drop zone…) keep their own behaviour.
 */
export function ProjectDropOverlay({ projectId }: { projectId: string }) {
  const enqueue = useUploads(s => s.enqueue)
  const [count, setCount] = useState<number | null>(null)
  const hide = useRef<number | undefined>(undefined)

  useEffect(() => {
    const own = (e: DragEvent): boolean => Boolean((e.target as Element | null)?.closest?.('[data-own-drop]'))
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e) || own(e)) {
        if (own(e)) setCount(null)
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setCount(e.dataTransfer?.items.length ?? 1)
      window.clearTimeout(hide.current)
      // dragleave is unreliable across child elements: hide when dragover stops firing
      hide.current = window.setTimeout(() => setCount(null), 160)
    }
    const onDrop = async (e: DragEvent): Promise<void> => {
      if (!hasFiles(e) || own(e) || !e.dataTransfer) return
      e.preventDefault()
      setCount(null)
      const files = await filesFromDrop(e.dataTransfer)
      if (files.length) void enqueue(projectId, files)
    }
    const drop = (e: DragEvent): void => void onDrop(e)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', drop)
      window.clearTimeout(hide.current)
    }
  }, [projectId, enqueue])

  if (count === null) return null
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/70 backdrop-blur-[3px]">
      <div className="absolute inset-4 rounded-2xl border-2 border-dashed border-amber/70" />
      <div className="flex flex-col items-center text-center animate-rise">
        <div className="group scale-150"><DocStack active /></div>
        <div className="display mt-8 text-[28px] font-semibold text-paper">Joindre {count > 1 ? `ces ${count} éléments` : 'ce document'} au contexte</div>
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-ink-300">
          Les agents les prendront en compte comme éléments de contexte — en plus de leur propre recherche, pas à la place. Les dossiers sont parcourus entièrement.
        </p>
      </div>
    </div>
  )
}

// ───────────────────────────── upload tray ─────────────────────────────

const STATUS_LABEL: Record<UploadItem['status'], string> = {
  queued: 'en attente',
  uploading: 'envoi',
  processing: 'extraction du texte…',
  done: 'ajouté',
  duplicate: 'déjà présent',
  error: 'échec',
}

export function UploadTray({ projectId }: { projectId: string }) {
  const all = useUploads(s => s.items)
  const dismiss = useUploads(s => s.dismiss)
  const enqueue = useUploads(s => s.enqueue)
  const remove = useUploads(s => s.remove)
  const items = useMemo(() => all.filter(i => i.projectId === projectId), [all, projectId])
  const [open, setOpen] = useState(true)
  const active = items.filter(isActive).length
  const failed = items.filter(i => i.status === 'error').length
  const settled = items.length - active

  // fold automatically once everything is in, and clear a fully successful batch after a while
  useEffect(() => {
    if (!items.length || active) return
    if (failed) return
    const t = window.setTimeout(() => dismiss(projectId), 12_000)
    return () => window.clearTimeout(t)
  }, [items.length, active, failed, dismiss, projectId])

  if (!items.length) return null
  const bytes = items.reduce((n, i) => n + i.size, 0)
  const sent = items.reduce((n, i) => n + i.size * (i.status === 'queued' ? 0 : isActive(i) ? i.progress * 0.9 : 1), 0)
  const pct = bytes ? Math.round((sent / bytes) * 100) : 100

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-[0_24px_60px_-18px_#000] backdrop-blur animate-rise">
      {active ? <div className="shimmer pointer-events-none absolute inset-x-0 top-0 h-px" /> : null}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className={cx('flex size-7 shrink-0 items-center justify-center rounded-md border', active ? 'border-amber/50 bg-amber-soft text-amber' : failed ? 'border-brick/50 bg-brick-soft text-brick' : 'border-teal/50 bg-teal-soft text-teal')}>
          {active ? <Spinner className="size-3.5" /> : failed ? <X className="size-3.5" /> : <Check className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-paper">
            {active ? `Envoi des documents · ${settled}/${items.length}` : failed ? `${items.length - failed}/${items.length} documents ajoutés` : `${items.length} document${items.length > 1 ? 's' : ''} ajouté${items.length > 1 ? 's' : ''} au contexte`}
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-800">
            <div className={cx('h-full rounded-full transition-all duration-300', failed && !active ? 'bg-brick' : active ? 'bg-amber' : 'bg-teal')} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <button onClick={() => setOpen(o => !o)} title={open ? 'Réduire' : 'Déplier'} className="cursor-pointer rounded-md p-1 text-ink-400 hover:text-ink-100">
          <ChevronDown className={cx('size-4 transition-transform', !open && 'rotate-180')} />
        </button>
        {!active ? <button onClick={() => dismiss(projectId)} title="Fermer" className="cursor-pointer rounded-md p-1 text-ink-400 hover:text-ink-100"><X className="size-4" /></button> : null}
      </div>
      {open ? (
        <ul className="max-h-[300px] overflow-y-auto border-t border-ink-750 py-1">
          {items.map(i => {
            const k = fileKind(i.name)
            return (
              <li key={i.id} className="group px-3.5 py-1.5">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className={k.tone}>{k.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-200" title={i.name}>{i.source ? <span className="mr-1.5 font-mono text-[11px] text-amber">{i.source.citationKey}</span> : null}{i.name}</span>
                  {i.status === 'error' ? (
                    <button title="Réessayer" onClick={() => { remove(i.id); void enqueue(projectId, [i.file]) }} className="cursor-pointer rounded-md p-0.5 text-ink-400 hover:text-amber"><RotateCcw className="size-3.5" /></button>
                  ) : null}
                  <span className={cx('shrink-0 font-mono text-[10.5px]', i.status === 'error' ? 'text-brick' : i.status === 'done' ? 'text-teal' : i.status === 'duplicate' ? 'text-ink-400' : 'text-ink-500')}>
                    {i.status === 'uploading' ? `${Math.round(i.progress * 100)} %` : i.status === 'duplicate' ? <span className="inline-flex items-center gap-1"><Copy className="size-3" />{STATUS_LABEL.duplicate}</span> : STATUS_LABEL[i.status]}
                  </span>
                </div>
                {isActive(i) ? (
                  <div className="ml-6 mt-1 h-[3px] overflow-hidden rounded-full bg-ink-800">
                    <div className={cx('h-full rounded-full bg-amber transition-all duration-200', i.status === 'processing' && 'animate-pulse-soft')} style={{ width: `${i.status === 'queued' ? 0 : Math.max(4, i.progress * 100)}%` }} />
                  </div>
                ) : null}
                {i.status === 'error' && i.error ? <div className="ml-6 mt-0.5 text-[11px] text-brick/90">{i.error}</div> : null}
                {i.status === 'done' && i.source?.notes ? <div className="ml-6 mt-0.5 line-clamp-2 text-[11px] text-ink-500">{i.source.notes}</div> : null}
                <div className="ml-6 font-mono text-[10px] text-ink-600">{fmtBytes(i.size)}{i.format ? ` · ${i.format}` : ''}{i.source?.pages ? ` · ${i.source.pages} p.` : ''}</div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
