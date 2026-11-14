# Tests for factory/scripts/lib.sh: factory_home, with_lock, append_jsonl.
. "$(dirname "$0")/lib.sh"
. "$SCRIPTS/lib.sh"

test_home_of_plain_repo_and_subdir() {
  mkrepo r && mkdir -p r/a/b
  expect_eq "$(factory_home "$TEST_TMP/r")" "$TEST_TMP/r"
  expect_eq "$(factory_home "$TEST_TMP/r/a/b")" "$TEST_TMP/r"
}

test_home_of_worktree_is_main_checkout() {
  mkrepo r && git -C r worktree add -q ../wt -b team/x && mkdir -p wt/deep
  expect_eq "$(factory_home "$TEST_TMP/wt")" "$TEST_TMP/r"
  expect_eq "$(factory_home "$TEST_TMP/wt/deep")" "$TEST_TMP/r"
}

test_home_outside_repo_is_the_dir() {
  mkdir plain
  expect_eq "$(factory_home "$TEST_TMP/plain")" "$TEST_TMP/plain"
  expect_eq "$(factory_home "$TEST_TMP/missing")" "$TEST_TMP/missing"
}

test_home_in_submodule_is_its_own_top_level() {
  mkrepo sub && mkrepo r
  git -C r -c protocol.file.allow=always submodule -q add "$TEST_TMP/sub" sub 2>/dev/null
  expect_eq "$(factory_home "$TEST_TMP/r/sub")" "$TEST_TMP/r/sub"
}

test_with_lock_runs_command_and_returns_its_status() {
  RC=0; with_lock l sh -c 'exit 7' || RC=$?
  expect_eq "$RC" 7
  expect_eq "$(echo piped | with_lock l cat)" piped "stdin passes through"
  expect_eq "$(with_lock l printf '%s|' 'a b' '$(x)')" 'a b|$(x)|' "args pass through unexpanded"
}

test_with_lock_times_out_with_75() {
  perl -MFcntl=:flock -e 'open(my $f, ">>", "l"); flock($f, LOCK_EX); open(my $r, ">", "held"); close $r; sleep 30' &
  local h=$! i=0; while [ ! -e held ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  RC=0; FACTORY_LOCK_TIMEOUT=0.3 with_lock l touch ran || RC=$?
  kill "$h"; wait "$h" 2>/dev/null || true
  expect_eq "$RC" 75
  [ ! -e ran ] || fail "ran the command without the lock"
}

test_lock_is_released_when_holder_exits() {
  with_lock l true
  RC=0; FACTORY_LOCK_TIMEOUT=0.3 with_lock l true || RC=$?
  expect_eq "$RC" 0
}

test_append_jsonl_without_perl_still_appends() {
  PATH=$(path_without perl) append_jsonl l out '{"a":1}'
  expect_eq "$(cat out)" '{"a":1}'
}

run_tests
