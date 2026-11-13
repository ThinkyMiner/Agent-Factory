// The factory's own files: config (CLAUDE.md, .claude/, factory/, .github/), memory, reflections
// and audits. The copy shown is main's (what CI and every new /work run use), overlaid with local
// changes: commits on the checked-out branch since it left main, and uncommitted edits. Those are
// flagged, so an edit CI will not see is visible. A branch that is merely behind main is not drift.
// Never follows a symlink; skips anything large.
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as g from './git.ts'
import type { Drift, MetaFile } from '../core/meta.ts'

export const META_PATHS = ['CLAUDE.md', '.claude', 'factory', '.github', 'memory/lessons.md', 'memory/reflections', 'docs/factory']
const LOCAL_ONLY = ['.claude/settings.local.json'] // usually git-ignored, and it still changes what agents may do
const SKIP = /(^|\/)(node_modules|worktrees|\.git)(\/|$)|(^|\/)\.gitkeep$/ // .claude/worktrees holds whole checkouts
const MAX_BYTES = 512 * 1024
const MAX_FILES = 2000

// git's blob id for some bytes, so comparing with main needs no extra git call.
// ponytail: assumes no autocrlf/clean filters; a Windows checkout would show every local file as modified
const blobSha = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')

/** undefined: missing or a symlink (never followed); null: too large. */
async function readSafe(repo: string, rel: string): Promise<Buffer | null | undefined> {
  const st = await lstat(join(repo, rel)).catch(() => null)
  if (!st?.isFile()) return undefined
  return st.size > MAX_BYTES ? null : readFile(join(repo, rel)).catch(() => undefined)
}

async function walk(repo: string, rel: string, out: Map<string, Buffer | null>) {
  if (out.size >= MAX_FILES || SKIP.test(rel)) return
  const st = await lstat(join(repo, rel)).catch(() => null)
  if (!st || st.isSymbolicLink()) return
  if (st.isDirectory()) {
    for (const name of (await readdir(join(repo, rel)).catch(() => [])).sort()) await walk(repo, `${rel}/${name}`, out)
  } else if (st.isFile()) {
    const b = await readSafe(repo, rel)
    if (b !== undefined) out.set(rel, b)
  }
}

const names = (out: string, strip = 0) => new Set(out.split('\0').filter(Boolean).map((l) => l.slice(strip)))

export async function loadMeta(repo: string, isGit: boolean, main: string | null): Promise<MetaFile[]> {
  if (!isGit || !main) {
    // nothing to compare with: the working tree as it is
    const work = new Map<string, Buffer | null>()
    for (const p of META_PATHS) await walk(repo, p, work)
    return [...work].sort(([a], [b]) => a.localeCompare(b)).map(([path, b]) => ({ path, drift: 'same' as const, text: b ? b.toString('utf8') : null, mainText: null }))
  }
  const onMain = new Map((await g.lsTree(repo, main, META_PATHS)).filter((e) => !SKIP.test(e.path)).map((e) => [e.path, e.sha]))
  const base = (await g.git(repo, ['merge-base', main, 'HEAD']).catch(() => '')).trim()
  const branch = base ? names(await g.git(repo, ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--', ...META_PATHS])) : new Set<string>()
  const uncommitted = names(await g.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...META_PATHS]), 3)
  for (const p of LOCAL_ONLY) if ((await readSafe(repo, p)) !== undefined) uncommitted.add(p)
  const local = new Set([...branch, ...uncommitted].filter((p) => !SKIP.test(p)))
  const blobs = await g.readBlobs(repo, [...onMain.values()])

  const out: MetaFile[] = []
  for (const path of [...new Set([...onMain.keys(), ...local])].sort().slice(0, MAX_FILES)) {
    const ms = onMain.get(path)
    const mainText = ms ? (blobs.get(ms) ?? null) : null
    if (!local.has(path)) {
      out.push({ path, drift: 'same', text: mainText, mainText })
      continue
    }
    const buf = await readSafe(repo, path)
    const drift: Drift | null = buf === undefined ? (ms ? 'deleted' : null) : !ms ? 'added' : buf && blobSha(buf) === ms ? 'same' : 'modified'
    if (!drift) continue // created and removed again locally, or a symlink
    out.push({
      path,
      drift,
      ...(drift !== 'same' && { where: uncommitted.has(path) ? ('uncommitted' as const) : ('branch' as const) }),
      text: buf ? buf.toString('utf8') : buf === null ? null : mainText,
      mainText,
    })
  }
  return out
}

/** One file's changes against main, for a path the loader listed (the caller checks). */
export async function metaDiff(repo: string, main: string, path: string): Promise<string> {
  return g.git(repo, ['diff', '--no-color', '--no-ext-diff', main, '--', path]).catch(() => '')
}
