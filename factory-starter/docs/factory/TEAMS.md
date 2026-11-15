# Team mode

A factory runs as one team until `factory/teams.json` exists. With it, the factory is several
teams, each with its own Claude Code session, its own git worktree and its own paths. Nothing
else changes: `/work`, the gates and the risk tiers are the same.

This page describes what is built so far (phases 1 and 2 of `plans/2026-11-14-teams.md` in the
kit's repository): the orchestrator plus one building team, `backend`; an optional bot account
for agents on GitHub; tickets, work items, build slots and the sweep. Planning meetings, more teams
and specialists come in later phases.

## Before you turn it on (once)

`factory github` sets the repository variable `FACTORY_HUMAN` to your login (for a factory made
before phase 2: `gh variable set FACTORY_HUMAN --body <your login>`). That is all that is required.

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
                          # it again to restart a closed tab. A new folder asks whether you trust
                          # it: answer that yourself. It says whose GitHub identity the agents get
factory team-up --print   # without Herdr: makes the worktrees, prints one launch command per team
```

Then give the backend lead an item: type `/work <issue>` in its pane.

## The roster

```json
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*"] },
             "backend":      { "owns": ["server/*", "db/*", "tests/*", "Makefile"] } },
  "append_only": ["memory/observations/*", "product/INBOX.md"] }
```

- `owns` uses the globs of `risk-rules.txt` (`*` also matches `/`), compared without case.
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
| A team writes only its own paths, its own work folders and append-only paths (by appending) | `guard.sh` checks every Edit, Write and every file a shell command writes | `ownership` job: `check-ownership.sh` with the roster from the base branch |
| A session writes only inside its own worktree (and temp dirs) | `guard.sh` | (not applicable) |
| A pull request carries one work folder; its spec's `team:` decides the team | (not applicable) | `ownership` |
| A pull request cannot widen its own ownership | the roster is blocked for sessions | roster and script read from the base branch |
| Factory files change only in their own pull request | blocked for sessions | `ownership` fails a team PR that touches them; `risk-gate` makes them R2 |
| Your files (`CLAUDE.md`, `product/BRIEF.md`, `product/ROADMAP.md`) change only in your pull requests | owned by no team, so blocked | `ownership` exempts a PR that changes only these and factory files; `risk-gate` makes them R2 (your label) |
| Sessions do not message each other | `crossSessionInbound: "refuse"`, `ListAgents` denied | (not applicable) |
| R2 needs your approval of the pull request as it is now | `human-approved` in any command is blocked | `risk-gate` runs `check-approval.sh`: the label was last added by `FACTORY_HUMAN`, after the newest push to the branch (timed by GitHub) |
| Sessions keep the GitHub identity they were started with | credential commands blocked (`gh auth`, `GH_TOKEN`, `security`, `git credential`, `~/.config/gh`, `~/.ssh`); settings deny reading `~/.config/gh` and `~/.ssh` | with a bot: its label never counts, and its token cannot push workflow changes |
| Issues and labels change only through `ticket.sh` and `item.sh` | raw `gh issue` / `gh label` writes, label edits on PRs and `gh api` writes are blocked | (not applicable) |

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
a fork, or a branch GitHub has no push record for, fails closed. The same check will gate the
planning brief (`brief-approved`) in phase 3.

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
- An accepted ticket is a work item for the receiving team: you run `/work <n>` in its tab.

`item.sh create --title "..." [--proposed] [--feature <id>]` (body on stdin) is how `/work` and
`/groom` create issues; in team mode it labels the issue `team:<team>`.

## Build slots

`/work` in a team session first runs `slot.sh acquire`. At most `max_active_build_teams`
(default 2) teams hold a slot; the next one is queued and its `/work` stops at once. `/work`
releases the slot when it opens its pull request or stops. `slot.sh status` shows who holds
one. A session that died keeps its slot; the sweep reports it, and deleting
`.factory/slots.json` frees every slot.

## The sweep

A script in its own tab (`sweep.sh --loop`, every 15 minutes), not a model, so it costs nothing
while all is well. It escalates tickets unanswered for 8 hours, a declined ticket that is disputed
or declined twice, tickets that block each other in a cycle, a team over its ticket budget, a
session stuck on a dialog for 10 minutes, a session working with no event for 30 minutes, and a
slot held for 4 hours (all in `limits`). Each new finding is an `escalation` event, once while it
lasts. Then the orchestrator's tab gets one fixed sentence, only when it is idle: read the
escalations and tell the human. The findings never travel in that sentence.

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
- **The approval check trusts GitHub's activity log** for push times. If GitHub has no record of
  a branch's pushes (an old branch), the gate stays closed until something is pushed.
