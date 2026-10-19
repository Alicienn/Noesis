import type { LeanCheck, LeanCheckStatus } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { newId, now, safeJsonParse } from '../core/util.ts'

/** Comparator runs (statement + proof), kept for the note drawer and formalization.yaml. */

interface Row {
  id: string
  project_id: string
  note_slug: string | null
  challenge_file: string
  solution_file: string
  theorems: string
  definitions: string
  permitted_axioms: string
  status: string
  output: string
  duration_ms: number | null
  created_by: string
  created_at: number
}

function fromRow(r: Row): LeanCheck {
  return {
    id: r.id,
    projectId: r.project_id,
    noteSlug: r.note_slug ?? undefined,
    challengeFile: r.challenge_file,
    solutionFile: r.solution_file,
    theorems: safeJsonParse(r.theorems, []),
    definitions: safeJsonParse(r.definitions, []),
    permittedAxioms: safeJsonParse(r.permitted_axioms, []),
    status: r.status as LeanCheckStatus,
    output: r.output,
    durationMs: r.duration_ms ?? undefined,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}

export function newCheckId(): string {
  return newId('lean')
}

export function createCheck(c: Omit<LeanCheck, 'createdAt' | 'output' | 'status'> & { status?: LeanCheckStatus }): LeanCheck {
  run(
    `INSERT INTO lean_checks (id, project_id, note_slug, challenge_file, solution_file, theorems, definitions, permitted_axioms, status, output, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
    c.id, c.projectId, c.noteSlug ?? null, c.challengeFile, c.solutionFile, JSON.stringify(c.theorems), JSON.stringify(c.definitions),
    JSON.stringify(c.permittedAxioms), c.status ?? 'running', c.createdBy, now(),
  )
  const check = getCheck(c.id)!
  bus.publish(c.projectId, { type: 'lean.check', check })
  return check
}

export function finishCheck(id: string, status: LeanCheckStatus, output: string, durationMs: number): LeanCheck | undefined {
  run('UPDATE lean_checks SET status = ?, output = ?, duration_ms = ? WHERE id = ?', status, output.slice(-20_000), durationMs, id)
  const check = getCheck(id)
  if (check) bus.publish(check.projectId, { type: 'lean.check', check })
  return check
}

export function getCheck(id: string): LeanCheck | undefined {
  const r = get<Row>('SELECT * FROM lean_checks WHERE id = ?', id)
  return r ? fromRow(r) : undefined
}

export function listChecks(projectId: string, noteSlug?: string): LeanCheck[] {
  const rows = noteSlug
    ? all<Row>('SELECT * FROM lean_checks WHERE project_id = ? AND note_slug = ? ORDER BY created_at DESC', projectId, noteSlug)
    : all<Row>('SELECT * FROM lean_checks WHERE project_id = ? ORDER BY created_at DESC', projectId)
  return rows.map(fromRow)
}
