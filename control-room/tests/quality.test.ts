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
