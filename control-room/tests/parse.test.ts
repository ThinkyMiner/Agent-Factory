import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  blockedSummary,
  bullets,
  parseEvents,
  parseLessons,
  parseObservationFile,
  parsePolicy,
  parseReflection,
  parseReview,
  parseSpec,
  prNotVerified,
} from '../server/core/parse.ts'

const TEMPLATE = (p: string) => readFileSync(new URL(`../demo/template/${p}`, import.meta.url), 'utf8')

describe('parseEvents', () => {
  test('coerces the string numbers emit-event.sh writes', () => {
    const { events, notices } = parseEvents('{"ts":"2026-11-01T10:00:00Z","type":"stage","work_id":"12","branch":"work/12-x","stage":"gate","status":"failed","round":"1","pr":"#40","tier":"R2"}\n', 'f')
    expect(notices).toEqual([])
    expect(events[0]).toMatchObject({ type: 'stage', work_id: '12', round: 1, pr: 40, tier: 'R2' })
  })
  test('a missing round is round 0; a numeric work_id becomes a string', () => {
    const { events } = parseEvents('{"ts":"2026-11-01T10:00:00Z","type":"stage","work_id":7,"stage":"spec","status":"started"}', 'f')
    expect(events[0]).toMatchObject({ work_id: '7', round: 0, branch: '' })
  })
  test('bad JSON, unknown types, bad fields and bad tiers become notices, not crashes', () => {
    const text = [
      'not json',
      '{"ts":"2026-11-01T10:00:00Z","type":"metric","x":1}',
      '{"ts":"2026-11-01T10:00:00Z","type":"stage","work_id":"1","stage":"deploy","status":"started"}',
      '{"ts":"yesterday","type":"stage","work_id":"1","stage":"spec","status":"started"}',
      '{"ts":"2026-11-01T10:00:00Z","type":"stage","work_id":"1","stage":"pr","status":"passed","tier":"R9"}',
      '',
    ].join('\n')
    const { events, notices } = parseEvents(text, 'events.jsonl')
    expect(events.map((e) => e.type)).toEqual(['unknown', 'unknown', 'unknown', 'stage'])
    expect(notices).toHaveLength(5)
    expect(notices[0]!.message).toMatch(/line 1: not valid JSON/)
    expect(notices[2]!.message).toMatch(/stage/)
    expect(notices[4]!.message).toMatch(/unknown tier "R9"/)
    expect((events[3] as { tier?: string }).tier).toBeUndefined()
  })
  test('team mode: planning, slot and item events are not notices; an escalation is a warning in its own words', () => {
    const text = ['round', 'approval', 'position', 'message', 'contract', 'dispatch', 'item', 'slot', 'ticket', 'integration']
      .map((type) => JSON.stringify({ ts: '2026-11-01T10:00:00Z', type, work_id: '', cycle: 'c001-x' }))
      .concat('{"ts":"2026-11-01T10:00:00Z","type":"escalation","reason":"slot","detail":"backend has held a build slot for 4 hours"}')
      .join('\n')
    const { events, notices } = parseEvents(text, 'f')
    expect(events).toHaveLength(11)
    expect(notices).toEqual([{ level: 'warn', source: 'f', message: 'line 11: escalation (slot): backend has held a build slot for 4 hours' }])
  })
  test('team mode stage names count as the pipeline stage they stand for, and keep their name in the detail', () => {
    const ev = (stage: string, detail?: string) => JSON.stringify({ ts: '2026-11-01T10:00:00Z', type: 'stage', work_id: '6', stage, status: 'blocked', round: '1', detail })
    const { events, notices } = parseEvents([ev('evidence-review', 'see BLOCKED.md'), ev('criteria'), ev('security', 'x'), ev('ui-review'), ev('design')].join('\n'), 'f')
    expect(notices).toEqual([])
    expect(events.map((e) => [(e as { stage: string }).stage, (e as { detail?: string }).detail])).toEqual([
      ['review', 'evidence-review: see BLOCKED.md'], ['build', 'criteria'], ['review', 'security: x'], ['review', 'ui-review'], ['spec', 'design'],
    ])
  })
  test('a half-written last line is skipped silently when tailing', () => {
    const text = '{"ts":"2026-11-01T10:00:00Z","type":"lifecycle","event":"Stop","session_id":"s"}\n{"ts":"2026-11-01T10:0'
    expect(parseEvents(text, 'f', { partialTail: true }).notices).toEqual([])
    expect(parseEvents(text, 'f').notices).toHaveLength(1)
  })
  test('lifecycle events keep optional fields and drop nulls', () => {
    const { events } = parseEvents('{"ts":"2026-11-01T10:00:00Z","type":"lifecycle","work_id":"","branch":"main","event":"SessionStart","session_id":"s1","reason":"startup","message":null}', 'f')
    expect(events[0]).toMatchObject({ event: 'SessionStart', session_id: 's1', reason: 'startup' })
    expect((events[0] as { message?: string }).message).toBeUndefined()
  })
})

const SPEC = `---
id: 12
title: Settle up between members
risk_floor: R1
tests: required
status: specified
---

## Problem
Members cannot settle up.

## Acceptance criteria
- AC-1: Given two members, when one settles, then the balance is zero.
- AC-2: Given a non-member,
  when they call settle, then the API responds 403.

## Out of scope
- Partial settlements.

## Assumptions
- Amounts are integers.

## Blocking questions
None

## Expected touch points
- src/balances/

## Follow-ups
-
`

describe('parseSpec', () => {
  test('reads frontmatter, criteria (with continuation lines) and sections', () => {
    const r = parseSpec(SPEC)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toEqual([])
    expect(r.value).toMatchObject({ id: '12', risk_floor: 'R1', tests: 'required', blockingQuestions: [], followUps: [], outOfScope: ['Partial settlements.'] })
    expect(r.value.criteria).toEqual([
      { id: 'AC-1', text: 'Given two members, when one settles, then the balance is zero.' },
      { id: 'AC-2', text: 'Given a non-member, when they call settle, then the API responds 403.' },
    ])
  })
  test('the unfilled template is rejected as a placeholder', () => {
    const r = parseSpec(TEMPLATE('factory/templates/spec.md'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/id is missing or still a placeholder/)
  })
  test('broken frontmatter returns the raw text', () => {
    const r = parseSpec('---\nid: [oops\nrisk_floor: R1\n---\nbody')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/id is missing or still a placeholder/)
      expect(r.raw).toContain('[oops')
    }
  })
  test('frontmatter is read line by line, as validate-spec.sh does: a colon in the title is fine', () => {
    const r = parseSpec(SPEC.replace('title: Settle up between members', 'title: Member roles: owner and member').replace('id: 12', 'id: "12"'))
    expect(r.ok && r.value.title).toBe('Member roles: owner and member')
    expect(r.ok && r.value.id).toBe('12')
  })
  test('no frontmatter, unclosed frontmatter and bad enum values are errors', () => {
    expect(parseSpec('## Problem\nx').ok).toBe(false)
    expect(parseSpec('---\nid: 1\n').ok).toBe(false)
    const r = parseSpec(SPEC.replace('risk_floor: R1', 'risk_floor: medium'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/risk_floor/)
  })
  test('missing sections and criteria are warnings, and blocking questions are listed', () => {
    const r = parseSpec(SPEC.replace(/## Out of scope[\s\S]*?## Assumptions/, '## Assumptions').replace('None', '- Hard or soft delete?').replace(/- AC-\d.*\n(  .*\n)?/g, ''))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings.join('\n')).toMatch(/Out of scope/)
    expect(r.warnings.join('\n')).toMatch(/no acceptance criteria/)
    expect(r.value.blockingQuestions).toEqual(['Hard or soft delete?'])
  })
})

const REVIEW = `VERDICT: changes-required
RISK: R2   (above the spec floor: db/migrations/0003.sql)
BLOCKING:
- src/api/users.ts:42  missing auth check; anyone can delete; check ownership first
- the AC-2 test would pass with the feature removed
NON-BLOCKING:
- src/api/users.ts  name the handler after the route
VERIFIED: make check (pass), make accept (pass)
NOT VERIFIED:
- Behaviour under concurrent writes.
`

describe('parseReview', () => {
  test('reads the fixed shape, findings with path and line', () => {
    const r = parseReview(REVIEW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toEqual([])
    expect(r.value.verdict).toBe('changes-required')
    expect(r.value.risk).toBe('R2')
    expect(r.value.riskWhy).toMatch(/above the spec floor/)
    expect(r.value.blocking[0]).toEqual({ path: 'src/api/users.ts', line: 42, text: 'missing auth check; anyone can delete; check ownership first' })
    expect(r.value.blocking[1]).toEqual({ text: 'the AC-2 test would pass with the feature removed' })
    expect(r.value.nonBlocking[0]).toMatchObject({ path: 'src/api/users.ts', line: undefined })
    expect(r.value.verified).toEqual(['make check (pass), make accept (pass)'])
    expect(r.value.notVerified).toEqual(['Behaviour under concurrent writes.'])
  })
  test('"- none" sections are empty', () => {
    const r = parseReview('VERDICT: pass\nRISK: R1\nBLOCKING:\n- none\nNON-BLOCKING:\n- none\nVERIFIED: make check\nNOT VERIFIED:\n- none\n')
    expect(r.ok && r.value.blocking.length + r.value.notVerified.length).toBe(0)
  })
  test('tolerates a code fence, bold labels and a preamble, with warnings', () => {
    const r = parseReview('Here is my review.\n```\n**VERDICT:** pass\n**RISK:** R1\nBLOCKING:\n- none\n```\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings.join(' ')).toMatch(/text before VERDICT/)
  })
  test('no VERDICT or an invalid verdict is a parse failure with the raw text', () => {
    const a = parseReview('Looks good to me.')
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.raw).toBe('Looks good to me.')
    const b = parseReview('VERDICT: approved\nRISK: R1')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.error).toMatch(/approved/)
  })
  test('an unknown RISK is a warning, not a failure', () => {
    const r = parseReview('VERDICT: escalate\nRISK: high\n')
    expect(r.ok && r.value.risk).toBeUndefined()
    expect(r.ok && r.warnings.join(' ')).toMatch(/RISK is not R0..R3/)
  })
})

describe('parseLessons', () => {
  test('skips the L-000 format example and reads real lessons with evidence', () => {
    const text = TEMPLATE('memory/lessons.md') + '\n- L-1 (build) Run make accept first. Evidence: #5, #12. Added 2026-10-01. Enforcement: none.\n'
    const { lessons, notices } = parseLessons(text)
    expect(notices).toEqual([])
    expect(lessons).toEqual([{ id: 'L-1', stage: 'build', text: 'Run make accept first.', evidence: ['5', '12'], added: '2026-10-01', enforcement: 'none' }])
  })
  test('malformed lines and lessons without evidence become notices', () => {
    const { lessons, notices } = parseLessons('- L-2 (spec) something went wrong\n- L-3 (spec) Do it. Evidence: none. Added 2026-10-01. Enforcement: lint.\n')
    expect(lessons.map((l) => l.id)).toEqual(['L-3'])
    expect(notices.map((n) => n.message)).toEqual(['lesson line does not match the format', 'L-3 has no evidence ids (provenance or it does not exist)'])
  })
})

describe('parseObservationFile', () => {
  test('reads the name, outcome and sourced lines', () => {
    const { value, notices } = parseObservationFile(
      'memory/observations/2026-11-02-12-settle-up.md',
      '# 2026-11-02 #12 settle-up\noutcome: blocked\n\n- [high] (review) Missing check. Source: work/12-settle-up/review.md\n- [low] (process) Clean.\n- [urgent] (x) y\n',
    )
    expect(value).toMatchObject({ date: '2026-11-02', workId: '12', slug: 'settle-up', outcome: 'blocked' })
    expect(value.items).toEqual([
      { priority: 'high', stage: 'review', text: 'Missing check.', source: 'work/12-settle-up/review.md' },
      { priority: 'low', stage: 'process', text: 'Clean.', source: undefined },
    ])
    expect(notices.map((n) => n.message)).toEqual([expect.stringMatching(/no Source/), expect.stringMatching(/does not match/)])
  })
})

describe('parseReflection', () => {
  test('reads labelled changes and the results of earlier ones', () => {
    const r = parseReflection(
      'memory/reflections/2026-11-06.md',
      `# Reflection\n\n## Check\n- C-2026-10-16-1: no effect. Still 0.4.\n- C-2026-10-16-2: worked.\n\n### C-2026-11-06-1: Name tests\n- Pattern: missing tests\n- Change: a rule\n- Expected effect: every AC named\n- How we will know: zero misses\n  in ten items\n`,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.changes).toEqual([{ id: 'C-2026-11-06-1', title: 'Name tests', pattern: 'missing tests', change: 'a rule', expected: 'every AC named', howWeWillKnow: 'zero misses in ten items' }])
    expect(r.value.results).toEqual([
      { id: 'C-2026-10-16-1', result: 'no effect', note: 'Still 0.4.' },
      { id: 'C-2026-10-16-2', result: 'worked', note: '' },
    ])
  })
  test('free prose is not guessed at', () => {
    expect(parseReflection('memory/reflections/x.md', '# Notes\n\nWe changed some prompts and it seemed better.').ok).toBe(false)
  })
})

describe('small files', () => {
  test('policy.env', () => {
    expect(parsePolicy(TEMPLATE('factory/policy.env'))).toMatchObject({ ok: true, value: { autoMergeMax: 'none' } })
    expect(parsePolicy('AUTO_MERGE_MAX_TIER="R1"\n')).toMatchObject({ ok: true, value: { autoMergeMax: 'R1' } })
    expect(parsePolicy('AUTO_MERGE_MAX_TIER=all').ok).toBe(false)
    expect(parsePolicy('# nothing').ok).toBe(false)
    // every setting, RIGOR too, with the comment above it
    const p = parsePolicy('# Highest tier\nAUTO_MERGE_MAX_TIER=R1\n\n# How much ceremony\n#   mvp  lighter\nRIGOR=mvp\nNEW_KEY="x y"\nlower=ignored\n')
    expect(p.ok && p.value.settings).toEqual([
      { key: 'AUTO_MERGE_MAX_TIER', value: 'R1', comment: 'Highest tier' },
      { key: 'RIGOR', value: 'mvp', comment: 'How much ceremony\n  mvp  lighter' },
      { key: 'NEW_KEY', value: 'x y', comment: '' },
    ])
  })
  test('blockedSummary: a "Label: text" BLOCKED.md gives the decision line, not "What I did"', () => {
    const text = '# Blocked: #9 widget copy\n\nWhat I did: rewrote the label and checked the old copy still renders?\n\nWhat stopped me: the criterion and the contract disagree on the wording.\n(The contract was approved first.)\n\nSmallest decision for the human: keep the contract wording, or change the criterion to match the page?\n'
    expect(blockedSummary(text)).toBe('keep the contract wording, or change the criterion to match the page?')
    expect(blockedSummary('# Blocked\n\nWhat I did: x\nDecision needed:\n- pick A or B\n')).toBe('pick A or B')
  })

  test('blockedSummary prefers the question line', () => {
    expect(blockedSummary('# Blocked\n\nI was writing the spec.\n\n- Hard delete or soft delete?\n')).toBe('Hard delete or soft delete?')
    expect(blockedSummary('# Blocked\n\nNo question here')).toBe('No question here')
    expect(blockedSummary('# Blocked: #4 x')).toBe('Blocked: #4 x')
    expect(blockedSummary('')).toBe('(BLOCKED.md is empty)')
    // the decision the human must make beats a question in "What I did"
    expect(blockedSummary('# Blocked\n\n## What I did\nIs the old copy fine?\n\n## Decision needed\n- Record the wording approval in D07.\n')).toBe('Record the wording approval in D07.')
  })
  test('PR body "Not verified" section; "nothing known" means none', () => {
    expect(prNotVerified(TEMPLATE('factory/templates/pr-body.md'))).toEqual([])
    expect(prNotVerified('## Not verified\n- the migration on real data\n\n## Assumptions\n- x')).toEqual(['the migration on real data'])
    expect(prNotVerified('## Not verified\n- nothing known\n')).toEqual([])
  })
  test('bullets joins continuation lines and drops placeholders and none', () => {
    expect(bullets('- a\n  b\n- <placeholder>\n- none\n1. c')).toEqual(['a b', 'c'])
  })
})
