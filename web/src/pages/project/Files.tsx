import {
  ChevronRight, CornerLeftUp, Download, File, FileCode2, FileImage, FileText, Folder, FolderOpen, HardDrive, Pencil, RefreshCw, Save,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FileEntry } from '@shared/types'
import { Markdown } from '../../components/Markdown'
import { Button, Empty, IconButton, Spinner, Tabs, Textarea, cx } from '../../components/ui'
import { api } from '../../lib/api'
import { fmtAgo, fmtBytes, fmtDate } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

const SHORTCUTS = ['reports', 'memory', 'scratch', 'artifacts', 'sources'] as const

type Kind = 'markdown' | 'image' | 'pdf' | 'text' | 'binary'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'])
const TEXT_EXT = new Set([
  'txt', 'log', 'out', 'err', 'py', 'json', 'jsonl', 'csv', 'tsv', 'tex', 'bib', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'ps1', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'html', 'htm', 'css', 'xml', 'sql', 'r', 'jl', 'm', 'c', 'h', 'cpp', 'hpp', 'rs', 'go', 'java', 'kt', 'rb', 'lua', 'ipynb', 'dat', 'env', 'gitignore',
])

const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')

function kindOf(name: string): Kind {
  const ext = extOf(name)
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXT.has(ext) || !ext) return 'text'
  return 'binary'
}

function EntryIcon({ entry, open }: { entry: FileEntry; open?: boolean }) {
  if (entry.dir) return open ? <FolderOpen className="size-4 text-amber" /> : <Folder className="size-4 text-amber/80" />
  const k = kindOf(entry.name)
  if (k === 'markdown') return <FileText className="size-4 text-teal" />
  if (k === 'image') return <FileImage className="size-4 text-rose" />
  if (k === 'pdf') return <FileText className="size-4 text-brick" />
  if (k === 'text') return <FileCode2 className="size-4 text-sky" />
  return <File className="size-4 text-ink-500" />
}

const parentOf = (p: string): string => p.split('/').slice(0, -1).join('/')

// ───────────────────────────── page ─────────────────────────────

export function Files() {
  const projectId = useProject(s => s.id)!
  const filesVersion = useProject(s => s.filesVersion)
  const [dir, setDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<FileEntry | null>(null)

  // initial selection: newest report, if any
  useEffect(() => {
    let cancelled = false
    api.files(projectId, 'reports')
      .then(list => {
        if (cancelled) return
        const newest = list.filter(e => !e.dir).sort((a, b) => b.mtime - a.mtime)[0]
        setDir(newest ? 'reports' : '')
        if (newest) setSelected(newest)
      })
      .catch(() => { if (!cancelled) setDir('') })
    return () => { cancelled = true }
  }, [projectId])

  const load = useCallback(async (path: string) => {
    try {
      const list = await api.files(projectId, path)
      setEntries(list)
      setError('')
      // keep the selected entry's metadata fresh
      setSelected(sel => (sel ? list.find(e => e.path === sel.path) ?? sel : sel))
    } catch (e) {
      setEntries([])
      setError((e as Error).message)
    }
  }, [projectId])

  useEffect(() => {
    if (dir === null) return
    void load(dir)
  }, [dir, load, filesVersion])

  const go = (path: string): void => {
    if (path === dir) return
    setEntries(null)
    setDir(path)
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-ink-750 bg-ink-925/60">
        <div className="border-b border-ink-750 px-3 py-3">
          <div className="kicker mb-2 flex items-center gap-1.5"><HardDrive className="size-3" />Workspace</div>
          <div className="flex flex-wrap gap-1">
            {SHORTCUTS.map(s => (
              <button
                key={s}
                onClick={() => go(s)}
                className={cx(
                  'cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
                  dir === s || dir?.startsWith(`${s}/`) ? 'border-amber/50 bg-amber-soft text-amber' : 'border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100',
                )}
              >
                {s}/
              </button>
            ))}
          </div>
        </div>

        <Breadcrumbs path={dir ?? ''} onGo={go} onRefresh={() => dir !== null && void load(dir)} />

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {entries === null ? (
            <div className="flex justify-center py-10 text-amber"><Spinner /></div>
          ) : error ? (
            <div className="m-3 rounded-md border border-brick/30 bg-brick-soft px-3 py-2 text-[12px] text-brick">{error}</div>
          ) : (
            <ul>
              {dir ? (
                <li>
                  <button onClick={() => go(parentOf(dir))} className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-ink-400 hover:bg-ink-850 hover:text-ink-100">
                    <CornerLeftUp className="size-4" />..
                  </button>
                </li>
              ) : null}
              {entries.map(e => (
                <li key={e.path}>
                  <button
                    onClick={() => (e.dir ? go(e.path) : setSelected(e))}
                    className={cx(
                      'group flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                      selected?.path === e.path ? 'bg-ink-800 text-paper' : 'text-ink-200 hover:bg-ink-850',
                    )}
                  >
                    <EntryIcon entry={e} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.name}</span>
                    <span className="shrink-0 font-mono text-[10.5px] text-ink-500" title={fmtDate(e.mtime)}>
                      {e.dir ? '' : fmtBytes(e.size)}
                    </span>
                  </button>
                </li>
              ))}
              {!entries.length && !dir ? <li className="px-4 py-8 text-center text-[12.5px] text-ink-500">Workspace vide.</li> : null}
              {!entries.length && dir ? <li className="px-4 py-8 text-center text-[12.5px] text-ink-500">Dossier vide.</li> : null}
            </ul>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        {selected ? (
          <FileViewer key={selected.path} entry={selected} version={filesVersion} />
        ) : (
          <div className="graph-paper flex h-full items-center justify-center">
            <Empty icon={<FileText className="size-8" />} title="Aucun fichier sélectionné">
              Rapports, scripts, figures et données produits par les agents vivent dans le workspace du projet.
            </Empty>
          </div>
        )}
      </main>
    </div>
  )
}

function Breadcrumbs({ path, onGo, onRefresh }: { path: string; onGo: (p: string) => void; onRefresh: () => void }) {
  const parts = path ? path.split('/') : []
  return (
    <div className="flex items-center gap-1 border-b border-ink-750 px-2 py-1.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-[11.5px]">
        <button onClick={() => onGo('')} className={cx('cursor-pointer rounded-md px-1.5 py-0.5 hover:bg-ink-850', parts.length ? 'text-ink-400' : 'text-ink-100')}>~</button>
        {parts.map((p, i) => {
          const to = parts.slice(0, i + 1).join('/')
          return (
            <span key={to} className="flex items-center gap-0.5">
              <ChevronRight className="size-3 text-ink-600" />
              <button onClick={() => onGo(to)} className={cx('cursor-pointer truncate rounded-md px-1.5 py-0.5 hover:bg-ink-850', i === parts.length - 1 ? 'text-ink-100' : 'text-ink-400')}>{p}</button>
            </span>
          )
        })}
      </div>
      <IconButton title="Actualiser" onClick={onRefresh} className="size-7"><RefreshCw className="size-3.5" /></IconButton>
    </div>
  )
}

// ───────────────────────────── viewer ─────────────────────────────

function FileViewer({ entry, version }: { entry: FileEntry; version: number }) {
  const projectId = useProject(s => s.id)!
  const toast = useApp(s => s.toast)
  const [forceText, setForceText] = useState(false)
  const kind: Kind = forceText ? 'text' : kindOf(entry.name)
  const textual = kind === 'markdown' || kind === 'text'
  const [text, setText] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [mdView, setMdView] = useState<'rendered' | 'source'>('rendered')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const url = api.fileUrl(projectId, entry.path)

  useEffect(() => {
    if (!textual || editing) return
    let cancelled = false
    api.fileText(projectId, entry.path)
      .then(t => { if (!cancelled) { setText(t); setLoadError('') } })
      .catch(e => { if (!cancelled) setLoadError((e as Error).message) })
    return () => { cancelled = true }
    // `version` re-fetches when the agents touch the workspace
  }, [projectId, entry.path, textual, version, editing])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.saveFile(projectId, entry.path, draft)
      setText(draft)
      setEditing(false)
      toast({ title: 'Fichier enregistré', body: entry.path, level: 'success' })
    } catch (e) {
      toast({ title: 'Enregistrement impossible', body: (e as Error).message, level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-750 px-4">
        <EntryIcon entry={entry} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] text-ink-100" title={entry.path}>{entry.path}</div>
        </div>
        <span className="hidden shrink-0 text-[11px] text-ink-500 md:inline">{fmtBytes(entry.size)} · {fmtAgo(entry.mtime)}</span>
        {kind === 'markdown' && !editing ? (
          <Tabs<'rendered' | 'source'> value={mdView} onChange={setMdView} items={[{ value: 'rendered', label: 'Rendu' }, { value: 'source', label: 'Source' }]} />
        ) : null}
        {textual && text !== null ? (
          editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Annuler</Button>
              <Button size="sm" variant="primary" loading={saving} onClick={save}>{!saving ? <Save className="size-3.5" /> : null}Enregistrer</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => { setDraft(text); setEditing(true) }}><Pencil className="size-3.5" />Modifier</Button>
          )
        ) : null}
        <a
          href={url}
          download={entry.name}
          title="Télécharger"
          className="inline-flex size-8 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
        >
          <Download className="size-4" />
        </a>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden bg-ink-925">
        {editing ? (
          <div className="flex h-full flex-col p-3">
            <Textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full flex-1 resize-none font-mono text-[12.5px] leading-[1.6]"
              onKeyDown={e => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault()
                  void save()
                }
              }}
            />
          </div>
        ) : kind === 'image' ? (
          <Centered>
            <img src={`${url}&v=${version}`} alt={entry.name} className="max-h-full max-w-full rounded-md border border-ink-750 bg-[repeating-conic-gradient(#1a1d25_0_25%,#121419_0_50%)] bg-[length:16px_16px] object-contain" />
          </Centered>
        ) : kind === 'pdf' ? (
          <iframe src={url} title={entry.name} className="h-full w-full border-0 bg-ink-950" />
        ) : kind === 'binary' ? (
          <Centered>
            <Empty icon={<File className="size-8" />} title="Aperçu indisponible">
              <p>Ce type de fichier ne peut pas être affiché.</p>
              <div className="mt-4 flex justify-center gap-2">
                <Button size="sm" onClick={() => setForceText(true)}>Ouvrir comme texte</Button>
                <a href={url} download={entry.name} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-ink-800 px-2.5 text-[12.5px] text-ink-100 hover:bg-ink-750"><Download className="size-3.5" />Télécharger</a>
              </div>
            </Empty>
          </Centered>
        ) : loadError ? (
          <Centered><Empty title="Lecture impossible">{loadError}</Empty></Centered>
        ) : text === null ? (
          <Centered><Spinner className="size-5 text-amber" /></Centered>
        ) : kind === 'markdown' && mdView === 'rendered' ? (
          <div className="h-full overflow-y-auto">
            <article className="mx-auto max-w-3xl px-8 py-10">
              {text.trim() ? <Markdown text={text} resolveUrl={src => api.fileUrl(projectId, joinPath(entry.path, src))} /> : <p className="italic text-ink-500">Fichier vide.</p>}
            </article>
          </div>
        ) : (
          <CodeView text={text} />
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center overflow-auto p-6">{children}</div>
}

function CodeView({ text }: { text: string }) {
  const lineNumbers = useMemo(() => {
    const n = text.split('\n').length
    return Array.from({ length: n }, (_, i) => i + 1).join('\n')
  }, [text])
  if (!text) return <Centered><p className="text-[13px] italic text-ink-500">Fichier vide.</p></Centered>
  return (
    <div className="h-full overflow-auto">
      <div className="flex min-w-max font-mono text-[12.5px] leading-[1.6]">
        <pre aria-hidden className="sticky left-0 select-none border-r border-ink-800 bg-ink-925 px-3 py-3 text-right text-ink-600">{lineNumbers}</pre>
        <pre className="px-4 py-3 text-ink-200">{text}</pre>
      </div>
    </div>
  )
}

/** Resolve `src` relative to the directory of `file` (workspace-relative paths). */
function joinPath(file: string, src: string): string {
  const parts = file.split('/').slice(0, -1)
  for (const seg of src.replace(/^\.\//, '').split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
