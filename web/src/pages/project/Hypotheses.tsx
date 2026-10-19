import { FlaskConical, Lightbulb, Plus, Swords, ThumbsDown, ThumbsUp, Trash2, Trophy } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { EvidenceItem, Hypothesis, HypothesisStatus } from '@shared/types'
import { Markdown } from '../../components/Markdown'
import { Badge, Button, Empty, Field, IconButton, Modal, Select, Textarea, cx } from '../../components/ui'
import { api } from '../../lib/api'
import { fmtAgo, HYP_STATUS } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'

const STATUSES = Object.keys(HYP_STATUS) as HypothesisStatus[]

const upsertHyp = (h: Hypothesis): void => {
  if (h?.id) useProject.setState(s => ({ hypotheses: { ...s.hypotheses, [h.id]: h } }))
}

export function Hypotheses() {
  const hypotheses = useProject(s => s.hypotheses)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<HypothesisStatus | 'all'>('all')

  const ranked = useMemo(() => Object.values(hypotheses).sort((a, b) => b.elo - a.elo || b.matches - a.matches || a.createdAt - b.createdAt), [hypotheses])
  const range = useMemo(() => {
    const elos = ranked.map(h => h.elo)
    return { min: Math.min(...elos, 1200), max: Math.max(...elos, 1200) }
  }, [ranked])
  const counts = useMemo(() => {
    const c: Partial<Record<HypothesisStatus, number>> = {}
    for (const h of ranked) c[h.status] = (c[h.status] ?? 0) + 1
    return c
  }, [ranked])
  const shown = filter === 'all' ? ranked : ranked.filter(h => h.status === filter)
  const totalMatches = Math.round(ranked.reduce((n, h) => n + h.matches, 0) / 2)

  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 pb-16 pt-8">
        <header className="flex flex-wrap items-end justify-between gap-4 animate-rise">
          <div>
            <div className="kicker mb-1.5 flex items-center gap-1.5"><Trophy className="size-3" />Tournoi d'hypothèses</div>
            <h1 className="display text-[32px] font-semibold leading-tight text-paper">Classement <span className="text-amber">Elo</span></h1>
            <p className="mt-1.5 max-w-xl text-[13px] text-ink-400">
              Les hypothèses s'affrontent en duels arbitrés par un modèle ; le classement reflète leur plausibilité et leur intérêt relatifs.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {ranked.length ? <span className="font-mono text-[11px] text-ink-500">{ranked.length} hypothèses · {totalMatches} duels</span> : null}
            <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" />Nouvelle hypothèse</Button>
          </div>
        </header>

        {ranked.length ? (
          <div className="mt-6 flex flex-wrap gap-1.5">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="toutes" count={ranked.length} />
            {STATUSES.filter(s => counts[s]).map(s => (
              <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)} label={HYP_STATUS[s].label} count={counts[s]!} />
            ))}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col gap-4">
          {shown.map((h, i) => (
            <HypothesisCard key={h.id} h={h} rank={ranked.indexOf(h) + 1} range={range} delay={i} />
          ))}
        </div>

        {!ranked.length ? (
          <div className="mt-8 rounded-xl border border-dashed border-ink-700 bg-ink-900/50">
            <Empty icon={<Lightbulb className="size-8" />} title="Aucune hypothèse pour l'instant">
              <p>
                À la manière d'un <em>co-scientist</em>, les agents formulent des hypothèses candidates, accumulent des preuves pour et contre,
                puis les font s'affronter en tournoi : chaque duel met à jour un score <span className="font-mono text-ink-300">Elo</span>.
                Les meilleures sont testées en priorité.
              </p>
              <Button className="mt-4" onClick={() => setCreating(true)}><Plus className="size-4" />Proposer la première</Button>
            </Empty>
          </div>
        ) : null}
      </div>
      <NewHypothesisModal open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cx('inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', active ? 'border-amber/50 bg-amber-soft text-ink-100' : 'border-ink-700 text-ink-300 hover:border-ink-500')}
    >
      {label}<span className="font-mono text-[10.5px] text-ink-500">{count}</span>
    </button>
  )
}

function EloBar({ elo, range }: { elo: number; range: { min: number; max: number } }) {
  const span = range.max - range.min
  const pct = span > 0 ? 8 + ((elo - range.min) / span) * 92 : 50
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div className="h-full rounded-full bg-gradient-to-r from-amber-deep to-amber transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  )
}

function HypothesisCard({ h, rank, range, delay }: { h: Hypothesis; rank: number; range: { min: number; max: number }; delay: number }) {
  const projectId = useProject(s => s.id)!
  const toast = useApp(s => s.toast)
  const [busy, setBusy] = useState(false)
  const st = HYP_STATUS[h.status]
  const pro = h.evidence.filter(e => e.stance === 'for')
  const con = h.evidence.filter(e => e.stance === 'against')
  const dim = h.status === 'refuted' || h.status === 'abandoned'

  const setStatus = async (status: HypothesisStatus): Promise<void> => {
    setBusy(true)
    try {
      upsertHyp(await api.updateHypothesis(projectId, h.id, { status }))
    } catch (error) {
      toast({ title: 'Mise à jour impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!confirm('Supprimer définitivement cette hypothèse ?')) return
    try {
      await api.deleteHypothesis(projectId, h.id)
      useProject.setState(s => {
        const next = { ...s.hypotheses }
        delete next[h.id]
        return { hypotheses: next }
      })
    } catch (error) {
      toast({ title: 'Suppression impossible', body: (error as Error).message, level: 'error' })
    }
  }

  return (
    <article
      style={{ animationDelay: `${Math.min(delay, 8) * 40}ms` }}
      className={cx('group rounded-xl border bg-ink-900 animate-rise', rank === 1 && !dim ? 'border-amber/40 shadow-[0_0_0_1px_#f2b54414,0_20px_50px_-30px_#f2b54455]' : 'border-ink-750', dim && 'opacity-70')}
    >
      <div className="flex gap-5 p-5">
        <div className="flex w-12 shrink-0 flex-col items-center">
          <span className={cx('display text-[34px] font-semibold leading-none', rank === 1 ? 'text-amber' : rank <= 3 ? 'text-paper' : 'text-ink-500')}>{rank}</span>
          <span className="kicker mt-1">rang</span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <h2 className={cx('display flex-1 text-[19px] leading-snug text-paper', h.status === 'refuted' && 'line-through decoration-brick/50')}>{h.statement}</h2>
            <IconButton title="Supprimer" onClick={remove} className="opacity-0 transition-opacity group-hover:opacity-100 hover:!text-brick"><Trash2 className="size-4" /></IconButton>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Badge tone={st.tone}>{st.label}</Badge>
            <Select value={h.status} disabled={busy} onChange={e => void setStatus(e.target.value as HypothesisStatus)} className="h-7 w-auto py-0 pl-2 text-[12px]" aria-label="Changer le statut">
              {STATUSES.map(s => <option key={s} value={s}>{HYP_STATUS[s].label}</option>)}
            </Select>
            <div className="flex min-w-[220px] flex-1 items-center gap-3">
              <span className="font-mono text-[15px] font-semibold text-amber">{Math.round(h.elo)}</span>
              <EloBar elo={h.elo} range={range} />
              <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-ink-400" title="Duels disputés"><Swords className="size-3" />{h.matches}</span>
            </div>
          </div>

          {h.rationale.trim() ? (
            <div className="mt-4">
              <div className="kicker mb-1">Justification</div>
              <Markdown text={h.rationale} small className="text-ink-200" />
            </div>
          ) : null}

          {h.testPlan.trim() ? (
            <div className="mt-4 rounded-md border border-ink-750 bg-ink-925 px-3.5 py-2.5">
              <div className="kicker mb-1 flex items-center gap-1.5"><FlaskConical className="size-3" />Plan de test</div>
              <Markdown text={h.testPlan} small />
            </div>
          ) : null}

          {h.evidence.length ? (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <EvidenceColumn items={pro} stance="for" />
              <EvidenceColumn items={con} stance="against" />
            </div>
          ) : null}

          <div className="mt-3 text-right text-[11px] text-ink-600">
            par <span className="font-mono text-ink-500">{h.createdBy}</span> · {fmtAgo(h.updatedAt)}
          </div>
        </div>
      </div>
    </article>
  )
}

function EvidenceColumn({ items, stance }: { items: EvidenceItem[]; stance: 'for' | 'against' }) {
  const pro = stance === 'for'
  return (
    <div className={cx('rounded-md border px-3 py-2.5', pro ? 'border-teal/25 bg-teal-soft/40' : 'border-brick/25 bg-brick-soft/40')}>
      <div className={cx('mb-1.5 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em]', pro ? 'text-teal' : 'text-brick')}>
        {pro ? <ThumbsUp className="size-3" /> : <ThumbsDown className="size-3" />}
        {pro ? 'Pour' : 'Contre'} <span className="text-ink-500">{items.length}</span>
      </div>
      {items.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map((e, i) => (
            <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-ink-200">
              <span className={cx('mt-[7px] size-1 shrink-0 rounded-full', pro ? 'bg-teal' : 'bg-brick')} />
              <span className="min-w-0">
                {e.text}
                {e.ref ? <span className="ml-1.5 whitespace-nowrap font-mono text-[11px] text-amber/80">[{e.ref}]</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12px] italic text-ink-500">Aucune preuve.</div>
      )}
    </div>
  )
}

function NewHypothesisModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projectId = useProject(s => s.id)!
  const toast = useApp(s => s.toast)
  const [statement, setStatement] = useState('')
  const [rationale, setRationale] = useState('')
  const [testPlan, setTestPlan] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      upsertHyp(await api.createHypothesis(projectId, { statement: statement.trim(), rationale, testPlan }))
      setStatement('')
      setRationale('')
      setTestPlan('')
      onClose()
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
      title="Nouvelle hypothèse"
      subtitle="Elle entrera dans le tournoi avec un Elo initial et sera confrontée aux autres."
      footer={<><Button variant="ghost" onClick={onClose}>Annuler</Button><Button variant="primary" loading={busy} disabled={!statement.trim()} onClick={create}>Ajouter</Button></>}
    >
      <div className="flex flex-col gap-4">
        <Field label="Énoncé" hint="Une affirmation précise et falsifiable.">
          <Textarea value={statement} onChange={e => setStatement(e.target.value)} rows={3} autoFocus className="display text-[15px]" />
        </Field>
        <Field label="Justification" hint="Pourquoi est-elle plausible ? (Markdown)">
          <Textarea value={rationale} onChange={e => setRationale(e.target.value)} rows={4} />
        </Field>
        <Field label="Plan de test" hint="Comment la confirmer ou la réfuter ?">
          <Textarea value={testPlan} onChange={e => setTestPlan(e.target.value)} rows={4} />
        </Field>
      </div>
    </Modal>
  )
}
