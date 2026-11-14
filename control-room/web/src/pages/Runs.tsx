// Every agent run, live and historic, from the lifecycle events. A run is "quiet" when it is still
// open but its item has had no event for the stale threshold. Virtualised: thousands of rows stay fast.
import { useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Hand, Hourglass, OctagonX } from 'lucide-react'
import { useApiState, useNow, useRuns, type ItemSummary, type RunRow } from '@/lib/api'
import { ago, cn, compact, duration } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { ItemId, LiveDot, Mono, STATUS, Status, StatusGlyph } from '@/components/vocab'

type RunState = 'running' | 'quiet' | 'waiting' | 'finished' | 'abandoned'
const RUN_STATES: RunState[] = ['running', 'quiet', 'waiting', 'finished', 'abandoned']

function runState(r: RunRow, item: ItemSummary | undefined): RunState {
  if (r.outcome !== 'running') return r.outcome
  if (r.agentType === 'foreman' && item?.flags.includes('waiting-input')) return 'waiting'
  if (item?.flags.includes('quiet')) return 'quiet'
  return 'running'
}

function RunStatus({ s, item, now }: { s: RunState; item?: ItemSummary; now: number }) {
  if (s === 'running') return <Status status="running" />
  if (s === 'quiet')
    return (
      <span className="inline-flex items-center gap-1 text-muted" title="Open, but no event for longer than the stale threshold">
        <Hourglass aria-hidden className="size-3.5" />
        quiet{item?.lastActivity ? ` · ${ago(item.lastActivity, now)}` : ''}
      </span>
    )
  if (s === 'waiting')
    return (
      <span className="inline-flex items-center gap-1 text-run">
        <Hand aria-hidden className="size-3.5" />
        waiting for you
      </span>
    )
  if (s === 'abandoned')
    return (
      <span className="inline-flex items-center gap-1 text-fail" title="The session ended without this run finishing">
        <OctagonX aria-hidden className="size-3.5" />
        abandoned
      </span>
    )
  return <span className="text-muted">finished</span>
}

const COLS = 'grid grid-cols-[minmax(200px,2.2fr)_minmax(110px,1fr)_80px_minmax(120px,1fr)_70px_76px_130px_110px_var(--tok)] items-center gap-x-3'

export function Runs() {
  const { data, error, isPending, refetch } = useRuns()
  const { data: state } = useApiState()
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const agent = params.get('agent') ?? ''
  const status = (params.get('status') ?? '') as RunState | ''
  const q = (params.get('q') ?? '').toLowerCase()
  const set = (k: string, v: string) => setParams((p) => (v ? p.set(k, v) : p.delete(k), p), { replace: true })

  const items = useMemo(() => new Map(state?.items.map((i) => [i.id, i])), [state])
  const all = useMemo(() => (data?.runs ?? []).map((r) => ({ r, s: runState(r, items.get(r.workId)) })), [data, items])
  const rows = all.filter(({ r, s }) => (!agent || r.agentType === agent) && (!status || s === status) && (!q || `#${r.workId} ${r.title ?? ''}`.toLowerCase().includes(q)))
  const agents = [...new Set(all.map(({ r }) => r.agentType))].sort()
  const counts = Object.fromEntries(RUN_STATES.map((s) => [s, all.filter((x) => x.s === s).length]))
  const tokens = !!data?.tokensAvailable

  const parent = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 34, overscan: 16 })

  return (
    <>
      <PageHeader title="Runs">
        <span className="text-[12px] text-muted tabular">
          {counts.running} running · {counts.quiet} quiet · {counts.waiting} waiting · {all.length} total
        </span>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
        <input
          type="search"
          value={params.get('q') ?? ''}
          onChange={(e) => set('q', e.target.value)}
          placeholder="Filter by item"
          data-page-filter
          aria-label="Filter by item number or title"
          className="h-7 w-52 rounded-md border border-border bg-surface px-2 text-[12.5px]"
        />
        <select value={agent} onChange={(e) => set('agent', e.target.value)} aria-label="Agent" className="h-7 rounded-md border border-border bg-surface px-1.5 text-[12.5px]">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <div role="group" aria-label="Status" className="inline-flex border border-border bg-surface">
          {(['', ...RUN_STATES] as const).map((s) => (
            <button key={s || 'all'} aria-pressed={status === s} onClick={() => set('status', s)} className={cn('border-r border-border px-2.5 py-1 font-mono text-[11.5px] text-muted last:border-r-0 hover:text-fg', status === s && 'bg-accent text-white hover:text-white')}>
              {s || 'all'}
              {s && <span className="ml-1 tabular text-faint">{counts[s]}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="p-5">
        {isPending ? (
          <Loading rows={8} label="Loading runs" />
        ) : error ? (
          <ErrorState title="Could not load runs" error={error} onRetry={() => void refetch()} />
        ) : !all.length ? (
          <Empty title="No agent runs recorded">
            Runs come from the lifecycle events the telemetry hook appends to <Mono>.factory/events.jsonl</Mono>. That file exists only on the machine that ran the factory.
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface" style={{ ['--tok' as string]: tokens ? '80px' : '0px' }}>
            <div role="table" aria-label="Agent runs" aria-rowcount={rows.length + 1} className="min-w-[1000px]">
              <div role="row" className={cn(COLS, 'label border-b border-border px-3 py-2')}>
                <span role="columnheader">Item</span>
                <span role="columnheader">Agent</span>
                <span role="columnheader">Stage</span>
                <span role="columnheader">Model</span>
                <span role="columnheader">Started</span>
                <span role="columnheader" className="text-right">
                  Took
                </span>
                <span role="columnheader">Run</span>
                <span role="columnheader">Stage result</span>
                <span role="columnheader" className={cn('text-right', !tokens && 'sr-only')}>
                  {tokens ? 'Tokens' : ''}
                </span>
              </div>
              {rows.length ? (
                <div ref={parent} className="max-h-[calc(100vh-190px)] overflow-y-auto">
                  <div role="rowgroup" style={{ height: v.getTotalSize(), position: 'relative' }}>
                    {v.getVirtualItems().map((vi) => {
                      const { r, s } = rows[vi.index]!
                      const item = items.get(r.workId)
                      return (
                        <div key={vi.key} role="row" aria-rowindex={vi.index + 2} className={cn(COLS, 'absolute inset-x-0 border-b border-border px-3 text-[12.5px]')} style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}>
                          <span role="cell" className="flex min-w-0 items-center gap-1.5">
                            {s === 'running' && <LiveDot />}
                            {r.workId ? (
                              <>
                                <ItemId id={r.workId} />
                                <Link data-nav-item to={`/items/${r.workId}/activity`} className="truncate hover:underline" title={r.title}>
                                  {r.title ?? <span className="text-faint">unknown item</span>}
                                </Link>
                              </>
                            ) : (
                              <span className="truncate text-muted" title="A Claude Code session that was not running /work: setup, /groom, /audit or a plain chat">
                                no work item
                              </span>
                            )}
                          </span>
                          <span role="cell" className="truncate">
                            <Mono>{r.agentType}</Mono>
                          </span>
                          <span role="cell">{r.stage ?? <span className="text-faint">—</span>}</span>
                          <span role="cell" className="truncate" title={r.model ?? r.tokensNote}>
                            {r.model ? <Mono className="text-muted">{r.model}</Mono> : <span className="text-faint">—</span>}
                          </span>
                          <span role="cell" className="text-muted tabular" title={r.start}>
                            {r.start ? `${ago(r.start, now)} ago` : '—'}
                          </span>
                          <span role="cell" className="text-right text-muted tabular">
                            {r.start ? duration((r.end ? Date.parse(r.end) : now) - Date.parse(r.start)) : '—'}
                          </span>
                          <span role="cell">
                            <RunStatus s={s} item={item} now={now} />
                          </span>
                          <span role="cell">
                            {r.stageResult && r.stageResult !== 'pending' && r.stageResult !== 'running' ? (
                              <span className="inline-flex items-center gap-1">
                                <StatusGlyph status={r.stageResult} />
                                {STATUS[r.stageResult].label}
                              </span>
                            ) : (
                              <span className="text-faint">—</span>
                            )}
                          </span>
                          <span role="cell" className={cn('text-right tabular', !tokens && 'sr-only')} title={r.tokens ? `input ${r.tokens.input}, output ${r.tokens.output}, cache write ${r.tokens.cacheWrite}, cache read ${r.tokens.cacheRead}` : r.tokensNote}>
                            {tokens ? r.tokens ? compact(r.tokens.total) : <span className="text-faint">—</span> : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div className="px-3 py-6 text-muted">No runs match these filters.</div>
              )}
            </div>
          </div>
        )}
        {!isPending && !error && !!all.length && !tokens && <p className="mt-2 text-[12px] text-muted">Token figures are hidden: no transcript on this machine could be read.</p>}
      </div>
    </>
  )
}
