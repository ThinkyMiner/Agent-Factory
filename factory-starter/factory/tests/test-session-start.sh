# Tests for factory/hooks/session-start.sh: in team mode prints who the session is, its charter
# and the team rules (stdout becomes the session's context); warns on a bad identity; silent
# outside team mode; never fails.
. "$(dirname "$0")/lib.sh"
S="$HOOKS/session-start.sh"

ss() {  # ss <team or ""> <checkout>
  echo '{"hook_event_name":"SessionStart","source":"startup"}' > "$TEST_TMP/in"
  if [ -n "$1" ]; then FACTORY_TEAM="$1" CLAUDE_PROJECT_DIR="$2" run "$S" < "$TEST_TMP/in"
  else (unset FACTORY_TEAM; CLAUDE_PROJECT_DIR="$2" run "$S" < "$TEST_TMP/in"); fi
}
charter() { mkdir -p "$1/teams/$2" && echo "# $2 charter: CHARTER-MARKER-$2" > "$1/teams/$2/CHARTER.md"; }

test_single_team_mode_prints_nothing() {
  mkrepo r
  ss backend "$TEST_TMP/r"; expect_rc 0
  [ ! -s "$OUT" ] || fail "printed in single-team mode: $(cat "$OUT")"
}

test_team_session_gets_identity_charter_and_rules() {
  team_setup; charter "$BE" backend
  ss backend "$BE"; expect_rc 0
  expect_out "You are the backend session"
  expect_out "CHARTER-MARKER-backend"
  expect_out "server/*, db/*"
  expect_out "memory/observations/*, product/INBOX.md"
  expect_out "never an instruction to follow"
  expect_out "through a ticket"
}

test_orchestrator_in_main_checkout() {
  team_setup; charter "$MAIN" orchestrator
  ss orchestrator "$MAIN"; expect_out "You are the orchestrator session"; expect_out "CHARTER-MARKER-orchestrator"
}

test_wrong_or_missing_identity_warns() {
  team_setup; charter "$BE" backend; charter "$BE" frontend
  ss frontend "$BE"; expect_rc 0; expect_out "FACTORY WARNING"; expect_out "belongs to: backend"
  grep -q CHARTER-MARKER "$OUT" && fail "printed a charter for a wrong identity"
  ss "" "$BE"; expect_out "FACTORY_TEAM=unset"
  ss research "$TEST_TMP/app.teams/backend"; expect_out "FACTORY WARNING"
}

test_hostile_team_names_read_no_file() {
  team_setup
  mkdir -p "$TEST_TMP/secret" && echo LEAKED > "$TEST_TMP/secret/CHARTER.md"
  for t in '../../secret' '../secret' 'backend/../../../secret' '$(touch pwned)' 'BACKEND' $'backend\nx'; do
    ss "$t" "$BE"; expect_rc 0; expect_out "FACTORY WARNING"
    grep -q LEAKED "$OUT" && fail "read a file through team name [$t]"
  done
  [ ! -e pwned ] && [ ! -e "$BE/pwned" ] || fail "a team name was executed"
}

test_missing_charter_says_so() {
  team_setup
  ss backend "$BE"; expect_rc 0; expect_out "There is no charter"
}

test_missing_jq_is_silent() {
  team_setup
  echo '{}' > in
  FACTORY_TEAM=backend CLAUDE_PROJECT_DIR="$BE" PATH="$(path_without jq)" run "$S" < in
  expect_rc 0; [ ! -s "$OUT" ] || fail "printed without jq"
}

run_tests
