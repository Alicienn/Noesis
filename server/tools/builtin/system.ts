import fs from 'node:fs'
import path from 'node:path'
import { bus } from '../../core/events.ts'
import { newId } from '../../core/util.ts'
import { getSettings } from '../../settings.ts'
import { assessRisk, execCommand, execFile, formatExec } from '../../services/shell.ts'
import { argNum, argStr, S } from '../types.ts'
import type { ToolContext, ToolDef } from '../types.ts'

/** Resolve a user/agent path. Relative paths are relative to the workspace. */
export function resolvePath(ctx: Pick<ToolContext, 'workspace'>, p: string): { abs: string; inside: boolean } {
  const abs = path.resolve(ctx.workspace, p.replace(/^~[\\/]/, `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/`))
  const rel = path.relative(ctx.workspace, abs)
  return { abs, inside: !rel.startsWith('..') && !path.isAbsolute(rel) }
}

function outsideRisk(key: string, write: boolean) {
  return (args: Record<string, unknown>, ctx: ToolContext): string | undefined => {
    const p = typeof args[key] === 'string' ? (args[key] as string) : ''
    if (!p) return undefined
    const { inside } = resolvePath(ctx, p)
    if (inside) return undefined
    return write ? 'écriture hors du workspace' : 'lecture hors du workspace'
  }
}

/** `find /`, `grep -r /`, `du C:\` … scanning a whole drive takes ages. */
const DISK_SCAN = /\b(find|du|ls\s+-\w*R\w*|grep\s+-\w*r\w*)\b[^|;&\n]*\s["']?(\/|[A-Za-z]:\\?)["']?(?=\s|$)/

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv'])

function walk(dir: string, base: string, depth: number, out: string[], limit: number): void {
  if (out.length >= limit) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) return
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full).replace(/\\/g, '/')
    if (e.isDirectory()) {
      out.push(`${rel}/`)
      if (depth > 0) walk(full, base, depth - 1, out, limit)
    } else {
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        // ignore
      }
      out.push(`${rel}  (${size < 1024 ? `${size} o` : size < 1048576 ? `${(size / 1024).toFixed(1)} Ko` : `${(size / 1048576).toFixed(1)} Mo`})`)
    }
  }
}

function changed(ctx: ToolContext): void {
  bus.publish(ctx.project.id, { type: 'files.changed' })
}

export const systemTools: ToolDef[] = [
  {
    name: 'file_list',
    category: 'files',
    description: 'Liste les fichiers d\'un dossier (relatif au workspace du projet par défaut). Structure du workspace: memory/ (mémoire miroir), sources/ (PDF et textes), reports/, scratch/ (scripts), artifacts/.',
    parameters: S.obj({ path: S.str('Dossier (défaut: racine du workspace)'), depth: S.int('Profondeur de récursion (défaut 2)') }),
    parallel: true,
    risk: outsideRisk('path', false),
    execute: async (args, ctx) => {
      const { abs } = resolvePath(ctx, argStr(args, 'path', '.'))
      if (!fs.existsSync(abs)) throw new Error(`Dossier introuvable: ${abs}`)
      const out: string[] = []
      walk(abs, abs, Math.min(6, argNum(args, 'depth', 2)), out, 400)
      return out.length ? `${abs}\n${out.join('\n')}${out.length >= 400 ? '\n[… liste tronquée]' : ''}` : '(dossier vide)'
    },
  },
  {
    name: 'file_read',
    category: 'files',
    description: 'Lit un fichier texte (numéros de lignes inclus). Pagination par offset/limit de lignes.',
    parameters: S.obj({ path: S.str('Chemin'), offset: S.int('Première ligne (1 = début)'), limit: S.int('Nombre de lignes (défaut 400)') }, ['path']),
    parallel: true,
    risk: outsideRisk('path', false),
    execute: async (args, ctx) => {
      const { abs } = resolvePath(ctx, argStr(args, 'path'))
      if (!fs.existsSync(abs)) throw new Error(`Fichier introuvable: ${abs}`)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) throw new Error('C\'est un dossier: utilise file_list')
      if (stat.size > 25 * 1024 * 1024) throw new Error('Fichier trop gros (>25 Mo); utilise bash (head, grep…)')
      const buf = fs.readFileSync(abs)
      if (buf.subarray(0, 8000).includes(0)) throw new Error('Fichier binaire. Pour un PDF: fetch_url sur le chemin n\'est pas possible — ajoute-le via la bibliothèque, ou utilise python.')
      const lines = buf.toString('utf8').split(/\r?\n/)
      const offset = Math.max(1, argNum(args, 'offset', 1))
      const limit = Math.min(2000, argNum(args, 'limit', 400))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((l, i) => `${String(offset + i).padStart(5)}│${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join('\n')
      return `${abs} (${lines.length} lignes)\n${body}${offset - 1 + limit < lines.length ? `\n[… suite: offset=${offset + limit}]` : ''}`
    },
  },
  {
    name: 'file_write',
    category: 'files',
    description: 'Crée ou écrase un fichier texte (dossiers créés automatiquement). Pour modifier un fichier existant, préfère file_edit.',
    parameters: S.obj({ path: S.str('Chemin (relatif au workspace)'), content: S.str('Contenu complet') }, ['path', 'content']),
    risk: outsideRisk('path', true),
    execute: async (args, ctx) => {
      const { abs } = resolvePath(ctx, argStr(args, 'path'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      const content = argStr(args, 'content')
      fs.writeFileSync(abs, content, 'utf8')
      changed(ctx)
      return `Écrit: ${abs} (${content.length} caractères)`
    },
  },
  {
    name: 'file_edit',
    category: 'files',
    description: 'Remplace une portion exacte d\'un fichier (old_string doit être unique, sauf replace_all).',
    parameters: S.obj({
      path: S.str('Chemin'),
      old_string: S.str('Texte exact à remplacer'),
      new_string: S.str('Texte de remplacement'),
      replace_all: S.bool('Remplacer toutes les occurrences'),
    }, ['path', 'old_string', 'new_string']),
    risk: outsideRisk('path', true),
    execute: async (args, ctx) => {
      const { abs } = resolvePath(ctx, argStr(args, 'path'))
      const text = fs.readFileSync(abs, 'utf8')
      const oldS = argStr(args, 'old_string')
      const count = text.split(oldS).length - 1
      if (count === 0) throw new Error('old_string introuvable dans le fichier (vérifie espaces et retours à la ligne; relis avec file_read)')
      if (count > 1 && args.replace_all !== true) throw new Error(`old_string apparaît ${count} fois; ajoute du contexte ou replace_all=true`)
      const next = args.replace_all === true ? text.split(oldS).join(argStr(args, 'new_string')) : text.replace(oldS, () => argStr(args, 'new_string'))
      fs.writeFileSync(abs, next, 'utf8')
      changed(ctx)
      return `Modifié: ${abs} (${count} remplacement${count > 1 ? 's' : ''})`
    },
  },
  {
    name: 'file_grep',
    category: 'files',
    description: 'Cherche une expression régulière dans un fichier texte ou dans les fichiers d\'un dossier (récursif). Fonctionne aussi sur les sorties tronquées sauvegardées dans artifacts/. Renvoie chemin:ligne: texte.',
    parameters: S.obj({
      pattern: S.str('Expression régulière (JS, insensible à la casse)'),
      path: S.str('Fichier ou dossier (relatif au workspace, défaut: workspace)'),
      glob: S.str('Filtre d\'extension, ex: .py ou .md'),
      context: S.int('Lignes de contexte autour de chaque correspondance (défaut 0, max 5)'),
    }, ['pattern']),
    parallel: true,
    risk: outsideRisk('path', false),
    execute: async (args, ctx) => {
      const { abs } = resolvePath(ctx, argStr(args, 'path', '.'))
      if (!fs.existsSync(abs)) throw new Error(`Introuvable: ${abs}`)
      let re: RegExp
      try {
        re = new RegExp(argStr(args, 'pattern'), 'i')
      } catch {
        re = new RegExp(argStr(args, 'pattern').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }
      const ext = typeof args.glob === 'string' ? args.glob.replace('*', '') : ''
      const around = Math.min(5, Math.max(0, argNum(args, 'context', 0)))
      const isFile = fs.statSync(abs).isFile()
      const files: string[] = []
      if (isFile) files.push(path.basename(abs))
      else walk(abs, abs, 8, files, 5000)
      const base = isFile ? path.dirname(abs) : abs
      const out: string[] = []
      let bytes = 0
      let scanned = 0
      for (const f of files) {
        if (ctx.signal.aborted) break
        if (f.endsWith('/')) continue
        const rel = f.replace(/\s+\(.*\)$/, '')
        if (ext && !rel.endsWith(ext)) continue
        if (/\.(pdf|png|jpe?g|gif|zip|gz|db|sqlite|npy|pkl|bin|exe|dll|woff2?)$/i.test(rel)) continue
        const full = path.join(base, rel)
        let size = 0
        try {
          size = (await fs.promises.stat(full)).size
        } catch {
          continue
        }
        if (size > 20 * 1024 * 1024 || bytes > 200 * 1024 * 1024) continue
        bytes += size
        // yield to the event loop: grep must never freeze the server
        if (++scanned % 25 === 0) await new Promise(r => setImmediate(r))
        let lines: string[]
        try {
          lines = (await fs.promises.readFile(full, 'utf8')).split(/\r?\n/)
        } catch {
          continue
        }
        for (let i = 0; i < lines.length && out.length < 200; i++) {
          if (!re.test(lines[i])) continue
          if (around) {
            const from = Math.max(0, i - around)
            const to = Math.min(lines.length, i + around + 1)
            const block = lines.slice(from, to).map((l, k) => `${from + k === i ? '>' : ' '} ${from + k + 1}│${l.slice(0, 300)}`)
            out.push(`${rel}:${i + 1}:\n${block.join('\n')}`)
          } else {
            out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`)
          }
        }
        if (out.length >= 200) break
      }
      if (!out.length) return 'Aucune correspondance.'
      return `${out.join('\n')}${out.length >= 200 ? '\n[… limité à 200 correspondances]' : ''}`
    },
  },
  {
    name: 'bash',
    category: 'exec',
    description: 'Exécute une commande shell dans le workspace du projet (Git Bash sous Windows si disponible, sinon PowerShell). Pour installer des paquets Python: "python -m pip install …". Les commandes risquées demandent l\'approbation humaine. Sortie tronquée si très longue. Reste dans le workspace : ne parcours jamais tout le disque (find /, grep -r /), c\'est très lent — utilise file_grep / file_list.',
    parameters: S.obj({ command: S.str('Commande'), timeout_s: S.int('Délai max en secondes (défaut 120, max 1800)'), cwd: S.str('Sous-dossier du workspace (optionnel)') }, ['command']),
    sensitive: true,
    timeoutMs: d => Math.max(d, 1_830_000),
    risk: (args, ctx) => assessRisk(String(args.command ?? ''), ctx.workspace),
    execute: async (args, ctx) => {
      // never worth an approval request: a verifier once sat 60 min waiting for the human on `find /`
      if (DISK_SCAN.test(argStr(args, 'command'))) {
        throw new Error('Commande refusée : elle parcourt tout le disque (très lent, jamais utile). Cherche dans le workspace (file_grep, file_list) ; les documents fournis sont dans inputs/, les sources de Mathlib se cherchent avec lean_search.')
      }
      const cwd = typeof args.cwd === 'string' ? resolvePath(ctx, args.cwd).abs : ctx.workspace
      const r = await execCommand(argStr(args, 'command'), { cwd, timeoutMs: Math.min(1800, argNum(args, 'timeout_s', 120)) * 1000, signal: ctx.signal })
      changed(ctx)
      return { content: formatExec(r, 14_000), status: r.exitCode === 0 ? 'ok' : 'error' }
    },
  },
  {
    name: 'python',
    category: 'exec',
    description: 'Exécute un script Python (calcul numérique/symbolique: numpy, scipy, sympy, networkx, matplotlib…). Le code est sauvegardé dans scratch/ puis exécuté depuis le workspace. Chaque appel est un processus neuf: sauvegarde les résultats intermédiaires dans des fichiers. Imprime explicitement ce que tu veux voir. Les figures: plt.savefig("artifacts/xxx.png").',
    parameters: S.obj({ code: S.str('Code Python 3 complet'), timeout_s: S.int('Délai max en secondes (défaut 300)'), name: S.str('Nom du fichier script (optionnel)') }, ['code']),
    sensitive: true,
    timeoutMs: d => Math.max(d, 3_630_000),
    risk: (args, ctx) => {
      const code = String(args.code ?? '')
      if (/\b(shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir)\s*\(\s*['"]?([A-Z]:|\/|~)/i.test(code)) return 'suppression de fichiers hors workspace'
      if (/subprocess|os\.system/.test(code)) return assessRisk(code, ctx.workspace)
      if (/requests\.(post|put|delete)|urllib.*method=['"](POST|PUT|DELETE)/i.test(code)) return 'requête HTTP sortante avec données'
      return undefined
    },
    execute: async (args, ctx) => {
      const name = (typeof args.name === 'string' && args.name.trim() ? args.name.trim().replace(/[^\w.-]/g, '_') : newId('py')).replace(/\.py$/, '')
      const file = path.join(ctx.workspace, 'scratch', `${name}.py`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, argStr(args, 'code'), 'utf8')
      const py = getSettings().shell.pythonPath || 'python'
      const r = await execFile(py, [file], { cwd: ctx.workspace, timeoutMs: Math.min(3600, argNum(args, 'timeout_s', 300)) * 1000, signal: ctx.signal, shellLabel: 'python' })
      changed(ctx)
      return { content: `script: scratch/${name}.py\n${formatExec(r, 14_000)}`, status: r.exitCode === 0 ? 'ok' : 'error' }
    },
  },
]
