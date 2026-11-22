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
  await expect(needs).toContainText('integrate/f001-reading-list · add human-approved, wait for the checks to pass, then merge') // the feature's PR to main
  await expect(needs).toContainText('Should a shared list be readable by anyone with the link')
  await expect(needs).toContainText('Who may open a shared list')
  await expect(needs).toContainText('API rate limit: retrying in 20 minutes')
  await expect(needs).toContainText('Do you trust the files in this folder?')
  const teams = page.getByRole('region', { name: /teams/i })
  await expect(teams).toContainText('Planning c002-share-links: decisions · waiting for backend')
  await expect(teams.getByRole('row', { name: /research/ })).toContainText('work/19-acceptance')
  await expect(teams.getByRole('row', { name: /research/ })).toContainText('Blocked')
  await expect(teams.getByRole('row', { name: /design/ })).toContainText('worktree missing')
  await expect(page.getByRole('region', { name: /running now/i })).toContainText('1 session open, idle at its prompt; nothing is running.') // the orchestrator's
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
  await expect(feature.getByRole('row', { name: /#23/ })).toContainText('Ready') // the item's state, and beside it the ticket's
  await expect(feature.getByRole('row', { name: /#23/ })).toContainText('ticket accepted')
  const issues = feature.getByRole('table', { name: 'Items of f001-reading-list' }) // #26 is also linked from the attribution table below
  await expect(issues.getByRole('row', { name: /#26/ })).toContainText('declined by frontend')
  await expect(issues.getByRole('row', { name: /#26/ }).getByRole('link', { name: '#26' })).toHaveAttribute('href', 'https://github.invalid/harbor/issues/26')
  await expect(feature.getByRole('row', { name: /#24/ })).toContainText('waits for #21 list-page (ready)')
  await expect(feature.getByRole('row', { name: /^#21 / })).toContainText('c001-D01')
  await expect(feature.getByRole('row', { name: /^#21 / }).getByRole('link', { name: 'c001-D01' })).toHaveCount(0) // an earlier cycle's record: not on this page
  const why = feature.getByRole('table', { name: /Failing tests of f001-reading-list/ })
  await expect(why).toContainText('AC2')
  await expect(why).toContainText('<script>alert("x")</script>')
  await expect(why.getByRole('link', { name: '#26' })).toHaveAttribute('href', 'https://github.invalid/harbor/issues/26') // the ticket integrate.sh filed for the row
  await expect(why.getByRole('link', { name: 'AC2' })).toHaveAttribute('href', 'https://github.com/example/harbor/blob/feature/f001-reading-list/features/f001-reading-list/acceptance.md#ac2-sharing')
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
  await expect(page.getByRole('heading', { name: /Stopped/ })).toHaveAttribute('title', /red check on its open pull request/) // not only "before a pull request"
  expect(errors).toEqual([])
})

test('a newcomer: where things are, what clears each row, where an item sits, and the words explained', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(TEAMS_URL + '/')
  const where = page.getByRole('region', { name: 'Where things are' })
  await expect(where.getByRole('listitem')).toHaveCount(2)
  await expect(where.getByRole('listitem').first()).toContainText('Pull request to main: #25')
  await expect(where.getByRole('listitem').first()).toContainText('next: you read PR #25, then add human-approved, wait for the checks to pass, then merge')
  await expect(where.getByRole('listitem').nth(1)).toContainText('Planning c002-share-links: decisions')
  await expect(where.getByRole('listitem').nth(1)).toContainText('next: backend accept or objection on draft 1')
  const hints = page.getByRole('note', { name: 'How to clear these rows' })
  await expect(hints).toContainText('Pull request rows: read it on GitHub, add the human-approved label, wait for its checks to pass, then merge it (with auto-merge on, it then merges itself).')
  await expect(hints).toContainText('Planning records marked needs-human')
  await expect(hints).toContainText('Session rows: a team')
  await expect(page.getByRole('region', { name: /teams/i }).getByRole('columnheader', { name: 'Holds' }).locator('abbr')).toHaveAttribute('title', /build slot/)
  await page.goto(TEAMS_URL + '/items/21')
  await expect(page.getByText('work-breakdown item list-page')).toBeVisible()
  await expect(page.getByRole('link', { name: 'f001-reading-list' })).toHaveAttribute('href', '/planning#features')
  await expect(page.getByText(/builds c001-D01/)).toBeVisible()
  await page.goto(TEAMS_URL + '/planning')
  await expect(page.getByRole('region', { name: /planning cycle/i }).getByRole('list', { name: 'Rounds' }).getByRole('listitem').first()).toHaveAttribute('title', /^the brief: what this cycle is for/)
  expect(errors).toEqual([])
})

test('where things are: each owner of a next step gets its own line and its own link', async ({ page }) => {
  const errors = watchErrors(page)
  // two owners at once (as the server gives them); the fixture's phase is reused with a second owner added
  await page.route('**/api/teams', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.phases[0].more = [{ who: 'backend', what: 'finish #20', href: '/items/20' }]
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(TEAMS_URL + '/')
  const first = page.getByRole('region', { name: 'Where things are' }).getByRole('listitem').first()
  await expect(first).toContainText('next: you read PR #25')
  await expect(first).toContainText('and: backend finish #20')
  await expect(first.getByRole('link', { name: 'finish #20' })).toHaveAttribute('href', '/items/20')
  expect(errors).toEqual([])
})

test('a merge with only GitHub\'s merger login names that login on Home and Board alike', async ({ page }) => {
  const errors = watchErrors(page)
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    Object.assign(body.items.find((i: { id: string }) => i.id === '20'), { mergedAt: new Date().toISOString(), mergedBy: undefined, merger: 'octo' })
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(TEAMS_URL + '/')
  await expect(page.getByRole('link', { name: /#20/ }).locator('[title^="merged by"]')).toHaveAttribute('title', 'merged by octo (GitHub account)')
  await page.goto(TEAMS_URL + '/board')
  await expect(page.getByRole('region', { name: 'Merged' })).toContainText('merged by octo')
  expect(errors).toEqual([])
})

test('an approved merge without auto-merge says approved by you, not who merged; another base is named', async ({ page }) => {
  const errors = watchErrors(page)
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    Object.assign(body.items.find((i: { id: string }) => i.id === '20'), { mergedAt: new Date().toISOString(), mergedBy: 'human', merger: undefined, mergedInto: 'release/v1' })
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(TEAMS_URL + '/')
  const row = page.getByRole('link', { name: /#20/ })
  await expect(row.locator('[title^="approved by you"]')).toHaveAttribute('title', 'approved by you; merged by unknown')
  await expect(row.getByText('→ release/v1')).toHaveAttribute('title', 'Merged into release/v1, not main')
  await page.goto(TEAMS_URL + '/board')
  await expect(page.getByRole('region', { name: 'Merged' })).toContainText('approved by you; merged by unknown into release/v1')
  expect(errors).toEqual([])
})

test('Needs you footers say what clears a merge or a red check, not that a pending PR is ready', async ({ page }) => {
  const errors = watchErrors(page)
  await page.route('**/api/state', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.needsYou.push({ id: '20', kind: 'merge', title: 'Reading list API', summary: 'R1 · checks pending · auto-merge was not enabled', since: new Date().toISOString() },
      { id: '24', kind: 'failed', title: 'Copy a share link', summary: 'CI failing: factory-tests', since: new Date().toISOString() },
      { id: 'pr-90', label: 'PR #90', kind: 'info', title: 'Kit sync', summary: 'factory/kit · approved: wait for the risk-gate rerun after the label to pass · R2', since: new Date().toISOString() })
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(TEAMS_URL + '/')
  const hints = page.getByRole('note', { name: 'How to clear these rows' })
  await expect(hints).toContainText('merge it on GitHub once its checks pass')
  await expect(hints).not.toContainText('the pull request is ready')
  await expect(hints).toContainText('a red check on its pull request is fixed by the team that owns the branch')
  await expect(hints).toContainText('nothing to do yet: its checks are still running (after your label, the risk-gate reruns)') // a PR row that waits never says merge
  expect(errors).toEqual([])
})

test('quality: an empty chart says whether nothing happened or it cannot be measured', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto(TEAMS_URL + '/quality')
  const lead = page.getByRole('region', { name: 'How long from ready to merged? (median hours)' })
  await expect(lead).toContainText('Cannot be measured')
  await expect(lead).toContainText('1 item merged, but none has a ready time')
  const escaped = page.getByRole('region', { name: 'Did defects escape?' })
  await expect(escaped).toContainText(/No data in the last \d+ weeks/)
  await expect(escaped).toContainText('Nothing escaped in this window.')
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
