// The factory's own files: drift against main, memory, reflections and their checks, config, audits.
import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from '../demo/generate.ts'
import { computeState, readDemoGitHub } from '../server/state.ts'
import { loadMeta } from '../server/sources/meta.ts'
import { auditsView, factoryView, prNext, pullNeeds, improvementView, memoryView, predictions } from '../server/core/meta.ts'
import type { Reflection } from '../server/core/types.ts'

const NOW = Date.parse('2026-11-13T10:00:00Z')

describe('over the demo', async () => {
  const d = generate(join(mkdtempSync(join(tmpdir(), 'cr-meta-')), 'demo'), NOW)
  const gh = await readDemoGitHub(d.github)
  const s = await computeState(d.repo, gh, { now: NOW, staleMinutes: 30 })
  const fv = factoryView(s.meta)

  test('a local edit CI will not see is flagged; everything else matches main', () => {
    const drifted = fv.files.filter((f) => f.drift !== 'same')
    expect(drifted).toEqual([{ path: 'factory/risk-rules.txt', drift: 'modified', where: 'uncommitted', size: expect.any(Number) }])
    expect(fv.rules!.main).not.toContain('src/reports')
    expect(fv.rules!.worktree).toContain('R2 src/reports/*')
    expect(fv.policy!.main).toMatchObject({ ok: true, value: { autoMergeMax: 'R1' } })
  })
  test('agents, skills, hooks and permissions come from their files', () => {
    expect(fv.agents.find((a) => a.name === 'reviewer')).toMatchObject({ model: 'opus', tools: ['Read', 'Grep', 'Glob', 'Bash'] })
    expect(fv.skills.find((k) => k.name === 'reflect')).toMatchObject({ manualOnly: true })
    const settings = fv.settings[0]!
    expect(settings.ok && settings.hooks.find((h) => h.event === 'PreToolUse')?.commands[0]).toContain('guard.sh')
    expect(settings.ok && settings.deny).toContain('Bash(gh pr review * --approve*)')
  })
  test('lessons with evidence; the format example is not a lesson', () => {
    const m = memoryView(s.meta, s.snap.observations)
    expect(m.lessons.map((l) => l.id)).toEqual(['L-1', 'L-2', 'L-3', 'L-4', 'L-5'])
    expect(m.lessons[0]!.evidence).toEqual(['5', '12', '13'])
    expect(m.notices).toEqual([])
    expect(m.observations.length).toBe(s.snap.observations.reduce((a, o) => a + o.items.length, 0))
    expect(new Set(m.observations.map((o) => o.key)).size).toBe(m.observations.length)
  })
  test('each prediction is joined to the later reflection that checked it', () => {
    const v = improvementView(s.meta, gh.data!.pulls)
    expect(v.reflections.every((r) => r.parsed.ok)).toBe(true)
    expect(v.predictions.map((p) => [p.title, p.check?.result])).toEqual([
      ['Run make accept before committing a build', 'no effect'],
      ['Membership check on every write path', 'worked'],
      ['Name acceptance tests after their criterion', undefined],
    ])
    expect(v.predictions[0]!.evidenceIds).toEqual(['5', '12'])
    expect(v.summary).toEqual({ worked: 1, noEffect: 1, worse: 0, unchecked: 1 })
    expect(v.pulls).toEqual([expect.objectContaining({ number: 141, tier: 'R2', approved: false })])
    expect(v.pulls[0]!.checks.map((c) => c.state)).toEqual(['pass', 'fail'])
  })
  test('an improvement PR above the auto-merge tier needs you, like any item PR', () => {
    expect(s.needsYou.filter((n) => n.id === 'pr-141')).toEqual([expect.objectContaining({ kind: 'approve', tier: 'R2', label: 'PR #141', href: '/improvement', summary: 'factory:improvement · R2' })]) // its failing risk-gate is expected until approved
    const pr = gh.data!.pulls.find((p) => p.number === 141)!
    const approvedNow = { ...pr, labels: [...pr.labels, 'human-approved'], timeline: [...pr.timeline, { type: 'labeled', label: 'human-approved', at: new Date(NOW).toISOString() }] } // its risk-gate failed before the label
    expect(pullNeeds([approvedNow], s.snap.rules, 'R1')).toEqual([expect.objectContaining({ kind: 'merge', href: '/improvement', summary: 'factory:improvement · approved: merge it · R2' })]) // approved is not merged
    const docs = { ...pr, labels: ['factory:improvement'], files: [{ path: 'docs/factory/MEMORY.md', additions: 1, deletions: 0 }], checks: pr.checks.map((c) => ({ ...c, conclusion: 'SUCCESS' })) } // R0: risk-gate passes
    expect(pullNeeds([docs], s.snap.rules, 'R1')).toEqual([]) // R0, auto-merges
    expect(pullNeeds([docs], s.snap.rules, 'none')).toEqual([expect.objectContaining({ kind: 'merge', tier: 'R0' })])
  })
  test('an approved R2 PR: a risk-gate failure from after the label is real; one from before is stale', () => {
    const pr = gh.data!.pulls.find((p) => p.number === 141)!
    const at = (m: number) => new Date(NOW - m * 60_000).toISOString()
    const approved = { ...pr, labels: ['factory:improvement', 'human-approved', 'risk:R2'], timeline: [{ type: 'labeled', label: 'human-approved', at: at(30) }] }
    const gate = (m: number) => ({ ...approved, checks: [{ name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: at(m) }] })
    expect(pullNeeds([gate(10)], s.snap.rules, 'R1')).toEqual([expect.objectContaining({ kind: 'failed', summary: 'factory:improvement · approved, but failing: risk-gate' })]) // completed after the approval
    expect(pullNeeds([gate(40)], s.snap.rules, 'R1')).toEqual([expect.objectContaining({ kind: 'merge', summary: 'factory:improvement · approved: merge it · R2' })]) // before it: CI re-runs it on the label
    // no completion time: it cannot be shown stale, so it is real
    const undated = { ...approved, autoMerge: true, checks: [{ name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE' }] }
    expect(prNext(undated, 'R2', 'R1')).toMatchObject({ kind: 'failed', who: 'its author', what: 'fix the failing check: risk-gate' })
    // not approved: the one next action, with or without auto-merge
    const open = { ...pr, labels: ['risk:R2'], headRefName: 'factory/x', checks: [] }
    expect(pullNeeds([open], s.snap.rules, 'R1')[0]!.summary).toBe('factory/x · add human-approved, wait for the checks to pass, then merge · R2')
    expect(pullNeeds([{ ...open, autoMerge: true }], s.snap.rules, 'R1')[0]!.summary).toBe('factory/x · add human-approved; auto-merge then merges it once the checks pass · R2')
  })
  test('a failing check beats auto-merge: auto-merge never merges a red PR', () => {
    const pr = gh.data!.pulls.find((p) => p.number === 141)!
    const red = { ...pr, labels: ['risk:R1'], autoMerge: true, checks: [{ name: 'factory-tests', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'risk-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
    expect(prNext(red, 'R1', 'R1')).toMatchObject({ kind: 'failed', who: 'its author', what: 'fix the failing check: factory-tests' })
    expect(prNext({ ...red, checks: [{ name: 'factory-tests', status: 'IN_PROGRESS' }] }, 'R1', 'R1')).toMatchObject({ kind: 'info', who: 'GitHub', what: 'auto-merge merges it when the checks pass' })
    // a re-run under way is newer than the dated failure
    const rerun = { ...red, checks: [{ name: 'factory-tests', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-11-13T09:00:00Z' }, { name: 'factory-tests', status: 'IN_PROGRESS' }] }
    expect(prNext(rerun, 'R1', 'R1')).toMatchObject({ kind: 'info', who: 'GitHub', failing: [] })
  })

  test('a draft pull request cannot merge: its author marks it ready for review', () => {
    const pr = gh.data!.pulls.find((p) => p.number === 141)!
    const draft = { ...pr, isDraft: true, autoMerge: false, labels: ['risk:R2', 'human-approved'], timeline: [{ type: 'labeled', label: 'human-approved', at: new Date(NOW).toISOString() }], checks: [{ name: 'factory-tests', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
    expect(prNext(draft, 'R2', 'R1')).toMatchObject({ kind: 'info', who: 'its author', what: 'mark it ready for review' })
    expect(prNext({ ...draft, labels: ['risk:R1'] }, 'R1', 'none')).toMatchObject({ who: 'its author', what: 'mark it ready for review' }) // not "merge it"
    expect(prNext({ ...draft, labels: [], checks: [{ name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE' }] }, undefined, 'R1')).toMatchObject({ who: 'its author', what: 'mark it ready for review' }) // a draft first, red or not
  })

  test('audits newest first, text kept raw for the sanitising renderer', () => {
    const a = auditsView(s.meta)
    expect(a).toHaveLength(2)
    expect(a[0]!.date > a[1]!.date).toBe(true)
    expect(a[0]!.text).toContain('<script>')
  })
})

test('a change without an id cannot be matched to a later check', () => {
  const r: Reflection[] = [
    { file: 'a', date: '2026-01-01', changes: [{ title: 'x', change: 'c', expected: 'e' }, { id: 'C-2026-01-01-2', title: 'y', change: 'c', expected: 'e', evidence: '#4 and #9' }], results: [] },
    { file: 'b', date: '2026-01-08', changes: [], results: [{ id: 'C-2026-01-01-2', result: 'worse', note: 'more rounds' }] },
  ]
  const p = predictions(r)
  expect(p[0]!.check).toBeUndefined()
  expect(p[1]!).toMatchObject({ evidenceIds: ['4', '9'], check: { result: 'worse', checkedIn: '2026-01-08' } })
})

test('the loader never follows a symlink, skips large files and works without git', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'cr-meta-raw-'))
  mkdirSync(join(repo, '.claude/agents'), { recursive: true })
  mkdirSync(join(repo, '.claude/worktrees/x'), { recursive: true })
  writeFileSync(join(repo, '.claude/agents/ok.md'), '---\nname: ok\n---\n')
  writeFileSync(join(repo, '.claude/worktrees/x/CLAUDE.md'), 'a whole checkout lives here')
  writeFileSync(join(repo, 'CLAUDE.md'), 'x'.repeat(600 * 1024))
  symlinkSync('/etc/hosts', join(repo, '.claude/agents/hosts.md'))
  symlinkSync('/etc', join(repo, 'factory'))
  let files = await loadMeta(repo, false, null)
  expect(files.map((f) => f.path)).toEqual(['.claude/agents/ok.md', 'CLAUDE.md'])
  expect(files.find((f) => f.path === 'CLAUDE.md')!.text).toBeNull()
  expect(files.every((f) => f.drift === 'same')).toBe(true)
  // in git: a committed change on the checked-out branch is "branch", an edit on top is "uncommitted"
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  git('init', '-q', '-b', 'main')
  git('add', '.claude/agents/ok.md')
  git('commit', '-qm', 'one')
  git('switch', '-qc', 'work/1-x')
  writeFileSync(join(repo, '.claude/agents/ok.md'), '---\nname: ok\nmodel: opus\n---\n')
  git('commit', '-qam', 'two')
  files = await loadMeta(repo, true, 'main')
  expect(files.find((f) => f.path === '.claude/agents/ok.md')).toMatchObject({ drift: 'modified', where: 'branch' })
  writeFileSync(join(repo, '.claude/agents/ok.md'), '---\nname: ok\nmodel: haiku\n---\n')
  files = await loadMeta(repo, true, 'main')
  expect(files.find((f) => f.path === '.claude/agents/ok.md')).toMatchObject({ drift: 'modified', where: 'uncommitted' })
  expect(files.find((f) => f.path === 'CLAUDE.md')).toMatchObject({ drift: 'added', where: 'uncommitted' })
})
