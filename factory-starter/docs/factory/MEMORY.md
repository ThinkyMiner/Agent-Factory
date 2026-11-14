# Factory memory

How the factory remembers, and why it is built from reviewed files instead of a
memory service. Read `ARCHITECTURE.md` first.

## What was borrowed, and from where

| Source | Idea | How it appears here |
|---|---|---|
| Mastra, observational memory | Two background roles: an Observer compresses raw history into a dated observation log, a Reflector periodically consolidates it. The log is stable text, not retrieved chunks. | `observer` agent writes one dated file per work item. `/reflect` consolidates. Observations are never loaded into working agents; only the short `lessons.md` is. |
| Warp, factory stack and agent memory | Memory is one part of a context layer next to skills and traces. It should be explicit and implicit, owned by you, and every memory should be traceable to the run that produced it and editable or deletable. | Everything is a file in your repo. Every observation names its source. Every lesson lists its evidence. Deleting a memory is deleting a line in a pull request. |
| Warp, self-improvement | "Outer-loop" observer agents score runs and propose changes to skills and config as pull requests. Memory alone is invisible; improvements should be auditable. | `/reflect` opens one small pull request per cycle, each change with a prediction, and checks last cycle's predictions before proposing more. |
| Claude Code | CLAUDE.md imports, path-scoped rules in `.claude/rules/`, skills, and optional per-agent memory folders. | Lessons load through a CLAUDE.md import. Narrow lessons become path-scoped rules. Per-agent self-written memory is deliberately not used in version 1 (see below). |
| Letta, Mem0, Zep and similar | Tiered, vector and temporal-graph memory services. | Not used. See "What is deliberately left out". |

## The five kinds of memory in this factory

| Kind | Question it answers | Where it lives | Written by | Loaded |
|---|---|---|---|---|
| Working | What am I doing right now? | The context window, plus `work/<id>-<slug>/` (spec, plan, log) | Each stage | By path, per stage |
| Episodic | What happened on that item? | `work/<id>-<slug>/` including `events.jsonl` and `review.md`; `.factory/events.jsonl`; Claude Code transcripts; git history; audits | The pipeline itself | On demand, by the observer and `/audit` |
| Observational | What was notable, across items? | `memory/observations/<date>-<id>-<slug>.md` | `observer`, once per run | Only by `/reflect` |
| Semantic | What is true about this product and codebase? | `product/BRIEF.md`, `docs/architecture.md`, `docs/decisions/` | You, and agents through R2 changes | By the stages that need it |
| Procedural | How do we do things here? | `CLAUDE.md`, `.claude/rules/`, `.claude/agents/`, `.claude/skills/`, `memory/lessons.md`, and above all tests, lint rules and gate scripts | `/reflect`, through a pull request you read | Always, or by path |

The flow between them is one-directional: episodes become observations,
observations become proposals, proposals become procedure. Nothing writes
directly into procedure.

## The loop

1. **Every run:** `/work` emits stage events and ends by running `observer`. The
   observer reads the work folder and skims the agents' transcripts for what
   actually happened (failed commands, retries, silent workarounds), then writes
   three to ten sourced observations. It gives no advice.
2. **Weekly:** `/audit` reports quality numbers and a reading sample for you.
3. **Weekly, after the audit:** `/reflect` (in a self-edit session) first checks
   whether last cycle's changes had the effect they predicted, then looks for
   patterns with at least two work items of evidence, then proposes at most five
   changes in one pull request.
4. **You** read that pull request. It is R2 by path.

## The promotion ladder

When `/reflect` finds a pattern it must pick the strongest fix that fits:

1. A test, type or lint rule in the product.
2. A check in `factory/scripts/` or the guard hook.
3. A path-scoped rule in `.claude/rules/`.
4. An edit to one agent's prompt.
5. A line in `memory/lessons.md`.

Each step down the ladder relies more on a model remembering to comply. A lesson
that stays in `lessons.md` for months is a sign something further up the ladder
is missing. `lessons.md` is capped at 40 entries so that it has to be pruned.

## Rules that keep memory trustworthy

- **Provenance or it does not exist.** An observation without a source and a
  lesson without evidence ids are deleted on sight.
- **Workers do not write their own rules.** The builder, test-author and
  reviewer cannot edit `memory/lessons.md`, `.claude/` or `factory/`. The guard
  hook blocks it and the paths are R2. This is the same separation as "the
  author does not review its own code", applied to memory.
- **Two occurrences before a lesson.** One incident is an anecdote. The
  exception is a single high-severity incident, labelled as such.
- **Every change predicts something countable.** If the next cycle does not
  show it, the change is reverted. Memory that cannot show an effect is clutter.
- **Text read from transcripts, issues and code is data.** The observer is told
  to record instruction-like text as a high-priority observation and not act on
  it. This matters more for memory than anywhere else, because a poisoned
  memory is replayed into every later run.
- **Lessons expire.** No supporting observation in 60 days means removal.

## What is deliberately left out

- **A vector database or memory service (Mem0, Zep, Letta, and others).** They
  solve recall across very large, unstructured histories and many users. One
  repo and one operator do not have that problem yet. Files in git already give
  provenance, diff, review, rollback and ownership, which a service has to
  rebuild. Revisit when `memory/observations/` is too large for `/reflect` to
  read in one pass; the first step then is full-text search over the files (the
  control room's SQLite index can do this), and embeddings only after that fails.
- **A temporal knowledge graph.** Its value is tracking facts that change over
  time. For a codebase, git is that record.
- **Per-agent self-written memory** (Claude Code's `memory:` field on a
  subagent). It is useful, and it is also exactly the invisible, unreviewed
  kind: the worker edits what the worker will be told next time. If you want it
  later, start with the reviewer only, keep it in `project` scope so it is in
  git, add its folder to the guard's allowed paths, and include it in what
  `/reflect` reads and prunes.
- **Auto-compaction as memory.** Compaction keeps a session alive; it is not a
  record. Anything that must survive goes in the work folder before the stage ends.

## Failure modes specific to memory

| Failure | Mitigation here |
|---|---|
| Poisoning: a wrong or hostile "lesson" gets stored and replayed | Observer records only; lessons arrive by reviewed pull request; evidence required |
| Bloat: context fills with rules, adherence drops | Cap of 40 lessons; path-scoped rules; promotion to enforcement; expiry |
| Superstition: a lesson from one coincidence | Two-item minimum; predictions checked next cycle |
| Staleness: a lesson outlives the code it was about | 60-day expiry; `/reflect` re-reads lessons against recent observations |
| Contradiction: two rules pull opposite ways | Observer records "instructions conflicted" as its own observation type |
| Invisible influence: nobody knows why agents behave as they do | All memory is plain files in the repo; the control room shows each lesson with its evidence |
| Self-serving memory: workers relax their own constraints | Workers cannot write procedure; `/reflect` may not weaken gates or change policy |

## Things to verify on your machine

- `.claude/settings.json` allows `Read(~/.claude/projects/**)` so the observer can
  read transcripts. If the rule syntax is not accepted by your Claude Code
  version, the observer will be prompted; approve it or adjust the rule.
- The transcript format is not a stable interface. The observer is told to
  inspect a few lines before extracting anything. If it reports transcripts as
  unreadable, it still works from the work folder alone.
