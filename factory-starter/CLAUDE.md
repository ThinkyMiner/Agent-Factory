# <Product name>

<One paragraph: what this is and who it is for. Details live in product/BRIEF.md.>

## Commands (agents use these and nothing else to judge "green")
- `make check`  : <what it runs, e.g. lint, typecheck, unit tests>. Must pass before anything is pushed.
- `make accept` : acceptance tests in tests/acceptance/.
- `make dev`    : run the product locally.

## Where things are
- `product/`            what we are building and why. BRIEF.md and ROADMAP.md are human-owned.
- `docs/architecture.md` boundaries and invariants. Read it before changing structure.
- `docs/decisions/`     one short record per decision someone would later question.
- `work/<id>-<slug>/`   one folder per work item: spec.md, plan.md, review.md, log.md.
- `tests/acceptance/`   tests derived from specs. Only the test-author agent edits these.
- `memory/`             what the factory has learned. observations/ gets one file per work item from the observer,
                        lessons.md only by `/reflect` through a pull request.
- `factory/`, `.claude/`, `.github/`, `teams/`  the factory itself. Not part of product work.
- Team mode (only if `factory/teams.json` exists): each team writes only its own paths.
  See `docs/factory/TEAMS.md`.

## Conventions
<Fill in as they emerge. Keep this under 15 bullets. When a convention can be a lint
rule or a test, make it one and delete the bullet.>

## Rules for every agent
- Make the smallest diff that satisfies the acceptance criteria. No drive-by refactors.
- Never weaken, skip or delete a test to get green. If a test is wrong, write why in
  `work/<id>-<slug>/disputes.md` and stop.
- Only the test-author edits `tests/acceptance/`.
- No new dependency unless the spec's Assumptions section names it and says why.
- Never read or write `.env` files or anything that looks like a credential.
- If you are blocked, or unsure about something that cannot be undone, write
  `work/<id>-<slug>/BLOCKED.md` and stop. Stopping is a success state.
- Report what you ran and what you did not verify. Never say a check passed unless
  you ran it in this session and saw it pass.
- If the factory itself gets in your way (a skill, agent, hook, script, rule or the
  control room is wrong, unclear or missing something), report it where the kit is
  kept: search with `gh issue list -R ThinkyMiner/Agent-Factory --search "<words>"` and
  comment on a match, or else `gh issue create -R ThinkyMiner/Agent-Factory` saying what
  you were doing, what happened and what you expected. That repository is public:
  describe only the factory, never product code, product details or credentials.
  Then carry on.

## Lessons learned (maintained by /reflect; do not edit by hand in product work)
@memory/lessons.md
