---
name: dispatch
description: After the human merged a planning cycle's pull request, hand its work breakdown to the teams. Orchestrator only. Invoke manually.
argument-hint: "<cycle id, like c001-share-links>"
disable-model-invocation: true
---

# /dispatch: hand out approved work

Cycle: $ARGUMENTS

1. Run `factory/scripts/dispatch.sh <cycle>`. It refuses unless the human merged the planning pull
   request, DECISIONS.md is valid with no needs-human record left, and no other feature branch is
   open. If it refuses, tell the human what it said and stop. Do not work around it.
2. It makes the feature branch, records each item in `planning/<cycle>/dispatch.jsonl`, ends the
   cycle and rings each team that has items. Report: the feature branch, and per team its items in
   the order the work breakdown's `after` column allows.
3. For a team it could not ring, tell the human to run `/inbox` in that team's tab.
