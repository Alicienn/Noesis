import fs from 'node:fs'
import path from 'node:path'
import notifier from 'node-notifier'
import type { ServerEvent } from '../../shared/types.ts'
import { bus } from '../core/events.ts'
import { getSettings } from '../settings.ts'
import { getProject } from '../store/projects.ts'
import { ROOT_DIR, PORT } from '../config.ts'

/**
 * Desktop notifications (Windows toast via SnoreToast, macOS/Linux native) and
 * in-app `notify` events that the browser turns into Notification API popups.
 */

type Level = 'info' | 'success' | 'warn' | 'error'

const recent = new Map<string, number>()
const ICON = path.join(ROOT_DIR, 'web', 'public', 'icon.png')

export function notify(projectId: string, title: string, body: string, level: Level = 'info', kind?: keyof ReturnType<typeof getSettings>['notifications']['on']): void {
  const settings = getSettings().notifications
  if (kind && !settings.on[kind]) return
  // de-duplicate identical notifications within 20 s
  const key = `${projectId}:${title}:${body}`
  const last = recent.get(key) ?? 0
  if (Date.now() - last < 20_000) return
  recent.set(key, Date.now())

  const project = getProject(projectId)
  const fullTitle = project ? `${title} — ${project.title}` : title
  bus.publish(projectId, { type: 'notify', title: fullTitle, body, level })
  bus.publish('*', { type: 'notify', title: fullTitle, body, level })

  if (!settings.windowsToast) return
  try {
    notifier.notify({
      title: `Noesis · ${fullTitle}`.slice(0, 120),
      message: body.slice(0, 250) || ' ',
      appID: 'Noesis Research',
      sound: settings.sound,
      wait: false,
      ...(fs.existsSync(ICON) ? { icon: ICON } : {}),
      // clicking the toast opens the dashboard
      ...(process.platform === 'win32' ? {} : { open: `http://localhost:${PORT}/p/${projectId}` }),
    } as any)
  } catch {
    // never let notification failures break a run
  }
}

/** Wire automatic notifications from bus events. */
export function startNotifier(): void {
  bus.subscribeAll((projectId: string, event: ServerEvent) => {
    if (projectId === '*') return
    if (event.type === 'request.upserted' && event.request.status === 'pending') {
      const r = event.request
      // only on creation (resolved_at undefined, created recently)
      if (Date.now() - r.createdAt > 5000) return
      if (r.kind === 'approval') notify(projectId, 'Approbation requise', r.title, 'warn', 'approval')
      else if (r.kind === 'pdf') notify(projectId, 'PDF demandé', r.title, 'warn', 'humanRequest')
      else notify(projectId, r.blocking ? 'Question bloquante' : 'Question de l\'agent', r.title, 'warn', 'humanRequest')
    }
  })
}
