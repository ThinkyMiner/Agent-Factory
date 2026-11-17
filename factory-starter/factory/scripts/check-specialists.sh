#!/usr/bin/env bash
# CI check for team mode: the work item carries the specialists' reports its tier, team and paths
# call for, and each one says pass.
#   check-specialists.sh <base-ref> <tier>           check the pull request (base...HEAD, read at HEAD)
#   check-specialists.sh --needs <base-ref> <tier>   print the names of the reports the item needs,
#                                                    one per line, and exit 0. Reads the working tree
#                                                    (committed or not), for /work mid-run.
# <tier> is risk-tier.sh's result. Required, in the one work folder (work/<id>-<slug>/):
#   review.md      always (reviewer), except when the spec's team has "evidence_review": true in
#                  the roster (research): evidence-review.md instead (evidence-reviewer)
#   ui-review.md   when the spec's team has "ui_review": true in the roster (ui-reviewer)
#   security.md    when <tier> is R2 or R3 (security-engineer), unless the change holds nothing but
#                  acceptance criteria or an acceptance review (features/<f>/acceptance.md,
#                  acceptance-review.md), its work folder and observations: those documents judge a
#                  build, and the build's own review at its tier checks security against the same records
#   db-review.md   when a changed path matches the roster's "db_paths" (db-engineer); globs as in
#                  risk-rules.txt (* also matches /), default ["db/*", "*migrations/*", "*schema*"]
# A report passes only when its first line starting with VERDICT: is exactly "VERDICT: pass" (spaces
# and \r allowed around the word, nothing else: a copied "pass | changes-required" never passes). One line per requirement: ok, MISSING, or NOT PASSING with the verdict found.
# The roster comes from the base branch (or $TEAMS_FILE), never from the pull request. No roster:
# single-team mode, nothing to check (--needs prints review.md, which /work runs on every item).
# A pull request with no work folder (factory, human or planning files) is exempt; --needs refuses
# it. More than one work folder, no spec, or a team that is not active: exit 1.
# With HEAD_REF (the head branch, in CI) integrate/<f>, the check is exempt: each work folder passed it
# when it merged into feature/<f>, and check-ownership.sh makes sure they arrive unchanged. An
# integrate/ HEAD_REF that is not integrate/<feature id> fails. --needs ignores HEAD_REF.
# Exit 0 ok, 1 something missing or not passing, 2 usage or environment.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh" || exit 2
usage() { echo "usage: check-specialists.sh [--needs] <base-ref> <R0|R1|R2|R3>" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "specialists: jq is not installed" >&2; exit 2; }

needs=0
[ "${1:-}" = --needs ] && { needs=1; shift; }
[ $# -eq 2 ] || usage
base=$1 tier=$2
[[ "$tier" =~ ^R[0-3]$ ]] || usage
git rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1 || { echo "specialists: unknown base ref $base" >&2; exit 2; }
if [ "$needs" = 0 ]; then
  case "${HEAD_REF:-}" in integrate/*)
    if ! [[ "$HEAD_REF" =~ ^integrate/f[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]]; then
      echo "specialists: the head branch is not a feature's integration branch (integrate/f001-slug)" >&2; exit 1
    fi
    echo "specialists: $HEAD_REF: exempt. Each work folder passed this check when it merged into feature/${HEAD_REF#integrate/}, and the ownership check makes sure they arrive unchanged."
    exit 0 ;;
  esac
fi
top=$(git rev-parse --show-toplevel) || exit 2
tmp=$(mktemp -d) || exit 2; trap 'rm -rf "$tmp"' EXIT

teams="$tmp/teams.json"
if [ -n "${TEAMS_FILE:-}" ]; then
  cat -- "$TEAMS_FILE" > "$teams" 2>/dev/null || : > "$teams"
elif ! git show "$base:factory/teams.json" > "$teams" 2>/dev/null; then
  echo "specialists: no factory/teams.json on $base: single-team mode, nothing to check" >&2
  [ "$needs" = 1 ] && echo review.md
  exit 0
fi
jq -e '.teams | type == "object"' "$teams" >/dev/null 2>&1 || { echo "specialists: the roster on $base is unreadable" >&2; exit 1; }
cd "$top" || exit 2

if [ "$needs" = 1 ]; then
  mb=$(git merge-base "$base" HEAD) || { echo "specialists: $base and HEAD share no history" >&2; exit 2; }
  { git diff -z --name-only --no-renames "$mb"; git ls-files -z --others --exclude-standard; } > "$tmp/files" || exit 2
  at_head() { [ -f "$1" ] && cat -- "$1"; }
else
  git diff -z --name-only --no-renames "$base"...HEAD > "$tmp/files" || exit 2
  at_head() { git cat-file blob "HEAD:$1" 2>/dev/null; }
fi

perl -0ne 'print "$1\0" if m{^work/([^/]+)/}' "$tmp/files" | sort -zu > "$tmp/items"
n=$(tr -cd '\0' < "$tmp/items" | wc -c | tr -d ' ')
if [ "$n" -eq 0 ]; then
  if [ "$needs" = 1 ]; then echo "specialists: no work folder in this change yet" >&2; exit 1; fi
  echo "specialists: no work folder (factory, human or planning files): exempt"; exit 0
fi
[ "$n" -eq 1 ] || { echo "specialists: a team's pull request carries exactly one work folder; this one has $n" >&2; exit 1; }
IFS= read -r -d '' item < "$tmp/items"
w="work/$(printf '%s' "$item" | tr -d '\000-\037')"

at_head "work/$item/spec.md" > "$tmp/spec" || { echo "specialists: $w has no spec.md, so its team is unknown" >&2; exit 1; }
team=$(spec_team "$tmp/spec" "$(jq -r '.default_team // empty' "$teams")")
if [ -z "$team" ] || ! team_names "$teams" | grep -qxF -- "$team"; then
  echo "specialists: $w names team '$(printf '%s' "$team" | tr -d '\000-\037' | cut -c1-40)', which is not an active team on $base" >&2
  exit 1
fi

# The requirements: "<report> TAB <why>".
req() { printf '%s\t%s\n' "$1" "$2" >> "$tmp/req"; }
# evidence_review swaps the reviewer, so only the value true does: anything else keeps review.md.
if jq -e --arg t "$team" '.teams[$t].evidence_review == true' "$teams" >/dev/null 2>&1; then
  req evidence-review.md "team $team has evidence_review"
else
  req review.md "every item"
fi
jq -e --arg t "$team" '.teams[$t].ui_review | . != null and . != false' "$teams" >/dev/null 2>&1 &&
  req ui-review.md "team $team has ui_review"
docs_only=1
while IFS= read -r -d '' f; do
  case "$f" in
    "work/$item"/*|memory/observations/*|features/*/acceptance.md|features/*/acceptance-review.md) ;;
    *) docs_only=0; break ;;
  esac
done < "$tmp/files"
case "$tier" in R2|R3)
  if [ "$docs_only" = 0 ]; then req security.md "tier $tier"
  elif [ "$needs" = 0 ]; then echo "specialists: only acceptance criteria or an acceptance review changed: no security report at $tier (the build's own review checks security)"
  fi ;;
esac
# db_paths: an array of strings, or the default when it is absent or garbled.
if ! jq -e '.db_paths | type == "array" and all(type == "string")' "$teams" >/dev/null 2>&1; then
  jq -e 'has("db_paths")' "$teams" >/dev/null 2>&1 && echo "specialists: db_paths in the roster is not a list of globs; using the default" >&2
  printf '%s\n' 'db/*' '*migrations/*' '*schema*' > "$tmp/db"
else
  jq -r '.db_paths[]' "$teams" > "$tmp/db"
fi
dbhit=""
shopt -s nocasematch
while IFS= read -r -d '' f && [ -z "$dbhit" ]; do
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    # $pat is deliberately unquoted so it is treated as a glob.
    if [[ "$f" == $pat ]]; then dbhit=$f; break; fi
  done < "$tmp/db"
done < "$tmp/files"
shopt -u nocasematch
[ -n "$dbhit" ] && req db-review.md "a db path changed: $(printf '%s' "$dbhit" | tr -d '\000-\037' | cut -c1-80)"

if [ "$needs" = 1 ]; then cut -f1 "$tmp/req"; exit 0; fi

echo "specialists: $w, team $team, tier $tier"
bad=0
while IFS="$(printf '\t')" read -r r why; do
  if ! at_head "work/$item/$r" > "$tmp/report"; then
    bad=1; printf '  %-12s %s  (%s)\n' MISSING "$r" "$why"; continue
  fi
  v=$(perl -ne 's/\r//g; if (/^VERDICT:/) { print $1 if /^VERDICT:[ \t]*([a-z-]+)[ \t]*$/; exit }' "$tmp/report")
  if [ "$v" = pass ]; then printf '  %-12s %s  (%s)\n' ok "$r" "$why"
  else bad=1; printf '  %-12s %s  (VERDICT: %s; %s)\n' "NOT PASSING" "$r" "${v:-none found}" "$why"; fi
done < "$tmp/req"

if [ "$bad" -ne 0 ]; then
  echo "specialists: a required report is missing or does not say VERDICT: pass. Run that specialist (/work does) and commit its reply as the report." >&2
  exit 1
fi
echo "specialists: ok"
