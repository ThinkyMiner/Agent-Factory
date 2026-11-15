#!/usr/bin/env bash
# Build slots: at most max_active_build_teams teams (factory/teams.json, default 2) build at once,
# so the sessions share one subscription without starving each other. /work takes a slot first.
#   slot.sh acquire     take a slot for this session's team; exit 3 and join the queue if all are taken
#   slot.sh release     give it back (when /work stops or opens its pull request)
#   slot.sh status      who holds a slot and who waits
# State: .factory/slots.json in the main checkout, changed only under .factory/slots.lock.
# The team is the session's (FACTORY_TEAM and its worktree), never an argument. A slot held by a
# session that died stays taken until that team releases it; the sweep reports old ones, and
# deleting .factory/slots.json frees them all.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "slot: $*" >&2; exit 1; }

action=${1:-}
case "$action" in acquire|release|status|_locked) ;; *) die "usage: slot.sh acquire|release|status" ;; esac
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
teams=$(teams_file "$top") || die "slots are for team mode, and this factory has no factory/teams.json"
home=$(factory_home "$top"); dir="$home/.factory"; f="$dir/slots.json"
mkdir -p "$dir"
max=$(jq -r '.max_active_build_teams // 2' "$teams" 2>/dev/null); [[ "$max" =~ ^[1-9][0-9]?$ ]] || max=2
state() { if jq -e '(.held | type == "object") and (.queue | type == "array")' "$f" >/dev/null 2>&1; then cat "$f"; else echo '{"held":{},"queue":[]}'; fi; }

if [ "$action" = status ]; then
  state | jq -r --argjson max "$max" '"slots: \(.held | length) of \($max) taken",
    (.held | to_entries[] | "  \(.key) since \(.value)"), (if (.queue | length) > 0 then "  waiting: \(.queue | join(", "))" else empty end)'
  exit 0
fi

me=$(session_team "$top") ||
  die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top). Slots belong to team sessions started by 'factory team-up'."
[ "$me" != orchestrator ] || die "the orchestrator does not build; slots are for building teams"

if [ "$action" != _locked ]; then
  rc=0; with_lock "$dir/slots.lock" bash "$0" _locked "$action" || rc=$?
  [ "$rc" != 75 ] || die "another session held the slot lock for more than ${FACTORY_LOCK_TIMEOUT:-5}s; try again"
  exit "$rc"
fi

# Under the lock from here on. $2 is the action.
now=$(date -u +%Y-%m-%dT%H:%M:%SZ); cur=$(state); out=""
case "${2:-}" in
  acquire)
    if jq -e --arg t "$me" '.held | has($t)' <<<"$cur" >/dev/null; then echo "slot: $me already holds a slot"; exit 0; fi
    if [ "$(jq '.held | length' <<<"$cur")" -lt "$max" ]; then
      jq --arg t "$me" --arg now "$now" '.held[$t] = $now | .queue -= [$t]' <<<"$cur" > "$f.new" && mv "$f.new" "$f"
      "$here/emit-event.sh" slot action=acquire >/dev/null 2>&1 || true
      echo "slot: $me holds a slot ($(jq '.held | length' "$f") of $max taken)"; exit 0
    fi
    jq --arg t "$me" 'if (.queue | index($t)) then . else .queue += [$t] end' <<<"$cur" > "$f.new" && mv "$f.new" "$f"
    "$here/emit-event.sh" slot action=queued >/dev/null 2>&1 || true
    echo "slot: all $max slots are taken ($(jq -r '.held | keys | join(", ")' "$f")). $me is queued: stop now, and run /work again when a slot is free." >&2
    exit 3 ;;
  release)
    if ! jq -e --arg t "$me" '.held | has($t)' <<<"$cur" >/dev/null; then echo "slot: $me holds no slot"; exit 0; fi
    jq --arg t "$me" 'del(.held[$t])' <<<"$cur" > "$f.new" && mv "$f.new" "$f"
    "$here/emit-event.sh" slot action=release >/dev/null 2>&1 || true
    out=$(jq -r '.queue | if length > 0 then " Waiting: \(join(", "))." else "" end' "$f")
    echo "slot: $me released its slot.$out" ;;
  *) die "usage: slot.sh acquire|release|status" ;;
esac
