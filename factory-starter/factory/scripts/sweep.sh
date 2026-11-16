#!/usr/bin/env bash
# The sweep: finds what is stuck and tells the orchestrator. A script on a timer, not a model, so
# it costs nothing while all is well.
#   sweep.sh           one pass
#   sweep.sh --loop    a pass every FACTORY_SWEEP_SECONDS (default 900); team-up runs it in a tab
# It escalates (limits from "limits" in factory/teams.json, defaults in brackets):
#   - a ticket still open and unanswered after ticket_answer_hours [8]
#   - a declined ticket that is disputed, and a ticket declined twice
#   - tickets that block each other in a cycle (each ticket's "What it blocks" issue numbers)
#   - a team over its tickets_per_day [5]
#   - a session in Herdr's blocked state (a permission or trust dialog) for blocked_minutes [10]
#   - a session working with no event for silent_minutes [30]
#   - a build slot held for slot_hours [4]
#   - a planning round (positions, discussion, review, decisions) open for round_minutes [60]
# Each new finding becomes an escalation event in .factory/events.jsonl, and the orchestrator's
# Herdr tab gets one fixed doorbell when it waits for input, never the findings themselves. A finding is
# escalated once while it lasts; a doorbell that could not ring is retried next pass.
# State: .factory/sweep.json. Only reads GitHub.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "sweep: $*" >&2; exit 1; }
DOORBELL="The sweep has new escalations. Read the latest escalation events in .factory/events.jsonl, look at what they point to, and tell the human what needs a decision."

if [ "${1:-}" = --loop ]; then
  every=${FACTORY_SWEEP_SECONDS:-900}; [[ "$every" =~ ^[1-9][0-9]{0,5}$ ]] || every=900
  while :; do bash "$0" || true; sleep "$every"; done
fi
[ $# -eq 0 ] || die "usage: sweep.sh [--loop]"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams=$(teams_file "$home") || die "the sweep is for team mode, and this factory has no factory/teams.json"
dir="$home/.factory"; mkdir -p "$dir"; sf="$dir/sweep.json"
limit() { local v; v=$(jq -r --arg k "$1" '.limits[$k] // empty' "$teams" 2>/dev/null); [[ "$v" =~ ^[0-9]{1,5}$ ]] && echo "$v" || echo "$2"; }
epoch() { jq -rn --arg d "$1" '$d | try (sub("\\.[0-9]+"; "") | fromdateiso8601) catch empty'; }
now=$(date -u +%s)
state=$(jq -c 'select(type == "object")' "$sf" 2>/dev/null) || true; [ -n "$state" ] || state='{}'
found=""
add() { found+="$(jq -cn --arg k "$1" --arg r "$2" --arg refs "$3" --arg t "$4" '{key: $k, reason: $r, refs: $refs, text: $t}')"$'\n'; }
note() { echo "sweep: $*" >&2; }

# ---- tickets (GitHub) ----
gh_ok=0
if tickets=$(gh issue list --label ticket --state open --limit 300 --json number,labels,createdAt,body,comments 2>/dev/null) &&
   jq -e 'type == "array"' <<<"$tickets" >/dev/null 2>&1; then
  gh_ok=1
  while IFS=$'\t' read -r n age; do
    [ -n "$n" ] && add "unanswered:#$n" unanswered "#$n" "ticket #$n has waited ${age}h for an answer"
  done < <(jq -r --argjson h "$(limit ticket_answer_hours 8)" --argjson now "$now" '.[]
      | select(any(.labels[]?; .name == "state:open"))
      | ((.createdAt // "") | try (sub("\\.[0-9]+"; "") | fromdateiso8601) catch null) as $t | select($t != null)
      | (($now - $t) / 3600 | floor) as $age | select($age >= $h) | [.number, $age] | @tsv' <<<"$tickets")
  while IFS=$'\t' read -r why n; do
    case "$why" in
      disputed) add "disputed:#$n" disputed "#$n" "ticket #$n was declined and is now disputed" ;;
      twice) add "declined-twice:#$n" declined-twice "#$n" "ticket #$n has been declined twice" ;;
    esac
  done < <(jq -r '.[] | [.comments[]?.body | strings | try (capture("^<!-- factory-ticket-action (?<j>[^\n]*) -->").j | fromjson | .action) catch empty] as $a
      | (if any(.labels[]?; .name == "state:disputed") and ($a | index("decline")) then ["disputed", .number] else empty end),
        (if ($a | map(select(. == "decline")) | length) >= 2 then ["twice", .number] else empty end) | @tsv' <<<"$tickets")
  # "X waits for T" for every issue X a ticket T blocks; tsort names the issues on a cycle.
  cyc=$(jq -r '.[] | .number as $t | (.body // "" | strings | try (capture("<!-- factory-ticket (?<j>[^\n]*) -->").j | fromjson | .blocks) catch [])
      | (. // [])[]? | numbers | "\(.) \($t)"' <<<"$tickets" | tsort 2>&1 >/dev/null | sed -n 's/^tsort: \([0-9][0-9]*\)$/#\1/p' | sort -u | paste -sd, - | sed 's/,/, /g')
  [ -z "$cyc" ] || add "cycle:$cyc" cycle "$cyc" "tickets block each other in a cycle: $cyc"
else
  note "cannot read tickets from GitHub this pass"
fi
today=$(date -u +%Y-%m-%d)
if made=$(gh issue list --label ticket --state all --search "created:>=$today" --limit 500 --json labels 2>/dev/null) &&
   jq -e 'type == "array"' <<<"$made" >/dev/null 2>&1; then
  p=$(limit tickets_per_day 5)
  while IFS=$'\t' read -r t c; do
    valid_team_name "$t" && add "budget:$t:$today" budget "$t" "$t opened $c tickets today, over its budget of $p"
  done < <(jq -r --argjson p "$p" '[.[] | [.labels[]?.name | strings | select(startswith("from:")) | ltrimstr("from:")] | unique[]]
      | group_by(.) | map(select(length > $p)) | .[] | [.[0], length] | @tsv' <<<"$made")
else
  gh_ok=0
fi

# ---- sessions (Herdr) ----
label=$(basename "$home"); orch=""; blocked=$(jq -c '.blocked // {} | if type == "object" then . else {} end' <<<"$state")
if command -v herdr-app >/dev/null 2>&1 && lay=$(herdr-app ls 2>/dev/null) && jq -e '.spaces | type == "array"' <<<"$lay" >/dev/null 2>&1; then
  was=$blocked; blocked='{}'
  bm=$(limit blocked_minutes 10); sm=$(limit silent_minutes 30)
  while IFS=$'\t' read -r t term st; do
    team_names "$teams" | grep -qxF -- "$t" || continue
    [ "$t" = orchestrator ] && orch=$term
    case "$st" in
      blocked)
        since=$(jq -r --arg t "$t" '.[$t] // empty' <<<"$was"); [[ "$since" =~ ^[0-9]{1,12}$ ]] || since=$now
        blocked=$(jq -c --arg t "$t" --argjson s "$since" '. + {($t): $s}' <<<"$blocked")
        mins=$(( (now - since) / 60 ))
        [ "$mins" -lt "$bm" ] || add "blocked:$t:$since" blocked "$t" "the $t session has waited on a dialog for $mins minutes (Herdr tab $t)" ;;
      working)
        last=$(grep -F "\"team\":\"$t\"" "$dir/events.jsonl" 2>/dev/null | tail -1 | jq -r '.ts // empty' 2>/dev/null)
        lt=$( [ -n "$last" ] && epoch "$last")
        if [ -n "$lt" ]; then
          mins=$(( (now - lt) / 60 ))
          [ "$mins" -lt "$sm" ] || add "silent:$t:$last" silent "$t" "the $t session has been working for $mins minutes without an event"
        fi ;;
    esac
  done < <(jq -r --arg l "$label" '[.spaces[] | select(.name == $l)][0].tabs[]? | select(.terminals[0])
      | [.name, (.terminals[0].terminal // ""), (.terminals[0].status // "unknown")] | @tsv' <<<"$lay")
else
  note "Herdr is not running: no session states, no doorbell"
fi

# ---- slots ----
sh=$(limit slot_hours 4)
while IFS=$'\t' read -r t since; do
  st=$(epoch "$since"); [ -n "$st" ] && valid_team_name "$t" || continue
  [ $(( (now - st) / 3600 )) -lt "$sh" ] || add "slot:$t:$since" slot "$t" "$t has held a build slot since $since"
done < <(jq -r '.held // {} | objects | to_entries[] | [.key, (.value | strings)] | @tsv' "$dir/slots.json" 2>/dev/null)

# ---- planning ----
if cyc=$(active_cycle "$home" 2>/dev/null); then
  IFS=$'\t' read -r st since < <(jq -r '[(.status // "" | strings), (.round_started_at // "" | strings)] | @tsv' "$home/planning/$cyc/state.json" 2>/dev/null) || true
  case "${st:-}" in
    positions|discussion-*|review|decisions)
      t0=$(epoch "${since:-}")
      if [ -n "$t0" ] && [ $(( (now - t0) / 60 )) -ge "$(limit round_minutes 60)" ]; then
        add "round:$cyc:$st:$since" round "$cyc" "planning $cyc has been in its $st round for $(( (now - t0) / 60 )) minutes: run /plan to close it"
      fi ;;
  esac
fi

# ---- escalate what is new, remember what is current ----
seen=$(jq -c '.seen // {} | if type == "object" then . else {} end' <<<"$state")
new=$(printf '%s' "$found" | jq -c --argjson seen "$seen" '.key as $k | select($seen | has($k) | not)')
while IFS= read -r f; do
  [ -n "$f" ] || continue
  "$here/emit-event.sh" escalation reason="$(jq -r .reason <<<"$f")" refs="$(jq -r .refs <<<"$f")" detail="$(jq -r .text <<<"$f")" >/dev/null 2>&1 || true
done <<<"$new"
# Findings that GitHub could not be asked about this pass are kept, so they are not escalated again.
seen=$(printf '%s' "$found" | jq -sc --argjson seen "$seen" --argjson now "$now" --argjson gh "$gh_ok" '
  (map({(.key): ($seen[.key] // $now)}) | add // {})
  + (if $gh == 1 then {} else ($seen | with_entries(select(.key | test("^(unanswered|disputed|declined-twice|cycle|budget):")))) end)')
ring=$(jq -r 'if .ring == true then "true" else "false" end' <<<"$state"); [ -z "$new" ] || ring=true
if [ "$ring" = true ] && [ -n "$orch" ] && command -v hc >/dev/null 2>&1; then
  hc_ring "$orch" "$DOORBELL" && ring=false
fi
jq -n --argjson seen "$seen" --argjson b "$blocked" --argjson r "$ring" '{seen: $seen, blocked: $b, ring: $r}' > "$sf.new" && mv "$sf.new" "$sf"

n_all=$(printf '%s' "$found" | grep -c . || true); n_new=$(printf '%s' "$new" | grep -c . || true)
printf '%s' "$found" | jq -r --argjson seen "$(jq -c '.seen // {}' <<<"$state" 2>/dev/null || echo '{}')" '.key as $k | "  \(if ($seen | has($k)) then "   " else "new" end) \(.text)"'
echo "sweep: $(date -u +%H:%M)Z, $n_all open finding(s), $n_new new.$( [ "$ring" = true ] && echo ' The orchestrator has not been told yet.')"
