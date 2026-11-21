// Team mode: the roster, the planning cycle, features, team worktrees and Herdr sessions, over a real
// git repo with worktrees and fake herdr-app / hc, plus malformed and hostile inputs.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionRecords, parseCycleState, parseDiscussion, parseRoster, waitingFor, type CycleState, type Message } from '../server/core/teams.ts'
import { herdrSessions } from '../server/sources/teams.ts'
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
    expect(recs).toEqual([{ id: 'c1-D01', title: 'One', status: 'decided' }, { id: 'c1-D02', title: 'Two', status: 'needs-human' }])
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
      ['approve', 'pr-25', 'integrate/f001-reading-list · add human-approved, then merge · R2'], // the feature's PR to main
      ['failed', 'session-frontend', 'API rate limit: retrying in 20 minutes'],
      ['waiting-input', 'session-research', 'Do you trust the files in this folder?'],
    ])
  })

  test('the feature: its branches, its issues and where each is, and its records', () => {
    const [f] = s.teams!.features
    expect(f).toMatchObject({ name: 'f001-reading-list', refs: { feature: 'feature/f001-reading-list', integrate: 'integrate/f001-reading-list' } })
    expect(f!.items.map((i) => [i.number, i.team, i.ticket, i.open, i.item?.state])).toEqual([
      [19, 'research', false, true, 'blocked'],
      [20, 'backend', false, false, 'merged'],
      [21, 'frontend', false, true, undefined],
      [23, 'backend', true, true, undefined],
    ])
    expect(f!.docs.map((d) => [d.file, d.ref, d.headline])).toEqual([
      ['acceptance.md', 'feature/f001-reading-list', '2 criteria'],
      ['e2e-report.md', 'integrate/f001-reading-list', 'E2E: fail, round: 1'],
      ['acceptance-review.md', 'feature/f001-reading-list', 'VERDICT: reject'],
    ])
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
      { ...base, number: 40, title: 'Fix the work breakdown path', headRefName: 'fix/c001-breakdown', labels: ['human-approved', 'risk:R2'], url: 'https://github.invalid/harbor/pull/40',
        files: [{ path: 'planning/c001-reading-list/DECISIONS.md', additions: 1, deletions: 1 }], checks: [{ name: 'risk-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      { ...base, number: 41, title: 'Unrelated', headRefName: 'fix/other', labels: ['risk:R2'], files: [{ path: 'planning/c001-reading-list-old/x.md', additions: 1, deletions: 0 }] },
    )
    let s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const c = s.teams!.cycle!
    expect(c).toMatchObject({ name: 'c001-reading-list', state: { status: 'approval' }, pr: { number: 9, state: 'MERGED' } })
    expect(c.blocking.map((b) => [b.number, b.why])).toEqual([[40, 'PR #40 must merge, then /dispatch']])
    expect(c.waiting).toEqual([{ team: 'you', owes: 'PR #40 must merge, then /dispatch' }]) // not "orchestrator owes /dispatch"
    expect(s.needsYou.find((n) => n.id === 'pr-40')).toMatchObject({ kind: 'merge', summary: 'fix/c001-breakdown · approved: merge it · R2 · planning c001-reading-list waits: PR #40 must merge, then /dispatch' })
    // with auto-merge on, it merges itself once CI is green: still shown, as information
    gh.data!.pulls.find((p) => p.number === 40)!.autoMerge = true
    s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    expect(s.needsYou.find((n) => n.id === 'pr-40')).toMatchObject({ kind: 'info', summary: expect.stringMatching(/^fix\/c001-breakdown · approved: merging when CI is green · R2 · /) })
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
    const s = await computeState(fx.repo, gh, { staleMinutes: 30 })
    const i = s.byId.get('21')!
    expect(i).toMatchObject({ branch: 'work/21-list-page-2', pr: { number: 31, state: 'OPEN' }, title: 'Reading list page', state: 'pr-open', blocked: undefined })
    expect(i.files['spec.md']!.path).toBe('work/21-list-page-2/spec.md')
    expect(s.needsYou.find((n) => n.id === '21')).toBeUndefined() // the first attempt's question is not this attempt's
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
      ['approve', 'pr-25', 'integrate/f001-reading-list · add human-approved, then merge · R2', 'https://github.invalid/harbor/pull/25'],
      ['approve', 'pr-31', 'planning/c002-share-links-fix · add human-approved, then merge · R2', 'https://github.invalid/harbor/pull/31'],
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
      expect(s.teams).toMatchObject({ rosterError: 'factory/teams.json: not valid JSON', teams: [], sessions: { available: false } })
      expect(s.snap.notices.find((n) => n.source === 'factory/teams.json')).toMatchObject({ level: 'error', raw: '{"teams": ' })
    } finally {
      process.env.PATH = PATH
    }
  })
})
