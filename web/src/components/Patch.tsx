// A unified diff, line by line. The +/- marks carry the meaning; the tint only helps.
import { cn } from '@/lib/utils'

export function Patch({ text, title }: { text: string; title: string }) {
  const lines = text.split('\n')
  const shown = lines.slice(0, 4000)
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface font-mono text-[12px] leading-[1.5]">
      <div className="sticky left-0 border-b border-border px-3 py-1.5 text-muted">{title}</div>
      <pre>
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              'px-3 whitespace-pre',
              l.startsWith('+') && !l.startsWith('+++') && 'bg-pass-bg',
              l.startsWith('-') && !l.startsWith('---') && 'bg-fail-bg',
              l.startsWith('@@') && 'text-run',
              /^(diff|index|---|\+\+\+)/.test(l) && 'text-muted',
            )}
          >
            {l || ' '}
          </div>
        ))}
      </pre>
      {lines.length > shown.length && <div className="px-3 py-2 text-muted">Diff truncated at {shown.length} lines.</div>}
    </div>
  )
}
