import type { HypothesisStatus } from '../../../shared/types.ts'
import { createHypothesis, HYPOTHESIS_STATUSES, listHypotheses, updateHypothesis } from '../../store/hypotheses.ts'
import { argNum, argStr, S } from '../types.ts'
import type { ToolDef } from '../types.ts'

export const hypothesisTools: ToolDef[] = [
  {
    name: 'hypothesis_add',
    category: 'hypotheses',
    description: 'Enregistre une hypothèse testable dans le registre (avec justification et plan de test). Formule-la de façon falsifiable.',
    parameters: S.obj({
      statement: S.str('Énoncé précis et falsifiable'),
      rationale: S.str('Pourquoi elle est plausible (sources, intuition, analogie)'),
      test_plan: S.str('Comment la tester / la réfuter (calcul, expérience, preuve, littérature)'),
    }, ['statement']),
    execute: async (args, ctx) => {
      const h = createHypothesis(ctx.project.id, { statement: argStr(args, 'statement'), rationale: argStr(args, 'rationale', ''), testPlan: argStr(args, 'test_plan', '') }, ctx.agent.id)
      return `Hypothèse ${h.id} enregistrée (Elo initial 1200).`
    },
  },
  {
    name: 'hypothesis_update',
    category: 'hypotheses',
    description: 'Met à jour une hypothèse : statut (proposed/testing/supported/refuted/abandoned) et/ou ajout d\'une preuve pour ou contre.',
    parameters: S.obj({
      id: S.str('Identifiant hyp_…'),
      status: S.enum(HYPOTHESIS_STATUSES, 'Nouveau statut'),
      evidence: S.str('Preuve / observation à ajouter'),
      stance: S.enum(['for', 'against'], 'La preuve soutient (for) ou contredit (against)'),
      ref: S.str('Référence: slug de note, clé de source, fichier…'),
      statement: S.str('Énoncé reformulé (optionnel)'),
      test_plan: S.str('Plan de test mis à jour (optionnel)'),
    }, ['id']),
    execute: async (args, ctx) => {
      const h = updateHypothesis(ctx.project.id, argStr(args, 'id'), {
        status: typeof args.status === 'string' ? (args.status as HypothesisStatus) : undefined,
        statement: typeof args.statement === 'string' ? args.statement : undefined,
        testPlan: typeof args.test_plan === 'string' ? args.test_plan : undefined,
        evidence: typeof args.evidence === 'string' && args.evidence
          ? { stance: args.stance === 'against' ? 'against' : 'for', text: args.evidence, ref: typeof args.ref === 'string' ? args.ref : undefined }
          : undefined,
      })
      return `Hypothèse ${h.id}: statut ${h.status}, ${h.evidence.filter(e => e.stance === 'for').length} pour / ${h.evidence.filter(e => e.stance === 'against').length} contre.`
    },
  },
  {
    name: 'hypothesis_list',
    category: 'hypotheses',
    description: 'Liste les hypothèses classées par score Elo, avec statut et preuves.',
    parameters: S.obj({}),
    parallel: true,
    execute: async (_args, ctx) => {
      const list = listHypotheses(ctx.project.id)
      if (!list.length) return 'Aucune hypothèse.'
      return list.map(h => `${h.id} [${h.status}] Elo ${h.elo} (${h.matches} duels)\n  ${h.statement}\n  pour: ${h.evidence.filter(e => e.stance === 'for').map(e => e.text).join(' | ') || '—'}\n  contre: ${h.evidence.filter(e => e.stance === 'against').map(e => e.text).join(' | ') || '—'}`).join('\n')
    },
  },
  {
    name: 'hypothesis_tournament',
    category: 'hypotheses',
    description: 'Lance un tournoi de débats par paires entre les hypothèses actives (juge = vérificateur) et met à jour les scores Elo. Utile pour prioriser quand il y a ≥3 hypothèses concurrentes.',
    parameters: S.obj({ rounds: S.int('Nombre de duels (défaut 6, max 20)') }),
    roles: ['lead'],
    timeoutMs: d => Math.max(d, 1_800_000),
    execute: async (args, ctx) => ctx.runtime.tournament({ rounds: Math.min(20, argNum(args, 'rounds', 6)), parent: ctx.agent, signal: ctx.signal }),
  },
]
