// Schemas for everything the factory writes, plus the shared result types.
// Pure: no I/O. The web app imports these types too.
import { z } from 'zod'

export const STAGES = ['intake', 'spec', 'tests', 'build', 'gate', 'review', 'observe', 'pr'] as const
export const STATUSES = ['started', 'passed', 'failed', 'blocked', 'skipped'] as const
export const TIERS = ['R0', 'R1', 'R2', 'R3'] as const
export const VERDICTS = ['pass', 'changes-required', 'escalate'] as const

export type Stage = (typeof STAGES)[number]
export type Status = (typeof STATUSES)[number]
export type Tier = (typeof TIERS)[number]
export type Verdict = (typeof VERDICTS)[number]

export const tierRank = (t: Tier | 'none'): number => (t === 'none' ? -1 : Number(t.slice(1)))
export const maxTier = (ts: Tier[]): Tier | undefined =>
  ts.length ? ts.reduce((a, b) => (tierRank(b) > tierRank(a) ? b : a)) : undefined

// ---------- parse results ----------

export type Parsed<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; error: string; raw: string }

export interface Notice {
  level: 'info' | 'warn' | 'error'
  source: string // file path or subsystem, e.g. "work/12-x/review.md" or "github"
  message: string
  raw?: string
}

// ---------- events ----------

const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a timestamp')
// emit-event.sh writes every value as a string ("round":"0"), so numbers are coerced.
const count = z.preprocess(
  (v) => (v === undefined || v === null || v === '' ? 0 : typeof v === 'string' ? Number(v.trim()) : v),
  z.number().int().min(0),
)
const optionalNumber = z.preprocess(
  (v) => (v === undefined || v === null || v === '' ? undefined : typeof v === 'string' ? Number(v.trim().replace(/^#/, '')) : v),
  z.number().int().positive().optional(),
)
// null and missing both become an optional key (hooks write null; jq drops it)
const optionalString = z.preprocess((v) => v ?? undefined, z.string().optional())
const optionalTimestamp = z.preprocess((v) => v ?? undefined, timestamp.optional())

// Team mode's /work and /research-work name more stages. Each counts as the pipeline stage it
// stands for, and keeps its own name at the front of the detail.
export const STAGE_ALIAS: Record<string, Stage> = {
  design: 'spec', 'ui-review': 'review', security: 'review', 'db-review': 'review',
  research: 'build', 'brief-gate': 'gate', criteria: 'build', 'criteria-gate': 'gate', 'acceptance-review': 'build', 'evidence-review': 'review',
}

export const StageEventSchema = z
  .object({
    ts: timestamp,
    type: z.literal('stage'),
    work_id: z.coerce.string(),
    branch: z.string().default(''),
    stage: z.string().pipe(z.enum([...STAGES, ...(Object.keys(STAGE_ALIAS) as [string, ...string[]])])),
    status: z.enum(STATUSES),
    round: count,
    detail: optionalString,
    tier: z.enum(TIERS).optional().catch(undefined),
    pr: optionalNumber.catch(undefined),
  })
  .transform((e) => {
    const as = STAGE_ALIAS[e.stage]
    return as ? { ...e, stage: as, detail: e.detail ? `${e.stage}: ${e.detail}` : e.stage } : { ...e, stage: e.stage as Stage }
  })

export const LifecycleEventSchema = z.object({
  ts: timestamp,
  type: z.literal('lifecycle'),
  work_id: z.coerce.string().default(''),
  branch: z.string().default(''),
  event: z.string(),
  session_id: optionalString,
  agent_type: optionalString,
  agent_id: optionalString,
  transcript_path: optionalString,
  reason: optionalString,
  message: optionalString,
})

export type StageEvent = z.infer<typeof StageEventSchema> & { key: string }
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema> & { key: string }
export interface UnknownEvent {
  type: 'unknown'
  ts?: string
  key: string
  raw: string
}
export type FactoryEvent = StageEvent | LifecycleEvent | UnknownEvent

// ---------- work folder documents ----------

export const SpecFrontmatterSchema = z.object({
  id: z.coerce.string().regex(/^[A-Za-z0-9._-]+$/, "id is missing or still a placeholder"),
  title: z.string().trim().min(1).refine((s) => !s.startsWith('<'), 'title is still a placeholder'),
  risk_floor: z.enum(TIERS),
  tests: z.enum(['required', 'none']),
  status: z.coerce.string().optional(),
})

export interface Criterion {
  id: string // "AC-1"
  text: string
}

export interface Spec {
  id: string
  title: string
  risk_floor: Tier
  tests: 'required' | 'none'
  status?: string
  problem: string
  criteria: Criterion[]
  outOfScope: string[]
  assumptions: string[]
  blockingQuestions: string[]
  touchPoints: string[]
  followUps: string[]
}

export interface Finding {
  path?: string
  line?: number
  text: string
}

export interface Review {
  verdict: Verdict
  risk?: Tier
  riskWhy?: string
  blocking: Finding[]
  nonBlocking: Finding[]
  verified: string[]
  notVerified: string[]
}

export const PRIORITIES = ['high', 'med', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]

export interface Observation {
  priority: Priority
  stage: string // observer vocabulary: spec, tests, build, gate, review, process, codebase
  text: string
  source?: string
}

export interface ObservationFile {
  file: string
  date: string
  workId: string
  slug: string
  outcome?: string
  items: Observation[]
}

export interface Lesson {
  id: string
  stage: string
  text: string
  evidence: string[] // work ids
  added: string
  enforcement: string
}

export interface ReflectionChange {
  id?: string
  title: string
  pattern?: string
  evidence?: string
  change?: string
  expected?: string
  howWeWillKnow?: string
}

export interface ReflectionResult {
  id: string
  result: 'worked' | 'no effect' | 'worse' | string
  note: string
}

export interface Reflection {
  file: string
  date: string
  changes: ReflectionChange[]
  results: ReflectionResult[] // this reflection's check of earlier changes
}

// ---------- GitHub (normalised; the demo writes this shape directly) ----------

export const LabelEventSchema = z.object({
  label: z.string(),
  action: z.enum(['added', 'removed']),
  at: timestamp,
})

export const IssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: optionalString,
  labels: z.array(z.string()).default([]),
  createdAt: timestamp,
  closedAt: optionalTimestamp,
  url: z.string().default(''),
  body: z.string().default(''),
  labelEvents: z.array(LabelEventSchema).default([]),
})

export const CheckSchema = z.object({
  name: z.string(),
  status: z.string(), // COMPLETED | IN_PROGRESS | QUEUED ...
  conclusion: optionalString, // SUCCESS | FAILURE | ...
  url: optionalString,
  completedAt: optionalTimestamp,
})

export const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean().default(false),
  headRefName: z.string(),
  baseRefName: z.string().optional(), // the branch it merges into: main, or feature/<f> in team mode
  headSha: z.string().default(''),
  labels: z.array(z.string()).default([]),
  createdAt: timestamp,
  mergedAt: optionalTimestamp,
  closedAt: optionalTimestamp,
  url: z.string().default(''),
  body: z.string().default(''),
  autoMerge: z.boolean().default(false),
  merger: optionalString, // the login GitHub says merged it; for auto-merge, whoever enabled it. Agents use the same account.
  checks: z.array(CheckSchema).default([]),
  files: z.array(z.object({ path: z.string(), additions: z.number().default(0), deletions: z.number().default(0) })).default([]),
  timeline: z
    .array(z.object({ type: z.string(), label: optionalString, at: timestamp }))
    .default([]),
})

export const GitHubDataSchema = z.object({
  repo: optionalString,
  defaultBranch: optionalString, // the repository's default branch on GitHub
  issues: z.array(IssueSchema),
  pulls: z.array(PullSchema),
})

export type Issue = z.infer<typeof IssueSchema>
export type Pull = z.infer<typeof PullSchema>
export type Check = z.infer<typeof CheckSchema>
export type GitHubData = z.infer<typeof GitHubDataSchema>

export interface GitHubStatus {
  state: 'fresh' | 'stale' | 'unavailable'
  fetchedAt?: string
  error?: string
}

export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped'
/** Each check's current run: a check can run more than once on the same head (a re-run, or risk-gate on the label).
 *  By date (a pending status from GitHub carries one; it wins a tie); an undated run still going is the newest;
 *  of undated results, a pass (a re-run that passed). */
export function currentChecks(checks: Check[]): Check[] {
  const at = (c: Check) => Date.parse(c.completedAt ?? '') || 0
  const key = (c: Check) => (checkState(c) === 'pending' ? (at(c) ? at(c) * 2 + 1 : Infinity) : at(c) * 2 + (checkState(c) === 'pass' ? 1 : 0))
  const cur = new Map<string, Check>()
  for (const c of checks) if (!cur.has(c.name) || key(c) > key(cur.get(c.name)!)) cur.set(c.name, c)
  return [...cur.values()]
}

/** A pull request's checks as every surface reads them (the PR helper, the item's state): each check's current run.
 *  R2: risk-gate fails until the human-approved label and CI re-runs it on the label, so a red gate before the label
 *  is expected, and one from before the latest label is a rerun still to come (pending), until a newer result lands. */
export function prChecks(p: Pull, tier: Tier | undefined): { failing: string[]; pending: string[]; rerun: boolean } {
  const r2 = !!tier && tierRank(tier) >= 2
  const approved = p.labels.includes('human-approved')
  const approvedAt = p.timeline.filter((x) => x.type === 'labeled' && x.label === 'human-approved').at(-1)?.at
  const out = { failing: [] as string[], pending: [] as string[], rerun: false }
  for (const c of currentChecks(p.checks)) {
    const st = checkState(c)
    if (r2 && c.name === 'risk-gate' && st === 'fail') {
      if (!approved) continue
      if (approvedAt && c.completedAt && Date.parse(c.completedAt) < Date.parse(approvedAt)) {
        out.pending.push(c.name)
        out.rerun = true
        continue
      }
    }
    if (st === 'fail') out.failing.push(c.name)
    else if (st === 'pending') out.pending.push(c.name)
  }
  return out
}
/** What a PR waits for while its checks run, in words. */
export const checksWait = (c: { pending: string[]; rerun: boolean }) => (c.rerun ? 'the risk-gate rerun after the label' : c.pending.join(', '))

export function checkState(c: Check): CheckState {
  if (c.status !== 'COMPLETED') return 'pending'
  switch (c.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
      return 'pass'
    case 'SKIPPED':
      return 'skipped'
    default:
      return 'fail'
  }
}
