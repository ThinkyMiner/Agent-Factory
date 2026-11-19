# Tests for factory/scripts/integrate.sh: the e2e gate between feature/<f> and main. Real git repos
# with a bare origin, the fake gh on PATH, and a product whose `make e2e` passes once
# server/share.txt says links expire after 7 days.
. "$(dirname "$0")/lib.sh"
I="$SCRIPTS/integrate.sh"
F=f001-share-links; C=c001-share-links
ZWSP=$(printf '\xe2\x80\x8b')

acc() {
  cat <<'EOF'
# Acceptance: f001-share-links

## AC1: A shared link opens the note read-only
- decisions: c001-D01
- check: Open a share link signed out; the note shows and has no edit control.

## AC2: A link expires after 7 days
- decisions: c001-D02
- check: Open a link made 8 days ago; it answers 410.
EOF
}
# integ_setup: approved cycle c001 on main, feature/f001-share-links dispatched with research's
# acceptance.md on it. The product's e2e runs every tests/e2e/*/*.sh.
integ_setup() {
  planning_setup
  cd "$MAIN"
  mkdir -p "planning/$C" server
  decisions_ok c001 > "planning/$C/DECISIONS.md"
  printf 'e2e:\n\t@sh e2e.sh\n' > Makefile
  cat > e2e.sh <<'SH'
rc=0
for t in tests/e2e/*/*.sh; do [ -f "$t" ] || continue; sh "$t" || rc=1; done
[ -z "${E2E_SLEEP:-}" ] || { echo $$ > "$E2E_PIDFILE"; exec sleep "$E2E_SLEEP"; }
exit $rc
SH
  echo "links never expire" > server/share.txt
  git add -A && git commit -qm "c001 approved" && git push -q origin main
  git switch -q -c "feature/$F"
  printf '%s\n' '{"cycle":"c001-share-links","item":"share-api","team":"backend","delivers":"POST /shares"}' \
    '{"cycle":"c001-share-links","item":"share-button","team":"frontend","delivers":"a Share button"}' > "planning/$C/dispatch.jsonl"
  mkdir -p "features/$F" && acc > "features/$F/acceptance.md"
  git add -A && git commit -qm "dispatch $C" && git push -q -u origin "feature/$F" && git switch -q main
}
orch() { by orchestrator "$I" "$@"; }
branch() { git -C "$MAIN" rev-parse --abbrev-ref HEAD; }
on_main() { expect_eq "$(branch)" main "the main checkout's branch"; }
origin_has() { git -C "$TEST_TMP/origin.git" cat-file -e "$1" 2>/dev/null; }
show() { git -C "$TEST_TMP/origin.git" show "integrate/$F:$1"; }
report_line() { show "features/$F/e2e-report.md" | sed -n "${1}p"; }
gh_log() { cat "$FAKE_GH/log" 2>/dev/null || true; }
created() { gh_log | grep '^issue create' || true; }
events() { grep "\"type\":\"$1\"" "$MAIN/.factory/events.jsonl" 2>/dev/null || true; }
# qa_writes: what integration-qa writes, black-box through the product's files
qa_writes() {
  mkdir -p "$MAIN/tests/e2e/$F"
  echo 'echo "ok AC1: a shared link opens the note read-only"' > "$MAIN/tests/e2e/$F/ac1.sh"
  cat > "$MAIN/tests/e2e/$F/ac2.sh" <<'SH'
if grep -q "expire after 7 days" server/share.txt; then echo "ok AC2: a link expires after 7 days"
else echo "FAIL AC2: a link expires after 7 days: server/share.txt says $(cat server/share.txt)"; exit 1; fi
SH
}
saved_tests() {
  orch tests "$F"; expect_rc 0
  qa_writes
  orch save "$F" --message "e2e tests for AC1 and AC2"; expect_rc 0
}
ATT_OK="- test: AC2: a link expires after 7 days | criterion: AC2 | decision: c001-D02 | contract: contracts/api.openapi.yaml#/paths/~1shares | team: backend | evidence: server/share.txt says links never expire (report line \"FAIL AC2\")"
# attribute <lines...>: integration-qa's attribution.md for round 1, saved
attribute() {
  orch tests "$F"; expect_rc 0
  printf '# Attribution: %s\nround: 1\n' "$F" > "$MAIN/features/$F/attribution.md"
  printf '%s\n' "$@" >> "$MAIN/features/$F/attribution.md"
  orch save "$F" --message "attribution, round 1"; expect_rc 0
}
# push_to <team> <branch> <file> <content>: that team's change lands on origin (a merged pull request);
# "human" pushes from a clone of its own, so the main checkout stays where it is
push_to() {
  local d; case "$1" in backend) d=$BE ;; frontend) d=$FE ;; research) d=$RE ;; *) d=$TEST_TMP/human ;; esac
  [ -d "$d" ] || git clone -q "$TEST_TMP/origin.git" "$d"
  git -C "$d" fetch -q origin && git -C "$d" switch -q -C "land-$RANDOM" "origin/$2"
  mkdir -p "$d/$(dirname "$3")" && printf '%s\n' "$4" > "$d/$3"
  git -C "$d" add -A && git -C "$d" commit -qm "change $3" && git -C "$d" push -q origin "HEAD:$2"
}
fix_lands() { push_to backend "feature/$F" server/share.txt "links expire after 7 days"; }
review() {  # review <verdict> [e2e-commit]: research's acceptance review lands on feature/<f>
  local c=${2:-$(report_line 4 | sed 's/^commit: //')}
  push_to research "feature/$F" "features/$F/acceptance-review.md" "$(printf '# Acceptance review: %s\nVERDICT: %s\ne2e-commit: %s\n- AC1: met | ok AC1 in the report\n- AC2: met | ok AC2 in the report' "$F" "$1" "$c")"
}
ticket_in_gh() {  # ticket_in_gh <n> <labels...>: an issue in the fake gh's repository
  local n=$1; shift
  [ -f "$FAKE_GH/issues.json" ] || echo '[]' > "$FAKE_GH/issues.json"
  jq --argjson n "$n" --arg ls "$*" '. + [{number: $n, title: "t", body: "b", state: "OPEN", comments: [],
    labels: ($ls | split(" ") | map({name: .}))}]' "$FAKE_GH/issues.json" > "$FAKE_GH/i.new" && mv "$FAKE_GH/i.new" "$FAKE_GH/issues.json"
}

test_scenario_a_seeded_failure_is_ticketed_and_fixed_in_round_two() {
  integ_setup
  by backend "$I" ready "$F"; expect_rc 1
  saved_tests; on_main
  by backend "$I" ready "$F"; expect_rc 0
  # round 1: the seeded failure, owned by backend
  orch run "$F"; expect_rc 1; on_main
  expect_out "round 1: e2e fail"; expect_out "integration-qa attributes"
  expect_eq "$(report_line 2) $(report_line 3)" "E2E: fail round: 1"
  show "features/$F/e2e-report.md" | grep -qF "    FAIL AC2: a link expires after 7 days" || fail "the report lacks the failing test"
  attribute "$ATT_OK"
  orch tickets "$F"; expect_rc 0
  expect_eq "$(created | wc -l | tr -d ' ')" 1 "tickets filed"
  t=$(created)
  for want in "--label to:backend" "--label type:bug" "--label from:orchestrator" "--label feature:$F"; do
    case "$t" in *"$want"*) ;; *) fail "the ticket lacks $want: $t" ;; esac
  done
  body=$(jq -r '.[0].body' "$FAKE_GH/issues.json")
  for want in '"decision":"c001-D02"' "AC2: a link expires after 7 days" "features/$F/attribution.md" "integrate/$F" "integration round 2"; do
    printf '%s' "$body" | grep -qF -- "$want" || fail "the ticket body lacks [$want]"
  done
  expect_eq "$(events integration | jq -r '[.step, .status, .round] | join(" ")' | tr '\n' ',')" "e2e fail 1,tickets filed 1,"
  # backend's fix lands on the feature branch; round 2 passes
  fix_lands
  orch run "$F"; expect_rc 0; on_main
  expect_out "round 2: e2e pass"
  expect_eq "$(report_line 2) $(report_line 3)" "E2E: pass round: 2"
  commit=$(report_line 4 | sed 's/^commit: //')
  expect_eq "$commit" "$(git -C "$TEST_TMP/origin.git" rev-parse "integrate/$F^")" "the tested commit"
  expect_eq "$(created | wc -l | tr -d ' ')" 2 "tickets filed"
  t=$(created | tail -1)
  for want in "--label to:research" "--label type:request" "--label feature:$F"; do
    case "$t" in *"$want"*) ;; *) fail "the review request lacks $want: $t" ;; esac
  done
  jq -r '.[1].body' "$FAKE_GH/issues.json" | grep -qF "e2e-commit: $commit" || fail "the review request does not name the commit"
  show "features/$F/FEATURE.md" | grep -qF "pass, round 2, commit $commit" || fail "FEATURE.md was not rendered"
}

test_scenario_two_failed_rounds_then_a_third_escalates() {
  integ_setup; saved_tests
  orch run "$F"; expect_rc 1
  orch run "$F"; expect_rc 3; on_main
  expect_out "STOP: the e2e tests of $F failed in two integration rounds (latest: round 2)"
  expect_eq "$(report_line 2) $(report_line 3)" "E2E: fail round: 2"
  expect_eq "$(events escalation | wc -l | tr -d ' ')" 1
  head=$(git -C "$TEST_TMP/origin.git" rev-parse "integrate/$F")
  orch run "$F"; expect_rc 3; on_main; expect_out "Tell the human"
  expect_eq "$(git -C "$TEST_TMP/origin.git" rev-parse "integrate/$F")" "$head" "a third round changed integrate/$F"
  ev=$(events escalation | tail -1)
  expect_eq "$(jq -r .reason <<<"$ev")" "integration failed twice"
  jq -r .refs <<<"$ev" | grep -qF "$F" || fail "the escalation does not name the feature"
  jq -r .refs <<<"$ev" | grep -qF "features/$F/e2e-report.md" || fail "the escalation does not name the report"
  expect_eq "$(events escalation | wc -l | tr -d ' ')" 2
  # a fix does not reopen it: the human decides
  fix_lands; orch run "$F"; expect_rc 3
}

test_only_the_orchestrator_integrates() {
  integ_setup
  for c in tests save run tickets pr close drop sync; do
    by backend "$I" "$c" "$F"; expect_rc 1; expect_err "only the orchestrator integrates"
    cd "$BE"; FACTORY_TEAM=orchestrator run "$I" "$c" "$F"; expect_rc 1; expect_err "this session has no team (FACTORY_TEAM=orchestrator"
    cd "$MAIN"; FACTORY_TEAM=backend run "$I" "$c" "$F"; expect_rc 1; expect_err "this session has no team"
    cd "$MAIN"; FACTORY_TEAM= run "$I" "$c" "$F"; expect_rc 1; expect_err "this session has no team"
  done
  on_main
  [ -z "$(gh_log)" ] || fail "a refused session reached GitHub: $(gh_log)"
  cd "$BE"; FACTORY_TEAM=orchestrator run "$I" ready "$F"; expect_rc 1; expect_out "not written yet"
}

test_feature_ids_are_validated_before_use() {
  integ_setup
  for x in '' F001-share 'f01-x' '../f001-x' 'f001-x/../../etc' 'f001-x;touch pwned' 'f001-$(touch pwned)' \
           'f001-`touch pwned`' "$(printf 'f001-x\nf002-y')" '-f001-x' 'f001-' "f001-$(head -c 60 /dev/zero | tr '\0' a)"; do
    for c in tests run ready sync; do orch "$c" "$x"; expect_rc 1; expect_err "usage: integrate.sh $c <feature>"; done
  done
  orch frobnicate "$F"; expect_rc 1
  [ ! -e "$MAIN/pwned" ] && [ ! -e pwned ] || fail "a feature id was executed"
}

test_refuses_while_planning_is_open_or_the_checkout_is_dirty() {
  integ_setup
  mkdir -p "$MAIN/.factory/planning" && echo c002-next > "$MAIN/.factory/planning/active"
  orch tests "$F"; expect_rc 1; expect_err "planning cycle c002-next is open"
  rm "$MAIN/.factory/planning/active"
  echo dirt > "$MAIN/server/dirt.txt"
  for c in tests run tickets pr close drop; do orch "$c" "$F"; expect_rc 1; expect_err "uncommitted changes"; done
  rm "$MAIN/server/dirt.txt"
  orch tests f002-other; expect_rc 1; expect_err "feature/f002-other is not on origin"
  on_main
}

test_tests_needs_valid_criteria_on_the_feature_branch() {
  integ_setup
  push_to research "feature/$F" "features/$F/acceptance.md" "$(acc | sed 's/c001-D02/c001-D09/')"
  orch tests "$F"; expect_rc 1; expect_err "c001-D09 is not a record"; expect_err "goes back to research"; on_main
  git -C "$RE" rm -q "features/$F/acceptance.md" && git -C "$RE" commit -qm rm && git -C "$RE" push -q origin "HEAD:feature/$F"
  orch tests "$F"; expect_rc 1; expect_err "features/$F/acceptance.md is not on feature/$F yet"; on_main
  push_to research "feature/$F" "features/$F/acceptance.md" "$(acc)"
  orch tests "$F"; expect_rc 0
  expect_out "$MAIN/features/$F/acceptance.md"; expect_out "integration-qa writes only in $MAIN/tests/e2e/$F/"
  expect_eq "$(branch)" "integrate/$F" "tests leaves the checkout for integration-qa"
}

test_save_commits_only_what_integration_qa_may_write() {
  integ_setup
  orch tests "$F"; expect_rc 0; qa_writes
  echo "links expire after 7 days" > "$MAIN/server/share.txt"; echo x > "$MAIN/notes.md"
  orch save "$F" --message "tests"; expect_rc 1; expect_err "server/share.txt"; expect_err "notes.md"
  expect_eq "$(branch)" "integrate/$F" "a refused save keeps integration-qa's work where it is"
  origin_has "integrate/$F" && fail "a refused save pushed"
  git -C "$MAIN" checkout -q -- server/share.txt && rm "$MAIN/notes.md"
  orch save "$F" --message; expect_rc 1; expect_err "--message needs a value"
  orch save "$F" --message "   "; expect_rc 1; expect_err "save needs --message"
  orch save "$F" --message "tests for AC1, AC2"$'\n\n''$(touch pwned) `touch pwned` @someone'; expect_rc 0; on_main
  expect_eq "$(git -C "$TEST_TMP/origin.git" log -1 --format=%B "integrate/$F" | grep -vx 'Factory-Stage: integrate-save' | grep -c .)" 1 "lines in the commit message"
  expect_eq "$(git -C "$TEST_TMP/origin.git" log -1 --format='%(trailers:key=Factory-Stage,valueonly)' "integrate/$F" | grep .)" integrate-save "the save trailer"
  expect_eq "$(git -C "$TEST_TMP/origin.git" diff --name-only "feature/$F" "integrate/$F" | tr '\n' ' ')" "tests/e2e/$F/ac1.sh tests/e2e/$F/ac2.sh "
  git -C "$TEST_TMP/origin.git" log -1 --format=%s "integrate/$F" | grep -qF "@${ZWSP}someone" || fail "the commit message was not cleaned"
  [ ! -e "$MAIN/pwned" ] || fail "the message was executed"
  orch save "$F" --message again; expect_rc 1; expect_err "not on integrate/$F: run integrate.sh tests $F first"
  orch tests "$F"; orch save "$F" --message nothing; expect_rc 1; expect_err "nothing to save"
}

test_saved_tests_are_locked_unless_a_declined_ticket_disputes_them() {
  integ_setup; saved_tests
  orch tests "$F"; expect_rc 0
  echo 'echo "ok AC2: changed to match the product"' > "$MAIN/tests/e2e/$F/ac2.sh"
  orch save "$F" --message weaken; expect_rc 1; expect_err "the e2e tests are locked"; expect_err "tests/e2e/$F/ac2.sh"
  git -C "$MAIN" checkout -q -- "tests/e2e/$F/ac2.sh"; rm "$MAIN/tests/e2e/$F/ac1.sh"
  orch save "$F" --message delete; expect_rc 1; expect_err "tests/e2e/$F/ac1.sh"
  git -C "$MAIN" checkout -q -- "tests/e2e/$F/ac1.sh"
  # a test committed locally first is still a change to a saved test
  echo 'exit 0' > "$MAIN/tests/e2e/$F/ac2.sh"; git -C "$MAIN" commit -qam sneak
  echo 'echo ok AC1: more' > "$MAIN/tests/e2e/$F/ac3.sh"
  orch save "$F" --message sneak; expect_rc 1; expect_err "commits of its own"
  git -C "$MAIN" reset -q --soft "origin/integrate/$F" && git -C "$MAIN" reset -q && git -C "$MAIN" checkout -q -- "tests/e2e/$F/ac2.sh"
  orch save "$F" --message "add a test"; expect_rc 0; on_main
  origin_has "integrate/$F:tests/e2e/$F/ac3.sh" || fail "a new test was not saved"
  # disputes: only an open, declined bug ticket from orchestrator for this feature unlocks
  ticket_in_gh 1 ticket from:orchestrator to:backend type:bug "feature:$F" state:declined
  ticket_in_gh 2 ticket from:orchestrator to:backend type:bug "feature:$F" state:open
  ticket_in_gh 3 ticket from:orchestrator to:backend type:bug feature:f002-other state:declined
  ticket_in_gh 4 ticket from:frontend to:backend type:bug "feature:$F" state:declined
  ticket_in_gh 5 ticket from:orchestrator to:backend type:request "feature:$F" state:declined
  ticket_in_gh 6 from:orchestrator to:backend type:bug "feature:$F" state:declined
  jq '. + [{number: 7, title: "t", body: "b", state: "CLOSED", comments: [], labels: ([ "ticket", "from:orchestrator", "to:backend", "type:bug", "feature:f001-share-links", "state:declined"] | map({name: .}))}]' \
    "$FAKE_GH/issues.json" > "$FAKE_GH/i.new" && mv "$FAKE_GH/i.new" "$FAKE_GH/issues.json"
  orch tests "$F"; echo 'echo "ok AC2: the criterion read again"' > "$MAIN/tests/e2e/$F/ac2.sh"
  for n in 2 3 4 5 6 7 99; do orch save "$F" --message fix --dispute "$n"; expect_rc 1; done
  for n in 'x' '1;touch pwned' '$(touch pwned)' 0 -1; do orch save "$F" --message fix --dispute "$n"; expect_rc 1; expect_err "--dispute takes the number"; done
  [ ! -e "$MAIN/pwned" ] || fail "a dispute number was executed"
  orch save "$F" --message "AC2 test fixed after dispute" --dispute 1; expect_rc 0; on_main; expect_out "under dispute #1"
  show "tests/e2e/$F/ac2.sh" | grep -qF "the criterion read again" || fail "the disputed test was not saved"
}

test_save_and_tests_refuse_symbolic_links() {
  integ_setup
  mkdir -p "$TEST_TMP/outside" && echo keep > "$TEST_TMP/outside/file"
  orch tests "$F"; expect_rc 0
  rmdir "$MAIN/tests/e2e/$F" && ln -s "$TEST_TMP/outside" "$MAIN/tests/e2e/$F"
  orch save "$F" --message link; expect_rc 1; expect_err "tests/e2e/$F is a symbolic link"
  rm "$MAIN/tests/e2e/$F"; mkdir "$MAIN/tests/e2e/$F"; qa_writes; ln -s /etc/passwd "$MAIN/tests/e2e/$F/ac3.sh"
  orch save "$F" --message link; expect_rc 1; expect_err "tests/e2e/$F/ac3.sh is a symbolic link"
  rm "$MAIN/tests/e2e/$F/ac3.sh"
  ln -s "$TEST_TMP/outside" "$MAIN/features/$F/attribution.md"
  orch save "$F" --message link; expect_rc 1; expect_err "features/$F/attribution.md is a symbolic link"
  rm "$MAIN/features/$F/attribution.md"
  orch save "$F" --message ok; expect_rc 0
  expect_eq "$(cat "$TEST_TMP/outside/file")" keep
  # a symbolic link committed on integrate/<f> itself
  git -C "$MAIN" switch -q -c sneaky "origin/integrate/$F" && git -C "$MAIN" rm -rq "tests/e2e/$F"
  mkdir -p "$MAIN/tests/e2e" && ln -s "$TEST_TMP/outside" "$MAIN/tests/e2e/$F" && git -C "$MAIN" add -A && git -C "$MAIN" commit -qm link
  git -C "$MAIN" push -q -f origin "HEAD:integrate/$F" && git -C "$MAIN" switch -q main
  orch tests "$F"; expect_rc 1; expect_err "is a symbolic link"; on_main
  by backend "$I" ready "$F"; expect_rc 1
  orch run "$F"; expect_rc 1; expect_err "write the e2e tests first"
}

test_the_first_save_rings_the_feature_teams() {
  integ_setup
  mkdir -p "$TEST_TMP/hd"
  jq -n '{spaces: [{name: "app", tabs: [{name: "backend", terminals: [{terminal: "t2"}]}, {name: "frontend", terminals: [{terminal: "t3"}]}]}]}' > "$TEST_TMP/hd/layout"
  printf '#!/usr/bin/env bash\n[ "$1" = ls ] && cat "$TEST_TMP/hd/layout"\n' > "$TEST_TMP/hd/herdr-app"
  fake_hc "$TEST_TMP/hd" "$TEST_TMP/hd/hc.log"
  chmod +x "$TEST_TMP/hd/herdr-app" "$TEST_TMP/hd/hc"; PATH="$TEST_TMP/hd:$PATH"
  saved_tests; expect_out "rang backend"; expect_out "rang frontend"
  expect_eq "$(sort "$TEST_TMP/hd/hc.log" | tr '\n' ' ')" "t2|The e2e tests for $F are written; its build items may start: run /inbox. t3|The e2e tests for $F are written; its build items may start: run /inbox. "
  orch tests "$F"; echo 'echo ok AC1: more' > "$MAIN/tests/e2e/$F/ac3.sh"
  orch save "$F" --message more; expect_rc 0
  expect_eq "$(lines "$TEST_TMP/hd/hc.log")" 2 "rings after a later save"
}

test_run_needs_the_tests_first_and_writes_a_fixed_report() {
  integ_setup
  orch run "$F"; expect_rc 1; expect_err "write the e2e tests first: integrate.sh tests $F"
  orch tests "$F"; qa_writes
  printf '%s\n' 'echo "<img src=x onerror=alert(1)> # not a heading @someone"' "printf 'bell\\007 cr\\r end\\n'" \
    "head -c 5000 /dev/zero | tr '\\0' z; echo" > "$MAIN/tests/e2e/$F/noise.sh"
  orch save "$F" --message tests; expect_rc 0
  orch run "$F"; expect_rc 1; on_main
  r=$(show "features/$F/e2e-report.md")
  expect_eq "$(sed -n 1p <<<"$r")" "# E2E report: $F"
  expect_eq "$(sed -n 2,3p <<<"$r" | tr '\n' ' ')" "E2E: fail round: 1 "
  expect_eq "$(sed -n 4p <<<"$r")" "commit: $(git -C "$TEST_TMP/origin.git" rev-parse "integrate/$F^")"
  expect_eq "$(sed -n 5p <<<"$r")" "feature: $(git -C "$TEST_TMP/origin.git" rev-parse "feature/$F")"
  expect_eq "$(sed -n 6p <<<"$r")" "main: $(git -C "$TEST_TMP/origin.git" rev-parse main)"
  expect_eq "$(sed -n 7p <<<"$r")" "exit: 2"
  sed -n 8p <<<"$r" | grep -Eq '^ran: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$' || fail "line 8: $(sed -n 8p <<<"$r")"
  expect_eq "$(sed -n 10p <<<"$r")" "## Output (last 200 lines)"
  [ -z "$(sed -n '11,$p' <<<"$r" | grep -v '^    ')" ] || fail "an output line is not indented: $(sed -n '11,$p' <<<"$r" | grep -v '^    ' | head -2)"
  [ "$(sed -n '11,$p' <<<"$r" | awk '{ if (length > m) m = length } END { print m }')" -le 1004 ] || fail "an output line was not cut"
  printf '%s' "$r" | grep -q "$(printf '\007')\|$(printf '\r')" && fail "a control character reached the report"
  printf '%s' "$r" | grep -qF '    <img src=x' || fail "the output is missing"
  expect_eq "$(git -C "$TEST_TMP/origin.git" diff --name-only "integrate/$F^" "integrate/$F" | tr '\n' ' ')" \
    "features/$F/FEATURE.md features/$F/e2e-report.md features/$F/tickets.jsonl "
  expect_eq "$(events integration | jq -r '[.feature, .step, .status, .round] | join(" ")')" "$F e2e fail 1"
}

test_a_damaged_report_stops_the_count() {
  integ_setup; saved_tests
  orch run "$F"; expect_rc 1
  for bad in 's/^round: 1$/round: one/' 's/^E2E: fail$/E2E: maybe/' '/^round:/d' '1s/.*/# E2E report: f002-other/' 's/^commit: .*/commit: HEAD/'; do
    git -C "$MAIN" switch -q -C sneaky "origin/integrate/$F"
    sed -i.bak "$bad" "$MAIN/features/$F/e2e-report.md" && rm "$MAIN/features/$F/e2e-report.md.bak"
    git -C "$MAIN" commit -qam garble && git -C "$MAIN" push -q -f origin "HEAD:integrate/$F" && git -C "$MAIN" switch -q main
    orch run "$F"; expect_rc 1; expect_err "e2e-report.md on integrate/$F is damaged"
    orch tickets "$F"; expect_rc 1; expect_err "is damaged"
    git -C "$MAIN" push -q -f origin "sneaky^:integrate/$F"
  done
  orch run "$F"; expect_rc 3
}

test_a_rerun_of_the_same_commit_asks_research_once() {
  integ_setup; saved_tests; fix_lands
  orch run "$F"; expect_rc 0
  c=$(report_line 4 | sed 's/^commit: //')
  # the tested commit again, as if its report never landed: the merges are no-ops, so the same commit is tested
  git -C "$TEST_TMP/origin.git" update-ref "refs/heads/integrate/$F" "$c"
  orch run "$F"; expect_rc 0; expect_out "research already has an open acceptance-review ticket for $c"
  expect_eq "$(created | wc -l | tr -d ' ')" 1 "review requests"
}

test_a_symlinked_report_is_never_written_through() {
  integ_setup; saved_tests
  echo keep > "$TEST_TMP/outside"
  git -C "$BE" fetch -q origin && git -C "$BE" switch -q -C sneak "origin/feature/$F"
  ln -s "$TEST_TMP/outside" "$BE/features/$F/e2e-report.md"
  git -C "$BE" add -A && git -C "$BE" commit -qm link && git -C "$BE" push -q origin "HEAD:feature/$F"
  orch run "$F"; expect_rc 1; expect_err "features/$F/e2e-report.md is a symbolic link"; on_main
  expect_eq "$(cat "$TEST_TMP/outside")" keep
}

test_a_merge_conflict_is_ticketed_to_the_owning_team() {
  integ_setup; saved_tests
  push_to backend "feature/$F" server/share.txt "links expire after 7 days"
  push_to backend "feature/$F" README.md "feature readme"
  push_to human main server/share.txt "links expire after 30 days"
  push_to human main README.md "main readme"
  orch run "$F"; expect_rc 4; on_main
  git -C "$MAIN" rev-parse -q --verify MERGE_HEAD >/dev/null && fail "the merge was left in progress"
  expect_out "round 1: merging origin/main into integrate/$F conflicts"
  expect_out "no team owns these conflicting paths; tell the human: README.md"
  expect_eq "$(created | wc -l | tr -d ' ')" 1 "conflict tickets"
  t=$(created)
  for want in "--label to:backend" "--label type:bug" "--label feature:$F"; do case "$t" in *"$want"*) ;; *) fail "lacks $want: $t" ;; esac; done
  jq -r '.[0].body' "$FAKE_GH/issues.json" | grep -qF "server/share.txt" || fail "the ticket does not name the path"
  expect_eq "$(events integration | jq -r '[.step, .status, .round] | join(" ")')" "merge-main conflict 1"
  origin_has "integrate/$F:features/$F/e2e-report.md" && fail "a conflicted round wrote a report"
  orch run "$F"; expect_rc 4; expect_out "backend already has an open bug ticket"
  expect_eq "$(created | wc -l | tr -d ' ')" 1 "conflict tickets after a second run"
}

test_make_e2e_is_killed_after_the_timeout() {
  integ_setup; saved_tests
  t0=$(date +%s)
  cd "$MAIN"; E2E_SLEEP=41 E2E_PIDFILE="$TEST_TMP/e2e.pid" FACTORY_E2E_TIMEOUT=2 FACTORY_TEAM=orchestrator run "$I" run "$F"; expect_rc 1
  [ $(( $(date +%s) - t0 )) -lt 20 ] || fail "the timeout did not stop make e2e"
  expect_eq "$(report_line 7)" "exit: 124"
  show "features/$F/e2e-report.md" | grep -qF "make e2e ran longer than 2 seconds and was killed" || fail "the report does not say it was killed"
  [ -s "$TEST_TMP/e2e.pid" ] || fail "the e2e never started its long step"
  kill -0 "$(cat "$TEST_TMP/e2e.pid")" 2>/dev/null && fail "make e2e's children were left running"
  true
}

test_tickets_refuses_a_bad_attribution_and_files_nothing() {
  integ_setup; saved_tests
  orch tickets "$F"; expect_rc 1; expect_err "no e2e report on integrate/$F yet"
  orch run "$F"; expect_rc 1
  orch tickets "$F"; expect_rc 1; expect_err "attribution.md is not on integrate/$F"
  L="- test: AC2: x | criterion: AC2 | decision: c001-D02 | contract: none"
  attribute "$ATT_OK" \
    "$L | team: backend" \
    "- test: AC9: x | criterion: AC9 | decision: c001-D02 | contract: none | team: backend | evidence: e" \
    "- test: AC2: x | criterion: AC2 | decision: c001-D01 | contract: none | team: backend | evidence: e" \
    "$L | team: research-ish | evidence: e" \
    "$L | team: design | evidence: e" \
    "$L | team: orchestrator | evidence: e" \
    "$L | team: backend | evidence: expected 410 | got 200" \
    "- test: AC2: x | criterion: AC2 | decision: c001-D02 | contract: ../secrets | team: backend | evidence: e" \
    "$L | team: backend | evidence:   " \
    "* test: AC2: x | criterion: AC2 | decision: c001-D02 | contract: none | team: backend | evidence: e" \
    "- test: AC2: x | decision: c001-D02 | criterion: AC2 | contract: none | team: backend | evidence: e" \
    "- test:  | criterion: AC2 | decision: c001-D02 | contract: none | team: backend | evidence: e" \
    "round: 1"
  orch tickets "$F"; expect_rc 1; on_main; expect_err "nothing was filed"
  for want in "attribution.md:4: 5 fields" "attribution.md:5: criterion \"AC9\" is not in acceptance.md" \
              "attribution.md:6: decision \"c001-D01\" is not one that AC2 names" "attribution.md:7: team \"research-ish\" is not an active team" \
              "attribution.md:8: team \"design\"" "attribution.md:9: team \"orchestrator\"" "attribution.md:10: 7 fields" \
              "attribution.md:11: contract must be a path under contracts/" "attribution.md:12: the evidence is empty" \
              "attribution.md:13: not a line of the format" "attribution.md:14: field 2 must start with \"criterion:\"" \
              "attribution.md:15: the test name is empty" "more than one round: line"; do
    expect_err "$want"
  done
  [ -z "$(created)" ] || fail "a ticket was filed from an invalid attribution: $(created)"
}

test_tickets_checks_the_round_and_the_header() {
  integ_setup; saved_tests
  orch run "$F"; expect_rc 1
  orch tests "$F"; printf '# Attribution: %s\nround: 2\n%s\n' "$F" "$ATT_OK" > "$MAIN/features/$F/attribution.md"; orch save "$F" --message a
  orch tickets "$F"; expect_rc 1; expect_err "attribution.md:2: the round must be 1"
  orch tests "$F"; printf '# Attribution: %s\n%s\n' "$F" "$ATT_OK" > "$MAIN/features/$F/attribution.md"; orch save "$F" --message a
  orch tickets "$F"; expect_rc 1; expect_err "no round: line"
  orch tests "$F"; printf '# Attribution: f002-other\nround: 1\n%s\n' "$ATT_OK" > "$MAIN/features/$F/attribution.md"; orch save "$F" --message a
  orch tickets "$F"; expect_rc 1; expect_err "attribution.md:1: the first line must be"
  orch tests "$F"; printf '# Attribution: %s\nround: 1\n\n' "$F" > "$MAIN/features/$F/attribution.md"; orch save "$F" --message a
  orch tickets "$F"; expect_rc 1; expect_err 'no "- test:" line'
  orch tests "$F"; { printf '# Attribution: %s\nround: 1\n' "$F"; head -c 1048576 /dev/zero | tr '\0' a; echo; } > "$MAIN/features/$F/attribution.md"; orch save "$F" --message a
  orch tickets "$F"; expect_rc 1; expect_err "larger than 64 KB"
  orch tests "$F"; { printf '# Attribution: %s\nround: 1\n%s' "$F" "$ATT_OK"; head -c 3000 /dev/zero | tr '\0' a; echo; } > "$MAIN/features/$F/attribution.md"; orch save "$F" --message a
  orch tickets "$F"; expect_rc 1; expect_err "attribution.md:3: longer than 2000 characters"
  [ -z "$(created)" ] || fail "a ticket was filed: $(created)"
}

test_tickets_go_one_per_team_with_hostile_text_neutralised() {
  integ_setup; saved_tests
  orch run "$F"; expect_rc 1
  attribute "$ATT_OK" \
    '- test: AC1: opens $(touch pwned) `touch pwned2` @octocat <b>bold</b> | criterion: AC1 | decision: c001-D01 | contract: none | team: frontend | evidence: the page shows "<script>" and $(id)' \
    "- test: AC2: link answers 410 | criterion: AC2 | decision: c001-D02 | contract: none | team: backend | evidence: got 200"$'\r'
  orch tickets "$F"; expect_rc 0
  expect_eq "$(created | wc -l | tr -d ' ')" 2 "one ticket per team"
  expect_eq "$(jq -r '[.[] | (.labels | map(.name) | map(select(startswith("to:"))) | .[0])] | join(" ")' "$FAKE_GH/issues.json")" "to:backend to:frontend"
  fe=$(jq -r '.[] | select(.labels | map(.name) | index("to:frontend")) | .body' "$FAKE_GH/issues.json")
  printf '%s' "$fe" | grep -qF "@${ZWSP}octocat" || fail "the @mention was not neutralised"
  printf '%s' "$fe" | grep -qF '&lt;b&gt;bold&lt;/b&gt;' || fail "HTML was not escaped"
  printf '%s' "$fe" | grep -qF '"decision":"c001-D01"' || fail "the frontend ticket has the wrong decision"
  printf '%s' "$(jq -r '.[0].body' "$FAKE_GH/issues.json")" | grep -qF "AC2: a link expires after 7 days; AC2: link answers 410" || fail "backend's ticket does not list both tests"
  [ ! -e "$MAIN/pwned" ] && [ ! -e "$MAIN/pwned2" ] || fail "attribution text was executed"
  orch tickets "$F"; expect_rc 0; expect_out "backend already has an open bug ticket"; expect_out "frontend already has an open bug ticket"
  expect_eq "$(created | wc -l | tr -d ' ')" 2 "tickets after a second run"
}

test_pr_refuses_until_e2e_passes_and_research_accepts_that_round() {
  integ_setup; saved_tests
  orch pr "$F"; expect_rc 1; expect_err "no e2e report"
  orch run "$F"; expect_rc 1
  orch pr "$F"; expect_rc 1; expect_err "says fail"; on_main
  fix_lands; orch run "$F"; expect_rc 0
  orch pr "$F"; expect_rc 1; expect_err "acceptance-review.md is not on feature/$F yet"; on_main
  review reject; orch pr "$F"; expect_rc 1; expect_err "does not say VERDICT: accept"
  review "accept | reject"; orch pr "$F"; expect_rc 1; expect_err "does not say VERDICT: accept"
  review accept 0123456789abcdef0123456789abcdef01234567; orch pr "$F"; expect_rc 1; expect_err "not round 2's"
  review accept
  push_to backend "feature/$F" server/extra.txt "a change after the round"
  orch pr "$F"; expect_rc 1; expect_err "code changed since round 2 (server/extra.txt )"; on_main
  [ -z "$(ls "$FAKE_GH/pulls")" ] || fail "a pull request was opened"
}

test_tests_changed_outside_save_stop_the_round() {
  integ_setup; saved_tests
  # integrate/<f> is not protected: a test weakened by a direct push is caught before the round runs
  push_to human "integrate/$F" "tests/e2e/$F/ac2.sh" 'echo "ok AC2: a link expires after 7 days"'
  orch run "$F"; expect_rc 1; expect_err "not as the last integrate.sh save left it"; on_main
  origin_has "integrate/$F:features/$F/e2e-report.md" && fail "a round ran on weakened tests"
  # a forged-looking subject without the trailer does not count as a save
  push_to human "integrate/$F" "tests/e2e/$F/ac3.sh" 'echo ok'
  orch run "$F"; expect_rc 1; expect_err "not as the last integrate.sh save left it"
}

test_tests_arriving_through_a_merge_stop_the_round() {
  integ_setup; saved_tests
  push_to backend "feature/$F" "tests/e2e/$F/ac9.sh" 'echo "ok AC2"'
  orch run "$F"; expect_rc 1; expect_err "changed tests/e2e/$F/, which only integrate.sh save changes"; on_main
  origin_has "integrate/$F:features/$F/e2e-report.md" && fail "a round ran on tests from the feature branch"
  return 0
}

test_records_that_come_with_the_review_are_not_code() {
  integ_setup; saved_tests; fix_lands; orch run "$F"; expect_rc 0
  review accept
  push_to research "feature/$F" "work/9-acceptance-review/spec.md" "team: research"
  push_to research "feature/$F" "memory/observations/9-acceptance-review.md" "observed"
  orch pr "$F"; expect_rc 0; expect_out "opened pull request"
  push_to backend "feature/$F" "workers/x.txt" "not a work folder"
  orch pr "$F"; expect_rc 1; expect_err "code changed since round 1 (workers/x.txt )"
}

test_pr_opens_one_pull_request_and_close_cleans_up() {
  integ_setup; saved_tests
  fix_lands; orch run "$F"; expect_rc 0; review accept
  orch tickets "$F"; expect_rc 1; expect_err "integration round 1 passed: there is nothing to ticket"
  orch pr "$F"; expect_rc 0; on_main; expect_out "opened pull request #"
  p=$(ls "$FAKE_GH/pulls" | head -1)
  expect_eq "$(jq -r '[.title, .head.ref, .base.ref] | join(" ")' "$FAKE_GH/pulls/$p")" "Feature $F integrate/$F main"
  jq -r '.labels[].name' "$FAKE_GH/pulls/$p" | grep -Eq '^risk:R[0-3]$' || fail "no risk label: $(cat "$FAKE_GH/pulls/$p")"
  expect_eq "$(jq -r '.auto_merge // "off"' "$FAKE_GH/pulls/$p")" off; expect_out "waits for the human"
  origin_has "integrate/$F:features/$F/acceptance-review.md" || fail "the review was not merged into integrate/$F"
  expect_eq "$(events integration | tail -1 | jq -r '[.step, .status, .round] | join(" ")')" "pr opened 1"
  # policy allows it: auto-merge, and no second pull request
  push_to human main factory/policy.env "AUTO_MERGE_MAX_TIER=R3"
  orch pr "$F"; expect_rc 0; expect_out "already open"; expect_out "auto-merge is on"
  expect_eq "$(ls "$FAKE_GH/pulls" | wc -l | tr -d ' ')" 1 "pull requests"
  expect_eq "$(jq -r .auto_merge.merge_method "$FAKE_GH/pulls/$p")" squash
  # close: only after the merge
  orch close "$F"; expect_rc 1; expect_err "is not merged"
  origin_has "feature/$F" || fail "close deleted the feature branch before the merge"
  jq '.state = "closed" | .merged = true' "$FAKE_GH/pulls/$p" > "$FAKE_GH/p.new" && mv "$FAKE_GH/p.new" "$FAKE_GH/pulls/$p"
  orch close "$F"; expect_rc 0; on_main; expect_out "dispatch.sh may run the next cycle"
  gh_log | grep -qxF "api -X DELETE repos/{owner}/{repo}/branches/feature/$F/protection" || fail "the protection was not removed: $(gh_log | tail -3)"
  origin_has "feature/$F" && fail "feature/$F is still on origin"
  origin_has "integrate/$F" && fail "integrate/$F is still on origin"
  git -C "$MAIN" rev-parse -q --verify "refs/heads/integrate/$F" >/dev/null && fail "the local integrate/$F is left"
  expect_eq "$(events integration | tail -1 | jq -r '[.step, .status] | join(" ")')" "closed done"
}

test_one_integrate_at_a_time() {
  integ_setup; saved_tests
  mkdir -p "$MAIN/.factory"
  perl -e 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX); open(my $s, ">", $ARGV[1]); close $s; sleep 20' \
    "$MAIN/.factory/integrate.lock" "$TEST_TMP/held" & holder=$!
  while [ ! -e "$TEST_TMP/held" ]; do sleep 0.1; done
  cd "$MAIN"; FACTORY_LOCK_TIMEOUT=1 FACTORY_TEAM=orchestrator run "$I" run "$F"
  kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null || true
  expect_rc 1; expect_err "another integrate.sh is running"
  origin_has "integrate/$F:features/$F/e2e-report.md" && fail "a round ran while another held the lock"
  true
}


# ---- sync: main merged into feature/<f> ----
test_sync_merges_main_into_the_feature_branch_without_touching_the_checkout() {
  integ_setup
  orch sync "$F"; expect_rc 0; expect_out "feature/$F already holds everything on main: nothing to sync"
  push_to human main .claude/agents/new.md "a newer prompt"; push_to human main factory/notes.txt "a kit fix"
  mkdir -p "$MAIN/.factory/planning" && echo c002-next > "$MAIN/.factory/planning/active"   # runs during planning
  echo dirt > "$MAIN/server/dirt.txt"                                                        # and in a dirty checkout
  local before; before=$(git -C "$MAIN" rev-parse HEAD)
  orch sync "$F"; expect_rc 0; expect_out "sync/$F -> feature/$F: pull request #1 (opened)"; expect_out "gh pr merge 1 --merge"
  expect_eq "$(git -C "$MAIN" rev-parse HEAD)" "$before" "the main checkout's commit"; on_main
  [ "$(cat "$MAIN/server/dirt.txt")" = dirt ] || fail "the checkout's own file changed"
  local o=$TEST_TMP/origin.git
  expect_eq "$(git -C "$o" show "sync/$F:factory/notes.txt")" "a kit fix"
  git -C "$o" cat-file -e "sync/$F:features/$F/acceptance.md" || fail "the feature's own files are not on sync/$F"
  expect_eq "$(git -C "$o" rev-parse "sync/$F^1") $(git -C "$o" rev-parse "sync/$F^2")" \
            "$(git -C "$o" rev-parse "feature/$F") $(git -C "$o" rev-parse main)" "sync/$F's parents"
  p=$(ls "$FAKE_GH/pulls" | head -1); p=${p%.json}
  expect_eq "$(jq -r '[.title, .head.ref, .base.ref] | join(" ")' "$FAKE_GH/pulls/$p.json")" "Sync main into feature/$F sync/$F feature/$F"
  # CI's ownership check, in a clone of its own, accepts what sync pushed
  git clone -q "$o" "$TEST_TMP/ci" && git -C "$TEST_TMP/ci" switch -q "sync/$F"
  (cd "$TEST_TMP/ci" && HEAD_REF="sync/$F" bash "$SCRIPTS/check-ownership.sh" "origin/feature/$F") > "$TEST_TMP/own.out" 2>&1 ||
    fail "the ownership check refused the sync: $(cat "$TEST_TMP/own.out")"
  grep -qF "factory/notes.txt  (as on main)" "$TEST_TMP/own.out" || fail "$(cat "$TEST_TMP/own.out")"
  # again, main unchanged: nothing pushed, so a label on the pull request stays valid
  local first; first=$(git -C "$o" rev-parse "sync/$F")
  orch sync "$F"; expect_rc 0; expect_out "pull request #$p"; expect_eq "$(git -C "$o" rev-parse "sync/$F")" "$first" "sync/$F after a second run"
  ! grep -q "(updated)\|(opened)" "$OUT" || fail "a second run pushed again: $(cat "$OUT")"
  # the feature moves on (an item merged), main does not: still nothing pushed
  push_to backend "feature/$F" server/built.txt "an item"
  orch sync "$F"; expect_rc 0; expect_out "pull request #$p"; expect_eq "$(git -C "$o" rev-parse "sync/$F")" "$first" "sync/$F after the feature moved"
  ! grep -q "(updated)\|(opened)" "$OUT" || fail "the feature moving made sync push again: $(cat "$OUT")"
  # main moves on: the same pull request, updated
  push_to human main factory/notes.txt "a second kit fix"
  orch sync "$F"; expect_rc 0; expect_out "pull request #$p (updated)"
  expect_eq "$(ls "$FAKE_GH/pulls" | wc -l | tr -d ' ')" 1 "pull requests"
  expect_eq "$(git -C "$o" show "sync/$F:factory/notes.txt")" "a second kit fix"
  git -C "$o" update-ref "refs/heads/feature/$F" "sync/$F"                                  # merged with a merge commit
  orch sync "$F"; expect_rc 0; expect_out "nothing to sync"
}

test_sync_refuses_when_main_and_the_feature_both_changed_a_file() {
  integ_setup
  push_to backend "feature/$F" e2e.sh "$(sed '1s/$/ # the feature/' "$MAIN/e2e.sh")"
  push_to human main e2e.sh "$(sed '$s/$/ # main/' "$MAIN/e2e.sh")"                         # merges cleanly, but both changed it
  orch sync "$F"; expect_rc 1; expect_err "main and feature/$F both changed: e2e.sh"
  push_to human main server/share.txt "links expire after 1 day"; fix_lands                # both changed one line: a conflict
  orch sync "$F"; expect_rc 1; expect_err "main and feature/$F conflict"
  origin_has "sync/$F" && fail "a refused sync was pushed"
  [ -z "$(ls "$FAKE_GH/pulls")" ] || fail "a refused sync opened a pull request"
  on_main
}

test_a_kept_sync_is_remade_when_the_feature_changed_a_file_it_brings() {
  integ_setup; local o=$TEST_TMP/origin.git first
  push_to human main e2e.sh "$(sed '$s/$/ # main/' "$MAIN/e2e.sh")"
  orch sync "$F"; expect_rc 0; expect_out "(opened)"; first=$(git -C "$o" rev-parse "sync/$F")
  push_to backend "feature/$F" e2e.sh "$(sed '1s/$/ # the feature/' "$MAIN/e2e.sh")"     # merges cleanly, but the feature changed it too
  orch sync "$F"; expect_rc 1; expect_err "main and feature/$F both changed: e2e.sh"
  expect_eq "$(git -C "$o" rev-parse "sync/$F")" "$first" "a refused sync is not pushed"
}

# ---- drop: the human stopped the feature ----
test_drop_keeps_the_branches_as_tags_and_closes_what_was_open() {
  integ_setup; saved_tests
  local o=$TEST_TMP/origin.git fsha isha
  fsha=$(git -C "$o" rev-parse "feature/$F"); isha=$(git -C "$o" rev-parse "integrate/$F")
  ticket_in_gh 5 ticket "feature:$F" to:backend; ticket_in_gh 6 "feature:$F" team:research; ticket_in_gh 7 ticket feature:f009-other
  (cd "$MAIN" && gh pr create --title "an item" --head work/6-acceptance --base "feature/$F" >/dev/null)
  (cd "$MAIN" && gh pr create --title "elsewhere" --head work/8-x --base main >/dev/null)
  orch drop "$F"; expect_rc 1; expect_err "usage: integrate.sh drop $F --reason"
  orch drop "$F" --reason "   "; expect_rc 1; expect_err "drop needs --reason"
  orch drop "$F" --reason x --extra y; expect_rc 1
  [ -z "$(gh_log | grep 'close')" ] || fail "a refused drop closed something: $(gh_log)"
  orch drop "$F" --reason '@someone said <b>stop</b> $(touch pwned)'; expect_rc 0; on_main
  expect_out "feature $F is stopped: kept as stopped/feature/$F stopped/integrate/$F"; expect_out "dispatch.sh may run the next cycle"
  expect_eq "$(git -C "$o" rev-parse "stopped/feature/$F") $(git -C "$o" rev-parse "stopped/integrate/$F")" "$fsha $isha" "the kept tags"
  origin_has "feature/$F" && fail "feature/$F is still on origin"
  origin_has "integrate/$F" && fail "integrate/$F is still on origin"
  expect_eq "$(jq -r 'map("\(.number)=\(.state)") | join(" ")' "$FAKE_GH/issues.json" | tr ' ' '\n' | grep -E '^[567]=' | sort | tr '\n' ' ')" "5=CLOSED 6=CLOSED 7=OPEN " "issues"
  expect_eq "$(jq -r '"\(.base.ref) \(.state)"' "$FAKE_GH"/pulls/*.json | sort | tr '\n' ' ')" "feature/$F closed main open " "pull requests"
  gh_log | grep -F "issue close 5 --comment Feature $F was stopped by the human: @${ZWSP}someone said &lt;b&gt;stop&lt;/b&gt; \$(touch pwned)." >/dev/null ||
    fail "the reason was not neutralised: $(gh_log | grep 'issue close' | head -1)"
  gh_log | grep -qxF "api -X DELETE repos/{owner}/{repo}/branches/feature/$F/protection" || fail "the protection was not removed"
  [ ! -e "$MAIN/pwned" ] && [ ! -e pwned ] || fail "the reason was run"
  expect_eq "$(events integration | tail -1 | jq -r '[.step, .status] | join(" ")')" "dropped done"
}

test_drop_deletes_nothing_unless_every_branch_is_kept() {
  integ_setup; saved_tests
  local o=$TEST_TMP/origin.git
  ticket_in_gh 5 ticket "feature:$F"
  git -C "$o" tag "stopped/integrate/$F" main                                                  # a tag already there, elsewhere
  orch drop "$F" --reason "the human stopped it"; expect_rc 1; expect_err "could not keep integrate/$F as the tag stopped/integrate/$F"
  expect_err "nothing was deleted"
  origin_has "feature/$F" && origin_has "integrate/$F" || fail "a branch was deleted"
  [ -z "$(gh_log | grep 'close\|DELETE')" ] || fail "a refused drop changed GitHub: $(gh_log | grep 'close\|DELETE')"
  on_main
}

run_tests
