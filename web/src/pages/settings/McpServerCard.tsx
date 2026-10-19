import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { McpServerConfig } from '@shared/types'
import { Badge, Field, IconButton, Input, Tabs, Textarea, Toggle, cx } from '../../components/ui'

export interface McpStatus { connected: boolean; tools: number; error?: string }

type Transport = 'stdio' | 'http'

/** One argument per line, or a single space-separated line ("quoted parts" kept together). */
export function parseArgs(text: string): string[] {
  if (text.includes('\n')) return text.split('\n').map(s => s.trim()).filter(Boolean)
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2])
}

/** `KEY=VALUE` or `Name: value` lines → record (split on the first separator). */
export function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const seps = [line.indexOf('='), line.indexOf(':')].filter(i => i > 0)
    if (seps.length === 0) continue
    const at = Math.min(...seps)
    const key = line.slice(0, at).trim()
    if (key) out[key] = line.slice(at + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

const fmtKv = (r: Record<string, string> | undefined, sep: string): string => Object.entries(r ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n')

export function McpServerCard({ server, status, duplicate, onChange, onRemove }: {
  server: McpServerConfig
  status?: McpStatus
  duplicate: boolean
  onChange: (s: McpServerConfig) => void
  onRemove: () => void
}) {
  const [transport, setTransport] = useState<Transport>(server.url !== undefined && !server.command ? 'http' : 'stdio')
  const [argsText, setArgsText] = useState((server.args ?? []).join('\n'))
  const [envText, setEnvText] = useState(fmtKv(server.env, '='))
  const [headersText, setHeadersText] = useState(fmtKv(server.headers, ': '))

  const base = { name: server.name, enabled: server.enabled }
  const build = (t: Transport, p: { command?: string; url?: string; args?: string; env?: string; headers?: string } = {}): McpServerConfig =>
    t === 'stdio'
      ? { ...base, command: p.command ?? server.command ?? '', args: parseArgs(p.args ?? argsText), env: parseKv(p.env ?? envText) }
      : { ...base, url: p.url ?? server.url ?? '', headers: parseKv(p.headers ?? headersText) }

  const switchTransport = (t: Transport): void => {
    setTransport(t)
    onChange(build(t))
  }

  return (
    <article className={cx('rounded-xl border bg-ink-900 p-4 transition-colors', server.enabled ? 'border-ink-750' : 'border-ink-750/60 opacity-75')}>
      <div className="flex flex-wrap items-center gap-3">
        <Toggle checked={server.enabled} onChange={enabled => onChange({ ...server, enabled })} />
        <Input
          value={server.name}
          onChange={e => onChange({ ...server, name: e.target.value })}
          placeholder="nom"
          spellCheck={false}
          className={cx('h-8 max-w-[220px] font-mono text-[12.5px]', (duplicate || !server.name.trim()) && '!border-brick/60')}
        />
        <StatusBadge status={status} enabled={server.enabled} />
        <div className="ml-auto flex items-center gap-2">
          <Tabs<Transport> value={transport} onChange={switchTransport} items={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }]} />
          <IconButton title="Supprimer ce serveur" onClick={onRemove} className="hover:!text-brick"><Trash2 className="size-3.5" /></IconButton>
        </div>
      </div>
      {duplicate ? <p className="mt-1.5 text-[11.5px] text-brick">Ce nom est déjà utilisé par un autre serveur.</p> : null}
      {status?.error && server.enabled ? <p className="mt-2 break-words rounded-md bg-brick-soft px-2.5 py-1.5 font-mono text-[11px] text-brick">{status.error}</p> : null}

      {transport === 'stdio' ? (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="flex flex-col gap-3">
            <Field label="Commande">
              <Input value={server.command ?? ''} onChange={e => onChange(build('stdio', { command: e.target.value }))} placeholder="npx" spellCheck={false} className="font-mono text-[12.5px]" />
            </Field>
            <Field label="Variables d'environnement" hint="Une par ligne : CLE=valeur">
              <Textarea rows={3} value={envText} onChange={e => { setEnvText(e.target.value); onChange(build('stdio', { env: e.target.value })) }} placeholder="API_KEY=…" spellCheck={false} className="font-mono text-[12px]" />
            </Field>
          </div>
          <Field label="Arguments" hint="Un par ligne, ou sur une seule ligne séparés par des espaces.">
            <Textarea rows={6} value={argsText} onChange={e => { setArgsText(e.target.value); onChange(build('stdio', { args: e.target.value })) }} placeholder={'-y\n@modelcontextprotocol/server-…'} spellCheck={false} className="font-mono text-[12px]" />
          </Field>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="URL (streamable HTTP)">
            <Input value={server.url ?? ''} onChange={e => onChange(build('http', { url: e.target.value }))} placeholder="http://localhost:3333/mcp" spellCheck={false} className="font-mono text-[12.5px]" />
          </Field>
          <Field label="En-têtes" hint="Un par ligne : Nom: valeur">
            <Textarea rows={3} value={headersText} onChange={e => { setHeadersText(e.target.value); onChange(build('http', { headers: e.target.value })) }} placeholder="Authorization: Bearer …" spellCheck={false} className="font-mono text-[12px]" />
          </Field>
        </div>
      )}
    </article>
  )
}

function StatusBadge({ status, enabled }: { status?: McpStatus; enabled: boolean }) {
  if (!enabled) return <Badge>désactivé</Badge>
  if (!status) return <Badge title="Enregistre pour démarrer le serveur">non démarré</Badge>
  if (status.connected) return <Badge tone="teal">connecté · {status.tools} outil{status.tools > 1 ? 's' : ''}</Badge>
  return <Badge tone="brick">{status.error ? 'erreur' : 'déconnecté'}</Badge>
}
