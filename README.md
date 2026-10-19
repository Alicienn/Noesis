<div align="center">

<img src="assets/logo.svg" alt="Noesis" width="560">

<br>

**Donne une question ambitieuse à une équipe d'IA. Récupère des résultats vérifiés, sourcés, et parfois prouvés en Lean.**

<br>

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)](https://react.dev)
[![Lean 4](https://img.shields.io/badge/Lean%204-Mathlib-7b61ff)](https://lean-lang.org)
[![SQLite](https://img.shields.io/badge/SQLite-local-003b57?logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![Fonctionne avec OpenAI et Anthropic](https://img.shields.io/badge/LLM-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20local-f2b544)](#choisir-ses-modèles)
[![Dernier commit](https://img.shields.io/github/last-commit/Alicienn/Noesis?color=5fb8a5)](https://github.com/Alicienn/Noesis/commits)
[![Stars](https://img.shields.io/github/stars/Alicienn/Noesis?style=flat&color=f2b544)](https://github.com/Alicienn/Noesis/stargazers)

</div>

---

## C'est quoi, Noesis ?

Noesis est un **laboratoire de recherche autonome** qui tourne sur ton ordinateur. Tu poses une question, tu choisis le modèle d'IA que tu veux (OpenAI, Anthropic, DeepSeek, un modèle local via Ollama…), et une équipe d'agents se met au travail : elle cherche dans la littérature, lit les articles, fait des calculs, vérifie ses propres conclusions et garde une trace de tout.

Tu suis l'avancement en direct dans un tableau de bord, et tu peux intervenir quand tu veux : poser une question à l'équipe, valider une action risquée, ou lui déposer un PDF.

Noesis est pensé pour la recherche de fond en **mathématiques, physique, informatique, réseaux et protocoles**, ou tout autre domaine où l'on veut des réponses étayées plutôt que des affirmations plausibles.

## Pourquoi l'utiliser ?

| Tu veux… | Noesis te donne… |
|---|---|
| Ne pas te faire raconter n'importe quoi | Un **vérificateur indépendant et sceptique** qui recalcule, relit les sources et exécute le code. Chaque résultat porte un niveau de vérification (affirmé, relu, contrôlé par calcul, prouvé en Lean). |
| Que l'IA se souvienne de ce qu'elle a fait | Une **mémoire qui s'accumule** d'une session à l'autre : notes liées entre elles, recherche sémantique, résumés automatiques. Rien n'est perdu quand le contexte sature. |
| Garder la main | Des **budgets**, des **pauses**, des approbations pour les actions risquées, et un chat pour reprendre la barre. |
| Travailler avec tes propres documents | Glisse des PDF, Word, PowerPoint, Excel, EPUB, notebooks ou dossiers entiers : ils deviennent du contexte, cités page par page. |
| Réutiliser le résultat | Un **export versionné** : manuscrit LaTeX, bibliographie BibTeX, résumé du raisonnement et fichiers Lean vérifiés. |
| Rester maître de tes données | Tout est **local** : base SQLite, fichiers, clés API. Rien n'est envoyé ailleurs qu'aux fournisseurs que tu configures. |

## Aperçu

- **Une équipe, pas un seul chatbot.** Un chercheur principal délègue en parallèle à un éclaireur (littérature), un expérimentateur (code et simulations), un théoricien (preuves) et un critique (attaque adversariale). Un superviseur surveille la trajectoire et corrige les boucles.
- **Un carnet vivant.** Les remarques du superviseur et les verdicts du vérificateur s'affichent dans la marge, en direct.
- **Des preuves formelles.** Pour les énoncés mathématiques, l'équipe peut écrire une preuve [Lean 4](https://lean-lang.org) et la faire valider par [Comparator](https://github.com/leanprover/comparator), le protocole d'[openai/math](https://github.com/openai/math).
- **Un tournoi d'hypothèses.** Les idées s'affrontent par paires et sont classées en Elo.

---

## Installation

**Prérequis :** [Node.js](https://nodejs.org) 22.13 ou plus récent. Python 3 est recommandé pour les calculs (`numpy`, `scipy`, `sympy`, `matplotlib`, `networkx`). Windows est la plateforme principale ; la vérification Lean passe par WSL.

```bash
git clone https://github.com/Alicienn/Noesis.git
cd Noesis
npm install
npm run build
npm start
```

L'application s'ouvre sur http://localhost:4317. Sous Windows, tu peux aussi double-cliquer sur **`Noesis.bat`** : il installe, construit, lance le serveur et ouvre le navigateur.

**Mode développement** (rechargement à chaud) : `npm run dev`. L'API écoute sur :4317 et l'interface sur http://localhost:5317.

## Premiers pas en 5 minutes

1. **Paramètres → Providers → Ajouter.** Renseigne la *base URL* (des préréglages existent : OpenAI, DeepSeek, OpenRouter, Anthropic, Groq, Mistral, Ollama, LM Studio…) et ta clé API, puis clique sur **Récupérer les modèles**.
2. **Paramètres → Rôles** : choisis un modèle pour chaque rôle.
   - Un modèle de raisonnement fort pour le chercheur principal et le vérificateur.
   - Un modèle rapide et peu coûteux pour le rôle « utilitaire ».
   - Optionnel : un modèle d'*embeddings*, qui active la recherche sémantique en mémoire.
3. **Paramètres → Recherche** *(optionnel)* : ajoute des clés (Tavily, Brave, Exa, Serper, SearXNG…) et un e-mail de contact pour OpenAlex et Crossref. DuckDuckGo fonctionne sans clé.
4. **Paramètres → Vérification formelle** *(optionnel)* : clique sur **Installer**. Cela installe Lean 4, Mathlib précompilée et Comparator dans WSL : environ 12 Go, une seule fois pour tous les projets, 20 à 40 minutes.
5. **Nouvelle recherche** : pose une question ambitieuse, ou choisis **Problème posé** pour un énoncé précis à prouver ou réfuter, puis lance.

### Choisir ses modèles

Noesis accepte toute API **compatible OpenAI** ou **Anthropic**, y compris les serveurs locaux (Ollama, LM Studio). Un modèle de raisonnement fort donne de bien meilleurs résultats pour le chercheur principal et le vérificateur ; un modèle bon marché suffit pour les tâches utilitaires.

---

# Fonctionnement en détail

## Ce que fait le harnais

### Une équipe d'agents

| Agent | Rôle |
|---|---|
| **Chercheur principal** | Pilote la recherche : cadrage, plan, hypothèses, investigation, synthèse, rapport final. |
| **Sous-agents** (`delegate`) | Spécialistes lancés **en parallèle**, chacun avec son propre contexte. Ils rendent un rapport condensé (*compress-before-return*). |
| ↳ éclaireur (`scout`) | Revue de littérature, graphe de citations, fiches de lecture. |
| ↳ expérimentateur (`experimenter`) | Code, simulations, calcul numérique reproductible. |
| ↳ théoricien (`theorist`) | Dérivations et preuves, vérifiées symboliquement. |
| ↳ critique (`critic`) | Attaque adversariale d'un raisonnement ou d'un plan. |
| **Vérificateur** | Contrôle indépendant et sceptique. Il recalcule, relit les sources et exécute le code, puis rend un verdict : vérifié, réfuté ou incertain. Les résultats importants (`finding`, importance ≥ 4) sont **vérifiés automatiquement en arrière-plan**. |
| **Superviseur** | Observe la trajectoire du chercheur principal toutes les N étapes, ou dès qu'une boucle est détectée. Il envoie diagnostics et suggestions et consigne des leçons méthodologiques. En cas d'alerte critique, il prévient l'humain. |
| **Bibliothécaire** | Consolide la mémoire « pendant le sommeil » : liens entre notes, fusion des doublons, invalidation des notes contredites, synthèses transversales. |
| **Tournoi d'hypothèses** | Débats par paires et classement Elo, sur le modèle du *AI co-scientist* de Google. |

Les agents communiquent par un **bus de messages**. Dans le tableau de bord, les remarques du superviseur et les verdicts du vérificateur s'affichent dans la marge du carnet (marginalia).

### Une mémoire en couches

Elle s'inspire de MemGPT/Letta, A-MEM, Zep/Graphiti, du *memory tool* et du *context editing* d'Anthropic, et des fichiers `CLAUDE.md`.

1. **Mémoire centrale.** Des blocs bornés toujours présents dans le contexte : `mission`, `plan`, `working`, `human` et `lessons`. L'agent les édite lui-même.
2. **Mémoire long terme.** Des notes atomiques typées et liées entre elles (Zettelkasten) : résultat, fait, méthode, impasse, question, définition, synthèse…
   - Recherche **hybride** : BM25 (SQLite FTS5) combiné à des embeddings, fusionnés par RRF.
   - Les notes contredites ne sont **jamais supprimées**. Elles sont marquées *superseded*, avec la raison.
3. **Mémoire épisodique.** Avant saturation du contexte, une **compaction** se déclenche :
   - les anciens échanges sont résumés en un épisode cumulatif ;
   - les faits durables encore absents sont extraits en notes ;
   - les vieux résultats d'outils volumineux sont effacés du contexte, mais gardés en base et accessibles par `recall_history`.
4. **Miroir Markdown.** Tout est aussi écrit dans `workspace/memory/` : `MEMORY.md` (index), `notes/*.md` avec front-matter YAML, `episodes/`, et les blocs centraux. Humains comme agents peuvent donc tout lire, y compris avec `grep`.

Contre le phénomène de *context rot*, l'état clé est placé en tête du contexte (prompt système) et un **rappel d'état** est ajouté en fin de contexte à chaque étape.

### Outils

- **Web** : recherche (SearXNG, Tavily, Brave, Exa, Serper, Jina, puis Bing et DuckDuckGo sans clé) et lecture de pages en markdown. La conversion se fait d'abord en local (Readability). Si la page est bloquée, vide ou rendue en JavaScript, Noesis enchaîne les lecteurs publics `r.jina.ai/<url>`, `defuddle.md/<url>`, `pure.md/<url>` et `markdown.new/<url>` (configurables, désactivables dans Paramètres → Recherche). Les pages d'erreur, captchas et paywalls sont détectés et jamais pris pour du contenu.
- **Recherche ciblée** : `paper_lookup` retrouve un article précis à partir de son titre (Crossref, arXiv, OpenAlex). Le graphe de citations passe par OpenCitations quand Semantic Scholar ou OpenAlex sont à court de quota. `source_read(section="17.3")` et `source_search(exact=true)` lisent un long document sans le paginer à l'aveugle.
- **Littérature** :
  - recherche agrégée dans OpenAlex, Semantic Scholar, arXiv, Crossref, Europe PMC et CORE ;
  - graphe de citations ;
  - **récupération automatique des PDF en accès libre** (arXiv, Unpaywall, OpenAlex, Semantic Scholar, balise `citation_pdf_url` des éditeurs) ;
  - extraction page par page et index plein texte, pour des citations avec numéro de page.
- **Documents de contexte** : glisse des fichiers ou des dossiers entiers, sans limite de nombre, dans la fenêtre « Nouvelle recherche », n'importe où sur la page d'un projet, ou dans l'onglet Sources.
  - Formats lus : PDF (page par page), Word, PowerPoint (notes de l'orateur comprises), Excel, OpenDocument, EPUB, HTML, notebooks, Markdown, LaTeX, code, CSV/JSON, texte en encodage Windows.
  - Les originaux sont rangés dans `workspace/inputs/`, où Python et bash peuvent les exploiter. Leur texte est indexé dans la bibliothèque. Un fichier déjà présent n'est pas ajouté deux fois.
  - Les agents les voient comme du **contexte à prendre en compte**, pas comme le périmètre de la recherche ni comme des vérités : ils les survolent tôt, les citent avec leur clé `[doc-…]` et continuent leur propre recherche. Un document ajouté en cours de route est signalé au chercheur principal. Un document jamais ouvert au bout de 15 minutes lui est rappelé, ainsi qu'au superviseur.
  - Si [Microsoft MarkItDown](https://github.com/microsoft/markitdown) est installé dans le Python configuré, il convertit les formats Office, EPUB, HTML, e-mails Outlook, ZIP et audio. Il s'installe en un clic dans Paramètres → Recherche & sources → Conversion en markdown. Sinon, l'extracteur intégré (pur JS) prend le relais.
- **PDF inaccessible** : l'agent appelle `request_pdf`. Tu reçois une **notification Windows**, puis tu déposes le PDF dans la boîte de réception. L'agent est prévenu et le lit.
- **Exécution** : `python` (calcul symbolique et numérique) et `bash` (Git Bash ou PowerShell), dans le workspace du projet.
- **Fichiers** : lecture, écriture, édition, recherche (grep).
- **Hypothèses** : registre avec preuves pour et contre, statuts et Elo.
- **Humain** : `ask_human` (bloquante ou non), `notify_human`, approbations.
- **MCP** : n'importe quel serveur *Model Context Protocol* (stdio ou HTTP) ajoute ses outils (Paramètres → Outils & MCP).

### Niveaux de vérification et preuves Lean

Repris du dépôt [openai/math](https://github.com/openai/math). Chaque résultat porte un **niveau de vérification**, calculé depuis la base et jamais déclaré par l'agent :

| Niveau | Signification |
|---|---|
| Affirmé | Aucune vérification positive. |
| Relu par le vérificateur | Verdict « vérifié » du vérificateur, obtenu par relecture. |
| Contrôlé par calcul | Verdict « vérifié », et le vérificateur a réellement exécuté du code (Python, shell, Lean). |
| Prouvé en Lean | Preuve acceptée par [Comparator](https://github.com/leanprover/comparator). |

La relecture humaine s'ajoute à ces niveaux : dans la fiche d'une note, tu peux approuver ou rejeter le résultat, ou juger la fidélité de son énoncé Lean.

**Vérification formelle.** Elle suit le protocole d'openai/math :

1. L'agent écrit l'**énoncé** seul (`Challenge.lean`, avec `sorry`), court et lisible.
2. Il écrit une **preuve** séparée (`Solution.lean`) et la met au point avec `lean_run` et `lean_search`.
3. `lean_check` lance Comparator. Celui-ci vérifie dans un bac à sable que la preuve porte exactement sur l'énoncé, qu'elle n'utilise que les axiomes standard (ni `sorry`, ni `native_decide`, ni axiome ajouté) et qu'elle passe le noyau Lean.
4. Reste à vérifier que l'énoncé Lean dit bien ce que dit la note. Le vérificateur s'en charge (`verify_claim(kind="formalization")`), et toi aussi si tu le souhaites.

Par projet, la formalisation peut être **désactivée**, activée **si pertinent** ou **exigée** (Réglages du projet).

**Problème posé.** C'est un gabarit pour les énoncés précis : énoncé autonome, définitions, références, portée. La solution attendue est une preuve ou une réfutation rigoureuse, sans affaiblir l'énoncé. Le chercheur principal suit alors un protocole dédié.

### Publication

L'onglet **Publication** d'un projet regroupe :

- les résultats classés par niveau de vérification ;
- le **résumé du raisonnement**, généré à la fin de la recherche. C'est un récit des obstacles, des idées décisives et des impasses. Ses extraits verbatim sont recopiés depuis la base, pas réécrits par le modèle ;
- les vérifications Comparator ;
- l'**export versionné** dans `publication/vN/`, qui contient :
  - le manuscrit LaTeX (`latexmk -lualatex manuscript.tex`) ;
  - `references.bib` ;
  - le résumé du raisonnement ;
  - `formalization.yaml` (schéma [mathlib-initiative](https://github.com/mathlib-initiative/formalization.yaml) v0.4) ;
  - les fichiers Lean vérifiés ;
  - un README.

  Une correction crée une nouvelle version, les anciennes restent intactes.

L'outil `prior_results` permet aussi aux agents de réutiliser les résultats vérifiés des autres projets du laboratoire, avec leur provenance.

### Sécurité et contrôle

Trois modes de permissions, réglables par projet :

- **intelligent** (par défaut) : approbation humaine seulement pour les actions risquées (suppressions massives, publication, requêtes sortantes avec données, écriture hors du workspace…) ;
- **toujours demander** : approbation pour tout shell ou Python ;
- **automatique** : aucune approbation.

Chaque projet peut aussi avoir un budget d'étapes et un budget de tokens. Les **pauses et reprises** sont possibles à tout moment, et l'humain peut intervenir dans le chat.

### Robustesse et diagnostic

- **Pannes d'outils** : un outil qui échoue 6 fois de suite pour une raison technique (moteur bloqué, quota épuisé) est retiré pendant 15 minutes. Les agents sont informés de l'incident dans leur contexte et une notification te demande d'agir si nécessaire. Les bases académiques à court de quota sont mises en pause automatiquement.
- **Fin de budget** : un vérificateur ou un sous-agent à court d'étapes a un dernier tour où il ne peut que rendre son verdict ou son rapport. Rien n'est deviné par mots-clés.
- **Vérifications automatiques** : 3 au maximum en file d'attente, avec un budget réduit. Un verdict « réfuté » abaisse la confiance de la note. Le chercheur principal est relancé tant que les notes réfutées, les hypothèses sans preuve ou la mémoire de travail périmée ne sont pas traitées.
- **Onglet Agents → Diagnostic** : il affiche, pour chaque session :
  - le taux d'échec par outil et les outils en panne ;
  - la répartition des tokens par rôle ;
  - les appels répétés et les outils jamais utilisés ;
  - les notes réfutées encore actives.

  Chaque constat est accompagné d'une recommandation.

### Notifications

Des toasts Windows natifs (SnoreToast via `node-notifier`) et des notifications navigateur sont émis pour :

- les questions de l'agent ;
- les approbations requises ;
- les PDF demandés ;
- la fin ou la mise en pause d'une recherche ;
- les erreurs ;
- les alertes critiques du superviseur.

---

## Architecture

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
server/            API Fastify + moteur d'agents (TypeScript, exécuté par tsx)
  llm/             clients OpenAI-compatible & Anthropic (streaming, outils, retries, découverte des modèles)
  agents/          boucle d'agent, orchestrateur, constructeur de contexte, prompts (.md éditables)
  memory/          notes, recherche hybride, épisodes, miroir Markdown
  tools/           registre d'outils + outils intégrés + pont MCP
  services/        recherche web, académique, PDF, shell, notifications
  store/           persistance SQLite (node:sqlite, sans module natif)
  routes/          API REST + flux SSE temps réel
web/               interface React (Vite, Tailwind v4, zustand)
shared/types.ts    contrat serveur ⇄ interface
scripts/           tests : outils (smoke), LLM factice, scénario de bout en bout
data/              base SQLite + workspaces des projets (créé au premier lancement)
```

Les **prompts** sont dans `server/agents/prompts/*.md`. Ils sont relus à chaque appel : on peut les ajuster sans redémarrer.

## Tests

```bash
npm test                 # chaque outil intégré, sans LLM (réseau requis)
npm run mock-llm         # LLM factice OpenAI/Anthropic-compatible sur :4398
NOESIS_PORT=4399 NOESIS_DATA_DIR=./data-test npm start
API=http://127.0.0.1:4399/api npm run e2e
```

Variantes du test de bout en bout :

- `PROTOCOL=anthropic` teste le protocole Anthropic ;
- `COMPACT=1` force la compaction de contexte.

Le scénario couvre : découverte des modèles, délégation parallèle, vérification automatique, superviseur, tournoi Elo, approbation refusée, rapport et fin de recherche.

Autres scénarios, à lancer après `npm run e2e` (qui configure le faux LLM) :

```bash
API=http://127.0.0.1:4399/api npx tsx scripts/e2e-cancel.ts
python scripts/make-doc-samples.py data-test-samples
API=http://127.0.0.1:4399/api SAMPLES=data-test-samples npx tsx scripts/e2e-documents.ts
```

Vérification formelle (nécessite l'environnement Lean) :

```bash
npm run lean:smoke                          # lean_run, lean_search, Comparator (preuve juste, énoncé affaibli, native_decide)
npm run bench:openai-math -- fetch 20       # défis Comparator d'openai/math (Apache-2.0)
npm run bench:openai-math -- check          # leurs énoncés compilent-ils avec notre Mathlib ?
npm run bench:openai-math -- propose BallPacking --required   # en faire un projet Noesis (serveur lancé)
```

`e2e-cancel` teste l'arrêt manuel, le timeout et le vérificateur bloqué. `e2e-documents` teste les documents fournis : tous les formats, les doublons, la visibilité dans le prompt et l'ajout en cours de recherche.

## Variables d'environnement

| Variable | Défaut | |
|---|---|---|
| `NOESIS_PORT` | 4317 | port de l'API (et de l'interface en production) |
| `NOESIS_HOST` | 127.0.0.1 | interface réseau (garde `127.0.0.1` : l'API exécute du code) |
| `NOESIS_DATA_DIR` | `./data` | base et workspaces |
| `NOESIS_WEB_PORT` | 5317 | port de l'interface en mode dev |

---

<div align="center">

Noesis s'inspire de MemGPT/Letta, A-MEM, Zep/Graphiti, du *AI co-scientist* de Google et d'[openai/math](https://github.com/openai/math).

Un bug, une idée ? [Ouvre une issue](https://github.com/Alicienn/Noesis/issues).

</div>
