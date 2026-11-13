// The TypeScript port must classify exactly like factory/scripts/classify-risk.sh.
import { describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classify, classifyFile, globToRegExp, parseRiskRules } from '../server/core/risk.ts'

const script = fileURLToPath(new URL('../demo/template/factory/scripts/classify-risk.sh', import.meta.url))
const rulesPath = fileURLToPath(new URL('../demo/template/factory/risk-rules.txt', import.meta.url))
const rules = parseRiskRules(readFileSync(rulesPath, 'utf8'))

const PATHS = [
  'docs/guide.md', 'README.md', 'src/x.ts', 'src/auth/login.ts', 'src/authz.ts', 'db/migrations/0001_init.sql', 'migrations/2.sql',
  '.env', '.env.local', 'config/.env.production', 'package.json', 'web/package.json', '.github/workflows/ci.yml', 'factory/policy.env',
  'memory/observations/2026-01-01-1-x.md', 'memory/lessons.md', 'memory/reflections/2026-01-01.md', 'work/12-x/spec.md', 'work/12-x/events.jsonl',
  'src/payment_service.ts', 'src/billing/x.ts', 'Dockerfile', 'Dockerfile.dev', 'infra/main.tf', 'scripts/deploy.sh', 'src/schema.ts',
  'CLAUDE.md', 'product/INBOX.md', 'product/BRIEF.md', 'src/my file.ts', 'src/[id].tsx', 'Makefile', 'go.mod', 'src/credentials.ts',
]

describe('classify-risk parity', () => {
  test('per-file tiers and patterns match the real script', () => {
    // stdout: the overall tier; stderr: "R<n>  <path>  (<pattern>)" per file
    const r = spawnSync('bash', [script, '--stdin'], { input: PATHS.join('\n') + '\n', env: { ...process.env, RISK_RULES: rulesPath }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    const scriptRows = r.stderr.trim().split('\n').map((l) => {
      const m = /^(R\d)  (.*)  \((.*)\)$/.exec(l)!
      return { path: m[2], tier: m[1], pattern: m[3] === 'no rule, default' ? null : m[3] }
    })
    expect(PATHS.map((p) => classifyFile(p, rules))).toEqual(scriptRows)
    expect(classify(PATHS, rules).tier).toBe(r.stdout.trim())
  })
  test('an empty change is R0, as in the script', () => {
    expect(classify([], rules).tier).toBe('R0')
  })
})

describe('globToRegExp', () => {
  test('bash [[ == ]] semantics: * crosses "/", classes and negation', () => {
    expect(globToRegExp('docs/*').test('docs/a/b.md')).toBe(true)
    expect(globToRegExp('*.md').test('a/b.md')).toBe(true)
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true)
    expect(globToRegExp('[!a]*').test('abc')).toBe(false)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
  test('comment lines and non-tier tokens are ignored', () => {
    expect(parseRiskRules('# R2 x\nfoo bar\nR2 *.sql\n').map((r) => r.pattern)).toEqual(['*.sql'])
  })
})
