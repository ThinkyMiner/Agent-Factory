// Data access: JSON over fetch, kept fresh by the server's SSE "changed" stream.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiState, ItemDetail } from '../../../server/core/api.ts'

export type { ApiState, ItemDetail, ItemSummary } from '../../../server/core/api.ts'
export type { NeedsEntry, RunningEntry, StageView, NeedsKind, State, Column } from '../../../server/core/derive.ts'
export type { Tier, Stage, Notice } from '../../../server/core/types.ts'

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
