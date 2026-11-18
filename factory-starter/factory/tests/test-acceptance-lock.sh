# Tests for factory/scripts/check-acceptance-lock.sh (fails if tests/acceptance/ changed after the
# commit carrying the trailer "Factory-Stage: tests").
. "$(dirname "$0")/lib.sh"
L="$SCRIPTS/check-acceptance-lock.sh"

setup() {
  mkrepo r && cd r
  mkdir -p tests/acceptance src && touch tests/acceptance/.gitkeep && git add . && git commit -qm base
  git switch -q -c work/7-thing
}
tests_commit() { echo "test $1" > "tests/acceptance/$1.test"; git add .; git commit -qm "tests" -m "Factory-Stage: tests"; }
build_commit() { echo "code $1" > "src/$1.ts"; git add .; git commit -qm "build" -m "Factory-Stage: build"; }

test_no_acceptance_changes_passes() {
  setup; build_commit a
  run "$L" main; expect_rc 0; expect_out "no acceptance tests"
}

test_locked_tests_then_build_passes() {
  setup; tests_commit a; build_commit a
  run "$L" main; expect_rc 0; expect_out "locked at"
}

test_tests_edited_after_lock_fails() {
  setup; tests_commit a; build_commit a
  echo "weakened" > tests/acceptance/a.test; git commit -qam "make it pass"
  run "$L" main; expect_rc 1; expect_err "tests/acceptance/a.test"
}

test_new_test_file_after_lock_fails() {
  setup; tests_commit a
  echo extra > tests/acceptance/b.test; git add .; git commit -qm "sneak"
  run "$L" main; expect_rc 1; expect_err "b.test"
}

test_deleted_test_after_lock_fails() {
  setup; tests_commit a; git rm -q tests/acceptance/a.test; git commit -qm "delete"
  run "$L" main; expect_rc 1
}

test_tests_without_trailer_fail() {
  setup; echo t > tests/acceptance/a.test; git add .; git commit -qm "tests, no trailer"
  run "$L" main; expect_rc 1; expect_err "no commit carries"
}

test_trailer_must_be_exact() {
  setup; echo t > tests/acceptance/a.test; git add .
  git commit -qm "tests" -m "Factory-Stage: tests please"
  run "$L" main; expect_rc 1
}

test_latest_lock_wins() {
  setup; tests_commit a; tests_commit b; build_commit a
  run "$L" main; expect_rc 0
}

test_custom_acceptance_dir() {
  setup; mkdir -p e2e; echo t > e2e/x.test; git add .; git commit -qm "tests" -m "Factory-Stage: tests"
  echo changed > e2e/x.test; git commit -qam "edit"
  ACCEPTANCE_DIR=e2e run "$L" main; expect_rc 1
}

test_unknown_base_fails_closed() {
  setup; tests_commit a
  run "$L" no-such-ref
  [ "$RC" != 0 ] || fail "an unknown base must not pass"
}

test_forged_trailer_is_a_documented_limit() {
  # The script header says a forged trailer gets through; the reviewer and audit cover it.
  # This test pins that behaviour so a change to it is noticed.
  setup; tests_commit a
  echo weakened > tests/acceptance/a.test; git commit -qam "edit" -m "Factory-Stage: tests"
  run "$L" main; expect_rc 0
}


test_a_sync_branch_is_exempt() {
  setup; tests_commit a; echo weakened > tests/acceptance/a.test; git commit -qam "after the lock"
  HEAD_REF=sync/f001-share run "$L" main; expect_rc 0; expect_out "sync/f001-share brings main's files unchanged"
  run "$L" main; expect_rc 1                                                        # without it, as before
  HEAD_REF=work/7-thing run "$L" main; expect_rc 1
  HEAD_REF=Sync/f001-share run "$L" main; expect_rc 1; expect_err "a.test"          # no look-alike
  local b
  for b in 'sync/f1-x' 'sync/../x' 'sync/$(touch pwned)' 'sync/' $'sync/f001-x\n' 'sync/f001-x/y'; do
    HEAD_REF=$b run "$L" main; [ "$RC" = 1 ] || fail "[$b] gave exit $RC"; expect_err "not a feature's sync branch"
  done
  [ ! -e pwned ] || fail "a branch name was run"
}

run_tests
