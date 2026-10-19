import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { FileEntry, HypothesisStatus, NoteType, ProjectConfig, ProjectSnapshot } from '../../shared/types.ts'
import { all } from '../db/database.ts'
import { errorMessage } from '../core/util.ts'
import { workspaceDir } from '../config.ts'
import { orchestrator } from '../agents/orchestrator.ts'
import { cancelToolRun } from '../agents/runner.ts'
import { createNote, deleteNote, getNote, listEpisodes, listNotes, searchNotes, setHumanReview, supersedeNote, updateNote } from '../memory/notes.ts'
import { listChecks } from '../store/leanChecks.ts'
import { exportPublication, listPublications } from '../agents/publication.ts'
import { listBlocks, setBlock } from '../store/blocks.ts'
import { agentMessages, agentUsage, listAgents, listBus, listToolRuns } from '../store/conversation.ts'
import { createHypothesis, deleteHypothesis, listHypotheses, updateHypothesis } from '../store/hypotheses.ts'
import { createProject, deleteProject, getProject, listProjects, projectStats, publishProject, updateProject } from '../store/projects.ts'
import { getRequest, listRequests, resolveRequest } from '../store/requests.ts'
import { attachPdf, deleteSource, getSource, listSources, readSourceText, setSourceStatus, upsertSource } from '../store/sources.ts'
import { acquirePdf } from '../tools/builtin/research.ts'
import { ingestProvidedFile, inputsDir } from '../store/documents.ts'
import type { IngestResult } from '../store/documents.ts'
import { crossrefByDoi, mergePapers, openAlexByDoi, searchArxiv } from '../services/academic.ts'
import type { Paper } from '../services/academic.ts'
import { resolveModel } from '../llm/providers.ts'
import { effectiveModels } from '../settings.ts'
import { sseHandler } from './sse.ts'
import { diagnostics } from './diagnostics.ts'

type P = { Params: { id: string } }

function notFound(reply: FastifyReply, what = 'Projet'): FastifyReply {
  return reply.code(404).send({ error: `${what} introuvable` })
}

function safePath(projectId: string, rel: string): string {
  const ws = workspaceDir(projectId)
  const abs = path.resolve(ws, rel || '.')
  if (path.relative(ws, abs).startsWith('..')) throw new Error('Chemin hors du workspace')
  return abs
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.py': 'text/plain; charset=utf-8',
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async () => listProjects())

  app.post<{ Body: { title: string; question: string; domain?: string; config?: Partial<ProjectConfig>; start?: boolean } }>('/api/projects', async (req, reply) => {
    if (!req.body.question?.trim()) return reply.code(400).send({ error: 'La question de recherche est requise' })
    const project = createProject(req.body)
    if (req.body.start) {
      try {
        orchestrator.start(project.id)
      } catch {
        // error already surfaced through status + notification
      }
    }
    return project
  })

  app.get<P>('/api/projects/:id', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return notFound(reply)
    const lead = orchestrator.ensureLead(project)
    const models = effectiveModels(project.config)
    const leadModel = resolveModel(models.lead.model)
    const lastUsage = all<{ prompt_tokens: number }>('SELECT prompt_tokens FROM usage WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', lead.id)[0]
    const snapshot: ProjectSnapshot = {
      project: { ...project, stats: projectStats(project.id) },
      agents: listAgents(project.id),
      blocks: listBlocks(project.id),
      messages: agentMessages(lead.id, 600),
      toolRuns: listToolRuns(project.id, 600),
      bus: listBus(project.id),
      requests: listRequests(project.id),
      contextTokens: lastUsage?.prompt_tokens ?? 0,
      contextWindow: leadModel?.contextWindow ?? 0,
    }
    return snapshot
  })

  app.patch<P & { Body: { title?: string; question?: string; domain?: string; config?: Partial<ProjectConfig> } }>('/api/projects/:id', async (req, reply) => {
    if (!getProject(req.params.id)) return notFound(reply)
    const p = updateProject(req.params.id, req.body)
    if (req.body.question) {
      // keep the mission block in sync with the question
      const mission = listBlocks(p.id).find(b => b.label === 'mission')
      if (mission && !mission.value.includes(req.body.question)) setBlock(p.id, 'mission', `# Question de recherche\n${req.body.question}\n\n${mission.value.replace(/^# Question de recherche\n[\s\S]*?\n\n/, '')}`, { force: true })
    }
    return p
  })

  app.delete<P>('/api/projects/:id', async req => {
    orchestrator.stop(req.params.id)
    deleteProject(req.params.id)
    return { ok: true }
  })

  // ── run control ──
  app.post<P>('/api/projects/:id/start', async (req, reply) => {
    try {
      orchestrator.start(req.params.id)
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.post<P>('/api/projects/:id/pause', async req => {
    orchestrator.stop(req.params.id, 'paused')
    return { ok: true }
  })
  app.post<P & { Body: { content: string } }>('/api/projects/:id/message', async (req, reply) => {
    if (!req.body.content?.trim()) return reply.code(400).send({ error: 'Message vide' })
    try {
      orchestrator.sendHuman(req.params.id, req.body.content.trim())
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.post<P>('/api/projects/:id/supervise', async (req, reply) => {
    try {
      await orchestrator.supervise(req.params.id, undefined, 'Demande manuelle de l\'humain')
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.post<P>('/api/projects/:id/consolidate', async req => ({ result: await orchestrator.consolidate(req.params.id) }))

  app.get<P>('/api/projects/:id/events', (req, reply) => sseHandler(req, reply, req.params.id))

  /** Stop one running action; the agent receives an "interrupted" result and continues. */
  app.post<{ Params: { rid: string } }>('/api/tool-runs/:rid/cancel', async (req, reply) => {
    if (!cancelToolRun(req.params.rid)) return reply.code(404).send({ error: 'Action introuvable ou déjà terminée' })
    return { ok: true }
  })

  // ── agents ──
  app.get<P & { Params: { agentId: string } }>('/api/projects/:id/agents/:agentId/messages', async req => ({
    messages: agentMessages(req.params.agentId, 1000),
    usage: agentUsage(req.params.agentId),
  }))

  /** Automated run analysis: what went wrong, what is wasted, what is under-used. */
  app.get<P>('/api/projects/:id/diagnostics', async req => diagnostics(req.params.id))

  app.get<P>('/api/projects/:id/usage', async req => all(
    'SELECT agent_id AS agentId, model, SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens, SUM(cached_tokens) AS cachedTokens, SUM(cache_write_tokens) AS cacheWriteTokens, COUNT(*) AS calls FROM usage WHERE project_id = ? GROUP BY agent_id, model ORDER BY promptTokens DESC',
    req.params.id,
  ))

  // ── memory ──
  app.get<P & { Querystring: { type?: string; q?: string; all?: string } }>('/api/projects/:id/notes', async req => {
    if (req.query.q) return (await searchNotes(req.params.id, req.query.q, { limit: 50, includeInactive: req.query.all === '1' })).map(h => h.note)
    return listNotes(req.params.id, { type: req.query.type as NoteType | undefined, includeInactive: req.query.all === '1' })
  })
  app.get<P & { Params: { slug: string } }>('/api/projects/:id/notes/:slug', async (req, reply) => getNote(req.params.id, req.params.slug) ?? notFound(reply, 'Note'))
  app.post<P & { Body: { title: string; content: string; type?: NoteType; tags?: string[]; importance?: number; confidence?: number; links?: string[] } }>('/api/projects/:id/notes', async req => createNote(req.params.id, req.body, 'human'))
  app.patch<P & { Params: { slug: string }; Body: Record<string, any> }>('/api/projects/:id/notes/:slug', async req => {
    if (req.body.supersede) return supersedeNote(req.params.id, req.params.slug, req.body.by, req.body.reason ?? 'invalidée par l\'humain')
    return updateNote(req.params.id, req.params.slug, req.body)
  })
  app.delete<P & { Params: { slug: string } }>('/api/projects/:id/notes/:slug', async req => {
    deleteNote(req.params.id, req.params.slug)
    return { ok: true }
  })
  /** Human review of a result, or of the faithfulness of its Lean statement. */
  app.post<P & { Params: { slug: string }; Body: { verdict: 'approved' | 'rejected'; target?: 'result' | 'lean_statement'; comment?: string } }>('/api/projects/:id/notes/:slug/review', async (req, reply) => {
    if (!['approved', 'rejected'].includes(req.body.verdict)) return reply.code(400).send({ error: 'verdict : approved ou rejected' })
    try {
      const note = setHumanReview(req.params.id, req.params.slug, { verdict: req.body.verdict, target: req.body.target === 'lean_statement' ? 'lean_statement' : 'result', comment: req.body.comment?.trim() ?? '' })
      if (orchestrator.isRunning(req.params.id)) {
        orchestrator.sendHuman(req.params.id, `J'ai ${req.body.verdict === 'approved' ? 'approuvé' : 'REJETÉ'} ${req.body.target === 'lean_statement' ? "l'énoncé Lean de" : ''} [[${note.slug}]]${req.body.comment ? ` : ${req.body.comment}` : '.'}`)
      }
      return note
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) })
    }
  })

  // ── formal verification & publication ──
  app.get<P & { Querystring: { note?: string } }>('/api/projects/:id/lean-checks', async req => listChecks(req.params.id, req.query.note || undefined))
  app.post<P>('/api/projects/:id/reasoning-summary', async (req, reply) => {
    try {
      return { file: await orchestrator.reasoningSummary(req.params.id) }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.get<P>('/api/projects/:id/publications', async req => listPublications(req.params.id))
  app.post<P & { Body: { note?: string } }>('/api/projects/:id/publications', async (req, reply) => {
    const project = getProject(req.params.id)
    if (!project) return notFound(reply)
    try {
      return exportPublication(project, { note: req.body?.note?.trim() || undefined })
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.get<P>('/api/projects/:id/episodes', async req => listEpisodes(req.params.id))
  app.get<P>('/api/projects/:id/blocks', async req => listBlocks(req.params.id))
  app.put<P & { Params: { label: string }; Body: { value: string } }>('/api/projects/:id/blocks/:label', async (req, reply) => {
    try {
      return setBlock(req.params.id, req.params.label, req.body.value)
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  app.get<P>('/api/projects/:id/graph', async req => {
    const notes = listNotes(req.params.id, { includeInactive: true })
    const sources = listSources(req.params.id)
    const nodes = [
      ...notes.map(n => ({ id: n.slug, label: n.title, kind: 'note', type: n.type, importance: n.importance, status: n.status, verdict: n.verification?.verdict })),
      ...sources.map(s => ({ id: `src:${s.citationKey}`, label: s.title, kind: 'source', type: s.kind, importance: 2, status: s.status })),
    ]
    const ids = new Set(nodes.map(n => n.id))
    const links: Array<{ source: string; target: string; kind: string }> = []
    const seen = new Set<string>()
    for (const n of notes) {
      for (const l of n.links) {
        const key = [n.slug, l].sort().join('|')
        if (ids.has(l) && !seen.has(key)) {
          seen.add(key)
          links.push({ source: n.slug, target: l, kind: 'link' })
        }
      }
      for (const s of n.sourceIds) if (ids.has(`src:${s}`)) links.push({ source: n.slug, target: `src:${s}`, kind: 'cites' })
      if (n.supersededBy && ids.has(n.supersededBy)) links.push({ source: n.slug, target: n.supersededBy, kind: 'superseded' })
    }
    return { nodes, links }
  })

  // ── hypotheses ──
  app.get<P>('/api/projects/:id/hypotheses', async req => listHypotheses(req.params.id))
  app.post<P & { Body: { statement: string; rationale?: string; testPlan?: string } }>('/api/projects/:id/hypotheses', async req => createHypothesis(req.params.id, req.body, 'human'))
  app.patch<P & { Params: { hid: string }; Body: { status?: HypothesisStatus; statement?: string; rationale?: string; testPlan?: string } }>('/api/projects/:id/hypotheses/:hid', async req => updateHypothesis(req.params.id, req.params.hid, req.body))
  app.delete<P & { Params: { hid: string } }>('/api/projects/:id/hypotheses/:hid', async req => {
    deleteHypothesis(req.params.id, req.params.hid)
    return { ok: true }
  })

  // ── sources ──
  app.get<P>('/api/projects/:id/sources', async req => listSources(req.params.id))
  app.post<P & { Body: { doi?: string; arxivId?: string; url?: string; title?: string; fetchPdf?: boolean } }>('/api/projects/:id/sources', async (req, reply) => {
    try {
      const { doi, arxivId, url, title } = req.body
      let paper: Paper | undefined
      if (arxivId) paper = (await searchArxiv('', 1, { idList: [arxivId.replace(/^arxiv:/i, '')] }))[0]
      if (!paper && doi) paper = mergePapers([await openAlexByDoi(doi).catch(() => undefined), await crossrefByDoi(doi).catch(() => undefined)].filter(Boolean) as Paper[])[0]
      const source = upsertSource(req.params.id, paper
        ? { kind: 'paper', title: paper.title, authors: paper.authors, year: paper.year, venue: paper.venue, doi: paper.doi, arxivId: paper.arxivId, url: paper.url, pdfUrl: paper.pdfUrl, abstract: paper.abstract, citations: paper.citations }
        : { kind: url ? 'web' : 'paper', title: title || url || doi || 'Sans titre', url, doi })
      if (req.body.fetchPdf !== false && (paper || url)) {
        const project = getProject(req.params.id)!
        await acquirePdf({ project, signal: AbortSignal.timeout(120_000) }, source).catch(() => undefined)
      }
      return getSource(req.params.id, source.id)
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  /** Upload a PDF (from the human). Optionally fulfils a request and/or targets an existing source. */
  app.post<P>('/api/projects/:id/sources/upload', async (req, reply) => {
    const projectId = req.params.id
    try {
      const parts = req.parts()
      let buffer: Buffer | undefined
      let filename = 'document.pdf'
      const fields: Record<string, string> = {}
      for await (const part of parts) {
        if (part.type === 'file') {
          buffer = await part.toBuffer()
          filename = part.filename || filename
        } else {
          fields[part.fieldname] = String(part.value)
        }
      }
      if (!buffer) return reply.code(400).send({ error: 'Aucun fichier' })
      const request = fields.requestId ? getRequest(fields.requestId) : undefined
      let source = fields.sourceId ? getSource(projectId, fields.sourceId) : request?.sourceId ? getSource(projectId, request.sourceId) : undefined
      if (!source) source = upsertSource(projectId, { kind: 'pdf', title: fields.title || filename.replace(/\.pdf$/i, '') })
      const updated = await attachPdf(projectId, source.id, new Uint8Array(buffer))
      if (request && request.status === 'pending') {
        const resolved = resolveRequest(request.id, `PDF fourni (${filename}) → ${updated.citationKey}, ${updated.pages ?? '?'} pages`)
        orchestrator.onRequestResolved(resolved)
      }
      return updated
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  /**
   * Documents provided by the human as input context (any format, any number).
   * Files are streamed to disk — no size limit beyond the disk — then extracted and indexed.
   */
  app.post<P>('/api/projects/:id/documents', async (req, reply) => {
    const projectId = req.params.id
    if (!getProject(projectId)) return notFound(reply)
    const results: Array<IngestResult & { filename: string }> = []
    const errors: Array<{ filename: string; error: string }> = []
    try {
      for await (const part of req.parts({ limits: { fileSize: Number.MAX_SAFE_INTEGER, files: Number.MAX_SAFE_INTEGER } })) {
        if (part.type !== 'file') continue
        const filename = part.filename || 'document'
        const tmp = path.join(inputsDir(projectId), `.upload-${crypto.randomUUID()}`)
        const hash = crypto.createHash('sha256')
        let size = 0
        try {
          const meter = new Transform({
            transform(chunk: Buffer, _enc, done) {
              hash.update(chunk)
              size += chunk.length
              done(null, chunk)
            },
          })
          await pipeline(part.file, meter, fs.createWriteStream(tmp))
          if (size === 0) throw new Error('Fichier vide')
          results.push({ filename, ...await ingestProvidedFile(projectId, { filename, tmpPath: tmp, hash: hash.digest('hex'), size }) })
        } catch (error) {
          fs.rmSync(tmp, { force: true })
          errors.push({ filename, error: errorMessage(error) })
        }
      }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
    const added = results.filter(r => !r.duplicate).map(r => r.source)
    if (added.length) orchestrator.onDocumentsProvided(projectId, added)
    if (!results.length && errors.length) return reply.code(400).send({ error: errors.map(e => `${e.filename} : ${e.error}`).join(' · '), errors })
    return { documents: results.map(r => ({ filename: r.filename, duplicate: r.duplicate, format: r.format, source: r.source })), errors }
  })

  app.post<P & { Params: { sid: string } }>('/api/projects/:id/sources/:sid/fetch', async (req, reply) => {
    const s = getSource(req.params.id, req.params.sid)
    if (!s) return notFound(reply, 'Source')
    const r = await acquirePdf({ project: getProject(req.params.id)!, signal: AbortSignal.timeout(120_000) }, s)
    return { ok: r.ok, message: r.message, source: r.source }
  })
  app.get<P & { Params: { sid: string } }>('/api/projects/:id/sources/:sid/text', async (req, reply) => {
    try {
      return readSourceText(req.params.id, req.params.sid)
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) })
    }
  })
  app.get<P & { Params: { sid: string } }>('/api/projects/:id/sources/:sid/pdf', async (req, reply) => {
    const s = getSource(req.params.id, req.params.sid)
    if (!s) return notFound(reply, 'Source')
    let file = path.join(workspaceDir(req.params.id), 'sources', `${s.citationKey}.pdf`)
    // a PDF provided by the human is kept once, in inputs/
    if (!fs.existsSync(file) && s.file?.toLowerCase().endsWith('.pdf')) file = path.join(workspaceDir(req.params.id), s.file)
    if (!fs.existsSync(file)) return notFound(reply, 'PDF')
    reply.header('content-type', 'application/pdf')
    return reply.send(fs.createReadStream(file))
  })
  app.delete<P & { Params: { sid: string } }>('/api/projects/:id/sources/:sid', async req => {
    deleteSource(req.params.id, req.params.sid)
    return { ok: true }
  })
  app.post<P & { Params: { sid: string } }>('/api/projects/:id/sources/:sid/unavailable', async req => {
    setSourceStatus(req.params.id, req.params.sid, 'failed', 'Indisponible (humain)')
    return { ok: true }
  })

  // ── human requests ──
  app.get<P>('/api/projects/:id/requests', async req => listRequests(req.params.id))
  app.post<{ Params: { rid: string }; Body: { response?: string; status?: 'resolved' | 'dismissed' } }>('/api/requests/:rid/resolve', async (req, reply) => {
    try {
      const r = resolveRequest(req.params.rid, req.body.response ?? '', req.body.status ?? 'resolved')
      if (r.kind === 'pdf' && r.sourceId && r.status === 'dismissed') setSourceStatus(r.projectId, r.sourceId, 'failed', 'L\'humain n\'a pas pu fournir le document')
      orchestrator.onRequestResolved(r)
      publishProject(r.projectId)
      return r
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })

  // ── workspace files ──
  app.get<P & { Querystring: { path?: string } }>('/api/projects/:id/files', async (req, reply) => {
    try {
      const abs = safePath(req.params.id, req.query.path ?? '')
      if (!fs.existsSync(abs)) return []
      const entries: FileEntry[] = fs.readdirSync(abs, { withFileTypes: true }).map(e => {
        const full = path.join(abs, e.name)
        const st = fs.statSync(full)
        return { path: path.relative(workspaceDir(req.params.id), full).replace(/\\/g, '/'), name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtimeMs }
      })
      return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.get<P & { Querystring: { path: string } }>('/api/projects/:id/files/raw', async (req, reply) => {
    try {
      const abs = safePath(req.params.id, req.query.path)
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return notFound(reply, 'Fichier')
      reply.header('content-type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream')
      return reply.send(fs.createReadStream(abs))
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
  app.put<P & { Body: { path: string; content: string } }>('/api/projects/:id/files', async (req, reply) => {
    try {
      const abs = safePath(req.params.id, req.body.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, req.body.content, 'utf8')
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) })
    }
  })
}
