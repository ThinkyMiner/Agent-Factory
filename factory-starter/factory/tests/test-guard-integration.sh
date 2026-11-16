# Tests for the integration parts of factory/hooks/guard.sh (team mode). The e2e report, FEATURE.md and
# tickets.jsonl are written only by integrate.sh and feature.sh; tests/e2e/ and attribution.md only by
# the orchestrator's session (integration-qa), even when the roster gives another team a covering glob.
. "$(dirname "$0")/lib.sh"
G="$HOOKS/guard.sh"

# edit <tool> <path>: a write payload in a single-team project at $TEST_TMP/root
edit() {
  mkdir -p "$TEST_TMP/root"
  jq -n --arg t "$1" --arg p "$2" '{tool_name:$t, tool_input:{file_path:$p}}' > "$TEST_TMP/in"
  CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < "$TEST_TMP/in"
}
# tw <team> <checkout> <tool> <path>, tb <team> <checkout> <command>: as that team in that checkout
tw() {
  jq -n --arg t "$3" --arg p "$4" '{tool_name:$t, tool_input:{file_path:$p, old_string:"a", new_string:"b"}}' > "$TEST_TMP/in"
  FACTORY_TEAM="$1" CLAUDE_PROJECT_DIR="$2" run "$G" < "$TEST_TMP/in"
}
tb() {
  jq -n --arg c "$3" '{tool_name:"Bash", tool_input:{command:$c}}' > "$TEST_TMP/in"
  FACTORY_TEAM="$1" CLAUDE_PROJECT_DIR="$2" run "$G" < "$TEST_TMP/in"
}
blocks()  { [ "$RC" = 2 ] || fail "expected the guard to block (exit 2), got $RC: $1"; }
allows()  { [ "$RC" = 0 ] || fail "expected the guard to allow (exit 0), got $RC: $1. $(cat "$ERR")"; }
# wide: the roster gives the orchestrator the records (as `factory teams init` does) and gives
# backend and frontend globs that cover them, in every checkout.
wide() {
  local d
  for d in "$MAIN" "$BE" "$FE"; do
    jq '.teams.orchestrator.owns += ["tests/e2e/*", "features/*/e2e-report.md", "features/*/attribution.md", "features/*/FEATURE.md", "features/*/tickets.jsonl"]
        | .teams.backend.owns += ["tests/*", "features/*"] | .teams.frontend.owns += ["*"]' "$d/factory/teams.json" > "$d/t.json" && mv "$d/t.json" "$d/factory/teams.json"
  done
}

test_single_team_factories_keep_todays_behaviour() {
  edit Write features/f001-x/e2e-report.md; allows "no roster: a product file"
  edit Write tests/e2e/f001-x/ac1.test.ts; allows "no roster: a product file"
}

test_e2e_report_feature_md_and_tickets_only_through_the_scripts() {
  team_setup; wide
  local p c
  for p in features/f001-x/e2e-report.md features/f001-x/FEATURE.md features/f001-x/tickets.jsonl FEATURES/F001-X/E2E-REPORT.MD \
           features/f001-x/sub/../FEATURE.md; do
    tw orchestrator "$MAIN" Write "$p"; blocks "orchestrator Write $p"
    tw orchestrator "$MAIN" Edit "$MAIN/$p"; blocks "orchestrator Edit $p, absolute"
    tw backend "$BE" Write "$p"; blocks "backend $p"; tw frontend "$FE" Write "$p"; blocks "frontend $p"
  done
  expect_err "written only by the integration scripts"
  for c in 'echo pass > features/f001-x/e2e-report.md' "sed -i '' s/fail/pass/ features/f001-x/e2e-report.md" \
           'cp /tmp/r.md features/f001-x/e2e-report.md' 'printf x | tee features/f001-x/FEATURE.md' \
           "echo '{}' >> features/f001-x/tickets.jsonl" 'rm features/f001-x/FEATURE.md' 'mv /tmp/x features/f001-x/tickets.jsonl'; do
    tb orchestrator "$MAIN" "$c"; blocks "orchestrator: $c"
  done
  mkdir -p "$MAIN/features/f001-x" && ln -s e2e-report.md "$MAIN/features/f001-x/link.md"
  tw orchestrator "$MAIN" Write features/f001-x/link.md; blocks "a symlink to the report"; expect_err "written only by the integration scripts"
  tb orchestrator "$MAIN" 'factory/scripts/integrate.sh run f001-x'; allows "the script itself"
  tb orchestrator "$MAIN" 'factory/scripts/feature.sh render f001-x'; allows "the script itself"
}

test_e2e_tests_and_attribution_are_the_orchestrators_only() {
  team_setup; wide
  tw orchestrator "$MAIN" Write tests/e2e/f001-x/ac1.test.ts; allows "integration-qa writes the e2e tests"
  tw orchestrator "$MAIN" Write features/f001-x/attribution.md; allows "integration-qa writes the attribution"
  tb orchestrator "$MAIN" 'mkdir -p tests/e2e/f001-x'; allows "its folder"
  local p c
  for p in tests/e2e/f001-x/ac1.test.ts tests/e2e/helpers.ts TESTS/E2E/x.ts tests/unit/../e2e/x.ts features/f001-x/attribution.md tests/e2e; do
    tw backend "$BE" Write "$p"; blocks "backend $p, though its roster glob covers it"
    tw frontend "$FE" Write "$p"; blocks "frontend $p, though it owns *"
  done
  expect_err "integration-qa writes it in the orchestrator's checkout"
  for c in 'rm -rf tests/e2e' 'mkdir -p tests/e2e/f001-x' 'echo x > tests/e2e/f001-x/a.ts' 'mv /tmp/x tests/e2e' \
           "sed -i '' s/410/200/ tests/e2e/f001-x/ac2.test.ts" 'cp /tmp/a.md features/f001-x/attribution.md'; do
    tb backend "$BE" "$c"; blocks "backend: $c"
  done
  mkdir -p "$BE/tests/e2e" && ln -s e2e "$BE/tests/link"
  tw backend "$BE" Write tests/link/x.ts; blocks "a symlink into tests/e2e"; expect_err "integration record"
  tw backend "$BE" Write tests/unit/a.test.ts; allows "its glob still covers the rest of tests/"
  tw backend "$BE" Write features/f001-x/notes.md; allows "and the rest of features/"
}

test_the_orchestrator_needs_the_roster_to_give_it_the_records() {
  team_setup                                    # the roster gives the orchestrator planning/* only
  tw orchestrator "$MAIN" Write tests/e2e/f001-x/ac1.test.ts; blocks "not in its roster"
  tw orchestrator "$MAIN" Write features/f001-x/attribution.md; blocks "not in its roster"
}

test_only_the_orchestrator_pushes_or_targets_an_integration_branch() {
  team_setup
  local c
  for c in 'git push origin integrate/f001-x' 'git push -u origin integrate/f001-x' 'git push origin HEAD:integrate/f001-x' \
           'git push origin HEAD:refs/heads/integrate/f001-x' 'git -C . push origin work/12-x:integrate/f001-x' \
           'cd server && git push origin Integrate/f001-x' 'gh pr create --base integrate/f001-x --title t --body b' \
           'gh pr create -B integrate/f001-x --title t' 'gh pr create --title t --base=integrate/f001-x' 'gh pr edit 7 --base integrate/f001-x'; do
    tb backend "$BE" "$c"; blocks "backend: $c"
  done
  expect_err "orchestrator's integration branch"
  git -C "$BE" switch -q -c integrate/f001-x
  tb backend "$BE" 'git push'; blocks "a bare push from an integration branch"
  tb backend "$BE" 'git push origin'; blocks "a push of the current branch"
  git -C "$BE" switch -q team/backend
  tb backend "$BE" 'git push -u origin work/12-share'; allows "its own work branch"
  tb backend "$BE" 'gh pr create --base feature/f001-x --title t --body b'; allows "into the feature branch"
  tb backend "$BE" 'git push origin work/integrate-docs'; allows "a work branch whose name merely contains the word"
  tb orchestrator "$MAIN" 'git push origin integrate/f001-x'; allows "the orchestrator"
  mkdir -p "$TEST_TMP/root"; jq -n '{tool_name:"Bash", tool_input:{command:"git push origin integrate/f001-x"}}' > in
  CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < in; allows "single-team mode keeps today's behaviour"
}

test_identity_and_checkout_still_decide() {
  team_setup; wide
  tw orchestrator "$BE" Write tests/e2e/f001-x/a.ts; blocks "the orchestrator's name in backend's worktree"
  tw backend "$MAIN" Write tests/e2e/f001-x/a.ts; blocks "backend's name in the main checkout"
  tw "" "$MAIN" Write tests/e2e/f001-x/a.ts; blocks "no team"
  tb backend "$BE" "echo x > $MAIN/tests/e2e/f001-x/a.ts"; blocks "into the main checkout from a worktree"
  FACTORY_ALLOW_SELF_EDIT=1 tw backend "$BE" Write tests/e2e/f001-x/a.ts; blocks "self-edit opens factory files only"
}

run_tests
