# Team mode

A factory runs as one team until `factory/teams.json` exists. With it, the factory is several
teams, each with its own Claude Code session, its own git worktree and its own paths. Nothing
else changes: `/work`, the gates and the risk tiers are the same.

This page describes what is built (phases 1 to 6 of `plans/2026-11-14-teams.md` in the kit's
repository): the orchestrator plus two building teams, `backend` and `frontend`, and the
`research` team; an optional bot account for agents on GitHub; tickets, work items, build slots
and the sweep; planning meetings; the security, database and UI reviewers; contracts; and feature
integration, with e2e tests and an acceptance review between a feature and `main`.

## Before you turn it on (once)

`factory github` sets the repository variable `FACTORY_HUMAN` to your login (for a factory made
before phase 2: `gh variable set FACTORY_HUMAN --body <your login>`), and protects `main` with
the five CI checks. That is all that is required. `dispatch.sh` copies `main`'s protection onto
each feature branch it makes, which needs admin rights on the repository: run it as an account
that has them (yours, or the orchestrator's if it runs as you).

**Optional, stronger: a bot account for the agents.** Without one, agents work on GitHub as you,
which costs two things (see Known weaknesses): risk-gate cannot tell your `human-approved` label
from an agent's, and a pull request could rewrite its own gates in `.github/workflows/`. With a
bot, only your labels count and the bot cannot change workflows. To set one up:
1. Create a GitHub account for the bot (it needs its own email address), invite it to the
   repository as a collaborator (write, never admin) and accept the invitation as the bot.
2. As the bot, create a **classic** token with only the **`repo`** scope. Leave `workflow`
   unticked: GitHub then refuses any push from the bot that changes `.github/workflows/`, so no
   pull request can rewrite its own gates. (Fine-grained tokens cannot yet reach a repository
   where the account is only a collaborator.)
3. Store it in your keychain, from a terminal: `security add-generic-password -s factory-github-bot -a factory -w`.
   `team-up` then starts every session as the bot, and refuses to start anything if the token
   does not work or is yours. Delete the item to go back to running agents as you.

## Turning it on

```
factory teams init        # writes factory/teams.json: orchestrator + backend, owning today's paths
                          # read it, then merge it through a pull request (R2: you approve it)
factory team-up           # with Herdr open: one worktree per team, and a space named after the repo
                          # with one tab per team running its claude, plus a tab for the sweep; run
                          # it again to restart a closed tab, or one whose claude exited (hc sees a
                          # bare shell there: the tab is closed and the team started fresh). A new folder asks whether you trust
                          # it: answer that yourself. It says whose GitHub identity the agents get
factory team-up --print   # without Herdr: makes the worktrees, prints one launch command per team
```

Then give the backend lead an item: type `/work <issue>` in its pane. For a frontend team, add its
entry to the roster (see below) in a pull request; `team-up` then gives it a tab running
`frontend-lead`.

## The roster

```json
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*", "tests/e2e/*", "features/*/FEATURE.md", "features/*/e2e-report.md",
                                         "features/*/attribution.md", "features/*/tickets.jsonl"] },
             "backend":      { "owns": ["server/*", "db/*", "tests/acceptance/backend/*", "Makefile"] },
             "frontend":     { "owns": ["web/*", "tests/acceptance/frontend/*"], "ui_review": true },
             "research":     { "owns": ["research/*", "features/*/acceptance.md", "features/*/acceptance-review.md"],
                               "evidence_review": true } },
  "db_paths": ["db/*", "*migrations/*", "*schema*"],
  "append_only": ["memory/observations/*", "product/INBOX.md"] }
```

- `owns` uses the globs of `risk-rules.txt` (`*` also matches `/`), compared without case.
- `ui_review: true` makes a team's items need a passing `ui-review.md` besides `review.md`;
  `evidence_review: true` (research) makes them need a passing `evidence-review.md` instead of it.
  `db_paths` (this is the default) decides which changes need a database review. Both are read
  from the base branch, like the rest of the roster.
- `contracts/*` belongs to no team, even if a roster lists it (see Contracts).
- A team with `"active": false` is not launched and owns nothing. Team names are lowercase
  letters, digits, `-` and `_`; any other key is ignored.
- `append_only` paths may be added to by any team, never rewritten or deleted.
- `default_team` is the team of a work folder whose spec has no `team:` line.
- Paths nobody owns (`product/BRIEF.md`, `CLAUDE.md`, ...) are written by the human only.
- The roster is a factory file: R2, and blocked for every session.

## Who a session is

A session's team is `FACTORY_TEAM`, set by `team-up` when it launches the session, and it must
match where the session runs: the orchestrator in the main checkout, any other team in
`../<repo>.teams/<team>`. Neither alone is enough. Commands that set `FACTORY_TEAM` or the
self-edit switch are blocked, and so is any team session driving Herdr (`herdr`, `herdr-app`,
`hc`, the core's socket) or `team-up`, because that would let one session type into another.

At start, resume and compaction the `session-start.sh` hook prints the team's charter
(`teams/<team>/CHARTER.md`) and the team rules into the session. Events in
`.factory/events.jsonl` carry `team`, taken from the session, never from the caller.

## What is enforced, and where

| Rule | Guard hook (as it happens) | CI (before merge) |
|---|---|---|
| A team writes only its own paths, its own work folders and append-only paths (by appending) | `guard.sh` checks every Edit, Write and every file a shell command writes | `ownership` job: `main`'s `check-ownership.sh` with the roster from the base branch |
| A session writes only inside its own worktree (and temp dirs) | `guard.sh` | (not applicable) |
| A pull request carries one work folder; its spec's `team:` decides the team | (not applicable) | `ownership` |
| A pull request cannot widen its own ownership | the roster is blocked for sessions | script from `main`, roster from the base branch |
| Factory files change only in their own pull request | blocked for sessions | `ownership` fails a team PR that touches them; `risk-gate` makes them R2 |
| Your files (`CLAUDE.md`, `product/BRIEF.md`, `product/ROADMAP.md`) change only in your pull requests | owned by no team, so blocked | `ownership` exempts a PR that changes only these and factory files; `risk-gate` makes them R2 (your label) |
| Sessions do not message each other | `crossSessionInbound: "refuse"`, `ListAgents` denied | (not applicable) |
| R2 needs your approval of the pull request as it is now | `human-approved` in any command is blocked | `risk-gate` runs `check-approval.sh`: the label was last added by `FACTORY_HUMAN`, after the newest push to the branch (timed by GitHub) |
| Sessions keep the GitHub identity they were started with | credential commands blocked (`gh auth`, `GH_TOKEN`, `security`, `git credential`, `~/.config/gh`, `~/.ssh`); settings deny reading `~/.config/gh` and `~/.ssh` | with a bot: its label never counts, and its token cannot push workflow changes |
| Issues and labels change only through `ticket.sh` and `item.sh` | raw `gh issue` / `gh label` writes, label edits on PRs and `gh api` writes are blocked | (not applicable) |
| The planning transcript, state, positions and attachments are written only by the planning scripts | direct writes to `planning/*/discussion.jsonl`, `state.json`, `dispatch.jsonl`, `positions/`, `attachments/` and shell commands naming `.factory/planning` are blocked | a `planning/<cycle>` pull request may change only `planning/<cycle>/` (and, to supersede, earlier `DECISIONS.md`); every `planning/*` and `contracts/*` file is R2 |
| No one reads a sealed position before the round closes | Read, Grep and Glob into `.factory/planning/*/sealed/` are blocked, for every session | (not applicable: sealed positions never leave the main checkout) |
| Approved decisions are never rewritten | (not applicable) | `decisions.sh check-append-only`: a record on the base branch may only gain `status: superseded` and `superseded_by` |
| An item's tier is the highest of its paths, its spec's `risk_floor`, the floors of the decision records it names and every reviewer's `RISK` | (not applicable; `/work` asks the same script) | `risk-gate` runs `main`'s `risk-tier.sh` (in single-team factories too); both names of a renamed file count |
| Every item has a passing review; a `ui_review` team's item also a passing UI review; an R2 or R3 item a passing security review (except one that holds only acceptance criteria or an acceptance review: the build they judge gets its own); a change to a db path a passing database review | (not applicable; `/work` runs the reviewers `check-specialists.sh --needs` names) | `risk-gate` step "Specialists' reports": `check-specialists.sh` with the base branch's roster |
| A security raise is honoured | (not applicable) | `decisions.sh validate`: every `RAISE: <record> <tier>` in `threat-model.md` or `db-review.md` needs that record's `risk_floor` at least as high (checked at each draft, at approval and by `dispatch.sh`) |
| A contract changes only by planning or under an accepted contract-change ticket | writes to `contracts/*` need a grant for the session's team in `.factory/grants/` (only `ticket.sh accept` writes one) | `ownership`: a team PR touching `contracts/*` must be the work item of a `type:contract-change` ticket to that team, accepted or done; a planning PR may only add new contracts its cycle promoted. Generated code must match: the `check` job runs `check-contracts.sh` |
| The research agents read only evidence | `researcher` and `evidence-reviewer` (by `agent_type`) may Read, Grep and Glob only inside `research/`, `product/`, `planning/`, `features/` and `contracts/` of their checkout, after `..` and symlinks; no pathless Grep or Glob, no glob that climbs out; no Bash | (not applicable) |
| The research agents write only research | `researcher` writes only inside `research/`; `evidence-reviewer` writes nothing | `ownership`: the research team's paths |
| Every research finding is sourced | (not applicable; `/research-work` runs it as its gate) | the `check` job runs `check-brief.sh --changed`: every finding cites a source, every source has a URL, a date and a quote, unsourced ideas are labelled assumptions or hypotheses |
| You decide which feedback research reads | `research/feedback/SOURCES.md` is blocked for every session | `ownership`: your file, even inside `research/`; R2 |
| The UI reviewer runs only the browser tooling | a session whose `agent_type` is `ui-reviewer` may run exactly `make ui-shots URL=<url> OUT=<dir>`, nothing else | (not applicable) |
| A feature reaches `main` only from `integrate/<f>`, once its e2e tests pass and research accepts the round | (not applicable) | the `check` job's "Feature gate" (`check-feature.sh`, `main`'s copy): `feature/*` into `main` always fails; `integrate/<f>` into `main` needs an e2e report saying pass, an acceptance review saying `VERDICT: accept` for that report's commit, nothing but records changed since that commit, `feature/<f>` protected with `main`'s checks, and `make e2e` passing in CI |
| A feature's items go to its feature branch, and a feature branch takes only them | (not applicable; `/work` and `/research-work` branch from it) | Feature gate: a work folder whose spec says `feature: <f>` merges only into `feature/<f>`, and a pull request into `feature/<f>` carries exactly one such folder |
| A factory change reaches a feature dispatched before it | (not applicable; `integrate.sh sync <f>` touches no checkout) | every job copies its checks from `main` (`RULES`), never from the base branch, so a feature's pull requests meet today's checks; a `sync/<f>` pull request into `feature/<f>` (main merged in) passes `ownership` only when every path it changes is as on `main` and untouched by the feature; the feature gate, specialists and acceptance lock leave it to that; its paths set its tier (factory files: R2, your label) |
| Integration records are written only by the integration scripts and integration-qa | `features/*/e2e-report.md`, `FEATURE.md` and `tickets.jsonl` are blocked for every session (scripts only); `tests/e2e/` and `features/*/attribution.md` only for the orchestrator's session; only the orchestrator pushes `integrate/<f>` or opens a pull request into it | `ownership`: never a team's path; an `integrate/<f>` pull request changes only this feature's records and what merging `feature/<f>` into `main` gives |
| E2E tests do not change to make the product pass | `integrate.sh save` refuses to change or delete a saved test unless the team declined its bug ticket (`--dispute`); `integrate.sh run` refuses tests that differ from the last save | Feature gate: nothing outside the records changed since the tested commit, and CI runs `make e2e` itself |

`/work` starts a new subagent for every delegation. A fix round goes to a new builder with the
spec and the exact failure, never back to the builder that wrote the code.

In team mode a session may also `mkdir` wherever it could add a file, and making a new file in
an append-only location counts as adding. Shell variables in a write's target are expanded only
for `$HOME`, `$TMPDIR` and `$CLAUDE_PROJECT_DIR`; any other one is blocked, so write literal paths.

The guard and its rules run from each worktree's own checkout. `/work` starts every item from
`origin/main`, so a guard change reaches a team when its next item starts.

## Approvals

`risk-gate` passes an R2 pull request only when `check-approval.sh` finds that the last time
`human-approved` was added, your account (`FACTORY_HUMAN`) added it, and that this was after the
newest push to the branch, as GitHub's activity log times it (a commit's own date can be
anything). So a label the bot adds keeps the gate red, and any push after your approval needs a
new one: remove the label and add it again once you have read what changed. Without a bot, an
agent's label would also come from your account, so then only the second half (newer than the
last push) adds protection against agents; the first half still stops anyone else. A pull request from
a fork, or a branch GitHub has no push record for, fails closed. The same check gates the
planning brief: `round.sh next` runs it for the label `brief-approved`.

## Rigor: full or mvp

`RIGOR` in `factory/policy.env` (yours, R2) sets how much ceremony a feature gets. Every check
reads main's copy, so a pull request cannot lighten its own. `full` is the default; `mvp` is for a
first version you will throw away or harden later:

| | full | mvp |
|---|---|---|
| Planning | positions, up to 2 discussion rounds, a specialist review round (threat model, data review), up to 3 drafts | positions, 1 discussion round, no review round, 1 draft |
| Acceptance criteria | any number; evidence review, plus security review at R2 when sample files come with them; a decision without a criterion blocks | at most 15; evidence review only; only a wrong, untestable or contradicting criterion blocks |
| Build items | wait for the e2e tests written from the criteria | start at dispatch; e2e tests come at integration |

Unchanged in both: secrets scan, ownership, CI, risk tiers, your label on R2, the security
review of R2 builds and of research briefs, and the feature gate (`make e2e` passes before a
feature reaches main). A roster `limits` entry still overrides the planning defaults.
`factory/scripts/policy.sh rigor` prints the rigor in force.

## Autonomy: on or off

`AUTONOMY` in `factory/policy.env` (yours) sets who the factory waits for. `off`, the default,
waits for you at each gate below. `on` is for projects where nobody needs to (a hobby project, a
prototype): you propose the product, the teams discuss it once, and from then on they talk only
through tickets and nothing waits for you. Every check reads main's copy, so a pull request cannot
turn it on for itself. `factory/scripts/policy.sh autonomy` prints the setting in force.

| | off | on |
|---|---|---|
| Brief | waits for your `brief-approved` | the orchestrator writes it from your proposal and goes on |
| Open planning questions, objections | `needs-human` records you settle | the orchestrator decides them (`decided_by: orchestrator`, dissent recorded) |
| Planning PR, sync PRs, PR to main | you add `human-approved` and merge | merge themselves once CI is green |
| Work PRs | auto-merge up to `AUTO_MERGE_MAX_TIER`; R2 needs your label | R0 to R2 merge themselves once CI is green |
| A team stops (blocking question, unsettled dispute, fix-round limit, `escalate`) | `BLOCKED.md`, for you | a question ticket to the orchestrator (`ticket.sh answer`); autostart resumes the item when it is answered |
| Sweep escalations | the orchestrator tells you | the orchestrator settles product and routing calls; only what no agent can fix comes to you |

Unchanged in both: the secrets scan, ownership, CI and the tests, R3 (never the factory's), the
guard, the security review of R2 builds, the limit of two integration rounds, and a pull request
that changes the factory itself (`factory/`, `.claude/`, `.github/`, `teams/`, `docs/factory/`)
still needs your `human-approved`, unless every such file is exactly as on main (a sync PR that
only carries main's kit). `risk-gate` runs `autonomy-gate.sh` from main to decide that.

## Tickets

A team asks another for something with a ticket, a GitHub issue that only `factory/scripts/ticket.sh`
writes:

```
ticket.sh create --to backend --type request --needs "..." --why "..." --blocks "#41" --done "..."
ticket.sh accept <n> | decline <n> --reason "..." | done <n> --pr <pr>      (the receiving team)
ticket.sh verify <n> | dispute <n> --reason "..." | withdraw <n> --reason "..."  (the asking team)
```

- Types: `request`, `bug`, `contract-change`, `decision-change`. Needs, why, done and reasons are at
  least 30 characters. The sending team is the session's, never an argument.
- At most 5 tickets per team per day and 2 open from one team to another
  (`limits.tickets_per_day`, `limits.open_tickets_per_pair` in the roster).
- States: open → accepted or declined; accepted → done; done → verified (closes) or disputed;
  declined → disputed; disputed → accepted or declined; anything before done → withdrawn
  (closes). A ticket can be disputed once; after that it goes to the orchestrator.
- Text is posted with `@mentions` and HTML neutralised. Each action comments with a
  machine-readable line, sets the `state:` label and writes a `ticket` event.
- An accepted ticket is a work item for the receiving team: the sweep types `/work <n>` in its tab
  when the ticket is about a dispatched feature (`feature:<f>`); for any other, you do.

`item.sh create --title "..." [--proposed] [--feature <id>]` (body on stdin) is how `/work` and
`/groom` create issues; in team mode it labels the issue `team:<team>`.

## Build slots

`/work` in a team session first runs `slot.sh acquire`. At most `max_active_build_teams`
(default 2) teams hold a slot; the next one is queued and its `/work` stops at once. `/work`
releases the slot when it opens its pull request or stops. `slot.sh status` shows who holds
one. A session that died keeps its slot; the sweep reports it, and deleting
`.factory/slots.json` frees every slot.

## The sweep

A script in its own tab (`sweep.sh --loop`, every 2 minutes), not a model, so it costs nothing
while all is well.

Each pass first starts approved work (`autostart.sh`), so nobody types it. You decide what gets
built when you merge a cycle's decisions; from there the sweep types the next command into the tab
that runs it, only while that tab waits for input, and the skill checks all it checks when you
type it:

| It types | Into | When |
|---|---|---|
| `/dispatch <cycle>` | orchestrator | the cycle's state on `origin/main` is `approval`, its `DECISIONS.md` is there, and no feature branch is open |
| `/work <n>` (research: `/research-work <n>`) | the team's tab | issue `<n>` is open on the open feature (`feature:<f>`), labelled `team:<team>` (an item from dispatch) or a ticket `to:<team>` in `state:accepted`, and has no `work/<n>-*` branch |
| `/integrate <f>` | orchestrator | `feature/<f>` or `integrate/<f>` moved, the factory on main (`factory/`, `.claude/`) changed (its first step syncs main into the feature), or a team declined or finished one of the orchestrator's tickets on `<f>`, since it last typed it |

`/dispatch` and `/work` are typed again after `retry_minutes` (30) while nothing came of them (a
full slot, tests not in yet), and at once when what they wait on moves: `origin/main` for
`/dispatch`, `feature/<f>` for `/work` (the item it waits for merged). Work outside a dispatched feature still waits for you to type
`/work`. Typing is key by key (`hc keys`), because a skill only a person may start does not run
from `hc send`; team-up turns Claude Code's feedback survey off, since it reads typed digits.
`FACTORY_AUTOSTART=0` in the sweep's environment turns this off.

Next it rings doorbells that waited. A ticket rings the team it is for, a declined or finished one
rings the team that asked (`/inbox` then verifies, disputes or withdraws it), a planning question rings
the team it asks (`--to all`: every team in the cycle but the asker), and dispatch and the rounds
ring the teams they name. A tab that is busy or closed cannot be rung, so the ring is kept as an
empty file, `.factory/rings/<team>`, and each pass tries again with its own fixed sentence ("run
/inbox"; the orchestrator's is "run /plan"), never words from the file. A tab autostart just typed
into keeps its ring for the next pass. Without Herdr nothing is kept: tell the team yourself.
Adding `brief-approved` runs no script, so the sweep checks it: once the label passes
`check-approval.sh` on the brief's pull request, it rings the orchestrator ("run /plan") once per cycle.

Then it escalates tickets unanswered for 8 hours, a declined ticket that is disputed
or declined twice, tickets that block each other in a cycle, a team over its ticket budget, a
session stuck on a dialog for 10 minutes, a session working with no event for 30 minutes, a
slot held for 4 hours (all in `limits`), and a team whose session has ended (hc sees a bare shell
in its tab; Herdr may still call it claude): run `factory team-up` to start it again. Each new finding is an `escalation` event, once while it
lasts. Then the orchestrator's tab gets one fixed sentence, only when it is idle: read the
escalations and tell the human. The findings never travel in that sentence.

## Planning

A feature that needs more than one team, or one team's work that is worth a decision record, starts
with a planning cycle. The orchestrator chairs it with `/plan`; leads take part with `/inbox`. Those two answer the doorbell, so the model may start
them; `/work`, `/research-work`, `/dispatch` and `/integrate` start only when typed, never by a
model (`test-doorbell.sh` holds both halves): by you, or by the sweep for work that follows from
decisions you approved (see The sweep). The
record is `planning/c<NNN>-<slug>/` on the branch `planning/c<NNN>-<slug>` in the main checkout, and
its pull request is how you approve it. Version 1 runs one cycle at a time: `round.sh open` refuses
while one is open (a marker in `.factory/planning/active`).

| Round | Who | What | What decides that it closes |
|---|---|---|---|
| brief | the orchestrator writes it from what you asked; you approve | `BRIEF.md`: Goal, Constraints, Out of scope, `teams:`. `round.sh brief` pushes it as a draft pull request. | You add `brief-approved` (`check-approval.sh`: your account, after the last push). A one-team cycle goes straight to decisions. |
| positions | each lead, in parallel | `position.sh submit`: Build, Needs from others, Risks, Open questions, What I would object to in the brief; contract drafts with `position.sh attach`. Sealed until the round closes. | every team submitted, or the round's time is up; then all are published at once to `positions/` |
| discussion-1, -2 | the orchestrator asks, leads answer | `say.sh question / answer / objection / proposal`, one JSON line each in `discussion.jsonl` | every question answered, or the time is up; a second round only with `--again` |
| review | security-engineer, and db-engineer when the data model is touched (the orchestrator runs them) | their replies, saved as `threat-model.md` and `db-review.md` | the orchestrator runs `round.sh next` |
| decisions | the orchestrator drafts `DECISIONS.md`; security-engineer reads each draft (its `RAISE` lines are appended to `threat-model.md`); each lead answers each draft once | `round.sh draft`, then `say.sh accept` or `say.sh objection --refs <record>`; after the last draft, `contracts.sh promote` for each contract a record names | every team answered (or the time is up) and `decisions.sh validate` passes; the pull request is marked ready |
| approval | you | settle each `needs-human` record (edit it, or tell the orchestrator), add `human-approved`, merge | `dispatch.sh` refuses unless `DECISIONS.md` is on `main` with no needs-human record left |

Then `/dispatch` makes the feature branch `feature/f<NNN>-<slug>`, protects it like `main`, writes
`dispatch.jsonl` (one line per work-breakdown row, plus research's `acceptance` item when the
breakdown has none) and rings the teams, whose `/inbox` turns their rows into issues for you to
run `/work` on. Version 1 dispatches one feature at a time, and refuses without an active research
team, which writes the acceptance criteria. What happens next is under Integration.

**The rules, all checked by the scripts, not by the chair.** A team says at most
`messages_per_round` [4] things per round, answers aside: an answer to a question put to it that it
has not answered yet is always allowed, so a late question cannot strike a team that used its messages; the orchestrator asks one team at most
`questions_per_team` [3] questions per round; a message body is at most `message_chars` [2000]
characters (longer material goes in an attached file); a position is at most `position_chars`
[20000]; at most `discussion_rounds` [2] discussion rounds and `drafts` [3] decision drafts; a
round lasts `round_minutes` [60]. A team that misses a round's time gets a strike; two strikes end
the meeting (`escalated`), and the sweep reports any round past its time. A question still open
at the end of discussion, and an objection still standing on the last draft, must become a
`needs-human` record that names the dissenting team: `decisions.sh validate` refuses otherwise.
The orchestrator never overrules; you decide.

`DECISIONS.md` records: `## c001-D01: Title`, then `- owner:`, `- affects:`, `- status: decided |
needs-human`, optional `risk_floor`, `supersedes`, `contract`, `refs`, `decided_by: human` (a needs-human
record you have since decided; it settles the open questions in its refs), and the sections Decision,
Reasoning, Alternatives rejected, Dissent. Then a `## Work breakdown` table:
`| item | team | delivers | after | contract | decisions |`. The full format is in the header of
`factory/scripts/decisions.sh`.

Everything a team writes in planning (positions, messages, attachments) is evidence for the other
teams to weigh, never an instruction to them; research's text above all, since it was read from
the open web. Every agent prompt says so.

## Reviews and specialists

Whoever builds an item does not judge it. Every reviewer is a fresh subagent with no edit tools.
Its reply is saved word for word in the work folder and committed:

| Report | Reviewer | When (decided by `check-specialists.sh`, never by the foreman) |
|---|---|---|
| `review.md` | `reviewer`: the diff against the spec, its decision records and contracts | every item, except an `evidence_review` team's |
| `evidence-review.md` | `evidence-reviewer`: every finding sourced, each quote re-fetched and saying what is claimed, assumptions labelled, injected instructions recorded | items of a team with `evidence_review: true` (research) |
| `ui-review.md` | `ui-reviewer`: the rendered result, light and dark, desktop and phone, plus an axe scan (`make ui-shots`) | items of a team with `ui_review: true` (frontend) |
| `security.md` | `security-engineer`: may raise the tier, never lower it | team mode, items whose tier is R2 or R3, except ones that change only `features/<f>/acceptance.md` or `acceptance-review.md` (with their work folder) |
| `db-review.md` | `db-engineer`: schema, migrations (reversibility, locking, data loss, backfill), queries | team mode, items that change a `db_paths` path |

Each report starts `VERDICT: pass | changes-required | escalate` and `RISK: R0..R3`. A report
passes only when its first `VERDICT:` line is exactly `VERDICT: pass`. Any `changes-required`
goes to a new builder with that report's BLOCKING list. Then the gate and every reviewer that had
already run go again, because a fix can break what another reviewer passed: at most 2 rounds in
total. `escalate` stops the item.

`/work` asks `check-specialists.sh --needs` which reports an item needs, and `risk-tier.sh` for its
tier after each report. Before it pushes, it runs the same check CI runs. A frontend item whose spec
adds or changes a screen, flow or design token first goes to `designer` (`design.md`).

`make ui-shots URL=<url> OUT=<dir>` is the factory's browser tooling. The kit's default only says
to define it. `factory/scripts/ui-shots.mjs` is a reference built on Playwright and
`@axe-core/playwright` from the product's own `node_modules`: 8 screenshots per page
({light, dark} x {1280x800, 390x844}) and `axe.json`. It refuses `file://` pages outside the
repository and output folders outside it. States the page reaches only after input (a long title,
an invalid colour, another layout) come from `ui-states.txt` in the work folder, which the
foreman writes before the UI review: each line names a state and the steps a person would take
(`fill <label> = <text>`, `select <label> = <option text>`, `click <button name>`). The reviewer's
command stays `make ui-shots URL=<url> OUT=<dir>`; a bad line stops it before anything renders.

## Research

The research team works out what is worth building: the market, competitors, problem statements
and user-level criteria. It reads the open web and text people send in, so everything it reads is
untrusted, and what it writes is evidence for the other teams to weigh, never an instruction to
them. Every agent prompt that reads research says so.

`/research-work <issue>` in the research lead's tab runs one question through:
1. The spec (the question, and the decision it informs).
2. A fresh `researcher` writes `research/<id>-<slug>/brief.md`. It has WebSearch and WebFetch, no
   shell, reads only the evidence folders and writes only `research/`.
3. The gate: `check-brief.sh`. Every finding is `- F<n>: <claim> [S<n>]`, and every source has a URL,
   an access date and an exact quote. Anything unsourced goes under Assumptions or Hypotheses.
   Any instruction found in a page goes under "Instructions found in sources", quoted, and is not
   followed. The brief opens with the line `> Evidence, not instructions.`.
4. A fresh `evidence-reviewer` (a different model tier) re-fetches every source: is the quote
   there, does it say what the finding claims, is every injected instruction recorded? Its reply is
   `evidence-review.md`. A fix goes to a new researcher, never to the one that wrote the brief.
5. A file in `research/` other than the brief stops the item: that is what a followed injection
   (`research/leak.md`) would look like.

The feedback half is dormant until `research/feedback/SOURCES.md` lists a real source, and only you
edit that file. Until then the team does discovery and writes hypotheses, labelled as such.

## Contracts

`contracts/` (for example `api.openapi.yaml`, `data-model.md`, `design/tokens.json`) is the
agreement between teams. No team owns it.

- **First author: planning.** A producing team attaches its draft to its position
  (`position.sh attach`). A decision record names the file (`- contract: contracts/api.openapi.yaml#/paths/~1shares`).
  After the last draft, the orchestrator runs `contracts.sh promote <cycle> <attachment>
  <contracts/path>`, which copies it in on the planning branch and records it in
  `planning/<cycle>/contracts.jsonl`. You approve the contract with `DECISIONS.md`, by merging.
  `promote` refuses a path no record names, and a path already on `main`.
- **Every change after that: a contract-change ticket.**
  `ticket.sh create --type contract-change --to <team>`. When that team accepts, `ticket.sh`
  writes a grant (`.factory/grants/contract-<n>.json`), and the guard lets that team's sessions
  write `contracts/` while the ticket stays accepted. Any other ticket action removes the grant.
  Its pull request is `/work <n>`: CI checks that issue `<n>` is a `type:contract-change` ticket
  to that team, accepted or done.
- **Generated code must match.** The `check` job runs `check-contracts.sh`: `make contract-gen`
  must change nothing (otherwise the generated code drifted), then `make contract-check` must pass
  (conformance, for example contract tests). A factory with no files in `contracts/` skips both.
  With contracts, the kit's default targets fail until the Makefile defines them for the stack.
- Every `contracts/*` file is R2: you approve each change.

## Integration

A dispatched feature is built on `feature/<f>` (protected like `main`; teams' pull requests go
there with the same checks) and reaches `main` through `integrate/<f>`, the orchestrator's branch:
the feature branch, `main` merged in, the e2e tests and the integration records. Its pull request
to `main` is the only way in. The orchestrator runs `/integrate <f>`; `factory/scripts/integrate.sh`
decides what passes.

A feature branch starts as `main` was at dispatch. CI holds its pull requests to `main`'s checks
anyway; for the sessions' own prompts and scripts to catch up after a factory change merges, the
orchestrator runs `integrate.sh sync <f>`. It pushes `sync/<f>` (`main` merged into the feature
branch) and opens its pull request, or refuses when the two changed the same file. You approve it
like any factory change.

1. **Criteria first.** Research's `acceptance` item writes `features/<f>/acceptance.md` into the
   feature branch: `## AC<n>: <title>`, a `- decisions:` line naming records, and a `- check:` a
   black-box test can run (`feature.sh check-acceptance`). A spec-writer writes it; a new
   evidence-reviewer checks each criterion traces to its decisions.
2. **Tests before anyone builds.** `integrate.sh tests <f>`, then a new `integration-qa` writes
   `tests/e2e/<f>/` from the criteria (each test named `AC<n>: ...`, through the product's public
   surface only), then `integrate.sh save`. Saved tests are locked. Build items wait for them:
   `/work` runs `integrate.sh ready <f>` first, and `save` rings the teams.
3. **A round.** When the feature's items are merged, `integrate.sh run <f>` merges `feature/<f>` and
   `main` into `integrate/<f>`, runs `make e2e` and commits `features/<f>/e2e-report.md` (verdict,
   round, the tested commit, the last 200 lines of output) and `FEATURE.md`, a generated summary
   with a `tickets.jsonl` snapshot. A merge conflict is ticketed to the teams owning the paths.
4. **A failed round.** A new integration-qa writes `features/<f>/attribution.md`: per failing test,
   the criterion, the decision record, the contract and the team whose code does not do what they
   say, with evidence. `integrate.sh tickets <f>` checks every line (all or nothing) and files one
   `bug` ticket per team. A test integration-qa finds wrong itself gets a bug ticket of its own, to
   the team whose code it runs, which declines it if it agrees (Disputes, below); you hear of it
   only if the team accepts it or the dispute keeps the test. The teams fix through their own
   pipelines, then round 2 runs.
5. **Two failed rounds** stop the feature: `run` writes an `escalation` event and refuses a third
   round. You decide: more time, a changed criterion, or dropping the feature. To drop it, tell
   the orchestrator: `integrate.sh drop <f> --reason <why>` keeps its branches as tags
   `stopped/feature/<f>` and `stopped/integrate/<f>`, closes its open pull requests and issues
   saying why, and deletes the branches, so the next cycle may be dispatched. You can drop a
   feature at any point, not only here.
6. **A passed round** files a ticket to research, which reviews it: a new evidence-reviewer, given
   the criteria, the report and the tests, writes `features/<f>/acceptance-review.md`
   (`VERDICT: accept | reject`, `e2e-commit: <the tested commit>`, a line per criterion), checked by
   a second one. With `accept` on the feature branch, `integrate.sh pr <f>` opens `integrate/<f>` →
   `main`, labelled with its tier (the highest of its contents; R2 needs your label, as always).
7. **Merged:** `integrate.sh close <f>` deletes both branches, and the next cycle may be dispatched.

**Disputes.** A team that thinks an e2e test is wrong declines the bug ticket with its evidence. A
new integration-qa re-checks once against the criterion: it fixes the test to match the criterion
(`integrate.sh save --dispute <n>`, then the ticket is withdrawn), or keeps it with reasons
(`ticket.sh dispute`). A second decline is escalated by the sweep, with both positions. A
disagreement about the criterion itself is a ticket to research. A disputed test never counts as
passing: CI runs `make e2e`.

Version 1: integration and planning share the main checkout, so `integrate.sh` refuses while a
planning cycle is open.

## Known weaknesses

- **Without a bot account, agents work on GitHub as you.** Then:
  - risk-gate cannot tell your `human-approved` label from one an agent added. Only the guard
    (which blocks any command containing `human-approved`) stands in the way, and the guard is
    drift prevention, not a wall.
  - A pull request runs its own copy of `ci.yml`, so one that rewrote the `risk-gate` or
    `ownership` job could pass its own gates. The guard blocks sessions from writing
    `.github/`; with a bot whose token lacks the `workflow` scope, GitHub refuses the push itself.
  The fix for both is the optional bot under "Before you turn it on".

- The guard reads shell commands for the files they write. It is a guardrail against drift and
  mistakes, not a sandbox: a program that writes files without naming them on the command line
  gets past it. CI's ownership check and branch protection are the boundaries that hold.
  The same goes for Herdr: a session runs inside a Herdr terminal, so a program that opens the
  core's socket itself could type into another session. The guard blocks the commands that do
  it by name; Claude Code's `crossSessionInbound: "refuse"` stops its own messages.
- **Your credentials are on the same machine.** Even with a bot token, every session runs as
  your macOS user, so your `gh` login, git credentials, keychain and SSH
  keys are readable by any program it runs. The guard blocks the obvious ways (`gh auth`,
  `GH_TOKEN`, `security`, `git credential`, `~/.config/gh`, `~/.ssh`), which is drift prevention,
  not a wall. Only running the agents as another OS user or in a container, with none of your
  credentials, closes it. What holds regardless: branch protection with `enforce_admins`, and
  `risk-gate`, which an agent acting as you could pass only by adding the label as you.
- **Team identity on GitHub is declarative.** Every team shares the one bot account. CI proves a
  pull request stays inside one team's paths, not which session wrote it, and a ticket's sender
  is the session that ran `ticket.sh`, not something GitHub checks.
- **Sealing is drift prevention.** Sealed positions sit in the main checkout as ordinary files.
  The guard blocks Read, Grep and Glob into them and shell commands naming `.factory` with
  `sealed` or `.factory/planning`; a program that finds them some other way can read them.
  Likewise the transcript is written only through `say.sh` because the guard blocks direct writes,
  not because the file cannot be written: every session runs as your user. A planning pull request
  shows the whole transcript, and you approve it by reading it.
- **The active-cycle marker is local** (`.factory/planning/active` in the main checkout). Two
  factories on two machines over one repository would not see each other's cycles.
- **Reports are declared, not proven.** CI checks that the right reports exist and say
  `VERDICT: pass`, not that the named reviewer wrote them: the lead saves each reply, and a lead
  that wrote one itself would pass the check. The telemetry log records every subagent's start
  and stop with its agent type: that is the evidence to check it against.
- **Agent types come from Claude Code.** The UI reviewer's shell limit trusts the hook input's
  `agent_type`. Claude Code documents it for subagents; phase 5 checks it live. The UI reviewer
  can still open any `http` address, but it can already say anything it read in its reply.
- **The research read limit covers the tools' own path arguments.** Grep and Glob search a
  folder with ripgrep, which does not follow symlinks (checked in Claude Code 2.1.325); if a
  later version adds `--follow`, a symlink planted inside `research/` would be read through.
  WebFetch is not limited: a researcher can send anything it may read to any web address, and
  it may read only the evidence folders.
- **WebFetch shows a page through a summary.** It quotes at most about 125 characters at a time,
  so a researcher records only the opening of a long injected instruction, and hidden text the
  summary leaves out can go unnoticed (seen in the phase 5 live check). The evidence reviewer
  re-fetches with targeted questions and says what it could not see; the guard is what keeps a
  followed instruction from reaching anything.
- **Contract grants are local files** in the main checkout. A ticket closed on GitHub without
  `ticket.sh` keeps its grant until `ticket.sh` next acts on it. CI's ticket check holds anyway.
- **`integrate/<f>` is not protected**, because `integrate.sh` pushes merges of `main` into it.
  Every agent can reach GitHub as the same account, so a session could push to it. The guard
  blocks team sessions from pushing it or opening pull requests into it, and `integrate.sh run`
  refuses e2e tests that differ from the last `save` (its commits carry a trailer, which a
  determined author could forge). What holds after a round: CI fails the pull request to `main` if
  anything but records changed since the tested commit, and runs `make e2e` itself.
- **The feature branch's protection is checked when the feature merges**, not continuously. An
  account with admin rights could lift it, push, and restore it before the gate reads it.
- **A spec's `feature:` is the team's own text.** A team that leaves it out sends a feature change
  to `main` as an ordinary item, through the ordinary gates, without the e2e gate.
- **Merge conflicts on `integrate/<f>` are ticketed to the owning team**, but a pull request into
  the feature branch cannot bring in `main`'s changes to other teams' files, so some conflicts need
  you.
- **The round count lives in the e2e report on `integrate/<f>`.** Removing the report resets it;
  the ownership check and the guard are what stop that.
- **The e2e report keeps the last 200 lines** of output, so the acceptance reviewer also gets the
  tests' code; a criterion it cannot see evidence for is judged not met.
- **The approval check trusts GitHub's activity log** for push times. If GitHub has no record of
  a branch's pushes (an old branch), the gate stays closed until something is pushed.
