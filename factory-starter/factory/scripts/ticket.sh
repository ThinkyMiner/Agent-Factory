#!/usr/bin/env bash
# Tickets: how one team asks another for something. A ticket is a GitHub issue that only this
# script writes (the guard blocks raw `gh issue` and `gh label` writes in team sessions).
#   ticket.sh create --to <team> --type <type> --needs <text> --why <text> --blocks <text> \
#                    --done <text> [--feature <id>] [--decision <id>]
#   ticket.sh accept <n>                  receiving team
#   ticket.sh decline <n> --reason <text> receiving team
#   ticket.sh done <n> --pr <number>      receiving team, once its pull request is open
#   ticket.sh verify <n>                  requesting team: the work does what it asked; closes it
#   ticket.sh dispute <n> --reason <text> requesting team, once per ticket, after decline or done
#   ticket.sh withdraw <n> --reason <text> requesting team, before done: no longer needed; closes it
# Types: request, bug, contract-change, decision-change. Needs, why, done and reasons are at least
# 30 characters, so the receiver gets context. A team opens at most 5 tickets a day and has at
# most 2 open with any one team (limits.tickets_per_day, limits.open_tickets_per_pair in
# factory/teams.json). Text is posted with @mentions and HTML neutralised.
# The team is the session's (FACTORY_TEAM and its worktree, see lib.sh), never an argument.
# Every action comments with a machine-readable line, sets the state: label and writes a ticket
# event. States: open -> accepted | declined; accepted -> done; done -> verified (closed) |
# disputed; declined -> disputed; disputed -> accepted | declined; any but done -> withdrawn (closed).
# Accepting a contract-change ticket writes <main checkout>/.factory/grants/contract-<n>.json,
# which lets the receiving team write contracts/ (guard.sh); every other action removes it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "ticket: $*" >&2; exit 1; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
teams=$(teams_file "$top") || die "tickets are for team mode, and this factory has no factory/teams.json"
me=$(session_team "$top") ||
  die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top). Tickets come from team sessions started by 'factory team-up'."
command -v gh >/dev/null 2>&1 || die "gh is not installed"

need_text() {  # need_text <name> <value> <min>
  local t; t=$(printf '%s' "$2" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  [ "${#t}" -ge "$3" ] || die "--$1 needs at least $3 characters of real context (got ${#t})"
  [ "${#2}" -le 8000 ] || die "--$1 is longer than 8000 characters; link to a file in the repository instead"
}
event() { "$here/emit-event.sh" ticket "$@" >/dev/null 2>&1 || true; }
limit() {  # limit <key> <default>: a non-negative integer from the roster
  local v; v=$(jq -r --arg k "$1" '.limits[$k] // empty' "$teams" 2>/dev/null)
  [[ "$v" =~ ^[0-9]{1,4}$ ]] && echo "$v" || echo "$2"
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
create)
  to="" type="" needs="" why="" blocks="" done_when="" feature="" decision=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in
      --to) to=$2 ;; --type) type=$2 ;; --needs) needs=$2 ;; --why) why=$2 ;; --blocks) blocks=$2 ;;
      --done) done_when=$2 ;; --feature) feature=$2 ;; --decision) decision=$2 ;;
      *) die "unknown option $1" ;;
    esac
    shift 2
  done
  valid_team_name "$to" && team_names "$teams" | grep -qxF -- "$to" || die "--to must be an active team: $(team_names "$teams" | tr '\n' ' ')"
  [ "$to" != "$me" ] || die "a ticket goes to another team; $me does its own work through /work"
  case "$type" in request|bug|contract-change|decision-change) ;; *) die "--type must be request, bug, contract-change or decision-change" ;; esac
  need_text needs "$needs" 30; need_text why "$why" 30; need_text done "$done_when" 30
  [ -n "$(printf '%s' "$blocks" | tr -d '[:space:]')" ] || die "--blocks is required: what waits on this (issue numbers), or 'nothing'"
  [ "${#blocks}" -le 2000 ] || die "--blocks is longer than 2000 characters"
  [ -z "$feature" ] || [[ "$feature" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || die "--feature must look like f001-share-links"
  [ -z "$decision" ] || [[ "$decision" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,31}$ ]] || die "--decision must look like c001-D02"

  today=$(date -u +%Y-%m-%d)
  made=$(gh issue list --label ticket --label "from:$me" --state all --search "created:>=$today" --limit 200 --json number --jq length) || die "cannot count today's tickets"
  [ "$made" -lt "$(limit tickets_per_day 5)" ] || die "$me has opened $made tickets today, its daily budget. Ask the orchestrator, or wait for tomorrow (UTC)."
  open=$(gh issue list --label ticket --label "from:$me" --label "to:$to" --state open --limit 200 --json number --jq length) || die "cannot count open tickets"
  [ "$open" -lt "$(limit open_tickets_per_pair 2)" ] || die "$me already has $open open tickets with $to. Wait for one to close."

  refs=$(printf '%s' "$blocks" | grep -oE '#[0-9]{1,9}' | tr -d '#' | jq -R 'tonumber' | jq -sc 'unique') || refs='[]'
  head=$(jq -cn --arg f "$me" --arg t "$to" --arg ty "$type" --arg fe "$feature" --arg d "$decision" --argjson b "$refs" \
           '{v: 1, from: $f, to: $t, type: $ty, feature: $fe, decision: $d, blocks: $b}')
  short=$(printf '%s' "$needs" | tr -s '[:space:]' ' '); title=$(clean_text "[$me → $to] $type: ${short:0:70}")
  body="<!-- factory-ticket $head -->
## What is needed
$(clean_text "$needs")

## Why
$(clean_text "$why")

## What it blocks
$(clean_text "$blocks")

## Done when
$(clean_text "$done_when")

## Context
From **$me** to **$to**, type \`$type\`${feature:+, feature \`$feature\`}${decision:+, decision \`$decision\`}.
Change this ticket only with \`factory/scripts/ticket.sh\` (accept, decline, done, verify, dispute)."
  labels=(ticket "to:$to" "from:$me" "type:$type" state:open)
  [ -z "$feature" ] || labels+=("feature:$feature")
  ensure_labels "${labels[@]}" || die "cannot list labels"
  args=(); for l in "${labels[@]}"; do args+=(--label "$l"); done
  url=$(printf '%s' "$body" | gh issue create --title "$title" --body-file - "${args[@]}") || die "GitHub refused the ticket"
  n=${url##*/}; [[ "$n" =~ ^[0-9]+$ ]] || die "unexpected answer from gh: $url"
  event number="$n" action=create from="$me" to="$to" ticket_type="$type" feature="$feature" state=open
  echo "ticket #$n: $me → $to ($type). $url"
  ;;

accept|decline|done|verify|dispute|withdraw)
  n=${1:-}; [[ "$n" =~ ^[1-9][0-9]{0,8}$ ]] || die "usage: ticket.sh $cmd <issue-number>"
  shift; reason="" pr=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in --reason) reason=$2 ;; --pr) pr=$2 ;; *) die "unknown option $1" ;; esac
    shift 2
  done
  json=$(gh issue view "$n" --json number,state,labels,comments) || die "cannot read issue #$n"
  jq -e '.labels | map(.name) | index("ticket")' >/dev/null <<<"$json" || die "#$n is not a ticket"
  get() { jq -r --arg p "$1" '[.labels[].name | select(startswith($p)) | ltrimstr($p)] | if length == 1 then .[0] else "" end' <<<"$json"; }
  from=$(get from:); to=$(get to:); state=$(get state:)
  [ -n "$from" ] && [ -n "$to" ] && [ -n "$state" ] || die "#$n has lost its from:, to: or state: label; ask the orchestrator to repair it"
  [ "$(jq -r .state <<<"$json")" = OPEN ] || die "#$n is closed"
  case "$cmd" in
    accept|decline|done) [ "$me" = "$to" ] || die "only $to, the receiving team, can $cmd #$n" ;;
    verify|dispute|withdraw) [ "$me" = "$from" ] || die "only $from, the team that asked, can $cmd #$n" ;;
  esac
  case "$cmd:$state" in
    accept:open|accept:disputed) new=accepted ;;
    decline:open|decline:disputed) new=declined; need_text reason "$reason" 30 ;;
    done:accepted) new=done; [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || die "done needs --pr <number>: the pull request that does it"
      gh pr view "$pr" --json number >/dev/null 2>&1 || die "there is no pull request #$pr" ;;
    verify:done) new=verified ;;
    dispute:declined|dispute:done) new=disputed; need_text reason "$reason" 30
      disputes=$(jq '[.comments[].body | capture("^<!-- factory-ticket-action (?<j>[^\n]*) -->").j | fromjson? | select(.action == "dispute")] | length' <<<"$json")
      [ "$disputes" -eq 0 ] || die "#$n was disputed once already; a second dispute goes to the orchestrator (a decision-change ticket)" ;;
    withdraw:open|withdraw:accepted|withdraw:declined|withdraw:disputed) new=withdrawn; need_text reason "$reason" 30 ;;
    *) die "#$n is $state; $cmd is not possible from there" ;;
  esac
  line=$(jq -cn --arg a "$cmd" --arg by "$me" --arg s "$new" --arg pr "$pr" '{action: $a, by: $by, state: $s} + (if $pr == "" then {} else {pr: ($pr | tonumber)} end)')
  comment="<!-- factory-ticket-action $line -->
**$cmd** by $me: $state → $new.${pr:+ Pull request #$pr.}"
  [ -z "$reason" ] || comment="$comment

$(clean_text "$reason")"
  ensure_labels "state:$new" || die "cannot list labels"
  printf '%s' "$comment" | gh issue comment "$n" --body-file - >/dev/null || die "GitHub refused the comment on #$n"
  gh issue edit "$n" --remove-label "state:$state" --add-label "state:$new" >/dev/null || die "could not set state:$new on #$n"
  case "$new" in verified|withdrawn) gh issue close "$n" >/dev/null || die "could not close #$n" ;; esac
  grant=$(contract_grant_file "$(factory_home "$top")" "$n")
  if [ "$new" = accepted ] && [ "$(get type:)" = contract-change ]; then
    mkdir -p "${grant%/*}" && jq -n --argjson n "$n" --arg t "$me" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{ticket: $n, team: $t, ts: $ts}' > "$grant.new" && mv "$grant.new" "$grant" || die "#$n is accepted, but the contract grant $grant could not be written"
    echo "ticket: $me may now change contracts/ for #$n, until it marks the ticket done"
  else
    rm -f "$grant"
  fi
  event number="$n" action="$cmd" from="$from" to="$to" state="$new"
  echo "ticket #$n: $state → $new"
  ;;

*) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
