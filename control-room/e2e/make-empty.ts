// A fresh factory: the kit with no history, not even a git repo. Used by e2e/empty.spec.ts.
import { cpSync, rmSync } from 'node:fs'
const out = process.argv[2]!
rmSync(out, { recursive: true, force: true })
cpSync(new URL('../demo/template', import.meta.url), out, { recursive: true })
