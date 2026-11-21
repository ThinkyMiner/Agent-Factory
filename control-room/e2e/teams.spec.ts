// Team mode in a browser: what needs you, the teams, the planning cycle and the feature, over the
// fixture in tests/teams-fixture.ts. Hostile text stays text; axe in both themes; no sideways scroll.
import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { TEAMS_URL } from '../playwright.config'

function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('dialog', (d) => {
    errors.push(`dialog: ${d.message()}`)
    void d.dismiss()
  })
  return errors
}

test('control room: team needs and the teams table', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(TEAMS_URL + '/')
  const needs = page.getByRole('region', { name: /needs you/i })
  await expect(needs.getByRole('listitem')).toHaveCount(5)
  await expect(needs).toContainText('integrate/f001-reading-list · add human-approved, then merge') // the feature's PR to main
  await expect(needs).toContainText('Should a shared list be readable by anyone with the link')
  await expect(needs).toContainText('Who may open a shared list')
  await expect(needs).toContainText('API rate limit: retrying in 20 minutes')
  await expect(needs).toContainText('Do you trust the files in this folder?')
  const teams = page.getByRole('region', { name: /teams/i })
  await expect(teams).toContainText('Planning c002-share-links: decisions · waiting for backend')
  await expect(teams.getByRole('row', { name: /research/ })).toContainText('work/19-acceptance')
  await expect(teams.getByRole('row', { name: /research/ })).toContainText('Blocked')
  await expect(teams.getByRole('row', { name: /design/ })).toContainText('worktree missing')
  await expect(page.getByText('unknown event type')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Planning', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('planning: the cycle, its transcript as plain text, the feature and its records', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(TEAMS_URL + '/planning')
  const cycle = page.getByRole('region', { name: /planning cycle/i })
  await expect(cycle.getByRole('list', { name: 'Waiting for' })).toHaveText('backend owes accept or objection on draft 1')
  await expect(cycle.getByRole('row', { name: /c002-D02/ })).toContainText('needs-human')
  const transcript = page.getByRole('region', { name: /transcript/i }).getByRole('list', { name: 'Transcript' })
  await expect(transcript.getByRole('listitem')).toHaveCount(5)
  await expect(transcript).toContainText('<script>alert("x")</script><img src=x onerror="alert(1)"> **not bold**')
  expect(await transcript.locator('script, img, strong, a').count()).toBe(0)
  const feature = page.getByRole('article', { name: 'Feature f001-reading-list' })
  await expect(feature).toContainText('E2E: fail, round: 1')
  await expect(feature).toContainText('VERDICT: reject')
  await expect(feature.getByRole('row', { name: /#23/ })).toContainText('ticket')
  await expect(feature.getByRole('row', { name: /#26/ })).toContainText('declined by frontend')
  await expect(feature.getByRole('row', { name: /#26/ }).getByRole('link', { name: '#26' })).toHaveAttribute('href', 'https://github.invalid/harbor/issues/26')
  await expect(feature.getByRole('row', { name: /#24/ })).toContainText('waits for #21 list-page (ready)')
  await expect(feature.getByRole('row', { name: /^#21 / })).toContainText('c001-D01')
  await expect(feature.getByRole('row', { name: /^#21 / }).getByRole('link', { name: 'c001-D01' })).toHaveCount(0) // an earlier cycle's record: not on this page
  const why = feature.getByRole('table', { name: /Failing tests of f001-reading-list/ })
  await expect(why).toContainText('AC2')
  await expect(why).toContainText('<script>alert("x")</script>')
  expect(await why.locator('script, img, strong, a[href^="javascript"]').count()).toBe(0)
  const d02 = cycle.getByRole('row', { name: /c002-D02/ })
  await d02.getByText('Who may open a shared list').click()
  await expect(d02).toContainText('frontend: members only.')
  await expect(cycle.getByRole('link', { name: 'c002-D02' })).toHaveAttribute('href', '#decision-c002-D02') // the needs-human line links its record
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  await feature.getByText('acceptance.md', { exact: true }).click()
  await expect(feature).toContainText('Saving a link')
  expect(errors).toEqual([])
})

test('board: dispatched items not started are Ready, with what they wait for', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(TEAMS_URL + '/board')
  const ready = page.getByRole('region', { name: 'Ready' })
  await expect(ready.getByRole('listitem')).toHaveCount(3) // #21, #23 (an accepted ticket), #24
  await expect(ready.getByRole('link', { name: /#24/ })).toContainText('waits for #21 list-page (ready)')
  expect(errors).toEqual([])
})

test('factory: the policy card shows every setting and what it changes', async ({ page }) => {
  await page.goto(TEAMS_URL + '/factory')
  const card = page.getByRole('region', { name: 'Factory policy' })
  await expect(card).toContainText('AUTO_MERGE_MAX_TIER=none')
  await expect(card).toContainText('Every pull request waits for you.')
  await expect(card).toContainText('RIGOR=mvp')
  await expect(card).toContainText('build items start at dispatch')
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme })
    for (const path of ['/', '/planning']) {
      test(`axe ${path} (team mode)`, async ({ page }) => {
        await page.goto(TEAMS_URL + path)
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
        await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0)
        await expect(page.getByRole('region', { name: /teams|planning cycle/i }).first()).toBeVisible()
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
      })
    }
  })
}

test.describe('narrow', () => {
  test.use({ viewport: { width: 400, height: 860 } })
  for (const path of ['/', '/planning']) {
    test(`no sideways scroll (team mode): ${path}`, async ({ page }) => {
      await page.goto(TEAMS_URL + path)
      await expect(page.getByRole('region', { name: /teams|planning cycle/i }).first()).toBeVisible()
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
      expect(over).toEqual([])
    })
  }
})
