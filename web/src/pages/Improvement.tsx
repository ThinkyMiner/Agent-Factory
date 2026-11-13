// Is the factory improving itself? Open factory:improvement pull requests, and every change /reflect
// proposed with its prediction and what the next reflection found.
import { Circle, CircleCheck, CircleMinus, CircleX, ExternalLink, Stamp } from 'lucide-react'
import { useApiState, useImprovement, useNow, type ImprovementView, type Prediction } from '@/lib/api'
import { ago, cn } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { ItemRefs } from '@/components/ItemsPanel'
import { Md, Raw } from '@/components/Markdown'
import { DriftFlag, Mono, TierChip } from '@/components/vocab'
import { ApproveAction } from '@/components/Actions'

const RESULT = {
  worked: { label: 'worked', icon: CircleCheck, cls: 'text-pass' },
  'no effect': { label: 'no effect', icon: CircleMinus, cls: 'text-muted' },
  worse: { label: 'made things worse', icon: CircleX, cls: 'text-fail' },
} as const

function Result({ p }: { p: Prediction }) {
  if (!p.check)
    return (
      <span className="inline-flex items-center gap-1 text-muted">
        <Circle aria-hidden className="size-3.5" />
        {p.id ? 'not checked yet' : 'cannot be checked: no change id'}
      </span>
    )
  const r = RESULT[p.check.result as keyof typeof RESULT] ?? { label: p.check.result, icon: Circle, cls: 'text-muted' }
  return (
    <div>
      <span className={cn('inline-flex items-center gap-1 font-medium', r.cls)}>
        <r.icon aria-hidden className="size-3.5" />
        {r.label}
      </span>
      {p.check.note && <div className="text-[12px] text-muted">{p.check.note}</div>}
      <div className="text-[11.5px] text-faint">checked in the {p.check.checkedIn} reflection</div>
    </div>
  )
}

function Pulls({ v }: { v: ImprovementView & { github: { state: string; fetchedAt?: string } } }) {
  const now = useNow()
  const { data: state } = useApiState()
  if (v.github.state === 'unavailable') return <Empty title="GitHub data unavailable">Open improvement pull requests come from GitHub. The reflections below are local and complete.</Empty>
  if (!v.pulls.length) return <Empty title="No open improvement pull requests"><Mono>/reflect</Mono> opens one per cycle, labelled <Mono>factory:improvement</Mono>.</Empty>
  return (
    <ul className="space-y-2">
      {v.pulls.map((p) => {
        const needsApproval = !p.approved && (p.tier === 'R2' || p.tier === 'R3' || state?.factory.autoMergeMax === 'none')
        return (
          <li key={p.number} className="rounded-lg border border-border bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <a href={p.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium hover:underline">
                <Mono className="text-muted">#{p.number}</Mono> {p.title}
                <ExternalLink aria-label="opens GitHub" className="size-3 text-muted" />
              </a>
              <TierChip tier={p.tier as 'R0' | 'R1' | 'R2' | 'R3' | undefined} />
              {p.isDraft && <span className="text-[12px] text-muted">draft</span>}
              <span className="ml-auto text-[12px] text-muted" title={p.createdAt}>opened {ago(p.createdAt, now)} ago</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
              {needsApproval ? (
                <span className="inline-flex items-center gap-1 font-medium text-wait">
                  <Stamp aria-hidden className="size-3.5" /> Waiting for your approval
                </span>
              ) : p.approved ? (
                <span className="inline-flex items-center gap-1 text-pass">
                  <CircleCheck aria-hidden className="size-3.5" /> human-approved
                </span>
              ) : null}
              {p.checks.map((c) => (
                <span key={c.name} className={cn('inline-flex items-center gap-1', c.state === 'pass' ? 'text-pass' : c.state === 'fail' ? 'text-fail' : 'text-muted')}>
                  {c.state === 'pass' ? <CircleCheck aria-hidden className="size-3.5" /> : c.state === 'fail' ? <CircleX aria-hidden className="size-3.5" /> : <Circle aria-hidden className="size-3.5" />}
                  <Mono>{c.name}</Mono> {c.state === 'pass' ? 'passed' : c.state === 'fail' ? 'failed' : c.state}
                </span>
              ))}
            </div>
            {p.files.length > 0 && (
              <div className="mt-1.5 text-[12px] text-muted">
                Changes {p.files.map((f, i) => <Mono key={f} className="text-fg">{i ? ', ' : ''}{f}</Mono>)}
              </div>
            )}
            {needsApproval && (p.tier === 'R2' || !p.tier) && (
              <div className="mt-2">
                <ApproveAction pr={p.number} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function Improvement() {
  const { data: v, error, isPending, refetch } = useImprovement()
  return (
    <>
      <PageHeader title="Improvement" />
      <div className="max-w-6xl space-y-6 p-5">
        {isPending ? (
          <Loading rows={6} label="Loading improvement" />
        ) : error ? (
          <ErrorState title="Could not load improvement" error={error} onRetry={() => void refetch()} />
        ) : (
          <>
            <section aria-labelledby="imp-prs" className="space-y-2">
              <h2 id="imp-prs" className="font-semibold">Open improvement pull requests</h2>
              <Pulls v={v!} />
            </section>

            <section aria-labelledby="imp-pred" className="space-y-2">
              <h2 id="imp-pred" className="font-semibold">Did the predictions hold?</h2>
              {v!.predictions.length ? (
                <>
                  <p className="text-muted">
                    Each change <Mono>/reflect</Mono> made says how we will know it worked; the next reflection checks it.{' '}
                    <span className="text-fg tabular">
                      {v!.summary.worked} worked · {v!.summary.noEffect} no effect · {v!.summary.worse} made things worse · {v!.summary.unchecked} not checked yet
                    </span>
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                    <table className="w-full min-w-[900px] text-left text-[12.5px]">
                      <thead className="text-[11.5px] text-muted">
                        <tr className="border-b border-border">
                          <th className="px-3 py-1.5 font-medium">Change</th>
                          <th className="px-3 py-1.5 font-medium">Evidence</th>
                          <th className="px-3 py-1.5 font-medium">What changed</th>
                          <th className="px-3 py-1.5 font-medium">How we will know</th>
                          <th className="px-3 py-1.5 font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...v!.predictions].reverse().map((p, i) => (
                          <tr key={p.id ?? `${p.file}-${i}`} className="border-b border-border align-top last:border-b-0">
                            <td className="w-[22%] px-3 py-2">
                              <div className="font-medium">{p.title}</div>
                              <div className="text-[11.5px] text-muted">
                                {p.id ? <Mono>{p.id}</Mono> : 'no id'} · <span className="whitespace-nowrap">proposed {p.date}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2"><ItemRefs ids={p.evidenceIds} /></td>
                            <td className="w-[22%] px-3 py-2">{p.change}</td>
                            <td className="w-[24%] px-3 py-2">{p.howWeWillKnow ?? p.expected}</td>
                            <td className="px-3 py-2"><Result p={p} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <Empty title="No predictions recorded">
                  Reflections in <Mono>memory/reflections/</Mono> list each change with labelled <Mono>Change:</Mono> and <Mono>How we will know:</Mono> fields. None were found.
                </Empty>
              )}
            </section>

            <section aria-labelledby="imp-ref" className="space-y-2">
              <h2 id="imp-ref" className="font-semibold">Reflections</h2>
              {!v!.reflections.length && <Empty title="No reflections yet">Run <Mono>/reflect</Mono> after the weekly <Mono>/audit</Mono>.</Empty>}
              {v!.reflections.map((r) => (
                <details key={r.path} className="rounded-lg border border-border bg-surface px-4 py-2">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <span className="font-medium">{r.date || r.path}</span>
                    <Mono className="text-muted">{r.path}</Mono>
                    <DriftFlag f={r} />
                    {!r.parsed.ok && <span className="text-[12px] font-medium text-block">could not parse: {r.parsed.error}</span>}
                  </summary>
                  <div className="mt-2 border-t border-border pt-2">{r.text != null ? r.parsed.ok ? <Md text={r.text} /> : <Raw text={r.text} /> : <span className="text-muted">Too large to show.</span>}</div>
                </details>
              ))}
            </section>
          </>
        )}
      </div>
    </>
  )
}
