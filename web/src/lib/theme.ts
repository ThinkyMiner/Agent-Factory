// Light, dark or follow the system. One store, so the sidebar toggle and the command palette agree.
import { useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'
function read(): Theme {
  try {
    const t = localStorage.getItem('cr-theme')
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system' // storage blocked: follow the system
  }
}
let theme: Theme = read()
const subs = new Set<() => void>()
const mq = matchMedia('(prefers-color-scheme: dark)')

export function applyTheme(t: Theme = theme) {
  document.documentElement.classList.toggle('dark', t === 'dark' || (t === 'system' && mq.matches))
}
mq.addEventListener('change', () => applyTheme())

export function setTheme(t: Theme) {
  theme = t
  try {
    localStorage.setItem('cr-theme', t)
  } catch {}
  applyTheme(t)
  subs.forEach((f) => f())
}
export const useTheme = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => theme,
  )
