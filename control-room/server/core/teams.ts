// Team mode (factory/teams.json): the roster, the planning cycle, features and team sessions, and
// what in them needs the human. Pure: sources/teams.ts reads the files. Every input may be missing,
// garbled or hostile; that becomes a notice or an error string, never an exception. Text from the
// factory (message bodies, briefs, decisions) is passed through as strings, never interpreted.
import { z } from 'zod'
import type { ItemView, NeedsEntry } from './derive.ts'
import { checkState, currentChecks, refHow, refsOf, type FactoryEvent, type Issue, type Notice, type Parsed, type Pull, type Ref, type Tier } from './types.ts'
import { roundWords } from './words.ts'
import { prNext } from './meta.ts'

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
  text: string // the record as written, below its heading (markdown, shown through the sanitising renderer)
  implementedBy?: number[] // issues whose work-breakdown row names it
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
      cur = { id: h[1]!, title: h[2]!.trim(), text: '' }
      recs.push(cur)
      inSection = false
      continue
    } else if (cur && line.startsWith('### ')) inSection = true
    else if (cur && !inSection) {
      const s = /^- status:\s*(\S+)/.exec(line)
      if (s) cur.status = s[1]
    }
    if (cur) cur.text += `${line}\n`
  }
  for (const r of recs) r.text = r.text.trim()
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

const sortByTs = <T extends { ts?: string }>(xs: T[]) => [...xs].sort((a, b) => Date.parse(a.ts ?? '') - Date.parse(b.ts ?? ''))

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
  features: { name: string; refs: { feature?: string; integrate?: string }; e2eTests?: number; docs: { file: string; ref: string; text: string }[]; dispatch: string | null }[]
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
  /** a dispatched cycle's open PRs that change planning/<cycle>/ (an amendment to its records), with their next step */
  amendments: { number: number; url: string; title: string; head: string; who: string; what: string }[]
}

export interface DispatchRow {
  item: string
  team: string
  after: string[]
  decisions: string[]
  contract?: string
  delivers?: string
}

/** dispatch.jsonl (dispatch.sh): one work-breakdown row per line. A bad line is skipped. */
export function parseDispatch(text: string): DispatchRow[] {
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return text.split('\n').flatMap((line) => {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (!o || typeof o.item !== 'string' || typeof o.team !== 'string') return []
      return [{ item: o.item, team: o.team, after: strs(o.after), decisions: strs(o.decisions), contract: typeof o.contract === 'string' && o.contract ? o.contract : undefined, delivers: typeof o.delivers === 'string' ? o.delivers : undefined }]
    } catch {
      return []
    }
  })
}

/** Which work-breakdown row an issue is: item.sh's issue names its item ("Item page-preview of ...")
 *  before anything it waits for, so the row whose name comes first in the title and body, among its team's. */
export function dispatchRowOf(issue: Pick<Issue, 'title' | 'body'>, rows: DispatchRow[], team?: string): DispatchRow | undefined {
  const text = `${issue.title}\n${issue.body.slice(0, 600)}`.toLowerCase()
  const at = (name: string) => {
    const m = new RegExp(`(^|[^a-z0-9-])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`).exec(text)
    return m ? m.index : Infinity
  }
  return rows
    .filter((r) => !team || r.team === team)
    .map((r) => ({ r, i: at(r.item) }))
    .filter((x) => x.i < Infinity)
    .sort((a, b) => a.i - b.i)[0]?.r
}

export interface FeatureView {
  name: string
  refs: { feature?: string; integrate?: string }
  e2eTests?: number // files under tests/e2e/<f>/ on the integration branch
  items: {
    number: number
    title: string
    url: string
    team?: string // team:<t>, or for a ticket the team it went to (to:<t>)
    ticket: boolean
    ticketState?: string // open | accepted | declined | done | verified: its state: label, else its last ticket event
    from?: string // a ticket's sender
    open: boolean
    item?: { state: ItemView['state']; pr?: number; prUrl?: string; autoMerge?: boolean; tier?: Tier; needs?: { kind: NeedsEntry['kind']; summary: string }; active?: boolean; last?: { stage: string; status: string; at?: string; detail?: string }
      waitsOn?: { kind: 'PR' | 'ticket'; n: number; url: string; stage: string }[] // its latest stage's waits=#<n>, open PRs and tickets only
      waitOver?: { stage: string; refs: Ref[]; sync?: { n: number; url: string } } } // none of them is open any more; sync: the feature's open sync PR, when a waited PR merged into main
    dispatch?: DispatchRow
    waitsFor?: string
  }[]
  docs: { file: string; ref: string; headline: string; text: string }[]
  attribution?: { ref: string; round?: number; rows: AttributionRow[] } // the failed round's tests, each tied to a criterion, decision, contract and team
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

/** Where the project is, in plain words: the phase, the one next step and who owns it. */
export interface Phase {
  step: 'no-cycle' | 'planning' | 'approval' | 'stopped' | 'building' | 'integration' | 'pr-to-main' | 'merged'
  label: string // "Building: 2 of 4 items merged"
  detail?: string
  next?: { who: string; what: string; href?: string }
  more?: { who: string; what: string; href?: string }[] // further owners' steps, one line each
}

export interface TeamsView {
  rosterSource: string
  rosterError?: string
  phases: Phase[] // the feature being built (if any), then the planning cycle under way (if any)
  cycle?: CycleView
  features: FeatureView[]
  teams: TeamRow[]
  sessions: { available: boolean }
}

export interface AttributionRow {
  test: string
  criterion: string
  decision: string
  contract: string
  team: string
  evidence: string
  ticket?: { number: number; url: string; state?: string } // the bug ticket integrate.sh filed for it: the team's, naming this test
  criterionUrl?: string // the criterion in acceptance.md on GitHub
  contractUrl?: string
}
/** attribution.md (integration-qa, checked by integrate.sh tickets): one line per failing test,
 *  "- test: ... | criterion: ... | decision: ... | contract: ... | team: ... | evidence: ...". Other lines are skipped. */
export function parseAttribution(text: string): { round?: number; rows: AttributionRow[] } {
  const keys = ['test', 'criterion', 'decision', 'contract', 'team', 'evidence'] as const
  const rows: AttributionRow[] = []
  let round: number | undefined
  for (const l of text.replace(/\r\n?/g, '\n').split('\n')) {
    const r = /^round: ([0-9]{1,4})$/.exec(l)
    if (r) round = Number(r[1])
    if (!l.startsWith('- test:')) continue
    const f = l.slice(2).split(' | ')
    if (f.length !== 6) continue
    const v = f.map((x, i) => new RegExp(`^${keys[i]}:\\s*(.*?)\\s*$`).exec(x)?.[1])
    if (v.every((x) => x !== undefined)) rows.push(Object.fromEntries(keys.map((k, i) => [k, v[i]!])) as unknown as AttributionRow)
  }
  return { round, rows }
}

const DOC_HEADLINE: Record<string, (t: string) => string> = {
  'attribution.md': (t) => {
    const a = parseAttribution(t)
    return `${a.rows.length} failing test${a.rows.length === 1 ? '' : 's'} attributed${a.round ? `, round ${a.round}` : ''}${a.rows.length ? ` (${[...new Set(a.rows.map((r) => r.team))].join(', ')})` : ''}`
  },
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

/** ticket.sh's events, newest last: each ticket's state when GitHub's labels are not there yet. */
export function ticketStates(events: FactoryEvent[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of sortByTs(events.filter((x): x is Extract<FactoryEvent, { type: 'unknown' }> => x.type === 'unknown' && x.raw.includes('"ticket"')))) {
    try {
      const o = JSON.parse(e.raw) as Record<string, unknown>
      if (o.type === 'ticket' && typeof o.state === 'string' && (typeof o.number === 'string' || typeof o.number === 'number')) m.set(String(o.number), o.state)
    } catch {
      /* not JSON: already a notice */
    }
  }
  return m
}

/** `next`: a pull request's one next action and who takes it (state.ts passes the risk rules in), the same
 *  function Needs you uses, so the two never disagree. Without it a planning PR is taken as R2. */
export function deriveTeams(inp: TeamsInput, gh: { issues: Issue[]; pulls: Pull[]; repo?: string }, items: Map<string, ItemView>, next: (p: Pull, floor?: Tier) => ReturnType<typeof prNext> = (p) => prNext(p, 'R2', 'none')): { view: TeamsView; needs: NeedsEntry[]; notices: Notice[]; waits: Map<string, string> } {
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
    const touches = (p: Pull) => (p.files.length ? p.files.some((f) => f.path.startsWith(`${src}/`)) : p.headRefName === src || p.headRefName.startsWith(`${src}-`))
    const blocking = settled ? [] : gh.pulls
      // not the cycle's own PR; a later PR from the same planning branch (a fix after the first merged) is one.
      // Without a readable state.json, the cycle's own PR is not known: its branch stands for it.
      .filter((p) => p.state === 'OPEN' && (state ? p.number !== state.pr : p.headRefName !== src) && touches(p))
      .sort((a, b) => a.number - b.number)
      .map((p) => ({ number: p.number, url: p.url, title: p.title, head: p.headRefName, labels: p.labels, why: `PR #${p.number} must merge${state?.status === 'approval' ? ', then /dispatch' : ''}` }))
    const amendments = !settled ? [] : gh.pulls
      .filter((p) => p.state === 'OPEN' && p.number !== state?.pr && touches(p))
      .sort((a, b) => a.number - b.number)
      .map((p) => {
        const n = next(p, 'R2')
        return { number: p.number, url: p.url, title: p.title, head: p.headRefName, who: n.who, what: n.what }
      })
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
      amendments,
    }

    // what in it needs the human, and whose turn it is outside the timed rounds
    const since = state?.history.at(-1)?.at ?? state?.round_started_at ?? ''
    const base = { id: `cycle-${c.name}`, label: `planning ${c.name}`, href: '/planning', since }
    const prOpen = pull ? pull.state === 'OPEN' : !c.onMain // without GitHub data: open until main has the record
    const briefOk = !!pull?.labels.includes('brief-approved')
    if (state?.status === 'brief') cycle.waiting.push(!state.pr ? { team: 'orchestrator', owes: 'the brief (round.sh brief)' } : briefOk ? { team: 'orchestrator', owes: 'round.sh next' } : { team: 'you', owes: `the label brief-approved on PR #${state.pr}` })
    const own = pull && pull.state === 'OPEN' ? next(pull, 'R2') : undefined // the decisions' PR is R2 whatever its files
    if (state?.status === 'approval' && prOpen) cycle.waiting.push(own ? { team: own.who, owes: `PR #${pull!.number}: ${own.what}` } : { team: 'you', owes: `human-approved and a merge of PR #${state.pr ?? '?'}` })
    // a fix to the cycle's files in its own PR goes first, merged by whoever its next step names
    else if (blocking.length) {
      for (const b of blocking) {
        const n = next(gh.pulls.find((p) => p.number === b.number)!)
        cycle.waiting.push({ team: n.who, owes: `PR #${b.number}: ${n.what}${state?.status === 'approval' ? ', then /dispatch' : ''}` })
      }
    }
    else if (state?.status === 'approval') cycle.waiting.push({ team: 'orchestrator', owes: '/dispatch' })
    if (state?.status === 'escalated') cycle.waiting.push({ team: 'you', owes: 'a decision: the meeting stopped at two strikes' })
    if (state?.status === 'brief' && state.pr && prOpen && !briefOk) {
      needs.push({ ...base, kind: 'approve', title: 'Approve the brief', summary: `read BRIEF.md, then add the label brief-approved to PR #${state.pr}` })
    }
    if (state?.status === 'approval' && state.pr && prOpen) {
      const approved = !!pull?.labels.includes('human-approved')
      needs.push({ ...base, kind: own?.kind ?? 'approve', title: 'Approve the decisions', summary: own ? `${approved ? '' : 'settle any needs-human record, then '}PR #${state.pr}: ${own.what}` : `settle any needs-human record, add human-approved to PR #${state.pr}, merge it`, tier: 'R2' })
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
  const label = (labels: string[], prefix: string) => labels.find((l) => l.startsWith(prefix))?.slice(prefix.length)
  const ticketEvents = ticketStates(inp.events)
  const refs = refsOf(gh.pulls, gh.issues, (n) => ticketEvents.get(String(n)))
  const waits = new Map<string, string>()
  const names = new Set([...inp.features.map((f) => f.name), ...gh.issues.map((i) => featureOf(i.labels)).filter((x): x is string => !!x)])
  const features: FeatureView[] = [...names].sort().map((name) => {
    const f = inp.features.find((x) => x.name === name)
    const rows = f?.dispatch ? parseDispatch(f.dispatch) : []
    const issues = gh.issues.filter((i) => featureOf(i.labels) === name).sort((a, b) => a.number - b.number)
    const rowOf = new Map(issues.filter((i) => !i.labels.includes('ticket')).map((i) => [i.number, dispatchRowOf(i, rows, label(i.labels, 'team:'))]))
    const done = (n: number) => ['merged', 'closed'].includes(items.get(String(n))?.state ?? '') || issues.find((i) => i.number === n)?.state === 'CLOSED'
    const list = issues.map((i) => {
      const it = items.get(String(i.number))
      const ticket = i.labels.includes('ticket')
      const team = label(i.labels, 'team:') ?? (ticket ? label(i.labels, 'to:') : undefined)
      const dispatch = rowOf.get(i.number)
      // what a dispatched item waits for: the rows in its "after" column not merged yet
      let waitsFor: string | undefined
      if (dispatch && !it?.pr && (!it || it.state === 'ready')) {
        const before = dispatch.after.map((a) => ({ a, n: [...rowOf].find(([, r]) => r?.item === a)?.[0] }))
        const open = before.filter((b) => b.n === undefined || !done(b.n))
        waitsFor = open.length
          ? open.map((b) => (b.n === undefined ? `${b.a} (no issue yet)` : `#${b.n} ${b.a} (${items.get(String(b.n))?.state ?? 'not started'})`)).join(', ')
          : `${team ?? 'its team'} to start it: the sweep types the command when that session is free, lowest number first`
        waits.set(String(i.number), waitsFor)
      }
      // waits=#<n> on its latest stage event: only an open PR, or a ticket still to be done, counts (no guessing from files)
      const waitsOn = (it?.waitsOn?.refs ?? []).flatMap((n): { kind: 'PR' | 'ticket'; n: number; url: string; stage: string }[] => {
        const r = refs.get(n)
        return r?.state === 'open' ? [{ kind: r.kind, n, url: r.url, stage: it!.waitsOn!.stage }] : []
      })
      if (waitsOn.length) {
        waitsFor = `${waitsOn.map((w) => `${w.kind} #${w.n}`).join(', ')} (${waitsOn[0]!.stage})`
        waits.set(String(i.number), waitsFor)
      }
      // what it waited on is merged, closed, done, verified or declined: the wait is over, and its own team takes the next step.
      // A PR merged into main reaches the feature branch through its sync PR (sync/<f> into feature/<f>), when one is open.
      const ended = (it?.waitOver?.refs ?? []).flatMap((n) => refs.get(n) ?? []).filter((r) => r.state !== 'open')
      let waitOver: NonNullable<FeatureView['items'][number]['item']>['waitOver']
      if (!waitsOn.length && ended.length) {
        const stage = it!.waitOver!.stage
        const lost = ended.filter((r) => r.state === 'closed' || r.state === 'declined') // nothing came of it: the team decides what next
        const fromMain = ended.filter((r) => r.kind === 'PR' && r.state === 'merged' && r.base === 'main')
        const sync = !lost.length && fromMain.length ? gh.pulls.find((p) => p.state === 'OPEN' && p.headRefName === `sync/${name}` && p.baseRefName === `feature/${name}`) : undefined
        waitOver = { stage, refs: ended, sync: sync && { n: sync.number, url: sync.url } }
        waitsFor = lost.length
          ? `${team ?? 'its team'} to check its tab: its ${stage} waited on ${lost.map((r) => `${r.kind} #${r.n}, which was ${refHow(r)}`).join(', and ')}`
          : sync
            ? `PR #${sync.number}, the feature sync that brings ${fromMain.map((r) => `PR #${r.n}`).join(', ')} from main; then ${team ?? 'its team'} resumes ${stage}`
            : `${team ?? 'its team'} to resume ${stage} (${ended.map((r) => `${r.kind} #${r.n} ${refHow(r)}`).join(', ')})`
        waits.set(String(i.number), waitsFor)
      }
      return {
        number: i.number, title: i.title, url: i.url, team, ticket,
        ticketState: ticket ? ticketEvents.get(String(i.number)) ?? label(i.labels, 'state:') : undefined, // as deriveItem: the event, else the label
        from: ticket ? label(i.labels, 'from:') : undefined,
        open: i.state === 'OPEN',
        item: it ? { state: it.state, pr: it.pr?.number, prUrl: it.pr?.url, autoMerge: it.pr?.autoMerge, tier: it.tier, needs: it.needs && { kind: it.needs.kind, summary: it.needs.summary }, active: !!it.active, last: lastStage(it), waitsOn: waitsOn.length ? waitsOn : undefined, waitOver } : undefined,
        dispatch,
        waitsFor,
      }
    })
    return {
      name,
      refs: f?.refs ?? {},
      e2eTests: f?.e2eTests,
      items: list,
      docs: (f?.docs ?? []).map((d) => ({ ...d, headline: DOC_HEADLINE[d.file]?.(d.text) ?? '' })),
      attribution: (() => {
        const d = f?.docs.find((x) => x.file === 'attribution.md')
        if (!d) return undefined
        const a = parseAttribution(d.text)
        const acc = f?.docs.find((x) => x.file === 'acceptance.md')
        const blob = (ref: string | undefined, path: string) => (gh.repo && ref ? `https://github.com/${gh.repo}/blob/${ref.replace(/^origin\//, '')}/${encodeURI(path)}` : undefined)
        const crit = acc && blob(acc.ref, `features/${name}/acceptance.md`)
        const body = (n: number) => issues.find((x) => x.number === n)?.body ?? ''
        const rows = a.rows.map((r) => {
          // integrate.sh tickets: one bug ticket per team, from the orchestrator, its needs naming the round and each test
          const t = list.filter((i) => i.ticket && i.from === 'orchestrator' && i.team === r.team && body(i.number).includes(r.test) && (a.round === undefined || body(i.number).includes(`round ${a.round} of`))).at(-1)
          // the criterion's heading, as GitHub anchors it: lower case, punctuation dropped, spaces to hyphens
          const heading = acc?.text.split('\n').find((l) => l.startsWith(`## ${r.criterion}:`))?.slice(3)
          const hash = heading?.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')
          const [path, frag] = r.contract.split('#')
          return {
            ...r,
            ticket: t && { number: t.number, url: t.url, state: t.ticketState },
            criterionUrl: crit && (hash ? `${crit}#${hash}` : crit),
            contractUrl: path?.startsWith('contracts/') ? blob(f?.refs.feature, path)?.concat(frag ? `#${encodeURI(frag)}` : '') : undefined,
          }
        })
        return { ref: d.ref, round: a.round, rows }
      })(),
      pulls: gh.pulls
        .filter((p) => p.headRefName === `integrate/${name}` || p.headRefName === `sync/${name}`)
        .map((p) => ({ number: p.number, url: p.url, title: p.title, state: p.state, head: p.headRefName })),
    }
  })

  // a decision links to the issues that build it: those whose work-breakdown row names it
  if (cycle) {
    for (const r of cycle.records) {
      const ns = features.flatMap((f) => f.items.filter((i) => i.dispatch?.decisions.includes(r.id)).map((i) => i.number))
      if (ns.length) r.implementedBy = [...new Set(ns)].sort((a, b) => a - b)
    }
  }

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

  const phases = phasesOf(cycle, features, gh.pulls, next)
  return { view: { rosterSource: inp.roster.source, rosterError, phases, cycle, features, teams, sessions: { available: inp.sessions.available } }, needs, notices, waits }
}


/** An item's latest stage event, as the strip quotes it: the newest attempt of its current stage. */
const lastStage = (it: ItemView) => {
  const a = it.stages.find((s) => s.stage === it.stage)?.attempts.at(-1)
  return a && it.stage ? { stage: it.stage, status: a.status, at: a.end ?? a.start, detail: a.detail?.slice(0, 160) } : undefined
}

/** Where things are: the newest feature (on main, its PR to main, its integration round, its items),
 *  and beside it a planning cycle not yet dispatched. A feature already on main is shown only alone. */
export function phasesOf(cycle: CycleView | undefined, features: FeatureView[], pulls: Pull[], next: (p: Pull, floor?: Tier) => ReturnType<typeof prNext> = (p) => prNext(p, 'R2', 'none')): Phase[] {
  const st = cycle?.state
  const planning = cycle && st?.status !== 'dispatched' && st?.status !== 'closed' ? cyclePhase(cycle) : undefined
  const f = features.find((x) => x.name === st?.feature) ?? features.at(-1)
  const built = f ? featurePhase(f, pulls, cycle, next) : undefined
  const out = [...(built && !(built.step === 'merged' && planning) ? [built] : []), ...(planning ? [planning] : [])]
  return out.length ? out : [{ step: 'no-cycle', label: 'No planning cycle yet', detail: 'In team mode work starts with a planning cycle: the teams agree decisions, you approve them, and dispatch turns them into items.', next: { who: 'orchestrator', what: 'open one with /plan', href: '/planning' } }]
}

function cyclePhase(cycle: CycleView): Phase {
  const st = cycle.state
  const owed = (w: Owed | undefined) => w && { who: w.team, what: w.owes, href: '/planning' }
  if (!st) return { step: 'planning', label: `Planning ${cycle.name}: its state.json cannot be read`, next: { who: 'orchestrator', what: 'repair the planning state (round.sh)', href: '/planning' } }
  if (st.status === 'approval') return { step: 'approval', label: `Approval: ${cycle.name}'s decisions`, detail: 'Nothing is built until the decisions are approved, merged and dispatched to the teams.', next: owed(cycle.waiting[0]) }
  if (st.status === 'escalated') return { step: 'stopped', label: `Planning ${cycle.name} stopped`, detail: 'A team took two strikes (it missed its turn twice).', next: owed(cycle.waiting[0]) }
  return { step: 'planning', label: `Planning ${cycle.name}: ${roundWords(st.status)}`, next: owed(cycle.waiting[0]) ?? { who: 'orchestrator', what: 'close the round (round.sh next)', href: '/planning' } }
}

function featurePhase(f: FeatureView, pulls: Pull[], cycle: CycleView | undefined, stepOf: (p: Pull, floor?: Tier) => ReturnType<typeof prNext>): Phase {
  const toMain = pulls.filter((p) => p.headRefName === `integrate/${f.name}`).sort((a, b) => b.number - a.number)[0]
  if (toMain?.state === 'MERGED') return { step: 'merged', label: `Merged: ${f.name} is on main`, detail: `PR #${toMain.number} merged.`, next: cycle && !cycle.active ? { who: 'orchestrator', what: 'the next planning cycle (/plan)', href: '/planning' } : undefined }
  if (toMain?.state === 'OPEN') {
    const n = stepOf(toMain)
    return { step: 'pr-to-main', label: `Pull request to main: #${toMain.number}`, detail: `The feature passed integration; ${f.name} reaches main when this merges.`, next: { who: n.who, what: n.kind === 'approve' ? `read PR #${toMain.number}, then ${n.what}` : `PR #${toMain.number}: ${n.what}`, href: toMain.url || '/planning' } }
  }
  const work = f.items.filter((i) => !i.ticket)
  const merged = work.filter((i) => i.item?.state === 'merged' || (!i.open && !i.item))
  const report = f.docs.find((d) => d.file === 'e2e-report.md')
  const round = report && /^round:\s*(\d+)/m.exec(report.text)?.[1]
  const verdict = report && /^E2E:\s*(\w+)/m.exec(report.text)?.[1]
  const tickets = f.items.filter((i) => i.ticket && i.open && i.ticketState !== 'declined' && i.ticketState !== 'done' && i.ticketState !== 'verified')
  if (report && (merged.length === work.length || tickets.length)) {
    const teams = [...new Set(tickets.map((t) => t.team ?? '?'))]
    return verdict === 'pass'
      ? { step: 'integration', label: `Integration round ${round ?? '?'} passed`, detail: `The e2e tests passed on ${report.ref}. Research reviews the acceptance tests; then the orchestrator opens the pull request to main.`, next: { who: 'orchestrator', what: 'the acceptance review, then integrate.sh pr', href: '/planning' } }
      : { step: 'integration', label: `Integration round ${round ?? '?'} failed`, detail: `The e2e tests failed on ${report.ref}; ${tickets.length} ticket${tickets.length === 1 ? '' : 's'} open for the teams that own the failures.`, next: tickets.length ? { who: teams.join(', '), what: `fix ${tickets.map((t) => `#${t.number}`).join(', ')}, then the next round runs`, href: '/planning' } : { who: 'orchestrator', what: 'file tickets from attribution.md (integrate.sh tickets)', href: '/planning' } }
  }
  const doing = f.items.filter((i) => i.item) // the dispatched items and the follow-up tickets being worked
  // each item's one next step, and who takes it
  type Step = { n: number; who: string; what: string; wait?: string; active?: boolean; quiet?: boolean }
  const steps = doing.flatMap((i): Step[] => {
    const it = i.item!
    const n = i.number
    const team = i.team ?? '?'
    const out: Step[] = []
    if (it.state === 'blocked') out.push({ n, who: 'you', what: `answer #${n} (it stopped with a question)` })
    // an open PR, whatever the item's state (a red one is "failed", a question can come after it): the PR's step,
    // from the helper Needs you and Planning use, with the item's known tier
    const pull = pulls.find((p) => p.number === it.pr && p.state === 'OPEN')
    if (pull || ['pr-open', 'awaiting-approval', 'awaiting-merge'].includes(it.state)) {
      const s = pull && stepOf(pull, it.tier ?? (it.state === 'awaiting-approval' ? 'R2' : undefined)) // the item's known tier (spec floor, review), as derive reads it
      // without GitHub data: what the item's state says
      const what = s?.what ?? (it.state === 'awaiting-merge' ? 'merge it' : it.state === 'awaiting-approval' ? (it.autoMerge ? 'add human-approved; auto-merge then merges it once the checks pass' : 'add human-approved, wait for the checks to pass, then merge') : 'its checks and review (no GitHub data)')
      const who = s ? (s.who === 'its author' ? team : s.who) : it.state === 'pr-open' ? team : 'you'
      const wait = who === 'you' ? 'waiting on you' : s?.kind === 'failed' ? 'with failing checks' : pull?.isDraft ? 'in draft' : !pull || currentChecks(pull.checks).some((c) => checkState(c) === 'pending') ? 'waiting on checks' : 'merging'
      out.push({ n, who, what: `#${n}${it.pr ? ` (PR #${it.pr})` : ''}: ${what}`, wait })
    }
    if (it.state === 'in-progress' && it.waitsOn) out.push({ n, who: team, what: `#${n} waits for ${it.waitsOn.map((w) => `${w.kind} #${w.n}`).join(', ')} (${it.waitsOn[0]!.stage})`, active: !!it.active, quiet: !it.active })
    else if (it.state === 'in-progress' && it.waitOver) {
      // the wait is over: the item's own team takes it (never a question for you)
      const w = it.waitOver
      const lost = w.refs.filter((r) => r.state === 'closed' || r.state === 'declined')
      const what = lost.length
        ? `#${n} waited on ${lost.map((r) => `${r.kind} #${r.n}, which was ${refHow(r)}`).join(', and ')}; check its tab`
        : `resume #${n}'s ${w.stage} (${w.refs.map((r) => `${r.kind} #${r.n} ${refHow(r)}`).join(', ')})${w.sync ? ` after the feature syncs (PR #${w.sync.n})` : ''}`
      out.push({ n, who: team, what, active: !!it.active, quiet: !it.active })
    } else if (it.state === 'in-progress') {
      const l = it.last
      const last = l && `${l.stage} ${l.status}${l.at ? ` ${new Date(l.at).toISOString().slice(11, 16)} UTC` : ''}`
      if (it.needs?.kind === 'waiting-input') out.push({ n, who: 'you', what: `#${n}: ${it.needs.summary}` })
      else if (it.needs?.kind === 'info') out.push({ n, who: team, what: `#${n} ${it.needs.summary}`, active: true }) // a stop logged while its agents run
      // "in progress" is an agent at work, by the test Running now uses
      else if (!it.active) out.push({ n, who: team, what: `#${n} in progress, no agent active (${it.needs?.kind === 'quiet' ? it.needs.summary : last ? `last: ${last}` : 'nothing recorded'}); check its tab`, quiet: true })
      // a failed or blocked last stage is not a plain "finish"
      else if (l && (l.status === 'failed' || l.status === 'blocked')) out.push({ n, who: team, what: `#${n} in progress; last stage ${last}${l.detail ? `: ${l.detail}` : ''}`, active: true })
      else out.push({ n, who: team, what: `finish #${n}${last ? ` (last: ${last})` : ''}`, active: true })
    }
    if (it.state === 'failed' && !pull) out.push({ n, who: 'you', what: `#${n} stopped: ${it.needs?.summary ?? 'see the item'}` })
    return out
  })
  // what an item's stage waits on (waits=#<n>): that PR's or ticket's owner comes first
  const waited = doing.flatMap((i) => [...(i.item!.waitsOn ?? []).map((w) => {
    const why = `#${i.number}'s ${w.stage} waits on it`
    const pull = w.kind === 'PR' ? pulls.find((p) => p.number === w.n) : undefined
    if (pull) {
      const s = stepOf(pull)
      return { who: s.who, what: `PR #${w.n} (${s.what}); ${why}`, href: pull.url || `/items/${i.number}` }
    }
    const t = f.items.find((x) => x.number === w.n)
    return { who: t?.team ?? '?', what: `ticket #${w.n} (${t?.ticketState ?? 'open'}); ${why}`, href: w.url || `/items/${i.number}` }
  }), ...(i.item!.state === 'in-progress' && i.item!.waitOver?.sync ? [i.item!.waitOver].flatMap((w) => {
    // what it waited on merged into main: the feature's sync PR brings it to the feature branch first
    const pull = pulls.find((p) => p.number === w.sync!.n)
    if (!pull) return []
    const s = stepOf(pull)
    const from = w.refs.filter((r) => r.kind === 'PR' && r.state === 'merged' && r.base === 'main').map((r) => `PR #${r.n}`).join(', ')
    return [{ who: s.who, what: `PR #${pull.number} (${s.what}); #${i.number} waits on it (the feature sync that brings ${from} from main)`, href: pull.url || `/items/${i.number}` }]
  }) : [])])
  // then one line per item step, each with its own link; yours first
  const lines = [...waited, ...[...steps].sort((a, b) => Number(b.who === 'you') - Number(a.who === 'you')).map((x) => ({ who: x.who, what: x.what, href: `/items/${x.n}` }))]
  const ready = work.filter((i) => i.item?.state === 'ready' && i.waitsFor && !/^#/.test(i.waitsFor))
  const next = lines[0] ?? (ready.length ? { who: ready[0]!.team ?? '?', what: `start #${ready[0]!.number} (the sweep types it when the session is free)`, href: `/items/${ready[0]!.number}` } : undefined)
  const inProgress = steps.filter((x) => x.active).length
  const quiet = steps.filter((x) => x.quiet).length
  const waitCount = new Map<string, number>()
  for (const x of steps) if (x.wait) waitCount.set(x.wait, (waitCount.get(x.wait) ?? 0) + 1)
  const waiting = [...waitCount].map(([w, k]) => `${k} pull request${k === 1 ? '' : 's'} ${w}`)
  const deps = f.items.filter((i) => i.waitsFor?.startsWith('#')).map((i) => `#${i.number} waits for ${i.waitsFor}`)
  // follow-ups: tickets a team accepted and worked, beside the dispatched items
  const follow = f.items.filter((i) => i.ticket && i.item)
  const followMerged = follow.filter((i) => i.item!.state === 'merged').length
  const e2e = f.refs.integrate
    ? `${f.e2eTests ? `${f.e2eTests} e2e test file${f.e2eTests === 1 ? '' : 's'} saved on ${f.refs.integrate}` : `no e2e tests on ${f.refs.integrate} yet`}; ${report ? `last integration round ${round ?? '?'}: ${verdict ?? 'no E2E line'}` : 'no integration round yet'}.`
    : `No integration branch yet: the orchestrator saves the e2e tests on integrate/${f.name}.`
  return {
    step: 'building',
    label: `Building ${f.name}: ${merged.length} of ${work.length} dispatched item${work.length === 1 ? '' : 's'} merged into its feature branch${follow.length ? `, +${follow.length} follow-up ticket${follow.length === 1 ? '' : 's'}${followMerged ? ` (${followMerged} merged)` : ''}` : ''}`,
    detail: [inProgress ? `${inProgress} in progress.` : '', quiet ? `${quiet} with no agent active.` : '', waiting.length ? `${waiting.join(', ')}.` : '', deps.length ? `${deps.join('; ')}.` : '', e2e].filter(Boolean).join(' '),
    next,
    ...(lines.length > 1 && { more: lines.slice(1) }),
  }
}
