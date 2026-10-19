<div align="center">

<img src="assets/logo.svg" alt="Noesis" width="560">

<br>

**Give an ambitious question to a team of AIs. Get back verified, sourced results, sometimes proved in Lean.**

<br>

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)](https://react.dev)
[![Lean 4](https://img.shields.io/badge/Lean%204-Mathlib-7b61ff)](https://lean-lang.org)
[![SQLite](https://img.shields.io/badge/SQLite-local-003b57?logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![Works with OpenAI and Anthropic](https://img.shields.io/badge/LLM-OpenAI%20%C2%B7%20Anthropic%20%C2%B7%20local-f2b544)](#choosing-your-models)
[![Last commit](https://img.shields.io/github/last-commit/Alicienn/Noesis?color=5fb8a5)](https://github.com/Alicienn/Noesis/commits)
[![Stars](https://img.shields.io/github/stars/Alicienn/Noesis?style=flat&color=f2b544)](https://github.com/Alicienn/Noesis/stargazers)

</div>

---

## What is Noesis?

Noesis is an **autonomous research lab** that runs on your own computer. You ask a question, pick the AI model you want (OpenAI, Anthropic, DeepSeek, a local model through Ollama…), and a team of agents gets to work: it searches the literature, reads papers, runs computations, checks its own conclusions and keeps a record of everything.

You follow progress live in a dashboard, and you can step in at any time: ask the team a question, approve a risky action, or hand it a PDF.

Noesis is built for deep research in **mathematics, physics, computer science, networks and protocols**, or any field where you want backed-up answers rather than plausible-sounding claims.

## Why use it?

| You want… | Noesis gives you… |
|---|---|
| Not to be fed nonsense | An **independent, skeptical verifier** that recomputes, rereads sources and runs the code. Every result carries a verification level (claimed, reviewed, checked by computation, proved in Lean). |
| An AI that remembers what it did | A **memory that builds up** across sessions: linked notes, semantic search, automatic summaries. Nothing is lost when the context fills up. |
| To stay in control | **Budgets**, **pauses**, approvals for risky actions, and a chat to take the wheel back. |
| To work with your own documents | Drop in PDFs, Word, PowerPoint, Excel, EPUB, notebooks or whole folders: they become context, cited page by page. |
| To reuse the output | A **versioned export**: LaTeX manuscript, BibTeX bibliography, reasoning summary and verified Lean files. |
| To own your data | Everything is **local**: SQLite database, files, API keys. Nothing leaves your machine except calls to the providers you configure. |

## Overview

- **A team, not a single chatbot.** A lead researcher delegates in parallel to a scout (literature), an experimenter (code and simulations), a theorist (proofs) and a critic (adversarial review). A supervisor watches the trajectory and breaks loops.
- **A living notebook.** Supervisor remarks and verifier verdicts appear in the margin, live.
- **Formal proofs.** For mathematical statements, the team can write a [Lean 4](https://lean-lang.org) proof and have it validated by [Comparator](https://github.com/leanprover/comparator), the protocol from [openai/math](https://github.com/openai/math).
- **A hypothesis tournament.** Ideas face off in pairs and are ranked by Elo.

---

## Installation

**Requirements:** [Node.js](https://nodejs.org) 22.13 or newer. Python 3 is recommended for computations (`numpy`, `scipy`, `sympy`, `matplotlib`, `networkx`). Windows is the primary platform; Lean verification runs through WSL.

```bash
git clone https://github.com/Alicienn/Noesis.git
cd Noesis
npm install
npm run build
npm start
```

The app opens at http://localhost:4317. On Windows you can also double-click **`Noesis.bat`**: it installs, builds, starts the server and opens the browser.

**Development mode** (hot reload): `npm run dev`. The API listens on :4317 and the UI on http://localhost:5317.

## Getting started in 5 minutes

1. **Settings → Providers → Add.** Enter the *base URL* (presets are provided: OpenAI, DeepSeek, OpenRouter, Anthropic, Groq, Mistral, Ollama, LM Studio…) and your API key, then click **Fetch models**.
2. **Settings → Roles**: pick a model for each role.
   - A strong reasoning model for the lead researcher and the verifier.
   - A fast, cheap model for the "utility" role.
   - Optional: an *embeddings* model, which enables semantic search in memory.
3. **Settings → Search** *(optional)*: add keys (Tavily, Brave, Exa, Serper, SearXNG…) and a contact email for OpenAlex and Crossref. DuckDuckGo works without a key.
4. **Settings → Formal verification** *(optional)*: click **Install**. This installs Lean 4, prebuilt Mathlib and Comparator in WSL: about 12 GB, once for all projects, 20 to 40 minutes.
5. **New research**: ask an ambitious question, or choose **Posed problem** for a precise statement to prove or disprove, then start.

### Choosing your models

Noesis accepts any **OpenAI-compatible** or **Anthropic** API, including local servers (Ollama, LM Studio). A strong reasoning model gives much better results for the lead researcher and the verifier; a cheap model is enough for utility tasks.

---

# How it works

## What the harness does

### A team of agents

| Agent | Role |
|---|---|
| **Lead researcher** | Drives the research: framing, plan, hypotheses, investigation, synthesis, final report. |
| **Sub-agents** (`delegate`) | Specialists launched **in parallel**, each with its own context. They return a condensed report (*compress-before-return*). |
| ↳ scout (`scout`) | Literature review, citation graph, reading notes. |
| ↳ experimenter (`experimenter`) | Code, simulations, reproducible numerical computation. |
| ↳ theorist (`theorist`) | Derivations and proofs, checked symbolically. |
| ↳ critic (`critic`) | Adversarial attack on a line of reasoning or a plan. |
| **Verifier** | Independent, skeptical check. It recomputes, rereads sources and runs the code, then returns a verdict: verified, refuted or uncertain. Important results (`finding`, importance ≥ 4) are **verified automatically in the background**. |
| **Supervisor** | Observes the lead researcher's trajectory every N steps, or as soon as a loop is detected. It sends diagnoses and suggestions and records methodological lessons. On a critical alert, it notifies the human. |
| **Librarian** | Consolidates memory "while sleeping": links between notes, merging duplicates, invalidating contradicted notes, cross-cutting syntheses. |
| **Hypothesis tournament** | Pairwise debates and Elo ranking, modeled on Google's *AI co-scientist*. |

Agents communicate through a **message bus**. In the dashboard, supervisor remarks and verifier verdicts appear in the notebook margin (marginalia).

### Layered memory

Inspired by MemGPT/Letta, A-MEM, Zep/Graphiti, Anthropic's *memory tool* and *context editing*, and `CLAUDE.md` files.

1. **Core memory.** Bounded blocks that are always in context: `mission`, `plan`, `working`, `human` and `lessons`. The agent edits them itself.
2. **Long-term memory.** Atomic, typed, interlinked notes (Zettelkasten): result, fact, method, dead end, question, definition, synthesis…
   - **Hybrid** search: BM25 (SQLite FTS5) combined with embeddings, fused with RRF.
   - Contradicted notes are **never deleted**. They are marked *superseded*, with the reason.
3. **Episodic memory.** Before the context saturates, a **compaction** is triggered:
   - older exchanges are summarized into a cumulative episode;
   - durable facts not yet captured are extracted into notes;
   - old bulky tool results are cleared from context but kept in the database and reachable through `recall_history`.
4. **Markdown mirror.** Everything is also written to `workspace/memory/`: `MEMORY.md` (index), `notes/*.md` with YAML front matter, `episodes/`, and the core blocks. Humans and agents can read it all, including with `grep`.

Against *context rot*, the key state is placed at the top of the context (system prompt) and a **state reminder** is appended at the end of the context at every step.

### Tools

- **Web**: search (SearXNG, Tavily, Brave, Exa, Serper, Jina, then Bing and DuckDuckGo without a key) and page reading as markdown. Conversion happens locally first (Readability). If a page is blocked, empty or rendered in JavaScript, Noesis falls back through the public readers `r.jina.ai/<url>`, `defuddle.md/<url>`, `pure.md/<url>` and `markdown.new/<url>` (configurable and can be disabled in Settings → Search). Error pages, captchas and paywalls are detected and never mistaken for content.
- **Targeted search**: `paper_lookup` finds a specific paper from its title (Crossref, arXiv, OpenAlex). The citation graph goes through OpenCitations when Semantic Scholar or OpenAlex are out of quota. `source_read(section="17.3")` and `source_search(exact=true)` read a long document without blindly paginating.
- **Literature**:
  - aggregated search across OpenAlex, Semantic Scholar, arXiv, Crossref, Europe PMC and CORE;
  - citation graph;
  - **automatic retrieval of open-access PDFs** (arXiv, Unpaywall, OpenAlex, Semantic Scholar, publishers' `citation_pdf_url` tag);
  - page-by-page extraction and full-text index, for citations with page numbers.
- **Context documents**: drag files or whole folders, with no limit on count, into the "New research" window, anywhere on a project page, or into the Sources tab.
  - Formats read: PDF (page by page), Word, PowerPoint (speaker notes included), Excel, OpenDocument, EPUB, HTML, notebooks, Markdown, LaTeX, code, CSV/JSON, Windows-encoded text.
  - Originals are stored in `workspace/inputs/`, where Python and bash can use them. Their text is indexed in the library. A file already present is not added twice.
  - Agents see them as **context to take into account**, not as the scope of the research nor as truths: they skim them early, cite them with their `[doc-…]` key and keep doing their own research. A document added mid-run is flagged to the lead researcher. A document never opened after 15 minutes is brought up again to them and to the supervisor.
  - If [Microsoft MarkItDown](https://github.com/microsoft/markitdown) is installed in the configured Python, it converts Office formats, EPUB, HTML, Outlook emails, ZIP and audio. It installs in one click in Settings → Search & sources → Markdown conversion. Otherwise the built-in extractor (pure JS) takes over.
- **Inaccessible PDF**: the agent calls `request_pdf`. You get a **Windows notification**, then drop the PDF in the inbox. The agent is notified and reads it.
- **Execution**: `python` (symbolic and numerical computation) and `bash` (Git Bash or PowerShell), inside the project workspace.
- **Files**: read, write, edit, search (grep).
- **Hypotheses**: registry with evidence for and against, statuses and Elo.
- **Human**: `ask_human` (blocking or not), `notify_human`, approvals.
- **MCP**: any *Model Context Protocol* server (stdio or HTTP) adds its tools (Settings → Tools & MCP).

### Verification levels and Lean proofs

Borrowed from the [openai/math](https://github.com/openai/math) repository. Every result carries a **verification level**, computed from the database and never declared by the agent:

| Level | Meaning |
|---|---|
| Claimed | No positive verification. |
| Reviewed by the verifier | "Verified" verdict from the verifier, obtained by rereading. |
| Checked by computation | "Verified" verdict, and the verifier actually ran code (Python, shell, Lean). |
| Proved in Lean | Proof accepted by [Comparator](https://github.com/leanprover/comparator). |

Human review comes on top of these levels: in a note's page, you can approve or reject the result, or judge the faithfulness of its Lean statement.

**Formal verification.** It follows the openai/math protocol:

1. The agent writes the **statement** alone (`Challenge.lean`, with `sorry`), short and readable.
2. It writes a separate **proof** (`Solution.lean`) and refines it with `lean_run` and `lean_search`.
3. `lean_check` runs Comparator. In a sandbox, it checks that the proof is about exactly that statement, that it only uses the standard axioms (no `sorry`, no `native_decide`, no added axiom) and that it passes the Lean kernel.
4. What remains is checking that the Lean statement says what the note says. The verifier handles it (`verify_claim(kind="formalization")`), and you can too if you wish.

Per project, formalization can be **disabled**, enabled **when relevant** or **required** (Project settings).

**Posed problem.** A template for precise statements: self-contained statement, definitions, references, scope. The expected solution is a rigorous proof or disproof, without weakening the statement. The lead researcher then follows a dedicated protocol.

### Publication

A project's **Publication** tab gathers:

- results ranked by verification level;
- the **reasoning summary**, generated at the end of the research. It is a narrative of obstacles, decisive ideas and dead ends. Its verbatim excerpts are copied from the database, not rewritten by the model;
- Comparator verifications;
- the **versioned export** in `publication/vN/`, which contains:
  - the LaTeX manuscript (`latexmk -lualatex manuscript.tex`);
  - `references.bib`;
  - the reasoning summary;
  - `formalization.yaml` ([mathlib-initiative](https://github.com/mathlib-initiative/formalization.yaml) schema v0.4);
  - the verified Lean files;
  - a README.

  A correction creates a new version; older ones remain untouched.

The `prior_results` tool also lets agents reuse verified results from other projects in the lab, with their provenance.

### Safety and control

Three permission modes, adjustable per project:

- **smart** (default): human approval only for risky actions (mass deletions, publication, outbound requests carrying data, writes outside the workspace…);
- **always ask**: approval for any shell or Python;
- **automatic**: no approval.

Each project can also have a step budget and a token budget. **Pausing and resuming** are possible at any time, and the human can step in through the chat.

### Robustness and diagnostics

- **Tool outages**: a tool that fails 6 times in a row for a technical reason (blocked engine, exhausted quota) is withdrawn for 15 minutes. Agents are told about the incident in their context and a notification asks you to act if needed. Academic databases that run out of quota are paused automatically.
- **End of budget**: a verifier or sub-agent that runs out of steps gets one last turn where it can only return its verdict or report. Nothing is guessed from keywords.
- **Automatic verifications**: at most 3 queued at a time, with a reduced budget. A "refuted" verdict lowers the note's confidence. The lead researcher is prompted again until refuted notes, unproved hypotheses and stale working memory have been dealt with.
- **Agents → Diagnostics tab**: shows, for each session:
  - the failure rate per tool and the tools that are down;
  - token breakdown by role;
  - repeated calls and tools never used;
  - refuted notes still active.

  Each finding comes with a recommendation.

### Notifications

Native Windows toasts (SnoreToast via `node-notifier`) and browser notifications are sent for:

- agent questions;
- required approvals;
- requested PDFs;
- research finished or paused;
- errors;
- critical supervisor alerts.

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (in French).

```
server/            Fastify API + agent engine (TypeScript, run by tsx)
  llm/             OpenAI-compatible & Anthropic clients (streaming, tools, retries, model discovery)
  agents/          agent loop, orchestrator, context builder, prompts (editable .md)
  memory/          notes, hybrid search, episodes, Markdown mirror
  tools/           tool registry + built-in tools + MCP bridge
  services/        web search, academic, PDF, shell, notifications
  store/           SQLite persistence (node:sqlite, no native module)
  routes/          REST API + real-time SSE stream
web/               React UI (Vite, Tailwind v4, zustand)
shared/types.ts    server ⇄ UI contract
scripts/           tests: tools (smoke), mock LLM, end-to-end scenario
data/              SQLite database + project workspaces (created on first launch)
```

The **prompts** live in `server/agents/prompts/*.md`. They are reloaded on every call, so you can tweak them without restarting.

## Tests

```bash
npm test                 # every built-in tool, no LLM (network required)
npm run mock-llm         # mock OpenAI/Anthropic-compatible LLM on :4398
NOESIS_PORT=4399 NOESIS_DATA_DIR=./data-test npm start
API=http://127.0.0.1:4399/api npm run e2e
```

End-to-end test variants:

- `PROTOCOL=anthropic` tests the Anthropic protocol;
- `COMPACT=1` forces context compaction.

The scenario covers: model discovery, parallel delegation, automatic verification, supervisor, Elo tournament, denied approval, report and end of research.

Other scenarios, to run after `npm run e2e` (which configures the mock LLM):

```bash
API=http://127.0.0.1:4399/api npx tsx scripts/e2e-cancel.ts
python scripts/make-doc-samples.py data-test-samples
API=http://127.0.0.1:4399/api SAMPLES=data-test-samples npx tsx scripts/e2e-documents.ts
```

Formal verification (requires the Lean environment):

```bash
npm run lean:smoke                          # lean_run, lean_search, Comparator (correct proof, weakened statement, native_decide)
npm run bench:openai-math -- fetch 20       # Comparator challenges from openai/math (Apache-2.0)
npm run bench:openai-math -- check          # do their statements compile with our Mathlib?
npm run bench:openai-math -- propose BallPacking --required   # turn one into a Noesis project (server running)
```

`e2e-cancel` tests manual stop, timeout and a stuck verifier. `e2e-documents` tests supplied documents: all formats, duplicates, visibility in the prompt and mid-run additions.

## Environment variables

| Variable | Default | |
|---|---|---|
| `NOESIS_PORT` | 4317 | API port (and UI port in production) |
| `NOESIS_HOST` | 127.0.0.1 | network interface (keep `127.0.0.1`: the API executes code) |
| `NOESIS_DATA_DIR` | `./data` | database and workspaces |
| `NOESIS_WEB_PORT` | 5317 | UI port in dev mode |

---

<div align="center">

Noesis draws on MemGPT/Letta, A-MEM, Zep/Graphiti, Google's *AI co-scientist* and [openai/math](https://github.com/openai/math).

Found a bug or have an idea? [Open an issue](https://github.com/Alicienn/Noesis/issues).

</div>
