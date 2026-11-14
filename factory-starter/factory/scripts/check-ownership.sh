#!/usr/bin/env bash
# CI check for team mode: a pull request may change only paths its team owns.
#   check-ownership.sh [base-ref]        (default origin/main)
# The pull request's team is the `team:` of the one work folder it carries (work/<id>-<slug>/).
# Every changed path must then be: that work folder, a path the team owns, or an append-only
# location that only grew. A pull request that changes only the factory's own files (.claude/,
# factory/, .github/, teams/, docs/factory/, memory/lessons.md, memory/reflections/) and the human's own
# (CLAUDE.md, product/BRIEF.md, product/ROADMAP.md) is the human's change: R2 in
# risk-rules.txt, so it needs the human-approved label, and it is exempt here.
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

echo "ownership: pull request for work/$item, team $team"
bad=0
while IFS= read -r -d '' f; do
  verdict=""
  case "$f" in "work/$item/"*) verdict="own work folder" ;; esac
  if [ -z "$verdict" ] && is_factory_path "$f"; then           # even if a roster glob covers it
    bad=1; verdict="NOT OK: a factory file; factory changes go in their own pull request"
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
