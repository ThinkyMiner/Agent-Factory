import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { Activity, Brain, ChartColumn, ClipboardCheck, Cloud, Cog, Columns3, LayoutDashboard, Monitor, Moon, Sprout, Sun, WifiOff } from 'lucide-react'
import { useApiState, useLiveUpdates, useNow } from '@/lib/api'
import { ago, cn } from '@/lib/utils'
import { Banner } from './States'

export const NAV = [
  { to: '/', label: 'Control room', icon: LayoutDashboard, key: 'r' },
  { to: '/board', label: 'Board', icon: Columns3, key: 'b' },
  { to: '/runs', label: 'Runs', icon: Activity, key: 'u' },
  { to: '/quality', label: 'Quality', icon: ChartColumn, key: 'q' },
  { to: '/memory', label: 'Memory', icon: Brain, key: 'm' },
  { to: '/improvement', label: 'Improvement', icon: Sprout, key: 'i' },
  { to: '/factory', label: 'Factory', icon: Cog, key: 'f' },
  { to: '/audits', label: 'Audits', icon: ClipboardCheck, key: 'a' },
]

type Theme = 'system' | 'light' | 'dark'
function readTheme(): Theme {
  try {
    const t = localStorage.getItem('cr-theme')
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}
export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem('cr-theme', theme)
    } catch {}
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyTheme(theme)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [theme])
  const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
  const Icon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon
  return (
    <button onClick={() => setTheme(next)} className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Theme: ${theme}. Switch to ${next}`} title={`Theme: ${theme}`}>
      <Icon aria-hidden className="size-3.5" />
      <span className="capitalize">{theme}</span>
    </button>
  )
}

/** "g" then a key jumps to a screen. Ignored while typing in a field. */
function useGoKeys() {
  const nav = useNavigate()
  useEffect(() => {
    let armed = 0
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'g') {
        armed = Date.now()
        return
      }
      if (Date.now() - armed < 1200) {
        const n = NAV.find((x) => x.key === e.key)
        if (n) {
          e.preventDefault()
          nav(n.to)
        }
      }
      armed = 0
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [nav])
}

export function Layout() {
  useGoKeys()
  const connected = useLiveUpdates()
  const { data } = useApiState()
  const now = useNow()
  const repoName = data?.factory.demo ? 'tally' : data?.factory.repo.split('/').filter(Boolean).at(-1)
  const gh = data?.github
  const needs = data?.needsYou.length ?? 0

  return (
    <div className="flex h-full flex-col md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-surface focus:p-2">
        Skip to content
      </a>
      <aside className="flex shrink-0 flex-col border-b border-border bg-surface md:w-52 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 md:pt-4">
          <span aria-hidden className="grid size-5 place-items-center rounded bg-fg">
            <span className="size-2 rounded-full bg-attention" />
          </span>
          <div className="min-w-0">
            <div className="font-semibold leading-tight">Control room</div>
            <div className="truncate font-mono text-[11px] text-muted" title={data?.factory.repo}>
              {repoName ?? '…'}
              {data?.factory.demo && <span className="ml-1 rounded bg-surface-2 px-1 font-sans text-[10px] tracking-wide uppercase">demo</span>}
            </div>
          </div>
        </div>
        <nav aria-label="Screens" className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cn('flex items-center gap-2 rounded-md px-2 py-1.5 whitespace-nowrap text-muted hover:bg-surface-2 hover:text-fg', isActive && 'bg-surface-2 font-medium text-fg')
              }
            >
              <n.icon aria-hidden className="size-4" />
              <span>{n.label}</span>
              {n.to === '/' && needs > 0 && (
                <span className="ml-auto rounded-full bg-attention px-1.5 text-[11px] leading-[18px] font-semibold text-bg tabular" aria-label={`${needs} need you`}>
                  {needs}
                </span>
              )}
              <kbd className="ml-auto hidden font-mono text-[10px] text-faint md:inline">{n.to === '/' && needs > 0 ? '' : `g ${n.key}`}</kbd>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-1 border-t border-border px-4 py-3 text-[12px] text-muted md:block">
          <div className="flex items-center gap-1.5" role="status">
            {connected ? <span className="size-2 rounded-full bg-pass" aria-hidden /> : <WifiOff aria-hidden className="size-3.5 text-fail" />}
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
          <div className="flex items-center gap-1.5" title={gh?.error}>
            <Cloud aria-hidden className="size-3.5" />
            {!gh ? '…' : gh.state === 'fresh' ? `GitHub · ${ago(gh.fetchedAt, now)}` : gh.state === 'stale' ? <span className="text-block">GitHub stale · {ago(gh.fetchedAt, now)}</span> : <span className="text-block">GitHub unavailable</span>}
          </div>
          <div className="text-faint">{data?.factory.actions ? 'Actions enabled' : 'Read-only'}</div>
          <ThemeToggle />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
        <main id="main" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function PageHeader({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-bg/90 px-5 py-3 backdrop-blur">
      <h1 className="text-[15px] font-semibold">{title}</h1>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </header>
  )
}
