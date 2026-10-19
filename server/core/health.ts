import { bus } from './events.ts'

/**
 * Tool health, per project. Observed failure mode: an outage (search engine
 * blocked, API budget exhausted) makes agents retry the same broken tool
 * dozens of times. This tracker:
 *  - counts consecutive failures per tool,
 *  - opens a "circuit" after repeated failures (the tool is hidden from agents
 *    for a cool-down, then offered again),
 *  - produces a short status block injected into every agent prompt,
 *  - raises one human notification per outage.
 */

interface ToolState {
  calls: number
  failures: number
  consecutive: number
  lastError?: string
  openUntil?: number
  notified?: boolean
}

const OPEN_AFTER = 6
const COOLDOWN_MS = 15 * 60_000
const states = new Map<string, Map<string, ToolState>>()

function stateOf(projectId: string, tool: string): ToolState {
  let p = states.get(projectId)
  if (!p) {
    p = new Map()
    states.set(projectId, p)
  }
  let s = p.get(tool)
  if (!s) {
    s = { calls: 0, failures: 0, consecutive: 0 }
    p.set(tool, s)
  }
  return s
}

/** "Aucun article trouvé" is a legitimate answer, not an outage: only infrastructure errors count. */
export function isInfrastructureError(text: string): boolean {
  return /HTTP (4(0[13]|29)|5\d\d)|bloqué|anti-bot|captcha|budget|limite de débit|rate limit|fetch failed|ECONN|ETIMEDOUT|timeout|indisponible|could not reach|impossible de joindre/i.test(text)
}

/**
 * Tools that run the agent's own code: their failures are the code's (a Lean
 * "deterministic timeout", a Python exception), never an outage to circuit-break.
 */
const CODE_TOOLS = new Set(['python', 'bash', 'lean_run', 'lean_check', 'lean_search'])

export function recordToolOutcome(projectId: string, tool: string, ok: boolean, output: string): void {
  const s = stateOf(projectId, tool)
  s.calls++
  if (ok || CODE_TOOLS.has(tool) || !isInfrastructureError(output)) {
    s.consecutive = 0
    if (s.openUntil) {
      s.openUntil = undefined
      s.notified = false
    }
    return
  }
  s.failures++
  s.consecutive++
  s.lastError = output.replace(/\s+/g, ' ').slice(0, 220)
  if (s.consecutive >= OPEN_AFTER && !s.openUntil) {
    s.openUntil = Date.now() + COOLDOWN_MS
    bus.publish(projectId, { type: 'log', level: 'warn', message: `Outil ${tool} désactivé ${COOLDOWN_MS / 60_000} min après ${s.consecutive} échecs consécutifs : ${s.lastError}` })
  }
}

/** Tool hidden from agents while its circuit is open. */
export function isCircuitOpen(projectId: string, tool: string): boolean {
  const s = states.get(projectId)?.get(tool)
  if (!s?.openUntil) return false
  if (Date.now() > s.openUntil) {
    // half-open: offer it again; one more failure re-opens it immediately
    s.openUntil = undefined
    s.consecutive = OPEN_AFTER - 1
    return false
  }
  return true
}

/** Outages that deserve a human notification (each reported once). */
export function takeNewOutages(projectId: string): Array<{ tool: string; error: string }> {
  const out: Array<{ tool: string; error: string }> = []
  for (const [tool, s] of states.get(projectId) ?? []) {
    if (s.openUntil && !s.notified) {
      s.notified = true
      out.push({ tool, error: s.lastError ?? '' })
    }
  }
  return out
}

/** Short status for prompts: degraded and disabled tools, with the reason. */
export function toolHealthSection(projectId: string): string {
  const lines: string[] = []
  for (const [tool, s] of states.get(projectId) ?? []) {
    if (s.openUntil) lines.push(`- ${tool} : DÉSACTIVÉ temporairement (${s.consecutive} échecs d'infrastructure consécutifs : ${s.lastError}). N'insiste pas, utilise une alternative.`)
    else if (s.consecutive >= 2) lines.push(`- ${tool} : instable (${s.consecutive} échecs consécutifs : ${s.lastError}).`)
  }
  if (!lines.length) return ''
  return `<etat_des_outils>\nIncidents en cours (mis à jour en temps réel) :\n${lines.join('\n')}\nAlternatives : paper_search (OpenAlex, arXiv, Crossref, CORE…), paper_lookup pour un article précis, fetch_url sur une URL connue, request_pdf pour un document inaccessible.\n</etat_des_outils>`
}

export function healthSnapshot(projectId: string): Array<{ tool: string; calls: number; failures: number; consecutive: number; disabled: boolean; lastError?: string }> {
  return [...(states.get(projectId) ?? [])].map(([tool, s]) => ({ tool, calls: s.calls, failures: s.failures, consecutive: s.consecutive, disabled: Boolean(s.openUntil && Date.now() < s.openUntil), lastError: s.lastError }))
}
