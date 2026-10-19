import { BellRing, Monitor, Volume2 } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { NotificationSettings } from '@shared/types'
import { browserNotifyEnabled, chime, desktopNotify, requestNotifyPermission, setBrowserNotify } from '../../lib/notify'
import { useApp } from '../../store/app'
import { Badge, Button, Panel, Toggle } from '../../components/ui'
import type { Tone } from '../../components/ui'
import { Loading, SaveButton, SectionHeader, useSettingsDraft } from './shared'

const EVENTS: Array<{ key: keyof NotificationSettings['on']; label: string; hint: string }> = [
  { key: 'humanRequest', label: 'Questions et demandes de PDF', hint: 'Un agent a besoin de toi pour avancer.' },
  { key: 'approval', label: 'Approbations requises', hint: 'Une commande attend ton feu vert.' },
  { key: 'runFinished', label: 'Fin / pause de recherche', hint: 'Rapport rendu ou budget atteint.' },
  { key: 'error', label: 'Erreurs', hint: 'Provider injoignable, outil en échec répété…' },
  { key: 'finding', label: 'Résultats importants (notify_human)', hint: 'L\'agent juge qu\'une découverte mérite ton attention.' },
  { key: 'supervisorCritical', label: 'Alertes critiques du superviseur', hint: 'Dérive, boucle ou erreur de fond détectée.' },
]

const PERMISSION: Record<NotificationPermission | 'unsupported', { label: string; tone: Tone }> = {
  granted: { label: 'autorisées', tone: 'teal' },
  default: { label: 'à autoriser', tone: 'amber' },
  denied: { label: 'bloquées', tone: 'brick' },
  unsupported: { label: 'non supportées', tone: 'neutral' },
}

const currentPermission = (): NotificationPermission | 'unsupported' => ('Notification' in window ? Notification.permission : 'unsupported')

export function NotificationsSection() {
  const { draft, setDraft, save, saving, dirty, loadError } = useSettingsDraft(['notifications'] as const)
  const [browserOn, setBrowserOn] = useState(browserNotifyEnabled)
  const [permission, setPermission] = useState(currentPermission)

  const set = (patch: Partial<NotificationSettings>): void => setDraft(d => d && { notifications: { ...d.notifications, ...patch } })
  const setOn = (key: keyof NotificationSettings['on'], v: boolean): void =>
    setDraft(d => d && { notifications: { ...d.notifications, on: { ...d.notifications.on, [key]: v } } })

  const toggleBrowser = async (on: boolean): Promise<void> => {
    setBrowserNotify(on)
    setBrowserOn(on)
    set({ browser: on })
    if (on) setPermission(await requestNotifyPermission())
  }

  const test = (): void => {
    chime()
    if (permission === 'granted' && browserOn) {
      try {
        new Notification('Noesis · test', { body: 'Les notifications de ce navigateur fonctionnent.', icon: '/favicon.svg' })
      } catch {
        desktopNotify('Noesis · test', 'Les notifications de ce navigateur fonctionnent.')
      }
    }
    useApp.getState().toast({ title: 'Notification de test', body: permission === 'granted' ? 'Carillon joué et notification envoyée.' : 'Carillon joué. Autorise les notifications pour les voir hors de l\'onglet.', level: 'info' })
  }

  const perm = PERMISSION[permission]

  return (
    <>
      <SectionHeader
        kicker="05 · Notifications"
        title="Notifications"
        actions={<SaveButton dirty={dirty} saving={saving} onClick={() => void save(undefined, 'Notifications enregistrées')} />}
      >
        Une recherche autonome peut durer des heures : choisis ce qui mérite de t'interrompre.
      </SectionHeader>

      {!draft ? <Loading error={loadError} /> : (
        <div className="flex flex-col gap-5">
          <Panel kicker="Canaux" title="Comment te prévenir" bodyClassName="flex flex-col gap-4 p-5">
            <Channel icon={<Monitor className="size-4" />}>
              <Toggle checked={draft.notifications.windowsToast} onChange={v => set({ windowsToast: v })} label="Notifications Windows" hint="Toasts système envoyés par le serveur, même navigateur fermé." />
            </Channel>
            <Channel icon={<Volume2 className="size-4" />}>
              <Toggle checked={draft.notifications.sound} onChange={v => set({ sound: v })} label="Son" hint="Accompagne les notifications système d'un signal sonore." />
            </Channel>
            <Channel icon={<BellRing className="size-4" />}>
              <div className="flex flex-1 flex-wrap items-start justify-between gap-3">
                <Toggle checked={browserOn} onChange={v => void toggleBrowser(v)} label="Notifications du navigateur" hint="Propre à ce navigateur : carillon si l'onglet est au premier plan, notification sinon." />
                <div className="flex items-center gap-2">
                  <Badge tone={perm.tone}>{perm.label}</Badge>
                  {permission === 'default' ? <Button size="sm" variant="outline" onClick={async () => setPermission(await requestNotifyPermission())}>Autoriser</Button> : null}
                  <Button size="sm" variant="subtle" onClick={test}>Tester</Button>
                </div>
              </div>
            </Channel>
            {permission === 'denied' ? <p className="pl-9 text-[11.5px] text-brick">Les notifications sont bloquées pour ce site : réautorise-les depuis l'icône de cadenas de la barre d'adresse.</p> : null}
          </Panel>

          <Panel kicker="Événements" title="Quand te prévenir" bodyClassName="grid grid-cols-1 gap-x-6 gap-y-4 p-5 md:grid-cols-2">
            {EVENTS.map(e => (
              <Toggle key={e.key} checked={draft.notifications.on[e.key]} onChange={v => setOn(e.key, v)} label={e.label} hint={e.hint} />
            ))}
          </Panel>
        </div>
      )}
    </>
  )
}

function Channel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-ink-850 text-ink-400">{icon}</span>
      {children}
    </div>
  )
}
