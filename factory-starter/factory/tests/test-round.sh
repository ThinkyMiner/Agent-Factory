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


mvp_main() {  # RIGOR=mvp on main, pushed, before the cycle opens
  echo RIGOR=mvp > "$MAIN/factory/policy.env"
  git -C "$MAIN" add -A && git -C "$MAIN" commit -qm mvp && git -C "$MAIN" push -q origin main
}

test_mvp_has_one_discussion_round_no_review_round_and_one_draft() {
  planning_setup; mvp_main; meeting_to discussion-1
  by orchestrator "$R" status; expect_out "rigor mvp"
  by orchestrator "$R" next --again; expect_rc 1; expect_err "limit: 1 discussion rounds"
  by orchestrator "$R" next; expect_rc 0; expect_out "RIGOR=mvp: no review round"; status_is decisions
  decisions_ok c001 > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0
  by orchestrator "$R" draft; expect_rc 1; expect_err "limit: 1 drafts"
}

test_mvp_planning_limits_yield_to_the_roster() {
  planning_setup; mvp_main; limits '{"discussion_rounds": 2, "drafts": 2}'
  git -C "$MAIN" commit -qam limits && git -C "$MAIN" push -q origin main
  meeting_to discussion-1
  by orchestrator "$R" next --again; expect_rc 0; status_is discussion-2
  by orchestrator "$R" next; expect_rc 0; status_is decisions          # still no review round
}

test_full_rigor_keeps_the_review_round_whatever_a_checkout_says() {
  planning_setup; meeting_to discussion-1
  echo RIGOR=mvp > "$P/../../factory/policy.env"                       # the chair's checkout, not main
  by orchestrator "$R" status; expect_out "rigor full"
  by orchestrator "$R" next; expect_rc 0; status_is review
}

autonomy_main() {  # AUTONOMY=<value> on main, pushed, before the cycle opens
  printf 'AUTONOMY=%s\n' "${1-on}" >> "$MAIN/factory/policy.env"
  git -C "$MAIN" add -A && git -C "$MAIN" commit -qm autonomy && git -C "$MAIN" push -q origin main
}
backend_only_decisions() { decisions_ok c001 | grep -vE 'share-button|share-research' | sed 's/^- affects: .*/- affects: none/'; }

test_with_autonomy_the_brief_needs_no_approval_and_the_planning_pr_merges_itself() {
  planning_setup; autonomy_main
  by orchestrator "$R" open share-links; expect_rc 0; expect_out "from the human's proposal"
  C=c001-share-links; P="$MAIN/planning/$C"; brief_ok "$C" backend
  by orchestrator "$R" brief; expect_rc 0; expect_out "AUTONOMY=on: no approval to wait for"
  jq -r .body "$FAKE_GH/pulls/1.json" | grep -q brief-approved && fail "the draft PR asks for the human's label"
  jq -r .body "$FAKE_GH/pulls/1.json" | grep -q "merges itself" || fail "the draft PR does not say it merges itself"
  by orchestrator "$R" next; expect_rc 0; status_is decisions                 # no brief-approved anywhere
  expect_eq "$(jq -r .brief_approval "$P/state.json")" "none needed (AUTONOMY=on)"
  backend_only_decisions > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0
  by backend "$SCRIPTS/say.sh" accept --to orchestrator --body ok
  by orchestrator "$R" next; expect_rc 0; status_is approval
  expect_out "pull request #1 is ready and merges itself once CI is green (AUTONOMY=on)"
  grep -qx "pr ready 1" "$FAKE_GH/log" && grep -qx "pr merge 1 --auto --merge" "$FAKE_GH/log" || fail "the planning PR was not set to merge itself: $(cat "$FAKE_GH/log")"
  jq -e '.draft == false and .auto_merge != null' "$FAKE_GH/pulls/1.json" >/dev/null || fail "pull request #1 is not ready with auto-merge"
}

test_with_autonomy_github_refusing_auto_merge_is_said_not_fatal() {
  planning_setup; autonomy_main; meeting_to decisions backend
  backend_only_decisions > "$P/DECISIONS.md"; by orchestrator "$R" draft
  by backend "$SCRIPTS/say.sh" accept --to orchestrator --body ok
  echo 'pr merge' > "$FAKE_GH/fail"
  by orchestrator "$R" next; expect_rc 0; status_is approval
  expect_out "GitHub refused to set it to merge itself; run gh pr merge 1 --auto --merge"
}

test_with_autonomy_a_brief_changed_after_positions_still_stops_approval() {
  planning_setup; autonomy_main; meeting_to decisions backend
  backend_only_decisions > "$P/DECISIONS.md"; by orchestrator "$R" draft
  by backend "$SCRIPTS/say.sh" accept --to orchestrator --body ok
  echo "One more goal." >> "$P/BRIEF.md"
  by orchestrator "$R" next; expect_rc 1; expect_err "BRIEF.md changed after it was settled (positions began)"
  grep -q "pr merge" "$FAKE_GH/log" && fail "a changed brief still got auto-merge"; true
}

test_without_autonomy_on_main_the_brief_still_waits_for_the_label() {
  local v
  for v in off ON yes 'on # please' '"on"' '$(touch pwned)' ''; do
    cd "$TEST_TMP" && rm -rf app app.teams origin.git gh pwned
    planning_setup; autonomy_main "$v"
    by orchestrator "$R" open share-links; brief_ok c001-share-links backend
    by orchestrator "$R" brief; expect_rc 0; expect_out "adds brief-approved"
    by orchestrator "$R" next; expect_rc 1; expect_err "the brief is not approved"
  done
  # on in the chair's checkout only, never pushed: still the human's label
  printf 'AUTONOMY=on\n' >> "$MAIN/factory/policy.env"
  by orchestrator "$R" next; expect_rc 1; expect_err "the brief is not approved"
  [ ! -e "$MAIN/pwned" ] && [ ! -e pwned ] || fail "a policy value was run"
}

test_with_autonomy_open_questions_and_drafts_go_to_the_orchestrator() {
  planning_setup; autonomy_main; meeting_to discussion-1
  by orchestrator "$SCRIPTS/say.sh" question --to backend --body "Rate limits on the share endpoint?"; expect_out c001-m004
  limits '{"round_minutes": 0}'
  by orchestrator "$R" next; expect_rc 0
  expect_out "still open, so the orchestrator decides each (decided_by: orchestrator), with each team's dissent recorded: c001-m004"
  grep -q needs-human "$OUT" && fail "the round still asks for needs-human records"
  limits '{"round_minutes": 60, "drafts": 1}'
  by orchestrator "$R" next; status_is decisions
  decisions_ok c001 decided none c001-m004 | perl -pe 's/^(- refs: c001-m004)$/$1\n- decided_by: orchestrator/' > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0
  by orchestrator "$R" draft; expect_rc 1; expect_err "decide what is left yourself (decided_by: orchestrator, each team's dissent recorded)"
}

run_tests
