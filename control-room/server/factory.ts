// One watched factory repo: holds the derived state, recomputes it when files change, polls
// GitHub, and tells subscribers. Everything hangs off this instance (no module-level state),
// so watching several repos later means several instances.
import { watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { GitHubData } from './core/types.ts'
import type { ItemDetail, RunRow, RunsResponse } from './core/api.ts'
import { stageResults } from './core/derive.ts'
import { quality } from './core/quality.ts'
import { auditsView, factoryView, improvementView, memoryView } from './core/meta.ts'
import { metaDiff } from './sources/meta.ts'
import type { StageEvent } from './core/types.ts'
import { transcriptSummary } from './sources/transcripts.ts'
import { summary } from './core/api.ts'
import { computeState, readDemoGitHub, type FactoryState, type GitHubInput } from './state.ts'
import { Store } from './store.ts'
import { fetchGitHub, repoSlug } from './sources/github.ts'
import * as g from './sources/git.ts'

export interface FactoryOptions {
  repo: string
  dataDir?: string
  staleMinutes: number
  github: { kind: 'gh'; intervalMs: number } | { kind: 'demo'; path: string } | { kind: 'off'; reason: string }
  transcriptsRoot: string
}

export type Change = { version: number; reason: string }

const IGNORE = /^(?:\.git\/(?:objects|logs|lfs|hooks|modules)\/|\.git\/(?:index|FETCH_HEAD|ORIG_HEAD|COMMIT_EDITMSG)$|node_modules\/|dist\/|\.venv\/|\.claude\/worktrees\/)/

export function dataDirFor(repo: string) {
  const real = realpathSync(repo)
  return join(homedir(), '.control-room', `${basename(real)}-${createHash('sha256').update(real).digest('hex').slice(0, 8)}`)
}

export class Factory {
  readonly repo: string
  readonly opts: FactoryOptions
  readonly store: Store
  readonly dataDir: string
  state!: FactoryState
  version = 0
  private gh: GitHubInput = { status: { state: 'unavailable', error: 'not fetched yet' } }
  private listeners = new Set<(c: Change) => void>()
  private watcher: FSWatcher | null = null
  private timers: NodeJS.Timeout[] = []
  private debounce: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private dirty = false
  private fingerprint = ''
  watchError: string | null = null

  constructor(opts: FactoryOptions) {
    this.opts = opts
    this.repo = opts.repo
    this.dataDir = opts.dataDir ?? dataDirFor(opts.repo)
    this.store = new Store(this.dataDir)
  }

  async start() {
    const gh = this.opts.github
    if (gh.kind === 'demo') this.gh = await readDemoGitHub(gh.path)
    else if (gh.kind === 'off') this.gh = this.cachedGitHub(gh.reason)
    else this.gh = this.cachedGitHub('fetching')
    await this.recompute('start')
    this.watch()
    // time moves on: quiet and failed depend on "now", so re-derive every 30 s
    this.timers.push(setInterval(() => this.schedule('clock'), 30_000))
    if (gh.kind === 'gh') {
      void this.refreshGitHub()
      this.timers.push(setInterval(() => void this.refreshGitHub(), gh.intervalMs))
    }
    if (gh.kind === 'demo') this.timers.push(setInterval(async () => { this.gh = await readDemoGitHub(gh.path); this.schedule('github') }, 5_000))
  }

  stop() {
    this.watcher?.close()
    this.timers.forEach(clearInterval)
    if (this.debounce) clearTimeout(this.debounce)
    this.listeners.clear()
    this.store.close()
  }

  subscribe(fn: (c: Change) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---------- recompute ----------

  schedule(reason: string) {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.recompute(reason), 200)
  }

  private async recompute(reason: string): Promise<void> {
    if (this.running) {
      this.dirty = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.dirty = false
          const next = await computeState(this.repo, this.gh, { staleMinutes: this.opts.staleMinutes })
          // ponytail: full recompute (~150 ms on 36 items); go incremental if a real factory makes this slow
          const fp = createHash('sha1').update(JSON.stringify([next.items.map(summary), next.needsYou, next.running, next.snap.notices, next.snap.github, next.runs, next.meta.map((f) => [f.path, f.drift, f.where, f.text]), next.teams])).digest('hex')
          this.state = next
          if (fp !== this.fingerprint) {
            this.fingerprint = fp
            this.version++
            for (const fn of this.listeners) fn({ version: this.version, reason })
          }
        } while (this.dirty)
      } catch (e) {
        console.error(`control-room: recompute failed: ${(e as Error).stack}`)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private watch() {
    try {
      this.watcher = watch(this.repo, { recursive: true }, (_ev, file) => {
        const f = String(file ?? '').split('\\').join('/')
        if (f && IGNORE.test(f)) return
        this.schedule(`file ${f}`)
      })
      this.watcher.on('error', (e) => this.fallbackToPolling(e))
    } catch (e) {
      this.fallbackToPolling(e as Error)
    }
  }

  private fallbackToPolling(e: Error) {
    this.watchError = `file watching failed (${e.message}); polling every 2 s instead`
    this.watcher?.close()
    this.watcher = null
    this.timers.push(setInterval(() => this.schedule('poll'), 2_000))
  }

  // ---------- GitHub ----------

  private cachedGitHub(reason: string): GitHubInput {
    const c = this.store.get<GitHubData>('github')
    if (c) return { data: c.value, status: { state: 'stale', fetchedAt: c.fetchedAt, error: reason } }
    return { status: { state: 'unavailable', error: reason } }
  }

  async refreshGitHub() {
    try {
      // work run on GitHub (the factory workflow) pushes work/* branches this checkout has not seen
      // ponytail: may briefly contend for a ref lock with a local push; per-ref fetch if that ever bites
      await g.git(this.repo, ['fetch', '--quiet', '--prune', 'origin'], 30_000).catch(() => {})
      const slug = await repoSlug(this.repo)
      const data = await fetchGitHub(this.repo, slug)
      const fetchedAt = new Date().toISOString()
      this.store.put('github', data, fetchedAt)
      this.gh = { data, status: { state: 'fresh', fetchedAt } }
    } catch (e) {
      const msg = (e as Error).message
      this.gh = this.cachedGitHub(/not a git repository|no git remotes|none of the git remotes/i.test(msg) ? 'no GitHub remote for this repository' : msg)
    }
    this.schedule('github')
  }

  githubData = () => this.gh.data

  /** After an action changed GitHub: read it again now rather than at the next poll. */
  async githubChanged() {
    const gh = this.opts.github
    if (gh.kind === 'demo') {
      this.gh = await readDemoGitHub(gh.path)
      await this.recompute('action')
    } else if (gh.kind === 'gh') await this.refreshGitHub()
  }

  // ---------- reads for the API ----------

  githubStatus() {
    return this.state.snap.github
  }

  async runs(): Promise<RunsResponse> {
    const resultOf = stageResults(this.state.snap.events.filter((e): e is StageEvent => e.type === 'stage'))
    const now = Date.now()
    const runs: RunRow[] = await Promise.all(
      this.state.runs.map(async (r) => {
        const t = await transcriptSummary(this.store, this.opts.transcriptsRoot, r.transcriptPath, { skipSidechain: r.agentType === 'foreman' })
        return {
          ...r,
          title: this.state.byId.get(r.workId)?.title,
          durationMs: r.start ? Date.parse(r.end ?? (r.outcome === 'running' ? new Date(now).toISOString() : r.lastSeen ?? new Date(now).toISOString())) - Date.parse(r.start) : undefined,
          stageResult: resultOf(r),
          model: t.ok ? t.model : undefined,
          tokens: t.ok ? t.tokens : undefined,
          tokensNote: t.ok ? undefined : t.reason,
        }
      }),
    )
    runs.sort((a, b) => Date.parse(b.start ?? b.end ?? '') - Date.parse(a.start ?? a.end ?? ''))
    return { runs, tokensAvailable: runs.some((r) => r.tokens) }
  }

  async quality(weeks: number) {
    const { runs, tokensAvailable } = await this.runs()
    const tokensByItem = new Map<string, number>()
    const tokenRuns = new Map<string, { read: number; total: number }>()
    if (tokensAvailable) {
      for (const r of runs) {
        if (!r.workId) continue
        const c = tokenRuns.get(r.workId) ?? { read: 0, total: 0 }
        c.total++
        if (r.tokens) {
          c.read++
          tokensByItem.set(r.workId, (tokensByItem.get(r.workId) ?? 0) + r.tokens.total)
        }
        tokenRuns.set(r.workId, c)
      }
    }
    const mergedPulls = (this.gh.data?.pulls ?? []).flatMap((p) => {
      const id = /^work\/([A-Za-z0-9._]+)-/.exec(p.headRefName)?.[1]
      return id && p.state === 'MERGED' && p.mergedAt ? [{ number: p.number, id, mergedAt: p.mergedAt, base: p.baseRefName }] : []
    })
    return quality({ items: this.state.items, tokensByItem, tokenRuns, mergedPulls, escapedIssues: this.state.snap.escapedIssues, now: Date.now(), weeks })
  }

  memory = () => memoryView(this.state.meta, this.state.snap.observations)
  improvement = () => ({ ...improvementView(this.state.meta, this.gh.data?.pulls ?? []), github: this.state.snap.github })
  factory = () => factoryView(this.state.meta)
  audits = () => auditsView(this.state.meta)
  teams = () => this.state.teams

  /** One factory file and its changes against main; only paths the loader listed. */
  async factoryFile(path: string) {
    const f = this.state.meta.find((x) => x.path === path)
    if (!f) return null
    const main = this.state.snap.main
    return { ...f, diff: main && f.drift === 'modified' ? await metaDiff(this.repo, main, path) : null }
  }

  async itemDetail(id: string): Promise<ItemDetail | null> {
    const item = this.state.byId.get(id)
    if (!item) return null
    const snap = this.state.snap
    const inp = snap.inputs.find((i) => i.id === id)!
    const events = snap.events.filter((e) => (e.type === 'stage' || e.type === 'lifecycle') && e.work_id === id)
    const all = await this.runs()
    const runs = all.runs.filter((r) => r.workId === id)
    const observations = snap.observations.filter((o) => o.workId === id)
    let commits: ItemDetail['commits'] = []
    let numstat: Record<string, { additions: number; deletions: number }> = {}
    if (snap.isGit && snap.main) {
      const ref = inp.branch && !inp.onMain ? (await g.workBranches(this.repo)).find((b) => b.name === inp.branch)?.ref : undefined
      if (ref) {
        const base = inp.base ?? snap.main
        commits = await g.branchCommits(this.repo, `${base}..${ref}`)
        numstat = await g.numstat(this.repo, [`${base}...${ref}`])
      } else if (inp.onMain?.sha) {
        commits = await g.branchCommits(this.repo, `-1`, inp.onMain.sha)
        numstat = await g.numstat(this.repo, [`${inp.onMain.sha}^!`])
      }
    }
    for (const f of inp.pull?.files ?? []) numstat[f.path] ??= { additions: f.additions, deletions: f.deletions }
    return {
      ...item,
      // the raw line is only for de-duplication; leaving it out halves the payload
      // ponytail: the whole history goes in one response (~2 MB at 12,000 events); page it if items get longer
      events: events.map(({ key: _, ...e }) => e) as ItemDetail['events'],
      runs,
      tokensAvailable: all.tokensAvailable,
      observations,
      commits,
      changes: item.riskFiles.map((f) => ({ ...f, ...(numstat[f.path] ?? {}) })),
      checks: inp.pull?.checks ?? [],
      prBody: inp.pull?.body,
      issueBody: inp.issue?.body,
      github: snap.github,
    }
  }

  async diff(id: string, file: string): Promise<string | null> {
    const item = this.state.byId.get(id)
    const inp = this.state.snap.inputs.find((i) => i.id === id)
    const snap = this.state.snap
    // only files in this item's change list: the client cannot name an arbitrary path
    if (!item || !inp || !item.riskFiles.some((f) => f.path === file) || !snap.isGit || !snap.main) return null
    if (inp.branch && !inp.onMain) {
      const ref = (await g.workBranches(this.repo)).find((b) => b.name === inp.branch)?.ref
      if (ref) return g.git(this.repo, ['diff', '--no-color', '--no-ext-diff', `${inp.base ?? snap.main}...${ref}`, '--', file]).catch(() => null)
    }
    if (inp.onMain?.sha) return g.git(this.repo, ['show', '--no-color', '--no-ext-diff', '--format=', inp.onMain.sha, '--', file]).catch(() => null)
    return null
  }
}
