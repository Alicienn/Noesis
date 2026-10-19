import { ChevronRight, Plug, Plus, RefreshCw, Search, Wrench } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpServerConfig, ToolDescriptor } from '@shared/types'
import { api } from '../../lib/api'
import { Badge, Button, Empty, Panel, Spinner, cx } from '../../components/ui'
import { McpServerCard } from './McpServerCard'
import type { McpStatus } from './McpServerCard'
import { Loading, Note, SaveButton, SectionHeader, errorText, toastError, useSettingsDraft } from './shared'

const MCP_PRESETS: Array<{ label: string; blurb: string; server: McpServerConfig }> = [
  { label: 'Système de fichiers', blurb: 'Lire et écrire hors du workspace', server: { name: 'filesystem', enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users'] } },
  { label: 'Fetch', blurb: 'Pages web converties en markdown', server: { name: 'fetch', enabled: true, command: 'uvx', args: ['mcp-server-fetch'] } },
  { label: 'Sequential thinking', blurb: 'Raisonnement pas à pas structuré', server: { name: 'sequential-thinking', enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] } },
  { label: 'Memory', blurb: 'Graphe de connaissances persistant', server: { name: 'memory', enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
]

const CATEGORY_LABEL: Record<string, string> = {
  plan: 'Plan',
  web: 'Web',
  literature: 'Littérature',
  memory: 'Mémoire',
  hypotheses: 'Hypothèses',
  exec: 'Exécution',
  formal: 'Vérification formelle (Lean)',
  files: 'Fichiers',
  agents: 'Agents',
  human: 'Humain',
  report: 'Rapport',
  mcp: 'MCP',
}
const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL)

export function ToolsSection() {
  const { draft, setDraft, save, saving, dirty, loadError } = useSettingsDraft(['mcpServers'] as const)
  const [status, setStatus] = useState<Record<string, McpStatus>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [catalogueVersion, setCatalogueVersion] = useState(0)
  // Stable React keys for the cards (their textareas keep local text state).
  const [uids, setUids] = useState<number[]>([])
  const nextUid = useRef(0)

  useEffect(() => {
    if (draft && uids.length !== draft.mcpServers.length) setUids(draft.mcpServers.map(() => nextUid.current++))
  }, [draft, uids.length])

  const loadStatus = useCallback(() => {
    api.mcpStatus().then(setStatus).catch(() => setStatus({}))
  }, [])
  useEffect(loadStatus, [loadStatus])

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setStatus(await api.mcpRefresh())
      setCatalogueVersion(v => v + 1)
    } catch (error) {
      toastError('Redémarrage MCP impossible', error)
    } finally {
      setRefreshing(false)
    }
  }

  const servers = draft?.mcpServers ?? []
  const setServers = (fn: (s: McpServerConfig[]) => McpServerConfig[]): void => setDraft(d => d && { mcpServers: fn(d.mcpServers) })

  const add = (server: McpServerConfig): void => {
    setServers(s => [...s, server])
    setUids(u => [...u, nextUid.current++])
  }
  const remove = (i: number): void => {
    setServers(s => s.filter((_, j) => j !== i))
    setUids(u => u.filter((_, j) => j !== i))
  }

  const names = servers.map(s => s.name.trim())
  const invalid = names.some((n, i) => !n || names.indexOf(n) !== i)

  const submit = async (): Promise<void> => {
    const cleaned = servers.map(s => ({ ...s, name: s.name.trim() }))
    if (await save({ mcpServers: cleaned }, 'Serveurs MCP enregistrés')) {
      // The server restarts MCP clients asynchronously after a change.
      setRefreshing(true)
      setTimeout(() => {
        loadStatus()
        setCatalogueVersion(v => v + 1)
        setRefreshing(false)
      }, 2500)
    }
  }

  return (
    <>
      <SectionHeader
        kicker="04 · Outils"
        title="Outils & MCP"
        actions={(
          <>
            <Button variant="ghost" onClick={() => void refresh()} loading={refreshing}>{refreshing ? null : <RefreshCw className="size-4" />}Reconnecter</Button>
            <SaveButton dirty={dirty && !invalid} saving={saving} onClick={() => void submit()} />
          </>
        )}
      >
        Branche des serveurs Model Context Protocol pour donner de nouveaux outils aux agents. Leurs outils apparaissent sous le préfixe <span className="font-mono text-ink-200">mcp__nom__</span>.
      </SectionHeader>

      {!draft ? <Loading error={loadError} /> : (
        <div className="flex flex-col gap-5">
          {invalid ? <Note tone="brick">Chaque serveur doit avoir un nom unique et non vide avant d'enregistrer.</Note> : null}

          {servers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-ink-600 bg-ink-900/40">
              <Empty icon={<Plug className="size-7" />} title="Aucun serveur MCP">Les outils intégrés suffisent pour commencer. Ajoute un serveur ci-dessous pour en étendre la panoplie.</Empty>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {servers.map((s, i) => (
                <McpServerCard
                  key={uids[i] ?? `i${i}`}
                  server={s}
                  status={status[s.name.trim()]}
                  duplicate={Boolean(s.name.trim()) && names.indexOf(s.name.trim()) !== i}
                  onChange={next => setServers(list => list.map((x, j) => (j === i ? next : x)))}
                  onRemove={() => remove(i)}
                />
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => add({ name: `serveur-${servers.length + 1}`, enabled: true, command: '', args: [] })}>
              <Plus className="size-4" />Ajouter un serveur
            </Button>
            <span className="kicker ml-2 mr-1">Suggestions</span>
            {MCP_PRESETS.map(p => {
              const taken = names.includes(p.server.name)
              return (
                <button
                  key={p.server.name}
                  type="button"
                  disabled={taken}
                  onClick={() => add(structuredClone(p.server))}
                  title={`${p.blurb} — ${p.server.command} ${p.server.args?.join(' ')}`}
                  className="flex items-center gap-1.5 rounded-full border border-ink-700 px-2.5 py-1 text-[11.5px] text-ink-300 transition-colors hover:border-amber/50 hover:text-amber disabled:cursor-default disabled:opacity-40 disabled:hover:border-ink-700 disabled:hover:text-ink-300 cursor-pointer"
                >
                  <Plus className="size-3" />{p.label}
                </button>
              )
            })}
          </div>
          <p className="-mt-3 text-[11.5px] text-ink-500">Les commandes <span className="font-mono">npx</span> et <span className="font-mono">uvx</span> nécessitent Node.js et uv installés sur cette machine.</p>

          <ToolCatalogue version={catalogueVersion} />
        </div>
      )}
    </>
  )
}

function ToolCatalogue({ version }: { version: number }) {
  const [tools, setTools] = useState<ToolDescriptor[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    api.tools().then(setTools).catch(e => setError(errorText(e)))
  }, [version])

  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const map = new Map<string, ToolDescriptor[]>()
    for (const t of tools ?? []) {
      if (!terms.every(x => `${t.name} ${t.description}`.toLowerCase().includes(x))) continue
      const list = map.get(t.category) ?? []
      list.push(t)
      map.set(t.category, list)
    }
    const rank = (c: string): number => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length)
    return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  }, [tools, query])

  const toggle = (c: string): void => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    return next
  })

  return (
    <Panel
      kicker="Catalogue"
      title={tools ? `${tools.length} outils disponibles` : 'Outils disponibles'}
      bodyClassName="p-0"
      actions={(
        <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-925 px-2.5 focus-within:border-amber/70">
          <Search className="size-3.5 text-ink-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filtrer…" className="h-7 w-44 bg-transparent text-[12.5px] text-ink-100 placeholder:text-ink-500 focus:outline-none" />
        </div>
      )}
    >
      {error ? <div className="p-4"><Note tone="brick">{error}</Note></div> : !tools ? (
        <div className="flex items-center gap-2 p-4 text-[12.5px] text-ink-400"><Spinner className="size-3.5" />Chargement du catalogue…</div>
      ) : groups.length === 0 ? (
        <p className="p-6 text-center text-[12.5px] text-ink-400">Aucun outil ne correspond.</p>
      ) : (
        <div className="divide-y divide-ink-750">
          {groups.map(([cat, list]) => {
            const expanded = open.has(cat) || query.trim() !== ''
            return (
              <div key={cat}>
                <button type="button" onClick={() => toggle(cat)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-ink-850 cursor-pointer">
                  <ChevronRight className={cx('size-3.5 text-ink-500 transition-transform', expanded && 'rotate-90')} />
                  {cat === 'mcp' ? <Plug className="size-3.5 text-teal" /> : <Wrench className="size-3.5 text-ink-500" />}
                  <span className="text-[13px] text-ink-100">{CATEGORY_LABEL[cat] ?? cat}</span>
                  <span className="font-mono text-[10.5px] text-ink-500">{list.length}</span>
                </button>
                {expanded ? (
                  <ul className="flex flex-col gap-px bg-ink-925/60 pb-2">
                    {list.map(t => (
                      <li key={t.name} className="px-4 py-2 pl-11">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12.5px] text-amber/90">{t.name}</span>
                          {t.source === 'mcp' ? <Badge tone="teal">mcp</Badge> : null}
                        </div>
                        <p className="mt-0.5 whitespace-pre-line text-[12px] leading-relaxed text-ink-300">{t.description}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
