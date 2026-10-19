import { ASSURANCE_LABELS } from '../../../shared/types.ts'
import { all, ftsQuery } from '../../db/database.ts'
import { assuranceRank, assuranceText, createNote, getNote, recordAssurance } from '../../memory/notes.ts'
import { getProject } from '../../store/projects.ts'
import { argBool, argNum, argStr, S } from '../types.ts'
import type { ToolDef } from '../types.ts'

/**
 * Results build on earlier results (as in openai/math, where later manuscripts
 * reuse earlier ones): search the verified results of the OTHER projects of this
 * lab, and import one as a fact with its provenance and verification level.
 */
export const priorTools: ToolDef[] = [
  {
    name: 'prior_results',
    category: 'memory',
    description: 'Cherche dans les résultats VÉRIFIÉS des autres projets de ce laboratoire (niveau ≥ « relu par le vérificateur »), pour réutiliser un résultat déjà établi au lieu de le refaire. Avec import=true et project + slug, copie le résultat dans la mémoire de ce projet (note « fact » avec provenance et niveau d\'origine).',
    parameters: S.obj({
      query: S.str('Mots-clés (recherche plein texte)'),
      min_level: S.enum(['reviewed', 'computed', 'formal'], 'Niveau minimal (défaut reviewed)'),
      limit: S.int('Nombre max de résultats (défaut 8)'),
      import: S.bool('Importer le résultat désigné par project + slug'),
      project: S.str('Id du projet d\'origine (pour import)'),
      slug: S.str('Slug de la note d\'origine (pour import)'),
    }),
    parallel: true,
    execute: async (args, ctx) => {
      if (argBool(args, 'import', false)) {
        const fromProject = getProject(argStr(args, 'project'))
        if (!fromProject || fromProject.id === ctx.project.id) throw new Error('project : id d\'un AUTRE projet du laboratoire requis')
        const src = getNote(fromProject.id, argStr(args, 'slug'))
        if (!src || src.status !== 'active') throw new Error('Note d\'origine introuvable ou invalidée')
        const level = src.assurance?.level ?? 'claimed'
        const note = createNote(ctx.project.id, {
          title: src.title,
          type: 'fact',
          content: `${src.content}\n\n---\n**Importé** du projet « ${fromProject.title} » (\`${fromProject.id}\`, [[${src.slug}]]) — niveau d'origine : ${assuranceText(src)}.`,
          tags: [...src.tags, 'importé'],
          confidence: src.confidence,
          importance: src.importance,
          sourceIds: src.sourceIds,
        }, ctx.agent.id)
        if (level !== 'claimed') recordAssurance(ctx.project.id, note.slug, { level, by: 'import', detail: `Niveau acquis dans le projet « ${fromProject.title} » ([[${src.slug}]]).` })
        return `Importé : [[${note.slug}]] (${ASSURANCE_LABELS[level]}). Les sources citées par la note d'origine sont dans la bibliothèque de l'autre projet : ajoute-les ici (paper_lookup) si tu les cites.`
      }
      const query = argStr(args, 'query')
      const minRank = assuranceRank((typeof args.min_level === 'string' ? args.min_level : 'reviewed') as 'reviewed')
      const rows = all<{ note_id: string; project_id: string; snip: string }>(
        `SELECT note_id, project_id, snippet(notes_fts, 1, '«', '»', '…', 20) AS snip FROM notes_fts
         WHERE notes_fts MATCH ? AND project_id != ? ORDER BY bm25(notes_fts, 5.0, 1.0, 2.0) LIMIT 80`,
        ftsQuery(query), ctx.project.id,
      )
      const out: string[] = []
      for (const r of rows) {
        const n = getNote(r.project_id, r.note_id)
        if (!n || n.status !== 'active' || !['finding', 'fact', 'definition', 'method', 'insight'].includes(n.type)) continue
        if (assuranceRank(n.assurance?.level) < minRank) continue
        const p = getProject(r.project_id)
        out.push(`- [${p?.title ?? r.project_id}] project=${r.project_id} slug=${n.slug} — **${n.title}** (${assuranceText(n)})\n  ${r.snip.replace(/\s+/g, ' ')}`)
        if (out.length >= Math.min(20, argNum(args, 'limit', 8))) break
      }
      return out.length ? `${out.join('\n')}\n→ import=true, project=…, slug=… pour réutiliser un résultat.` : 'Aucun résultat vérifié correspondant dans les autres projets.'
    },
  },
]
