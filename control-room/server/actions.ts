// Every change the control room can make, in one file. Off unless started with --actions.
// The HTTP layer has already checked Host, Origin, Sec-Fetch-Site, the per-launch token and the JSON
// content type. Each action here validates its input, re-checks the live state it depends on,
// makes one call with an argument array (text goes through stdin), and every attempt is logged.
//
// ponytail: "start a run" is not built. It would be one more entry in ACTIONS with flag 'runs'
// (its own --allow-runs switch), because starting an agent is a different kind of change from a
// label or a comment. Nothing else here needs to change for it.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { GitHubDataSchema, currentChecks, tierRank, type GitHubData } from './core/types.ts'
import { pullTier } from './core/meta.ts'
import { gh } from './sources/github.ts'
import type { Factory } from './factory.ts'

export interface GitHubWriter {
  addLabel(kind: 'issue' | 'pr', n: number, label: string): Promise<void>
  comment(issue: number, body: string): Promise<void>
  /** A fresh read of a PR, never the cache: approval is checked against the head as it is now. */
  pullHead(pr: number): Promise<{ sha: string; state: string; labels: string[] }>
}

export function ghWriter(cwd: string, slug: () => Promise<string>): GitHubWriter {
  return {
    addLabel: async (kind, n, label) => void (await gh([kind, 'edit', String(n), '--repo', await slug(), '--add-label', label], cwd)),
    comment: async (n, body) => void (await gh(['issue', 'comment', String(n), '--repo', await slug(), '--body-file', '-'], cwd, 30000, body)),
    pullHead: async (n) => {
      const o = JSON.parse(await gh(['pr', 'view', String(n), '--repo', await slug(), '--json', 'headRefOid,state,labels'], cwd)) as { headRefOid: string; state: string; labels: { name: string }[] }
      return { sha: o.headRefOid, state: o.state, labels: o.labels.map((l) => l.name) }
    },
  }
}

/** The demo's GitHub is a JSON file: actions edit it, so the whole flow can be tried offline. */
export function demoWriter(path: string): GitHubWriter {
  const read = () => GitHubDataSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  const edit = (fn: (d: GitHubData, now: string) => void) => {
    const d = read()
    fn(d, new Date().toISOString())
    writeFileSync(`${path}.tmp`, JSON.stringify(d, null, 2))
    renameSync(`${path}.tmp`, path)
  }
  return {
    addLabel: async (kind, n, label) =>
      edit((d, now) => {
        if (kind === 'issue') {
          const i = d.issues.find((x) => x.number === n)
          if (!i) throw new Error(`no issue #${n}`)
          i.labels.push(label)
          i.labelEvents.push({ label, action: 'added', at: now })
        } else {
          const p = d.pulls.find((x) => x.number === n)
          if (!p) throw new Error(`no pull request #${n}`)
          p.labels.push(label)
          p.timeline.push({ type: 'labeled', label, at: now })
        }
      }),
    comment: async () => {}, // the demo models no issue comments; the action log keeps the text
    pullHead: async (n) => {
      const p = read().pulls.find((x) => x.number === n)
      if (!p) throw new Error(`no pull request #${n}`)
      return { sha: p.headSha, state: p.state, labels: p.labels }
    },
  }
}

export interface ActionResult {
  status: number
  body: { ok: boolean; message: string } & Record<string, unknown>
}
const refuse = (status: number, message: string): ActionResult => ({ status, body: { ok: false, message } })
const done = (message: string, extra: Record<string, unknown> = {}): ActionResult => ({ status: 200, body: { ok: true, message, ...extra } })

const n = z.number().int().positive()
const ACTIONS = {
  'mark-ready': { flag: 'actions', input: z.object({ issue: n }).strict() },
  approve: { flag: 'actions', input: z.object({ pr: n, headSha: z.string().regex(/^[0-9a-f]{7,64}$/), confirm: z.string() }).strict() },
  answer: { flag: 'actions', input: z.object({ issue: n, body: z.string().trim().min(1, 'the answer is empty').max(20_000) }).strict() },
} as const
export type ActionName = keyof typeof ACTIONS
export type ActionFlag = (typeof ACTIONS)[ActionName]['flag'] | 'runs'
export const isAction = (s: string): s is ActionName => Object.hasOwn(ACTIONS, s)

export interface LogEntry {
  at: string
  action: string
  outcome: 'done' | 'refused' | 'failed'
  status: number
  message: string
  input?: unknown
}

export class Actions {
  private queue: Promise<unknown> = Promise.resolve()
  private factory: Factory
  private writer: GitHubWriter
  private enabled: ReadonlySet<ActionFlag>
  readonly logPath: string

  constructor(factory: Factory, writer: GitHubWriter, dataDir: string, enabled: ReadonlySet<ActionFlag> = new Set(['actions'])) {
    this.factory = factory
    this.writer = writer
    this.enabled = enabled
    this.logPath = join(dataDir, 'actions.jsonl')
  }

  log(e: Omit<LogEntry, 'at'>) {
    appendFileSync(this.logPath, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n')
  }

  static readLog(dataDir: string, limit = 200): LogEntry[] {
    const p = join(dataDir, 'actions.jsonl')
    if (!existsSync(p)) return []
    const out: LogEntry[] = []
    for (const line of readFileSync(p, 'utf8').split('\n').reverse()) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as LogEntry)
      } catch {
        // a torn line from a crash: skip it, keep the rest
      }
      if (out.length >= limit) break
    }
    return out
  }

  /** One at a time, so two quick clicks cannot race each other's checks. */
  run(name: string, raw: unknown): Promise<ActionResult> {
    const next = this.queue.then(() => this.runOne(name, raw))
    this.queue = next.catch(() => {})
    return next
  }

  private async runOne(name: string, raw: unknown): Promise<ActionResult> {
    if (!isAction(name)) return refuse(404, `no action "${name}"`)
    if (!this.enabled.has(ACTIONS[name].flag)) return refuse(403, `${name} is not enabled`)
    const parsed = ACTIONS[name].input.safeParse(raw)
    if (!parsed.success) {
      const r = refuse(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
      this.log({ action: name, outcome: 'refused', status: r.status, message: r.body.message })
      return r
    }
    const input = parsed.data as Record<string, unknown>
    const logged = name === 'answer' ? { issue: input.issue, body: String(input.body).slice(0, 2000) } : input
    let r: ActionResult
    try {
      r = name === 'mark-ready' ? await this.markReady(input as never) : name === 'approve' ? await this.approve(input as never) : await this.answer(input as never)
    } catch (e) {
      r = refuse(502, `GitHub refused or could not be reached: ${(e as Error).message}`)
      this.log({ action: name, outcome: 'failed', status: r.status, message: r.body.message, input: logged })
      return r
    }
    this.log({ action: name, outcome: r.body.ok ? 'done' : 'refused', status: r.status, message: r.body.message, input: logged })
    if (r.body.ok) await this.factory.githubChanged()
    return r
  }

  private async markReady({ issue }: { issue: number }) {
    const i = this.factory.githubData()?.issues.find((x) => x.number === issue)
    if (!i) return refuse(404, `issue #${issue} is not in the GitHub data`)
    if (i.state !== 'OPEN') return refuse(409, `issue #${issue} is closed`)
    if (i.labels.includes('factory:ready')) return refuse(409, `issue #${issue} is already labelled factory:ready`)
    await this.writer.addLabel('issue', issue, 'factory:ready')
    return done(`Added factory:ready to issue #${issue}. The next /work ${issue} picks it up.`)
  }

  /** What the approver sees before confirming: tier and why, the paths that make it R2, the review. */
  approvePreview(pr: number): ActionResult {
    const pull = this.factory.githubData()?.pulls.find((p) => p.number === pr)
    if (!pull) return refuse(404, `pull request #${pr} is not in the GitHub data`)
    const item = this.factory.state.items.find((i) => i.pr?.number === pr)
    const t = item ? { tier: item.tier, sources: item.tierSources, files: item.riskFiles } : pullTier(pull, this.factory.state.snap.rules)
    const problem =
      pull.state !== 'OPEN' ? `pull request #${pr} is ${pull.state.toLowerCase()}` :
      pull.labels.includes('human-approved') ? `pull request #${pr} already has human-approved` :
      !t.tier || tierRank(t.tier) < 2 ? `pull request #${pr} is ${t.tier ?? 'not classified'}: below R2 it does not need human-approved` :
      t.tier === 'R3' ? `pull request #${pr} is R3: the factory does not make R3 changes, so it is not approved from here` :
      null
    return {
      status: 200,
      body: {
        ok: !problem,
        message: problem ?? `Approve pull request #${pr}`,
        pr,
        title: pull.title,
        url: pull.url,
        headSha: pull.headSha,
        item: item && { id: item.id, title: item.title },
        tier: t.tier,
        sources: t.sources,
        r2Files: t.files.filter((f) => tierRank(f.tier) >= 2),
        files: t.files.length,
        review: item?.review ? (item.review.ok ? { verdict: item.review.value.verdict, blocking: item.review.value.blocking.length, nonBlocking: item.review.value.nonBlocking.length } : { error: item.review.error }) : null,
        checks: currentChecks(pull.checks).map((c) => ({ name: c.name, conclusion: c.conclusion ?? c.status })),
        notVerified: item?.notVerified.length ?? null,
        confirm: `approve #${pr}`,
      },
    }
  }

  private async approve({ pr, headSha, confirm }: { pr: number; headSha: string; confirm: string }) {
    const preview = this.approvePreview(pr)
    if (!preview.body.ok) return refuse(409, preview.body.message)
    if (confirm.trim() !== `approve #${pr}`) return refuse(400, `type "approve #${pr}" to confirm`)
    const live = await this.writer.pullHead(pr)
    if (live.state !== 'OPEN') return refuse(409, `pull request #${pr} is ${live.state.toLowerCase()} now`)
    if (live.labels.includes('human-approved')) return refuse(409, `pull request #${pr} was approved meanwhile`)
    if (live.sha !== headSha) return refuse(409, `pull request #${pr} has new commits since you reviewed it (${headSha.slice(0, 8)} → ${live.sha.slice(0, 8)}). Review it again.`)
    await this.writer.addLabel('pr', pr, 'human-approved')
    return done(`Added human-approved to pull request #${pr} at ${headSha.slice(0, 8)}.`)
  }

  private async answer({ issue, body }: { issue: number; body: string }) {
    const item = this.factory.state.items.find((i) => i.issue?.number === issue || i.id === String(issue))
    if (!item) return refuse(404, `no work item for issue #${issue}`)
    if (item.state !== 'blocked') return refuse(409, `#${item.id} is not blocked (${item.state}); there is no question to answer`)
    await this.writer.comment(issue, body)
    return done(`Posted your answer on issue #${issue}. Run /work ${item.id} to continue.`)
  }
}
