---
name: reflect
description: Turn accumulated observations into a small, evidenced pull request that improves the factory (lessons, rules, prompts, checks). Invoke manually after /audit, in a session started with FACTORY_ALLOW_SELF_EDIT=1.
argument-hint: "[since YYYY-MM-DD, default: last reflection]"
disable-model-invocation: true
---

# /reflect: improve the factory from its own record

Since: $ARGUMENTS

Observations are raw and cheap. Lessons are loaded into every run and are
expensive. Your job is to move as little as possible from the first to the
second, and to prefer enforcement over memory wherever you can.

This skill edits the factory's own files, so it only works in a session started
with `FACTORY_ALLOW_SELF_EDIT=1`. If the guard blocks you, stop and say so.

## 1. Read
- Files in `memory/observations/` dated after the last file in `memory/reflections/`
  (or after the argument). File names start with the date.
- `memory/lessons.md`, the latest `docs/factory/audits/` report, and the last
  reflection, including what it predicted.

## 2. Check last time's changes first
For each change in the previous reflection, compare its "how we will know" with
what the observations since then show. Mark it worked, no effect, or made things
worse. Propose reverting anything that did not work. A factory that only ever
adds rules gets slower and more confused.

## 3. Find patterns
Group observations by cause, not by symptom. A pattern needs at least two work
items as evidence. A single incident qualifies only if it was [high] and the
consequence would have been serious, and you must label it "single occurrence".
Ignore anything already covered by a lesson, rule or check.

## 4. Choose the strongest fix that fits
In this order of preference:
1. A test, type or lint rule in the product (cannot be forgotten).
2. A check in `factory/scripts/` or the guard hook (cannot be skipped).
3. A path-scoped rule in `.claude/rules/` (loads only where relevant).
4. An edit to one agent's prompt in `.claude/agents/` (affects one stage).
5. A line in `memory/lessons.md` (affects everyone, every run: last resort).
Also look for lessons that can now be promoted up this ladder and deleted, and
lessons with no supporting observation in the last 60 days, which should be removed.

## 5. Open one pull request, at most five changes
- Branch `factory/reflect-<YYYY-MM-DD>`, label `factory:improvement`.
- `memory/reflections/<YYYY-MM-DD>.md` listing for each change: the pattern,
  the evidence (work item ids and observation lines), the change, the expected
  effect, and "how we will know" as something countable in future observations
  or audit numbers.
- The changes themselves.
- Never change `factory/policy.env`, the risk tiers of existing rules, or
  branch protection. Never weaken a gate. If the evidence says a gate is wrong,
  write that in the reflection for the human to decide.

This pull request is R2 by path. The human reads it; that review is what keeps
the factory's memory honest.

## 6. Report
What you proposed, what you chose not to propose and why, and which earlier
changes worked.
