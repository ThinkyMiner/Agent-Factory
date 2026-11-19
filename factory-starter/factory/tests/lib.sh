# Helpers for the factory's script tests. Plain bash 3.2 (macOS) compatible, no framework.
# A test file sources this, defines functions named
#   test_*  must pass
#   gap_*   a known hole, expected to fail until fixed; if it passes it is reported as XPASS
#           (and fails the run) so that it gets renamed to test_* instead of silently rotting
# and ends with `run_tests`. Each test runs in a subshell, in its own temp dir, under `set -e`.
set -uo pipefail

KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPTS="$KIT/factory/scripts"
HOOKS="$KIT/factory/hooks"

# Isolate git from the user's config (signing, hooks, default branch, identity).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=factory-test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=factory-test GIT_COMMITTER_EMAIL=test@example.invalid
unset FACTORY_ALLOW_SELF_EDIT CLAUDE_PROJECT_DIR

fail() { echo "      $*" >&2; return 1; }

# run <cmd...>: exit code in $RC, stdout in file $OUT, stderr in file $ERR.
run() { RC=0; "$@" >"$OUT" 2>"$ERR" || RC=$?; }
expect_rc()   { [ "$RC" = "$1" ] || fail "exit $RC, expected $1. stderr: $(head -c 400 "$ERR")"; }
expect_out()  { grep -qF -- "$1" "$OUT" || fail "stdout lacks [$1]; got: $(head -c 300 "$OUT")"; }
expect_err()  { grep -qF -- "$1" "$ERR" || fail "stderr lacks [$1]; got: $(head -c 300 "$ERR")"; }
expect_eq()   { [ "$1" = "$2" ] || fail "expected [$2], got [$1]${3:+ ($3)}"; }
lines()       { if [ -f "$1" ]; then awk 'END{print NR}' "$1"; else echo 0; fi; }

# mkrepo <dir>: a git repo on main with one empty commit.
mkrepo() { git init -q -b main "$1" && git -C "$1" commit -q --allow-empty -m init; }

# path_without <tool...>: prints a directory to use as PATH that has the usual tools minus these.
path_without() {
  local d tool p
  d=$(mktemp -d "$TEST_TMP/bin.XXXX")
  for tool in bash sh env cat grep egrep sed awk git date mkdir dirname basename head tail tr wc \
              rm mv cp ls sleep touch xcrun jq perl; do
    case " $* " in *" $tool "*) continue ;; esac
    p=$(command -v "$tool" 2>/dev/null) || continue
    case "$p" in /*) ln -s "$p" "$d/$tool" ;; esac
  done
  echo "$d"
}

# team_setup: a team-mode factory. Main checkout $MAIN (the orchestrator's) with a roster, and
# worktrees for backend ($BE) and frontend ($FE) where factory team-up would put them.
team_setup() {
  mkrepo app && mkdir -p app/factory app/server app/web app/product app/memory/observations
  cat > app/factory/teams.json <<'JSON'
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*"] },
             "backend":  { "owns": ["server/*", "db/*"] },
             "frontend": { "owns": ["web/*"] },
             "research": { "owns": ["research/*"], "active": false } },
  "append_only": ["memory/observations/*", "product/INBOX.md"] }
JSON
  echo "# Inbox" > app/product/INBOX.md; echo old > app/memory/observations/old.md
  git -C app add -A && git -C app commit -qm roster
  git -C app worktree add -q ../app.teams/backend -b team/backend
  git -C app worktree add -q ../app.teams/frontend -b team/frontend
  BE="$TEST_TMP/app.teams/backend"; FE="$TEST_TMP/app.teams/frontend"; MAIN="$TEST_TMP/app"
}
# fake_hc <dir> <log>: an hc in <dir> (put <dir> on PATH) that records each send in <log> as
# "<terminal>|<text>", plus "|<more args>" if it was given any, and each `hc keys` as
# "<terminal>|keys <key> <key>...". `hc ls --json` lists terminals t1 to
# t99, each with the status in $TEST_TMP/hc-status-<terminal>, else $TEST_TMP/hc-status, else done
# (hc's word for a session that has finished a turn and waits for input).
fake_hc() {
  mkdir -p "$1"
  { echo '#!/usr/bin/env bash'; printf 'log=%q\n' "$2"; cat <<'SH'
case "$1" in
  ls) for i in $(seq 1 99); do
        s=$(cat "$TEST_TMP/hc-status-t$i" 2>/dev/null || cat "$TEST_TMP/hc-status" 2>/dev/null || echo done)
        jq -cn --arg a "t$i" --arg s "$s" '{address: $a, status: $s}'
      done | jq -s '{terminals: .}' ;;
  send) printf '%s|%s%s\n' "$2" "$3" "${4:+|${*:4}}" >> "$log" ;;
  keys) printf '%s|keys %s\n' "$2" "${*:3}" >> "$log" ;;
  *) exit 3 ;;
esac
SH
  } > "$1/hc"
  chmod +x "$1/hc"
}
# fake_gh: the fake gh (factory/tests/fake-gh) first on PATH, its repository in $FAKE_GH.
fake_gh() {
  export FAKE_GH="$TEST_TMP/gh" FAKE_GH_USER=human
  mkdir -p "$FAKE_GH/bin" "$FAKE_GH/pulls" "$FAKE_GH/events"
  ln -sf "$KIT/factory/tests/fake-gh" "$FAKE_GH/bin/gh"
  export PATH="$FAKE_GH/bin:$PATH"
}
# fake_branches: after fake_gh, gh api also answers GET and PUT repos/{owner}/{repo}/branches/<b>/protection
# from $FAKE_GH/protection/<b>.json (a PUT stores its --input as given; no file: 404 "Branch not
# protected", as GitHub says). <b>.rc, if there, is the GET's exit code: like gh on an HTTP error, the
# body still goes to stdout and its message to stderr. Logged, and failed by $FAKE_GH/fail, like
# every fake gh call.
fake_branches() {
  mkdir -p "$FAKE_GH/protection"; rm -f "$FAKE_GH/bin/gh"
  printf '#!/usr/bin/env bash\nreal=%q\n' "$KIT/factory/tests/fake-gh" > "$FAKE_GH/bin/gh"
  cat >> "$FAKE_GH/bin/gh" <<'SH'
case "$*" in "api "*branches/*/protection*) ;; *) exec "$real" "$@" ;; esac
S=$FAKE_GH; printf '%s\n' "$*" >> "$S/log"
if [ -f "$S/fail" ]; then
  while IFS= read -r p; do [ -n "$p" ] && [[ "$*" == *$p* ]] && { echo "HTTP 502: fake failure" >&2; exit 1; }; done < "$S/fail"
fi
m=GET in=- b=""
while [ $# -gt 0 ]; do
  case "$1" in -X|--method) m=$2; shift ;; --input) in=$2; shift ;; repos/*) b=${1#repos/\{owner\}/\{repo\}/branches/}; b=${b%/protection} ;; esac; shift
done
f="$S/protection/$b.json"
case "$m" in
  GET) body=$(cat "$f" 2>/dev/null) && rc=$(cat "$f.rc" 2>/dev/null || echo 0) || { body='{"message":"Branch not protected","status":"404"}'; rc=1; }
       printf '%s\n' "$body"
       [ "$rc" = 0 ] || { echo "gh: $(printf '%s' "$body" | jq -r '"\(.message) (HTTP \(.status))"' 2>/dev/null)" >&2; exit "$rc"; } ;;
  PUT) mkdir -p "$(dirname "$f")"; if [ "$in" = - ]; then cat > "$f"; else cat "$in" > "$f"; fi; cat "$f" ;;
  *) echo "fake gh: no $m for branch protection" >&2; exit 1 ;;
esac
SH
  chmod +x "$FAKE_GH/bin/gh"
}
# fake_keychain [token]: a fake macOS `security` on PATH holding the bot's token (none if omitted).
fake_keychain() {
  mkdir -p "$TEST_TMP/kc"
  if [ $# -gt 0 ]; then printf '%s\n' "$1" > "$TEST_TMP/kc/token"; else rm -f "$TEST_TMP/kc/token"; fi
  cat > "$TEST_TMP/kc/security" <<'SH'
#!/usr/bin/env bash
[ "$1" = find-generic-password ] && [ -f "$TEST_TMP/kc/token" ] || exit 44
case " $* " in *" -s factory-github-bot "*"-w "*) cat "$TEST_TMP/kc/token" ;; *) exit 44 ;; esac
SH
  chmod +x "$TEST_TMP/kc/security"
  case ":$PATH:" in *":$TEST_TMP/kc:"*) ;; *) export PATH="$TEST_TMP/kc:$PATH" ;; esac
}
# planning_setup: a team-mode factory with three building teams and a bare origin, for meetings.
# $MAIN is the orchestrator's checkout; $BE, $FE, $RE the backend, frontend and research worktrees.
planning_setup() {
  mkrepo app && mkdir -p app/factory app/server app/web app/research && echo .factory/ > app/.gitignore
  cat > app/factory/teams.json <<'JSON'
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*"] },
             "backend":  { "owns": ["server/*"] },
             "frontend": { "owns": ["web/*"] },
             "research": { "owns": ["research/*"] },
             "design":   { "owns": ["design/*"], "active": false } } }
JSON
  git -C app add -A && git -C app commit -qm roster
  git clone -q --bare app origin.git && git -C app remote add origin "$TEST_TMP/origin.git" && git -C app fetch -q origin
  git -C app branch -q -u origin/main main
  for t in backend frontend research; do git -C app worktree add -q "../app.teams/$t" -b "team/$t" origin/main; done
  MAIN="$TEST_TMP/app"; BE="$TEST_TMP/app.teams/backend"; FE="$TEST_TMP/app.teams/frontend"; RE="$TEST_TMP/app.teams/research"
  fake_gh; export FACTORY_HUMAN=human
}
# by <team> <cmd...>: run cmd in that team's checkout as that team's session (sets RC/OUT/ERR)
by() {
  local t=$1; shift
  case "$t" in orchestrator) cd "$MAIN" ;; backend) cd "$BE" ;; frontend) cd "$FE" ;; research) cd "$RE" ;; *) cd "$TEST_TMP" ;; esac
  FACTORY_TEAM=$t run "$@"
}
# approve <pr> [label] [actor]: the label added a minute after the pull request's branch was last pushed
approve() {
  local ref; ref=$(jq -r .head.ref "$FAKE_GH/pulls/$1.json")
  local push at; push=$(perl -MPOSIX -e 'print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time - 120))'); at=$(perl -MPOSIX -e 'print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time - 60))')
  jq -n --arg r "refs/heads/$ref" --arg t "$push" '[{ref: $r, activity_type: "push", timestamp: $t}]' > "$FAKE_GH/activity.json"
  jq -n --arg l "${2:-brief-approved}" --arg a "${3:-human}" --arg t "$at" '[{id: 1, event: "labeled", label: {name: $l}, actor: {login: $a}, created_at: $t}]' > "$FAKE_GH/events/$1.json"
}
# brief_ok <cycle> <teams>: a filled-in brief in the main checkout
brief_ok() {
  cat > "$MAIN/planning/$1/BRIEF.md" <<EOF
# Brief: $1
teams: $2

## Goal
Let a reader share one note with a link that works without an account.

## Constraints
No new dependencies. Links must not reveal other notes.

## Out of scope
Editing through a shared link.
EOF
}
# position_ok: a position with every required section, on stdout
position_ok() {
  printf '## Build\n%s\n\n## Needs from others\nnone\n\n## Risks\nLink guessing.\n\n## Open questions\nHow long do links live?\n\n## What I would object to in the brief\nnone\n' "${1:-A share endpoint.}"
}
# decisions_ok <cycle-prefix> [status of D02] [dissent of D02] [refs of D02]: a valid DECISIONS.md on stdout
decisions_ok() {
  local p=$1
  cat <<EOF
# Decisions: $p

## $p-D01: Share links are signed tokens
- owner: backend
- affects: frontend, research
- status: decided
- risk_floor: R2
- contract: contracts/api.openapi.yaml#/paths/~1shares
### Decision
A share link carries a signed token naming one note.
### Reasoning
Tokens cannot be guessed and reveal nothing about other notes.
### Alternatives rejected
Sequential ids, which can be guessed.
### Dissent
none

## $p-D02: Links expire after 7 days
- owner: backend
- affects: frontend
- status: ${2:-decided}
- refs: ${4:-}
### Decision
Tokens expire seven days after they are made.
### Reasoning
Limits the damage of a leaked link.
### Alternatives rejected
Links that never expire.
### Dissent
${3:-none}

## Work breakdown

| item | team | delivers | after | contract | decisions |
|---|---|---|---|---|---|
| share-api | backend | POST /shares and GET /s/:token | - | contracts/api.openapi.yaml | $p-D01, $p-D02 |
| share-button | frontend | a Share button that copies the link | share-api | - | $p-D01 |
| share-research | research | who shares notes and why | - | - | $p-D02 |
EOF
}
# meeting_to <round> [teams]: cycle c001-share-links taken through the scripts to that round.
# Sets C (the cycle) and P (its folder in the main checkout).
meeting_to() {
  local want=$1 teams=${2:-backend, frontend, research} t
  C=c001-share-links; P="$MAIN/planning/$C"
  by orchestrator "$SCRIPTS/round.sh" open share-links; expect_rc 0
  brief_ok "$C" "$teams"
  by orchestrator "$SCRIPTS/round.sh" brief; expect_rc 0
  approve "$(jq .pr "$P/state.json")"
  by orchestrator "$SCRIPTS/round.sh" next; expect_rc 0
  [ "$want" = positions ] || [ "$want" = brief-approved ] && return 0
  [ "$(jq -r .status "$P/state.json")" = decisions ] && return 0       # a one-team cycle
  position_ok > "$TEST_TMP/pos"
  for t in $(echo "$teams" | tr ',' ' '); do by "$t" "$SCRIPTS/position.sh" submit < "$TEST_TMP/pos"; expect_rc 0; done
  by orchestrator "$SCRIPTS/round.sh" next; expect_rc 0; [ "$want" = discussion-1 ] && return 0
  by orchestrator "$SCRIPTS/round.sh" next; expect_rc 0; [ "$want" = review ] && return 0
  by orchestrator "$SCRIPTS/round.sh" next; expect_rc 0; [ "$want" = decisions ] && return 0
  return 0
}
# limits <json>: set factory/teams.json "limits" in every checkout
limits() {
  local d; for d in "$MAIN" "$BE" "$FE" "$RE"; do jq --argjson l "$1" '.limits = $l' "$d/factory/teams.json" > "$d/t.json" && mv "$d/t.json" "$d/factory/teams.json"; done
}
status_is() { expect_eq "$(jq -r .status "$P/state.json")" "$1"; }
run_tests() {
  local file fn rc p=0 f=0 g=0 x=0
  file=$(basename "${BASH_SOURCE[1]}" .sh)
  echo "$file"
  for fn in $(declare -F | awk '{print $3}' | grep -E '^(test|gap)_'); do
    TEST_TMP=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/factory-test.XXXXXX")" && pwd -P)
    OUT=$TEST_TMP/.out ERR=$TEST_TMP/.err
    export TEST_TMP OUT ERR
    ( cd "$TEST_TMP" || exit 99; set -e; "$fn" ) 2>"$TEST_TMP/.log"
    rc=$?
    case "$fn:$rc" in
      test_*:0) p=$((p+1)); echo "  ok     $fn" ;;
      test_*)   f=$((f+1)); echo "  FAIL   $fn"; sed 's/^/         /' "$TEST_TMP/.log" ;;
      gap_*:0)  x=$((x+1)); echo "  XPASS  $fn  (gap is closed: rename it to test_)" ;;
      gap_*)    g=$((g+1)); echo "  gap    $fn  (known, still open)" ;;
    esac
    rm -rf "$TEST_TMP"
  done
  echo "  -> $p passed, $f failed, $g known gaps, $x unexpectedly passing"
  [ -n "${FACTORY_TEST_TALLY:-}" ] && echo "$p $f $g $x" >> "$FACTORY_TEST_TALLY"
  [ "$f" -eq 0 ] && [ "$x" -eq 0 ]
}
