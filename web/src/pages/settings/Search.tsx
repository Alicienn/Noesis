import { AlertTriangle, ArrowDown, ArrowUp, Download, ExternalLink, FileText, Info, Play, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { GlobalSettings, ReaderId, SearchProviderId, SearchSettings } from '@shared/types'
import { api } from '../../lib/api'
import type { MarkitdownStatus } from '../../lib/api'
import { useApp } from '../../store/app'
import { Badge, Button, Field, IconButton, Input, Panel, Toggle } from '../../components/ui'
import { Loading, Note, SaveButton, SecretInput, SectionHeader, errorText, useSettingsDraft } from './shared'

type SecretKey = 'tavilyKey' | 'braveKey' | 'exaKey' | 'serperKey' | 'jinaKey' | 'semanticScholarKey' | 'openAlexKey' | 'coreKey'
const SECRET_KEYS: SecretKey[] = ['tavilyKey', 'braveKey', 'exaKey', 'serperKey', 'jinaKey', 'semanticScholarKey', 'openAlexKey', 'coreKey']

const ENGINES: Record<SearchProviderId, { label: string; blurb: string; field?: 'searxngUrl' | SecretKey }> = {
  searxng: { label: 'SearXNG', blurb: 'Méta-moteur auto-hébergé, sans clé.', field: 'searxngUrl' },
  tavily: { label: 'Tavily', blurb: 'API pensée pour les agents, extraits propres.', field: 'tavilyKey' },
  brave: { label: 'Brave Search', blurb: 'Index indépendant, quota gratuit mensuel.', field: 'braveKey' },
  exa: { label: 'Exa', blurb: 'Recherche neuronale, très bonne sur le contenu technique.', field: 'exaKey' },
  serper: { label: 'Serper', blurb: 'Résultats Google via API.', field: 'serperKey' },
  jina: { label: 'Jina', blurb: 'Recherche + lecture de pages en markdown.', field: 'jinaKey' },
  bing: { label: 'Bing', blurb: 'Sans clé (lecture des résultats publics) — secours fiable mais moins précis qu\'une API.' },
  duckduckgo: { label: 'DuckDuckGo', blurb: 'Sans clé, dernier recours — souvent bloqué (anti-bot).' },
}

const ENGINE_FIELDS: Array<{ key: 'searxngUrl' | SecretKey; label: string; placeholder: string; secret: boolean }> = [
  { key: 'searxngUrl', label: 'URL SearXNG', placeholder: 'http://localhost:8888', secret: false },
  { key: 'tavilyKey', label: 'Clé Tavily', placeholder: 'tvly-…', secret: true },
  { key: 'braveKey', label: 'Clé Brave', placeholder: 'BSA…', secret: true },
  { key: 'exaKey', label: 'Clé Exa', placeholder: '…', secret: true },
  { key: 'serperKey', label: 'Clé Serper', placeholder: '…', secret: true },
  { key: 'jinaKey', label: 'Clé Jina', placeholder: 'jina_…', secret: true },
]

export function SearchSection() {
  const { draft, setDraft, save, saving, dirty, loadError, original } = useSettingsDraft(['search'] as const)
  const [available, setAvailable] = useState<string[]>()

  const refreshHealth = (): void => {
    api.health().then(h => setAvailable(h.searchProviders)).catch(() => setAvailable(undefined))
  }
  useEffect(refreshHealth, [])

  const set = (patch: Partial<SearchSettings>): void => setDraft(d => d && { search: { ...d.search, ...patch } })

  const move = (i: number, delta: -1 | 1): void => {
    if (!draft) return
    const order = [...draft.search.order]
    const j = i + delta
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    set({ order })
  }

  const submit = async (): Promise<void> => {
    if (!draft || !original) return
    // Only send secrets the user actually changed; masked ones are left alone.
    const search: Partial<SearchSettings> = { ...draft.search }
    for (const k of SECRET_KEYS) if (search[k] === original.search[k]) delete search[k]
    if (await save({ search } as Partial<GlobalSettings>, 'Recherche enregistrée')) refreshHealth()
  }

  return (
    <>
      <SectionHeader
        kicker="03 · Recherche"
        title="Recherche & sources"
        actions={<SaveButton dirty={dirty} saving={saving} onClick={() => void submit()} />}
      >
        Les moteurs web sont essayés dans l'ordre : le premier qui répond l'emporte. Les bases académiques (OpenAlex, Crossref, arXiv, Semantic Scholar, CORE, Unpaywall) sont toujours interrogées en direct.
      </SectionHeader>

      {!draft ? <Loading error={loadError} /> : (
        <div className="flex flex-col gap-5">
          <Panel kicker="Ordre de priorité" title="Moteurs web" bodyClassName="p-0">
            <ol className="divide-y divide-ink-750">
              {draft.search.order.map((id, i) => {
                const meta = ENGINES[id]
                const ready = available ? available.includes(id) : !meta.field || Boolean(draft.search[meta.field])
                return (
                  <li key={id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-5 font-mono text-[11px] text-ink-500">{i + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] text-ink-100">{meta.label}</div>
                      <div className="truncate text-[11.5px] text-ink-500">{meta.blurb}</div>
                    </div>
                    {ready ? <Badge tone="teal">actif</Badge> : <Badge>{meta.field === 'searxngUrl' ? 'sans URL' : 'sans clé'}</Badge>}
                    <div className="flex items-center">
                      <IconButton title="Monter" onClick={() => move(i, -1)} disabled={i === 0} className="size-7"><ArrowUp className="size-3.5" /></IconButton>
                      <IconButton title="Descendre" onClick={() => move(i, 1)} disabled={i === draft.search.order.length - 1} className="size-7"><ArrowDown className="size-3.5" /></IconButton>
                    </div>
                  </li>
                )
              })}
            </ol>
          </Panel>

          <ReadersPanel value={draft.search.readers ?? DEFAULT_READERS} onChange={readers => set({ readers })} />

          <Panel kicker="Accès" title="Clés & instances" bodyClassName="flex flex-col gap-4 p-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {ENGINE_FIELDS.map(f => (
                <Field key={f.key} label={f.label}>
                  {f.secret
                    ? <SecretInput value={draft.search[f.key] ?? ''} onChange={v => set({ [f.key]: v })} placeholder={f.placeholder} />
                    : <Input value={draft.search[f.key] ?? ''} onChange={e => set({ [f.key]: e.target.value })} placeholder={f.placeholder} spellCheck={false} className="font-mono text-[12.5px]" />}
                </Field>
              ))}
            </div>
            <Note icon={<Info className="size-3.5" />}>DuckDuckGo ne demande aucune clé mais peut limiter le débit en cas d'usage intensif : ajoute au moins un moteur avec clé pour des recherches soutenues.</Note>
          </Panel>

          <Panel kicker="Littérature scientifique" title="Bases académiques" bodyClassName="flex flex-col gap-4 p-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="E-mail de contact" hint="Donne accès au « polite pool » d'OpenAlex, Crossref et Unpaywall (plus rapide, plus fiable).">
                <Input type="email" value={draft.search.contactEmail ?? ''} onChange={e => set({ contactEmail: e.target.value })} placeholder="toi@exemple.org" />
              </Field>
              <Field label="Clé Semantic Scholar" hint="Sans clé, l'API répond très souvent 429 (trop de requêtes).">
                <SecretInput value={draft.search.semanticScholarKey ?? ''} onChange={v => set({ semanticScholarKey: v })} />
              </Field>
              <Field label="Clé OpenAlex" hint="Facultative ; sans clé, le budget quotidien est réduit.">
                <SecretInput value={draft.search.openAlexKey ?? ''} onChange={v => set({ openAlexKey: v })} />
              </Field>
              <Field label="Clé CORE" hint="Texte intégral de millions d'articles en libre accès.">
                <SecretInput value={draft.search.coreKey ?? ''} onChange={v => set({ coreKey: v })} />
              </Field>
            </div>
          </Panel>

          <DocumentsPanel />

          <SearchTester dirty={dirty} />
        </div>
      )}
    </>
  )
}

/** Conversion of provided documents: Microsoft MarkItDown when installed, built-in extractor otherwise. */
function DocumentsPanel() {
  const toast = useApp(s => s.toast)
  const [status, setStatus] = useState<MarkitdownStatus>()
  const [enabled, setEnabled] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [checking, setChecking] = useState(false)
  const [log, setLog] = useState('')

  const check = (refresh: boolean): void => {
    setChecking(true)
    api.markitdown(refresh).then(setStatus).catch(() => setStatus(undefined)).finally(() => setChecking(false))
  }
  useEffect(() => {
    check(false)
    api.settings().then(s => setEnabled(s.documents?.markitdown !== false)).catch(() => undefined)
  }, [])

  const toggle = async (v: boolean): Promise<void> => {
    setEnabled(v)
    try {
      await api.saveSettings({ documents: { markitdown: v } })
    } catch (error) {
      setEnabled(!v)
      toast({ title: 'Enregistrement impossible', body: (error as Error).message, level: 'error' })
    }
  }

  const install = async (): Promise<void> => {
    setInstalling(true)
    setLog('')
    try {
      const r = await api.installMarkitdown()
      setStatus(r.status)
      setLog(r.ok ? '' : r.log)
      toast({ title: r.ok ? 'MarkItDown installé' : 'Installation échouée', body: r.ok ? `Version ${r.status.version}` : 'Voir le journal ci-dessous.', level: r.ok ? 'success' : 'error' })
    } catch (error) {
      toast({ title: 'Installation impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Panel kicker="Documents fournis" title="Conversion en markdown" bodyClassName="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-amber"><FileText className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] text-ink-100">Microsoft MarkItDown</span>
            {status ? (status.available ? <Badge tone="teal">installé · v{status.version}</Badge> : <Badge tone="amber">{status.error ?? 'indisponible'}</Badge>) : <Badge>…</Badge>}
            <a href="https://github.com/microsoft/markitdown" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-ink-400 hover:text-amber">GitHub<ExternalLink className="size-3" /></a>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
            Utilisé en priorité pour Word, PowerPoint, Excel (y compris .xls), EPUB, HTML, notebooks, e-mails Outlook, archives ZIP et audio (transcription). Les PDF restent extraits page par page par Noesis pour garder les numéros de page dans les citations. Sans MarkItDown, l'extracteur intégré prend le relais.
          </p>
          {status && !status.available ? <p className="mt-1 font-mono text-[11px] text-ink-500">{status.python} -m pip install "markitdown[all]"</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton title="Revérifier" onClick={() => check(true)} disabled={checking}><RefreshCw className={checking ? 'size-3.5 animate-spin' : 'size-3.5'} /></IconButton>
          {status && !status.available ? <Button size="sm" variant="primary" loading={installing} onClick={() => void install()}>{!installing ? <Download className="size-3.5" /> : null}Installer</Button> : null}
        </div>
      </div>
      <Toggle checked={enabled} onChange={v => void toggle(v)} disabled={!status?.available} label="Utiliser MarkItDown quand il est disponible" hint="Désactive pour n'utiliser que l'extracteur intégré (plus rapide, aucune dépendance Python)." />
      {installing ? <Note icon={<Info className="size-3.5" />}>Installation en cours dans {status?.python ?? 'python'} — cela peut prendre quelques minutes (dépendances audio, Office, PDF…).</Note> : null}
      {log ? <pre className="max-h-48 overflow-auto rounded-md border border-brick/40 bg-ink-950 p-3 font-mono text-[11px] text-ink-300">{log}</pre> : null}
    </Panel>
  )
}

type SearchResult = Awaited<ReturnType<typeof api.testSearch>>

const DEFAULT_READERS: ReaderId[] = ['jina', 'defuddle', 'puremd', 'markdown_new']

const READER_META: Record<ReaderId, { label: string; example: string; blurb: string }> = {
  jina: { label: 'Jina Reader', example: 'r.jina.ai/<url>', blurb: 'Le plus rapide ; une clé Jina (champ ci-dessous) augmente le débit.' },
  defuddle: { label: 'Defuddle', example: 'defuddle.md/<url>', blurb: 'Extraction très propre (auteur, titre, corps).' },
  puremd: { label: 'pure.md', example: 'pure.md/<url>', blurb: 'Markdown avec métadonnées, bon sur les pages simples.' },
  markdown_new: { label: 'markdown.new', example: 'markdown.new/<url>', blurb: 'Dernier recours.' },
}

/**
 * Public services that turn any URL into markdown with a real browser: used
 * when the local conversion hits a blocked, empty or JavaScript-only page.
 */
function ReadersPanel({ value, onChange }: { value: ReaderId[]; onChange: (v: ReaderId[]) => void }) {
  const all = [...value, ...DEFAULT_READERS.filter(r => !value.includes(r))]
  const toggle = (id: ReaderId): void => onChange(value.includes(id) ? value.filter(r => r !== id) : all.filter(r => r === id || value.includes(r)))
  const move = (id: ReaderId, delta: -1 | 1): void => {
    const order = [...value]
    const i = order.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    onChange(order)
  }
  return (
    <Panel kicker="Lecture de pages" title="Lecteurs web → markdown" bodyClassName="p-0">
      <ol className="divide-y divide-ink-750">
        {all.map(id => {
          const meta = READER_META[id]
          const on = value.includes(id)
          return (
            <li key={id} className="flex items-center gap-3 px-4 py-2.5">
              <Toggle checked={on} onChange={() => toggle(id)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[13.5px] text-ink-100">{meta.label}<span className="font-mono text-[11px] text-ink-500">{meta.example}</span></div>
                <div className="truncate text-[11.5px] text-ink-500">{meta.blurb}</div>
              </div>
              {on ? (
                <div className="flex items-center">
                  <IconButton title="Monter" onClick={() => move(id, -1)} disabled={value.indexOf(id) === 0} className="size-7"><ArrowUp className="size-3.5" /></IconButton>
                  <IconButton title="Descendre" onClick={() => move(id, 1)} disabled={value.indexOf(id) === value.length - 1} className="size-7"><ArrowDown className="size-3.5" /></IconButton>
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      <div className="border-t border-ink-750 px-4 py-3">
        <Note icon={<Info className="size-3.5" />}>
          Utilisés seulement quand la conversion locale échoue (page bloquée, vide ou rendue en JavaScript), dans cet ordre. Ces services voient les URL consultées : désactive-les tous pour un projet confidentiel. Aucun ne contourne les paywalls ni les protections type Cloudflare des éditeurs.
        </Note>
      </div>
    </Panel>
  )
}

function SearchTester({ dirty }: { dirty: boolean }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SearchResult>()
  const [error, setError] = useState<string>()

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try {
      setResult(await api.testSearch(query.trim()))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel kicker="Diagnostic" title="Tester la recherche" bodyClassName="flex flex-col gap-3 p-5">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void run() }}>
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="quantum error correction surface code threshold" />
        <Button type="submit" variant="subtle" loading={busy}>{busy ? null : <Play className="size-3.5" />}Tester</Button>
      </form>
      {dirty ? <p className="text-[11.5px] text-amber/80">Modifications non enregistrées : le test utilise la configuration enregistrée.</p> : null}
      {error ? <Note tone="brick" icon={<AlertTriangle className="size-3.5" />}>{error}</Note> : null}
      {result ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12px] text-ink-400">
            {result.results.length
              ? <>Réponse de <Badge tone="teal">{ENGINES[result.provider as SearchProviderId]?.label ?? result.provider}</Badge> · {result.results.length} résultat{result.results.length > 1 ? 's' : ''}</>
              : <span className="text-brick">Aucun moteur n'a renvoyé de résultat.</span>}
          </div>
          {result.errors.map((e, i) => <Note key={i} tone="brick" icon={<AlertTriangle className="size-3.5" />}>{e}</Note>)}
          {result.results.length === 0 ? null : <ul className="flex flex-col divide-y divide-ink-750 rounded-lg border border-ink-750 bg-ink-925/60">
            {result.results.map(r => (
              <li key={r.url} className="px-3 py-2">
                <a href={r.url} target="_blank" rel="noreferrer" className="group flex items-center gap-1.5 text-[13px] text-ink-100 hover:text-amber">
                  <span className="truncate">{r.title || r.url}</span>
                  <ExternalLink className="size-3 shrink-0 text-ink-500 group-hover:text-amber" />
                </a>
                <div className="truncate font-mono text-[10.5px] text-ink-500">{r.url}</div>
                {r.snippet ? <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-300">{r.snippet}</p> : null}
              </li>
            ))}
          </ul>}
        </div>
      ) : null}
    </Panel>
  )
}
