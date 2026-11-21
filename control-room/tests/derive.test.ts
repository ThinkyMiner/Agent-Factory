// State derivation: every rule in DESIGN.md §5, plus partial and contradictory inputs.
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildStages, deriveAll, deriveItem, expireRuns, indexLifecycle, type Context, type ItemInputs } from '../server/core/derive.ts'
import { parseRiskRules } from '../server/core/risk.ts'
import { currentChecks, type Issue, type LifecycleEvent, type Pull, type Stage, type StageEvent, type Status } from '../server/core/types.ts'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const RULES = parseRiskRules(readFileSync(new URL('../demo/template/factory/risk-rules.txt', import.meta.url), 'utf8'))
let n = 0

const se = (stage: Stage, status: Status, minAgo: number, round = 0, extra: Partial<StageEvent> = {}): StageEvent => ({
  ts: ago(minAgo), type: 'stage', work_id: '1', branch: 'work/1-x', stage, status, round, key: `s${n++}`, ...extra,
})
const le = (event: string, minAgo: number, extra: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
  ts: ago(minAgo), type: 'lifecycle', work_id: '1', branch: 'work/1-x', event, session_id: 'sess', key: `l${n++}`, ...extra,
})
const issue = (labels: string[], extra: Partial<Issue> = {}): Issue => ({
  number: 1, title: 'Issue title', state: 'OPEN', labels, createdAt: ago(5000), url: 'u', body: '', labelEvents: [], ...extra,
})
const pull = (extra: Partial<Pull> = {}): Pull => ({
  number: 101, title: 'PR', state: 'OPEN', isDraft: false, headRefName: 'work/1-x', headSha: 'abc', labels: ['risk:R1'], createdAt: ago(60),
  url: 'p', body: '', autoMerge: true, files: [], timeline: [],
  checks: ['check', 'secrets', 'risk-gate'].map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
  ...extra,
})
const file = (text: string, minAgo = 0, origin: 'worktree' | 'branch' | 'main' = 'branch') => ({ path: 'work/1-x/f', text, time: ago(minAgo), origin })
const SPEC = (floor = 'R1', tests = 'required') =>
  `---\nid: 1\ntitle: Spec title\nrisk_floor: ${floor}\ntests: ${tests}\n---\n## Problem\np\n## Acceptance criteria\n- AC-1: a\n- AC-2: b\n## Out of scope\n## Assumptions\n## Blocking questions\nNone\n`
const REVIEW = (verdict = 'pass', risk = 'R1', notVerified = '- none') =>
  `VERDICT: ${verdict}\nRISK: ${risk}\nBLOCKING:\n- none\nNON-BLOCKING:\n- none\nVERIFIED: make check\nNOT VERIFIED:\n${notVerified}\n`

function ctx(lifecycle: LifecycleEvent[] = [], over: Partial<Context> = {}): Context {
  const { sessions, runs } = indexLifecycle(lifecycle)
  return { now: NOW, staleMinutes: 30, autoMergeMax: 'R1', rules: RULES, sessions, runs, ...over }
}
function derive(over: Partial<ItemInputs>, c: Partial<Context> = {}) {
  const inp: ItemInputs = { id: '1', files: {}, stageEvents: [], lifecycle: [], notices: [], ...over }
  return deriveItem(inp, ctx(inp.lifecycle, c))!
}
const RUN_TO_PR = () => [se('intake', 'passed', 90), se('spec', 'passed', 85), se('tests', 'passed', 80), se('build', 'passed', 70), se('gate', 'passed', 68), se('review', 'passed', 62), se('observe', 'passed', 61), se('pr', 'passed', 60, 0, { tier: 'R1', pr: 101 })]

describe('not started', () => {
  test('an issue without factory labels and no work is not an item', () => {
    expect(deriveItem({ id: '1', files: {}, stageEvents: [], lifecycle: [], notices: [], issue: issue(['bug']) }, ctx())).toBeNull()
  })
  test('proposed and ready come from labels; ready wins; readyAt from the label event', () => {
    expect(derive({ issue: issue(['factory:proposed']) })).toMatchObject({ state: 'proposed', column: 'proposed' })
    const r = derive({ issue: issue(['factory:proposed', 'factory:ready'], { labelEvents: [{ label: 'factory:ready', action: 'added', at: ago(100) }] }) })
    expect(r).toMatchObject({ state: 'ready', column: 'ready', readyAt: ago(100), since: ago(100) })
  })
})

describe('in progress', () => {
  test('current stage, round and no needs while events are recent', () => {
    const r = derive({ stageEvents: [se('intake', 'passed', 10), se('spec', 'passed', 8), se('tests', 'started', 5)] })
    expect(r).toMatchObject({ state: 'in-progress', column: 'in-progress', stage: 'tests', stageStatus: 'running', needs: undefined, flags: [], since: ago(5) })
  })
  test('quiet after staleMinutes with no event of any kind; the threshold is configurable', () => {
    const inp = { stageEvents: [se('build', 'started', 45)] }
    expect(derive(inp)).toMatchObject({ flags: ['quiet'], needs: { kind: 'quiet' } })
    expect(derive(inp, { staleMinutes: 60 })).toMatchObject({ flags: [], needs: undefined })
  })
  test('a recent lifecycle event keeps it from going quiet', () => {
    const r = derive({ stageEvents: [se('build', 'started', 45)], lifecycle: [le('SessionStart', 46), le('SubagentStop', 10, { agent_id: 'b', agent_type: 'builder' })] })
    expect(r.flags).not.toContain('quiet')
  })
  test('live: an open subagent in a live session', () => {
    const life = [le('SessionStart', 20), le('SubagentStart', 4, { agent_id: 'a1', agent_type: 'builder' })]
    const r = derive({ stageEvents: [se('build', 'started', 4)], lifecycle: life })
    expect(r.flags).toEqual(['live'])
    expect(r.live).toEqual({ agentType: 'builder', since: ago(4) })
  })
  test('waiting-input: the session is showing a notification, even with a subagent open', () => {
    const life = [le('SessionStart', 20), le('SubagentStart', 12, { agent_id: 'a1', agent_type: 'test-author' }), le('Notification', 10, { reason: 'permission_prompt', message: 'Claude needs your permission to use Bash' })]
    const r = derive({ stageEvents: [se('tests', 'started', 12)], lifecycle: life })
    expect(r.needs).toMatchObject({ kind: 'waiting-input', summary: 'Claude Code is waiting: Claude needs your permission to use Bash' })
    expect(new Set(r.flags)).toEqual(new Set(['waiting-input', 'live']))
  })
  test('an auth_success notification is not waiting', () => {
    const r = derive({ stageEvents: [se('tests', 'started', 12)], lifecycle: [le('SessionStart', 20), le('Notification', 10, { reason: 'auth_success' })] })
    expect(r.needs).toBeUndefined()
  })
  test('the foreman ending its turn mid-pipeline is waiting, unless a subagent is still open', () => {
    expect(derive({ stageEvents: [se('gate', 'started', 6)], lifecycle: [le('SessionStart', 20), le('Stop', 5)] }).needs?.kind).toBe('waiting-input')
    const open = [le('SessionStart', 20), le('SubagentStart', 7, { agent_id: 'x', agent_type: 'builder' }), le('Stop', 5)]
    expect(derive({ stageEvents: [se('build', 'started', 6)], lifecycle: open }).needs).toBeUndefined()
  })
  test('lifecycle only (no stage events yet) is still in progress', () => {
    expect(derive({ lifecycle: [le('SessionStart', 3), le('SubagentStart', 2, { agent_id: 's', agent_type: 'spec-writer' })] })).toMatchObject({ state: 'in-progress', flags: ['live'] })
  })
  test('events win over issue labels that disagree, with an info notice', () => {
    const r = derive({ issue: issue(['factory:proposed']), stageEvents: [se('spec', 'started', 2)] })
    expect(r.state).toBe('in-progress')
    expect(r.notices.map((x) => x.message).join()).toMatch(/events win/)
  })
})

describe('blocked', () => {
  test('a fresh BLOCKED.md stops the item and shows the question', () => {
    const r = derive({ stageEvents: [se('intake', 'passed', 30), se('spec', 'blocked', 20), se('observe', 'passed', 15)], files: { 'BLOCKED.md': file('# Blocked\n\nWhat I was doing.\n\nHard or soft delete?', 18, 'worktree') } })
    expect(r).toMatchObject({ state: 'blocked', column: 'stopped', needs: { kind: 'answer', summary: 'Hard or soft delete?', since: ago(18) } })
    expect(r.reason).toMatch(/stopped at spec/)
  })
  test('a blocked event with no file still blocks, with the detail and a notice', () => {
    const r = derive({ stageEvents: [se('build', 'blocked', 20, 0, { detail: 'builder disputes AC-2' }), se('observe', 'passed', 15)] })
    expect(r).toMatchObject({ state: 'blocked', needs: { kind: 'answer', summary: 'builder disputes AC-2' } })
    expect(r.notices.map((x) => x.message).join()).toMatch(/no current BLOCKED.md/)
  })
  test('a bare blocked event while the item\'s agents still run is not a question for you yet', () => {
    const life = [le('SessionStart', 30), le('SubagentStart', 12, { agent_id: 't1', agent_type: 'test-author' })]
    const r = derive({ stageEvents: [se('build', 'started', 25), se('build', 'blocked', 8, 0, { detail: 'test dispute' })], lifecycle: life })
    expect(r).toMatchObject({ state: 'in-progress', flags: ['live'] })
    expect(r.needs).toMatchObject({ kind: 'info', summary: `logged a stop at build ${ago(8).slice(11, 16)} UTC while its agents are still running; check its tab` })
    // a BLOCKED.md makes it a question, live agents or not
    const asked = derive({ stageEvents: [se('build', 'started', 25), se('build', 'blocked', 8)], lifecycle: life, files: { 'BLOCKED.md': file('# Blocked\n\nWhich?', 8, 'worktree') } })
    expect(asked).toMatchObject({ state: 'blocked', needs: { kind: 'answer', summary: 'Which?' } })
  })
  test('a BLOCKED.md older than a re-run is stale: the item is in progress, flagged', () => {
    const r = derive({ stageEvents: [se('spec', 'blocked', 3000), se('spec', 'started', 30, 1), se('spec', 'passed', 25, 1), se('tests', 'started', 5)], files: { 'BLOCKED.md': file('Which?', 2990) } })
    expect(r).toMatchObject({ state: 'in-progress', stage: 'tests' })
    expect(r.flags).toContain('stale-blocked')
    expect(r.blocked?.stale).toBe(true)
  })
  test('a BLOCKED.md older than the item\'s pull request or a ticket transition is answered, not current', () => {
    const block = { stageEvents: [se('review', 'blocked', 300, 2)], files: { 'BLOCKED.md': file('Which wording?', 300) } }
    const pr = derive({ ...block, pull: pull({ createdAt: ago(100) }) })
    expect(pr).toMatchObject({ state: 'pr-open', blocked: { stale: true } })
    expect(pr.notices.map((x) => x.message)).toContain('BLOCKED.md is older than a later step (PR #101 opened); treating it as answered')
    const ticket = derive({ ...block, tickets: [{ ts: ago(200), what: 'ticket done (done)' }] })
    expect(ticket.blocked?.stale).toBe(true)
    expect(ticket.flags).toContain('stale-blocked')
    expect(derive({ ...block, tickets: [{ ts: ago(400), what: 'ticket accepted (accepted)' }] })).toMatchObject({ state: 'blocked', blocked: { stale: false } })
  })
})

describe('failed', () => {
  test('a failed stage is a fix round in progress until the run goes quiet', () => {
    expect(derive({ stageEvents: [se('gate', 'failed', 5)] }).state).toBe('in-progress')
    expect(derive({ stageEvents: [se('gate', 'failed', 45, 1, { detail: 'make accept: 1 failing' })] })).toMatchObject({ state: 'failed', column: 'stopped', needs: { kind: 'failed', summary: 'gate r1 failed: make accept: 1 failing' } })
  })
  test('a failed stage followed by the session ending is failed at once', () => {
    expect(derive({ stageEvents: [se('gate', 'failed', 5)], lifecycle: [le('SessionStart', 30), le('SessionEnd', 3)] }).state).toBe('failed')
  })
  test('a session that ends mid-stage is failed, and its open agent run is abandoned', () => {
    const life = [le('SessionStart', 30), le('SubagentStart', 20, { agent_id: 'b1', agent_type: 'builder' }), le('SessionEnd', 10)]
    const c = ctx(life)
    expect(c.runs[0]).toMatchObject({ outcome: 'abandoned', agentType: 'builder' })
    const r = derive({ stageEvents: [se('build', 'started', 20)], lifecycle: life })
    expect(r).toMatchObject({ state: 'failed', needs: { kind: 'failed' } })
    expect(r.needs!.summary).toMatch(/session ended during build/)
    expect(r.flags).not.toContain('live')
  })
  test('a failing required check on an open PR', () => {
    const r = derive({ stageEvents: RUN_TO_PR(), pull: pull({ checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }] }) })
    expect(r).toMatchObject({ state: 'failed', needs: { kind: 'failed', summary: 'CI failing: check' } })
  })
})

describe('pull requests', () => {
  test('open with auto-merge is pr-open; nothing needed', () => {
    expect(derive({ stageEvents: RUN_TO_PR(), pull: pull() })).toMatchObject({ state: 'pr-open', column: 'pr-open', needs: undefined, pr: { number: 101 } })
  })
  test('R2 without approval waits for approval; the failing risk-gate is expected, not a failure', () => {
    const p = pull({ labels: ['risk:R2'], autoMerge: false, checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE' }] })
    const r = derive({ stageEvents: RUN_TO_PR(), pull: p, files: { 'review.md': file(REVIEW('pass', 'R2')) } })
    expect(r).toMatchObject({ state: 'awaiting-approval', column: 'waiting', tier: 'R2', needs: { kind: 'approve' } })
    expect(r.needs!.summary).toMatch(/review: pass/)
  })
  test('after approval, a risk-gate failure from before the label is out of date (CI re-runs it); a later one is real', () => {
    const gate = (min: number) => [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: ago(min) }]
    const approved = (checks: Pull['checks']) => pull({ labels: ['risk:R2', 'human-approved'], autoMerge: false, checks, timeline: [{ type: 'labeled', label: 'human-approved', at: ago(10) }] })
    expect(derive({ stageEvents: RUN_TO_PR(), pull: approved(gate(30)) }).state).toBe('awaiting-merge')
    expect(derive({ stageEvents: RUN_TO_PR(), pull: approved(gate(5)) })).toMatchObject({ state: 'failed', needs: { kind: 'failed' } })
    expect(derive({ stageEvents: RUN_TO_PR(), pull: approved([{ name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE' }]) }).state).toBe('failed') // time unknown: assume real
  })
  test('R2 by path alone, shown with the rule that matched', () => {
    const r = derive({ stageEvents: RUN_TO_PR(), pull: pull({ autoMerge: false }), changedFiles: ['src/x.ts', 'db/migrations/0004_add.sql'] })
    expect(r.tier).toBe('R2')
    expect(r.state).toBe('awaiting-approval')
    expect(r.needs!.summary).toBe('R2 · db/migrations/0004_add.sql (*migrations/*) · no review.md')
    expect(r.riskFiles).toEqual([{ path: 'src/x.ts', tier: 'R1', pattern: null }, { path: 'db/migrations/0004_add.sql', tier: 'R2', pattern: '*migrations/*' }])
  })
  test('approved R2 not merged, and R1 without auto-merge under policy none, wait for a merge', () => {
    const approved = derive({ stageEvents: RUN_TO_PR(), pull: pull({ labels: ['risk:R2', 'human-approved'], autoMerge: false }) })
    expect(approved).toMatchObject({ state: 'awaiting-merge', needs: { kind: 'merge' }, pr: { approved: true } })
    const policy = derive({ stageEvents: RUN_TO_PR(), pull: pull({ autoMerge: false }) }, { autoMergeMax: 'none' })
    expect(policy.needs!.summary).toMatch(/R1 is above AUTO_MERGE_MAX_TIER=none/)
  })
  test('closed without merging is stopped; a re-run after the close is not', () => {
    const closed = pull({ state: 'CLOSED', closedAt: ago(30) })
    expect(derive({ stageEvents: RUN_TO_PR(), pull: closed })).toMatchObject({ state: 'closed', column: 'stopped', needs: undefined })
    expect(derive({ stageEvents: [...RUN_TO_PR(), se('intake', 'passed', 10), se('spec', 'started', 9)], pull: closed }).state).toBe('in-progress')
  })
  test('offline: a pr stage event with no GitHub data is pr-open', () => {
    expect(derive({ stageEvents: RUN_TO_PR() })).toMatchObject({ state: 'pr-open', reason: expect.stringMatching(/no GitHub data/) })
  })
})

describe('merged and closed', () => {
  test('merged says into what: the PR\'s base, or main when only main\'s tree says so', () => {
    expect(derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), baseRefName: 'feature/f001-x' }) })).toMatchObject({ state: 'merged', mergedInto: 'feature/f001-x' })
    expect(derive({ onMain: { at: ago(30) } })).toMatchObject({ state: 'merged', mergedInto: 'main' })
  })
  test('a draft pull request waits for its author, not for auto-merge or you', () => {
    const r = derive({ stageEvents: RUN_TO_PR(), pull: pull({ isDraft: true, autoMerge: false, labels: ['risk:R1', 'human-approved'] }) })
    expect(r).toMatchObject({ state: 'pr-open', reason: 'PR #101 is a draft: its author marks it ready for review' })
    expect(r.needs).toBeUndefined()
  })

  test('a CI re-run on the same head: only each check\'s current run counts (a running re-run is newer than any result)', () => {
    const run = (conclusion: string | undefined, min?: number) => ({ name: 'factory-tests', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, completedAt: min === undefined ? undefined : ago(min) })
    const green = derive({ stageEvents: RUN_TO_PR(), pull: pull({ autoMerge: false, checks: [run('FAILURE', 20), run('SUCCESS', 5)] }) })
    expect(green.state).not.toBe('failed')
    const rerunning = derive({ stageEvents: RUN_TO_PR(), pull: pull({ autoMerge: false, checks: [run('FAILURE', 20), run(undefined)] }) })
    expect(rerunning.state).not.toBe('failed')
    expect(rerunning.needs?.summary).toContain('checks pending')
    expect(currentChecks([run('SUCCESS', 5), run('FAILURE', 20)]).map((c) => c.conclusion)).toEqual(['SUCCESS'])
  })

  test('merged: first pass, auto vs human', () => {
    const auto = derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), timeline: [{ type: 'auto_merge_enabled', at: ago(59) }] }) })
    expect(auto).toMatchObject({ state: 'merged', column: 'merged', mergedAt: ago(30), mergedBy: 'auto', firstPass: true, fixRounds: 0 })
    const human = derive({ stageEvents: [...RUN_TO_PR(), se('gate', 'failed', 69)], pull: pull({ state: 'MERGED', mergedAt: ago(30), labels: ['risk:R2', 'human-approved'], autoMerge: false }) }) // merged by hand
    expect(human).toMatchObject({ mergedBy: 'human', firstPass: false, fixRounds: 1, fixByStage: { gate: 1 } })
    // approved, then auto-merge merged it: auto, not "merged by you"; GitHub's merger login is kept as said
    const approvedAuto = derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), labels: ['risk:R2', 'human-approved'], autoMerge: true, merger: 'octo' }) })
    expect(approvedAuto).toMatchObject({ mergedBy: 'auto', merger: 'octo' })
    // auto-merge enabled, then disabled before a manual merge: the last auto-merge event before the merge decides
    const off = derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), autoMerge: false, timeline: [{ type: 'auto_merge_enabled', at: ago(50) }, { type: 'auto_merge_disabled', at: ago(40) }] }) })
    expect(off.mergedBy).toBeUndefined()
    const reEnabled = derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), autoMerge: false, timeline: [{ type: 'auto_merge_disabled', at: ago(50) }, { type: 'auto_merge_enabled', at: ago(40) }] }) })
    expect(reEnabled.mergedBy).toBe('auto')
  })

  test('merged on a second attempt is not a first pass, though this attempt had no fix rounds', () => {
    const second = derive({ stageEvents: RUN_TO_PR(), earlierAttempts: 1, pull: pull({ state: 'MERGED', mergedAt: ago(30) }) })
    expect(second).toMatchObject({ state: 'merged', fixRounds: 0, firstPass: false })
  })

  test('merged: auto-merge still on the merged PR is auto even without the timeline event; no evidence names no one', () => {
    // GitHub keeps autoMergeRequest on a pull request that auto-merge merged, but the timeline can miss the event
    const autoOnly = derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), autoMerge: true, timeline: [] }) })
    expect(autoOnly.mergedBy).toBe('auto')
    // merged with neither auto-merge nor human-approved: an agent may have merged it with the same account; say who only with evidence
    const unknown = derive({ stageEvents: RUN_TO_PR(), pull: pull({ state: 'MERGED', mergedAt: ago(30), autoMerge: false, timeline: [] }) })
    expect(unknown.state).toBe('merged')
    expect(unknown.mergedBy).toBeUndefined()
  })
  test('offline: the work folder on main means merged', () => {
    expect(derive({ stageEvents: RUN_TO_PR(), onMain: { at: ago(20) } })).toMatchObject({ state: 'merged', mergedAt: ago(20) })
  })
  test('events after a merge keep it merged, with a notice', () => {
    const r = derive({ stageEvents: [...RUN_TO_PR(), se('build', 'started', 5)], pull: pull({ state: 'MERGED', mergedAt: ago(30) }) })
    expect(r.state).toBe('merged')
    expect(r.notices.map((x) => x.message).join()).toMatch(/after the merge/)
  })
  test('an issue closed as not planned', () => {
    expect(derive({ issue: issue(['factory:proposed'], { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: ago(10) }) })).toMatchObject({ state: 'closed', reason: 'issue closed (not planned)' })
  })
  test('a revert flags the item', () => {
    expect(derive({ onMain: { at: ago(100) }, revertedBy: { at: ago(10), ref: 'PR #9', title: 'Revert' } }).flags).toEqual(['reverted'])
  })
})

describe('tier, documents and what nobody verified', () => {
  test('the tier is the highest source and nothing lowers it', () => {
    const r = derive({ stageEvents: RUN_TO_PR(), pull: pull({ labels: ['risk:R1'] }), files: { 'spec.md': file(SPEC('R2')), 'review.md': file(REVIEW('pass', 'R0')) } })
    expect(r.tier).toBe('R2')
    expect(r.tierSources.map((s) => `${s.source}:${s.tier}`)).toEqual(['spec:R2', 'pr-label:R1', 'pr-event:R1', 'review:R0'])
  })
  test('a malformed spec and review are notices; the item still derives', () => {
    const r = derive({ stageEvents: [se('build', 'started', 2)], files: { 'spec.md': file('no frontmatter'), 'review.md': file('Looks fine.') } })
    expect(r.state).toBe('in-progress')
    expect(r.spec).toMatchObject({ ok: false, raw: 'no frontmatter' })
    expect(r.notices.filter((x) => x.level === 'error').map((x) => x.message)).toEqual([expect.stringMatching(/could not parse spec.md/), expect.stringMatching(/could not parse review.md/)])
    expect(r.title).toBe('#1')
  })
  test('a spec whose id disagrees with the folder', () => {
    const r = derive({ stageEvents: [se('spec', 'passed', 2)], files: { 'spec.md': file(SPEC().replace('id: 1', 'id: 9')) } })
    expect(r.notices.map((x) => x.message).join()).toMatch(/says id 9/)
  })
  test('not verified: review, PR body, criteria without tests, missing review', () => {
    const r = derive({
      stageEvents: RUN_TO_PR(),
      pull: pull({ body: '## Not verified\n- rollback\n- Concurrency.\n' }),
      files: { 'spec.md': file(SPEC()), 'review.md': file(REVIEW('pass', 'R1', '- concurrency')) },
      testRefs: [{ ac: 'AC-1', file: 'tests/acceptance/1-x.test.ts', line: 3, text: "test('AC-1')" }],
    })
    expect(r.notVerified.map((x) => x.text)).toEqual(['concurrency', 'rollback', 'AC-2 has no acceptance test that names it'])
    expect(r.notVerified[0]!.source).toBe('review.md, PR #101 body')
    const none = derive({ stageEvents: [se('tests', 'skipped', 5)], pull: pull(), files: { 'spec.md': file(SPEC('R0', 'none')) } })
    expect(none.notVerified.map((x) => x.text)).toEqual(['acceptance tests were skipped (spec says tests: none)', 'no review.md: the independent review is not on record'])
  })
  test('events in any order give the same result', () => {
    const evs = [se('intake', 'passed', 10), se('spec', 'passed', 8), se('tests', 'started', 5)]
    expect(derive({ stageEvents: [...evs].reverse() }).stage).toBe('tests')
  })
})

describe('pipelineRuns', () => {
  test('one run per /work invocation, with how it ended', () => {
    const r = derive({ stageEvents: [se('intake', 'started', 300), se('spec', 'blocked', 290), se('observe', 'passed', 288), se('intake', 'started', 60), se('spec', 'passed', 55), se('pr', 'passed', 40)] })
    expect(r.pipelineRuns.map((x) => [x.outcome, x.stage])).toEqual([['blocked', 'spec'], ['pr', undefined]])
    const dead = derive({ stageEvents: [se('intake', 'started', 300), se('gate', 'failed', 200)] })
    expect(dead.pipelineRuns).toMatchObject([{ outcome: 'failed', stage: 'gate' }])
  })
})

describe('stageResult', () => {
  test('an agent run gets the result of the stage it served', async () => {
    const { stageResult } = await import('../server/core/derive.ts')
    const run = { agentId: 'a', agentType: 'reviewer', workId: '1', stage: 'review' as const, start: ago(30), end: ago(20), outcome: 'finished' as const }
    expect(stageResult(run, [se('review', 'failed', 50), se('review', 'passed', 19)])).toBe('passed')
  })
})

describe('buildStages', () => {
  test('attempts, rounds, durations and a terminal event with no start', () => {
    const stages = buildStages([se('gate', 'started', 20), se('gate', 'failed', 18), se('gate', 'started', 10, 1), se('gate', 'passed', 7, 1), se('review', 'passed', 5)])
    const gate = stages.find((s) => s.stage === 'gate')!
    expect(gate).toMatchObject({ status: 'passed', rounds: 1, durationMs: 5 * 60_000 })
    expect(gate.attempts.map((a) => `${a.round}:${a.status}`)).toEqual(['0:failed', '1:passed'])
    const review = stages.find((s) => s.stage === 'review')!
    expect(review.attempts).toEqual([{ round: 0, status: 'passed', end: ago(5) }])
    expect(review.durationMs).toBeUndefined()
    expect(stages.find((s) => s.stage === 'spec')!.status).toBe('pending')
  })
})

describe('indexLifecycle', () => {
  test('pairs runs by agent id; a stop with no start is still a run; a resumed session is live again', () => {
    const { runs, sessions } = indexLifecycle([
      le('SessionStart', 50), le('SubagentStart', 40, { agent_id: 'a' , agent_type: 'builder' }), le('SubagentStop', 30, { agent_id: 'a', agent_type: 'builder', transcript_path: '/t.jsonl' }),
      le('SubagentStop', 20, { agent_id: 'b', agent_type: 'reviewer' }), le('SessionEnd', 15), le('SessionStart', 5),
    ])
    expect(runs.filter((r) => r.agentType !== 'foreman').map((r) => [r.agentType, r.outcome, r.stage, r.transcriptPath])).toEqual([['builder', 'finished', 'build', '/t.jsonl'], ['reviewer', 'finished', 'review', undefined]])
    expect(runs.filter((r) => r.agentType === 'foreman')).toMatchObject([{ agentId: 'session:sess', outcome: 'running', workId: '1' }])
    expect(sessions.get('sess')!.end).toBeUndefined()
  })
  test('a subagent event with an empty agent_type is labelled "subagent", not blank', () => {
    const { runs } = indexLifecycle([le('SubagentStop', 5, { agent_id: 'c', agent_type: '' })])
    expect(runs.find((r) => r.agentId === 'c')?.agentType).toBe('subagent')
  })
})

describe('runs with no end', () => {
  test('a run open past the quiet threshold with nothing heard is "no end recorded"; Running now lists exactly the running runs', () => {
    const lifecycle = [
      le('SessionStart', 120, { session_id: 'old', work_id: '7' }), le('SubagentStart', 100, { session_id: 'old', work_id: '7', agent_id: 'b7', agent_type: 'builder' }), // never stopped
      le('SessionStart', 20, { session_id: 'new', work_id: '8' }), le('SubagentStart', 10, { session_id: 'new', work_id: '8', agent_id: 'r8', agent_type: 'reviewer' }),
      le('SessionStart', 200, { session_id: 'team', work_id: '' }), le('Notification', 5, { session_id: 'team', work_id: '', reason: 'idle' }), // a team session, no item
      le('SessionStart', 300, { session_id: 'setup', work_id: '' }), // a session long gone without its end
    ]
    const { sessions, runs } = indexLifecycle(lifecycle)
    const last = new Map([['7', Date.parse(ago(100))], ['8', Date.parse(ago(10))]])
    expireRuns(runs, sessions, last, NOW, 30)
    const by = (id: string) => runs.find((r) => r.agentId === id)!.outcome
    expect([by('b7'), by('session:old'), by('r8'), by('session:new'), by('session:team'), by('session:setup')]).toEqual(['no-end', 'no-end', 'running', 'running', 'running', 'no-end'])
    const c = ctx([], { runs, sessions })
    const out = deriveAll([{ id: '7', files: {}, stageEvents: [se('build', 'started', 100, 0, { work_id: '7' })], lifecycle: lifecycle.filter((e) => e.work_id === '7'), notices: [] }, { id: '8', files: {}, stageEvents: [se('review', 'started', 10, 0, { work_id: '8' })], lifecycle: lifecycle.filter((e) => e.work_id === '8'), notices: [] }], c)
    expect(out.running.map((r) => [r.workId, r.agentType])).toEqual([['8', 'reviewer'], ['8', 'foreman'], ['', 'foreman']])
    expect(out.running).toHaveLength(runs.filter((r) => r.outcome === 'running').length) // what the Runs page counts as running
    expect(out.byId.get('7')).toMatchObject({ flags: ['quiet'], needs: { kind: 'quiet', summary: 'no event for 100 min during build (builder: no end recorded)' } })
  })
})

describe('idle sessions', () => {
  test('a session whose latest event is an idle prompt or a Stop is idle, not running; its run stops counting time', () => {
    const lifecycle = [
      le('SessionStart', 60, { session_id: 'a', work_id: '8' }), le('Notification', 20, { session_id: 'a', work_id: '8', reason: 'idle_prompt', message: 'Claude is waiting for your input' }),
      le('SessionStart', 60, { session_id: 'b', work_id: '' }), le('Stop', 15, { session_id: 'b', work_id: '' }),
      le('SessionStart', 10, { session_id: 'c', work_id: '9' }), le('Notification', 2, { session_id: 'c', work_id: '9', reason: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
      le('SessionStart', 10, { session_id: 'd', work_id: '7' }), le('SubagentStart', 8, { session_id: 'd', work_id: '7', agent_id: 'x', agent_type: 'builder' }), le('Stop', 7, { session_id: 'd', work_id: '7' }),
    ]
    const { sessions, runs } = indexLifecycle(lifecycle)
    expireRuns(runs, sessions, new Map([['8', Date.parse(ago(20))], ['9', Date.parse(ago(2))], ['7', Date.parse(ago(7))]]), NOW, 30)
    const by = (id: string) => runs.find((r) => r.agentId === id)!
    expect([by('session:a'), by('session:b'), by('session:c'), by('session:d')].map((r) => [r.outcome, r.lastSeen])).toEqual([
      ['idle', ago(20)], ['idle', ago(15)], // waiting at its prompt with nothing to do
      ['running', undefined], // a permission prompt is a question mid-run, not idle
      ['running', undefined], // its builder is still open
    ])
    const out = deriveAll([], ctx([], { runs, sessions }))
    expect(out.running.map((r) => [r.workId, r.agentType])).toEqual([['7', 'builder'], ['9', 'foreman'], ['7', 'foreman']])
    // a run with no end stops its clock at the last thing heard
    const { sessions: s2, runs: r2 } = indexLifecycle([le('SessionStart', 120, { session_id: 'e', work_id: '5' }), le('SubagentStart', 100, { session_id: 'e', work_id: '5', agent_id: 'y', agent_type: 'builder' })])
    expireRuns(r2, s2, new Map([['5', Date.parse(ago(100))]]), NOW, 30)
    expect(r2.find((r) => r.agentId === 'y')).toMatchObject({ outcome: 'no-end', lastSeen: ago(100) })
  })
})

describe('deriveAll', () => {
  test('needs-you is ordered answer, approve, failed, waiting-input, quiet, merge; then oldest first', () => {
    const mk = (id: string, over: Partial<ItemInputs>): ItemInputs => ({ id, files: {}, lifecycle: [], notices: [], stageEvents: [], ...over })
    const relabel = (evs: StageEvent[], id: string) => evs.map((e) => ({ ...e, work_id: id }))
    const out = deriveAll(
      [
        mk('5', { stageEvents: relabel(RUN_TO_PR(), '5'), pull: pull({ autoMerge: false }) }),
        mk('4', { stageEvents: relabel([se('build', 'started', 50)], '4') }),
        mk('3', { stageEvents: relabel([se('gate', 'failed', 50)], '3') }),
        mk('2', { stageEvents: relabel(RUN_TO_PR(), '2'), pull: pull({ labels: ['risk:R2'], autoMerge: false }) }),
        mk('1', { stageEvents: relabel([se('spec', 'blocked', 3)], '1') }),
        mk('6', { stageEvents: relabel([se('spec', 'blocked', 30)], '6') }),
      ],
      ctx([], { autoMergeMax: 'none' }),
    )
    expect(out.needsYou.map((x) => `${x.kind}#${x.id}`)).toEqual(['answer#6', 'answer#1', 'approve#2', 'failed#3', 'quiet#4', 'merge#5'])
    expect(out.items.map((i) => i.id)).toEqual(['6', '5', '4', '3', '2', '1'])
  })
})
