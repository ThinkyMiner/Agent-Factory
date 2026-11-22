// Views over the factory's own files (see sources/meta.ts): Memory, Improvement, Factory, Audits.
// Pure, so tests/meta.test.ts can check them; nothing here infers meaning from prose.
import { parseLessons, parsePolicy, parseReflection, splitFrontmatter } from './parse.ts'
import type { NeedsEntry, NeedsKind } from './derive.ts'
import { classify, type RiskRule } from './risk.ts'
import { checkState, checksWait, currentChecks, maxTier, prChecks, tierRank, type Check, type Notice, type Tier, type ObservationFile, type Parsed, type Pull, type Reflection, type ReflectionChange, type ReflectionResult } from './types.ts'

export type Drift = 'same' | 'modified' | 'added' | 'deleted'
export interface MetaFile {
  path: string
  drift: Drift // the working tree against main
  where?: 'uncommitted' | 'branch' // a drift committed on the checked-out branch, or not committed at all
  text: string | null // the working-tree copy (main's when deleted); null when too large
  mainText: string | null
}
export type FileFlag = Pick<MetaFile, 'path' | 'drift' | 'where'>

const flag = (f: MetaFile): FileFlag => ({ path: f.path, drift: f.drift, ...(f.where && { where: f.where }) })
const find = (files: MetaFile[], path: string) => files.find((f) => f.path === path)
const under = (files: MetaFile[], dir: string) => files.filter((f) => f.path.startsWith(`${dir}/`) && f.path.endsWith('.md'))
const ids = (s: string | undefined) => [...new Set([...(s ?? '').matchAll(/#(\d+)/g)].map((m) => m[1]!))]
const tooLarge = (path: string): Notice => ({ level: 'warn', source: path, message: 'too large to read (over 512 KB)' })

// ---------- Memory ----------

export function memoryView(files: MetaFile[], observations: ObservationFile[]) {
  const f = find(files, 'memory/lessons.md')
  const parsed = f?.text != null ? parseLessons(f.text) : null
  return {
    file: f && flag(f),
    cap: 40, // MEMORY.md: "lessons.md is capped at 40 entries"
    lessons: parsed?.lessons ?? [],
    notices: parsed?.notices ?? (f ? [tooLarge(f.path)] : []),
    observations: observations.flatMap((o) => o.items.map((x, i) => ({ ...x, key: `${o.file}#${i}`, date: o.date, workId: o.workId, file: o.file }))),
  }
}
export type MemoryView = ReturnType<typeof memoryView>

// ---------- Improvement ----------

export interface Prediction extends ReflectionChange {
  date: string // the reflection that proposed it
  file: string
  evidenceIds: string[]
  check?: ReflectionResult & { checkedIn: string } // the first later reflection that checked it
}

/** Each change a reflection proposed, joined to the later reflection that checked it (by change id). */
export function predictions(reflections: Reflection[]): Prediction[] {
  const sorted = [...reflections].sort((a, b) => a.date.localeCompare(b.date))
  return sorted.flatMap((r) =>
    r.changes.map((c) => {
      const later = sorted.filter((x) => x.date > r.date)
      const check = c.id ? later.flatMap((x) => x.results.filter((res) => res.id === c.id).map((res) => ({ ...res, checkedIn: x.date })))[0] : undefined
      return { ...c, date: r.date, file: r.file, evidenceIds: ids(c.evidence), ...(check && { check }) }
    }),
  )
}

export function improvementView(files: MetaFile[], pulls: Pull[]) {
  const reflections = under(files, 'memory/reflections').map((f) => ({
    ...flag(f),
    date: /(\d{4}-\d{2}-\d{2})/.exec(f.path)?.[1] ?? '',
    parsed: (f.text == null ? { ok: false, error: 'too large to read', raw: '' } : parseReflection(f.path, f.text)) as Parsed<Reflection>,
    text: f.text,
  }))
  reflections.sort((a, b) => b.date.localeCompare(a.date))
  const preds = predictions(reflections.flatMap((r) => (r.parsed.ok ? [r.parsed.value] : [])))
  const open = pulls
    .filter((p) => p.state === 'OPEN' && p.labels.includes('factory:improvement'))
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      createdAt: p.createdAt,
      isDraft: p.isDraft,
      approved: p.labels.includes('human-approved'),
      tier: /^risk:(R[0-3])$/.exec(p.labels.find((l) => l.startsWith('risk:')) ?? '')?.[1],
      checks: currentChecks(p.checks).map((c) => ({ name: c.name, state: checkState(c) })),
      files: p.files.map((x) => x.path),
    }))
  const count = (r: string) => preds.filter((p) => p.check?.result === r).length
  return {
    pulls: open,
    reflections,
    predictions: preds,
    summary: { worked: count('worked'), noEffect: count('no effect'), worse: count('worse'), unchecked: preds.filter((p) => !p.check).length },
  }
}
export type ImprovementView = ReturnType<typeof improvementView>

/** A pull request that is not a work item (an improvement PR): the highest of its risk label and
 *  its files classified with main's rules. Nothing can lower it. */
export function pullTier(p: Pull, rules: RiskRule[]) {
  const label = /^risk:(R[0-3])$/.exec(p.labels.find((l) => l.startsWith('risk:')) ?? '')?.[1] as Tier | undefined
  const files = p.files.length ? classify(p.files.map((f) => f.path), rules) : null
  const sources = [...(label ? [{ source: 'pr-label' as const, tier: label, why: `risk:${label} label` }] : []), ...(files ? [{ source: 'paths' as const, tier: files.tier }] : [])]
  return { tier: maxTier(sources.map((x) => x.tier)), sources, files: files?.files ?? [] }
}

/** The one next action on an open pull request and who takes it. Needs you, Planning and the strip all say this.
 *  R2 needs the human-approved label; risk-gate fails until then, and CI re-runs it on the label, so a
 *  risk-gate failure is stale only when it provably completed before the label (as derive.ts reads it).
 *  Any other failing check comes first: auto-merge never merges a red pull request. */
export function prNext(p: Pull, tier: Tier | undefined, autoMergeMax: Tier | 'none'): { kind: NeedsKind; who: string; what: string; failing: string[]; approved: boolean } {
  const r2 = !!tier && tierRank(tier) >= 2
  const approved = p.labels.includes('human-approved')
  const checks = prChecks(p, tier)
  const failing = checks.failing
  const base = { failing, approved }
  if (p.isDraft) return { ...base, kind: 'info', who: 'its author', what: 'mark it ready for review' } // first: a draft merges for no one
  if (failing.length) return { ...base, kind: 'failed', who: 'its author', what: `fix the failing check${failing.length > 1 ? 's' : ''}: ${failing.join(', ')}` }
  if (r2 && !approved) return { ...base, kind: 'approve', who: 'you', what: p.autoMerge ? 'add human-approved; auto-merge then merges it once the checks pass' : 'add human-approved, wait for the checks to pass, then merge' }
  if (p.autoMerge) return { ...base, kind: 'info', who: 'GitHub', what: 'auto-merge merges it when the checks pass' }
  // no merge until every check is green, after the label too
  if (checks.pending.length) return { ...base, kind: 'info', who: 'CI', what: `wait for ${checksWait(checks)} to pass` }
  const below = !!tier && tierRank(tier) <= tierRank(autoMergeMax)
  return { ...base, kind: 'merge', who: 'you', what: `merge it${below && !approved ? ' (auto-merge is not on)' : ''}` }
}

/** Open pull requests that are not work items (an improvement, a planning fix, a factory change, the
 *  feature's PR to main) need you like any item's PR when above the auto-merge tier. `skip`: PRs shown
 *  elsewhere (work items, the planning cycle's own PR). `waits`: what waits on a PR (the planning cycle),
 *  said on its row; such a PR is shown even at or below the auto-merge tier, so nothing waits unseen. */
export function pullNeeds(pulls: Pull[], rules: RiskRule[], autoMergeMax: Tier | 'none', skip: Set<number> = new Set(), waits: Map<number, string> = new Map(), teamMode = false): NeedsEntry[] {
  return pulls
    .filter((p) => p.state === 'OPEN' && !p.isDraft && !skip.has(p.number))
    .flatMap((p): NeedsEntry[] => {
      const { tier } = pullTier(p, rules)
      const wait = waits.get(p.number)
      // at or below the auto-merge tier it is the factory's to merge, unless something waits on it
      if ((!tier || tierRank(tier) <= tierRank(autoMergeMax)) && !wait) return []
      const n = prNext(p, tier, autoMergeMax)
      const improvement = p.labels.includes('factory:improvement')
      // ponytail: the label counts as approval; GitHub's push times are not fetched, so a label older
      // than the last push shows only as risk-gate failing on the PR. Fetch push activity if that bites.
      const head = improvement ? 'factory:improvement' : p.headRefName
      const what = n.kind === 'failed' ? `${n.approved ? 'approved, but failing' : 'failing'}: ${n.failing.join(', ')}` : n.kind === 'approve' && improvement ? '' : `${n.approved ? 'approved: ' : ''}${n.what}`
      const tail = n.kind === 'failed' ? '' : ` · ${tier ?? 'no risk tier yet'}${n.failing.length ? ` · failing: ${n.failing.join(', ')}` : ''}`
      return [{
        id: `pr-${p.number}`, label: `PR #${p.number}`, title: p.title, tier, since: p.createdAt,
        kind: n.kind,
        summary: `${[head, what].filter(Boolean).join(' · ')}${tail}${wait ? ` · ${wait}` : ''}${teamMode && p.headRefName.startsWith('factory/') ? ' · a kit change: teams get it after it merges and their feature syncs (integrate.sh sync); items may wait on it' : ''}`,
        href: improvement ? '/improvement' : p.url || '/',
      }]
    })
}

// ---------- Factory config ----------

function frontmatter(f: MetaFile) {
  const fm = splitFrontmatter(f.text ?? '')
  return { data: fm.data ?? {}, error: f.text == null ? 'too large to read' : fm.error }
}

export interface HookEntry {
  event: string
  matcher?: string
  commands: string[]
}
export function parseSettings(f: MetaFile) {
  try {
    const o = JSON.parse(f.text ?? '') as Record<string, unknown>
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const perms = (o.permissions ?? {}) as Record<string, unknown>
    const hooks: HookEntry[] = []
    for (const [event, list] of Object.entries((o.hooks ?? {}) as Record<string, unknown>)) {
      for (const h of Array.isArray(list) ? list : []) {
        const e = h as { matcher?: unknown; hooks?: unknown }
        const commands = (Array.isArray(e.hooks) ? e.hooks : []).map((x) => (x as { command?: unknown }).command).filter((x): x is string => typeof x === 'string')
        hooks.push({ event, ...(typeof e.matcher === 'string' && { matcher: e.matcher }), commands })
      }
    }
    return { ...flag(f), ok: true as const, allow: strings(perms.allow), deny: strings(perms.deny), ask: strings(perms.ask), hooks }
  } catch (e) {
    return { ...flag(f), ok: false as const, error: f.text == null ? 'too large to read' : `not valid JSON: ${(e as Error).message}`, raw: f.text ?? '' }
  }
}

export function factoryView(files: MetaFile[]) {
  const policy = find(files, 'factory/policy.env')
  const rules = find(files, 'factory/risk-rules.txt')
  const agents = files
    .filter((f) => /^\.claude\/agents\/[^/]+\.md$/.test(f.path))
    .map((f) => {
      const { data, error } = frontmatter(f)
      return { ...flag(f), name: data.name || f.path.split('/').pop()!.replace(/\.md$/, ''), description: data.description, model: data.model, tools: data.tools?.split(',').map((t) => t.trim()).filter(Boolean), error }
    })
  const skills = files
    .filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f.path))
    .map((f) => {
      const { data, error } = frontmatter(f)
      return { ...flag(f), name: data.name || f.path.split('/')[2]!, description: data.description, argumentHint: data['argument-hint'], manualOnly: data['disable-model-invocation'] === 'true', error }
    })
  return {
    files: files.map((f) => ({ ...flag(f), size: f.text?.length ?? null })),
    // CI reads policy and rules from main, so main's copy is the one in force
    policy: policy && {
      ...flag(policy),
      main: (policy.mainText ?? (policy.drift === 'same' ? policy.text : null)) != null ? parsePolicy((policy.mainText ?? policy.text)!) : null,
      worktree: policy.drift !== 'same' && policy.text != null ? parsePolicy(policy.text) : null,
    },
    rules: rules && { ...flag(rules), main: rules.mainText ?? (rules.drift === 'same' ? rules.text : null), worktree: rules.drift !== 'same' ? rules.text : null },
    agents,
    skills,
    settings: ['.claude/settings.json', '.claude/settings.local.json'].flatMap((p) => {
      const f = find(files, p)
      return f ? [parseSettings(f)] : []
    }),
  }
}
export type FactoryView = ReturnType<typeof factoryView>

// ---------- Audits ----------

export function auditsView(files: MetaFile[]) {
  return under(files, 'docs/factory/audits')
    .map((f) => ({ ...flag(f), date: /(\d{4}-\d{2}-\d{2})/.exec(f.path)?.[1] ?? '', text: f.text }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path))
}
export type AuditsView = ReturnType<typeof auditsView>
