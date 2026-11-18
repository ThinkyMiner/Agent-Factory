// The HTTP server: 127.0.0.1 only, Host-checked, read-only unless actions are enabled.
// Static files are served from a map built from the web build directory, so a request path
// can never reach anything else on disk.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { Factory } from './factory.ts'
import { Actions } from './actions.ts'
import { summary, type ApiState } from './core/api.ts'

export interface ServerOptions {
  port: number // preferred; the next 20 are tried, then any free port
  webDir: string
  actions: Actions | false // false: read-only; nothing that changes anything is even constructed
  demo: boolean
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
}
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ')

function loadAssets(dir: string, token: string) {
  const assets = new Map<string, { body: Buffer; type: string; immutable: boolean }>()
  const walk = (d: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else assets.set('/' + relative(dir, p).split('\\').join('/'), { body: readFileSync(p), type: TYPES[extname(p)] ?? 'application/octet-stream', immutable: p.includes(`${join(dir, 'assets')}`) })
    }
  }
  walk(dir)
  const index = assets.get('/index.html')
  if (index) index.body = Buffer.from(index.body.toString('utf8').replace('</head>', `<meta name="cr-token" content="${token}"></head>`))
  return assets
}

export async function startServer(factory: Factory, opts: ServerOptions): Promise<{ server: Server; url: string; token: string; close: () => Promise<void> }> {
  const token = randomBytes(24).toString('base64url') // per launch; used by actions (phase 4)
  let assets = loadAssets(opts.webDir, token)
  let port = 0
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`))
  const tokenOk = (t: string) => t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
    res.end(text)
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-security-policy', CSP)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('cross-origin-opener-policy', 'same-origin')
    res.setHeader('cross-origin-resource-policy', 'same-origin')
    // DNS rebinding: a page on evil.example that resolves to 127.0.0.1 sends Host: evil.example
    if (!allowedHosts().has(req.headers.host ?? '')) {
      req.resume()
      return send(res, 421, 'misdirected request', { connection: 'close' })
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    if (req.method === 'POST' && opts.actions && path.startsWith('/api/actions/')) return action(opts.actions, req, res, path.slice('/api/actions/'.length).slice(0, 64))
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.resume() // drain any body so the connection closes cleanly
      // No write endpoints exist unless actions are enabled (phase 4), and even then only under /api/actions/.
      // answered before the body is read, so the socket cannot be reused: say so
      return send(res, 405, { error: 'read-only: this control room was started without --actions' }, { allow: 'GET, HEAD', connection: 'close' })
    }

    if (path.startsWith('/api/')) {
      try {
        if (path === '/api/state') return send(res, 200, apiState(factory, opts))
        if (path === '/api/stream') return stream(factory, req, res)
        if (path === '/api/runs') return send(res, 200, await factory.runs())
        if (path === '/api/quality') {
          const weeks = Math.min(52, Math.max(4, Number(url.searchParams.get('weeks')) || 12))
          return send(res, 200, await factory.quality(weeks))
        }
        if (path === '/api/actions/log') return send(res, 200, Actions.readLog(factory.dataDir))
        if (path === '/api/actions/approve') {
          if (!opts.actions) return send(res, 404, { ok: false, message: 'actions are off: start the control room with --actions' })
          const r = opts.actions.approvePreview(Number(url.searchParams.get('pr')))
          return send(res, r.status, r.body)
        }
        if (path === '/api/memory') return send(res, 200, factory.memory())
        if (path === '/api/improvement') return send(res, 200, factory.improvement())
        if (path === '/api/factory') return send(res, 200, factory.factory())
        if (path === '/api/audits') return send(res, 200, factory.audits())
        if (path === '/api/teams') return send(res, 200, factory.teams())
        if (path === '/api/factory/file') {
          const f = await factory.factoryFile(url.searchParams.get('path') ?? '')
          return f ? send(res, 200, f) : send(res, 404, { error: 'not a factory file' })
        }
        const item = /^\/api\/items\/([A-Za-z0-9._]+)$/.exec(path)
        if (item) {
          const d = await factory.itemDetail(item[1]!)
          return d ? send(res, 200, d) : send(res, 404, { error: `no item #${item[1]}` })
        }
        const diff = /^\/api\/items\/([A-Za-z0-9._]+)\/diff$/.exec(path)
        if (diff) {
          const file = url.searchParams.get('file') ?? ''
          const text = await factory.diff(diff[1]!, file)
          return text === null ? send(res, 404, { error: 'no diff for that file' }) : send(res, 200, text)
        }
        return send(res, 404, { error: 'not found' })
      } catch (e) {
        console.error(`control-room: ${path}: ${(e as Error).stack}`)
        return send(res, 500, { error: 'internal error; see the server log' })
      }
    }

    // static files, then the app shell for client-side routes
    let asset = assets.get(path)
    if (!asset && process.env.CONTROL_ROOM_DEV) {
      assets = loadAssets(opts.webDir, token)
      asset = assets.get(path)
    }
    if (!asset && !extname(path)) asset = assets.get('/index.html')
    if (!asset) return send(res, path === '/' || !extname(path) ? 503 : 404, path === '/' ? 'The web app is not built. Run: npm run build' : 'not found')
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : asset.body)
  }

  // A change: same origin (Origin and Sec-Fetch-Site), the per-launch token, JSON, small. Every
  // attempt, refused or not, goes to the action log.
  const action = async (a: Actions, req: IncomingMessage, res: ServerResponse, name: string) => {
    const deny = (status: number, message: string) => {
      req.resume()
      a.log({ action: name, outcome: 'refused', status, message })
      return send(res, status, { ok: false, message }, { connection: 'close' })
    }
    if (!allowedOrigins().has(req.headers.origin ?? '')) return deny(403, 'refused: the request did not come from this page (Origin)')
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin') return deny(403, `refused: a ${site} request (Sec-Fetch-Site)`)
    if (!tokenOk(String(req.headers['x-control-room-token'] ?? ''))) return deny(403, 'refused: missing or wrong per-launch token')
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return deny(415, 'refused: the body must be JSON')
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length
      if (size > 64 * 1024) return deny(413, 'refused: the body is over 64 KB')
      chunks.push(c)
    }
    let body: unknown
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return deny(400, 'refused: the body is not valid JSON')
    }
    const r = await a.run(name, body)
    return send(res, r.status, r.body)
  }

  const server = createServer((req, res) => void handler(req, res))
  for (const candidate of [...Array.from({ length: 21 }, (_, i) => opts.port + i), 0]) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(candidate, '127.0.0.1', () => resolve(true))
    })
    if (ok) {
      port = (server.address() as { port: number }).port
      break
    }
  }
  if (!port) throw new Error('could not bind a port on 127.0.0.1')
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

function apiState(f: Factory, opts: ServerOptions): ApiState {
  const s = f.state
  return {
    version: f.version,
    factory: { repo: f.repo, demo: opts.demo, isGit: s.snap.isGit, head: s.snap.head, main: s.snap.main, autoMergeMax: s.snap.autoMergeMax, staleMinutes: f.opts.staleMinutes, actions: !!opts.actions, teams: !!s.teams },
    github: s.snap.github,
    items: s.items.map(summary),
    needsYou: s.needsYou,
    running: s.running,
    notices: [...s.snap.notices, ...(f.watchError ? [{ level: 'warn' as const, source: 'watcher', message: f.watchError }] : [])],
    now: s.ctx.now,
  }
}

function stream(f: Factory, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write(`retry: 2000\nevent: changed\ndata: ${JSON.stringify({ version: f.version, reason: 'connected' })}\n\n`)
  const off = f.subscribe((c) => res.write(`event: changed\ndata: ${JSON.stringify(c)}\n\n`))
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  req.on('close', () => {
    off()
    clearInterval(beat)
  })
}
