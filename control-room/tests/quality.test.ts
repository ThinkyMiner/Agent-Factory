import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quality, weekStart } from '../server/core/quality.ts'
import { generate } from '../demo/generate.ts'
import { computeState, readDemoGitHub } from '../server/state.ts'
import { summarise } from '../server/sources/transcripts.ts'

describe('weekStart', () => {
  test('is Monday 00:00 local time', () => {
    const d = new Date(weekStart(new Date(2026, 10, 13, 15).getTime())) // Fri 13 Nov 2026
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours()]).toEqual([2026, 10, 9, 1, 0])
    expect(new Date(weekStart(new Date(2026, 10, 16, 0, 0).getTime())).getDate()).toBe(16) // a Monday is its own week
  })
})

describe('quality over the demo', async () => {
  const NOW = Date.parse('2026-11-13T09:30:00Z')
  const d = generate(join(mkdtempSync(join(tmpdir(), 'cr-q-')), 'demo'), NOW)
  const s = await computeState(d.repo, await readDemoGitHub(d.github), { now: NOW, staleMinutes: 30 })
  const q = quality({ items: s.items, tokensByItem: new Map([['14', 1000], ['16', 3000], ['15', 2000]]), escapedIssues: s.snap.escapedIssues, now: NOW, weeks: 8 })
  const metric = (k: string) => q.metrics.find((m) => m.key === k)!
  const all = (k: string) => metric(k).points.flatMap((p) => p.ids)

  test('every value carries the items behind it', () => {
    for (const m of q.metrics) {
      for (const p of m.points) {
        if (m.kind === 'stacked') expect(p.parts?.reduce((a, x) => a + x.ids.length, 0) ?? 0, `${m.key} ${p.week}`).toBe(p.ids.length)
        if (m.unit === 'count' && m.kind === 'bars') expect(p.value).toBe(p.ids.length)
      }
    }
  })
  test('throughput counts each merged item once, in its merge week', () => {
    const merged = s.items.filter((i) => i.state === 'merged').map((i) => i.id).sort()
    expect(all('throughput').sort()).toEqual(merged)
  })
  test('first pass and fix rounds agree with derive', () => {
    expect(metric('first-pass').points.flatMap((p) => p.parts?.find((x) => x.key === 'first pass')?.ids ?? []).sort()).toEqual(s.items.filter((i) => i.firstPass).map((i) => i.id).sort())
    const reviewFixes = metric('fix-rounds').points.flatMap((p) => p.parts?.find((x) => x.key === 'review')?.ids ?? [])
    expect(reviewFixes.filter((x) => x === '8')).toHaveLength(2) // #8 used both review fix rounds
  })
  test('escaped defects: the reverted #7 and the labelled issue #43', () => {
    expect(all('escaped').sort()).toEqual(['7', 'issue:43'])
    // the headline covers the last four weeks; the revert was five weeks before NOW
    const last4 = metric('escaped').points.slice(-4).flatMap((p) => p.ids)
    expect(q.headline.find((h) => h.key === 'escaped')!.ids).toEqual(last4)
    expect(last4).toEqual([])
  })
  test('runs that stopped, by reason', () => {
    const reasons = metric('stops').points.flatMap((p) => p.parts ?? []).map((x) => x.key)
    expect(reasons).toEqual(expect.arrayContaining(['reached a PR', 'blocked']))
    const why = metric('stops').points.flatMap((p) => Object.values(p.notes ?? {}))
    expect(why).toEqual(expect.arrayContaining(['blocked at spec', 'blocked at gate']))
    for (const m of q.metrics) for (const p of m.points) for (const x of p.parts ?? []) if (m.series) expect(m.series, m.key).toContain(x.key)
  })
  test('merged says where; every merged work PR counts, an item tried twice twice; partial tokens say so', () => {
    const items = s.items.filter((i) => i.state === 'merged' && i.mergedAt).slice(0, 2)
    const [a, b] = items.map((i) => ({ ...i, mergedInto: 'feature/f001-x' }))
    const at = a!.mergedAt!
    const q2 = quality({
      items: [a!, b!], now: NOW, weeks: 8, escapedIssues: [],
      tokensByItem: new Map([[a!.id, 500]]), tokenRuns: new Map([[a!.id, { read: 6, total: 12 }]]),
      mergedPulls: [{ number: 24, id: a!.id, mergedAt: at, base: 'feature/f001-x' }, { number: 31, id: a!.id, mergedAt: at, base: 'feature/f001-x' }, { number: 40, id: b!.id, mergedAt: at, base: 'main' }],
    })
    const m = (k: string) => q2.metrics.find((x) => x.key === k)!
    expect(m('throughput').note).toMatch(/^Merged means the item's pull request merged into its base: main, or in team mode its feature branch \(2 of 2 here\)/)
    const prs = m('merged-prs').points.find((p) => p.ids.length)!
    expect(prs.value).toBe(3)
    expect(prs.parts!.map((x) => [x.key, x.value])).toEqual([['into a feature branch', 2], ['into main', 1]])
    expect(prs.notes![a!.id]).toBe('PR #24 into feature/f001-x; PR #31')
    expect(m('tokens').note).toContain('Partial: 6 of 12 runs of these items had a readable transcript')
    expect(m('tokens').points.find((p) => p.ids.length)!.notes).toEqual({ [a!.id]: 'partial: 6 of 12 runs readable' })
    expect(quality({ items: [a!], now: NOW, weeks: 8, escapedIssues: [], tokensByItem: new Map() }).metrics.find((x) => x.key === 'throughput')!.note).toContain('feature branch (1 of 1 here)')
  })
  test('a merged PR or item without a recorded base is "base unknown", not main', () => {
    const [a, b] = s.items.filter((i) => i.state === 'merged' && i.mergedAt).slice(0, 2).map((i, n) => ({ ...i, mergedInto: n ? undefined : 'feature/f001-x' }))
    const at = a!.mergedAt!
    const q2 = quality({
      items: [a!, b!], now: NOW, weeks: 8, escapedIssues: [], tokensByItem: new Map(),
      mergedPulls: [{ number: 24, id: a!.id, mergedAt: at, base: 'feature/f001-x' }, { number: 40, id: b!.id, mergedAt: at }],
    })
    const m = (k: string) => q2.metrics.find((x) => x.key === k)!
    expect(m('merged-prs').series).toContain('base unknown')
    expect(m('merged-prs').points.find((p) => p.ids.length)!.parts!.map((x) => [x.key, x.value])).toEqual([['into a feature branch', 1], ['base unknown', 1]])
    expect(m('throughput').note).toContain('feature branch (1 of 2 here; 1 with no recorded base)')
  })

  test('a merged item with no readable transcript counts in the coverage; an empty chart says whether it cannot be measured', () => {
    const [a, b] = s.items.filter((i) => i.state === 'merged' && i.mergedAt).slice(0, 2)
    const q2 = quality({ items: [a!, b!], now: NOW, weeks: 8, escapedIssues: [], tokensByItem: new Map([[a!.id, 500]]), tokenRuns: new Map([[a!.id, { read: 2, total: 2 }], [b!.id, { read: 0, total: 3 }]]) })
    const m = (q: typeof q2, k: string) => q.metrics.find((x) => x.key === k)!
    expect(m(q2, 'tokens').note).toContain('Partial: 2 of 5 runs of these items had a readable transcript')
    expect(m(q2, 'tokens').note).toContain('1 merged item had none and is not in the median')
    expect(m(q2, 'tokens').cannot).toBeUndefined()
    // merged items, but none with a readable transcript or a ready time: the chart cannot be measured, which is not "nothing happened"
    const blind = quality({ items: [{ ...b!, readyAt: undefined }], now: NOW, weeks: 8, escapedIssues: [], tokensByItem: new Map([['other', 1]]), tokenRuns: new Map([[b!.id, { read: 0, total: 3 }]]) })
    expect(m(blind, 'tokens').cannot).toBe('1 item merged, but none of its runs had a readable transcript.')
    expect(m(blind, 'lead-time').cannot).toBe('1 item merged, but none has a ready time (a factory:ready label or an intake event).')
    // nothing merged at all: no data, not unmeasurable
    const none = quality({ items: [], now: NOW, weeks: 8, escapedIssues: [], tokensByItem: new Map([['other', 1]]) })
    expect(m(none, 'lead-time').cannot).toBeUndefined()
  })

  test('the throughput note never says main for a base it does not know', () => {
    const items = s.items.filter((i) => i.state === 'merged' && i.mergedAt).slice(0, 2).map((i) => ({ ...i, mergedInto: undefined }))
    const note = (xs: typeof s.items) => quality({ items: xs, now: NOW, weeks: 8, escapedIssues: [], tokensByItem: new Map() }).metrics.find((x) => x.key === 'throughput')!.note!
    expect(note(items)).not.toContain('into main')
    expect(note(items)).toMatch(/^Merged means the item's pull request merged into its base branch \(2 of 2 here with no recorded base\)\./)
    expect(note(items.map((i) => ({ ...i, mergedInto: 'main' })))).toMatch(/^Merged means the item's pull request merged into main\./)
    expect(note([])).toMatch(/^Merged means the item's pull request merged into its base branch\./)
  })

  test('lead time and tokens are medians with per-item values', () => {
    const tok = metric('tokens').points.find((p) => p.ids.length > 0)!
    const v = Object.values(tok.perItem!).sort((a, b) => a - b)
    expect(tok.value).toBe(v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2)
    expect(metric('lead-time').points.some((p) => (p.value ?? 0) > 0)).toBe(true)
  })
  test('no token data: no tokens chart', () => {
    expect(quality({ items: s.items, tokensByItem: new Map(), escapedIssues: [], now: NOW, weeks: 4 }).metrics.some((m) => m.key === 'tokens')).toBe(false)
  })
})

describe('transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-t-'))
  const line = (o: object) => JSON.stringify(o)
  test('deduplicates streamed lines per message, keeping the largest; skips synthetic and sidechain', async () => {
    const p = join(dir, 's.jsonl')
    writeFileSync(p, [
      line({ type: 'assistant', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } } }),
      line({ type: 'assistant', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 2, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 } } }),
      line({ type: 'assistant', requestId: 'r2', message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } }),
      line({ type: 'assistant', requestId: 'r3', isSidechain: true, message: { id: 'm3', model: 'x', usage: { input_tokens: 5, output_tokens: 5 } } }),
      'not json with "usage" in it',
      line({ type: 'user', message: { content: 'hi' } }),
    ].join('\n'))
    expect(await summarise(p, { skipSidechain: true })).toEqual({ ok: true, model: 'claude-opus-5-5', models: ['claude-opus-5-5'], tokens: { input: 2, output: 50, cacheWrite: 100, cacheRead: 0, total: 152 }, requests: 1 })
    expect(await summarise(p, { skipSidechain: false })).toMatchObject({ ok: true, tokens: { total: 162 }, requests: 2 })
  })
  test('a file with no usage is unreadable, not zero', async () => {
    const p = join(dir, 'empty.jsonl')
    writeFileSync(p, line({ type: 'user', message: {} }) + '\n')
    expect(await summarise(p, { skipSidechain: false })).toMatchObject({ ok: false })
  })
})
