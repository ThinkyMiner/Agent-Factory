// Job 3: is the factory getting better? Weekly series, each value carrying the item ids behind
// it so every number on the Quality screen links to its items. Pure; tested in tests/quality.test.ts.
import type { ItemView } from './derive.ts'
import { STAGES, type Stage } from './types.ts'

export interface Part {
  key: string
  value: number
  ids: string[] // item ids, or "issue:<n>" for escaped-defect issues that are not items
}
export interface Point {
  week: string // Monday, YYYY-MM-DD (local)
  value: number | null // null: nothing to measure that week
  ids: string[]
  parts?: Part[]
  perItem?: Record<string, number> // the value each item contributed (hours, tokens)
  notes?: Record<string, string> // a word per item, e.g. "blocked at gate"
}
export interface Metric {
  key: string
  question: string
  unit: 'count' | 'percent' | 'hours' | 'tokens'
  kind: 'bars' | 'stacked'
  series?: string[] // stacked: the fixed order of part keys, which fixes their colours
  note?: string
  points: Point[]
}

const DAY = 86_400_000
/** Monday 00:00 local time of the week containing t. */
export function weekStart(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export interface QualityInput {
  items: ItemView[]
  tokensByItem: Map<string, number> // total tokens of the runs tied to the item whose transcript was readable (empty map: unknown)
  tokenRuns?: Map<string, { read: number; total: number }> // per item: runs with a readable transcript, of all its runs
  mergedPulls?: { number: number; id: string; mergedAt: string; base?: string }[] // every merged work PR (work/<id>-*), every attempt
  escapedIssues: { number: number; createdAt: string }[]
  now: number
  weeks: number
}

export function quality({ items, tokensByItem, tokenRuns = new Map(), mergedPulls = [], escapedIssues, now, weeks }: QualityInput) {
  const first = weekStart(now) - (weeks - 1) * 7 * DAY
  const starts = Array.from({ length: weeks }, (_, i) => weekStart(first + i * 7 * DAY + DAY / 2)) // DST-safe
  const weekOf = (iso: string | undefined) => {
    if (!iso) return null
    const t = Date.parse(iso)
    if (Number.isNaN(t) || t < first || t > now + DAY) return null
    return ymd(weekStart(t))
  }
  const blank = (): Map<string, Point> => new Map(starts.map((s) => [ymd(s), { week: ymd(s), value: 0, ids: [] }]))
  const series = (m: Map<string, Point>) => [...m.values()]

  const merged = items.filter((i) => i.state === 'merged' && i.mergedAt)
  const byMergeWeek = (fn: (p: Point, i: ItemView) => void) => {
    const m = blank()
    for (const i of merged) {
      const w = weekOf(i.mergedAt)
      if (w && m.has(w)) fn(m.get(w)!, i)
    }
    return m
  }
  const partsOf = (p: Point, key: string) => {
    p.parts ??= []
    let part = p.parts.find((x) => x.key === key)
    if (!part) p.parts.push((part = { key, value: 0, ids: [] }))
    return part
  }
  const add = (p: Point, key: string | null, id: string) => {
    p.ids.push(id)
    p.value = (p.value ?? 0) + 1
    if (key) {
      const part = partsOf(p, key)
      part.value++
      part.ids.push(id)
    }
  }

  // 1. throughput
  const throughput = byMergeWeek((p, i) => add(p, null, i.id))

  // 2. lead time, ready -> merged (median hours)
  const lead = byMergeWeek((p, i) => {
    if (!i.readyAt) return
    const h = (Date.parse(i.mergedAt!) - Date.parse(i.readyAt)) / 3_600_000
    if (h < 0) return
    p.ids.push(i.id)
    ;(p.perItem ??= {})[i.id] = Math.round(h * 10) / 10
  })
  for (const p of lead.values()) p.value = median(Object.values(p.perItem ?? {}))

  // 3. first-pass rate
  const firstPass = byMergeWeek((p, i) => {
    const part = partsOf(p, i.firstPass ? 'first pass' : 'needed fixes')
    part.value++
    part.ids.push(i.id)
    p.ids.push(i.id)
  })
  for (const p of firstPass.values()) {
    const fp = p.parts?.find((x) => x.key === 'first pass')?.value ?? 0
    p.value = p.ids.length ? Math.round((fp / p.ids.length) * 100) : null
  }

  // 4. fix rounds by stage: each failure that triggered a fix round, in the week it happened
  const fixes = blank()
  for (const i of items) {
    for (const s of i.stages) {
      for (const a of s.attempts) {
        if (a.status !== 'failed') continue
        const w = weekOf(a.end ?? a.start)
        if (!w || !fixes.has(w)) continue
        add(fixes.get(w)!, s.stage, i.id)
      }
    }
  }
  for (const p of fixes.values()) p.parts?.sort((a, b) => STAGES.indexOf(a.key as Stage) - STAGES.indexOf(b.key as Stage))

  // 5. runs that stopped, by reason (share of /work runs that ended that week)
  const stops = blank()
  for (const i of items) {
    for (const r of i.pipelineRuns) {
      if (r.outcome === 'running') continue
      const w = weekOf(r.end)
      if (!w || !stops.has(w)) continue
      const p = stops.get(w)!
      p.ids.push(i.id)
      const key = r.outcome === 'pr' ? 'reached a PR' : r.outcome
      const part = partsOf(p, key)
      part.value++
      part.ids.push(i.id)
      if (key !== 'reached a PR') {
        const why = r.outcome === 'abandoned' ? 'abandoned' : `${r.outcome} at ${r.stage ?? 'an unknown stage'}`
        p.notes ??= {}
        p.notes[i.id] = p.notes[i.id] ? `${p.notes[i.id]}; ${why}` : why
      }
    }
  }
  for (const p of stops.values()) {
    const ended = p.ids.length
    const ok = p.parts?.find((x) => x.key === 'reached a PR')?.value ?? 0
    p.value = ended ? Math.round(((ended - ok) / ended) * 100) : null
  }

  const STOPS = ['reached a PR', 'blocked', 'failed', 'abandoned']
  for (const p of stops.values()) p.parts?.sort((a, b) => STOPS.indexOf(a.key) - STOPS.indexOf(b.key))

  // 6. tier mix and 7. who merged
  const tiers = byMergeWeek((p, i) => add(p, i.tier ?? 'unknown', i.id))
  const mergedBy = byMergeWeek((p, i) => add(p, i.mergedBy === 'auto' ? 'auto-merged' : i.mergedBy === 'human' ? 'merged by you' : 'unknown', i.id))

  // 8. escaped defects: reverted items (by revert date) and issues labelled escaped-defect
  const escaped = blank()
  for (const i of items) {
    const w = weekOf(i.reverted?.at)
    if (w && escaped.has(w)) add(escaped.get(w)!, 'reverted', i.id)
  }
  for (const e of escapedIssues) {
    const w = weekOf(e.createdAt)
    if (w && escaped.has(w)) add(escaped.get(w)!, 'escaped-defect issue', `issue:${e.number}`)
  }

  // 9. tokens per merged item (median), saying how many of its runs could be read
  let read = 0
  let total = 0
  const tokens = byMergeWeek((p, i) => {
    const t = tokensByItem.get(i.id)
    if (t === undefined) return
    p.ids.push(i.id)
    ;(p.perItem ??= {})[i.id] = t
    const c = tokenRuns.get(i.id)
    if (c) {
      read += c.read
      total += c.total
      if (c.read < c.total) (p.notes ??= {})[i.id] = `partial: ${c.read} of ${c.total} runs readable`
    }
  })
  for (const p of tokens.values()) p.value = median(Object.values(p.perItem ?? {}))

  // 10. every merged work pull request, attempts included, in the week it merged, by where it merged
  const prs = blank()
  for (const pr of mergedPulls) {
    const w = weekOf(pr.mergedAt)
    if (!w || !prs.has(w)) continue
    const p = prs.get(w)!
    add(p, pr.base?.startsWith('feature/') ? 'into a feature branch' : 'into main', pr.id)
    const n = (p.notes ??= {})
    n[pr.id] = n[pr.id] ? `${n[pr.id]}; PR #${pr.number}` : `PR #${pr.number}${pr.base ? ` into ${pr.base}` : ''}`
  }
  const mergedTo = merged.reduce((m, i) => m.set(i.mergedInto ?? 'main', (m.get(i.mergedInto ?? 'main') ?? 0) + 1), new Map<string, number>())
  const intoFeature = [...mergedTo].filter(([b]) => b.startsWith('feature/')).reduce((a, [, n]) => a + n, 0)
  const MERGED = intoFeature
    ? `Merged means the item's pull request merged into its base: main, or in team mode its feature branch (${intoFeature} of ${merged.length} here), which reaches main later through the feature's integrate pull request.`
    : "Merged means the item's pull request merged into main."

  const metrics: Metric[] = [
    { key: 'throughput', question: 'How many items are we merging each week?', unit: 'count', kind: 'bars', note: `${MERGED} Each item counts once, by its latest merged pull request.`, points: series(throughput) },
    { key: 'lead-time', question: 'How long from ready to merged? (median hours)', unit: 'hours', kind: 'bars', note: 'Ready is when the factory:ready label was added, or the first intake event when the label time is unknown.', points: series(lead) },
    { key: 'first-pass', question: 'What share merged with no fix rounds?', unit: 'percent', kind: 'bars', points: series(firstPass) },
    { key: 'fix-rounds', question: 'Where do fix rounds happen?', unit: 'count', kind: 'stacked', series: [...STAGES], note: 'Each failure that triggered a fix round, charged to the stage that failed.', points: series(fixes) },
    { key: 'stops', question: 'What share of runs stopped, and why?', unit: 'percent', kind: 'stacked', series: STOPS, note: 'Of the /work runs that ended that week. The drilldown says where each one stopped.', points: series(stops) },
    { key: 'tiers', question: 'What is the risk mix of what merged?', unit: 'count', kind: 'stacked', series: ['R0', 'R1', 'R2', 'R3', 'unknown'], points: series(tiers) },
    { key: 'merged-by', question: 'How much merged without me?', unit: 'count', kind: 'stacked', series: ['auto-merged', 'merged by you', 'unknown'], note: 'Inferred from the pull request: auto-merge enabled and no human-approved label counts as auto-merged. Who pressed merge is not fetched from GitHub.', points: series(mergedBy) },
    { key: 'escaped', question: 'Did defects escape?', unit: 'count', kind: 'stacked', series: ['reverted', 'escaped-defect issue'], note: 'Reverted pull requests, plus issues labelled escaped-defect.', points: series(escaped) },
  ]
  if (mergedPulls.length) metrics.splice(1, 0, { key: 'merged-prs', question: 'How many work pull requests merged each week? (every attempt)', unit: 'count', kind: 'stacked', series: ['into main', 'into a feature branch'], note: 'Every merged pull request from a work/<id>-<slug> branch, so an item tried twice counts twice.', points: series(prs) })
  if (tokensByItem.size) {
    const cover = total && read < total ? `Partial: ${read} of ${total} runs of these items had a readable transcript; the rest are not counted.` : 'Every run of these items had a readable transcript.'
    metrics.push({ key: 'tokens', question: 'How many tokens does a merged item cost? (median)', unit: 'tokens', kind: 'bars', note: `The agent runs and foreman sessions tied to the item, from their transcripts. ${total ? cover : ''}`.trim(), points: series(tokens) })
  }

  // headline numbers over the last four weeks
  const recent = (m: Map<string, Point>) => series(m).slice(-4)
  const ids = (m: Map<string, Point>) => recent(m).flatMap((p) => p.ids)
  const mergedIds = ids(throughput)
  const fpIds = recent(firstPass).flatMap((p) => p.parts?.find((x) => x.key === 'first pass')?.ids ?? [])
  const leadVals = recent(lead).flatMap((p) => Object.values(p.perItem ?? {}))
  const headline = [
    { key: 'merged', label: 'Merged, last 4 weeks', value: mergedIds.length, unit: 'count' as const, ids: mergedIds },
    { key: 'first-pass', label: 'First-pass rate', value: mergedIds.length ? Math.round((fpIds.length / mergedIds.length) * 100) : null, unit: 'percent' as const, ids: fpIds },
    { key: 'lead-time', label: 'Median lead time', value: median(leadVals), unit: 'hours' as const, ids: recent(lead).flatMap((p) => p.ids) },
    { key: 'escaped', label: 'Escaped defects', value: ids(escaped).length, unit: 'count' as const, ids: ids(escaped) },
  ]
  return { weeks: starts.map(ymd), metrics, headline }
}
export type Quality = ReturnType<typeof quality>
