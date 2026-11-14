# Factory starter

A small, opinionated software factory for one operator and Claude Code: five
agents, four skills, deterministic gates, risk-tiered merging. The design and the
reasoning are in `docs/factory/ARCHITECTURE.md`. This file is how to stand it up.

## What is in here

    CLAUDE.md                     rules and map for every agent (fill in the blanks)
    Makefile                      the single definition of "green" (fill in for your stack)
    .claude/settings.json         permissions and the guard hook
    .claude/agents/               spec-writer, test-author, builder, reviewer, observer
    .claude/skills/work/          /work   one item through the pipeline
    .claude/skills/groom/         /groom  propose the next items from the roadmap
    .claude/skills/audit/         /audit  weekly after-the-fact review
    .claude/skills/reflect/       /reflect  turn observations into a reviewed factory change
    factory/risk-rules.txt        path patterns to risk tiers
    factory/policy.env            how much the factory may auto-merge
    factory/scripts/              validate-spec, classify-risk, check-acceptance-lock
    factory/hooks/guard.sh        blocks edits to the factory, .env writes, force push
    factory/hooks/telemetry.sh    records session and subagent events for the control room
    factory/scripts/emit-event.sh stage events, written by /work
    memory/                       observations (per item) and lessons (reviewed)
    factory/templates/            spec and pull request templates
    product/                      BRIEF, ROADMAP (yours), INBOX (anyone's)
    docs/architecture.md          product structure and invariants (yours to write)
    docs/factory/ARCHITECTURE.md  how the factory works and why
    docs/factory/MEMORY.md        how the factory remembers and improves
    docs/factory/UI-BUILD-PROMPT.md  prompt for building the control room UI
    .github/workflows/ci.yml      required checks: make check, secret scan, risk gate
    work/                         one folder per work item
    tests/acceptance/             tests derived from specs

## You need

git, GitHub CLI (`gh`, authenticated), `jq`, `make`, bash, and Claude Code signed
in with your subscription. A GitHub repository where you can set branch
protection and required status checks.

## This week

**Day 1: decide what the product is.** No agents yet. Write `product/BRIEF.md` and
the first three lines of `product/ROADMAP.md`. Do it in a normal Claude Code
session if you want a sparring partner, but the words are yours. Create the
repository and copy this kit into it. Run `chmod +x factory/scripts/*.sh factory/hooks/guard.sh`.

**Day 2: build the walking skeleton by hand.** Still not the factory. With Claude
Code in plan mode, pick the stack and build one thin end-to-end slice: one route
or command, one test, and (if the product stores data) one table. Then:
- fill in `make check`, `make accept` and `make dev` in the Makefile;
- write `docs/architecture.md`, especially Invariants and "How to add a typical feature";
- fill in the Commands and Conventions sections of `CLAUDE.md`;
- add toolchain setup to `.github/workflows/ci.yml` and get it green on main.

Agents copy what exists. On an empty repository they invent, and each one invents
something different. The skeleton is what makes their output consistent.

**Day 3: turn on the gates, run one item.**
- Protect `main`: require the `check`, `secrets` and `risk-gate` jobs to pass, and
  block direct pushes. Allow auto-merge in the repository settings.
- Create the labels `factory:proposed`, `factory:ready`, `human-approved`,
  `risk:R0`, `risk:R1`, `risk:R2`, `escaped-defect`, `factory:improvement`.
- Start `claude` in the repository and run `/work "a deliberately tiny change"`.
  Watch every stage. Read the spec, the tests, the diff and the review.

**Days 4 and 5: ten small items.** Run `/groom`, pick from what it proposes, and
feed items through `/work` one at a time. Read every pull request. Each time a
stage gets something wrong, change the factory (an agent prompt, CLAUDE.md, a
risk rule, a lint, a test), not only the code. To edit the factory's own files,
start the session with `FACTORY_ALLOW_SELF_EDIT=1 claude`.

**End of week: `/audit`.** Read the report and its sample. If your own reading
found nothing the reviewer missed across the last ten items, set
`AUTO_MERGE_MAX_TIER=R0` in `factory/policy.env`. Move to `R1` after another clean
stretch. The later stages are in the architecture document.

## Day-to-day

    /groom                 propose next items as issues labelled factory:proposed
    /work 42               run issue 42 through the pipeline
    /work "one-line ask"   create the issue, then run it
    /audit                 weekly report in docs/factory/audits/
    /reflect               after the audit, in a FACTORY_ALLOW_SELF_EDIT=1 session

A run that stops and writes `work/<id>-<slug>/BLOCKED.md` is the factory doing its
job. Answer the question in the file, or on the issue, and run `/work <id>` again.

## The control room UI

The factory writes everything a dashboard needs: `work/*/` records, stage events,
lifecycle events, observations and lessons. `docs/factory/UI-BUILD-PROMPT.md` is a
prompt for building the UI as a separate local app. Build it after the first ten
items, when there is real data to look at.

## Notes on Claude Code behaviour this kit relies on

- `.claude/settings.json` sets `CLAUDE_CODE_FORK_SUBAGENT=0` so the foreman can
  wait for each subagent in turn. Without it, interactive sessions start subagents
  in the background.
- Subagent requests count against the same subscription usage limits as your main
  session, so a full `/work` run costs several times a single session.
- Model aliases in the agent files (`sonnet`, `opus`, `inherit`) resolve against
  what your plan offers. Change them in `.claude/agents/*.md` if you want a
  different split.
- Permission prompts: the allow-list covers the pipeline's own commands. Anything
  else will ask. Widen the list as you learn what is routine rather than switching
  permission checks off.
- Claude Code changes quickly. If a frontmatter field or setting here is ignored,
  check the current docs at https://code.claude.com/docs before debugging the kit.
