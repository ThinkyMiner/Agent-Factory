// Designed empty, loading, stale and error states, shared by every view.
import type { ReactNode } from 'react'
import { CloudOff, RefreshCw, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Empty({ title, children, icon, className }: { title: string; children?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-dashed border-border px-5 py-6 text-muted', className)}>
      <div className="flex items-center gap-2 font-medium text-fg">
        {icon}
        {title}
      </div>
      {children && <div className="mt-1.5 max-w-prose">{children}</div>}
    </div>
  )
}

export function Loading({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-surface-2" style={{ opacity: 1 - i * 0.15 }} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  )
}

export function ErrorState({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-fail/40 bg-fail-bg px-4 py-3">
      <div className="flex items-center gap-2 font-medium text-fail">
        <TriangleAlert aria-hidden className="size-4" />
        {title}
      </div>
      <div className="mt-1 text-muted">{error instanceof Error ? error.message : String(error)}</div>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2">
          <RefreshCw aria-hidden className="size-3.5" /> Retry
        </button>
      )}
    </div>
  )
}

export function Banner({ tone, icon, children }: { tone: 'stale' | 'error' | 'info'; icon?: ReactNode; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 border-b px-5 py-2 text-[12.5px]',
        tone === 'stale' && 'border-block/30 bg-block-bg text-fg',
        tone === 'error' && 'border-fail/30 bg-fail-bg text-fg',
        tone === 'info' && 'border-border bg-surface-2 text-fg',
      )}
    >
      {icon ?? <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0 text-block" />}
      <div>{children}</div>
    </div>
  )
}

export function Section({ title, count, children, actions, id, className }: { title: ReactNode; count?: number; children: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn('mt-6 first:mt-0', className)}>
      <div className="mb-2 flex items-center gap-2">
        <h2 id={id} className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">
          {title}
          {count !== undefined && <span className="ml-1.5 tabular text-faint">{count}</span>}
        </h2>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>
      {children}
    </section>
  )
}
