// Item detail. Job 2: let me trust what merged without reading everything.
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Tabs } from 'radix-ui'
import { ArrowLeft, ExternalLink, FileWarning, GitCommitHorizontal, Radio, ShieldQuestion } from 'lucide-react'
import { getText, HttpError, useItem, useNow, useTeams, type ItemDetail, type StageView } from '@/lib/api'
import { ago, cn, compact, duration, when } from '@/lib/utils'
import { Md, Raw } from '@/components/Markdown'
import { Patch } from '@/components/Patch'
import { Empty, ErrorState, Loading } from '@/components/States'
import { CopyCommand } from './ControlRoom'
import { ActionTrail, AnswerForm, ApproveAction, MarkReady } from '@/components/Actions'
import { Mono, NEEDS, NeedsTag, STATUS, StageLabel, StateBadge, Status, StatusGlyph, TAB, TAB_LIST, TierChip, TONE_BORDER, needsTone } from '@/components/vocab'

const TABS = ['spec', 'plan', 'changes', 'gates', 'review', 'activity', 'not-verified', 'observations'] as const
type Tab = (typeof TABS)[number]

export function Item() {
  const { id = '', tab } = useParams()
  const nav = useNavigate()
  const { data, error, isLoading, refetch } = useItem(id)
  const current: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'spec'

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg/90 px-5 py-2.5 backdrop-blur">
        <Link to="/board" className="inline-flex items-center gap-1 text-muted hover:text-fg">
          <ArrowLeft aria-hidden className="size-3.5" /> Board
        </Link>
        <span className="text-faint">/</span>
        <Mono>#{id}</Mono>
      </header>
      <div className="px-5 py-4">
        {isLoading && <Loading rows={6} label={`Loading #${id}`} />}
        {error && (error instanceof HttpError && error.status === 404 ? <Empty title={`There is no item #${id}`}>It may have been renamed, or its issue lost its factory label.</Empty> : <ErrorState title={`Could not load #${id}`} error={error} onRetry={() => void refetch()} />)}
        {data && (
          <>
            <Header item={data} />
            <NeedsPanel item={data} />
            <ParseNotices item={data} />
            <NotVerifiedCallout item={data} onOpen={() => nav(`/items/${id}/not-verified`)} />
            <StageStrip item={data} />
            <Tabs.Root value={current} onValueChange={(v) => nav(`/items/${id}/${v}`, { replace: true })} className="mt-5">
              <Tabs.List aria-label="Item details" className={TAB_LIST}>
                {TABS.map((t) => (
                  <Tabs.Trigger key={t} value={t} className={TAB}>
                    {tabLabel(t, data)}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              <div className="pt-4">
                <Tabs.Content value="spec"><SpecTab item={data} /></Tabs.Content>
                <Tabs.Content value="plan"><DocTab text={data.files['plan.md']?.text} empty="No plan.md: the build stage has not written one." /></Tabs.Content>
                <Tabs.Content value="changes"><ChangesTab item={data} /></Tabs.Content>
                <Tabs.Content value="gates"><GatesTab item={data} /></Tabs.Content>
                <Tabs.Content value="review"><ReviewTab item={data} /></Tabs.Content>
                <Tabs.Content value="activity"><ActivityTab item={data} /></Tabs.Content>
                <Tabs.Content value="not-verified"><NotVerifiedTab item={data} /></Tabs.Content>
                <Tabs.Content value="observations"><ObservationsTab item={data} /></Tabs.Content>
              </div>
            </Tabs.Root>
          </>
        )}
      </div>
    </>
  )
}

function tabLabel(t: Tab, d: ItemDetail) {
  const base = { spec: 'Spec', plan: 'Plan', changes: 'Changes', gates: 'Gates', review: 'Review', activity: 'Activity', 'not-verified': 'Not verified', observations: 'Observations' }[t]
  const n = t === 'not-verified' ? d.notVerified.length : t === 'changes' ? d.changes.length : t === 'observations' ? d.observations.reduce((a, o) => a + o.items.length, 0) : 0
  const bad = (t === 'spec' && d.spec && !d.spec.ok) || (t === 'review' && d.reviews.some((r) => !r.review.ok))
  return (
    <span className="inline-flex items-center gap-1.5">
      {base}
      {n > 0 && <span className={cn('px-1 text-[11px] tabular', t === 'not-verified' ? 'bg-block-bg text-block' : 'bg-surface-2 text-muted')}>{n}</span>}
      {bad && <FileWarning aria-label="could not parse" className="size-3.5 text-fail" />}
    </span>
  )
}

function Header({ item }: { item: ItemDetail }) {
  const now = useNow()
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Mono className="text-muted">#{item.id}</Mono>
        <TierChip tier={item.tier} />
        <StateBadge state={item.state} />
        {item.live && (
          <span className="inline-flex items-center gap-1 text-[12px] text-run">
            <Radio aria-hidden className="size-3.5" /> {item.live.agentType} active for {duration(now - Date.parse(item.live.since ?? ''))}
          </span>
        )}
        {item.reverted && <span className="rounded bg-fail-bg px-1.5 text-[12px] font-medium text-fail">Reverted by {item.reverted.ref}</span>}
      </div>
      <h1 className="mt-2 text-[24px] leading-tight font-normal tracking-[-0.02em]">{item.title}</h1>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
        <span>{item.reason}</span>
        {item.since && <span title={when(item.since)}>· since {ago(item.since, now)} ago</span>}
        {item.pr && <ExtLink href={item.pr.url}>PR #{item.pr.number}</ExtLink>}
        {item.issue && <ExtLink href={item.issue.url}>Issue #{item.issue.number}</ExtLink>}
        {item.branch && <Mono>{item.branch}</Mono>}
        <span>{item.fixRounds ? `${item.fixRounds} fix round${item.fixRounds > 1 ? 's' : ''}` : 'no fix rounds'}</span>
        {item.state !== 'merged' && item.state !== 'closed' && <CopyCommand cmd={`/work ${item.id}`} />}
      </div>
      {item.state === 'proposed' && item.issue && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
          <span className="text-muted">Proposed: the factory does not pick it up until it is labelled factory:ready.</span>
          <MarkReady issue={item.issue.number} />
        </div>
      )}
      <TeamLinks item={item} />
      <ActionTrail issue={item.issue?.number} pr={item.pr?.number} />
    </div>
  )
}

/** Team mode: the item's place in its feature: its work-breakdown row, the decisions it builds, the
 *  ticket it is, and what it waits for, each linked to Planning. */
function TeamLinks({ item }: { item: ItemDetail }) {
  const { data } = useTeams()
  const f = data?.features.find((x) => x.items.some((i) => String(i.number) === item.id))
  const row = f?.items.find((i) => String(i.number) === item.id)
  if (!f || !row) return null
  const records = new Set(data?.cycle?.records.map((r) => r.id))
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-muted">
      <span>feature <Link to="/planning#features" className="font-mono text-[12px] text-fg underline underline-offset-2">{f.name}</Link></span>
      {row.team && <span>team <Mono className="text-fg">{row.team}</Mono></span>}
      {row.dispatch && <span>work-breakdown item <Mono className="text-fg">{row.dispatch.item}</Mono></span>}
      {!!row.dispatch?.decisions.length && (
        <span>
          builds{' '}
          {row.dispatch.decisions.map((d, k) => (
            <span key={d}>
              {k > 0 && ', '}
              {records.has(d) ? <Link to={`/planning#decision-${d}`} className="font-mono text-[12px] text-fg underline underline-offset-2">{d}</Link> : <span className="font-mono text-[12px]" title="a record of an earlier cycle, in its planning folder on main">{d}</span>}
            </span>
          ))}
        </span>
      )}
      {row.ticket && <span>ticket{row.from ? ` from ${row.from}` : ''}{row.ticketState ? `: ${row.ticketState}` : ''}</span>}
      {row.waitsFor && <span>waits for {row.waitsFor}</span>}
    </div>
  )
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!/^https:\/\//.test(href)) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-fg hover:underline">
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  )
}

function NeedsPanel({ item }: { item: ItemDetail }) {
  const n = item.needs
  if (!n) return null
  const blocked = n.kind === 'answer' && item.blocked && !item.blocked.stale ? item.blocked : null
  return (
    <section aria-label="Needs you" className={cn('mt-4 rounded-lg border border-l-4 border-border bg-surface px-4 py-3', TONE_BORDER[needsTone(n.kind)])}>
      <div className="flex flex-wrap items-center gap-2">
        <NeedsTag kind={n.kind} />
        <span className="font-medium">{NEEDS[n.kind].verb}</span>
      </div>
      {blocked ? (
        <>
          <Md text={blocked.text} className="mt-2 text-[13.5px]" />
          <p className="mt-3 text-[12px] text-muted">
            From <Mono>{blocked.path}</Mono> ({item.files['BLOCKED.md']?.origin === 'worktree' ? 'working tree, not committed' : 'committed'}). Answer on {item.issue ? <ExtLink href={item.issue.url}>issue #{item.issue.number}</ExtLink> : 'the issue'}, then run <CopyCommand cmd={`/work ${item.id}`} />.
          </p>
          {item.issue && <AnswerForm issue={item.issue.number} id={item.id} />}
        </>
      ) : (
        <p className="mt-1.5">{n.summary}</p>
      )}
      {n.kind === 'approve' && (
        <div className="mt-2 grid gap-1 text-[12.5px]">
          {item.tierSources.map((s, i) => (
            <div key={i} className="flex gap-2">
              <TierChip tier={s.tier} />
              <span className="w-20 text-muted">{s.source}</span>
              <span className="min-w-0">{s.why ?? ''}</span>
            </div>
          ))}
          {item.pr && (
            <div className="mt-2">
              <ApproveAction pr={item.pr.number} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ParseNotices({ item }: { item: ItemDetail }) {
  if (!item.notices.length) return null
  return (
    <ul className="mt-3 space-y-1 text-[12.5px]">
      {item.notices.map((n, i) => (
        <li key={i} className={cn('flex items-start gap-2 rounded-md px-3 py-1.5', n.level === 'error' ? 'bg-fail-bg' : 'bg-surface-2')}>
          <FileWarning aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', n.level === 'error' ? 'text-fail' : 'text-muted')} />
          <span>
            <Mono className="text-muted">{n.source}</Mono> {n.message}
            {n.level === 'error' && ' The raw text is shown in its tab.'}
          </span>
        </li>
      ))}
    </ul>
  )
}

function NotVerifiedCallout({ item, onOpen }: { item: ItemDetail; onOpen: () => void }) {
  if (!item.notVerified.length) return null
  return (
    <section aria-label="Not verified" className="mt-3 rounded-lg border border-block/40 bg-block-bg px-4 py-2.5">
      <div className="flex items-center gap-2 font-medium">
        <ShieldQuestion aria-hidden className="size-4 text-block" /> Not verified by anyone ({item.notVerified.length})
        <button onClick={onOpen} className="ml-auto text-[12px] font-normal text-muted underline">
          Details
        </button>
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-6 text-[12.5px]">
        {item.notVerified.slice(0, 4).map((n, i) => (
          <li key={i}>
            {n.text} <span className="text-muted">({n.source})</span>
          </li>
        ))}
        {item.notVerified.length > 4 && <li className="text-muted">and {item.notVerified.length - 4} more</li>}
      </ul>
    </section>
  )
}

function StageStrip({ item }: { item: ItemDetail }) {
  return (
    <ol aria-label="Stages" className="mt-4 grid grid-cols-4 overflow-hidden rounded-lg border border-border bg-surface sm:grid-cols-8">
      {item.stages.map((s) => {
        const current = s.stage === item.stage && item.state === 'in-progress'
        return (
          <li key={s.stage} className={cn('border-r border-b border-border px-2.5 py-2 last:border-r-0 sm:border-b-0', current && 'bg-run-bg', s.status === 'pending' && 'text-faint')} aria-current={current ? 'step' : undefined}>
            <div className="flex items-center gap-1.5 font-mono text-[12px]">
              <StatusGlyph status={s.status} />
              {s.stage}
            </div>
            <div className="mt-0.5 text-[11.5px] text-muted tabular">
              <span className="sr-only">{STATUS[s.status].label}, </span>
              {s.durationMs !== undefined ? duration(s.durationMs) : s.status === 'pending' ? '' : s.status === 'skipped' ? 'skipped' : '—'}
              {s.rounds > 0 && <span className="ml-1">· r{s.rounds}</span>}
              {item.fixByStage[s.stage] ? <span className="ml-1 text-fail">· {item.fixByStage[s.stage]}✕</span> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ---------- tabs ----------

function suiteState(item: ItemDetail): { label: string; status: StageView['status'] } {
  const check = item.checks.find((c) => c.name === 'check')
  if (check) {
    if (check.status !== 'COMPLETED') return { label: 'CI check running', status: 'running' }
    return check.conclusion === 'SUCCESS' ? { label: 'suite passed in CI (check)', status: 'passed' } : { label: `CI check ${String(check.conclusion).toLowerCase()}`, status: 'failed' }
  }
  const gate = item.stages.find((s) => s.stage === 'gate')!
  if (gate.status === 'passed') return { label: 'suite passed at the gate (make accept)', status: 'passed' }
  if (gate.status === 'failed' || gate.status === 'blocked') return { label: `gate ${gate.status}`, status: gate.status }
  return { label: 'not run yet', status: 'pending' }
}

function SpecTab({ item }: { item: ItemDetail }) {
  const spec = item.spec
  if (!spec) return <Empty title="No spec.md yet">The spec stage writes it.</Empty>
  if (!spec.ok)
    return (
      <div>
        <ErrorState title="Could not parse spec.md" error={spec.error} />
        <h3 className="mt-4 mb-1 text-[12px] font-semibold text-muted">Raw spec.md</h3>
        <Raw text={spec.raw} />
      </div>
    )
  const s = spec.value
  const suite = suiteState(item)
  const testsWritten = item.stages.find((x) => x.stage === 'tests')?.status === 'passed'
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>
          risk_floor <TierChip tier={s.risk_floor} />
        </span>
        <span>
          tests <Mono>{s.tests}</Mono>
        </span>
        {s.status && (
          <span title="Nothing in the factory updates this field">
            status <Mono>{s.status}</Mono>
          </span>
        )}
      </div>
      <Block title="Problem">
        <Md text={s.problem || '_empty_'} />
      </Block>
      <Block title={`Acceptance criteria (${s.criteria.length})`}>
        <p className="mb-2 flex items-center gap-1.5 text-[12px] text-muted">
          Pass state per test is not recorded by the factory; the suite as a whole: <Status status={suite.status} /> <span>({suite.label})</span>
        </p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {s.criteria.map((c) => {
            const refs = item.testRefs.filter((r) => r.ac === c.id)
            return (
              <li key={c.id} className="grid gap-x-3 px-3 py-2 sm:grid-cols-[3.5rem_1fr]">
                <Mono className="font-semibold">{c.id}</Mono>
                <div>
                  <Md text={c.text} />
                  {refs.length ? (
                    <ul className="mt-1 space-y-0.5">
                      {refs.map((r, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-[12px]">
                          <StatusGlyph status={s.tests === 'none' ? 'skipped' : suite.status} />
                          <Mono className="text-muted">
                            {r.file}:{r.line}
                          </Mono>
                          <Mono className="truncate">{r.text}</Mono>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={cn('mt-1 text-[12px]', testsWritten ? 'text-block' : 'text-faint')}>
                      {s.tests === 'none' ? 'No tests (spec says tests: none)' : testsWritten ? 'No acceptance test names this criterion' : 'Tests not written yet'}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </Block>
      <List title="Assumptions (made without asking)" items={s.assumptions} />
      <List title="Blocking questions" items={s.blockingQuestions} empty="None" />
      <List title="Out of scope" items={s.outOfScope} />
      <List title="Expected touch points" items={s.touchPoints} mono />
      <List title="Follow-ups" items={s.followUps} empty="None" />
      {spec.warnings.length > 0 && <List title="Spec warnings" items={spec.warnings} />}
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[12px] font-semibold text-muted">{title}</h3>
      {children}
    </section>
  )
}
function List({ title, items, empty, mono }: { title: string; items: string[]; empty?: string; mono?: boolean }) {
  return (
    <Block title={title}>
      {items.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {items.map((x, i) => (
            <li key={i}>{mono ? <Mono>{x}</Mono> : <Md text={x} className="inline-block" />}</li>
          ))}
        </ul>
      ) : (
        <p className="text-faint">{empty ?? 'None recorded'}</p>
      )}
    </Block>
  )
}

function DocTab({ text, empty }: { text?: string; empty: string }) {
  return text ? <Md text={text} className="max-w-3xl" /> : <Empty title={empty} />
}

function ChangesTab({ item }: { item: ItemDetail }) {
  const [file, setFile] = useState<string | null>(null)
  if (!item.changes.length) return <Empty title="No changes recorded">There is no branch diff, pull request file list or merge commit for this item yet.</Empty>
  const total = item.changes.reduce((a, c) => [a[0]! + (c.additions ?? 0), a[1]! + (c.deletions ?? 0)], [0, 0])
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
      <div>
        <p className="mb-1.5 text-[12px] text-muted">
          {item.changes.length} files · <span className="text-pass">+{total[0]}</span> <span className="text-fail">−{total[1]}</span> · tier per file from <Mono>factory/risk-rules.txt</Mono> on main
        </p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {item.changes.map((c) => (
            <li key={c.path}>
              <button onClick={() => setFile(c.path)} aria-pressed={file === c.path} className={cn('flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2', file === c.path && 'bg-surface-2')}>
                <TierChip tier={c.tier} />
                <Mono className="min-w-0 flex-1 truncate" >{c.path}</Mono>
                <span className="text-[11.5px] tabular">
                  <span className="text-pass">+{c.additions ?? '?'}</span> <span className="text-fail">−{c.deletions ?? '?'}</span>
                </span>
              </button>
              {c.pattern && <div className="-mt-1 px-2.5 pb-1.5 pl-10 text-[11px] text-muted">matched <Mono>{c.pattern}</Mono></div>}
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0">{file ? <Diff id={item.id} file={file} /> : <Empty title="Pick a file to see its diff" />}</div>
    </div>
  )
}

function Diff({ id, file }: { id: string; file: string }) {
  const { data, error, isLoading } = useQuery({ queryKey: ['diff', id, file], queryFn: () => getText(`/api/items/${encodeURIComponent(id)}/diff?file=${encodeURIComponent(file)}`) })
  if (isLoading) return <Loading rows={6} label="Loading diff" />
  if (error) return <Empty title="No diff available">{error instanceof HttpError && error.status === 404 ? 'The branch or commit for this change is not in the local repository.' : String(error)}</Empty>
  return <Patch text={data ?? ''} title={file} />
}

function GatesTab({ item }: { item: ItemDetail }) {
  const gate = item.stages.find((s) => s.stage === 'gate')!
  return (
    <div className="max-w-4xl space-y-5">
      <Block title="Gate scripts (run by the foreman)">
        <p className="mb-1.5 text-[12px] text-muted">
          <Mono>make check</Mono>, <Mono>make accept</Mono>, <Mono>check-acceptance-lock.sh</Mono> and <Mono>classify-risk.sh</Mono> are recorded as one gate event per attempt; results per script are not recorded.
        </p>
        {gate.attempts.length ? (
          <table className="w-full rounded-lg border border-border bg-surface text-left">
            <thead className="text-[11.5px] text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-1.5 font-medium">Round</th>
                <th className="px-3 py-1.5 font-medium">Result</th>
                <th className="px-3 py-1.5 font-medium">Detail</th>
                <th className="px-3 py-1.5 text-right font-medium">Took</th>
              </tr>
            </thead>
            <tbody>
              {gate.attempts.map((a, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5 tabular">r{a.round}</td>
                  <td className="px-3 py-1.5">
                    <Status status={a.status} />
                  </td>
                  <td className="px-3 py-1.5">{a.detail ?? <span className="text-faint">—</span>}</td>
                  <td className="px-3 py-1.5 text-right tabular text-muted">{a.start && a.end ? duration(Date.parse(a.end) - Date.parse(a.start)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="The gate has not run" />
        )}
      </Block>
      <Block title="CI checks on the pull request">
        {item.checks.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {item.checks.map((c) => {
              const st: StageView['status'] = c.status !== 'COMPLETED' ? 'running' : c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' ? 'passed' : c.conclusion === 'SKIPPED' ? 'skipped' : 'failed'
              return (
                <li key={c.name} className="flex items-center gap-3 px-3 py-1.5">
                  <Mono className="w-24">{c.name}</Mono>
                  <Status status={st} />
                  {c.name === 'risk-gate' && st === 'failed' && !item.pr?.approved && <span className="text-[12px] text-muted">expected until you add human-approved</span>}
                  {c.url && <ExtLink href={c.url}>details</ExtLink>}
                </li>
              )
            })}
          </ul>
        ) : (
          <Empty title={item.pr ? 'No checks reported' : 'No pull request yet'}>{item.github.state !== 'fresh' && 'GitHub data is not fresh, so checks may be missing.'}</Empty>
        )}
      </Block>
      <Block title="Risk tier">
        <div className="space-y-1">
          {item.tierSources.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <TierChip tier={s.tier} />
              <span className="w-20 text-muted">{s.source}</span>
              <span>{s.why ?? ''}</span>
            </div>
          ))}
          {!item.tierSources.length && <p className="text-faint">No tier source yet.</p>}
          <p className="pt-1 text-[12px] text-muted">The tier is the highest source; nothing lowers it.</p>
        </div>
      </Block>
    </div>
  )
}

const REVIEW_WHO: Record<string, string> = {
  'review.md': 'the independent reviewer',
  'evidence-review.md': 'the evidence reviewer (research items)',
  'db-review.md': 'the database specialist',
  'ui-review.md': 'the UI specialist',
}
function ReviewTab({ item }: { item: ItemDetail }) {
  if (!item.reviews.length) return <Empty title="No review on record yet">The reviewer writes review.md after the gate passes; specialists add db-review.md, ui-review.md or evidence-review.md when their paths are touched.</Empty>
  return (
    <div className="space-y-8">
      {item.reviews.map((x) => (
        <section key={x.file} aria-label={x.file}>
          <h3 className="mb-2 text-[12px] text-muted">
            <Mono className="text-fg">{x.file}</Mono> · by {REVIEW_WHO[x.file]}
          </h3>
          <OneReview item={item} file={x.file} r={x.review} />
        </section>
      ))}
    </div>
  )
}
function OneReview({ item, file, r }: { item: ItemDetail; file: string; r: ItemDetail['reviews'][number]['review'] }) {
  if (!r.ok)
    return (
      <div>
        <ErrorState title={`Could not parse ${file}`} error={r.error} />
        <h3 className="mt-4 mb-1 text-[12px] font-semibold text-muted">Raw {file}</h3>
        <Raw text={r.raw} />
      </div>
    )
  const v = r.value
  const reviewStage = item.stages.find((s) => s.stage === 'review')!
  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn('rounded-md px-2 py-0.5 font-semibold', v.verdict === 'pass' ? 'bg-pass-bg text-pass' : v.verdict === 'escalate' ? 'bg-block-bg text-block' : 'bg-fail-bg text-fail')}>VERDICT: {v.verdict}</span>
        <span className="inline-flex items-center gap-1.5">
          RISK <TierChip tier={v.risk} /> {v.riskWhy && <span className="text-muted">{v.riskWhy}</span>}
        </span>
        <span className="text-muted">{reviewStage.rounds ? `${reviewStage.rounds} review fix round${reviewStage.rounds > 1 ? 's' : ''}; only the last review is kept` : 'first review'}</span>
      </div>
      <Findings title="Blocking" items={v.blocking} tone="fail" />
      <Findings title="Non-blocking" items={v.nonBlocking} tone="muted" />
      <List title="Verified (by the reviewer, per its own report)" items={v.verified} />
      <List title="Not verified" items={v.notVerified} empty="None" />
      {r.warnings.length > 0 && <List title="Format warnings" items={r.warnings} />}
    </div>
  )
}
function Findings({ title, items, tone }: { title: string; items: { path?: string; line?: number; text: string }[]; tone: 'fail' | 'muted' }) {
  return (
    <Block title={`${title} (${items.length})`}>
      {items.length ? (
        <ul className={cn('divide-y divide-border rounded-lg border border-border bg-surface', tone === 'fail' && 'border-l-[3px] border-l-fail')}>
          {items.map((f, i) => (
            <li key={i} className="px-3 py-1.5">
              {f.path && (
                <Mono className="mr-2 text-muted">
                  {f.path}
                  {f.line ? `:${f.line}` : ''}
                </Mono>
              )}
              {f.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-faint">None</p>
      )}
    </Block>
  )
}

type Row = { ts: string; kind: 'stage' | 'lifecycle' | 'commit'; text: React.ReactNode; status?: StageView['status'] }

function ActivityTab({ item }: { item: ItemDetail }) {
  const now = useNow()
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const e of item.events) {
      if (e.type === 'stage')
        out.push({ ts: e.ts, kind: 'stage', status: e.status === 'started' ? 'running' : e.status, text: <><StageLabel stage={e.stage} round={e.round} /> <span className="text-muted">{e.status}</span>{e.detail && <span> · {e.detail}</span>}{e.pr && <span className="text-muted"> · PR #{e.pr}</span>}{e.tier && <span className="text-muted"> · {e.tier}</span>}</> })
      else out.push({ ts: e.ts, kind: 'lifecycle', text: <><Mono className="text-muted">{e.event}</Mono>{e.agent_type && <Mono> {e.agent_type}</Mono>}{e.reason && <span className="text-muted"> · {e.reason}</span>}{e.message && <span> · {e.message}</span>}</> })
    }
    for (const c of item.commits) out.push({ ts: c.time, kind: 'commit', text: <><Mono className="text-muted">{c.sha.slice(0, 8)}</Mono> {c.subject}{c.stage && <Mono className="ml-1 rounded bg-surface-2 px-1">Factory-Stage: {c.stage}</Mono>}</> })
    return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  }, [item])
  const parent = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 30, overscan: 12 })

  return (
    <div className="space-y-5">
      <Block title={`Agent runs (${item.runs.length})`}>
        {item.runs.length ? (
          <table className="w-full max-w-4xl rounded-lg border border-border bg-surface text-left">
            <thead className="text-[11.5px] text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-1.5 font-medium">Agent</th>
                <th className="px-3 py-1.5 font-medium">Stage</th>
                <th className="px-3 py-1.5 font-medium">Started</th>
                <th className="px-3 py-1.5 text-right font-medium">Took</th>
                <th className="px-3 py-1.5 font-medium">Outcome</th>
                <th className="px-3 py-1.5 font-medium">Model</th>
                {item.tokensAvailable && <th className="px-3 py-1.5 text-right font-medium">Tokens</th>}
              </tr>
            </thead>
            <tbody>
              {item.runs.map((r) => (
                <tr key={r.agentId} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5"><Mono>{r.agentType}</Mono></td>
                  <td className="px-3 py-1.5">{r.stage ?? '—'}</td>
                  <td className="px-3 py-1.5 text-muted" title={r.start}>{r.start ? `${ago(r.start, now)} ago` : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular text-muted">{r.start ? duration((r.end ? Date.parse(r.end) : now) - Date.parse(r.start)) : '—'}</td>
                  <td className="px-3 py-1.5">{r.outcome === 'running' ? <Status status="running" /> : r.outcome === 'abandoned' ? <span className="text-fail">abandoned</span> : r.outcome === 'no-end' ? <span className="text-muted" title="Started, never recorded an end, nothing heard for the quiet threshold">no end recorded</span> : <span className="text-muted">finished</span>}</td>
                  <td className="px-3 py-1.5" title={r.tokensNote}>{r.model ? <Mono className="text-muted">{r.model}</Mono> : <span className="text-faint">—</span>}</td>
                  {item.tokensAvailable && (
                    <td className="px-3 py-1.5 text-right tabular" title={r.tokens ? `input ${r.tokens.input}, output ${r.tokens.output}, cache write ${r.tokens.cacheWrite}, cache read ${r.tokens.cacheRead}` : r.tokensNote}>
                      {r.tokens ? compact(r.tokens.total) : <span className="text-faint">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No agent runs recorded">Lifecycle events come from the telemetry hook in <Mono>.factory/events.jsonl</Mono>, which exists only on the machine that ran the factory.</Empty>
        )}
      </Block>
      <Block title={`Events and commits (${rows.length})`}>
        {rows.length ? (
          <div ref={parent} tabIndex={0} aria-label="Events and commits, newest first" className="max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-surface" role="list">
            <div style={{ height: v.getTotalSize(), position: 'relative' }}>
              {v.getVirtualItems().map((vi) => {
                const r = rows[vi.index]!
                return (
                  <div key={vi.key} role="listitem" data-index={vi.index} ref={v.measureElement} className="absolute inset-x-0 flex items-baseline gap-3 border-b border-border px-3 py-1.5" style={{ transform: `translateY(${vi.start}px)` }}>
                    <time className="w-36 shrink-0 text-[12px] text-muted tabular" dateTime={r.ts} title={r.ts}>
                      {when(r.ts)}
                    </time>
                    <span className="w-4 shrink-0">{r.kind === 'commit' ? <GitCommitHorizontal aria-label="commit" className="size-3.5 text-muted" /> : r.status ? <StatusGlyph status={r.status} /> : <span aria-hidden className="text-faint">·</span>}</span>
                    <span className="min-w-0">{r.text}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <Empty title="No events yet" />
        )}
      </Block>
      <Block title="Where this item's files were read from">
        <ul className="text-[12.5px]">
          {Object.entries(item.files).map(([name, f]) => (
            <li key={name}>
              <Mono>{f!.path}</Mono> <span className="text-muted">— {f!.origin === 'worktree' ? 'working tree' : f!.origin === 'branch' ? `branch ${item.branch ?? ''}` : 'main'}</span>
            </li>
          ))}
          {!Object.keys(item.files).length && <li className="text-faint">No work folder found.</li>}
        </ul>
      </Block>
    </div>
  )
}

function NotVerifiedTab({ item }: { item: ItemDetail }) {
  if (!item.notVerified.length) return <Empty title="Nothing is recorded as unverified">The review lists nothing under NOT VERIFIED, the pull request body lists nothing, and every criterion has a named test.</Empty>
  return (
    <ul className="max-w-3xl divide-y divide-border rounded-lg border border-block/40 bg-surface">
      {item.notVerified.map((n, i) => (
        <li key={i} className="flex items-start gap-3 px-3 py-2">
          <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-block" />
          <span className="flex-1">{n.text}</span>
          <Mono className="text-muted">{n.source}</Mono>
        </li>
      ))}
    </ul>
  )
}

function ObservationsTab({ item }: { item: ItemDetail }) {
  if (!item.observations.length) return <Empty title="No observations for this item">The observer writes them at the end of every run, including runs that stopped.</Empty>
  return (
    <div className="max-w-4xl space-y-4">
      {item.observations.map((o) => (
        <section key={o.file}>
          <h3 className="mb-1 text-[12px] text-muted">
            <Mono>{o.file}</Mono> {o.outcome && <>· outcome <Mono>{o.outcome}</Mono></>}
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {o.items.map((x, i) => (
              <li key={i} className="grid grid-cols-[3.5rem_5.5rem_1fr] gap-2 px-3 py-1.5 max-sm:grid-cols-1">
                <span className={cn('font-medium', x.priority === 'high' ? 'text-fail' : x.priority === 'med' ? 'text-block' : 'text-muted')}>[{x.priority}]</span>
                <span className="text-muted">{x.stage}</span>
                <span>
                  {x.text}
                  {x.source ? <span className="block text-[12px] text-muted">Source: {x.source}</span> : <span className="block text-[12px] text-block">No source recorded</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
