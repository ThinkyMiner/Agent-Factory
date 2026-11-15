#!/usr/bin/env bash
# Did the human approve this pull request as it is now?
#   check-approval.sh <pr-number> [label]          (label defaults to human-approved)
# Passes (exit 0) only when the label is on the pull request, the account that last added it is
# FACTORY_HUMAN (a repository variable, which only an admin can change), and it was added after
# the newest push to the pull request's branch, timed by GitHub, not by the commits. Agents work
# as a bot account, so a label they add does not count; a push after your label needs a new one.
# Reads GitHub with gh (in CI: GH_TOKEN and GH_REPO). Exit 1 not approved, 2 cannot tell. Both
# fail the gate: when in doubt it is closed.
set -euo pipefail
trap 'echo "approval: unexpected error at line $LINENO; not approved" >&2; exit 2' ERR
die() { echo "approval: $*" >&2; exit 2; }
no()  { echo "approval: $*" >&2; exit 1; }

n=${1:-}; label=${2-human-approved}
[[ "$n" =~ ^[1-9][0-9]{0,9}$ ]] || die "usage: check-approval.sh <pr-number> [label]"
[[ "$label" =~ ^[a-z][a-z0-9:-]{0,49}$ ]] || die "not a label name: $label"
human=${FACTORY_HUMAN:-}
[[ "$human" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$ ]] ||
  die "the repository variable FACTORY_HUMAN is not a GitHub login. Set it to yours: gh variable set FACTORY_HUMAN --body <login> (factory github does this)."
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

pr=$(gh api "repos/{owner}/{repo}/pulls/$n") || die "cannot read pull request #$n"
read -r head same < <(jq -r '[.head.ref, (.head.repo.full_name == .base.repo.full_name)] | @tsv' <<<"$pr") ||
  die "pull request #$n is not readable JSON"
[ -n "$head" ] && [ "$head" != null ] || die "pull request #$n has no head branch"
[ "$same" = true ] || die "pull request #$n comes from a fork; its pushes cannot be timed, so it cannot be approved by label"

# The label's add and remove events, oldest first (ids grow with time).
last=$(gh api --paginate "repos/{owner}/{repo}/issues/$n/events" \
         --jq '.[] | select(.event == "labeled" or .event == "unlabeled") | [.id, .event, .label.name, .actor.login, .created_at] | @tsv' |
       awk -F'\t' -v l="$label" '$3 == l' | sort -n -k1,1 | tail -1) || die "cannot read the events of #$n"
[ -n "$last" ] || no "'$label' is not on #$n. Read the diff, then add the label."
IFS=$'\t' read -r _ event _ actor at <<<"$last"
[ "$event" = labeled ] || no "'$label' was removed from #$n. Read the diff, then add the label."
[ "$(lower "$actor")" = "$(lower "$human")" ] ||
  no "'$label' on #$n was added by $actor, not by $human (FACTORY_HUMAN). Only your own label counts: remove it, read the diff, add it yourself."

ref=$(jq -rn --arg r "refs/heads/$head" '$r | @uri')
pushed=$(gh api "repos/{owner}/{repo}/activity?ref=$ref&per_page=100" \
           --jq '[.[] | select(.activity_type != "branch_deletion") | .timestamp] | max // empty') ||
  die "cannot read when $head was last pushed"
[ -n "$pushed" ] || die "GitHub has no record of a push to $head, so the label cannot be dated against it"
strip() { printf '%s' "${1%%.*}" | sed 's/Z$//'; }        # 2026-11-15T06:14:05.123Z -> 2026-11-15T06:14:05
[[ "$(strip "$at")" > "$(strip "$pushed")" ]] ||
  no "'$label' on #$n was added at $at, before the last push to $head at $pushed. Read what changed, then remove the label and add it again."
echo "approval: '$label' on #$n added by $actor at $at, after the last push at $pushed"
