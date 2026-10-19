import { CheckCircle2, ChevronDown, FileCode2, Sigma, ThumbsDown, ThumbsUp, UserCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AssuranceLevel, LeanCheck, Note } from '@shared/types'
import { ASSURANCE_LABELS, ASSURANCE_LEVELS } from '@shared/types'
import { api } from '../lib/api'
import { ASSURANCE_SHORT, ASSURANCE_TONE, fmtAgo, VERDICT_LABEL, VERDICT_TONE } from '../lib/format'
import { useApp } from '../store/app'
import { useProject } from '../store/project'
import { Badge, Button, cx } from './ui'

/** Compact badge for lists: hidden for « affirmé » unless `always`. */
export function AssuranceBadge({ note, always }: { note: Note; always?: boolean }) {
  const level: AssuranceLevel = note.assurance?.level ?? 'claimed'
  if (level === 'claimed' && !always) return null
  const unreviewed = level === 'formal' && note.assurance?.lean?.statementReview?.verdict !== 'supported'
  return (
    <Badge tone={ASSURANCE_TONE[level]} title={`${ASSURANCE_LABELS[level]}${unreviewed ? ' — fidélité de l\'énoncé Lean non relue' : ''}`}>
      {level === 'formal' ? <Sigma className="size-2.5" /> : null}{ASSURANCE_SHORT[level]}{unreviewed ? '?' : ''}
    </Badge>
  )
}

/** Ladder, history, Lean formalization and human review of one note. */
export function AssuranceSection({ note, onUpdated }: { note: Note; onUpdated: (n: Note) => void }) {
  const projectId = useProject(s => s.id)!
  const filesVersion = useProject(s => s.filesVersion)
  const toast = useApp(s => s.toast)
  const [checks, setChecks] = useState<LeanCheck[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const a = note.assurance
  const level: AssuranceLevel = a?.level ?? 'claimed'
  const rank = ASSURANCE_LEVELS.indexOf(level)

  useEffect(() => {
    api.leanChecks(projectId, note.slug).then(setChecks).catch(() => setChecks([]))
  }, [projectId, note.slug, filesVersion, a?.lean?.status])

  const review = async (verdict: 'approved' | 'rejected', target: 'result' | 'lean_statement'): Promise<void> => {
    const comment = prompt(verdict === 'approved'
      ? (target === 'lean_statement' ? 'Commentaire (optionnel) : en quoi l\'énoncé Lean est fidèle' : 'Commentaire (optionnel)')
      : (target === 'lean_statement' ? 'Qu\'est-ce qui diffère entre l\'énoncé Lean et la note ?' : 'Pourquoi rejeter ce résultat ?'), '')
    if (comment === null) return
    setBusy(`${verdict}-${target}`)
    try {
      onUpdated(await api.reviewNote(projectId, note.slug, { verdict, target, comment }))
      toast({ title: verdict === 'approved' ? 'Relecture enregistrée' : 'Rejet enregistré', body: 'Le chercheur principal est prévenu s\'il travaille.', level: 'success' })
    } catch (error) {
      toast({ title: 'Enregistrement impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy('')
    }
  }

  const latest = checks[0]
  const proved = checks.find(c => c.status === 'proved')
  const sr = a?.lean?.statementReview
  const hr = a?.humanReview

  return (
    <div className="flex flex-col gap-3">
      {/* ladder */}
      <div className="grid grid-cols-4 gap-1">
        {ASSURANCE_LEVELS.map((l, i) => (
          <div key={l} className={cx('rounded-md border px-2 py-1.5 text-center text-[10.5px] leading-tight', i <= rank ? (i === rank ? 'border-amber/50 bg-amber-soft text-amber' : 'border-ink-700 bg-ink-850 text-ink-300') : 'border-ink-800 text-ink-600')}>
            {ASSURANCE_LABELS[l]}
          </div>
        ))}
      </div>

      {/* Lean */}
      {latest || a?.lean ? (
        <div className="rounded-md border border-ink-750 bg-ink-925 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Sigma className="size-3.5 text-moss" />
            <span className="text-[12.5px] text-ink-200">Formalisation Lean</span>
            {latest ? <Badge tone={latest.status === 'proved' ? 'moss' : latest.status === 'running' ? 'amber' : 'brick'}>{latest.status === 'proved' ? 'acceptée par Comparator' : latest.status === 'running' ? 'vérification en cours' : 'rejetée'}</Badge> : null}
            {latest ? <span className="ml-auto text-[11px] text-ink-500">{fmtAgo(latest.createdAt)}</span> : null}
          </div>
          {proved ? (
            <div className="mt-2 flex flex-col gap-1 text-[12px]">
              <span className="text-ink-400">Théorème(s) : <span className="font-mono text-ink-200">{proved.theorems.join(', ')}</span>{proved.definitions.length ? <> · trous : <span className="font-mono text-amber">{proved.definitions.join(', ')}</span></> : null}</span>
              <span className="flex flex-wrap gap-3">
                <a className="inline-flex items-center gap-1 text-teal hover:text-paper" href={api.fileUrl(projectId, proved.challengeFile)} target="_blank" rel="noreferrer"><FileCode2 className="size-3" />Énoncé (Challenge.lean)</a>
                <a className="inline-flex items-center gap-1 text-teal hover:text-paper" href={api.fileUrl(projectId, proved.solutionFile)} target="_blank" rel="noreferrer"><FileCode2 className="size-3" />Preuve (Solution.lean)</a>
              </span>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-ink-800 pt-2 text-[12px]">
            <span className="text-ink-400">Fidélité de l'énoncé :</span>
            {sr ? <Badge tone={VERDICT_TONE[sr.verdict]}>{VERDICT_LABEL[sr.verdict]} (agent)</Badge> : <Badge>non relue par un agent</Badge>}
            {hr?.target === 'lean_statement' ? <Badge tone={hr.verdict === 'approved' ? 'teal' : 'brick'}><UserCheck className="size-2.5" />{hr.verdict === 'approved' ? 'approuvée' : 'rejetée'} par toi</Badge> : null}
          </div>
          {sr?.summary ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">{sr.summary}</p> : null}
          {proved ? (
            <div className="mt-2 flex gap-2">
              <Button size="sm" loading={busy === 'approved-lean_statement'} onClick={() => void review('approved', 'lean_statement')}><ThumbsUp className="size-3.5" />Énoncé fidèle</Button>
              <Button size="sm" variant="ghost" loading={busy === 'rejected-lean_statement'} onClick={() => void review('rejected', 'lean_statement')}><ThumbsDown className="size-3.5" />Infidèle</Button>
            </div>
          ) : null}
          {latest && latest.status !== 'proved' && latest.output ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11.5px] text-ink-400">Sortie de Comparator</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[10.5px] text-ink-300">{latest.output.split('\n').slice(-40).join('\n')}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* human review of the result */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-ink-400">Ta relecture :</span>
        {hr?.target === 'result' ? <Badge tone={hr.verdict === 'approved' ? 'teal' : 'brick'}><UserCheck className="size-2.5" />{hr.verdict === 'approved' ? 'approuvé' : 'rejeté'} · {fmtAgo(hr.at)}</Badge> : <span className="text-ink-500">aucune</span>}
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" loading={busy === 'approved-result'} onClick={() => void review('approved', 'result')}><CheckCircle2 className="size-3.5" />Approuver</Button>
          <Button size="sm" variant="ghost" loading={busy === 'rejected-result'} onClick={() => void review('rejected', 'result')}><ThumbsDown className="size-3.5" />Rejeter</Button>
        </span>
      </div>
      {hr?.comment ? <p className="text-[11.5px] italic text-ink-400">« {hr.comment} »</p> : null}

      {/* history */}
      {a?.history.length ? (
        <div>
          <button className="flex cursor-pointer items-center gap-1 text-[11.5px] text-ink-400 hover:text-ink-200" onClick={() => setOpen(o => !o)}>
            <ChevronDown className={cx('size-3 transition-transform', open ? '' : '-rotate-90')} />Historique ({a.history.length})
          </button>
          {open ? (
            <ol className="mt-1.5 flex flex-col gap-1.5 border-l border-ink-750 pl-3">
              {[...a.history].reverse().map((e, i) => (
                <li key={i} className="text-[11.5px] leading-relaxed text-ink-300">
                  <span className="mr-1.5"><Badge tone={ASSURANCE_TONE[e.level]}>{ASSURANCE_SHORT[e.level]}</Badge></span>
                  <span className="font-mono text-[10.5px] text-ink-500">{e.by} · {fmtAgo(e.at)}</span>
                  <div className="text-ink-400">{e.detail}</div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
