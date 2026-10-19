import { ArrowRight, BookOpen, Brain, FlaskConical, Lightbulb, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { FormalPolicy, ProblemSpec, ProjectConfig, ProjectKind, RunMode } from '@shared/types'
import { api } from '../lib/api'
import { fmtAgo, fmtTokens, PROJECT_STATUS } from '../lib/format'
import { useApp } from '../store/app'
import { Badge, Button, Field, Input, Modal, Select, Tabs, Textarea, Toggle, cx } from '../components/ui'
import { StatusDot } from '../layout/AppShell'
import { DocumentDropzone, PendingFiles } from '../components/Documents'
import { useUploads } from '../store/uploads'

const EXAMPLES = [
  { title: 'Codes correcteurs quantiques', domain: 'Physique quantique', question: 'Quelles familles de codes LDPC quantiques offrent aujourd\'hui le meilleur compromis entre taux, distance et seuil sous bruit circuit-level, et quelles pistes concrètes pourraient améliorer les décodeurs temps réel ?' },
  { title: 'Contrôle de congestion', domain: 'Réseaux', question: 'Peut-on concevoir un algorithme de contrôle de congestion qui atteigne l\'équité de BBRv3 tout en réduisant la latence de file d\'attente sur des liens 5G à capacité très variable ? Proposer, analyser et simuler.' },
  { title: 'Conjecture combinatoire', domain: 'Mathématiques', question: 'Étudier la conjecture des ensembles union-closed (Frankl) : état de l\'art des bornes, techniques entropiques récentes, et tentative d\'amélioration de la constante.' },
]

export function Home() {
  const projects = useApp(s => s.projects)
  const loadProjects = useApp(s => s.loadProjects)
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(params.get('new') === '1')

  useEffect(() => {
    if (params.get('new') === '1') {
      setOpen(true)
      params.delete('new')
      setParams(params, { replace: true })
    }
  }, [params, setParams])

  const running = projects.filter(p => p.status === 'running' || p.status === 'waiting_human').length
  const totals = projects.reduce((a, p) => ({ notes: a.notes + (p.stats?.notes ?? 0), sources: a.sources + (p.stats?.sources ?? 0), tokens: a.tokens + (p.stats?.promptTokens ?? 0) + (p.stats?.completionTokens ?? 0) }), { notes: 0, sources: 0, tokens: 0 })

  return (
    <div className="graph-paper h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 pb-16 pt-10">
        <header className="flex flex-wrap items-end justify-between gap-6 animate-rise">
          <div>
            <div className="kicker mb-2">Laboratoire · {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <h1 className="display text-[44px] font-semibold leading-[1.05] text-paper">
              Recherches <span className="text-amber">en cours</span>
            </h1>
            <p className="mt-3 max-w-xl text-[14px] text-ink-300">
              Des agents autonomes qui cherchent, lisent, calculent, vérifient et consignent — avec une mémoire qui s'accumule de session en session.
            </p>
          </div>
          <div className="flex items-stretch gap-px overflow-hidden rounded-lg border border-ink-750 bg-ink-750">
            {[
              { k: 'actives', v: running },
              { k: 'notes', v: totals.notes },
              { k: 'sources', v: totals.sources },
              { k: 'tokens', v: fmtTokens(totals.tokens) },
            ].map(s => (
              <div key={s.k} className="bg-ink-900 px-5 py-3">
                <div className="display text-[26px] leading-none text-paper">{s.v}</div>
                <div className="kicker mt-1.5">{s.k}</div>
              </div>
            ))}
          </div>
        </header>

        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <button
            onClick={() => setOpen(true)}
            className="group flex min-h-[200px] flex-col justify-between rounded-xl border border-dashed border-ink-600 bg-ink-900/40 p-5 text-left transition-all hover:border-amber/60 hover:bg-ink-900 cursor-pointer animate-rise"
          >
            <div className="flex size-10 items-center justify-center rounded-lg border border-amber/40 bg-amber-soft text-amber transition-transform group-hover:scale-105">
              <Plus className="size-5" />
            </div>
            <div>
              <div className="display text-[20px] text-paper">Nouvelle recherche</div>
              <div className="mt-1 text-[12.5px] text-ink-400">Pose une question ouverte ; l'équipe d'agents s'occupe du reste.</div>
            </div>
          </button>
          {projects.map((p, i) => (
            <ProjectCard key={p.id} project={p} delay={i} onDeleted={loadProjects} />
          ))}
        </div>
      </div>
      <NewProjectModal open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

function ProjectCard({ project: p, delay, onDeleted }: { project: ReturnType<typeof useApp.getState>['projects'][number]; delay: number; onDeleted: () => void }) {
  const st = PROJECT_STATUS[p.status]
  return (
    <Link
      to={`/p/${p.id}`}
      style={{ animationDelay: `${Math.min(delay, 8) * 40}ms` }}
      className={cx(
        'group relative flex min-h-[200px] flex-col overflow-hidden rounded-xl border bg-ink-900 p-5 transition-all animate-rise hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-20px_#000]',
        st.live ? 'border-amber/40' : 'border-ink-750 hover:border-ink-600',
      )}
    >
      {st.live ? <div className="shimmer pointer-events-none absolute inset-x-0 top-0 h-px" /> : null}
      <div className="flex items-center justify-between gap-2">
        <Badge tone={st.tone}><StatusDot status={p.status} className="size-1.5" />{st.label}</Badge>
        <span className="text-[11px] text-ink-500">{fmtAgo(p.updatedAt)}</span>
      </div>
      <h3 className="display mt-3 text-[19px] leading-snug text-paper">{p.title}</h3>
      {p.domain ? <div className="kicker mt-1 !text-amber/70">{p.domain}</div> : null}
      <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-ink-300">{p.question}</p>
      <div className="mt-auto flex items-center gap-4 pt-4 text-[11.5px] text-ink-400">
        <span className="flex items-center gap-1"><Brain className="size-3.5" />{p.stats?.notes ?? 0}</span>
        <span className="flex items-center gap-1"><BookOpen className="size-3.5" />{p.stats?.sources ?? 0}</span>
        <span className="flex items-center gap-1"><Lightbulb className="size-3.5" />{p.stats?.hypotheses ?? 0}</span>
        <span className="flex items-center gap-1 font-mono">{fmtTokens((p.stats?.promptTokens ?? 0) + (p.stats?.completionTokens ?? 0))} tok</span>
        <button
          onClick={async e => {
            e.preventDefault()
            if (!confirm(`Supprimer définitivement « ${p.title} » et tout son workspace ?`)) return
            await api.deleteProject(p.id)
            onDeleted()
          }}
          title="Supprimer"
          className="ml-auto rounded-md p-1 text-ink-600 opacity-0 transition-opacity hover:text-brick group-hover:opacity-100 cursor-pointer"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </Link>
  )
}

const EMPTY_PROBLEM: ProblemSpec = { statement: '', definitions: '', references: '', scope: '', noBruteForce: true }

/**
 * The "problem" template (after the prompts published with openai/math): a
 * self-contained statement, resolution OR refutation accepted, frozen scope.
 */
export function composeProblem(p: ProblemSpec): string {
  const section = (title: string, body: string): string => (body.trim() ? `\n\n# ${title}\n${body.trim()}` : '')
  return [
    'Donne une solution complète et rigoureuse au problème suivant. Même si le problème est réputé ouvert, l\'intention est que tu le résolves et que tu présentes une solution complète.',
    `La solution peut être une résolution complète et rigoureuse, ou une réfutation rigoureuse et bien présentée.${p.noBruteForce ? ' Les énumérations exhaustives et les preuves assistées par ordinateur sont fortement déconseillées dans la rédaction finale.' : ''}`,
  ].join('\n\n')
    + section('Problème', p.statement)
    + section('Définitions et conventions', p.definitions)
    + section('Références', p.references)
    + section('Portée (ce qui est demandé, ce qui ne l\'est pas)', p.scope)
}

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const toast = useApp(s => s.toast)
  const [title, setTitle] = useState('')
  const [domain, setDomain] = useState('')
  const [question, setQuestion] = useState('')
  const [kind, setKind] = useState<ProjectKind>('research')
  const [problem, setProblem] = useState<ProblemSpec>(EMPTY_PROBLEM)
  const [formal, setFormal] = useState<FormalPolicy>('off')
  const [leanReady, setLeanReady] = useState<boolean>()
  useEffect(() => {
    if (open) api.lean().then(s => setLeanReady(s.available)).catch(() => setLeanReady(false))
  }, [open])
  const setP = (patch: Partial<ProblemSpec>): void => setProblem(p => ({ ...p, ...patch }))
  const finalQuestion = kind === 'problem' ? composeProblem(problem) : question
  const ready = kind === 'problem' ? Boolean(problem.statement.trim()) : Boolean(question.trim())
  const [mode, setMode] = useState<RunMode>('autonomous')
  const [permission, setPermission] = useState<ProjectConfig['permission']>('smart')
  const [maxSteps, setMaxSteps] = useState(300)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  const create = async (start: boolean): Promise<void> => {
    setBusy(true)
    try {
      // with documents, start only once they are uploaded and indexed so the lead sees them from step one
      const p = await api.createProject({ title: title || (kind === 'problem' ? problem.statement : question).slice(0, 60), domain, question: finalQuestion, config: { mode, permission, maxSteps, kind, formal }, start: start && !files.length })
      if (files.length) {
        void useUploads.getState().enqueue(p.id, files).then(async items => {
          const failed = items.filter(i => i.status === 'error').length
          if (failed) toast({ title: `${failed} document(s) non ajouté(s)`, body: 'Réessaie depuis le panneau d\'envoi ou l\'onglet Sources.', level: 'warn' })
          if (start) await api.start(p.id).catch(error => toast({ title: 'Lancement impossible', body: (error as Error).message, level: 'error' }))
        })
      }
      onClose()
      setTitle('')
      setQuestion('')
      setDomain('')
      setFiles([])
      setProblem(EMPTY_PROBLEM)
      navigate(`/p/${p.id}`)
    } catch (error) {
      toast({ title: 'Création impossible', body: (error as Error).message, level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nouvelle recherche"
      subtitle="Une question précise et ambitieuse donne les meilleurs résultats. Tu pourras tout ajuster ensuite."
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={() => void create(false)} disabled={!ready} loading={busy}>Créer sans lancer</Button>
          <Button variant="primary" onClick={() => void create(true)} disabled={!ready} loading={busy} title={files.length ? 'La recherche démarre dès que les documents sont indexés' : undefined}>
            <FlaskConical className="size-4" /> Lancer la recherche{files.length ? ` · ${files.length} doc${files.length > 1 ? 's' : ''}` : ''}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Tabs<ProjectKind>
          value={kind}
          onChange={k => {
            setKind(k)
            setFormal(k === 'problem' ? 'preferred' : 'off')
          }}
          items={[{ value: 'research', label: 'Recherche ouverte' }, { value: 'problem', label: 'Problème posé (prouver ou réfuter)' }]}
        />
        {kind === 'research' ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map(ex => (
                <button key={ex.title} onClick={() => { setTitle(ex.title); setDomain(ex.domain); setQuestion(ex.question) }} className="flex items-center gap-1.5 rounded-full border border-ink-700 px-2.5 py-1 text-[11.5px] text-ink-300 transition-colors hover:border-amber/50 hover:text-amber cursor-pointer">
                  <Sparkles className="size-3" />{ex.title}
                </button>
              ))}
            </div>
            <Field label="Question de recherche" hint="Contexte, contraintes, ce que tu attends comme livrable…">
              <Textarea rows={6} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ex : Existe-t-il une borne inférieure meilleure que … pour … ? Proposer une approche, la tester numériquement et la prouver si possible." autoFocus />
            </Field>
          </>
        ) : (
          <>
            <Field label="Énoncé" hint="Autonome et précis : l'affirmation à prouver ou à réfuter, avec ses hypothèses. LaTeX accepté ($…$).">
              <Textarea rows={5} value={problem.statement} onChange={e => setP({ statement: e.target.value })} placeholder="Ex : Prouver ou réfuter : pour tout entier n ≥ 2, …" autoFocus />
            </Field>
            <Field label="Définitions et conventions" hint="Tout ce qu'il faut pour que l'énoncé n'ait qu'une lecture (objets, normalisations, cas limites).">
              <Textarea rows={3} value={problem.definitions} onChange={e => setP({ definitions: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Références" hint="Article d'où vient le problème, numéros d'équations ou de théorèmes.">
                <Textarea rows={3} value={problem.references} onChange={e => setP({ references: e.target.value })} />
              </Field>
              <Field label="Portée" hint="Ce qui est demandé et ce qui ne l'est pas (ex. « aucune borne explicite n'est exigée »).">
                <Textarea rows={3} value={problem.scope} onChange={e => setP({ scope: e.target.value })} />
              </Field>
            </div>
            <Toggle checked={problem.noBruteForce} onChange={v => setP({ noBruteForce: v })} label="Déconseiller les énumérations et preuves assistées par ordinateur dans la rédaction finale" hint="Les calculs restent permis pour explorer et vérifier." />
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Titre"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Court et parlant" /></Field>
          <Field label="Domaine"><Input value={domain} onChange={e => setDomain(e.target.value)} placeholder="Mathématiques, physique, réseaux…" /></Field>
        </div>
        <Field label="Formalisation Lean" hint={leanReady === false ? 'Environnement Lean non installé (Paramètres → Vérification formelle) : les outils Lean resteront indisponibles.' : formal === 'off' ? 'Aucun outil Lean pour ce projet.' : formal === 'preferred' ? "Le résultat principal est formalisé et vérifié par Comparator quand c'est faisable." : "Le résultat principal doit être prouvé en Lean avant le rapport final (ou l'impossibilité expliquée)."}>
          <Select value={formal} onChange={e => setFormal(e.target.value as FormalPolicy)}>
            <option value="off">Désactivée</option>
            <option value="preferred">Si pertinent</option>
            <option value="required">Exigée</option>
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Mode" hint={mode === 'autonomous' ? 'L\'agent avance seul jusqu\'au rapport final.' : 'L\'agent rend la main après chaque tâche.'}>
            <Select value={mode} onChange={e => setMode(e.target.value as RunMode)}>
              <option value="autonomous">Autonome</option>
              <option value="interactive">Interactif</option>
            </Select>
          </Field>
          <Field label="Permissions" hint={{ auto: 'Tout est exécuté sans demander.', smart: 'Approbation pour les actions risquées.', ask: 'Approbation pour tout shell / Python.' }[permission]}>
            <Select value={permission} onChange={e => setPermission(e.target.value as ProjectConfig['permission'])}>
              <option value="smart">Intelligent</option>
              <option value="ask">Toujours demander</option>
              <option value="auto">Automatique</option>
            </Select>
          </Field>
          <Field label="Étapes max" hint="0 = illimité">
            <Input type="number" min={0} value={maxSteps} onChange={e => setMaxSteps(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Documents de contexte (optionnel)" hint="Articles, notes, données, code… Les agents les prennent en compte en plus de leur propre recherche, pas à la place.">
          <DocumentDropzone compact onFiles={f => setFiles(prev => [...prev, ...f])} />
          <PendingFiles files={files} onRemove={i => setFiles(prev => prev.filter((_, j) => j !== i))} onClear={() => setFiles([])} />
        </Field>
        <div className="flex items-center gap-2 rounded-md border border-ink-750 bg-ink-850 px-3 py-2 text-[12px] text-ink-400">
          <ArrowRight className="size-3.5 text-amber" />
          Les modèles utilisés se règlent dans Paramètres → Rôles (et peuvent être surchargés par projet).
        </div>
      </div>
    </Modal>
  )
}
