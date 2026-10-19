/** Browser notifications + a soft chime, as a complement to Windows toasts. */

const KEY = 'noesis.browserNotify'

export function browserNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function setBrowserNotify(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // ignore
  }
}

export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  if (Notification.permission === 'default') return Notification.requestPermission()
  return Notification.permission
}

let audio: AudioContext | undefined

export function chime(): void {
  try {
    audio ??= new AudioContext()
    const t = audio.currentTime
    for (const [i, f] of [660, 990].entries()) {
      const o = audio.createOscillator()
      const g = audio.createGain()
      o.frequency.value = f
      o.type = 'sine'
      g.gain.setValueAtTime(0, t + i * 0.12)
      g.gain.linearRampToValueAtTime(0.06, t + i * 0.12 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.5)
      o.connect(g).connect(audio.destination)
      o.start(t + i * 0.12)
      o.stop(t + i * 0.12 + 0.55)
    }
  } catch {
    // ignore
  }
}

export function desktopNotify(title: string, body: string): void {
  if (!browserNotifyEnabled()) return
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    chime()
    return
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/favicon.svg', tag: title })
    } catch {
      // ignore
    }
  }
}
