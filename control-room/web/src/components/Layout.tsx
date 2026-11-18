import { Suspense } from 'react'
import { NavLink, Outlet } from 'react-router'
import { Activity, Brain, ChartColumn, ClipboardCheck, Cloud, CloudOff, Cog, Columns3, LayoutDashboard, Monitor, Moon, Sprout, Sun, Users, WifiOff } from 'lucide-react'
import { useApiState, useLiveUpdates, useNow } from '@/lib/api'
import { ago, cn } from '@/lib/utils'
import { Banner, Loading } from './States'
import { setTheme, useTheme, type Theme } from '@/lib/theme'
import { ActionToasts } from './Actions'
import { KeyboardLayer, PaletteButton } from './Keyboard'

export const NAV = [
  { to: '/', label: 'Control room', icon: LayoutDashboard, key: 'r' },
  { to: '/board', label: 'Board', icon: Columns3, key: 'b' },
  { to: '/runs', label: 'Runs', icon: Activity, key: 'u' },
  { to: '/quality', label: 'Quality', icon: ChartColumn, key: 'q' },
  { to: '/memory', label: 'Memory', icon: Brain, key: 'm' },
  { to: '/improvement', label: 'Improvement', icon: Sprout, key: 'i' },
  { to: '/factory', label: 'Factory', icon: Cog, key: 'f' },
  { to: '/audits', label: 'Audits', icon: ClipboardCheck, key: 'a' },
  { to: '/planning', label: 'Planning', icon: Users, key: 'p' }, // team mode only
]

const THEMES: { t: Theme; label: string; icon: typeof Sun }[] = [
  { t: 'light', label: 'Light', icon: Sun },
  { t: 'dark', label: 'Dark', icon: Moon },
  { t: 'system', label: 'Match the system', icon: Monitor },
]

/** Light, dark or follow the system: three visible choices, the current one filled. */
function ThemeToggle() {
  const theme = useTheme()
  return (
    <div role="group" aria-label="Theme" className="inline-flex border border-border">
      {THEMES.map(({ t, label, icon: Icon }) => (
        <button
          key={t}
          onClick={() => setTheme(t)}
          aria-pressed={theme === t}
          aria-label={label}
          title={`Theme: ${label.toLowerCase()}`}
          className={cn('grid size-7 place-items-center border-r border-border text-muted last:border-r-0 hover:text-fg', theme === t && 'bg-accent text-white hover:text-white')}
        >
          <Icon aria-hidden className="size-3.5" />
        </button>
      ))}
    </div>
  )
}

export function Layout() {
  const connected = useLiveUpdates()
  const { data } = useApiState()
  const now = useNow()
  const repoName = data?.factory.demo ? 'tally' : data?.factory.repo.split('/').filter(Boolean).at(-1)
  const gh = data?.github
  const needs = data?.needsYou.length ?? 0

  return (
    <div className="flex h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <header className="shrink-0 border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-6 px-5">
          <div className="flex h-14 items-center gap-2.5">
            <span aria-hidden className="grid size-6 place-items-center bg-fg">
              <span className="size-2 bg-accent" />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="font-mono text-[14px]">control room</div>
              <div className="truncate font-mono text-[11px] text-muted" title={data?.factory.repo}>
                {repoName ?? '…'}
                {data?.factory.demo && <span className="ml-1.5 bg-lime px-1 text-[10px] tracking-wider text-lime-fg uppercase">demo</span>}
              </div>
            </div>
          </div>
          <nav aria-label="Screens" className="order-last -mx-5 flex w-[calc(100%+40px)] overflow-x-auto border-t border-border px-3 xl:order-none xl:mx-0 xl:w-auto xl:border-t-0 xl:px-0">
            {NAV.filter((n) => n.to !== '/planning' || data?.factory.teams).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                title={`${n.label} (g ${n.key})`}
                className={({ isActive }) =>
                  cn(
                    'relative flex h-11 items-center gap-1.5 px-2 font-mono text-[13px] whitespace-nowrap text-muted hover:text-fg xl:h-14',
                    isActive && 'text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent',
                  )
                }
              >
                <span>{n.label}</span>
                {n.to === '/' && needs > 0 && (
                  <span className="bg-lime px-1.5 text-[11px] leading-[18px] text-lime-fg tabular" aria-label={`${needs} need you`}>
                    {needs}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex h-14 items-center gap-3 font-mono text-[11px] text-muted">
            <span className="flex items-center gap-1.5" role="status">
              {connected ? <span className="size-1.5 bg-pass" aria-hidden /> : <WifiOff aria-hidden className="size-3.5 text-fail" />}
              {connected ? 'Live' : 'Reconnecting…'}
            </span>
            <span className={cn('hidden items-center gap-1.5 sm:flex', gh && gh.state !== 'fresh' && 'text-block')} title={gh?.error ?? (gh?.fetchedAt ? `GitHub fetched ${ago(gh.fetchedAt, now)} ago` : undefined)}>
              {gh && gh.state !== 'fresh' ? <CloudOff aria-hidden className="size-3.5" /> : <Cloud aria-hidden className="size-3.5" />}
              <span className="sr-only 2xl:not-sr-only">{!gh ? '…' : gh.state === 'fresh' ? `GitHub · ${ago(gh.fetchedAt, now)}` : gh.state === 'stale' ? `GitHub stale · ${ago(gh.fetchedAt, now)}` : 'GitHub unavailable'}</span>
            </span>
            <span className={cn(data?.factory.actions && 'text-attention')}>{data?.factory.actions ? 'Actions enabled' : 'Read-only'}</span>
            <ThemeToggle />
            <PaletteButton />
          </div>
        </div>
      </header>
      {!connected && data && (
        <Banner tone="error" icon={<WifiOff aria-hidden className="mt-0.5 size-4 shrink-0 text-fail" />}>
          Lost the live connection to the control room server. Retrying; what you see may be out of date.
        </Banner>
      )}
      {gh && gh.state !== 'fresh' && (
        <Banner tone="stale">
          {gh.state === 'stale' ? (
            <>
              <strong>GitHub data is stale</strong> (last fetched {ago(gh.fetchedAt, now)} ago). Local state is current; pull requests, labels and checks may not be.
            </>
          ) : (
            <>
              <strong>No GitHub data.</strong> Showing local state only: issues, pull requests and checks are missing.
            </>
          )}
          {gh.error && <span className="text-muted"> Reason: {gh.error}.</span>}
        </Banner>
      )}
      <main id="main" className="field min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
        <div className="mx-auto min-h-full max-w-[1360px] border-x border-border bg-bg">
          <Suspense fallback={<div className="p-5"><Loading rows={5} /></div>}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      {data?.factory.actions && <ActionToasts />}
      <KeyboardLayer />
    </div>
  )
}

export function PageHeader({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border bg-bg/95 px-5 pt-5 pb-3 backdrop-blur">
      <h1 className="text-[24px] leading-none font-normal tracking-[-0.02em]">{title}</h1>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </header>
  )
}
