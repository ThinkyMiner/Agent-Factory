// Reads team mode's inputs for core/teams.ts: the roster, the planning cycle's files, feature
// branches, team worktrees and Herdr. Reads only: git, the files, `herdr-app ls` and `hc get`
// (never send or keys). Of Herdr's layout only the factory's own space is kept; every other space,
// tab and terminal is dropped here without being looked at, stored or shown.
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseCycleState, type SessionTab, type TeamsInput } from '../core/teams.ts'
import type { Snapshot } from './load.ts'
import * as g from './git.ts'

const CYCLE = /^c(\d{3})-[a-z0-9][a-z0-9-]{0,40}$/
const MAX_DOC = 200_000
const readText = (p: string) => readFile(p, 'utf8').then((s) => s, () => null)
const show = (repo: string, ref: string, path: string) => g.git(repo, ['show', `${ref}:${path}`]).catch(() => null)

/** null: not a team-mode factory (no factory/teams.json on main or in the working tree). */
export async function loadTeams(snap: Snapshot): Promise<TeamsInput | null> {
  const { repo, main } = snap
  let rosterText = main ? await show(repo, main, 'factory/teams.json') : null
  const rosterSource = rosterText !== null ? main! : 'working tree'
  rosterText ??= await readText(join(repo, 'factory/teams.json'))
  if (rosterText === null) return null

  const mains = [...new Set(snap.isGit ? ['origin/main', main ?? 'main'] : [])]
  const planningBranches = snap.isGit ? await g.branchesUnder(repo, 'planning/') : new Map<string, string[]>()
  const featureBranches = snap.isGit ? await g.branchesUnder(repo, 'feature/') : new Map<string, string[]>()
  const integrateBranches = snap.isGit ? await g.branchesUnder(repo, 'integrate/') : new Map<string, string[]>()

  // ---- the cycle: the active one, else the newest there is ----
  const marker = (await readText(join(repo, '.factory/planning/active')))?.split('\n')[0]?.trim() ?? ''
  const active = CYCLE.test(marker) ? marker : undefined
  let name = active
  if (!name) {
    const onMain = snap.isGit ? (await Promise.all(mains.map((m) => g.git(repo, ['ls-tree', '--name-only', m, 'planning/']).catch(() => '')))).join('\n').split('\n').map((p) => p.replace(/^planning\//, '')) : []
    const local = await readdir(join(repo, 'planning')).catch(() => [] as string[])
    name = [...onMain, ...planningBranches.keys(), ...local].filter((c) => CYCLE.test(c)).sort().at(-1)
  }
  let cycle: TeamsInput['cycle']
  if (name) {
    const feature = name.replace(/^c/, 'f')
    // every copy of the cycle's record: the main checkout, its branch, the feature branch dispatch wrote
    // "dispatched" to, and main once merged. state.json's history only grows: the longest is the newest.
    const sources: { source: string; read: (p: string) => Promise<string | null> }[] = [
      { source: 'working tree', read: (p) => readText(join(repo, p)) },
      ...[...(planningBranches.get(name) ?? []), ...(featureBranches.get(feature) ?? []), ...mains].map((ref) => ({ source: ref, read: (p: string) => show(repo, ref, p) })),
    ]
    const dir = `planning/${name}`
    const copies = await Promise.all(sources.map(async (s) => ({ ...s, text: await s.read(`${dir}/state.json`) })))
    const len = (t: string | null) => {
      const r = t === null ? null : parseCycleState(t)
      return r?.ok ? r.value.history.length : -1
    }
    const pick = copies.filter((c) => c.text !== null).reduce<(typeof copies)[number] | undefined>((best, c) => (!best || len(c.text) > len(best.text) ? c : best), undefined)
    const from = pick ?? sources[0]!
    const cycleTeams = (() => {
      const r = pick?.text ? parseCycleState(pick.text) : null
      return r?.ok ? r.value.teams : []
    })()
    // a sealed position is never read, only whether it exists (round.sh: non-empty)
    const submitted: string[] = []
    for (const t of cycleTeams) {
      if (!/^[a-z0-9_-]+$/.test(t)) continue
      const s = await stat(join(repo, '.factory/planning', name, 'sealed', `${t}.md`)).catch(() => null)
      if (s?.isFile() && s.size > 0) submitted.push(t)
    }
    cycle = {
      name,
      active: name === active,
      source: from.source,
      onMain: copies.some((c) => mains.includes(c.source) && c.text !== null),
      state: pick?.text ?? null,
      discussion: await from.read(`${dir}/discussion.jsonl`),
      brief: await from.read(`${dir}/BRIEF.md`),
      decisions: await from.read(`${dir}/DECISIONS.md`),
      submitted,
    }
  }

  // ---- features: their branches and records ----
  const features: TeamsInput['features'] = []
  for (const f of new Set([...featureBranches.keys(), ...integrateBranches.keys()])) {
    const fr = featureBranches.get(f) ?? []
    const ir = integrateBranches.get(f) ?? []
    const docs: TeamsInput['features'][number]['docs'] = []
    // the criteria and their review are written on the feature branch, the e2e report on integrate
    // the attribution of a failed round is integration-qa's, on integrate
    for (const [file, refs] of [['acceptance.md', [...fr, ...ir]], ['e2e-report.md', [...ir, ...fr]], ['attribution.md', [...ir, ...fr]], ['acceptance-review.md', [...fr, ...ir]]] as const) {
      for (const ref of refs) {
        const text = await show(repo, ref, `features/${f}/${file}`)
        if (text === null) continue
        docs.push({ file, ref, text: text.length > MAX_DOC ? `${text.slice(0, MAX_DOC)}\n\n[cut at ${MAX_DOC} characters]` : text })
        break
      }
    }
    // the work breakdown dispatch.sh wrote for it, on the feature branch (cycle c<NNN> for feature f<NNN>)
    let dispatch: string | null = null
    for (const ref of fr) {
      const p = (await g.lsTree(repo, ref, ['planning/'])).find((e) => e.path.startsWith(`planning/c${f.slice(1, 4)}-`) && e.path.endsWith('/dispatch.jsonl'))?.path
      if (p && (dispatch = await show(repo, ref, p)) !== null) break
    }
    // test files only (x.test.mjs, x.spec.ts, ...): a helper module beside them is not a test
    const e2eTests = ir[0] ? (await g.lsTree(repo, ir[0], [`tests/e2e/${f}/`])).filter((e) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.path)).length : undefined
    features.push({ name: f, refs: { feature: fr[0], integrate: ir[0] }, e2eTests, docs, dispatch })
  }

  // ---- checkouts: the orchestrator's is the main one ----
  const [mainCheckout] = snap.worktrees
  const checkouts: TeamsInput['checkouts'] = [
    ...(mainCheckout ? [{ team: 'orchestrator', path: mainCheckout.path, branch: mainCheckout.branch, exists: mainCheckout.exists }] : []),
    ...g.teamWorktrees(snap.worktrees).map((w) => ({ team: w.team, path: w.path, branch: w.branch, exists: w.exists })),
  ]

  return {
    roster: { text: rosterText, source: rosterSource },
    cycle,
    features,
    checkouts,
    sessions: await herdrSessions(basename(mainCheckout?.path ?? repo)),
    events: snap.events,
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
    child.stdin?.end()
  })
}

type Json = Record<string, unknown> | undefined
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/** The factory's Herdr space (named after the repo folder): each tab's state from `hc get`.
 *  ponytail: one `herdr-app ls` and one `hc get` per tab on every recompute; cache them if a busy factory makes that slow. */
export async function herdrSessions(space: string): Promise<{ available: boolean; tabs: SessionTab[] }> {
  let layout: unknown
  try {
    layout = JSON.parse(await run('herdr-app', ['ls']))
  } catch {
    return { available: false, tabs: [] }
  }
  const spaces = obj(layout)?.spaces
  // only the factory's space is kept: nothing else from the layout leaves this function
  const mine = Array.isArray(spaces) ? spaces.map(obj).find((s) => s?.name === space) : undefined
  const tabs = Array.isArray(mine?.tabs) ? mine.tabs.map(obj) : []
  let noHc = false
  const out = await Promise.all(
    tabs.map(async (t): Promise<SessionTab> => {
      const tab = typeof t?.name === 'string' ? t.name.slice(0, 80) : '?'
      const term = Array.isArray(t?.terminals) ? obj(t.terminals[0])?.terminal : undefined
      if (typeof term !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(term)) return { tab, state: 'unknown' }
      try {
        const j = obj(JSON.parse(await run('hc', ['get', term, '--json'])))
        const st = obj(j?.status)
        const ms = j?.status_ms
        return {
          tab,
          state: typeof st?.state === 'string' ? st.state.slice(0, 20) : 'unknown',
          msg: typeof st?.msg === 'string' && st.msg ? st.msg.slice(0, 300) : undefined,
          since: typeof ms === 'number' && ms > 1e12 && ms < 1e14 ? new Date(ms).toISOString() : undefined,
        }
      } catch (e) {
        if ((e as { code?: unknown }).code === 'ENOENT') noHc = true
        return { tab, state: 'unknown' }
      }
    }),
  )
  return noHc ? { available: false, tabs: [] } : { available: true, tabs: out }
}
