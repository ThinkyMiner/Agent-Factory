// Token usage and model from Claude Code transcripts. The format is not a stable interface, so
// this reads defensively and says "unreadable" rather than guess:
//  - only files whose real path is under the transcripts root are opened;
//  - assistant lines carry message.usage; Claude Code writes one line per content block with
//    the same message id (streaming lines carry partial output), so usage is deduplicated on
//    (message.id, requestId), keeping the largest total (as ccusage does since #888);
//  - "<synthetic>" messages are skipped; a session's own file skips sidechain lines.
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { sep } from 'node:path'
import type { Store } from '../store.ts'

export interface Tokens {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
}

export type TranscriptSummary =
  | { ok: true; model?: string; models: string[]; tokens: Tokens; requests: number }
  | { ok: false; reason: string }

export function underRoot(path: string, root: string): string | null {
  try {
    const real = realpathSync(path)
    const r = realpathSync(root)
    return real === r || real.startsWith(r + sep) ? real : null
  } catch {
    return null
  }
}

export async function summarise(path: string, opts: { skipSidechain: boolean }): Promise<TranscriptSummary> {
  const best = new Map<string, { usage: Tokens; model?: string }>()
  let lines = 0
  let bad = 0
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    lines++
    if (!line.includes('"usage"')) continue
    let o: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      o = JSON.parse(line)
    } catch {
      bad++
      continue
    }
    if (o.type !== 'assistant' || !o.message?.usage) continue
    if (opts.skipSidechain && o.isSidechain) continue
    const model: string | undefined = typeof o.message.model === 'string' ? o.message.model : undefined
    if (model === '<synthetic>') continue
    const u = o.message.usage
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    const usage = { input: n(u.input_tokens), output: n(u.output_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens), total: 0 }
    usage.total = usage.input + usage.output + usage.cacheWrite + usage.cacheRead
    const key = `${o.message.id ?? `line${lines}`}:${o.requestId ?? ''}`
    const prev = best.get(key)
    if (!prev || usage.total > prev.usage.total) best.set(key, { usage, model })
  }
  if (!best.size) return { ok: false, reason: lines ? `no assistant usage found in ${lines} lines${bad ? ` (${bad} unparseable)` : ''}` : 'empty file' }
  const tokens: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 }
  const models = new Map<string, number>()
  for (const { usage, model } of best.values()) {
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'total'] as const) tokens[k] += usage[k]
    if (model) models.set(model, (models.get(model) ?? 0) + 1)
  }
  const sorted = [...models].sort((a, b) => b[1] - a[1]).map(([m]) => m)
  return { ok: true, model: sorted[0], models: sorted, tokens, requests: best.size }
}

/** Cached by path, size and mtime; a growing transcript is re-read. */
export async function transcriptSummary(store: Store, root: string, path: string | undefined, opts: { skipSidechain: boolean }): Promise<TranscriptSummary> {
  if (!path) return { ok: false, reason: 'no transcript path recorded' }
  const real = underRoot(path, root)
  if (!real) {
    try {
      statSync(path)
      return { ok: false, reason: 'transcript is outside the transcripts folder; not read' }
    } catch {
      return { ok: false, reason: 'transcript file not found' }
    }
  }
  const st = statSync(real)
  const key = `transcript:${real}:${opts.skipSidechain ? 'main' : 'all'}`
  const cached = store.get<{ size: number; mtime: number; summary: TranscriptSummary }>(key)
  if (cached && cached.value.size === st.size && cached.value.mtime === st.mtimeMs) return cached.value.summary
  const summary = await summarise(real, opts).catch((e: Error) => ({ ok: false as const, reason: `could not read: ${e.message}` }))
  store.put(key, { size: st.size, mtime: st.mtimeMs, summary })
  return summary
}
