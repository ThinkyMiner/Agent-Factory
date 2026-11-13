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
