// Reads a factory repo (working tree + git refs + .factory/events.jsonl + GitHub data) into
// the raw ItemInputs that core/derive.ts turns into state. All reads, no writes.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { openFindings, parseEvents, parseObservationFile, parsePolicy, type SweepFinding } from '../core/parse.ts'
import { parseRiskRules, type RiskRule } from '../core/risk.ts'
import { WORK_FILES, type ItemInputs, type TestRef, type WorkFile, type WorkFileName } from '../core/derive.ts'
import type { FactoryEvent, GitHubData, GitHubStatus, Issue, LifecycleEvent, Notice, ObservationFile, Pull, StageEvent, Tier } from '../core/types.ts'
import * as g from './git.ts'

export interface Snapshot {
  repo: string
  isGit: boolean
  head: string | null
  main: string | null
  autoMergeMax: Tier | 'none'
  rules: RiskRule[]
  worktrees: g.Worktree[] // every checkout, the main one first
  inputs: ItemInputs[]
  events: FactoryEvent[] // every event, deduplicated, file order
  lifecycle: LifecycleEvent[]
  observations: ObservationFile[]
  escapedIssues: { number: number; title: string; url: string; createdAt: string }[] // issues labelled escaped-defect
  github: GitHubStatus & { repo?: string }
  notices: Notice[]
  findings: SweepFinding[] // the sweep's open findings (team mode); empty without a readable sweep.json
}

type Origin = WorkFile['origin']
interface Source {
  origin: Origin
  ref?: string // git ref for branch/main
  path: string // repo-relative file path
  read: () => Promise<{ text: string; time: string }>
}

const FOLDER = /^([A-Za-z0-9._]+)-([A-Za-z0-9._-]+)$/
const readText = (p: string) => readFile(p, 'utf8').then((s) => s, () => null)
const listDir = (p: string) => readdir(p, { withFileTypes: true }).then((d) => d, () => [])
const ORDER: Record<Origin, number> = { worktree: 0, branch: 1, main: 2 }
/** The item an acceptance test belongs to: tests/acceptance/<id>-... or tests/acceptance/<team>/<id>-... */
const testOf = (path: string) => /^tests\/acceptance\/(?:[a-z0-9_-]+\/)?([A-Za-z0-9._]+?)-[^/]*$/.exec(path)?.[1]

export async function loadSnapshot(repo: string, gh: { data?: GitHubData; status: GitHubStatus }): Promise<Snapshot> {
  const notices: Notice[] = []
  const isGit = await g.isRepo(repo)
  const head = isGit ? await g.headBranch(repo) : null
  const main = isGit ? await g.mainRef(repo) : null
  if (!isGit) notices.push({ level: 'info', source: 'git', message: 'not a git repository: showing the working tree only (no branches, commits or main)' })
  else if (!main) notices.push({ level: 'warn', source: 'git', message: 'no main or master branch found' })

  // policy and rules from main, as CI reads them; the working tree only when there is no main
  let policyText: string | null = null
  if (main) policyText = await g.git(repo, ['show', `${main}:factory/policy.env`]).catch(() => null)
  policyText ??= await readText(join(repo, 'factory/policy.env'))
  const policy = policyText === null ? null : parsePolicy(policyText)
  if (!policy) notices.push({ level: 'warn', source: 'factory/policy.env', message: 'missing; assuming AUTO_MERGE_MAX_TIER=none' })
  else if (!policy.ok) notices.push({ level: 'error', source: 'factory/policy.env', message: policy.error, raw: policy.raw })
  const autoMergeMax = policy?.ok ? policy.value.autoMergeMax : 'none'
  let rulesText: string | null = null
  if (main) rulesText = await g.git(repo, ['show', `${main}:factory/risk-rules.txt`]).catch(() => null)
  rulesText ??= await readText(join(repo, 'factory/risk-rules.txt'))
  if (rulesText === null) notices.push({ level: 'warn', source: 'factory/risk-rules.txt', message: 'missing; every path classifies as R1' })
  const rules = parseRiskRules(rulesText ?? '')

  // ---- collect every copy of every file we care about, by origin ----
  const sources: Source[] = []
  // A work folder in a checkout: the main one, or a team's worktree (team mode) on that item's branch.
  // A checkout rewrites mtimes, so a tracked, unmodified file takes its last commit time;
  // only modified or untracked files use the mtime.
  const addCheckout = async (root: string, only?: string) => {
    const dirty = isGit ? await g.dirtyPaths(root, ['work/']) : null
    const time = async (rel: string) => {
      if (dirty && !dirty.has(rel)) {
        const c = await g.lastCommitTime(root, 'HEAD', rel)
        if (c) return c
      }
      return (await stat(join(root, rel))).mtime.toISOString()
    }
    for (const d of await listDir(join(root, 'work'))) {
      if (!d.isDirectory() || !FOLDER.test(d.name) || (only && d.name !== only)) continue
      for (const f of await listDir(join(root, 'work', d.name))) {
        if (!f.isFile()) continue
        const rel = `work/${d.name}/${f.name}`
        sources.push({ origin: 'worktree', path: rel, read: async () => ({ text: (await readText(join(root, rel))) ?? '', time: f.name === 'BLOCKED.md' ? await time(rel) : (await stat(join(root, rel))).mtime.toISOString() }) })
      }
    }
  }
  // team worktrees first: for its own item, a team's checkout is newer than the main one
  const worktrees = isGit ? await g.worktrees(repo) : []
  for (const w of g.teamWorktrees(worktrees)) if (w.exists && w.branch?.startsWith('work/')) await addCheckout(w.path, w.branch.slice(5))
  await addCheckout(repo)
  // acceptance tests sit in tests/acceptance/ or, in team mode, tests/acceptance/<team>/
  const addFiles = async (dir: string, depth: number) => {
    for (const f of await listDir(join(repo, dir))) {
      const rel = `${dir}/${f.name}`
      if (f.isDirectory() && depth > 0) await addFiles(rel, depth - 1)
      if (!f.isFile()) continue
      sources.push({ origin: 'worktree', path: rel, read: async () => ({ text: (await readText(join(repo, rel))) ?? '', time: (await stat(join(repo, rel))).mtime.toISOString() }) })
    }
  }
  await addFiles('tests/acceptance', 1)
  await addFiles('memory/observations', 0)

  const branches = isGit ? await g.workBranches(repo) : []
  const blobRefs: { origin: Origin; ref: string; time: string; entries: g.TreeEntry[] }[] = []
  if (main) {
    const entries = await g.lsTree(repo, main, ['work/', 'tests/acceptance/', 'memory/observations/'])
    blobRefs.push({ origin: 'main', ref: main, time: '', entries })
  }
  for (const b of branches) {
    const folder = b.name.slice('work/'.length)
    const id = FOLDER.exec(folder)![1]!
    const entries = (await g.lsTree(repo, b.ref, [`work/${folder}/`, 'tests/acceptance/', 'memory/observations/'])).filter(
      (e) => e.path.startsWith(`work/${folder}/`) || testOf(e.path) === id || new RegExp(`^memory/observations/\\d{4}-\\d{2}-\\d{2}-${id}-`).test(e.path),
    )
    blobRefs.push({ origin: 'branch', ref: b.ref, time: b.time, entries })
  }
  // main history first: when each folder reached main, and reverts
  const onMain = new Map<string, { at: string; sha: string; files: string[] }>()
  const revertedSha = new Map<string, { at: string; ref: string; title: string }>()
  if (main) {
    for (const c of (await g.commits(repo, main)).reverse()) {
      for (const f of c.files) {
        const m = /^work\/([^/]+)\//.exec(f)
        if (m && !onMain.has(m[1]!)) onMain.set(m[1]!, { at: c.time, sha: c.sha, files: c.files })
      }
      const rv = /This reverts commit ([0-9a-f]{40})/.exec(c.body)
      if (rv) revertedSha.set(rv[1]!, { at: c.time, ref: c.sha.slice(0, 8), title: c.subject })
    }
    // a reverted item's folder is gone from main's tree: read it from the commit that merged it
    const inMain = new Set(blobRefs[0]?.entries.map((e) => /^work\/([^/]+)\//.exec(e.path)?.[1]).filter(Boolean))
    for (const [folder, c] of onMain) {
      if (inMain.has(folder)) continue
      const id = FOLDER.exec(folder)?.[1]
      const entries = (await g.lsTree(repo, c.sha, [`work/${folder}/`, 'tests/acceptance/'])).filter((e) => e.path.startsWith(`work/${folder}/`) || testOf(e.path) === id)
      blobRefs.push({ origin: 'main', ref: c.sha, time: c.at, entries })
    }
  }
  const blobs = await g.readBlobs(repo, blobRefs.flatMap((r) => r.entries.map((e) => e.sha)))
  for (const r of blobRefs) {
    for (const e of r.entries) {
      sources.push({
        origin: r.origin,
        ref: r.ref,
        path: e.path,
        read: async () => ({
          text: blobs.get(e.sha) ?? '',
          // only BLOCKED.md needs an exact time (state depends on it); the rest use the ref's time
          time: e.path.endsWith('/BLOCKED.md') ? ((await g.lastCommitTime(repo, r.ref, e.path)) ?? r.time) : r.time,
        }),
      })
    }
  }

  // ---- events: the live stream plus every per-item events.jsonl, deduplicated by line ----
  const events: FactoryEvent[] = []
  const seen = new Set<string>()
  // With the sweep's state, an escalation is a notice only while its finding is open (below).
  const sweepText = await readText(join(repo, '.factory/sweep.json'))
  const addEvents = (text: string, source: string, partialTail: boolean) => {
    const r = parseEvents(text, source, { partialTail })
    notices.push(...(sweepText === null ? r.notices : r.notices.filter((n) => !/^line \d+: escalation\b/.test(n.message))))
    for (const e of r.events) {
      if (seen.has(e.key)) continue
      seen.add(e.key)
      events.push(e)
    }
  }
  const live = await readText(join(repo, '.factory/events.jsonl'))
  if (live !== null) addEvents(live, '.factory/events.jsonl', true)
  for (const s of sources.filter((s) => s.path.endsWith('/events.jsonl')).sort((a, b) => ORDER[a.origin] - ORDER[b.origin])) {
    addEvents((await s.read()).text, `${s.path}${s.ref ? ` @${s.ref}` : ''}`, s.origin === 'worktree')
  }
  let findings: SweepFinding[] = []
  if (sweepText !== null) {
    const f = openFindings(sweepText, events)
    if (f) findings = f
    else {
      notices.push({ level: 'warn', source: '.factory/sweep.json', message: 'not readable: showing every escalation ever written' })
      events.forEach((e, i) => {
        if (e.type === 'unknown' && /"type"\s*:\s*"escalation"/.test(e.raw)) notices.push(...parseEvents(e.raw, '.factory/events.jsonl').notices.map((n) => ({ ...n, message: n.message.replace(/^line 1:/, `event ${i + 1}:`) })))
      })
    }
    for (const x of findings) notices.push({ level: 'warn', source: '.factory/sweep.json', message: `escalation (${x.reason}): ${x.detail}` })
  }
  const stageEvents = events.filter((e): e is StageEvent => e.type === 'stage')
  const lifecycle = events.filter((e): e is LifecycleEvent => e.type === 'lifecycle')
  for (const e of stageEvents) if (!e.work_id) notices.push({ level: 'warn', source: 'events', message: `stage event without work_id (${e.stage} ${e.status} at ${e.ts}) cannot be tied to an item` })

  // ---- GitHub ----
  const issues = new Map<string, Issue>()
  const pulls = new Map<string, Pull>()
  const revertedPr = new Map<number, { at: string; ref: string; title: string }>()
  const pullByHead = new Map<string, Pull>()
  const rank = (x: Pull) => (x.state === 'OPEN' ? 2 : x.state === 'MERGED' ? 1 : 0)
  const better = (p: Pull, prev: Pull | undefined) => !prev || rank(p) > rank(prev) || (rank(p) === rank(prev) && Date.parse(p.createdAt) > Date.parse(prev.createdAt))
  for (const i of gh.data?.issues ?? []) issues.set(String(i.number), i)
  for (const p of gh.data?.pulls ?? []) {
    const m = /^work\/([A-Za-z0-9._]+)-/.exec(p.headRefName)
    if (m) {
      if (better(p, pulls.get(m[1]!))) pulls.set(m[1]!, p)
      if (better(p, pullByHead.get(p.headRefName))) pullByHead.set(p.headRefName, p)
    }
    const rv = /Reverts [\w.-]+\/[\w.-]+#(\d+)/.exec(p.body)
    if (p.state === 'MERGED' && /^Revert "/.test(p.title) && rv) revertedPr.set(Number(rv[1]), { at: p.mergedAt ?? p.createdAt, ref: `PR #${p.number}`, title: p.title })
  }

  // ---- the item universe ----
  const ids = new Set<string>()
  const folderNames = new Map<string, Set<string>>()
  for (const s of sources) {
    const m = /^work\/([^/]+)\//.exec(s.path)
    const fm = m && FOLDER.exec(m[1]!)
    if (!fm) continue
    ids.add(fm[1]!)
    if (!folderNames.has(fm[1]!)) folderNames.set(fm[1]!, new Set())
    folderNames.get(fm[1]!)!.add(m![1]!)
  }
  for (const b of branches) ids.add(FOLDER.exec(b.name.slice(5))![1]!)
  for (const e of events) if ((e.type === 'stage' || e.type === 'lifecycle') && e.work_id) ids.add(e.work_id)
  // factory issues, and in team mode the items dispatch made (feature:<f>); deriveItem decides which are items
  for (const [id, i] of issues) if (i.labels.some((l) => (l.startsWith('factory:') && l !== 'factory:improvement') || l.startsWith('feature:'))) ids.add(id)
  for (const id of pulls.keys()) ids.add(id)

  // index once: a per-item scan of every file and event is O(items x events)
  const groupBy = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>()
    for (const x of xs) {
      const k = key(x)
      const a = m.get(k)
      if (a) a.push(x)
      else m.set(k, [x])
    }
    return m
  }
  const byPath = groupBy(sources, (s) => s.path)
  const testsById = groupBy(
    sources.filter((s) => s.path.startsWith('tests/acceptance/')),
    (s) => testOf(s.path) ?? '',
  )
  const stageById = groupBy(stageEvents, (e) => e.work_id)
  const lifeById = groupBy(lifecycle, (e) => e.work_id)
  // ticket transitions (ticket.sh): an item that does a ticket is that ticket's issue
  const ticketsById = groupBy(
    events.flatMap((e) => {
      if (e.type !== 'unknown' || !e.ts || !e.raw.includes('"ticket"')) return []
      try {
        const o = JSON.parse(e.raw) as Record<string, unknown>
        const state = typeof o.state === 'string' ? o.state : undefined
        return o.type === 'ticket' && (typeof o.number === 'string' || typeof o.number === 'number') ? [{ id: String(o.number), ts: e.ts, what: `ticket ${String(o.action ?? '?')}${state ? ` (${state})` : ''}`, state }] : []
      } catch {
        return []
      }
    }),
    (x) => x.id,
  )
  // an item tried more than once (work/<id>-<slug>, then work/<id>-<slug>-2): the newest attempt is the item
  const attempt = (name: string) => Number(/-(\d+)$/.exec(name)?.[1] ?? 1)

  // a branch name to a ref to read: origin's copy first (teams push there; a local branch may lag)
  const resolved = new Map<string, string | null>()
  const resolve = async (name: string) => {
    if (!isGit) return null
    if (!resolved.has(name)) {
      let ref: string | null = null
      for (const r of [`origin/${name}`, name]) if (!ref && (await g.git(repo, ['rev-parse', '--verify', '-q', `refs/${r.startsWith('origin/') ? 'remotes' : 'heads'}/${r}`]).catch(() => null))) ref = r
      resolved.set(name, ref)
    }
    return resolved.get(name)!
  }
  const inputs: ItemInputs[] = []
  for (const id of ids) {
    const itemNotices: Notice[] = []
    // the open PR's branch is the live attempt; otherwise the newest branch (by its last commit), then the highest -<n>
    const tries = branches.filter((b) => b.name.startsWith(`work/${id}-`)).sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || attempt(b.name) - attempt(a.name))
    const ranked = pulls.get(id)
    const branch = (ranked?.state === 'OPEN' && tries.find((b) => b.name === ranked.headRefName)) || tries[0]
    // the PR of that attempt; another attempt's PR only when it is not older than this attempt's work
    const pull = (branch && pullByHead.get(branch.name)) ?? (branch && ranked && Date.parse(ranked.createdAt) < Date.parse(branch.time) ? undefined : ranked)
    if (ranked && pull !== ranked) itemNotices.push({ level: 'info', source: `item #${id}`, message: `PR #${ranked.number} (${ranked.state.toLowerCase()}) was an earlier attempt from ${ranked.headRefName}; showing the newer ${branch!.name}` })
    const names = [...(folderNames.get(id) ?? [])].sort((a, b) => attempt(b) - attempt(a))
    const folder = branch?.name.slice(5) ?? names[0]
    if (names.length > 1) itemNotices.push({ level: 'warn', source: `item #${id}`, message: `more than one work folder for #${id}: ${names.join(', ')}; using ${folder}` })
    const slug = folder ? FOLDER.exec(folder)?.[2] : undefined

    // files: per file, worktree beats branch beats main, all from the one attempt's folder
    // (another attempt's BLOCKED.md or spec is not this attempt's)
    const files: ItemInputs['files'] = {}
    for (const name of WORK_FILES) {
      const cands = [...new Set(folder ? [folder] : names)]
        .flatMap((n) => byPath.get(`work/${n}/${name}`) ?? [])
        .filter((s) => s.origin !== 'branch' || s.ref === branch?.ref)
        .sort((a, b) => ORDER[a.origin] - ORDER[b.origin])
      const pick = cands[0]
      if (pick) {
        const { text, time } = await pick.read()
        files[name as WorkFileName] = { path: pick.path, text, time, origin: pick.origin }
      }
    }

    // acceptance test references: lines that name AC-<n>
    const testRefs: TestRef[] = []
    const testSrc = new Map<string, Source>()
    for (const s of (testsById.get(id) ?? []).sort((a, b) => ORDER[a.origin] - ORDER[b.origin])) {
      if (s.origin === 'branch' && s.ref !== branch?.ref) continue
      if (!testSrc.has(s.path)) testSrc.set(s.path, s)
    }
    for (const s of testSrc.values()) {
      const { text } = await s.read()
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\bAC[-_ ]?(\d+)\b/gi)) testRefs.push({ ac: `AC-${Number(m[1])}`, file: s.path, line: i + 1, text: line.trim().slice(0, 200) })
      })
    }

    // what the change is measured against: the PR's base, else the feature branch it was dispatched on, else main
    const feature = issues.get(id)?.labels.find((l) => l.startsWith('feature:'))?.slice(8)
    const base = (pull?.baseRefName && (await resolve(pull.baseRefName))) || (feature && (await resolve(`feature/${feature}`))) || main
    const om = folder ? onMain.get(folder) ?? names.map((n) => onMain.get(n)).find(Boolean) : undefined
    let changed: string[] | undefined
    if (pull?.files.length) changed = pull.files.map((f) => f.path)
    else if (branch && base && !om) {
      const r = await g.workRange(repo, base, branch.ref, pull)
      changed = await g.changedFiles(repo, r.from, r.to)
    }
    else if (om) changed = om.files

    // events of another attempt (its own work/<id>-* branch) are not this attempt's
    const mine = branch?.name ?? (folder ? `work/${folder}` : undefined)
    const other = (e: { branch: string }) => !!mine && e.branch !== mine && e.branch.startsWith(`work/${id}-`)
    const stageAll = stageById.get(id) ?? []
    inputs.push({
      id,
      slug,
      files,
      stageEvents: stageAll.filter((e) => !other(e)),
      lifecycle: (lifeById.get(id) ?? []).filter((e) => !other(e)),
      earlierAttempts: new Set([...tries.map((b) => b.name), ...stageAll.map((e) => e.branch)].filter((b) => b.startsWith(`work/${id}-`) && b !== mine && attempt(b) < attempt(mine ?? ''))).size,
      issue: issues.get(id),
      pull,
      branch: branch?.name,
      onMain: om ? { at: om.at, sha: om.sha } : undefined,
      changedFiles: changed,
      base: base ?? undefined,
      testRefs,
      tickets: (ticketsById.get(id) ?? []).map(({ ts, what, state }) => ({ ts, what, state })),
      revertedBy: (pull && revertedPr.get(pull.number)) ?? (om ? revertedSha.get(om.sha) : undefined),
      notices: itemNotices,
    })
  }

  // observations: one file per item, newest copy wins
  const obsByName = new Map<string, Source>()
  for (const s of sources.filter((s) => s.path.startsWith('memory/observations/') && s.path.endsWith('.md')).sort((a, b) => ORDER[a.origin] - ORDER[b.origin])) {
    if (!obsByName.has(s.path)) obsByName.set(s.path, s)
  }
  const observations: ObservationFile[] = []
  for (const s of obsByName.values()) {
    const r = parseObservationFile(s.path, (await s.read()).text)
    observations.push(r.value)
    notices.push(...r.notices)
  }

  return {
    repo,
    isGit,
    head,
    main,
    autoMergeMax,
    rules,
    worktrees,
    inputs,
    events,
    lifecycle,
    observations,
    escapedIssues: (gh.data?.issues ?? []).filter((i) => i.labels.includes('escaped-defect')).map((i) => ({ number: i.number, title: i.title, url: i.url, createdAt: i.createdAt })),
    github: { ...gh.status, repo: gh.data?.repo },
    notices,
    findings,
  }
}
