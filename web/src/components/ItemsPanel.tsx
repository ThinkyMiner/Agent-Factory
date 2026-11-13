// A side panel listing the items behind a number: every Quality value opens one.
import { Link } from 'react-router'
import { Dialog } from 'radix-ui'
import { ExternalLink, X } from 'lucide-react'
import { useApiState } from '@/lib/api'
import { ItemId, Mono, StateBadge, TierChip } from './vocab'

export interface Drill {
  title: string
  subtitle?: string
  ids: string[] // item ids, or "issue:<n>"
  values?: Record<string, string> // what each item contributed, already formatted
}

export function ItemsPanel({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  const { data } = useApiState()
  const byId = new Map(data?.items.map((i) => [i.id, i]))
  // an item can appear more than once (two fix rounds in one week): list it once, with a count
  const counts = new Map<string, number>()
  for (const id of drill?.ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  const repo = data?.github.repo

  return (
    <Dialog.Root open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(460px,100vw)] flex-col border-l border-border bg-surface shadow-xl focus:outline-none">
          <div className="flex items-start gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-[14px] font-semibold">{drill?.title}</Dialog.Title>
              <Dialog.Description className="text-[12px] text-muted">
                {drill?.subtitle ? `${drill.subtitle} · ` : ''}
                {counts.size} {counts.size === 1 ? 'item' : 'items'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>
          <ul className="flex-1 overflow-y-auto">
            {[...counts].map(([id, n]) => {
              const issue = /^issue:(\d+)$/.exec(id)?.[1]
              const item = byId.get(id)
              return (
                <li key={id} className="flex items-baseline gap-2 border-b border-border px-5 py-2">
                  {issue ? (
                    repo ? (
                      <a href={`https://github.com/${repo}/issues/${issue}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:underline">
                        <Mono className="text-muted">issue #{issue}</Mono>
                        <ExternalLink aria-label="opens GitHub" className="size-3 text-muted" />
                      </a>
                    ) : (
                      <Mono className="text-muted">issue #{issue}</Mono>
                    )
                  ) : (
                    <ItemId id={id} />
                  )}
                  <span className="min-w-0 flex-1">
                    {item ? (
                      <Link to={`/items/${id}`} className="hover:underline">
                        {item.title}
                      </Link>
                    ) : (
                      <span className="text-muted">{issue ? 'Issue labelled escaped-defect' : 'Not found in this factory'}</span>
                    )}
                    {drill?.values?.[id] && <span className="block text-[12px] text-muted">{drill.values[id]}</span>}
                  </span>
                  {n > 1 && <span className="text-[12px] text-muted tabular">×{n}</span>}
                  {item && <TierChip tier={item.tier} />}
                  {item && <StateBadge state={item.state} />}
                </li>
              )
            })}
            {!counts.size && <li className="px-5 py-6 text-muted">No items behind this number.</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Evidence links: each id goes to its item; an id the factory does not know is shown as such. */
export function ItemRefs({ ids }: { ids: string[] }) {
  const { data } = useApiState()
  if (!ids.length) return <span className="text-[12px] text-block">no evidence ids</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => {
        const item = data?.items.find((i) => i.id === id)
        return item ? (
          <Link key={id} to={`/items/${id}`} title={item.title} className="rounded border border-border bg-surface-2 px-1 font-mono text-[11.5px] hover:border-border-strong hover:underline">
            #{id}
          </Link>
        ) : (
          <span key={id} title="No work item with this id in this factory" className="rounded border border-dashed border-border px-1 font-mono text-[11.5px] text-muted">
            #{id} not found
          </span>
        )
      })}
    </span>
  )
}
