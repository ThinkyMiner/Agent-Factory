// Home. Job 1: tell me what needs me. "Needs you" always wins the visual hierarchy.
import { Link } from 'react-router'
import { CircleCheck, Copy, Info } from 'lucide-react'
import { useApiState, useNow, useTeams, type ApiState, type NeedsEntry, type SessionTab } from '@/lib/api'
import { ago, cn, elapsed } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading, Section } from '@/components/States'
import { ItemId, LiveDot, Mono, NeedsTag, NEEDS, StageLabel, StateBadge, Term, TierChip, TONE_BORDER, needsTone } from '@/components/vocab'

export function ControlRoom() {
  const { data, error, isLoading, refetch } = useApiState()
  return (
    <>
      <PageHeader title="Control room">{data && <FactoryLine data={data} />}</PageHeader>
      <div className="px-5 py-4">
        {isLoading && <Loading rows={5} label="Loading the factory" />}
        {error && <ErrorState title="Could not load the factory state" error={error} onRetry={() => void refetch()} />}
        {data && (data.items.length === 0 && !data.factory.teams ? <NewFactory data={data} /> : <Home data={data} />)}
      </div>
    </>
  )
}

function FactoryLine({ data }: { data: ApiState }) {
  return (
    <span className="text-[12px] text-muted">
      auto-merge up to <Mono className="text-fg">{data.factory.autoMergeMax}</Mono> · quiet after {data.factory.staleMinutes} min
    </span>
  )
}

function Home({ data }: { data: ApiState }) {
  return (
    <>
      {data.factory.teams && <Where />}
      <NeedsYou entries={data.needsYou} />
      {data.factory.teams && <Teams />}
      <Running data={data} />
      <Merged data={data} />
      <Notices data={data} />
    </>
  )
}

function NeedsYou({ entries }: { entries: NeedsEntry[] }) {
  const now = useNow()
  if (!entries.length) {
    return (
      <section aria-labelledby="needs" className="border border-border bg-surface px-5 py-4">
        <h2 id="needs" className="flex items-center gap-2 text-[14px] font-normal">
          <CircleCheck aria-hidden className="size-4 text-pass" /> Nothing needs you
        </h2>
        <p className="mt-1 text-muted">No blocked runs, no pull requests waiting for you, nothing failed or gone quiet.</p>
      </section>
    )
  }
  return (
    <section aria-labelledby="needs" className="border border-accent bg-surface">
      <h2 id="needs" className="flex items-center gap-3 bg-accent px-4 py-2.5 text-[12px] font-normal tracking-[0.1em] text-white uppercase">
        Needs you <span className="bg-lime px-1.5 tracking-normal text-lime-fg tabular">{entries.length}</span>
        <span className="ml-auto text-[11px] tracking-normal normal-case opacity-85 max-sm:hidden">oldest first, by kind</span>
      </h2>
      <ul>
        {entries.map((n) => (
          <li key={`${n.kind}-${n.id}`} className={cn('group border-b border-l-2 border-border last:border-b-0', TONE_BORDER[needsTone(n.kind)])}>
            <Link data-nav-item to={n.href ?? `/items/${n.id}`} className="grid grid-cols-[7.5rem_1fr_auto] items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 focus-visible:bg-surface-2 max-sm:grid-cols-[1fr_auto]">
              <NeedsTag kind={n.kind} className="max-sm:col-span-2" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {n.label ? <span className="font-mono text-[12px] text-muted">{n.label}</span> : <ItemId id={n.id} link={false} />}
                  <span className="font-medium">{n.title}</span>
                </span>
                <span className={cn('mt-0.5 block text-muted', n.kind === 'answer' && 'text-[13.5px] text-fg')}>
                  {n.kind === 'answer' ? <q className="italic">{n.summary}</q> : n.summary}
                </span>
              </span>
              <span className="flex items-center gap-2 text-[12px] whitespace-nowrap text-muted">
                <TierChip tier={n.tier} />
                <StageLabel stage={n.stage} />
                <span className="w-9 text-right tabular" title={n.since}>
                  {ago(n.since, now)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div role="note" aria-label="How to clear these rows" className="space-y-0.5 border-t border-border bg-surface-2 px-4 py-2 text-[12px] text-muted">
        {[...new Set(entries.map(hintKey))].map((k) => (
          <p key={k} className="flex items-start gap-1.5">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" /> <span>{HINT[k]}</span>
          </p>
        ))}
        <p className="pl-5">Rows clear themselves when what they wait for moves on.</p>
      </div>
    </section>
  )
}

/** What clears a row, by what the row is: an item's question, a pull request, a planning record, the sweep, a session. */
const hintKey = (n: NeedsEntry) =>
  n.id.startsWith('pr-') ? `pr-${n.kind}` : n.id.startsWith('sweep-') ? 'sweep' : n.id.startsWith('session-') ? `session-${n.kind}` : n.id.startsWith('decision-') ? 'decision' : n.id.startsWith('cycle-') ? 'cycle' : n.kind
const HINT: Record<string, React.ReactNode> = {
  answer: <>{NEEDS.answer.label}: answer on the item's issue, then run <CopyCommand cmd="/work <id>" /> again (in team mode the team's session picks it up).</>,
  approve: <>{NEEDS.approve.label}: read the item's pull request, add the <Mono>human-approved</Mono> label on GitHub, wait for its checks to pass, then merge it (with auto-merge on, it then merges itself).</>,
  merge: <>{NEEDS.merge.label}: merge it on GitHub once its checks pass; the row says whether they have (nothing will merge it for you).</>,
  failed: <>{NEEDS.failed.label}: open the item: a red check on its pull request is fixed by the team that owns the branch; a failed stage runs again only when the run is started again.</>,
  'waiting-input': <>{NEEDS['waiting-input'].label}: a Claude Code session is showing a prompt; answer it in that terminal.</>,
  quiet: <>{NEEDS.quiet.label}: nothing was heard from the run for a while; look at its terminal: it may have stopped.</>,
  info: <>{NEEDS.info.label}: nothing to do; it moves by itself, and is listed so nothing waits unseen.</>,
  'pr-approve': <>Pull request rows: read it on GitHub, add the <Mono>human-approved</Mono> label, wait for its checks to pass, then merge it (with auto-merge on, it then merges itself).</>,
  'pr-merge': <>Pull request rows marked {NEEDS.merge.label}: merge it on GitHub.</>,
  'pr-failed': <>Pull request rows marked {NEEDS.failed.label}: a required check fails on GitHub; whoever owns the branch fixes it.</>,
  'pr-info': <>Pull request rows marked {NEEDS.info.label}: nothing to do yet: its checks are still running (after your label, the risk-gate reruns), or auto-merge merges it once they pass; the row says which.</>,
  decision: <>Planning records marked needs-human: decide them in the cycle's <Mono>DECISIONS.md</Mono> (or tell the orchestrator); see Planning.</>,
  cycle: <>Planning rows: the round waits for your label or merge on the cycle's pull request; see Planning.</>,
  sweep: <>Sweep rows: what the sweep (the factory's watchdog) saw in the team sessions, in its words; it clears when the sweep stops seeing it.</>,
  'session-failed': <>Session rows: a team's Claude Code session reports an error in its Herdr tab.</>,
  'session-waiting-input': <>Session rows: a team's Claude Code session waits on a prompt or dialog in its Herdr tab; answer it there.</>,
}

export function CopyCommand({ cmd, className }: { cmd: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        void navigator.clipboard?.writeText(cmd)
        const el = e.currentTarget
        el.dataset.copied = '1'
        setTimeout(() => delete el.dataset.copied, 1200)
      }}
      className={cn('group inline-flex items-center gap-1 rounded-sm border border-border-strong bg-surface px-1.5 font-mono text-[12px] text-fg hover:border-fg data-[copied]:border-pass', className)}
      title="Copy to clipboard"
      aria-label={`Copy ${cmd}`}
    >
      {cmd}
      <Copy aria-hidden className="size-3 text-muted group-data-[copied]:text-pass" />
    </button>
  )
}

const SESSION: Record<string, string> = { working: 'text-run', blocked: 'text-block', error: 'text-fail' }
function Session({ s }: { s?: SessionTab }) {
  if (!s) return <span className="text-faint">no tab</span>
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      {s.state === 'working' && <LiveDot label="working" />}
      <Mono className={SESSION[s.state] ?? 'text-muted'}>{s.state}</Mono>
      {s.msg && <span className="text-[12px] text-muted">{s.msg}</span>}
    </span>
  )
}

/** Team mode: where the project is, in plain words: each phase under way, its next step and who owns it. */
function Where() {
  const { data } = useTeams()
  if (!data?.phases.length) return null
  return (
    <section aria-labelledby="where" className="mb-4 border border-border bg-surface">
      <h2 id="where" className="sr-only">Where things are</h2>
      <ol className="divide-y divide-border">
        {data.phases.map((p, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="label w-20 shrink-0">{STEP[p.step]}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{p.label}</span>
              {p.detail && <span className="block text-[12.5px] text-muted">{p.detail}</span>}
            </span>
            {p.next && (
              <span className="text-[12.5px]">
                {[p.next, ...(p.more ?? [])].map((n, k) => (
                  <span key={k} className="block">
                    <span className="text-muted">{k ? 'and: ' : 'next: '}</span>
                    <Mono className={cn(n.who === 'you' ? 'font-semibold text-attention' : 'text-fg')}>{n.who}</Mono>{' '}
                    {n.href?.startsWith('http') ? (
                      <a href={n.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{n.what}</a>
                    ) : n.href ? (
                      <Link to={n.href} className="underline underline-offset-2">{n.what}</Link>
                    ) : (
                      n.what
                    )}
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
const STEP: Record<string, string> = { 'no-cycle': 'start', planning: 'planning', approval: 'approval', stopped: 'stopped', building: 'building', integration: 'integration', 'pr-to-main': 'to main', merged: 'merged' }

/** Team mode: each team's session, checkout and the item it holds; the cycle in one line. */
function Teams() {
  const { data } = useTeams()
  if (!data) return null
  const c = data.cycle
  const waiting = c?.waiting.map((w) => w.team).filter((t, i, a) => a.indexOf(t) === i)
  return (
    <Section
      title="Teams"
      count={data.teams.filter((t) => t.inRoster).length}
      id="teams"
      actions={!data.sessions.available && <span>sessions unavailable</span>}
    >
      {c && (
        <p className="panel mb-2 px-3 py-2 text-[13px]">
          <Link to="/planning" className="underline underline-offset-2">Planning {c.name}</Link>: <Mono>{c.state?.status ?? 'state unreadable'}</Mono>
          {c.state?.feature && <> → <Mono>{c.state.feature}</Mono></>}
          {!!waiting?.length && <span className="text-muted"> · waiting for {waiting.join(', ')}</span>}
        </p>
      )}
      {data.rosterError && <p role="alert" className="mb-2 text-fail">{data.rosterError}</p>}
      <div className="overflow-x-auto">
        <table className="panel w-full text-left">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-2">Team</th>
              <th className="px-3 py-2">Session</th>
              <th className="px-3 py-2">Checkout</th>
              <th className="px-3 py-2"><Term k="holds">Holds</Term></th>
            </tr>
          </thead>
          <tbody>
            {data.teams.map((t) => (
              <tr key={t.name} className="border-b border-border align-top last:border-b-0">
                <td className="px-3 py-1.5">
                  <Mono className="text-fg">{t.name}</Mono>
                  {!t.active && <span className="ml-1.5 text-[12px] text-muted">inactive</span>}
                  {t.owns.length > 0 && (
                    <span className="block max-w-[22rem] truncate text-[11.5px] text-muted" title={t.owns.join('  ')}>
                      owns {t.owns.join(', ')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5">{data.sessions.available ? <Session s={t.session} /> : <span className="text-faint">—</span>}</td>
                <td className="px-3 py-1.5">
                  {!t.checkout ? (
                    <span className="text-faint">{t.inRoster ? 'no worktree' : '—'}</span>
                  ) : !t.checkout.exists ? (
                    <span className="text-block" title={t.checkout.path}>worktree missing</span>
                  ) : (
                    <span className="font-mono text-[12px] text-muted" title={t.checkout.path}>{t.checkout.branch ?? 'detached'}</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  {t.item ? (
                    <Link data-nav-item to={`/items/${t.item.id}`} className="inline-flex flex-wrap items-baseline gap-x-1.5 hover:underline">
                      <ItemId id={t.item.id} link={false} /> {t.item.title} <StateBadge state={t.item.state} />
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

const idleWords = (n: number) => (n ? `${n} session${n === 1 ? '' : 's'} open, ${n === 1 ? 'idle at its prompt' : 'all idle at their prompts'}; nothing is running.` : 'No agent run or session is open.')

function Running({ data }: { data: ApiState }) {
  const now = useNow()
  return (
    <Section title="Running now" count={data.running.length} id="running">
      {data.running.length === 0 ? (
        data.factory.teams ? (
          <Empty title="Nothing is running">{idleWords(data.idleSessions)} In team mode the sweep types <Mono>/work</Mono> into a team's session when it is free and a dispatched item is ready; the strip at the top says what comes next.</Empty>
        ) : (
          <Empty title="Nothing is running">{data.idleSessions > 0 && <>{idleWords(data.idleSessions)} </>}Start an item with <CopyCommand cmd="/work <id>" /> in a Claude Code session in the factory repo.</Empty>
        )
      ) : (
        <table className="panel w-full text-left">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2">Stage</th>
              <th className="px-3 py-2">Agent</th>
              <th className="px-3 py-2 text-right">Elapsed</th>
            </tr>
          </thead>
          <tbody>
            {data.running.map((r, k) => (
              <tr key={`${r.workId}-${r.agentType}-${r.since ?? k}`} className="border-b border-border last:border-b-0">
                <td className="px-3 py-1.5">
                  {r.workId ? (
                    <Link data-nav-item to={`/items/${r.workId}`} className="hover:underline">
                      <ItemId id={r.workId} link={false} /> {r.title}
                    </Link>
                  ) : (
                    <span className="text-muted" title="A Claude Code session that is not running /work on an item: a team session, setup, /plan or /groom">no work item</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <StageLabel stage={r.stage} status="running" />
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    {r.agentType !== 'foreman' && <LiveDot />}
                    <Mono>{r.agentType === 'foreman' ? <Term k="foreman" /> : r.agentType}</Mono>
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right tabular text-muted">{elapsed(r.since, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

/** Who merged, as far as the pull request shows it: the label proves an approval, not who pressed merge. */
export const mergedWords = (i: { mergedBy?: 'auto' | 'human'; merger?: string }) =>
  i.mergedBy === 'auto' ? 'auto-merged' : i.mergedBy === 'human' ? `approved by you; merged by ${i.merger ?? 'unknown'}` : i.merger ? `merged by ${i.merger} (GitHub account)` : 'merged; who merged is not recorded'

function Merged({ data }: { data: ApiState }) {
  const main = data.factory.main?.replace(/^origin\//, '') ?? 'main'
  const now = useNow()
  const startOfDay = new Date(now).setHours(0, 0, 0, 0)
  const d = new Date(now)
  const startOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime()
  const merged = data.items.filter((i) => i.state === 'merged' && i.mergedAt).sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!))
  const today = merged.filter((i) => Date.parse(i.mergedAt!) >= startOfDay)
  const week = merged.filter((i) => Date.parse(i.mergedAt!) >= startOfWeek && Date.parse(i.mergedAt!) < startOfDay)
  const Row = ({ i }: { i: (typeof merged)[number] }) => (
    <li className="border-b border-border last:border-b-0">
      <Link data-nav-item to={`/items/${i.id}`} className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2">
        <ItemId id={i.id} link={false} />
        <span className="min-w-0 flex-1 truncate">{i.title}</span>
        {i.mergedInto && i.mergedInto !== main && <span className="font-mono text-[11px] text-muted" title={i.mergedInto.startsWith('feature/') ? "Merged into the feature branch; main gets it when the feature's integrate pull request merges" : `Merged into ${i.mergedInto}, not ${main}`}>→ {i.mergedInto}</span>}
        {i.reverted && <span className="text-[11.5px] font-medium text-fail">reverted</span>}
        <TierChip tier={i.tier} />
        <span className="w-16 text-[12px] text-muted" title={mergedWords(i)}>
          {i.mergedBy === 'auto' ? 'auto' : i.mergedBy === 'human' ? 'approved' : ''}
        </span>
        <span className="w-14 text-right text-[12px] text-muted tabular" title={`${i.fixRounds} fix rounds`}>
          {i.fixRounds ? `${i.fixRounds} fix` : 'first pass'}
        </span>
        <span className="w-8 text-right text-[12px] text-muted tabular">{ago(i.mergedAt, now)}</span>
      </Link>
    </li>
  )
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      {[
        ['Merged today', today, 'merged-today'] as const,
        ['Earlier this week', week, 'merged-week'] as const,
      ].map(([title, list, id]) => (
        <Section key={id} title={title} count={list.length} id={id} className="mt-0">
          {list.length ? (
            <ul className="panel">
              {list.map((i) => (
                <Row key={i.id} i={i} />
              ))}
            </ul>
          ) : (
            <Empty title={id === 'merged-today' ? 'Nothing merged today yet' : 'Nothing else merged this week'} />
          )}
        </Section>
      ))}
    </div>
  )
}

function Notices({ data }: { data: ApiState }) {
  if (!data.notices.length) return null
  return (
    <Section title="Factory notices" count={data.notices.length} id="notices">
      <ul className="panel text-[12.5px]">
        {data.notices.map((n, i) => (
          <li key={i} className="flex gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
            <span className={cn('w-10 shrink-0 font-mono text-[11px] uppercase', n.level === 'error' ? 'text-fail' : n.level === 'warn' ? 'text-block' : 'text-muted')}>{n.level}</span>
            <Mono className="shrink-0 text-muted">{n.source}</Mono>
            <span>{n.message}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function NewFactory({ data }: { data: ApiState }) {
  return (
    <div className="max-w-3xl">
      <section aria-labelledby="new-factory" className="fig">
        <div className="fig-cap"><span className="fig-title">getting started</span></div>
        <div className="panel px-6 py-6">
        <h2 id="new-factory" className="text-[24px] leading-tight font-normal tracking-[-0.02em]">This factory has no work items yet</h2>
        <p className="mt-2 text-muted">
          The control room fills in as the factory runs. It reads <Mono>work/</Mono>, <Mono>.factory/events.jsonl</Mono>, git and GitHub, and changes nothing.
        </p>
        <ol className="mt-5 list-[decimal-leading-zero] space-y-2.5 pl-8 marker:font-mono marker:text-faint">
          <li>
            Write <Mono>product/BRIEF.md</Mono> and the first lines of <Mono>product/ROADMAP.md</Mono>.
          </li>
          <li>
            In Claude Code in the factory repo, run <CopyCommand cmd="/groom" /> to propose issues.
          </li>
          <li>
            Label the ones you want built <Mono>factory:ready</Mono>.
          </li>
          <li>
            Run <CopyCommand cmd="/work <id>" />. The item appears here within seconds and moves across the board as stages finish.
          </li>
        </ol>
        {!data.factory.isGit && <p className="mt-4 text-block">This folder is not a git repository yet, so branches, commits and pull requests cannot be shown.</p>}
        </div>
      </section>
      <Notices data={data} />
    </div>
  )
}
