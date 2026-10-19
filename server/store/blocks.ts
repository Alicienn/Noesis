import fs from 'node:fs'
import path from 'node:path'
import type { CoreBlock, Project } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { now } from '../core/util.ts'
import { workspaceDir } from '../config.ts'

/**
 * Core memory blocks (Letta/MemGPT style): small, labelled, size-capped texts
 * that are ALWAYS in the lead agent's context and that the agent edits itself.
 * Each block is mirrored to `workspace/memory/<LABEL>.md` so humans and shell
 * tools can read them.
 */
export const BLOCK_DEFS: Array<{ label: string; limit: number; description: string }> = [
  { label: 'mission', limit: 3000, description: 'La question de recherche, les objectifs, les critères de succès et les contraintes. Rarement modifié.' },
  { label: 'plan', limit: 5000, description: 'Plan de recherche courant sous forme de checklist ([ ] / [x]) avec la prochaine action. Mis à jour à chaque étape importante.' },
  { label: 'working', limit: 4000, description: 'Mémoire de travail : focus actuel, raisonnements intermédiaires, pistes ouvertes, ce qu\'il faut ne pas oublier.' },
  { label: 'human', limit: 2000, description: 'Directives, préférences et réponses de l\'humain à respecter.' },
  { label: 'lessons', limit: 2500, description: 'Leçons méthodologiques apprises (ce qui marche, ce qui échoue, pièges). Alimenté par le superviseur et la consolidation.' },
]

interface BlockRow {
  label: string
  value: string
  lim: number
  description: string
  updated_at: number
}

function fromRow(r: BlockRow): CoreBlock {
  return { label: r.label, value: r.value, limit: r.lim, description: r.description, updatedAt: r.updated_at }
}

export function initCoreBlocks(project: Project): void {
  for (const def of BLOCK_DEFS) {
    let value = ''
    if (def.label === 'mission') {
      value = `# Question de recherche\n${project.question}\n\n${project.domain ? `Domaine : ${project.domain}\n\n` : ''}# Critères de succès\n- Réponse argumentée, sourcée et vérifiée\n- Résultats intermédiaires consignés en mémoire\n- Rapport final rédigé dans reports/`
    }
    if (def.label === 'plan') value = '- [ ] Cadrer la question, définir les sous-questions\n- [ ] État de l\'art\n- [ ] Hypothèses et pistes\n- [ ] Investigation / calculs / expériences\n- [ ] Vérification croisée\n- [ ] Rapport final'
    run(
      'INSERT OR IGNORE INTO core_blocks (project_id, label, value, lim, description, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id, def.label, value, def.limit, def.description, now(),
    )
    mirror(project.id, def.label, value)
  }
}

export function listBlocks(projectId: string): CoreBlock[] {
  const order = BLOCK_DEFS.map(d => d.label)
  return all<BlockRow>('SELECT * FROM core_blocks WHERE project_id = ?', projectId)
    .map(fromRow)
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
}

export function getBlock(projectId: string, label: string): CoreBlock | undefined {
  const row = get<BlockRow>('SELECT * FROM core_blocks WHERE project_id = ? AND label = ?', projectId, label)
  return row ? fromRow(row) : undefined
}

export function setBlock(projectId: string, label: string, value: string, opts: { force?: boolean } = {}): CoreBlock {
  const block = getBlock(projectId, label)
  if (!block) throw new Error(`Bloc mémoire inconnu: ${label}. Blocs: ${BLOCK_DEFS.map(d => d.label).join(', ')}`)
  if (!opts.force && value.length > block.limit) {
    throw new Error(`Le bloc « ${label} » est limité à ${block.limit} caractères (reçu ${value.length}). Condense-le ou déplace des détails dans une note (memory_write).`)
  }
  run('UPDATE core_blocks SET value = ?, updated_at = ? WHERE project_id = ? AND label = ?', value, now(), projectId, label)
  mirror(projectId, label, value)
  const updated = getBlock(projectId, label)!
  bus.publish(projectId, { type: 'block.updated', block: updated })
  return updated
}

function mirror(projectId: string, label: string, value: string): void {
  try {
    const file = path.join(workspaceDir(projectId), 'memory', `${label.toUpperCase()}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value, 'utf8')
  } catch {
    // mirror is best-effort
  }
}
