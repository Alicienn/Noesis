import { FileDown, FolderOpen, PackageCheck, RefreshCw, ScrollText, Sigma } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AssuranceLevel, LeanCheck, PublicationVersion } from '@shared/types'
import { ASSURANCE_LABELS, ASSURANCE_LEVELS } from '@shared/types'
import { api } from '../../lib/api'
import { ASSURANCE_TONE, fmtAgo, fmtDate, NOTE_TYPE } from '../../lib/format'
import { useApp } from '../../store/app'
import { useProject } from '../../store/project'
import { AssuranceBadge } from '../../components/Assurance'
import { Markdown } from '../../components/Markdown'
import { NoteDrawer } from '../../components/NoteDrawer'
import { Badge, Button, Empty, Input, Panel, cx } from '../../components/ui'

const SUMMARY = 'reports/_resume-raisonnement.md'

/**
 * Results by verification level, abridged reasoning summary, Lean checks, and
 * versioned publication bundles (LaTeX + BibTeX + formalization.yaml).
 */
export function Publication() {
  const pid = useProject(s => s.id)!
  const notes = useProject(s => s.notes)
  const filesVersion = useProject(s => s.filesVersion)
  const toast = useApp(s => s.toast)
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>()
  const [checks, setChecks] = useState<LeanCheck[]>([])
  const [versions, setVersions] = useState<PublicationVersion[]>([])
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    api.fileText(pid, SUMMARY).then(setSummary).catch(() => setSummary(null))
    api.leanChecks(pid).then(setChecks).catch(() => setChecks([]))
    api.publications(pid).then(setVersions).catch(() => setVersions([]))
  }, [pid])
  useEffect(load, [load, filesVersion])

  const results = useMemo(() => Object.values(notes)
    .filter(n => n.status === 'active' && ['finding', 'insight', 'fact'].includes(n.type))
    .sort((a, b) => ASSURANCE_LEVELS.indexOf(b.assurance?.level ?? 'claimed') - ASSURANCE_LEVELS.indexOf(a.assurance?.level ?? 'claimed') || b.importance - a.importance), [notes])
  const count = (l: AssuranceLevel): number => results.filter(n => (n.assurance?.level ?? 'claimed') === l).length

  const generate = async (): Promise<void> => {
    setBusy('summary')
    try {
      await api.reasoningSummary(pid)
      load()
      toast({ title: 'Résumé du raisonnement généré', body: SUMMARY, level: 'success' })
    } catch (error) {
      toast({ title: 'Génération impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy('')
    }
  }

  const publish = async (): Promise<void> => {
    setBusy('publish')
    try {
      const v = await api.publish(pid, note)
      setNote('')
      load()
      toast({ title: `Version ${v.version} exportée`, body: v.dir, level: 'success' })
    } catch (error) {
      toast({ title: 'Export impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <Panel kicker="Résultats" title="Niveau de vérification" bodyClassName="p-0">
          <div className="grid grid-cols-4 gap-px border-b border-ink-750 bg-ink-750">
            {[...ASSURANCE_LEVELS].reverse().map(l => (
              <div key={l} className="bg-ink-900 px-4 py-3">
                <div className="display text-[24px] leading-none text-paper">{count(l)}</div>
                <div className="mt-1.5"><Badge tone={ASSURANCE_TONE[l]}>{ASSURANCE_LABELS[l]}</Badge></div>
              </div>
            ))}
          </div>
          {results.length ? (
            <ul className="divide-y divide-ink-800">
              {results.slice(0, 80).map(n => (
                <li key={n.id}>
                  <button onClick={() => setOpenSlug(n.slug)} className="flex w-full cursor-pointer items-center gap-3 px-5 py-2.5 text-left hover:bg-ink-900">
                    <Badge tone={NOTE_TYPE[n.type].tone}>{NOTE_TYPE[n.type].label}</Badge>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{n.title}</span>
                    <AssuranceBadge note={n} always />
                  </button>
                </li>
              ))}
            </ul>
          ) : <div className="p-5"><Empty title="Aucun résultat consigné">Les résultats (notes « finding ») apparaîtront ici avec leur niveau de vérification.</Empty></div>}
        </Panel>

        <Panel kicker="Trajectoire" title={<span className="flex items-center gap-2"><ScrollText className="size-4 text-amber" />Résumé du raisonnement</span>}
          actions={<Button size="sm" loading={busy === 'summary'} onClick={() => void generate()}>{busy !== 'summary' ? <RefreshCw className="size-3.5" /> : null}{summary ? 'Régénérer' : 'Générer'}</Button>}
          bodyClassName="p-5"
        >
          {summary ? (
            <div className="max-h-[520px] overflow-y-auto pr-2"><Markdown text={summary} onNoteClick={setOpenSlug} /></div>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-400">
              Récit abrégé de la recherche (obstacles, idées décisives, impasses, vérifications), sur le modèle des résumés publiés avec openai/math. Les extraits verbatim sont recopiés depuis la base, jamais réécrits par le modèle. Généré automatiquement à la fin d'une recherche, ou à la demande.
            </p>
          )}
        </Panel>

        <Panel kicker="Vérification formelle" title={<span className="flex items-center gap-2"><Sigma className="size-4 text-moss" />Vérifications Comparator</span>} bodyClassName="p-0">
          {checks.length ? (
            <table className="w-full text-[12px]">
              <thead className="text-left text-ink-500">
                <tr className="border-b border-ink-750"><th className="px-4 py-2 font-normal">Théorème(s)</th><th className="px-2 py-2 font-normal">Note</th><th className="px-2 py-2 font-normal">Statut</th><th className="px-2 py-2 font-normal">Durée</th><th className="px-4 py-2 font-normal">Quand</th></tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {checks.map(c => (
                  <tr key={c.id}>
                    <td className="px-4 py-2 font-mono text-ink-200">
                      <a href={api.fileUrl(pid, c.challengeFile)} target="_blank" rel="noreferrer" className="hover:text-teal">{c.theorems.join(', ')}</a>
                    </td>
                    <td className="px-2 py-2">{c.noteSlug ? <button className="cursor-pointer font-mono text-teal hover:text-paper" onClick={() => setOpenSlug(c.noteSlug!)}>[[{c.noteSlug}]]</button> : <span className="text-ink-600">—</span>}</td>
                    <td className="px-2 py-2"><Badge tone={c.status === 'proved' ? 'moss' : c.status === 'running' ? 'amber' : 'brick'}>{c.status === 'proved' ? 'acceptée' : c.status === 'running' ? 'en cours' : 'rejetée'}</Badge></td>
                    <td className="px-2 py-2 font-mono text-ink-400">{c.durationMs ? `${Math.round(c.durationMs / 1000)} s` : '—'}</td>
                    <td className="px-4 py-2 text-ink-500">{fmtAgo(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="p-5 text-[12.5px] text-ink-400">Aucune vérification Lean pour ce projet. Active la formalisation dans les réglages du projet ; l'environnement s'installe dans Paramètres → Vérification formelle.</p>}
        </Panel>

        <Panel kicker="Publication" title={<span className="flex items-center gap-2"><PackageCheck className="size-4 text-amber" />Versions exportées</span>} bodyClassName="flex flex-col gap-4 p-5">
          <p className="text-[12.5px] leading-relaxed text-ink-400">
            Chaque export crée <span className="font-mono">publication/vN/</span> : manuscrit LaTeX et Markdown, <span className="font-mono">references.bib</span>, résumé du raisonnement, <span className="font-mono">formalization.yaml</span> (schéma mathlib-initiative v0.4) avec les fichiers Lean vérifiés, et un README qui donne le niveau de chaque résultat. Une correction devient une nouvelle version ; les précédentes ne sont jamais modifiées.
          </p>
          <div className="flex gap-2">
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Note de version (optionnel) : ex. correction du lemme 3" className="flex-1" />
            <Button variant="primary" loading={busy === 'publish'} onClick={() => void publish()}>{busy !== 'publish' ? <FileDown className="size-4" /> : null}Exporter une version</Button>
          </div>
          {versions.length ? (
            <ul className="flex flex-col gap-2">
              {versions.map(v => (
                <li key={v.version} className={cx('rounded-md border px-4 py-3', v === versions[0] ? 'border-amber/40 bg-ink-900' : 'border-ink-750')}>
                  <div className="flex items-center gap-2">
                    <FolderOpen className="size-3.5 text-amber" />
                    <span className="font-mono text-[13px] text-ink-100">v{v.version}</span>
                    {v === versions[0] ? <Badge tone="amber">dernière</Badge> : null}
                    {v.note ? <span className="truncate text-[12px] text-ink-300">{v.note}</span> : null}
                    <span className="ml-auto text-[11px] text-ink-500">{fmtDate(v.createdAt)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {v.files.filter(f => !f.includes('/') || f.endsWith('.lean')).map(f => (
                      <a key={f} href={api.fileUrl(pid, `${v.dir}/${f}`)} target="_blank" rel="noreferrer" className="font-mono text-[11.5px] text-teal hover:text-paper">{f}</a>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </div>
      <NoteDrawer slug={openSlug} onClose={() => setOpenSlug(null)} onNavigate={setOpenSlug} />
    </div>
  )
}
