# Tests for factory/scripts/contracts.sh: a planning cycle promotes a team's contract draft into
# contracts/, as the contract's first author. Meetings run through the real planning scripts.
. "$(dirname "$0")/lib.sh"
CS="$SCRIPTS/contracts.sh"
A=backend-api.openapi.yaml

# to_decisions: cycle c001-share-links in its decisions round, with backend's API draft attached
# to its position and published as planning/<cycle>/attachments/backend-api.openapi.yaml, and the
# first draft of DECISIONS.md out (its c001-D01 names contracts/api.openapi.yaml#/paths/~1shares).
to_decisions() {
  meeting_to positions
  position_ok > "$TEST_TMP/pos"; printf 'openapi: 3.1.0\npaths: {}\n' > "$TEST_TMP/api"
  for t in backend frontend research; do by "$t" "$SCRIPTS/position.sh" submit < "$TEST_TMP/pos"; expect_rc 0; done
  by backend "$SCRIPTS/position.sh" attach api.openapi.yaml < "$TEST_TMP/api"; expect_rc 0
  for i in 1 2 3; do by orchestrator "$SCRIPTS/round.sh" next; expect_rc 0; done
  status_is decisions
  decisions_ok c001 > "$P/DECISIONS.md"
  by orchestrator "$SCRIPTS/round.sh" draft; expect_rc 0
}
promote() { by orchestrator "$CS" promote "$@"; }
nothing_written() { [ ! -e "$MAIN/contracts" ] || fail "contracts/ was written: $(ls -R "$MAIN/contracts")"; [ ! -e "$P/contracts.jsonl" ] || fail "contracts.jsonl was written"; }

test_promote_copies_records_commits_pushes_and_tells() {
  planning_setup; to_decisions
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 0; expect_out "decisions: c001-D01"
  cmp -s "$P/attachments/$A" "$MAIN/contracts/api.openapi.yaml" || fail "the draft was not copied"
  expect_eq "$(jq -c '[.cycle, .attachment, .path, .decisions]' "$P/contracts.jsonl")" '["c001-share-links","backend-api.openapi.yaml","contracts/api.openapi.yaml",["c001-D01"]]'
  jq -e '.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$")' "$P/contracts.jsonl" >/dev/null || fail "no time in contracts.jsonl"
  expect_eq "$(git -C "$MAIN" log -1 --format=%s)" "planning $C: promote $A to contracts/api.openapi.yaml"
  expect_eq "$(git -C "$MAIN" show --name-only --format= HEAD | sort | tr '\n' ' ')" "contracts/api.openapi.yaml planning/$C/contracts.jsonl "
  expect_eq "$(git --git-dir="$TEST_TMP/origin.git" rev-parse "planning/$C")" "$(git -C "$MAIN" rev-parse HEAD)" "pushed"
  expect_eq "$(grep '"type":"contract"' "$MAIN/.factory/events.jsonl" | jq -c '[.team, .action, .cycle, .path, .decisions]')" \
    '["orchestrator","promote","c001-share-links","contracts/api.openapi.yaml","c001-D01"]'
  cd "$MAIN"; run "$SCRIPTS/check-ownership.sh" origin/main; expect_rc 0                     # what CI then sees
  expect_out "contracts/api.openapi.yaml  (a new contract this cycle decides)"
  printf 'openapi: 3.1.0\npaths: {"/shares": {}}\n' > "$TEST_TMP/api2"
  cp "$TEST_TMP/api2" "$P/attachments/backend-api-v2.yaml"; git -C "$MAIN" add -A planning && git -C "$MAIN" commit -qm v2
  promote "$C" backend-api-v2.yaml contracts/api.openapi.yaml; expect_rc 0                     # again, in the same cycle
  expect_eq "$(lines "$P/contracts.jsonl")" 2
  cmp -s "$TEST_TMP/api2" "$MAIN/contracts/api.openapi.yaml" || fail "the second draft did not replace the first"
}

test_not_before_the_decisions_round() {
  planning_setup; meeting_to positions
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "decisions or approval round (the cycle is positions)"
}

test_only_the_orchestrator_in_its_checkout_on_the_branch() {
  planning_setup; to_decisions
  by backend "$CS" promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "only the orchestrator promotes"
  cd "$BE"; FACTORY_TEAM=orchestrator run "$CS" promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "this session has no team"
  cd "$MAIN"; run env -u FACTORY_TEAM "$CS" promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "FACTORY_TEAM=unset"
  promote c002-other "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "c002-other is not the planning cycle in progress"
  for c in '../c001-share-links' 'c1-x' '$(touch pwned)' ''; do promote "$c" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "must look like"; done
  git -C "$MAIN" switch -q main; promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "not on planning/$C"
  git -C "$MAIN" switch -q "planning/$C"
  promote "$C" "$A"; expect_rc 1; expect_err "contracts.sh promote <cycle>"
  by orchestrator "$CS" publish "$C" "$A" contracts/x; expect_rc 1
  for s in '{"status": "decisions"' '[]' '{"status": "discussion-1"}' ''; do
    printf '%s' "$s" > "$P/state.json"; promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "decisions or approval round"
  done
  nothing_written
  [ ! -e pwned ] && [ ! -e "$MAIN/pwned" ] || fail "an argument was executed"
}

test_no_team_mode_no_promotion() {
  mkrepo solo && cd solo; FACTORY_TEAM=orchestrator run "$CS" promote c001-x a.yaml contracts/a.yaml
  expect_rc 1; expect_err "this factory has no factory/teams.json"
}

test_the_attachment_must_be_one_round_sh_published() {
  planning_setup; to_decisions
  for a in '../state.json' '../../../factory/teams.json' 'sub/x' '.hidden' '' "$P/attachments/$A" '$(touch pwned)' 'a b' $'a\nb'; do
    promote "$C" "$a" contracts/api.openapi.yaml; expect_rc 1; expect_err "the attachment is a file name"
  done
  promote "$C" missing.yaml contracts/api.openapi.yaml; expect_rc 1; expect_err "not a published attachment"
  mkdir "$P/attachments/sub"; promote "$C" sub contracts/api.openapi.yaml; expect_rc 1; expect_err "not a published attachment"
  ln -s ../BRIEF.md "$P/attachments/link.md"; promote "$C" link.md contracts/api.openapi.yaml; expect_rc 1; expect_err "is a symlink"
  ln -s /etc/hosts "$P/attachments/hosts"; promote "$C" hosts contracts/api.openapi.yaml; expect_rc 1; expect_err "is a symlink"
  head -c 1048576 /dev/zero | tr '\0' x > "$P/attachments/huge.yaml"; promote "$C" huge.yaml contracts/api.openapi.yaml; expect_rc 1; expect_err "over 200000 bytes"
  mv "$P/attachments" "$TEST_TMP/att"; ln -s "$TEST_TMP/att" "$P/attachments"
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "planning/$C/attachments is a symlink"
  nothing_written
  [ ! -e pwned ] && [ ! -e "$MAIN/pwned" ] || fail "an argument was executed"
}

test_the_target_must_be_a_clean_contracts_path() {
  planning_setup; to_decisions
  local t
  for t in contracts contracts/ contracts//api.yaml contracts/../factory/teams.json contracts/a/../../x -contracts/x contracts/-x \
           "$MAIN/contracts/api.yaml" /contracts/x 'contracts/a b.yaml' 'contracts/$(touch pwned)' 'contracts/`touch pwned`' \
           $'contracts/a\nb' Contracts/api.yaml server/x.js 'contracts/api.openapi.yaml#/paths' 'contracts/a,b' "contracts/a'b" 'contracts/a"b' \
           "contracts/$(head -c 100000 /dev/zero | tr '\0' a)" contracts/a..b ''; do   # (Linux refuses an argument over 128 KB)
    promote "$C" "$A" "$t"; expect_rc 1; expect_err "clean path of a file under contracts/"
  done
  ln -s factory "$MAIN/contracts"; cp "$MAIN/factory/teams.json" "$TEST_TMP/roster"
  sed -i.bak 's#contract: contracts/api.openapi.yaml#contract: contracts/teams.json#' "$P/DECISIONS.md"
  promote "$C" "$A" contracts/teams.json; expect_rc 1; expect_err "passes through a symlink (contracts)"
  cmp -s "$MAIN/factory/teams.json" "$TEST_TMP/roster" || fail "wrote through the symlink into factory/"
  rm "$MAIN/contracts"; mkdir -p "$MAIN/contracts/teams.json"
  promote "$C" "$A" contracts/teams.json; expect_rc 1; expect_err "is a directory"
  [ ! -e pwned ] && [ ! -e "$MAIN/pwned" ] || fail "a target was executed"
  [ ! -e "$P/contracts.jsonl" ] || fail "contracts.jsonl was written"
}

test_first_author_only() {
  planning_setup; to_decisions
  git clone -q "$TEST_TMP/origin.git" other && mkdir other/contracts && echo approved > other/contracts/api.openapi.yaml
  git -C other add -A && git -C other commit -qm approved && git -C other push -q origin main
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "already on main"; expect_err "contract-change ticket"
  nothing_written
  git -C "$MAIN" remote set-url origin "$TEST_TMP/nowhere.git"
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "cannot reach origin"
}

test_a_decision_record_must_name_the_target() {
  planning_setup; to_decisions
  promote "$C" "$A" contracts/other.yaml; expect_rc 1; expect_err "no record in planning/$C/DECISIONS.md names contracts/other.yaml"
  printf -- '- contract: contracts/other.yaml\n' >> "$P/DECISIONS.md"                       # after the work breakdown
  promote "$C" "$A" contracts/other.yaml; expect_rc 1
  perl -0pi -e 's/(### Decision\n)/$1- contract: contracts\/other.yaml\n/' "$P/DECISIONS.md"   # inside a record's text
  promote "$C" "$A" contracts/other.yaml; expect_rc 1
  printf '## c001-D09: No sections\n- owner: backend\n\n## Notes\n- contract: contracts/other.yaml\n' >> "$P/DECISIONS.md"
  promote "$C" "$A" contracts/other.yaml; expect_rc 1                                       # under a heading that is no record
  sed -i.bak 's#^- contract: contracts/api.openapi.yaml.*#- contract: contracts/api.openapi.yaml.bak#' "$P/DECISIONS.md"
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1                                  # a longer path is another path
  rm "$P/DECISIONS.md"; promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 1; expect_err "no record"
  nothing_written
  decisions_ok c001 | perl -pe 's/\n/\r\n/' > "$P/DECISIONS.md"                             # CRLF
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 0; expect_out "decisions: c001-D01"
  expect_eq "$(jq -c .decisions "$P/contracts.jsonl")" '["c001-D01"]'
  decisions_ok c001 | perl -pe 's#^- affects: frontend$#- affects: frontend\n- contract: contracts/api.openapi.yaml   \# also#' > "$P/DECISIONS.md"
  promote "$C" "$A" contracts/api.openapi.yaml; expect_rc 0                                  # named by two records
  expect_eq "$(tail -1 "$P/contracts.jsonl" | jq -c .decisions)" '["c001-D01","c001-D02"]'
}

run_tests
