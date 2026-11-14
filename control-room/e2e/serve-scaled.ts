// The demo plus thousands of synthetic rows (demo/scale.ts), served read-only for e2e/perf.spec.ts.
// usage: node e2e/serve-scaled.ts <dir> <port>
import { join } from 'node:path'
import { generate } from '../demo/generate.ts'
import { scale } from '../demo/scale.ts'
import { Factory } from '../server/factory.ts'
import { startServer } from '../server/http.ts'

const [dir, port] = process.argv.slice(2) as [string, string]
const d = generate(dir)
scale(d)
const f = new Factory({ repo: d.repo, dataDir: join(dir, '.data'), staleMinutes: 30, github: { kind: 'demo', path: d.github }, transcriptsRoot: d.transcripts })
const t = performance.now()
await f.start()
console.log(`scaled demo: first full read in ${Math.round(performance.now() - t)} ms`)
const srv = await startServer(f, { port: Number(port), webDir: join(import.meta.dirname, '..', 'dist', 'web'), actions: false, demo: true })
console.log(srv.url)
