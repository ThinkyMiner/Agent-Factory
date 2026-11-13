// Performance smoke at scale: 1,036 items, ~15,000 events, ~2,200 agent runs, ~3,000 observations
// (demo/scale.ts). Lists are virtualised, so the DOM stays small and pages stay quick. Thresholds are
// generous so the test is about "responsive", not a benchmark; the measured numbers are printed.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { SCALED_DIR, SCALED_URL } from '../playwright.config'

test.use({ baseURL: SCALED_URL })

test('thousands of rows stay responsive, and a live change still lands quickly', async ({ page }) => {
  const m: Record<string, number> = {}
  const time = async (key: string, fn: () => Promise<unknown>) => {
    const t = Date.now()
    await fn()
    m[key] = Date.now() - t
  }

  await time('api-state-ms', async () => {
    const r = await page.request.get('/api/state')
    m['api-state-kb'] = Math.round((await r.body()).length / 1024)
  })

  await time('board-ms', async () => {
    await page.goto('/board')
    await expect(page.getByRole('region', { name: /^Proposed/ }).getByRole('listitem').first()).toBeVisible()
  })

  await time('activity-ms', async () => {
    await page.goto('/items/28/activity')
    await expect(page.getByRole('list', { name: 'Events and commits, newest first' }).getByRole('listitem').first()).toBeVisible()
  })
  const list = page.getByRole('list', { name: 'Events and commits, newest first' })
  const total = Number(/\((\d+)\)/.exec((await page.getByRole('heading', { name: /^Events and commits/ }).innerText()) ?? '')?.[1])
  expect(total).toBeGreaterThan(10_000)
  m['activity-dom-rows'] = await list.getByRole('listitem').count()
  expect(m['activity-dom-rows']).toBeLessThan(150)
  await time('activity-scroll-to-end-ms', async () => {
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight))
    await expect(list.locator(`[data-index="${total - 1}"]`)).toBeVisible()
  })

  await time('runs-ms', async () => {
    await page.goto('/runs')
    await expect(page.getByRole('table', { name: 'Agent runs' }).getByRole('row').nth(1)).toBeVisible()
  })
  m['runs-dom-rows'] = await page.getByRole('table', { name: 'Agent runs' }).getByRole('row').count()
  expect(m['runs-dom-rows']).toBeLessThan(150)

  await page.goto('/memory/observations')
  await expect(page.getByRole('list', { name: 'Observations' }).getByRole('listitem').first()).toBeVisible()
  await time('observation-search-ms', async () => {
    await page.getByRole('searchbox', { name: 'Search observations' }).fill('observation 2999 ')
    await expect(page.getByText(/^1 of \d{4,}$/)).toBeVisible()
  })

  await page.goto('/board')
  const inProgress = page.getByRole('region', { name: /^In progress/ })
  await expect(page.getByRole('region', { name: /^Ready/ }).getByRole('listitem').filter({ hasText: '#39' })).toBeVisible()
  await time('live-update-ms', async () => {
    appendFileSync(join(SCALED_DIR, 'repo', '.factory/events.jsonl'), JSON.stringify({ ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), type: 'stage', work_id: '39', branch: 'main', stage: 'intake', status: 'started', round: '0' }) + '\n')
    await expect(inProgress.getByRole('listitem').filter({ hasText: '#39' })).toBeVisible({ timeout: 5000 })
  })

  console.log(`perf at scale: ${JSON.stringify(m)}`)
  expect(m['board-ms']).toBeLessThan(5000)
  expect(m['activity-ms']).toBeLessThan(4000)
  expect(m['runs-ms']).toBeLessThan(4000)
  expect(m['observation-search-ms']).toBeLessThan(1500)
  expect(m['live-update-ms']).toBeLessThan(3000)
})
