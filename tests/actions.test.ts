// Actions (--actions): every guard on the way in, each action's own checks, the log, and that the
// gh calls are argument arrays with free text on stdin. The flag-off case is in server.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { generate } from '../demo/generate.ts'
import { Factory } from '../server/factory.ts'
import { startServer } from '../server/http.ts'
import { Actions, demoWriter, ghWriter } from '../server/actions.ts'

const root = mkdtempSync(join(tmpdir(), 'cr-actions-'))
const demo = generate(join(root, 'demo'))
const web = join(root, 'web')
mkdirSync(web)
writeFileSync(join(web, 'index.html'), '<html><head></head><body>app</body></html>')
const dataDir = join(root, 'data')

function call(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const u = new URL(url)
  return new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: { host: u.host, ...opts.headers } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode!, json: body ? JSON.parse(body) : {} }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('with --actions (demo GitHub)', () => {
  let f: Factory
  let srv: Awaited<ReturnType<typeof startServer>>
  let actions: Actions
  const post = (name: string, body: unknown, headers: Record<string, string> = {}) =>
    call(`${srv.url}/api/actions/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.url, 'sec-fetch-site': 'same-origin', 'x-control-room-token': srv.token, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const github = () => JSON.parse(readFileSync(demo.github, 'utf8'))

  beforeAll(async () => {
    f = new Factory({ repo: demo.repo, dataDir, staleMinutes: 30, github: { kind: 'demo', path: demo.github }, transcriptsRoot: demo.transcripts })
    await f.start()
    actions = new Actions(f, demoWriter(demo.github), dataDir)
    srv = await startServer(f, { port: 4390, webDir: web, actions, demo: true })
  })
  afterAll(async () => {
    f.stop()
    await srv.close()
  })

  test('refused without the token, from another origin or site, or not JSON; nothing changes; every refusal is logged', async () => {
    const before = readFileSync(demo.github, 'utf8')
    const cases: [Record<string, string>, number][] = [
      [{ 'x-control-room-token': '' }, 403],
      [{ 'x-control-room-token': 'x'.repeat(srv.token.length) }, 403],
      [{ origin: 'http://evil.example' }, 403],
      [{ origin: 'null' }, 403],
      [{ origin: `http://127.0.0.1:${Number(new URL(srv.url).port) + 1}` }, 403],
      [{ 'sec-fetch-site': 'cross-site' }, 403],
      [{ 'sec-fetch-site': 'same-site' }, 403],
      [{ 'content-type': 'text/plain' }, 415],
      [{ 'content-type': 'application/x-www-form-urlencoded' }, 415],
    ]
    for (const [h, status] of cases) expect((await post('mark-ready', { issue: 40 }, h)).status, JSON.stringify(h)).toBe(status)
    expect((await post('mark-ready', 'x'.repeat(70 * 1024))).status).toBe(413)
    expect((await post('mark-ready', '{not json')).status).toBe(400)
    expect(readFileSync(demo.github, 'utf8')).toBe(before)
    const log = Actions.readLog(dataDir)
    expect(log.slice(0, cases.length + 2).every((e) => e.outcome === 'refused')).toBe(true)
    expect(readFileSync(actions.logPath, 'utf8')).not.toContain(srv.token)
  })

  test('unknown actions and unexpected fields are refused', async () => {
    expect((await post('start-run', { item: 37 })).status).toBe(404)
    expect((await post('mark-ready', { issue: 40, label: 'human-approved' })).status).toBe(400)
    expect((await post('mark-ready', { issue: '40' })).status).toBe(400)
  })

  test('mark ready: #40 moves from proposed to ready; twice is refused', async () => {
    expect(f.state.byId.get('40')!.state).toBe('proposed')
    const r = await post('mark-ready', { issue: 40 })
    expect(r).toMatchObject({ status: 200, json: { ok: true } })
    expect(github().issues.find((i: { number: number }) => i.number === 40).labels).toContain('factory:ready')
    expect(f.state.byId.get('40')!.state).toBe('ready')
    expect((await post('mark-ready', { issue: 40 })).status).toBe(409)
    expect((await post('mark-ready', { issue: 999 })).status).toBe(404)
  })

  test('approve: the preview shows tier, R2 paths and review; a wrong confirmation or a moved head is refused', async () => {
    const p = (await call(`${srv.url}/api/actions/approve?pr=132`)).json
    expect(p).toMatchObject({ ok: true, tier: 'R2', confirm: 'approve #132', item: { id: '32' } })
    expect(p.r2Files.map((x: { path: string }) => x.path)).toContain('db/migrations/0007_audit_log.sql')
    expect(p.review).toHaveProperty('verdict')
    expect((await post('approve', { pr: 132, headSha: p.headSha, confirm: 'approve 132' })).status).toBe(400)
    const moved = await post('approve', { pr: 132, headSha: 'f'.repeat(40), confirm: 'approve #132' })
    expect(moved.status).toBe(409)
    expect(moved.json.message).toContain('new commits')
    expect(github().pulls.find((x: { number: number }) => x.number === 132).labels).not.toContain('human-approved')

    const ok = await post('approve', { pr: 132, headSha: p.headSha, confirm: 'approve #132' })
    expect(ok).toMatchObject({ status: 200, json: { ok: true } })
    expect(github().pulls.find((x: { number: number }) => x.number === 132).labels).toContain('human-approved')
    expect(f.state.byId.get('32')!.state).not.toBe('awaiting-approval')
    expect(f.state.needsYou.some((n) => n.id === '32' && n.kind === 'approve')).toBe(false)
    expect((await post('approve', { pr: 132, headSha: p.headSha, confirm: 'approve #132' })).status).toBe(409)
  })

  test('approve is only for R2: R1 does not need it', async () => {
    const p = (await call(`${srv.url}/api/actions/approve?pr=134`)).json
    expect(p.ok).toBe(false)
    const r = await post('approve', { pr: 134, headSha: p.headSha, confirm: 'approve #134' })
    expect(r.status).toBe(409)
    expect(r.json.message).toContain('does not need human-approved')
  })

  test('answer: only for a blocked item, never empty; the text is logged', async () => {
    expect((await post('answer', { issue: 23, body: '   ' })).status).toBe(400)
    expect((await post('answer', { issue: 14, body: 'hello' })).status).toBe(409)
    const r = await post('answer', { issue: 23, body: 'Yes: delete the expenses too.' })
    expect(r).toMatchObject({ status: 200, json: { ok: true } })
    expect(Actions.readLog(dataDir)[0]).toMatchObject({ action: 'answer', outcome: 'done', input: { issue: 23, body: 'Yes: delete the expenses too.' } })
  })

  test('the log endpoint lists attempts newest first', async () => {
    const log = (await call(`${srv.url}/api/actions/log`)).json as unknown as { action: string }[]
    expect(log[0]!.action).toBe('answer')
    expect(log.length).toBeGreaterThan(10)
  })
})

test('gh writer: argument arrays only; the answer text goes through stdin, never argv', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'cr-fake-gh-'))
  const log = join(bin, 'calls.jsonl')
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n')
  if (process.argv[2] === 'pr' && process.argv[3] === 'view') process.stdout.write(JSON.stringify({ headRefOid: 'abc1234', state: 'OPEN', labels: [{ name: 'risk:R2' }] }))
})
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const w = ghWriter(bin, async () => 'owner/repo')
    const evil = '$(touch /tmp/pwned) --repo evil/x\n`id`; rm -rf ~'
    await w.comment(23, evil)
    await w.addLabel('pr', 132, 'human-approved')
    await w.addLabel('issue', 40, 'factory:ready')
    expect(await w.pullHead(132)).toEqual({ sha: 'abc1234', state: 'OPEN', labels: ['risk:R2'] })
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(calls).toEqual([
      { argv: ['issue', 'comment', '23', '--repo', 'owner/repo', '--body-file', '-'], stdin: evil },
      { argv: ['pr', 'edit', '132', '--repo', 'owner/repo', '--add-label', 'human-approved'], stdin: '' },
      { argv: ['issue', 'edit', '40', '--repo', 'owner/repo', '--add-label', 'factory:ready'], stdin: '' },
      { argv: ['pr', 'view', '132', '--repo', 'owner/repo', '--json', 'headRefOid,state,labels'], stdin: '' },
    ])
  } finally {
    process.env.PATH = path
  }
})
