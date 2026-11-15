#!/usr/bin/env bash
# A contract's first author: promote a team's draft from a planning cycle into contracts/.
#   contracts.sh promote <cycle> <attachment-name> <contracts/path>
# The orchestrator only, in the main checkout on branch planning/<cycle>, while that cycle is the
# one in progress and in its decisions or approval round. The human approves the contract with
# DECISIONS.md, by merging the planning pull request. After that a contract changes only under a
# type:contract-change ticket the receiving team accepted (ticket.sh, guard.sh, check-ownership.sh).
# Refuses: an attachment that is not a regular file directly in planning/<cycle>/attachments/
# (no ../, symlink or subdirectory; at most 200000 bytes, as position.sh takes them); a target
# that is not a clean path of a file under contracts/ (letters, digits, . _ - and /; no .., //
# or leading -); a target already on origin/main (later changes go through tickets); a target
# no record in planning/<cycle>/DECISIONS.md names in a contract: line (without the #fragment).
# Then: copies the draft, appends {ts, cycle, attachment, path, decisions} to
# planning/<cycle>/contracts.jsonl, commits both on the planning branch, pushes it and writes a
# contract event. Exit 0 promoted, 1 refused or failed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "contracts: $*" >&2; exit 1; }

[ "${1:-}" = promote ] && [ $# -eq 4 ] || { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }
cyc=$2 att=$3 path=$4
[[ "$cyc" =~ ^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || die "the cycle must look like c001-share-links"
[[ "$att" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || die "the attachment is a file name in planning/$cyc/attachments/ (letters, digits, . _ -)"
valid_contract_path "$path" || die "the target must be a clean path of a file under contracts/ (letters, digits, . _ - and /, no ..), like contracts/api.openapi.yaml"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams_file "$home" >/dev/null || die "contracts are promoted in team mode, and this factory has no factory/teams.json"
me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
[ "$me" = orchestrator ] || die "only the orchestrator promotes contract drafts; $me asks for a contract change with ticket.sh"
[ "$(active_cycle "$home" || true)" = "$cyc" ] || die "$cyc is not the planning cycle in progress"
[ "$(git -C "$home" rev-parse --abbrev-ref HEAD)" = "planning/$cyc" ] || die "the main checkout is not on planning/$cyc; switch back to it first"
dir="$home/planning/$cyc"
st=$(jq -r 'select(type == "object") | .status // empty' "$dir/state.json" 2>/dev/null || true)
case "$st" in decisions|approval) ;; *) die "drafts are promoted in the decisions or approval round (the cycle is ${st:-unreadable})" ;; esac

src="$dir/attachments/$att"
for p in "$home/planning" "$dir" "$dir/attachments" "$src"; do [ ! -L "$p" ] || die "${p#"$home"/} is a symlink; promote only what round.sh published"; done
[ -f "$src" ] || die "planning/$cyc/attachments/$att is not a published attachment (round.sh publishes them with the positions)"
[ "$(wc -c < "$src" | tr -d ' ')" -le 200000 ] || die "planning/$cyc/attachments/$att is over 200000 bytes, more than position.sh takes"
p=$home; IFS=/ read -r -a parts <<<"$path"
for c in "${parts[@]}"; do p="$p/$c"; [ ! -L "$p" ] || die "$path passes through a symlink (${p#"$home"/})"; done
[ ! -d "$home/$path" ] || die "$path is a directory"

git -C "$home" fetch -q origin 2>/dev/null || die "cannot reach origin"
git -C "$home" rev-parse -q --verify refs/remotes/origin/main >/dev/null || die "origin has no main branch"
! git -C "$home" cat-file -e "origin/main:$path" 2>/dev/null ||
  die "$path is already on main. A contract has one first author; a change to it is a contract-change ticket (ticket.sh create --type contract-change)"
ids=$(decision_contracts "$dir/DECISIONS.md" | awk -v p="$path" '$2 == p {print $1}' | sort -u)
[ -n "$ids" ] || die "no record in planning/$cyc/DECISIONS.md names $path in a contract: line; the decision comes first"

mkdir -p "$(dirname "$home/$path")"
cp "$src" "$home/$path"
jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg c "$cyc" --arg a "$att" --arg p "$path" --arg d "$ids" \
  '{ts: $ts, cycle: $c, attachment: $a, path: $p, decisions: ($d | split("\n") | map(select(length > 0)))}' >> "$dir/contracts.jsonl"
git -C "$home" add -- "$path" "planning/$cyc/contracts.jsonl"
git -C "$home" commit -qm "planning $cyc: promote $att to $path" -- "$path" "planning/$cyc/contracts.jsonl"
git -C "$home" push -q -u origin "planning/$cyc" 2>/dev/null || die "could not push planning/$cyc"
"$here/emit-event.sh" contract action=promote cycle="$cyc" attachment="$att" path="$path" decisions="$(echo $ids)" >/dev/null 2>&1 || true
echo "contracts: $att is now $path on planning/$cyc (decisions: $(echo $ids)). The human approves it with DECISIONS.md."
