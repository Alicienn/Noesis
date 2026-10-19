import { create } from 'zustand'
import type { HumanRequest, Project, ServerEvent } from '@shared/types'
import { api } from '../lib/api'
import { desktopNotify } from '../lib/notify'

export interface Toast {
  id: number
  title: string
  body?: string
  level: 'info' | 'success' | 'warn' | 'error'
}

interface AppState {
  projects: Project[]
  inbox: HumanRequest[]
  toasts: Toast[]
  connected: boolean
  loadProjects: () => Promise<void>
  loadInbox: () => Promise<void>
  toast: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
  connect: () => () => void
}

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  projects: [],
  inbox: [],
  toasts: [],
  connected: false,

  loadProjects: async () => set({ projects: await api.projects() }),
  loadInbox: async () => set({ inbox: await api.inbox() }),

  toast: t => {
    const id = ++toastId
    set(s => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => get().dismiss(id), t.level === 'error' ? 9000 : 5500)
  },
  dismiss: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  connect: () => {
    void get().loadProjects()
    void get().loadInbox()
    const es = new EventSource('/api/events')
    es.onopen = () => set({ connected: true })
    es.onerror = () => set({ connected: false })
    es.onmessage = e => {
      const ev = JSON.parse(e.data) as ServerEvent
      if (ev.type === 'project.updated') {
        set(s => {
          const exists = s.projects.some(p => p.id === ev.project.id)
          const projects = exists ? s.projects.map(p => (p.id === ev.project.id ? ev.project : p)) : [ev.project, ...s.projects]
          return { projects }
        })
      } else if (ev.type === 'tokens' && ev.projectId) {
        set(s => ({ projects: s.projects.map(p => (p.id === ev.projectId && p.stats ? { ...p, stats: { ...p.stats, ...ev.totals } } : p)) }))
      } else if (ev.type === 'request.upserted') {
        set(s => {
          const others = s.inbox.filter(r => r.id !== ev.request.id)
          return { inbox: ev.request.status === 'pending' ? [ev.request, ...others] : others }
        })
      } else if (ev.type === 'notify') {
        get().toast({ title: ev.title, body: ev.body, level: ev.level })
        desktopNotify(ev.title, ev.body)
      }
    }
    return () => es.close()
  },
}))
