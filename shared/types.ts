/**
 * Contract shared by the server and the web UI.
 * Everything that crosses the HTTP / SSE boundary is described here.
 */

// ───────────────────────────── Providers & models ─────────────────────────────

export type Protocol = 'openai' | 'anthropic'

export interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderConfig {
  id: string
  name: string
  protocol: Protocol
  baseURL: string
  /** Never sent to the client in clear: the API returns a masked value. */
  apiKey?: string
  /** Extra HTTP headers sent with every request. */
  headers?: Record<string, string>
  /** Models the user adopted from discovery or entered by hand. */
  models: ModelInfo[]
  /** Send `reasoning_content` back on assistant tool turns (DeepSeek thinking mode). */
  echoReasoning?: boolean
  createdAt: number
}

/** `providerId::modelId` */
export type ModelRef = string

export interface RoleModelConfig {
  model: ModelRef | ''
  temperature?: number
  maxTokens?: number
  /** Optional `reasoning_effort` for reasoning models. */
  reasoningEffort?: '' | 'low' | 'medium' | 'high'
}

export type AgentRole =
  | 'lead'
  | 'supervisor'
  | 'verifier'
  | 'scout'
  | 'experimenter'
  | 'theorist'
  | 'critic'
  | 'librarian'

export const ROLE_LABELS: Record<AgentRole, string> = {
  lead: 'Chercheur principal',
  supervisor: 'Superviseur',
  verifier: 'Vérificateur',
  scout: 'Éclaireur bibliographique',
  experimenter: 'Expérimentateur',
  theorist: 'Théoricien',
  critic: 'Critique',
  librarian: 'Bibliothécaire (mémoire)',
}

/** Which model each family of agents uses. Sub-agents fall back to `subagent`, then `lead`. */
export interface ModelAssignments {
  lead: RoleModelConfig
  supervisor: RoleModelConfig
  verifier: RoleModelConfig
  subagent: RoleModelConfig
  /** Compaction, memory consolidation, titles. Cheap & fast model recommended. */
  utility: RoleModelConfig
  /** Optional embeddings model (OpenAI `/embeddings`). Enables hybrid memory search. */
  embedding: { model: ModelRef | '' }
}

// ───────────────────────────── Global settings ─────────────────────────────

export type SearchProviderId = 'duckduckgo' | 'bing' | 'searxng' | 'tavily' | 'brave' | 'exa' | 'serper' | 'jina'

/** Public URL→markdown services (r.jina.ai/<url>, defuddle.md/<url>…). */
export type ReaderId = 'jina' | 'defuddle' | 'puremd' | 'markdown_new'

export interface SearchSettings {
  /** Providers are tried in this order; the first that answers wins. */
  order: SearchProviderId[]
  /** Reader services used when a page is blocked, empty or JavaScript-only ([] = disabled). */
  readers?: ReaderId[]
  searxngUrl?: string
  tavilyKey?: string
  braveKey?: string
  exaKey?: string
  serperKey?: string
  jinaKey?: string
  /** Contact e-mail for polite pools (OpenAlex, Crossref, Unpaywall). */
  contactEmail?: string
  semanticScholarKey?: string
  openAlexKey?: string
  coreKey?: string
}

export interface McpServerConfig {
  name: string
  enabled: boolean
  /** stdio transport */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** streamable HTTP transport */
  url?: string
  headers?: Record<string, string>
}

export type PermissionMode = 'auto' | 'smart' | 'ask'

export interface NotificationSettings {
  windowsToast: boolean
  browser: boolean
  sound: boolean
  /** Which events trigger a desktop notification. */
  on: {
    humanRequest: boolean
    approval: boolean
    runFinished: boolean
    error: boolean
    finding: boolean
    supervisorCritical: boolean
  }
}

export interface GlobalSettings {
  models: ModelAssignments
  search: SearchSettings
  mcpServers: McpServerConfig[]
  notifications: NotificationSettings
  defaults: ProjectConfig
  shell: {
    /** 'auto' picks Git Bash on Windows when present, else PowerShell. */
    preferred: 'auto' | 'bash' | 'powershell' | 'cmd'
    pythonPath: string
  }
  documents?: {
    /** Convert Office, EPUB, audio, Outlook… with Microsoft MarkItDown when it is installed in Python. */
    markitdown: boolean
  }
  /** Formal verification with Lean 4 + Mathlib + Comparator (run inside WSL on Windows). */
  lean?: LeanSettings
}

export interface LeanSettings {
  /** Expose the Lean tools to the agents when the environment is ready. */
  enabled: boolean
  /** WSL distribution (Windows only). */
  distro: string
  /** Shared Lake workspace with a prebuilt Mathlib (Linux path, `~` allowed). */
  workspace: string
  /** Max seconds for one `lean_run` / `lean_check`. */
  timeoutSec: number
}

export interface LeanStatus {
  available: boolean
  /** Short reason when unavailable (WSL missing, not installed…). */
  error?: string
  leanVersion?: string
  mathlib?: string
  comparator: boolean
  landrun: boolean
  lean4export: boolean
  workspace: string
  distro?: string
  checkedAt: number
  install?: { running: boolean; startedAt?: number; finishedAt?: number; ok?: boolean; log: string }
}

// ───────────────────────────── Projects ─────────────────────────────

export type RunMode = 'autonomous' | 'interactive'

export interface ProjectConfig {
  mode: RunMode
  permission: PermissionMode
  /** Hard cap of lead LLM steps per run (0 = unlimited). */
  maxSteps: number
  /** Stop when spend estimation exceeds this many tokens (0 = unlimited). */
  maxTokens: number
  /** Supervisor reviews the lead every N steps (0 = off). */
  supervisorEvery: number
  /** Automatically verify notes flagged as important findings. */
  autoVerify: boolean
  /** Compact the conversation when it reaches this fraction of the context window. */
  compactAt: number
  /** Keep this many most recent tool results uncleared in context. */
  keepToolResults: number
  /** Max concurrent sub-agents. */
  maxParallelAgents: number
  /** Default timeout of one tool action, in seconds (delegation & verification get longer budgets). */
  toolTimeoutSec: number
  /** Per-project model overrides; empty fields inherit global assignments. */
  models?: Partial<ModelAssignments>
  /** Extra instructions appended to the lead system prompt. */
  customInstructions: string
  /** Tools disabled for this project. */
  disabledTools: string[]
  /** 'problem': a precisely stated (mathematical) problem to solve or refute, with its own protocol. */
  kind?: ProjectKind
  /** Lean formalization: off, preferred for the main results, or required before concluding. */
  formal?: FormalPolicy
}

export type ProjectKind = 'research' | 'problem'
export type FormalPolicy = 'off' | 'preferred' | 'required'

/** Fields of the "problem" template (new research dialog); turned into the question text. */
export interface ProblemSpec {
  statement: string
  definitions: string
  references: string
  scope: string
  /** Discourage brute-force enumeration / computer-assisted proofs in the final write-up. */
  noBruteForce: boolean
}

export type ProjectStatus = 'idle' | 'running' | 'waiting_human' | 'paused' | 'finished' | 'error'

export interface Project {
  id: string
  title: string
  question: string
  domain: string
  status: ProjectStatus
  config: ProjectConfig
  createdAt: number
  updatedAt: number
  stats?: ProjectStats
}

export interface ProjectStats {
  steps: number
  promptTokens: number
  completionTokens: number
  /** Input tokens served from the provider's prefix cache (part of promptTokens). */
  cachedTokens?: number
  /** Input tokens written to the cache (Anthropic), part of promptTokens. */
  cacheWriteTokens?: number
  /** LLM calls made so far. */
  calls?: number
  notes: number
  sources: number
  hypotheses: number
  pendingRequests: number
  agentsRunning: number
}

export interface TokenTotals {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  calls: number
}

// ───────────────────────────── Conversation ─────────────────────────────

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  id: string
  projectId: string
  agentId: string
  role: MessageRole
  content: string
  reasoning?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  /** origin of a user message: human, supervisor, system nudge, agent bus... */
  meta?: {
    origin?: 'human' | 'supervisor' | 'system' | 'agent' | 'compaction' | 'verifier'
    from?: string
    toolStatus?: 'ok' | 'error' | 'denied' | 'cancelled' | 'timeout'
    durationMs?: number
    truncated?: boolean
    [k: string]: unknown
  }
  /** 1 when replaced by a compaction summary (kept for the UI history). */
  compacted?: boolean
  createdAt: number
}

// ───────────────────────────── Agents ─────────────────────────────

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'waiting' | 'done' | 'error' | 'stopped'

export interface AgentInstance {
  id: string
  projectId: string
  parentId?: string
  role: AgentRole
  name: string
  status: AgentStatus
  task?: string
  model?: string
  result?: string
  steps: number
  createdAt: number
  finishedAt?: number
}

export interface BusMessage {
  id: string
  projectId: string
  from: string
  to: string
  kind: 'suggestion' | 'warning' | 'critical' | 'info' | 'report' | 'verification' | 'reply'
  content: string
  createdAt: number
}

// ───────────────────────────── Memory ─────────────────────────────

export type NoteType =
  | 'finding'
  | 'fact'
  | 'hypothesis'
  | 'method'
  | 'question'
  | 'idea'
  | 'dead_end'
  | 'definition'
  | 'insight'
  | 'todo'

export interface Verification {
  verdict: 'supported' | 'refuted' | 'uncertain' | 'pending'
  confidence: number
  summary: string
  issues?: string[]
  at: number
}

/**
 * How far a result has been checked, from the weakest to the strongest
 * (inspired by the verification stages of openai/math):
 * claimed → reviewed by the verifier → checked by computation → proof accepted by Lean/Comparator.
 * Human review is recorded separately (it can apply at any level).
 */
export type AssuranceLevel = 'claimed' | 'reviewed' | 'computed' | 'formal'

export const ASSURANCE_LEVELS: AssuranceLevel[] = ['claimed', 'reviewed', 'computed', 'formal']

export const ASSURANCE_LABELS: Record<AssuranceLevel, string> = {
  claimed: 'Affirmé',
  reviewed: 'Relu par le vérificateur',
  computed: 'Contrôlé par calcul',
  formal: 'Prouvé en Lean',
}

export interface AssuranceEvent {
  level: AssuranceLevel
  /** agent id, 'human' or 'comparator' */
  by: string
  at: number
  detail: string
  /** e.g. the Lean check id */
  ref?: string
}

export interface HumanReview {
  verdict: 'approved' | 'rejected'
  /** What was reviewed: the result itself, or the faithfulness of its Lean statement. */
  target: 'result' | 'lean_statement'
  comment: string
  at: number
}

export interface Assurance {
  level: AssuranceLevel
  history: AssuranceEvent[]
  /** Last Lean formalization of the note (statement + proof checked by Comparator). */
  lean?: { checkId: string; status: LeanCheckStatus; statementReview?: { verdict: Verification['verdict']; by: string; at: number; summary: string } }
  humanReview?: HumanReview
}

export type LeanCheckStatus = 'running' | 'proved' | 'failed' | 'error'

/** One Comparator run: Challenge (statement with sorry) vs Solution (proof). */
export interface LeanCheck {
  id: string
  projectId: string
  noteSlug?: string
  /** Workspace-relative paths of the copies archived in lean/checks/<id>/ */
  challengeFile: string
  solutionFile: string
  theorems: string[]
  definitions: string[]
  permittedAxioms: string[]
  status: LeanCheckStatus
  /** Tail of the Comparator output */
  output: string
  durationMs?: number
  createdBy: string
  createdAt: number
}

export interface Note {
  id: string
  projectId: string
  slug: string
  title: string
  type: NoteType
  content: string
  tags: string[]
  /** 0..1, author's own confidence */
  confidence: number
  /** 1..5 */
  importance: number
  links: string[]
  sourceIds: string[]
  verification?: Verification
  /** Verification ladder; absent = never checked (level « claimed »). */
  assurance?: Assurance
  /** Graphiti-style invalidation: contradicted facts are superseded, never deleted. */
  status: 'active' | 'superseded' | 'archived'
  supersededBy?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  accessCount: number
}

export interface CoreBlock {
  label: string
  value: string
  limit: number
  description: string
  updatedAt: number
}

export interface Episode {
  id: string
  projectId: string
  agentId: string
  summary: string
  messageCount: number
  createdAt: number
}

// ───────────────────────────── Hypotheses ─────────────────────────────

export type HypothesisStatus = 'proposed' | 'testing' | 'supported' | 'refuted' | 'abandoned'

export interface EvidenceItem {
  stance: 'for' | 'against'
  text: string
  ref?: string
  at: number
}

export interface Hypothesis {
  id: string
  projectId: string
  statement: string
  rationale: string
  status: HypothesisStatus
  elo: number
  matches: number
  evidence: EvidenceItem[]
  testPlan: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

// ───────────────────────────── Sources ─────────────────────────────

export type SourceStatus = 'metadata' | 'full_text' | 'requested' | 'failed'

export interface Source {
  id: string
  projectId: string
  kind: 'paper' | 'web' | 'pdf' | 'book' | 'dataset' | 'other'
  title: string
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  arxivId?: string
  url?: string
  pdfUrl?: string
  abstract?: string
  citationKey: string
  status: SourceStatus
  pages?: number
  chars?: number
  notes?: string
  citations?: number
  /** 'human' = document provided by the human as input context. */
  origin?: 'human'
  /** Original file in the workspace (e.g. inputs/data.csv), for documents provided by the human. */
  file?: string
  createdAt: number
}

// ───────────────────────────── Human inbox ─────────────────────────────

export type RequestKind = 'question' | 'pdf' | 'approval' | 'info' | 'access'

export interface HumanRequest {
  id: string
  projectId: string
  agentId: string
  kind: RequestKind
  title: string
  body: string
  options?: string[]
  /** Blocking requests pause the agent until answered. */
  blocking: boolean
  status: 'pending' | 'resolved' | 'dismissed'
  response?: string
  /** For approvals: the command / action payload. */
  payload?: Record<string, unknown>
  sourceId?: string
  createdAt: number
  resolvedAt?: number
}

// ───────────────────────────── Tools ─────────────────────────────

export interface ToolRun {
  id: string
  projectId: string
  agentId: string
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error' | 'denied' | 'waiting_approval' | 'cancelled' | 'timeout'
  result?: string
  durationMs?: number
  createdAt: number
}

export interface ToolDescriptor {
  name: string
  description: string
  category: string
  source: 'builtin' | 'mcp'
  parameters: Record<string, unknown>
}

// ───────────────────────────── Files ─────────────────────────────

export interface FileEntry {
  path: string
  name: string
  dir: boolean
  size: number
  mtime: number
}

// ───────────────────────────── Events (SSE) ─────────────────────────────

export type ServerEvent =
  | { type: 'project.updated'; project: Project }
  | { type: 'agent.updated'; agent: AgentInstance }
  | { type: 'message.created'; message: ChatMessage }
  | { type: 'message.updated'; message: ChatMessage }
  | { type: 'llm.delta'; agentId: string; kind: 'text' | 'reasoning'; delta: string }
  | { type: 'llm.toolcall.delta'; agentId: string; index: number; name?: string; argsDelta?: string }
  | { type: 'llm.done'; agentId: string }
  | { type: 'tool.updated'; run: ToolRun }
  | { type: 'note.upserted'; note: Note }
  | { type: 'note.deleted'; id: string }
  | { type: 'block.updated'; block: CoreBlock }
  | { type: 'hypothesis.upserted'; hypothesis: Hypothesis }
  | { type: 'source.upserted'; source: Source }
  | { type: 'request.upserted'; request: HumanRequest }
  | { type: 'bus.message'; message: BusMessage }
  | { type: 'episode.created'; episode: Episode }
  | { type: 'usage'; agentId: string; promptTokens: number; completionTokens: number; contextTokens: number; contextWindow: number }
  /** Emitted after every LLM call (any agent, any role): fresh project totals. */
  | { type: 'tokens'; projectId?: string; agentId: string; totals: TokenTotals; call: TokenTotals }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; agentId?: string }
  | { type: 'notify'; title: string; body: string; level: 'info' | 'success' | 'warn' | 'error' }
  | { type: 'files.changed' }
  | { type: 'lean.check'; check: LeanCheck }

export type ServerEventType = ServerEvent['type']

// ───────────────────────────── API payloads ─────────────────────────────

export interface ProjectSnapshot {
  project: Project
  agents: AgentInstance[]
  blocks: CoreBlock[]
  messages: ChatMessage[]
  toolRuns: ToolRun[]
  bus: BusMessage[]
  requests: HumanRequest[]
  contextTokens: number
  contextWindow: number
}

export interface DiscoveredModel extends ModelInfo {
  ownedBy?: string
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  mode: 'autonomous',
  permission: 'smart',
  maxSteps: 300,
  maxTokens: 0,
  supervisorEvery: 8,
  autoVerify: true,
  compactAt: 0.72,
  keepToolResults: 8,
  maxParallelAgents: 3,
  toolTimeoutSec: 1800,
  customInstructions: '',
  disabledTools: [],
  kind: 'research',
  formal: 'off',
}

/** Exported publication bundle (workspace/publication/vN). */
export interface PublicationVersion {
  version: number
  dir: string
  createdAt: number
  files: string[]
  note?: string
}
