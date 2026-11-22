#!/usr/bin/env bash
# The planning meeting's chair: opens a cycle and moves it from round to round, refusing to move
# until the round's rule is met. Only the orchestrator runs it; status and ready are read-only and
# open to every team. The record is planning/<cycle>/ on branch planning/<cycle> in the main
# checkout (see lib.sh, "planning"); state.json there is written only by this script.
#   round.sh open <slug>             start cycle c<NNN>-<slug>: its branch and a BRIEF.md to fill in
#   round.sh brief                   BRIEF.md is written: check it, commit, push, open the draft pull
#                                    request. You approve the brief with the label brief-approved.
#   round.sh next [--again]          close this round and open the next one:
#     brief -> positions             brief-approved added by you (FACTORY_HUMAN) after the last push
#                                    (with AUTONOMY=on in factory/policy.env: no approval);
#                                    a one-team cycle goes straight to decisions
#     positions -> discussion-1      every team has submitted, or the round's time is up; then all
#                                    positions are published at once
#     discussion-N -> review         every question answered, or the time is up; questions still
#                                    open must become needs-human decision records (AUTONOMY=on: the
#                                    orchestrator decides them, decided_by: orchestrator). With RIGOR=mvp
#                                    (factory/policy.env) straight to decisions: no review round
#     discussion-N -> N+1 (--again)  the same, at most limits.discussion_rounds [2; mvp 1] rounds
#     review -> decisions
#     decisions -> approval          a draft every team answered (or the time is up) and a valid
#                                    DECISIONS.md; the pull request is marked ready for you (AUTONOMY=on:
#                                    ready and set to merge itself once CI is green)
#   round.sh draft                   DECISIONS.md is ready for the leads: check it, commit, push, ring
#                                    them; at most limits.drafts [3; mvp 1]
#   round.sh abandon --reason <text> end the cycle without decisions
#   round.sh status                  where the cycle is, and what the calling team owes
#   round.sh ready                   exit 0 if this round's rule is met now
# A team that misses a round's time (limits.round_minutes [60]) gets a strike; at two strikes the
# cycle is escalated and only abandon is left. Version 1 runs one cycle at a time.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "round: $*" >&2; exit 1; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams=$(teams_file "$home") || die "planning is for team mode, and this factory has no factory/teams.json"
lock="$home/.factory/planning.lock"; mkdir -p "$home/.factory/planning"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
rig=$(rigor "$home")
aut=$(autonomy "$home")   # on: nobody waits for the human (factory/policy.env)
# open_left: what to do with what the teams left open, in this mode's words
open_left() { if [ "$aut" = on ]; then echo "the orchestrator decides each (decided_by: orchestrator), with each team's dissent recorded"; else echo "each must become a needs-human decision record"; fi; }
# lim <key> <full default> [<mvp default>]: the roster's limit, else this rigor's default
lim() { if [ "$rig" = mvp ] && [ -n "${3:-}" ]; then planning_limit "$teams" "$1" "$3"; else planning_limit "$teams" "$1" "$2"; fi; }
event() { "$here/emit-event.sh" "$@" >/dev/null 2>&1 || true; }
cmd=${1:-}; [ $# -gt 0 ] && shift

me=""
case "$cmd" in
  status|ready) me=$(session_team "$top" 2>/dev/null || true) ;;
  open|brief|next|draft|abandon)
    me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
    [ "$me" = orchestrator ] || die "only the orchestrator chairs a cycle; $me takes part with position.sh and say.sh" ;;
  *) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac

# ---- open: before any cycle exists ----
if [ "$cmd" = open ]; then
  slug=${1:-}
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || die "usage: round.sh open <slug> (lowercase letters, digits and -)"
  if c=$(active_cycle "$home"); then die "cycle $c is still open. Version 1 runs one cycle at a time: finish it, or round.sh abandon."; fi
  [ -z "$(git -C "$home" status --porcelain)" ] || die "the main checkout has uncommitted changes"
  git -C "$home" fetch -q origin 2>/dev/null || true
  base=main; git -C "$home" rev-parse -q --verify refs/remotes/origin/main >/dev/null && base=origin/main
  max=$( { git -C "$home" ls-tree --name-only "$base" planning/ 2>/dev/null | sed 's#^planning/##'
           git -C "$home" for-each-ref --format='%(refname:lstrip=4)' refs/remotes/origin/planning/
           git -C "$home" for-each-ref --format='%(refname:lstrip=3)' refs/heads/planning/; } |
         sed -n 's/^c\([0-9][0-9][0-9]\)-.*/\1/p' | sort -n | tail -1)
  cyc=$(printf 'c%03d-%s' $((10#${max:-0} + 1)) "$slug")
  git -C "$home" switch -q -c "planning/$cyc" "$base" || die "could not make branch planning/$cyc"
  dir="$home/planning/$cyc"; mkdir -p "$dir"
  cat > "$dir/BRIEF.md" <<EOF
# Brief: $cyc
teams: <the teams taking part, comma separated>

## Goal
<what this cycle should achieve, and for whom>

## Constraints
<what any solution must respect>

## Out of scope
<what this cycle will not do>
EOF
  t=$(now)
  jq -n --arg c "$cyc" --arg t "$t" '{v: 1, cycle: $c, status: "brief", teams: [], pr: null, draft: 0, strikes: {},
    unanswered: [], round_started_at: $t, history: [{status: "brief", at: $t}]}' > "$dir/state.json"
  echo "$cyc" > "$home/.factory/planning/active"
  event round cycle="$cyc" status=opened
  echo "round: opened $cyc on branch planning/$cyc in $home."
  if [ "$aut" = on ]; then echo "round: write planning/$cyc/BRIEF.md from the human's proposal, then run round.sh brief."
  else echo "round: write planning/$cyc/BRIEF.md (or ask the human to), then run round.sh brief."; fi
  exit 0
fi

# ---- everything else works on the active cycle ----
cyc=$(active_cycle "$home") || die "no planning cycle is open (round.sh open <slug> starts one)"
dir="$home/planning/$cyc"; st="$dir/state.json"; tx="$dir/discussion.jsonl"; sealed="$home/.factory/planning/$cyc/sealed"
S=$(jq -c 'select(type == "object" and (.teams | type == "array"))' "$st" 2>/dev/null) || true
[ -n "$S" ] || die "$st is missing or damaged; the cycle cannot go on (round.sh abandon ends it)"
status=$(jq -r .status <<<"$S")
cteams=$(jq -r '.teams[]' <<<"$S")
draft=$(jq -r '.draft // 0' <<<"$S")
started=$(jq -r .round_started_at <<<"$S")
age=$(( $(date -u +%s) - $(jq -rn --arg d "$started" '$d | try fromdateiso8601 catch 0') ))
timed_out=0; [ "$age" -lt $(( $(lim round_minutes 60) * 60 )) ] || timed_out=1
msgs() { cat "$tx" 2>/dev/null | jq -c 'select(type == "object")' 2>/dev/null || true; }

# unanswered: the questions of this round still owed an answer, as "<id> <team>" lines. A question
# to "all" is owed by every cycle team but its sender; to "human" by no one here.
unanswered() {
  msgs | jq -rs --arg r "$status" --argjson teams "$(jq -c .teams <<<"$S")" '
    . as $all | $all[] | select(.round == $r and .kind == "question") | . as $q
    | (if $q.to == "all" then ($teams - [$q.from]) elif $q.to == "human" then [] else [$q.to] end)[]
    | . as $t | select([$all[] | select(.kind == "answer" and .from == $t and ((.refs // []) | index($q.id)))] | length == 0)
    | "\($q.id) \($t)"'
}
responded() { msgs | jq -r --argjson d "$draft" 'select(.round == "decisions" and .draft == $d and (.kind == "accept" or .kind == "objection")) | .from' | sort -u; }
submitted() { local t; for t in $cteams; do [ -s "$sealed/$t.md" ] && echo "$t"; done; true; }
missing_from() { comm -23 <(printf '%s\n' $cteams | sort -u) <(printf '%s' "$1" | grep . | sort -u); }

# ready: is this round's own rule met (time aside)? Prints what it waits for when not.
ready() {
  local m
  case "$status" in
    positions) m=$(missing_from "$(submitted)"); [ -z "$m" ] || { echo "waiting for positions from: $(echo $m)"; return 1; } ;;
    discussion-*) m=$(unanswered); [ -z "$m" ] || { echo "waiting for answers: $(echo "$m" | tr '\n' ',' | sed 's/,$//; s/,/, /g')"; return 1; } ;;
    decisions) [ "$draft" -gt 0 ] || { echo "waiting for the first draft of DECISIONS.md (round.sh draft)"; return 1; }
               m=$(missing_from "$(responded)"); [ -z "$m" ] || { echo "waiting for accept or objection on draft $draft from: $(echo $m)"; return 1; } ;;
    review) ;;
    *) echo "nothing to wait for: the cycle is $status"; return 1 ;;
  esac
  echo "round $status of $cyc can close"
}

if [ "$cmd" = ready ]; then ready; exit; fi
if [ "$cmd" = status ]; then
  echo "cycle $cyc: $status (teams: $(echo $cteams); round open $((age / 60)) of $(lim round_minutes 60) minutes; draft $draft; pull request #$(jq -r '.pr // "none"' <<<"$S"); rigor $rig)"
  echo "record: $dir"
  r=$(ready) && echo "$r" || echo "$r"
  if [ -n "$me" ] && grep -qxF -- "$me" <<<"$cteams"; then
    case "$status" in
      positions) [ -s "$sealed/$me.md" ] && echo "$me: position submitted (you may resubmit until the round closes)" || echo "$me owes: a position (position.sh submit)" ;;
      discussion-*) o=$(unanswered | awk -v t="$me" '$2 == t {print $1}' | tr '\n' ' '); [ -z "$o" ] || echo "$me owes answers to: $o(say.sh answer --refs <id>)" ;;
      decisions) [ "$draft" -gt 0 ] && ! responded | grep -qxF -- "$me" && echo "$me owes: accept or objection on draft $draft (say.sh accept | say.sh objection --refs <record>)" ;;
    esac
  fi
  exit 0
fi

# ---- the chair's commands ----
[ "$(git -C "$home" rev-parse --abbrev-ref HEAD)" = "planning/$cyc" ] || die "the main checkout is not on planning/$cyc; switch back to it first"
save() { S=$1; printf '%s\n' "$S" | jq . > "$st.new" && mv "$st.new" "$st"; }
push() {  # push <message>: commit the cycle's folder and push its branch
  git -C "$home" add -- "planning/$cyc"
  git -C "$home" diff --cached --quiet -- "planning/$cyc" || git -C "$home" commit -qm "planning $cyc: $1" -- "planning/$cyc"
  git -C "$home" push -q -u origin "planning/$cyc" 2>/dev/null || die "could not push planning/$cyc"
}
say_as() {  # say_as <from> <to> <kind> <body>: a transcript line written by the chair
  local line id
  line=$(jq -cn --arg c "$cyc" --arg r "$status" --arg f "$1" --arg t "$2" --arg k "$3" --arg b "$4" --argjson d "$draft" \
    '{cycle: $c, round: $r, from: $f, to: $t, kind: $k, refs: [], body: $b} + (if $r == "decisions" then {draft: $d} else {} end)')
  id=$(transcript_append "$tx" "$lock" "${cyc%%-*}" "$line") || die "the transcript is locked by another writer; try again"
  event message cycle="$cyc" round="$status" id="$id" from="$1" to="$2" kind="$3"
}
ring_all() {
  local t; for t in $cteams; do ring_team "$home" "$t" "Planning needs you: run /inbox." || echo "round: could not ring $t now: the sweep rings it when its tab waits (without Herdr, tell it to run /inbox)"; done
}
move() {  # move <new status>
  local t; t=$(now)
  save "$(jq -c --arg s "$1" --arg t "$t" '.status = $s | .round_started_at = $t | .history += [{status: $s, at: $t}]' <<<"$S")"
  status=$1
  event round cycle="$cyc" status="$1"
}
strike() {  # strike <team>...: they missed this round's time; two strikes stop the meeting
  local t out=""
  for t in "$@"; do S=$(jq -c --arg t "$t" '.strikes[$t] = ((.strikes[$t] // 0) + 1)' <<<"$S"); done
  save "$S"
  out=$(jq -r '.strikes | to_entries[] | select(.value >= 2) | .key' <<<"$S" | tr '\n' ' ')
  if [ -n "$out" ]; then
    move escalated; push "escalated"
    event escalation reason=planning-strikes refs="$cyc" detail="missed two planning rounds: $out"
    die "$out missed two rounds' time: the meeting stops here. Tell the human; round.sh abandon ends the cycle."
  fi
  echo "round: time is up; a strike for: $*"
}

case "$cmd" in
brief)
  [ "$status" = brief ] || die "the brief was settled already (the cycle is $status)"
  b="$dir/BRIEF.md"; [ -f "$b" ] || die "planning/$cyc/BRIEF.md is missing"
  ! grep -qE '^<.*>$' "$b" || die "BRIEF.md still has template lines (<...>); fill them in"
  IFS=', ' read -r -a bt <<<"$(sed -n 's/^teams:[[:space:]]*//p' "$b" | head -1)"
  list=""; for t in ${bt[@]+"${bt[@]}"}; do
    valid_team_name "$t" && team_names "$teams" | grep -qxF -- "$t" || die "BRIEF.md names '$t', which is not an active team"
    [ "$t" != orchestrator ] || die "the orchestrator chairs; it is not one of the brief's teams"
    case " $list " in *" $t "*) ;; *) list="$list $t" ;; esac
  done
  [ -n "$list" ] || die "BRIEF.md needs a line 'teams: a, b' naming the teams taking part"
  for h in Goal Constraints "Out of scope"; do
    awk -v h="## $h" '$0 == h {on = 1; next} /^## / {on = 0} on && NF {found = 1} END {exit !found}' "$b" || die "BRIEF.md needs a non-empty '## $h' section"
  done
  save "$(jq -c --arg l "$list" '.teams = ($l | split(" ") | map(select(length > 0))) | .strikes = (.teams | map({(.): 0}) | add)' <<<"$S")"
  push "brief"
  pr=$(jq -r '.pr // empty' <<<"$S")
  if [ -z "$pr" ]; then
    if [ "$aut" = on ]; then body="AUTONOMY=on: the orchestrator decides what the teams leave open, and this pull request merges itself once it is ready and CI is green."
    else body="Add the label **brief-approved** once you have read BRIEF.md. The decisions are approved by merging this pull request once it is ready (it is R2)."; fi
    url=$(printf 'Planning cycle %s: the brief, then positions, discussion, decisions.\n\n%s\n' "$cyc" "$body" |
          gh pr create --draft --base main --head "planning/$cyc" --title "Planning $cyc" --body-file -) || die "GitHub refused the draft pull request"
    pr=${url##*/}; [[ "$pr" =~ ^[0-9]+$ ]] || die "unexpected answer from gh: $url"
    save "$(jq -c --argjson p "$pr" '.pr = $p' <<<"$S")"; push "brief on #$pr"
  fi
  if [ "$aut" = on ]; then echo "round: the brief for $cyc is on draft pull request #$pr. AUTONOMY=on: no approval to wait for; run round.sh next."
  else echo "round: the brief for $cyc is on draft pull request #$pr. The human reads it and adds brief-approved; then round.sh next."; fi
  ;;

next)
  again=0; [ "${1:-}" = --again ] && again=1
  case "$status" in
    brief)
      pr=$(jq -r '.pr // empty' <<<"$S"); [ -n "$pr" ] || die "the brief has no pull request yet (round.sh brief)"
      if [ "$aut" = on ]; then out="approval: none needed (AUTONOMY=on)"
      else
        human=${FACTORY_HUMAN:-$(gh variable get FACTORY_HUMAN 2>/dev/null || true)}
        out=$(FACTORY_HUMAN=$human bash "$here/check-approval.sh" "$pr" brief-approved 2>&1) || die "the brief is not approved: ${out#approval: }"
      fi
      save "$(jq -c --arg sha "$(git -C "$home" hash-object "$dir/BRIEF.md")" --arg a "${out#approval: }" '.brief_sha = $sha | .brief_approval = $a' <<<"$S")"
      event approval cycle="$cyc" what=brief
      if [ "$(echo $cteams | wc -w)" -eq 1 ]; then move decisions; else move positions; fi
      push "$status"; ring_all ;;
    positions)
      sub=$(submitted); m=$(missing_from "$sub")
      if [ -n "$m" ]; then [ "$timed_out" = 1 ] || die "$(ready)"; strike $m; fi
      mkdir -p "$dir/positions" "$dir/attachments"
      for t in $sub; do
        cp "$sealed/$t.md" "$dir/positions/$t.md"
        for a in "$sealed/$t-attachments"/*; do [ -f "$a" ] && cp "$a" "$dir/attachments/$t-$(basename "$a")"; done
        say_as "$t" all position "positions/$t.md"
      done
      move discussion-1; push "positions published"; ring_all ;;
    discussion-*)
      n=${status#discussion-}; m=$(unanswered)
      [ "$again" = 0 ] || [ "$n" -lt "$(lim discussion_rounds 2 1)" ] || die "limit: $n discussion rounds (limits.discussion_rounds); go on with round.sh next"
      if [ -n "$m" ]; then
        [ "$timed_out" = 1 ] || die "$(ready)"
        save "$(jq -c --arg ids "$(awk '{print $1}' <<<"$m" | sort -u | tr '\n' ' ')" '.unanswered = (.unanswered + ($ids | split(" ") | map(select(length > 0))) | unique)' <<<"$S")"
        strike $(awk '$2 != "orchestrator" {print $2}' <<<"$m" | sort -u)
        echo "round: still open, so $(open_left): $(awk '{print $1}' <<<"$m" | sort -u | tr '\n' ' ')"
      fi
      if [ "$again" = 1 ]; then move "discussion-$((n + 1))"
      elif [ "$rig" = mvp ]; then move decisions; echo "round: RIGOR=mvp: no review round"
      else move review; fi
      push "$status" ;;
    review) move decisions; push "$status" ;;
    decisions)
      [ "$draft" -gt 0 ] || die "$(ready)"
      m=$(missing_from "$(responded)")
      if [ -n "$m" ]; then [ "$timed_out" = 1 ] || die "$(ready)"; strike $m; fi
      bash "$here/decisions.sh" validate || die "DECISIONS.md is not ready for approval (above)"
      [ "$(git -C "$home" hash-object "$dir/BRIEF.md")" = "$(jq -r .brief_sha <<<"$S")" ] || die "BRIEF.md changed after it was $([ "$aut" = on ] && echo "settled (positions began)" || echo approved); abandon and open a new cycle"
      move approval; push "for approval"
      pr=$(jq -r .pr <<<"$S")
      gh pr ready "$pr" >/dev/null 2>&1 || die "could not mark pull request #$pr ready"
      if [ "$aut" = on ]; then
        if gh pr merge "$pr" --auto --merge >/dev/null 2>&1; then
          echo "round: pull request #$pr is ready and merges itself once CI is green (AUTONOMY=on); then dispatch runs (autostart types /dispatch)."
        else
          echo "round: pull request #$pr is ready, but GitHub refused to set it to merge itself; run gh pr merge $pr --auto --merge once it can (AUTONOMY=on)."
        fi
      else
        echo "round: pull request #$pr is ready. The human approves the decisions by merging it (R2, human-approved); then the orchestrator runs dispatch.sh."
      fi
      exit 0 ;;
    *) die "nothing to move: the cycle is $status" ;;
  esac
  echo "round: $cyc is now in $status."
  ;;

draft)
  [ "$status" = decisions ] || die "drafts belong to the decisions round (the cycle is $status)"
  [ "$draft" -lt "$(lim drafts 3 1)" ] || die "limit: $draft drafts (limits.drafts); $([ "$aut" = on ] && echo "decide what is left yourself (decided_by: orchestrator, each team's dissent recorded)" || echo "settle what is left as needs-human records") and run round.sh next"
  bash "$here/decisions.sh" validate --new-draft || die "DECISIONS.md is not ready to show the teams (above)"
  save "$(jq -c '.draft += 1' <<<"$S")"; draft=$((draft + 1))
  say_as orchestrator all decision "draft $draft: planning/$cyc/DECISIONS.md"
  push "draft $draft"; ring_all
  echo "round: draft $draft is out. Each team accepts or objects once (say.sh)."
  ;;

abandon)
  why=${2:-}; [ "${1:-}" = --reason ] && [ "${#why}" -ge 10 ] || die "usage: round.sh abandon --reason <why, at least 10 characters>"
  case "$status" in dispatched|closed) die "the cycle is already $status" ;; esac
  say_as orchestrator all dissent "abandoned: $why"
  move closed; push "abandoned"
  pr=$(jq -r '.pr // empty' <<<"$S")
  [ -z "$pr" ] || gh pr close "$pr" --comment "Cycle abandoned: $(clean_text "$why")" >/dev/null 2>&1 || echo "round: could not close pull request #$pr; close it by hand"
  rm -f "$home/.factory/planning/active"
  git -C "$home" switch -q main 2>/dev/null || true
  echo "round: $cyc abandoned; the main checkout is back on main."
  ;;
esac
