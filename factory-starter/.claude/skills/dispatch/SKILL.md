---
name: dispatch
description: After the human merged a planning cycle's pull request, hand its work breakdown to the teams. Orchestrator only. Invoke manually.
argument-hint: "<cycle id, like c001-share-links>"
disable-model-invocation: true
---

# /dispatch: hand out approved work

Cycle: $ARGUMENTS

1. Run `factory/scripts/dispatch.sh <cycle>`. It refuses unless the human merged the planning pull
   request, DECISIONS.md is valid with no needs-human record left, no other feature branch is
   open, and research is an active team (it writes the acceptance criteria integration needs). It
   also stops if GitHub refuses to protect the feature branch like main. If it refuses, tell the
   human what it said and stop. Do not work around it.
2. It makes the feature branch and protects it like main, records each item in
   `planning/<cycle>/dispatch.jsonl` (with research's `acceptance` item when the work breakdown
   has none), ends the cycle and rings each team that has items. Report: the feature branch and
   whether it is protected, and per team its items in the order the work breakdown's `after`
   column allows. Build items wait for the e2e tests: research writes the criteria first, then
   `/integrate <feature>` has integration-qa write the tests. With `factory/scripts/policy.sh
   rigor` printing `mvp`, build items start at once and the e2e tests come at integration.
3. For a team it could not ring, tell the human to run `/inbox` in that team's tab.
