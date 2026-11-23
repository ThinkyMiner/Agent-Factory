#!/usr/bin/env bash
# The sweep: starts approved work (autostart.sh) and finds what is stuck and tells the
# orchestrator. A script on a timer, not a model, so it costs nothing while all is well.
#   sweep.sh           one pass
#   sweep.sh --loop    a pass every FACTORY_SWEEP_SECONDS (default 120); team-up runs it in a tab
# It escalates (limits from "limits" in factory/teams.json, defaults in brackets):
#   - a ticket still open and unanswered after ticket_answer_hours [8]
# A ticket still open (nobody accepted or declined it) after ticket_ring_minutes [10] rings the team
# it is for once more, with a fixed line: a lead can list GitHub before a ticket filed seconds
# earlier shows up, and then nothing rings it again.
#   - a declined ticket that is disputed, and a ticket declined twice
#   - tickets that block each other in a cycle (each ticket's "What it blocks" issue numbers)
#   - a team over its tickets_per_day [5] (not the orchestrator: integration files its tickets)
#   - a session in Herdr's blocked state (a permission or trust dialog) for blocked_minutes [10]
#   - a session working with no event for silent_minutes [30]
#   - a team whose session has ended (hc sees a shell in its Herdr tab, where claude ran)
#   - a build slot held for slot_hours [4]
#   - a planning round (positions, discussion, review, decisions; with AUTONOMY=on the brief too,
#     which then waits on nobody) open for round_minutes [60]
# Each new finding becomes an escalation event in .factory/events.jsonl, and the orchestrator's
# Herdr tab gets one fixed doorbell when it waits for input, never the findings themselves. A finding is
# escalated once while it lasts; a doorbell that could not ring is retried next pass.
# It also rings each team owed a doorbell that could not ring when it was sent (.factory/rings/),
# and rings the orchestrator once when the human has approved a cycle's brief (nothing else tells it).
# Each pass first fast-forwards the main checkout to origin/main when it is on main and clean (the
# orchestrator's rule too), so a factory change merged into main runs from the next pass on.
# State: .factory/sweep.json. Only reads GitHub.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "sweep: $*" >&2; exit 1; }
DOORBELL="The sweep has new escalations. Read the latest escalation events in .factory/events.jsonl, look at what they point to, and tell the human what needs a decision."

if [ "${1:-}" = --loop ]; then
  every=${FACTORY_SWEEP_SECONDS:-120}; [[ "$every" =~ ^[1-9][0-9]{0,5}$ ]] || every=120
  while :; do bash "$0" || true; sleep "$every"; done
fi
[ $# -eq 0 ] || die "usage: sweep.sh [--loop]"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams=$(teams_file "$home") || die "the sweep is for team mode, and this factory has no factory/teams.json"
dir="$home/.factory"; mkdir -p "$dir"; sf="$dir/sweep.json"
# Fast-forward only, and only a clean main: never a branch, a local commit or a change in progress.
if [ "$(git -C "$home" symbolic-ref -q --short HEAD 2>/dev/null)" = main ] &&
   [ -z "$(git -C "$home" status --porcelain --untracked-files=no 2>/dev/null)" ] &&
   git -C "$home" fetch -q origin main 2>/dev/null; then
  git -C "$home" merge -q --ff-only refs/remotes/origin/main >/dev/null 2>&1 || true
fi
typedto=$("$here/autostart.sh") || true
[ -z "$typedto" ] || printf '%s\n' "$typedto"
# Doorbells that could not ring when they were sent (the tab was busy): ring them now, with the
# sweep's own fixed line. Not a tab autostart typed into this pass: it has just started a turn.
# One owed for 10 minutes to a tab hc calls working is typed anyway (hc_queue): that tab may be a
# session whose prompt is free while a background task of its own runs.
for f in "$dir"/rings/*; do
  [ -f "$f" ] || continue
  t=${f##*/}
  valid_team_name "$t" && team_names "$teams" | grep -qxF -- "$t" || { rm -f "$f"; continue; }
  grep -qF " into $t (" <<<"$typedto" && continue
  q=""; [ -z "$(find "$f" -mmin +10 2>/dev/null)" ] || q=queue
  if ring_team "$home" "$t" "$(later_line "$t")" $q; then rm -f "$f"; echo "sweep: rang $t (a doorbell that had waited)"; fi
done
limit() { local v; v=$(jq -r --arg k "$1" '.limits[$k] // empty' "$teams" 2>/dev/null); [[ "$v" =~ ^[0-9]{1,5}$ ]] && echo "$v" || echo "$2"; }
epoch() { jq -rn --arg d "$1" '$d | try (sub("\\.[0-9]+"; "") | fromdateiso8601) catch empty'; }
now=$(date -u +%s)
state=$(jq -c 'select(type == "object")' "$sf" 2>/dev/null) || true; [ -n "$state" ] || state='{}'
found=""
add() { found+="$(jq -cn --arg k "$1" --arg r "$2" --arg refs "$3" --arg t "$4" '{key: $k, reason: $r, refs: $refs, text: $t}')"$'\n'; }
note() { echo "sweep: $*" >&2; }

# ---- tickets (GitHub) ----
gh_ok=0
rerung=$(jq -c '.rerung // [] | if type == "array" then map(numbers) else [] end' <<<"$state" 2>/dev/null) || rerung='[]'
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
  open_now=$(jq -c '[.[] | select(any(.labels[]?; .name == "state:open")) | .number]' <<<"$tickets")
  while IFS=$'\t' read -r n t; do
    valid_team_name "$t" && team_names "$teams" | grep -qxF -- "$t" || continue
    if [ "$t" = orchestrator ]; then line="A ticket for you: answer it (gh issue list --label ticket --label to:orchestrator --state open)."
    else line="A ticket for you: run /inbox."; fi
    ring_team "$home" "$t" "$line" >/dev/null 2>&1 || true
    echo "sweep: rang $t again for ticket #$n, still open"
    rerung=$(jq -c --argjson n "$n" '. + [$n]' <<<"$rerung")
  done < <(jq -r --argjson m "$(limit ticket_ring_minutes 10)" --argjson h "$(limit ticket_answer_hours 8)" --argjson now "$now" --argjson done "$rerung" '.[]
      | select(any(.labels[]?; .name == "state:open")) | .number as $n | select($done | index($n) | not)
      | ((.createdAt // "") | try (sub("\\.[0-9]+"; "") | fromdateiso8601) catch null) as $t
      | select($t != null and ($now - $t) >= $m * 60 and ($now - $t) < $h * 3600)
      | [$n, ([.labels[]?.name | strings | select(startswith("to:")) | ltrimstr("to:")][0] // "")] | @tsv' <<<"$tickets")
  rerung=$(jq -c --argjson o "$open_now" 'map(select(. as $n | $o | index($n)))' <<<"$rerung")
else
  note "cannot read tickets from GitHub this pass"
fi
today=$(date -u +%Y-%m-%d)
if made=$(gh issue list --label ticket --state all --search "created:>=$today" --limit 500 --json labels 2>/dev/null) &&
   jq -e 'type == "array"' <<<"$made" >/dev/null 2>&1; then
  p=$(limit tickets_per_day 5)
  while IFS=$'\t' read -r t c; do
    valid_team_name "$t" && [ "$t" != orchestrator ] && add "budget:$t:$today" budget "$t" "$t opened $c tickets today, over its budget of $p"
  done < <(jq -r --argjson p "$p" '[.[] | [.labels[]?.name | strings | select(startswith("from:")) | ltrimstr("from:")] | unique[]]
      | group_by(.) | map(select(length > $p)) | .[] | [.[0], length] | @tsv' <<<"$made")
else
  gh_ok=0
fi

# ---- sessions (Herdr) ----
label=$(basename "$home"); orch=""; blocked=$(jq -c '.blocked // {} | if type == "object" then . else {} end' <<<"$state")
busy=$(jq -c '.working // {} | if type == "object" then . else {} end' <<<"$state")
if command -v herdr-app >/dev/null 2>&1 && lay=$(herdr-app ls 2>/dev/null) && jq -e '.spaces | type == "array"' <<<"$lay" >/dev/null 2>&1; then
  was=$blocked; blocked='{}'; wasbusy=$busy; busy='{}'
  bm=$(limit blocked_minutes 10); sm=$(limit silent_minutes 30)
  agents=$(hc ls --json 2>/dev/null | jq -c '[.terminals[]? | select(.address | type == "string") | {(.address): (.agent // "" | tostring)}] | add // {}' 2>/dev/null) || agents='{}'
  [ -n "$agents" ] || agents='{}'
  while IFS=$'\t' read -r t term st; do
    team_names "$teams" | grep -qxF -- "$t" || continue
    [ "$t" = orchestrator ] && orch=$term
    # Herdr can go on calling the tab claude-code after claude exits; hc names the program it sees.
    case "$(jq -r --arg t "$term" '.[$t] // empty' <<<"$agents" 2>/dev/null)" in zsh|bash|sh|fish|dash|ksh)
      add "down:$t:$term" down "$t" "the $t session has ended (its Herdr tab $term shows a shell): run factory team-up to start it again"
      continue ;;
    esac
    case "$st" in
      blocked)
        since=$(jq -r --arg t "$t" '.[$t] // empty' <<<"$was"); [[ "$since" =~ ^[0-9]{1,12}$ ]] || since=$now
        blocked=$(jq -c --arg t "$t" --argjson s "$since" '. + {($t): $s}' <<<"$blocked")
        mins=$(( (now - since) / 60 ))
        [ "$mins" -lt "$bm" ] || add "blocked:$t:$since" blocked "$t" "the $t session has waited on a dialog for $mins minutes (Herdr tab $t)" ;;
      working)
        # Silent since its last event, or since this sweep first saw it working, whichever is later:
        # a session that has just started a turn (often one autostart typed) is not silent.
        since=$(jq -r --arg t "$t" '.[$t] // empty' <<<"$wasbusy"); [[ "$since" =~ ^[0-9]{1,12}$ ]] || since=$now
        busy=$(jq -c --arg t "$t" --argjson s "$since" '. + {($t): $s}' <<<"$busy")
        last=$(grep -F "\"team\":\"$t\"" "$dir/events.jsonl" 2>/dev/null | tail -1 | jq -r '.ts // empty' 2>/dev/null)
        lt=$( [ -n "$last" ] && epoch "$last")
        if [ -n "$lt" ]; then
          [ "$lt" -ge "$since" ] || lt=$since
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
brief_rung=$(jq -r '.brief_rung // empty | strings' <<<"$state")
if cyc=$(active_cycle "$home" 2>/dev/null); then
  IFS=$'\t' read -r st since < <(jq -r '[(.status // "" | strings), (.round_started_at // "" | strings)] | @tsv' "$home/planning/$cyc/state.json" 2>/dev/null) || true
  overdue() {
    local t0; t0=$(epoch "${since:-}")
    if [ -n "$t0" ] && [ $(( (now - t0) / 60 )) -ge "$(limit round_minutes 60)" ]; then
      add "round:$cyc:$st:$since" round "$cyc" "planning $cyc has been in its $st round for $(( (now - t0) / 60 )) minutes: run /plan to close it"
    fi
  }
  [ "${st:-}" = brief ] && [ "$(autonomy "$home")" = on ] && st=brief-autonomous
  case "${st:-}" in
    brief-autonomous) st=brief; overdue ;;     # AUTONOMY=on: the brief waits on nobody
    brief)
      pr=$(jq -r '.pr // empty | numbers' "$home/planning/$cyc/state.json" 2>/dev/null)
      if [ -n "$pr" ] && [ "$brief_rung" != "$cyc" ]; then
        human=${FACTORY_HUMAN:-$(gh variable get FACTORY_HUMAN 2>/dev/null || true)}
        if FACTORY_HUMAN=$human bash "$here/check-approval.sh" "$pr" brief-approved >/dev/null 2>&1; then
          ring_team "$home" orchestrator "$(later_line orchestrator)" && echo "sweep: rang orchestrator (the brief of $cyc is approved)"
          brief_rung=$cyc     # rung, or left in .factory/rings for the next pass
        fi
      fi ;;
    positions|discussion-*|review|decisions) overdue ;;
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
jq -n --argjson seen "$seen" --argjson b "$blocked" --argjson w "$busy" --argjson r "$ring" --arg br "$brief_rung" --argjson rr "${rerung:-[]}" '{seen: $seen, blocked: $b, working: $w, ring: $r, brief_rung: $br, rerung: $rr}' > "$sf.new" && mv "$sf.new" "$sf"

n_all=$(printf '%s' "$found" | grep -c . || true); n_new=$(printf '%s' "$new" | grep -c . || true)
printf '%s' "$found" | jq -r --argjson seen "$(jq -c '.seen // {}' <<<"$state" 2>/dev/null || echo '{}')" '.key as $k | "  \(if ($seen | has($k)) then "   " else "new" end) \(.text)"'
echo "sweep: $(date -u +%H:%M)Z, $n_all open finding(s), $n_new new.$( [ "$ring" = true ] && echo ' The orchestrator has not been told yet.')"
