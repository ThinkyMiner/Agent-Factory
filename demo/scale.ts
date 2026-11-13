// Stacks synthetic history onto a generated demo, so the app can be measured with thousands of
// rows: stage events and agent runs on #28, observations, and proposed issues on the fake GitHub.
// Used by e2e/serve-scaled.ts and e2e/perf.spec.ts. Timestamps are in the past, so the current
// state of every demo item stays what the demo says it is.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STAGES = ['intake', 'spec', 'tests', 'build', 'gate', 'review', 'observe', 'pr']
const DAY = 86_400_000

export function scale(demo: { repo: string; github: string }, n = { events: 10_000, runs: 2_000, observations: 3_000, issues: 1_000 }, nowMs = Date.now()) {
  const from = nowMs - 40 * DAY
  const to = nowMs - 2 * DAY
  const at = (i: number, of: number) => new Date(from + ((to - from) * i) / of).toISOString().replace(/\.\d+Z$/, 'Z')
  const lines: string[] = []
  for (let i = 0; i < n.events; i++) {
    lines.push(JSON.stringify({ ts: at(i, n.events), type: 'stage', work_id: '28', branch: 'work/28-edit-expense', stage: STAGES[Math.floor(i / 2) % STAGES.length], status: i % 2 ? 'passed' : 'started', round: String(Math.floor(i / 16)) }))
  }
  for (let i = 0; i < n.runs; i++) {
    const base = { type: 'lifecycle', work_id: '28', branch: 'work/28-edit-expense', session_id: 'scale-session', agent_type: 'builder', agent_id: `scale${i}` }
    lines.push(JSON.stringify({ ts: at(2 * i, 2 * n.runs), ...base, event: 'SubagentStart' }))
    lines.push(JSON.stringify({ ts: at(2 * i + 1, 2 * n.runs), ...base, event: 'SubagentStop' }))
  }
  appendFileSync(join(demo.repo, '.factory/events.jsonl'), lines.join('\n') + '\n')

  const dir = join(demo.repo, 'memory/observations')
  mkdirSync(dir, { recursive: true })
  const perFile = 10
  for (let f = 0; f < n.observations / perFile; f++) {
    const id = 1000 + f
    const obs = Array.from({ length: perFile }, (_, k) => `- [${['high', 'med', 'low'][k % 3]}] (${['spec', 'tests', 'build', 'gate', 'review', 'process', 'codebase'][(f + k) % 7]}) Synthetic observation ${f * perFile + k} about item ${id}: retry ${k}. Source: work/${id}-scaled/log.md`)
    writeFileSync(join(dir, `${at(f, n.observations / perFile).slice(0, 10)}-${id}-scaled.md`), `# scaled #${id}\noutcome: ready-for-pr\n\n${obs.join('\n')}\n`)
  }

  const gh = JSON.parse(readFileSync(demo.github, 'utf8'))
  for (let i = 0; i < n.issues; i++) {
    gh.issues.push({ number: 1000 + i, title: `Scaled proposal ${i}: ${['export', 'filter', 'audit', 'invite', 'budget'][i % 5]} something`, state: 'OPEN', labels: ['factory:proposed'], createdAt: at(i, n.issues), url: `https://github.com/demo/tally/issues/${1000 + i}`, body: '', labelEvents: [] })
  }
  writeFileSync(demo.github, JSON.stringify(gh))
}
