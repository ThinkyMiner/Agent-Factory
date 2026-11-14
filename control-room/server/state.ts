// One full read of a factory: load raw inputs, then derive state. Used by the server and tests.
import { readFile } from 'node:fs/promises'
import { byNeeds, deriveAll, indexLifecycle, type Context } from './core/derive.ts'
import { improvementNeeds } from './core/meta.ts'
import { GitHubDataSchema, type GitHubData, type GitHubStatus } from './core/types.ts'
import { loadSnapshot } from './sources/load.ts'
import { loadMeta } from './sources/meta.ts'

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
  const needsYou = [...d.needsYou, ...improvementNeeds(gh.data?.pulls ?? [], snap.rules, snap.autoMergeMax)].sort(byNeeds)
  return { snap, meta, ctx, runs, sessions, ...d, needsYou }
}
export type FactoryState = Awaited<ReturnType<typeof computeState>>

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
