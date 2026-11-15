---
name: work
description: Run one work item through the factory pipeline (spec, acceptance tests, build, gate, review, pull request). Invoke manually with an issue number or a one-line request.
argument-hint: "[issue-number | one-line request]"
disable-model-invocation: true
---

# /work: one item through the pipeline

Work item: $ARGUMENTS

You are the foreman for this item. You route work, run the gate scripts and decide
what happens next. You do not write product code or tests yourself, and you do not
change the order of the stages. Each subagent starts with no memory of this
conversation, so give it file paths (the spec is the contract), never your own
paraphrase of the task. Wait for each subagent to finish before starting the next.

Every delegation starts a new subagent, fix rounds included: a fix round goes to a
new `builder` given the spec path and the exact findings, never to the builder that
wrote the code. Never resume a subagent and never message one with SendMessage. A
fresh builder reads the code and the failure as they are, not its earlier reasoning.

Keep a running record in `<work folder>/log.md`: one line per stage with the
outcome and the loop count.

Also emit a structured event when each stage starts and when it ends, so the
control room and the audit can read the run without parsing prose:

    factory/scripts/emit-event.sh stage work_id=<id> stage=<name> status=<status> round=<n> detail="<one line>"

Stage names: intake, spec, tests, build, gate, review, pr, observe.
Statuses: started, passed, failed, blocked, skipped. Use `round` for fix rounds
(0 for the first attempt). On the pr stage add `tier=<R0..R3>` and `pr=<number>`.

## 0. Intake
- If the argument is a number, read it with `gh issue view <n>`. Otherwise create
  an issue from the text with `factory/scripts/item.sh create --title "<outcome>"`, the
  text on stdin, and use the number it prints as the id.
- Require a clean working tree. If it is not, stop and say so.
- In team mode, take a build slot: `factory/scripts/slot.sh acquire`. Exit 3 means every
  slot is taken: stop at once and say so (nothing else to clean up). Once you hold a slot,
  release it (`factory/scripts/slot.sh release`) when you finish step 7 or stop.
- `git fetch origin`, then create branch `work/<id>-<slug>` from `origin/main`
  (`git switch -c work/<id>-<slug> origin/main`; it works the same in a team's
  worktree, where `main` itself is checked out elsewhere), and folder `work/<id>-<slug>/`.

## 1. Spec
- Delegate to `spec-writer` with the issue text and the work folder path. In team
  mode (`$FACTORY_TEAM` is set) also give it the team: the spec's `team:` line decides
  whose paths the item may change. Outside team mode the spec has no `team:` line.
- Run `factory/scripts/validate-spec.sh <work folder>/spec.md`.
  - Exit 1 (malformed): send the output back to `spec-writer` once. Still failing: stop.
  - Exit 3 (blocking questions): write the questions in `BLOCKED.md` and stop (outside
    team mode, also post them as an issue comment). Do not guess the answers.
- If the spec lists Follow-ups, create one issue per follow-up with
  `factory/scripts/item.sh create --proposed --title "<outcome>"` (the follow-up on stdin).
- If `risk_floor` is R3, stop. R3 changes are made by the human.

## 2. Acceptance tests
- Skip only if the spec has `tests: none` (documentation-only items).
- Delegate to `test-author` with the spec path.
- If it reports untestable criteria, send them to `spec-writer` once, then rerun.

## 3. Build
- Delegate to `builder` with the spec path.
- If it wrote `disputes.md`, send the dispute to a new `test-author` once. If they still
  disagree, stop and escalate to the human with both positions.
- In team mode, a write the guard blocks because another team owns the path is not
  something to work around: stop, write `BLOCKED.md` naming the paths and their team, and
  ask that team with a ticket: `factory/scripts/ticket.sh create --to <team> --type request
  --needs "..." --why "..." --blocks "#<id>" --done "..."`.

## 4. Gate (run these yourself; trust them over any agent's summary)
Before each run, emit `stage=gate status=started round=<n>` (0, then 1 and 2 for fix
rounds), and after it `passed` or `failed` with the same round.

    make check
    make accept
    factory/scripts/check-acceptance-lock.sh
    factory/scripts/classify-risk.sh
- Any failure: start a new `builder` with the spec path and the exact output, then run
  the gate again. At most 2 fix rounds, then stop.
- The tier is the higher of the script's result and the spec's `risk_floor`.

## 5. Review
- Delegate to `reviewer` with the spec path and base ref `origin/main`.
- Save its reply verbatim as `<work folder>/review.md`.
- `changes-required`: start a new `builder` with the spec path and the BLOCKING list
  only, rerun the gate, then start a new `reviewer`. At most 2 rounds, then stop.
- `escalate`: stop. If the reviewer's RISK is higher than yours, use the reviewer's.

## 6. Observe
- Delegate to `observer` with the work folder path. Do this on every run,
  including runs that stopped early: run it before you write the final report.
- Its observation file is committed with the work folder in the next step, so
  the record travels in the same pull request as the change. On a stopped run,
  commit it to the branch without opening a pull request.

## 7. Pull request
- Commit the work folder and the observation file, push the branch, and open a pull request using
  `factory/templates/pr-body.md`. Add the label `risk:<tier>`.
- Read `AUTO_MERGE_MAX_TIER` from `factory/policy.env`. If the tier is at or below
  it, run `gh pr merge --auto --squash`. Otherwise leave it for the human and say so.
- Never add the `human-approved` label. Never merge with admin rights.
- If this item does an accepted ticket, run `factory/scripts/ticket.sh done <ticket> --pr <number>`.
- In team mode, release the build slot: `factory/scripts/slot.sh release`.

## 8. Report
Five lines: pull request link, tier and why, fix rounds used at each stage,
anything not verified, and one suggested change to the factory (a prompt, rule or
test) if any stage needed a fix round.

## When you stop
Stopping early is correct behaviour. Write `BLOCKED.md` with what you were doing,
what stopped you, and the smallest decision the human needs to make. Emit a
`blocked` event for the stage, run the observer (step 6), release the build slot
in team mode, then leave the branch as it is. Do not raise a loop limit, lower a tier, or edit a gate to
get through.
