# Factory architecture

How this repository turns a request into merged, tested software, and where a
human is still required. Version 1: one operator, greenfield product, nothing in
production yet, Claude Code on a subscription.

## Principles

1. **The pipeline is fixed; agents fill the stages.** The order of work lives in
   `.claude/skills/work/SKILL.md`, not in an agent's judgment. An agent decides how
   to do its stage. It does not decide which stage is next or whether to skip one.
2. **Handoffs are files.** Each stage reads a file and writes a file. Nothing
   important is passed as a summary in conversation, because summaries drift and
   files can be validated, diffed and audited.
3. **Whoever wrote it does not judge it.** Tests come from the spec before the code
   exists. Review happens in a fresh context with no edit tools. "Green" is decided
   by scripts and CI, never by an agent's report of what it ran.
4. **Judgment goes to agents, checks go to tools.** Linting, types, tests, secret
   scanning and risk classification are deterministic. An LLM is not asked to do
   anything a script can do.
5. **Gates scale with how hard a change is to undo.** Most changes merge on
   evidence. A human reads the ones that are expensive to reverse, and audits the
   rest afterwards.
6. **Fix the factory, not just the product.** When an agent makes the same mistake
   twice, the correction goes into a prompt, a rule, a lint or a test.

## Roles

| Role | Version 1 | Why |
|---|---|---|
| Foreman (orchestrator) | Your main Claude Code session running `/work` | Routes, runs gates, enforces loop limits. Writes no product code. |
| Spec writer (PM) | `spec-writer` subagent | Ambiguity is the most expensive defect; it gets its own stage. |
| Test author (QA) | `test-author` subagent | Acceptance tests derived from the spec, committed before the build. |
| Builder (developer) | `builder` subagent | Minimal diff until the gates pass. |
| Reviewer | `reviewer` subagent, read-only | Fresh context, different model tier, includes a security pass. |
| Observer | `observer` subagent, once per run | Records what happened, with sources. Feeds `/reflect`. See `MEMORY.md`. |
| Security | CI tools: secret scan now, SAST and dependency audit when there is code | Deterministic first. An agent is added later for threat modelling R2 changes. |
| Architect | You, with Claude in plan mode, writing `docs/architecture.md` | On an empty repo there is nothing for an architect agent to be consistent with. |
| Product owner | You own BRIEF and ROADMAP; `/groom` proposes | "What to build" stays human even when "how" is automated. |
| Release / SRE | Not yet | There is nothing to release. Added at first deploy. |
| Docs, feedback, triage | Not yet | Added when there are users. |

Four working agents and one observer is deliberate. Every extra agent adds a handoff, and handoffs are
where context is lost. Add a role when the audit shows a recurring failure that
role would catch, not before.

## Pipeline

| # | Stage | Done by | Reads | Writes | Stops the run when |
|---|---|---|---|---|---|
| 0 | Intake | Foreman | Issue | Branch, `work/<id>-<slug>/` | Tree is dirty or main is stale |
| 1 | Spec | spec-writer | Issue, BRIEF, architecture | `spec.md` | Spec fails validation twice, has blocking questions, or is R3 |
| 2 | Tests | test-author | `spec.md` | `tests/acceptance/*`, commit with `Factory-Stage: tests` | A criterion is untestable after one spec revision |
| 3 | Build | builder | `spec.md`, tests | Code, `plan.md`, commit with `Factory-Stage: build` | Builder disputes a test and the test-author disagrees |
| 4 | Gate | Scripts | The branch | Pass or fail, risk tier | Still failing after 2 fix rounds |
| 5 | Review | reviewer | `spec.md`, diff | `review.md` | Verdict is `escalate`, or still `changes-required` after 2 rounds |
| 6 | Observe | observer | Work folder, transcripts | `memory/observations/<date>-<id>-<slug>.md` | Never |
| 7 | PR | Foreman | Everything above | Pull request with evidence and tier | Never: opens the PR, then merge policy applies |
| 8 | Merge | CI plus policy | Required checks, tier, label | Merge or wait | R2 without `human-approved`; any R3 |

Every stop writes `BLOCKED.md` saying what stopped and the smallest decision
needed. A stopped run is the system working. A run that never stops and merges
something wrong is the failure to design against.

## Risk tiers and human gates

| Tier | Examples | Who merges |
|---|---|---|
| R0 | Docs, copy, work records | Auto, once `AUTO_MERGE_MAX_TIER` is R0 or higher |
| R1 | Ordinary change inside existing boundaries (the default) | Auto, once `AUTO_MERGE_MAX_TIER` is R1 |
| R2 | Schema and migrations, dependencies, auth, architecture doc, the factory's own files, CI, infrastructure | You, by adding the `human-approved` label after reading the diff |
| R3 | Secrets, payments, destructive data operations | You, outside the pipeline. The factory stops. |

The tier is the highest of three sources: the spec's `risk_floor`, the path rules
in `factory/risk-rules.txt`, and the reviewer's assessment. Any source can raise
it. Nothing can lower it. CI classifies using the base branch's copy of the rules,
so a pull request cannot loosen the gate it has to pass.

What stays human regardless of tier:
- Product direction: `product/BRIEF.md` and the order of `product/ROADMAP.md`.
- Which issues get the `factory:ready` label.
- Changes to the factory itself: start the session with `FACTORY_ALLOW_SELF_EDIT=1`.
- The weekly audit (`/audit`), which is what makes auto-merge defensible.
- Reading the `/reflect` pull request, which is the only way the factory's memory changes.
- Raising `AUTO_MERGE_MAX_TIER`.

Before production, a bad merge costs a revert, so R0 and R1 can go to auto-merge
early. The R2 list should be reviewed, and probably widened, on the day real
users or real data arrive.

## Models and usage

The pattern is "the strongest model decides, cheaper models type" (known in the
community as the foreman or advisor pattern). The session model is the foreman.
`spec-writer` inherits it. `test-author` and `builder` run on `sonnet`. `reviewer`
runs on `opus`, so the code is not reviewed by the model tier that wrote it.

On a subscription every subagent request counts against the same usage limits as
the main session. A full run uses several times what a single session would. To
stay inside the limits: keep items small, let R0 items skip the test stage, and do
not parallelise until the single-item loop is boring.

Same-vendor review shares blind spots. Version 1 accepts that and compensates with
spec-derived tests, deterministic gates and the sampled human audit. A reviewer
from a second model vendor is a later upgrade for R2 changes.

## Context: what lives where

| Kind | Location | Loaded |
|---|---|---|
| Rules for every agent, commands, map of the repo | `CLAUDE.md` (keep it short) | Every session and subagent |
| Product intent | `product/BRIEF.md`, `ROADMAP.md` | Read by spec-writer and `/groom` |
| Structure and invariants | `docs/architecture.md` | Read by spec-writer, builder, reviewer |
| Decisions | `docs/decisions/` | On demand |
| Procedures | `.claude/skills/` | When invoked |
| Role behaviour | `.claude/agents/` | When that agent runs |
| Per-item record | `work/<id>-<slug>/` | The contract and the audit trail for that item |
| Ideas and objections | `product/INBOX.md` | When grooming |
| What the factory has learned | `memory/` (see `MEMORY.md`) | `lessons.md` always; observations only by `/reflect` |
| Live and per-item events | `.factory/events.jsonl` in the main checkout (one log shared by every worktree, appended under `.factory/events.lock`), `work/<id>-<slug>/events.jsonl` | By the control room and `/audit` |

There is no hidden state. If a session dies, the next one can resume from the
branch and the work folder. Adding a teammate means adding a reader of these same
files, plus CODEOWNERS for R2 paths.

## Boundaries, from weakest to strongest

1. Prompts: the rules in `CLAUDE.md` and each agent definition.
2. Tool limits: the reviewer has no edit tools.
3. Permission rules and the PreToolUse guard in `.claude/settings.json` and
   `factory/hooks/guard.sh`: no edits to the factory's own files, no `.env`
   writes, no force push, no push to main, no self-approval.
4. Branch protection with required checks: nothing merges red, whoever asks.
5. Credentials: the machine and the CI job that run agents hold no production
   secrets. This is the only layer that holds against a model that is confused or
   has been fed hostile input, so it is the one to be strict about.

Layers 1 to 3 prevent drift and honest mistakes. They are not a sandbox.

## Failure modes and what answers them

| Failure | What it looks like | Mitigation here |
|---|---|---|
| Builds the wrong thing | Clean code, wrong feature | Spec stage with testable criteria; assumptions recorded; blocking questions stop the run |
| Tests bent to pass | Green build, weakened assertions | Tests written before code by a different agent; acceptance lock script; reviewer checks for vacuous tests |
| Self-approval | Author declares its own work good | Read-only reviewer in fresh context on another model tier; gates run by scripts |
| Says it ran checks, did not | "All tests pass" with no run | Foreman and CI run `make check` themselves; agents' claims are not evidence |
| Scope creep | 900-line diff for a 30-line request | One item = one small PR; reviewer flags out-of-spec changes; extras go to INBOX |
| Infinite fix loop | Usage limit burned on one item | Hard caps: 2 gate rounds, 2 review rounds, then stop with BLOCKED.md |
| Agent edits its own guardrails | Rule relaxed in the same PR that needs it | Guard hook blocks the paths; those paths are R2; CI uses base-branch rules |
| Context rot | Later stages contradict the spec | Each subagent starts fresh from files; the spec path is passed, not a paraphrase |
| Architecture drift | Each change sensible, the whole incoherent | `docs/architecture.md` invariants; changes to it are R2; `/audit` looks for patterns |
| Prompt injection | Issue text or a fetched page gives instructions | Only human-labelled issues enter; no production credentials reachable; R2 gate on sensitive paths |
| Silent quality decay under auto-merge | Nobody reads anything any more | Weekly `/audit` with a random sample; autonomy lowered after any escaped defect |
| Supply chain | New dependency pulls in something hostile | New dependencies must be named in the spec; manifest changes are R2; dependency audit in CI |

## Growth path

Move to the next stage when the entry condition is true, not on a date.

**Stage 1, interactive (week 1).** You run `/work` in a terminal and read every
pull request. `AUTO_MERGE_MAX_TIER=none`. Goal: ten items through the pipeline,
and the prompts tuned on what went wrong.

**Stage 2, earned auto-merge.** Entry: ten consecutive items where your own review
found nothing the reviewer missed. Set `AUTO_MERGE_MAX_TIER=R0`, then `R1` after
another clean stretch. Start the weekly `/audit`.

**Stage 3, unattended.** Entry: auto-merge at R1 with two clean audits. Enable
`.github/workflows/factory.yml` so labelling an issue `factory:ready` runs the
pipeline in CI. Consider converting `/work` into a saved Claude Code workflow
script, which moves the stage order from a prompt into code and makes runs
resumable.

**Stage 4, first deploy.** Add a release skill: preview deploy per PR, staging,
feature flags, a rollback runbook that has been rehearsed. Deploy configuration is
R2. Production deploys start as a human button. Widen the R2 rules. Add a
security agent that writes a short threat model for every R2 change.

**Stage 5, production signals.** Add a triage agent that turns error-tracker
alerts and user feedback into issues labelled `factory:proposed`. It never
patches production directly; a signal becomes a work item and goes through the
same pipeline. Add a docs agent if docs lag.

**Stage 6, more people or more throughput.** Add CODEOWNERS on R2 paths, move CI
auth from a personal subscription token to an API key, run builders in parallel
in separate git worktrees, and add a second-vendor reviewer for R2.

## Changing the factory

The factory's own files (`.claude/`, `factory/`, `.github/`) are R2 and blocked
from normal sessions. To change them, start a session with
`FACTORY_ALLOW_SELF_EDIT=1 claude`, make the change on its own branch, and read
the diff yourself. Record why in `docs/decisions/` when the change alters a gate.
