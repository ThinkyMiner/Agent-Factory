#!/usr/bin/env bash
# Work items: the issues a team builds from. In team mode this script is the only way a session
# creates one (the guard blocks raw `gh issue` writes); it works the same in a single-team factory.
#   item.sh create --title <text> [--proposed] [--feature <id>]  < body
# Prints the new issue's number. Labels: team:<team> (the session's team, in team mode),
# factory:proposed with --proposed (for /groom; you promote it to factory:ready),
# feature:<id> with --feature. Title and body are posted with @mentions and HTML neutralised.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "item: $*" >&2; exit 1; }

[ "${1:-}" = create ] || die "usage: item.sh create --title <text> [--proposed] [--feature <id>] < body"
shift
title="" proposed=0 feature=""
while [ $# -gt 0 ]; do
  case "$1" in
    --title) [ $# -ge 2 ] || die "--title needs a value"; title=$2; shift 2 ;;
    --feature) [ $# -ge 2 ] || die "--feature needs a value"; feature=$2; shift 2 ;;
    --proposed) proposed=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
labels=()
if teams=$(teams_file "$top"); then
  me=$(session_team "$top") ||
    die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top). Items come from team sessions started by 'factory team-up'."
  labels+=("team:$me")
fi
[ "$proposed" = 0 ] || labels+=(factory:proposed)
[ -z "$feature" ] || [[ "$feature" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || die "--feature must look like f001-share-links"
[ -z "$feature" ] || labels+=("feature:$feature")
title=$(printf '%s' "$title" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
[ "${#title}" -ge 5 ] && [ "${#title}" -le 200 ] || die "--title must be 5 to 200 characters"
[ ! -t 0 ] || die "give the item's body on stdin"
body=$(head -c 60001) || true
[ "${#body}" -le 60000 ] || die "the body is longer than 60000 characters; put details in a file in the repository"
[ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] || die "the body is empty: say what is wanted and how you will know it is done"

[ ${#labels[@]} = 0 ] || ensure_labels "${labels[@]}" || die "cannot list labels"
args=(); for l in ${labels[@]+"${labels[@]}"}; do args+=(--label "$l"); done
url=$(clean_text "$body" | gh issue create --title "$(clean_text "$title")" --body-file - ${args[@]+"${args[@]}"}) || die "GitHub refused the item"
n=${url##*/}; [[ "$n" =~ ^[0-9]+$ ]] || die "unexpected answer from gh: $url"
"$here/emit-event.sh" item number="$n" action=create >/dev/null 2>&1 || true
echo "$n"
