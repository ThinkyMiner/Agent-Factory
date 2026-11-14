// Home. Job 1: tell me what needs me. "Needs you" always wins the visual hierarchy.
import { Link } from 'react-router'
import { CircleCheck, Copy, Info } from 'lucide-react'
import { useApiState, useNow, type ApiState, type NeedsEntry } from '@/lib/api'
import { ago, cn, elapsed } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading, Section } from '@/components/States'
import { ItemId, LiveDot, Mono, NeedsTag, NEEDS, StageLabel, TierChip, TONE_BORDER, needsTone } from '@/components/vocab'

export function ControlRoom() {
  const { data, error, isLoading, refetch } = useApiState()
  return (
    <>
      <PageHeader title="Control room">{data && <FactoryLine data={data} />}</PageHeader>
      <div className="px-5 py-4">
        {isLoading && <Loading rows={5} label="Loading the factory" />}
        {error && <ErrorState title="Could not load the factory state" error={error} onRetry={() => void refetch()} />}
        {data && (data.items.length === 0 ? <NewFactory data={data} /> : <Home data={data} />)}
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
      <NeedsYou entries={data.needsYou} />
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
      <p className="flex items-center gap-1.5 border-t border-border bg-surface-2 px-4 py-2 text-[12px] text-muted">
        <Info aria-hidden className="size-3.5" /> {NEEDS.answer.label}: answer on the issue, then run <CopyCommand cmd="/work <id>" /> again. Rows clear themselves when the item moves on.
      </p>
    </section>
  )
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

function Running({ data }: { data: ApiState }) {
  const now = useNow()
  return (
    <Section title="Running now" count={data.running.length} id="running">
      {data.running.length === 0 ? (
        <Empty title="Nothing is running">Start an item with <CopyCommand cmd="/work <id>" /> in a Claude Code session in the factory repo.</Empty>
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
            {data.running.map((r) => (
              <tr key={r.workId} className="border-b border-border last:border-b-0">
                <td className="px-3 py-1.5">
                  <Link data-nav-item to={`/items/${r.workId}`} className="hover:underline">
                    <ItemId id={r.workId} link={false} /> {r.title}
                  </Link>
                </td>
                <td className="px-3 py-1.5">
                  <StageLabel stage={r.stage} status="running" />
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    {r.agentType !== 'foreman' && <LiveDot />}
                    <Mono>{r.agentType}</Mono>
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

function Merged({ data }: { data: ApiState }) {
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
        {i.reverted && <span className="text-[11.5px] font-medium text-fail">reverted</span>}
        <TierChip tier={i.tier} />
        <span className="w-16 text-[12px] text-muted" title={i.mergedBy === 'auto' ? 'auto-merged' : 'merged by you'}>
          {i.mergedBy === 'auto' ? 'auto' : i.mergedBy === 'human' ? 'by you' : ''}
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
