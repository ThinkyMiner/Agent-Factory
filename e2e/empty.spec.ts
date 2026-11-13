// A new factory with zero items should look intentional and say what to do next.
import { expect, test } from '@playwright/test'
import { EMPTY_URL } from '../playwright.config'

test('a new factory: next steps, no GitHub data, every screen has an empty state', async ({ page }) => {
  await page.goto(EMPTY_URL + '/')
  await expect(page.getByRole('heading', { name: 'This factory has no work items yet' })).toBeVisible()
  await expect(page.getByText('No GitHub data.')).toBeVisible()
  await expect(page.getByText('not a git repository yet')).toBeVisible()
  await page.screenshot({ path: 'docs/screenshots/empty-factory.png' })
  await page.goto(EMPTY_URL + '/board')
  await expect(page.getByText('No work items yet')).toBeVisible()
  await page.goto(EMPTY_URL + '/runs')
  await expect(page.getByText('No agent runs recorded')).toBeVisible()
  await page.goto(EMPTY_URL + '/quality')
  await expect(page.getByText('No history yet')).toBeVisible()
  await page.goto(EMPTY_URL + '/memory')
  await expect(page.getByText('No lessons yet')).toBeVisible()
  await page.goto(EMPTY_URL + '/memory/observations')
  await expect(page.getByText('No observations yet')).toBeVisible()
  await page.goto(EMPTY_URL + '/improvement')
  await expect(page.getByText('GitHub data unavailable')).toBeVisible()
  await expect(page.getByText('No predictions recorded')).toBeVisible()
  await page.goto(EMPTY_URL + '/factory')
  await expect(page.getByRole('region', { name: 'Agents' })).toContainText('reviewer')
  await expect(page.getByRole('status', { name: 'Differences from main' })).toHaveCount(0)
  await page.goto(EMPTY_URL + '/audits')
  await expect(page.getByText('No audits yet')).toBeVisible()
})
