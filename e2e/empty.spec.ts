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
})
