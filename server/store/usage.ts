import type { TokenTotals } from '../../shared/types.ts'
import { get } from '../db/database.ts'

/** Token totals of a project (or one agent), prefix-cache hits and writes included. */
export function tokenTotals(projectId: string, agentId?: string): TokenTotals {
  const r = get<{ p: number; c: number; h: number; w: number; n: number }>(
    `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c, COALESCE(SUM(cached_tokens),0) AS h,
            COALESCE(SUM(cache_write_tokens),0) AS w, COUNT(*) AS n
     FROM usage WHERE project_id = ? ${agentId ? 'AND agent_id = ?' : ''}`,
    ...(agentId ? [projectId, agentId] : [projectId]),
  )
  return { promptTokens: r?.p ?? 0, completionTokens: r?.c ?? 0, cachedTokens: r?.h ?? 0, cacheWriteTokens: r?.w ?? 0, calls: r?.n ?? 0 }
}
