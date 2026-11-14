// Loads every screen against the demo, checks the "done means" behaviours that need a browser,
// and writes screenshots to docs/screenshots/.
import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEMO_DIR } from '../playwright.config'

const REPO = join(DEMO_DIR, 'repo')
const shot = (page: Page, name: string) => page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: false })

function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return errors
}

test('control room: needs you first, running, merged', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  const needs = page.getByRole('region', { name: /needs you/i })
  await expect(needs).toBeVisible()
  await expect(needs.getByRole('listitem')).toHaveCount(11)
  await expect(needs.getByRole('listitem').filter({ hasText: 'PR #141' })).toContainText('factory:improvement · R2')
  await expect(needs).toContainText('Should deleting an account also delete the expenses')
  await expect(needs).toContainText('db/migrations/0007_audit_log.sql')
  await expect(page.getByRole('region', { name: /running now/i })).toContainText('reviewer')
  await shot(page, 'control-room')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(needs).toBeVisible()
  await shot(page, 'control-room-dark')
  expect(errors).toEqual([])
})

test('board: columns, cards, filters', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/board')
  for (const name of ['Proposed', 'Ready', 'In progress', 'Pull request open', 'Waiting for me', 'Stopped', 'Merged']) {
    await expect(page.getByRole('heading', { name: new RegExp(`^${name}`) })).toBeVisible()
  }
  const waiting = page.getByRole('region', { name: /Waiting for me/ })
  await expect(waiting.getByRole('listitem')).toHaveCount(2)
  await shot(page, 'board')
  await page.getByRole('button', { name: 'Tier R2' }).click()
  await expect(page).toHaveURL(/tier=R2/)
  await expect(page.getByRole('region', { name: /^Merged/ }).getByRole('listitem')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('item detail: every tab renders', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/items/32')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log table for group changes')
  await expect(page.getByRole('region', { name: 'Not verified' })).toContainText('Rollback of 0007 was not exercised')
  await expect(page.getByRole('list', { name: 'Stages' })).toBeVisible()
  await shot(page, 'item-spec')
  for (const [tab, text] of [
    ['Plan', 'Files:'],
    ['Changes', 'Pick a file'],
    ['Gates', 'CI checks on the pull request'],
    ['Review', 'VERDICT: pass'],
    ['Activity', 'Agent runs'],
    ['Not verified', 'migration was not run'],
    ['Observations', 'outcome'],
  ] as const) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
    await expect(page.getByRole('tabpanel')).toContainText(text)
  }
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: /0007_audit_log.sql/ }).click()
  await expect(page.getByRole('tabpanel')).toContainText('create table audit_log')
  await shot(page, 'item-changes')
  await page.getByRole('tab', { name: /^Activity/ }).click()
  await shot(page, 'item-activity')
  expect(errors).toEqual([])
})

test('read-only: no action buttons, and each says how to do it by hand', async ({ page }) => {
  await page.goto('/items/32')
  await expect(page.getByText('Read-only')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review and approve…' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /gh pr edit 132 --add-label human-approved/ })).toBeVisible()
  await page.goto('/items/23')
  await expect(page.getByLabel(/Your answer/)).toHaveCount(0)
  await page.goto('/items/40')
  await expect(page.getByRole('button', { name: /gh issue edit 40 --add-label factory:ready/ })).toBeVisible()
})

test('item detail: a blocked item shows the question; a malformed review shows a notice and the raw text', async ({ page }) => {
  await page.goto('/items/23')
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Should deleting an account')
  await shot(page, 'item-blocked')
  await page.goto('/items/10/review')
  await expect(page.getByText('Could not parse review.md').first()).toBeVisible()
  await expect(page.getByRole('tabpanel')).toContainText('Looks good overall')
  await shot(page, 'item-malformed-review')
})

test('runs: live and historic, with quiet runs called out and filters in the URL', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/runs')
  const table = page.getByRole('table', { name: 'Agent runs' })
  await expect(table.getByRole('row').filter({ hasText: '#29' }).filter({ hasText: 'quiet' })).toHaveCount(1)
  await expect(table.getByRole('row').filter({ hasText: '#30' }).filter({ hasText: 'foreman' }).first()).toContainText('waiting for you')
  await expect(table).toContainText('claude-opus-5-5')
  await shot(page, 'runs')
  await page.getByRole('button', { name: /^quiet/ }).click()
  await expect(page).toHaveURL(/status=quiet/)
  const rows = table.getByRole('row').filter({ hasNot: page.getByRole('columnheader') })
  await expect(rows).toHaveCount(1) // the demo has one quiet run: #29's builder
  await expect(rows.first()).toContainText('#29')
  await expect(rows.first()).toContainText('quiet')
  expect(errors).toEqual([])
})

test('quality: every number opens the items behind it', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/quality')
  for (const q of ['How many items are we merging each week?', 'Where do fix rounds happen?', 'Did defects escape?', 'How many tokens does a merged item cost? (median)'])
    await expect(page.getByRole('heading', { name: q, exact: true })).toBeVisible()
  await shot(page, 'quality')
  // a headline tile
  await page.getByRole('button', { name: /Merged, last 4 weeks/ }).click()
  const panel = page.getByRole('dialog')
  await expect(panel.getByRole('listitem').first()).toBeVisible()
  await panel.getByRole('listitem').first().getByRole('link').last().click()
  await expect(page).toHaveURL(/\/items\/\d+/)
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Quality')
  await expect(panel).toBeHidden()
  await page.goBack()
  // a bar, by keyboard: the chart is one tab stop, arrows move, Enter lists
  const chart = page.getByRole('group', { name: /How many items are we merging each week/ })
  await chart.focus()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Week of')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  // a stacked segment through the table view: the reverted #7 is an escaped defect
  const card = page.getByRole('region', { name: 'Did defects escape?' })
  await card.getByText('Table').click()
  await card.getByRole('button', { name: '1', exact: true }).first().click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('listitem')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Where do fix rounds happen?' })).toBeVisible()
  await shot(page, 'quality-dark')
  expect(errors).toEqual([])
})

test('memory: lessons link to their evidence, observations are searchable, patterns open their rows', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/memory')
  await expect(page.getByText('5 of 40 lessons')).toBeVisible()
  const lessons = page.getByRole('tabpanel')
  for (const l of await lessons.getByRole('listitem').all()) await expect(l.getByRole('link').first()).toHaveAttribute('href', /^\/items\/\d+$/)
  await shot(page, 'memory-lessons')
  await lessons.getByRole('listitem').filter({ hasText: 'L-1' }).getByRole('link', { name: '#12' }).click()
  await expect(page).toHaveURL(/\/items\/12$/)
  await page.goto('/memory/observations')
  await page.getByRole('searchbox', { name: 'Search observations' }).fill('agents skip the review')
  const list = page.getByRole('list', { name: 'Observations' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('not acted on')
  await expect(page).toHaveURL(/q=agents/)
  await shot(page, 'memory-observations')
  await page.goto('/memory/patterns')
  await shot(page, 'memory-patterns')
  const cell = page.getByRole('link', { name: /review observations, week of/ }).first()
  const n = Number(await cell.innerText())
  await cell.click()
  await expect(page).toHaveURL(/stage=review&week=/)
  await expect(page.getByRole('list', { name: 'Observations' }).getByRole('listitem')).toHaveCount(n)
  expect(errors).toEqual([])
})

test('improvement: the open improvement PR, and whether each prediction held', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/improvement')
  const pr = page.getByRole('listitem').filter({ hasText: '#141' })
  await expect(pr).toContainText('Waiting for your approval')
  await expect(pr).toContainText('risk-gate failed')
  const table = page.getByRole('table')
  await expect(table.getByRole('row').filter({ hasText: 'Run make accept before committing a build' })).toContainText('no effect')
  await expect(table.getByRole('row').filter({ hasText: 'Membership check on every write path' })).toContainText('worked')
  await expect(table.getByRole('row').filter({ hasText: 'Name acceptance tests after their criterion' })).toContainText('not checked yet')
  await expect(page.getByText('1 worked · 1 no effect · 0 made things worse · 1 not checked yet')).toBeVisible()
  await shot(page, 'improvement')
  await page.goto('/quality')
  await expect(page.getByRole('region', { name: "Did /reflect's predictions hold?" })).toContainText('1 worked')
  expect(errors).toEqual([])
})

test('factory: config read-only, local drift from main flagged, classify a path', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/factory')
  const drift = page.getByRole('status', { name: 'Differences from main' })
  await expect(drift).toContainText('1 file differs from main')
  await expect(drift).toContainText('factory/risk-rules.txt')
  await expect(drift).toContainText('uncommitted')
  await expect(page.getByText('AUTO_MERGE_MAX_TIER=R1')).toBeVisible()
  await page.getByLabel('Classify a path').fill('src/reports/export.ts')
  const rules = page.getByRole('region', { name: 'Risk rules' })
  await expect(rules.getByText('main (CI uses)').locator('..')).toContainText('R1')
  await expect(rules.getByText('working tree', { exact: true }).locator('..')).toContainText('R2')
  await expect(page.getByRole('region', { name: 'Agents' })).toContainText('model: opus')
  await shot(page, 'factory')
  await drift.getByRole('button', { name: 'factory/risk-rules.txt' }).click()
  await expect(page).toHaveURL(/file=factory%2Frisk-rules.txt|file=factory\/risk-rules.txt/)
  await expect(page.getByText('+R2 src/reports/*')).toBeVisible()
  expect(errors).toEqual([])
})

test('audits: newest first, rendered, and the script in one stays text', async ({ page }) => {
  const errors = watchErrors(page)
  let dialogs = 0
  page.on('dialog', (d) => (dialogs++, void d.dismiss()))
  await page.goto('/audits')
  const article = page.getByRole('article')
  await expect(article.getByRole('heading', { name: 'Autonomy recommendation' })).toBeVisible()
  await expect(article.locator('code', { hasText: "<script>alert('audit text is untrusted" })).toBeVisible()
  await expect(article.locator('script')).toHaveCount(0)
  await shot(page, 'audits')
  await page.getByRole('navigation', { name: 'Audits' }).getByRole('link').last().click()
  await expect(page).toHaveURL(/\/audits\/\d{4}-\d{2}-\d{2}$/)
  expect(dialogs).toBe(0)
  expect(errors).toEqual([])
})

test('theme: the top-bar switch picks light or dark over the system, and the choice sticks', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  const theme = page.getByRole('group', { name: 'Theme' })
  const html = page.locator('html')
  await expect(theme.getByRole('button', { name: 'Match the system' })).toHaveAttribute('aria-pressed', 'true')
  await expect(html).toHaveClass(/dark/)
  await theme.getByRole('button', { name: 'Light' }).click()
  await expect(html).not.toHaveClass(/dark/)
  await page.reload()
  await expect(html).not.toHaveClass(/dark/)
  await expect(theme.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
  await theme.getByRole('button', { name: 'Dark' }).click()
  await expect(html).toHaveClass(/dark/)
  await theme.getByRole('button', { name: 'Match the system' }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).not.toHaveClass(/dark/)
})

test('keyboard: the palette finds items and runs commands; g, j/k, / and ? work', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await page.keyboard.type('audit log table')
  await shot(page, 'command-palette')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/items\/32$/)
  await page.keyboard.press('g')
  await page.keyboard.press('b')
  await expect(page).toHaveURL(/\/board$/)
  await expect(page.locator('[data-page-filter]')).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.locator('[data-page-filter]')).toBeFocused()
  await page.keyboard.type('j') // typing in a field is not a shortcut
  await expect(page.locator('[data-page-filter]')).toHaveValue('j')
  await page.goto('/')
  await expect(page.locator('main [data-nav-item]').first()).toBeVisible()
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  const second = await page.locator(':focus').getAttribute('href')
  await page.keyboard.press('k')
  await page.keyboard.press('j')
  await expect(page.locator(':focus')).toHaveAttribute('href', second!)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`${second!.replace(/[/]/g, '\\/')}$`))
  await page.keyboard.press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('theme dark')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('theme system')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  expect(errors).toEqual([])
})

test('live: a new BLOCKED.md puts the item in "needs you" within seconds', async ({ page }) => {
  await page.goto('/')
  const needs = page.getByRole('region', { name: /needs you/i })
  await expect(needs).not.toContainText('#28')
  // the checked-out item's run stops and asks
  writeFileSync(join(REPO, 'work/28-edit-expense/BLOCKED.md'), '# Blocked\n\nShould an edit keep the original amount in the history?\n')
  await expect(needs).toContainText('Should an edit keep the original amount in the history?', { timeout: 5_000 })
})

test('live: appending a stage event moves the card without a refresh', async ({ page }) => {
  await page.goto('/board')
  const ready = page.getByRole('region', { name: /^Ready/ })
  const inProgress = page.getByRole('region', { name: /^In progress/ })
  await expect(ready).toContainText('Archive a group')
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  appendFileSync(join(REPO, '.factory/events.jsonl'), JSON.stringify({ ts, type: 'stage', work_id: '39', branch: 'main', stage: 'intake', status: 'started', round: '0' }) + '\n')
  await expect(inProgress).toContainText('Archive a group', { timeout: 5_000 })
  await expect(ready).not.toContainText('Archive a group')
})

test('live: a new audit appears without a refresh, flagged as not on main', async ({ page }) => {
  await page.goto('/audits')
  await expect(page.getByRole('article')).toBeVisible()
  const file = join(REPO, 'docs/factory/audits/2026-11-20.md')
  writeFileSync(file, '# Audit 2026-11-20\n\n## Counts\n- Items merged: 0\n')
  try {
    const link = page.getByRole('navigation', { name: 'Audits' }).getByRole('link', { name: /2026-11-20/ })
    await expect(link).toBeVisible({ timeout: 5000 })
    await expect(link).toContainText('not committed to main')
  } finally {
    rmSync(file)
  }
})

test('a malformed file produces a notice, not an error page', async ({ page }) => {
  writeFileSync(join(REPO, 'work/28-edit-expense/review.md'), 'VERDICT: maybe\n')
  await page.goto('/items/28/review')
  await expect(page.getByText('Could not parse review.md').first()).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Edit an expense')
})

test('unknown routes and items are designed states', async ({ page }) => {
  await page.goto('/items/999')
  await expect(page.getByText('There is no item #999')).toBeVisible()
  await page.goto('/nope')
  await expect(page.getByText('Nothing here')).toBeVisible()
})
