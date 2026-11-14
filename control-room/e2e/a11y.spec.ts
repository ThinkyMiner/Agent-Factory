// Accessibility: axe (WCAG 2.1 A and AA) on every screen, in both themes, including an open
// dialog and the command palette. Charts and tables are scanned like everything else.
import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const SCREENS = ['/', '/board', '/items/32', '/items/32/changes', '/items/32/activity', '/items/23', '/items/31/review', '/runs', '/quality', '/memory', '/memory/observations', '/memory/patterns', '/improvement', '/factory?file=factory/risk-rules.txt', '/audits', '/nope']

async function scan(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme })
    for (const path of SCREENS) {
      test(`axe ${path}`, async ({ page }) => {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
        await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0)
        expect(await scan(page)).toEqual([])
      })
    }
  })
}

test('axe with overlays open: palette, shortcuts, items panel', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  expect(await scan(page)).toEqual([])
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  expect(await scan(page)).toEqual([])
  await page.keyboard.press('Escape')
  await page.goto('/quality')
  await page.getByRole('button', { name: /Merged, last 4 weeks/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await scan(page)).toEqual([])
})
