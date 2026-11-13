// control-room <factory-path> | --demo   [options]
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { generate } from '../demo/generate.ts'
import { COLUMNS } from './core/derive.ts'
import { Factory, type FactoryOptions } from './factory.ts'
import { startServer } from './http.ts'
import { Actions, demoWriter, ghWriter } from './actions.ts'
import { repoSlug } from './sources/github.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'dist', 'web')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    demo: { type: 'boolean', default: false },
    'demo-dir': { type: 'string' },
    'data-dir': { type: 'string' },
    port: { type: 'string', default: '4317' },
    'stale-minutes': { type: 'string', default: '30' },
    offline: { type: 'boolean', default: false },
    'github-interval': { type: 'string', default: '60' },
    open: { type: 'boolean', default: false },
    print: { type: 'boolean', default: false },
    actions: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const USAGE = `usage: npm start -- <factory-repo-path> [options]
       npm start -- --demo [options]

  --demo                 generate a fake factory in ~/.control-room/demo and open that
  --demo-dir DIR         where --demo writes its factory (it is replaced on every start)
  --port N               preferred port on 127.0.0.1 (default 4317; the next free one is used if taken)
  --stale-minutes N      a run with no event for N minutes needs you (default 30)
  --data-dir DIR         where the cache lives (default ~/.control-room/<repo>-<hash>; safe to delete)
  --offline              do not call GitHub; show cached GitHub data as stale
  --github-interval S    seconds between GitHub refreshes (default 60)
  --actions              allow changes: mark an issue ready, approve an R2 pull request, answer a
                         blocked question. Off by default; every attempt is logged.
  --open                 open the browser
  --print                print the derived board and exit`

const fail = (msg: string): never => {
  console.error(`${msg}\n\n${USAGE}`)
  process.exit(2)
}
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}
if (!values.demo && positionals.length !== 1) fail('give a factory repo path, or --demo')
const num = (name: string, v: string, min: number) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < min) fail(`--${name} must be a number >= ${min}`)
  return n
}
const staleMinutes = num('stale-minutes', values['stale-minutes']!, 1)
const port = num('port', values.port!, 1)

let opts: FactoryOptions
if (values.demo) {
  const out = resolve(values['demo-dir'] ?? join(homedir(), '.control-room', 'demo'))
  const d = generate(out)
  opts = { repo: d.repo, dataDir: join(out, '.data'), staleMinutes, github: { kind: 'demo', path: d.github }, transcriptsRoot: d.transcripts }
} else {
  const repo = resolve(positionals[0]!)
  if (!existsSync(repo) || !statSync(repo).isDirectory()) fail(`not a directory: ${repo}`)
  opts = {
    repo,
    dataDir: values['data-dir'] ? resolve(values['data-dir']) : undefined,
    staleMinutes,
    github: values.offline ? { kind: 'off', reason: 'started with --offline' } : { kind: 'gh', intervalMs: num('github-interval', values['github-interval']!, 10) * 1000 },
    transcriptsRoot: join(homedir(), '.claude', 'projects'),
  }
}

const factory = new Factory(opts)
await factory.start()

if (values.print) {
  const s = factory.state
  console.log(`factory ${opts.repo}${s.snap.isGit ? '' : ' (not a git repo)'} · AUTO_MERGE_MAX_TIER=${s.snap.autoMergeMax} · GitHub ${s.snap.github.state}`)
  console.log(`\nNEEDS YOU (${s.needsYou.length})`)
  for (const n of s.needsYou) console.log(`  ${n.kind.padEnd(13)} #${n.id.padEnd(4)} ${n.summary}`)
  for (const col of COLUMNS) {
    const items = s.items.filter((i) => i.column === col)
    console.log(`\n${col.toUpperCase()} (${items.length})`)
    for (const i of items) console.log(`  #${i.id.padEnd(4)} ${(i.tier ?? '--').padEnd(3)} ${i.state.padEnd(18)} ${i.title}${i.flags.length ? `  [${i.flags.join(', ')}]` : ''}`)
  }
  factory.stop()
  process.exit(0)
}

if (!existsSync(join(WEB, 'index.html'))) {
  console.log('Building the web app (first run)...')
  const { build } = await import('vite')
  await build({ configFile: join(ROOT, 'vite.config.ts'), logLevel: 'warn' })
}

const gh = opts.github
const actions =
  values.actions &&
  new Actions(factory, gh.kind === 'demo' ? demoWriter(gh.path) : ghWriter(opts.repo, () => repoSlug(opts.repo)), factory.dataDir)
const srv = await startServer(factory, { port, webDir: WEB, actions, demo: values.demo! })
console.log(`control room for ${opts.repo}\n  ${srv.url}\n  ${actions ? `ACTIONS ON (mark ready, approve, answer); every attempt is logged to ${actions.logPath}` : 'read-only'} · GitHub: ${gh.kind === 'gh' ? `every ${values['github-interval']} s` : gh.kind}`)
if (values.open) execFile('open', [srv.url], () => {})

const shutdown = async () => {
  factory.stop()
  await srv.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
