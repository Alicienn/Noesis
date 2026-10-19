import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectStats } from '@shared/types'
import { fmtTokens } from '../lib/format'
import { useProject } from '../store/project'
import { cx } from './ui'

/**
 * Live token telemetry: totals refreshed after every LLM call (any agent), a
 * running estimate of what is streaming right now, and the prefix-cache share
 * — the part of the input the provider served from its cache at a fraction of
 * the price.
 */

/** ~3.6 characters per token: same heuristic as the server's context budget. */
const CHARS_PER_TOKEN = 3.6

const prefersReducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Eases a number towards its target so changes read as motion, not flicker. */
function useTweened(target: number, ms = 650): number {
  const [value, setValue] = useState(target)
  const from = useRef(target)
  const shown = useRef(target)
  useEffect(() => {
    if (prefersReducedMotion() || Math.abs(target - shown.current) < 1) {
      shown.current = target
      setValue(target)
      return
    }
    from.current = shown.current
    const start = performance.now()
    let raf = 0
    const tick = (t: number): void => {
      const k = Math.min(1, (t - start) / ms)
      const eased = 1 - (1 - k) ** 4
      shown.current = from.current + (target - from.current) * eased
      setValue(shown.current)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return value
}

/** Output tokens currently being streamed by every live agent (estimate, reconciled at the end of each call). */
function useStreamingTokens(): number {
  const live = useProject(s => s.live)
  return useMemo(() => {
    let chars = 0
    for (const l of Object.values(live)) {
      chars += l.text.length + l.reasoning.length
      for (const c of l.toolCalls) chars += c.args.length
    }
    return Math.round(chars / CHARS_PER_TOKEN)
  }, [live])
}

export interface TokenBreakdown {
  input: number
  output: number
  cached: number
  written: number
  fresh: number
  calls: number
  hit: number | null
}

export function breakdown(stats?: ProjectStats): TokenBreakdown {
  const input = stats?.promptTokens ?? 0
  const output = stats?.completionTokens ?? 0
  const cached = Math.min(input, stats?.cachedTokens ?? 0)
  const written = Math.min(input - cached, stats?.cacheWriteTokens ?? 0)
  return { input, output, cached, written, fresh: Math.max(0, input - cached - written), calls: stats?.calls ?? 0, hit: input > 0 && cached > 0 ? cached / input : null }
}

export function TokenMeter() {
  const stats = useProject(s => s.project?.stats)
  const streaming = useStreamingTokens()
  const b = breakdown(stats)
  const total = useTweened(b.input + b.output + streaming)
  const [pulse, setPulse] = useState(false)
  const last = useRef(b.calls)

  // a short glow each time a call lands, so a refresh is noticed without staring at digits
  useEffect(() => {
    if (b.calls === last.current) return
    last.current = b.calls
    setPulse(true)
    const t = window.setTimeout(() => setPulse(false), 700)
    return () => window.clearTimeout(t)
  }, [b.calls])

  const sum = Math.max(1, b.input + b.output + streaming)
  const segments = [
    { key: 'cached', value: b.cached, className: 'bg-teal', label: 'Entrée lue depuis le cache' },
    { key: 'written', value: b.written, className: 'bg-sky', label: 'Entrée écrite en cache' },
    { key: 'fresh', value: b.fresh, className: 'bg-amber', label: 'Entrée plein tarif' },
    { key: 'output', value: b.output, className: 'bg-ink-200', label: 'Sortie générée' },
    { key: 'live', value: streaming, className: 'bg-ink-200/40 animate-pulse-soft', label: 'En cours (estimation)' },
  ]

  return (
    <div className="group/meter relative flex flex-col gap-1.5 outline-none" tabIndex={0} aria-label={`Tokens consommés : ${fmtTokens(b.input + b.output)}`}>
      <div className="flex items-baseline gap-2">
        <span className={cx('font-mono text-[15px] leading-none tabular-nums text-paper transition-[text-shadow] duration-500', pulse && '[text-shadow:0_0_14px_#f2b54499]')}>{fmtTokens(total)}</span>
        {streaming > 0 ? <span className="font-mono text-[10.5px] leading-none text-amber/90 tabular-nums">+{fmtTokens(streaming)}</span> : null}
        <span className={cx('ml-auto font-mono text-[10.5px] leading-none tabular-nums', b.hit === null ? 'text-ink-500' : b.hit >= 0.6 ? 'text-teal' : b.hit >= 0.3 ? 'text-amber' : 'text-brick')} title="Part de l'entrée servie depuis le cache du fournisseur">
          {b.hit === null ? 'cache —' : `cache ${Math.round(b.hit * 100)} %`}
        </span>
      </div>
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-ink-800">
        {segments.map(s => (s.value > 0 ? <div key={s.key} className={cx('h-full transition-[width] duration-700 ease-out first:rounded-l-full last:rounded-r-full', s.className)} style={{ width: `${(s.value / sum) * 100}%` }} /> : null))}
      </div>

      <div className="pointer-events-none invisible absolute right-0 top-[calc(100%+12px)] z-50 w-[300px] translate-y-1 rounded-2xl border border-ink-700 bg-ink-875 p-4 opacity-0 shadow-[0_24px_60px_-20px_#000] transition-all duration-200 group-hover/meter:visible group-hover/meter:translate-y-0 group-hover/meter:opacity-100 group-focus/meter:visible group-focus/meter:translate-y-0 group-focus/meter:opacity-100">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-paper">Consommation de la session</span>
          <span className="font-mono text-[11px] text-ink-400">{b.calls} appel{b.calls > 1 ? 's' : ''}</span>
        </div>
        <dl className="mt-3 flex flex-col gap-1.5 text-[12px]">
          <Row label="Entrée totale" value={b.input} strong />
          {segments.slice(0, 3).map(s => <Row key={s.key} label={s.label} value={s.value} dot={s.className} indent />)}
          <Row label="Sortie générée" value={b.output} dot="bg-ink-200" strong />
          {streaming > 0 ? <Row label="En cours (estimation)" value={streaming} dot="bg-ink-200/40" /> : null}
        </dl>
        <p className="mt-3 border-t border-ink-750 pt-2.5 text-[11.5px] leading-relaxed text-ink-400">
          {b.hit === null
            ? b.input > 0
              ? 'Aucun token servi depuis le cache pour l\'instant : soit le fournisseur ne le renvoie pas, soit le début du prompt change à chaque appel.'
              : 'Mis à jour après chaque appel au modèle, tous agents confondus.'
            : `${Math.round(b.hit * 100)} % de l'entrée a été servie depuis le cache du fournisseur, facturée bien moins cher. Mis à jour après chaque appel, tous agents confondus.`}
        </p>
      </div>
    </div>
  )
}

function Row({ label, value, dot, strong, indent }: { label: string; value: number; dot?: string; strong?: boolean; indent?: boolean }) {
  return (
    <div className={cx('flex items-center gap-2', indent && 'pl-3')}>
      {dot ? <span className={cx('size-2 shrink-0 rounded-full', dot)} /> : null}
      <dt className={cx('flex-1', strong ? 'text-ink-100' : 'text-ink-300')}>{label}</dt>
      <dd className={cx('font-mono tabular-nums', strong ? 'text-paper' : 'text-ink-200')}>{value.toLocaleString('fr-FR')}</dd>
    </div>
  )
}
