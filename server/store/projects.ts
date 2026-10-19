import fs from 'node:fs'
import type { Project, ProjectConfig, ProjectStats, ProjectStatus } from '../../shared/types.ts'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { tokenTotals } from './usage.ts'
import { bus } from '../core/events.ts'
import { newId, now, safeJsonParse } from '../core/util.ts'
import { ensureProjectDirs, projectDir } from '../config.ts'
import { getSettings } from '../settings.ts'
import { initCoreBlocks } from './blocks.ts'

interface ProjectRow {
  id: string
  title: string
  question: string
  domain: string
  status: string
  config: string
  created_at: number
  updated_at: number
}

function fromRow(r: ProjectRow): Project {
  return {
    id: r.id,
    title: r.title,
    question: r.question,
    domain: r.domain,
    status: r.status as ProjectStatus,
    config: { ...DEFAULT_PROJECT_CONFIG, ...safeJsonParse<Partial<ProjectConfig>>(r.config, {}) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function projectStats(id: string): ProjectStats {
  const n = (sql: string): number => (get<{ n: number }>(sql, id)?.n ?? 0)
  const usage = tokenTotals(id)
  return {
    steps: n("SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND role = 'assistant'"),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    calls: usage.calls,
    notes: n("SELECT COUNT(*) AS n FROM notes WHERE project_id = ? AND status = 'active'"),
    sources: n('SELECT COUNT(*) AS n FROM sources WHERE project_id = ?'),
    hypotheses: n('SELECT COUNT(*) AS n FROM hypotheses WHERE project_id = ?'),
    pendingRequests: n("SELECT COUNT(*) AS n FROM requests WHERE project_id = ? AND status = 'pending'"),
    agentsRunning: n("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status IN ('thinking','tool','waiting')"),
  }
}

export function listProjects(): Project[] {
  return all<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC').map(r => ({ ...fromRow(r), stats: projectStats(r.id) }))
}

export function getProject(id: string): Project | undefined {
  const row = get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
  return row ? fromRow(row) : undefined
}

export function requireProject(id: string): Project {
  const p = getProject(id)
  if (!p) throw new Error(`Projet introuvable: ${id}`)
  return p
}

export function createProject(input: { title: string; question: string; domain?: string; config?: Partial<ProjectConfig> }): Project {
  const id = newId('prj')
  const config: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, ...getSettings().defaults, ...(input.config ?? {}) }
  const t = now()
  run(
    'INSERT INTO projects (id, title, question, domain, status, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, input.title.trim() || 'Nouveau projet', input.question.trim(), input.domain?.trim() ?? '', 'idle', JSON.stringify(config), t, t,
  )
  ensureProjectDirs(id)
  const project = requireProject(id)
  initCoreBlocks(project)
  publishProject(id)
  return project
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'title' | 'question' | 'domain' | 'status'>> & { config?: Partial<ProjectConfig> }): Project {
  const p = requireProject(id)
  const config = patch.config ? { ...p.config, ...patch.config } : p.config
  run(
    'UPDATE projects SET title = ?, question = ?, domain = ?, status = ?, config = ?, updated_at = ? WHERE id = ?',
    patch.title ?? p.title, patch.question ?? p.question, patch.domain ?? p.domain, patch.status ?? p.status, JSON.stringify(config), now(), id,
  )
  return publishProject(id)
}

export function setProjectStatus(id: string, status: ProjectStatus): void {
  const p = getProject(id)
  if (!p || p.status === status) return
  run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', status, now(), id)
  publishProject(id)
}

export function touchProject(id: string): void {
  run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), id)
}

export function publishProject(id: string): Project {
  const project = { ...requireProject(id), stats: projectStats(id) }
  bus.publish(id, { type: 'project.updated', project })
  bus.publish('*', { type: 'project.updated', project })
  return project
}

export function deleteProject(id: string): void {
  run('DELETE FROM projects WHERE id = ?', id)
  run('DELETE FROM notes_fts WHERE project_id = ?', id)
  run('DELETE FROM chunks_fts WHERE project_id = ?', id)
  run('DELETE FROM usage WHERE project_id = ?', id)
  fs.rmSync(projectDir(id), { recursive: true, force: true })
}
