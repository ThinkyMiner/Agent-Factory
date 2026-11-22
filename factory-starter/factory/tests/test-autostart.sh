# Tests for factory/scripts/autostart.sh: what it types into which tab, that it types each thing
# once, and what it never types. gh, herdr-app and hc are faked; origin is a bare repository.
. "$(dirname "$0")/lib.sh"
A="$SCRIPTS/autostart.sh"

setup() {
  planning_setup; cd "$MAIN"
  mkdir -p "$TEST_TMP/herdr"
  printf '#!/usr/bin/env bash\n[ "$1" = ls ] && cat "$TEST_TMP/layout"\n' > "$TEST_TMP/herdr/herdr-app"
  fake_hc "$TEST_TMP/herdr" "$TEST_TMP/hc.log"
  chmod +x "$TEST_TMP/herdr/herdr-app"; export PATH="$TEST_TMP/herdr:$PATH"
  # This factory's space "app": t1 orchestrator, t2 backend, t3 frontend, t4 research. Another
  # factory's space has a tab named backend too (t99): never typed into.
  jq -n '{spaces: [{name: "other", tabs: [{name: "backend", terminals: [{terminal: "t99"}]}]},
    {name: "app", tabs: [{name: "orchestrator", terminals: [{terminal: "t1"}]}, {name: "backend", terminals: [{terminal: "t2"}]},
                         {name: "frontend", terminals: [{terminal: "t3"}]}, {name: "research", terminals: [{terminal: "t4"}]}]}]}' > "$TEST_TMP/layout"
  echo '[]' > "$FAKE_GH/issues.json"
}
feature() { git -C "$MAIN" push -q origin "main:refs/heads/feature/${1:-f001-x}"; }
issue() {  # issue <n> <OPEN|CLOSED> <label>...
  local n=$1 st=$2; shift 2
  jq --argjson n "$n" --arg st "$st" '. + [{number: $n, title: "t", body: "b", state: $st, comments: [],
      createdAt: "2026-01-01T00:00:00Z", labels: ($ARGS.positional | map({name: .}))}]' "$FAKE_GH/issues.json" --args "$@" > "$FAKE_GH/i" &&
    mv "$FAKE_GH/i" "$FAKE_GH/issues.json"
}
typed() { sort "$TEST_TMP/hc.log" 2>/dev/null | tr '\n' ';'; }
reset_log() { rm -f "$TEST_TMP/hc.log"; }

test_dispatched_items_start_in_their_teams_tabs_lowest_first_once() {
  setup; feature
  issue 9 OPEN feature:f001-x team:backend; issue 7 OPEN feature:f001-x team:backend
  issue 8 OPEN feature:f001-x team:frontend; issue 6 OPEN feature:f001-x team:research
  run "$A"; expect_rc 0; expect_out "typed /work 7 into backend (t2)"
  expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;t2|keys ctrl+u / w o r k space 7 enter;t3|keys ctrl+u / w o r k space 8 enter;t4|keys ctrl+u / r e s e a r c h - w o r k space 6 enter;"
  expect_eq "$(grep -c '"type":"autostart"' .factory/events.jsonl)" 4
  reset_log; run "$A"; expect_rc 0; expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 9 enter;"   # backend's tab is free again
  reset_log; run "$A"; expect_rc 0; expect_eq "$(typed)" ""   # all typed less than 30 minutes ago
}

test_a_busy_or_blocked_tab_is_typed_into_later() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend
  echo working > "$TEST_TMP/hc-status-t2"; echo blocked > "$TEST_TMP/hc-status-t1"
  run "$A"; expect_rc 0; expect_eq "$(typed)" ""
  echo idle > "$TEST_TMP/hc-status-t2"; echo done > "$TEST_TMP/hc-status-t1"
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;t2|keys ctrl+u / w o r k space 7 enter;"
}

test_work_with_a_branch_is_left_alone_and_the_rest_is_retried_after_30_minutes() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend; issue 9 OPEN feature:f001-x team:backend
  git -C "$BE" branch -q work/7-load-week
  run "$A"; expect_out "typed /work 9 into backend"
  reset_log; jq -c '."work:9" -= 1700' .factory/autostart.json > s && mv s .factory/autostart.json
  run "$A"; expect_eq "$(typed)" ""                                           # 28 minutes: not yet
  jq -c '."work:9" -= 200' .factory/autostart.json > s && mv s .factory/autostart.json
  run "$A"; expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 9 enter;"           # 31 minutes, still no branch
  reset_log; git -C "$MAIN" push -q origin main:refs/heads/work/9-x
  jq -c '."work:9" -= 4000' .factory/autostart.json > s && mv s .factory/autostart.json
  run "$A"; expect_eq "$(typed)" ""                                           # its branch is on origin
}

test_waiting_work_is_typed_again_as_soon_as_the_feature_moves() {
  setup; feature; issue 9 OPEN feature:f001-x team:backend
  run "$A"; expect_out "typed /work 9 into backend"
  reset_log; run "$A"; expect_eq "$(typed)" ""                                # nothing moved, 30 minutes not up
  git commit -q --allow-empty -m item8 && git push -q origin main:feature/f001-x   # the item it waited for merged
  echo working > "$TEST_TMP/hc-status-t2"; run "$A"
  expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"   # backend busy: later
  rm "$TEST_TMP/hc-status-t2"; reset_log; run "$A"
  expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 9 enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""                                # once per move
  jq -c '."work:9@" = {"x": 1}' .factory/autostart.json > s && mv s .factory/autostart.json
  run "$A"; expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 9 enter;"    # a broken record counts as moved
  reset_log; jq -c '."work:9@" = "$(rm -rf x)"' .factory/autostart.json > s && mv s .factory/autostart.json
  run "$A"; expect_rc 0; expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 9 enter;"
  expect_eq "$(jq -r '."work:9@"' .factory/autostart.json)" "$(git rev-parse origin/feature/f001-x)"
}

test_a_refused_dispatch_is_typed_again_as_soon_as_main_moves() {
  setup; mkdir -p planning/c001-x
  echo '{"status":"approval"}' > planning/c001-x/state.json; echo '# D' > planning/c001-x/DECISIONS.md
  git add -A && git commit -qm c && git push -q origin main
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / d i s p a t c h space c 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""                                # refused, nothing moved
  echo fix >> planning/c001-x/DECISIONS.md; git commit -qam fix && git push -q origin main
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / d i s p a t c h space c 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
  git commit -q --allow-empty -m local                                        # only local: not a move
  run "$A"; expect_eq "$(typed)" ""
}

test_only_work_on_the_open_feature_for_one_team_is_typed() {
  setup; feature
  issue 1 CLOSED feature:f001-x team:backend
  issue 2 OPEN feature:f002-y team:backend                       # another feature
  issue 3 OPEN team:backend                                      # an item for main: a person starts it
  issue 4 OPEN feature:f001-x                                    # no team
  issue 5 OPEN feature:f001-x team:backend team:frontend         # two teams
  issue 6 OPEN feature:f001-x team:orchestrator
  issue 10 OPEN feature:f001-x team:design                       # an inactive team
  issue 11 OPEN feature:f001-x 'team:backend;rm -rf x'           # not a team name
  issue 12 OPEN ticket feature:f001-x to:backend state:open      # not accepted yet
  issue 13 OPEN ticket feature:f001-x to:backend state:declined
  issue 14 OPEN ticket to:frontend state:accepted                # accepted, but not about the feature
  issue 15 OPEN ticket feature:f001-x team:frontend state:accepted   # a ticket goes by to:, not team:
  issue 16 OPEN ticket feature:f001-x to:frontend state:accepted
  echo working > "$TEST_TMP/hc-status-t1"
  run "$A"; expect_rc 0; expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 1 6 enter;"
}

test_dispatch_is_typed_once_a_cycle_is_approved_and_no_feature_is_open() {
  setup; mkdir -p planning/c001-x
  echo '{"status":"decisions"}' > planning/c001-x/state.json; echo '# D' > planning/c001-x/DECISIONS.md
  git add -A && git commit -qm c && git push -q origin main
  run "$A"; expect_rc 0; expect_eq "$(typed)" ""                       # not approved yet
  echo '{"status":"approval"}' > planning/c001-x/state.json; git commit -qam a && git push -q origin main
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / d i s p a t c h space c 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""                         # once
  feature; jq -c '."dispatch:c001-x" -= 4000' .factory/autostart.json > s && mv s .factory/autostart.json
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"   # dispatched: no more /dispatch
}

test_dispatch_is_not_typed_for_a_broken_cycle() {
  setup; mkdir -p planning/c001-x planning/C002-y planning/c003-z
  echo '{"status":"approval"}' > planning/c001-x/state.json                                   # no DECISIONS.md
  echo '{"status":"approval"}' > planning/C002-y/state.json; echo x > planning/C002-y/DECISIONS.md   # not a cycle name
  echo 'not json' > planning/c003-z/state.json; echo x > planning/c003-z/DECISIONS.md
  git add -A && git commit -qm c && git push -q origin main
  run "$A"; expect_rc 0; expect_eq "$(typed)" ""
  echo x > planning/c001-x/DECISIONS.md; git add -A; git commit -qm local    # complete only locally, not on origin/main
  run "$A"; expect_eq "$(typed)" ""
}

test_integrate_is_typed_again_when_the_feature_moves() {
  setup; feature
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
  git commit -q --allow-empty -m moved && git push -q origin main:feature/f001-x
  echo working > "$TEST_TMP/hc-status-t1"; run "$A"; expect_eq "$(typed)" ""   # busy: later
  rm "$TEST_TMP/hc-status-t1"; run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  reset_log; git push -q origin main:refs/heads/integrate/f001-x
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
}

test_integrate_is_typed_again_when_the_factory_on_main_changes() {
  setup; feature
  run "$A"; reset_log; run "$A"; expect_eq "$(typed)" ""
  echo product > README.md; git add README.md; git commit -qm readme && git push -q origin main
  run "$A"; expect_eq "$(typed)" ""                                   # product only: nothing to sync
  mkdir -p factory .claude; echo k >> factory/kit-note; git add factory; git commit -qm kit && git push -q origin main
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
  echo s >> .claude/skill-note; git add .claude; git commit -qm skill && git push -q origin main
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  reset_log; echo l >> factory/kit-note; git commit -qam local                 # only local: not on origin/main
  run "$A"; expect_eq "$(typed)" ""
}

test_integrate_is_typed_again_when_a_team_answers_the_orchestrators_ticket() {
  setup; feature; issue 34 OPEN ticket feature:f001-x from:orchestrator to:frontend type:bug state:open
  issue 40 OPEN ticket feature:f001-x from:backend to:frontend type:request state:open
  run "$A"; reset_log; run "$A"; expect_eq "$(typed)" ""
  jq 'map(if .number == 40 then .labels |= map(if .name == "state:open" then {name: "state:declined"} else . end) else . end)' "$FAKE_GH/issues.json" > i && mv i "$FAKE_GH/issues.json"
  run "$A"; expect_eq "$(typed)" ""                                   # not the orchestrator's ticket
  jq 'map(if .number == 34 then .labels |= map(if .name == "state:open" then {name: "state:declined"} else . end) else . end)' "$FAKE_GH/issues.json" > i && mv i "$FAKE_GH/issues.json"
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
  echo 'issue list' > "$FAKE_GH/fail"; run "$A"; expect_eq "$(typed)" ""   # GitHub down: not a change
  rm "$FAKE_GH/fail"; run "$A"; expect_eq "$(typed)" ""
}

test_off_without_herdr_without_origin_or_when_turned_off() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend
  FACTORY_AUTOSTART=0 run "$A"; expect_rc 0; expect_eq "$(typed)" ""
  echo 'not json' > "$TEST_TMP/layout"; run "$A"; expect_rc 0; expect_err "Herdr is not running"; expect_eq "$(typed)" ""
  setup; feature; issue 7 OPEN feature:f001-x team:backend; git remote set-url origin "$TEST_TMP/nowhere.git"
  run "$A"; expect_rc 0; expect_err "cannot reach origin"; expect_eq "$(typed)" ""
  run "$A" --now; expect_rc 1; expect_err "usage: autostart.sh"
  cd "$TEST_TMP"; mkrepo solo; cd solo; run "$A"; expect_rc 1; expect_err "no factory/teams.json"
}

test_a_github_failure_types_no_work_but_still_integrates() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend; echo 'issue list' > "$FAKE_GH/fail"
  run "$A"; expect_rc 0; expect_err "cannot read the items of f001-x"
  expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
}

test_a_corrupt_state_file_is_started_over() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend; mkdir -p .factory
  echo '[1,2' > .factory/autostart.json
  run "$A"; expect_rc 0; expect_out "typed /work 7"; expect_eq "$(jq -r '."work:7" | type' .factory/autostart.json)" number
}

test_hc_type_types_only_plain_slash_commands() {
  setup; . "$SCRIPTS/lib.sh"
  local bad
  for bad in "work 7" "/Work 7" "/work 7; rm -rf ~" '/work $(id)' "/work 7
/exit" "/work	7" "/$(printf 'a%.0s' $(seq 1 90))" ""; do
    RC=0; hc_type t2 "$bad" || RC=$?; expect_eq "$RC" 2 "hc_type typed: $bad"
  done
  expect_eq "$(typed)" ""
  echo blocked > "$TEST_TMP/hc-status-t2"; RC=0; hc_type t2 "/work 7" || RC=$?; expect_eq "$RC" 1; expect_eq "$(typed)" ""
  rm "$TEST_TMP/hc-status-t2"; hc_type t2 "/research-work 12"
  expect_eq "$(typed)" "t2|keys ctrl+u / r e s e a r c h - w o r k space 1 2 enter;"
}

test_the_sweep_runs_autostart_each_pass() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend
  run "$SCRIPTS/sweep.sh"; expect_rc 0; expect_out "typed /work 7 into backend (t2)"
}
test_the_sweep_does_not_ring_a_tab_autostart_just_typed_into() {
  setup; feature; issue 7 OPEN feature:f001-x team:backend; mkdir -p .factory/rings; : > .factory/rings/backend
  echo working > "$TEST_TMP/hc-status-t1"
  run "$SCRIPTS/sweep.sh"; expect_rc 0
  expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 7 enter;"
  [ -f .factory/rings/backend ] || fail "the waiting ring was dropped instead of kept for the next pass"
}

# tkt <n> <OPEN|CLOSED> <body> <label>...: a ticket issue whose body is given as is.
tkt() {
  local n=$1 st=$2 body=$3; shift 3
  jq --argjson n "$n" --arg st "$st" --arg b "$body" '. + [{number: $n, title: "t", body: $b, state: $st, comments: [],
      createdAt: "2026-01-01T00:00:00Z", labels: ($ARGS.positional | map({name: .}))}]' "$FAKE_GH/issues.json" --args "$@" > "$FAKE_GH/i" &&
    mv "$FAKE_GH/i" "$FAKE_GH/issues.json"
}
meta() { printf '<!-- factory-ticket {"v":1,"from":"frontend","to":"orchestrator","type":"question","blocks":%s} -->\n## What is needed\nx' "$1"; }
relabel() {  # relabel <n> <OPEN|CLOSED> <label>...: replace the issue's labels and state
  local n=$1 st=$2; shift 2
  jq --argjson n "$n" --arg st "$st" 'map(if .number == $n then .state = $st | .labels = ($ARGS.positional | map({name: .})) else . end)' \
    "$FAKE_GH/issues.json" --args "$@" > "$FAKE_GH/i" && mv "$FAKE_GH/i" "$FAKE_GH/issues.json"
}

test_a_started_item_resumes_once_when_the_ticket_it_waits_on_is_answered() {
  setup; feature; issue 9 OPEN feature:f001-x team:frontend; git -C "$MAIN" branch -q work/9-page
  tkt 30 OPEN "$(meta '[9]')" ticket feature:f001-x from:frontend to:orchestrator type:question state:open
  run "$A"; expect_rc 0; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"   # not answered yet
  reset_log; relabel 30 OPEN ticket feature:f001-x from:frontend to:orchestrator type:question state:done
  run "$A"; expect_rc 0; expect_out "typed /work 9 into frontend (t3)"
  expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 9 enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""                                     # once
  relabel 30 CLOSED ticket feature:f001-x from:frontend to:orchestrator type:question state:verified
  run "$A"; expect_eq "$(typed)" ""                                                # verified is the same answer
  tkt 31 OPEN "$(meta '[9]')" ticket feature:f001-x from:frontend to:orchestrator type:request state:open
  run "$A"; expect_eq "$(typed)" ""
  relabel 31 OPEN ticket feature:f001-x from:frontend to:orchestrator type:request state:declined
  echo working > "$TEST_TMP/hc-status-t3"; run "$A"; expect_eq "$(typed)" ""       # busy: later
  rm "$TEST_TMP/hc-status-t3"; run "$A"; expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 9 enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
  relabel 31 OPEN ticket feature:f001-x from:frontend to:orchestrator type:request state:accepted
  run "$A"; expect_eq "$(typed)" ""                                                # disputed and accepted: not an answer
  relabel 31 OPEN ticket feature:f001-x from:frontend to:orchestrator type:request state:done
  run "$A"; expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 9 enter;"         # answered after all: resume again
}

test_a_ticket_answered_and_closed_between_passes_still_resumes_the_item() {
  setup; feature; issue 9 OPEN feature:f001-x team:frontend; git -C "$MAIN" branch -q work/9-page
  tkt 32 OPEN "$(meta '[9]')" ticket feature:f001-x from:frontend to:orchestrator state:open
  run "$A"; reset_log
  relabel 32 CLOSED ticket feature:f001-x from:frontend to:orchestrator state:verified   # done and verified before this pass
  run "$A"; expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 9 enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
}

test_only_a_well_formed_ticket_naming_the_item_resumes_it() {
  setup; feature; issue 9 OPEN feature:f001-x team:frontend; git -C "$MAIN" branch -q work/9-page
  local L="feature:f001-x from:frontend to:orchestrator state:done" i=40 b
  for b in "no meta here" '<!-- factory-ticket {"blocks":[9] -->' "$(meta '{"a":9}')" "$(meta '"9"')" "$(meta '9')" \
           "$(meta '[9.5]')" "$(meta '[-9]')" "$(meta '[0]')" "$(meta '[1e20]')" "$(meta '[10]')" "$(meta '["9; touch pwned"]')" \
           "$(meta '["$(touch pwned)"]')" "$(meta '[null,true,[9],{"n":9}]')" "$(printf '<!-- factory-ticket\n{"blocks":[9]} -->')"; do
    i=$((i + 1)); tkt "$i" OPEN "$b" ticket $L
  done
  tkt 60 OPEN "$(meta '[9]')" feature:f001-x from:frontend to:orchestrator state:done             # not a ticket
  tkt 61 OPEN "$(meta '[9]')" ticket feature:f001-x from:frontend to:orchestrator state:withdrawn
  tkt 62 OPEN "$(meta '[9]')" ticket feature:f001-x from:frontend to:orchestrator                 # no state
  tkt 63 OPEN "$(meta '[9]')" ticket from:frontend to:orchestrator state:done                     # not about the feature
  run "$A"; expect_rc 0; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  [ ! -e pwned ] && [ ! -e "$MAIN/pwned" ] || fail "a ticket body was executed"
  reset_log; tkt 64 OPEN "$(meta '["#9"]')" ticket $L
  run "$A"; expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 9 enter;"         # "#9" as text counts too
}

test_resume_types_the_right_command_for_research_and_for_an_accepted_ticket() {
  setup; feature
  issue 6 OPEN feature:f001-x team:research; git -C "$MAIN" branch -q work/6-brief
  issue 20 OPEN ticket feature:f001-x from:frontend to:backend state:accepted; git -C "$MAIN" branch -q work/20-api
  tkt 70 OPEN "$(meta '[6, 20]')" ticket feature:f001-x from:research to:orchestrator state:open
  run "$A"; reset_log
  relabel 70 OPEN ticket feature:f001-x from:research to:orchestrator state:done
  run "$A"; expect_eq "$(typed)" "t2|keys ctrl+u / w o r k space 2 0 enter;t4|keys ctrl+u / r e s e a r c h - w o r k space 6 enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""
}

test_github_down_resumes_nothing_and_the_answer_is_not_lost() {
  setup; feature; issue 9 OPEN feature:f001-x team:frontend; git -C "$MAIN" branch -q work/9-page
  tkt 30 OPEN "$(meta '[9]')" ticket feature:f001-x from:frontend to:orchestrator state:open
  run "$A"; reset_log; relabel 30 OPEN ticket feature:f001-x from:frontend to:orchestrator state:done
  echo 'issue list' > "$FAKE_GH/fail"; run "$A"; expect_rc 0; expect_eq "$(typed)" ""
  rm "$FAKE_GH/fail"; run "$A"; expect_eq "$(typed)" "t3|keys ctrl+u / w o r k space 9 enter;"
}

test_the_orchestrator_is_typed_once_when_the_pull_request_to_main_merges() {
  setup; feature; mkdir -p "$FAKE_GH/pulls"
  run "$A"; reset_log; run "$A"; expect_eq "$(typed)" ""
  pr() { jq -n --argjson n "$1" --arg h "$2" --arg b "$3" --argjson m "$4" --arg s "$5" \
    '{number: $n, title: "t", state: $s, merged: $m, head: {ref: $h}, base: {ref: $b}}' > "$FAKE_GH/pulls/$1.json"; }
  pr 50 integrate/f001-x main false open; run "$A"; expect_eq "$(typed)" ""          # open, not merged
  pr 51 integrate/f002-y main true closed; pr 52 integrate/f001-x feature/f001-x true closed; pr 53 work/9-x main true closed
  run "$A"; expect_eq "$(typed)" ""                                                # another feature, base or head
  pr 50 integrate/f001-x main true closed
  run "$A"; expect_eq "$(typed)" "t1|keys ctrl+u / i n t e g r a t e space f 0 0 1 - x enter;"
  reset_log; run "$A"; expect_eq "$(typed)" ""                                     # once
  echo 'pr list' > "$FAKE_GH/fail"; run "$A"; expect_eq "$(typed)" ""              # GitHub down: not a change
  rm "$FAKE_GH/fail"; run "$A"; expect_eq "$(typed)" ""
}

run_tests
