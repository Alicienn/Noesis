import fs from 'node:fs'
import path from 'node:path'
import { bus } from '../../core/events.ts'
import { newId } from '../../core/util.ts'
import { getNote, recordAssurance, setLeanAssurance } from '../../memory/notes.ts'
import { leanReady, leanSettings, runComparator, runLeanFile, searchMathlib, STANDARD_AXIOMS } from '../../services/lean.ts'
import { createCheck, finishCheck, newCheckId } from '../../store/leanChecks.ts'
import { argList, argNum, argStr, S } from '../types.ts'
import type { ToolContext, ToolDef } from '../types.ts'
import { resolvePath } from './system.ts'

/**
 * Formal verification tools (Lean 4 + Mathlib + Comparator). Offered only when
 * the environment is installed (Paramètres → Vérification formelle).
 *
 * Protocol, after openai/math: a short, human-readable Challenge file states the
 * result (theorem … := by sorry); a separate Solution file proves the very same
 * statement; Comparator checks that the statements match, that only the standard
 * axioms are used, and replays the proof in the kernel. The remaining trust point
 * is the faithfulness of the Challenge to the claim: it is reviewed separately.
 */

const IO_RISK = /\bIO\.Process\b|\bIO\.FS\.(writeFile|removeFile|removeDirAll|createDirAll)\b|\brun_cmd\b|\bSystem\.FilePath\b/

function leanTimeout(d: number): number {
  return Math.max(d, (leanSettings().timeoutSec + 180) * 1000)
}

function readLean(ctx: ToolContext, p: string, what: string): { abs: string; rel: string; text: string } {
  const { abs, inside } = resolvePath(ctx, p)
  if (!inside) throw new Error(`${what} : le fichier doit être dans le workspace du projet`)
  if (!fs.existsSync(abs)) throw new Error(`${what} introuvable : ${p}`)
  if (!abs.endsWith('.lean')) throw new Error(`${what} : un fichier .lean est attendu`)
  return { abs, rel: path.relative(ctx.workspace, abs).replace(/\\/g, '/'), text: fs.readFileSync(abs, 'utf8') }
}

/** Declared names (theorem/lemma/def…) ignoring namespaces: enough for an early, readable error. */
function declares(text: string, name: string): boolean {
  const short = name.split('.').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(theorem|lemma|def|abbrev|noncomputable def|instance)\\s+(\\S+\\.)?${short}\\b`).test(text)
}

export const leanTools: ToolDef[] = [
  {
    name: 'lean_run',
    category: 'formal',
    description: 'Compile un fichier Lean 4 contre Mathlib (espace Lean partagé) et renvoie les erreurs, les buts restants et les sorties de #check/#eval. C\'est la boucle de travail pour écrire un énoncé ou une preuve : #check pour vérifier un énoncé, `exact?`/`apply?`/`simp?`/`aesop` pour trouver des lemmes, `sorry` pour laisser une étape ouverte (compté dans le résultat). Donne `code` (le fichier est sauvegardé dans lean/scratch/) ou `file` (chemin dans le workspace). `import Mathlib` est ajouté si aucun import n\'est présent. Première compilation d\'un fichier : 10 à 60 s (chargement de Mathlib).',
    parameters: S.obj({
      code: S.str('Source Lean complète (alternative à file)'),
      file: S.str('Fichier .lean du workspace (alternative à code)'),
      name: S.str('Nom du fichier quand code est fourni (ex. lemme_borne)'),
      timeout_s: S.int('Délai max en secondes (défaut : réglage global)'),
    }),
    sensitive: true,
    parallel: true,
    available: leanReady,
    timeoutMs: leanTimeout,
    risk: args => (typeof args.code === 'string' && IO_RISK.test(args.code) ? 'exécution de code arbitraire depuis Lean (IO)' : undefined),
    execute: async (args, ctx) => {
      let abs: string
      let rel: string
      if (typeof args.code === 'string' && args.code.trim()) {
        const name = (typeof args.name === 'string' && args.name.trim() ? args.name.trim() : newId('lean')).replace(/\.lean$/, '').replace(/[^\w-]/g, '_')
        rel = `lean/scratch/${name}.lean`
        abs = path.join(ctx.workspace, rel)
        const code = /^\s*import\s/m.test(args.code) ? args.code : `import Mathlib\n\n${args.code}`
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, code, 'utf8')
        bus.publish(ctx.project.id, { type: 'files.changed' })
      } else {
        const f = readLean(ctx, argStr(args, 'file'), 'Fichier')
        abs = f.abs
        rel = f.rel
        if (IO_RISK.test(f.text) && ctx.project.config.permission !== 'auto') {
          // the risk hook only sees inline code; a file with IO actions is refused rather than run unseen
          throw new Error('Ce fichier contient des actions IO (IO.Process, écriture de fichiers…). Passe le code via `code` pour qu\'il soit soumis à approbation.')
        }
      }
      const r = await runLeanFile({ projectId: ctx.project.id, file: abs, displayPath: rel, timeoutSec: typeof args.timeout_s === 'number' ? args.timeout_s : undefined, signal: ctx.signal })
      const head = r.timedOut
        ? `TIMEOUT après ${Math.round(r.durationMs / 1000)} s (${rel}). Découpe la preuve ou augmente timeout_s.`
        : r.ok
          ? `OK — ${rel} compile${r.sorries ? ` avec ${r.sorries} sorry (preuve incomplète)` : ', sans sorry'} · ${Math.round(r.durationMs / 1000)} s`
          : `ÉCHEC — ${rel} ne compile pas · ${Math.round(r.durationMs / 1000)} s`
      const hint = /unknown (identifier|constant)/.test(r.output) ? '\nAstuce : nom de lemme inconnu → lean_search (Mathlib) ou `exact?` pour le retrouver.' : ''
      const out = r.output.length > 14_000 ? `${r.output.slice(0, 6000)}\n… [${r.output.length - 12_000} caractères omis] …\n${r.output.slice(-6000)}` : r.output
      return { content: `${head}\n${out || '(aucun message)'}${hint}`, status: r.ok && !r.timedOut ? 'ok' : 'error' }
    },
  },
  {
    name: 'lean_search',
    category: 'formal',
    description: 'Cherche dans les sources de Mathlib (expression régulière étendue, sensible à la casse) : noms de lemmes, énoncés, définitions. Ex. "theorem .*Nat\\.Prime.*two", "lemma .*norm_sum_le", "def IsCompact". Renvoie fichier:ligne: texte. Complète `exact?` / `#check` de lean_run.',
    parameters: S.obj({ pattern: S.str('Expression régulière (grep -E)'), limit: S.int('Nombre max de lignes (défaut 40)') }, ['pattern']),
    parallel: true,
    available: leanReady,
    execute: async (args, ctx) => {
      const out = await searchMathlib(argStr(args, 'pattern'), { limit: argNum(args, 'limit', 40), signal: ctx.signal })
      return out || 'Aucune correspondance dans Mathlib.'
    },
  },
  {
    name: 'lean_check',
    category: 'formal',
    description: `Vérification formelle définitive par Comparator (le juge utilisé par openai/math). Deux fichiers distincts :
- challenge : l'ÉNONCÉ seul, court et lisible par un humain (définitions nécessaires + \`theorem nom … := by sorry\`), qui doit dire exactement ce qu'affirme la note ;
- solution : un fichier autonome (import Mathlib, sans importer le challenge) qui redéclare les mêmes définitions et le même théorème, cette fois prouvé.
Comparator vérifie que chaque théorème listé a exactement l'énoncé du challenge, n'utilise que les axiomes standard (${STANDARD_AXIOMS.join(', ')} ; ni sorry ni axiome ajouté) et passe le noyau Lean. Avec note_slug, une réussite élève la note au niveau « Prouvé en Lean ». Mets au point la preuve avec lean_run avant : chaque lean_check reconstruit les deux fichiers (plusieurs minutes).`,
    parameters: S.obj({
      challenge: S.str('Fichier .lean de l\'énoncé (dans le workspace, ex. lean/borne/Challenge.lean)'),
      solution: S.str('Fichier .lean de la preuve (ex. lean/borne/Solution.lean)'),
      theorems: S.arr({ type: 'string' }, 'Noms complets des théorèmes à vérifier (avec namespace)'),
      definitions: S.arr({ type: 'string' }, 'Définitions laissées en `sorry` dans le challenge et fournies par la solution (« trous » : leur valeur doit ensuite être relue)'),
      note_slug: S.str('Note dont c\'est la formalisation (optionnel mais recommandé)'),
    }, ['challenge', 'solution', 'theorems']),
    sensitive: true,
    available: leanReady,
    timeoutMs: leanTimeout,
    execute: async (args, ctx) => {
      const challenge = readLean(ctx, argStr(args, 'challenge'), 'Challenge')
      const solution = readLean(ctx, argStr(args, 'solution'), 'Solution')
      const theorems = argList(args, 'theorems')
      const definitions = argList(args, 'definitions')
      if (!theorems.length) throw new Error('theorems : au moins un nom de théorème est requis')
      const noteSlug = typeof args.note_slug === 'string' && args.note_slug.trim() ? args.note_slug.trim().replace(/^\[\[|\]\]$/g, '') : undefined
      const note = noteSlug ? getNote(ctx.project.id, noteSlug) : undefined
      if (noteSlug && !note) throw new Error(`Note introuvable : ${noteSlug}`)
      // cheap early errors (Comparator would also reject these, after minutes of building)
      const missing = [...theorems, ...definitions].filter(n => !declares(challenge.text, n))
      if (missing.length) throw new Error(`Le challenge ne déclare pas : ${missing.join(', ')}`)
      const missingSol = [...theorems, ...definitions].filter(n => !declares(solution.text, n))
      if (missingSol.length) throw new Error(`La solution ne déclare pas : ${missingSol.join(', ')}`)
      if (/\b(sorry|admit)\b/.test(solution.text.replace(/--.*$/gm, '').replace(/\/-[\s\S]*?-\//g, ''))) throw new Error('La solution contient encore `sorry`/`admit` : termine la preuve (lean_run) avant lean_check.')
      if (/^\s*axiom\s/m.test(solution.text)) throw new Error('La solution déclare un `axiom` : seuls les axiomes standard sont acceptés.')
      if (/^\s*import\s+Checks\b/m.test(solution.text)) throw new Error('La solution ne doit pas importer le challenge : elle redéclare l\'énoncé.')

      const id = newCheckId()
      const dir = `lean/checks/${id}`
      const archive = path.join(ctx.workspace, dir)
      fs.mkdirSync(archive, { recursive: true })
      fs.writeFileSync(path.join(archive, 'Challenge.lean'), challenge.text, 'utf8')
      fs.writeFileSync(path.join(archive, 'Solution.lean'), solution.text, 'utf8')
      createCheck({
        id, projectId: ctx.project.id, noteSlug: note?.slug, challengeFile: `${dir}/Challenge.lean`, solutionFile: `${dir}/Solution.lean`,
        theorems, definitions, permittedAxioms: STANDARD_AXIOMS, createdBy: ctx.agent.id,
      })
      if (note) setLeanAssurance(ctx.project.id, note.slug, { checkId: id, status: 'running' })

      let r: Awaited<ReturnType<typeof runComparator>>
      try {
        r = await runComparator({ projectId: ctx.project.id, checkId: id, challenge: path.join(archive, 'Challenge.lean'), solution: path.join(archive, 'Solution.lean'), theorems, definitions, signal: ctx.signal })
      } catch (error) {
        finishCheck(id, 'error', (error as Error).message, 0)
        if (note) setLeanAssurance(ctx.project.id, note.slug, { checkId: id, status: 'error' })
        throw error
      }
      const status = r.ok ? 'proved' : 'failed'
      fs.writeFileSync(path.join(archive, 'comparator.log'), r.output, 'utf8')
      fs.writeFileSync(path.join(archive, 'config.json'), JSON.stringify({ theorem_names: theorems, definition_names: definitions, permitted_axioms: STANDARD_AXIOMS }, null, 2), 'utf8')
      finishCheck(id, status, r.output, r.durationMs)
      bus.publish(ctx.project.id, { type: 'files.changed' })

      const tail = r.output.split('\n').slice(-40).join('\n')
      if (!r.ok) {
        if (note) setLeanAssurance(ctx.project.id, note.slug, { checkId: id, status: 'failed' })
        return { status: 'error', content: `REJETÉ par Comparator${r.timedOut ? ' (timeout)' : ''} — vérification ${id}, ${Math.round(r.durationMs / 1000)} s.\nCauses fréquentes : énoncé de la solution différent du challenge (même une implicite ou une instance), axiome non standard, sorry caché, erreur de compilation.\n--- sortie (fin) ---\n${tail}` }
      }
      if (note) {
        recordAssurance(ctx.project.id, note.slug, {
          level: 'formal', by: 'comparator', ref: id,
          detail: `Comparator : ${theorems.join(', ')} prouvé(s), axiomes standard uniquement (${dir}).`,
        }, { checkId: id, status: 'proved' })
      }
      return `ACCEPTÉ par Comparator — vérification ${id} (${Math.round(r.durationMs / 1000)} s) : ${theorems.join(', ')} prouvé(s) avec les seuls axiomes ${STANDARD_AXIOMS.join(', ')}. Fichiers archivés dans ${dir}/.${note ? ` La note [[${note.slug}]] passe au niveau « Prouvé en Lean ».` : ' (Aucune note liée : passe note_slug pour faire monter le niveau de vérification d\'une note.)'}
Reste un point de confiance : l'énoncé ${dir}/Challenge.lean dit-il exactement ce qu'affirme la note ? → verify_claim(kind="formalization"${note ? `, note_slug="${note.slug}"` : ''}, context="${dir}/Challenge.lean")${definitions.length ? `\nATTENTION : ${definitions.length} définition(s) « trou » (${definitions.join(', ')}) — Comparator ne contrôle que leur type : leur valeur doit être relue (une définition triviale peut rendre le théorème vide).` : ''}`
    },
  },
]
