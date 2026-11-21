# Tests for factory/scripts/dispatch.sh: only approved, settled decisions are handed out, one feature
# branch at a time, research always gets the acceptance criteria to write, the feature branch is
# protected like main, and each team with items is rung.
. "$(dirname "$0")/lib.sh"
DIS="$SCRIPTS/dispatch.sh"; R="$SCRIPTS/round.sh"; SAY="$SCRIPTS/say.sh"
F=f001-share-links

approved() {  # approved [status of D02]: a three-team cycle taken to approval and merged; main protected.
  # DEC_PERL, if set, is a perl -p program applied to DECISIONS.md first.
  planning_setup; fake_branches; protect_main
  meeting_to decisions; decisions_ok c001 "${1:-decided}" "${1:+frontend disagrees}" | perl -pe "${DEC_PERL:-}" > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0
  for t in backend research; do by "$t" "$SAY" accept --to orchestrator --body ok; done
  if [ -n "${1:-}" ]; then by frontend "$SAY" objection --to orchestrator --refs c001-D02 --body "Too short."
  else by frontend "$SAY" accept --to orchestrator --body ok; fi
  by orchestrator "$R" next; expect_rc 0
  git -C "$MAIN" push -q origin "planning/$C:main"
}
protect_main() {  # as GitHub answers for main after `factory github`
  cat > "$FAKE_GH/protection/main.json" <<'JSON'
{"url": "https://api.github.com/repos/o/r/branches/main/protection",
 "required_status_checks": {"url": "x", "strict": true, "contexts": ["check", "ownership", "risk-gate"], "contexts_url": "x",
                            "checks": [{"context": "check", "app_id": 15368}, {"context": "ownership", "app_id": 15368}, {"context": "risk-gate", "app_id": 15368}]},
 "enforce_admins": {"url": "x", "enabled": true}, "required_linear_history": {"enabled": false}}
JSON
}
on_origin() { git -C "$TEST_TMP/origin.git" rev-parse -q --verify "refs/heads/$1" >/dev/null; }
jsonl() { git -C "$TEST_TMP/origin.git" show "feature/$F:planning/$C/dispatch.jsonl"; }
nothing_dispatched() {  # no branch anywhere, the checkout back on a clean main, the cycle still open
  on_origin "feature/$F" && fail "feature/$F is on origin"
  git -C "$MAIN" rev-parse -q --verify "refs/heads/feature/$F" >/dev/null && fail "feature/$F is left in the main checkout"
  expect_eq "$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)" main
  expect_eq "$(git -C "$MAIN" status --porcelain)" ""
  expect_eq "$(cat "$MAIN/.factory/planning/active")" "$C"
  grep -q '"type":"dispatch"' "$MAIN/.factory/events.jsonl" && fail "a dispatch event was written"
  true
}

test_who_and_what_may_be_dispatched() {
  approved
  by backend "$DIS" "$C"; expect_rc 1; expect_err "only the orchestrator dispatches"
  for c in '' c1-x 'c001-x;touch pwned' '../c001-x' C001-X; do by orchestrator "$DIS" "$c"; expect_rc 1; expect_err "usage"; done
  by orchestrator "$DIS" c002-other; expect_rc 1; expect_err "planning/c002-other/DECISIONS.md is not on origin/main"
  [ ! -e pwned ] || fail "an argument was executed"
}

test_needs_human_records_block_dispatch() {
  approved needs-human
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "1 needs-human record(s) left: c001-D02"
  on_origin "feature/$F" && fail "made a feature branch anyway"
  true
}

test_one_feature_branch_at_a_time() {
  approved
  git -C "$MAIN" push -q origin main:feature/f000-older
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "feature/f000-older is still open"
  git -C "$MAIN" push -q origin --delete feature/f000-older
  by orchestrator "$DIS" "$C"; expect_rc 0
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "feature/$F is still open"
}

test_the_state_on_main_must_be_approval() {
  approved
  git -C "$MAIN" switch -q main && git -C "$MAIN" merge -q --ff-only origin/main
  jq '.status = "decisions"' "$P/state.json" > s && mv s "$P/state.json"
  git -C "$MAIN" commit -qam "not approved" && git -C "$MAIN" push -q origin main
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "the cycle's state on main is 'decisions', not approval"
  echo dirt > "$MAIN/dirt"; by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "uncommitted changes"
}

test_research_must_be_an_active_team() {
  approved
  for change in '.teams.research.active = false' 'del(.teams.research)'; do
    git -C "$MAIN" checkout -q -- factory/teams.json
    jq "$change" "$MAIN/factory/teams.json" > t && mv t "$MAIN/factory/teams.json"
    by orchestrator "$DIS" "$C"; expect_rc 1
    expect_err "research is not an active team in factory/teams.json: integration needs acceptance criteria, which the research team writes"
    on_origin "feature/$F" && fail "made a feature branch without research ($change)"
    grep -q 'branches/' "$FAKE_GH/log" 2>/dev/null && fail "asked GitHub about protection before refusing"
  done
  git -C "$MAIN" checkout -q -- factory/teams.json
  by orchestrator "$DIS" "$C"; expect_rc 0
}

test_research_gets_the_acceptance_criteria_item() {
  approved
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "is feature/$F, 4 item(s)"
  expect_eq "$(jsonl | jq -r '"\(.team):\(.item)"' | tr '\n' ' ')" "backend:share-api frontend:share-button research:share-research research:acceptance "
  jsonl | tail -1 | jq -e --arg f "$F" --arg c "$C" '. == {ts: .ts, cycle: $c, feature: $f, item: "acceptance", team: "research",
      delivers: "features/\($f)/acceptance.md: the feature'"'"'s acceptance criteria", after: [], contract: "", decisions: ["c001-D01", "c001-D02"]}' >/dev/null ||
    fail "the acceptance line is wrong: $(jsonl | tail -1)"
  expect_eq "$(grep -c '"type":"dispatch"' "$MAIN/.factory/events.jsonl")" 4
  grep '"type":"dispatch"' "$MAIN/.factory/events.jsonl" | grep -q '"to":"research","item":"acceptance"' || fail "no dispatch event for the acceptance item"
}

test_a_breakdown_that_has_the_acceptance_line_gets_no_second() {
  DEC_PERL='s{who shares notes and why}{features/f001-share-links/acceptance.md, what done means}'; approved
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "3 item(s)"
  expect_eq "$(jsonl | jq -r .item | tr '\n' ' ')" "share-api share-button share-research "
}

test_a_breakdown_that_names_the_feature_as_f_gets_no_second() {
  DEC_PERL='s{^\| share-research \|}{| acceptance |}; s{who shares notes and why}{features/<f>/acceptance.md, what done means}'; approved
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "3 item(s)"
  expect_eq "$(jsonl | jq -r 'select(.item == "acceptance") | .delivers' | cut -d, -f1)" "features/$F/acceptance.md"
}

test_only_research_delivering_the_file_counts() {
  DEC_PERL='s{POST /shares and GET /s/:token}{features/f001-share-links/acceptance.md and the API}'; approved
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "4 item(s)"
  expect_eq "$(jsonl | jq -r .item | tail -1)" acceptance
}

test_the_name_acceptance_is_kept_for_research() {
  for row in share-research share-button; do
    DEC_PERL="s{^\\| $row \\|}{| acceptance |}"; approved
    by orchestrator "$DIS" "$C"; expect_rc 1
    expect_err "the work breakdown has an item named acceptance that is not research delivering features/$F/acceptance.md"
    nothing_dispatched
    cd "$TEST_TMP" && rm -rf app app.teams origin.git gh
  done
}

test_the_feature_branch_is_protected_like_main() {
  approved
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "feature/$F is protected like main"
  jq -e '. == {required_status_checks: {strict: true, contexts: ["check", "ownership", "risk-gate"]}, enforce_admins: true,
               required_pull_request_reviews: null, restrictions: null}' "$FAKE_GH/protection/feature/$F.json" >/dev/null ||
    fail "the protection put on the feature branch is wrong: $(cat "$FAKE_GH/protection/feature/$F.json")"
  grep -qxF "api -X PUT repos/{owner}/{repo}/branches/feature/$F/protection --input -" "$FAKE_GH/log" || fail "no PUT: $(cat "$FAKE_GH/log")"
  # main's protection is read before the branch exists, and the branch is protected after it is pushed
  expect_eq "$(grep -n 'branches/' "$FAKE_GH/log" | cut -d: -f2- | sed 's/ --input -//' | tr '\n' ' ')" \
    "api repos/{owner}/{repo}/branches/main/protection api -X PUT repos/{owner}/{repo}/branches/feature/$F/protection "
}

test_main_without_status_checks_or_admin_enforcement_is_copied_as_it_is() {
  approved
  echo '{"enforce_admins": {"enabled": false}, "required_pull_request_reviews": {"required_approving_review_count": 1}}' > "$FAKE_GH/protection/main.json"
  by orchestrator "$DIS" "$C"; expect_rc 0
  jq -e '. == {required_status_checks: null, enforce_admins: false, required_pull_request_reviews: null, restrictions: null}' \
    "$FAKE_GH/protection/feature/$F.json" >/dev/null || fail "wrong protection: $(cat "$FAKE_GH/protection/feature/$F.json")"
}

test_an_unprotected_main_is_said_and_dispatch_carries_on() {
  approved
  rm "$FAKE_GH/protection/main.json"
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "main has no branch protection, so feature/$F has none either"
  [ ! -e "$FAKE_GH/protection/feature/$F.json" ] || fail "protected the feature branch anyway"
  on_origin "feature/$F" || fail "no feature branch"
  # a private repository on GitHub Free cannot protect a branch: the same
  cd "$TEST_TMP" && rm -rf app app.teams origin.git gh; approved
  echo '{"message": "Upgrade to GitHub Pro or make this repository public to enable this feature.", "status": "403"}' > "$FAKE_GH/protection/main.json"
  echo 1 > "$FAKE_GH/protection/main.json.rc"
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "main has no branch protection"
}

test_main_protection_unreadable_stops_before_anything_is_made() {
  approved
  echo 'branches/main/protection' > "$FAKE_GH/fail"
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "cannot read main's branch protection: HTTP 502: fake failure. Nothing was dispatched"
  nothing_dispatched; rm "$FAKE_GH/fail"
  echo '{"message": "Not Found", "status": "404"}' > "$FAKE_GH/protection/main.json"; echo 1 > "$FAKE_GH/protection/main.json.rc"
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "cannot read main's branch protection: gh: Not Found (HTTP 404)"
  nothing_dispatched; rm "$FAKE_GH/protection/main.json.rc"
  for garbled in 'not json {' '' '[]' '"protected"' '{"enforce_admins": true}' '{"enforce_admins": {"enabled": "yes"}}' \
      '{"enforce_admins": {"enabled": true}, "required_status_checks": {"strict": true, "contexts": "check"}}' \
      '{"enforce_admins": {"enabled": true}, "required_status_checks": {"strict": true, "contexts": [1]}}' \
      '{"enforce_admins": {"enabled": true}, "required_status_checks": {"strict": true, "contexts": {"a": "check"}}}' \
      '{"enforce_admins": {"enabled": true}, "required_status_checks": {"contexts": ["check"]}}' \
      '{"enforce_admins": {"enabled": true}} {"enforce_admins": {"enabled": false}}' \
      '{"enforce_admins": {"enabled": true}, "required_status_checks": {"strict": true, "contexts": ["ch'; do
    printf '%s' "$garbled" > "$FAKE_GH/protection/main.json"
    by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "cannot read main's branch protection"
    nothing_dispatched
  done
}

test_github_refusing_to_protect_the_feature_branch_undoes_it() {
  approved
  echo '-X PUT' > "$FAKE_GH/fail"
  by orchestrator "$DIS" "$C"; expect_rc 1
  expect_err "GitHub refused to protect feature/$F like main: HTTP 502: fake failure. Nothing was dispatched; feature/$F is removed again"
  expect_err "needs admin rights on the repository: run dispatch.sh again"
  nothing_dispatched
  rm "$FAKE_GH/fail"                                 # what it says to do works
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "feature/$F is protected like main"
  [ ! -e "$MAIN/.factory/planning/active" ] || fail "the cycle is still marked open"
}

test_hostile_text_reaches_dispatch_jsonl_as_data() {
  printf '%s' 'who "shares" $(touch pwned) `touch pwned2` back\slash \n {"x":1} '"'"'q'"'"' a'$'\r''b' > "$TEST_TMP/hostile"
  DEC_PERL='BEGIN { open my $h, "<", "'"$TEST_TMP"'/hostile" or die; $x = <$h> } s{who shares notes and why}{$x}'; approved
  by orchestrator "$DIS" "$C"; expect_rc 0
  expect_eq "$(jsonl | awk 'END {print NR}')" 4
  jsonl | while IFS= read -r l; do jq -e 'type == "object"' <<<"$l" >/dev/null || fail "not one JSON object per line: $l"; done
  expect_eq "$(jsonl | jq -r 'select(.item == "share-research") | .delivers')" "$(cat "$TEST_TMP/hostile")"
  ls "$MAIN" "$TEST_TMP" | grep -q pwned && fail "text in the work breakdown was executed"
  true
}

test_hostile_decision_ids_never_reach_dispatch() {
  approved
  git -C "$MAIN" switch -q main && git -C "$MAIN" merge -q --ff-only origin/main
  perl -pi -e 's{^## c001-D02:}{## c001-D02\$(touch\${IFS}pwned)":}' "$P/DECISIONS.md"
  git -C "$MAIN" commit -qam "hostile id" && git -C "$MAIN" push -q origin main
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "an id must look like c001-D01"
  nothing_dispatched
  ls "$MAIN" "$TEST_TMP" | grep -q pwned && fail "a decision id was executed"
  true
}

test_each_team_with_items_is_rung() {
  approved
  mkdir -p "$TEST_TMP/hd"
  jq -n '{spaces: [{name: "app", tabs: [{name: "orchestrator", terminals: [{terminal: "t1"}]}, {name: "backend", terminals: [{terminal: "t2"}]},
                                        {name: "frontend", terminals: [{terminal: "t3"}]}]}]}' > "$TEST_TMP/hd/layout"
  printf '#!/usr/bin/env bash\n[ "$1" = ls ] && cat "$TEST_TMP/hd/layout"\n' > "$TEST_TMP/hd/herdr-app"
  fake_hc "$TEST_TMP/hd" "$TEST_TMP/hd/hc.log"
  chmod +x "$TEST_TMP/hd/herdr-app" "$TEST_TMP/hd/hc"; PATH="$TEST_TMP/hd:$PATH"
  by orchestrator "$DIS" "$C"; expect_rc 0
  expect_out "rang backend"; expect_out "rang frontend"; expect_out "could not ring research"
  expect_eq "$(sort "$TEST_TMP/hd/hc.log" | tr '\n' ' ')" "t2|New items for you: run /inbox. t3|New items for you: run /inbox. "
}

run_tests
