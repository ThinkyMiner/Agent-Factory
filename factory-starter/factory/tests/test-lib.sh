# Tests for factory/scripts/lib.sh: factory_home, with_lock, append_jsonl.
. "$(dirname "$0")/lib.sh"
. "$SCRIPTS/lib.sh"

test_home_of_plain_repo_and_subdir() {  # a kit kept in a subfolder keeps its state there
  mkrepo r && mkdir -p r/a/b
  expect_eq "$(factory_home "$TEST_TMP/r")" "$TEST_TMP/r"
  expect_eq "$(factory_home "$TEST_TMP/r/a/b")" "$TEST_TMP/r/a/b"
}

test_home_of_worktree_is_main_checkout() {
  mkrepo r && git -C r worktree add -q ../wt -b team/x && mkdir -p wt/deep
  expect_eq "$(factory_home "$TEST_TMP/wt")" "$TEST_TMP/r"
  expect_eq "$(factory_home "$TEST_TMP/wt/deep")" "$TEST_TMP/r/deep"
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


test_rigor_is_mains_and_anything_but_mvp_is_full() {
  mkrepo r && mkdir -p r/factory
  expect_eq "$(rigor "$TEST_TMP/r")" full "no policy.env"
  echo RIGOR=mvp > r/factory/policy.env
  expect_eq "$(rigor "$TEST_TMP/r")" mvp "no origin/main: the checkout's copy"
  printf 'RIGOR=mvp\r\n' > r/factory/policy.env; expect_eq "$(rigor "$TEST_TMP/r")" mvp "CRLF"
  local v
  for v in MVP 'mvp # light' '"mvp"' 'mvp; touch pwned' '$(touch pwned)' '`touch pwned`' '' full mvpx; do
    printf 'RIGOR=%s\n' "$v" > r/factory/policy.env
    expect_eq "$(rigor "$TEST_TMP/r")" full "RIGOR=$v"
  done
  printf ' RIGOR=mvp\n' > r/factory/policy.env; expect_eq "$(rigor "$TEST_TMP/r")" full "indented: not a setting"
  printf 'RIGOR=mvp\nRIGOR=full\n' > r/factory/policy.env; expect_eq "$(rigor "$TEST_TMP/r")" full "the last line wins"
  head -c 3000 /dev/urandom > r/factory/policy.env; expect_eq "$(rigor "$TEST_TMP/r")" full "binary junk"
  [ ! -e pwned ] && [ ! -e r/pwned ] || fail "a value was executed"
  # once there is an origin/main, only main's copy counts
  echo RIGOR=full > r/factory/policy.env; git -C r add -A && git -C r commit -qm policy
  git clone -q --bare r origin.git && git -C r remote add origin "$TEST_TMP/origin.git" && git -C r fetch -q origin
  echo RIGOR=mvp > r/factory/policy.env
  expect_eq "$(rigor "$TEST_TMP/r")" full "the checkout cannot lighten main"
  git -C r commit -qam mvp; expect_eq "$(rigor "$TEST_TMP/r")" full "nor a local commit"
  git -C r push -q origin main && git -C r fetch -q origin
  expect_eq "$(rigor "$TEST_TMP/r")" mvp "main says mvp"
  git -C r worktree add -q ../wt -b team/x origin/main 2>/dev/null
  expect_eq "$(rigor "$TEST_TMP/wt")" mvp "a team's worktree reads main too"
  git -C r rm -q factory/policy.env && git -C r commit -qm gone && git -C r push -q origin main && git -C r fetch -q origin
  mkdir -p r/factory && echo RIGOR=mvp > r/factory/policy.env
  expect_eq "$(rigor "$TEST_TMP/r")" full "main without a policy: full, whatever the checkout says"
}

test_policy_sh_prints_the_rigor_and_refuses_anything_else() {
  mkrepo r && mkdir -p r/factory && echo RIGOR=mvp > r/factory/policy.env && cd r
  run "$SCRIPTS/policy.sh" rigor; expect_rc 0; expect_eq "$(cat "$OUT")" mvp
  mkdir -p deep/er && cd deep/er; run "$SCRIPTS/policy.sh" rigor; expect_eq "$(cat "$OUT")" mvp "from a subfolder"
  local a
  for a in "" RIGOR "rigor extra" --help '$(touch pwned)' AUTO_MERGE_MAX_TIER; do
    run "$SCRIPTS/policy.sh" $a; expect_rc 2; expect_err "usage: policy.sh rigor"
  done
  [ ! -e pwned ] || fail "an argument was executed"
  mkdir "$TEST_TMP/plain" && cd "$TEST_TMP/plain"; run "$SCRIPTS/policy.sh" rigor; expect_rc 0; expect_eq "$(cat "$OUT")" full "outside a repository"
}

test_autonomy_is_mains_and_anything_but_on_is_off() {
  mkrepo r && mkdir -p r/factory
  expect_eq "$(autonomy "$TEST_TMP/r")" off "no policy.env"
  echo AUTONOMY=on > r/factory/policy.env
  expect_eq "$(autonomy "$TEST_TMP/r")" on "no origin/main: the checkout's copy"
  printf 'AUTONOMY=on\r\n' > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" on "CRLF"
  printf 'RIGOR=mvp\nAUTONOMY=on\n' > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" on "beside other settings"
  expect_eq "$(rigor "$TEST_TMP/r")" mvp "rigor still reads its own line"
  local v
  for v in ON yes true 1 'on # please' '"on"' 'on; touch pwned' '$(touch pwned)' '`touch pwned`' '' off onx; do
    printf 'AUTONOMY=%s\n' "$v" > r/factory/policy.env
    expect_eq "$(autonomy "$TEST_TMP/r")" off "AUTONOMY=$v"
  done
  printf ' AUTONOMY=on\n' > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" off "indented: not a setting"
  printf '#AUTONOMY=on\n' > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" off "commented out"
  printf 'AUTONOMY=on\nAUTONOMY=off\n' > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" off "the last line wins"
  printf 'XAUTONOMY=on\n' > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" off "another key"
  head -c 3000 /dev/urandom > r/factory/policy.env; expect_eq "$(autonomy "$TEST_TMP/r")" off "binary junk"
  [ ! -e pwned ] && [ ! -e r/pwned ] || fail "a value was executed"
  echo AUTONOMY=off > r/factory/policy.env; git -C r add -A && git -C r commit -qm policy
  git clone -q --bare r origin.git && git -C r remote add origin "$TEST_TMP/origin.git" && git -C r fetch -q origin
  echo AUTONOMY=on > r/factory/policy.env
  expect_eq "$(autonomy "$TEST_TMP/r")" off "the checkout cannot turn it on"
  git -C r commit -qam on; expect_eq "$(autonomy "$TEST_TMP/r")" off "nor a local commit"
  git -C r push -q origin main && git -C r fetch -q origin
  expect_eq "$(autonomy "$TEST_TMP/r")" on "main says on"
}

test_policy_sh_prints_autonomy() {
  mkrepo r && mkdir -p r/factory && echo AUTONOMY=on > r/factory/policy.env && cd r
  run "$SCRIPTS/policy.sh" autonomy; expect_rc 0; expect_eq "$(cat "$OUT")" on
  run "$SCRIPTS/policy.sh" autonomy extra; expect_rc 2; expect_err "usage: policy.sh rigor|autonomy"
  mkdir "$TEST_TMP/plain" && cd "$TEST_TMP/plain"; run "$SCRIPTS/policy.sh" autonomy; expect_rc 0; expect_eq "$(cat "$OUT")" off "outside a repository"
}

run_tests
