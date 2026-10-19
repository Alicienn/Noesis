import { CheckCircle2, Download, ExternalLink, Info, RefreshCw, Sigma, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LeanSettings, LeanStatus } from '@shared/types'
import { api } from '../../lib/api'
import { useApp } from '../../store/app'
import { Badge, Button, Field, IconButton, Input, Panel, Toggle } from '../../components/ui'
import { Loading, Note, SaveButton, SectionHeader, errorText, useSettingsDraft } from './shared'

const DEFAULTS: LeanSettings = { enabled: true, distro: 'Ubuntu', workspace: '~/noesis-lean', timeoutSec: 900 }

/**
 * Formal verification: Lean 4 + Mathlib + Comparator, installed once in WSL
 * (≈ 12 GB) and shared by every project.
 */
export function LeanSection() {
  const { draft, setDraft, save, saving, dirty, loadError } = useSettingsDraft(['lean'] as const)
  const toast = useApp(s => s.toast)
  const [status, setStatus] = useState<LeanStatus>()
  const [checking, setChecking] = useState(false)

  const check = (refresh: boolean): void => {
    setChecking(true)
    api.lean(refresh).then(setStatus).catch(() => setStatus(undefined)).finally(() => setChecking(false))
  }
  useEffect(() => check(false), [])

  // follow a running installation
  const installing = Boolean(status?.install?.running)
  useEffect(() => {
    if (!installing) return
    const t = setInterval(() => api.lean().then(setStatus).catch(() => undefined), 4000)
    return () => clearInterval(t)
  }, [installing])
  useEffect(() => {
    if (status?.install && !status.install.running && status.install.finishedAt && Date.now() - status.install.finishedAt < 10_000) {
      toast({ title: status.install.ok ? 'Environnement Lean installé' : 'Installation Lean échouée', body: status.install.ok ? 'Les agents peuvent maintenant formaliser et vérifier des preuves.' : 'Voir le journal.', level: status.install.ok ? 'success' : 'error' })
      check(true)
    }
  }, [status?.install?.running]) // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (): Promise<void> => {
    try {
      setStatus(await api.installLean())
    } catch (error) {
      toast({ title: 'Installation impossible', body: errorText(error), level: 'error' })
    }
  }

  if (!draft) return <Loading error={loadError} />
  const lean = { ...DEFAULTS, ...(draft.lean ?? {}) }
  const set = (patch: Partial<LeanSettings>): void => setDraft(d => d && { lean: { ...DEFAULTS, ...(d.lean ?? {}), ...patch } })

  const parts: Array<[string, boolean | undefined, string | undefined]> = [
    ['Lean 4', Boolean(status?.leanVersion), status?.leanVersion?.replace(/^Lean \(version ([^,]+).*$/, '$1')],
    ['Mathlib précompilée', Boolean(status?.mathlib), status?.mathlib],
    ['Comparator', status?.comparator, undefined],
    ['lean4export', status?.lean4export, undefined],
    ['landrun (bac à sable)', status?.landrun, undefined],
  ]

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader kicker="Vérification formelle" title="Lean 4 · Mathlib · Comparator" actions={<SaveButton dirty={dirty} saving={saving} onClick={() => void save(undefined, 'Réglages Lean enregistrés')} />}>
        Les agents écrivent l'énoncé d'un résultat en Lean (challenge), puis sa preuve (solution). Comparator, le juge utilisé par openai/math, vérifie que la preuve porte exactement sur l'énoncé, sans axiome ajouté, et la fait passer par le noyau Lean. Un résultat accepté atteint le niveau « Prouvé en Lean ».
      </SectionHeader>

      <Panel kicker="Environnement" title="État de l'installation" bodyClassName="flex flex-col gap-4 p-5"
        actions={<IconButton title="Revérifier" onClick={() => check(true)} disabled={checking}><RefreshCw className={checking ? 'size-3.5 animate-spin' : 'size-3.5'} /></IconButton>}
      >
        <div className="flex items-start gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-amber"><Sigma className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {status ? (status.available ? <Badge tone="teal">prêt</Badge> : <Badge tone="amber">{status.error ?? 'indisponible'}</Badge>) : <Badge>…</Badge>}
              {status?.distro ? <span className="font-mono text-[11px] text-ink-500">WSL · {status.distro} · {status.workspace}</span> : null}
              <a href="https://github.com/leanprover/comparator" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-ink-400 hover:text-amber">Comparator<ExternalLink className="size-3" /></a>
            </div>
            <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {parts.map(([label, ok, detail]) => (
                <li key={label} className="flex items-center gap-2 text-[12.5px] text-ink-300">
                  {ok ? <CheckCircle2 className="size-3.5 text-teal" /> : <XCircle className="size-3.5 text-ink-600" />}
                  {label}{detail ? <span className="font-mono text-[11px] text-ink-500">{detail}</span> : null}
                </li>
              ))}
            </ul>
          </div>
          {status && !status.available && !installing ? (
            <Button size="sm" variant="primary" onClick={() => void install()}><Download className="size-3.5" />Installer</Button>
          ) : null}
        </div>
        {status && !status.available && !installing ? (
          <Note icon={<Info className="size-3.5" />}>
            Installation unique, partagée par tous les projets : environ 12 Go dans WSL (toolchain Lean ~3 Go, Mathlib précompilée ~8 Go, outils ~0,6 Go) et 20 à 40 minutes selon la connexion. Aucun mot de passe administrateur n'est demandé. Sous Windows, WSL 2 avec une distribution Ubuntu doit déjà être installé (<span className="font-mono">wsl --install -d Ubuntu</span>).
          </Note>
        ) : null}
        {installing ? <Note tone="amber" icon={<RefreshCw className="size-3.5 animate-spin" />}>Installation en cours — tu peux quitter cette page, elle continue en arrière-plan.</Note> : null}
        {status?.install?.log && (installing || status.install.ok === false) ? (
          <pre className="max-h-64 overflow-auto rounded-md border border-ink-750 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-300">{status.install.log}</pre>
        ) : null}
      </Panel>

      <Panel kicker="Réglages" title="Utilisation par les agents" bodyClassName="flex flex-col gap-4 p-5">
        <Toggle checked={lean.enabled} onChange={v => set({ enabled: v })} label="Proposer les outils Lean aux agents" hint="lean_run, lean_search et lean_check apparaissent quand l'environnement est prêt ET que le projet active la formalisation (Réglages du projet)." />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Distribution WSL" hint="Windows uniquement"><Input value={lean.distro} onChange={e => set({ distro: e.target.value })} /></Field>
          <Field label="Espace Lean partagé" hint="Chemin Linux"><Input value={lean.workspace} onChange={e => set({ workspace: e.target.value })} className="font-mono" /></Field>
          <Field label="Délai max (s)" hint="Par compilation ou vérification"><Input type="number" min={60} value={lean.timeoutSec} onChange={e => set({ timeoutSec: Math.max(60, Number(e.target.value) || 900) })} /></Field>
        </div>
      </Panel>
    </div>
  )
}
