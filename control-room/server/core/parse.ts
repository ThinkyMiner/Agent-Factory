// Parsers for the files the factory writes. Pure, total: they never throw.
// A file that cannot be parsed comes back as { ok:false, error, raw } so the UI can show
// a notice and the raw text instead of an error page.
import {
  LifecycleEventSchema,
  SpecFrontmatterSchema,
  StageEventSchema,
  TIERS,
  VERDICTS,
  PRIORITIES,
  type FactoryEvent,
  type Finding,
  type Lesson,
  type Notice,
  type ObservationFile,
  type Observation,
  type Parsed,
  type Reflection,
  type ReflectionChange,
  type ReflectionResult,
  type Review,
  type Spec,
  type Tier,
  type Verdict,
} from './types.ts'

const fail = <T>(error: string, raw: string): Parsed<T> => ({ ok: false, error, raw })
const lines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n')

// ---------- events.jsonl ----------

/**
 * Parse an events.jsonl file. Unknown event types are kept (as type "unknown") so they
 * still show in Activity; malformed lines become notices. When `partialTail` is set, a
 * final line without a newline that does not parse is assumed to be mid-write and skipped
 * silently.
 */
export function parseEvents(text: string, source: string, opts: { partialTail?: boolean } = {}) {
  const events: FactoryEvent[] = []
  const notices: Notice[] = []
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  const endsWithNewline = text.endsWith('\n')
  all.forEach((line, i) => {
    const key = line.trim()
    if (!key) return
    const isTail = i === all.length - 1 && !endsWithNewline
    let obj: unknown
    try {
      obj = JSON.parse(key)
    } catch {
      if (isTail && opts.partialTail) return
      notices.push({ level: 'warn', source, message: `line ${i + 1}: not valid JSON, skipped`, raw: key })
      return
    }
    const type = (obj as { type?: unknown })?.type
    const schema = type === 'stage' ? StageEventSchema : type === 'lifecycle' ? LifecycleEventSchema : null
    if (!schema) {
      const ts = (obj as { ts?: unknown })?.ts
      events.push({ type: 'unknown', ts: typeof ts === 'string' ? ts : undefined, key, raw: key })
      notices.push({ level: 'info', source, message: `line ${i + 1}: unknown event type ${JSON.stringify(type)}, shown in Activity only` })
      return
    }
    const r = schema.safeParse(obj)
    if (!r.success) {
      const why = r.error.issues.map((x) => `${x.path.join('.') || 'event'}: ${x.message}`).join('; ')
      events.push({ type: 'unknown', ts: typeof (obj as { ts?: unknown }).ts === 'string' ? (obj as { ts: string }).ts : undefined, key, raw: key })
      notices.push({ level: 'warn', source, message: `line ${i + 1}: ${why}`, raw: key })
      return
    }
    const ev = { ...r.data, key } as FactoryEvent
    const rawTier = (obj as { tier?: unknown }).tier
    if (type === 'stage' && rawTier !== undefined && rawTier !== '' && !(ev as { tier?: Tier }).tier) {
      notices.push({ level: 'warn', source, message: `line ${i + 1}: unknown tier ${JSON.stringify(rawTier)} ignored` })
    }
    events.push(ev)
  })
  return { events, notices }
}

// ---------- markdown helpers ----------

/**
 * Frontmatter the way factory/scripts/validate-spec.sh reads it: one `key: value` per line,
 * matched by pattern, not parsed as YAML. (A title like "Roles: owner and member" is invalid
 * YAML but valid to the factory, so a YAML parser would reject specs the factory accepted.)
 */
export function splitFrontmatter(text: string): { data?: Record<string, string>; body: string; error?: string } {
  const t = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  if (!t.startsWith('---\n')) return { body: t, error: 'no frontmatter (expected a leading --- block)' }
  const end = t.indexOf('\n---', 3)
  if (end < 0) return { body: t, error: 'frontmatter is not closed with ---' }
  const after = t.indexOf('\n', end + 1)
  const body = after < 0 ? '' : t.slice(after + 1)
  const data: Record<string, string> = {}
  for (const line of t.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line)
    if (m && !(m[1]! in data)) data[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { data, body }
}

/** "## Heading" sections, keyed by lowercased heading. */
export function sections(body: string): Map<string, string> {
  const out = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (current !== null && !out.has(current)) out.set(current, buf.join('\n').trim())
  }
  for (const line of lines(body)) {
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (m && !line.startsWith('###')) {
      flush()
      current = m[1]!.toLowerCase()
      buf = []
    } else buf.push(line)
  }
  flush()
  return out
}

const isNone = (s: string) => /^(none|n\/a|nothing|-)\.?$/i.test(s.trim())
const isPlaceholder = (s: string) => /^<[^>]*>\.?$/.test(s.trim())

/** Bullet list items ("- x", "* x", "1. x"), with continuation lines joined. "None" yields []. */
export function bullets(text: string | undefined): string[] {
  if (!text) return []
  const items: string[] = []
  for (const raw of lines(text)) {
    const line = raw.trimEnd()
    if (!line.trim() || line.trim().startsWith('<!--')) continue
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (m) items.push(m[1]!.trim())
    else if (items.length) items[items.length - 1] += ' ' + line.trim()
    else items.push(line.trim())
  }
  return items.filter((s) => !isNone(s) && !isPlaceholder(s))
}

// ---------- spec.md ----------

export function parseSpec(text: string): Parsed<Spec> {
  const fm = splitFrontmatter(text)
  if (fm.error) return fail(fm.error, text)
  const r = SpecFrontmatterSchema.safeParse(fm.data ?? {})
  if (!r.success) {
    return fail('frontmatter: ' + r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '), text)
  }
  const warnings: string[] = []
  const sec = sections(fm.body)
  for (const need of ['problem', 'acceptance criteria', 'out of scope', 'assumptions', 'blocking questions']) {
    if (!sec.has(need)) warnings.push(`missing section "## ${need[0]!.toUpperCase()}${need.slice(1)}"`)
  }
  const acSource = sec.get('acceptance criteria') ?? fm.body
  const criteria: Spec['criteria'] = []
  for (const item of bullets(acSource)) {
    const m = /^(AC-\d+):\s*(.*)$/.exec(item)
    if (!m) continue
    if (criteria.some((c) => c.id === m[1])) warnings.push(`duplicate criterion ${m[1]}`)
    if (m[2]!.includes('<')) warnings.push(`${m[1]} still contains a <placeholder>`)
    criteria.push({ id: m[1]!, text: m[2]! })
  }
  if (!criteria.length) warnings.push('no acceptance criteria in the form "- AC-1: ..."')
  const f = r.data
  return {
    ok: true,
    warnings,
    value: {
      id: f.id,
      title: f.title.trim(),
      risk_floor: f.risk_floor,
      tests: f.tests,
      status: f.status,
      problem: (sec.get('problem') ?? '').trim(),
      criteria,
      outOfScope: bullets(sec.get('out of scope')),
      assumptions: bullets(sec.get('assumptions')),
      blockingQuestions: bullets(sec.get('blocking questions')),
      touchPoints: bullets(sec.get('expected touch points')),
      followUps: bullets(sec.get('follow-ups')),
    },
  }
}

// ---------- review.md ----------

const REVIEW_HEADERS = ['VERDICT', 'RISK', 'BLOCKING', 'NON-BLOCKING', 'VERIFIED', 'NOT VERIFIED'] as const
type ReviewHeader = (typeof REVIEW_HEADERS)[number]

function finding(s: string): Finding {
  // "path:line  text", "path  text", or plain text
  const m = /^`?([^\s`]+?)(?::(\d+))?`?(?:\s+[-—:]\s+|\s+)(.+)$/.exec(s)
  if (m && (m[1]!.includes('/') || /\.\w{1,8}$/.test(m[1]!))) {
    return { path: m[1], line: m[2] ? Number(m[2]) : undefined, text: m[3]!.trim() }
  }
  return { text: s }
}

export function parseReview(text: string): Parsed<Review> {
  const parts = new Map<ReviewHeader, string[]>()
  const warnings: string[] = []
  let current: ReviewHeader | null = null
  let preamble = false
  for (const raw of lines(text)) {
    const line = raw.replace(/^\s*(?:\*\*|__)?/, '').replace(/^#+\s*/, '')
    const m = /^(VERDICT|RISK|NON-BLOCKING|BLOCKING|NOT VERIFIED|VERIFIED)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/.exec(line)
    if (m) {
      current = m[1] as ReviewHeader
      if (parts.has(current)) warnings.push(`${current} appears more than once; using the first`)
      else parts.set(current, m[2] ? [m[2]] : [])
      continue
    }
    if (current === null) {
      if (raw.trim() && !/^```/.test(raw.trim())) preamble = true
      continue
    }
    if (/^```/.test(raw.trim())) continue
    parts.get(current)?.push(raw)
  }
  if (preamble) warnings.push('text before VERDICT was ignored')
  const verdictRaw = (parts.get('VERDICT')?.[0] ?? '').trim().toLowerCase().replace(/[`*.]/g, '').split(/\s+/)[0] ?? ''
  if (!parts.has('VERDICT')) return fail('no "VERDICT:" line', text)
  if (!(VERDICTS as readonly string[]).includes(verdictRaw)) {
    return fail(`VERDICT must be pass, changes-required or escalate (found "${parts.get('VERDICT')?.[0]?.trim()}")`, text)
  }
  let risk: Tier | undefined
  let riskWhy: string | undefined
  const riskLine = parts.get('RISK')
  if (!riskLine) warnings.push('no "RISK:" line')
  else {
    const rm = /^\s*`?(R[0-3])\b`?\s*[-—:(]*\s*(.*?)\)?\s*$/.exec(riskLine.join(' '))
    if (rm && (TIERS as readonly string[]).includes(rm[1]!)) {
      risk = rm[1] as Tier
      riskWhy = rm[2] || undefined
    } else warnings.push(`RISK is not R0..R3 ("${riskLine.join(' ').trim()}")`)
  }
  for (const h of ['BLOCKING', 'NON-BLOCKING', 'VERIFIED', 'NOT VERIFIED'] as const) {
    if (!parts.has(h)) warnings.push(`no "${h}:" section`)
  }
  const list = (h: ReviewHeader) => bullets((parts.get(h) ?? []).join('\n'))
  return {
    ok: true,
    warnings,
    value: {
      verdict: verdictRaw as Verdict,
      risk,
      riskWhy,
      blocking: list('BLOCKING').map(finding),
      nonBlocking: list('NON-BLOCKING').map(finding),
      verified: list('VERIFIED'),
      notVerified: list('NOT VERIFIED'),
    },
  }
}

// ---------- memory/lessons.md ----------

export function parseLessons(text: string, source = 'memory/lessons.md') {
  const lessons: Lesson[] = []
  const notices: Notice[] = []
  for (const line of lines(text)) {
    if (!/^\s*-\s+L-\d+/.test(line)) continue
    if (/^\s*-\s+L-0+\s/.test(line) || line.includes('YYYY')) continue // the format example in the file header
    const m = /^\s*-\s+(L-\d+)\s+\(([^)]+)\)\s+(.*?)\s+Evidence:\s*(.*?)\.?\s+Added\s+(\S+?)\.?\s+Enforcement:\s*([\w-]+)\.?\s*$/.exec(line)
    if (!m) {
      notices.push({ level: 'warn', source, message: 'lesson line does not match the format', raw: line.trim() })
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m[5]!)) notices.push({ level: 'warn', source, message: `${m[1]}: date "${m[5]}" is not YYYY-MM-DD` })
    const evidence = [...m[4]!.matchAll(/#(\d+)/g)].map((x) => x[1]!)
    if (!evidence.length) notices.push({ level: 'warn', source, message: `${m[1]} has no evidence ids (provenance or it does not exist)` })
    lessons.push({ id: m[1]!, stage: m[2]!, text: m[3]!.trim(), evidence, added: m[5]!, enforcement: m[6]! })
  }
  return { lessons, notices }
}

// ---------- memory/observations/<date>-<id>-<slug>.md ----------

export function parseObservationFile(file: string, text: string) {
  const notices: Notice[] = []
  const base = file.split('/').pop()!.replace(/\.md$/, '')
  const nm = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9._]+)-(.+)$/.exec(base)
  if (!nm) {
    notices.push({ level: 'warn', source: file, message: 'file name is not <date>-<id>-<slug>.md' })
  }
  const items: Observation[] = []
  let outcome: string | undefined
  for (const line of lines(text)) {
    const om = /^outcome:\s*(\S+)/.exec(line)
    if (om) outcome = om[1]
    if (!/^\s*-\s+\[/.test(line)) continue
    const m = /^\s*-\s+\[(\w+)\]\s+\(([\w -]+)\)\s+(.*?)\s*(?:Source:\s*(.*))?$/.exec(line)
    if (!m || !(PRIORITIES as readonly string[]).includes(m[1]!.toLowerCase())) {
      notices.push({ level: 'warn', source: file, message: 'observation line does not match "- [high|med|low] (stage) text. Source: ..."', raw: line.trim() })
      continue
    }
    if (!m[4]) notices.push({ level: 'warn', source: file, message: 'observation has no Source (provenance or it does not exist)', raw: line.trim() })
    items.push({ priority: m[1]!.toLowerCase() as Observation['priority'], stage: m[2]!.trim(), text: m[3]!.trim(), source: m[4]?.trim() || undefined })
  }
  const value: ObservationFile = {
    file,
    date: nm?.[1] ?? '',
    workId: nm?.[2] ?? '',
    slug: nm?.[3] ?? base,
    outcome,
    items,
  }
  return { value, notices }
}

// ---------- memory/reflections/<date>.md ----------
// Reflections have no fixed shape yet (data-contract proposal 9). This reads the labelled
// fields the /reflect skill asks for when they are present, and nothing else.

const FIELD_LABELS: [keyof ReflectionChange, RegExp][] = [
  ['pattern', /^pattern$/i],
  ['evidence', /^evidence$/i],
  ['change', /^(the )?change$/i],
  ['expected', /^expected( effect)?$/i],
  ['howWeWillKnow', /^how we will know$/i],
]

export function parseReflection(file: string, text: string): Parsed<Reflection> {
  const date = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? ''
  const changes: ReflectionChange[] = []
  const results: ReflectionResult[] = []
  let cur: ReflectionChange | null = null
  let field: keyof ReflectionChange | null = null
  for (const raw of lines(text)) {
    const h = /^#{2,4}\s+(.*)$/.exec(raw)
    if (h) {
      const title = h[1]!.trim()
      const idm = /^(C-\d{4}-\d{2}-\d{2}-\d+)\s*[:.-]?\s*(.*)$/.exec(title)
      cur = { id: idm?.[1], title: idm ? idm[2] || idm[1]! : title }
      changes.push(cur)
      field = null
      continue
    }
    const res = /^\s*-\s+(C-\d{4}-\d{2}-\d{2}-\d+)\s*:\s*(worked|no effect|made things worse|worse)\b[.:,]?\s*(.*)$/i.exec(raw)
    if (res) {
      const r = res[2]!.toLowerCase()
      results.push({ id: res[1]!, result: r === 'made things worse' ? 'worse' : r, note: res[3]!.trim() })
      continue
    }
    const lm = /^\s*(?:[-*]\s+)?(?:\*\*|__)?([A-Za-z ]+?)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/.exec(raw)
    const label = lm && FIELD_LABELS.find(([, re]) => re.test(lm[1]!.trim()))
    if (cur && lm && label) {
      field = label[0]
      ;(cur as unknown as Record<string, string>)[field] = lm[2]!.trim()
      continue
    }
    if (cur && field && raw.trim() && !/^\s*$/.test(raw)) {
      const rec = cur as unknown as Record<string, string>
      rec[field] = `${rec[field] ?? ''} ${raw.trim()}`.trim()
    }
  }
  const real = changes.filter((c) => c.change && (c.expected || c.howWeWillKnow))
  if (!real.length && !results.length) {
    return fail('no changes with labelled "Change:" and "Expected effect:" / "How we will know:" fields', text)
  }
  return { ok: true, warnings: [], value: { file, date, changes: real, results } }
}

// ---------- small files ----------

/** factory/policy.env: AUTO_MERGE_MAX_TIER. */
export function parsePolicy(text: string): Parsed<{ autoMergeMax: Tier | 'none' }> {
  const m = /^\s*AUTO_MERGE_MAX_TIER\s*=\s*["']?(\w+)["']?\s*$/m.exec(text)
  if (!m) return fail('AUTO_MERGE_MAX_TIER is not set', text)
  const v = m[1]!
  if (v !== 'none' && !(TIERS as readonly string[]).includes(v)) return fail(`AUTO_MERGE_MAX_TIER="${v}" is not none or R0..R3`, text)
  return { ok: true, warnings: [], value: { autoMergeMax: v as Tier | 'none' } }
}

/** One-line summary of a BLOCKED.md for the needs-you row. The full text is always shown on open. */
export function blockedSummary(text: string): string {
  const clean = (l: string) => l.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim()
  const all = lines(text).filter((l) => l.trim())
  const body = all.filter((l) => !/^\s*#/.test(l)).map(clean).filter(Boolean)
  const q = body.find((l) => l.endsWith('?'))
  return (q ?? body[0] ?? (all[0] ? clean(all[0]) : '') ?? '').slice(0, 240) || '(BLOCKED.md is empty)'
}

/** A "## Not verified" section from a pull request body (factory/templates/pr-body.md). */
export function prNotVerified(body: string): string[] {
  return bullets(sections(body).get('not verified')).filter((s) => !/^nothing known\.?$/i.test(s))
}
