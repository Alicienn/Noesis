# Architecture de Noesis

## Choix techniques

| Décision | Choix | Pourquoi |
|---|---|---|
| Backend | **Fastify + TypeScript** exécuté par `tsx` | Le backend porte des processus longs : boucles d'agents de plusieurs heures, sous-processus shell et Python, flux SSE, connexions MCP. Un serveur Node classique s'y prête mieux qu'un framework orienté rendu (Next.js), dont les fonctions de route ne sont pas faites pour des tâches d'arrière-plan persistantes. |
| Frontend | **Vite + React 19 + Tailwind v4 + zustand** | C'est une application monopage locale : pas de SEO, pas de rendu côté serveur. Vite offre un rechargement instantané et un build statique servi par Fastify. |
| Base | **SQLite via `node:sqlite`** (WAL + FTS5) | Aucun module natif à compiler sous Windows. Le BM25 plein texte est inclus. Un seul fichier facile à sauvegarder. |
| Temps réel | **SSE** (Server-Sent Events) | Le flux est unidirectionnel (serveur → interface), la reconnexion est automatique, et il n'y a pas de dépendance supplémentaire. |
| LLM | Clients maison, **OpenAI Chat Completions** et **Anthropic Messages** | Ils donnent un contrôle fin : streaming du raisonnement (`reasoning_content`, balises `<think>`), appels d'outils parallèles, renvoi du raisonnement à DeepSeek, retries exponentiels. Les paramètres optionnels refusés par un endpoint (`stream_options`, `max_tokens` vs `max_completion_tokens`, `temperature`…) sont adaptés automatiquement. |
| Outils externes | **MCP** (`@modelcontextprotocol/sdk`) | Brancher l'écosystème existant sans code spécifique. |
| PDF | **unpdf** (build serverless de pdf.js) | Pur JavaScript, extraction page par page. |
| HTML → Markdown | **Readability + linkedom + turndown** | Lecture propre des pages. Jina Reader sert de repli. |

## Flux d'une étape d'agent (`server/agents/runner.ts`)

```
 ┌─ boîte de réception (bus) ─→ messages « Humain / Superviseur / Vérificateur / Agent »
 │
 ├─ construction du contexte (agents/context.ts)
 │    [system]  prompt du rôle + mémoire centrale + aperçu mémoire + épisodes compactés
 │    [history] messages vivants, vieux résultats d'outils volumineux effacés
 │    [tail]    rappel d'état (étape, contexte, prochaine action, demandes en attente)
 │
 ├─ si contexte > compactAt × fenêtre → compaction
 │    résumé cumulatif (épisode) + extraction des faits durables en notes
 │
 ├─ appel LLM en streaming → événements llm.delta vers l'interface
 │
 ├─ appels d'outils
 │    appels consécutifs marqués « parallel » → exécution concurrente
 │    contrôle des permissions → éventuelle demande d'approbation bloquante
 │    sorties > 24 000 caractères → tronquées dans le contexte, version complète dans artifacts/
 │
 └─ après l'étape (lead)
      superviseur toutes les N étapes, ou si boucle détectée
      consolidation de la mémoire toutes les 30 étapes
      budget de tokens
```

## Orchestrateur (`server/agents/orchestrator.ts`)

Il implémente l'interface `AgentRuntime` que les outils utilisent : `delegate`, `verify`, `tournament`, `askHuman`, `sendMessage` et `finish`. Les outils ne dépendent donc jamais de l'orchestrateur, ce qui évite les cycles d'imports et permet de les tester avec un faux runtime.

- **Délégation** : un sous-agent est une `AgentLoop` avec son propre prompt (`subagent.md`, plus la section du rôle dans `roles.md`), un jeu d'outils restreint et un budget d'étapes. Un sémaphore par projet limite les agents concurrents. Si le budget est épuisé, un rapport final est exigé.
- **Vérification automatique** : un hook sur `note.upserted` lance le vérificateur pour toute nouvelle note `finding` d'importance ≥ 4. Le verdict est attaché à la note et envoyé au chercheur principal.
- **Superviseur** : un appel structuré en JSON qui reçoit la trajectoire récente, le plan et les statistiques. Il produit un diagnostic, des suggestions, un message et des leçons. Les leçons alimentent le bloc `lessons` (méta-revue façon co-scientist).
- **Bibliothécaire** : un appel JSON qui propose des opérations (`link`, `supersede`, `merge`, `insight`, `adjust`, `lesson`). Elles sont exécutées de façon défensive.
- **Humain** : les demandes bloquantes passent l'agent en `waiting` et le projet en `waiting_human`. Elles sont résolues par l'API (réponse, PDF déposé, approbation).

## Documents fournis par l'humain

- **Envoi** (`POST /api/projects/:id/documents`, multipart, un ou plusieurs fichiers). Chaque fichier est écrit en flux dans `inputs/`, avec calcul du SHA-256 au passage. Il n'y a pas de limite de taille ; au-delà de 150 Mo, le fichier est stocké mais pas indexé. Un contenu déjà présent n'est pas ajouté deux fois.
- **Extraction** (`services/documents.ts`) :
  - le PDF passe toujours par l'extracteur page par page ;
  - pour les formats Office, EPUB, HTML, notebooks, Outlook, ZIP et audio, MarkItDown est essayé d'abord s'il est installé (`services/markitdown.ts`) ; ses diapositives et feuilles sont redécoupées en pages ;
  - sinon, un lecteur ZIP/XML intégré prend le relais (docx avec titres et tableaux, pptx avec notes, xlsx par feuille, ODF, EPUB dans l'ordre de lecture), ainsi que Readability pour le HTML et une détection de texte et d'encodage.
- **Stockage** (`store/documents.ts`) : une source `origin = 'human'`, `file = inputs/…`, clé `doc-…`. Le texte est indexé dans FTS5 comme pour les autres sources.
- **Agents** :
  - `providedDocumentsSection` (`agents/context.ts`) liste les documents dans les prompts du chercheur principal, des sous-agents et du superviseur. Ceux qui n'ont pas encore été ouverts passent en premier ; « ouvert » se déduit des `tool_runs`.
  - Le message de démarrage les mentionne.
  - `orchestrator.onDocumentsProvided` regroupe les ajouts faits en cours de recherche en un seul message au chercheur principal.
  - `pendingDuties` rappelle les documents jamais ouverts.
- **Interface** (`components/Documents.tsx`, `store/uploads.ts`) : zone de dépôt (fichiers et dossiers récursifs), overlay de dépôt sur toute la page projet, panneau d'envoi avec progression par fichier (XHR) et bouton pour réessayer. Les éléments `data-own-drop` gardent leur propre comportement de dépôt.

## Niveaux de vérification et vérification formelle

Repris du dépôt [openai/math](https://github.com/openai/math), qui publie ses résultats « à différents stades de vérification » et vérifie les formalisations Lean avec [Comparator](https://github.com/leanprover/comparator).

- **Échelle** (`Note.assurance`, colonne `notes.assurance`) : `claimed` → `reviewed` → `computed` → `formal`. Elle ne monte que sur des faits enregistrés en base, jamais sur une affirmation du modèle :
  - `reviewed` : verdict `supported` du vérificateur ;
  - `computed` : même verdict, et le vérificateur a exécuté au moins un `python`, `bash`, `lean_run` ou `lean_check` réussi (table `tool_runs`) ;
  - `formal` : `lean_check` accepté par Comparator.

  Une réfutation ramène une note non formelle à `claimed`. Une preuve Lean n'est pas défaite par un verdict LLM : le conflit est signalé, car il indique en général un énoncé Lean infidèle. La relecture humaine (`humanReview`) est enregistrée à part et peut porter sur le résultat ou sur la fidélité de l'énoncé Lean. L'historique complet est conservé.
- **Environnement Lean** (`services/lean.ts`) : Lean 4, Mathlib précompilée, Comparator, lean4export et landrun, installés une seule fois dans WSL par `scripts/lean/setup-wsl.sh` (environ 12 Go) dans un espace Lake partagé `~/noesis-lean`. Les scripts passent par l'entrée standard de `wsl.exe -- bash -s`, ce qui évite les problèmes de guillemets Windows. Chaque tâche tourne dans son propre groupe de processus (`setsid`) : une annulation ou un timeout tue bien lake, lean et comparator. Pendant un run avec formalisation, WSL est maintenu éveillé et Mathlib est préchargée : environ 4 s par compilation au lieu de 45 s à froid.
- **Outils** (`tools/builtin/lean.ts`, catégorie `formal`) :
  - `lean_run` : boucle de mise au point ;
  - `lean_search` : grep dans Mathlib ;
  - `lean_check` : verdict de Comparator.

  Ils ne sont proposés que si l'environnement est prêt et que le projet a `config.formal` à `preferred` ou `required`. Chaque vérification est archivée dans `lean/checks/<id>/` (Challenge, Solution, config, log) et dans la table `lean_checks`.
- **Fidélité de l'énoncé** : `verify_claim(kind="formalization")` juge si le Challenge dit exactement ce que dit la note. Le verdict va dans `assurance.lean.statementReview`, pas dans la vérification de la note. Un énoncé infidèle fait perdre le niveau `formal`.
- **Problème posé** (`config.kind = 'problem'`) : gabarit dans la fenêtre « Nouvelle recherche » (énoncé autonome, résolution ou réfutation, portée figée) et protocole `prompts/problem.md` dans le prompt du chercheur principal.

## Publication (`agents/publication.ts`)

- **Résumé du raisonnement** (`reports/_resume-raisonnement.md`, généré à la fin d'une recherche ou à la demande) : récit en sections, sur le modèle des « reasoning summaries » d'openai/math. Le modèle choisit des extraits verbatim **par numéro** parmi des phrases réelles des agents tirées de la base ; il ne les écrit jamais. Le préfixe `_` exclut ce fichier de l'audit du rapport final.
- **Export versionné** (`publication/vN/`) :
  - `manuscript.tex` (conversion Markdown → LaTeX de `services/latex.ts` : `[clé]` → `\cite`, maths conservées, LuaLaTeX) ;
  - `references.bib` ;
  - `reasoning-summary.tex` ;
  - `formalization.yaml` (schéma mathlib-initiative v0.4, `main_results` liés aux configs Comparator) ;
  - `lean/<id>/` ;
  - un README avec le niveau de chaque résultat.

  Une version n'est jamais réécrite : une correction en crée une nouvelle (`CHANGELOG.md`).
- **Résultats antérieurs** (`prior_results`) : recherche dans les notes vérifiées des autres projets, et import avec provenance et niveau d'origine.

## Ajouter une capacité

- **Un outil** : ajouter un `ToolDef` dans `server/tools/builtin/*.ts` (schéma JSON, catégorie, `parallel`, `risk`, `execute`). La catégorie détermine quels rôles y ont accès (`tools/registry.ts`).
- **Un rôle de sous-agent** : ajouter une section `## role` dans `prompts/roles.md`, le rôle dans `shared/types.ts` et ses catégories d'outils dans le registre.
- **Un moteur de recherche** : ajouter une entrée dans `services/search.ts`.
- **Un protocole LLM** : ajouter un client dans `server/llm/` et le brancher dans `llm/client.ts`.
- **Des outils tiers** : ajouter un serveur MCP depuis l'interface, sans code.

## Données

```
data/
  noesis.db                      SQLite (WAL)
  projects/<id>/workspace/
    memory/  MEMORY.md, MISSION.md, PLAN.md, WORKING.md, HUMAN.md, LESSONS.md, notes/*.md, episodes/*.md
    inputs/  documents fournis par l'humain (originaux, exploitables par python/bash)
    sources/ <clé>.pdf, <clé>.txt   (texte extrait avec marqueurs de pages)
    reports/ rapports markdown (+ _resume-raisonnement.md)
    scratch/ scripts Python générés
    artifacts/ figures, sorties complètes d'outils
    lean/    scratch/ (brouillons lean_run), checks/<id>/ (Challenge, Solution, config, log Comparator)
    publication/ v1/, v2/… (manuscrit, BibTeX, formalization.yaml, Lean), CHANGELOG.md

WSL : ~/noesis-lean/        espace Lake partagé (Mathlib précompilée, Checks/, Scratch/)
      ~/.local/bin/          comparator, lean4export, landrun
```
