// The weekly after-the-fact reviews from /audit, newest first, rendered through the sanitiser.
import { Link, useParams } from 'react-router'
import { useAudits } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/Layout'
import { Empty, ErrorState, Loading } from '@/components/States'
import { Md } from '@/components/Markdown'
import { DriftFlag, Mono } from '@/components/vocab'

export function Audits() {
  const { date } = useParams()
  const { data, error, isPending, refetch } = useAudits()
  const current = data?.find((a) => a.date === date) ?? data?.[0]
  return (
    <>
      <PageHeader title="Audits">{data && <span className="text-[12px] text-muted tabular">{data.length} audits</span>}</PageHeader>
      <div className="p-5">
        {isPending ? (
          <Loading rows={6} label="Loading audits" />
        ) : error ? (
          <ErrorState title="Could not load audits" error={error} onRetry={() => void refetch()} />
        ) : !data!.length ? (
          <Empty title="No audits yet">
            Run <Mono>/audit</Mono> weekly. It writes <Mono>docs/factory/audits/&lt;date&gt;.md</Mono>: counts, a reading list chosen at random, patterns, and whether to change the auto-merge tier.
          </Empty>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
            <nav aria-label="Audits">
              <ul className="space-y-0.5">
                {data!.map((a) => (
                  <li key={a.path}>
                    <Link
                      data-nav-item
                      to={`/audits/${a.date}`}
                      aria-current={a === current ? 'page' : undefined}
                      className={cn('block rounded-md px-2 py-1.5 hover:bg-surface-2', a === current && 'bg-surface-2 font-medium')}
                    >
                      {a.date || a.path}
                      {a.drift !== 'same' && <span className="block text-[11.5px] text-attention">{a.drift === 'added' ? 'not committed to main' : 'differs from main'}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {current && (
              <article className="min-w-0 rounded-lg border border-border bg-surface p-5" aria-label={`Audit ${current.date}`}>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <Mono>{current.path}</Mono>
                  <DriftFlag f={current} />
                </div>
                {current.text == null ? <Empty title="Too large to show (over 512 KB)" /> : <Md text={current.text} />}
              </article>
            )}
          </div>
        )}
      </div>
    </>
  )
}
