# Tests for factory/scripts/item.sh: work items as issues, the only way a team session makes one.
. "$(dirname "$0")/lib.sh"
I="$SCRIPTS/item.sh"
issue() { jq --argjson n "$1" '.[] | select(.number == $n)' "$FAKE_GH/issues.json"; }
labels() { issue "$1" | jq -r '[.labels[].name] | sort | join(" ")'; }

test_single_team_mode_makes_a_plain_issue() {
  mkrepo r && cd r; fake_gh
  echo "Add GET /health returning ok" > b
  run "$I" create --title "Health check endpoint" < b; expect_rc 0; expect_eq "$(cat "$OUT")" 1
  expect_eq "$(labels 1)" ""; expect_eq "$(issue 1 | jq -r .body)" "Add GET /health returning ok"
  grep -q '"type":"item".*"number":"1"' .factory/events.jsonl || fail "no item event"
}

test_team_mode_labels_the_sessions_team() {
  team_setup; fake_gh; cd "$BE"; echo body > b
  FACTORY_TEAM=backend run "$I" create --title "Notes by id" --proposed --feature f001-share < b; expect_rc 0
  expect_eq "$(labels 1)" "factory:proposed feature:f001-share team:backend"
  grep -q '"team":"backend"' "$MAIN/.factory/events.jsonl" || fail "event lacks the team"
}

test_team_mode_needs_a_real_session() {
  team_setup; fake_gh; echo body > "$TEST_TMP/b"
  cd "$BE"; FACTORY_TEAM=frontend run "$I" create --title "Notes by id" < "$TEST_TMP/b"; expect_rc 1; expect_err "this session has no team"
  cd "$BE"; run env -u FACTORY_TEAM "$I" create --title "Notes by id" < "$TEST_TMP/b"; expect_rc 1
  expect_eq "$(jq length "$FAKE_GH/issues.json" 2>/dev/null || echo 0)" 0
}

test_hostile_text_is_neutralised_and_never_run() {
  mkrepo r && cd r; fake_gh
  printf '@octocat <img src=x onerror=alert(1)> $(touch pwned) `touch pwned2`\n\x1b[31mred' > b
  run "$I" create --title $'Ping @someone\nnow <b>x</b>' < b; expect_rc 0
  expect_eq "$(issue 1 | jq -r .title)" "Ping @​someone now &lt;b&gt;x&lt;/b&gt;"
  body=$(issue 1 | jq -r .body)
  grep -qE '@[a-z]|<img' <<<"$body" && fail "mention or HTML left: $body"
  grep -q $'\x1b' <<<"$body" && fail "escape sequence posted"
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "text was executed"
}

test_bad_input_is_refused() {
  mkrepo r && cd r; fake_gh; echo body > b
  run "$I"; expect_rc 1; expect_err "usage"
  run "$I" delete 1; expect_rc 1; expect_err "usage"
  run "$I" create --title abc < b; expect_rc 1; expect_err "5 to 200"
  run "$I" create --title "$(head -c 201 /dev/zero | tr '\0' a)" < b; expect_rc 1; expect_err "5 to 200"
  run "$I" create --title "Valid title" < /dev/null; expect_rc 1; expect_err "body is empty"
  printf ' \n\t\n' > e; run "$I" create --title "Valid title" < e; expect_rc 1; expect_err "body is empty"
  head -c 60001 /dev/zero | tr '\0' x > big; run "$I" create --title "Valid title" < big; expect_rc 1; expect_err "longer than 60000"
  run "$I" create --title "Valid title" --feature 'a,b' < b; expect_rc 1; expect_err "--feature must look like"
  run "$I" create --title "Valid title" --label x < b; expect_rc 1; expect_err "unknown option --label"
  run "$I" create --title < b; expect_rc 1; expect_err "--title needs a value"
  expect_eq "$(jq length "$FAKE_GH/issues.json" 2>/dev/null || echo 0)" 0
}

test_github_failure_is_reported() {
  mkrepo r && cd r; fake_gh; echo body > b; echo 'issue create' > "$FAKE_GH/fail"
  run "$I" create --title "Valid title" < b; expect_rc 1; expect_err "GitHub refused the item"
}

run_tests
