# Tests for factory/scripts/slot.sh: at most max_active_build_teams teams build at once.
. "$(dirname "$0")/lib.sh"
S="$SCRIPTS/slot.sh"
as() { local t=$1; shift; case "$t" in orchestrator) cd "$MAIN" ;; backend) cd "$BE" ;; frontend) cd "$FE" ;; esac; FACTORY_TEAM=$t run "$S" "$@"; }
max() {  # max <value>: set max_active_build_teams in every checkout's roster
  local d; for d in "$MAIN" "$BE" "$FE"; do jq --argjson m "$1" '.max_active_build_teams = $m' "$d/factory/teams.json" > "$d/t" && mv "$d/t" "$d/factory/teams.json"; done
}
held() { jq -r '.held | keys | join(" ")' "$MAIN/.factory/slots.json"; }

test_acquire_queue_release() {
  team_setup; max 1
  as backend acquire; expect_rc 0; expect_out "backend holds a slot (1 of 1 taken)"
  as backend acquire; expect_rc 0; expect_out "already holds"
  as frontend acquire; expect_rc 3; expect_err "all 1 slots are taken (backend). frontend is queued"
  expect_eq "$(jq -c .queue "$MAIN/.factory/slots.json")" '["frontend"]'
  as backend release; expect_rc 0; expect_out "backend released its slot. Waiting: frontend."
  as frontend acquire; expect_rc 0; expect_eq "$(jq -c .queue "$MAIN/.factory/slots.json")" '[]'
  as backend release; expect_rc 0; expect_out "holds no slot"
  as orchestrator status; expect_out "slots: 1 of 1 taken"; expect_out "frontend since"
  expect_eq "$(grep -c '"type":"slot"' "$MAIN/.factory/events.jsonl")" 4
  grep '"type":"slot"' "$MAIN/.factory/events.jsonl" | jq -r '"\(.team) \(.action)"' | tr '\n' ',' > got
  expect_eq "$(cat got)" "backend acquire,frontend queued,backend release,frontend acquire,"
}

test_default_is_two_and_bad_limits_fall_back() {
  team_setup
  as backend acquire; as frontend acquire; expect_rc 0; expect_out "2 of 2 taken"
  as backend release; as frontend release
  for m in '"3; rm -rf x"' -1 0 1000 '"x"' null; do
    max "$m"; as backend acquire; expect_rc 0; expect_out "of 2 taken"; as backend release
  done
}

test_who_may_hold_a_slot() {
  team_setup
  as orchestrator acquire; expect_rc 1; expect_err "the orchestrator does not build"
  cd "$FE"; FACTORY_TEAM=backend run "$S" acquire; expect_rc 1; expect_err "this session has no team"
  cd "$FE"; FACTORY_TEAM=frontend run "$S" _locked acquire; expect_rc 0     # the lock is not a way around identity
  cd "$BE"; FACTORY_TEAM=frontend run "$S" _locked acquire; expect_rc 1; expect_err "this session has no team"
  mkrepo solo && cd solo; FACTORY_TEAM=backend run "$S" acquire; expect_rc 1; expect_err "slots are for team mode"
  as backend grab; expect_rc 1; expect_err "usage"
}

test_concurrent_acquires_never_overfill() {
  team_setup; max 1
  for i in 1 2 3 4 5 6 7 8 9 10; do
    (cd "$BE" && FACTORY_TEAM=backend "$S" acquire >/dev/null 2>&1) &
    (cd "$FE" && FACTORY_TEAM=frontend "$S" acquire >/dev/null 2>&1) &
  done
  wait
  jq -e . "$MAIN/.factory/slots.json" >/dev/null || fail "slots.json is not valid JSON after concurrent writers"
  expect_eq "$(jq '.held | length' "$MAIN/.factory/slots.json")" 1
  expect_eq "$(jq '[.held | keys[]] + .queue | sort | unique | length' "$MAIN/.factory/slots.json")" 2
}

test_concurrent_acquire_and_release_stay_consistent() {
  team_setup
  for i in 1 2 3 4 5 6 7 8; do
    (cd "$BE" && FACTORY_TEAM=backend "$S" acquire >/dev/null 2>&1; FACTORY_TEAM=backend "$S" release >/dev/null 2>&1) &
    (cd "$FE" && FACTORY_TEAM=frontend "$S" acquire >/dev/null 2>&1) &
  done
  wait
  jq -e '(.held | type == "object") and (.queue | type == "array")' "$MAIN/.factory/slots.json" >/dev/null || fail "state damaged"
  expect_eq "$(held)" frontend
}

test_damaged_state_is_recovered() {
  team_setup
  mkdir -p "$MAIN/.factory"
  for bad in 'not json' '{"held": [], "queue": {}}' '' '{"held": {"backend": "x"}'; do
    printf '%s' "$bad" > "$MAIN/.factory/slots.json"
    as frontend acquire; expect_rc 0; expect_eq "$(held)" frontend; as frontend release
  done
}

test_a_hung_lock_holder_costs_only_the_timeout_and_a_killed_one_nothing() {
  team_setup; mkdir -p "$MAIN/.factory"
  perl -e 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX); sleep 4' "$MAIN/.factory/slots.lock" &
  holder=$!; sleep 0.5
  cd "$BE"; start=$(date +%s); FACTORY_LOCK_TIMEOUT=1 FACTORY_TEAM=backend run "$S" acquire
  expect_rc 1; expect_err "held the slot lock for more than 1s"
  [ $(( $(date +%s) - start )) -le 3 ] || fail "waited longer than the timeout"
  kill -9 "$holder"; wait "$holder" 2>/dev/null || true
  FACTORY_LOCK_TIMEOUT=1 FACTORY_TEAM=backend run "$S" acquire; expect_rc 0
}

run_tests
