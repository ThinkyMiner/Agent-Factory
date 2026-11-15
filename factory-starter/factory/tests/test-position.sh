# Tests for factory/scripts/position.sh: sealed positions, only from the cycle's teams, only in round 1.
. "$(dirname "$0")/lib.sh"
POS="$SCRIPTS/position.sh"; R="$SCRIPTS/round.sh"
sealed() { echo "$MAIN/.factory/planning/c001-share-links/sealed"; }

test_who_may_submit() {
  planning_setup; meeting_to positions "backend, frontend"; position_ok > "$TEST_TMP/pos"
  by orchestrator "$POS" submit < "$TEST_TMP/pos"; expect_rc 1; expect_err "the orchestrator chairs and has no position"
  by research "$POS" submit < "$TEST_TMP/pos"; expect_rc 1; expect_err "research is not one of this cycle's teams"
  cd "$FE"; FACTORY_TEAM=backend run "$POS" submit < "$TEST_TMP/pos"; expect_rc 1; expect_err "this session has no team"
  by backend "$POS" submit < "$TEST_TMP/pos"; expect_rc 0; expect_out "sealed"
  [ -s "$(sealed)/backend.md" ] && [ ! -e "$P/positions" ] || fail "the position was not sealed, or was published early"
}

test_every_section_is_required_with_content() {
  planning_setup; meeting_to positions
  for h in "Build" "Needs from others" "Risks" "Open questions" "What I would object to in the brief"; do
    position_ok | awk -v h="## $h" '$0 == h {skip = 1; next} /^## / {skip = 0} !skip' > "$TEST_TMP/p"
    by backend "$POS" submit < "$TEST_TMP/p"; expect_rc 1; expect_err "needs a '## $h' section"
    position_ok | awk -v h="## $h" '{print} $0 == h {getline; print ""}' > "$TEST_TMP/p"
    by backend "$POS" submit < "$TEST_TMP/p"; expect_rc 1; expect_err "needs a '## $h' section"
  done
  position_ok | sed 's/^## Build$/## BUILD/' > "$TEST_TMP/p"; by backend "$POS" submit < "$TEST_TMP/p"; expect_rc 0
  [ ! -s "$(sealed)/frontend.md" ] || fail "a refused position was sealed"
}

test_resubmitting_replaces_and_limits_hold() {
  planning_setup; meeting_to positions
  position_ok "First version." > "$TEST_TMP/p1"; position_ok "Second version." > "$TEST_TMP/p2"
  by backend "$POS" submit < "$TEST_TMP/p1"; by backend "$POS" submit < "$TEST_TMP/p2"; expect_rc 0
  grep -q "Second version." "$(sealed)/backend.md" && ! grep -q "First version." "$(sealed)/backend.md" || fail "resubmission did not replace"
  { position_ok; head -c 20001 /dev/zero | tr '\0' z; } > "$TEST_TMP/big"
  by backend "$POS" submit < "$TEST_TMP/big"; expect_rc 1; expect_err "over 20000"
  by backend "$POS" submit < /dev/null; expect_rc 1; expect_err "needs a '## Build' section"
}

test_attachments_are_sealed_then_published_with_the_team_prefix() {
  planning_setup; meeting_to positions; position_ok > "$TEST_TMP/pos"
  printf 'openapi: 3.1.0\n' > "$TEST_TMP/api"
  for n in '../escape' '.hidden' 'a/b' '' 'x y' '$(touch pwned)'; do by backend "$POS" attach "$n" < "$TEST_TMP/api"; expect_rc 1; expect_err "usage"; done
  head -c 200001 /dev/zero > "$TEST_TMP/huge"; by backend "$POS" attach huge.bin < "$TEST_TMP/huge"; expect_rc 1; expect_err "over 200000 bytes"
  by backend "$POS" attach api.openapi.yaml < "$TEST_TMP/api"; expect_rc 0
  for t in backend frontend research; do by "$t" "$POS" submit < "$TEST_TMP/pos"; done
  by orchestrator "$R" next; expect_rc 0
  cmp -s "$TEST_TMP/api" "$P/attachments/backend-api.openapi.yaml" || fail "the attachment was not published"
  expect_eq "$(ls "$P/attachments")" backend-api.openapi.yaml
  [ ! -e pwned ] && [ ! -e "$MAIN/escape" ] || fail "a hostile name made something"
  by backend "$POS" submit < "$TEST_TMP/pos"; expect_rc 1; expect_err "only in the positions round"
}

run_tests
