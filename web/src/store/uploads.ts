import { create } from 'zustand'
import type { Source } from '@shared/types'

/**
 * Upload queue for documents provided as input context. Lives outside the
 * pages so uploads keep going while the user navigates (or right after a
 * project is created from the "new research" modal).
 */

export type UploadStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'duplicate' | 'error'

export interface UploadItem {
  id: string
  projectId: string
  file: File
  name: string
  size: number
  /** 0..1 — bytes sent */
  progress: number
  status: UploadStatus
  error?: string
  format?: string
  source?: Source
  startedAt?: number
}

interface DocumentResult {
  documents: Array<{ filename: string; duplicate: boolean; format: string; source: Source }>
  errors: Array<{ filename: string; error: string }>
}

const CONCURRENCY = 3

interface UploadState {
  items: UploadItem[]
  /** Queue files; resolves once every one of them is settled. */
  enqueue: (projectId: string, files: File[]) => Promise<UploadItem[]>
  dismiss: (projectId: string) => void
  remove: (id: string) => void
}

const waiters = new Map<string, () => void>()
let seq = 0

export const useUploads = create<UploadState>((set, get) => {
  const patch = (id: string, p: Partial<UploadItem>): void => set(s => ({ items: s.items.map(i => (i.id === id ? { ...i, ...p } : i)) }))

  const settle = (id: string, p: Partial<UploadItem>): void => {
    patch(id, p)
    waiters.get(id)?.()
    waiters.delete(id)
    pump()
  }

  const send = (item: UploadItem): void => {
    patch(item.id, { status: 'uploading', startedAt: Date.now(), progress: 0 })
    const fd = new FormData()
    fd.append('file', item.file, item.name)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/projects/${item.projectId}/documents`)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) patch(item.id, { progress: e.loaded / e.total })
    }
    xhr.upload.onload = () => patch(item.id, { progress: 1, status: 'processing' })
    xhr.onerror = () => settle(item.id, { status: 'error', error: 'Connexion au serveur perdue' })
    xhr.onload = () => {
      let data: (DocumentResult & { error?: string }) | undefined
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = undefined
      }
      if (xhr.status >= 400 || !data) return settle(item.id, { status: 'error', error: data?.error ?? `HTTP ${xhr.status}` })
      const doc = data.documents[0]
      if (!doc) return settle(item.id, { status: 'error', error: data.errors[0]?.error ?? 'Échec' })
      settle(item.id, { status: doc.duplicate ? 'duplicate' : 'done', source: doc.source, format: doc.format, progress: 1 })
    }
    xhr.send(fd)
  }

  const pump = (): void => {
    const items = get().items
    let active = items.filter(i => i.status === 'uploading' || i.status === 'processing').length
    for (const item of items) {
      if (active >= CONCURRENCY) break
      if (item.status !== 'queued') continue
      active++
      send(item)
    }
  }

  return {
    items: [],
    enqueue: async (projectId, files) => {
      const fresh: UploadItem[] = files.map(file => ({ id: `up${++seq}`, projectId, file, name: file.name, size: file.size, progress: 0, status: 'queued' }))
      const done = Promise.all(fresh.map(i => new Promise<void>(resolve => waiters.set(i.id, resolve))))
      set(s => ({ items: [...s.items, ...fresh] }))
      pump()
      await done
      const ids = new Set(fresh.map(i => i.id))
      return get().items.filter(i => ids.has(i.id))
    },
    dismiss: projectId => set(s => ({ items: s.items.filter(i => i.projectId !== projectId || ['queued', 'uploading', 'processing'].includes(i.status)) })),
    remove: id => set(s => ({ items: s.items.filter(i => i.id !== id) })),
  }
})

export const isActive = (i: UploadItem): boolean => i.status === 'queued' || i.status === 'uploading' || i.status === 'processing'
