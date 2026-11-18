// A small invented team-mode factory ("harbor", a bookmarking app): a real git repo with a dispatched
// feature, an open planning cycle, team worktrees (one on a work item that stopped with an
// uncommitted BLOCKED.md, one whose folder is gone), the live event log, GitHub data, and fake
// `herdr-app` and `hc` that also expose another, private space which must never be read.
// Used by tests/teams.test.ts and e2e/make-teams.ts.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GitHubData } from '../server/core/types.ts'

const HOUR = 3_600_000

export const HOSTILE = '<script>alert("x")</script><img src=x onerror="alert(1)"> **not bold** [link](javascript:alert(1))'
export const QUESTION = 'Both reviews disagree on AC2. Should a shared list be readable by anyone with the link, or only by members?'
export const SEALED = 'SEALED POSITION TEXT: nobody reads this before the round closes'
export const PRIVATE = ['secret-space', 'private-tab', 't99', 'PRIVATE MESSAGE']

export function makeTeamsFactory(root: string, now = Date.now()) {
  rmSync(root, { recursive: true, force: true })
  const repo = join(root, 'harbor')
  const teamsDir = join(root, 'harbor.teams')
  const bin = join(root, 'bin')
  mkdirSync(repo, { recursive: true })
  const at = (h: number) => new Date(now - h * HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'factory', GIT_AUTHOR_EMAIL: 'factory@example.invalid', GIT_COMMITTER_NAME: 'factory', GIT_COMMITTER_EMAIL: 'factory@example.invalid' }
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const write = (rel: string, text: string, base = repo) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true })
    writeFileSync(join(base, rel), text)
  }
  const commit = (msg: string, h: number) => {
    git('add', '-A')
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', msg], { env: { ...env, GIT_AUTHOR_DATE: at(h), GIT_COMMITTER_DATE: at(h) } })
  }
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  const state = (o: Record<string, unknown>) => JSON.stringify({ v: 1, strikes: {}, unanswered: [], ...o }, null, 2)

  // ---- main: the kit, the roster, a merged planning cycle ----
  git('init', '-q', '-b', 'main')
  write('factory/risk-rules.txt', readFileSync(new URL('../demo/template/factory/risk-rules.txt', import.meta.url), 'utf8'))
  write('factory/policy.env', 'AUTO_MERGE_MAX_TIER=none\n')
  write('factory/teams.json', JSON.stringify({
    version: 1, default_team: 'backend', limits: { round_minutes: 45 },
    teams: {
      orchestrator: { owns: ['planning/*', 'tests/e2e/*'] },
      backend: { owns: ['server/*', 'db/*'] },
      frontend: { owns: ['web/*'], ui_review: true },
      research: { owns: ['research/*', 'features/*/acceptance.md'], evidence_review: true },
      design: { owns: ['design/*'], active: false },
      'Bad Name': { owns: ['*'] },
    },
  }, null, 2))
  write('work/.gitkeep', '')
  const c1 = 'planning/c001-reading-list'
  const c1history = ['brief', 'positions', 'discussion-1', 'review', 'decisions', 'approval'].map((s, i) => ({ status: s, at: at(70 - i) }))
  write(`${c1}/BRIEF.md`, '# Brief: c001-reading-list\nteams: backend, frontend, research\n\n## Goal\nSave links to read later.\n')
  write(`${c1}/state.json`, state({ cycle: 'c001-reading-list', status: 'approval', teams: ['backend', 'frontend', 'research'], pr: 9, draft: 1, round_started_at: at(65), history: c1history }))
  write(`${c1}/DECISIONS.md`, '# Decisions: c001-reading-list\n\n## c001-D01: The list API\n- owner: backend\n- affects: frontend\n- status: decided\n\n### Decision\nGET /api/list.\n')
  write(`${c1}/discussion.jsonl`, jsonl([{ id: 'c001-m001', ts: at(69), cycle: 'c001-reading-list', round: 'discussion-1', from: 'orchestrator', to: 'backend', kind: 'question', refs: [], body: 'Paged or not?' }]))
  commit('Factory kit, roster and planning c001-reading-list', 72)
  git('branch', 'team/backend')
  git('branch', 'team/frontend')
  git('branch', 'team/design')

  // ---- the feature dispatch made, its integration round, and research's item on it ----
  const f = 'features/f001-reading-list'
  git('switch', '-q', '-c', 'feature/f001-reading-list')
  write(`${c1}/state.json`, state({ cycle: 'c001-reading-list', status: 'dispatched', feature: 'f001-reading-list', teams: ['backend', 'frontend', 'research'], pr: 9, draft: 1, round_started_at: at(65), history: [...c1history, { status: 'dispatched', at: at(60) }] }))
  write(`${f}/acceptance.md`, '# Acceptance: f001-reading-list\n\n## AC1: Saving a link\n- decisions: c001-D01\n- check: POST then GET lists it\n\n## AC2: Sharing\n- decisions: c001-D01\n- check: a shared list opens\n')
  write(`${f}/acceptance-review.md`, 'VERDICT: reject\ne2e-commit: 0123456789abcdef0123456789abcdef01234567\n- AC2: the test opens the list as its owner\n')
  commit('dispatch c001-reading-list as f001-reading-list', 60)
  git('switch', '-q', '-c', 'integrate/f001-reading-list')
  write(`${f}/e2e-report.md`, '# E2E report: f001-reading-list\nE2E: fail\nround: 1\ncommit: 0123456789abcdef0123456789abcdef01234567\n\n## Output (last 200 lines)\n    AC2 failed\n')
  commit('integrate f001-reading-list: round 1, e2e fail', 30)
  git('switch', '-q', '-c', 'work/19-acceptance', 'feature/f001-reading-list')
  write('work/19-acceptance/spec.md', '---\nid: 19\ntitle: Acceptance criteria for the reading list\nrisk_floor: R1\ntests: none\nstatus: draft\n---\n## Problem\nCriteria for f001.\n## Acceptance criteria\n- AC-1: criteria exist\n')
  commit('work 19: spec', 6)

  // ---- the open cycle, on its branch in the main checkout ----
  const c2 = 'planning/c002-share-links'
  git('switch', '-q', '-c', c2, 'main')
  write(`${c2}/BRIEF.md`, '# Brief: c002-share-links\nteams: backend, frontend\n\n## Goal\nShare a list by link.\n')
  write(`${c2}/state.json`, state({
    cycle: 'c002-share-links', status: 'decisions', teams: ['backend', 'frontend'], pr: 12, draft: 1, round_started_at: at(1),
    history: ['brief', 'positions', 'discussion-1', 'review', 'decisions'].map((s, i) => ({ status: s, at: at(5 - i) })),
  }))
  const m = (id: number, round: string, from: string, to: string, kind: string, body: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: `c002-m${String(id).padStart(3, '0')}`, ts: at(5 - id / 10), cycle: 'c002-share-links', round, from, to, kind, refs: [], body, ...extra })
  write(`${c2}/discussion.jsonl`, [
    m(1, 'discussion-1', 'orchestrator', 'backend', 'question', 'Can a link expire?'),
    m(2, 'discussion-1', 'backend', 'orchestrator', 'answer', 'Yes, after 30 days.', { refs: ['c002-m001'] }),
    m(3, 'discussion-1', 'frontend', 'all', 'proposal', HOSTILE),
    '{"id": "c002-m004", "this line is cut',
    JSON.stringify({ id: 'c002-m005', round: 'discussion-1', kind: 'answer' }),
    m(6, 'decisions', 'orchestrator', 'all', 'decision', 'draft 1: planning/c002-share-links/DECISIONS.md', { draft: 1 }),
    m(7, 'decisions', 'frontend', 'all', 'accept', 'Fine with both records.', { draft: 1 }),
  ].join('\n') + '\n')
  write(`${c2}/DECISIONS.md`, [
    '# Decisions: c002-share-links', '',
    '## c002-D01: Links expire', '- owner: backend', '- affects: frontend', '- status: decided', '', '### Decision', 'After 30 days.', '',
    '## c002-D02: Who may open a shared list', '- owner: backend', '- affects: frontend', '- status: needs-human', '', '### Decision', 'Undecided.', '### Dissent', 'frontend: members only.',
    '- status: decided (this line is inside a section, not a field)', '',
    '## Work breakdown', '| item | team | delivers | after | contract | decisions |', '|---|---|---|---|---|---|', '| share-api | backend | the API | | | c002-D01 |', '',
  ].join('\n'))
  commit('planning c002-share-links: draft 1', 1)

  // ---- live state: the active marker, a sealed position, the event log ----
  write('.factory/planning/active', 'c002-share-links\n')
  write('.factory/planning/c002-share-links/sealed/backend.md', SEALED)
  const ev = (h: number, type: string, o: Record<string, unknown>) => ({ ts: at(h), type, work_id: '', branch: c2, team: 'orchestrator', ...o })
  const stage = (h: number, stage: string, status: string, round: number, detail: string) => ({ ts: at(h), type: 'stage', work_id: '19', branch: 'work/19-acceptance', stage, status, round: String(round), detail, team: 'research' })
  write('.factory/events.jsonl', jsonl([
    ev(5, 'round', { cycle: 'c002-share-links', status: 'opened' }),
    ev(4.5, 'approval', { cycle: 'c002-share-links', what: 'brief' }),
    ev(4.2, 'position', { cycle: 'c002-share-links', action: 'submitted', team: 'backend', branch: 'team/backend' }),
    ev(4.9, 'message', { cycle: 'c002-share-links', round: 'discussion-1', id: 'c002-m001', from: 'orchestrator', to: 'backend', kind: 'question' }),
    ev(1, 'round', { cycle: 'c002-share-links', status: 'decisions' }),
    stage(5, 'intake', 'passed', 0, 'acceptance item, feature f001-reading-list'),
    stage(4.8, 'spec', 'passed', 0, 'spec ok'),
    stage(4.7, 'criteria', 'started', 0, 'spec-writer'),
    stage(4, 'criteria-gate', 'passed', 0, '2 criteria'),
    stage(3, 'evidence-review', 'blocked', 1, 'reviews disagree; see BLOCKED.md'),
    { ts: at(4.9), type: 'slot', work_id: '19', branch: 'work/19-acceptance', action: 'acquire', team: 'research' },
    { ts: at(2), type: 'escalation', work_id: '', branch: 'main', reason: 'slot', refs: 'research', detail: 'research has held a build slot for 3 hours' },
  ]))

  // ---- team worktrees: research on its item with an uncommitted BLOCKED.md; design's folder is gone ----
  for (const [team, branch] of [['backend', 'team/backend'], ['frontend', 'team/frontend'], ['research', 'work/19-acceptance'], ['design', 'team/design']] as const) {
    git('worktree', 'add', '-q', join(teamsDir, team), branch)
  }
  write('work/19-acceptance/BLOCKED.md', `# Blocked\n\n${QUESTION}\n`, join(teamsDir, 'research'))
  rmSync(join(teamsDir, 'design'), { recursive: true, force: true })

  // ---- GitHub, as the control room normalises it ----
  const issue = (number: number, title: string, labels: string[], state: 'OPEN' | 'CLOSED' = 'OPEN') =>
    ({ number, title, state, labels, createdAt: at(59), url: `https://github.invalid/harbor/issues/${number}`, body: '', labelEvents: [] })
  const pull = (number: number, title: string, headRefName: string, state: 'OPEN' | 'MERGED', labels: string[], isDraft = false) =>
    ({ number, title, state, isDraft, headRefName, headSha: 'f'.repeat(40), labels, createdAt: at(50), mergedAt: state === 'MERGED' ? at(40) : undefined, url: `https://github.invalid/harbor/pull/${number}`, body: '', autoMerge: false, checks: [], files: [], timeline: [] })
  const github: GitHubData = {
    repo: 'example/harbor',
    issues: [
      issue(19, 'Acceptance criteria for the reading list', ['feature:f001-reading-list', 'team:research']),
      issue(20, 'Reading list API', ['feature:f001-reading-list', 'team:backend'], 'CLOSED'),
      issue(21, 'Reading list page', ['team:frontend', 'feature:f001-reading-list']),
      issue(23, 'The list API answers 500 for an empty list', ['feature:f001-reading-list', 'team:backend', 'ticket', 'type:bug']),
    ],
    pulls: [
      pull(12, 'Planning c002-share-links', c2, 'OPEN', ['brief-approved'], true),
      pull(22, 'Reading list API', 'work/20-list-api', 'MERGED', ['risk:R1']),
      pull(25, 'Feature f001-reading-list', 'integrate/f001-reading-list', 'OPEN', ['risk:R2']),
    ],
  }
  writeFileSync(join(root, 'github.json'), JSON.stringify(github, null, 2))

  // ---- Herdr: the factory's space and someone else's ----
  const hcLog = join(root, 'hc.log')
  const layout = {
    spaces: [
      { name: PRIVATE[0], tabs: [{ name: PRIVATE[1], terminals: [{ terminal: PRIVATE[2], status: 'working' }] }] },
      {
        name: 'harbor',
        tabs: [
          ...['orchestrator', 'backend', 'frontend', 'research', 'sweep'].map((name, i) => ({ name, terminals: [{ terminal: `t${i + 1}` }] })),
          { name: 'odd', terminals: [{ terminal: 't7; touch pwned' }] },
        ],
      },
    ],
  }
  const status = (state: string | null, msg?: string) => JSON.stringify({ status: { app: state ? 'claude-code' : null, state, ...(msg ? { msg } : {}) }, status_ms: now - HOUR, screen: 'SCREEN CONTENTS ARE NEVER READ' })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'herdr-app'), `#!/bin/sh\n[ "$1" = ls ] || exit 2\ncat <<'EOF'\n${JSON.stringify(layout)}\nEOF\n`)
  writeFileSync(join(bin, 'hc'), [
    '#!/bin/sh',
    `echo "$*" >> '${hcLog}'`,
    '[ "$1" = get ] || exit 2',
    'case "$2" in',
    `  t1) echo '${status('idle')}' ;;`,
    `  t2) echo '${status('working')}' ;;`,
    `  t3) echo '${status('error', 'API rate limit: retrying in 20 minutes')}' ;;`,
    `  t4) echo '${status('blocked', 'Do you trust the files in this folder?')}' ;;`,
    `  t5) echo '${status(null)}' ;;`,
    `  t99) echo '{"status":{"state":"working","msg":"${PRIVATE[3]}"}}' ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'))
  chmodSync(join(bin, 'herdr-app'), 0o755)
  chmodSync(join(bin, 'hc'), 0o755)

  return { root, repo, teamsDir, bin, hcLog, github: join(root, 'github.json'), git }
}
