import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const ROOT_DIR = path.resolve(here, '..')
export const DATA_DIR = path.resolve(process.env.NOESIS_DATA_DIR ?? path.join(ROOT_DIR, 'data'))
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects')
export const DB_PATH = path.join(DATA_DIR, 'noesis.db')
export const WEB_DIST = path.join(ROOT_DIR, 'dist')
export const PROMPTS_DIR = path.join(ROOT_DIR, 'server', 'agents', 'prompts')

export const PORT = Number(process.env.NOESIS_PORT ?? 4317)
export const HOST = process.env.NOESIS_HOST ?? '127.0.0.1'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(PROJECTS_DIR, { recursive: true })

/** Root folder of a project: workspace (agent files), sources (PDFs), memory mirror. */
export function projectDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId)
}

export function workspaceDir(projectId: string): string {
  return path.join(projectDir(projectId), 'workspace')
}

export function ensureProjectDirs(projectId: string): void {
  const ws = workspaceDir(projectId)
  for (const sub of ['', 'memory', 'memory/notes', 'memory/episodes', 'sources', 'reports', 'scratch', 'artifacts']) {
    fs.mkdirSync(path.join(ws, sub), { recursive: true })
  }
}
