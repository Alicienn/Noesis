import { ArrowUpRight, BookMarked, CircleSlash, Link2, Pencil, ShieldCheck, Sigma, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Note } from '@shared/types'
import { api } from '../lib/api'
import { fmtAgo, fmtDate, NOTE_TYPE, VERDICT_LABEL, VERDICT_TONE } from '../lib/format'
import { useApp } from '../store/app'
import { useProject } from '../store/project'
import { Markdown } from './Markdown'
import { AssuranceSection } from './Assurance'
import { Badge, Button, Field, IconButton, Input, Select, Textarea, cx } from './ui'

// ───────────────────────────── small shared bits ─────────────────────────────

/** Finds a note by slug, id, or (case-insensitive) title — wikilinks may use any of them. */
export function findNote(notes: Record<string, Note>, key: string): Note | undefined {
  if (notes[key]) return notes[key]
  const list = Object.values(notes)
  const k = key.trim().toLowerCase()
  return list.find(n => n.slug === key) ?? list.find(n => n.slug.toLowerCase() === k) ?? list.find(n => n.title.toLowerCase() === k)
}

export function upsertNoteInStore(note: Note): void {
  if (!note?.id) return
  useProject.setState(s => ({ notes: { ...s.notes, [note.id]: note } }))
}

export function ImportanceDots({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-[3px]', className)} title={`Importance ${value}/5`}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className={cx('size-1.5 rounded-full', i <= value ? 'bg-amber' : 'bg-ink-700')} />
      ))}
    </span>
  )
}

export function ConfidenceBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  const color = pct >= 75 ? 'bg-teal' : pct >= 45 ? 'bg-amber' : 'bg-brick'
  return (
    <span className={cx('inline-flex items-center gap-2', className)} title={`Confiance ${pct} %`}>
      <span className="h-1 w-20 overflow-hidden rounded-full bg-ink-800">
        <span className={cx('block h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-[11px] text-ink-300">{pct}%</span>
    </span>
  )
}

function Section({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-ink-750 px-6 py-4">
      <div className="kicker mb-2.5 flex items-center gap-1.5">{icon}{label}</div>
      {children}
    </section>
  )
}

// ───────────────────────────── drawer ─────────────────────────────

export function NoteDrawer({ slug, onClose, onNavigate }: { slug: string | null; onClose: () => void; onNavigate?: (slug: string) => void }) {
  const [shown, setShown] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (slug === null) {
      setShown(false)
      return
    }
    const raf = requestAnimationFrame(() => setShown(true))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
    }
  }, [slug])

  if (slug === null) return null

  return (
    <div className="fixed inset-0 z-40">
      <div
        className={cx('absolute inset-0 bg-ink-950/60 backdrop-blur-[2px] transition-opacity duration-200', shown ? 'opacity-100' : 'opacity-0')}
        onMouseDown={onClose}
      />
      <aside
        className={cx(
          'absolute inset-y-0 right-0 flex w-[520px] max-w-[100vw] flex-col border-l border-ink-700 bg-ink-900 shadow-[-30px_0_80px_-20px_#000] transition-transform duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)]',
          shown ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <NoteBody key={slug} slug={slug} onClose={onClose} onNavigate={onNavigate} />
      </aside>
    </div>
  )
}

function NoteBody({ slug, onClose, onNavigate }: { slug: string; onClose: () => void; onNavigate?: (slug: string) => void }) {
  const projectId = useProject(s => s.id)!
  const notes = useProject(s => s.notes)
  const sources = useProject(s => s.sources)
  const toast = useApp(s => s.toast)
  const note = findNote(notes, slug)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'' | 'invalidate' | 'delete'>('')

  const backlinks = useMemo(() => (note ? Object.values(notes).filter(n => n.id !== note.id && n.links.includes(note.slug)) : []), [notes, note])
  const sourceByKey = useMemo(() => Object.fromEntries(Object.values(sources).map(s => [s.citationKey, s])), [sources])

  if (!note) {
    return (
      <>
        <DrawerHeader onClose={onClose} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <CircleSlash className="size-7 text-ink-600" />
          <div className="display text-[18px] text-ink-200">Note introuvable</div>
          <div className="font-mono text-[12px] text-ink-500">[[{slug}]]</div>
        </div>
      </>
    )
  }

  const t = NOTE_TYPE[note.type] ?? { label: note.type, tone: 'neutral' as const }
  const superseded = note.status === 'superseded'
  const v = note.verification
  const nav = (s: string): void => onNavigate?.(s)

  const invalidate = async (): Promise<void> => {
    const reason = prompt('Pourquoi invalider cette note ?', 'contredite par de nouveaux éléments')
    if (reason === null) return
    setBusy('invalidate')
    try {
      const updated = await api.updateNote(projectId, note.slug, { supersede: true, reason: reason || undefined })
      upsertNoteInStore(updated)
      toast({ title: 'Note invalidée', body: note.title, level: 'info' })
    } catch (error) {
      toast({ title: 'Invalidation impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy('')
    }
  }

  const remove = async (): Promise<void> => {
    if (!confirm(`Supprimer définitivement la note « ${note.title} » ?`)) return
    setBusy('delete')
    try {
      await api.deleteNote(projectId, note.slug)
      useProject.setState(s => {
        const next = { ...s.notes }
        delete next[note.id]
        return { notes: next }
      })
      onClose()
    } catch (error) {
      toast({ title: 'Suppression impossible', body: (error as Error).message, level: 'error' })
      setBusy('')
    }
  }

  return (
    <>
      <DrawerHeader onClose={onClose}>
        <Badge tone={t.tone}>{t.label}</Badge>
        {superseded ? <Badge tone="brick">invalidée</Badge> : note.status === 'archived' ? <Badge>archivée</Badge> : null}
        <span className="truncate font-mono text-[11px] text-ink-500">{note.slug}</span>
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto">
        {editing ? (
          <EditForm note={note} projectId={projectId} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="px-6 pb-4 pt-5">
              <h2 className={cx('display text-[25px] font-normal leading-tight', superseded ? 'text-ink-400 line-through decoration-brick/60' : 'text-paper')}>{note.title}</h2>
              {superseded ? (
                <div className="mt-2 rounded-md border border-brick/30 bg-brick-soft px-3 py-2 text-[12.5px] text-brick">
                  {note.supersededBy ? (
                    <>remplacée par{' '}
                      <button className="cursor-pointer font-mono text-teal underline decoration-dotted underline-offset-2 hover:text-paper" onClick={() => nav(note.supersededBy!)}>
                        [[{note.supersededBy}]]
                      </button>
                    </>
                  ) : 'Cette note a été invalidée.'}
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-ink-400">
                <span className="flex items-center gap-2">confiance <ConfidenceBar value={note.confidence} /></span>
                <span className="flex items-center gap-2">importance <ImportanceDots value={note.importance} /></span>
              </div>
              {note.tags.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {note.tags.map(tag => <span key={tag} className="rounded-md bg-ink-800 px-1.5 py-px font-mono text-[11px] text-ink-300">#{tag}</span>)}
                </div>
              ) : null}
            </div>

            {v ? (
              <Section label="Vérification" icon={<ShieldCheck className="size-3" />}>
                <div className="rounded-md border border-ink-750 bg-ink-925 p-3">
                  <div className="flex items-center gap-3">
                    <Badge tone={VERDICT_TONE[v.verdict] ?? 'neutral'}>{VERDICT_LABEL[v.verdict] ?? v.verdict}</Badge>
                    {v.verdict !== 'pending' ? <ConfidenceBar value={v.confidence} /> : null}
                    <span className="ml-auto text-[11px] text-ink-500">{fmtAgo(v.at)}</span>
                  </div>
                  {v.summary ? <Markdown text={v.summary} small className="mt-2 text-ink-200" onNoteClick={onNavigate} /> : null}
                  {v.issues?.length ? (
                    <ul className="mt-2 space-y-1 border-t border-ink-800 pt-2 text-[12.5px] text-ink-300">
                      {v.issues.map((issue, i) => (
                        <li key={i} className="flex gap-2"><span className="mt-[7px] size-1 shrink-0 rounded-full bg-brick" />{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </Section>
            ) : null}

            {['finding', 'fact', 'insight', 'definition', 'method'].includes(note.type) || note.assurance ? (
              <Section label="Niveau de vérification" icon={<Sigma className="size-3" />}>
                <AssuranceSection note={note} onUpdated={upsertNoteInStore} />
              </Section>
            ) : null}

            <section className="border-t border-ink-750 px-6 py-5">
              {note.content.trim() ? <Markdown text={note.content} onNoteClick={onNavigate} /> : <p className="text-[13px] italic text-ink-500">Note vide.</p>}
            </section>

            {note.links.length || backlinks.length ? (
              <Section label="Liens" icon={<Link2 className="size-3" />}>
                <div className="flex flex-col gap-1">
                  {note.links.map(l => <NoteLinkRow key={`o-${l}`} target={l} note={findNote(notes, l)} onClick={() => nav(l)} />)}
                  {backlinks.map(n => <NoteLinkRow key={`b-${n.id}`} target={n.slug} note={n} back onClick={() => nav(n.slug)} />)}
                </div>
              </Section>
            ) : null}

            {note.sourceIds.length ? (
              <Section label="Sources" icon={<BookMarked className="size-3" />}>
                <div className="flex flex-col gap-1.5">
                  {note.sourceIds.map(key => {
                    const s = sourceByKey[key]
                    return (
                      <div key={key} className="flex items-baseline gap-2 text-[12.5px]">
                        <span className="shrink-0 font-mono text-amber/90">{key}</span>
                        {s ? <span className="truncate text-ink-300" title={s.title}>{s.title}{s.year ? ` (${s.year})` : ''}</span> : null}
                      </div>
                    )
                  })}
                </div>
              </Section>
            ) : null}

            <section className="border-t border-ink-750 px-6 py-4 text-[11.5px] text-ink-500">
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <span>auteur</span><span className="font-mono text-ink-300">{note.createdBy}</span>
                <span>créée</span><span className="text-ink-300">{fmtDate(note.createdAt)}</span>
                <span>modifiée</span><span className="text-ink-300">{fmtDate(note.updatedAt)} · {fmtAgo(note.updatedAt)}</span>
                <span>consultations</span><span className="font-mono text-ink-300">{note.accessCount}</span>
              </div>
            </section>
          </>
        )}
      </div>

      {!editing ? (
        <footer className="flex items-center gap-2 border-t border-ink-750 bg-ink-925 px-5 py-3">
          <Button size="sm" onClick={() => setEditing(true)}><Pencil className="size-3.5" />Modifier</Button>
          {!superseded ? (
            <Button size="sm" variant="ghost" loading={busy === 'invalidate'} onClick={invalidate}><CircleSlash className="size-3.5" />Invalider</Button>
          ) : null}
          <Button size="sm" variant="danger" className="ml-auto" loading={busy === 'delete'} onClick={remove}><Trash2 className="size-3.5" />Supprimer</Button>
        </footer>
      ) : null}
    </>
  )
}

function DrawerHeader({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-750 px-4">
      <span className="kicker mr-1">Note</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <IconButton title="Fermer (Échap)" onClick={onClose}><X className="size-4" /></IconButton>
    </header>
  )
}

function NoteLinkRow({ target, note, back, onClick }: { target: string; note?: Note; back?: boolean; onClick: () => void }) {
  const t = note ? NOTE_TYPE[note.type] : undefined
  return (
    <button
      onClick={onClick}
      className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink-850"
    >
      <span className={cx('font-mono text-[10px] uppercase tracking-wider', back ? 'text-ink-500' : 'text-teal/80')}>{back ? '← retour' : '→ lien'}</span>
      <span className={cx('min-w-0 flex-1 truncate text-[13px]', note ? 'text-ink-100' : 'text-ink-500 italic', note?.status === 'superseded' && 'line-through opacity-60')}>
        {note?.title ?? target}
      </span>
      {t ? <Badge tone={t.tone}>{t.label}</Badge> : null}
      <ArrowUpRight className="size-3.5 text-ink-600 group-hover:text-ink-300" />
    </button>
  )
}

function EditForm({ note, projectId, onDone }: { note: Note; projectId: string; onDone: () => void }) {
  const toast = useApp(s => s.toast)
  const [title, setTitle] = useState(note.title)
  const [content, setContent] = useState(note.content)
  const [importance, setImportance] = useState(note.importance)
  const [confidence, setConfidence] = useState(note.confidence)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const updated = await api.updateNote(projectId, note.slug, { title, content, importance, confidence })
      upsertNoteInStore(updated)
      onDone()
    } catch (error) {
      toast({ title: 'Enregistrement impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <Field label="Titre"><Input value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Importance">
          <Select value={importance} onChange={e => setImportance(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map(i => <option key={i} value={i}>{i} / 5</option>)}
          </Select>
        </Field>
        <Field label={<span className="flex justify-between">Confiance <span className="font-mono text-ink-400">{Math.round(confidence * 100)}%</span></span>}>
          <input type="range" min={0} max={1} step={0.05} value={confidence} onChange={e => setConfidence(Number(e.target.value))} className="mt-2.5 w-full cursor-pointer accent-[#f2b544]" />
        </Field>
      </div>
      <Field label="Contenu" hint="Markdown, LaTeX ($…$) et [[liens]] vers d'autres notes.">
        <Textarea value={content} onChange={e => setContent(e.target.value)} rows={18} className="font-mono text-[12.5px]" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>Annuler</Button>
        <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save}>Enregistrer</Button>
      </div>
    </div>
  )
}
