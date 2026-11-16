#!/usr/bin/env bash
# After the human approved a cycle's decisions (merged its planning pull request), hand the work out.
#   dispatch.sh <cycle>        the orchestrator only
# Refuses unless planning/<cycle>/DECISIONS.md is on origin/main, valid, with no needs-human
# record left, and the cycle's state there is "approval". Version 1 runs one feature at a time, so
# it also refuses while any feature/* branch is still on origin. Integration needs acceptance
# criteria, which the research team writes, so research must be an active team.
# Then: makes feature/f<NNN>-<slug> from origin/main, writes planning/<cycle>/dispatch.jsonl (one
# line per work-breakdown item, plus research's item "acceptance" delivering
# features/f<NNN>-<slug>/acceptance.md from every record of the cycle, unless a research row already
# delivers it) and state "dispatched" on it, pushes it, and protects it like main: the same required
# status checks and strict flag, enforce_admins, no reviews, no push restrictions. Main's protection
# is read before anything is made. Main unprotected: said, and dispatch carries on. GitHub refusing
# to protect the feature branch while main is protected: the branch is removed again and dispatch
# stops. Then it ends the cycle (the next one may open), writes a dispatch event per item and rings
# each team that has items: run /inbox. The main checkout is left on main.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "dispatch: $*" >&2; exit 1; }

cyc=${1:-}
[[ "$cyc" =~ ^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || die "usage: dispatch.sh <cycle> (like c001-share-links)"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
roster=$(teams_file "$home") || die "dispatch is for team mode, and this factory has no factory/teams.json"
me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
[ "$me" = orchestrator ] || die "only the orchestrator dispatches"
team_names "$roster" | grep -qx research ||
  die "research is not an active team in factory/teams.json: integration needs acceptance criteria, which the research team writes. Add it to the roster (docs/factory/TEAMS.md) and dispatch again"
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

# Research's acceptance criteria, unless the breakdown already gives research that file.
acc="features/$feature/acceptance.md"
if ! printf '%s\n' "$items" | jq -e --arg p "$acc" 'select(.team == "research" and (.delivers | contains($p)))' >/dev/null; then
  ! printf '%s\n' "$items" | jq -e 'select(.item == "acceptance")' >/dev/null ||
    die "the work breakdown has an item named acceptance that is not research delivering $acc; that name is kept for research's acceptance criteria"
  recs=$(grep -oE "^## ${cyc%%-*}-D[0-9]{2}:" "$dir/DECISIONS.md" | sed 's/^## //; s/:$//' | jq -R . | jq -sc .)
  items+=$'\n'$(jq -nc --arg d "$acc: the feature's acceptance criteria" --argjson ds "$recs" \
    '{item: "acceptance", team: "research", delivers: $d, after: [], contract: "", decisions: $ds}')
fi

# Main's protection, read before anything is made. When main has none, gh answers 404 "Branch not
# protected", or 403 "Upgrade to GitHub Pro" for a private repository on a free plan.
perr=$(mktemp); trap 'rm -f "$perr"' EXIT
if prot=$(cd "$home" && gh api 'repos/{owner}/{repo}/branches/main/protection' 2>"$perr"); then
  put=$(jq -sce 'select(length == 1) | .[0] | select(type == "object" and (.enforce_admins.enabled | type) == "boolean"
          and (.required_status_checks == null or ((.required_status_checks.strict | type) == "boolean"
               and (.required_status_checks.contexts | type) == "array" and all(.required_status_checks.contexts[]; type == "string"))))
        | {required_status_checks: (.required_status_checks | if . then {strict, contexts} else null end),
           enforce_admins: .enforce_admins.enabled, required_pull_request_reviews: null, restrictions: null}' <<<"$prot" 2>/dev/null) ||
    die "cannot read main's branch protection: gh did not return required_status_checks and enforce_admins as GitHub does. Nothing was dispatched"
elif grep -qE 'Branch not protected|Upgrade to GitHub Pro' <<<"$prot$(cat "$perr")"; then
  put=""
else
  die "cannot read main's branch protection: $(head -c 300 "$perr"). Nothing was dispatched"
fi

git -C "$home" switch -q -c "feature/$feature" origin/main || die "could not make feature/$feature"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$items" | jq -c --arg c "$cyc" --arg f "$feature" --arg ts "$ts" '{ts: $ts, cycle: $c, feature: $f} + .' > "$dir/dispatch.jsonl"
jq --arg f "$feature" --arg ts "$ts" '.status = "dispatched" | .feature = $f | .history += [{status: "dispatched", at: $ts}]' "$dir/state.json" > "$dir/state.json.new" && mv "$dir/state.json.new" "$dir/state.json"
git -C "$home" add -- "planning/$cyc" && git -C "$home" commit -qm "dispatch $cyc as $feature" -- "planning/$cyc"
git -C "$home" push -q -u origin "feature/$feature" 2>/dev/null || die "could not push feature/$feature"
git -C "$home" switch -q main

if [ -z "$put" ]; then
  echo "dispatch: main has no branch protection, so feature/$feature has none either. The CI feature gate refuses to merge an unprotected feature: protect main (factory github)."
elif printf '%s\n' "$put" | (cd "$home" && gh api -X PUT "repos/{owner}/{repo}/branches/feature/$feature/protection" --input - >/dev/null 2>"$perr"); then
  echo "dispatch: feature/$feature is protected like main (its required checks, no direct pushes)."
else
  why=$(head -c 300 "$perr")
  undo="feature/$feature is removed again"
  git -C "$home" push -q origin --delete "feature/$feature" 2>/dev/null || undo="delete feature/$feature by hand (git push origin --delete feature/$feature)"
  git -C "$home" branch -qD "feature/$feature" 2>/dev/null || true
  die "GitHub refused to protect feature/$feature like main: $why. Nothing was dispatched; $undo. Protecting a branch needs admin rights on the repository: run dispatch.sh again as an account that has them (gh auth status shows this one)"
fi
[ "$(active_cycle "$home" 2>/dev/null)" != "$cyc" ] || rm -f "$home/.factory/planning/active"

while IFS=$'\t' read -r t it; do
  "$here/emit-event.sh" dispatch cycle="$cyc" feature="$feature" to="$t" item="$it" >/dev/null 2>&1 || true
done < <(printf '%s\n' "$items" | jq -r '[.team, .item] | @tsv')
"$here/emit-event.sh" round cycle="$cyc" status=dispatched >/dev/null 2>&1 || true
echo "dispatch: $cyc is feature/$feature, $(printf '%s\n' "$items" | grep -c .) item(s)."
for t in $(printf '%s\n' "$items" | jq -r .team | sort -u); do
  ring_team "$home" "$t" "New items for you: run /inbox." && echo "dispatch: rang $t" || echo "dispatch: could not ring $t (busy, or no Herdr): tell it to run /inbox"
done
