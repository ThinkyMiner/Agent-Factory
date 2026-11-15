# Tests for factory/scripts/dispatch.sh: only approved, settled decisions are handed out, one feature
# branch at a time, and each team with items is rung.
. "$(dirname "$0")/lib.sh"
DIS="$SCRIPTS/dispatch.sh"; R="$SCRIPTS/round.sh"; SAY="$SCRIPTS/say.sh"

approved() {  # approved [status of D02]: a three-team cycle taken to approval and merged
  planning_setup; meeting_to decisions; decisions_ok c001 "${1:-decided}" "${1:+frontend disagrees}" > "$P/DECISIONS.md"
  by orchestrator "$R" draft
  for t in backend research; do by "$t" "$SAY" accept --to orchestrator --body ok; done
  if [ -n "${1:-}" ]; then by frontend "$SAY" objection --to orchestrator --refs c001-D02 --body "Too short."
  else by frontend "$SAY" accept --to orchestrator --body ok; fi
  by orchestrator "$R" next; expect_rc 0
  git -C "$MAIN" push -q origin "planning/$C:main"
}

test_who_and_what_may_be_dispatched() {
  approved
  by backend "$DIS" "$C"; expect_rc 1; expect_err "only the orchestrator dispatches"
  for c in '' c1-x 'c001-x;touch pwned' '../c001-x' C001-X; do by orchestrator "$DIS" "$c"; expect_rc 1; expect_err "usage"; done
  by orchestrator "$DIS" c002-other; expect_rc 1; expect_err "planning/c002-other/DECISIONS.md is not on origin/main"
  [ ! -e pwned ] || fail "an argument was executed"
}

test_needs_human_records_block_dispatch() {
  approved needs-human
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "1 needs-human record(s) left: c001-D02"
  git -C "$TEST_TMP/origin.git" rev-parse -q --verify refs/heads/feature/f001-share-links >/dev/null && fail "made a feature branch anyway"
  true
}

test_one_feature_branch_at_a_time() {
  approved
  git -C "$MAIN" push -q origin main:feature/f000-older
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "feature/f000-older is still open"
  git -C "$MAIN" push -q origin --delete feature/f000-older
  by orchestrator "$DIS" "$C"; expect_rc 0
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "feature/f001-share-links is still open"
}

test_the_state_on_main_must_be_approval() {
  approved
  git -C "$MAIN" switch -q main && git -C "$MAIN" merge -q --ff-only origin/main
  jq '.status = "decisions"' "$P/state.json" > s && mv s "$P/state.json"
  git -C "$MAIN" commit -qam "not approved" && git -C "$MAIN" push -q origin main
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "the cycle's state on main is 'decisions', not approval"
  echo dirt > "$MAIN/dirt"; by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "uncommitted changes"
}

test_each_team_with_items_is_rung() {
  approved
  mkdir -p "$TEST_TMP/hd"
  jq -n '{spaces: [{name: "app", tabs: [{name: "orchestrator", terminals: [{terminal: "t1"}]}, {name: "backend", terminals: [{terminal: "t2"}]},
                                        {name: "frontend", terminals: [{terminal: "t3"}]}]}]}' > "$TEST_TMP/hd/layout"
  printf '#!/usr/bin/env bash\n[ "$1" = ls ] && cat "$TEST_TMP/hd/layout"\n' > "$TEST_TMP/hd/herdr-app"
  printf '#!/usr/bin/env bash\nprintf "%%s|%%s|%%s\\n" "$2" "$3" "$4 $5" >> "$TEST_TMP/hd/hc.log"\n' > "$TEST_TMP/hd/hc"
  chmod +x "$TEST_TMP/hd/herdr-app" "$TEST_TMP/hd/hc"; PATH="$TEST_TMP/hd:$PATH"
  by orchestrator "$DIS" "$C"; expect_rc 0
  expect_out "rang backend"; expect_out "rang frontend"; expect_out "could not ring research"
  expect_eq "$(sort "$TEST_TMP/hd/hc.log" | tr '\n' ' ')" "t2|New items for you: run /inbox.|--if idle t3|New items for you: run /inbox.|--if idle "
}

run_tests
