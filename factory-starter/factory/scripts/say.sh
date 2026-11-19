#!/usr/bin/env bash
# Say something in the planning meeting. The only way a team adds to planning/<cycle>/discussion.jsonl.
#   say.sh <kind> --to <team|all|orchestrator|human> [--refs <id>,...] [--attach <file>] [--body <text>]
# The body comes from --body, or from stdin. This script stamps id, ts, cycle, round and from (the
# session's team, never an argument); the body is stored as a JSON string and never interpreted.
# What may be said, by round:
#   discussion-N  orchestrator: question, proposal         teams: question, answer, objection, proposal
#   review        orchestrator: question, objection, proposal   teams: answer
#   decisions     orchestrator: decision, proposal, dissent      teams: accept, objection (once per team per draft)
# An answer refs a question put to the answering team (or to all); an objection in the decisions
# round refs the record it objects to (c001-D02). Limits (factory/teams.json "limits"): a team says
# at most messages_per_round [4] per round; the orchestrator asks one team at most
# questions_per_team [3] per round; a body is at most message_chars [2000] characters, so longer
# material goes in a file passed with --attach (from this worktree or a temp folder; copied into
# planning/<cycle>/attachments/).
# A question to a team rings that team; a message that completes the round rings the orchestrator.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "say: $*" >&2; exit 1; }

kind=${1:-}; [ $# -gt 0 ] && shift
case "$kind" in question|answer|objection|proposal|accept|decision|dissent) ;; *) die "usage: say.sh <question|answer|objection|proposal|accept|decision|dissent> --to <who> [--refs ids] [--attach file] [--body text]" ;; esac
to="" refs="" attach="" body="" hasbody=0
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 needs a value"
  case "$1" in --to) to=$2 ;; --refs) refs=$2 ;; --attach) attach=$2 ;; --body) body=$2; hasbody=1 ;; *) die "unknown option $1" ;; esac
  shift 2
done
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams=$(teams_file "$top") || die "planning is for team mode, and this factory has no factory/teams.json"
me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
cyc=$(active_cycle "$home") || die "no planning cycle is open"
dir="$home/planning/$cyc"; tx="$dir/discussion.jsonl"; lock="$home/.factory/planning.lock"
[ "$(git -C "$home" rev-parse --abbrev-ref HEAD)" = "planning/$cyc" ] || die "the main checkout is not on planning/$cyc; ask the orchestrator"
S=$(jq -c 'select(type == "object" and (.teams | type == "array"))' "$dir/state.json" 2>/dev/null) || true
[ -n "$S" ] || die "the cycle's state.json is missing or damaged"
status=$(jq -r .status <<<"$S"); draft=$(jq -r '.draft // 0' <<<"$S"); cteams=$(jq -r '.teams[]' <<<"$S")
lim() { planning_limit "$teams" "$1" "$2"; }
msgs() { cat "$tx" 2>/dev/null | jq -c 'select(type == "object")' 2>/dev/null || true; }
in_cycle() { grep -qxF -- "$1" <<<"$cteams"; }

[ "$me" = orchestrator ] || in_cycle "$me" || die "$me is not one of this cycle's teams ($(echo $cteams))"
role=team; [ "$me" = orchestrator ] && role=orchestrator
case "$status:$role" in
  discussion-*:orchestrator) ok="question proposal" ;;
  discussion-*:team) ok="question answer objection proposal" ;;
  review:orchestrator) ok="question objection proposal" ;;
  review:team) ok="answer" ;;
  decisions:orchestrator) ok="decision proposal dissent" ;;
  decisions:team) ok="accept objection" ;;
  *) die "nothing can be said in the $status round" ;;
esac
case " $ok " in *" $kind "*) ;; *) die "the $role cannot say $kind in the $status round (it may say: $ok)" ;; esac
case "$to" in all|orchestrator|human) ;; *) in_cycle "$to" || die "--to must be a cycle team ($(echo $cteams)), all, orchestrator or human" ;; esac
[ "$to" != "$me" ] || die "$me cannot address itself"

if [ "$hasbody" = 0 ]; then [ -t 0 ] && die "give the body with --body or on stdin"; body=$(head -c 200000); fi
[ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] || die "the body is empty"
max=$(lim message_chars 2000)
[ "${#body}" -le "$max" ] || die "the body has ${#body} characters, over the limit of $max: put the material in a file and pass --attach, with a short body"

ids=()
if [ -n "$refs" ]; then IFS=', ' read -r -a ids <<<"$refs"; fi
pre=${cyc%%-*}
for r in ${ids[@]+"${ids[@]}"}; do
  if [[ "$r" =~ ^${pre}-m[0-9]{3}$ ]]; then msgs | jq -e --arg r "$r" 'select(.id == $r)' >/dev/null || die "--refs: there is no message $r"
  elif [[ "$r" =~ ^${pre}-D[0-9]{2}$ ]]; then grep -qE "^## $r:" "$dir/DECISIONS.md" 2>/dev/null || die "--refs: DECISIONS.md has no record $r"
  else die "--refs: $r is not a message id ($pre-m001) or a record id ($pre-D01) of this cycle"; fi
done
reflist=$(printf '%s\n' ${ids[@]+"${ids[@]}"} | jq -R 'select(length > 0)' | jq -sc .)

mine=$(msgs | jq -s --arg r "$status" --arg me "$me" '[.[] | select(.round == $r and .from == $me and .kind != "position")] | length')
if [ "$role" = team ]; then
  [ "$mine" -lt "$(lim messages_per_round 4)" ] || die "limit: $me has said $mine things in the $status round (limits.messages_per_round)"
elif [ "$kind" = question ] && [ "$to" != all ] && [ "$to" != human ]; then
  asked=$(msgs | jq -s --arg r "$status" --arg t "$to" '[.[] | select(.round == $r and .from == "orchestrator" and .kind == "question" and .to == $t)] | length')
  [ "$asked" -lt "$(lim questions_per_team 3)" ] || die "limit: the orchestrator has asked $to $asked questions in the $status round (limits.questions_per_team)"
fi
case "$kind" in
  answer)
    msgs | jq -se --argjson refs "$reflist" --arg me "$me" 'any(.[]; .kind == "question" and .from != $me and (.to == $me or .to == "all") and (.id as $i | $refs | index($i)))' >/dev/null ||
      die "an answer must --refs a question put to $me or to all" ;;
  accept|objection)
    if [ "$status" = decisions ]; then
      [ "$draft" -gt 0 ] || die "there is no draft yet to accept or object to"
      n=$(msgs | jq -s --arg me "$me" --argjson d "$draft" '[.[] | select(.round == "decisions" and .draft == $d and .from == $me and (.kind == "accept" or .kind == "objection"))] | length')
      [ "$n" -eq 0 ] || die "limit: $me already answered draft $draft; one accept or objection per team per draft"
      [ "$kind" = accept ] || jq -e 'any(.[]; test("-D[0-9]{2}$"))' <<<"$reflist" >/dev/null || die "an objection must --refs the record it objects to (for example ${pre}-D01)"
    fi ;;
esac

att=""
if [ -n "$attach" ]; then
  [ -f "$attach" ] && [ ! -L "$attach" ] || die "--attach: $attach is not a regular file"
  real="$(cd "$(dirname "$attach")" && pwd -P)/$(basename "$attach")"; wt=$(cd "$top" && pwd -P)
  case "$real" in "$wt"/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;; *) die "--attach: only files in this worktree or a temp folder can be attached" ;; esac
  case "$(basename "$real")" in .env|.env.*) die "--attach: .env files are never attached" ;; esac
  [ "$(wc -c < "$attach" | tr -d ' ')" -le 200000 ] || die "--attach: $attach is over 200000 bytes"
  name=$(printf '%s' "$(basename "$attach")" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-60); case "$name" in .*) name="_${name#.}" ;; esac
  mkdir -p "$dir/attachments"; att="attachments/$status-$me-$name"; k=1
  while [ -e "$dir/$att" ]; do k=$((k + 1)); att="attachments/$status-$me-$k-$name"; done
  cp "$attach" "$dir/$att"
fi

line=$(jq -cn --arg c "$cyc" --arg r "$status" --arg f "$me" --arg t "$to" --arg k "$kind" --argjson refs "$reflist" --arg b "$body" --arg a "$att" --argjson d "$draft" \
  '{cycle: $c, round: $r, from: $f, to: $t, kind: $k, refs: $refs, body: $b} + (if $a == "" then {} else {attach: $a} end) + (if $r == "decisions" then {draft: $d} else {} end)')
rc=0; id=$(transcript_append "$tx" "$lock" "$pre" "$line") || rc=$?
[ "$rc" = 0 ] || die "could not write the transcript (code $rc$( [ "$rc" = 75 ] && echo ': another writer held the lock; try again'))"
"$here/emit-event.sh" message cycle="$cyc" round="$status" id="$id" from="$me" to="$to" kind="$kind" >/dev/null 2>&1 || true
echo "$id"
if [ "$kind" = question ]; then
  for t in $( [ "$to" = all ] && printf '%s\n' "$cteams" || { in_cycle "$to" && printf '%s\n' "$to"; } ); do
    [ "$t" = "$me" ] || ring_team "$home" "$t" "Planning needs you: run /inbox." || true
  done
fi
if [ "$me" != orchestrator ] && bash "$here/round.sh" ready >/dev/null 2>&1; then ring_team "$home" orchestrator "Planning: a round can close. Run /plan." || true; fi
