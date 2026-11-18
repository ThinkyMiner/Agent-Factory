// Data access: JSON over fetch, kept fresh by the server's SSE "changed" stream.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiState, ItemDetail, RunsResponse } from '../../../server/core/api.ts'
import type { Quality } from '../../../server/core/quality.ts'
import type { AuditsView, FactoryView, ImprovementView, MemoryView, MetaFile } from '../../../server/core/meta.ts'
import type { GitHubStatus } from '../../../server/core/types.ts'
import type { TeamsView } from '../../../server/core/teams.ts'

export type { ApiState, ItemDetail, ItemSummary, RunRow, RunsResponse } from '../../../server/core/api.ts'
export type { Quality, Metric, Point, Part } from '../../../server/core/quality.ts'
export type { NeedsEntry, RunningEntry, StageView, NeedsKind, State, Column } from '../../../server/core/derive.ts'
export type { Tier, Stage, Notice } from '../../../server/core/types.ts'
export type { AuditsView, Drift, FactoryView, ImprovementView, MemoryView, Prediction } from '../../../server/core/meta.ts'
export type { CycleView, FeatureView, Message, SessionTab, TeamRow, TeamsView } from '../../../server/core/teams.ts'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new HttpError(r.status, (await r.text().catch(() => '')) || r.statusText)
  return r.json() as Promise<T>
}
export async function getText(path: string): Promise<string> {
  const r = await fetch(path)
  if (!r.ok) throw new HttpError(r.status, r.statusText)
  return r.text()
}

export const useApiState = () => useQuery({ queryKey: ['state'], queryFn: () => getJson<ApiState>('/api/state') })
export const useItem = (id: string) => useQuery({ queryKey: ['item', id], queryFn: () => getJson<ItemDetail>(`/api/items/${encodeURIComponent(id)}`), retry: (n, e) => !(e instanceof HttpError && e.status === 404) && n < 2 })

export const useRuns = () => useQuery({ queryKey: ['runs'], queryFn: () => getJson<RunsResponse>('/api/runs') })
export const useQuality = (weeks: number) => useQuery({ queryKey: ['quality', weeks], queryFn: () => getJson<Quality>(`/api/quality?weeks=${weeks}`), placeholderData: keepPreviousData })

// ---------- actions (only when the server was started with --actions) ----------

const TOKEN = typeof document === 'undefined' ? '' : (document.querySelector('meta[name="cr-token"]')?.getAttribute('content') ?? '')

export interface ActionReply {
  ok: boolean
  message: string
}
/** POST one action. The browser adds Origin and Sec-Fetch-Site; the token proves it is this page. */
export async function postAction(name: 'mark-ready' | 'approve' | 'answer', body: Record<string, unknown>): Promise<ActionReply> {
  const r = await fetch(`/api/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-room-token': TOKEN }, body: JSON.stringify(body) })
  const j = (await r.json().catch(() => ({}))) as Partial<ActionReply> & { error?: string }
  if (!r.ok || !j.ok) throw new HttpError(r.status, j.message ?? j.error ?? r.statusText)
  return j as ActionReply
}

export interface ApprovePreview extends ActionReply {
  pr: number
  title: string
  url: string
  headSha: string
  item?: { id: string; title: string }
  tier?: import('../../../server/core/types.ts').Tier
  sources: { source: string; tier: import('../../../server/core/types.ts').Tier; why?: string }[]
  r2Files: { path: string; tier: import('../../../server/core/types.ts').Tier; pattern: string | null }[]
  files: number
  review: null | { verdict: string; blocking: number; nonBlocking: number } | { error: string }
  checks: { name: string; conclusion: string }[]
  notVerified: number | null
  confirm: string
}
export const useApprovePreview = (pr: number, enabled: boolean) =>
  useQuery({ enabled, queryKey: ['approve-preview', pr], queryFn: () => getJson<ApprovePreview>(`/api/actions/approve?pr=${pr}`), staleTime: 0, gcTime: 0 })

export interface ActionLogEntry {
  at: string
  action: string
  outcome: 'done' | 'refused' | 'failed'
  status: number
  message: string
  input?: { issue?: number; pr?: number; body?: string }
}
export const useActionLog = () => useQuery({ queryKey: ['action-log'], queryFn: () => getJson<ActionLogEntry[]>('/api/actions/log') })

export const useMemory = () => useQuery({ queryKey: ['memory'], queryFn: () => getJson<MemoryView>('/api/memory') })
export const useImprovement = () => useQuery({ queryKey: ['improvement'], queryFn: () => getJson<ImprovementView & { github: GitHubStatus }>('/api/improvement') })
export const useFactoryConfig = () => useQuery({ queryKey: ['factory'], queryFn: () => getJson<FactoryView>('/api/factory') })
export const useFactoryFile = (path: string | null) =>
  useQuery({ enabled: !!path, queryKey: ['factory-file', path], queryFn: () => getJson<MetaFile & { diff: string | null }>(`/api/factory/file?path=${encodeURIComponent(path!)}`) })
/** Team mode only: null when the factory has no factory/teams.json. */
export const useTeams = (enabled = true) => useQuery({ enabled, queryKey: ['teams'], queryFn: () => getJson<TeamsView | null>('/api/teams') })
export const useAudits = () => useQuery({ queryKey: ['audits'], queryFn: () => getJson<AuditsView>('/api/audits') })

/** Subscribe to server changes; returns whether the stream is connected. */
export function useLiveUpdates(): boolean {
  const qc = useQueryClient()
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const es = new EventSource('/api/stream')
    let last = -1
    es.addEventListener('changed', (e) => {
      setConnected(true)
      const { version } = JSON.parse((e as MessageEvent).data) as { version: number }
      if (version !== last) {
        last = version
        void qc.invalidateQueries()
      }
    })
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [qc])
  return connected
}

// one shared clock for relative times, ticking every 15 s
let now = Date.now()
const subs = new Set<() => void>()
setInterval(() => {
  now = Date.now()
  subs.forEach((f) => f())
}, 15_000)
export const useNow = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => now,
  )
