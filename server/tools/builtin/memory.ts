import { all } from '../../db/database.ts'
import type { NoteType } from '../../../shared/types.ts'
import { BLOCK_DEFS, getBlock, setBlock } from '../../store/blocks.ts'
import { createNote, getNote, listNotes, NOTE_TYPES, noteToText, searchNotes, similarNotes, supersedeNote, updateNote } from '../../memory/notes.ts'
import { listEpisodes } from '../../memory/notes.ts'
import { getSource } from '../../store/sources.ts'
import { argBool, argList, argNum, argStr, S } from '../types.ts'
import type { ToolDef } from '../types.ts'

const blockLabels = BLOCK_DEFS.map(b => b.label)

export const memoryTools: ToolDef[] = [
  {
    name: 'update_plan',
    category: 'plan',
    description: 'Remplace le plan de recherche (bloc mémoire « plan », toujours visible). Format checklist markdown: "- [x] fait", "- [ ] à faire", avec la PROCHAINE action en tête. Appelle-le dès que le plan évolue.',
    parameters: S.obj({ plan: S.str('Plan complet en markdown (checklist).') }, ['plan']),
    execute: async (args, ctx) => {
      const b = setBlock(ctx.project.id, 'plan', argStr(args, 'plan'))
      return `Plan mis à jour (${b.value.length}/${b.limit} caractères).`
    },
  },
  {
    name: 'core_memory_edit',
    category: 'memory',
    description: `Édite un bloc de mémoire centrale (toujours présent dans ton contexte). Blocs: ${BLOCK_DEFS.map(b => `${b.label} — ${b.description}`).join(' | ')}. Opérations: replace (remplace tout), append (ajoute à la fin), str_replace (remplace old par new).`,
    parameters: S.obj({
      label: S.enum(blockLabels, 'Bloc à modifier'),
      operation: S.enum(['replace', 'append', 'str_replace'], 'Type de modification'),
      text: S.str('Nouveau texte (replace/append) ou texte de remplacement (str_replace).'),
      old: S.str('Texte exact à remplacer (str_replace uniquement).'),
    }, ['label', 'operation', 'text']),
    execute: async (args, ctx) => {
      const label = argStr(args, 'label')
      if (label === 'mission' && ctx.agent.role !== 'lead') throw new Error('Seul le chercheur principal peut modifier la mission')
      const block = getBlock(ctx.project.id, label)
      if (!block) throw new Error(`Bloc inconnu: ${label}`)
      const op = argStr(args, 'operation', 'replace')
      const text = argStr(args, 'text')
      let value = block.value
      if (op === 'replace') value = text
      else if (op === 'append') value = value ? `${value}\n${text}` : text
      else {
        const old = argStr(args, 'old')
        if (!value.includes(old)) throw new Error(`Texte introuvable dans le bloc ${label}. Contenu actuel:\n${value}`)
        value = value.replace(old, text)
      }
      const b = setBlock(ctx.project.id, label, value)
      return `Bloc « ${label} » mis à jour (${b.value.length}/${b.limit}).`
    },
  },
  {
    name: 'memory_write',
    category: 'memory',
    description: 'Crée une note atomique dans la mémoire long terme (une idée = une note). Utilise-la pour tout résultat, fait sourcé, définition, méthode, impasse (dead_end) ou question ouverte que tu voudras retrouver. Indique des liens [[slug]] vers des notes liées et les clés des sources. Retourne le slug et les notes similaires existantes (pour lier ou fusionner).',
    parameters: S.obj({
      title: S.str('Titre court et spécifique (devient le slug).'),
      content: S.str('Contenu autonome en markdown (LaTeX accepté: $...$). Inclure le raisonnement/les preuves, pas seulement la conclusion.'),
      type: S.enum(NOTE_TYPES, 'Nature de la note'),
      tags: S.arr({ type: 'string' }, 'Mots-clés'),
      confidence: S.num('Confiance 0..1'),
      importance: S.int('Importance 1..5 (5 = résultat central). Les notes « finding » d\'importance ≥4 sont vérifiées automatiquement.'),
      links: S.arr({ type: 'string' }, 'Slugs de notes liées'),
      sources: S.arr({ type: 'string' }, 'Clés de citation des sources'),
    }, ['title', 'content', 'type']),
    execute: async (args, ctx) => {
      const sourceIds = argList(args, 'sources').map(k => getSource(ctx.project.id, k)?.citationKey ?? k)
      const note = createNote(ctx.project.id, {
        title: argStr(args, 'title'),
        content: argStr(args, 'content'),
        type: argStr(args, 'type', 'finding') as NoteType,
        tags: argList(args, 'tags'),
        confidence: argNum(args, 'confidence', 0.6),
        importance: argNum(args, 'importance', 3),
        links: argList(args, 'links'),
        sourceIds,
      }, ctx.agent.id)
      const similar = similarNotes(ctx.project.id, `${note.title} ${note.content.slice(0, 300)}`, note.id, 4)
        .filter(n => !note.links.includes(n.slug))
      let out = `Note créée: [[${note.slug}]] (${note.type}, importance ${note.importance}).`
      if (similar.length) {
        out += `\nNotes proches non liées — envisage memory_update(links) ou de fusionner si doublon:\n${similar.map(n => `- ${noteToText(n, false)}`).join('\n')}`
      }
      return out
    },
  },
  {
    name: 'memory_update',
    category: 'memory',
    description: 'Met à jour une note existante (contenu complet, ajout en fin, titre, confiance, importance, tags, liens, sources).',
    parameters: S.obj({
      slug: S.str('Slug ou id de la note'),
      content: S.str('Nouveau contenu complet (optionnel)'),
      append: S.str('Texte à ajouter à la fin (optionnel)'),
      title: S.str('Nouveau titre'),
      confidence: S.num('Confiance 0..1'),
      importance: S.int('Importance 1..5'),
      tags: S.arr({ type: 'string' }, 'Remplace les tags'),
      links: S.arr({ type: 'string' }, 'Liens à AJOUTER'),
      sources: S.arr({ type: 'string' }, 'Sources à AJOUTER'),
    }, ['slug']),
    execute: async (args, ctx) => {
      const note = updateNote(ctx.project.id, argStr(args, 'slug'), {
        content: typeof args.content === 'string' ? args.content : undefined,
        append: typeof args.append === 'string' ? args.append : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
        importance: typeof args.importance === 'number' ? args.importance : undefined,
        tags: args.tags ? argList(args, 'tags') : undefined,
        links: args.links ? argList(args, 'links') : undefined,
        sourceIds: args.sources ? argList(args, 'sources') : undefined,
      })
      return `Note mise à jour: ${noteToText(note, false)}`
    },
  },
  {
    name: 'memory_supersede',
    category: 'memory',
    description: 'Invalide une note devenue fausse ou obsolète (elle est conservée dans l\'historique, marquée « superseded »), éventuellement remplacée par une nouvelle note. Ne jamais laisser une note contredite active.',
    parameters: S.obj({
      slug: S.str('Note à invalider'),
      replaced_by: S.str('Slug de la note qui la remplace (optionnel)'),
      reason: S.str('Pourquoi elle est invalidée (preuve, source, calcul…)'),
    }, ['slug', 'reason']),
    execute: async (args, ctx) => {
      const by = typeof args.replaced_by === 'string' && args.replaced_by.trim() ? args.replaced_by.trim() : undefined
      const n = supersedeNote(ctx.project.id, argStr(args, 'slug'), by, argStr(args, 'reason'))
      const pending = n.supersededBy && !getNote(ctx.project.id, n.supersededBy)
      return `Note [[${n.slug}]] invalidée${n.supersededBy ? `, remplacée par [[${n.supersededBy}]]` : ''}.${pending ? ` Cette note n'existe pas encore : crée-la avec exactement ce titre/slug (memory_write) pour que le lien soit valide.` : ''}`
    },
  },
  {
    name: 'memory_search',
    category: 'memory',
    description: 'Recherche hybride (mots-clés BM25 + sémantique) dans la mémoire long terme. À utiliser AVANT de refaire un travail, pour retrouver résultats, méthodes, impasses déjà explorées.',
    parameters: S.obj({
      query: S.str('Requête en langage naturel ou mots-clés'),
      type: S.enum(NOTE_TYPES, 'Filtrer par type (optionnel)'),
      limit: S.int('Nombre max de résultats (défaut 8)'),
      include_inactive: S.bool('Inclure les notes invalidées'),
    }, ['query']),
    parallel: true,
    execute: async (args, ctx) => {
      const hits = await searchNotes(ctx.project.id, argStr(args, 'query'), {
        limit: argNum(args, 'limit', 8),
        type: typeof args.type === 'string' && NOTE_TYPES.includes(args.type as NoteType) ? (args.type as NoteType) : undefined,
        includeInactive: argBool(args, 'include_inactive', false),
      })
      if (!hits.length) return 'Aucune note correspondante.'
      return hits.map(h => `${noteToText(h.note, false)}\n   … ${h.snippet.replace(/\n/g, ' ').slice(0, 300)}`).join('\n')
    },
  },
  {
    name: 'memory_read',
    category: 'memory',
    description: 'Lit une note complète (et les titres des notes liées).',
    parameters: S.obj({ slug: S.str('Slug ou id') }, ['slug']),
    parallel: true,
    execute: async (args, ctx) => {
      const note = getNote(ctx.project.id, argStr(args, 'slug'))
      if (!note) {
        const close = similarNotes(ctx.project.id, argStr(args, 'slug').replace(/[-_]/g, ' '), undefined, 5)
        throw new Error(`Note introuvable.${close.length ? ` Notes proches :\n${close.map(n => `- [[${n.slug}]] ${n.title}`).join('\n')}` : ' Utilise memory_search.'}`)
      }
      const linked = note.links.map(l => getNote(ctx.project.id, l)).filter(Boolean).map(n => `- ${noteToText(n!, false)}`)
      return `${noteToText(note)}${note.verification ? `\n\nVérification: ${note.verification.verdict} — ${note.verification.summary}${note.verification.issues?.length ? `\nProblèmes: ${note.verification.issues.join('; ')}` : ''}` : ''}${linked.length ? `\n\nNotes liées:\n${linked.join('\n')}` : ''}`
    },
  },
  {
    name: 'memory_list',
    category: 'memory',
    description: 'Liste les notes (titres uniquement), éventuellement filtrées par type.',
    parameters: S.obj({ type: S.enum(NOTE_TYPES, 'Type (optionnel)') }),
    parallel: true,
    execute: async (args, ctx) => {
      const notes = listNotes(ctx.project.id, { type: typeof args.type === 'string' ? (args.type as NoteType) : undefined, limit: 300 })
      if (!notes.length) return 'Mémoire vide.'
      return notes.map(n => `- ${noteToText(n, false)}`).join('\n')
    },
  },
  {
    name: 'recall_history',
    category: 'memory',
    description: 'Recherche dans l\'historique brut des conversations (y compris les parties compactées) et les résumés d\'épisodes. Utile pour retrouver un détail exact d\'une étape passée (sortie de commande, chiffre…).',
    parameters: S.obj({ query: S.str('Texte à chercher (sous-chaîne, insensible à la casse)'), limit: S.int('Max résultats (défaut 8)') }, ['query']),
    parallel: true,
    execute: async (args, ctx) => {
      const q = argStr(args, 'query').toLowerCase()
      const limit = argNum(args, 'limit', 8)
      const rows = all<{ agent_id: string; role: string; name: string | null; content: string; created_at: number }>(
        "SELECT agent_id, role, name, content, created_at FROM messages WHERE project_id = ? AND lower(content) LIKE ? ORDER BY created_at DESC LIMIT ?",
        ctx.project.id, `%${q.replace(/[%_]/g, '')}%`, limit,
      )
      const episodes = listEpisodes(ctx.project.id).filter(e => e.summary.toLowerCase().includes(q)).slice(-3)
      const out: string[] = []
      for (const r of rows) {
        const idx = r.content.toLowerCase().indexOf(q)
        const start = Math.max(0, idx - 300)
        out.push(`[${new Date(r.created_at).toLocaleString('fr-FR')} · ${r.agent_id} · ${r.role}${r.name ? `:${r.name}` : ''}] …${r.content.slice(start, start + 800)}…`)
      }
      for (const e of episodes) out.push(`[Épisode ${new Date(e.createdAt).toLocaleString('fr-FR')}]\n${e.summary.slice(0, 1500)}`)
      return out.length ? out.join('\n\n') : 'Rien trouvé dans l\'historique.'
    },
  },
]
