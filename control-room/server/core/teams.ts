// Team mode (factory/teams.json): the roster, the planning cycle, features and team sessions, and
// what in them needs the human. Pure: sources/teams.ts reads the files. Every input may be missing,
// garbled or hostile; that becomes a notice or an error string, never an exception. Text from the
// factory (message bodies, briefs, decisions) is passed through as strings, never interpreted.
import { z } from 'zod'
import type { ItemView, NeedsEntry } from './derive.ts'
import type { FactoryEvent, Issue, Notice, Parsed, Pull } from './types.ts'

// ---------- the roster ----------

export interface Team {
  name: string
  owns: string[]
  active: boolean
  review?: 'ui' | 'evidence' // ui_review / evidence_review
}
export interface Roster {
  teams: Team[]
  roundMinutes: number // limits.round_minutes [60]
}

const TEAM_NAME = /^[a-z0-9_-]+$/

/** factory/teams.json the way lib.sh reads it: other keys and badly named teams are ignored. */
export function parseRoster(text: string): Parsed<Roster> {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not valid JSON', raw: text }
  }
  const o = (j && typeof j === 'object' ? j : {}) as { teams?: unknown; limits?: { round_minutes?: unknown } }
  if (!o.teams || typeof o.teams !== 'object' || Array.isArray(o.teams)) return { ok: false, error: 'no "teams" object', raw: text }
  const warnings: string[] = []
  const teams: Team[] = []
  for (const [name, v] of Object.entries(o.teams as Record<string, unknown>)) {
    if (!TEAM_NAME.test(name)) {
      warnings.push(`team ${JSON.stringify(name)} ignored: a name is lowercase letters, digits, - and _`)
      continue
    }
    const t = (v && typeof v === 'object' ? v : {}) as { owns?: unknown; active?: unknown; ui_review?: unknown; evidence_review?: unknown }
    const owns = Array.isArray(t.owns) ? t.owns.filter((s): s is string => typeof s === 'string') : []
    teams.push({ name, owns, active: t.active !== false, review: t.ui_review === true ? 'ui' : t.evidence_review === true ? 'evidence' : undefined })
  }
  const rm = Number(o.limits?.round_minutes)
  return { ok: true, value: { teams, roundMinutes: Number.isInteger(rm) && rm >= 0 ? rm : 60 }, warnings }
}

// ---------- the planning cycle ----------

const str = z.preprocess((v) => v ?? undefined, z.string().optional()).catch(undefined)
const num = z.preprocess((v) => (v === null || v === '' ? undefined : typeof v === 'string' ? Number(v) : v), z.number().int().nonnegative().optional()).catch(undefined)

const CycleStateSchema = z.object({
  cycle: str,
  status: z.string(),
  teams: z.array(z.string()), // round.sh: a state without a teams array is damaged
  pr: num,
  draft: num,
  feature: str,
  strikes: z.record(z.string(), z.number()).catch({}).default({}),
  unanswered: z.array(z.string()).catch([]).default([]),
  round_started_at: str,
  history: z.array(z.object({ status: z.string(), at: z.string() })).catch([]).default([]),
})
export type CycleState = z.infer<typeof CycleStateSchema>

export function parseCycleState(text: string): Parsed<CycleState> {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, error: 'state.json is not valid JSON', raw: text }
  }
  const r = CycleStateSchema.safeParse(j)
  if (!r.success) return { ok: false, error: `state.json: ${r.error.issues.map((i) => `${i.path.join('.') || 'state'}: ${i.message}`).join('; ')}`, raw: text }
  return { ok: true, value: r.data, warnings: [] }
}

const MessageSchema = z.object({
  id: z.string(),
  ts: z.string(),
  round: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  refs: z.array(z.string()).catch([]).default([]),
  body: z.string().catch('').default(''),
  draft: num,
  attach: str,
})
export type Message = z.infer<typeof MessageSchema>

/** discussion.jsonl: one message per line. A bad line is a notice; the rest still show. */
export function parseDiscussion(text: string, source: string): { messages: Message[]; notices: Notice[] } {
  const messages: Message[] = []
  const notices: Notice[] = []
  text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    if (!line.trim()) return
    let j: unknown
    try {
      j = JSON.parse(line)
    } catch {
      notices.push({ level: 'warn', source, message: `line ${i + 1}: not valid JSON, skipped`, raw: line })
      return
    }
    const r = MessageSchema.safeParse(j)
    if (r.success) messages.push(r.data)
    else notices.push({ level: 'warn', source, message: `line ${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.') || 'message'}: ${x.message}`).join('; ')}`, raw: line })
  })
  return { messages, notices }
}

export interface DecisionRecord {
  id: string
  title: string
  status?: string // decided | needs-human | superseded
}

/** The `## c001-D02: Title` records of DECISIONS.md and their `- status:` lines (decisions.sh's format). */
export function decisionRecords(text: string): DecisionRecord[] {
  const recs: DecisionRecord[] = []
  let cur: DecisionRecord | undefined
  let inSection = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^## (\S+?):\s*(.*)$/.exec(line)
    if (/^##\s+Work breakdown\s*$/i.test(line) || (!h && line.startsWith('## '))) cur = undefined
    else if (h) {
      cur = { id: h[1]!, title: h[2]!.trim() }
      recs.push(cur)
      inSection = false
    } else if (cur && line.startsWith('### ')) inSection = true
    else if (cur && !inSection) {
      const s = /^- status:\s*(\S+)/.exec(line)
      if (s) cur.status = s[1]
    }
  }
  return recs
}

export interface Owed {
  team: string
  owes: string
}

/** Who the round waits for, by the round's own rule (round.sh `ready`). Positions are known
 *  only as submitted or not: a sealed position is never read. */
export function waitingFor(s: CycleState, messages: Message[], submitted: string[]): Owed[] {
  const draft = s.draft ?? 0
  if (s.status === 'positions') return s.teams.filter((t) => !submitted.includes(t)).map((team) => ({ team, owes: 'a position' }))
  if (s.status.startsWith('discussion-')) {
    const owed: Owed[] = []
    for (const q of messages.filter((m) => m.round === s.status && m.kind === 'question')) {
      const who = q.to === 'all' ? s.teams.filter((t) => t !== q.from) : q.to === 'human' ? [] : [q.to]
      for (const team of who) if (!messages.some((a) => a.kind === 'answer' && a.from === team && a.refs.includes(q.id))) owed.push({ team, owes: `an answer to ${q.id}` })
    }
    return owed
  }
  if (s.status === 'decisions') {
    if (!draft) return [{ team: 'orchestrator', owes: 'the first draft of DECISIONS.md' }]
    const said = new Set(messages.filter((m) => m.round === 'decisions' && m.draft === draft && (m.kind === 'accept' || m.kind === 'objection')).map((m) => m.from))
    return s.teams.filter((t) => !said.has(t)).map((team) => ({ team, owes: `accept or objection on draft ${draft}` }))
  }
  if (s.status === 'review') return [{ team: 'orchestrator', owes: 'the reviews, then round.sh next' }]
  return []
}

// ---------- the whole view ----------

export interface SessionTab {
  tab: string
  state: string // idle | working | done | error | blocked | unknown
  msg?: string
  since?: string
}

export interface TeamsInput {
  roster: { text: string | null; source: string }
  cycle?: {
    name: string
    active: boolean // named by .factory/planning/active
    source: string // where its files were read: "working tree" or a ref
    onMain: boolean // main has its record: the planning pull request was merged
    state: string | null
    discussion: string | null
    brief: string | null
    decisions: string | null
    submitted: string[] // teams with a sealed position (existence only)
  }
  features: { name: string; refs: { feature?: string; integrate?: string }; docs: { file: string; ref: string; text: string }[] }[]
  checkouts: { team: string; path: string; branch: string | null; exists: boolean }[] // the orchestrator's is the main checkout
  sessions: { available: boolean; tabs: SessionTab[] }
  events: FactoryEvent[]
}

export interface CycleView {
  name: string
  active: boolean
  source: string
  state?: CycleState
  error?: string
  brief?: string
  records: DecisionRecord[]
  waiting: Owed[]
  messages: Message[]
  events: { ts: string; type: string; team?: string; text: string }[]
  pr?: { number: number; url?: string; state?: Pull['state']; isDraft?: boolean; labels: string[] }
  /** other open PRs that change planning/<cycle>/ (a fix to DECISIONS.md...): the cycle waits on them */
  blocking: { number: number; url: string; title: string; head: string; labels: string[]; why: string }[]
}

export interface FeatureView {
  name: string
  refs: { feature?: string; integrate?: string }
  items: { number: number; title: string; url: string; team?: string; ticket: boolean; open: boolean; item?: { state: ItemView['state']; pr?: number } }[]
  docs: { file: string; ref: string; headline: string; text: string }[]
  pulls: { number: number; url: string; title: string; state: Pull['state']; head: string }[]
}

export interface TeamRow {
  name: string
  owns: string[]
  active: boolean
  review?: Team['review']
  inRoster: boolean // false: a session tab that is not a team (the sweep)
  checkout?: { path: string; branch: string | null; exists: boolean }
  item?: { id: string; title: string; state: ItemView['state'] }
  session?: SessionTab
}

export interface TeamsView {
  rosterSource: string
  rosterError?: string
  cycle?: CycleView
  features: FeatureView[]
  teams: TeamRow[]
  sessions: { available: boolean }
}

const DOC_HEADLINE: Record<string, (t: string) => string> = {
  'acceptance.md': (t) => `${(t.match(/^## AC\d+\b/gm) ?? []).length} criteria`,
  'e2e-report.md': (t) => [/^E2E: .*$/m.exec(t)?.[0], /^round: .*$/m.exec(t)?.[0]].filter(Boolean).join(', ') || 'no E2E line',
  'acceptance-review.md': (t) => /^VERDICT: .*$/m.exec(t)?.[0] ?? 'no VERDICT line',
}

/** What a planning event says, in a few words (the transcript has the messages themselves). */
function eventText(o: Record<string, unknown>): string {
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  switch (o.type) {
    case 'round': return `round: ${s('status')}`
    case 'approval': return `approved: ${s('what')}`
    case 'position': return `position ${s('action')}`
    case 'contract': return `contract ${s('action')}: ${s('path')}`
    case 'dispatch': return `dispatched ${s('item')} to ${s('to')} (${s('feature')})`
    case 'autostart': return `autostart typed ${s('detail')}`
    default: return String(o.type)
  }
}

export function deriveTeams(inp: TeamsInput, gh: { issues: Issue[]; pulls: Pull[] }, items: Map<string, ItemView>): { view: TeamsView; needs: NeedsEntry[]; notices: Notice[] } {
  const notices: Notice[] = []
  const needs: NeedsEntry[] = []

  // roster
  const r = inp.roster.text === null ? null : parseRoster(inp.roster.text)
  const rosterError = !r ? 'factory/teams.json is missing' : r.ok ? undefined : `factory/teams.json: ${r.error}`
  if (rosterError) notices.push({ level: 'error', source: 'factory/teams.json', message: rosterError, raw: r && !r.ok ? r.raw : undefined })
  if (r?.ok) r.warnings.forEach((w) => notices.push({ level: 'warn', source: 'factory/teams.json', message: w }))
  const roster = r?.ok ? r.value : undefined

  // the cycle
  let cycle: CycleView | undefined
  if (inp.cycle) {
    const c = inp.cycle
    const src = `planning/${c.name}`
    const st = c.state === null ? undefined : parseCycleState(c.state)
    const error = !st ? `${src}/state.json is missing` : st.ok ? undefined : st.error
    if (error) notices.push({ level: 'error', source: `${src}/state.json`, message: error, raw: st && !st.ok ? st.raw : undefined })
    const state = st?.ok ? st.value : undefined
    const disc = c.discussion === null ? { messages: [], notices: [] } : parseDiscussion(c.discussion, `${src}/discussion.jsonl`)
    notices.push(...disc.notices)
    const records = c.decisions === null ? [] : decisionRecords(c.decisions)
    const pull = state?.pr ? gh.pulls.find((p) => p.number === state.pr) : undefined
    const settled = state?.status === 'dispatched' || state?.status === 'closed'
    // by its files; by its branch name only when GitHub gave no file list
    const touches = (p: Pull) => (p.files.length ? p.files.some((f) => f.path.startsWith(`${src}/`)) : p.headRefName.startsWith(`${src}-`))
    const blocking = settled ? [] : gh.pulls
      .filter((p) => p.state === 'OPEN' && p.number !== state?.pr && p.headRefName !== src && touches(p)) // not the cycle's own PR
      .sort((a, b) => a.number - b.number)
      .map((p) => ({ number: p.number, url: p.url, title: p.title, head: p.headRefName, labels: p.labels, why: `PR #${p.number} must merge${state?.status === 'approval' ? ', then /dispatch' : ''}` }))
    const events: CycleView['events'] = []
    for (const e of inp.events) {
      if (e.type !== 'unknown') continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(e.raw) as Record<string, unknown>
      } catch {
        continue
      }
      // messages are in the transcript itself; autostart names the cycle or its feature in what it typed
      const typed = o?.type === 'autostart' && typeof o.detail === 'string' && (o.detail.endsWith(` ${c.name}`) || o.detail.endsWith(` f${c.name.slice(1)}`))
      if (o && (o.cycle === c.name || typed) && o.type !== 'message' && typeof o.ts === 'string') events.push({ ts: o.ts, type: String(o.type), team: typeof o.team === 'string' ? o.team : undefined, text: eventText(o) })
    }
    cycle = {
      name: c.name,
      active: c.active,
      source: c.source,
      state,
      error,
      brief: c.brief ?? undefined,
      records,
      waiting: state ? waitingFor(state, disc.messages, c.submitted) : [],
      messages: disc.messages,
      events: events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
      pr: state?.pr ? { number: state.pr, url: pull?.url, state: pull?.state, isDraft: pull?.isDraft, labels: pull?.labels ?? [] } : undefined,
      blocking,
    }

    // what in it needs the human, and whose turn it is outside the timed rounds
    const since = state?.history.at(-1)?.at ?? state?.round_started_at ?? ''
    const base = { id: `cycle-${c.name}`, label: `planning ${c.name}`, href: '/planning', since }
    const prOpen = pull ? pull.state === 'OPEN' : !c.onMain // without GitHub data: open until main has the record
    const briefOk = !!pull?.labels.includes('brief-approved')
    if (state?.status === 'brief') cycle.waiting.push(!state.pr ? { team: 'orchestrator', owes: 'the brief (round.sh brief)' } : briefOk ? { team: 'orchestrator', owes: 'round.sh next' } : { team: 'you', owes: `the label brief-approved on PR #${state.pr}` })
    if (state?.status === 'approval' && prOpen) cycle.waiting.push({ team: 'you', owes: `human-approved and a merge of PR #${state.pr ?? '?'}` })
    // a fix to the cycle's files in its own PR: whoever merges it (you, above the auto-merge tier) goes first
    else if (blocking.length) cycle.waiting.push(...blocking.map((b) => ({ team: 'you', owes: b.why })))
    else if (state?.status === 'approval') cycle.waiting.push({ team: 'orchestrator', owes: '/dispatch' })
    if (state?.status === 'escalated') cycle.waiting.push({ team: 'you', owes: 'a decision: the meeting stopped at two strikes' })
    if (state?.status === 'brief' && state.pr && prOpen && !briefOk) {
      needs.push({ ...base, kind: 'approve', title: 'Approve the brief', summary: `read BRIEF.md, then add the label brief-approved to PR #${state.pr}` })
    }
    if (state?.status === 'approval' && state.pr && prOpen) {
      const approved = !!pull?.labels.includes('human-approved')
      needs.push({ ...base, kind: approved ? 'merge' : 'approve', title: 'Approve the decisions', summary: approved ? `PR #${state.pr} is approved: merge it` : `settle any needs-human record, add human-approved to PR #${state.pr}, merge it`, tier: 'R2' })
    }
    if (state?.status === 'escalated') {
      const out = Object.entries(state.strikes).filter(([, n]) => n >= 2).map(([t]) => t)
      needs.push({ ...base, kind: 'failed', title: 'The planning meeting stopped', summary: `two strikes${out.length ? ` (${out.join(', ')})` : ''}: decide, or have the orchestrator run round.sh abandon` })
    }
    if (state?.status !== 'dispatched' && state?.status !== 'closed') {
      for (const d of records.filter((x) => x.status === 'needs-human')) {
        needs.push({ ...base, id: `decision-${d.id}`, label: d.id, kind: 'answer', title: d.title || d.id, summary: `needs-human record in planning/${c.name}/DECISIONS.md: decide it` })
      }
    }
  }

  // features: their issues (feature:<f>, team:<t>, ticket) and where each is
  const featureOf = (labels: string[]) => labels.find((l) => l.startsWith('feature:'))?.slice(8)
  const names = new Set([...inp.features.map((f) => f.name), ...gh.issues.map((i) => featureOf(i.labels)).filter((x): x is string => !!x)])
  const features: FeatureView[] = [...names].sort().map((name) => {
    const f = inp.features.find((x) => x.name === name)
    return {
      name,
      refs: f?.refs ?? {},
      items: gh.issues
        .filter((i) => featureOf(i.labels) === name)
        .sort((a, b) => a.number - b.number)
        .map((i) => {
          const it = items.get(String(i.number))
          return {
            number: i.number, title: i.title, url: i.url, team: i.labels.find((l) => l.startsWith('team:'))?.slice(5), ticket: i.labels.includes('ticket'), open: i.state === 'OPEN',
            item: it ? { state: it.state, pr: it.pr?.number } : undefined,
          }
        }),
      docs: (f?.docs ?? []).map((d) => ({ ...d, headline: DOC_HEADLINE[d.file]?.(d.text) ?? '' })),
      pulls: gh.pulls
        .filter((p) => p.headRefName === `integrate/${name}` || p.headRefName === `sync/${name}`)
        .map((p) => ({ number: p.number, url: p.url, title: p.title, state: p.state, head: p.headRefName })),
    }
  })

  // teams: roster, checkout, the item it holds, its session
  const tabs = inp.sessions.tabs
  const teams: TeamRow[] = (roster?.teams ?? []).map((t) => {
    const co = inp.checkouts.find((c) => c.team === t.name)
    const id = co?.branch && /^work\/([A-Za-z0-9._]+)-/.exec(co.branch)?.[1]
    const it = id ? items.get(id) : undefined
    return {
      name: t.name, owns: t.owns, active: t.active, review: t.review, inRoster: true,
      checkout: co && { path: co.path, branch: co.branch, exists: co.exists },
      item: id ? { id, title: it?.title ?? co!.branch!.slice(5), state: it?.state ?? 'in-progress' } : undefined,
      session: tabs.find((s) => s.tab === t.name),
    }
  })
  // the sweep's tab besides the roster; any other tab in the space is not the factory's to show
  const ours = (tab: string) => tab === 'sweep' || teams.some((t) => t.name === tab)
  for (const s of tabs) if (s.tab === 'sweep') teams.push({ name: s.tab, owns: [], active: true, inRoster: false, session: s })
  for (const co of inp.checkouts) {
    if (!co.exists && teams.some((t) => t.name === co.team)) notices.push({ level: 'warn', source: 'git worktree', message: `the ${co.team} worktree ${co.path} no longer exists (git worktree prune removes it)` })
  }
  for (const s of tabs.filter((x) => ours(x.tab))) {
    const base = { id: `session-${s.tab}`, label: `session ${s.tab}`, href: '/', since: s.since ?? '' }
    if (s.state === 'error') needs.push({ ...base, kind: 'failed', title: `The ${s.tab} session failed`, summary: s.msg || 'Herdr reports an error' })
    if (s.state === 'blocked') needs.push({ ...base, kind: 'waiting-input', title: `The ${s.tab} session is waiting for you`, summary: s.msg || 'a prompt or dialog in its Herdr tab' })
  }

  return { view: { rosterSource: inp.roster.source, rosterError, cycle, features, teams, sessions: { available: inp.sessions.available } }, needs, notices }
}
