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
  setup; item 12-share "team: backend"; mkdir contracts && echo x > contracts/api.yaml; echo x > README.md; commit
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

test_unknown_base_is_an_error() {
  setup; item 12-share "team: backend"; commit
  run "$O" no-such-ref; expect_rc 2
}

test_unreadable_roster_fails() {
  setup; item 12-share "team: backend"; commit
  echo '{bad' > /tmp/factory-bad-roster.$$
  TEAMS_FILE=/tmp/factory-bad-roster.$$ run "$O" main; rm -f /tmp/factory-bad-roster.$$
  expect_rc 1; expect_err "unreadable"
}

run_tests
