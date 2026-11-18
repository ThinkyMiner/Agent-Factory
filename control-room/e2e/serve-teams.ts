// The team-mode fixture (tests/teams-fixture.ts), with its fake Herdr first on PATH, served read-only for e2e/teams.spec.ts.
// usage: node e2e/serve-teams.ts <dir> <port>
import { join } from 'node:path'
import { makeTeamsFactory } from '../tests/teams-fixture.ts'
import { Factory } from '../server/factory.ts'
import { startServer } from '../server/http.ts'

const [dir, port] = process.argv.slice(2) as [string, string]
const fx = makeTeamsFactory(dir)
process.env.PATH = `${fx.bin}:${process.env.PATH}`
const f = new Factory({ repo: fx.repo, dataDir: join(dir, '.data'), staleMinutes: 30, github: { kind: 'demo', path: fx.github }, transcriptsRoot: join(dir, 'transcripts') })
await f.start()
const srv = await startServer(f, { port: Number(port), webDir: join(import.meta.dirname, '..', 'dist', 'web'), actions: false, demo: false })
console.log(srv.url)
