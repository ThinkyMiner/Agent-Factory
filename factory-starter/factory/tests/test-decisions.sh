# Tests for factory/scripts/decisions.sh: the record's shape, the open-question and objection rules,
# the work breakdown for dispatch, and CI's check that approved records only gain "superseded".
. "$(dirname "$0")/lib.sh"
D="$SCRIPTS/decisions.sh"

cycle() {  # a cycle folder with state.json for c001 and teams backend, frontend, research
  mkrepo r && cd r && mkdir -p planning/c001-share-links && P="$TEST_TMP/r/planning/c001-share-links"
  jq -n '{v: 1, cycle: "c001-share-links", status: "decisions", teams: ["backend", "frontend", "research"], draft: 1, unanswered: []}' > "$P/state.json"
}
broken() {  # broken <perl substitution> <expected error>
  decisions_ok c001 | perl -0pe "$1" > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "$2"
}

test_a_valid_record_passes() {
  cycle; decisions_ok c001 > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 0; expect_out "decisions: ok, 2 record(s), 0 needs-human, 3 item(s)"
}

test_malformed_records_are_named() {
  cycle
  broken 's/^- owner: backend\n//m' "c001-D01 (line 3): owner must be one of the cycle teams"
  broken 's/owner: backend/owner: orchestrator/' "owner must be one of the cycle teams"
  broken 's/affects: frontend, research/affects: frontend, design/' "affects names design"
  broken 's/status: decided/status: superseded/' "status must be decided or needs-human"
  broken 's/risk_floor: R2/risk_floor: R4/' "risk_floor must be R0 to R3"
  broken 's/^(- risk_floor: R2)/$1\n- supersedes: c001-D02/m' "supersedes must name a record of an earlier cycle"
  broken 's{contracts/api.openapi.yaml#/paths/~1shares}{contracts/../../etc/passwd}' "contract must be a path under contracts/"
  broken 's/## c001-D02/## c002-D02/' "an id must look like c001-D01"
  broken 's/## c001-D02/## c001-D01/' "the id is used twice"
  broken 's/### Reasoning\nTokens cannot be guessed and reveal nothing about other notes.\n//' "the section ### Reasoning is missing or empty"
  broken 's/(### Dissent\n)none/$1/' "### Dissent is missing or empty"
  broken 's/- refs: \n/- refs: m014\n/' "refs must be transcript ids like c001-m014"
  printf '# nothing\n' > "$P/DECISIONS.md"; run "$D" validate "$P"; expect_rc 1; expect_err "no decision records"
  rm "$P/DECISIONS.md"; run "$D" validate "$P"; expect_rc 1; expect_err "is missing"
}

test_the_work_breakdown_is_checked() {
  cycle
  broken 's/## Work breakdown.*//s' "no ## Work breakdown table"
  broken 's/\| item \| team \|/| what | team |/' "the work breakdown header must be"
  broken 's/\| share-button \| frontend/| share-button | design/' "team design is not a cycle team"
  broken 's/\| share-research \| research/| share-api | research/' "item share-api is listed twice"
  broken 's/\| research \| who shares notes and why \| - \| - \| c001-D02 \|/| research | who shares | - | - | c001-D07 |/' "decision c001-D07 is not in DECISIONS.md"
  broken 's/\| share-button \| frontend \| a Share button that copies the link \| share-api/| share-button | frontend | x | share-apx/' "comes after share-apx, which is not an item"
  broken 's/(\| share-api \| backend \| [^|]+\| )- /$1share-button /' "the after column has a loop"
  broken 's/\| share-research \| research \| who shares notes and why/| Share Research | research | who/' "item must be a short slug"
}

test_open_questions_and_objections_must_be_settled() {
  cycle; decisions_ok c001 > "$P/DECISIONS.md"
  jq '.unanswered = ["c001-m004"]' "$P/state.json" > s && mv s "$P/state.json"
  run "$D" validate "$P"; expect_rc 1; expect_err "question c001-m004 was left open in discussion"
  decisions_ok c001 needs-human "none" c001-m004 > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 0; expect_out "1 needs-human"
  printf '{"id":"c001-m009","round":"decisions","kind":"objection","from":"frontend","draft":1,"refs":["c001-D02"],"body":"x"}\n{"id":"c001-m010","round":"decisions","kind":"objection","from":"research","draft":0,"refs":["c001-D01"],"body":"old draft"}\nnot json\n' > "$P/discussion.jsonl"
  decisions_ok c001 needs-human "none" c001-m004 > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "frontend objected to c001-D02"
  decisions_ok c001 needs-human "frontend wants 30 days" c001-m004 > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 0
  run "$D" validate "$P" --new-draft; expect_rc 0
}

test_items_are_json_and_refuse_needs_human() {
  cycle; decisions_ok c001 | sed 's/a Share button that copies the link/a "Share" button \\ that copies $(touch pwned)/' > "$P/DECISIONS.md"
  run "$D" items "$P"; expect_rc 0
  expect_eq "$(jq -s length "$OUT")" 3
  expect_eq "$(jq -r 'select(.item == "share-button") | .delivers' "$OUT")" 'a "Share" button \ that copies $(touch pwned)'
  expect_eq "$(jq -c 'select(.item == "share-api") | [.after, .contract, .decisions]' "$OUT")" '[[],"contracts/api.openapi.yaml",["c001-D01","c001-D02"]]'
  decisions_ok c001 needs-human > "$P/DECISIONS.md"
  run "$D" items "$P"; expect_rc 1; expect_err "1 needs-human record(s) left: c001-D02"
  [ ! -e pwned ] || fail "a field was executed"
  echo '{"broken' > "$P/state.json"; run "$D" items "$P"; expect_rc 1; expect_err "state.json is missing or damaged"
}

raises() {  # raises <file> <printf text>: the file in the cycle folder, then validate
  printf "$2" > "$P/$1"; run "$D" validate "$P"
}

test_security_raises_set_risk_floors() {
  cycle; decisions_ok c001 > "$P/DECISIONS.md"          # D01 has risk_floor R2, D02 none
  run "$D" validate "$P"; expect_rc 0                    # no threat-model.md: fine
  raises threat-model.md 'THREAT MODEL:\n- Raise the token lifetime with backend: it matters.\nRAISES:\nRAISE: c001-D01 R2 a token grants read access\nNOT VERIFIED: - none\n'; expect_rc 0
  raises threat-model.md 'RAISE: c001-D01 R1 lower than the floor changes nothing\n- RAISE: c001-D02 R2 a leaked link works for a week\n'
  expect_rc 1; expect_err "threat-model.md line 2: raises c001-D02 to R2, so its risk_floor must be at least R2"
  decisions_ok c001 | perl -0pe 's/(- status: decided\n)(- refs:)/$1- risk_floor: R3\n$2/' > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 0
  run "$D" validate "$P" --new-draft; expect_rc 0
  raises db-review.md 'RAISE: c001-D01 R3 dropping the column loses every share\n'
  expect_rc 1; expect_err "db-review.md line 1: raises c001-D01 to R3"
  run "$D" items "$P"; expect_rc 1; expect_err "raises c001-D01 to R3"   # dispatch refuses it too
}

test_malformed_and_hostile_raises_fail() {
  cycle; decisions_ok c001 > "$P/DECISIONS.md"
  for l in 'RAISE: c001-D01 R9 tier out of range' 'RAISE: c001-D1 R2 short id' 'RAISE: ../c001-D01 R2 climbs' \
           'RAISE: c001-D01$(touch pwned) R2 subshell' 'RAISE: `touch pwned` R2 backticks' 'RAISE: "c001-D01" R2 quoted' \
           'RAISE: c001-D01' 'RAISE:' 'RAISE c001-D01 R2 no colon' '**RAISE:** c001-D01 R2 bold' 'Raise: c001-D01 R2 lower case' \
           'RAISE: c001-D01 R2, comma glued to the tier' 'RAISE:c001-D01 R2 no space'; do
    printf '%s\n' "$l" > "$P/threat-model.md"
    run "$D" validate "$P"; expect_rc 1 || fail "[$l]"; expect_err "threat-model.md line 1: a raise must read RAISE: <record id like c001-D01> <R0..R3> <why>"
  done
  [ ! -e pwned ] && [ ! -e "$P/pwned" ] || fail "a raise was executed"
  raises threat-model.md 'RAISE: c001-D09 R2 a record nobody wrote\n'; expect_rc 1; expect_err "raises c001-D09, which is not in DECISIONS.md"
  # an earlier cycle's record (say one this cycle supersedes) cannot be raised here: its floor is approved
  raises threat-model.md 'RAISE: c000-D03 R3 the old record\n'; expect_rc 1; expect_err "c000-D03 is not a record of this cycle"
  decisions_ok c001 | perl -0pe 's/(## c001-D02.*?)(- refs: )/$1- supersedes: c000-D03\n$2/s' > "$P/DECISIONS.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "c000-D03 is not a record of this cycle"
  decisions_ok c001 > "$P/DECISIONS.md"
  raises threat-model.md 'RAISE: c001-D01 R2 the "why" has '"'quotes'"', $(touch pwned) and `id`\n'; expect_rc 0
  [ ! -e pwned ] || fail "a raise's reason was executed"
}

test_raises_survive_crlf_huge_files_and_links() {
  cycle; decisions_ok c001 | sed 's/$/\r/' > "$P/DECISIONS.md"
  raises threat-model.md 'RAISE: c001-D01 R2\r\nRAISE: c001-D02 R1 crlf\r\n'; expect_rc 1; expect_err "line 2: raises c001-D02 to R1"
  raises threat-model.md 'RAISE: c001-D01 R2\r\n'; expect_rc 0
  { perl -e 'print "prose without a raise in it.\n" x 40000'; echo 'RAISE: c001-D02 R2 at the end of 1 MB'; } > "$P/threat-model.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "line 40001: raises c001-D02 to R2"
  perl -e 'print "RAISE: c001-D01 ", "x" x 1048576' > "$P/threat-model.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "line 1: a raise must read"
  printf 'RAISE: c001-D02 R3 hidden behind a link\n' > "$TEST_TMP/outside.md"
  rm "$P/threat-model.md"; ln -s ../../../outside.md "$P/threat-model.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "threat-model.md must be a plain file"
  rm "$P/threat-model.md"; ln -s "$P/no-such-file" "$P/threat-model.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "threat-model.md must be a plain file"
  rm "$P/threat-model.md"; mkdir "$P/threat-model.md"
  run "$D" validate "$P"; expect_rc 1; expect_err "threat-model.md must be a plain file"
}

test_round_draft_refuses_a_draft_below_a_raise() {
  planning_setup; meeting_to decisions
  decisions_ok c001 > "$P/DECISIONS.md"
  printf 'RAISE: c001-D02 R2 a leaked link works for a week\n' > "$P/threat-model.md"
  by orchestrator "$SCRIPTS/round.sh" draft; expect_rc 1; expect_err "raises c001-D02 to R2"
  expect_eq "$(jq .draft "$P/state.json")" 0
  decisions_ok c001 | perl -0pe 's/(## c001-D02.*?)(- refs: )/$1- risk_floor: R2\n$2/s' > "$P/DECISIONS.md"
  by orchestrator "$SCRIPTS/round.sh" draft; expect_rc 0
  git -C "$MAIN" show --stat HEAD | grep -q threat-model.md || fail "the threat model is not in the planning record"
}

test_approved_records_only_gain_superseded() {
  mkrepo r && cd r && mkdir -p planning/c001-share-links && decisions_ok c001 > planning/c001-share-links/DECISIONS.md
  git add -A && git commit -qm approved && git switch -q -c later
  run "$D" check-append-only main; expect_rc 0; expect_out "unchanged"
  printf '\n## c001-D03: A new record\n- owner: backend\n' >> planning/c001-share-links/DECISIONS.md; git commit -qam add
  run "$D" check-append-only main; expect_rc 0
  sed -i.bak 's/Tokens expire seven days/Tokens expire thirty days/' planning/c001-share-links/DECISIONS.md; rm -f planning/c001-share-links/DECISIONS.md.bak; git commit -qam edit
  run "$D" check-append-only main; expect_rc 1; expect_err "approved record c001-D02 was changed"
  git reset -q --hard HEAD~1
  perl -0pi -e 's/(## c001-D02.*?- status: )decided/$1superseded/s' planning/c001-share-links/DECISIONS.md; git commit -qam sup
  run "$D" check-append-only main; expect_rc 1; expect_err "may only become status: superseded, with superseded_by"
  perl -0pi -e 's/(## c001-D02.*?- status: superseded)/$1\n- superseded_by: c002-D01/s' planning/c001-share-links/DECISIONS.md; git commit -qam sup2
  run "$D" check-append-only main; expect_rc 0
  perl -0pi -e 's/## c001-D01:.*?(?=## c001-D02)//s' planning/c001-share-links/DECISIONS.md; git commit -qam del
  run "$D" check-append-only main; expect_rc 1; expect_err "approved record c001-D01 was removed"
  git rm -q planning/c001-share-links/DECISIONS.md; git commit -qm gone
  run "$D" check-append-only main; expect_rc 1; expect_err "was approved and is now deleted"
  run "$D" check-append-only no-such-ref; expect_rc 1; expect_err "unknown base ref"
}

test_a_branch_behind_base_does_not_delete_records_approved_after_it() {
  # found in the dry run: a pull request made before a planning merge failed "was approved and is
  # now deleted" for the record the planning merge brought in
  mkrepo r && cd r && mkdir -p planning/c001-share-links && decisions_ok c001 > planning/c001-share-links/DECISIONS.md
  git add -A && git commit -qm c001 && git switch -q -c stale
  echo x > other.txt && git add other.txt && git commit -qm "unrelated work"
  git switch -q main && mkdir -p planning/c002-more && decisions_ok c002 > planning/c002-more/DECISIONS.md
  git add -A && git commit -qm c002 && git switch -q stale
  run "$D" check-append-only main; expect_rc 0; expect_out "unchanged"
  git rm -q planning/c001-share-links/DECISIONS.md && git commit -qm gone   # hostile: still caught
  run "$D" check-append-only main; expect_rc 1; expect_err "c001-share-links/DECISIONS.md was approved and is now deleted"
  git switch -q --orphan lone && git rm -rq --cached . && echo y > y.txt && git add y.txt && git commit -qm lone
  run "$D" check-append-only main; expect_rc 1; expect_err "shares no history"
}

run_tests
