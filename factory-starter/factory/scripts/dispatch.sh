#!/usr/bin/env bash
# After the human approved a cycle's decisions (merged its planning pull request), hand the work out.
#   dispatch.sh <cycle>        the orchestrator only
# Refuses unless planning/<cycle>/DECISIONS.md is on origin/main, valid, with no needs-human
# record left, and the cycle's state there is "approval". Version 1 runs one feature at a time, so
# it also refuses while any feature/* branch is still on origin.
# Then: makes feature/f<NNN>-<slug> from origin/main, writes planning/<cycle>/dispatch.jsonl (one
# line per work-breakdown item) and state "dispatched" on it, pushes it, ends the cycle (the next
# one may open), writes a dispatch event per item and rings each team that has items: run /inbox.
# The main checkout is left on main.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "dispatch: $*" >&2; exit 1; }

cyc=${1:-}
[[ "$cyc" =~ ^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || die "usage: dispatch.sh <cycle> (like c001-share-links)"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams_file "$home" >/dev/null || die "dispatch is for team mode, and this factory has no factory/teams.json"
me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
[ "$me" = orchestrator ] || die "only the orchestrator dispatches"
[ -z "$(git -C "$home" status --porcelain)" ] || die "the main checkout has uncommitted changes"
git -C "$home" fetch -q --prune origin || die "cannot reach origin"
git -C "$home" cat-file -e "origin/main:planning/$cyc/DECISIONS.md" 2>/dev/null ||
  die "planning/$cyc/DECISIONS.md is not on origin/main: the human approves the decisions by merging the planning pull request"
open=$(git -C "$home" for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin/feature/ | grep -v '^HEAD$' | head -1 || true)
[ -z "$open" ] || die "$open is still open; version 1 runs one feature branch at a time"

git -C "$home" switch -q main 2>/dev/null || git -C "$home" switch -q -c main origin/main
git -C "$home" merge -q --ff-only origin/main || die "the main checkout's main has diverged from origin/main"
dir="$home/planning/$cyc"
st=$(jq -r '.status // empty' "$dir/state.json" 2>/dev/null || true)
[ "$st" = approval ] || die "the cycle's state on main is '${st:-unreadable}', not approval"
items=$(bash "$here/decisions.sh" items "$dir") || die "the approved decisions cannot be dispatched (above)"

feature="f${cyc#c}"
git -C "$home" switch -q -c "feature/$feature" origin/main || die "could not make feature/$feature"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$items" | jq -c --arg c "$cyc" --arg f "$feature" --arg ts "$ts" '{ts: $ts, cycle: $c, feature: $f} + .' > "$dir/dispatch.jsonl"
jq --arg f "$feature" --arg ts "$ts" '.status = "dispatched" | .feature = $f | .history += [{status: "dispatched", at: $ts}]' "$dir/state.json" > "$dir/state.json.new" && mv "$dir/state.json.new" "$dir/state.json"
git -C "$home" add -- "planning/$cyc" && git -C "$home" commit -qm "dispatch $cyc as $feature" -- "planning/$cyc"
git -C "$home" push -q -u origin "feature/$feature" 2>/dev/null || die "could not push feature/$feature"
git -C "$home" switch -q main
[ "$(active_cycle "$home" 2>/dev/null)" != "$cyc" ] || rm -f "$home/.factory/planning/active"

while IFS=$'\t' read -r t it; do
  "$here/emit-event.sh" dispatch cycle="$cyc" feature="$feature" to="$t" item="$it" >/dev/null 2>&1 || true
done < <(printf '%s\n' "$items" | jq -r '[.team, .item] | @tsv')
"$here/emit-event.sh" round cycle="$cyc" status=dispatched >/dev/null 2>&1 || true
echo "dispatch: $cyc is feature/$feature, $(printf '%s\n' "$items" | grep -c .) item(s)."
for t in $(printf '%s\n' "$items" | jq -r .team | sort -u); do
  ring_team "$home" "$t" "New items for you: run /inbox." && echo "dispatch: rang $t" || echo "dispatch: could not ring $t (busy, or no Herdr): tell it to run /inbox"
done
