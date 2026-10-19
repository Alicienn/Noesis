import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { HOST, PORT, WEB_DIST, DATA_DIR } from './config.ts'
import './db/database.ts'
import { all, run } from './db/database.ts'
import { startNotifier } from './services/notify.ts'
import { startOrchestratorHooks } from './agents/orchestrator.ts'
import { refreshMcp, closeMcp } from './tools/mcp.ts'
import { globalRoutes } from './routes/global.ts'
import { projectRoutes } from './routes/projects.ts'
import { detectShell } from './services/shell.ts'
import { warmLeanStatus } from './services/lean.ts'

const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 })

/**
 * The API can execute code on this machine, so only the local UI may call it:
 *  - Origin must be a localhost origin (blocks cross-site requests / CSRF),
 *  - Host must be a local name (blocks DNS-rebinding attacks).
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const isLocalOrigin = (origin: string): boolean => {
  try {
    return LOCAL_HOST.test(new URL(origin).host)
  } catch {
    return false
  }
}
app.addHook('onRequest', async (req, reply) => {
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return reply.code(403).send({ error: 'Hôte non autorisé' })
  }
  const origin = req.headers.origin
  if (origin && !isLocalOrigin(origin) && process.env.NOESIS_ALLOW_ORIGIN !== origin) {
    return reply.code(403).send({ error: 'Origine non autorisée' })
  }
})
await app.register(cors, { origin: (origin, cb) => cb(null, !origin || isLocalOrigin(origin) || origin === process.env.NOESIS_ALLOW_ORIGIN) })
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })

app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
  console.error('[api]', error)
  reply.code(error.statusCode ?? 500).send({ error: error.message })
})

await app.register(globalRoutes)
await app.register(projectRoutes)

// Production: serve the built SPA
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  // wildcard routing resolves files at request time, so a rebuild needs no restart
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' })
  app.setNotFoundHandler((req, reply) => {
    // only client-side routes fall back to the SPA; a missing file (stale asset hash) is a real 404
    if (req.url.startsWith('/api/') || /\.[a-z0-9]{2,5}(\?|$)/i.test(req.url)) return reply.code(404).send({ error: 'Not found' })
    return reply.sendFile('index.html')
  })
}

// Crash recovery: nothing can be running at boot.
run("UPDATE projects SET status = 'paused' WHERE status IN ('running', 'waiting_human')")
run("UPDATE agents SET status = CASE WHEN role IN ('lead','supervisor','librarian') THEN 'idle' ELSE 'stopped' END WHERE status IN ('thinking','tool','waiting')")
run("UPDATE tool_runs SET status = 'error', result = COALESCE(result, 'Interrompu (redémarrage du serveur)') WHERE status IN ('running','waiting_approval')")
const stale = all<{ id: string }>("SELECT id FROM requests WHERE status = 'pending' AND blocking = 1 AND kind = 'approval'")
for (const r of stale) run("UPDATE requests SET status = 'dismissed', response = 'Expirée (redémarrage)' WHERE id = ?", r.id)

startNotifier()
startOrchestratorHooks()
void refreshMcp()
warmLeanStatus()

await app.listen({ port: PORT, host: HOST })
const shell = detectShell()
console.log(`\n  ◆ Noesis — harnais de recherche autonome`)
console.log(`  API      http://${HOST}:${PORT}/api`)
console.log(`  Données  ${DATA_DIR}`)
console.log(`  Shell    ${shell.kind} (${shell.path})\n`)

const shutdown = async (): Promise<void> => {
  await closeMcp()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
