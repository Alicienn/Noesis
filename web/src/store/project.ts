import { create } from 'zustand'
import type {
  AgentInstance, BusMessage, ChatMessage, CoreBlock, HumanRequest, Hypothesis, Note, Project, ServerEvent, Source, ToolRun,
} from '@shared/types'
import { api } from '../lib/api'

const EMPTY_STATS = { steps: 0, promptTokens: 0, completionTokens: 0, notes: 0, sources: 0, hypotheses: 0, pendingRequests: 0, agentsRunning: 0 }

export interface LiveStream {
  text: string
  reasoning: string
  toolCalls: Array<{ name: string; args: string }>
  startedAt: number
}

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  contextTokens: number
  contextWindow: number
}

interface ProjectState {
  id?: string
  loading: boolean
  error?: string
  project?: Project
  agents: AgentInstance[]
  blocks: CoreBlock[]
  /** messages of every agent we have seen, by agent */
  messages: Record<string, ChatMessage[]>
  toolRuns: Record<string, ToolRun>
  bus: BusMessage[]
  requests: HumanRequest[]
  notes: Record<string, Note>
  hypotheses: Record<string, Hypothesis>
  sources: Record<string, Source>
  live: Record<string, LiveStream>
  usage: Record<string, UsageInfo>
  logs: Array<{ at: number; level: string; message: string; agentId?: string }>
  filesVersion: number
  open: (id: string) => () => void
  reload: () => Promise<void>
  loadNotes: () => Promise<void>
  loadHypotheses: () => Promise<void>
  loadSources: () => Promise<void>
  loadAgentMessages: (agentId: string) => Promise<void>
}

const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map(x => [x.id, x]))

export const useProject = create<ProjectState>((set, get) => ({
  loading: false,
  agents: [],
  blocks: [],
  messages: {},
  toolRuns: {},
  bus: [],
  requests: [],
  notes: {},
  hypotheses: {},
  sources: {},
  live: {},
  usage: {},
  logs: [],
  filesVersion: 0,

  open: (id: string) => {
    set({ id, loading: true, error: undefined, project: undefined, agents: [], blocks: [], messages: {}, toolRuns: {}, bus: [], requests: [], notes: {}, hypotheses: {}, sources: {}, live: {}, usage: {}, logs: [] })
    void get().reload()
    void get().loadNotes()
    void get().loadHypotheses()
    void get().loadSources()
    const es = new EventSource(`/api/projects/${id}/events`)
    es.onmessage = e => {
      if (get().id !== id) return
      apply(JSON.parse(e.data) as ServerEvent)
    }
    // re-sync after reconnects
    es.onopen = () => {
      if (get().project) void get().reload()
    }
    return () => es.close()
  },

  reload: async () => {
    const id = get().id
    if (!id) return
    try {
      const snap = await api.project(id)
      if (get().id !== id) return
      const leadId = `lead_${id}`
      set(s => ({
        loading: false,
        project: snap.project,
        agents: snap.agents,
        blocks: snap.blocks,
        messages: { ...s.messages, [leadId]: snap.messages },
        toolRuns: byId(snap.toolRuns),
        bus: snap.bus,
        requests: snap.requests,
        usage: snap.contextWindow && !s.usage[leadId]
          ? { ...s.usage, [leadId]: { promptTokens: 0, completionTokens: 0, contextTokens: snap.contextTokens, contextWindow: snap.contextWindow } }
          : s.usage,
      }))
    } catch (error) {
      set({ loading: false, error: (error as Error).message })
    }
  },

  loadNotes: async () => {
    const id = get().id
    if (!id) return
    const notes = await api.notes(id, { all: true })
    if (get().id === id) set({ notes: byId(notes) })
  },
  loadHypotheses: async () => {
    const id = get().id
    if (!id) return
    const list = await api.hypotheses(id)
    if (get().id === id) set({ hypotheses: byId(list) })
  },
  loadSources: async () => {
    const id = get().id
    if (!id) return
    const list = await api.sources(id)
    if (get().id === id) set({ sources: byId(list) })
  },
  loadAgentMessages: async agentId => {
    const id = get().id
    if (!id) return
    const { messages } = await api.agentMessages(id, agentId)
    if (get().id === id) set(s => ({ messages: { ...s.messages, [agentId]: messages } }))
  },
}))

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex(x => x.id === item.id)
  if (i === -1) return [...list, item]
  const copy = list.slice()
  copy[i] = item
  return copy
}

function apply(ev: ServerEvent): void {
  const set = useProject.setState
  switch (ev.type) {
    case 'project.updated':
      set({ project: ev.project })
      break
    case 'agent.updated':
      set(s => ({ agents: upsert(s.agents, ev.agent) }))
      break
    case 'message.created':
    case 'message.updated': {
      const m = ev.message
      set(s => {
        const list = s.messages[m.agentId]
        const live = m.role === 'assistant' && ev.type === 'message.created' ? { ...s.live } : s.live
        if (live !== s.live) delete live[m.agentId]
        return { messages: { ...s.messages, [m.agentId]: upsert(list ?? [], m) }, live }
      })
      break
    }
    case 'llm.delta':
      set(s => {
        const cur = s.live[ev.agentId] ?? { text: '', reasoning: '', toolCalls: [], startedAt: Date.now() }
        return { live: { ...s.live, [ev.agentId]: { ...cur, [ev.kind === 'text' ? 'text' : 'reasoning']: cur[ev.kind === 'text' ? 'text' : 'reasoning'] + ev.delta } } }
      })
      break
    case 'llm.toolcall.delta':
      set(s => {
        const cur = s.live[ev.agentId] ?? { text: '', reasoning: '', toolCalls: [], startedAt: Date.now() }
        const calls = cur.toolCalls.slice()
        const c = calls[ev.index] ?? { name: '', args: '' }
        calls[ev.index] = { name: c.name + (ev.name ?? ''), args: c.args + (ev.argsDelta ?? '') }
        return { live: { ...s.live, [ev.agentId]: { ...cur, toolCalls: calls } } }
      })
      break
    case 'llm.done':
      // keep the stream until the assistant message lands (avoids flicker); clear stale streams
      setTimeout(() => {
        const s = useProject.getState()
        const cur = s.live[ev.agentId]
        if (cur && Date.now() - cur.startedAt > 1500) {
          const live = { ...s.live }
          delete live[ev.agentId]
          useProject.setState({ live })
        }
      }, 1500)
      break
    case 'tool.updated':
      set(s => ({ toolRuns: { ...s.toolRuns, [ev.run.id]: ev.run } }))
      break
    case 'note.upserted':
      set(s => ({ notes: { ...s.notes, [ev.note.id]: ev.note } }))
      break
    case 'note.deleted':
      set(s => {
        const notes = { ...s.notes }
        delete notes[ev.id]
        return { notes }
      })
      break
    case 'block.updated':
      set(s => ({ blocks: s.blocks.map(b => (b.label === ev.block.label ? ev.block : b)) }))
      break
    case 'hypothesis.upserted':
      set(s => ({ hypotheses: { ...s.hypotheses, [ev.hypothesis.id]: ev.hypothesis } }))
      break
    case 'source.upserted':
      set(s => ({ sources: { ...s.sources, [ev.source.id]: ev.source } }))
      break
    case 'request.upserted':
      set(s => ({ requests: upsert(s.requests, ev.request) }))
      break
    case 'bus.message':
      set(s => ({ bus: [...s.bus, ev.message].slice(-400) }))
      break
    case 'tokens':
      // fresh totals after every LLM call, whichever agent made it
      set(s => (s.project ? { project: { ...s.project, stats: { ...(s.project.stats ?? EMPTY_STATS), ...ev.totals } } } : {}))
      break
    case 'usage':
      set(s => ({ usage: { ...s.usage, [ev.agentId]: { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, contextTokens: ev.contextTokens, contextWindow: ev.contextWindow } } }))
      break
    case 'log':
      set(s => ({ logs: [...s.logs, { at: Date.now(), level: ev.level, message: ev.message, agentId: ev.agentId }].slice(-300) }))
      break
    case 'files.changed':
      set(s => ({ filesVersion: s.filesVersion + 1 }))
      break
  }
}
