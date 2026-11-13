// Read-only git access. Every call is execFile with an argument array (never a shell), and
// GIT_OPTIONAL_LOCKS=0 so reading never takes the index lock from under a running factory.
import { execFile, spawn } from 'node:child_process'

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }

export function git(repo: string, args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { env: ENV, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`), { code: (err as { code?: unknown }).code }))
      else resolve(stdout)
    })
  })
}

const ok = async (p: Promise<string>) => p.then((s) => s, () => null)

export const isRepo = async (repo: string) => (await ok(git(repo, ['rev-parse', '--is-inside-work-tree'])))?.trim() === 'true'
export const headBranch = async (repo: string) => (await ok(git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])))?.trim() || null

export async function mainRef(repo: string): Promise<string | null> {
  for (const r of ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (await ok(git(repo, ['rev-parse', '--verify', '-q', r]))) return r.replace(/^refs\/(heads|remotes)\//, '')
  }
  return null
}

export interface Branch {
  name: string // work/<id>-<slug>
  ref: string // the ref to read from (local name or origin/...)
  sha: string
  time: string
}

/** Local and origin work/* branches; a local branch wins over its remote twin. */
export async function workBranches(repo: string): Promise<Branch[]> {
  const out = await ok(git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)', 'refs/heads/work', 'refs/remotes/origin/work']))
  const byName = new Map<string, Branch>()
  for (const line of (out ?? '').split('\n')) {
    const [full, sha, time] = line.split('\0')
    if (!full || !sha) continue
    const local = full.startsWith('refs/heads/')
    const name = full.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '')
    if (!/^work\/[A-Za-z0-9._]+-[A-Za-z0-9._-]+$/.test(name)) continue
    if (byName.has(name) && !local) continue
    byName.set(name, { name, ref: local ? name : `origin/${name}`, sha, time: time ?? '' })
  }
  return [...byName.values()]
}

export interface TreeEntry {
  sha: string
  path: string
}

export async function lsTree(repo: string, ref: string, paths: string[]): Promise<TreeEntry[]> {
  const out = await ok(git(repo, ['ls-tree', '-r', '-z', ref, '--', ...paths]))
  return (out ?? '')
    .split('\0')
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf('\t')
      const [, type, sha] = l.slice(0, tab).split(' ')
      return type === 'blob' ? { sha: sha!, path: l.slice(tab + 1) } : null
    })
    .filter((x): x is TreeEntry => x !== null)
}

/** Read many blobs through one `git cat-file --batch` process. Results are cached by SHA. */
const blobCache = new Map<string, string>()
export function readBlobs(repo: string, shas: string[]): Promise<Map<string, string>> {
  const want = [...new Set(shas)].filter((s) => !blobCache.has(s))
  const result = () => new Map(shas.map((s) => [s, blobCache.get(s) ?? '']))
  if (!want.length) return Promise.resolve(result())
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['-C', repo, 'cat-file', '--batch'], { env: ENV })
    const chunks: Buffer[] = []
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.on('error', reject)
    p.on('close', () => {
      const buf = Buffer.concat(chunks)
      let pos = 0
      for (const sha of want) {
        const nl = buf.indexOf(10, pos)
        if (nl < 0) break
        const header = buf.subarray(pos, nl).toString()
        const size = Number(header.split(' ')[2])
        if (header.endsWith('missing') || Number.isNaN(size)) {
          pos = nl + 1
          continue
        }
        blobCache.set(sha, buf.subarray(nl + 1, nl + 1 + size).toString('utf8'))
        pos = nl + 1 + size + 1
      }
      resolve(result())
    })
    p.stdin.end(want.join('\n') + '\n')
  })
}

export async function lastCommitTime(repo: string, ref: string, path: string): Promise<string | null> {
  return (await ok(git(repo, ['log', '-1', '--format=%cI', ref, '--', path])))?.trim() || null
}

export interface Commit {
  sha: string
  time: string
  subject: string
  body: string
  files: string[]
}

/** Commits on a ref (newest first) with the files each one touched. */
export async function commits(repo: string, range: string, max = 3000): Promise<Commit[]> {
  const out = await ok(git(repo, ['log', `-n${max}`, '--no-merges', '--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f', '--name-only', range]))
  const list: Commit[] = []
  for (const rec of (out ?? '').split('\x1e')) {
    if (!rec.trim()) continue
    const [sha, time, subject, body, files] = rec.split('\x1f')
    list.push({ sha: sha!, time: time!, subject: subject!, body: body ?? '', files: (files ?? '').split('\n').map((s) => s.trim()).filter(Boolean) })
  }
  return list
}

/** Paths under `paths` that are modified or untracked in the working tree. */
export async function dirtyPaths(repo: string, paths: string[]): Promise<Set<string>> {
  const out = await ok(git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]))
  return new Set((out ?? '').split('\0').filter((l) => l.length > 3).map((l) => l.slice(3)))
}

export async function changedFiles(repo: string, base: string, ref: string): Promise<string[]> {
  const out = await ok(git(repo, ['diff', '--name-only', '-z', `${base}...${ref}`]))
  return (out ?? '').split('\0').filter(Boolean)
}
