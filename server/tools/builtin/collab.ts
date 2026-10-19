import fs from 'node:fs'
import path from 'node:path'
import { bus } from '../../core/events.ts'
import { slugify } from '../../core/util.ts'
import { notify } from '../../services/notify.ts'
import { argBool, argList, argNum, argStr, S } from '../types.ts'
import type { ToolDef } from '../types.ts'

const SUB_ROLES = ['scout', 'experimenter', 'theorist', 'critic'] as const

export const collabTools: ToolDef[] = [
  {
    name: 'delegate',
    category: 'agents',
    description: `Confie une sous-tâche bien délimitée à un sous-agent spécialisé qui travaille avec son propre contexte et ses outils, puis te renvoie un rapport condensé. Plusieurs appels delegate dans le même message s'exécutent EN PARALLÈLE. Rôles: scout (revue de littérature ciblée, lit et résume des articles), experimenter (code, simulations, calculs numériques), theorist (dérivations, preuves, modèles formels), critic (cherche les failles d'un raisonnement/d'un plan). Donne une tâche précise, le contexte nécessaire et le livrable attendu.`,
    parameters: S.obj({
      role: S.enum(SUB_ROLES, 'Spécialité du sous-agent'),
      task: S.str('Tâche précise avec livrable attendu'),
      context: S.str('Contexte utile: ce qu\'on sait déjà, notes/sources pertinentes, contraintes'),
      max_steps: S.int('Budget d\'étapes (défaut 25)'),
    }, ['role', 'task']),
    roles: ['lead'],
    parallel: true,
    timeoutMs: d => Math.max(d * 3, 5_400_000),
    execute: async (args, ctx) => ctx.runtime.delegate({
      role: argStr(args, 'role') as (typeof SUB_ROLES)[number],
      task: argStr(args, 'task'),
      context: argStr(args, 'context', ''),
      maxSteps: Math.min(80, argNum(args, 'max_steps', 25)),
      parent: ctx.agent,
      signal: ctx.signal,
    }),
  },
  {
    name: 'verify_claim',
    category: 'agents',
    description: 'Fait vérifier une affirmation par un vérificateur indépendant et adversarial (recalcul, relecture de preuve, contrôle des sources/citations, exécution de code). Utilise-le pour tout résultat clé avant de le considérer établi. Si note_slug est fourni, le verdict est attaché à la note et fait monter son niveau (relu, ou contrôlé par calcul si le vérificateur a exécuté du code). kind="formalization" : fait juger si un énoncé Lean (challenge de lean_check, chemin dans context) dit exactement ce qu\'affirme la note.',
    parameters: S.obj({
      claim: S.str('Affirmation précise à vérifier'),
      kind: S.enum(['math', 'code', 'citation', 'empirical', 'logic', 'general', 'formalization'], 'Nature de la vérification (formalization = fidélité d\'un énoncé Lean à la note)'),
      context: S.str('Éléments de preuve, calculs, sources, fichiers à examiner'),
      note_slug: S.str('Note à laquelle attacher le verdict (optionnel)'),
    }, ['claim']),
    roles: ['lead', 'theorist', 'experimenter', 'scout'],
    parallel: true,
    timeoutMs: d => Math.max(d * 2, 3_600_000),
    execute: async (args, ctx) => {
      const { report } = await ctx.runtime.verify({
        claim: argStr(args, 'claim'),
        kind: argStr(args, 'kind', 'general'),
        context: argStr(args, 'context', ''),
        noteSlug: typeof args.note_slug === 'string' ? args.note_slug : undefined,
        parent: ctx.agent,
        signal: ctx.signal,
      })
      return report
    },
  },
  {
    name: 'send_message',
    category: 'agents',
    description: 'Envoie un message sur le bus inter-agents (ex: répondre au superviseur, informer le chercheur principal). Destinataires: "lead", "supervisor", ou un id d\'agent.',
    parameters: S.obj({ to: S.str('Destinataire'), content: S.str('Message') }, ['to', 'content']),
    execute: async (args, ctx) => {
      const to = argStr(args, 'to')
      const recipient = to === 'lead' ? `lead_${ctx.project.id}` : to
      ctx.runtime.sendMessage({ from: ctx.agent.id, to: recipient, content: argStr(args, 'content'), kind: 'reply' })
      return `Message envoyé à ${to}.`
    },
  },
  {
    name: 'ask_human',
    category: 'human',
    description: 'Pose une question à l\'humain (notification Windows envoyée). blocking=true met la recherche en pause jusqu\'à la réponse — à réserver aux décisions structurantes (choix de direction, ambiguïté de la question, accès à une ressource). Sinon, continue et la réponse arrivera comme message.',
    parameters: S.obj({
      question: S.str('Question claire, avec le contexte nécessaire pour répondre vite'),
      options: S.arr({ type: 'string' }, 'Choix proposés (optionnel)'),
      blocking: S.bool('Attendre la réponse (défaut false)'),
    }, ['question']),
    roles: ['lead'],
    timeoutMs: 0,
    execute: async (args, ctx) => {
      const question = argStr(args, 'question')
      const blocking = argBool(args, 'blocking', false)
      const req = await ctx.runtime.askHuman({
        kind: 'question',
        title: question.split('\n')[0].slice(0, 140),
        body: question,
        options: argList(args, 'options'),
        blocking,
        agent: ctx.agent,
        signal: ctx.signal,
      })
      if (!blocking) return `Question envoyée (${req.id}). Continue; la réponse arrivera comme message.`
      return req.status === 'resolved' ? `Réponse de l'humain: ${req.response}` : 'L\'humain a ignoré la question. Décide toi-même de façon raisonnable et note ce choix.'
    },
  },
  {
    name: 'notify_human',
    category: 'human',
    description: 'Envoie une notification (toast Windows + dashboard) pour signaler une avancée majeure ou un résultat important. Ne pas en abuser.',
    parameters: S.obj({ title: S.str('Titre court'), message: S.str('Message') }, ['title', 'message']),
    roles: ['lead'],
    execute: async (args, ctx) => {
      notify(ctx.project.id, argStr(args, 'title'), argStr(args, 'message'), 'success', 'finding')
      return 'Notification envoyée.'
    },
  },
  {
    name: 'write_report',
    category: 'report',
    description: 'Écrit (ou réécrit) un rapport markdown dans reports/. Rapport final attendu : résumé exécutif (avec le périmètre réellement traité), question, méthode, section « Livrables » (état de chacun), résultats (chacun relié à ses notes [[slug]] et sources [clé]), discussion, limites du résultat ET du processus, pistes. Ne rédige ni tableau de confiance, ni bibliographie : une annexe générée depuis la base les ajoute (statuts réels, sources lues / non lues). LaTeX autorisé ($…$, $$…$$). Puis report_audit.',
    parameters: S.obj({ title: S.str('Titre'), content: S.str('Contenu markdown complet'), filename: S.str('Nom de fichier (optionnel)') }, ['title', 'content']),
    roles: ['lead', 'scout', 'theorist', 'experimenter', 'critic'],
    execute: async (args, ctx) => {
      const name = `${(typeof args.filename === 'string' && args.filename ? args.filename : slugify(argStr(args, 'title'))).replace(/\.md$/, '')}.md`
      const file = path.join(ctx.workspace, 'reports', name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const content = argStr(args, 'content')
      fs.writeFileSync(file, content.startsWith('#') ? content : `# ${argStr(args, 'title')}\n\n${content}`, 'utf8')
      bus.publish(ctx.project.id, { type: 'files.changed' })
      return `Rapport écrit: reports/${name} (${content.length} caractères)`
    },
  },
  {
    name: 'finish_research',
    category: 'report',
    description: 'Termine la session de recherche autonome. Le rapport final est d\'abord AUDITÉ automatiquement (citations vs bibliothèque, notes réfutées/invalidées, vérifications revendiquées, livrables de la question, contradictions) : s\'il reste des problèmes bloquants, la clôture est refusée et l\'audit t\'est renvoyé pour correction. Lance report_audit avant pour gagner du temps. Une annexe générée depuis la base (vérifications réelles, bibliographie lue/non lue, limites du processus) est ajoutée au rapport.',
    parameters: S.obj({
      summary: S.str('Bilan: réponse obtenue, niveau de confiance, rapport, questions ouvertes'),
      report: S.str('Fichier du rapport final dans reports/ (défaut : le plus récent)'),
      contested: S.arr({ type: 'string' }, 'Points de l\'audit que tu estimes être des faux positifs, chacun avec sa justification vérifiable (ex. « 31 % : chiffre de [[note-v2]], vérifiée »). Accepté seulement après un premier audit ; consigné tel quel dans l\'annexe du rapport, lue par l\'humain.'),
    }, ['summary']),
    roles: ['lead'],
    timeoutMs: d => Math.max(d, 600_000),
    execute: async (args, ctx) => {
      const audit = await ctx.runtime.auditReport({ file: typeof args.report === 'string' ? args.report : undefined, agent: ctx.agent, signal: ctx.signal, final: true, contested: argList(args, 'contested') })
      if (!audit.accept) return { status: 'error', content: `Clôture refusée : le rapport final doit d'abord être corrigé.\n\n${audit.text}\n\n→ Corrige les points BLOQUANTS du rapport (write_report, même nom de fichier), puis rappelle finish_research. Si un point est un faux positif de l'audit, ne réécris pas le rapport en boucle : rappelle finish_research avec contested=[« point : justification »].` }
      ctx.runtime.finish({ agent: ctx.agent, summary: argStr(args, 'summary') })
      return { content: `Recherche marquée comme terminée. ${audit.file ? `Annexe d'audit ajoutée à ${audit.file}.` : ''}\n\n${audit.text}`, stop: true }
    },
  },
  {
    name: 'report_audit',
    category: 'report',
    description: 'Audite un rapport avant de le finaliser : citations inexistantes ou mal titrées, sources citées mais jamais lues, notes réfutées/invalidées utilisées, vérifications revendiquées à tort, chiffres sans source ou issus de notes réfutées, livrables de la question non traités, contradictions internes, surinterprétations. À lancer après chaque version du rapport final.',
    parameters: S.obj({ report: S.str('Fichier dans reports/ (défaut : le plus récent)') }),
    roles: ['lead', 'critic'],
    timeoutMs: d => Math.max(d, 600_000),
    execute: async (args, ctx) => {
      const audit = await ctx.runtime.auditReport({ file: typeof args.report === 'string' ? args.report : undefined, agent: ctx.agent, signal: ctx.signal })
      return { content: audit.text, status: audit.accept ? 'ok' : 'error' }
    },
  },
  {
    name: 'submit_result',
    category: 'report',
    description: 'Rend ton rapport final au chercheur principal et termine ta mission. Le rapport doit être CONDENSÉ et autonome: résultats clés, preuves/sources (clés de citation, slugs de notes, fichiers), niveau de confiance, ce qui reste incertain. Pas de remplissage.',
    parameters: S.obj({ report: S.str('Rapport condensé (markdown)') }, ['report']),
    roles: ['scout', 'experimenter', 'theorist', 'critic', 'librarian'],
    execute: async args => ({ content: argStr(args, 'report'), stop: true }),
  },
  {
    name: 'submit_verdict',
    category: 'report',
    description: 'Rends ton verdict de vérification et termine.',
    parameters: S.obj({
      verdict: S.enum(['supported', 'refuted', 'uncertain'], 'supported = vérifié; refuted = faux; uncertain = impossible de conclure'),
      confidence: S.num('Confiance dans le verdict 0..1'),
      summary: S.str('Justification concise (ce que tu as vérifié et comment)'),
      issues: S.arr({ type: 'string' }, 'Erreurs, lacunes ou réserves trouvées'),
    }, ['verdict', 'confidence', 'summary']),
    roles: ['verifier'],
    execute: async args => ({ content: JSON.stringify({ verdict: args.verdict, confidence: args.confidence, summary: args.summary, issues: argList(args, 'issues') }), stop: true }),
  },
]
