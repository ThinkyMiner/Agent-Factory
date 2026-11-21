// The factory's configuration, read-only: policy, risk rules (with a "classify a path" box), agents,
// skills, hooks and permissions, and every file, each flagged where it differs from main. CI and new
// /work runs use main's copy, so a local edit is something to know about, not something in force.
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { FileDiff } from 'lucide-react'
import { classifyFile, parseRiskRules } from '../../../server/core/risk.ts'
import { useFactoryConfig, useFactoryFile, type FactoryView, type Tier } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { Md, Raw } from '@/components/Markdown'
import { Patch } from '@/components/Patch'
import { DriftFlag, Mono, TierChip } from '@/components/vocab'

function Card({ title, id, children, aside }: { title: string; id: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="fig">
      <div className="fig-cap">
        <h2 id={id} className="fig-title">{title}</h2>
        {aside}
      </div>
      <div className="panel p-4">{children}</div>
    </section>
  )
}

const POLICY: Record<string, string> = {
  none: 'Every pull request waits for you.',
  R0: 'R0 pull requests (docs, copy, work records) merge on their own once CI is green.',
  R1: 'R0 and R1 pull requests merge on their own once CI is green.',
}

/** What each setting changes, in one line. A key the control room does not know shows the comment above it in the file. */
function meaning(key: string, value: string, comment: string): string {
  if (key === 'AUTO_MERGE_MAX_TIER') return `${POLICY[value] ?? `Pull requests up to ${value} merge on their own once CI is green.`} R2 always needs the human-approved label; R3 is never done by the factory.`
  if (key === 'RIGOR')
    return value === 'mvp'
      ? 'Team mode, first version: one discussion round, one draft, no specialist review round; at most 15 acceptance criteria; build items start at dispatch and the e2e tests come at integration.'
      : 'Team mode, full ceremony: a specialist review round, up to 2 discussion rounds and 3 drafts; criteria get an evidence review; build items wait for the e2e tests. (Anything but "mvp" means full.)'
  return comment.split('\n')[0]?.trim() || 'Not a setting the control room knows, and the file says nothing above it.'
}

function Policy({ v }: { v: FactoryView }) {
  const p = v.policy
  const show = (r: NonNullable<NonNullable<FactoryView['policy']>['main']>) =>
    r.ok ? (
      <dl className="space-y-2">
        {r.value.settings.map((s) => (
          <div key={s.key}>
            <dt><Mono className="text-[13px]">{s.key}={s.value}</Mono></dt>
            <dd className="mt-0.5 text-muted">{meaning(s.key, s.value, s.comment)}</dd>
          </div>
        ))}
      </dl>
    ) : (
      <div>
        <div className="font-medium text-fail">Could not read the policy: {r.error}</div>
        <Raw text={r.raw} className="mt-1" />
      </div>
    )
  return (
    <Card title="Factory policy" id="f-policy" aside={<><Mono className="text-muted">factory/policy.env</Mono><DriftFlag f={p} /></>}>
      {!p ? <Empty title="No factory/policy.env">Without it, every pull request waits for you.</Empty> : p.main ? show(p.main) : <span className="text-muted">Not on main.</span>}
      {p?.worktree && (
        <div className="mt-3 rounded-md border border-attention/40 bg-attention-bg px-3 py-2">
          <div className="text-[12px] font-medium text-attention">Your working tree says (not in force until merged):</div>
          {show(p.worktree)}
        </div>
      )}
    </Card>
  )
}

function Rules({ v }: { v: FactoryView }) {
  const r = v.rules
  const main = useMemo(() => parseRiskRules(r?.main ?? ''), [r?.main])
  const local = useMemo(() => (r?.worktree != null ? parseRiskRules(r.worktree) : null), [r?.worktree])
  const [path, setPath] = useState('')
  const key = (x: { tier: number; pattern: string }) => `R${x.tier} ${x.pattern}`
  const added = local?.filter((x) => !main.some((m) => key(m) === key(x))) ?? []
  const removed = local ? main.filter((m) => !local.some((x) => key(x) === key(m))) : []
  const result = (rules: typeof main, label: string) => {
    const f = classifyFile(path.trim().replace(/^\.?\//, ''), rules)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-[12px] text-muted">{label}</span>
        <TierChip tier={f.tier as Tier} />
        <span className="text-[12.5px]">{f.pattern ? <>matched <Mono>{f.pattern}</Mono></> : 'no rule matched: R1 by default'}</span>
      </div>
    )
  }
  return (
    <Card title="Risk rules" id="f-rules" aside={<><Mono className="text-muted">factory/risk-rules.txt</Mono><DriftFlag f={r} /></>}>
      {!r ? (
        <Empty title="No factory/risk-rules.txt">Every path classifies as R1.</Empty>
      ) : (
        <div className="space-y-3">
          <p className="text-muted">For each changed file the highest matching tier wins; a file that matches nothing is R1. CI reads these from main, so a pull request cannot relax its own gate.</p>
          <div>
            <label htmlFor="classify" className="text-[12px] font-medium">Classify a path</label>
            <input id="classify" value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/auth/session.ts" spellCheck={false} className="mt-1 h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-[12.5px]" />
            {path.trim() && (
              <div className="mt-2 space-y-1" aria-live="polite">
                {result(main, local ? 'main (CI uses)' : 'tier')}
                {local && result(local, 'working tree')}
              </div>
            )}
          </div>
          {(added.length > 0 || removed.length > 0) && (
            <div className="rounded-md border border-attention/40 bg-attention-bg px-3 py-2 text-[12.5px]">
              <div className="font-medium text-attention">Rules in your working tree that CI does not use yet</div>
              {added.map((x) => <div key={`+${key(x)}`}><Mono>+ {key(x)}</Mono></div>)}
              {removed.map((x) => <div key={`-${key(x)}`}><Mono>− {key(x)}</Mono></div>)}
            </div>
          )}
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11.5px] text-muted">
              <tr className="border-b border-border">
                <th className="py-1 pr-3 font-medium">Tier</th>
                <th className="py-1 font-medium">Pattern (main)</th>
              </tr>
            </thead>
            <tbody>
              {main.map((x, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  <td className="py-1 pr-3"><TierChip tier={`R${Math.min(x.tier, 3)}` as Tier} /></td>
                  <td className="py-1"><Mono>{x.pattern}</Mono></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function Agents({ v }: { v: FactoryView }) {
  return (
    <Card title="Agents" id="f-agents" aside={<Mono className="text-muted">.claude/agents/</Mono>}>
      {!v.agents.length ? (
        <Empty title="No agents defined" />
      ) : (
        <ul className="divide-y divide-border">
          {v.agents.map((a) => (
            <li key={a.path} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Mono className="font-semibold">{a.name}</Mono>
                {a.model ? <Mono className="rounded bg-surface-2 px-1 text-muted">model: {a.model}</Mono> : <span className="text-[12px] text-muted">model: inherits the session's</span>}
                <DriftFlag f={a} />
              </div>
              {a.description && <p className="mt-0.5 text-muted">{a.description}</p>}
              <div className="mt-1 text-[12px]">
                {a.tools?.length ? <>Tools: <Mono>{a.tools.join(', ')}</Mono></> : <span className="text-muted">Tools: all the session has (none listed)</span>}
              </div>
              {a.error && <div className="text-[12px] text-block">Front matter: {a.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Skills({ v }: { v: FactoryView }) {
  return (
    <Card title="Skills" id="f-skills" aside={<Mono className="text-muted">.claude/skills/</Mono>}>
      {!v.skills.length ? (
        <Empty title="No skills defined" />
      ) : (
        <ul className="divide-y divide-border">
          {v.skills.map((k) => (
            <li key={k.path} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Mono className="font-semibold">/{k.name}</Mono>
                {k.argumentHint && <Mono className="text-muted">{k.argumentHint}</Mono>}
                {k.manualOnly && <span className="rounded border border-border px-1 text-[11.5px] text-muted">you invoke it; agents cannot</span>}
                <DriftFlag f={k} />
              </div>
              {k.description && <p className="mt-0.5 text-muted">{k.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Settings({ v }: { v: FactoryView }) {
  if (!v.settings.length) return <Card title="Hooks and permissions" id="f-settings"><Empty title="No .claude/settings.json">Without it there is no guard hook and no telemetry.</Empty></Card>
  return (
    <>
      {v.settings.map((s) => (
        <Card key={s.path} title={s.path.endsWith('local.json') ? 'Local hooks and permissions' : 'Hooks and permissions'} id={`f-${s.path}`} aside={<><Mono className="text-muted">{s.path}</Mono><DriftFlag f={s} /></>}>
          {!s.ok ? (
            <div>
              <div className="font-medium text-fail">Could not read {s.path}: {s.error}</div>
              <Raw text={s.raw} className="mt-1" />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <h3 className="mb-1 text-[12px] font-semibold text-muted">Hooks</h3>
                {s.hooks.length ? (
                  <table className="w-full text-left text-[12.5px]">
                    <tbody>
                      {s.hooks.map((h, i) => (
                        <tr key={i} className="border-b border-border align-top last:border-b-0">
                          <td className="py-1 pr-3 whitespace-nowrap"><Mono>{h.event}</Mono></td>
                          <td className="py-1 pr-3 text-muted">{h.matcher ? <Mono>{h.matcher}</Mono> : 'every'}</td>
                          <td className="py-1 break-all">{h.commands.map((c) => <Mono key={c} className="block">{c}</Mono>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <span className="text-muted">None.</span>
                )}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {(['allow', 'deny', 'ask'] as const).filter((k) => k !== 'ask' || s.ask.length).map((k) => (
                  <div key={k}>
                    <h3 className="mb-1 text-[12px] font-semibold text-muted">{k === 'allow' ? 'Allowed without asking' : k === 'deny' ? 'Denied' : 'Always asks'}</h3>
                    {s[k].length ? <ul>{s[k].map((p) => <li key={p}><Mono>{p}</Mono></li>)}</ul> : <span className="text-muted">None.</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      ))}
    </>
  )
}

function Files({ v }: { v: FactoryView }) {
  const [params, setParams] = useSearchParams()
  const selected = params.get('file')
  const file = useFactoryFile(selected)
  return (
    <Card title="Files" id="f-files" aside={<span className="text-[12px] text-muted">{v.files.length} files</span>}>
      <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_2fr]">
        <ul className="max-h-[70vh] overflow-y-auto rounded-md border border-border" aria-label="Factory files">
          {v.files.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => setParams((p) => (p.set('file', f.path), p), { replace: true })}
                aria-current={selected === f.path ? 'true' : undefined}
                className={cn('flex w-full items-center gap-1.5 border-b border-border px-2 py-1 text-left last:border-b-0 hover:bg-surface-2', selected === f.path && 'bg-surface-2')}
              >
                <Mono className="min-w-0 flex-1 truncate">{f.path}</Mono>
                {f.drift !== 'same' && <FileDiff aria-label={`${f.drift}, differs from main`} className="size-3.5 shrink-0 text-attention" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0">
          {!selected ? (
            <Empty title="Pick a file">Files that differ from main carry a mark.</Empty>
          ) : file.isPending ? (
            <Loading rows={8} label="Loading file" />
          ) : file.error ? (
            <ErrorState title={`Could not load ${selected}`} error={file.error} />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Mono className="font-semibold">{file.data!.path}</Mono>
                <DriftFlag f={file.data} />
              </div>
              {file.data!.diff && <Patch text={file.data!.diff} title={`${file.data!.path} — changes against main`} />}
              {file.data!.text == null ? (
                <Empty title="Too large to show (over 512 KB)" />
              ) : file.data!.path.endsWith('.md') ? (
                <div className="rounded-md border border-border p-3"><Md text={file.data!.text} /></div>
              ) : (
                <Raw text={file.data!.text} />
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

export function FactoryConfig() {
  const { data: v, error, isPending, refetch } = useFactoryConfig()
  const drifted = v?.files.filter((f) => f.drift !== 'same') ?? []
  const [, setParams] = useSearchParams()
  return (
    <>
      <PageHeader title="Factory">
        <span className="text-[12px] text-muted">Read-only. Change these through a pull request.</span>
      </PageHeader>
      <div className="space-y-4 p-5">
        {isPending ? (
          <Loading rows={8} label="Loading factory configuration" />
        ) : error ? (
          <ErrorState title="Could not load the factory configuration" error={error} onRetry={() => void refetch()} />
        ) : !v!.files.length ? (
          <Empty title="No factory files found">Expected <Mono>CLAUDE.md</Mono>, <Mono>.claude/</Mono> and <Mono>factory/</Mono> from the factory-starter kit.</Empty>
        ) : (
          <>
            {drifted.length > 0 && (
              <section role="status" aria-label="Differences from main" className="rounded-lg border border-attention/40 bg-attention-bg px-4 py-3">
                <div className="flex items-center gap-1.5 font-medium">
                  <FileDiff aria-hidden className="size-4 text-attention" />
                  {drifted.length} {drifted.length === 1 ? 'file differs' : 'files differ'} from main. CI and new <Mono>/work</Mono> runs use main's copy.
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {drifted.map((f) => (
                    <li key={f.path} className="flex flex-wrap items-center gap-2">
                      <button onClick={() => setParams((p) => (p.set('file', f.path), p), { replace: true })} className="hover:underline">
                        <Mono>{f.path}</Mono>
                      </button>
                      <DriftFlag f={f} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-4">
                <Policy v={v!} />
                <Rules v={v!} />
              </div>
              <div className="space-y-4">
                <Agents v={v!} />
                <Skills v={v!} />
              </div>
            </div>
            <Settings v={v!} />
            <Files v={v!} />
          </>
        )}
      </div>
    </>
  )
}
