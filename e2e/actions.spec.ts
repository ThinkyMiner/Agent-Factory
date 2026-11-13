// With --actions: approve (preview, typed confirmation), answer, mark ready, each visible in the app
// without a refresh. The read-only demo shows how to do each by hand instead (smoke.spec.ts).
import { expect, test } from '@playwright/test'
import { ACTIONS_URL } from '../playwright.config'

test.use({ baseURL: ACTIONS_URL })

test('approve an R2 pull request: see what you approve, type the confirmation, the item moves on', async ({ page }) => {
  await page.goto('/items/32')
  await expect(page.getByText('Actions enabled')).toBeVisible()
  await page.getByRole('button', { name: 'Review and approve…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Approve pull request #132' })
  await expect(dialog.getByRole('region', { name: 'Paths that need you' })).toContainText('db/migrations/0007_audit_log.sql')
  await expect(dialog.getByRole('region', { name: 'Review' })).toContainText('Verdict')
  const approve = dialog.getByRole('button', { name: 'Approve #132' })
  await expect(approve).toBeDisabled()
  await dialog.getByLabel(/Type approve #132 to confirm/).fill('approve 132')
  await expect(approve).toBeDisabled()
  await dialog.getByLabel(/Type approve #132 to confirm/).fill('approve #132')
  await page.screenshot({ path: 'docs/screenshots/approve-dialog.png' })
  await approve.click()
  await expect(page.getByRole('status').filter({ hasText: 'Added human-approved to pull request #132' })).toBeVisible()
  await expect(dialog).toBeHidden()
  // approved, no auto-merge on this PR: it now needs merging, not approving
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Merge the pull request')
  await expect(page.getByRole('list', { name: 'Actions taken from the control room' })).toContainText('You approved')
})

test('answer a blocked question: posted, then told to run /work', async ({ page }) => {
  await page.goto('/items/23')
  const box = page.getByLabel('Your answer, posted as a comment on issue #23')
  await expect(page.getByRole('button', { name: 'Post answer' })).toBeDisabled()
  await box.fill('Delete them too; keep a 30-day undo.')
  await page.getByRole('button', { name: 'Post answer' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Posted your answer on issue #23' })).toBeVisible()
  await expect(page.getByText('Answer posted on issue #23. Next:')).toBeVisible()
})

test('mark a proposed issue ready: it moves to Ready', async ({ page }) => {
  await page.goto('/items/41')
  await expect(page.getByText('Proposed', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Mark ready…' }).click()
  await page.getByRole('button', { name: 'Mark ready', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Added factory:ready to issue #41' })).toBeVisible()
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible()
})

test('approving an improvement PR says there was no reviewer', async ({ page }) => {
  await page.goto('/improvement')
  await page.getByRole('listitem').filter({ hasText: '#141' }).getByRole('button', { name: 'Review and approve…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('No reviewer ran on this pull request')
  await expect(dialog).toContainText('factory/scripts/pre-commit.sh')
})
