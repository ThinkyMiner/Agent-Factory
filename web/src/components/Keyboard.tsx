// Keyboard: ⌘K / Ctrl+K command palette, "g" then a key for a screen, j/k through the page's list,
// "/" to the page's filter, "?" for this list. Single keys are ignored while typing in a field.
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Command } from 'cmdk'
import { Dialog } from 'radix-ui'
import { Search, X } from 'lucide-react'
import { useApiState } from '@/lib/api'
import { setTheme } from '@/lib/theme'
import { NAV } from './Layout'
import { NEEDS, STATE, TierChip } from './vocab'

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** Move focus to the next or previous [data-nav-item] in the page. */
function step(dir: 1 | -1) {
  const all = [...document.querySelectorAll<HTMLElement>('main [data-nav-item]')].filter((e) => e.offsetParent !== null)
  if (!all.length) return
  const i = all.indexOf(document.activeElement as HTMLElement)
  const next = all[i < 0 ? (dir > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, i + dir))]!
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
}

export function useShortcuts(open: { palette: () => void; help: () => void }) {
  const nav = useNavigate()
  useEffect(() => {
    let armed = 0
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        open.palette()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('[role="dialog"]')) return
      if (Date.now() - armed < 1200) {
        armed = 0
        const n = NAV.find((x) => x.key === e.key)
        if (n) {
          e.preventDefault()
          nav(n.to)
        }
        return
      }
      if (e.key === 'g') armed = Date.now()
      else if (e.key === 'j' || e.key === 'k') {
        e.preventDefault()
        step(e.key === 'j' ? 1 : -1)
      } else if (e.key === '/') {
        const f = document.querySelector<HTMLElement>('[data-page-filter]')
        if (f) {
          e.preventDefault()
          f.focus()
        }
      } else if (e.key === '?') {
        e.preventDefault()
        open.help()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [nav, open])
}

const item = 'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] data-[selected=true]:bg-surface-2'
const group = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted'

export function Palette({ open, setOpen, onHelp }: { open: boolean; setOpen: (o: boolean) => void; onHelp: () => void }) {
  const nav = useNavigate()
  const loc = useLocation()
  const { data } = useApiState()
  const here = /^\/items\/([A-Za-z0-9._]+)/.exec(loc.pathname)?.[1]
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/30"
      contentClassName="fixed top-[12vh] left-1/2 z-50 w-[min(620px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden className="size-4 text-muted" />
        <Command.Input placeholder="Jump to an item or a screen, or run a command" className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint focus-visible:outline-none" />
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-muted">No match.</Command.Empty>
        {!!data?.needsYou.length && (
          <Command.Group heading="Needs you" className={group}>
            {data.needsYou.map((n) => (
              <Command.Item key={`${n.kind}-${n.id}`} value={`needs ${n.kind} ${n.label ?? `#${n.id}`} ${n.title}`} onSelect={run(() => nav(n.href ?? `/items/${n.id}`))} className={item}>
                <span className="w-16 shrink-0 text-[12px] font-medium text-attention">{NEEDS[n.kind].label}</span>
                <span className="font-mono text-[12px] text-muted">{n.label ?? `#${n.id}`}</span>
                <span className="truncate">{n.title}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        <Command.Group heading="Screens" className={group}>
          {NAV.map((s) => (
            <Command.Item key={s.to} value={`screen ${s.label}`} onSelect={run(() => nav(s.to))} className={item}>
              <s.icon aria-hidden className="size-4 text-muted" />
              {s.label}
              <kbd className="ml-auto font-mono text-[11px] text-muted">g {s.key}</kbd>
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Commands" className={group}>
          {here && (
            <Command.Item value={`copy /work ${here}`} onSelect={run(() => void navigator.clipboard?.writeText(`/work ${here}`))} className={item}>
              Copy <span className="font-mono text-[12px]">/work {here}</span>
            </Command.Item>
          )}
          {(['light', 'dark', 'system'] as const).map((t) => (
            <Command.Item key={t} value={`theme ${t}`} onSelect={run(() => setTheme(t))} className={item}>
              Theme: {t}
            </Command.Item>
          ))}
          <Command.Item value="keyboard shortcuts help" onSelect={run(onHelp)} className={item}>
            Keyboard shortcuts
          </Command.Item>
        </Command.Group>
        {!!data?.items.length && (
          <Command.Group heading="Items" className={group}>
            {data.items.map((i) => (
              <Command.Item key={i.id} value={`#${i.id} ${i.title} ${STATE[i.state].label}`} onSelect={run(() => nav(`/items/${i.id}`))} className={item}>
                <span className="w-10 shrink-0 font-mono text-[12px] text-muted">#{i.id}</span>
                <span className="truncate">{i.title}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-muted">
                  <TierChip tier={i.tier} />
                  {STATE[i.state].label}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  )
}

const KEYS: [string, string][] = [
  ['⌘K or Ctrl+K', 'Command palette: items, screens, commands'],
  ['g then r b u q m i f a', 'Control room, Board, Runs, Quality, Memory, Improvement, Factory, Audits'],
  ['j / k', 'Next or previous row in the page'],
  ['Enter', 'Open the focused row'],
  ['/', "Focus the page's filter"],
  ['← → Home End', 'Move between weeks in a focused chart; Enter lists the items'],
  ['Esc', 'Close a dialog or panel'],
  ['?', 'This list'],
]

export function ShortcutsHelp({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-lg border border-border bg-surface p-5 shadow-xl focus:outline-none">
          <div className="flex items-center">
            <Dialog.Title className="text-[15px] font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className="ml-auto rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-0.5 text-[12.5px] text-muted">Single keys do nothing while you are typing in a field.</Dialog.Description>
          <table className="mt-3 w-full text-[13px]">
            <tbody>
              {KEYS.map(([k, what]) => (
                <tr key={k} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-4 whitespace-nowrap">
                    <kbd className="font-mono text-[12px]">{k}</kbd>
                  </td>
                  <td className="py-1.5 text-muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Palette and help, mounted once in the layout. */
export function KeyboardLayer() {
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [open] = useState(() => ({ palette: () => setPalette(true), help: () => setHelp(true) }))
  useShortcuts(open)
  return (
    <>
      <Palette open={palette} setOpen={setPalette} onHelp={() => setHelp(true)} />
      <ShortcutsHelp open={help} setOpen={setHelp} />
    </>
  )
}

/** A visible way in, for people who do not know the shortcut. */
export function PaletteButton() {
  return (
    <button
      onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
      className="flex h-8 items-center gap-2 rounded-sm bg-fg px-3 text-[12px] text-bg hover:opacity-90"
    >
      <Search aria-hidden className="size-3.5" /> <span className="max-sm:sr-only">Search</span>
      <kbd className="text-[11px] opacity-70 max-sm:hidden">⌘K</kbd>
    </button>
  )
}
