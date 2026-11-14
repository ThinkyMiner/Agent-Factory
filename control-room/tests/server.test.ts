// The HTTP server over the demo: read-only guarantees, Host checks, offline GitHub.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { generate } from '../demo/generate.ts'
import { Factory } from '../server/factory.ts'
import { startServer } from '../server/http.ts'
import { Store } from '../server/store.ts'
import { readFileSync } from 'node:fs'

const root = mkdtempSync(join(tmpdir(), 'cr-server-'))
const demo = generate(join(root, 'demo'))
const web = join(root, 'web')
mkdirSync(web)
writeFileSync(join(web, 'index.html'), '<html><head></head><body>app</body></html>')

function call(url: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}) {
  const u = new URL(url)
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: { host: opts.host ?? u.host, ...opts.headers } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('offline GitHub', () => {
  test('with a cache: local state plus GitHub data marked stale with its fetch time', async () => {
    const dataDir = join(root, 'data-cached')
    const store = new Store(dataDir)
    store.put('github', JSON.parse(readFileSync(demo.github, 'utf8')), '2026-11-13T05:00:00.000Z')
    store.close()
    const f = new Factory({ repo: demo.repo, dataDir, staleMinutes: 30, github: { kind: 'off', reason: 'started with --offline' }, transcriptsRoot: demo.transcripts })
    await f.start()
    expect(f.state.snap.github).toMatchObject({ state: 'stale', fetchedAt: '2026-11-13T05:00:00.000Z', error: 'started with --offline' })
    expect(f.state.byId.get('32')!.state).toBe('awaiting-approval')
    f.stop()
  })
  test('without a cache: local state only, GitHub unavailable, merged items still found from main', async () => {
    const f = new Factory({ repo: demo.repo, dataDir: join(root, 'data-empty'), staleMinutes: 30, github: { kind: 'off', reason: 'no network' }, transcriptsRoot: demo.transcripts })
    await f.start()
    expect(f.state.snap.github.state).toBe('unavailable')
    expect(f.state.byId.get('14')!.state).toBe('merged')
    expect(f.state.byId.get('23')!.state).toBe('blocked')
    expect(f.state.byId.get('34')!.state).toBe('pr-open') // from the pr event alone
    expect(f.state.byId.get('37')).toBeUndefined() // ready items exist only on GitHub
    f.stop()
  })
})

describe('http server (read-only)', () => {
  let f: Factory
  let srv: Awaited<ReturnType<typeof startServer>>
  beforeAll(async () => {
    f = new Factory({ repo: demo.repo, dataDir: join(root, 'data-http'), staleMinutes: 30, github: { kind: 'demo', path: demo.github }, transcriptsRoot: demo.transcripts })
    await f.start()
    srv = await startServer(f, { port: 4380, webDir: web, actions: false, demo: true })
  })
  afterAll(async () => {
    f.stop()
    await srv.close()
  })

  test('binds to 127.0.0.1 only', () => {
    expect((srv.server.address() as { address: string }).address).toBe('127.0.0.1')
  })
  test('serves state and items', async () => {
    const r = await call(`${srv.url}/api/state`)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).items).toHaveLength(36)
    expect((await call(`${srv.url}/api/items/32`)).status).toBe(200)
    expect((await call(`${srv.url}/api/items/999`)).status).toBe(404)
  })
  test('every non-GET method on every path is refused, and nothing changes', async () => {
    const before = (await call(`${srv.url}/api/state`)).body
    const githubBefore = readFileSync(demo.github, 'utf8')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/state', '/api/items/32', '/api/factory/file', '/api/memory', '/api/actions/approve', '/api/actions/mark-ready', '/api/actions/answer', '/', '/board']) {
        const r = await call(`${srv.url}${path}`, { method, headers: { 'content-type': 'application/json', origin: srv.url, 'x-control-room-token': srv.token }, body: '{"pr":132,"issue":37}' })
        expect(r.status, `${method} ${path}`).toBe(405)
      }
    }
    expect((await call(`${srv.url}/api/state`)).body).toBe(before)
    expect(readFileSync(demo.github, 'utf8')).toBe(githubBefore)
    // a request that would pass every check with actions on: same origin, same site, the token, JSON
    for (const [name, body] of [['mark-ready', { issue: 40 }], ['approve', { pr: 132, headSha: 'a'.repeat(40), confirm: 'approve #132' }], ['answer', { issue: 23, body: 'x' }]] as const) {
      const r = await call(`${srv.url}/api/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.url, 'sec-fetch-site': 'same-origin', 'x-control-room-token': srv.token }, body: JSON.stringify(body) })
      expect(r.status, name).toBe(405)
    }
    expect((await call(`${srv.url}/api/actions/approve?pr=132`)).status).toBe(404)
    expect(readFileSync(demo.github, 'utf8')).toBe(githubBefore)
    expect(JSON.parse((await call(`${srv.url}/api/actions/log`)).body)).toEqual([])
    expect(JSON.parse((await call(`${srv.url}/api/state`)).body).factory.actions).toBe(false)
  })
  test('a request for another Host is refused (DNS rebinding)', async () => {
    expect((await call(`${srv.url}/api/state`, { host: 'evil.example' })).status).toBe(421)
    expect((await call(`${srv.url}/api/state`, { host: `localhost:${new URL(srv.url).port}` })).status).toBe(200)
  })
  test('diffs only for files in the item’s change list', async () => {
    expect((await call(`${srv.url}/api/items/32/diff?file=db/migrations/0007_audit_log.sql`)).status).toBe(200)
    expect((await call(`${srv.url}/api/items/32/diff?file=${encodeURIComponent('../../../../etc/passwd')}`)).status).toBe(404)
    expect((await call(`${srv.url}/api/items/32/diff?file=factory/policy.env`)).status).toBe(404)
  })
  test('factory files only for paths the loader listed', async () => {
    const r = await call(`${srv.url}/api/factory/file?path=factory/risk-rules.txt`)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).diff).toContain('+R2 src/reports/*')
    for (const p of ['../../../../etc/passwd', 'factory/../../../etc/passwd', '/etc/passwd', 'src/index.ts', 'work/23-delete-account/spec.md'])
      expect((await call(`${srv.url}/api/factory/file?path=${encodeURIComponent(p)}`)).status, p).toBe(404)
    for (const p of ['/api/memory', '/api/improvement', '/api/factory', '/api/audits']) expect((await call(`${srv.url}${p}`)).status, p).toBe(200)
  })
  test('static paths cannot leave the web build', async () => {
    for (const p of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../server/cli.ts']) {
      const r = await call(`${srv.url}${p}`)
      expect(r.body, p).not.toMatch(/"name": "control-room"|root:|parseArgs/)
    }
  })
  test('security headers and the per-launch token in the app shell', async () => {
    const r = await call(`${srv.url}/board`)
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/)
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.body).toContain(`<meta name="cr-token" content="${srv.token}">`)
  })
})
