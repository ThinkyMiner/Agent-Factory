// Items as cards in columns by state. Filters live in the URL so a view can be linked.
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import { useApiState, useNow, type Column, type ItemSummary, type Tier } from '@/lib/api'
import { ago, cn } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { ItemId, LiveDot, NEEDS, NeedsTag, StageDots, StageLabel, StateBadge, TIER_HINT, TierChip } from '@/components/vocab'

const COLUMNS: { key: Column; label: string; hint: string }[] = [
  { key: 'proposed', label: 'Proposed', hint: 'Issues labelled factory:proposed' },
  { key: 'ready', label: 'Ready', hint: 'Labelled factory:ready, or dispatched to a team (team mode); not started' },
  { key: 'in-progress', label: 'In progress', hint: 'A run is moving through the stages' },
  { key: 'pr-open', label: 'Pull request open', hint: 'Open with auto-merge, which merges it when CI passes; or a draft its author has not marked ready' },
  { key: 'waiting', label: 'Waiting for me', hint: 'A pull request held at the human gate' },
  { key: 'stopped', label: 'Stopped', hint: 'Stopped with a question (BLOCKED.md), a failed stage or a red check on its open pull request, or closed' },
  { key: 'merged', label: 'Merged', hint: "The item's pull request merged into its base: main, or in team mode its feature branch (main gets it with the feature)" },
]
const TIERS: Tier[] = ['R0', 'R1', 'R2', 'R3']
const MERGED_SHOWN = 15

export function Board() {
  const { data, error, isLoading, refetch } = useApiState()
  const [params, setParams] = useSearchParams()
  const tiers = (params.get('tier')?.split(',').filter(Boolean) ?? []) as Tier[]
  const cols = (params.get('state')?.split(',').filter(Boolean) ?? []) as Column[]
  const q = params.get('q') ?? ''
  const allMerged = params.get('merged') === 'all'

  const set = (key: string, value: string | null) =>
    setParams(
      (p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: true },
    )
  const toggle = (key: 'tier' | 'state', list: string[], v: string) => set(key, (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]).join(',') || null)

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (data?.items ?? []).filter(
      (i) =>
        (!tiers.length || (i.tier && tiers.includes(i.tier))) &&
        (!needle || i.title.toLowerCase().includes(needle) || `#${i.id}`.includes(needle) || i.id === needle),
    )
  }, [data, tiers.join(), q])
  const shown = COLUMNS.filter((c) => !cols.length || cols.includes(c.key))

  return (
    <>
      <PageHeader title="Board">
        <label className="relative">
          <span className="sr-only">Filter by title or id</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => set('q', e.target.value || null)}
            placeholder="Filter by title or #id"
            data-page-filter
            className="h-7 w-52 rounded-md border border-border bg-surface pr-2 pl-7 text-[12.5px] placeholder:text-faint"
          />
        </label>
        <FilterGroup label="Tier">
          {TIERS.map((t) => (
            <Toggle key={t} on={tiers.includes(t)} onClick={() => toggle('tier', tiers, t)} label={`Tier ${t}`} title={`Risk tier ${TIER_HINT[t]}`}>
              <span className="font-mono">{t}</span>
            </Toggle>
          ))}
        </FilterGroup>
        <FilterGroup label="State">
          {COLUMNS.map((c) => (
            <Toggle key={c.key} on={cols.includes(c.key)} onClick={() => toggle('state', cols, c.key)} label={`Show ${short(c.label)}`}>
              {short(c.label)}
            </Toggle>
          ))}
        </FilterGroup>
        {(tiers.length > 0 || cols.length > 0 || q) && (
          <button className="text-[12px] text-muted underline" onClick={() => setParams({}, { replace: true })}>
            Clear
          </button>
        )}
      </PageHeader>
      <div className="px-4 py-4">
        {isLoading && <Loading rows={4} label="Loading the board" />}
        {error && <ErrorState title="Could not load the board" error={error} onRetry={() => void refetch()} />}
        {data && data.items.length === 0 && (
          <Empty title="No work items yet">
            {data.factory.teams ? (
              <>In team mode items come from dispatch: once you approve and merge a planning cycle's decisions, <code className="font-mono">/dispatch</code> makes one issue per row of its work breakdown, and they appear here as Ready. See <Link to="/planning" className="underline">Planning</Link> for where the cycle is.</>
            ) : (
              <>Run <code className="font-mono">/groom</code> in the factory to propose issues; they appear here as Proposed.</>
            )}
          </Empty>
        )}
        {data && data.items.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-4 max-md:flex-col">
            {shown.map((c) => {
              let list = items.filter((i) => i.column === c.key)
              const total = list.length
              if (c.key === 'merged') list = list.sort((a, b) => Date.parse(b.mergedAt ?? '') - Date.parse(a.mergedAt ?? ''))
              if (c.key === 'merged' && !allMerged) list = list.slice(0, MERGED_SHOWN)
              return (
                <section key={c.key} aria-labelledby={`col-${c.key}`} className="flex max-w-[320px] min-w-[158px] flex-1 basis-0 flex-col max-md:max-w-none">
                  <h2 id={`col-${c.key}`} className={cn('mb-2 flex items-center gap-2 border-b border-border px-1 pb-2 text-[10.5px] font-normal tracking-[0.08em] uppercase', c.key === 'waiting' && total ? 'text-wait' : 'text-muted')} title={c.hint}>
                    {c.label}
                    <span className="ml-auto tabular text-faint">{total}</span>
                  </h2>
                  <ul className="flex flex-col gap-1.5">
                    {list.map((i) => (
                      <Card key={i.id} i={i} />
                    ))}
                    {!total && <li className="border border-dashed border-border-strong px-3 py-3 font-mono text-[11px] text-faint">none</li>}
                  </ul>
                  {c.key === 'merged' && total > MERGED_SHOWN && (
                    <button className="mt-2 text-left text-[12px] text-muted underline" onClick={() => set('merged', allMerged ? null : 'all')}>
                      {allMerged ? 'Show recent only' : `Show all ${total}`}
                    </button>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

function Card({ i }: { i: ItemSummary }) {
  const now = useNow()
  return (
    <li>
      <Link
        data-nav-item
        to={`/items/${i.id}`}
        className={cn(
          'block border bg-surface px-3 py-2.5 hover:border-fg focus-visible:border-focus',
          i.needs ? 'border-attention shadow-[inset_2px_0_0_var(--attention)]' : 'border-border',
        )}
      >
        <div className="flex items-center gap-1.5">
          <ItemId id={i.id} link={false} />
          <TierChip tier={i.tier} />
          {i.live && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-run">
              <LiveDot label={`${i.live.agentType} active`} /> {i.live.agentType}
            </span>
          )}
        </div>
        <div className="mt-1 leading-snug font-medium">{i.title}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
          {i.column === 'in-progress' && <StageLabel stage={i.stage} round={i.round} status={i.stageStatus} />}
          {i.column === 'ready' && i.waitsFor && <span className="w-full text-[11.5px]">waits for {i.waitsFor}</span>}
          {(i.column === 'waiting' || i.column === 'stopped') && !i.needs && <StateBadge state={i.state} className="px-1.5 py-0 text-[11.5px]" />}
          {i.column === 'pr-open' && i.pr && <span>PR #{i.pr.number}</span>}
          {i.column === 'merged' && <span>{i.mergedBy === 'auto' ? 'auto-merged' : i.mergedBy === 'human' ? 'merged by you' : i.merger ? `merged by ${i.merger}` : 'merged'}{i.mergedInto && i.mergedInto !== 'main' && <> into <span className="font-mono text-[11px]">{i.mergedInto}</span></>}</span>}
          {i.needs && <NeedsTag kind={i.needs.kind} className="text-[12px] [&_svg]:size-3.5" />}
          <span className="ml-auto inline-flex items-center gap-2 tabular">
            {i.fixRounds > 0 ? <span title={`${i.fixRounds} fix rounds`}>{i.fixRounds} fix</span> : i.column === 'merged' ? <span>first pass</span> : null}
            <span title={`in this state since ${i.since ?? 'unknown'}`}>{ago(i.since, now)}</span>
          </span>
        </div>
        {(i.column === 'in-progress' || i.column === 'stopped') && i.stages.some((s) => s.status !== 'pending') && (
          <div className="mt-1.5">
            <StageDots stages={i.stages} />
          </div>
        )}
        {(i.errors > 0 || i.reverted || i.flags.includes('stale-blocked')) && (
          <div className="mt-1 flex flex-wrap gap-2 text-[11.5px]">
            {i.errors > 0 && <span className="text-fail">{i.errors === 1 ? '1 file could not be parsed' : `${i.errors} files could not be parsed`}</span>}
            {i.reverted && <span className="text-fail">reverted</span>}
            {i.flags.includes('stale-blocked') && <span className="text-muted">old BLOCKED.md</span>}
          </div>
        )}
        {i.needs && <span className="sr-only">Needs you: {NEEDS[i.needs.kind].verb}</span>}
      </Link>
    </li>
  )
}

const short = (label: string) => label.replace('Pull request open', 'PR open').replace('Waiting for me', 'Waiting')

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center border border-border bg-surface">
      <span className="label border-r border-border px-2 py-1">{label}</span>
      {children}
    </div>
  )
}
function Toggle({ on, onClick, label, title, children }: { on: boolean; onClick: () => void; label: string; title?: string; children: React.ReactNode }) {
  return (
    <button aria-pressed={on} aria-label={label} title={title} onClick={onClick} className={cn('px-2 py-1 text-[11.5px] text-muted hover:text-fg', on && 'bg-accent text-white hover:text-white')}>
      {children}
    </button>
  )
}
