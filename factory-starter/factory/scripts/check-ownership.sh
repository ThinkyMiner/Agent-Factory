#!/usr/bin/env bash
# CI check for team mode: a pull request may change only paths its team owns.
#   check-ownership.sh [base-ref]        (default origin/main)
# The pull request's team is the `team:` of the one work folder it carries (work/<id>-<slug>/).
# Every changed path must then be: that work folder, a path the team owns, or an append-only
# location that only grew. A pull request that changes only the factory's own files (.claude/,
# factory/, .github/, teams/, docs/factory/, memory/lessons.md, memory/reflections/) and the human's own
# (CLAUDE.md, product/BRIEF.md, product/ROADMAP.md) is the human's change: R2 in
# risk-rules.txt, so it needs the human-approved label, and it is exempt here.
# A planning/<cycle> branch's pull request may change only planning/<cycle>/ (and, to supersede,
# earlier cycles' DECISIONS.md), and add contracts/ files that are not on the base branch, each
# listed in planning/<cycle>/contracts.jsonl and named by a contract: line in its DECISIONS.md
# (contracts.sh promote). It never changes or deletes a contract that is on the base branch.
# A team's pull request changes contracts/ only when its work folder's id is a GitHub issue
# labelled ticket, type:contract-change, to:<its team> and state:accepted or state:done (read with
# gh, so GH_TOKEN and GH_REPO in CI); a gh failure is a violation, never a pass.
# The roster is read from the base branch (or $TEAMS_FILE), never from the pull request, so a
# pull request cannot widen its own ownership. No roster on the base branch: single-team mode, ok.
# Exit 0 ok, 1 a violation, 2 usage or environment.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh" || exit 2
command -v jq >/dev/null 2>&1 || { echo "ownership: jq is not installed" >&2; exit 2; }

base=${1:-origin/main}
git rev-parse -q --verify "$base^{commit}" >/dev/null || { echo "ownership: unknown base ref $base" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
teams=${TEAMS_FILE:-}
if [ -z "$teams" ]; then
  if ! git show "$base:factory/teams.json" > "$tmp/teams.json" 2>/dev/null; then
    echo "ownership: no factory/teams.json on $base: single-team mode, nothing to check"
    exit 0
  fi
  teams="$tmp/teams.json"
fi
jq -e '.teams | type == "object"' "$teams" >/dev/null 2>&1 || { echo "ownership: the roster on $base is unreadable" >&2; exit 1; }

is_factory_path() {
  case "$1" in .claude/*|factory/*|.github/*|teams/*|docs/factory/*|memory/lessons.md|memory/reflections/*) return 0 ;; esac
  return 1
}
is_human_path() {
  case "$1" in CLAUDE.md|product/BRIEF.md|product/ROADMAP.md) return 0 ;; esac
  return 1
}

n=0; nonfactory=0; folders=""
while IFS= read -r -d '' f; do
  printf '%s\0' "$f" >> "$tmp/files"
  n=$((n + 1))
  is_factory_path "$f" || is_human_path "$f" || nonfactory=1
  case "$f" in
    work/*/*) item=${f#work/}; item=${item%%/*}
              case " $folders " in *" $item "*) ;; *) folders="$folders $item" ;; esac ;;
  esac
done < <(git diff -z --name-only --no-renames "$base"...HEAD)

if [ "$n" -eq 0 ]; then echo "ownership: no changes"; exit 0; fi

# A planning pull request (branch planning/<cycle>, from $HEAD_REF in CI) carries only its cycle's
# record. The one exception: an earlier cycle's DECISIONS.md, where a record it supersedes gains
# status: superseded (decisions.sh check-append-only checks that nothing else changed).
head_ref=${HEAD_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}
case "$head_ref" in
  planning/*)
    cyc=${head_ref#planning/}
    if ! [[ "$cyc" =~ ^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]]; then
      echo "ownership: $head_ref is not a planning cycle's branch (planning/c001-slug)" >&2; exit 1
    fi
    echo "ownership: planning pull request for $cyc"
    git show "HEAD:planning/$cyc/contracts.jsonl" > "$tmp/contracts.jsonl" 2>/dev/null || : > "$tmp/contracts.jsonl"
    git show "HEAD:planning/$cyc/DECISIONS.md" > "$tmp/decisions.md" 2>/dev/null || : > "$tmp/decisions.md"
    bad=0
    while IFS= read -r -d '' f; do
      case "$f" in
        "planning/$cyc/"*) verdict="this cycle's record" ;;
        planning/*/DECISIONS.md) verdict="an earlier cycle's decisions (superseding only)" ;;
        contracts/*)
          if git cat-file -e "$base:$f" 2>/dev/null; then verdict="NOT OK: an approved contract changes only under a contract-change ticket"
          elif ! valid_contract_path "$f"; then verdict="NOT OK: not a clean path of a file under contracts/"
          elif ! [[ "$(git ls-tree HEAD -- "$f" | cut -c1-6)" =~ ^100(644|755)$ ]]; then verdict="NOT OK: not a regular file"
          elif ! jq -Rn -e --arg c "$cyc" --arg p "$f" 'any(inputs | fromjson? | objects; .cycle == $c and .path == $p)' "$tmp/contracts.jsonl" >/dev/null 2>&1; then
            verdict="NOT OK: not promoted by contracts.sh (planning/$cyc/contracts.jsonl)"
          elif ! decision_contracts "$tmp/decisions.md" | awk -v p="$f" '$2 == p {found = 1} END {exit !found}'; then
            verdict="NOT OK: no record in planning/$cyc/DECISIONS.md names it in a contract: line"
          else verdict="a new contract this cycle decides"; fi ;;
        *) verdict="NOT OK: a planning pull request changes only planning/$cyc/" ;;
      esac
      case "$verdict" in NOT\ OK*) bad=1 ;; esac
      printf '  %s  (%s)\n' "$f" "$verdict"
    done < "$tmp/files"
    [ "$bad" = 0 ] || { echo "ownership: this planning pull request changes paths it may not (above)" >&2; exit 1; }
    echo "ownership: ok"; exit 0 ;;
esac
if [ "$nonfactory" -eq 0 ]; then
  echo "ownership: factory or human-owned files only (R2, read by the human): not a team's pull request"
  exit 0
fi

set -- $folders
if [ "$#" -ne 1 ]; then
  echo "ownership: a team's pull request carries exactly one work folder; this one has $#:${folders:- none}" >&2
  exit 1
fi
item=$1
if ! git show "HEAD:work/$item/spec.md" > "$tmp/spec.md" 2>/dev/null; then
  echo "ownership: work/$item has no spec.md, so its team is unknown" >&2
  exit 1
fi
team=$(spec_team "$tmp/spec.md" "$(jq -r '.default_team // empty' "$teams")")
if [ -z "$team" ] || ! team_names "$teams" | grep -qxF -- "$team"; then
  echo "ownership: work/$item names team '${team}', which is not an active team on $base" >&2
  exit 1
fi

# contract_ticket: is work/$item's id an accepted contract-change ticket to $team? Asks GitHub once;
# sets $ticket to "ok" or to why not.
ticket=""
contract_ticket() {
  local id=${item%%-*} labels l
  [ -z "$ticket" ] || return 0
  if ! [[ "$id" =~ ^[1-9][0-9]{0,8}$ ]]; then ticket="work/$item does not start with an issue number"; return 0; fi
  if ! labels=$(gh issue view "$id" --json labels --jq '.labels[].name' </dev/null 2>"$tmp/gh.err"); then
    ticket="cannot read issue #$id from GitHub: $(head -c 200 "$tmp/gh.err" | tr '\n' ' ')"; return 0
  fi
  for l in ticket type:contract-change "to:$team"; do
    grep -qxF -- "$l" <<<"$labels" || { ticket="issue #$id is not a contract-change ticket to $team (no label $l)"; return 0; }
  done
  grep -qxE 'state:(accepted|done)' <<<"$labels" || { ticket="ticket #$id is not accepted (state:accepted or state:done)"; return 0; }
  ticket=ok
}

echo "ownership: pull request for work/$item, team $team"
bad=0
while IFS= read -r -d '' f; do
  verdict=""
  case "$f" in "work/$item/"*) verdict="own work folder" ;; esac
  if [ -z "$verdict" ] && is_factory_path "$f"; then           # even if a roster glob covers it
    bad=1; verdict="NOT OK: a factory file; factory changes go in their own pull request"
  fi
  if [ -z "$verdict" ]; then
    case "$f" in contracts/*)                                    # even if a roster glob covers it
      contract_ticket
      if [ "$ticket" = ok ]; then verdict="contract change under ticket #${item%%-*}"; else bad=1; verdict="NOT OK: a contract; $ticket"; fi ;;
    esac
  fi
  if [ -z "$verdict" ] && team_owns "$teams" "$team" "$f"; then verdict="owned by $team"; fi
  if [ -z "$verdict" ] && is_append_only "$teams" "$f"; then
    if ! git cat-file -e "HEAD:$f" 2>/dev/null; then
      verdict="DELETES an append-only file"
    elif ! git cat-file -e "$base:$f" 2>/dev/null; then
      verdict="new append-only file"
    elif [ "$(git diff --numstat "$base"...HEAD -- "$f" | awk '{d += $2} END {print d + 0}')" != 0 ]; then
      verdict="REMOVES lines from an append-only file"
    else
      verdict="appends only"
    fi
    case "$verdict" in DELETES*|REMOVES*) bad=1; verdict="NOT OK: $verdict" ;; esac
  fi
  if [ -z "$verdict" ]; then
    bad=1
    if is_factory_path "$f"; then
      verdict="NOT OK: a factory file; factory changes go in their own pull request"
    else
      owner=$(path_owner "$teams" "$f")
      verdict="NOT OK: owned by ${owner:-no team}, not $team"
    fi
  fi
  printf '  %s  (%s)\n' "$f" "$verdict"
done < "$tmp/files"

if [ "$bad" -ne 0 ]; then
  echo "ownership: this pull request changes paths team $team does not own. Ask the owning team for the change (a ticket) instead." >&2
  exit 1
fi
echo "ownership: ok"
