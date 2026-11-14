// A port of factory/scripts/classify-risk.sh, so the control room never executes code from
// the factory repo. tests/risk.test.ts runs the real script over the same inputs to prove parity.
import type { Tier } from './types.ts'

export interface RiskRule {
  tier: number
  pattern: string
  re: RegExp
}

export interface FileRisk {
  path: string
  tier: Tier
  pattern: string | null // null: no rule matched, default R1
}

/** bash [[ $f == $pat ]] glob: * matches anything including "/", ? one char, [...] a class. */
export function globToRegExp(pat: string): RegExp {
  let re = ''
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '\\' && i + 1 < pat.length) re += escape(pat[++i]!)
    else if (c === '[') {
      const close = pat.indexOf(']', i + 2)
      if (close < 0) {
        re += '\\['
        continue
      }
      let body = pat.slice(i + 1, close)
      const neg = body[0] === '!' || body[0] === '^'
      if (neg) body = body.slice(1)
      re += `[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/^\]/, '\\]')}]`
      i = close
    } else re += escape(c)
  }
  return new RegExp(`^${re}$`, 's')
}
const escape = (c: string) => c.replace(/[.+^${}()|[\]\\/-]/g, '\\$&')

/** Same reading as the script: `while read -r t pat _`, skipping blanks and comments. */
export function parseRiskRules(text: string): RiskRule[] {
  const rules: RiskRule[] = []
  for (const line of text.split('\n')) {
    const [t, pat] = line.trim().split(/\s+/)
    if (!t || t.startsWith('#') || !pat) continue
    const m = /^R(\d+)$/.exec(t)
    if (!m) continue // the script's integer test fails for these, so they never match
    rules.push({ tier: Number(m[1]), pattern: pat, re: globToRegExp(pat) })
  }
  return rules
}

export function classifyFile(path: string, rules: RiskRule[]): FileRisk {
  let tier = -1
  let pattern: string | null = null
  for (const r of rules) {
    if (r.tier > tier && r.re.test(path)) {
      tier = r.tier
      pattern = r.pattern
    }
  }
  return { path, tier: `R${tier < 0 ? 1 : Math.min(tier, 3)}` as Tier, pattern }
}

/** Highest tier over all files. An empty change is R0, as in the script. */
export function classify(paths: string[], rules: RiskRule[]): { tier: Tier; files: FileRisk[] } {
  const files = paths.filter(Boolean).map((p) => classifyFile(p, rules))
  const max = files.reduce((m, f) => Math.max(m, Number(f.tier.slice(1))), 0)
  return { tier: `R${max}` as Tier, files }
}
