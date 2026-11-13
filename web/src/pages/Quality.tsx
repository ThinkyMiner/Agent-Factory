// Job 3: is the factory getting better? One small chart per question, weekly buckets, and every
// number (tile, bar, segment, table cell) opens the items behind it.
// Hand-written SVG following the dataviz rules: thin bars with a rounded data end, 2px gaps between
// stacked segments, hairline grid, legend for 2+ series, a tooltip on hover and focus, a table twin.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import { useQuality, type Metric, type Point } from '@/lib/api'
import { cn, compact, day } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { ItemsPanel, type Drill } from '@/components/ItemsPanel'

const WEEKS = [4, 8, 12, 26]

export function fmt(unit: Metric['unit'], v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (unit === 'percent') return `${v}%`
  if (unit === 'hours') return v < 48 ? `${Math.round(v * 10) / 10} h` : `${Math.round(v / 2.4) / 10} d`
  if (unit === 'tokens') return compact(v)
  return String(v)
}

/** Colour follows the key's fixed slot in the metric's series, never its rank in the data. */
function color(m: Metric, key: string) {
  const i = m.series?.indexOf(key) ?? -1
  if (key === 'unknown' || i < 0) return 'var(--series-other)'
  return m.key === 'tiers' ? `var(--tier-${i})` : `var(--series-${i + 1})`
}

const NOUN: Record<string, string> = { throughput: 'merged', 'fix-rounds': 'fix rounds', tiers: 'merged', 'merged-by': 'merged', escaped: 'escaped' }
const NONE: Record<string, string> = { 'fix-rounds': 'No fix rounds', stops: 'No runs ended', escaped: 'Nothing escaped' }
const partValue = (p: Point, key: string) => p.parts?.find((x) => x.key === key)?.value ?? 0

function sentence(m: Metric, p: Point): string {
  if (!p.ids.length) return NONE[m.key] ?? 'Nothing merged'
  const n = new Set(p.ids).size
  if (m.key === 'stops') return `${p.value}% stopped · ${p.ids.length - partValue(p, 'reached a PR')} of ${p.ids.length} runs`
  if (m.key === 'first-pass') return `${p.value}% · ${partValue(p, 'first pass')} of ${n} merged`
  if (m.unit === 'hours' || m.unit === 'tokens') return `${fmt(m.unit, p.value)} median · ${n} ${n === 1 ? 'item' : 'items'}`
  return `${p.value} ${NOUN[m.key] ?? ''}`
}

function drillFor(m: Metric, p: Point, part?: string): Drill {
  const values: Record<string, string> = {}
  const add = (id: string, s: string) => (values[id] = values[id] && !values[id].split(', ').includes(s) ? `${values[id]}, ${s}` : s)
  for (const [id, v] of Object.entries(p.notes ?? {})) add(id, v)
  for (const [id, v] of Object.entries(p.perItem ?? {})) add(id, fmt(m.unit, v))
  if (!part && !p.notes) for (const x of p.parts ?? []) for (const id of x.ids) add(id, x.key)
  return { title: m.question, subtitle: `Week of ${day(p.week)}${part ? ` · ${part}` : ''}`, ids: part ? (p.parts?.find((x) => x.key === part)?.ids ?? []) : p.ids, values }
}

interface Seg {
  key: string
  value: number
  from: number
  to: number
}
/** Bars, or stacked segments in series order; a percent stack is normalised to 100. */
function columns(m: Metric): { total: number | null; segs: Seg[] }[] {
  return m.points.map((p) => {
    if (m.kind === 'bars') return { total: p.value, segs: p.value ? [{ key: m.key, value: p.value, from: 0, to: p.value }] : [] }
    const parts = (p.parts ?? []).filter((x) => x.value > 0)
    const sum = parts.reduce((a, x) => a + x.value, 0)
    const k = m.unit === 'percent' && sum ? 100 / sum : 1
    let acc = 0
    const segs = parts.map((x) => ({ key: x.key, value: x.value, from: acc, to: (acc += x.value * k) }))
    return { total: sum ? acc : p.ids.length ? 0 : null, segs }
  })
}

function ticks(max: number, unit: Metric['unit']): number[] {
  if (unit === 'percent') return [0, 50, 100]
  if (max <= 0) return [0, 1]
  const raw = max / 3
  const p = 10 ** Math.floor(Math.log10(raw))
  let step = [1, 2, 5, 10].map((x) => x * p).find((s) => s >= raw)!
  if (unit === 'count') step = Math.max(1, Math.round(step))
  const top = Math.ceil(max / step) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 100) / 100)
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const roundedTop = (x: number, y: number, w: number, h: number, r: number) => {
  r = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`
}

function Chart({ m, pick }: { m: Metric; pick: (d: Drill) => void }) {
  const [ref, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const cols = useMemo(() => columns(m), [m])
  const ts = ticks(Math.max(0, ...cols.map((c) => c.total ?? 0)), m.unit)
  const top = ts.at(-1)!
  const [H, L, R, T, B] = [140, 46, 8, 8, 22]
  const W = Math.max(width, 240)
  const n = cols.length
  const band = (W - L - R) / n
  const bw = Math.min(24, Math.max(4, band * 0.6))
  const y = (v: number) => T + H - (v / top) * H
  const every = Math.ceil(48 / band)
  const lastData = cols.findLastIndex((c) => c.segs.length)

  const onKey = (e: KeyboardEvent) => {
    const i = active ?? lastData
    const next = { ArrowRight: Math.min(n - 1, i + 1), ArrowLeft: Math.max(0, i - 1), Home: 0, End: n - 1 }[e.key]
    if (next !== undefined) {
      e.preventDefault()
      setActive(next)
    } else if ((e.key === 'Enter' || e.key === ' ') && active !== null && m.points[active]!.ids.length) {
      e.preventDefault()
      pick(drillFor(m, m.points[active]!))
    } else if (e.key === 'Escape') setActive(null)
  }

  const cx = active === null ? 0 : L + band * (active + 0.5)
  const p = active === null ? null : m.points[active]!
  return (
    <div ref={ref} className="relative">
      <div
        tabIndex={0}
        role="group"
        aria-label={`${m.question} ${n} weeks. Arrow keys move between weeks, Enter lists the items.`}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? Math.max(0, lastData))}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="rounded-md"
      >
        {width > 0 && (
          <svg width={W} height={T + H + B} role="img" aria-label={`${m.question} The table below the chart lists every value.`} className="block select-none">
            {ts.map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border)" shapeRendering="crispEdges" />
                <text x={L - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[10.5px] tabular">
                  {fmt(m.unit, t)}
                </text>
              </g>
            ))}
            {cols.map((c, i) => {
              const x = L + band * (i + 0.5) - bw / 2
              return (
                <g key={m.points[i]!.week} onPointerEnter={() => setActive(i)} onClick={() => m.points[i]!.ids.length && pick(drillFor(m, m.points[i]!))} className={m.points[i]!.ids.length ? 'cursor-pointer' : undefined}>
                  <rect x={L + band * i + 1} y={T} width={band - 2} height={H} fill={active === i ? 'var(--surface-2)' : 'transparent'} />
                  {c.segs.map((s, k) => {
                    const last = k === c.segs.length - 1
                    const h = y(s.from) - y(s.to) - (last ? 0 : 2)
                    if (h < 0.5) return null
                    return (
                      <path
                        key={s.key}
                        d={last ? roundedTop(x, y(s.to), bw, h, 4) : `M${x},${y(s.to) + 2}h${bw}v${h}h${-bw}Z`}
                        fill={m.kind === 'bars' ? 'var(--series-1)' : color(m, s.key)}
                        onClick={(e) => {
                          if (m.kind !== 'stacked') return
                          e.stopPropagation()
                          pick(drillFor(m, m.points[i]!, s.key))
                        }}
                      />
                    )
                  })}
                  {c.total === null && m.points[i]!.ids.length === 0 && m.unit !== 'count' && (
                    <line x1={x + bw / 2 - 3} x2={x + bw / 2 + 3} y1={y(0) - 3} y2={y(0) - 3} stroke="var(--faint)" aria-hidden />
                  )}
                  {(n - 1 - i) % every === 0 && (
                    <text x={L + band * (i + 0.5)} y={T + H + 15} textAnchor="middle" className="fill-muted text-[10.5px]">
                      {day(m.points[i]!.week)}
                    </text>
                  )}
                </g>
              )
            })}
            <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" shapeRendering="crispEdges" />
          </svg>
        )}
      </div>
      {p && active !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 min-w-36 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-md"
          style={cx < W * 0.6 ? { left: cx + bw / 2 + 10, top: T } : { right: W - cx + bw / 2 + 10, top: T }}
        >
          <div className="text-muted">Week of {day(p.week)}</div>
          <div className="font-semibold">{sentence(m, p)}</div>
          {m.kind === 'stacked' &&
            [...cols[active]!.segs].reverse().map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="h-[2px] w-3 rounded" style={{ background: color(m, s.key) }} />
                <span className="font-medium tabular">{s.value}</span>
                <span className="text-muted">{s.key}</span>
              </div>
            ))}
          {!!p.ids.length && <div className="mt-0.5 text-faint">Click or press Enter for the items</div>}
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {p ? `Week of ${day(p.week)}: ${sentence(m, p)}` : ''}
      </div>
    </div>
  )
}

function Legend({ m }: { m: Metric }) {
  if (m.kind !== 'stacked') return null
  const present = new Set(m.points.flatMap((p) => (p.parts ?? []).filter((x) => x.value > 0).map((x) => x.key)))
  const keys = (m.series ?? []).filter((k) => present.has(k))
  if (keys.length < 2) return keys.length ? <p className="text-[12px] text-muted">All: {keys[0]}</p> : null
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted" aria-label="Legend">
      {keys.map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: color(m, k) }} />
          {k}
        </li>
      ))}
    </ul>
  )
}

function Table({ m, pick }: { m: Metric; pick: (d: Drill) => void }) {
  const keys = m.kind === 'stacked' ? (m.series ?? []).filter((k) => m.points.some((p) => partValue(p, k) > 0)) : []
  const cell = (label: string, d: Drill | null) =>
    d && d.ids.length ? (
      <button className="tabular hover:underline" onClick={() => pick(d)}>
        {label}
      </button>
    ) : (
      <span className="text-faint tabular">{label}</span>
    )
  return (
    <details className="mt-2 text-[12px]">
      <summary className="cursor-pointer text-muted hover:text-fg">Table</summary>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="py-1 pr-3 font-medium">Week of</th>
              <th className="py-1 pr-3 font-medium">Value</th>
              {keys.map((k) => (
                <th key={k} className="py-1 pr-3 font-medium">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...m.points].reverse().map((p) => (
              <tr key={p.week} className="border-b border-border last:border-b-0">
                <td className="py-1 pr-3 whitespace-nowrap">{day(p.week)}</td>
                <td className="py-1 pr-3">{cell(p.ids.length ? sentence(m, p) : '—', drillFor(m, p))}</td>
                {keys.map((k) => (
                  <td key={k} className="py-1 pr-3">
                    {cell(String(partValue(p, k)), drillFor(m, p, k))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function Card({ m, weeks, pick }: { m: Metric; weeks: number; pick: (d: Drill) => void }) {
  const empty = m.points.every((p) => !p.ids.length)
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface p-4" aria-labelledby={`q-${m.key}`}>
      <h2 id={`q-${m.key}`} className="font-semibold">
        {m.question}
      </h2>
      {m.note && <p className="text-[12px] text-muted">{m.note}</p>}
      {empty ? (
        <Empty title={`Nothing in the last ${weeks} weeks`} className="mt-3 py-4" />
      ) : (
        <>
          <div className="mt-2 mb-1">
            <Legend m={m} />
          </div>
          <Chart m={m} pick={pick} />
          <Table m={m} pick={pick} />
        </>
      )}
    </section>
  )
}

export function Quality() {
  const [params, setParams] = useSearchParams()
  const weeks = WEEKS.includes(Number(params.get('weeks'))) ? Number(params.get('weeks')) : 12
  const { data: q, error, isPending, isPlaceholderData, refetch } = useQuality(weeks)
  const [drill, setDrill] = useState<Drill | null>(null)

  return (
    <>
      <PageHeader title="Quality">
        <div role="group" aria-label="Weeks shown" className="inline-flex rounded-md border border-border bg-surface p-0.5">
          {WEEKS.map((w) => (
            <button
              key={w}
              aria-pressed={w === weeks}
              onClick={() => setParams((p) => (p.set('weeks', String(w)), p), { replace: true })}
              className={cn('rounded px-2 py-0.5 text-[12px] text-muted hover:text-fg', w === weeks && 'bg-surface-2 font-medium text-fg')}
            >
              {w} weeks
            </button>
          ))}
        </div>
      </PageHeader>
      <div className={cn('space-y-4 p-5 transition-opacity', isPlaceholderData && 'opacity-60')}>
        {isPending ? (
          <Loading rows={6} label="Loading quality" />
        ) : error ? (
          <ErrorState title="Could not load quality figures" error={error} onRetry={() => void refetch()} />
        ) : !q!.metrics.some((m) => m.points.some((p) => p.ids.length)) ? (
          <Empty title="No history yet">Quality figures come from merged items, stage events and fix rounds. They appear once the factory has run a few items through <span className="font-mono text-[12px]">/work</span>.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {q!.headline.map((h) => {
                const n = new Set(h.ids).size
                return (
                  <button
                    key={h.key}
                    onClick={() => setDrill({ title: h.label, subtitle: 'Last 4 weeks', ids: h.ids })}
                    disabled={!n}
                    className="rounded-lg border border-border bg-surface p-4 text-left enabled:hover:border-border-strong"
                  >
                    <div className="text-[12px] text-muted">{h.label}</div>
                    <div className="mt-1 text-[26px] leading-tight font-semibold">{fmt(h.unit, h.value)}</div>
                    <div className="text-[11.5px] text-faint">{n ? `${n} ${n === 1 ? 'item' : 'items'} · last 4 weeks` : 'Nothing in the last 4 weeks'}</div>
                  </button>
                )
              })}
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {q!.metrics.map((m) => (
                <Card key={m.key} m={m} weeks={weeks} pick={setDrill} />
              ))}
            </div>
            {!q!.metrics.some((m) => m.key === 'tokens') && (
              <p className="text-[12px] text-muted">Token cost is hidden: no transcript on this machine could be read for these items.</p>
            )}
          </>
        )}
      </div>
      <ItemsPanel drill={drill} onClose={() => setDrill(null)} />
    </>
  )
}
