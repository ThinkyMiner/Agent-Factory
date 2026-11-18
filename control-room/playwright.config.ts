import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEMO_DIR = join(tmpdir(), 'control-room-e2e', 'demo')
export const EMPTY_DIR = join(tmpdir(), 'control-room-e2e', 'empty')
const PORT = 4399
export const EMPTY_URL = 'http://127.0.0.1:4398'
export const ACTIONS_DIR = join(tmpdir(), 'control-room-e2e', 'actions')
export const ACTIONS_URL = 'http://127.0.0.1:4397'
export const SCALED_DIR = join(tmpdir(), 'control-room-e2e', 'scaled')
export const SCALED_URL = 'http://127.0.0.1:4396'
export const TEAMS_DIR = join(tmpdir(), 'control-room-e2e', 'teams')
export const TEAMS_URL = 'http://127.0.0.1:4395'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  webServer: [
    {
      command: `node server/cli.ts --demo --demo-dir ${DEMO_DIR} --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}/api/state`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      command: `node e2e/make-empty.ts ${EMPTY_DIR} && node server/cli.ts ${EMPTY_DIR} --port 4398 --offline --data-dir ${EMPTY_DIR}-data`,
      url: `${EMPTY_URL}/api/state`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // a second demo with --actions on: its own copy, so the read-only tests never see a change
      command: `node server/cli.ts --demo --demo-dir ${ACTIONS_DIR} --port 4397 --actions`,
      url: `${ACTIONS_URL}/api/state`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // the demo plus thousands of rows, for e2e/perf.spec.ts
      command: `node e2e/serve-scaled.ts ${SCALED_DIR} 4396`,
      url: `${SCALED_URL}/api/state`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // a team-mode factory: planning cycle, feature, team worktrees, fake Herdr (e2e/teams.spec.ts)
      command: `node e2e/serve-teams.ts ${TEAMS_DIR} 4395`,
      url: `${TEAMS_URL}/api/state`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
