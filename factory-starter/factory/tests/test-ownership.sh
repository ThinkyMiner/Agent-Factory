# Tests for factory/scripts/check-ownership.sh, the CI check that a pull request stays inside its
# team's paths. Each test builds a base branch with a roster and a pull-request branch on top.
. "$(dirname "$0")/lib.sh"
O="$SCRIPTS/check-ownership.sh"

setup() {
  mkrepo r && cd r
  mkdir -p factory server web product memory/observations
  cat > factory/teams.json <<'JSON'
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*"] },
             "backend":  { "owns": ["server/*", "db/*"] },
             "frontend": { "owns": ["web/*"] },
             "research": { "owns": ["research/*"], "active": false } },
  "append_only": ["memory/observations/*", "product/INBOX.md"] }
JSON
  printf '# Inbox\n- first\n' > product/INBOX.md
  echo old > memory/observations/old.md
  echo base > server/a.js
  git add -A && git commit -qm base
  git switch -q -c work/12-share
}
item() {  # item <id-slug> <team-line or "">: a work folder with a spec
  mkdir -p "work/$1"
  { echo '---'; echo "id: ${1%%-*}"; [ -n "$2" ] && echo "$2"; echo '---'; } > "work/$1/spec.md"
}
commit() { git add -A && git commit -qm change; }

test_single_team_mode_passes() {
  mkrepo r && cd r && git switch -q -c work/1-x && mkdir web && echo x > web/a.js && commit
  run "$O" main; expect_rc 0; expect_out "single-team mode"
}

test_owned_changes_pass() {
  setup; item 12-share "team: backend"; echo new > server/a.js; mkdir -p db && echo s > db/schema.sql; commit
  run "$O" main; expect_rc 0; expect_out "team backend"; expect_out "ownership: ok"
}

test_foreign_path_fails() {
  setup; item 12-share "team: backend"; echo x > web/app.js; commit
  run "$O" main; expect_rc 1; expect_out "web/app.js  (NOT OK: owned by frontend, not backend)"
}

test_unowned_path_fails() {
  setup; fake_gh; item 12-share "team: backend"; mkdir contracts && echo x > contracts/api.yaml; echo x > README.md; commit
  run "$O" main; expect_rc 1; expect_out "owned by no team"
}

test_factory_file_inside_team_pr_fails() {
  setup; item 12-share "team: backend"; echo x >> server/a.js; echo '#' >> factory/teams.json; commit
  run "$O" main; expect_rc 1; expect_out "factory changes go in their own pull request"
}

test_factory_only_pr_is_exempt() {
  setup; mkdir -p .claude teams/backend; echo x > .claude/settings.json; echo c > teams/backend/CHARTER.md; commit
  run "$O" main; expect_rc 0; expect_out "factory or human-owned files only"
}

test_factory_docs_are_factory_files() {
  setup; mkdir -p docs/factory; echo x > docs/factory/TEAMS.md; echo '#' >> factory/teams.json; commit
  run "$O" main; expect_rc 0; expect_out "factory or human-owned files only"
  setup; item 12-share "team: backend"; echo x >> server/a.js; mkdir -p docs/factory; echo x > docs/factory/TEAMS.md; commit
  jq '.teams.backend.owns += ["docs/*"]' factory/teams.json > "$TEST_TMP/wide.json"
  TEAMS_FILE="$TEST_TMP/wide.json" run "$O" main; expect_rc 1
  expect_out "docs/factory/TEAMS.md  (NOT OK: a factory file; factory changes go in their own pull request)"
}

test_human_owned_files_alone_are_exempt() {
  setup; echo '# Product' > CLAUDE.md; echo brief > product/BRIEF.md; echo '#' >> factory/teams.json; commit
  run "$O" main; expect_rc 0; expect_out "human-owned files only"
}

test_human_owned_files_in_team_pr_or_with_product_code_fail() {
  setup; item 12-share "team: backend"; echo x >> server/a.js; echo '# Product' > CLAUDE.md; commit
  run "$O" main; expect_rc 1; expect_out "CLAUDE.md  (NOT OK: owned by no team, not backend)"
  setup; echo '# Product' > CLAUDE.md; echo x >> server/a.js; commit
  run "$O" main; expect_rc 1; expect_err "exactly one work folder"
  setup; printf -- '- an idea\n' >> product/INBOX.md; commit     # INBOX is R0: not the human's gate
  run "$O" main; expect_rc 1; expect_err "exactly one work folder"
  setup; echo x > product/brief.md; commit                         # case matters for paths
  run "$O" main; expect_rc 1
}

test_feedback_sources_are_the_humans_even_inside_research() {
  setup; git switch -q main; jq '.teams.research.active = true' factory/teams.json > t && mv t factory/teams.json; git commit -qam roster
  git switch -q -c work/13-feedback; item 13-feedback "team: research"
  mkdir -p research/feedback; echo brief > research/feedback/notes.md; echo "- https://example.com/forum" > research/feedback/SOURCES.md; commit
  run "$O" main; expect_rc 1; expect_out "research/feedback/SOURCES.md  (NOT OK: owned by no team, not research)"
  expect_out "research/feedback/notes.md  (owned by research)"
  git switch -q -c human main; mkdir -p research/feedback; echo "- https://example.com/forum" > research/feedback/SOURCES.md; commit
  run "$O" main; expect_rc 0; expect_out "human-owned files only"
}

test_pr_cannot_widen_its_own_ownership() {
  setup; item 12-share "team: backend"
  jq '.teams.backend.owns += ["web/*"]' factory/teams.json > t && mv t factory/teams.json
  echo x > web/app.js; commit
  run "$O" main; expect_rc 1; expect_out "web/app.js  (NOT OK: owned by frontend"
}

test_exactly_one_work_folder() {
  setup; echo x > server/b.js; commit
  run "$O" main; expect_rc 1; expect_err "exactly one work folder"
  item 12-share "team: backend"; item 13-more "team: backend"; commit
  run "$O" main; expect_rc 1; expect_err "has 2"
}

test_spec_team_rules() {
  setup; mkdir -p work/12-share && echo notes > work/12-share/log.md; commit
  run "$O" main; expect_rc 1; expect_err "no spec.md"
  item 12-share "team: marketing"; commit
  run "$O" main; expect_rc 1; expect_err "not an active team"
  item 12-share "team: research"; commit
  run "$O" main; expect_rc 1; expect_err "not an active team"
  item 12-share ""; echo x >> server/a.js; commit
  run "$O" main; expect_rc 0; expect_out "team backend"
}

test_spec_claiming_another_team_cannot_reach_back() {
  setup; item 12-share "team: frontend"; echo x >> server/a.js; commit
  run "$O" main; expect_rc 1; expect_out "server/a.js  (NOT OK: owned by backend, not frontend)"
}

test_append_only_rules() {
  setup; item 12-share "team: backend"
  echo n > memory/observations/2026-01-01-12-share.md; printf -- '- second\n' >> product/INBOX.md; commit
  run "$O" main; expect_rc 0; expect_out "new append-only file"; expect_out "appends only"
  printf '# Inbox\n- rewritten\n' > product/INBOX.md; commit
  run "$O" main; expect_rc 1; expect_out "REMOVES lines"
}

test_append_only_delete_fails() {
  setup; item 12-share "team: backend"; git rm -q memory/observations/old.md; commit
  run "$O" main; expect_rc 1; expect_out "DELETES an append-only file"
}

test_hostile_file_names() {
  setup; item 12-share "team: backend"
  echo x > 'server/with space.js'; echo x > $'server/new\nline.js'; echo x > 'server/$(touch pwned).js'
  echo x > 'server/é✓.js'; commit
  run "$O" main; expect_rc 0
  [ ! -e pwned ] || fail "a file name was executed"
  mkdir -p $'web/sneaky\nserver' && echo x > $'web/sneaky\nserver/x.js'; commit
  run "$O" main; expect_rc 1
}

test_rename_out_of_owned_path_fails() {
  setup; item 12-share "team: backend"; git mv server/a.js web/a.js; commit
  run "$O" main; expect_rc 1; expect_out "web/a.js  (NOT OK"
}

# plan <cycle>: a planning branch with that cycle's record
plan() {
  git switch -q main && git switch -q -c "planning/$1"
  mkdir -p "planning/$1"; echo brief > "planning/$1/BRIEF.md"; echo '{}' > "planning/$1/discussion.jsonl"
}

test_planning_pr_carries_only_its_cycle() {
  setup; plan c002-share; commit
  run "$O" main; expect_rc 0; expect_out "planning pull request for c002-share"; expect_out "ownership: ok"
  echo x >> server/a.js; commit
  run "$O" main; expect_rc 1; expect_out "server/a.js  (NOT OK: a planning pull request changes only planning/c002-share/)"
  setup; plan c002-share; mkdir -p planning/c003-other; echo x > planning/c003-other/BRIEF.md; commit
  run "$O" main; expect_rc 1; expect_out "planning/c003-other/BRIEF.md  (NOT OK"
  setup; plan c002-share; echo '#' >> factory/teams.json; commit
  run "$O" main; expect_rc 1; expect_out "factory/teams.json  (NOT OK"
  setup; plan c002-share; mkdir -p work/12-share; echo x > work/12-share/spec.md; commit
  run "$O" main; expect_rc 1; expect_out "work/12-share/spec.md  (NOT OK"
}

test_planning_pr_may_touch_earlier_decisions() {
  setup; git switch -q main; mkdir -p planning/c001-first; echo '## c001-D01: x' > planning/c001-first/DECISIONS.md; commit
  plan c002-share; echo '- status: superseded' >> planning/c001-first/DECISIONS.md; commit
  run "$O" main; expect_rc 0; expect_out "planning/c001-first/DECISIONS.md  (an earlier cycle's decisions (superseding only))"
}

test_planning_branch_from_ci_env_and_bad_names() {
  setup; item 12-share "team: backend"; echo new > server/a.js; commit
  HEAD_REF=planning/c002-share run "$O" main; expect_rc 1; expect_out "NOT OK: a planning pull request"
  HEAD_REF=work/12-share run "$O" main; expect_rc 0; expect_out "team backend"
  for b in 'planning/../x' 'planning/c1-x' 'planning/c002-Share' 'planning/c002-$(id)' 'planning/'; do
    HEAD_REF=$b run "$O" main; expect_rc 1; expect_err "is not a planning cycle's branch"
  done
}

test_team_pr_cannot_touch_planning() {
  setup; item 12-share "team: backend"; mkdir -p planning/c002-share; echo x > planning/c002-share/discussion.jsonl; commit
  run "$O" main; expect_rc 1; expect_out "owned by orchestrator, not backend"
}

test_unknown_base_is_an_error() {
  setup; item 12-share "team: backend"; commit
  run "$O" no-such-ref; expect_rc 2
}

# ---- contracts ----

# gh_issue <n> <label>...: issue n in the fake gh, with exactly these labels
gh_issue() {
  local n=$1; shift
  jq -n --argjson n "$n" '[{number: $n, title: "t", body: "", state: "OPEN", labels: ($ARGS.positional | map({name: .})), comments: []}]' --args "$@" > "$FAKE_GH/issues.json"
}

test_team_pr_changes_contracts_only_under_an_accepted_contract_change_ticket() {
  setup; fake_gh; git switch -q main && mkdir contracts && echo v1 > contracts/api.yaml && commit && git switch -q -C work/12-share
  item 12-share "team: backend"; echo v2 > contracts/api.yaml; echo x >> server/a.js; commit
  run "$O" main; expect_rc 1; expect_out "contracts/api.yaml  (NOT OK: a contract; cannot read issue #12"
  for st in accepted done; do
    gh_issue 12 ticket type:contract-change to:backend from:frontend "state:$st"
    run "$O" main; expect_rc 0; expect_out "contracts/api.yaml  (contract change under ticket #12)"
  done
  for st in open declined disputed verified withdrawn; do
    gh_issue 12 ticket type:contract-change to:backend "state:$st"
    run "$O" main; expect_rc 1; expect_out "ticket #12 is not accepted"
  done
  gh_issue 12 ticket type:contract-change to:frontend state:accepted; run "$O" main; expect_rc 1; expect_out "(no label to:backend)"
  gh_issue 12 ticket type:request to:backend state:accepted; run "$O" main; expect_rc 1; expect_out "(no label type:contract-change)"
  gh_issue 12 type:contract-change to:backend state:accepted; run "$O" main; expect_rc 1; expect_out "(no label ticket)"
  gh_issue 12 ticket type:contract-change 'to:backend,state:accepted'; run "$O" main; expect_rc 1        # one label with a comma
  gh_issue 12 ticket type:contract-change to:backend 'state:accepted ' 'state:accepted-not'; run "$O" main; expect_rc 1
  gh_issue 12 ticket type:contract-change to:backends state:accepted; run "$O" main; expect_rc 1; expect_out "(no label to:backend)"
  gh_issue 12 not-a-ticket type:contract-change to:backend state:accepted; run "$O" main; expect_rc 1; expect_out "(no label ticket)"
  gh_issue 12 ticket type:contract-change to:backend state:accepted
  jq '.teams.backend.owns += ["contracts/*"]' factory/teams.json > "$TEST_TMP/wide.json"
  echo 'issue view' > "$FAKE_GH/fail"
  TEAMS_FILE="$TEST_TMP/wide.json" run "$O" main; expect_rc 1; expect_out "NOT OK: a contract; cannot read issue #12"   # a roster glob is no ticket
  rm "$FAKE_GH/fail"; head -c 40 "$FAKE_GH/issues.json" > i && mv i "$FAKE_GH/issues.json"
  run "$O" main; expect_rc 1; expect_out "cannot read issue #12"                                           # truncated JSON
  gh_issue 12 ticket type:contract-change to:backend state:accepted; git rm -q contracts/api.yaml; mkdir -p contracts; echo n > contracts/new.yaml; commit
  : > "$FAKE_GH/log"; run "$O" main; expect_rc 0
  expect_out "contracts/api.yaml  (contract change under ticket #12)"; expect_out "contracts/new.yaml  (contract change"  # removing one, too
  expect_eq "$(grep -c 'issue view' "$FAKE_GH/log")" 1 "one gh call per run"
}

test_team_pr_contract_ticket_id_comes_from_the_work_folder() {
  setup; fake_gh; gh_issue 12 ticket type:contract-change to:backend state:accepted
  for id in 'share' '012' '12$(id)' '12`id`' 'x12'; do
    git switch -q main; git branch -q -D work/12-share; git switch -q -c work/12-share
    item "$id-share" "team: backend"; mkdir -p contracts && echo x > contracts/api.yaml; commit
    run "$O" main; expect_rc 1; expect_out "does not start with an issue number"
  done
  ! grep -q 'issue view' "$FAKE_GH/log" 2>/dev/null || fail "asked GitHub about a bad id"
}

# promoted <cycle> <path>...: on planning/<cycle>, each path promoted as contracts.sh does it
promoted() {
  local c=$1 p i=0; shift
  for p in "$@"; do
    i=$((i + 1)); mkdir -p "$(dirname "$p")"; echo "openapi: 3.1.0" > "$p"
    printf '## %s-D%02d: Contract %s\n- owner: backend\n- contract: %s#/paths/~1shares\n### Decision\nx\n\n' "${c%%-*}" "$i" "$i" "$p" >> "planning/$c/DECISIONS.md"
    jq -cn --arg c "$c" --arg p "$p" '{ts: "2026-11-15T10:00:00Z", cycle: $c, attachment: "backend-api.yaml", path: $p, decisions: ["x"]}' >> "planning/$c/contracts.jsonl"
  done
}

test_planning_pr_adds_the_contracts_it_promoted() {
  setup; plan c002-share; promoted c002-share contracts/api.openapi.yaml contracts/design/tokens.json; commit
  run "$O" main; expect_rc 0
  expect_out "contracts/api.openapi.yaml  (a new contract this cycle decides)"; expect_out "contracts/design/tokens.json  (a new contract"
  echo extra > contracts/other.yaml; commit
  run "$O" main; expect_rc 1; expect_out "contracts/other.yaml  (NOT OK: not promoted by contracts.sh"
  setup; plan c002-share; promoted c002-share contracts/api.yaml; sed -i.bak 's/c002-share/c003-other/' planning/c002-share/contracts.jsonl; commit
  run "$O" main; expect_rc 1; expect_out "not promoted by contracts.sh"                                   # another cycle's line
  setup; plan c002-share; promoted c002-share contracts/api.yaml; sed -i.bak '/^- contract:/d' planning/c002-share/DECISIONS.md
  printf -- '- contract: contracts/api.yaml\n' >> planning/c002-share/DECISIONS.md; commit                # only in a section's text
  run "$O" main; expect_rc 1; expect_out "no record in planning/c002-share/DECISIONS.md names it"
}

test_planning_pr_contract_records_hostile_and_malformed() {
  setup; plan c002-share; promoted c002-share contracts/api.yaml
  printf '{"cycle":"c002-share","path":"contracts/api.y\n{not json\n[]\n' > planning/c002-share/contracts.jsonl
  jq -cn '{cycle: "c002-share", path: "contracts/api.yaml"}' | perl -pe 's/\n/\r\n/' >> planning/c002-share/contracts.jsonl
  perl -pi -e 's/\n/\r\n/' planning/c002-share/DECISIONS.md; commit
  run "$O" main; expect_rc 0; expect_out "contracts/api.yaml  (a new contract"                            # CRLF and junk lines
  printf '{"cycle":"c002-share","path":"contracts/api.y' > planning/c002-share/contracts.jsonl; commit
  run "$O" main; expect_rc 1; expect_out "not promoted"                                                  # truncated JSON
  setup; plan c002-share; promoted c002-share 'contracts/$(touch pwned).yaml' $'contracts/new\nline.yaml' 'contracts/a b.yaml'; commit
  run "$O" main; expect_rc 1; expect_out "not a clean path of a file under contracts/"
  [ ! -e pwned ] || fail "a file name was executed"
  setup; plan c002-share; promoted c002-share contracts/api.yaml; rm contracts/api.yaml; ln -s ../factory/teams.json contracts/api.yaml; commit
  run "$O" main; expect_rc 1; expect_out "contracts/api.yaml  (NOT OK: not a regular file)"
  setup; plan c002-share; mkdir -p planning/c002-share; : > planning/c002-share/DECISIONS.md; mkdir contracts; echo x > contracts/api.yaml; commit
  run "$O" main; expect_rc 1; expect_out "not promoted"                                                  # no contracts.jsonl at all
}

test_planning_pr_never_changes_an_approved_contract() {
  setup; git switch -q main; mkdir contracts && echo v1 > contracts/api.yaml && commit
  plan c002-share; promoted c002-share contracts/api.yaml; commit
  run "$O" main; expect_rc 1; expect_out "contracts/api.yaml  (NOT OK: an approved contract changes only under a contract-change ticket)"
  setup; git switch -q main; mkdir contracts && echo v1 > contracts/old.yaml && commit
  plan c002-share; git rm -q contracts/old.yaml; commit
  run "$O" main; expect_rc 1; expect_out "contracts/old.yaml  (NOT OK: an approved contract"
}

# ---- integration ----

# integ <f>: origin/feature/<f> (a ref, as a clone has it) with a backend item and research's
# acceptance.md; then branch integrate/<f> from it with every kind of integration record.
integ() {
  git switch -q main && git switch -q -c "feature/$1"
  item 12-share "team: backend"; echo works > server/a.js; mkdir -p "features/$1"; echo crit > "features/$1/acceptance.md"; commit
  git update-ref "refs/remotes/origin/feature/$1" HEAD
  git switch -q -c "integrate/$1"; git branch -q -D "feature/$1"
  mkdir -p "tests/e2e/$1/ui"; echo t > "tests/e2e/$1/ac1.sh"; echo t > "tests/e2e/$1/ui/ac2.spec.ts"
  for r in e2e-report.md attribution.md FEATURE.md tickets.jsonl; do echo x > "features/$1/$r"; done; commit
}

test_integration_pr_brings_the_feature_branch_and_its_records() {
  setup; integ f001-share
  HEAD_REF=integrate/f001-share run "$O" main; expect_rc 0; expect_out "integration pull request for f001-share"
  expect_out "server/a.js  (as feature/f001-share brings it)"; expect_out "work/12-share/spec.md  (as feature/f001-share brings it)"
  expect_out "features/f001-share/acceptance.md  (as feature/f001-share brings it)"
  expect_out "tests/e2e/f001-share/ui/ac2.spec.ts  (this feature's integration record)"
  local r; for r in e2e-report.md attribution.md FEATURE.md tickets.jsonl; do expect_out "features/f001-share/$r  (this feature's integration record)"; done
  run "$O" main; expect_rc 0; expect_out "integration pull request"                    # the branch name from git
  git rm -q "features/f001-share/attribution.md"; commit
  HEAD_REF=integrate/f001-share run "$O" main; expect_rc 0                              # a record may go
}

test_integration_pr_changes_nothing_the_feature_branch_does_not() {
  local c
  for c in 'echo sneaky > server/a.js' 'echo x > web/new.js' 'echo x >> work/12-share/spec.md' "echo '#' >> factory/teams.json" \
           'mkdir -p .github && echo x > .github/ci.yml' 'echo changed > features/f001-share/acceptance.md' \
           'echo accept > features/f001-share/acceptance-review.md' 'chmod +x server/a.js' 'echo x > README.md' \
           'mkdir -p tests/e2e/f002-other && echo t > tests/e2e/f002-other/x.sh' 'mkdir -p features/f002-other && echo x > features/f002-other/e2e-report.md' \
           'mkdir -p tests/e2e && echo t > tests/e2e/helpers.sh' 'mkdir -p features/f001-share/x && echo x > features/f001-share/x/FEATURE.md' \
           'echo x > features/f001-share/notes.md' 'mkdir -p tests/e2e/f001-sharex && echo t > tests/e2e/f001-sharex/a.sh' \
           'mkdir -p work/13-x && echo x > work/13-x/spec.md' 'git rm -q product/INBOX.md'; do
    setup; integ f001-share; eval "$c"; commit
    HEAD_REF=integrate/f001-share run "$O" main; [ "$RC" = 1 ] || fail "[$c] passed: $(cat "$OUT")"
    expect_out "(NOT OK: not as on feature/f001-share; changes reach main through feature/f001-share's pull requests)"
  done
}

test_integration_pr_takes_main_moving_on_but_not_reverting_it() {
  setup; git switch -q main; printf '%s\n' 1 2 3 4 5 6 7 8 9 > server/c.js; commit
  git switch -q -c feature/f001-share; item 12-share "team: backend"; perl -pi -e 's/^1$/one/' server/c.js; echo works > server/a.js; commit
  git update-ref refs/remotes/origin/feature/f001-share HEAD
  git switch -q main; perl -pi -e 's/^9$/nine/' server/c.js; echo hotfix > server/d.js; commit     # main moves on, in the same file too
  git switch -q -c integrate/f001-share refs/remotes/origin/feature/f001-share; git merge -q --no-edit main >/dev/null
  mkdir -p tests/e2e/f001-share; echo t > tests/e2e/f001-share/ac1.sh; commit
  HEAD_REF=integrate/f001-share run "$O" main; expect_rc 0; expect_out "server/c.js  (as feature/f001-share brings it)"
  perl -pi -e 's/^nine$/9/' server/c.js; commit                                                  # undoing main's change
  HEAD_REF=integrate/f001-share run "$O" main; expect_rc 1; expect_out "server/c.js  (NOT OK"
  git reset -q --hard HEAD~1; echo base > server/d.js; commit                                    # or a file only main changed
  HEAD_REF=integrate/f001-share run "$O" main; expect_rc 1; expect_out "server/d.js  (NOT OK"
}

test_integration_branch_names_and_base() {
  setup; integ f001-share
  local b
  for b in 'integrate/../x' 'integrate/f1-x' 'integrate/F001-share' 'integrate/f001-share/x' 'integrate/$(touch pwned)' 'integrate/' \
           $'integrate/f001-share\n' 'integrate/f001-share '; do
    HEAD_REF=$b run "$O" main; [ "$RC" = 1 ] || fail "[$b] gave exit $RC"; expect_err "is not a feature's integration branch"
  done
  [ ! -e pwned ] || fail "a branch name was run"
  HEAD_REF=integrate/f002-other run "$O" main; expect_rc 1; expect_err "origin/feature/f002-other does not exist"
  git branch -q other main
  HEAD_REF=integrate/f001-share run "$O" other; expect_rc 1; expect_err "goes to main only, not other"
  HEAD_REF=integrate/f001-share run "$O" origin/feature/f001-share; expect_rc 1; expect_err "goes to main only"
  HEAD_REF=Integrate/f001-share run "$O" main; expect_rc 1; expect_out "pull request for work/12-share, team backend"   # no look-alike gets the case
}

test_team_pr_cannot_carry_integration_records() {
  local p
  for p in tests/e2e/f001-share/x.test features/f001-share/e2e-report.md features/f001-share/attribution.md features/f001-share/FEATURE.md \
           features/f001-share/tickets.jsonl tests/e2e/helpers.ts tests/e2e TESTS/E2E/f001/x.test Features/f001-share/E2E-Report.md; do
    setup; item 12-share "team: backend"; echo x >> server/a.js; mkdir -p "$(dirname "$p")"; echo x > "$p"; commit
    jq '.teams.backend.owns += ["tests/*", "features/*", "TESTS/*", "Features/*"]' factory/teams.json > "$TEST_TMP/wide.json"
    TEAMS_FILE="$TEST_TMP/wide.json" run "$O" main; [ "$RC" = 1 ] || fail "$p passed in a team's pull request"
    expect_out "$p  (NOT OK: an integration record; it reaches main only through integrate/<feature>)"
  done
  setup; item 12-share "team: backend"; mkdir -p features/f001-share tests/unit; echo x > features/f001-share/acceptance.md; echo x > tests/unit/a.test; commit
  jq '.teams.backend.owns += ["tests/*", "features/*"]' factory/teams.json > "$TEST_TMP/wide.json"
  TEAMS_FILE="$TEST_TMP/wide.json" run "$O" main; expect_rc 0; expect_out "features/f001-share/acceptance.md  (owned by backend)"   # not a record
  expect_out "tests/unit/a.test  (owned by backend)"
}

test_unreadable_roster_fails() {
  setup; item 12-share "team: backend"; commit
  echo '{bad' > /tmp/factory-bad-roster.$$
  TEAMS_FILE=/tmp/factory-bad-roster.$$ run "$O" main; rm -f /tmp/factory-bad-roster.$$
  expect_rc 1; expect_err "unreadable"
}

run_tests
