import type { EvidenceItem, Hypothesis, HypothesisStatus } from '../../shared/types.ts'
import { all, get, run } from '../db/database.ts'
import { bus } from '../core/events.ts'
import { newId, now, safeJsonParse } from '../core/util.ts'

/**
 * Hypothesis ledger (AI co-scientist inspired): every hypothesis carries its
 * evidence for/against, a test plan, a status, and an Elo rating updated by
 * pairwise "tournament" debates between hypotheses.
 */

interface Row {
  id: string
  project_id: string
  statement: string
  rationale: string
  status: string
  elo: number
  matches: number
  evidence: string
  test_plan: string
  created_by: string
  created_at: number
  updated_at: number
}

function fromRow(r: Row): Hypothesis {
  return {
    id: r.id,
    projectId: r.project_id,
    statement: r.statement,
    rationale: r.rationale,
    status: r.status as HypothesisStatus,
    elo: Math.round(r.elo),
    matches: r.matches,
    evidence: safeJsonParse<EvidenceItem[]>(r.evidence, []),
    testPlan: r.test_plan,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export const HYPOTHESIS_STATUSES: HypothesisStatus[] = ['proposed', 'testing', 'supported', 'refuted', 'abandoned']

export function listHypotheses(projectId: string): Hypothesis[] {
  return all<Row>('SELECT * FROM hypotheses WHERE project_id = ? ORDER BY elo DESC, created_at', projectId).map(fromRow)
}

export function getHypothesis(projectId: string, id: string): Hypothesis | undefined {
  const r = get<Row>('SELECT * FROM hypotheses WHERE project_id = ? AND id = ?', projectId, id)
  return r ? fromRow(r) : undefined
}

function publish(h: Hypothesis): Hypothesis {
  bus.publish(h.projectId, { type: 'hypothesis.upserted', hypothesis: h })
  return h
}

export function createHypothesis(projectId: string, input: { statement: string; rationale?: string; testPlan?: string }, createdBy: string): Hypothesis {
  const id = newId('hyp')
  const t = now()
  run(
    'INSERT INTO hypotheses (id, project_id, statement, rationale, status, elo, matches, evidence, test_plan, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1200, 0, ?, ?, ?, ?, ?)',
    id, projectId, input.statement.trim(), input.rationale?.trim() ?? '', 'proposed', '[]', input.testPlan?.trim() ?? '', createdBy, t, t,
  )
  return publish(getHypothesis(projectId, id)!)
}

export function updateHypothesis(
  projectId: string,
  id: string,
  patch: { status?: HypothesisStatus; statement?: string; rationale?: string; testPlan?: string; evidence?: Omit<EvidenceItem, 'at'> },
): Hypothesis {
  const h = getHypothesis(projectId, id)
  if (!h) throw new Error(`Hypothèse introuvable: ${id}`)
  const evidence = patch.evidence ? [...h.evidence, { ...patch.evidence, at: now() }] : h.evidence
  const status = patch.status && HYPOTHESIS_STATUSES.includes(patch.status) ? patch.status : h.status
  run(
    'UPDATE hypotheses SET statement = ?, rationale = ?, status = ?, evidence = ?, test_plan = ?, updated_at = ? WHERE id = ?',
    patch.statement ?? h.statement, patch.rationale ?? h.rationale, status, JSON.stringify(evidence), patch.testPlan ?? h.testPlan, now(), id,
  )
  return publish(getHypothesis(projectId, id)!)
}

export function deleteHypothesis(projectId: string, id: string): void {
  run('DELETE FROM hypotheses WHERE project_id = ? AND id = ?', projectId, id)
}

/** Standard Elo update, K=32. `winner` is 'a', 'b' or 'draw'. */
export function recordMatch(projectId: string, aId: string, bId: string, winner: 'a' | 'b' | 'draw'): void {
  const a = getHypothesis(projectId, aId)
  const b = getHypothesis(projectId, bId)
  if (!a || !b) return
  const ea = 1 / (1 + 10 ** ((b.elo - a.elo) / 400))
  const sa = winner === 'a' ? 1 : winner === 'draw' ? 0.5 : 0
  const K = 32
  const da = K * (sa - ea)
  run('UPDATE hypotheses SET elo = elo + ?, matches = matches + 1, updated_at = ? WHERE id = ?', da, now(), a.id)
  run('UPDATE hypotheses SET elo = elo - ?, matches = matches + 1, updated_at = ? WHERE id = ?', da, now(), b.id)
  publish(getHypothesis(projectId, a.id)!)
  publish(getHypothesis(projectId, b.id)!)
}
