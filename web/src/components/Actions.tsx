// The three changes the control room can make, each shown only when the server was started with
// --actions. Read-only, each one says how to do it yourself instead. Approval shows what you are
// approving and asks you to type the confirmation; the server re-checks everything anyway.
import { useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { Dialog } from 'radix-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, CircleX, LoaderCircle, Stamp, X } from 'lucide-react'
import { postAction, useActionLog, useApiState, useApprovePreview, useNow, type ActionLogEntry } from '@/lib/api'
import { ago, cn } from '@/lib/utils'
import { CopyCommand } from '@/pages/ControlRoom'
import { Mono, TierChip } from './vocab'

const useActionsOn = () => !!useApiState().data?.factory.actions

// Results go to a toast as well: an action usually changes the item, and the live update can
// unmount the button that started it before you read what happened.
type Toast = { id: number; ok: boolean; message: string }
let toasts: Toast[] = []
const toastSubs = new Set<() => void>()
function toast(ok: boolean, message: string) {
  const t = { id: Date.now() + Math.random(), ok, message }
  const set = (next: Toast[]) => ((toasts = next), toastSubs.forEach((f) => f()))
  set([...toasts, t].slice(-3))
  setTimeout(() => set(toasts.filter((x) => x !== t)), 12_000)
}
export function ActionToasts() {
  const list = useSyncExternalStore((f) => (toastSubs.add(f), () => void toastSubs.delete(f)), () => toasts)
  return (
    <div className="fixed right-4 bottom-4 z-[60] w-[min(420px,calc(100vw-32px))] space-y-2">
      {list.map((t) => (
        <div key={t.id} role={t.ok ? 'status' : 'alert'} className={cn('flex items-start gap-2 rounded-lg border bg-surface px-3 py-2 text-[12.5px] shadow-lg', t.ok ? 'border-pass/40' : 'border-fail/40')}>
          {t.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-pass" /> : <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-fail" />}
          <span className="min-w-0 flex-1">{t.message}</span>
          <button aria-label="Dismiss" className="rounded p-0.5 text-muted hover:text-fg" onClick={() => ((toasts = toasts.filter((x) => x !== t)), toastSubs.forEach((f) => f()))}>
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function useAction(name: 'mark-ready' | 'approve' | 'answer', after?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => postAction(name, body),
    onSuccess: (d) => (toast(true, d.message), after?.()),
    onError: (e) => toast(false, e.message),
    onSettled: () => void qc.invalidateQueries(),
  })
}

/** Errors stay next to the form so you can correct and retry; success is in the toast. */
function Outcome({ m }: { m: ReturnType<typeof useAction> }) {
  if (m.isError)
    return (
      <p role="alert" className="inline-flex items-center gap-1 text-[12.5px] text-fail">
        <CircleX aria-hidden className="size-3.5" /> {m.error.message}
      </p>
    )
  return null
}

const button = 'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-50'
const primary = cn(button, 'bg-fg text-bg hover:opacity-90')
const secondary = cn(button, 'border border-border bg-surface hover:border-border-strong')

// ---------- mark ready ----------

export function MarkReady({ issue }: { issue: number }) {
  const on = useActionsOn()
  const [asking, setAsking] = useState(false)
  const m = useAction('mark-ready')
  if (!on) return <CopyCommand cmd={`gh issue edit ${issue} --add-label factory:ready`} />
  if (m.isSuccess) return null
  return asking ? (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>
        Add <Mono>factory:ready</Mono> to issue #{issue}?
      </span>
      <button className={primary} disabled={m.isPending} onClick={() => m.mutate({ issue })}>
        {m.isPending && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />} Mark ready
      </button>
      <button className={secondary} onClick={() => setAsking(false)}>
        Cancel
      </button>
      <Outcome m={m} />
    </span>
  ) : (
    <button className={secondary} onClick={() => setAsking(true)}>
      Mark ready…
    </button>
  )
}

// ---------- answer a blocked question ----------

export function AnswerForm({ issue, id }: { issue: number; id: string }) {
  const on = useActionsOn()
  const [text, setText] = useState('')
  const m = useAction('answer')
  if (!on) return null
  if (m.isSuccess)
    return (
      <p className="mt-3 text-[12.5px]">
        Answer posted on issue #{issue}. Next: <CopyCommand cmd={`/work ${id}`} />
      </p>
    )
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        m.mutate({ issue, body: text })
      }}
    >
      <label htmlFor={`answer-${issue}`} className="text-[12px] font-medium">
        Your answer, posted as a comment on issue #{issue}
      </label>
      <textarea id={`answer-${issue}`} value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={20000} className="block w-full rounded-md border border-border bg-surface px-2.5 py-2 text-[13px]" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primary} disabled={!text.trim() || m.isPending}>
          {m.isPending && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />} Post answer
        </button>
        <span className="text-[12px] text-muted">The factory does not continue on its own: run /work {id} after.</span>
      </div>
      <Outcome m={m} />
    </form>
  )
}

// ---------- approve an R2 pull request ----------

export function ApproveAction({ pr }: { pr: number }) {
  const on = useActionsOn()
  const [open, setOpen] = useState(false)
  if (!on)
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        Read the Changes and Review tabs, then on GitHub: <CopyCommand cmd={`gh pr edit ${pr} --add-label human-approved`} />
      </span>
    )
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className={primary}>
        <Stamp aria-hidden className="size-3.5" /> Review and approve…
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed top-[8vh] left-1/2 z-50 max-h-[84vh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-xl focus:outline-none">
          {open && <ApproveBody pr={pr} onDone={() => setOpen(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ApproveBody({ pr, onDone }: { pr: number; onDone: () => void }) {
  const p = useApprovePreview(pr, true)
  const [typed, setTyped] = useState('')
  const m = useAction('approve', onDone)
  const d = p.data
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <Dialog.Title className="text-[15px] font-semibold">Approve pull request #{pr}</Dialog.Title>
          <Dialog.Description className="text-[12.5px] text-muted">
            Adds the <Mono>human-approved</Mono> label: you have read this diff. Merging still needs CI to pass.
          </Dialog.Description>
        </div>
        <Dialog.Close className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
          <X aria-hidden className="size-4" />
        </Dialog.Close>
      </div>
      {p.isPending ? (
        <p className="text-muted">Loading what you are approving…</p>
      ) : p.error || !d ? (
        <p role="alert" className="text-fail">{p.error?.message ?? 'Could not load the pull request.'}</p>
      ) : (
        <>
          <div className="font-medium">
            {d.title} {d.item && <Link to={`/items/${d.item.id}`} className="text-[12.5px] font-normal text-run hover:underline">#{d.item.id}</Link>}
          </div>
          <section aria-label="Risk tier" className="space-y-1">
            <h3 className="text-[12px] font-semibold text-muted">Why it is {d.tier ?? 'unclassified'}</h3>
            {d.sources.map((s, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[12.5px]">
                <TierChip tier={s.tier} />
                <span className="w-20 text-muted">{s.source}</span>
                <span>{s.why ?? ''}</span>
              </div>
            ))}
          </section>
          <section aria-label="Paths that need you" className="space-y-1">
            <h3 className="text-[12px] font-semibold text-muted">Paths at R2 or above ({d.r2Files.length} of {d.files} files)</h3>
            {d.r2Files.length ? (
              <ul className="text-[12.5px]">
                {d.r2Files.map((f) => (
                  <li key={f.path} className="flex items-baseline gap-2">
                    <TierChip tier={f.tier} /> <Mono>{f.path}</Mono> <span className="text-muted">matched <Mono>{f.pattern}</Mono></span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-muted">None: the tier comes from the spec, the reviewer or a label, not from paths.</p>
            )}
          </section>
          <section aria-label="Review" className="text-[12.5px]">
            <h3 className="text-[12px] font-semibold text-muted">Review</h3>
            {!d.review ? (
              <p className="text-block">No reviewer ran on this pull request. You are the only review.</p>
            ) : 'error' in d.review ? (
              <p className="text-block">review.md could not be parsed: {d.review.error}</p>
            ) : (
              <p>
                Verdict <Mono>{d.review.verdict}</Mono> · {d.review.blocking} blocking · {d.review.nonBlocking} non-blocking findings
              </p>
            )}
            {d.notVerified ? (
              <p className="text-block">
                {d.notVerified} {d.notVerified === 1 ? 'thing' : 'things'} nobody verified. {d.item && <Link to={`/items/${d.item.id}/not-verified`} className="underline">Read them</Link>}
              </p>
            ) : null}
            {d.checks.length > 0 && (
              <p className="text-muted">
                Checks: {d.checks.map((c) => (c.name === 'risk-gate' && /fail/i.test(c.conclusion) ? 'risk-gate failing until you approve (CI re-runs it on the label)' : `${c.name} ${c.conclusion.toLowerCase()}`)).join(' · ')}
              </p>
            )}
          </section>
          {!d.ok ? (
            <p role="alert" className="rounded-md bg-block-bg px-3 py-2 text-[12.5px]">{d.message}</p>
          ) : (
            <form
              className="space-y-2 border-t border-border pt-3"
              onSubmit={(e) => {
                e.preventDefault()
                m.mutate({ pr, headSha: d.headSha, confirm: typed })
              }}
            >
              <label htmlFor="approve-confirm" className="block text-[12.5px]">
                You are approving the head commit <Mono>{d.headSha.slice(0, 8)}</Mono>. If new commits arrive first, the approval is refused. Type <Mono className="font-semibold">{d.confirm}</Mono> to confirm.
              </label>
              <input id="approve-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="h-8 w-full rounded-md border border-border bg-surface px-2 font-mono text-[12.5px]" />
              <div className="flex items-center gap-2">
                <button type="submit" className={primary} disabled={typed.trim() !== d.confirm || m.isPending}>
                  {m.isPending && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />} Approve #{pr}
                </button>
                <Dialog.Close className={secondary}>Cancel</Dialog.Close>
              </div>
              <Outcome m={m} />
            </form>
          )}
        </>
      )}
    </div>
  )
}

// ---------- what was done from here ----------

const VERB: Record<string, string> = { 'mark-ready': 'marked ready', approve: 'approved', answer: 'answered' }

/** Recent actions on one item, from the local action log. */
export function ActionTrail({ issue, pr }: { issue?: number; pr?: number }) {
  const { data } = useActionLog()
  const now = useNow()
  const mine = (data ?? []).filter((e: ActionLogEntry) => (issue && e.input?.issue === issue) || (pr && e.input?.pr === pr)).slice(0, 3)
  if (!mine.length) return null
  return (
    <ul aria-label="Actions taken from the control room" className="mt-2 space-y-0.5 text-[12px] text-muted">
      {mine.map((e) => (
        <li key={e.at + e.action}>
          <span className={e.outcome === 'done' ? 'text-pass' : 'text-fail'}>{e.outcome === 'done' ? `You ${VERB[e.action] ?? e.action}` : `${VERB[e.action] ?? e.action}: ${e.outcome}`}</span> · {ago(e.at, now)} ago · {e.message}
        </li>
      ))}
    </ul>
  )
}
