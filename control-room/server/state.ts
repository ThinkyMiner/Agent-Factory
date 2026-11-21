// One full read of a factory: load raw inputs, then derive state. Used by the server and tests.
import { readFile } from 'node:fs/promises'
import { byNeeds, deriveAll, indexLifecycle, type Context, type NeedsEntry, type NeedsKind } from './core/derive.ts'
import type { SweepFinding } from './core/parse.ts'
import { pullNeeds } from './core/meta.ts'
import { GitHubDataSchema, type GitHubData, type GitHubStatus } from './core/types.ts'
import { loadSnapshot } from './sources/load.ts'
import { loadMeta } from './sources/meta.ts'
import { deriveTeams } from './core/teams.ts'
import { loadTeams } from './sources/teams.ts'

export interface GitHubInput {
  data?: GitHubData
  status: GitHubStatus
}

export async function computeState(repo: string, gh: GitHubInput, opts: { now?: number; staleMinutes: number }) {
  const snap = await loadSnapshot(repo, gh)
  const meta = await loadMeta(repo, snap.isGit, snap.main)
  const { sessions, runs } = indexLifecycle(snap.lifecycle)
  const ctx: Context = { now: opts.now ?? Date.now(), staleMinutes: opts.staleMinutes, autoMergeMax: snap.autoMergeMax, rules: snap.rules, sessions, runs }
  const d = deriveAll(snap.inputs, ctx)
  // team mode: the cycle, features, teams and sessions, and what in them needs you
  const teamsIn = await loadTeams(snap)
  const t = teamsIn ? deriveTeams(teamsIn, { issues: gh.data?.issues ?? [], pulls: gh.data?.pulls ?? [] }, d.byId) : null
  if (t) snap.notices.push(...t.notices)
  // every open PR that waits for you and is not an item's or the planning cycle's (those say it themselves)
  const shown = new Set([...d.items.flatMap((i) => (i.pr ? [i.pr.number] : [])), ...(t?.view.cycle?.pr ? [t.view.cycle.pr.number] : [])])
  const waits = new Map((t?.view.cycle?.blocking ?? []).map((b) => [b.number, `planning ${t!.view.cycle!.name} waits: ${b.why}`]))
  const needsYou = [...d.needsYou, ...pullNeeds(gh.data?.pulls ?? [], snap.rules, snap.autoMergeMax, shown, waits), ...(t?.needs ?? []), ...findingNeeds(snap.findings)].sort(byNeeds)
  return { snap, meta, ctx, runs, sessions, ...d, needsYou, teams: t?.view ?? null }
}
export type FactoryState = Awaited<ReturnType<typeof computeState>>

// A session on a dialog is already a need of its own (the teams view reads Herdr live).
const FINDING_KIND: Record<string, NeedsKind | null> = { blocked: null, silent: 'quiet', slot: 'quiet', round: 'quiet', unanswered: 'quiet' }
/** The sweep's open findings, each a row under Needs you until the sweep stops seeing it. */
export function findingNeeds(findings: SweepFinding[]): NeedsEntry[] {
  return findings.flatMap((f) => {
    const kind = f.reason in FINDING_KIND ? FINDING_KIND[f.reason] : 'failed'
    return kind ? [{ kind, id: `sweep-${f.key}`, label: `sweep · ${f.reason}`, title: f.detail, summary: `escalated by the sweep${f.refs ? ` (${f.refs})` : ''}; it clears when the sweep stops seeing it`, since: f.since, href: '/' }] : []
  })
}

/** The demo's fake GitHub: a JSON file in the normalised shape, always "fresh". */
export async function readDemoGitHub(path: string): Promise<GitHubInput> {
  try {
    const r = GitHubDataSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (!r.success) return { status: { state: 'unavailable', error: `demo github.json: ${r.error.issues[0]?.message}` } }
    return { data: r.data, status: { state: 'fresh', fetchedAt: new Date().toISOString() } }
  } catch (e) {
    return { status: { state: 'unavailable', error: (e as Error).message } }
  }
}
