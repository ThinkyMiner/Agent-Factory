import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...v: ClassValue[]) => twMerge(clsx(v))

const MIN = 60_000
export function ago(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  const ms = now - Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  if (ms < MIN) return 'just now'
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)}m`
  if (ms < 48 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))}h`
  return `${Math.floor(ms / (24 * 60 * MIN))}d`
}
export function duration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—'
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)}m ${Math.round((ms % MIN) / 1000)}s`
  return `${Math.floor(ms / (60 * MIN))}h ${Math.floor((ms % (60 * MIN)) / MIN)}m`
}
export const elapsed = (iso: string | undefined, now: number) => (iso ? duration(now - Date.parse(iso)) : '—')
export const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')
const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
export const compact = (n: number) => COMPACT.format(n)
/** "3 Nov" from a YYYY-MM-DD week start, read as a local date. */
export const day = (ymd: string) => new Date(`${ymd}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** The Monday (local) of the week holding a YYYY-MM-DD date; weeks match the Quality screen. */
export function monday(ymd: string, plusWeeks = 0): string {
  const d = new Date(`${ymd}T00:00`)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + plusWeeks * 7)
  return ymdOf(d)
}
export const today = () => ymdOf(new Date())
