// control-room <factory-path> | --demo   [--stale-minutes N] [--print]
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { generate } from '../demo/generate.ts'
import { COLUMNS } from './core/derive.ts'
import { computeState, readDemoGitHub } from './state.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    demo: { type: 'boolean', default: false },
    'stale-minutes': { type: 'string', default: '30' },
    print: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const USAGE = `usage: npm start -- <factory-repo-path> [options]
       npm start -- --demo [options]

  --demo               generate a fake factory in ~/.control-room/demo and open it
  --stale-minutes N    a run with no event for N minutes needs you (default 30)
  --print              print the derived board and exit`

if (values.help || (!values.demo && positionals.length !== 1)) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 2)
}
const staleMinutes = Number(values['stale-minutes'])
if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
  console.error('--stale-minutes must be a positive number')
  process.exit(2)
}

let repo: string
let gh
if (values.demo) {
  const out = join(homedir(), '.control-room', 'demo')
  const d = generate(out)
  repo = d.repo
  gh = await readDemoGitHub(d.github)
} else {
  repo = resolve(positionals[0]!)
  if (!existsSync(repo)) {
    console.error(`no such directory: ${repo}`)
    process.exit(2)
  }
  gh = { status: { state: 'unavailable' as const, error: 'GitHub is not wired up yet (phase 1)' } }
}

const s = await computeState(repo, gh, { staleMinutes })
console.log(`factory ${repo}${s.snap.isGit ? '' : ' (not a git repo)'} · policy AUTO_MERGE_MAX_TIER=${s.snap.autoMergeMax} · GitHub ${s.snap.github.state}`)
console.log(`\nNEEDS YOU (${s.needsYou.length})`)
for (const n of s.needsYou) console.log(`  ${n.kind.padEnd(13)} #${n.id.padEnd(4)} ${n.summary}`)
console.log(`\nRUNNING (${s.running.length})`)
for (const r of s.running) console.log(`  #${r.workId.padEnd(4)} ${String(r.stage).padEnd(7)} ${r.agentType}`)
for (const col of COLUMNS) {
  const items = s.items.filter((i) => i.column === col)
  console.log(`\n${col.toUpperCase()} (${items.length})`)
  for (const i of items) console.log(`  #${i.id.padEnd(4)} ${(i.tier ?? '--').padEnd(3)} ${i.state.padEnd(18)} ${i.title}${i.flags.length ? `  [${i.flags.join(', ')}]` : ''}`)
}
if (!s.items.length) console.log('\nNo work items yet. Run /groom, label an issue factory:ready, then /work <id>.')
const notices = [...s.snap.notices, ...s.items.flatMap((i) => i.notices)]
if (notices.length) {
  console.log(`\nNOTICES (${notices.length})`)
  for (const n of notices) console.log(`  ${n.level.padEnd(5)} ${n.source}: ${n.message}`)
}
