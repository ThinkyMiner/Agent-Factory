// Team mode: the roster, the planning cycle, features, team worktrees and Herdr sessions, over a real
// git repo with worktrees and fake herdr-app / hc, plus malformed and hostile inputs.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionRecords, parseAttribution, parseCycleState, parseDiscussion, parseRoster, phasesOf, waitingFor, type CycleState, type Message } from '../server/core/teams.ts'
import type { ItemView } from '../server/core/derive.ts'
import { herdrSessions } from '../server/sources/teams.ts'
import { Factory } from '../server/factory.ts'
import { PULLS, normalisePull } from '../server/sources/github.ts'
import type { GitHubData } from '../server/core/types.ts'
import { computeState, readDemoGitHub } from '../server/state.ts'
import { HOSTILE, PRIVATE, QUESTION, SEALED, makeTeamsFactory } from './teams-fixture.ts'

const root = mkdtempSync(join(tmpdir(), 'cr-teams-'))
const PATH = process.env.PATH
afterAll(() => {
  process.env.PATH = PATH
})

describe('parsers', () => {
  test('the roster: badly named teams are ignored with a warning; inactive teams and review flags kept', () => {
    const r = parseRoster(JSON.stringify({ teams: { backend: { owns: ['server/*', 7] }, web: { ui_review: true, active: false }, 'No!': {} }, limits: { round_minutes: '45' } }))
    expect(r.ok && r.value).toEqual({
      teams: [{ name: 'backend', owns: ['server/*'], active: true, review: undefined }, { name: 'web', owns: [], active: false, review: 'ui' }],
      roundMinutes: 45,
    })
    expect(r.ok && r.warnings[0]).toMatch(/"No!" ignored/)
  })
  test('a garbled or shapeless roster is an error with its raw text, not a crash', () => {
    expect(parseRoster('{"teams": {')).toMatchObject({ ok: false, error: 'not valid JSON', raw: '{"teams": {' })
    expect(parseRoster('{"teams": ["backend"]}')).toMatchObject({ ok: false, error: 'no "teams" object' })
    expect(parseRoster('null')).toMatchObject({ ok: false })
  })
  test('state.json: garbled or without a teams array is damaged (as round.sh says); odd fields are dropped', () => {
    expect(parseCycleState('{"status": "brief", ')).toMatchObject({ ok: false, error: 'state.json is not valid JSON' })
    expect(parseCycleState('{"status": "brief"}')).toMatchObject({ ok: false, error: expect.stringMatching(/teams/) })
    const r = parseCycleState('{"status":"decisions","teams":["a"],"pr":"12","draft":null,"strikes":"x","history":[{"status":"brief"}]}')
    expect(r.ok && r.value).toMatchObject({ status: 'decisions', teams: ['a'], pr: 12, draft: undefined, strikes: {}, history: [] })
  })
  test('discussion.jsonl: a bad line is a notice and the rest still show; a body is kept as the text it is', () => {
    const text = ['{"id":"m1","ts":"t","round":"discussion-1","from":"a","to":"all","kind":"proposal","body":' + JSON.stringify(HOSTILE) + '}', 'not json', '{"id":"m2"}', '', '[1,2]'].join('\n')
    const r = parseDiscussion(text, 'd.jsonl')
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]!.body).toBe(HOSTILE)
    expect(r.messages[0]!.refs).toEqual([])
    expect(r.notices.map((n) => n.message)).toEqual([expect.stringMatching(/^line 2: not valid JSON/), expect.stringMatching(/^line 3: /), expect.stringMatching(/^line 5: /)])
  })
  test('decision records: the status field only, not text in a section or the work breakdown', () => {
    const recs = decisionRecords('## c1-D01: One\n- status: decided\n### Decision\n- status: needs-human\n## c1-D02: Two\n- owner: a\n- status: needs-human\n## Work breakdown\n| x |\n')
    // each record also keeps its text, to expand in Planning
    expect(recs).toEqual([{ id: 'c1-D01', title: 'One', status: 'decided', text: '- status: decided\n### Decision\n- status: needs-human' }, { id: 'c1-D02', title: 'Two', status: 'needs-human', text: '- owner: a\n- status: needs-human' }])
  })
  test('attribution.md: one row per failing test with its six fields; anything else is skipped', () => {
    const a = parseAttribution(['# Attribution: f001-x', 'round: 2', '- test: tests/e2e/f001-x/ac8.spec.ts | criterion: AC8 | decision: c001-D06 | contract: contracts/api.md | team: backend | evidence: 500 on an empty week',
      '- test: a | criterion: AC9 | decision: c001-D06', 'free text <script>', '- test: b | criterion: AC9 | decision: c001-D06 | contract: none | team: frontend | evidence: a | b'].join('\n'))
    expect(a).toEqual({ round: 2, rows: [{ test: 'tests/e2e/f001-x/ac8.spec.ts', criterion: 'AC8', decision: 'c001-D06', contract: 'contracts/api.md', team: 'backend', evidence: '500 on an empty week' }] })
  })
  test('the phase: an item held at your approval makes the next step yours', () => {
    const row = (number: number, state: ItemView['state'] | undefined, more: object = {}) => ({ number, title: `t${number}`, url: '', team: 'frontend', ticket: false, open: true, ...(state && { item: { state, pr: number + 4 } }), ...more })
    const f = { name: 'f001-first-card', refs: {}, docs: [], pulls: [], items: [row(7, 'merged'), row(8, 'awaiting-approval'), row(9, 'ready', { waitsFor: '#8 fit-layout (awaiting-approval)' })] }
    expect(phasesOf(undefined, [f], [])).toEqual([{ step: 'building', label: 'Building f001-first-card: 1 of 3 dispatched items merged into its feature branch', detail: '1 in progress. No integration branch yet: the orchestrator saves the e2e tests on integrate/f001-first-card.', next: { who: 'you', what: '#8 (PR #12): add human-approved, wait for the checks to pass, then merge', href: '/items/8' } }])
  })
  test('the phase while building: dispatched items, follow-up tickets, and the e2e tests on the integration branch', () => {
    const row = (number: number, state: ItemView['state'] | undefined, more: object = {}) => ({ number, title: `t${number}`, url: '', team: 'frontend', ticket: false, open: true, ...(state && { item: { state, pr: number + 4 } }), ...more })
    const items = [row(7, 'merged'), row(8, 'in-progress'), row(9, 'ready'), row(15, 'merged', { ticket: true, ticketState: 'done' })]
    const [p] = phasesOf(undefined, [{ name: 'f001-first-card', refs: { integrate: 'origin/integrate/f001-first-card' }, e2eTests: 3, docs: [], pulls: [], items }], [])
    expect(p!.label).toBe('Building f001-first-card: 1 of 3 dispatched items merged into its feature branch, +1 follow-up ticket (1 merged)')
    expect(p!.detail).toBe('1 in progress. 3 e2e test files saved on origin/integrate/f001-first-card; no integration round yet.')
    const [q] = phasesOf(undefined, [{ name: 'f001-first-card', refs: {}, docs: [], pulls: [], items: items.slice(0, 3) }], [])
    expect(q!.detail).toBe('1 in progress. No integration branch yet: the orchestrator saves the e2e tests on integrate/f001-first-card.')
  })
  test('who a round waits for, by its own rule', () => {
    const s = (status: string, draft = 0): CycleState => ({ status, teams: ['a', 'b'], draft, strikes: {}, unanswered: [], history: [] }) as CycleState
    const msg = (o: Partial<Message>): Message => ({ id: 'x', ts: '', round: 'discussion-1', from: 'o', to: 'all', kind: 'question', refs: [], body: '', ...o })
    expect(waitingFor(s('positions'), [], ['a'])).toEqual([{ team: 'b', owes: 'a position' }])
    const qs = [msg({ id: 'q1', from: 'a', to: 'all' }), msg({ id: 'q2', to: 'b' }), msg({ id: 'q3', to: 'human' }), msg({ kind: 'answer', from: 'b', refs: ['q1'] }), msg({ id: 'q4', round: 'discussion-2', to: 'a' })]
    expect(waitingFor(s('discussion-1'), qs, [])).toEqual([{ team: 'b', owes: 'an answer to q2' }])
    expect(waitingFor(s('decisions'), [], [])).toEqual([{ team: 'orchestrator', owes: 'the first draft of DECISIONS.md' }])
    const said = [msg({ round: 'decisions', kind: 'accept', from: 'a', draft: 2 }), msg({ round: 'decisions', kind: 'objection', from: 'b', draft: 1 })]
    expect(waitingFor(s('decisions', 2), said, [])).toEqual([{ team: 'b', owes: 'accept or objection on draft 2' }])
    expect(waitingFor(s('dispatched'), qs, [])).toEqual([])
  })
})

test('a pull request keeps the branch it merges into (GitHub\'s baseRefName); without it, none', () => {
  const n = { number: 1, title: 't', state: 'OPEN', headRefName: 'work/1-x', createdAt: '2026-11-01T00:00:00Z', url: 'u' }
  expect(normalisePull({ ...n, baseRefName: 'feature/f001-x' }).baseRefName).toBe('feature/f001-x')
  expect(normalisePull(n).baseRefName).toBeUndefined()
  expect(PULLS).toContain('baseRefName')
})

describe('a team-mode factory', () => {
  let fx: ReturnType<typeof makeTeamsFactory>
  let s: Awaited<ReturnType<typeof computeState>>
  beforeAll(async () => {
    fx = makeTeamsFactory(join(root, 'one'))
    process.env.PATH = `${fx.bin}:${PATH}`
    s = await computeState(fx.repo, await readDemoGitHub(fx.github), { staleMinutes: 30 })
  })

  test('a work item stopped in a team worktree needs you, with its uncommitted BLOCKED.md', () => {
    const i = s.byId.get('19')!
    expect(i.state).toBe('blocked')
    expect(i.blocked).toMatchObject({ summary: QUESTION, path: 'work/19-acceptance/BLOCKED.md', stale: false })
    expect(s.needsYou.find((n) => n.id === '19')).toMatchObject({ kind: 'answer', summary: QUESTION })
    // research's own stage names count as the pipeline stage they stand for, keeping their name
    expect(i.stage).toBe('review')
    expect(i.stages.find((x) => x.stage === 'review')!.attempts[0]!.detail).toBe('evidence-review: reviews disagree; see BLOCKED.md')
  })

  test('the active cycle from the working tree: round, who has not answered, records, PR, transcript, events', () => {
    const c = s.teams!.cycle!
    expect(c).toMatchObject({ name: 'c002-share-links', active: true, source: 'working tree', pr: { number: 12, state: 'OPEN', isDraft: true } })
    expect(c.state!.status).toBe('decisions')
    expect(c.waiting).toEqual([{ team: 'backend', owes: 'accept or objection on draft 1' }])
    expect(c.records.map((r) => [r.id, r.status])).toEqual([['c002-D01', 'decided'], ['c002-D02', 'needs-human']])
    expect(c.messages.map((m) => m.id)).toEqual(['c002-m001', 'c002-m002', 'c002-m003', 'c002-m006', 'c002-m007'])
    expect(c.messages[2]!.body).toBe(HOSTILE)
    expect(c.events.map((e) => e.text)).toEqual(['round: opened', 'approved: brief', 'position submitted', 'round: decisions'])
    expect(s.snap.notices.filter((n) => n.source.endsWith('discussion.jsonl')).map((n) => n.message)).toEqual([expect.stringMatching(/^line 4: not valid JSON/), expect.stringMatching(/^line 5: ts:/)])
  })

  test('planning events are not notices; an escalation is, in its own words', () => {
    expect(s.snap.notices.filter((n) => /unknown event type/.test(n.message))).toEqual([])
    expect(s.snap.notices.filter((n) => /escalation/.test(n.message)).map((n) => n.message)).toEqual(['line 12: escalation (slot): research has held a build slot for 3 hours'])
  })

  test('what needs you in team mode: the needs-human record, a failed session, a session at a prompt', () => {
    const team = s.needsYou.filter((n) => n.id !== '19').map((n) => [n.kind, n.id, n.summary])
    expect(team).toEqual([
      ['answer', 'decision-c002-D02', 'needs-human record in planning/c002-share-links/DECISIONS.md: decide it'],
      ['approve', 'pr-25', 'integrate/f001-reading-list · add human-approved, wait for the checks to pass, then merge · R2'], // the feature's PR to main
      ['failed', 'session-frontend', 'API rate limit: retrying in 20 minutes'],
      ['waiting-input', 'session-research', 'Do you trust the files in this folder?'],
    ])
  })

  test('the feature: its branches, its issues and where each is, and its records', () => {
    const [f] = s.teams!.features
    expect(f).toMatchObject({ name: 'f001-reading-list', refs: { feature: 'feature/f001-reading-list', integrate: 'integrate/f001-reading-list' } })
    // dispatched and not started is Ready, like an accepted ticket; a declined ticket is not work. A ticket's team is where it went.
    expect(f!.items.map((i) => [i.number, i.team, i.ticket, i.ticketState, i.open, i.item?.state])).toEqual([
      [19, 'research', false, undefined, true, 'blocked'],
      [20, 'backend', false, undefined, false, 'merged'],
      [21, 'frontend', false, undefined, true, 'ready'],
      [23, 'backend', true, 'accepted', true, 'ready'], // its label lags: ticket.sh's event says accepted
      [24, 'frontend', false, undefined, true, 'ready'],
      [26, 'frontend', true, 'declined', true, undefined],
    ])
    // what each dispatched item waits for, from the work breakdown's "after" column
    expect(f!.items.map((i) => [i.number, i.dispatch?.item, i.waitsFor])).toEqual([
      [19, 'acceptance', undefined],
      [20, 'list-api', undefined],
      [21, 'list-page', 'frontend to start it: the sweep types the command when that session is free, lowest number first'], // list-api merged
      [23, undefined, undefined],
      [24, 'share-copy', '#21 list-page (ready)'],
      [26, undefined, undefined],
    ])
    expect(s.byId.get('24')).toMatchObject({ state: 'ready', column: 'ready', feature: 'f001-reading-list', reason: 'dispatched to frontend in feature f001-reading-list', waitsFor: '#21 list-page (ready)' })
    expect(s.byId.get('23')).toMatchObject({ state: 'ready', reason: 'ticket accepted by backend (feature f001-reading-list)' })
    expect(s.byId.has('26')).toBe(false)
    expect(f!.docs.map((d) => [d.file, d.ref, d.headline])).toEqual([
      ['acceptance.md', 'feature/f001-reading-list', '2 criteria'],
      ['e2e-report.md', 'integrate/f001-reading-list', 'E2E: fail, round: 1'],
      ['attribution.md', 'integrate/f001-reading-list', '1 failing test attributed, round 1 (frontend)'], // beside the e2e report it explains
      ['acceptance-review.md', 'feature/f001-reading-list', 'VERDICT: reject'],
    ])
    expect(f!.attribution).toMatchObject({ ref: 'integrate/f001-reading-list', round: 1, rows: [{ criterion: 'AC2', decision: 'c001-D01', team: 'frontend', evidence: HOSTILE }] })
    // each row links the ticket integrate.sh filed for it, and its criterion in acceptance.md
    expect(f!.attribution!.rows[0]).toMatchObject({ ticket: { number: 26, url: 'https://github.invalid/harbor/issues/26', state: 'declined' }, criterionUrl: 'https://github.com/example/harbor/blob/feature/f001-reading-list/features/f001-reading-list/acceptance.md#ac2-sharing' })
    expect(f!.attribution!.rows[0]!.contractUrl).toBeUndefined() // contract: none
    expect(f!.pulls.map((p) => p.number)).toEqual([25])
  })

  test('teams: roster, checkout, the item held, the session; a worktree whose folder is gone', () => {
    const rows = Object.fromEntries(s.teams!.teams.map((t) => [t.name, t]))
    expect(Object.keys(rows)).toEqual(['orchestrator', 'backend', 'frontend', 'research', 'design', 'sweep']) // the tab "odd" is not a team
    expect(rows.orchestrator!.checkout).toMatchObject({ branch: 'planning/c002-share-links', exists: true })
    expect(rows.research).toMatchObject({ review: 'evidence', checkout: { branch: 'work/19-acceptance' }, item: { id: '19', state: 'blocked' }, session: { state: 'blocked' } })
    expect(rows.design).toMatchObject({ active: false, checkout: { exists: false } })
    expect(rows.sweep).toMatchObject({ inRoster: false, session: { state: 'unknown' } })
    expect(rows.odd).toBeUndefined() // and its terminal id, which is not one, is never passed to hc (privacy test)
    expect(s.snap.notices.some((n) => /design worktree .* no longer exists/.test(n.message))).toBe(true)
  })

  test('privacy: only the factory’s Herdr space is read; no sealed position, screen or other space appears anywhere', () => {
    const out = JSON.stringify([s.teams, s.needsYou, s.snap.notices])
    for (const p of [...PRIVATE, SEALED, 'SCREEN CONTENTS']) expect(out).not.toContain(p)
    const asked = readFileSync(fx.hcLog, 'utf8').trim().split('\n')
    expect([...new Set(asked)].sort()).toEqual(['get t1 --json', 'get t2 --json', 'get t3 --json', 'get t4 --json', 'get t5 --json'])
    expect(existsSync(join(fx.repo, 'pwned'))).toBe(false)
  })

  test('nothing in the factory was written', () => {
    expect(fx.git('status', '--porcelain', '--untracked-files=all')).toBe('?? .factory/events.jsonl\n?? .factory/planning/active\n?? .factory/planning/c002-share-links/sealed/backend.md\n')
  })
})

describe('missing and damaged inputs', () => {
  test('without herdr-app or hc: sessions unavailable, nothing else', async () => {
    const empty = join(root, 'no-bin')
    mkdirSync(empty, { recursive: true })
    process.env.PATH = empty
    try {
      expect(await herdrSessions('harbor')).toEqual({ available: false, tabs: [] })
      writeFileSync(join(empty, 'herdr-app'), '#!/bin/sh\necho "{\\"spaces\\":[{\\"name\\":\\"harbor\\",\\"tabs\\":[{\\"name\\":\\"backend\\",\\"terminals\\":[{\\"terminal\\":\\"t1\\"}]}]}]}"\n', { mode: 0o755 })
      expect(await herdrSessions('harbor')).toEqual({ available: false, tabs: [] }) // hc missing
      writeFileSync(join(empty, 'herdr-app'), '#!/bin/sh\necho "not json"\n', { mode: 0o755 })
      expect(await herdrSessions('harbor')).toEqual({ available: false, tabs: [] })
    } finally {
      process.env.PATH = PATH
    }
  })

  test('a garbled state.json in the working tree: the branch copy is used; garbled everywhere is an error, not a crash', async () => {
    const fx = makeTeamsFactory(join(root, 'two'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    writeFileSync(join(fx.repo, 'planning/c002-share-links/state.json'), '{"status": "decisions", "teams": [')
    let s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.cycle).toMatchObject({ source: 'planning/c002-share-links', state: { status: 'decisions' } })
    fx.git('commit', '-qam', 'garble')
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.cycle).toMatchObject({ name: 'c002-share-links', error: 'state.json is not valid JSON', state: undefined, waiting: [] })
    expect(s.teams!.cycle!.messages).toHaveLength(5)
    expect(s.needsYou.some((n) => n.id === 'decision-c002-D02')).toBe(true)
  })

  test('no active cycle: the newest copy (dispatched, on the feature branch), then main once the branches are gone', async () => {
    const fx = makeTeamsFactory(join(root, 'three'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    rmSync(join(fx.repo, '.factory/planning/active'))
    fx.git('switch', '-q', 'main')
    fx.git('branch', '-q', '-D', 'planning/c002-share-links')
    let s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.cycle).toMatchObject({ name: 'c001-reading-list', active: false, source: 'feature/f001-reading-list', state: { status: 'dispatched', feature: 'f001-reading-list' } })
    fx.git('branch', '-q', '-D', 'feature/f001-reading-list', 'integrate/f001-reading-list')
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.cycle).toMatchObject({ source: 'working tree', state: { status: 'approval' }, waiting: [{ team: 'orchestrator', owes: '/dispatch' }] })
    expect(s.needsYou.filter((n) => n.id.startsWith('cycle-'))).toEqual([]) // merged: nothing to approve
  })

  test('approved and merged, the cycle still waits on an open PR that fixes its files: Planning and Needs you both say so', async () => {
    const fx = makeTeamsFactory(join(root, 'blocking'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    rmSync(join(fx.repo, '.factory/planning/active'))
    fx.git('switch', '-q', 'main')
    fx.git('branch', '-q', '-D', 'planning/c002-share-links', 'feature/f001-reading-list', 'integrate/f001-reading-list')
    const base = gh.data!.pulls.find((p) => p.number === 25)!
    gh.data!.pulls.push(
      { ...base, number: 9, title: 'Planning c001-reading-list', headRefName: 'planning/c001-reading-list', state: 'MERGED', labels: ['human-approved'] },
      { ...base, number: 40, title: 'Fix the work breakdown path', headRefName: 'planning/c001-reading-list', labels: ['human-approved', 'risk:R2'], url: 'https://github.invalid/harbor/pull/40',
        files: [{ path: 'planning/c001-reading-list/DECISIONS.md', additions: 1, deletions: 1 }], checks: [{ name: 'risk-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] }, // a second PR from the cycle's branch
      { ...base, number: 41, title: 'Unrelated', headRefName: 'fix/other', labels: ['risk:R2'], files: [{ path: 'planning/c001-reading-list-old/x.md', additions: 1, deletions: 0 }] },
    )
    let s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const c = s.teams!.cycle!
    expect(c).toMatchObject({ name: 'c001-reading-list', state: { status: 'approval' }, pr: { number: 9, state: 'MERGED' } })
    expect(c.blocking.map((b) => [b.number, b.why])).toEqual([[40, 'PR #40 must merge, then /dispatch']])
    expect(c.waiting).toEqual([{ team: 'you', owes: 'PR #40: merge it, then /dispatch' }]) // not "orchestrator owes /dispatch"
    expect(s.needsYou.find((n) => n.id === 'pr-40')).toMatchObject({ kind: 'merge', summary: 'planning/c001-reading-list · approved: merge it · R2 · planning c001-reading-list waits: PR #40 must merge, then /dispatch' })
    // with auto-merge on, it merges itself once CI is green: still shown, as information
    gh.data!.pulls.find((p) => p.number === 40)!.autoMerge = true
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.needsYou.find((n) => n.id === 'pr-40')).toMatchObject({ kind: 'info', summary: expect.stringMatching(/^planning\/c001-reading-list · approved: merging when CI is green · R2 · /) })
    expect(s.teams!.cycle!.waiting).toEqual([{ team: 'auto-merge', owes: 'PR #40: merging when CI is green, then /dispatch' }]) // Planning says who merges as Needs you does
    // not yet approved: the one next action, the same in both places
    gh.data!.pulls.find((p) => p.number === 40)!.labels = ['risk:R2']
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.needsYou.find((n) => n.id === 'pr-40')).toMatchObject({ kind: 'approve', summary: expect.stringMatching(/^planning\/c001-reading-list · add human-approved; auto-merge then merges it once the checks pass · R2/) })
    expect(s.teams!.cycle!.waiting).toEqual([{ team: 'you', owes: 'PR #40: add human-approved; auto-merge then merges it once the checks pass, then /dispatch' }])
    gh.data!.pulls.find((p) => p.number === 40)!.autoMerge = false
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.cycle!.waiting).toEqual([{ team: 'you', owes: 'PR #40: add human-approved, wait for the checks to pass, then merge, then /dispatch' }])
    // merged: the orchestrator's turn again
    gh.data!.pulls.find((p) => p.number === 40)!.state = 'MERGED'
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.cycle!.waiting).toEqual([{ team: 'orchestrator', owes: '/dispatch' }])
    expect(s.needsYou.find((n) => n.id === 'pr-40')).toBeUndefined()
  })

  test('an item tried twice: branch, PR, spec, files and block all come from the newest attempt', async () => {
    const fx = makeTeamsFactory(join(root, 'attempts'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    const put = (rel: string, text: string) => {
      mkdirSync(join(fx.repo, rel, '..'), { recursive: true })
      writeFileSync(join(fx.repo, rel), text)
    }
    const spec = (title: string) => `---\nid: 21\ntitle: ${title}\nrisk_floor: R1\ntests: none\nstatus: draft\n---\n## Problem\np\n## Acceptance criteria\n- AC-1: the page lists links\n`
    fx.git('switch', '-q', '-c', 'work/21-list-page', 'feature/f001-reading-list')
    put('work/21-list-page/spec.md', spec('Reading list page, first try'))
    put('work/21-list-page/BLOCKED.md', '# Blocked\n\n## What I did\nBuilt the page; is the old copy fine?\n\n## Decision needed\nRecord the wording approval in c001-D01.\n')
    fx.git('add', '-A')
    fx.git('commit', '-qm', 'work 21: first attempt')
    fx.git('switch', '-q', '-c', 'work/21-list-page-2', 'feature/f001-reading-list')
    put('work/21-list-page-2/spec.md', spec('Reading list page'))
    put('web/page.ts', 'export const page = 1\n')
    fx.git('add', '-A')
    fx.git('commit', '-qm', 'work 21: second attempt')
    fx.git('switch', '-q', 'planning/c002-share-links')
    const base = gh.data!.pulls.find((p) => p.number === 22)!
    gh.data!.pulls.push(
      { ...base, number: 24, title: 'Reading list page', headRefName: 'work/21-list-page', state: 'MERGED', createdAt: new Date(Date.now() - 7_200_000).toISOString() },
      { ...base, number: 31, title: 'Reading list page', headRefName: 'work/21-list-page-2', state: 'OPEN', mergedAt: undefined, autoMerge: true, url: 'https://github.invalid/harbor/pull/31',
        files: [{ path: 'work/21-list-page-2/spec.md', additions: 9, deletions: 0 }, { path: 'web/page.ts', additions: 1, deletions: 0 }] },
    )
    // both attempts opened a PR: the stage history is the selected attempt's only
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
    const ev = (h: number, branch: string, stage: string, status: string, pr: number) => JSON.stringify({ ts: ago(h), type: 'stage', work_id: '21', branch, stage, status, round: '0', tier: 'R1', pr: String(pr), detail: `opened PR #${pr}`, team: 'research' })
    const evs = join(fx.repo, '.factory/events.jsonl')
    mkdirSync(join(fx.repo, '.factory'), { recursive: true })
    writeFileSync(evs, (existsSync(evs) ? readFileSync(evs, 'utf8') : '') + [ev(2, 'work/21-list-page', 'review', 'failed', 24), ev(1.9, 'work/21-list-page', 'pr', 'passed', 24), ev(0.5, 'work/21-list-page-2', 'pr', 'passed', 31)].join('\n') + '\n')
    const s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const i = s.byId.get('21')!
    expect(i).toMatchObject({ branch: 'work/21-list-page-2', pr: { number: 31, state: 'OPEN' }, title: 'Reading list page', state: 'pr-open', blocked: undefined })
    expect(i.files['spec.md']!.path).toBe('work/21-list-page-2/spec.md')
    expect(i.stages.find((x) => x.stage === 'pr')!.attempts.map((a) => a.detail)).toEqual(['opened PR #31'])
    expect(i.fixRounds).toBe(0) // the first attempt's failed review is not this attempt's
    expect(s.needsYou.find((n) => n.id === '21')).toBeUndefined() // the first attempt's question is not this attempt's
  })

  test('acceptance tests under tests/acceptance/<team>/ are found; evidence, db and ui reviews are reviews', async () => {
    const fx = makeTeamsFactory(join(root, 'tests-reviews'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    const put = (rel: string, text: string) => {
      mkdirSync(join(fx.repo, rel, '..'), { recursive: true })
      writeFileSync(join(fx.repo, rel), text)
    }
    const review = (verdict: string, nv: string) => `VERDICT: ${verdict}\nRISK: R1\nBLOCKING:\n- none\nNON-BLOCKING:\n- none\nVERIFIED: make check\nNOT VERIFIED:\n- ${nv}\n`
    fx.git('switch', '-q', '-c', 'work/20-list-api', 'feature/f001-reading-list')
    put('work/20-list-api/spec.md', '---\nid: 20\ntitle: Reading list API\nrisk_floor: R1\ntests: required\nstatus: draft\n---\n## Problem\np\n## Acceptance criteria\n- AC-1: GET lists saved links\n- AC-2: an empty list is []\n')
    put('work/20-list-api/evidence-review.md', review('pass', 'load under many users'))
    put('work/20-list-api/db-review.md', review('pass', 'the migration on a full table'))
    put('tests/acceptance/backend/20-list-api.test.js', "test('AC-1: GET lists saved links', () => {})\n")
    put('tests/acceptance/backend/harness.mjs', '// AC-9 is not a test of any item\n')
    fx.git('add', '-A')
    fx.git('commit', '-qm', 'work 20')
    fx.git('switch', '-q', 'planning/c002-share-links')
    put('tests/acceptance/backend/20-empty.test.js', "test('AC_2 empty list', () => {})\n") // the working tree, not committed
    const s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const i = s.byId.get('20')!
    expect(i.testRefs.map((r) => [r.ac, r.file]).sort()).toEqual([['AC-1', 'tests/acceptance/backend/20-list-api.test.js'], ['AC-2', 'tests/acceptance/backend/20-empty.test.js']])
    expect(i.reviews.map((r) => [r.file, r.review.ok && r.review.value.verdict])).toEqual([['evidence-review.md', 'pass'], ['db-review.md', 'pass']])
    expect(i.review).toMatchObject({ ok: true, value: { verdict: 'pass' } })
    expect(i.notVerified.map((n) => [n.text, n.source])).toEqual([['load under many users', 'evidence-review.md'], ['the migration on a full table', 'db-review.md']]) // and not "no review.md"
  })

  test('a change is measured against its PR\'s base or its feature branch, not main', async () => {
    const fx = makeTeamsFactory(join(root, 'base'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = JSON.parse(readFileSync(fx.github, 'utf8')) as GitHubData
    fx.git('branch', 'work/33-instant-format', 'feature/f001-reading-list') // a ticket's branch at its feature's tip: nothing of its own yet
    fx.git('switch', '-q', '-c', 'work/34-page-copy', 'feature/f001-reading-list')
    mkdirSync(join(fx.repo, 'web'), { recursive: true })
    writeFileSync(join(fx.repo, 'web/copy.ts'), 'export const copy = "Saved"\n')
    fx.git('add', 'web/copy.ts')
    fx.git('commit', '-qm', 'work 34: copy')
    fx.git('switch', '-q', 'planning/c002-share-links')
    gh.issues.push({ ...gh.issues[0]!, number: 33, title: 'Times in the instant format', labels: ['feature:f001-reading-list', 'team:frontend', 'ticket'] })
    const base = gh.pulls.find((p) => p.number === 22)!
    gh.pulls.push({ ...base, number: 36, title: 'Page copy', headRefName: 'work/34-page-copy', baseRefName: 'feature/f001-reading-list', state: 'OPEN', mergedAt: undefined, files: [] }) // GitHub gave no file list
    writeFileSync(fx.github, JSON.stringify(gh))
    const f = new Factory({ repo: fx.repo, dataDir: join(fx.root, 'data'), staleMinutes: 30, github: { kind: 'demo', path: fx.github }, transcriptsRoot: join(fx.root, 'none') })
    await f.start()
    try {
      const t33 = f.state.byId.get('33')!
      expect(t33).toMatchObject({ branch: 'work/33-instant-format', riskFiles: [] })
      expect((await f.itemDetail('33'))!.commits).toEqual([])
      const t34 = f.state.byId.get('34')!
      expect(t34.riskFiles.map((x) => x.path)).toEqual(['web/copy.ts'])
      const d = (await f.itemDetail('34'))!
      expect(d.commits.map((c) => c.subject)).toEqual(['work 34: copy'])
      expect(d.changes).toEqual([expect.objectContaining({ path: 'web/copy.ts', additions: 1, deletions: 0 })])
      expect(await f.diff('34', 'web/copy.ts')).toContain('+export const copy = "Saved"')
    } finally {
      f.stop()
    }
  })

  test('a merged PR bounds the item\'s commits, files and diff by its head: later commits on the branch are not its', async () => {
    const fx = makeTeamsFactory(join(root, 'bounded'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = JSON.parse(readFileSync(fx.github, 'utf8')) as GitHubData
    const put = (rel: string, text: string) => {
      mkdirSync(join(fx.repo, rel, '..'), { recursive: true })
      writeFileSync(join(fx.repo, rel), text)
      fx.git('add', rel)
    }
    fx.git('switch', '-q', '-c', 'work/35-share-copy', 'feature/f001-reading-list')
    put('web/share.ts', 'export const share = 1\n')
    fx.git('commit', '-qm', 'work 35: copy button')
    const head = fx.git('rev-parse', 'HEAD').trim()
    fx.git('switch', '-q', 'feature/f001-reading-list')
    fx.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #37', 'work/35-share-copy') // GitHub's merge commit
    fx.git('switch', '-q', 'work/35-share-copy')
    put('web/late.ts', 'export const late = 1\n')
    fx.git('commit', '-qm', 'work 35: after the merge')
    fx.git('switch', '-q', 'planning/c002-share-links')
    gh.issues.push({ ...gh.issues[0]!, number: 35, title: 'Copy button', labels: ['feature:f001-reading-list', 'team:frontend'] })
    const base = gh.pulls.find((p) => p.number === 22)!
    gh.pulls.push({ ...base, number: 37, title: 'Copy button', headRefName: 'work/35-share-copy', headSha: head, baseRefName: 'feature/f001-reading-list', state: 'MERGED', files: [] }) // no file list from GitHub
    writeFileSync(fx.github, JSON.stringify(gh))
    const f = new Factory({ repo: fx.repo, dataDir: join(fx.root, 'data'), staleMinutes: 30, github: { kind: 'demo', path: fx.github }, transcriptsRoot: join(fx.root, 'none') })
    await f.start()
    try {
      expect(f.state.byId.get('35')!.riskFiles.map((x) => x.path)).toEqual(['web/share.ts'])
      const d = (await f.itemDetail('35'))!
      expect(d.commits.map((c) => c.subject)).toEqual(['work 35: copy button'])
      expect(await f.diff('35', 'web/share.ts')).toContain('+export const share = 1')
    } finally {
      f.stop()
    }
  })

  test('a dispatched cycle: each decision keeps its text and names the issues that build it', async () => {
    const fx = makeTeamsFactory(join(root, 'records'))
    process.env.PATH = `${fx.bin}:${PATH}`
    rmSync(join(fx.repo, '.factory/planning/active'))
    fx.git('switch', '-q', 'main')
    fx.git('branch', '-q', '-D', 'planning/c002-share-links')
    const s = await computeState(fx.repo, await readDemoGitHub(fx.github), { staleMinutes: 30 })
    expect(s.teams!.cycle!.records).toEqual([{ id: 'c001-D01', title: 'The list API', status: 'decided', text: '- owner: backend\n- affects: frontend\n- status: decided\n\n### Decision\nGET /api/list.', implementedBy: [19, 20, 21] }]) // #24's row names no decision
  })

  test('where things are: the feature\'s phase and the planning round, each with its next step and owner', async () => {
    const fx = makeTeamsFactory(join(root, 'phases'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    const brief = (st: Awaited<ReturnType<typeof computeState>>) => st.teams!.phases.map((p) => [p.step, p.label, p.next?.who, p.next?.what])
    let s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const planning = ['planning', 'Planning c002-share-links: decisions: the orchestrator drafts DECISIONS.md and each team accepts or objects', 'backend', 'accept or objection on draft 1']
    expect(brief(s)).toEqual([['pr-to-main', 'Pull request to main: #25', 'you', 'read PR #25, then add human-approved, wait for the checks to pass, then merge'], planning])
    gh.data!.pulls = gh.data!.pulls.filter((p) => p.number !== 25) // before the PR to main: the failed round and its open ticket
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(brief(s)).toEqual([['integration', 'Integration round 1 failed', 'backend', 'fix #23, then the next round runs'], planning]) // #26 was declined
    expect(s.teams!.phases[0]!.detail).toMatch(/^The e2e tests failed on (origin\/)?integrate\/f001-reading-list; 1 ticket open/)
    gh.data!.issues = gh.data!.issues.filter((i) => i.number !== 23) // no ticket open, no round yet counted: still building
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(brief(s)[0]).toEqual(['building', 'Building f001-reading-list: 1 of 4 dispatched items merged into its feature branch', 'you', 'answer #19 (it stopped with a question)'])
    expect(s.teams!.phases[0]!.detail).toMatch(/no e2e tests on (origin\/)?integrate\/f001-reading-list yet; last integration round 1: fail\.$/)
    fx.git('switch', '-q', 'integrate/f001-reading-list')
    mkdirSync(join(fx.repo, 'tests/e2e/f001-reading-list'), { recursive: true })
    writeFileSync(join(fx.repo, 'tests/e2e/f001-reading-list/ac2.spec.ts'), "test('AC2', () => {})\n")
    fx.git('add', 'tests/e2e/f001-reading-list/ac2.spec.ts')
    fx.git('commit', '-qm', 'e2e tests for f001-reading-list')
    fx.git('switch', '-q', 'planning/c002-share-links')
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.teams!.phases[0]!.detail).toMatch(/1 e2e test file saved on (origin\/)?integrate\/f001-reading-list; last integration round 1: fail\.$/)
    gh.data!.pulls.push({ ...gh.data!.pulls.find((p) => p.number === 22)!, number: 25, headRefName: 'integrate/f001-reading-list', state: 'MERGED' })
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(brief(s)).toEqual([planning]) // on main: what is under way is the next cycle
  })

  test('the brief and the approval rounds need you while their pull request is open', async () => {
    const fx = makeTeamsFactory(join(root, 'four'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    const st = join(fx.repo, 'planning/c002-share-links/state.json')
    const at = new Date().toISOString()
    // round.sh saves the state and commits it with every move
    const save = (o: object) => {
      writeFileSync(st, JSON.stringify(o))
      fx.git('commit', '-qam', 'move')
    }
    save({ status: 'brief', teams: [], pr: 12, history: [{ status: 'brief', at }] })
    gh.data!.pulls[0]!.labels = []
    let s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.needsYou.find((n) => n.id === 'cycle-c002-share-links')).toMatchObject({ kind: 'approve', summary: 'read BRIEF.md, then add the label brief-approved to PR #12', href: '/planning' })
    expect(s.teams!.cycle!.waiting).toEqual([{ team: 'you', owes: 'the label brief-approved on PR #12' }])
    save({ status: 'approval', teams: ['backend'], pr: 12, history: [{ status: 'approval', at }] })
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.needsYou.find((n) => n.id === 'cycle-c002-share-links')).toMatchObject({ kind: 'approve', tier: 'R2' })
    gh.data!.pulls[0]!.state = 'MERGED'
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.needsYou.find((n) => n.id === 'cycle-c002-share-links')).toBeUndefined()
  })

  test('the sweep: its open findings are notices and needs; cleared ones are history; an unreadable sweep.json shows them all', async () => {
    const fx = makeTeamsFactory(join(root, 'five'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
    const esc = (h: number, reason: string, refs: string, detail: string) => JSON.stringify({ ts: ago(h), type: 'escalation', work_id: '', branch: 'main', reason, refs, detail })
    const evs = join(fx.repo, '.factory/events.jsonl')
    writeFileSync(evs, readFileSync(evs, 'utf8') + [
      esc(20, 'round', 'c002-share-links', 'planning c002-share-links has been in its discussion-1 round for 61 minutes: run /plan to close it'),
      esc(3, 'down', 'frontend', 'the frontend session has ended (its Herdr tab t3 shows a shell): run factory team-up to start it again'), // cleared since
      esc(1, 'down', 'backend', 'the backend session has ended (its Herdr tab t2 shows a shell): run factory team-up to start it again'),
      esc(1, 'blocked', 'research', 'the research session has waited on a dialog for 12 minutes (Herdr tab research)'),
      JSON.stringify({ ts: ago(0.5), type: 'autostart', work_id: '', branch: 'main', detail: '/dispatch c002-share-links' }),
    ].join('\n') + '\n')
    const sweep = (text: string) => writeFileSync(join(fx.repo, '.factory/sweep.json'), text)
    const escNotices = (st: Awaited<ReturnType<typeof computeState>>) => st.snap.notices.filter((n) => /escalation \(/.test(n.message)).map((n) => n.message)
    const t0 = Math.floor(Date.now() / 1000) - 3600
    sweep(JSON.stringify({ seen: { 'down:backend:t2': t0, 'blocked:research:123': t0, 'budget:frontend:2026-11-21': t0 }, blocked: {}, working: {}, ring: false }))
    let st = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(escNotices(st)).toEqual([
      'escalation (down): the backend session has ended (its Herdr tab t2 shows a shell): run factory team-up to start it again',
      'escalation (blocked): the research session has waited on a dialog for 12 minutes (Herdr tab research)',
      'escalation (budget): budget:frontend:2026-11-21', // no event says it in words: the key does
    ]) // the slot and the old round have cleared
    const sweepNeeds = st.needsYou.filter((n) => n.id.startsWith('sweep-')).map((n) => [n.kind, n.id, n.title, n.since])
    expect(sweepNeeds).toEqual([
      ['failed', 'sweep-down:backend:t2', 'the backend session has ended (its Herdr tab t2 shows a shell): run factory team-up to start it again', new Date(t0 * 1000).toISOString()],
      ['failed', 'sweep-budget:frontend:2026-11-21', 'budget:frontend:2026-11-21', new Date(t0 * 1000).toISOString()],
    ]) // a session on a dialog is already its own need
    expect(st.snap.notices.filter((n) => /unknown event type/.test(n.message))).toEqual([])
    expect(st.teams!.cycle!.events.map((e) => e.text)).toContain('autostart typed /dispatch c002-share-links')
    sweep(JSON.stringify({ seen: {} }))
    st = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(escNotices(st)).toEqual([])
    expect(st.needsYou.filter((n) => n.id.startsWith('sweep-'))).toEqual([])
    for (const bad of ['{"seen": {', '{"seen": ["down:backend:t2"]}', 'null', '']) {
      sweep(bad)
      st = await computeState(fx.repo, gh, { staleMinutes: 30 })
      expect(st.snap.notices.find((n) => n.source === '.factory/sweep.json')).toMatchObject({ level: 'warn', message: 'not readable: showing every escalation ever written' })
      expect(escNotices(st)).toHaveLength(5) // the fixture's slot, the old round, both downs, blocked
      expect(st.needsYou.filter((n) => n.id.startsWith('sweep-'))).toEqual([])
    }
  })

  test('every open pull request that waits for your label needs you, whatever its branch; drafts and the cycle\'s own are not repeated; approved ones wait for the merge', async () => {
    const fx = makeTeamsFactory(join(root, 'six'))
    process.env.PATH = `${fx.bin}:${PATH}`
    const gh = await readDemoGitHub(fx.github)
    const base = gh.data!.pulls.find((p) => p.number === 25)!
    const pr = (number: number, headRefName: string, labels: string[], files: string[], more: object = {}) =>
      ({ ...base, number, headRefName, title: `PR ${number}`, labels, url: `https://github.invalid/harbor/pull/${number}`, files: files.map((path) => ({ path, additions: 1, deletions: 0 })), ...more })
    gh.data!.pulls.push(
      pr(31, 'planning/c002-share-links-fix', [], ['factory/teams.json']), // R2 by its path, no label at all
      pr(32, 'factory/csp', ['human-approved'], ['factory/risk-rules.txt']), // approved
      pr(36, 'planning/fix', ['human-approved'], ['factory/teams.json'], { checks: [ // approved, but ownership fails: it cannot merge
        { name: 'ownership', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'ownership', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'risk-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
      pr(33, 'inbox/note', [], [], {}), // no labels, no files: its tier is unknown
      pr(34, 'factory/draft', [], ['factory/policy.env'], { isDraft: true }),
      pr(35, 'sync/f001-reading-list', [], ['server/x.ts']), // R1: merge it, with AUTO_MERGE_MAX_TIER=none
    )
    Object.assign(gh.data!.pulls.find((p) => p.number === 12)!, { isDraft: false, labels: ['brief-approved', 'risk:R2'] })
    const s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const prs = s.needsYou.filter((n) => n.id.startsWith('pr-')).map((n) => [n.kind, n.id, n.summary, n.href])
    expect(prs).toEqual([
      ['approve', 'pr-25', 'integrate/f001-reading-list · add human-approved, wait for the checks to pass, then merge · R2', 'https://github.invalid/harbor/pull/25'],
      ['approve', 'pr-31', 'planning/c002-share-links-fix · add human-approved, wait for the checks to pass, then merge · R2', 'https://github.invalid/harbor/pull/31'],
      ['failed', 'pr-36', 'planning/fix · approved, but failing: ownership', 'https://github.invalid/harbor/pull/36'],
      ['merge', 'pr-32', 'factory/csp · approved: merge it · R2', 'https://github.invalid/harbor/pull/32'], // approved, not merged: it still waits on you
      ['merge', 'pr-35', 'sync/f001-reading-list · merge it · R1', 'https://github.invalid/harbor/pull/35'],
    ]) // #12 is the cycle's own PR: its row says what the round needs
  })

  test('a garbled or missing roster', async () => {
    const dir = join(root, 'plain')
    mkdirSync(join(dir, 'factory'), { recursive: true })
    process.env.PATH = join(root, 'no-bin')
    try {
      let s = await computeState(dir, { status: { state: 'unavailable' } }, { staleMinutes: 30 })
      expect(s.teams).toBeNull() // not team mode: nothing changes
      writeFileSync(join(dir, 'factory/teams.json'), '{"teams": ')
      s = await computeState(dir, { status: { state: 'unavailable' } }, { staleMinutes: 30 })
      expect(s.teams).toMatchObject({ rosterError: 'factory/teams.json: not valid JSON', teams: [], sessions: { available: false }, phases: [{ step: 'no-cycle', next: { who: 'orchestrator', what: 'open one with /plan' } }] })
      expect(s.snap.notices.find((n) => n.source === 'factory/teams.json')).toMatchObject({ level: 'error', raw: '{"teams": ' })
    } finally {
      process.env.PATH = PATH
    }
  })
})
