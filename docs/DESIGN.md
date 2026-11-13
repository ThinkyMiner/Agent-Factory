# Control room: design

Status: **approved 2026-11-13**. Built in phases (§9). Changes made while building are marked *(changed in build)*.

Target factory: `../factory-starter` for now. The app
takes any factory path as an argument, so a deployed factory elsewhere works the same
way. Built here: `./control-room`.
Machine: macOS, Node 26.7.0, `gh` 2.87 signed in.

## 1. What the factory actually records (checked against the files)

The factory-starter repo is an unused template: it is not a git repository, has no
GitHub remote and no work items, and holds one lifecycle event. Everything that depends
on history is developed against `--demo`. Where the files differ from the prompt's
description, I trust the files:

| # | Finding | Consequence for the app |
|---|---|---|
| 1 | Work items in progress or stopped live on `work/<id>-<slug>` branches. The working tree shows only `main` plus the branch that is checked out. | I read work folders from every local and remote `work/*` branch through `git ls-tree`/`git show` (cached by blob SHA). The working tree overlays the checked-out branch, which is how an uncommitted `BLOCKED.md` shows up. |
| 2 | `BLOCKED.md` is written but not necessarily committed. The skill says "leave the branch as it is". | A blocked item can drop out of view after a branch switch. The app keeps the last seen question and marks it "file no longer present". This is data-contract proposal 7. |
| 3 | The intake `started` event is emitted before the branch and folder exist, so it reaches only `.factory/events.jsonl`. | Intake is missing from the durable record. The app merges both streams and deduplicates identical lines. |
| 4 | `emit-event.sh` uses `jq --arg`, so `round` and `pr` are strings (`"0"`). | The schema coerces them to numbers. A value that cannot be coerced produces a notice. |
| 5 | `review.md` is overwritten on every review round. | Only the final review survives. The number of review rounds comes from events. |
| 6 | The gate is recorded as one stage event. Results for each script (check, accept, lock, classify) and for each test are recorded nowhere. | The Gates tab shows the gate events plus CI check runs from GitHub. The pass state of each AC is "suite passed/failed", never per test. |
| 7 | The spec's `status:` is always `specified`, because nothing updates it. | It is ignored for state and shown as-is. |
| 8 | Neither `escaped-defect` nor `factory:improvement` is in the README's list of labels to create. `escaped-defect` is used nowhere in the factory. | The app still reads both, and also detects reverts on its own (titles starting `Revert "`, bodies containing "This reverts"). |
| 9 | Reflections and audits have no fixed shape. | Audits are rendered as-is. Reflections are parsed into the change/prediction/result table only when the labelled fields are present; otherwise they are rendered with a notice. Nothing is inferred from prose. |
| 10 | The format example line in `lessons.md`, `- L-000 (stage) ...`, matches the format itself. | The parser skips `L-000` and placeholder dates. |
| 11 | Lifecycle events carry no model. | The transcript does (`message.model`). A subagent transcript sits at `<session>/subagents/agent-<id>.jsonl`, and `SubagentStop` gives its path. |
| 12 | Transcript lines repeat for each content block under the same `message.id`. The one `transcript_path` in the starter's events points to a file that does not exist. | Tokens are deduplicated on (`message.id`, `requestId`), keeping the largest total and skipping `<synthetic>`. A missing file means "tokens unknown", and token columns are hidden unless the figures are readable. |
| 13 | Observers use their own stage vocabulary (spec, tests, build, gate, review, **process, codebase**), and observation files carry an `outcome:` header. | The app shows the observer's vocabulary as it is written and does not map it onto pipeline stages. |
| 14 | With `AUTO_MERGE_MAX_TIER=none`, every PR waits for you, not just R2. | "Needs you" includes every PR above the auto-merge tier, as you decided. |
| 15 | Auto-merged and human-merged PRs have the same `mergedBy`, because the factory uses your `gh` token. | They are told apart through the GitHub timeline (`AutoMergeEnabledEvent` and `human-approved`), fetched with one GraphQL query. |

## 2. References: what I take and what I don't

- **Warp Factories.** Take: a "Waiting on you" home with **one row per work item** that
  clears itself when the state changes. Take: median cycle time per stage, and an
  autonomy figure (the share of items merged with no human rework). Don't take: LLM-judge
  scorers, because the gates are scripted, and team or multi-factory navigation.
- **disler/claude-code-hooks-multi-agent-observability, Claude-Code-Agent-Monitor, agents-observe.**
  Take:
  - a fixed envelope on every event;
  - an idempotent ingest;
  - an **abandoned** state for a run that has a `SubagentStart` but whose session ended without a `SubagentStop`;
  - a parent → subagent tree under each session.

  Don't take:
  - a tool-call timeline as the main view, which is noise for a work-item console;
  - hooks that POST to a server, because the factory already writes files and the files are the truth;
  - config editors or "run Claude" pages.
- **ccusage.** Take its rules for deduplicating tokens (row 12 above). Don't take its
  cost-in-dollars view: you are on a subscription, so the app shows tokens only.

## 3. Architecture

```
factory repo (read only)                          control-room process (127.0.0.1)
 work/*  .factory/events.jsonl  memory/  ...  ──►  sources/  fs.watch + git + gh + transcripts
 git refs, main tree, work/* branches               │  (I/O; every external call is execFile(argv), never a shell)
 gh api graphql (issues, PRs, checks, timeline)     ▼
                                                   core/     zod schemas → parsers → derive()   (pure, no I/O)
                                                    │
                                                   SQLite    node:sqlite, a cache rebuildable from the files
                                                    │        (gh cache + fetched_at, transcript token summaries,
                                                    │         event index for paging, FTS5 over observations)
                                                    ▼
                                                   http      JSON API + SSE "changed" + static web build
                                                    ▼
                                                   web/      React + Vite + Tailwind + shadcn/ui, TanStack Query
```

- **One package, three folders:** `server/` (with `server/core/` pure), `web/`, `demo/`.
  The server runs as TypeScript directly on Node 26, using native type stripping, so the
  server needs no build step. The web app imports types from `server/core` with
  type-only imports.
- **Deviations from your defaults, with reasons:**
  - `node:sqlite` in place of `better-sqlite3`: built in, so nothing native to compile, and FTS5 is present (I checked).
  - `node:http` in place of a framework: about 20 routes, so a framework adds nothing.
  - Charts as small hand-written SVG components in place of a chart library: every bar has to be a link to its items, and a library mostly gets in the way of that.
- **Several factories later:** all state hangs off a `Factory` instance created by
  `openFactory(path)`, with no module-level singletons. Adding a second repo means a
  map of instances and a path prefix on the routes.
- **Live updates:** recursive `fs.watch` on `work/`, `.factory/`, `memory/`,
  `docs/factory/`, `.claude/` and `factory/`, plus `.git/HEAD`, `.git/refs/` and
  `packed-refs`. Changes are debounced by 200 ms and only the affected sources are
  re-read. `events.jsonl` is tailed by byte offset: a partial last line is held back,
  and a truncated file is re-read. After `derive()` runs, SSE sends
  `{version, scopes}`, and the client invalidates those queries.
- **GitHub:** polled every 60 s through one GraphQL query each for issues and PRs
  (labels, timeline, checks, autoMerge, body, files). Each response is cached with its
  `fetched_at`. When a fetch fails or `gh` is missing, the app keeps the cache and
  shows "GitHub data from 2 h ago". `--demo` swaps in a fake GitHub backed by a JSON
  file. This is the only seam with two implementations.
- **Port:** tries 4317, then the next 20 ports, then lets the OS choose. It prints the URL.
- **Data directory:** `~/.control-room/<repo>-<hash>/` holds `index.sqlite` and
  `actions.log`. Deleting it is always safe. Nothing is ever written into the factory repo.

## 4. Data model (`server/core`, zod)

- `StageEvent { ts, work_id, branch, stage, status, round:number, detail?, tier?, pr?:number }`
- `LifecycleEvent { ts, work_id, branch, event, session_id?, agent_type?, agent_id?, transcript_path?, reason?, message? }`
- `Spec { id, title, risk_floor, tests, status, problem, criteria:[{id:'AC-n', text}], outOfScope[], assumptions[], blockingQuestions[], touchPoints[], followUps[] }`
- `Review { verdict, risk:{tier, why}, blocking:Finding[], nonBlocking:Finding[], verified[], notVerified[] }`, where `Finding { path?, line?, text }`
- `ObservationFile { date, id, slug, outcome?, items:[{priority, stage, text, source}] }`
- `Lesson { id, stage, text, evidence:number[], added, enforcement }`
- `Reflection { date, changes?:[{title, pattern, evidence, change, expected, howWeWillKnow, result?}], raw }`
- `Issue`, `PullRequest { number, head, state, labels, autoMerge, checks[], timeline[], body, files[], mergedAt }`
- Every parse returns `Parsed<T> = { ok:true, value, warnings[] } | { ok:false, error, raw }`. A
  failed parse never throws. The item still renders, with the notice and the raw text.
- `AgentRun { agentId, agentType, workId, sessionId, start, end?, outcome: running|finished|abandoned, model?, tokens? }`
  is built by pairing `SubagentStart` and `SubagentStop` on `agent_id`.

## 5. State derivation (the core; pure functions, tested first)

`deriveItem(inputs, policy, now, staleMinutes) → ItemState`. The inputs are the
deduplicated stage events, the lifecycle events, the work folder snapshot (with the
source and time of each file), the issue, the PR and git facts. All of them may be
partial.

**Per stage:** the rounds are max(`round`) and the duration is the sum over rounds of
start to end. Each stage is shown as not reached, running, passed, failed, blocked or
skipped. *(changed in build)* **Fix rounds** are the number of `failed` stage events,
charged to the stage that failed. Summing round numbers would count one review fix three
times, because it re-runs build, gate and review. **First pass** means merged with no
failed event. **Tier** is the highest of the spec's
`risk_floor`, the PR's `risk:` label, the pr event's `tier` and the review's `RISK`,
because nothing lowers it. Each source is listed.

**State.** Rules are checked in order and the first match wins. Each rule records its reason.

| # | State | Board column | Needs you? | Rule |
|---|---|---|---|---|
| 1 | merged | Merged | no | PR merged; offline, the work folder is present in `main`'s tree. Flag `reverted` if a revert PR or commit points at it. |
| 2 | closed | Stopped | no | PR closed unmerged, or issue closed, with no events afterwards. |
| 3 | blocked | Stopped | **answer** | `BLOCKED.md` exists with no `started` event after it, or the last stage event is `blocked`. The question is the file's text. |
| 4 | failed | Stopped | **look** | The last stage event is `failed`, with no event of any kind for `staleMinutes`. Also: an open PR with a failing required check. |
| 5 | awaiting-approval | Waiting for me | **approve** | Open PR, tier R2, no `human-approved` label. |
| 6 | awaiting-merge | Waiting for me | **merge** | Open PR above `AUTO_MERGE_MAX_TIER` (or with no auto-merge), checks not failing. |
| 7 | pr-open | PR open | no | Open PR with auto-merge set. Offline: a `pr passed` event with no merge evidence. |
| 8 | in-progress | In progress (stage) | flags | Any stage events or branch activity. Flags: `live` (an open SubagentStart in a live session), `waiting-input` (the session's last lifecycle event is a Notification, so Claude Code is waiting on you), `quiet` (the last event is `started` and nothing has happened for `staleMinutes`). |
| 9 | ready | Ready | no | Issue labelled `factory:ready`. |
| 10 | proposed | Proposed | no | Issue labelled `factory:proposed`. |

"Stopped" means the run halted with no PR. "Waiting for me" means a PR held at the human
gate. **"Needs you"** is one row per item, gathered from rows 3–6 plus the
`waiting-input` and `quiet` flags. It is ordered answer → approve → failed → waiting-input
→ quiet → merge, and each row clears itself when the item's state moves on. The default
for `staleMinutes` is 30. You can change it with `--stale-minutes`, and the UI shows
the value.

**Contradictions resolve to a state plus a visible notice, never a crash:**
- events after a merge;
- a `BLOCKED.md` followed by newer `started` events (the file is treated as stale);
- a `blocked` event with no file (the question comes from the event's `detail`);
- a spec `id` that differs from the folder;
- two folders for one id (the newer wins);
- an unknown stage or status (kept in Activity, ignored by `derive`);
- out-of-order timestamps (sorted, with file order kept when timestamps are equal);
- issue labels that disagree with the events (the events win);
- stale GitHub data (local rules apply and the card shows the data's age).

*(changed in build)* **Two more timing rules:**
- **When a `BLOCKED.md` was written.** If the file is untracked or modified, its time is
  its mtime. If it's tracked and unchanged, its time is its last commit, because a
  checkout rewrites mtimes.
- **How long "waiting for input" lasts.** A Notification counts as current until the next
  hook event, because nothing records the prompt being answered (proposal 14).

The demo generator writes `expected.json` (item → intended state, column and flags), and a
test asserts `derive()` matches it for **every** demo item. That covers "tests cover every
item state in the demo data" by construction.

## 6. Screens (desktop-first; collapse to one column under 900 px)

```
┌ sidebar ─┬ Control room ──────────────────────── GitHub: 40 s ago ● live ─┐
│ ● Room   │ NEEDS YOU (5)                                                   │
│   Board  │ ▲ #41 answer  spec   "Soft-delete or hard-delete accounts?"  2h │
│   Runs   │ ◆ #37 approve R2     migrations/0004_*.sql · review: pass    1d │
│   Quality│ ✕ #44 failed  gate r2 "make accept: 2 failing"                  │
│   Memory │ … #46 quiet   build  no event for 41 min                        │
│   Improve│ ⇢ #39 merge   R1     checks ✓ · policy: none                    │
│   Factory├─────────────────────────────────────────────────────────────────┤
│   Audits │ RUNNING NOW   #45 review r1 · reviewer (opus) · 6m 12s  ▮       │
│          ├─────────────────────────────────────────────────────────────────┤
│ ⌘K       │ MERGED  today 2 · this week 7   (list: id, title, tier, rounds) │
└──────────┴─────────────────────────────────────────────────────────────────┘
```
- **Board:** seven columns. A card shows `#id`, the title, a tier chip (a square,
  outlined `R2`), a status glyph and word, the rounds, the age in the current state and
  a live dot. Filters for tier and state are kept in the URL.
- **Item detail:** a stage strip across the top
  (`intake ✓ 2m │ spec ✓ 4m │ tests ✓ │ build ✓ r1 │ gate ✕→✓ r1 │ review …`). A
  "Not verified (n)" banner appears whenever the list is not empty. The tabs are:
  - **Spec:** each AC with the matching test references (lines containing `AC-n` in
    `tests/acceptance/<id>-<slug>*`) and the suite's pass state.
  - **Plan**
  - **Changes:** the files with the tier of each file and a lazy diff.
  - **Gates:** gate events by round, plus the `check`/`secrets`/`risk-gate` runs.
  - **Review:** findings grouped by severity.
  - **Activity:** a virtualised list of events, commits with trailers and agent runs.
  - **Not verified:** the review's NOT VERIFIED, the PR body's "Not verified",
    and ACs with no test found.
  - **Observations**
- **Runs:** a virtualised table with columns item, agent, model, start, duration,
  outcome, stage result and tokens. Filters, plus a live/historic toggle.
- **Quality:** small multiples, each titled with its question ("Are we merging more each
  week?"). The data is in weekly buckets from Monday, local time, over 12 weeks. Clicking
  any bar or number opens a side panel listing the items behind it. Escaped defects link
  to both the revert and the original item. Tokens appear only when they are readable.
- **Memory:** three views.
  - Lessons: each with evidence chips linking to items, its age and the enforcement level, plus a counter out of 40.
  - Observations: FTS search with filters for stage, priority and item.
    *(Changed in build: all-words substring search in the browser over the one memory payload,
    virtualised. A factory with ~1,000 items has ~10,000 observations, which this handles
    instantly. Move to FTS5 in the SQLite index when the payload gets too large to send.)*
  - Patterns: observation stage × week counts. Each count opens the observations behind it.
- **Improvement:** open `factory:improvement` PRs and a table of reflection changes, with
  the prediction and what happened since.
- **Factory:**
  - agents (model, tools)
  - skills
  - risk rules, with a "classify a path" box
  - the policy
  - hooks and permissions

  Each file is flagged if it differs from `main`, uncommitted or on a branch.
  *(Changed in build: "differs" means a local change, either a commit on the checked-out branch
  since it left `main` or an uncommitted edit. A branch that is only behind `main` is not
  drift, and those files show `main`'s copy. The policy is now read from `main` too, like
  the rules, because CI reads both from `main`. `.claude/worktrees/` is skipped and never
  watched.)*
- **Needs you** *(changed in build)* also lists open `factory:improvement` pull requests above
  the auto-merge tier. Their tier is the highest of the `risk:` label and the files,
  classified with `main`'s rules. They are R2 by path, so they wait for `human-approved`
  like any other R2 pull request.
- **Audits:** a list, newest first, rendered.

**Vocabulary everywhere:**
- stage = a lowercase word;
- status = a glyph plus a word (✓ passed, ✕ failed, ▲ blocked, … running, – skipped), coloured;
- tier = an outlined square chip, never coloured like a status;
- ids, paths, commands and test names are monospace.

**States:** each view has designed empty, loading, stale and error states. A factory with
no items shows the next step: "Run `/groom`, label an issue `factory:ready`, then `/work <id>`."

**Keyboard:** `⌘K` command palette (items, screens, actions); `g` then `r`/`b`/`u`/`q`/`m`/`i`/`f`/`a` to
jump to a screen; `j`/`k` and Enter in lists; `/` to filter; `?` for help. Light and dark
themes, following the system by default.

## 7. API (all GETs read; one JSON shape each, validated in tests)

```
GET  /api/state                    items[], needsYou[], running[], merged{today,week}, github{status,fetchedAt}, notices[], version
GET  /api/items/:id                full detail (parsed files with Parsed<> wrappers, stages, gates, runs, notVerified, observations)
GET  /api/items/:id/diff?file=     one file's patch; the file must be in that item's changed-file list (allowlist)
GET  /api/runs?item&agent&outcome&cursor
GET  /api/events?item&type&cursor&limit
GET  /api/quality?weeks=12         series + item ids behind every value
GET  /api/memory/{lessons,observations?q&stage&priority,patterns}
GET  /api/improvement   /api/factory   /api/audits   /api/audits/:date
GET  /api/stream                   SSE: changed {version, scopes[]}, heartbeat 15 s
── Phase 4, only with --actions ──
POST /api/actions/mark-ready       {issue}
GET  /api/actions/approve/:pr      preview: tier, R2 paths (+ matching rule), verdict, head SHA
POST /api/actions/approve          {pr, headSha, confirm:"approve #<pr>"}   refused if the head has moved
POST /api/actions/answer           {issue, body}   → gh issue comment
*(As built: `server/actions.ts` holds every change. The checks run in this order:
`--actions` must be set, otherwise no writer exists and every POST gets 405. Then: Origin is
this page; `Sec-Fetch-Site` is absent or same-origin; the per-launch token matches
(constant-time); the content type is JSON; the body is 64 KB or less. The input must pass a
strict zod schema. The action then re-checks live state: approve compares the head SHA
against a fresh `gh pr view`, accepts R2 only, and needs the typed confirmation. Each
action makes one `gh` call with an argument array; the answer text goes through stdin.
Every attempt, refusals included, is appended to `<data-dir>/actions.jsonl`, never with
the token. `--demo --actions` writes to the demo's `github.json`, so the whole flow works
offline. Results also appear in a toast, because the live update often unmounts the
button that started the action.)*
```
"Copy `/work <id>`" happens only in the browser.

## 8. Security

- The server binds to 127.0.0.1, and **every request** is checked for `Host` =
  `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- **Mutations:**
  - The routes exist only with `--actions`. Without the flag, any request method other
    than GET or HEAD gets a 405.
  - With the flag, a request needs:
    - the per-launch token, passed in a `<meta>` tag and sent back in a header;
    - an exact `Origin` match;
    - `Sec-Fetch-Site: same-origin` when the browser sends it;
    - a JSON body.
  - Each attempt and each result goes to `actions.log`.
  - The future "start a run" feature would sit behind its own `--allow-runs` flag, using the same wrapper.
- **External calls:** `gh` and `git` only through `execFile(argv)`, with `--` before any
  paths. Refs are validated (`^work/\d+-[a-z0-9-]+$`) and issue and PR numbers parsed as
  integers. **Transcripts** are read only when their real path is under `~/.claude/projects/`.
- **Rendered content:**
  - Markdown goes through `react-markdown` with GFM and no raw HTML. Images are not
    loaded; they are shown as links, so untrusted text cannot fire requests. Only
    `http`/`https` links work, and they get `noopener noreferrer`.
  - Strict CSP (`default-src 'self'`), with no inline scripts.
  - Nothing is executed from the factory repo. Risk classification is a TypeScript port of
    `classify-risk.sh`, checked by a parity test that runs the real script over fixtures.
- **Paths:** the client never sends a filesystem path apart from the diff file, which is
  checked against the allowlist above. Static assets are served from a map built at
  startup.

## 9. Phase plan

Each phase ends with:
- the app running against demo data;
- `npm test` green;
- Playwright screenshots of each new screen;
- a commit;
- a list of what I did not verify.

| Phase | Contents | Proof |
|---|---|---|
| 0 | Scaffold; demo generator (a real git repo with `work/*` branches and trailers, about 30 items, `github.json`, `expected.json`); all parsers; `derive()`; classify port | Unit tests, including contradictory and partial inputs; derive matches `expected.json` for every item |
| 1 | Server (watch, git, gh, SSE, security baseline); Control room, Board and Item detail, read-only and live | Playwright: `BLOCKED.md` → needs you in under 3 s; an appended event moves the card; a malformed file shows a notice |
| 2 | Runs, transcript tokens, Activity, stale detection, Quality; optional `--demo --simulate` ticker | Every Quality number links to items; offline test shows the stale banner |
| 3 | Memory (FTS), Improvement, Factory (drift vs `main`), Audits | Every lesson links to its evidence |
| 4 | Actions behind `--actions` | Tests: with the flag off, every non-GET request on every route is refused and makes no `gh` call and no write. With it on: missing token, wrong origin and wrong host are all refused; approval is refused if the head has moved |
| 5 | Command palette, keyboard, accessibility pass (axe in Playwright), performance pass (10k events), README with screenshots, `npm start -- <path>` / `npm start -- --demo` | Smoke test across every screen in both themes |

## 10. Proposed changes to the factory's data contract (so far)

1. Emit the intake events after the branch and folder exist, so the durable log is complete.
2. Write numbers as numbers (`jq --argjson` for `round` and `pr`).
3. Keep each review round (`review-<round>.md`) instead of overwriting `review.md`.
4. Record the gate per check, with an exit code and the classify per-file reasoning (`gate.jsonl`).
5. Save the per-test results from `make accept` (JUnit or JSON), and have the test-author write an AC → test table.
6. Drop the spec's `status:` or have the foreman update it.
7. Commit `BLOCKED.md` to the branch with a small header (`stage`, `question`), and put the question in the `blocked` event's `detail`.
8. Add `escaped-defect` and `factory:improvement` to the label setup, and have `/audit` apply `escaped-defect`.
9. Give reflections a fixed per-change shape with ids, and have the next reflection record `Result: <id> worked | no effect | worse`.
10. Add a `run` id to every stage event, so that re-runs of one item after it was blocked can be told apart.
11. Record the agent's model in the lifecycle events (telemetry can read it from the agent file).
12. Move the `L-000` format example in `lessons.md` into a comment.
13. Align the observer's stage names with the pipeline's, or document the mapping.
14. Record when a permission prompt or question is answered (for example a `UserPromptSubmit` or `PostToolUse` telemetry hook), so "Claude Code is waiting" clears at once.
15. Have observations cite the lessons they support or contradict (`Supports: L-3`). "No supporting observation in 60 days means removal" cannot be computed today, so the Memory screen shows only each lesson's age.
16. Give audits YAML front matter with the counts and the autonomy recommendation (`keep | raise | lower`). Audits can then be charted next to the Quality numbers they summarise.
17. Quote spec titles in front matter, or document that front matter is read line by line. A colon in a title breaks every YAML parser, although `validate-spec.sh` accepts it.
18. Have `risk-gate` report "waiting for approval" as a pending status, not a failure, on an unapproved R2 pull request. Today "failing" sometimes means "waiting for you". The control room tells the two apart using the check's `completedAt` and the label time. It assumes a real failure when either time is missing.
