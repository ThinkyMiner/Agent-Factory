// Team mode: the planning cycle (status, round, who owes what, its pull request, the transcript)
// and the features it dispatched. Everything here was written by agents: bodies are plain text,
// documents go through the sanitising markdown renderer.
import { useNow, useTeams, type CycleView, type FeatureView } from '@/lib/api'
import { ago, cn, when } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading, Section } from '@/components/States'
import { Md } from '@/components/Markdown'
import { ItemId, Mono, StateBadge } from '@/components/vocab'
import { CopyCommand } from './ControlRoom'

export function Planning() {
  const { data, error, isPending, refetch } = useTeams()
  return (
    <>
      <PageHeader title="Planning" />
      <div className="px-5 py-4">
        {isPending ? (
          <Loading rows={5} label="Loading planning" />
        ) : error ? (
          <ErrorState title="Could not load planning" error={error} onRetry={() => void refetch()} />
        ) : !data ? (
          <Empty title="This factory runs as one team">
            Planning cycles and features are team mode. It starts with <Mono>factory/teams.json</Mono> (<Mono>factory teams init</Mono>).
          </Empty>
        ) : (
          <>
            {data.cycle ? <Cycle c={data.cycle} /> : (
              <Section title="Planning cycle" id="cycle">
                <Empty title="No planning cycle yet">The orchestrator opens one with <CopyCommand cmd="/plan" />.</Empty>
              </Section>
            )}
            <Section title="Features" count={data.features.length} id="features">
              {data.features.length ? <div className="space-y-3">{data.features.map((f) => <Feature key={f.name} f={f} />)}</div> : <Empty title="No feature dispatched yet" />}
            </Section>
            {data.cycle && <Transcript c={data.cycle} />}
          </>
        )}
      </div>
    </>
  )
}

const Field = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <dt className="label">{k}</dt>
    <dd className="mt-0.5">{children}</dd>
  </div>
)

function Cycle({ c }: { c: CycleView }) {
  const now = useNow()
  const s = c.state
  const needsHuman = c.records.filter((r) => r.status === 'needs-human')
  return (
    <Section title={`Planning cycle · ${c.name}`} id="cycle">
      <div className="panel space-y-4 px-4 py-3">
        {c.error && <p role="alert" className="text-fail">{c.error}</p>}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Field k="Status">
            <Mono className="text-fg">{s?.status ?? 'unknown'}</Mono>
            {s?.feature && <Mono className="text-muted"> → {s.feature}</Mono>}
          </Field>
          <Field k="In this status">
            <span title={when(s?.history.at(-1)?.at ?? s?.round_started_at)}>{ago(s?.history.at(-1)?.at ?? s?.round_started_at, now)}</span>
            {!!s?.draft && <span className="text-muted"> · draft {s.draft}</span>}
          </Field>
          <Field k="Pull request">
            {c.pr ? (
              <>
                {c.pr.url ? <a href={c.pr.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">#{c.pr.number}</a> : <Mono>#{c.pr.number}</Mono>}
                <span className="text-muted"> {c.pr.state ? c.pr.state.toLowerCase() : 'no GitHub data'}{c.pr.isDraft ? ', draft' : ''}{c.pr.labels.length ? ` · ${c.pr.labels.join(', ')}` : ''}</span>
              </>
            ) : (
              <span className="text-muted">none yet</span>
            )}
            {c.blocking.map((b) => (
              <span key={b.number} className="block text-[12.5px]">
                <a href={b.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">#{b.number}</a>{' '}
                <span className="text-block">{b.why}</span>
                <span className="text-muted"> · {b.title}{b.labels.includes('human-approved') ? ' · approved' : ''}</span>
              </span>
            ))}
          </Field>
          <Field k="Read from">
            <Mono>{c.source}</Mono>
            {c.active && <span className="text-muted"> · active</span>}
          </Field>
        </dl>
        {s && (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Field k="Teams">
              {s.teams.map((t) => (
                <span key={t} className="mr-3 inline-block">
                  <Mono>{t}</Mono>
                  {!!s.strikes[t] && <span className="text-block"> · {s.strikes[t]} strike{s.strikes[t] === 1 ? '' : 's'}</span>}
                </span>
              ))}
            </Field>
            <Field k="Waiting for">
              {c.waiting.length ? (
                <ul aria-label="Waiting for">
                  {c.waiting.map((w, i) => (
                    <li key={i}>
                      <Mono className="text-fg">{w.team}</Mono> <span className="text-muted">owes {w.owes}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-muted">{s.status.startsWith('discussion-') || s.status === 'positions' || s.status === 'decisions' ? 'nobody: the round can close' : '—'}</span>
              )}
            </Field>
          </dl>
        )}
        {!!s?.history.length && (
          <ol aria-label="Rounds" className="flex flex-wrap gap-x-1 gap-y-1 font-mono text-[11.5px] text-muted">
            {s.history.map((h, i) => (
              <li key={i} title={when(h.at)} className={cn(i === s.history.length - 1 && 'text-fg')}>
                {i > 0 && <span aria-hidden>→ </span>}
                {h.status}
              </li>
            ))}
          </ol>
        )}
        {needsHuman.length > 0 && (
          <p className="text-block">
            {needsHuman.length} needs-human record{needsHuman.length > 1 ? 's' : ''} to decide: {needsHuman.map((r) => r.id).join(', ')}
          </p>
        )}
      </div>

      {c.records.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table aria-label="Decision records" className="panel w-full text-left">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-2">Record</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {c.records.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5"><Mono>{r.id}</Mono></td>
                  <td className="px-3 py-1.5">{r.title}</td>
                  <td className={cn('px-3 py-1.5', r.status === 'needs-human' && 'font-medium text-block')}>{r.status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {c.brief && (
        <details className="panel mt-3 px-4 py-2">
          <summary className="cursor-pointer font-mono text-[12px]">BRIEF.md</summary>
          <Md text={c.brief} className="mt-2" />
        </details>
      )}
    </Section>
  )
}

/** The cycle's messages, as the plain text they are, then its planning events. */
function Transcript({ c }: { c: CycleView }) {
  const now = useNow()
  return (
    <Section title="Transcript" count={c.messages.length} id="transcript">
      {c.messages.length ? (
        <ol aria-label="Transcript" className="panel">
          {c.messages.map((m, i) => (
            <li key={`${m.id}-${i}`} className="border-b border-border px-3 py-2 last:border-b-0">
              {(i === 0 || c.messages[i - 1]!.round !== m.round) && <div className="label mb-1 text-fg">{m.round}</div>}
              <div className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-muted">
                <Mono>{m.id}</Mono>
                <span>
                  <Mono className="text-fg">{m.from}</Mono> → <Mono>{m.to}</Mono>
                </span>
                <span className="font-medium text-fg">{m.kind}{m.draft ? ` (draft ${m.draft})` : ''}</span>
                {m.refs.length > 0 && <span>refs {m.refs.join(', ')}</span>}
                {m.attach && <span>attached <Mono>{m.attach}</Mono></span>}
                <span className="ml-auto tabular" title={when(m.ts)}>{ago(m.ts, now)}</span>
              </div>
              {/* untrusted text: shown as text, never as HTML or markdown */}
              <p className="mt-1 text-[13px] break-words whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ol>
      ) : (
        <Empty title="No messages yet" />
      )}

      {c.events.length > 0 && (
        <details className="panel mt-3 px-4 py-2">
          <summary className="cursor-pointer font-mono text-[12px]">Planning events · {c.events.length}</summary>
          <ul className="mt-2 text-[12.5px]">
            {c.events.map((e, i) => (
              <li key={i} className="flex gap-3 py-0.5">
                <span className="w-28 shrink-0 text-muted tabular" title={e.ts}>{when(e.ts)}</span>
                <Mono className="w-24 shrink-0 text-muted">{e.team ?? ''}</Mono>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  )
}

function Feature({ f }: { f: FeatureView }) {
  return (
    <article aria-label={`Feature ${f.name}`} className="panel px-4 py-3">
      <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Mono className="text-[13px] text-fg">{f.name}</Mono>
        <span className="text-[12px] text-muted">
          {f.refs.feature ? <Mono>{f.refs.feature}</Mono> : 'no feature branch'}
          {f.refs.integrate && <> · <Mono>{f.refs.integrate}</Mono></>}
        </span>
      </h3>
      {f.items.length ? (
        <div className="mt-2 overflow-x-auto">
          <table aria-label={`Items of ${f.name}`} className="w-full text-left">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="py-1.5 pr-3">Issue</th>
                <th className="py-1.5 pr-3">Team</th>
                <th className="py-1.5 pr-3">Where</th>
              </tr>
            </thead>
            <tbody>
              {f.items.map((i) => (
                <tr key={i.number} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-3">
                    {i.item ? <ItemId id={String(i.number)} /> : <Mono className="text-muted">#{i.number}</Mono>} {i.title}
                    {i.ticket && <Mono className="ml-1.5 text-muted">ticket</Mono>}
                  </td>
                  <td className="py-1.5 pr-3"><Mono>{i.team ?? '—'}</Mono></td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {i.item ? (
                      <>
                        <StateBadge state={i.item.state} />
                        {i.item.pr && <Mono className="ml-1.5 text-muted">PR #{i.item.pr}</Mono>}
                      </>
                    ) : (
                      <span className="text-muted">{i.open ? 'open, not started' : 'closed'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-muted">No issues labelled <Mono>feature:{f.name}</Mono> (or no GitHub data).</p>
      )}
      {f.pulls.length > 0 && (
        <ul className="mt-2 text-[12.5px]">
          {f.pulls.map((p) => (
            <li key={p.number}>
              <a href={p.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">PR #{p.number}</a> <Mono className="text-muted">{p.head}</Mono> {p.title} <span className="text-muted">({p.state.toLowerCase()})</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 space-y-1">
        {f.docs.length ? (
          f.docs.map((d) => (
            <details key={d.file}>
              <summary className="cursor-pointer text-[12.5px]">
                <Mono className="text-fg">{d.file}</Mono> <span className="text-muted">· {d.headline} · on <Mono>{d.ref}</Mono></span>
              </summary>
              <Md text={d.text} className="mt-2 border-l-2 border-border pl-3" />
            </details>
          ))
        ) : (
          <p className="text-[12.5px] text-muted">No acceptance criteria, e2e report or acceptance review on its branches yet.</p>
        )}
      </div>
    </article>
  )
}

