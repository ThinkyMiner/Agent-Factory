# Tests for factory/scripts/round.sh beyond the meeting itself: who chairs, opening, the brief,
# approval, damaged state and the record's branch.
. "$(dirname "$0")/lib.sh"
R="$SCRIPTS/round.sh"

test_only_the_orchestrator_chairs_but_anyone_may_ask_status() {
  planning_setup
  for c in "open x-y" brief next draft "abandon --reason long-enough-reason"; do
    by backend "$R" $c; expect_rc 1
  done
  by backend "$R" open share-links; expect_err "only the orchestrator chairs a cycle"
  cd "$BE"; FACTORY_TEAM=orchestrator run "$R" open share-links; expect_rc 1; expect_err "this session has no team"
  meeting_to positions
  by backend "$R" status; expect_rc 0; expect_out "cycle c001-share-links: positions"; expect_out "backend owes: a position"
  by frontend "$R" ready; expect_rc 1; expect_out "waiting for positions from: backend frontend research"
}

test_open_checks_its_slug_and_the_checkout_and_numbers_cycles() {
  planning_setup
  for s in Bad a '../x' '$(touch pwned)' "$(head -c 42 /dev/zero | tr '\0' a)" '-x' ''; do
    by orchestrator "$R" open "$s"; expect_rc 1; expect_err "usage"
  done
  echo dirt > "$MAIN/dirt"; by orchestrator "$R" open share-links; expect_rc 1; expect_err "uncommitted changes"; rm "$MAIN/dirt"
  mkdir -p "$MAIN/planning/c007-old" && echo x > "$MAIN/planning/c007-old/DECISIONS.md"
  git -C "$MAIN" add -A && git -C "$MAIN" commit -qm old && git -C "$MAIN" push -q origin main
  git -C "$MAIN" push -q origin main:planning/c009-unmerged
  by orchestrator "$R" open share-links; expect_rc 0; expect_out "opened c010-share-links"
  [ ! -e pwned ] || fail "a slug was executed"
}

test_the_brief_is_checked_before_it_goes_out() {
  planning_setup; by orchestrator "$R" open share-links; C=c001-share-links; P="$MAIN/planning/$C"
  for line in "teams: *" "teams: orchestrator, backend" "teams: design" "teams: ../backend" "teams:" 'teams: $(touch pwned)'; do
    brief_ok "$C" x; sed -i.bak "s|^teams: x$|$line|" "$P/BRIEF.md"; rm -f "$P/BRIEF.md.bak"
    by orchestrator "$R" brief; expect_rc 1
  done
  brief_ok "$C" "backend, backend,frontend"; sed -i.bak '/^## Constraints$/,/^## Out/{/^No new/d;}' "$P/BRIEF.md"; rm -f "$P/BRIEF.md.bak"
  by orchestrator "$R" brief; expect_rc 1; expect_err "needs a non-empty '## Constraints' section"
  brief_ok "$C" "backend, backend,frontend"; by orchestrator "$R" brief; expect_rc 0
  expect_eq "$(jq -c .teams "$P/state.json")" '["backend","frontend"]'
  by orchestrator "$R" brief; expect_rc 0; expect_eq "$(ls "$FAKE_GH/pulls")" 1.json      # one pull request, updated
  [ ! -e pwned ] && [ ! -e "$MAIN/pwned" ] || fail "a brief line was executed"
}

test_a_stale_brief_approval_does_not_count() {
  planning_setup; by orchestrator "$R" open share-links; C=c001-share-links; P="$MAIN/planning/$C"
  brief_ok "$C" "backend, frontend"; by orchestrator "$R" brief
  approve 1; jq --arg t "$(perl -MPOSIX -e 'print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time))')" '. + [{ref: "refs/heads/planning/c001-share-links", activity_type: "push", timestamp: $t}]' "$FAKE_GH/activity.json" > a && mv a "$FAKE_GH/activity.json"
  by orchestrator "$R" next; expect_rc 1; expect_err "before the last push"
}

test_a_brief_changed_after_approval_stops_the_approval() {
  planning_setup; meeting_to decisions "backend"
  decisions_ok c001 | grep -vE 'share-button|share-research' | sed 's/^- affects: .*/- affects: none/' > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0
  expect_eq "$(jq -c 'select(.kind == "decision") | [.draft, .body]' "$P/discussion.jsonl")" '[1,"draft 1: planning/c001-share-links/DECISIONS.md"]' "the chair's line names its draft"
  by backend "$SCRIPTS/say.sh" accept --to orchestrator --body ok
  echo "One more goal." >> "$P/BRIEF.md"
  by orchestrator "$R" next; expect_rc 1; expect_err "BRIEF.md changed after it was approved"
}

test_damaged_state_and_wrong_branch_stop_the_chair() {
  planning_setup; meeting_to positions
  git -C "$MAIN" switch -q main
  by orchestrator "$R" next; expect_rc 1; expect_err "state.json is missing or damaged"
  git -C "$MAIN" switch -q "planning/$C"; echo '[1,2]' > "$P/state.json"
  by orchestrator "$R" next; expect_rc 1; expect_err "state.json is missing or damaged"
  by orchestrator "$R" abandon --reason short; expect_rc 1; expect_err "state.json is missing or damaged"
  git -C "$MAIN" checkout -q -- "planning/$C/state.json"
  by orchestrator "$R" abandon --reason short; expect_rc 1; expect_err "at least 10 characters"
  by orchestrator "$R" abandon; expect_rc 1; expect_err "usage"
  by orchestrator "$R" abandon --reason "The goal moved to next month."; expect_rc 0
  jq -e '.state == "closed"' "$FAKE_GH/pulls/1.json" >/dev/null || fail "the draft PR was not closed"
  expect_eq "$(git -C "$TEST_TMP/origin.git" show "planning/$C:planning/$C/state.json" | jq -r .status)" closed
  by orchestrator "$R" next; expect_rc 1; expect_err "no planning cycle is open"
}

test_unknown_command_prints_usage() {
  planning_setup; by orchestrator "$R" frobnicate; expect_rc 1; expect_err "round.sh open <slug>"
}

run_tests
