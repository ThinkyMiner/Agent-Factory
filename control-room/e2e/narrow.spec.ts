// Desktop-first, but usable in a narrow window: no screen scrolls sideways at 400 px.
// Wide tables and diffs scroll inside their own box instead.
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 400, height: 860 } })

for (const path of ['/', '/board', '/items/32', '/items/32/changes', '/items/23', '/runs', '/quality', '/memory', '/memory/observations', '/memory/patterns', '/improvement', '/factory', '/audits']) {
  test(`no sideways scroll: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0)
    const over = await page.evaluate(() => {
      const w = document.documentElement.clientWidth
      return [...document.querySelectorAll<HTMLElement>('main *')]
        .filter((e) => {
          const r = e.getBoundingClientRect()
          if (r.right <= w + 1 || r.width === 0) return false
          for (let p = e.parentElement; p; p = p.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= w + 1) return false
          return true
        })
        .slice(0, 5)
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)} right=${Math.round(e.getBoundingClientRect().right)}`)
    })
    expect(over, `sticks out of a ${await page.evaluate(() => document.documentElement.clientWidth)}px window`).toEqual([])
    if (path === '/' || path === '/items/32' || path === '/quality') await page.screenshot({ path: `docs/screenshots/narrow${path.replace(/\//g, '-') || '-home'}.png`.replace('narrow-.png', 'narrow-home.png') })
  })
}
