import { Brain, Clock, Database, Layers, Network, Pencil, Plus, RefreshCw, Search, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d'
import type { CoreBlock, Episode, Note, NoteType } from '@shared/types'
import { Markdown } from '../../components/Markdown'
import { ConfidenceBar, ImportanceDots, NoteDrawer, upsertNoteInStore } from '../../components/NoteDrawer'
import { Badge, Button, Empty, Field, Input, Modal, Select, Spinner, Tabs, Textarea, Toggle, cx } from '../../components/ui'
import { AssuranceBadge } from '../../components/Assurance'
import type { Tone } from '../../components/ui'
import { api } from '../../lib/api'
import type { GraphData } from '../../lib/api'
import { fmtAgo, fmtDate, NOTE_TYPE, VERDICT_LABEL, VERDICT_TONE } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

type Tab = 'core' | 'notes' | 'graph' | 'episodes'

const TONE_HEX: Record<Tone, string> = {
  amber: '#f2b544', teal: '#5fb8a5', brick: '#e06a5a', sky: '#7fa8de', moss: '#a3c46c', rose: '#d98bb0', neutral: '#808898',
}

export function Memory() {
  const [tab, setTab] = useState<Tab>('notes')
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const blocks = useProject(s => s.blocks)
  const notes = useProject(s => s.notes)
  const activeCount = useMemo(() => Object.values(notes).filter(n => n.status === 'active').length, [notes])
  const close = useCallback(() => setOpenSlug(null), [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-ink-750 bg-ink-925/60 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="display text-[22px] text-paper">Mémoire</h1>
          <span className="kicker">{activeCount} notes actives</span>
        </div>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'core', label: <><Brain className="size-3.5" />Mémoire centrale</>, count: blocks.length },
            { value: 'notes', label: <><Database className="size-3.5" />Notes</>, count: activeCount },
            { value: 'graph', label: <><Network className="size-3.5" />Graphe</> },
            { value: 'episodes', label: <><Layers className="size-3.5" />Épisodes</> },
          ]}
        />
      </header>
      <div className="min-h-0 flex-1">
        {tab === 'core' ? <CoreBlocks /> : null}
        {tab === 'notes' ? <NotesTab onOpen={setOpenSlug} /> : null}
        {tab === 'graph' ? <GraphTab onOpen={setOpenSlug} /> : null}
        {tab === 'episodes' ? <EpisodesTab /> : null}
      </div>
      <NoteDrawer slug={openSlug} onClose={close} onNavigate={setOpenSlug} />
    </div>
  )
}

// ───────────────────────────── Core blocks ─────────────────────────────

function CoreBlocks() {
  const blocks = useProject(s => s.blocks)
  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <p className="mb-5 max-w-2xl text-[13px] text-ink-400">
          Blocs toujours présents dans le contexte de l'agent principal (à la MemGPT). Ils condensent l'essentiel : objectif, plan, acquis.
          Chaque bloc a une taille maximale ; l'agent les réécrit au fil de la recherche.
        </p>
        {blocks.length ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {blocks.map(b => <BlockCard key={b.label} block={b} />)}
          </div>
        ) : (
          <Empty icon={<Brain className="size-7" />} title="Aucun bloc de mémoire centrale">Ils apparaîtront au démarrage de la recherche.</Empty>
        )}
      </div>
    </div>
  )
}

function BlockCard({ block }: { block: CoreBlock }) {
  const projectId = useProject(s => s.id)!
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(block.value)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const len = editing ? draft.length : block.value.length
  const ratio = block.limit ? len / block.limit : 0

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const updated = await api.setBlock(projectId, block.label, draft)
      useProject.setState(s => ({ blocks: s.blocks.map(b => (b.label === updated.label ? updated : b)) }))
      setEditing(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col rounded-lg border border-ink-750 bg-ink-900/90 animate-rise">
      <header className="flex items-start gap-3 border-b border-ink-750 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-amber">{block.label}</div>
          {block.description ? <div className="mt-0.5 text-[12px] leading-snug text-ink-400">{block.description}</div> : null}
        </div>
        {!editing ? (
          <Button size="sm" variant="ghost" onClick={() => { setDraft(block.value); setError(''); setEditing(true) }}><Pencil className="size-3.5" />Modifier</Button>
        ) : null}
      </header>
      <div className="flex items-center gap-3 px-4 pt-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-800">
          <div className={cx('h-full rounded-full transition-all', ratio > 1 ? 'bg-brick' : ratio > 0.85 ? 'bg-amber' : 'bg-teal/80')} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
        <span className={cx('font-mono text-[10.5px]', ratio > 1 ? 'text-brick' : 'text-ink-500')}>{len} / {block.limit}</span>
      </div>
      <div className="flex-1 px-4 py-3">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea value={draft} onChange={e => setDraft(e.target.value)} rows={10} className="font-mono text-[12.5px]" autoFocus />
            {error ? <div className="rounded-md border border-brick/30 bg-brick-soft px-2.5 py-1.5 text-[12px] text-brick">{error}</div> : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Annuler</Button>
              <Button size="sm" variant="primary" loading={busy} onClick={save}>Enregistrer</Button>
            </div>
          </div>
        ) : block.value.trim() ? (
          <Markdown text={block.value} small />
        ) : (
          <p className="text-[12.5px] italic text-ink-500">Vide.</p>
        )}
      </div>
      <footer className="px-4 pb-2.5 text-right text-[10.5px] text-ink-600">{block.updatedAt ? `mis à jour ${fmtAgo(block.updatedAt)}` : ''}</footer>
    </section>
  )
}

// ───────────────────────────── Notes ─────────────────────────────

type Sort = 'importance' | 'recent' | 'access'

const SORTERS: Record<Sort, (a: Note, b: Note) => number> = {
  importance: (a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt,
  recent: (a, b) => b.updatedAt - a.updatedAt,
  access: (a, b) => b.accessCount - a.accessCount || b.updatedAt - a.updatedAt,
}

function useNoteSearch(projectId: string, q: string, includeAll: boolean): { results: Note[] | null; searching: boolean } {
  const [results, setResults] = useState<Note[] | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(() => {
      api.notes(projectId, { q: query, all: includeAll })
        .then(r => { if (!cancelled) setResults(r) })
        .catch(() => { if (!cancelled) setResults([]) })
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [projectId, q, includeAll])
  return { results, searching }
}

function NotesTab({ onOpen }: { onOpen: (slug: string) => void }) {
  const projectId = useProject(s => s.id)!
  const notes = useProject(s => s.notes)
  const [q, setQ] = useState('')
  const [type, setType] = useState<NoteType | null>(null)
  const [includeAll, setIncludeAll] = useState(false)
  const [sort, setSort] = useState<Sort>('importance')
  const [creating, setCreating] = useState(false)
  const { results, searching } = useNoteSearch(projectId, q, includeAll)

  const base = useMemo(() => {
    const list = results ? results.map(n => notes[n.id] ?? n) : Object.values(notes)
    return includeAll ? list : list.filter(n => n.status === 'active')
  }, [results, notes, includeAll])

  const counts = useMemo(() => {
    const c: Partial<Record<NoteType, number>> = {}
    for (const n of base) c[n.type] = (c[n.type] ?? 0) + 1
    return c
  }, [base])

  const shown = useMemo(() => {
    const list = type ? base.filter(n => n.type === type) : base
    return results ? list : list.slice().sort(SORTERS[sort])
  }, [base, type, results, sort])

  return (
    <div className="flex h-full">
      <aside className="flex w-[264px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-ink-750 bg-ink-925/60 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-500" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Recherche hybride…" className="pl-8 pr-8" />
          {searching ? <Spinner className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-amber" /> : null}
        </div>

        <div>
          <div className="kicker mb-2">Types</div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={type === null} onClick={() => setType(null)} label="tous" count={base.length} />
            {(Object.keys(NOTE_TYPE) as NoteType[]).filter(t => counts[t]).map(t => (
              <Chip key={t} active={type === t} onClick={() => setType(type === t ? null : t)} label={NOTE_TYPE[t].label} count={counts[t]!} color={TONE_HEX[NOTE_TYPE[t].tone]} />
            ))}
          </div>
        </div>

        <div>
          <div className="kicker mb-2">Tri</div>
          <Select value={sort} onChange={e => setSort(e.target.value as Sort)} disabled={Boolean(results)} className="h-8 text-[12.5px]">
            <option value="importance">Importance</option>
            <option value="recent">Plus récentes</option>
            <option value="access">Plus consultées</option>
          </Select>
          {results ? <div className="mt-1.5 text-[11px] text-ink-500">Résultats triés par pertinence.</div> : null}
        </div>

        <Toggle checked={includeAll} onChange={setIncludeAll} label="Inclure invalidées" hint="Notes remplacées ou archivées" />

        <div className="mt-auto">
          <Button variant="primary" className="w-full" onClick={() => setCreating(true)}><Plus className="size-4" />Nouvelle note</Button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {shown.length ? (
          <ul className="divide-y divide-ink-800">
            {shown.map(n => <NoteRow key={n.id} note={n} onOpen={onOpen} />)}
          </ul>
        ) : (
          <Empty icon={<Database className="size-7" />} title={q ? 'Aucun résultat' : 'Aucune note'}>
            {q ? 'Essaie d\'autres termes, ou inclus les notes invalidées.' : 'Les agents consignent ici résultats, faits, méthodes et impasses au fil de la recherche.'}
          </Empty>
        )}
      </div>

      <NewNoteModal open={creating} onClose={() => setCreating(false)} onCreated={n => onOpen(n.slug)} />
    </div>
  )
}

function Chip({ active, onClick, label, count, color }: { active: boolean; onClick: () => void; label: string; count: number; color?: string }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors',
        active ? 'border-amber/50 bg-amber-soft text-ink-100' : 'border-ink-700 text-ink-300 hover:border-ink-500',
      )}
    >
      {color ? <span className="size-1.5 rounded-full" style={{ background: color }} /> : null}
      {label}
      <span className="font-mono text-[10px] text-ink-500">{count}</span>
    </button>
  )
}

function NoteRow({ note: n, onOpen }: { note: Note; onOpen: (slug: string) => void }) {
  const t = NOTE_TYPE[n.type] ?? { label: n.type, tone: 'neutral' as const }
  const inactive = n.status !== 'active'
  return (
    <li>
      <button onClick={() => onOpen(n.slug)} className={cx('group flex w-full cursor-pointer items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-ink-900', inactive && 'opacity-55')}>
        <span className="mt-[7px] h-6 w-0.5 shrink-0 rounded-full" style={{ background: TONE_HEX[t.tone] }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge tone={t.tone}>{t.label}</Badge>
            <span className={cx('truncate text-[14px] text-ink-100 group-hover:text-paper', inactive && 'line-through decoration-ink-500')}>{n.title}</span>
          </div>
          <div className="mt-1 line-clamp-1 text-[12px] text-ink-400">{n.content.replace(/[#*_`>[\]]/g, '').slice(0, 220)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
            <ImportanceDots value={n.importance} />
            {n.verification ? <Badge tone={VERDICT_TONE[n.verification.verdict] ?? 'neutral'}>{VERDICT_LABEL[n.verification.verdict] ?? n.verification.verdict}</Badge> : null}
            <AssuranceBadge note={n} />
            {n.status === 'superseded' ? <Badge tone="brick">invalidée</Badge> : null}
            {n.tags.slice(0, 4).map(tag => <span key={tag} className="font-mono text-ink-400">#{tag}</span>)}
            <span className="ml-auto whitespace-nowrap">{fmtAgo(n.updatedAt)}</span>
          </div>
        </div>
      </button>
    </li>
  )
}

function NewNoteModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (n: Note) => void }) {
  const projectId = useProject(s => s.id)!
  const toast = useApp(s => s.toast)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<NoteType>('finding')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [importance, setImportance] = useState(3)
  const [confidence, setConfidence] = useState(0.7)
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const note = await api.createNote(projectId, {
        title: title.trim(), type, content, importance, confidence,
        tags: tags.split(/[,\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean),
      })
      upsertNoteInStore(note)
      setTitle('')
      setContent('')
      setTags('')
      onClose()
      onCreated(note)
    } catch (error) {
      toast({ title: 'Création impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nouvelle note"
      subtitle="Ajoute une connaissance à la mémoire partagée des agents."
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button variant="primary" loading={busy} disabled={!title.trim()} onClick={create}><Sparkles className="size-4" />Créer</Button></>}
    >
      <div className="flex flex-col gap-4">
        <Field label="Titre"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex. Le décodeur BP+OSD sature au-delà de d = 12" autoFocus /></Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Type">
            <Select value={type} onChange={e => setType(e.target.value as NoteType)}>
              {(Object.keys(NOTE_TYPE) as NoteType[]).map(t => <option key={t} value={t}>{NOTE_TYPE[t].label}</option>)}
            </Select>
          </Field>
          <Field label="Importance">
            <Select value={importance} onChange={e => setImportance(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map(i => <option key={i} value={i}>{i} / 5</option>)}
            </Select>
          </Field>
          <Field label={<span className="flex justify-between">Confiance <ConfidenceBar value={confidence} className="scale-90" /></span>}>
            <input type="range" min={0} max={1} step={0.05} value={confidence} onChange={e => setConfidence(Number(e.target.value))} className="mt-2.5 w-full cursor-pointer accent-[#f2b544]" />
          </Field>
        </div>
        <Field label="Contenu" hint="Markdown, LaTeX et [[liens]] vers d'autres notes.">
          <Textarea value={content} onChange={e => setContent(e.target.value)} rows={9} className="font-mono text-[12.5px]" />
        </Field>
        <Field label="Tags" hint="Séparés par des virgules ou des espaces.">
          <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="décodage, ldpc" />
        </Field>
      </div>
    </Modal>
  )
}

// ───────────────────────────── Graph ─────────────────────────────

type GNode = GraphData['nodes'][number]
type GLink = { kind: string }
type FGNode = NodeObject<GNode>
type FGLink = LinkObject<GNode, GLink>

const endId = (end: FGLink['source']): string => (typeof end === 'object' && end ? String(end.id) : String(end))

function useSize(ref: RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: Math.floor(width), h: Math.floor(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

function nodeColor(n: GNode): string {
  if (n.kind === 'source') return '#808898'
  const t = NOTE_TYPE[n.type as NoteType]
  return t ? TONE_HEX[t.tone] : TONE_HEX.neutral
}

const nodeRadius = (n: GNode): number => (n.kind === 'source' ? 2.6 : 2.4 + (n.importance || 1) * 1.15)

function GraphTab({ onOpen }: { onOpen: (slug: string) => void }) {
  const projectId = useProject(s => s.id)!
  const noteCount = useProject(s => Object.keys(s.notes).length)
  const sourceCount = useProject(s => Object.keys(s.sources).length)
  const [data, setData] = useState<{ nodes: FGNode[]; links: FGLink[] } | null>(null)
  const [error, setError] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods<FGNode, FGLink> | undefined>(undefined)
  const fitted = useRef(false)
  const size = useSize(boxRef)
  const ready = size.w > 0

  useEffect(() => {
    let cancelled = false
    api.graph(projectId)
      .then(g => {
        if (cancelled) return
        // keep positions of nodes we already laid out, so a refresh doesn't scramble the map
        setData(prev => {
          const pos = new Map((prev?.nodes ?? []).map(n => [String(n.id), n]))
          const nodes = g.nodes.map(n => {
            const p = pos.get(n.id)
            return p ? { ...n, x: p.x, y: p.y, vx: 0, vy: 0 } : { ...n }
          })
          return { nodes, links: g.links.map(l => ({ ...l })) }
        })
        setError('')
      })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [projectId, noteCount, sourceCount])

  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !data) return
    fg.d3Force('charge')?.strength?.(-55)
    fg.d3Force('link')?.distance?.(38)
  }, [data, ready])

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const l of data?.links ?? []) {
      const a = endId(l.source)
      const b = endId(l.target)
      if (!m.has(a)) m.set(a, new Set())
      if (!m.has(b)) m.set(b, new Set())
      m.get(a)!.add(b)
      m.get(b)!.add(a)
    }
    return m
  }, [data])

  const isLit = useCallback((id: string): boolean => !hover || id === hover || Boolean(neighbors.get(hover)?.has(id)), [hover, neighbors])

  const drawNode = useCallback((node: FGNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const r = nodeRadius(node)
    const id = String(node.id)
    const lit = isLit(id)
    const superseded = node.status === 'superseded' || node.status === 'archived'
    ctx.globalAlpha = !lit ? 0.14 : superseded ? 0.3 : 1
    ctx.fillStyle = nodeColor(node)
    if (node.kind === 'source') {
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    } else {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fill()
      if (node.verdict && node.verdict !== 'pending') {
        ctx.beginPath()
        ctx.arc(x, y, r + 1.6, 0, 2 * Math.PI)
        ctx.strokeStyle = TONE_HEX[VERDICT_TONE[node.verdict] ?? 'neutral']
        ctx.lineWidth = 1.1
        ctx.stroke()
      }
    }
    if (id === hover) {
      ctx.beginPath()
      ctx.arc(x, y, r + 3.2, 0, 2 * Math.PI)
      ctx.strokeStyle = '#f3efe4'
      ctx.lineWidth = 1 / scale
      ctx.stroke()
    }
    const showLabel = id === hover || (hover ? lit : scale > 2.3)
    if (showLabel) {
      const fs = Math.max(10 / scale, 1.6)
      const label = node.label.length > 48 ? `${node.label.slice(0, 46)}…` : node.label
      ctx.font = `${id === hover ? 600 : 400} ${fs}px "IBM Plex Sans", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.lineWidth = 3 / scale
      ctx.strokeStyle = '#0b0c0f'
      ctx.strokeText(label, x, y + r + 2.5)
      ctx.fillStyle = id === hover ? '#f3efe4' : '#c9cdd6'
      ctx.fillText(label, x, y + r + 2.5)
    }
    ctx.globalAlpha = 1
  }, [hover, isLit])

  const paintArea = useCallback((node: FGNode, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node) + 2.5, 0, 2 * Math.PI)
    ctx.fill()
  }, [])

  const touches = (l: FGLink): boolean => Boolean(hover) && (endId(l.source) === hover || endId(l.target) === hover)
  const linkColor = (l: FGLink): string => {
    if (hover && !touches(l)) return '#20242d'
    if (l.kind === 'superseded') return '#e06a5a'
    if (touches(l)) return '#f2b544aa'
    return l.kind === 'cites' ? '#5d6575' : '#434a59'
  }

  const legendTypes = useMemo(() => {
    const present = new Set((data?.nodes ?? []).filter(n => n.kind === 'note').map(n => n.type))
    return (Object.keys(NOTE_TYPE) as NoteType[]).filter(t => present.has(t))
  }, [data])

  return (
    <div ref={boxRef} className="graph-paper relative h-full overflow-hidden">
      {!data && !error ? <div className="absolute inset-0 flex items-center justify-center text-amber"><Spinner className="size-5" /></div> : null}
      {error ? <Empty icon={<Network className="size-7" />} title="Graphe indisponible">{error}</Empty> : null}
      {data && !data.nodes.length ? (
        <Empty icon={<Network className="size-7" />} title="Graphe vide">Les notes, leurs liens [[…]] et les sources citées formeront ici une carte de la connaissance.</Empty>
      ) : null}
      {data && data.nodes.length && size.w > 0 ? (
        <ForceGraph2D<GNode, GLink>
          ref={fgRef}
          graphData={data}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={() => ''}
          nodeCanvasObject={drawNode}
          nodePointerAreaPaint={paintArea}
          linkColor={linkColor}
          linkWidth={l => (l.kind === 'superseded' ? 1.4 : touches(l) ? 1.5 : 0.8)}
          linkLineDash={l => (l.kind === 'cites' ? [2, 2] : null)}
          linkDirectionalArrowLength={l => (l.kind === 'superseded' ? 4 : 0)}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={() => '#e06a5a'}
          cooldownTicks={150}
          onEngineStop={() => {
            if (!fitted.current) {
              fitted.current = true
              fgRef.current?.zoomToFit(500, 50)
            }
          }}
          onNodeHover={n => setHover(n ? String(n.id) : null)}
          onNodeClick={n => { if (n.kind === 'note') onOpen(String(n.id)) }}
          onBackgroundClick={() => setHover(null)}
        />
      ) : null}

      {data && data.nodes.length ? (
        <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-ink-750 bg-ink-900/85 px-3.5 py-3 backdrop-blur-sm">
          <div className="kicker mb-2">Légende</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-ink-300">
            {legendTypes.map(t => (
              <span key={t} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: TONE_HEX[NOTE_TYPE[t].tone] }} />{NOTE_TYPE[t].label}</span>
            ))}
            <span className="flex items-center gap-1.5"><span className="size-2 bg-ink-400" />source</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-ink-400 opacity-30" />invalidée</span>
          </div>
          <div className="mt-2.5 flex flex-col gap-1 border-t border-ink-800 pt-2 text-[11px] text-ink-400">
            <span className="flex items-center gap-2"><span className="w-5 border-t border-ink-600" />lien [[…]]</span>
            <span className="flex items-center gap-2"><span className="w-5 border-t border-dashed border-ink-500" />cite</span>
            <span className="flex items-center gap-2"><span className="w-5 border-t border-brick" />remplacée par</span>
          </div>
        </div>
      ) : null}

      {data && data.nodes.length ? (
        <div className="absolute bottom-4 right-4 flex items-center gap-2">
          <span className="rounded-md border border-ink-750 bg-ink-900/85 px-2.5 py-1 font-mono text-[11px] text-ink-400">{data.nodes.length} nœuds · {data.links.length} liens</span>
          <Button size="sm" variant="subtle" onClick={() => fgRef.current?.zoomToFit(400, 50)}>Recadrer</Button>
        </div>
      ) : null}
    </div>
  )
}

// ───────────────────────────── Episodes ─────────────────────────────

function EpisodesTab() {
  const projectId = useProject(s => s.id)!
  const [episodes, setEpisodes] = useState<Episode[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.episodes(projectId)
      setEpisodes(list.slice().sort((a, b) => b.createdAt - a.createdAt))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <p className="max-w-xl text-[13px] text-ink-400">
            Quand le contexte d'un agent se remplit, la conversation est compactée en un résumé d'épisode. Ces résumés restent consultables par les agents (rappel de l'historique).
          </p>
          <Button size="sm" variant="ghost" loading={loading} onClick={load}>{!loading ? <RefreshCw className="size-3.5" /> : null}Actualiser</Button>
        </div>
        {error ? <div className="rounded-md border border-brick/30 bg-brick-soft px-3 py-2 text-[12.5px] text-brick">{error}</div> : null}
        {episodes && !episodes.length ? (
          <Empty icon={<Clock className="size-7" />} title="Aucun épisode">Aucune compaction n'a encore eu lieu sur ce projet.</Empty>
        ) : null}
        {!episodes && !error ? <div className="flex justify-center py-12 text-amber"><Spinner /></div> : null}
        {episodes?.length ? (
          <ol className="relative border-l border-ink-750 pl-6">
            {episodes.map((ep, i) => (
              <li key={ep.id} className="relative mb-6 animate-rise" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <span className="absolute -left-[29.5px] top-1.5 size-2.5 rounded-full border-2 border-ink-950 bg-amber" />
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-400">
                  <span className="text-ink-200">{fmtDate(ep.createdAt)}</span>
                  <span className="text-ink-600">·</span>
                  <span className="font-mono text-ink-300">{ep.agentId}</span>
                  <Badge>{ep.messageCount} messages</Badge>
                </div>
                <div className="rounded-lg border border-ink-750 bg-ink-900 px-4 py-3">
                  <Markdown text={ep.summary} small />
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  )
}
