import { AlertTriangle, Info, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { Diagnostics } from '../../lib/api'
import { fmtDuration, fmtTokens } from '../../lib/format'
import { useProject } from '../../store/project'
import { Badge, Empty, IconButton, Spinner, cx } from '../../components/ui'

/** Automated run analysis: failing tools, waste, ignored refutations, unused tools. */
export function DiagnosticsView({ onNote }: { onNote?: (slug: string) => void }) {
  const id = useProject(s => s.id)!
  const [data, setData] = useState<Diagnostics | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      setData(await api.diagnostics(id))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [id])

  if (!data) return <div className="flex h-full items-center justify-center"><Spinner className="size-5 text-amber" /></div>
  const totalTokens = data.tokensByRole.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0)

  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <header className="flex items-center justify-between">
          <div>
            <div className="kicker">Analyse automatique de la session</div>
            <h2 className="display mt-1 text-[22px] text-paper">Diagnostic</h2>
          </div>
          <IconButton title="Rafraîchir" onClick={() => void load()}>{loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}</IconButton>
        </header>

        <section className="rounded-lg border border-ink-750 bg-ink-900/90">
          <div className="kicker border-b border-ink-750 px-4 py-2">Constats</div>
          {data.warnings.length ? (
            <ul className="divide-y divide-ink-800">
              {data.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2.5 px-4 py-2.5 text-[13px] leading-snug text-ink-200">
                  {w.level === 'warn' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" /> : <Info className="mt-0.5 size-4 shrink-0 text-sky" />}
                  {w.text}
                </li>
              ))}
            </ul>
          ) : <Empty title="Rien à signaler">Aucun problème détecté dans cette session.</Empty>}
        </section>

        {data.verdicts.refutedActive.length ? (
          <section className="rounded-lg border border-brick/30 bg-ink-900/90 px-4 py-3">
            <div className="kicker !text-brick">Notes réfutées encore actives</div>
            <ul className="mt-2 flex flex-col gap-1">
              {data.verdicts.refutedActive.map(n => (
                <li key={n.slug}><button onClick={() => onNote?.(n.slug)} className="text-left text-[13px] text-ink-200 hover:text-amber cursor-pointer">[[{n.slug}]] {n.title}</button></li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-lg border border-ink-750 bg-ink-900/90 px-4 py-3">
            <div className="kicker">Tokens par rôle</div>
            <ul className="mt-2.5 flex flex-col gap-2">
              {data.tokensByRole.map(r => {
                const t = r.promptTokens + r.completionTokens
                return (
                  <li key={r.role}>
                    <div className="flex items-baseline justify-between text-[12.5px]"><span className="text-ink-200">{r.role}</span><span className="font-mono text-ink-400">{fmtTokens(t)} · {r.calls} appels · {Math.round((t / Math.max(1, totalTokens)) * 100)} %{r.cachedTokens ? <span className="text-teal"> · cache {Math.round((r.cachedTokens / Math.max(1, r.promptTokens)) * 100)} %</span> : null}</span></div>
                    <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-ink-800">
                      <div className="h-full bg-teal" style={{ width: `${((r.cachedTokens ?? 0) / Math.max(1, totalTokens)) * 100}%` }} />
                      <div className="h-full bg-amber" style={{ width: `${((t - (r.cachedTokens ?? 0)) / Math.max(1, totalTokens)) * 100}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
          <section className="rounded-lg border border-ink-750 bg-ink-900/90 px-4 py-3">
            <div className="kicker">Vérifications & équipe</div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Badge tone="teal">{data.verdicts.supported} vérifiées</Badge>
              <Badge tone="brick">{data.verdicts.refuted} réfutées</Badge>
              <Badge tone="amber">{data.verdicts.uncertain} incertaines</Badge>
            </div>
            <p className="mt-3 text-[12.5px] text-ink-300">Sous-agents : {Object.entries(data.agents.byRole).map(([r, n]) => `${r} ×${n}`).join(', ') || 'aucun'} · {data.agents.exhausted} à court de budget</p>
            {data.academic.length ? <p className="mt-2 text-[12.5px] text-amber">Bases en pause : {data.academic.map(a => `${a.backend} (${a.minutesLeft} min)`).join(', ')}</p> : null}
            {data.health.some(h => h.disabled) ? <p className="mt-1 text-[12.5px] text-brick">Outils désactivés : {data.health.filter(h => h.disabled).map(h => h.tool).join(', ')}</p> : null}
          </section>
        </div>

        <section className="overflow-hidden rounded-lg border border-ink-750 bg-ink-900/90">
          <div className="kicker border-b border-ink-750 px-4 py-2">Outils</div>
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-[11px] uppercase tracking-wide text-ink-500">
              <tr><th className="px-4 py-2 font-medium">Outil</th><th className="px-2 font-medium">Appels</th><th className="px-2 font-medium">Échecs</th><th className="px-2 font-medium">Durée moy.</th><th className="px-4 font-medium">Par rôle</th></tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {data.tools.map(t => {
                const rate = t.errors / t.calls
                return (
                  <tr key={t.tool} title={t.lastError}>
                    <td className="px-4 py-1.5 font-mono text-ink-100">{t.tool}</td>
                    <td className="px-2 font-mono text-ink-300">{t.calls}</td>
                    <td className={cx('px-2 font-mono', rate >= 0.5 ? 'text-brick' : rate >= 0.2 ? 'text-amber' : 'text-ink-400')}>{t.errors}{t.errors ? ` (${Math.round(rate * 100)} %)` : ''}</td>
                    <td className="px-2 font-mono text-ink-400">{fmtDuration(t.avgMs)}</td>
                    <td className="px-4 text-ink-400">{Object.entries(t.roles).map(([r, n]) => `${r} ${n}`).join(' · ')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {data.unused.length ? <p className="border-t border-ink-750 px-4 py-2 text-[12px] text-ink-400">Jamais utilisés : {data.unused.join(', ')}</p> : null}
        </section>
      </div>
    </div>
  )
}
