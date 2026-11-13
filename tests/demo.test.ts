// End to end over the demo factory: every item derives to the state the generator intended.
import { beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from '../demo/generate.ts'
import { computeState, readDemoGitHub, type FactoryState } from '../server/state.ts'

const NOW = Date.parse('2026-11-13T09:30:00Z')
let state: FactoryState
let expected: Record<string, { state: string; needs?: string; flags?: string[] }>

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'cr-demo-')), 'demo')
  const d = generate(out, NOW)
  expected = JSON.parse(readFileSync(d.expected, 'utf8'))
  state = await computeState(d.repo, await readDemoGitHub(d.github), { now: NOW, staleMinutes: 30 })
})

describe('demo factory', () => {
  test('the items are exactly the expected ones', () => {
    expect(state.items.map((i) => i.id).sort()).toEqual(Object.keys(expected).sort())
  })
  test('every item derives to its intended state, needs and flags', () => {
    const got = Object.fromEntries(state.items.map((i) => [i.id, { state: i.state, needs: i.needs?.kind, flags: [...i.flags].sort() }]))
    const want = Object.fromEntries(Object.entries(expected).map(([id, e]) => [id, { state: e.state, needs: e.needs, flags: [...(e.flags ?? [])].sort() }]))
    expect(got).toEqual(want)
  })
  test('the demo covers every state and every needs-you kind', () => {
    expect(new Set(state.items.map((i) => i.state))).toEqual(new Set(['proposed', 'ready', 'in-progress', 'pr-open', 'awaiting-approval', 'awaiting-merge', 'blocked', 'failed', 'closed', 'merged']))
    expect(new Set(state.needsYou.map((n) => n.kind))).toEqual(new Set(['answer', 'approve', 'failed', 'waiting-input', 'quiet', 'merge']))
  })
  test('documents come from the right place', () => {
    const b = state.byId
    // the untracked BLOCKED.md in the working tree, next to the committed spec on the branch
    expect(b.get('23')!.files['BLOCKED.md']!.origin).toBe('worktree')
    expect(b.get('23')!.files['spec.md']!.origin).toBe('branch')
    expect(b.get('23')!.needs!.summary).toMatch(/^Should deleting an account/)
    // the checked-out branch's uncommitted edits win
    expect(b.get('28')!.files['events.jsonl' as never]).toBeUndefined()
    expect(b.get('28')!.files['log.md']!.origin).toBe('worktree')
    // a reverted item's record is read from the commit that merged it
    expect(b.get('7')!.spec).toMatchObject({ ok: true })
    expect(b.get('7')!.reverted).toMatchObject({ ref: 'PR #119' })
  })
  test('malformed files are notices with the raw text, not failures', () => {
    expect(state.byId.get('10')!.review).toMatchObject({ ok: false, error: 'no "VERDICT:" line' })
    expect(state.byId.get('31')!.spec).toMatchObject({ ok: false })
    expect(state.snap.notices.some((n) => /13-settle-up\/events.jsonl/.test(n.source) && /not valid JSON/.test(n.message))).toBe(true)
  })
  test('fix rounds: #8 used both review fix rounds; #13 one gate and one review', () => {
    expect(state.byId.get('8')).toMatchObject({ fixRounds: 2, fixByStage: { review: 2 }, firstPass: false })
    expect(state.byId.get('13')).toMatchObject({ fixRounds: 2, fixByStage: { gate: 1, review: 1 } })
    expect(state.byId.get('4')).toMatchObject({ fixRounds: 0, firstPass: true, mergedBy: 'human' })
    expect(state.byId.get('14')).toMatchObject({ mergedBy: 'auto' })
  })
  test('the R2 approval says which paths made it R2', () => {
    expect(state.byId.get('32')!.needs!.summary).toBe('R2 · db/migrations/0007_audit_log.sql (*migrations/*) · review: pass')
  })
  test('agent runs are paired, with transcripts and stages', () => {
    const agents = state.runs.filter((r) => r.agentType !== 'foreman')
    const live = agents.filter((r) => r.outcome === 'running').map((r) => `${r.workId}:${r.agentType}`).sort()
    expect(live).toEqual(['28:reviewer', '30:test-author', '31:builder'])
    expect(agents.filter((r) => r.outcome === 'finished').every((r) => r.transcriptPath && r.stage)).toBe(true)
    expect(state.runs.some((r) => r.agentType === 'foreman' && r.outcome === 'running' && r.workId === '28')).toBe(true)
  })
})
