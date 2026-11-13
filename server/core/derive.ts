// Turns files and events into item state: which stage, which round, waiting on whom.
// Pure functions only. Every input may be partial or contradictory; contradictions resolve
// to a state plus a visible notice, never an exception. Rules are documented in docs/DESIGN.md §5.
import { blockedSummary, parseReview, parseSpec, prNotVerified } from './parse.ts'
import { classify, type FileRisk, type RiskRule } from './risk.ts'
import {
  STAGES,
  checkState,
  maxTier,
  tierRank,
  type Check,
  type Issue,
  type LifecycleEvent,
  type Notice,
  type Parsed,
  type Pull,
  type Review,
  type Spec,
  type Stage,
  type StageEvent,
  type Tier,
} from './types.ts'

// ---------- inputs ----------

export type WorkFileName = 'spec.md' | 'plan.md' | 'log.md' | 'review.md' | 'disputes.md' | 'BLOCKED.md'
export const WORK_FILES: WorkFileName[] = ['spec.md', 'plan.md', 'log.md', 'review.md', 'disputes.md', 'BLOCKED.md']

export interface WorkFile {
  path: string // repo-relative
  text: string
  time: string // worktree: mtime; committed: time of the last commit that touched it
  origin: 'worktree' | 'branch' | 'main'
}

export interface TestRef {
  ac: string // "AC-1"
  file: string
  line: number
  text: string
}

export interface ItemInputs {
  id: string
  slug?: string
  files: Partial<Record<WorkFileName, WorkFile>>
  stageEvents: StageEvent[] // deduplicated, any order
  lifecycle: LifecycleEvent[] // events whose work_id is this item
  issue?: Issue
  pull?: Pull
  branch?: string // work/<id>-<slug> if it exists locally or on origin
  onMain?: { at: string; sha?: string } // the work folder is in main's tree (merged)
  changedFiles?: string[] // vs main: branch diff, PR files or the squash commit
  testRefs?: TestRef[]
  revertedBy?: { at: string; ref: string; title: string }
  notices: Notice[]
}

export interface Session {
  id: string
  start?: string
  end?: string
  last: LifecycleEvent
  transcriptPath?: string // the main session transcript, from SessionStart
  workId?: string // the item it last worked on
}

export interface AgentRun {
  agentId: string
  agentType: string // a subagent type, or "foreman" for the main session
  sessionId?: string
  workId: string
  stage?: Stage
  start?: string
  end?: string
  transcriptPath?: string
  outcome: 'running' | 'finished' | 'abandoned'
}

export interface Context {
  now: number
  staleMinutes: number
  autoMergeMax: Tier | 'none'
  rules: RiskRule[]
  sessions: Map<string, Session>
  runs: AgentRun[]
}

// ---------- outputs ----------

export type State =
  | 'proposed'
  | 'ready'
  | 'in-progress'
  | 'pr-open'
  | 'awaiting-approval'
  | 'awaiting-merge'
  | 'blocked'
  | 'failed'
  | 'closed'
  | 'merged'
export type Column = 'proposed' | 'ready' | 'in-progress' | 'pr-open' | 'waiting' | 'merged' | 'stopped'
export type NeedsKind = 'answer' | 'approve' | 'failed' | 'waiting-input' | 'quiet' | 'merge'
export type Flag = 'live' | 'quiet' | 'waiting-input' | 'reverted' | 'stale-blocked'
export const NEEDS_ORDER: NeedsKind[] = ['answer', 'approve', 'failed', 'waiting-input', 'quiet', 'merge']
export const COLUMNS: Column[] = ['proposed', 'ready', 'in-progress', 'pr-open', 'waiting', 'stopped', 'merged']

const COLUMN_OF: Record<State, Column> = {
  proposed: 'proposed',
  ready: 'ready',
  'in-progress': 'in-progress',
  'pr-open': 'pr-open',
  'awaiting-approval': 'waiting',
  'awaiting-merge': 'waiting',
  blocked: 'stopped',
  failed: 'stopped',
  closed: 'stopped',
  merged: 'merged',
}

export interface Attempt {
  round: number
  start?: string
  end?: string
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'skipped'
  detail?: string
}

export interface StageView {
  stage: Stage
  status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped'
  rounds: number // highest fix round seen (0 = first attempt only)
  attempts: Attempt[]
  durationMs?: number
}

export interface TierSource {
  source: 'spec' | 'paths' | 'pr-label' | 'pr-event' | 'review'
  tier: Tier
  why?: string
}

export interface Needs {
  kind: NeedsKind
  summary: string
  since: string
}

export interface NotVerified {
  text: string
  source: string
}

export interface ItemView {
  id: string
  slug?: string
  title: string
  state: State
  column: Column
  reason: string // which rule decided the state, in words
  needs?: Needs
  flags: Flag[]
  since?: string // entered the current state
  stage?: Stage // current or last pipeline stage
  stageStatus?: StageView['status']
  round: number // round of the current stage
  fixRounds: number // failures that triggered a fix round
  fixByStage: Partial<Record<Stage, number>>
  stages: StageView[]
  tier?: Tier
  tierSources: TierSource[]
  riskFiles: FileRisk[] // per-file classification of the change
  pr?: { number: number; url: string; state: Pull['state']; approved: boolean; autoMerge: boolean }
  issue?: { number: number; url: string; state: Issue['state'] }
  branch?: string
  live?: { agentType: string; since?: string }
  mergedAt?: string
  readyAt?: string
  mergedBy?: 'auto' | 'human'
  firstPass?: boolean
  reverted?: ItemInputs['revertedBy']
  spec?: Parsed<Spec>
  review?: Parsed<Review>
  blocked?: { text: string; summary: string; time: string; stale: boolean; path: string }
  notVerified: NotVerified[]
  pipelineRuns: PipelineRun[]
  testRefs: TestRef[]
  files: ItemInputs['files']
  lastActivity?: string
  notices: Notice[]
}

// ---------- helpers ----------

const t = (s: string | undefined) => (s ? Date.parse(s) : NaN)
const byTime = <T extends { ts: string }>(a: T, b: T) => t(a.ts) - t(b.ts)
const fmtMin = (ms: number) => `${Math.round(ms / 60000)} min`
export const AGENT_STAGE: Record<string, Stage> = {
  'spec-writer': 'spec',
  'test-author': 'tests',
  builder: 'build',
  reviewer: 'review',
  observer: 'observe',
}

/** Stable sort by timestamp; events with equal timestamps keep their file order. */
export function sortEvents<T extends { ts: string }>(evs: T[]): T[] {
  return evs.map((e, i) => [e, i] as const).sort((a, b) => byTime(a[0], b[0]) || a[1] - b[1]).map(([e]) => e)
}

// ---------- lifecycle: sessions and agent runs ----------

export function indexLifecycle(events: LifecycleEvent[]): { sessions: Map<string, Session>; runs: AgentRun[] } {
  const sessions = new Map<string, Session>()
  const runs: AgentRun[] = []
  const open = new Map<string, AgentRun>()
  for (const e of sortEvents(events)) {
    if (e.session_id) {
      const s = sessions.get(e.session_id) ?? { id: e.session_id, last: e }
      s.last = e
      if (e.work_id) s.workId = e.work_id
      if (e.event === 'SessionStart' && !s.start) s.start = e.ts
      if (e.event === 'SessionStart' && e.transcript_path) s.transcriptPath ??= e.transcript_path
      if (e.event === 'SessionEnd') s.end = e.ts
      if (e.event === 'SessionStart' && s.end && t(e.ts) > t(s.end)) s.end = undefined // resumed
      sessions.set(e.session_id, s)
    }
    const key = e.agent_id ?? `${e.session_id ?? ''}:${e.agent_type ?? ''}`
    if (e.event === 'SubagentStart') {
      const run: AgentRun = {
        agentId: e.agent_id ?? key,
        agentType: e.agent_type ?? 'unknown',
        sessionId: e.session_id,
        workId: e.work_id,
        stage: AGENT_STAGE[e.agent_type ?? ''],
        start: e.ts,
        outcome: 'running',
      }
      open.set(key, run)
      runs.push(run)
    } else if (e.event === 'SubagentStop') {
      let run = open.get(key)
      if (!run) {
        run = { agentId: e.agent_id ?? key, agentType: e.agent_type ?? 'unknown', sessionId: e.session_id, workId: e.work_id, stage: AGENT_STAGE[e.agent_type ?? ''], outcome: 'finished' }
        runs.push(run)
      }
      open.delete(key)
      run.end = e.ts
      run.outcome = 'finished'
      run.transcriptPath = e.transcript_path ?? run.transcriptPath
      if (!run.workId) run.workId = e.work_id
    }
  }
  for (const run of open.values()) {
    const s = run.sessionId ? sessions.get(run.sessionId) : undefined
    if (s?.end && t(s.end) >= t(run.start)) run.outcome = 'abandoned'
    // a running subagent's transcript is already being written next to the session's
    if (s?.transcriptPath && run.agentId) run.transcriptPath = s.transcriptPath.replace(/\.jsonl$/, `/subagents/agent-${run.agentId}.jsonl`)
  }
  // the main session is the foreman's run
  for (const s of sessions.values()) {
    runs.push({ agentId: `session:${s.id}`, agentType: 'foreman', sessionId: s.id, workId: s.workId ?? '', start: s.start, end: s.end, transcriptPath: s.transcriptPath, outcome: s.end ? 'finished' : 'running' })
  }
  return { sessions, runs }
}

/** The status of the stage an agent run served: the first terminal event for it after the run started. */
export function stageResult(run: AgentRun, events: StageEvent[]): StageView['status'] | undefined {
  if (!run.stage) return undefined
  const e = sortEvents(events).find((x) => x.work_id === run.workId && x.stage === run.stage && x.status !== 'started' && t(x.ts) >= t(run.start) - 1000)
  return e ? (e.status as StageView['status']) : run.outcome === 'running' ? 'running' : undefined
}

export interface PipelineRun {
  start: string
  end: string
  outcome: 'pr' | 'blocked' | 'failed' | 'abandoned' | 'running'
  stage?: Stage // where a blocked or failed run stopped
}

/** Split an item's events into /work invocations: each run starts at an intake event. */
export function pipelineRuns(events: StageEvent[], itemState: State): PipelineRun[] {
  const sorted = sortEvents(events)
  const groups: StageEvent[][] = []
  for (const e of sorted) {
    const startsRun = e.stage === 'intake' && (e.status === 'started' || !groups.at(-1)?.some((x) => x.stage === 'intake'))
    if (startsRun || !groups.length) groups.push([])
    groups.at(-1)!.push(e)
  }
  return groups.map((g, i) => {
    const last = i === groups.length - 1
    const pipe = g.filter((e) => e.stage !== 'observe')
    const blocked = pipe.find((e) => e.status === 'blocked')
    const outcome: PipelineRun['outcome'] = g.some((e) => e.stage === 'pr' && e.status === 'passed')
      ? 'pr'
      : blocked
        ? 'blocked'
        : last && itemState === 'failed'
          ? 'failed'
          : last && itemState === 'in-progress'
            ? 'running'
            : last && itemState === 'blocked'
              ? 'blocked'
              : 'abandoned'
    return { start: g[0]!.ts, end: g.at(-1)!.ts, outcome, stage: outcome === 'pr' || outcome === 'running' ? undefined : (blocked ?? pipe.at(-1))?.stage }
  })
}

// ---------- stages ----------

export function buildStages(events: StageEvent[]): StageView[] {
  return STAGES.map((stage) => {
    const evs = events.filter((e) => e.stage === stage)
    const attempts: Attempt[] = []
    for (const e of evs) {
      if (e.status === 'started') {
        attempts.push({ round: e.round, start: e.ts, status: 'running', detail: e.detail })
        continue
      }
      // a terminal event closes the latest open attempt of this stage, or stands alone
      let a = [...attempts].reverse().find((x) => x.status === 'running' && x.round === e.round) ?? [...attempts].reverse().find((x) => x.status === 'running')
      if (!a) {
        a = { round: e.round, status: 'running' }
        attempts.push(a)
      }
      a.end = e.ts
      a.status = e.status
      if (e.detail) a.detail = e.detail
    }
    const last = evs.at(-1)
    const durations = attempts.filter((a) => a.start && a.end).map((a) => t(a.end) - t(a.start))
    return {
      stage,
      status: last ? (last.status === 'started' ? 'running' : last.status) : 'pending',
      rounds: evs.reduce((m, e) => Math.max(m, e.round), 0),
      attempts,
      durationMs: durations.length ? durations.reduce((a, b) => a + b, 0) : undefined,
    }
  })
}

// ---------- the item ----------

export function deriveItem(inp: ItemInputs, ctx: Context): ItemView | null {
  const notices: Notice[] = [...inp.notices]
  const note = (message: string, level: Notice['level'] = 'warn', source = `item #${inp.id}`) => notices.push({ level, source, message })
  const events = sortEvents(inp.stageEvents)
  const lifecycle = sortEvents(inp.lifecycle)
  const issue = inp.issue
  const pr = inp.pull
  const isFactoryIssue = !!issue?.labels.some((l) => l === 'factory:proposed' || l === 'factory:ready')
  const hasWork = events.length > 0 || lifecycle.length > 0 || !!inp.branch || !!inp.onMain || Object.keys(inp.files).length > 0 || !!pr
  if (!isFactoryIssue && !hasWork) return null

  // documents
  const spec = inp.files['spec.md'] ? parseSpec(inp.files['spec.md'].text) : undefined
  const review = inp.files['review.md'] ? parseReview(inp.files['review.md'].text) : undefined
  if (spec && !spec.ok) note(`could not parse spec.md: ${spec.error}`, 'error', inp.files['spec.md']!.path)
  if (spec?.ok) spec.warnings.forEach((w) => note(`spec.md: ${w}`, 'warn', inp.files['spec.md']!.path))
  if (review && !review.ok) note(`could not parse review.md: ${review.error}`, 'error', inp.files['review.md']!.path)
  if (review?.ok) review.warnings.forEach((w) => note(`review.md: ${w}`, 'warn', inp.files['review.md']!.path))
  if (spec?.ok && spec.value.id !== inp.id) note(`spec.md says id ${spec.value.id} but the folder is #${inp.id}`)

  // stages and rounds
  const stages = buildStages(events)
  // A fix round is triggered by a failure; it is charged to the stage that failed. (Round
  // numbers propagate: one review fix re-runs build, gate and review, so summing them triple-counts.)
  const fixByStage: Partial<Record<Stage, number>> = {}
  for (const e of events) if (e.status === 'failed') fixByStage[e.stage] = (fixByStage[e.stage] ?? 0) + 1
  const fixRounds = Object.values(fixByStage).reduce((a, b) => a + b, 0)
  const pipeline = events.filter((e) => e.stage !== 'observe') // the observer runs after every stop, so it never decides state
  const lastPipe = pipeline.at(-1)
  const lastStage = lastPipe ?? events.at(-1)
  const activityTimes = [...events.map((e) => t(e.ts)), ...lifecycle.map((e) => t(e.ts))].filter((x) => !Number.isNaN(x))
  const lastActivity = activityTimes.length ? Math.max(...activityTimes) : undefined
  const idleMs = lastActivity !== undefined ? ctx.now - lastActivity : Infinity
  const stale = ctx.staleMinutes * 60000

  // session and live agent for this item
  const itemRuns = ctx.runs.filter((r) => r.workId === inp.id && r.agentType !== 'foreman')
  const liveRun = itemRuns.filter((r) => r.outcome === 'running').at(-1)
  const lastLife = lifecycle.filter((e) => e.session_id).at(-1)
  const session = lastLife?.session_id ? ctx.sessions.get(lastLife.session_id) : undefined
  const sessionEndedAfter = (ts: string | undefined) => !!session?.end && t(session.end) >= t(ts)

  // tier: the highest source wins; nothing lowers it
  const tierSources: TierSource[] = []
  if (spec?.ok) tierSources.push({ source: 'spec', tier: spec.value.risk_floor, why: 'risk_floor' })
  const risk = inp.changedFiles?.length ? classify(inp.changedFiles, ctx.rules) : undefined
  if (risk) {
    const top = risk.files.filter((f) => f.tier === risk.tier)
    tierSources.push({ source: 'paths', tier: risk.tier, why: top.slice(0, 3).map((f) => `${f.path} (${f.pattern ?? 'no rule'})`).join(', ') + (top.length > 3 ? `, +${top.length - 3} more` : '') })
  }
  const label = pr?.labels.map((l) => /^risk:(R[0-3])$/.exec(l)?.[1]).find(Boolean) as Tier | undefined
  if (label) tierSources.push({ source: 'pr-label', tier: label })
  const evTier = [...events].reverse().find((e) => e.tier)?.tier
  if (evTier) tierSources.push({ source: 'pr-event', tier: evTier })
  if (review?.ok && review.value.risk) tierSources.push({ source: 'review', tier: review.value.risk, why: review.value.riskWhy })
  const tier = maxTier(tierSources.map((s) => s.tier))

  // BLOCKED.md and its freshness
  const bf = inp.files['BLOCKED.md']
  const startedAfter = (ts: string) => events.some((e) => e.status === 'started' && e.stage !== 'observe' && t(e.ts) > t(ts))
  const blocked = bf ? { text: bf.text, summary: blockedSummary(bf.text), time: bf.time, stale: startedAfter(bf.time), path: bf.path } : undefined
  if (blocked?.stale) note('BLOCKED.md is older than later stage events; treating it as answered')

  // pull request facts
  const approved = !!pr?.labels.includes('human-approved')
  // risk-gate fails every R2 pull request until it is approved, and CI re-runs it on the label.
  // So a failing risk-gate is expected before approval, and out of date if it finished before it.
  const approvedAt = pr?.timeline.filter((x) => x.type === 'labeled' && x.label === 'human-approved').at(-1)?.at
  const gateRerun = (c: Check) => c.name === 'risk-gate' && tierRank(tier ?? 'R0') >= 2 && (!approved || (!!approvedAt && !!c.completedAt && t(c.completedAt) < t(approvedAt)))
  const failingChecks = (pr?.checks ?? []).filter((c) => checkState(c) === 'fail' && !gateRerun(c))
  const readyAt = issue?.labelEvents.filter((e) => e.label === 'factory:ready' && e.action === 'added').at(0)?.at ?? events.find((e) => e.stage === 'intake')?.ts
  let mergedBy: ItemView['mergedBy']
  if (pr?.state === 'MERGED') mergedBy = approved || !pr.timeline.some((x) => x.type === 'auto_merge_enabled') ? 'human' : 'auto'

  // ---------- the state rules, first match wins (DESIGN.md §5) ----------
  let state: State
  let reason: string
  let since: string | undefined
  let needs: Needs | undefined
  const flags: Flag[] = []
  const stageName = lastStage ? `${lastStage.stage}${lastStage.round ? ` r${lastStage.round}` : ''}` : 'intake'
  const lastTs = lastStage?.ts

  const merged = pr?.state === 'MERGED' || (pr?.state !== 'OPEN' && pr?.state !== 'CLOSED' && !!inp.onMain)
  if (pr?.state === 'OPEN' && inp.onMain) note('the work folder is on main but the pull request is still open')
  if (merged) {
    state = 'merged'
    since = pr?.mergedAt ?? inp.onMain?.at
    reason = pr?.state === 'MERGED' ? `PR #${pr.number} merged` : 'work folder is on main (GitHub data unavailable)'
    if (since && events.some((e) => e.stage !== 'observe' && t(e.ts) > t(since) + 60000)) note('stage events were recorded after the merge')
  } else if (
    (pr?.state === 'CLOSED' && !events.some((e) => t(e.ts) > t(pr.closedAt))) ||
    (issue?.state === 'CLOSED' && pr?.state !== 'OPEN' && !events.some((e) => t(e.ts) > t(issue.closedAt)))
  ) {
    state = 'closed'
    since = pr?.state === 'CLOSED' ? pr.closedAt : issue?.closedAt
    reason = pr?.state === 'CLOSED' ? `PR #${pr.number} closed without merging` : `issue closed${issue?.stateReason ? ` (${issue.stateReason.toLowerCase().replace('_', ' ')})` : ''}`
  } else if ((blocked && !blocked.stale) || (lastPipe?.status === 'blocked' && pr?.state !== 'OPEN')) {
    state = 'blocked'
    const ev = [...pipeline].reverse().find((e) => e.status === 'blocked')
    since = blocked && !blocked.stale ? blocked.time : ev?.ts
    const summary = blocked && !blocked.stale ? blocked.summary : ev?.detail ?? 'blocked (no BLOCKED.md found and no detail on the event)'
    if (!blocked || blocked.stale) note('a blocked event was recorded but there is no current BLOCKED.md; the question comes from the event')
    reason = `stopped at ${ev?.stage ?? lastStage?.stage ?? 'unknown stage'} and wrote BLOCKED.md`
    needs = { kind: 'answer', summary, since: since ?? '' }
  } else if (pr?.state === 'OPEN' && failingChecks.length) {
    state = 'failed'
    since = pr.createdAt
    reason = `CI check${failingChecks.length > 1 ? 's' : ''} failing on PR #${pr.number}`
    needs = { kind: 'failed', summary: `CI failing: ${failingChecks.map((c) => c.name).join(', ')}`, since }
  } else if (pr?.state === 'OPEN' && tierRank(tier ?? 'R0') >= 2 && !approved) {
    state = 'awaiting-approval'
    since = pr.createdAt
    reason = `${tier} pull request without the human-approved label`
    const high = tierSources.filter((s) => tierRank(s.tier) >= 2)
    const why =
      high.find((s) => s.source === 'paths')?.why ??
      (high.some((s) => s.source === 'spec') ? 'spec risk_floor' : undefined) ??
      (high.find((s) => s.source === 'review') ? `reviewer: ${high.find((s) => s.source === 'review')!.why ?? 'assessed ' + tier}` : 'PR label')
    const verdict = review?.ok ? `review: ${review.value.verdict}` : review ? 'review.md unparseable' : 'no review.md'
    needs = { kind: 'approve', summary: `${tier} · ${why} · ${verdict}`, since }
  } else if (pr?.state === 'OPEN' && !pr.isDraft && !pr.autoMerge) {
    // Without auto-merge nothing will merge it but you. The policy only explains why.
    state = 'awaiting-merge'
    since = pr.createdAt
    const why = approved
      ? 'approved, not merged'
      : tierRank(tier ?? 'R1') > tierRank(ctx.autoMergeMax)
        ? `${tier ?? 'tier unknown'} is above AUTO_MERGE_MAX_TIER=${ctx.autoMergeMax}`
        : 'auto-merge was not enabled'
    reason = `PR #${pr.number} open; ${why}`
    const checks = pr.checks.length ? (pr.checks.every((c) => checkState(c) === 'pass' || checkState(c) === 'skipped') ? 'checks passing' : 'checks pending') : 'no checks reported'
    needs = { kind: 'merge', summary: `${tier ?? '?'} · ${checks} · ${why}`, since }
  } else if (pr?.state === 'OPEN' || (!pr && lastPipe?.stage === 'pr' && lastPipe.status === 'passed')) {
    state = 'pr-open'
    since = pr?.createdAt ?? lastPipe?.ts
    reason = pr ? `PR #${pr.number} open with auto-merge` : `pr stage passed${lastPipe?.pr ? ` (PR #${lastPipe.pr})` : ''}; no GitHub data for it`
  } else if (lastPipe?.status === 'failed' && (idleMs > stale || sessionEndedAfter(lastPipe.ts))) {
    state = 'failed'
    since = lastPipe.ts
    reason = `${stageName} failed and the run did not continue`
    needs = { kind: 'failed', summary: `${stageName} failed${lastPipe.detail ? `: ${lastPipe.detail}` : ''}`, since }
  } else if (lastStage && !(lastStage.stage === 'pr' && lastStage.status === 'passed') && sessionEndedAfter(lastStage.ts) && !liveRun) {
    state = 'failed'
    since = session?.end
    reason = `the Claude Code session ended during ${stageName}`
    needs = { kind: 'failed', summary: `session ended during ${stageName} (${lastStage.status}) without a pull request or BLOCKED.md`, since: since ?? '' }
  } else if (events.length || lifecycle.length || inp.branch) {
    state = 'in-progress'
    const cur = [...events].reverse().find((e) => e.stage === lastStage?.stage && e.status === 'started')
    since = cur?.ts ?? lastTs
    reason = lastStage ? `last event: ${lastStage.stage} ${lastStage.status}` : 'branch exists, no stage events yet'
    const last = session && !session.end ? session.last : undefined
    // A Notification stays "current" until the next hook event, because nothing records the
    // prompt being answered (data-contract proposal 14).
    const waiting = last && t(last.ts) >= t(lastTs) && ((last.event === 'Notification' && last.reason !== 'auth_success') || (last.event === 'Stop' && !liveRun))
    if (waiting) {
      flags.push('waiting-input')
      needs = {
        kind: 'waiting-input',
        summary: last.event === 'Notification' ? `Claude Code is waiting: ${last.message ?? last.reason ?? 'notification'}` : `Claude Code ended its turn during ${stageName}; it is waiting in the terminal`,
        since: last.ts,
      }
    } else if (idleMs > stale) {
      flags.push('quiet')
      needs = { kind: 'quiet', summary: `no event for ${fmtMin(idleMs)} during ${stageName}${liveRun ? ` (${liveRun.agentType} still open)` : ''}`, since: new Date(lastActivity ?? ctx.now).toISOString() }
    }
  } else if (issue?.labels.includes('factory:ready')) {
    state = 'ready'
    since = readyAt ?? issue.createdAt
    reason = 'issue labelled factory:ready'
  } else {
    state = 'proposed'
    since = issue?.labelEvents.find((e) => e.label === 'factory:proposed')?.at ?? issue?.createdAt
    reason = 'issue labelled factory:proposed'
  }

  if (liveRun && session && !session.end && ['in-progress', 'blocked', 'failed'].includes(state)) flags.push('live')
  if (blocked?.stale) flags.push('stale-blocked')
  if (inp.revertedBy) flags.push('reverted')
  if (issue && isFactoryIssue && hasWork && state !== 'merged' && state !== 'closed' && issue.labels.includes('factory:proposed') && !issue.labels.includes('factory:ready') && events.length) {
    note('issue is only labelled factory:proposed but stage events exist; the events win', 'info')
  }

  // what nobody verified
  const notVerified: NotVerified[] = []
  if (review?.ok) review.value.notVerified.forEach((text) => notVerified.push({ text, source: 'review.md' }))
  if (review && !review.ok) notVerified.push({ text: 'review.md could not be parsed, so nothing in it can be relied on', source: 'review.md' })
  if (pr) prNotVerified(pr.body).forEach((text) => notVerified.push({ text, source: `PR #${pr.number} body` }))
  const testRefs = inp.testRefs ?? []
  if (spec?.ok && spec.value.tests === 'none') notVerified.push({ text: 'acceptance tests were skipped (spec says tests: none)', source: 'spec.md' })
  else if (spec?.ok && stages.find((s) => s.stage === 'tests')?.status === 'passed') {
    for (const c of spec.value.criteria) {
      if (!testRefs.some((r) => r.ac === c.id)) notVerified.push({ text: `${c.id} has no acceptance test that names it`, source: 'tests/acceptance' })
    }
  }
  if ((state === 'merged' || pr) && !review) notVerified.push({ text: 'no review.md: the independent review is not on record', source: 'work folder' })
  // the PR body usually repeats the review's list: one line per point, every source named
  const seenNv = new Map<string, NotVerified>()
  for (const n of notVerified.splice(0)) {
    const k = n.text.toLowerCase().replace(/[\s.]+$/g, '').replace(/\s+/g, ' ')
    const prev = seenNv.get(k)
    if (prev) prev.source += `, ${n.source}`
    else seenNv.set(k, { ...n })
  }
  notVerified.push(...seenNv.values())

  const title = (spec?.ok && spec.value.title) || issue?.title || pr?.title || inp.slug || `#${inp.id}`
  const curStage = lastStage ? stages.find((s) => s.stage === lastStage.stage) : undefined
  return {
    id: inp.id,
    slug: inp.slug,
    title,
    state,
    column: COLUMN_OF[state],
    reason,
    needs,
    flags,
    since,
    stage: lastStage?.stage,
    stageStatus: curStage?.status,
    round: lastStage?.round ?? 0,
    fixRounds,
    fixByStage,
    stages,
    tier,
    tierSources,
    riskFiles: risk?.files ?? [],
    pr: pr ? { number: pr.number, url: pr.url, state: pr.state, approved, autoMerge: pr.autoMerge } : undefined,
    issue: issue ? { number: issue.number, url: issue.url, state: issue.state } : undefined,
    branch: inp.branch,
    live: liveRun && flags.includes('live') ? { agentType: liveRun.agentType, since: liveRun.start } : undefined,
    mergedAt: state === 'merged' ? since : undefined,
    readyAt,
    mergedBy,
    firstPass: state === 'merged' ? fixRounds === 0 : undefined,
    reverted: inp.revertedBy,
    spec,
    review,
    blocked,
    notVerified,
    pipelineRuns: pipelineRuns(events, state),
    testRefs,
    files: inp.files,
    lastActivity: lastActivity !== undefined ? new Date(lastActivity).toISOString() : undefined,
    notices,
  }
}

// ---------- the whole factory ----------

export interface RunningEntry {
  workId: string
  title: string
  stage?: Stage
  agentType: string
  since?: string
}

export interface NeedsEntry extends Needs {
  id: string
  title: string
  tier?: Tier
  stage?: Stage
  label?: string // shown instead of "#id" for entries that are not work items (an improvement PR)
  href?: string // where the row goes, instead of the item page
}

/** Needs-you order: by kind, then oldest first. */
export const byNeeds = (a: Needs, b: Needs) => NEEDS_ORDER.indexOf(a.kind) - NEEDS_ORDER.indexOf(b.kind) || t(a.since) - t(b.since)

export function deriveAll(inputs: ItemInputs[], ctx: Context) {
  const items = inputs.map((i) => deriveItem(i, ctx)).filter((x): x is ItemView => x !== null)
  items.sort((a, b) => Number(b.id) - Number(a.id) || a.id.localeCompare(b.id))
  const needsYou: NeedsEntry[] = items
    .filter((i) => i.needs)
    .map((i) => ({ ...i.needs!, id: i.id, title: i.title, tier: i.tier, stage: i.stage }))
    .sort(byNeeds)
  const byId = new Map(items.map((i) => [i.id, i]))
  const running: RunningEntry[] = []
  for (const i of items) {
    if (i.live) running.push({ workId: i.id, title: i.title, stage: i.stage, agentType: i.live.agentType, since: i.live.since })
    else if (i.state === 'in-progress' && i.stageStatus === 'running' && !i.flags.includes('quiet') && !i.flags.includes('waiting-input')) {
      running.push({ workId: i.id, title: i.title, stage: i.stage, agentType: 'foreman', since: i.since })
    }
  }
  return { items, needsYou, running, byId }
}
