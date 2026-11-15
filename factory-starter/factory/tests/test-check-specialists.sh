# Tests for factory/scripts/check-specialists.sh, the CI check that a work item carries the
# specialists' reports its tier, team and paths need, each saying VERDICT: pass. Each test builds a
# base branch with a roster and a pull-request branch on top.
. "$(dirname "$0")/lib.sh"
S="$SCRIPTS/check-specialists.sh"

setup() {
  mkrepo r && cd r
  mkdir -p factory server web
  cat > factory/teams.json <<'JSON'
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*"] },
             "backend":  { "owns": ["server/*", "db/*"] },
             "frontend": { "owns": ["web/*"], "ui_review": true },
             "research": { "owns": ["research/*"], "active": false } } }
JSON
  echo base > server/a.js; echo base > web/a.js
  git add -A && git commit -qm base
  git switch -q -c work/12-share
}
item() {  # item <folder> <team-line or "">: a work folder with a spec
  mkdir -p "work/$1"
  { echo '---'; echo 'id: 12'; [ -n "$2" ] && echo "$2"; echo 'risk_floor: R1'; echo '---'; } > "work/$1/spec.md"
}
says() { printf 'VERDICT: %s\nRISK: R1\nBLOCKING:\n- none\n' "$3" > "work/$1/$2"; }   # says <folder> <report> <verdict>
commit() { git add -A && git commit -qm change; }
roster() { jq "$1" factory/teams.json > t && mv t factory/teams.json; }   # roster <jq filter>, on main

test_single_team_mode_has_nothing_to_check() {
  mkrepo r && cd r && git switch -q -c work/1-x && item 1-x "" && echo x > a.js && commit
  run "$S" main R2; expect_rc 0; expect_err "single-team mode"
  run "$S" --needs main R2; expect_rc 0; expect_eq "$(cat "$OUT")" review.md "single-team /work reviews every item"
}

test_pull_request_without_work_folder_is_exempt() {
  setup; mkdir -p .claude; echo x > .claude/settings.json; commit
  run "$S" main R2; expect_rc 0; expect_out "exempt"
  setup; mkdir -p planning/c001-x; echo b > planning/c001-x/BRIEF.md; commit
  run "$S" main R2; expect_rc 0; expect_out "exempt"
  run "$S" --needs main R2; expect_rc 1; expect_err "no work folder"
}

test_more_than_one_work_folder_fails() {
  setup; item 12-share "team: backend"; item 13-more "team: backend"; says 12-share review.md pass; says 13-more review.md pass; commit
  run "$S" main R1; expect_rc 1; expect_err "exactly one work folder; this one has 2"
}

test_every_item_needs_a_passing_review() {
  setup; item 12-share "team: backend"; echo x >> server/a.js; commit
  run "$S" main R1; expect_rc 1; expect_out "MISSING      review.md  (every item)"
  says 12-share review.md changes-required; commit
  run "$S" main R1; expect_rc 1; expect_out "NOT PASSING  review.md  (VERDICT: changes-required; every item)"
  says 12-share review.md pass; commit
  run "$S" main R1; expect_rc 0; expect_out "ok           review.md"; expect_out "specialists: ok"
  [ "$(grep -c '^  ' "$OUT")" = 1 ] || fail "an R1 backend item needs review.md only: $(cat "$OUT")"
}

test_r2_needs_a_passing_security_report() {
  setup; item 12-share "team: backend"; says 12-share review.md pass; echo x >> server/a.js; commit
  run "$S" main R2; expect_rc 1; expect_out "MISSING      security.md  (tier R2)"
  says 12-share security.md changes-required; commit
  run "$S" main R2; expect_rc 1; expect_out "NOT PASSING  security.md  (VERDICT: changes-required; tier R2)"
  says 12-share security.md escalate; commit
  run "$S" main R3; expect_rc 1; expect_out "(VERDICT: escalate; tier R3)"
  says 12-share security.md pass; commit
  run "$S" main R2; expect_rc 0
  run "$S" main R1; expect_rc 0; [ "$(grep -c security "$OUT")" = 0 ] || fail "R1 needs no security report"
}

test_ui_review_team_needs_both_reviews() {
  setup; item 12-share "team: frontend"; echo x >> web/a.js; says 12-share review.md pass; commit
  run "$S" main R1; expect_rc 1; expect_out "MISSING      ui-review.md  (team frontend has ui_review)"
  says 12-share ui-review.md pass; says 12-share review.md changes-required; commit
  run "$S" main R1; expect_rc 1; expect_out "NOT PASSING  review.md"; expect_out "ok           ui-review.md"
  says 12-share ui-review.md changes-required; says 12-share review.md pass; commit
  run "$S" main R1; expect_rc 1; expect_out "NOT PASSING  ui-review.md"
  says 12-share ui-review.md pass; commit
  run "$S" main R1; expect_rc 0
  # A team without ui_review needs no ui-review.md.
  setup; item 12-share "team: backend"; says 12-share review.md pass; echo x >> server/a.js; commit
  run "$S" main R1; expect_rc 0; [ "$(grep -c ui-review "$OUT")" = 0 ] || fail "backend has no ui_review"
}

test_db_path_change_needs_db_review() {
  local p
  for p in db/schema.sql server/migrations/001_add.sql server/user_schema.ts DB/Seed.SQL; do
    setup; item 12-share "team: backend"; says 12-share review.md pass; mkdir -p "$(dirname "$p")"; echo x > "$p"; commit
    run "$S" main R1; expect_rc 1; expect_out "MISSING      db-review.md  (a db path changed: $p)"
    says 12-share db-review.md pass; commit
    run "$S" main R1; expect_rc 0
  done
  setup; item 12-share "team: backend"; says 12-share review.md pass; git rm -q server/a.js; mkdir -p db; echo x > db/new.sql; commit
  run "$S" main R1; expect_rc 1; expect_out "db-review.md"
}

test_db_paths_come_from_the_roster() {
  setup; git switch -q main; roster '.db_paths = ["sql/*"]'; git commit -qam db; git switch -q -c work/13-x
  item 13-x "team: backend"; says 13-x review.md pass; mkdir -p db; echo x > db/schema.sql; commit
  run "$S" main R1; expect_rc 0; [ "$(grep -c db-review "$OUT")" = 0 ] || fail "db/ is not a db path in this roster"
  mkdir -p sql; echo x > sql/a.sql; commit
  run "$S" main R1; expect_rc 1; expect_out "a db path changed: sql/a.sql"
  setup; git switch -q main; roster '.db_paths = []'; git commit -qam db; git switch -q -c work/13-x
  item 13-x "team: backend"; says 13-x review.md pass; mkdir -p db; echo x > db/schema.sql; commit
  run "$S" main R1; expect_rc 0
  # A garbled db_paths falls back to the default, and says so.
  for bad in '"db/*"' '[1, 2]' '{"a": "b"}' 'null'; do
    setup; git switch -q main; roster ".db_paths = $bad"; git commit -qam db; git switch -q -c work/13-x
    item 13-x "team: backend"; says 13-x review.md pass; mkdir -p db; echo x > db/a.sql; commit
    run "$S" main R1; expect_rc 1; expect_out "MISSING      db-review.md"; expect_err "not a list of globs"
  done
}

test_needs_lists_the_reports() {
  setup; item 12-share "team: frontend"; echo x >> web/a.js; mkdir -p db; echo x > db/schema.sql; commit
  run "$S" --needs main R2; expect_rc 0
  expect_eq "$(cat "$OUT" | tr '\n' ' ')" "review.md ui-review.md security.md db-review.md "
  run "$S" --needs main R1; expect_eq "$(cat "$OUT" | tr '\n' ' ')" "review.md ui-review.md db-review.md "
  # It reads the working tree: an uncommitted spec, change and new file count.
  setup; echo x >> server/a.js; item 12-share "team: backend"
  run "$S" --needs main R1; expect_rc 0; expect_eq "$(cat "$OUT")" review.md
  mkdir -p server/migrations; echo x > server/migrations/1.sql
  run "$S" --needs main R0; expect_eq "$(cat "$OUT" | tr '\n' ' ')" "review.md db-review.md "
  # Run from a subfolder, the paths are still the repository's.
  cd server && run "$S" --needs main R0 && cd ..; expect_eq "$(cat "$OUT" | tr '\n' ' ')" "review.md db-review.md "
}

test_roster_comes_from_base_not_the_pull_request() {
  setup; item 12-share "team: frontend"; says 12-share review.md pass; echo x >> web/a.js
  roster '.teams.frontend.ui_review = false | .db_paths = []'; mkdir -p db; echo x > db/schema.sql; commit
  run "$S" main R1; expect_rc 1; expect_out "MISSING      ui-review.md"; expect_out "MISSING      db-review.md"
  jq 'del(.db_paths)' factory/teams.json > "$TEST_TMP/t.json"
  TEAMS_FILE="$TEST_TMP/t.json" run "$S" main R1; expect_rc 1
  [ "$(grep -c ui-review "$OUT")" = 0 ] || fail "TEAMS_FILE is the roster when set"
}

test_team_comes_from_the_spec_not_the_session() {
  setup; item 12-share "team: frontend"; says 12-share review.md pass; echo x >> web/a.js; commit
  FACTORY_TEAM=backend run "$S" main R1; expect_rc 1; expect_out "MISSING      ui-review.md"
  setup; item 12-share ""; says 12-share review.md pass; echo x >> server/a.js; commit
  FACTORY_TEAM=frontend run "$S" main R1; expect_rc 0; expect_out "team backend"   # default_team
}

test_spec_problems_fail_closed() {
  setup; mkdir -p work/12-share; says 12-share review.md pass; commit
  run "$S" main R1; expect_rc 1; expect_err "no spec.md"
  item 12-share "team: marketing"; commit
  run "$S" main R1; expect_rc 1; expect_err "not an active team"
  item 12-share "team: research"; commit
  run "$S" main R1; expect_rc 1; expect_err "not an active team"
  item 12-share 'team: $(touch pwned)'; commit
  run "$S" main R1; expect_rc 1; [ ! -e pwned ] || fail "a team value was executed"
  item 12-share $'team: frontend\r'; commit
  run "$S" main R1; expect_rc 1                     # CRLF: no such team, not a quiet pass
}

test_only_exactly_pass_passes() {
  local v
  for v in passed PASS Pass 'pass-ish' 'pa' '$(touch pwned)' ''; do
    setup; item 12-share "team: backend"; echo x >> server/a.js; printf 'VERDICT: %s\nRISK: R1\n' "$v" > work/12-share/review.md; commit
    run "$S" main R1; [ "$RC" = 1 ] || fail "VERDICT [$v] passed"
  done
  expect_out "(VERDICT: none found; every item)"
  [ ! -e pwned ] || fail "a verdict was executed"
  setup; item 12-share "team: backend"; echo x >> server/a.js
  printf 'VERDICT: changes-required\nVERDICT: pass\n' > work/12-share/review.md; commit
  run "$S" main R1; expect_rc 1; expect_out "(VERDICT: changes-required"
  printf 'Summary.\nVERDICT:\tpass   \r\nRISK: R1\r\n' > work/12-share/review.md; commit
  run "$S" main R1; expect_rc 0
  for v in 'pass | changes-required | escalate' 'pass   (all criteria met)' 'pass, mostly' 'pass changes-required'; do
    printf 'VERDICT: %s\nVERDICT: pass\nRISK: R1\n' "$v" > work/12-share/review.md; commit
    run "$S" main R1; [ "$RC" = 1 ] || fail "VERDICT [$v] passed"
  done
  printf 'VERDICT: pa' > work/12-share/review.md; commit
  run "$S" main R1; expect_rc 1; expect_out "(VERDICT: pa;"
}

test_hostile_report_files() {
  setup; item 12-share "team: backend"; echo x >> server/a.js
  echo 'VERDICT: pass' > pass.txt; ln -s ../../pass.txt work/12-share/review.md; commit
  run "$S" main R1; expect_rc 1; expect_out "NOT PASSING  review.md"          # a link is not its target
  git rm -q work/12-share/review.md; mkdir -p work/12-share/review.md; echo 'VERDICT: pass' > work/12-share/review.md/x; commit
  run "$S" main R1; expect_rc 1; expect_out "MISSING      review.md"
  git rm -rq work/12-share/review.md; { head -c 1048576 /dev/zero | tr '\0' 'z'; echo; echo 'VERDICT: pass'; } > work/12-share/review.md; commit
  run "$S" main R1; expect_rc 0
  # The report must be committed: an uncommitted pass does not count in CI.
  says 12-share review.md changes-required; commit; says 12-share review.md pass
  run "$S" main R1; expect_rc 1
}

test_hostile_folder_names() {
  setup; item $'12-new\nline $(touch pwned)' "team: backend"; says $'12-new\nline $(touch pwned)' review.md pass; echo x >> server/a.js; commit
  run "$S" main R1; expect_rc 0; expect_out 'work/12-newline $(touch pwned), team backend'
  [ ! -e pwned ] || fail "a folder name was executed"
}

test_roster_problems() {
  setup; item 12-share "team: backend"; says 12-share review.md pass; commit
  printf '{"teams": {"backend": {"ow' > "$TEST_TMP/cut.json"
  TEAMS_FILE="$TEST_TMP/cut.json" run "$S" main R1; expect_rc 1; expect_err "unreadable"
  printf '{"teams": []}' > "$TEST_TMP/list.json"
  TEAMS_FILE="$TEST_TMP/list.json" run "$S" main R1; expect_rc 1; expect_err "unreadable"
  perl -pe 's/\n/\r\n/' factory/teams.json > "$TEST_TMP/crlf.json"
  TEAMS_FILE="$TEST_TMP/crlf.json" run "$S" main R1; expect_rc 0
  TEAMS_FILE="$TEST_TMP/none.json" run "$S" main R1; expect_rc 1; expect_err "unreadable"
  cd server && TEAMS_FILE=../factory/teams.json run "$S" main R1; expect_rc 0   # relative to where it runs
}

test_usage_and_environment_errors_exit_2() {
  setup; item 12-share "team: backend"; commit
  for a in "main" "main R4" "main r2" "main R2 extra" "--needs main" "--needs" "" "--other main R1"; do
    run "$S" $a; [ "$RC" = 2 ] || fail "args [$a] gave exit $RC, expected 2"
  done
  run "$S" no-such-ref R1; expect_rc 2; expect_err "unknown base ref"
  run env PATH="$(path_without jq)" bash "$S" main R1; expect_rc 2; expect_err "jq"
}

test_runs_from_a_ci_copy() {
  setup; item 12-share "team: backend"; says 12-share review.md pass; echo x >> server/a.js; commit
  mkdir "$TEST_TMP/ci"; for f in check-specialists.sh lib.sh; do cat "$SCRIPTS/$f" > "$TEST_TMP/ci/$f"; done
  run bash "$TEST_TMP/ci/check-specialists.sh" main R1; expect_rc 0
  run bash "$TEST_TMP/ci/check-specialists.sh" main R2; expect_rc 1; expect_out "MISSING      security.md"
}

run_tests
