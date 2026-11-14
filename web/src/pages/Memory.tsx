// What the factory has learned: lessons (each with its evidence), every observation (searchable),
// and where observations cluster (stage x week). All of it is text agents wrote: rendered as text.
import { useMemo, useRef } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Tabs } from 'radix-ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ShieldCheck } from 'lucide-react'
import { useMemory, useNow, type MemoryView } from '@/lib/api'
import { cn, day, monday, today } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { ItemRefs } from '@/components/ItemsPanel'
import { DriftFlag, ItemId, Mono, PriorityTag, TAB, TAB_LIST } from '@/components/vocab'
import { Raw } from '@/components/Markdown'

const TABS = ['lessons', 'observations', 'patterns'] as const
type Tab = (typeof TABS)[number]

export function Memory() {
  const { tab } = useParams()
  const nav = useNavigate()
  const current: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'lessons'
  const { data, error, isPending, refetch } = useMemory()
  return (
    <>
      <PageHeader title="Memory">
        {data && (
          <span className="text-[12px] text-muted tabular">
            {data.lessons.length} of {data.cap} lessons · {data.observations.length} observations
          </span>
        )}
      </PageHeader>
      <div className="p-5">
        {isPending ? (
          <Loading rows={6} label="Loading memory" />
        ) : error ? (
          <ErrorState title="Could not load memory" error={error} onRetry={() => void refetch()} />
        ) : (
          <Tabs.Root value={current} onValueChange={(v) => nav(`/memory/${v}`, { replace: true })}>
            <Tabs.List aria-label="Memory" className={TAB_LIST}>
              <Tabs.Trigger value="lessons" className={TAB}>Lessons ({data!.lessons.length})</Tabs.Trigger>
              <Tabs.Trigger value="observations" className={TAB}>Observations ({data!.observations.length})</Tabs.Trigger>
              <Tabs.Trigger value="patterns" className={TAB}>Patterns</Tabs.Trigger>
            </Tabs.List>
            <div className="pt-4">
              <Tabs.Content value="lessons"><Lessons m={data!} /></Tabs.Content>
              <Tabs.Content value="observations"><Observations m={data!} /></Tabs.Content>
              <Tabs.Content value="patterns"><Patterns m={data!} /></Tabs.Content>
            </div>
          </Tabs.Root>
        )}
      </div>
    </>
  )
}

const EXPIRY_DAYS = 60 // MEMORY.md: "No supporting observation in 60 days means removal."

function Lessons({ m }: { m: MemoryView }) {
  const now = useNow()
  return (
    <div className="max-w-5xl space-y-4">
      <p className="text-muted">
        Loaded into every agent on every run through <Mono>CLAUDE.md</Mono>. Changed only by <Mono>/reflect</Mono>, through a pull request you read. <Mono>{m.file?.path ?? 'memory/lessons.md'}</Mono> <DriftFlag f={m.file} />
      </p>
      {m.notices.length > 0 && (
        <div role="status" className="space-y-2 rounded-lg border border-block/40 bg-block-bg px-4 py-3">
          <div className="font-medium">Lines in lessons.md that could not be read as lessons</div>
          {m.notices.map((n, i) => (
            <div key={i}>
              <div className="text-[12.5px]">{n.message}</div>
              {n.raw && <Raw text={n.raw} className="mt-1" />}
            </div>
          ))}
        </div>
      )}
      {!m.lessons.length ? (
        <Empty title={m.file ? 'No lessons yet' : 'No memory/lessons.md'}>
          <Mono>/reflect</Mono> adds a lesson only when a pattern has evidence from at least two work items, and only when nothing stronger (a test, a lint rule, a check) fits.
        </Empty>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border bg-surface">
          {m.lessons.map((l) => {
            const age = Math.floor((now - Date.parse(`${l.added}T00:00`)) / 86_400_000)
            return (
              <li key={l.id} className="grid grid-cols-[3.5rem_5.5rem_1fr] gap-x-3 gap-y-1 px-4 py-2.5 max-md:grid-cols-[3.5rem_1fr]">
                <Mono className="pt-px">{l.id}</Mono>
                <span className="text-muted max-md:hidden">{l.stage}</span>
                <div className="min-w-0 space-y-1">
                  <div>{l.text}</div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                    <span className="inline-flex items-center gap-1">
                      Evidence <ItemRefs ids={l.evidence} />
                    </span>
                    <span title={l.added}>
                      Added {Number.isNaN(age) ? l.added : age === 0 ? 'today' : `${age} days ago`}
                      {age > EXPIRY_DAYS && <span className="ml-1 font-medium text-attention">· older than {EXPIRY_DAYS} days: due for a /reflect check</span>}
                    </span>
                    {l.enforcement === 'none' ? (
                      <span title="Relies on the model remembering it. MEMORY.md: turn it into a test, lint rule or check, then delete the line.">Enforcement: none (memory only)</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-fg">
                        <ShieldCheck aria-hidden className="size-3.5" /> Enforced by {l.enforcement}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function Observations({ m }: { m: MemoryView }) {
  const [params, setParams] = useSearchParams()
  const set = (k: string, v: string) => setParams((p) => (v ? p.set(k, v) : p.delete(k), p), { replace: true })
  const q = params.get('q') ?? ''
  const stage = params.get('stage') ?? ''
  const priority = params.get('priority') ?? ''
  const item = (params.get('item') ?? '').replace(/^#/, '')
  const week = params.get('week') ?? ''
  const stages = useMemo(() => [...new Set(m.observations.map((o) => o.stage))].sort(), [m])
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const end = week && monday(week, 1)
    return m.observations
      .filter((o) => (!stage || o.stage === stage) && (!priority || o.priority === priority) && (!item || o.workId === item) && (!week || (o.date >= week && o.date < end!)))
      .filter((o) => {
        if (!words.length) return true
        const hay = `${o.text} ${o.source ?? ''} ${o.stage} #${o.workId}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      .sort((a, b) => b.date.localeCompare(a.date) || Number(b.workId) - Number(a.workId))
  }, [m, q, stage, priority, item, week])
  const parent = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 52, overscan: 10 })

  if (!m.observations.length) return <Empty title="No observations yet">The observer writes three to ten sourced observations at the end of every <Mono>/work</Mono> run, into <Mono>memory/observations/</Mono>.</Empty>
  const control = 'h-7 rounded-md border border-border bg-surface px-2 text-[12.5px]'
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input data-page-filter type="search" value={q} onChange={(e) => set('q', e.target.value)} placeholder="Search observations" aria-label="Search observations" className={cn(control, 'w-64')} />
        <select value={stage} onChange={(e) => set('stage', e.target.value)} aria-label="Stage" className={control}>
          <option value="">All stages</option>
          {stages.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div role="group" aria-label="Priority" className="inline-flex border border-border bg-surface">
          {['', 'high', 'med', 'low'].map((p) => (
            <button key={p || 'any'} aria-pressed={priority === p} onClick={() => set('priority', p)} className={cn('border-r border-border px-2.5 py-1 font-mono text-[11.5px] text-muted last:border-r-0 hover:text-fg', priority === p && 'bg-accent text-white hover:text-white')}>
              {p || 'any priority'}
            </button>
          ))}
        </div>
        <input value={params.get('item') ?? ''} onChange={(e) => set('item', e.target.value.trim())} placeholder="#item" aria-label="Item number" className={cn(control, 'w-20 font-mono')} />
        {week && (
          <button onClick={() => set('week', '')} className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[12px] hover:border-border-strong" aria-label={`Remove the week filter, week of ${day(week)}`}>
            Week of {day(week)} ×
          </button>
        )}
        <span className="ml-auto text-[12px] text-muted tabular" aria-live="polite">
          {rows.length} of {m.observations.length}
        </span>
      </div>
      {rows.length ? (
        <div ref={parent} className="max-h-[calc(100vh-230px)] overflow-y-auto rounded-lg border border-border bg-surface" role="list" aria-label="Observations">
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const o = rows[vi.index]!
              return (
                <div key={o.key} role="listitem" data-index={vi.index} ref={v.measureElement} className="absolute inset-x-0 grid grid-cols-[6rem_3.5rem_3.5rem_6rem_1fr] gap-x-3 border-b border-border px-3 py-1.5 max-md:grid-cols-[3.5rem_1fr]" style={{ transform: `translateY(${vi.start}px)` }}>
                  <time className="text-muted tabular max-md:hidden" dateTime={o.date}>{o.date}</time>
                  <ItemId id={o.workId} />
                  <PriorityTag p={o.priority} />
                  <span className="text-muted max-md:hidden">{o.stage}</span>
                  <span className="min-w-0 max-md:col-span-2">
                    {o.text}
                    {o.source ? <span className="block text-[12px] text-muted">Source: {o.source}</span> : <span className="block text-[12px] text-block">No source recorded</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <Empty title="No observations match these filters" />
      )}
    </div>
  )
}

/** Observation counts by stage and week: where the factory keeps tripping. Every cell opens its rows. */
function Patterns({ m }: { m: MemoryView }) {
  const weeks = useMemo(() => Array.from({ length: 12 }, (_, i) => monday(today(), i - 11)), [])
  const rows = useMemo(() => {
    const by = new Map<string, { stage: string; cells: Map<string, number>; high: number; total: number }>()
    for (const o of m.observations) {
      const w = monday(o.date)
      if (!o.date || w < weeks[0]!) continue
      const r = by.get(o.stage) ?? { stage: o.stage, cells: new Map(), high: 0, total: 0 }
      r.cells.set(w, (r.cells.get(w) ?? 0) + 1)
      r.total++
      if (o.priority === 'high') r.high++
      by.set(o.stage, r)
    }
    return [...by.values()].sort((a, b) => b.total - a.total)
  }, [m, weeks])
  const max = Math.max(1, ...rows.flatMap((r) => [...r.cells.values()]))
  if (!rows.length) return <Empty title="No observations in the last 12 weeks" />
  return (
    <div className="space-y-2">
      <p className="text-muted">Observations per stage and week, last 12 weeks. A stage that stays dark week after week is a pattern for <Mono>/reflect</Mono>. Select a number to read the observations behind it.</p>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-center text-[12.5px]">
          <thead className="text-[11.5px] text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left font-medium">Stage</th>
              {weeks.map((w) => (
                <th key={w} className="px-1 py-1.5 font-medium whitespace-nowrap">{day(w)}</th>
              ))}
              <th className="px-3 py-1.5 font-medium">Total</th>
              <th className="px-3 py-1.5 font-medium">[high]</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-3 py-1 text-left font-normal">{r.stage}</th>
                {weeks.map((w) => {
                  const n = r.cells.get(w) ?? 0
                  const pct = Math.round((n / max) * 85) + 10
                  return (
                    <td key={w} className="p-0.5">
                      {n ? (
                        <Link
                          to={`/memory/observations?stage=${encodeURIComponent(r.stage)}&week=${w}`}
                          aria-label={`${n} ${r.stage} observations, week of ${day(w)}`}
                          className={cn('block rounded-[3px] py-1 font-medium tabular hover:outline hover:outline-1 hover:outline-fg', pct > 55 ? 'text-white' : 'text-fg')}
                          style={{ background: `color-mix(in srgb, var(--series-1) ${pct}%, var(--surface))` }}
                        >
                          {n}
                        </Link>
                      ) : (
                        <span className="block py-1 text-faint" aria-hidden>·</span>
                      )}
                    </td>
                  )
                })}
                <td className="px-3 tabular">
                  <Link to={`/memory/observations?stage=${encodeURIComponent(r.stage)}`} className="hover:underline">{r.total}</Link>
                </td>
                <td className="px-3 tabular">
                  {r.high ? <Link to={`/memory/observations?stage=${encodeURIComponent(r.stage)}&priority=high`} className="hover:underline">{r.high}</Link> : <span className="text-faint">0</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
