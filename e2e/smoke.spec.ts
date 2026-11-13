// Loads every screen against the demo, checks the "done means" behaviours that need a browser,
// and writes screenshots to docs/screenshots/.
import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, writeFileSync } from 'node:fs'
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
  await expect(needs.getByRole('listitem')).toHaveCount(10)
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
