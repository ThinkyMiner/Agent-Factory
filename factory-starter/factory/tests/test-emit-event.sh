# Tests for factory/scripts/emit-event.sh: appends one event to .factory/events.jsonl and, on a
# work/<id>-<slug> branch whose folder exists, to work/<id>-<slug>/events.jsonl. Never fails.
. "$(dirname "$0")/lib.sh"
E="$SCRIPTS/emit-event.sh"

log() { echo "$TEST_TMP/r/.factory/events.jsonl"; }
field() { tail -n 1 "${2:-$(log)}" | jq -r "$1"; }

test_no_type_prints_usage_and_exits_0() {
  mkrepo r && cd r
  run "$E"; expect_rc 0; expect_err usage
  expect_eq "$(lines "$(log)")" 0
}

test_basic_event() {
  mkrepo r && cd r
  run "$E" stage stage=build status=started round=0
  expect_rc 0
  expect_eq "$(field .type)" stage
  expect_eq "$(field .stage)" build
  expect_eq "$(field .status)" started
  expect_eq "$(field .round)" 0
  expect_eq "$(field .branch)" main
  expect_eq "$(field .work_id)" ""
}

test_work_branch_writes_both_logs() {
  mkrepo r && cd r && git switch -q -c work/12-share && mkdir -p work/12-share
  run "$E" stage stage=spec status=passed
  expect_eq "$(field .work_id)" 12
  expect_eq "$(lines work/12-share/events.jsonl)" 1
  expect_eq "$(field .stage work/12-share/events.jsonl)" spec
}

test_work_branch_without_folder_writes_shared_only() {
  mkrepo r && cd r && git switch -q -c work/12-share
  run "$E" stage stage=spec status=passed
  expect_eq "$(lines "$(log)")" 1
  [ ! -e work ] || fail "created a work folder"
}

test_bad_keys_are_skipped() {
  mkrepo r && cd r
  run "$E" x 'a-b=1' '=v' noequals 'k_1=ok' 'a b=2' 'k$(id)=3'
  expect_eq "$(field 'keys | sort | join(",")')" "branch,k_1,ts,type,work_id"
}

test_hostile_values_are_stored_literally() {
  mkrepo r && cd r
  local v; v=$(printf 'q"uote\nnew line `touch pwned2` $(touch pwned) é ✓ \\ end')
  run "$E" x "v=$v"
  expect_eq "$(field .v)" "$v"
  expect_eq "$(lines "$(log)")" 1
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "value was executed"
}

test_large_value_is_kept() {
  mkrepo r && cd r
  local v; v=$(head -c 60000 /dev/zero | tr '\0' a)
  run "$E" x "v=$v"
  expect_eq "$(field '.v | length')" 60000
}

test_work_id_and_branch_can_be_passed() {
  mkrepo r && cd r
  run "$E" stage work_id=99 branch=work/99-x
  expect_eq "$(field .work_id)" 99
  expect_eq "$(field .branch)" work/99-x
}

test_missing_jq_exits_0() {
  mkrepo r && cd r
  PATH=$(path_without jq) run "$E" x a=1
  expect_rc 0; expect_eq "$(lines "$(log)")" 0
}

test_unwritable_log_exits_0() {
  mkrepo r && cd r && mkdir .factory && chmod 500 .factory
  run "$E" x a=1
  chmod 700 .factory
  expect_rc 0
}

test_outside_a_repo_writes_to_cwd() {
  mkdir r && cd r
  run "$E" x a=1
  expect_rc 0; expect_eq "$(lines "$(log)")" 1
}

test_envelope_fields_cannot_be_forged() {
  # ts and type come from the script; a caller passing ts= or type= must not overwrite them.
  mkrepo r && cd r
  run "$E" stage ts=1999-01-01T00:00:00Z type=approval
  expect_eq "$(field .type)" stage
  [ "$(field .ts)" != 1999-01-01T00:00:00Z ] || fail "ts was forged"
}

test_worktree_writes_shared_log_in_main_checkout() {
  mkrepo r && git -C r worktree add -q ../wt -b team/backend
  cd wt && git switch -q -c work/8-x && mkdir -p work/8-x
  run "$E" stage stage=build status=started
  expect_rc 0
  expect_eq "$(lines "$TEST_TMP/r/.factory/events.jsonl")" 1 "shared log in the main checkout"
  [ ! -e .factory ] || fail "wrote a second log inside the worktree"
  expect_eq "$(lines work/8-x/events.jsonl)" 1 "per-item log stays in the worktree"
  [ ! -e work/8-x/events.jsonl.lock ] && [ ! -e work/8-x/events.lock ] || fail "lock file inside the work folder"
}

# hold_lock <lockfile> <seconds>: a background process holding the event lock; pid in $HOLDER.
hold_lock() {
  mkdir -p "$(dirname "$1")"
  perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX); open(my $r, ">", "$ARGV[0].held"); close $r; sleep $ARGV[1]' "$1" "$2" &
  HOLDER=$!
  local i=0; while [ ! -e "$1.held" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  [ -e "$1.held" ] || fail "holder never took the lock"
}

test_killed_lock_holder_does_not_block() {
  mkrepo r && cd r
  hold_lock .factory/events.lock 60
  kill -9 "$HOLDER"; wait "$HOLDER" 2>/dev/null || true
  local t0 t1; t0=$(date +%s)
  FACTORY_LOCK_TIMEOUT=10 run "$E" x a=1
  t1=$(date +%s)
  [ $((t1 - t0)) -le 2 ] || fail "waited $((t1 - t0))s on a dead holder's lock"
  expect_eq "$(lines .factory/events.jsonl)" 1
  expect_eq "$(field .type)" x
}

test_hung_lock_holder_costs_only_the_timeout() {
  mkrepo r && cd r
  hold_lock .factory/events.lock 60
  local t0 t1; t0=$(date +%s)
  FACTORY_LOCK_TIMEOUT=1 run "$E" x a=1
  t1=$(date +%s)
  kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null || true
  expect_rc 0
  [ $((t1 - t0)) -le 3 ] || fail "took $((t1 - t0))s with a 1s timeout"
  expect_eq "$(jq -r 'select(.type=="x") | .a' .factory/events.jsonl)" 1 "event not lost"
  expect_eq "$(jq -r 'select(.type=="lock_timeout") | .lock' .factory/events.jsonl)" .factory/events.lock
}

test_concurrent_writers_lose_and_interleave_nothing() {
  # 20 emit-event writers x 10 events of ~70 KB (bigger than one write(), so unlocked appends could
  # interleave) plus 5 telemetry writers x 10, all at once, into one shared and one per-item log.
  mkrepo r && cd r && git switch -q -c work/5-x && mkdir -p work/5-x
  local pad i; pad=$(head -c 70000 /dev/zero | tr '\0' p)
  for i in $(seq 1 20); do
    ( for j in $(seq 1 10); do "$E" x writer="$i" n="$j" pad="$pad"; done ) &
  done
  for i in $(seq 1 5); do
    ( for j in $(seq 1 10); do printf '{"hook_event_name":"Stop","session_id":"t%s-%s"}' "$i" "$j" | CLAUDE_PROJECT_DIR="$PWD" "$HOOKS/telemetry.sh"; done ) &
  done
  wait
  expect_eq "$(lines .factory/events.jsonl)" 250 "shared log lines"
  expect_eq "$(lines work/5-x/events.jsonl)" 200 "per-item log lines"
  jq -e . .factory/events.jsonl > /dev/null || fail "shared log has a corrupt line"
  jq -e . work/5-x/events.jsonl > /dev/null || fail "per-item log has a corrupt line"
  expect_eq "$(jq -r 'select(.type=="x") | "\(.writer)-\(.n)"' .factory/events.jsonl | sort -u | awk 'END{print NR}')" 200 "distinct emit events"
  expect_eq "$(jq -r 'select(.type=="x") | .pad | length' .factory/events.jsonl | sort -u)" 70000 "no truncated payload"
  expect_eq "$(jq -r 'select(.type=="lifecycle") | .session_id' .factory/events.jsonl | sort -u | awk 'END{print NR}')" 50 "distinct telemetry events"
  expect_eq "$(jq -r 'select(.type=="lock_timeout")' .factory/events.jsonl | awk 'END{print NR}')" 0 "no lock timeouts"
}

run_tests
