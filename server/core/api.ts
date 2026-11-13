// The JSON the server sends. Pure types plus the summary projection, shared with the web app.
import type { AgentRun, ItemView, NeedsEntry, RunningEntry } from './derive.ts'
import type { Check, GitHubStatus, LifecycleEvent, Notice, ObservationFile, StageEvent, Tier } from './types.ts'
import type { FileRisk } from './risk.ts'

/** What the board and lists need; the full item comes from /api/items/:id. */
export function summary(i: ItemView) {
  return {
    id: i.id, slug: i.slug, title: i.title, state: i.state, column: i.column, reason: i.reason, needs: i.needs, flags: i.flags, since: i.since,
    stage: i.stage, stageStatus: i.stageStatus, round: i.round, fixRounds: i.fixRounds, fixByStage: i.fixByStage, tier: i.tier, pr: i.pr, issue: i.issue,
    branch: i.branch, live: i.live, mergedAt: i.mergedAt, readyAt: i.readyAt, mergedBy: i.mergedBy, firstPass: i.firstPass, reverted: i.reverted,
    lastActivity: i.lastActivity, notices: i.notices.length, errors: i.notices.filter((n) => n.level === 'error').length, notVerified: i.notVerified.length,
    stages: i.stages.map((s) => ({ stage: s.stage, status: s.status, rounds: s.rounds })),
  }
}
export type ItemSummary = ReturnType<typeof summary>

export interface ApiState {
  version: number
  factory: { repo: string; demo: boolean; isGit: boolean; head: string | null; main: string | null; autoMergeMax: Tier | 'none'; staleMinutes: number; actions: boolean }
  github: GitHubStatus & { repo?: string }
  items: ItemSummary[]
  needsYou: NeedsEntry[]
  running: RunningEntry[]
  notices: Notice[]
  now: number
}

export interface BranchCommit {
  sha: string
  time: string
  subject: string
  stage?: string // the Factory-Stage trailer
}

export interface ItemDetail extends ItemView {
  events: (StageEvent | LifecycleEvent)[]
  runs: AgentRun[]
  observations: ObservationFile[]
  commits: BranchCommit[]
  changes: (FileRisk & { additions?: number; deletions?: number })[]
  checks: Check[]
  prBody?: string
  issueBody?: string
  github: GitHubStatus
}
