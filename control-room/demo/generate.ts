// Generates a realistic fake factory: a real git repo (work/* branches, Factory-Stage trailers,
// squash merges, a revert), the live event stream, transcripts, memory, reflections, an audit,
// a fake GitHub dataset and expected.json (the state each item is meant to be in).
//
//   node demo/generate.ts <out-dir> [--now <iso>]
//
// Layout:  <out>/repo  <out>/github.json  <out>/expected.json  <out>/transcripts/
// Deterministic for a given --now.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const REPO_SLUG = 'demo/tally'
const AGENT: Record<string, string> = { spec: 'spec-writer', tests: 'test-author', build: 'builder', review: 'reviewer', observe: 'observer' }
const DURATION: Record<string, number> = { intake: 1, spec: 5, tests: 7, build: 18, gate: 3, review: 9, observe: 3, pr: 1 }

type Tier = 'R0' | 'R1' | 'R2' | 'R3'
type RunEnd = 'done' | 'live' | 'waiting' | 'quiet' | 'died'

interface Run {
  steps: string // "intake spec tests build gate.fail build@1 gate@1 review observe pr"
  gapHoursBefore?: number // pause before this run (for re-runs after BLOCKED)
  end?: RunEnd
}

interface Scenario {
  id: number
  slug: string
  title: string
  floor: Tier
  tests?: 'required' | 'none'
  startDaysAgo?: number
  endMinutesAgo?: number // anchor the last event instead of the start
  runs?: Run[]
  pr?: {
    outcome: 'merged' | 'open' | 'closed'
    afterHours?: number // merge/close delay after the PR opens
    merge?: 'auto' | 'human'
    autoMerge?: boolean // open PRs: auto-merge enabled
    approved?: boolean
    failing?: string // name of a failing check
    pending?: boolean
  }
  files?: Record<string, string> // product files the build writes
  labels?: string[] // issue labels (default: factory:ready once work starts)
  issueClosedDaysAgo?: number
  blockedUncommitted?: boolean
  checkedOut?: boolean
  question?: string
  malformedReview?: boolean
  malformedSpec?: boolean
  badEventLine?: boolean
  missingTestFor?: string
  revertedDaysAgo?: number
  notVerified?: string[]
  expect: { state: string; needs?: string; flags?: string[] }
}

// ---------------------------------------------------------------------------------------
// the thirty-odd items, oldest first
const S: Scenario[] = [
  { id: 3, slug: 'readme-quickstart', title: 'Quickstart section in the README', floor: 'R0', tests: 'none', startDaysAgo: 41,
    runs: [{ steps: 'intake spec tests.skip build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 6, merge: 'human' },
    files: { 'README.md': '# Tally\n\n## Quickstart\n\n    make dev\n' }, expect: { state: 'merged' } },
  { id: 4, slug: 'health-endpoint', title: 'GET /health returns build info', floor: 'R1', startDaysAgo: 40,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 20, merge: 'human' },
    files: { 'src/routes/health.ts': 'export const health = () => ({ ok: true })\n' }, expect: { state: 'merged' } },
  { id: 5, slug: 'create-group', title: 'Create a group with a name', floor: 'R1', startDaysAgo: 36,
    runs: [{ steps: 'intake spec tests build gate.fail build@1 gate@1 review observe pr' }], pr: { outcome: 'merged', afterHours: 4, merge: 'human' },
    files: { 'src/groups/create.ts': 'export function createGroup(name: string) { return { name } }\n' }, expect: { state: 'merged' } },
  { id: 6, slug: 'users-email-index', title: 'Unique index on users.email', floor: 'R2', startDaysAgo: 34,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 26, merge: 'human', approved: true },
    files: { 'db/migrations/0003_users_email_index.sql': 'create unique index users_email on users(email);\n' }, expect: { state: 'merged' } },
  { id: 7, slug: 'add-expense', title: 'Add an expense to a group', floor: 'R1', startDaysAgo: 31,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 3, merge: 'human' }, revertedDaysAgo: 27,
    files: { 'src/expenses/add.ts': 'export function addExpense(amount: number) { return amount * 2 }\n' }, expect: { state: 'merged', flags: ['reverted'] } },
  { id: 8, slug: 'split-evenly', title: 'Split an expense evenly between members', floor: 'R1', startDaysAgo: 27,
    runs: [{ steps: 'intake spec tests build gate review.fail build@1 gate@1 review.fail@1 build@2 gate@2 review@2 observe pr' }],
    pr: { outcome: 'merged', afterHours: 5, merge: 'human' }, files: { 'src/expenses/split.ts': 'export const split = (a: number, n: number) => a / n\n' },
    expect: { state: 'merged' } },
  { id: 9, slug: 'changelog', title: 'CHANGELOG for user-visible changes', floor: 'R0', tests: 'none', startDaysAgo: 24,
    runs: [{ steps: 'intake spec tests.skip build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 0.3, merge: 'auto' },
    files: { 'CHANGELOG.md': '# Changelog\n' }, expect: { state: 'merged' } },
  { id: 10, slug: 'list-expenses', title: "List a group's expenses newest first", floor: 'R1', startDaysAgo: 22,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 8, merge: 'human' }, malformedReview: true,
    files: { 'src/expenses/list.ts': 'export const list = () => []\n' }, expect: { state: 'merged' } },
  { id: 11, slug: 'currency-format', title: 'Format amounts with the group currency', floor: 'R1', startDaysAgo: 19, missingTestFor: 'AC-3',
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 0.4, merge: 'auto' },
    files: { 'src/money/format.ts': 'export const fmt = (n: number, c: string) => `${c} ${n.toFixed(2)}`\n' }, expect: { state: 'merged' } },
  { id: 12, slug: 'rate-limit', title: 'Rate-limit the public API', floor: 'R1', startDaysAgo: 15,
    runs: [{ steps: 'intake spec tests build gate.fail build@1 gate@1 review observe pr' }], pr: { outcome: 'merged', afterHours: 30, merge: 'human', approved: true },
    files: { 'package.json': '{\n  "name": "tally",\n  "dependencies": { "rate-limiter-flexible": "^5.0.0" }\n}\n', 'src/middleware/rate-limit.ts': 'export const limit = 100\n' },
    expect: { state: 'merged' } },
  { id: 13, slug: 'settle-up', title: 'Settle up between two members', floor: 'R1', startDaysAgo: 12, badEventLine: true,
    runs: [{ steps: 'intake spec tests build gate.fail build@1 gate@1 review.fail build@2 gate@2 review@1 observe pr' }],
    pr: { outcome: 'merged', afterHours: 0.5, merge: 'auto' }, files: { 'src/balances/settle.ts': 'export const settle = () => 0\n' }, expect: { state: 'merged' } },
  { id: 14, slug: 'member-invite', title: 'Invite a member by email', floor: 'R1', startDaysAgo: 8,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 0.4, merge: 'auto' },
    files: { 'src/members/invite.ts': 'export const invite = (email: string) => email\n' }, expect: { state: 'merged' } },
  { id: 15, slug: 'api-docs', title: 'Document the expenses API', floor: 'R0', tests: 'none', startDaysAgo: 6,
    runs: [{ steps: 'intake spec tests.skip build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 0.2, merge: 'auto' },
    files: { 'docs/api/expenses.md': '# Expenses API\n' }, expect: { state: 'merged' } },
  { id: 17, slug: 'group-totals', title: 'Group balance totals', floor: 'R1', startDaysAgo: 3,
    runs: [{ steps: 'intake spec tests build gate review.fail build@1 gate@1 review@1 observe pr' }], pr: { outcome: 'merged', afterHours: 0.6, merge: 'auto' },
    files: { 'src/balances/totals.ts': 'export const totals = () => ({})\n' }, expect: { state: 'merged' } },
  { id: 16, slug: 'delete-expense', title: 'Delete an expense (soft delete)', floor: 'R1', endMinutesAgo: 75,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'merged', afterHours: 0.6, merge: 'auto' },
    files: { 'src/expenses/delete.ts': 'export const softDelete = (id: string) => ({ id, deleted: true })\n' }, expect: { state: 'merged' } },

  // stopped without merging
  { id: 21, slug: 'csv-export', title: 'Export expenses as CSV', floor: 'R1', startDaysAgo: 20,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'closed', afterHours: 40 },
    files: { 'src/export/csv.ts': 'export const csv = () => ""\n' }, expect: { state: 'closed' } },
  { id: 22, slug: 'dark-mode', title: 'Dark mode for the web app', floor: 'R1', startDaysAgo: 25, labels: ['factory:proposed'], issueClosedDaysAgo: 21,
    expect: { state: 'closed' } },

  // blocked: each one needs an answer
  { id: 23, slug: 'delete-account', title: 'Delete a user account', floor: 'R2', endMinutesAgo: 125, blockedUncommitted: true,
    question: 'Should deleting an account also delete the expenses that user paid for, or keep them (anonymised) so the other members’ balances stay correct?',
    runs: [{ steps: 'intake spec.block observe' }], expect: { state: 'blocked', needs: 'answer' } },
  { id: 24, slug: 'recurring-expense', title: 'Recurring monthly expenses', floor: 'R1', startDaysAgo: 1.1,
    question: 'The builder and test-author disagree about AC-2: does a recurring expense created on the 31st recur on the last day of shorter months, or skip them?',
    runs: [{ steps: 'intake spec tests build.block observe' }], files: { 'src/expenses/recurring.ts': 'export const nextDue = () => null\n' },
    expect: { state: 'blocked', needs: 'answer' } },
  { id: 25, slug: 'share-link', title: 'Share a read-only group link', floor: 'R2', startDaysAgo: 3.2,
    question: 'The reviewer escalated: the share link grants read access without an account. Is an unguessable link enough, or must links expire?',
    runs: [{ steps: 'intake spec tests build gate review.block observe' }], files: { 'src/auth/share-link.ts': 'export const token = () => crypto.randomUUID()\n' },
    expect: { state: 'blocked', needs: 'answer' } },
  { id: 26, slug: 'import-bank-csv', title: 'Import expenses from a bank CSV', floor: 'R1', startDaysAgo: 2,
    question: 'make accept still fails after 2 fix rounds (AC-3: dates in DD/MM/YYYY). Should the importer guess the date format, or require the user to choose it?',
    runs: [{ steps: 'intake spec tests build gate.fail build@1 gate.fail@1 build@2 gate.block@2 observe' }], files: { 'src/import/bank.ts': 'export const parse = () => []\n' },
    expect: { state: 'blocked', needs: 'answer' } },

  // failed: the run stopped without BLOCKED.md
  { id: 27, slug: 'receipt-upload', title: 'Attach a receipt image to an expense', floor: 'R1', startDaysAgo: 0.6,
    runs: [{ steps: 'intake spec tests build gate.fail', end: 'died' }], files: { 'src/receipts/upload.ts': 'export const upload = () => {}\n' },
    expect: { state: 'failed', needs: 'failed' } },

  // in progress
  { id: 28, slug: 'edit-expense', title: 'Edit an expense', floor: 'R1', endMinutesAgo: 4, checkedOut: true,
    question: 'Can any member edit an expense, or only the member who paid?',
    runs: [{ steps: 'intake spec.block observe' }, { gapHoursBefore: 40, steps: 'intake spec@1 tests build gate review.run', end: 'live' }],
    files: { 'src/expenses/edit.ts': 'export const edit = () => {}\n' }, expect: { state: 'in-progress', flags: ['live', 'stale-blocked'] } },
  { id: 29, slug: 'member-roles', title: 'Member roles: owner and member', floor: 'R1', endMinutesAgo: 130,
    runs: [{ steps: 'intake spec tests build gate.run', end: 'quiet' }], files: { 'src/members/roles.ts': 'export type Role = "owner" | "member"\n' },
    expect: { state: 'in-progress', needs: 'quiet', flags: ['quiet'] } },
  { id: 30, slug: 'group-search', title: 'Search groups by name', floor: 'R1', endMinutesAgo: 12,
    runs: [{ steps: 'intake spec tests.run', end: 'waiting' }], expect: { state: 'in-progress', needs: 'waiting-input', flags: ['waiting-input', 'live'] } },
  { id: 31, slug: 'expense-notes', title: 'Free-text notes on an expense', floor: 'R1', endMinutesAgo: 6, malformedSpec: true,
    runs: [{ steps: 'intake spec tests build.run', end: 'live' }], expect: { state: 'in-progress', flags: ['live'] } },

  // pull requests
  { id: 32, slug: 'audit-log-table', title: 'Audit log table for group changes', floor: 'R1', startDaysAgo: 1.4,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'open' },
    notVerified: ['The migration was not run against a copy of production-sized data.', 'Rollback of 0007 was not exercised.'],
    files: { 'db/migrations/0007_audit_log.sql': 'create table audit_log (id integer primary key, group_id integer, at text);\n', 'src/audit/log.ts': 'export const log = () => {}\n' },
    expect: { state: 'awaiting-approval', needs: 'approve' } },
  { id: 33, slug: 'ci-dependency-cache', title: 'Cache dependencies in CI', floor: 'R2', startDaysAgo: 2.5,
    runs: [{ steps: 'intake spec tests.skip build gate review observe pr' }], pr: { outcome: 'open', approved: true }, tests: 'none',
    files: { '.github/workflows/ci.yml': '# toolchain cache added\n' }, expect: { state: 'awaiting-merge', needs: 'merge' } },
  { id: 34, slug: 'expense-categories', title: 'Expense categories', floor: 'R1', endMinutesAgo: 25,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'open', autoMerge: true, pending: true },
    files: { 'src/expenses/categories.ts': 'export const categories = ["food", "travel"]\n' }, expect: { state: 'pr-open' } },
  { id: 35, slug: 'split-by-shares', title: 'Split an expense by shares', floor: 'R1', startDaysAgo: 0.9,
    runs: [{ steps: 'intake spec tests build gate review observe pr' }], pr: { outcome: 'open', autoMerge: true, failing: 'check' },
    files: { 'src/expenses/shares.ts': 'export const byShares = () => []\n' }, expect: { state: 'failed', needs: 'failed' } },

  // not started
  { id: 37, slug: 'monthly-summary', title: 'Monthly summary email', floor: 'R1', startDaysAgo: 4, labels: ['factory:ready'], expect: { state: 'ready' } },
  { id: 38, slug: 'undo-expense', title: 'Undo the last expense', floor: 'R1', startDaysAgo: 2, labels: ['factory:ready'], expect: { state: 'ready' } },
  { id: 39, slug: 'archive-group', title: 'Archive a group', floor: 'R1', startDaysAgo: 1, labels: ['factory:ready'], expect: { state: 'ready' } },
  { id: 40, slug: 'multi-currency', title: 'Multi-currency groups', floor: 'R2', startDaysAgo: 5, labels: ['factory:proposed'], expect: { state: 'proposed' } },
  { id: 41, slug: 'offline-mode', title: 'Offline mode for the web app', floor: 'R1', startDaysAgo: 5, labels: ['factory:proposed'], expect: { state: 'proposed' } },
  { id: 42, slug: 'expense-comments', title: 'Comments on an expense', floor: 'R1', startDaysAgo: 0.5, labels: ['factory:proposed'], expect: { state: 'proposed' } },
]

// ---------------------------------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

interface Ev {
  ts: number
  type: 'stage' | 'lifecycle'
  data: Record<string, string>
}

interface Step {
  stage: string
  status: 'passed' | 'failed' | 'blocked' | 'skipped' | 'started'
  round: number
}

function parseSteps(s: string): Step[] {
  return s.split(/\s+/).filter(Boolean).map((tok) => {
    const m = /^(\w+)(?:\.(\w+))?(?:@(\d+))?$/.exec(tok)!
    const status = ({ fail: 'failed', block: 'blocked', skip: 'skipped', run: 'started', undefined: 'passed' } as Record<string, Step['status']>)[String(m[2])]!
    return { stage: m[1]!, status, round: Number(m[3] ?? 0) }
  })
}

export function generate(out: string, nowMs = Date.now()) {
  const rand = rng(42)
  const jitter = (min: number) => Math.round(min * (0.7 + rand() * 0.6) * MIN)
  // only ever wipe a directory this generator created
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, 'expected.json'))) throw new Error(`refusing to overwrite ${out}: not a demo directory`)
  rmSync(out, { recursive: true, force: true })
  const repo = join(out, 'repo')
  const tdir = join(out, 'transcripts')
  mkdirSync(repo, { recursive: true })
  const run = (args: string[], at?: number) =>
    execFileSync('git', ['-C', repo, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'factory', GIT_AUTHOR_EMAIL: 'factory@example.invalid', GIT_COMMITTER_NAME: 'factory', GIT_COMMITTER_EMAIL: 'factory@example.invalid', ...(at ? { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  const commit = (msg: string, at: number) => {
    run(['add', '-A'])
    run(['commit', '-q', '--allow-empty', '-m', msg], at)
    return run(['rev-parse', 'HEAD']).trim()
  }

  // ---- the kit and a walking skeleton ----
  const t0 = nowMs - 44 * DAY
  run(['init', '-q', '-b', 'main'])
  cpSync(join(HERE, 'template'), repo, { recursive: true })
  write('factory/policy.env', readFileSync(join(HERE, 'template/factory/policy.env'), 'utf8').replace('AUTO_MERGE_MAX_TIER=none', 'AUTO_MERGE_MAX_TIER=R1'))
  write('product/BRIEF.md', '# Product brief\n\n## What it is\nTally: a shared-expenses app for small groups (flatmates, trips).\n')
  commit('Factory kit', t0)
  write('src/index.ts', 'export const app = {}\n')
  write('tests/acceptance/.gitkeep', '')
  commit('Walking skeleton', t0 + 2 * HOUR)

  const liveEvents: Ev[] = []
  const github = { repo: REPO_SLUG, issues: [] as unknown[], pulls: [] as unknown[] }
  const expected: Record<string, unknown> = {}
  const branchesToCheck: { sc: Scenario; branch: string; folderFiles: Record<string, string> }[] = []
  const reverts: { sc: Scenario; sha: string; prNumber: number; at: number }[] = []
  const merges: { at: number; fn: () => void }[] = []
  let sessionN = 0
  let agentN = 0

  const emitStage = (list: Ev[], at: number, sc: Scenario, st: Step, extra: Record<string, string> = {}) =>
    list.push({ ts: at, type: 'stage', data: { work_id: String(sc.id), branch: `work/${sc.id}-${sc.slug}`, stage: st.stage, status: st.status, round: String(st.round), ...extra } })
  const emitLife = (at: number, sc: Scenario | null, event: string, extra: Record<string, string> = {}) =>
    liveEvents.push({ ts: at, type: 'lifecycle', data: { work_id: sc ? String(sc.id) : '', branch: sc ? `work/${sc.id}-${sc.slug}` : 'main', event, ...extra } })

  const writeTranscript = (session: string, agentId: string, agentType: string, model: string, start: number, end: number) => {
    const p = join(tdir, `-demo-tally/${session}/subagents/agent-${agentId}.jsonl`)
    mkdirSync(dirname(p), { recursive: true })
    const lines: string[] = []
    const n = 3 + Math.floor(rand() * 6)
    for (let i = 0; i < n; i++) {
      const id = `msg_${agentId}_${i}`
      const req = `req_${agentId}_${i}`
      const at = iso(start + ((end - start) * (i + 1)) / (n + 1))
      const usage = { input_tokens: 3 + i, cache_creation_input_tokens: i === 0 ? 18000 + Math.floor(rand() * 9000) : Math.floor(rand() * 4000), cache_read_input_tokens: i === 0 ? 0 : 20000 + i * 3000, output_tokens: 200 + Math.floor(rand() * 1800) }
      // Claude Code writes one line per content block with the same message id; streaming lines carry partial output
      lines.push(JSON.stringify({ type: 'assistant', timestamp: at, requestId: req, isSidechain: true, agentId, message: { id, model, role: 'assistant', usage: { ...usage, output_tokens: Math.floor(usage.output_tokens / 3) } } }))
      lines.push(JSON.stringify({ type: 'assistant', timestamp: at, requestId: req, isSidechain: true, agentId, message: { id, model, role: 'assistant', usage } }))
      lines.push(JSON.stringify({ type: 'user', timestamp: at, isSidechain: true, agentId, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }))
    }
    writeFileSync(p, lines.join('\n') + '\n')
    writeFileSync(p.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType }))
    return p
  }
  const writeSessionTranscript = (session: string, start: number, end: number) => {
    const p = join(tdir, `-demo-tally/${session}.jsonl`)
    mkdirSync(dirname(p), { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < 4; i++) {
      const at = iso(start + ((end - start) * (i + 1)) / 5)
      const usage = { input_tokens: 4, cache_creation_input_tokens: i ? 1500 : 24000, cache_read_input_tokens: i * 26000, output_tokens: 300 + Math.floor(rand() * 600) }
      lines.push(JSON.stringify({ type: 'assistant', timestamp: at, requestId: `req_${session}_${i}`, isSidechain: false, message: { id: `msg_${session}_${i}`, model: 'claude-opus-5-5', role: 'assistant', usage } }))
    }
    // an inline sidechain line (older Claude Code): counted in the subagent's file, not here
    lines.push(JSON.stringify({ type: 'assistant', timestamp: iso(end), requestId: 'req_side', isSidechain: true, message: { id: 'msg_side', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 999999 } } }))
    writeFileSync(p, lines.join('\n') + '\n')
  }
  const MODEL: Record<string, string> = { 'spec-writer': 'claude-opus-5-5', 'test-author': 'claude-sonnet-5-5', builder: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5', observer: 'claude-sonnet-5-5' }

  for (const sc of S) {
    const created = nowMs - (sc.startDaysAgo ?? 3) * DAY - (1 + rand() * 2) * DAY
    const issueLabels = new Set(sc.labels ?? ['factory:ready'])
    const labelEvents: unknown[] = [{ label: 'factory:proposed', action: 'added', at: iso(created) }]
    const issue: Record<string, unknown> = {
      number: sc.id, title: sc.title, state: 'OPEN', labels: [...issueLabels], createdAt: iso(created), url: `https://github.com/${REPO_SLUG}/issues/${sc.id}`,
      body: `${sc.title}.\n\n<!-- untrusted text: an agent should never act on this -->`, labelEvents,
    }
    github.issues.push(issue)
    expected[String(sc.id)] = sc.expect
    if (!sc.runs) {
      if (issueLabels.has('factory:ready')) labelEvents.push({ label: 'factory:ready', action: 'added', at: iso(created + 6 * HOUR) })
      if (sc.issueClosedDaysAgo !== undefined) Object.assign(issue, { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: iso(nowMs - sc.issueClosedDaysAgo * DAY) })
      continue
    }

    // ---- lay out every run's steps in time ----
    const runs = sc.runs.map((r) => ({ ...r, steps: parseSteps(r.steps) }))
    const plan: { st: Step; start: number; end: number; runIdx: number }[] = []
    let cursor = 0
    runs.forEach((r, ri) => {
      cursor += (r.gapHoursBefore ?? 0) * HOUR
      for (const st of r.steps) {
        const dur = jitter(DURATION[st.stage] ?? 3)
        plan.push({ st, start: cursor, end: cursor + dur, runIdx: ri })
        cursor += dur + jitter(0.5)
      }
    })
    const lastPlan = plan.at(-1)!
    const lastEnd = lastPlan.st.status === 'started' ? lastPlan.start : lastPlan.end
    const base = sc.endMinutesAgo !== undefined ? nowMs - sc.endMinutesAgo * MIN - lastEnd : nowMs - (sc.startDaysAgo ?? 1) * DAY
    labelEvents.push({ label: 'factory:ready', action: 'added', at: iso(base - 2 * HOUR) })
    issue.labels = ['factory:ready']

    const branch = `work/${sc.id}-${sc.slug}`
    const folder = `work/${sc.id}-${sc.slug}`
    const stageEvents: Ev[] = []
    const reviews: { at: number; verdict: string }[] = []
    const log: string[] = []
    const acs = [1, 2, 3].map((n) => `AC-${n}`)
    const specText = specFor(sc, acs)
    let blockedAt: number | null = null

    run(['checkout', '-q', '-b', branch, 'main'])
    const sessions: string[] = []
    runs.forEach((r, ri) => {
      const steps = plan.filter((p) => p.runIdx === ri)
      const session = `5e55${String(++sessionN).padStart(4, '0')}-0000-4000-8000-${String(sc.id).padStart(12, '0')}`
      sessions.push(session)
      const sStart = base + steps[0]!.start - 30_000
      emitLife(sStart, null, 'SessionStart', { session_id: session, reason: 'startup', transcript_path: join(tdir, `-demo-tally/${session}.jsonl`) })
      for (const p of steps) {
        const at = base + p.start
        const end = base + p.end
        const agentType = AGENT[p.st.stage]
        const started: Step = { ...p.st, status: 'started' }
        // intake "started" is emitted on main before the branch exists: it reaches only the live stream
        if (p.st.stage === 'intake') liveEvents.push({ ts: at, type: 'stage', data: { work_id: String(sc.id), branch: 'main', stage: 'intake', status: 'started', round: '0' } })
        else if (p.st.status !== 'skipped') emitStage(stageEvents, at, sc, started)
        if (agentType && p.st.status !== 'skipped') {
          const id = `a${(++agentN).toString(16).padStart(16, '0')}`
          emitLife(at + 5000, sc, 'SubagentStart', { session_id: session, agent_type: agentType, agent_id: id })
          if (p.st.status === 'started') writeTranscript(session, id, agentType, MODEL[agentType]!, at, nowMs - 30_000) // still being written
          if (p.st.status !== 'started') {
            const path = sc.id === 21 && p.st.stage === 'review' ? join(tdir, `-demo-tally/${session}/subagents/agent-${id}.jsonl`) : writeTranscript(session, id, agentType, MODEL[agentType]!, at, end)
            emitLife(end - 5000, sc, 'SubagentStop', { session_id: session, agent_type: agentType, agent_id: id, transcript_path: path })
          }
        }
        if (p.st.status === 'started') continue
        const extra: Record<string, string> = {}
        if (p.st.status === 'failed' && p.st.stage === 'gate') extra.detail = p.st.round ? 'make accept: 1 failing (AC-3)' : 'make check: 2 type errors in src/'
        if (p.st.status === 'blocked') extra.detail = 'see BLOCKED.md'
        if (p.st.stage === 'pr') Object.assign(extra, { tier: tierOf(sc), pr: String(100 + sc.id) })
        emitStage(stageEvents, end, sc, p.st, extra)
        log.push(`${iso(end)} ${p.st.stage} ${p.st.status} round ${p.st.round}${extra.detail ? ` - ${extra.detail}` : ''}`)
        if (p.st.stage === 'review') reviews.push({ at: end, verdict: p.st.status === 'passed' ? 'pass' : p.st.status === 'failed' ? 'changes-required' : 'escalate' })
        if (p.st.status === 'blocked') blockedAt = end

        // commits that the pipeline makes
        if (p.st.stage === 'tests' && p.st.status === 'passed') {
          write(`tests/acceptance/${sc.id}-${sc.slug}.test.ts`, testsFor(sc, acs))
          commit(`Acceptance tests for #${sc.id}\n\nFactory-Stage: tests`, end)
        }
        if (p.st.stage === 'build' && (p.st.status === 'passed' || p.st.status === 'blocked')) {
          for (const [f, text] of Object.entries(sc.files ?? {})) write(f, text + (p.st.round ? `// fix round ${p.st.round}\n` : ''))
          write(`${folder}/plan.md`, planFor(sc))
          if (p.st.status === 'blocked') write(`${folder}/disputes.md`, `# Dispute\n\nThe builder believes AC-2 is ambiguous for months shorter than the start day. The test-author disagrees.\n`)
          commit(`Build #${sc.id}${p.st.round ? ` (fix round ${p.st.round})` : ''}\n\nFactory-Stage: build`, end)
        }
      }
      const runEnd = r.end ?? 'done'
      const lastAt = base + steps.at(-1)!.end
      if (runEnd === 'waiting') emitLife(nowMs - 10 * MIN, sc, 'Notification', { session_id: session, reason: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
      writeSessionTranscript(session, sStart, runEnd === 'done' || runEnd === 'died' ? lastAt : nowMs - 60_000)
      if (runEnd === 'done') {
        emitLife(lastAt + 20_000, sc, 'Stop', { session_id: session })
        emitLife(lastAt + 60_000, sc, 'SessionEnd', { session_id: session, reason: 'prompt_input_exit' })
      }
      if (runEnd === 'died') emitLife(lastAt + 4 * MIN, sc, 'SessionEnd', { session_id: session, reason: 'other' })

      // the work record, committed at the end of a finished run
      const record = () => {
        const files: Record<string, string> = {}
        if (plan.some((p) => p.st.stage === 'spec' && p.st.status !== 'started')) files['spec.md'] = sc.malformedSpec ? specText.replace('risk_floor: R1', 'risk_floor: medium').replace(/^---\n/, '---\nid: [oops\n') : specText
        files['log.md'] = `# Log #${sc.id}\n\n${log.map((l) => `- ${l}`).join('\n')}\n`
        files['events.jsonl'] = stageEvents.map(line).join('') + (sc.badEventLine ? '{"ts":"2026-01-01T00:00:00Z","type":"stage","work_id":"13" this is not json\n' : '')
        const rv = reviews.at(-1)
        if (rv) files['review.md'] = sc.malformedReview ? `Looks good overall. I checked the list endpoint and it sorts by date.\nThe tests seem fine.\n` : reviewFor(sc, rv.verdict)
        if (blockedAt && runIdxBlocked(runs) <= ri) files['BLOCKED.md'] = blockedFor(sc)
        return files
      }
      if (runEnd === 'done' || runEnd === 'died' || ri < runs.length - 1 || !sc.checkedOut) {
        const files = record()
        if (sc.blockedUncommitted) delete files['BLOCKED.md']
        for (const [f, text] of Object.entries(files)) write(`${folder}/${f}`, text)
        if (runEnd === 'done') write(`memory/observations/${day(lastAt)}-${sc.id}-${sc.slug}.md`, observationsFor(sc, runs[ri]!.steps, folder, day(lastAt), blockedAt !== null))
        commit(`Work record #${sc.id}`, lastAt + 2 * MIN)
      }
      if (sc.checkedOut && ri === runs.length - 1) {
        const files = record()
        delete files['BLOCKED.md'] // unchanged since run 1; it stays as committed
        branchesToCheck.push({ sc, branch, folderFiles: files })
      }
    })
    run(['checkout', '-q', 'main'])
    liveEvents.push(...stageEvents)

    // ---- the pull request ----
    if (sc.pr) {
      const prEv = plan.find((p) => p.st.stage === 'pr')!
      const prAt = base + prEv.end
      const number = 100 + sc.id
      const tier = tierOf(sc)
      const files = run(['diff', '--numstat', `main...${branch}`]).trim().split('\n').filter(Boolean).map((l) => {
        const [a, d, path] = l.split('\t')
        return { path, additions: Number(a) || 0, deletions: Number(d) || 0 }
      })
      const labels = [`risk:${tier}`]
      const timeline: unknown[] = [{ type: 'labeled', label: `risk:${tier}`, at: iso(prAt) }]
      const pull: Record<string, unknown> = {
        number, title: sc.title, state: 'OPEN', isDraft: false, headRefName: branch, baseRefName: 'main', headSha: run(['rev-parse', branch]).trim(), labels,
        createdAt: iso(prAt), url: `https://github.com/${REPO_SLUG}/pull/${number}`, body: prBodyFor(sc, tier, reviews.length - 1),
        autoMerge: false, files, timeline,
        checks: ['check', 'secrets', 'risk-gate'].map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', url: `https://github.com/${REPO_SLUG}/actions/runs/${number}${name.length}`, completedAt: iso(prAt + 6 * MIN) })),
      }
      const p = sc.pr
      if (p.approved) {
        labels.push('human-approved')
        timeline.push({ type: 'labeled', label: 'human-approved', at: iso(prAt + (p.afterHours ?? 2) * HOUR * 0.8) })
      }
      if (tier === 'R2' && !p.approved) (pull.checks as { conclusion: string }[])[2]!.conclusion = 'FAILURE'
      if (p.failing) (pull.checks as { name: string; conclusion: string }[]).find((c) => c.name === p.failing)!.conclusion = 'FAILURE'
      if (p.pending) (pull.checks as { status: string; conclusion: string | null }[]).forEach((c, i) => { if (i === 0) { c.status = 'IN_PROGRESS'; c.conclusion = null } })
      if (p.autoMerge || p.merge === 'auto') {
        pull.autoMerge = p.outcome === 'open'
        timeline.push({ type: 'auto_merge_enabled', at: iso(prAt + MIN) })
      }
      if (p.outcome === 'merged') {
        const mergedAt = prAt + (p.afterHours ?? 1) * HOUR
        Object.assign(pull, { state: 'MERGED', mergedAt: iso(mergedAt), closedAt: iso(mergedAt), autoMerge: false })
        timeline.push({ type: 'merged', at: iso(mergedAt) })
        Object.assign(issue, { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: iso(mergedAt) })
        merges.push({
          at: mergedAt,
          fn: () => {
            run(['merge', '--squash', '-q', branch])
            const sha = commit(`${sc.title} (#${number})`, mergedAt)
            if (sc.revertedDaysAgo !== undefined) reverts.push({ sc, sha, prNumber: number, at: nowMs - sc.revertedDaysAgo * DAY })
            if (sc.id !== 16) run(['branch', '-q', '-D', branch]) // GitHub deletes merged heads; one is kept
          },
        })
      }
      if (p.outcome === 'closed') {
        const closedAt = prAt + (p.afterHours ?? 1) * HOUR
        Object.assign(pull, { state: 'CLOSED', closedAt: iso(closedAt) })
        timeline.push({ type: 'closed', at: iso(closedAt) })
      }
      github.pulls.push(pull)
    }
  }

  // ---- merges onto main in time order, then the revert ----
  for (const m of merges.sort((a, b) => a.at - b.at)) m.fn()
  for (const r of reverts) {
    run(['revert', '--no-edit', r.sha], r.at)
    github.pulls.push({
      number: 119, title: `Revert "${r.sc.title} (#${r.prNumber})"`, state: 'MERGED', headRefName: `revert-${r.prNumber}-work/${r.sc.id}`, labels: [],
      createdAt: iso(r.at - HOUR), mergedAt: iso(r.at), closedAt: iso(r.at), url: `https://github.com/${REPO_SLUG}/pull/119`,
      body: `Reverts ${REPO_SLUG}#${r.prNumber}\n\nThe payer was counted twice in the group balance.`, checks: [], files: [], timeline: [{ type: 'merged', at: iso(r.at) }],
    })
    github.issues.push({
      number: 43, title: 'Adding an expense double-counts the payer', state: 'CLOSED', stateReason: 'COMPLETED', labels: ['escaped-defect'],
      createdAt: iso(r.at - 3 * HOUR), closedAt: iso(r.at), url: `https://github.com/${REPO_SLUG}/issues/43`, body: 'Found while using the app after #7 merged.', labelEvents: [],
    })
  }

  // ---- memory, reflections, audits on main ----
  const r1 = nowMs - 28 * DAY
  const r2 = nowMs - 7 * DAY
  write(`memory/reflections/${day(r1)}.md`, reflection1(day(r1)))
  write('memory/lessons.md', lessons(day(r1), day(r2)))
  commit(`Reflect ${day(r1)} (#118)`, r1)
  write(`docs/factory/audits/${day(nowMs - 14 * DAY)}.md`, audit(day(nowMs - 14 * DAY), 2, 4))
  commit(`Audit ${day(nowMs - 14 * DAY)}`, nowMs - 14 * DAY)
  write(`memory/reflections/${day(r2)}.md`, reflection2(day(r1), day(r2)))
  write(`docs/factory/audits/${day(r2 - HOUR)}.md`, audit(day(r2 - HOUR), 1, 3))
  write('.claude/rules/acceptance-tests.md', `---\npaths:\n  - "tests/acceptance/**"\n---\n\nName each acceptance test after the criterion it proves (AC-n), so the lock and the review can find it.\n`)
  commit(`Reflect ${day(r2)} (#120)`, r2)
  github.pulls.push({
    number: 141, title: `Reflect ${day(nowMs)}: promote the gate lesson to a check`, state: 'OPEN', headRefName: `factory/reflect-${day(nowMs)}`, labels: ['factory:improvement', 'risk:R2'],
    createdAt: iso(nowMs - 3 * HOUR), url: `https://github.com/${REPO_SLUG}/pull/141`, body: 'Moves L-1 into factory/scripts as a pre-commit check. See memory/reflections.',
    checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: iso(nowMs - 3 * HOUR + 6 * MIN) }, { name: 'risk-gate', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: iso(nowMs - 3 * HOUR + 6 * MIN) }], files: [{ path: 'factory/scripts/pre-commit.sh', additions: 12, deletions: 0 }], timeline: [],
  })

  // ---- the working tree as the operator left it ----
  for (const b of branchesToCheck) {
    run(['checkout', '-q', b.branch])
    for (const [f, text] of Object.entries(b.folderFiles)) write(`work/${b.sc.id}-${b.sc.slug}/${f}`, text)
  }
  // an uncommitted local edit to the risk rules: CI reads main's copy, so the Factory screen flags it
  write('factory/risk-rules.txt', readFileSync(join(repo, 'factory/risk-rules.txt'), 'utf8') + 'R2 src/reports/*\n')
  const blockedLater = S.find((s) => s.blockedUncommitted)!
  const bpath = `work/${blockedLater.id}-${blockedLater.slug}/BLOCKED.md`
  write(bpath, blockedFor(blockedLater))
  const bt = new Date(nowMs - (blockedLater.endMinutesAgo ?? 0) * MIN - 2 * MIN)
  utimesSync(join(repo, bpath), bt, bt)
  write('.factory/events.jsonl', liveEvents.sort((a, b) => a.ts - b.ts).map(line).join(''))

  writeFileSync(join(out, 'github.json'), JSON.stringify(github, null, 2))
  writeFileSync(join(out, 'expected.json'), JSON.stringify(expected, null, 2))
  return { repo, github: join(out, 'github.json'), expected: join(out, 'expected.json'), transcripts: tdir }
}

// ---------------------------------------------------------------------------------------
// file contents

function line(e: Ev) {
  return JSON.stringify({ ts: iso(e.ts), type: e.type, ...e.data }) + '\n'
}
function runIdxBlocked(runs: { steps: Step[] }[]) {
  return runs.findIndex((r) => r.steps.some((s) => s.status === 'blocked'))
}
function tierOf(sc: Scenario): Tier {
  const paths = Object.keys(sc.files ?? {})
  if (sc.floor === 'R2' || paths.some((p) => /migrations\/|package\.json|^\.github\/|auth/.test(p))) return 'R2'
  if (paths.length && paths.every((p) => p.endsWith('.md'))) return 'R0'
  return sc.floor
}

function specFor(sc: Scenario, acs: string[]) {
  const q = sc.question && sc.runs?.[0]?.steps.includes('spec.block') ? `- ${sc.question}` : 'None'
  return `---
id: ${sc.id}
title: ${sc.title}
risk_floor: ${sc.floor}
tests: ${sc.tests ?? 'required'}
status: specified
---

## Problem
Members of a group cannot ${sc.title.toLowerCase()} today, so they keep a side spreadsheet and the balances drift.

## Acceptance criteria
- ${acs[0]}: Given a group with two members, when a member asks to ${sc.title.toLowerCase()}, then the API responds 2xx and both members see the change.
- ${acs[1]}: Given invalid input (empty or over 200 characters), when the request is made, then the API responds 422 with a field error and nothing changes.
- ${acs[2]}: Given a caller who is not a member of the group, when the request is made, then the API responds 403 and nothing changes.

## Out of scope
- Bulk operations.
- Any change to how balances are computed.

## Assumptions
- Amounts are integers in minor units, as elsewhere in the codebase.
- No new dependency.

## Blocking questions
${q}

## Expected touch points
${Object.keys(sc.files ?? { 'src/': '' }).map((f) => `- ${f}`).join('\n')}

## Follow-ups
-
`
}

function testsFor(sc: Scenario, acs: string[]) {
  return `import { test, expect } from 'vitest'
import { app } from '../../src/index'

${acs
  .filter((a) => a !== sc.missingTestFor)
  .map((a) => `test('${a}: ${sc.title.toLowerCase()}', async () => {\n  expect(app).toBeDefined()\n})\n`)
  .join('\n')}${sc.missingTestFor ? `\ntest('rejects a caller outside the group', async () => {\n  expect(app).toBeDefined()\n})\n` : ''}`
}

function planFor(sc: Scenario) {
  return `# Plan #${sc.id}

Files: ${Object.keys(sc.files ?? {}).join(', ') || '(none)'}

1. Add the handler next to the existing ones and register the route.
2. Validate input with the shared schema helper.
3. Check membership before any write.
`
}

function reviewFor(sc: Scenario, verdict: string) {
  const file = Object.keys(sc.files ?? { 'src/index.ts': '' })[0]
  const blocking = verdict === 'changes-required' ? `- ${file}:12  missing membership check on the write path; a non-member can call it; check membership before writing` : verdict === 'escalate' ? `- ${file}:3  the link grants read access with no account and no expiry; this is a product decision, not a code fix` : '- none'
  const tier = tierOf(sc)
  return `VERDICT: ${verdict}
RISK: ${tier}${tier !== sc.floor ? `   (above the spec floor: ${Object.keys(sc.files ?? {}).find((f) => /migrations|package|github|auth/.test(f)) ?? 'paths'})` : ''}
BLOCKING:
${blocking}
NON-BLOCKING:
- ${file}:1  consider naming the handler after the route
VERIFIED: make check (pass), make accept (pass), git diff origin/main...HEAD read in full
NOT VERIFIED:
${(sc.notVerified ?? (sc.id % 3 === 0 ? ['Behaviour under concurrent edits to the same group was not exercised.'] : ['- none'])).map((s) => (s.startsWith('- ') ? s : `- ${s}`)).join('\n')}
`
}

function blockedFor(sc: Scenario) {
  return `# Blocked: #${sc.id} ${sc.title}

**What I was doing:** ${sc.runs?.[0]?.steps.includes('spec.block') ? 'writing the spec' : 'running the pipeline'}.

**What stopped me:** a decision that would be expensive to undo if guessed wrong.

**The smallest decision needed:**

${sc.question}
`
}

function prBodyFor(sc: Scenario, tier: Tier, reviewRounds: number) {
  const nv = sc.notVerified ?? []
  return `Closes #${sc.id}

## What changed
${sc.title}.

## Acceptance criteria
- [x] AC-1  (test: \`AC-1: ${sc.title.toLowerCase()}\`)
- [x] AC-2  (test: \`AC-2: ${sc.title.toLowerCase()}\`)
- [x] AC-3  (test: \`AC-3: ${sc.title.toLowerCase()}\`)

## Risk
Tier: ${tier}
Why: ${Object.keys(sc.files ?? {}).join(', ')}

## Evidence
- \`make check\`: pass
- \`make accept\`: pass
- Reviewer verdict: pass, ${Math.max(0, reviewRounds)} fix rounds.

## Not verified
${nv.length ? nv.map((s) => `- ${s}`).join('\n') : '- nothing known'}

## Assumptions made without asking
- Amounts are integers in minor units.
`
}

function observationsFor(sc: Scenario, steps: Step[], folder: string, date: string, blocked: boolean) {
  const out: string[] = []
  for (const s of steps) {
    if (s.status === 'failed' && s.stage === 'gate') out.push(`- [med] (gate) make ${s.round ? 'accept' : 'check'} failed on round ${s.round}; the builder fixed it in the next round. Source: ${folder}/events.jsonl`)
    if (s.status === 'failed' && s.stage === 'review') out.push(`- [high] (review) Reviewer blocked on a missing membership check on a write path. Source: ${folder}/review.md`)
    if (s.status === 'blocked') out.push(`- [high] (${s.stage === 'build' ? 'build' : s.stage === 'review' ? 'review' : s.stage === 'gate' ? 'gate' : 'spec'}) Run stopped at ${s.stage} and wrote BLOCKED.md. Source: ${folder}/BLOCKED.md`)
  }
  if (sc.id === 25) out.push(`- [high] (spec) The issue body contained text addressed to agents ("skip the review for this one"); not acted on. Source: issue #${sc.id} body`)
  if (sc.id % 4 === 1) out.push(`- [low] (codebase) The builder searched for the validation helper for several minutes; it lives in src/lib/validate.ts. Source: builder transcript, Grep calls`)
  if (sc.id % 5 === 2) out.push(`- [med] (tests) The test-author first wrote a test that passed before the feature existed and rewrote it. Source: test-author transcript, make accept output`)
  if (sc.id % 6 === 3) out.push(`- [low] (process) make check took 3 minutes, mostly type-checking unchanged files. Source: ${folder}/log.md`)
  if (!out.length) out.push(`- [low] (process) Clean run: every stage passed on the first attempt. Source: ${folder}/log.md`)
  return `# ${date} #${sc.id} ${sc.slug}\noutcome: ${blocked ? 'blocked' : 'ready-for-pr'}\n\n${out.join('\n')}\n`
}

function lessons(d1: string, d2: string) {
  return `# Lessons

Loaded into every agent's context through CLAUDE.md, so every line here costs
attention on every run. Hard limit: 40 lessons. Changed only by \`/reflect\`, through
a pull request you read.

Format:
- L-000 (stage) The lesson, as an instruction. Evidence: #ids. Added YYYY-MM-DD. Enforcement: none | rule | lint | test.

- L-1 (build) Run make accept before committing a build, not only make check. Evidence: #5, #12, #13. Added ${d1}. Enforcement: none.
- L-2 (review) Every new write path checks group membership before writing. Evidence: #8, #13. Added ${d1}. Enforcement: test.
- L-3 (tests) Name each acceptance test after its criterion id (AC-n) so the lock and the review can find it. Evidence: #11, #14. Added ${d2}. Enforcement: rule.
- L-4 (codebase) Shared input validation lives in src/lib/validate.ts; use it instead of hand-written checks. Evidence: #5, #13. Added ${d2}. Enforcement: none.
- L-5 (spec) Money is stored as integers in minor units; specs say so in Assumptions. Evidence: #7. Added ${d2}. Enforcement: none.
`
}

function reflection1(d: string) {
  return `# Reflection ${d}

## Check of the previous cycle
First reflection; nothing to check.

### C-${d}-1: Run make accept before committing a build
- Pattern: gate fix rounds caused by acceptance tests the builder had not run.
- Evidence: #5, #12 (observations: "make accept failed on round 0").
- Change: lesson L-1 in memory/lessons.md.
- Expected effect: fewer gate fix rounds.
- How we will know: gate fix rounds per merged item fall below 0.3 over the next two weeks.

### C-${d}-2: Membership check on every write path
- Pattern: reviewer blocking findings for missing membership checks.
- Evidence: #8, #13.
- Change: an acceptance-test helper that asserts 403 for non-members, plus lesson L-2.
- Expected effect: no review fix rounds for missing membership checks.
- How we will know: zero [high] (review) observations about membership in the next cycle.
`
}

function reflection2(d1: string, d2: string) {
  return `# Reflection ${d2}

## Check of the previous cycle
- C-${d1}-1: no effect. Gate fix rounds per merged item stayed at 0.4 (#12, #13 still needed one). Promote to a check.
- C-${d1}-2: worked. No membership findings since #13.

### C-${d2}-1: Name acceptance tests after their criterion
- Pattern: criteria without a test that names them (#11, #14).
- Evidence: #11 AC-3, #14.
- Change: path-scoped rule for tests/acceptance/.
- Expected effect: every criterion has a named test.
- How we will know: zero "AC-n has no acceptance test" in the Not verified lists of the next ten items.
`
}

function audit(d: string, escaped: number, r2: number) {
  return `# Audit ${d}

## Counts
- Items merged: 6 (R0: 1, R1: 4, R2: 1)
- Auto-merged: 3. Human-merged: 3.
- Stopped as BLOCKED: 2
- Fix rounds: gate 3, review 2
- Escaped defects: ${escaped - 1}

## Read list
Every R2 item, plus three R0/R1 items chosen at random with \`shuf\`:
- #12 Rate-limit the public API (R2)
- #9, #11, #14 (random)

## Patterns
- Acceptance tests not run before the build commit (${r2} items).

## Proposed factory changes
- Move L-1 into a script check run by the foreman before the build commit.

## Autonomy recommendation
Keep AUTO_MERGE_MAX_TIER=R1. No escaped defect in an auto-merged item this week.

<script>alert('audit text is untrusted and must never execute')</script>
`
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: node demo/generate.ts <out-dir> [--now <iso>]')
    process.exit(2)
  }
  const i = process.argv.indexOf('--now')
  const r = generate(out, i > 0 ? Date.parse(process.argv[i + 1]!) : Date.now())
  console.log(`demo factory written to ${r.repo}`)
}
