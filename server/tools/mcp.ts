import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerConfig } from '../../shared/types.ts'
import { getSettings } from '../settings.ts'
import { errorMessage } from '../core/util.ts'
import type { ToolDef } from './types.ts'

/**
 * Model Context Protocol bridge: any MCP server (stdio or HTTP) configured in
 * Settings becomes a set of tools named `mcp__<server>__<tool>`. This is how
 * Noesis plugs into the existing ecosystem (Lean prover, Wolfram, arXiv MCP,
 * browser automation, databases…) without bespoke code.
 */

interface Connection {
  config: McpServerConfig
  client: Client
  tools: ToolDef[]
  error?: string
}

const connections = new Map<string, Connection>()
const statuses = new Map<string, { connected: boolean; tools: number; error?: string }>()

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}

async function connect(config: McpServerConfig): Promise<Connection> {
  const client = new Client({ name: 'noesis', version: '1.0.0' })
  if (config.url) {
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } }))
    } catch {
      await client.connect(new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } }))
    }
  } else if (config.command) {
    // On Windows, npx/uvx etc. are .cmd shims that must go through cmd.exe
    const needsCmd = process.platform === 'win32' && !/\.(exe|com)$/i.test(config.command) && !/[\\/]/.test(config.command)
    await client.connect(new StdioClientTransport({
      command: needsCmd ? 'cmd.exe' : config.command,
      args: needsCmd ? ['/c', config.command, ...(config.args ?? [])] : config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
      stderr: 'ignore',
    }))
  } else {
    throw new Error('Serveur MCP sans command ni url')
  }
  const listed = await client.listTools()
  const server = sanitize(config.name)
  const tools: ToolDef[] = listed.tools.map(t => ({
    name: `mcp__${server}__${sanitize(t.name)}`.slice(0, 64),
    description: `[MCP ${config.name}] ${t.description ?? t.name}`.slice(0, 1500),
    category: 'mcp',
    parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    sensitive: true,
    execute: async (args, ctx) => {
      const result = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: 600_000 })
      const parts = (result.content as Array<Record<string, any>> | undefined ?? []).map(c => {
        if (c.type === 'text') return c.text as string
        if (c.type === 'resource') return c.resource?.text ?? `[ressource ${c.resource?.uri}]`
        if (c.type === 'image') return `[image ${c.mimeType}]`
        return JSON.stringify(c).slice(0, 2000)
      })
      if (result.structuredContent && !parts.length) parts.push(JSON.stringify(result.structuredContent, null, 2))
      return { content: parts.join('\n') || '(résultat vide)', status: result.isError ? 'error' : 'ok' }
    },
  }))
  return { config, client, tools }
}

/** (Re)connect every enabled server from settings. Failures are recorded, not thrown. */
export async function refreshMcp(): Promise<void> {
  const wanted = getSettings().mcpServers.filter(s => s.enabled)
  for (const [name, conn] of connections) {
    const still = wanted.find(w => w.name === name)
    if (!still || JSON.stringify(still) !== JSON.stringify(conn.config)) {
      await conn.client.close().catch(() => {})
      connections.delete(name)
      statuses.delete(name)
    }
  }
  await Promise.all(wanted.map(async cfg => {
    if (connections.has(cfg.name)) return
    try {
      const conn = await connect(cfg)
      connections.set(cfg.name, conn)
      statuses.set(cfg.name, { connected: true, tools: conn.tools.length })
      console.log(`[mcp] ${cfg.name}: ${conn.tools.length} outils`)
    } catch (error) {
      statuses.set(cfg.name, { connected: false, tools: 0, error: errorMessage(error) })
      console.warn(`[mcp] ${cfg.name}: ${errorMessage(error)}`)
    }
  }))
  for (const s of getSettings().mcpServers.filter(s => !s.enabled)) statuses.set(s.name, { connected: false, tools: 0, error: 'désactivé' })
}

export function mcpTools(): ToolDef[] {
  return [...connections.values()].flatMap(c => c.tools)
}

export function mcpStatus(): Record<string, { connected: boolean; tools: number; error?: string }> {
  return Object.fromEntries(statuses)
}

export async function closeMcp(): Promise<void> {
  await Promise.all([...connections.values()].map(c => c.client.close().catch(() => {})))
  connections.clear()
}
