# Team mode

A factory runs as one team until `factory/teams.json` exists. With it, the factory is several
teams, each with its own Claude Code session, its own git worktree and its own paths. Nothing
else changes: `/work`, the gates and the risk tiers are the same.

This page describes what is built so far (phase 1 of `plans/2026-11-14-teams.md` in the kit's
repository): the orchestrator plus one building team, `backend`. Planning meetings, tickets,
more teams and specialists come in later phases.

## Turning it on

```
factory teams init        # writes factory/teams.json: orchestrator + backend, owning today's paths
                          # read it, then merge it through a pull request (R2: you approve it)
factory team-up           # with Herdr open: one worktree per team, and a space named after the repo
                          # with one tab per team running its claude; run it again to restart a
                          # closed tab. A new folder asks whether you trust it: answer that yourself
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

`/work` starts a new subagent for every delegation. A fix round goes to a new builder with the
spec and the exact failure, never back to the builder that wrote the code.

In team mode a session may also `mkdir` wherever it could add a file, and making a new file in
an append-only location counts as adding. Shell variables in a write's target are expanded only
for `$HOME`, `$TMPDIR` and `$CLAUDE_PROJECT_DIR`; any other one is blocked, so write literal paths.

The guard and its rules run from each worktree's own checkout. `/work` starts every item from
`origin/main`, so a guard change reaches a team when its next item starts.

## Known weaknesses

- The guard reads shell commands for the files they write. It is a guardrail against drift and
  mistakes, not a sandbox: a program that writes files without naming them on the command line
  gets past it. CI's ownership check and branch protection are the boundaries that hold.
  The same goes for Herdr: a session runs inside a Herdr terminal, so a program that opens the
  core's socket itself could type into another session. The guard blocks the commands that do
  it by name; Claude Code's `crossSessionInbound: "refuse"` stops its own messages.
- Every session runs on your machine as your user. Until phase 2 gives agent sessions a separate
  bot token, an agent that ignores its rules can use your GitHub credentials. Branch protection
  with `enforce_admins` still stops merges that skip the checks.
