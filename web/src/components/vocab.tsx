// The one vocabulary for stage, status, state, tier and "needs you". Every screen uses these,
// so a status always looks the same, and colour is never the only signal (glyph + word).
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequest,
  Hand,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestion,
  OctagonX,
  Stamp,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NeedsKind, Stage, State, StageView, Tier } from '@/lib/api'

type Tone = 'pass' | 'fail' | 'block' | 'run' | 'wait' | 'muted' | 'attention'
const TONE_TEXT: Record<Tone, string> = {
  pass: 'text-pass',
  fail: 'text-fail',
  block: 'text-block',
  run: 'text-run',
  wait: 'text-wait',
  muted: 'text-muted',
  attention: 'text-attention',
}
const TONE_BG: Record<Tone, string> = {
  pass: 'bg-pass-bg',
  fail: 'bg-fail-bg',
  block: 'bg-block-bg',
  run: 'bg-run-bg',
  wait: 'bg-wait-bg',
  muted: 'bg-surface-2',
  attention: 'bg-attention-bg',
}
export const TONE_BORDER: Record<Tone, string> = {
  pass: 'border-l-pass',
  fail: 'border-l-fail',
  block: 'border-l-block',
  run: 'border-l-run',
  wait: 'border-l-wait',
  muted: 'border-l-border-strong',
  attention: 'border-l-attention',
}

// ---- stage status ----
export const STATUS: Record<StageView['status'], { label: string; icon: LucideIcon; tone: Tone }> = {
  pending: { label: 'not reached', icon: Circle, tone: 'muted' },
  running: { label: 'running', icon: LoaderCircle, tone: 'run' },
  passed: { label: 'passed', icon: CircleCheck, tone: 'pass' },
  failed: { label: 'failed', icon: CircleX, tone: 'fail' },
  blocked: { label: 'blocked', icon: TriangleAlert, tone: 'block' },
  skipped: { label: 'skipped', icon: CircleMinus, tone: 'muted' },
}

export function StatusGlyph({ status, className }: { status: StageView['status']; className?: string }) {
  const s = STATUS[status]
  return <s.icon aria-hidden className={cn('size-3.5 shrink-0', TONE_TEXT[s.tone], status === 'running' && 'animate-spin [animation-duration:2.5s]', className)} />
}
export function Status({ status }: { status: StageView['status'] }) {
  const s = STATUS[status]
  return (
    <span className={cn('inline-flex items-center gap-1', TONE_TEXT[s.tone])}>
      <StatusGlyph status={status} />
      {s.label}
    </span>
  )
}

/** "build r1 · running": stage in monospace-free lowercase, the vocabulary from the pipeline. */
export function StageLabel({ stage, round, status }: { stage?: Stage; round?: number; status?: StageView['status'] }) {
  if (!stage) return <span className="text-faint">—</span>
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {status && <StatusGlyph status={status} />}
      <span>{stage}</span>
      {!!round && <span className="text-muted tabular">r{round}</span>}
    </span>
  )
}

// ---- item state ----
export const STATE: Record<State, { label: string; icon: LucideIcon; tone: Tone }> = {
  proposed: { label: 'Proposed', icon: CircleDashed, tone: 'muted' },
  ready: { label: 'Ready', icon: CircleDot, tone: 'muted' },
  'in-progress': { label: 'In progress', icon: LoaderCircle, tone: 'run' },
  'pr-open': { label: 'PR open', icon: GitPullRequest, tone: 'run' },
  'awaiting-approval': { label: 'Awaiting approval', icon: Stamp, tone: 'wait' },
  'awaiting-merge': { label: 'Awaiting merge', icon: GitMerge, tone: 'wait' },
  blocked: { label: 'Blocked', icon: TriangleAlert, tone: 'block' },
  failed: { label: 'Failed', icon: OctagonX, tone: 'fail' },
  closed: { label: 'Closed', icon: CircleSlash, tone: 'muted' },
  merged: { label: 'Merged', icon: CircleCheck, tone: 'pass' },
}
export function StateBadge({ state, className }: { state: State; className?: string }) {
  const s = STATE[state]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap', TONE_BG[s.tone], TONE_TEXT[s.tone], className)}>
      <s.icon aria-hidden className="size-3.5" />
      {s.label}
    </span>
  )
}

// ---- needs you ----
export const NEEDS: Record<NeedsKind, { label: string; verb: string; icon: LucideIcon; tone: Tone }> = {
  answer: { label: 'Answer', verb: 'Answer the question', icon: MessageCircleQuestion, tone: 'block' },
  approve: { label: 'Approve', verb: 'Read and approve', icon: Stamp, tone: 'wait' },
  failed: { label: 'Failed', verb: 'Look at the failure', icon: OctagonX, tone: 'fail' },
  'waiting-input': { label: 'Waiting', verb: 'Claude Code is waiting for you', icon: Hand, tone: 'run' },
  quiet: { label: 'Quiet', verb: 'Check the run', icon: Hourglass, tone: 'muted' },
  merge: { label: 'Merge', verb: 'Merge the pull request', icon: GitMerge, tone: 'pass' },
}
export function NeedsTag({ kind, className }: { kind: NeedsKind; className?: string }) {
  const n = NEEDS[kind]
  return (
    <span className={cn('inline-flex items-center gap-1 font-medium whitespace-nowrap', TONE_TEXT[n.tone], className)}>
      <n.icon aria-hidden className="size-4" />
      {n.label}
    </span>
  )
}
export const needsTone = (k: NeedsKind) => NEEDS[k].tone

// ---- risk tier: a square, outlined, monospace chip; never coloured like a status ----
const TIER_HINT: Record<Tier, string> = {
  R0: 'R0: cannot break the product (docs, copy, records)',
  R1: 'R1: ordinary change inside existing boundaries',
  R2: 'R2: a human reads and approves the diff',
  R3: 'R3: the factory does not make these',
}
export function TierChip({ tier, className }: { tier?: Tier; className?: string }) {
  if (!tier) return null // not assessed yet (no spec, PR or path classification)
  return (
    <span
      title={`Risk tier ${TIER_HINT[tier]}`}
      aria-label={`risk tier ${tier}`}
      className={cn(
        'inline-flex h-[18px] items-center rounded-[3px] px-1 font-mono text-[11px] leading-none font-semibold tabular',
        tier === 'R0' && 'border border-dashed border-border-strong text-muted',
        tier === 'R1' && 'border border-border-strong text-fg',
        tier === 'R2' && 'border-2 border-fg text-fg',
        tier === 'R3' && 'border-2 border-fg bg-fg text-bg',
        className,
      )}
    >
      {tier}
    </span>
  )
}

// ---- small bits ----
export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn('font-mono text-[12px]', className)}>{children}</span>

export function ItemId({ id, link = true, className }: { id: string; link?: boolean; className?: string }) {
  const body = <Mono className={cn('text-muted', className)}>#{id}</Mono>
  return link ? (
    <Link to={`/items/${id}`} className="hover:underline">
      {body}
    </Link>
  ) : (
    body
  )
}

export function LiveDot({ label = 'agent active' }: { label?: string }) {
  return (
    <span className="relative inline-flex size-2" role="img" aria-label={label} title={label}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-run opacity-60 [animation-duration:2s]" />
      <span className="relative inline-flex size-2 rounded-full bg-run" />
    </span>
  )
}

/** Eight segments, one per stage: glyph, name, rounds. */
export function StageDots({ stages }: { stages: { stage: Stage; status: StageView['status']; rounds: number }[] }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={stages.map((s) => `${s.stage} ${STATUS[s.status].label}`).join(', ')} role="img">
      {stages.map((s) => (
        <span key={s.stage} title={`${s.stage}: ${STATUS[s.status].label}${s.rounds ? `, ${s.rounds} fix rounds` : ''}`}>
          <StatusGlyph status={s.status} className="size-3" />
        </span>
      ))}
    </span>
  )
}
