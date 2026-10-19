import fs from 'node:fs'
import path from 'node:path'
import { PROMPTS_DIR } from '../config.ts'

/**
 * Prompts live as Markdown files in server/agents/prompts so they can be
 * tuned without touching code. They are re-read on each use (edits apply live).
 */
export function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8')
}

export function render(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = vars[key]
    return v === undefined ? '' : String(v)
  }).replace(/\n{3,}/g, '\n\n')
}

export function roleInstructions(role: string): string {
  const all = loadPrompt('roles')
  const parts = all.split(/^## /m)
  const section = parts.find(p => p.startsWith(`${role}\n`))
  return section ? section.slice(role.length + 1).trim() : ''
}

export function principles(): string {
  return loadPrompt('_principles')
}

export function today(): string {
  return new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}
