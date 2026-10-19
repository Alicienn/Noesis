import { all } from '../db/database.ts'
import { healthSnapshot } from '../core/health.ts'
import { academicStatus } from '../services/academic.ts'
import { listNotes } from '../memory/notes.ts'
import { listHypotheses } from '../store/hypotheses.ts'
import { listSources } from '../store/sources.ts'
import { allTools } from '../tools/registry.ts'

export interface Diagnostics {
  tools: Array<{ tool: string; calls: number; errors: number; avgMs: number; roles: Record<string, number>; lastError?: string }>
  unused: string[]
  health: ReturnType<typeof healthSnapshot>
  academic: ReturnType<typeof academicStatus>
  tokensByRole: Array<{ role: string; calls: number; promptTokens: number; completionTokens: number; cachedTokens: number }>
  repeated: Array<{ agent: string; tool: string; args: string; count: number }>
  verdicts: { supported: number; refuted: number; uncertain: number; refutedActive: Array<{ slug: string; title: string }> }
  agents: { byRole: Record<string, number>; exhausted: number }
  warnings: Array<{ level: 'warn' | 'info'; text: string }>
}

/**
 * Turns the raw run (tool runs, usage, notes) into the findings a human would
 * extract by reading transcripts: failing tools, waste, ignored refutations.
 */
export function diagnostics(projectId: string): Diagnostics {
  const runs = all<{ tool: string; role: string; status: string; duration_ms: number | null; result: string | null; agent_id: string; args: string }>(
    'SELECT r.tool, a.role, r.status, r.duration_ms, substr(r.result, 1, 200) AS result, r.agent_id, r.args FROM tool_runs r JOIN agents a ON a.id = r.agent_id WHERE r.project_id = ?',
    projectId,
  )
  const byTool = new Map<string, Diagnostics['tools'][number] & { ms: number }>()
  for (const r of runs) {
    const t = byTool.get(r.tool) ?? { tool: r.tool, calls: 0, errors: 0, avgMs: 0, ms: 0, roles: {} }
    t.calls++
    t.ms += r.duration_ms ?? 0
    t.roles[r.role] = (t.roles[r.role] ?? 0) + 1
    if (r.status !== 'ok') {
      t.errors++
      t.lastError = r.result?.replace(/\s+/g, ' ').slice(0, 180) ?? t.lastError
    }
    byTool.set(r.tool, t)
  }
  const tools = [...byTool.values()].map(({ ms, ...t }) => ({ ...t, avgMs: Math.round(ms / Math.max(1, t.calls)) })).sort((a, b) => b.calls - a.calls)
  const used = new Set(tools.map(t => t.tool))
  const unused = allTools().filter(t => t.category !== 'mcp' && !used.has(t.name)).map(t => t.name)

  const tokensByRole = all<{ role: string; calls: number; promptTokens: number; completionTokens: number; cachedTokens: number }>(
    `SELECT COALESCE(a.role, CASE WHEN u.agent_id LIKE '%compaction%' THEN 'compaction' ELSE u.agent_id END) AS role, COUNT(*) AS calls,
            SUM(u.prompt_tokens) AS promptTokens, SUM(u.completion_tokens) AS completionTokens, SUM(u.cached_tokens) AS cachedTokens
     FROM usage u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.project_id = ? GROUP BY role ORDER BY promptTokens DESC`,
    projectId,
  )

  const rep = new Map<string, { agent: string; tool: string; args: string; count: number }>()
  for (const r of runs) {
    const key = `${r.agent_id}|${r.tool}|${r.args}`
    const e = rep.get(key) ?? { agent: r.agent_id, tool: r.tool, args: r.args.slice(0, 160), count: 0 }
    e.count++
    rep.set(key, e)
  }
  const repeated = [...rep.values()].filter(e => e.count > 1).sort((a, b) => b.count - a.count).slice(0, 15)

  const notes = listNotes(projectId, { includeInactive: true, limit: 5000 })
  const verified = notes.filter(n => n.verification && n.verification.verdict !== 'pending')
  const refutedActive = notes.filter(n => n.status === 'active' && n.verification?.verdict === 'refuted').map(n => ({ slug: n.slug, title: n.title }))
  const verdicts = {
    supported: verified.filter(n => n.verification!.verdict === 'supported').length,
    refuted: verified.filter(n => n.verification!.verdict === 'refuted').length,
    uncertain: verified.filter(n => n.verification!.verdict === 'uncertain').length,
    refutedActive,
  }

  const agentRows = all<{ role: string; steps: number }>("SELECT role, steps FROM agents WHERE project_id = ? AND role NOT IN ('lead','supervisor','librarian')", projectId)
  const byRole: Record<string, number> = {}
  for (const a of agentRows) byRole[a.role] = (byRole[a.role] ?? 0) + 1
  const exhausted = agentRows.filter(a => a.steps >= 20).length

  // ── human-readable findings ──
  const warnings: Diagnostics['warnings'] = []
  for (const t of tools) {
    const rate = t.errors / t.calls
    if (t.calls >= 5 && rate >= 0.5) warnings.push({ level: 'warn', text: `${t.tool} échoue dans ${Math.round(rate * 100)} % des cas (${t.errors}/${t.calls}). Dernière erreur : ${t.lastError ?? '?'}` })
  }
  const web = byTool.get('web_search')
  if (web && web.errors / web.calls > 0.5) warnings.push({ level: 'warn', text: 'La recherche web est inutilisable : ajoute une clé (Tavily, Brave, Exa, Serper) ou une instance SearXNG dans Paramètres → Recherche.' })
  for (const a of academicStatus()) warnings.push({ level: 'warn', text: `Base ${a.backend} en pause (${a.reason}). ${a.backend === 'openalex' ? 'Une clé OpenAlex gratuite lève la limite.' : a.backend === 'semantic_scholar' ? 'Une clé Semantic Scholar gratuite lève la limite.' : ''}` })
  const total = tokensByRole.reduce((n, r) => n + r.promptTokens, 0)
  const verifierShare = (tokensByRole.find(r => r.role === 'verifier')?.promptTokens ?? 0) / Math.max(1, total)
  const cached = tokensByRole.reduce((n, r) => n + (r.cachedTokens ?? 0), 0)
  // only meaningful once the provider reports cache hits at all (DeepSeek, OpenAI, Anthropic do)
  if (cached > 0 && total > 200_000 && cached / total < 0.5) warnings.push({ level: 'info', text: `Seulement ${Math.round((cached / total) * 100)} % des tokens d'entrée viennent du cache du fournisseur : le début du prompt change trop souvent d'un appel à l'autre, chaque étape coûte plein tarif.` })
  if (verifierShare > 0.5) warnings.push({ level: 'warn', text: `Les vérifications consomment ${Math.round(verifierShare * 100)} % des tokens. Réserve l'auto-vérification aux résultats centraux (désactivable dans Réglages du projet).` })
  if (refutedActive.length) warnings.push({ level: 'warn', text: `${refutedActive.length} note(s) réfutée(s) toujours active(s) : le chercheur principal ne les a pas encore corrigées ni invalidées.` })
  if (exhausted >= 3) warnings.push({ level: 'info', text: `${exhausted} sous-agents ont épuisé leur budget d'étapes : missions trop larges, ou outils en échec.` })
  const junk = listSources(projectId).filter(s => /^(403|404|just a moment|page not found|wayback|google scholar)/i.test(s.title))
  if (junk.length) warnings.push({ level: 'info', text: `${junk.length} source(s) sont des pages d'erreur enregistrées par erreur (${junk.slice(0, 3).map(s => s.citationKey).join(', ')}) : supprime-les depuis l'onglet Sources.` })
  const hyps = listHypotheses(projectId)
  if (hyps.length && hyps.every(h => h.evidence.length === 0)) warnings.push({ level: 'info', text: 'Aucune hypothèse n\'a reçu de preuve (hypothesis_update jamais utilisé).' })
  for (const u of ['paper_citations', 'paper_lookup', 'request_pdf']) {
    if (unused.includes(u) && runs.length > 50) warnings.push({ level: 'info', text: `Outil utile jamais utilisé : ${u}.` })
  }
  for (const r of repeated.filter(r => r.count >= 3).slice(0, 3)) warnings.push({ level: 'info', text: `${r.agent} a appelé ${r.tool} ${r.count}× avec les mêmes arguments.` })

  return { tools, unused, health: healthSnapshot(projectId), academic: academicStatus(), tokensByRole, repeated, verdicts, agents: { byRole, exhausted }, warnings }
}
