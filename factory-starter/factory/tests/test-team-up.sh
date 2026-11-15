# Tests for factory/scripts/team-up.sh: worktrees per team, one Herdr tab + claude per team, each
# started as the factory's bot, and a tab for the sweep. gh and the keychain are faked too.
# herdr-app is faked on PATH: it records its argv in $TEST_TMP/app.log and keeps the window's
# layout (spaces > tabs > terminals, the shape `herdr-app ls` prints) in fake/layout.
. "$(dirname "$0")/lib.sh"
U="$SCRIPTS/team-up.sh"

fake_app() {
  mkdir -p "$TEST_TMP/fake" && echo '{"spaces":[]}' > "$TEST_TMP/fake/layout"
  cat > "$TEST_TMP/fake/herdr-app" <<'SH'
#!/usr/bin/env bash
S=$(dirname "$0"); L="$S/layout"; printf '%s\n' "$*" >> "$TEST_TMP/app.log"
[ -f "$S/closed" ] && { echo "no window" >&2; exit 1; }
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
n=$(grep -c '^do ' "$TEST_TMP/app.log"); term="t$n"
case "$1 ${2:-}" in
  "ls ") cat "$L" ;;
  "do space.new") tab=$(arg --tab "$@")
     [ -f "$S/fail-$tab" ] && { echo '{"error":"could not start"}'; exit 1; }
     jq --arg n "$(arg --name "$@")" --arg tab "$tab" --arg t "$term" \
       '.spaces += [{id: "sp1", name: $n, tabs: [{name: $tab, terminals: [{terminal: $t, status: "idle", app: "claude-code"}]}]}]' "$L" > "$L.new" && mv "$L.new" "$L"
     jq -nc --arg t "$term" '{space: "sp1", tab: "tb1", terminal: $t}' ;;
  "do tab.new") tab=$(arg --name "$@"); st=idle; [ -f "$S/block-$tab" ] && st=blocked
     [ -f "$S/fail-$tab" ] && { echo '{"error":"could not start"}'; exit 1; }
     jq --arg s "$(arg --space "$@")" --arg tab "$tab" --arg t "$term" --arg st "$st" \
       '(.spaces[] | select(.id == $s) | .tabs) += [{name: $tab, terminals: [{terminal: $t, status: $st, app: "claude-code"}]}]' "$L" > "$L.new" && mv "$L.new" "$L"
     jq -nc --arg t "$term" '{tab: "tb2", terminal: $t}' ;;
  *) exit 3 ;;
esac
SH
  chmod +x "$TEST_TMP/fake/herdr-app"
  export PATH="$TEST_TMP/fake:$PATH"
}
layout() { jq "$1" "$TEST_TMP/fake/layout" > "$TEST_TMP/l" && mv "$TEST_TMP/l" "$TEST_TMP/fake/layout"; }
argv() { jq -nc --arg t "$1" --arg a "$2" --arg b "$SCRIPTS/bot-session.sh" '["env", "FACTORY_TEAM=\($t)", $b, "claude", "--agent", $a, "-n", $t]'; }
BOT=ghp_factorybot0000000000000000000000

kit() {  # a team-mode factory in $TEST_TMP/app, cwd inside it
  mkrepo app && cd app && mkdir -p factory .claude/agents
  cat > factory/teams.json <<'JSON'
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*"] },
             "backend":  { "owns": ["server/*"] },
             "frontend": { "owns": ["web/*"], "active": false } } }
JSON
  echo agent > .claude/agents/orchestrator.md; echo agent > .claude/agents/backend-lead.md
  git add -A && git commit -qm roster
  fake_gh; fake_keychain "$BOT"
}
BE() { echo "$TEST_TMP/app.teams/backend"; }

test_single_team_mode_refuses() {
  mkrepo app && cd app
  run "$U" --print; expect_rc 1; expect_err "single team"
}

test_print_makes_worktrees_and_prints_launch_commands() {
  kit
  run "$U" --print; expect_rc 0
  expect_out "agents work on GitHub as $BOT"
  expect_out "cd $TEST_TMP/app && FACTORY_TEAM=orchestrator $SCRIPTS/bot-session.sh claude --agent orchestrator -n orchestrator"
  expect_out "cd $(BE) && FACTORY_TEAM=backend $SCRIPTS/bot-session.sh claude --agent backend-lead -n backend"
  expect_out "cd $TEST_TMP/app && $SCRIPTS/bot-session.sh bash $SCRIPTS/sweep.sh --loop"
  expect_eq "$(git -C "$(BE)" rev-parse --abbrev-ref HEAD)" team/backend
  [ ! -e "$TEST_TMP/app.teams/frontend" ] || fail "launched an inactive team"
  run "$U" --print; expect_rc 0
  git worktree remove "$(BE)"; run "$U" --print; expect_rc 0     # reuses the existing branch
  expect_eq "$(git -C "$(BE)" rev-parse --abbrev-ref HEAD)" team/backend
}

test_from_origin_main_when_there_is_a_remote() {
  kit; git clone -q --bare . ../origin.git; git remote add origin ../origin.git; git fetch -q origin
  git commit -q --allow-empty -m local-only
  run "$U" --print; expect_rc 0
  expect_eq "$(git -C "$(BE)" rev-parse HEAD)" "$(git rev-parse origin/main)"
}

test_runs_from_a_worktree_too() {
  kit; run "$U" --print; cd "$(BE)"
  run "$U" --print; expect_rc 0; expect_out "cd $TEST_TMP/app && FACTORY_TEAM=orchestrator $SCRIPTS/bot-session.sh"
}

test_foreign_directory_in_the_way_fails() {
  kit; mkdir -p ../app.teams/backend && echo mine > ../app.teams/backend/file
  run "$U" --print; expect_rc 1; expect_err "not a worktree"
  expect_eq "$(cat ../app.teams/backend/file)" mine
}

test_hostile_roster_is_refused() {
  kit
  for t in '../escape' '$(touch pwned)' 'Backend' 'a b' $'backend\nfrontend'; do
    jq --arg t "$t" '.teams[$t] = {owns: ["x/*"]}' factory/teams.json > t.json && cp t.json factory/teams.json
    run "$U" --print; expect_rc 1; expect_err "invalid team name"
    git checkout -q factory/teams.json
  done
  [ ! -e ../escape ] && [ ! -e pwned ] && [ ! -e ../app.teams/escape ] || fail "a hostile name made something"
  jq '.teams.backend.agent = "../../x"' factory/teams.json > t.json && cp t.json factory/teams.json
  run "$U" --print; expect_rc 1; expect_err "invalid agent name"
}

test_missing_agent_file_fails() {
  kit; rm .claude/agents/backend-lead.md
  run "$U" --print; expect_rc 1; expect_err "backend-lead.md does not exist"
}

test_herdr_launch_and_rerun_is_idempotent() {
  kit; fake_app
  run "$U"; expect_rc 0; expect_out "2 started"; expect_out "sweep: started in t3"
  grep -qxF -- "do space.new --name app --folder $TEST_TMP/app --tab orchestrator --argv $(argv orchestrator orchestrator)" "$TEST_TMP/app.log" || fail "no space for the orchestrator: $(cat "$TEST_TMP/app.log")"
  grep -qxF -- "do tab.new --space sp1 --name backend --folder $(BE) --argv $(argv backend backend-lead)" "$TEST_TMP/app.log" || fail "backend tab wrong: $(cat "$TEST_TMP/app.log")"
  sw=$(jq -nc --arg b "$SCRIPTS/bot-session.sh" --arg s "$SCRIPTS/sweep.sh" '[$b, "bash", $s, "--loop"]')
  grep -qxF -- "do tab.new --space sp1 --name sweep --folder $TEST_TMP/app --argv $sw" "$TEST_TMP/app.log" || fail "sweep tab wrong: $(cat "$TEST_TMP/app.log")"
  : > "$TEST_TMP/app.log"
  run "$U"; expect_rc 0; expect_out "0 started"; expect_out "backend: already running in t2"; expect_out "sweep: already running in t3"
  grep -q '^do ' "$TEST_TMP/app.log" && fail "rerun launched again: $(cat "$TEST_TMP/app.log")"
  layout '(.spaces[0].tabs) |= map(select(.name != "backend"))'     # the backend tab was closed
  run "$U"; expect_rc 0; expect_out "1 started"
  grep -qF -- "do tab.new --space sp1 --name backend" "$TEST_TMP/app.log" || fail "did not restart backend in the factory's space"
}

test_other_spaces_and_tabs_are_left_alone() {
  kit; fake_app
  layout '.spaces += [{id: "sp7", name: "other", tabs: [{name: "backend", terminals: [{terminal: "t70", status: "idle", app: "claude-code"}]}]}]'
  run "$U"; expect_rc 0; expect_out "2 started"     # a backend tab in another space is not ours
  expect_eq "$(jq -c '[.spaces[] | select(.id == "sp7") | .tabs[].name]' "$TEST_TMP/fake/layout")" '["backend"]'
}

test_team_tab_without_claude_stops() {
  kit; fake_app; run "$U"; expect_rc 0
  layout '(.spaces[0].tabs[] | select(.name == "backend") | .terminals[0].app) = null'   # claude exited, a shell is left
  run "$U"; expect_rc 1; expect_err "not running claude (t2). Close that tab"
}

test_without_herdr_points_to_print() {
  kit
  PATH="$FAKE_GH/bin:$TEST_TMP/kc:$(path_without herdr-app)" run "$U"; expect_rc 1; expect_err "--print"
  fake_app; touch "$TEST_TMP/fake/closed"
  run "$U"; expect_rc 1; expect_err "Herdr is not open"
}

test_session_waiting_on_a_prompt_is_reported_not_fatal() {
  kit; fake_app; touch "$TEST_TMP/fake/block-backend"
  run "$U"; expect_rc 0; expect_out "backend: started backend-lead in t2"; expect_out "trust the folder"
  run "$U"; expect_rc 0; expect_out "backend: running in t2, waiting for you"
}

test_start_that_fails_outright_stops() {
  kit; fake_app; touch "$TEST_TMP/fake/fail-backend"
  run "$U"; expect_rc 1; expect_err "Herdr did not start backend"
  rm "$TEST_TMP/fake/fail-backend"; echo '{"spaces":[]}' > "$TEST_TMP/fake/layout"; touch "$TEST_TMP/fake/fail-orchestrator"
  run "$U"; expect_rc 1; expect_err "Herdr did not start orchestrator"
}

test_without_a_bot_token_sessions_work_as_you_and_it_says_so() {
  kit; fake_app; fake_keychain
  run "$U"; expect_rc 0; expect_out "agents work on GitHub as you (human): there is no bot token"
  expect_out "risk-gate cannot tell"
  plain=$(jq -nc '["env", "FACTORY_TEAM=backend", "claude", "--agent", "backend-lead", "-n", "backend"]')
  grep -qxF -- "do tab.new --space sp1 --name backend --folder $(BE) --argv $plain" "$TEST_TMP/app.log" || fail "backend tab wrong: $(cat "$TEST_TMP/app.log")"
  grep -qF -- "--name sweep --folder $TEST_TMP/app --argv [\"bash\"," "$TEST_TMP/app.log" || fail "sweep tab wrong: $(cat "$TEST_TMP/app.log")"
  run "$U" --print; expect_rc 0; expect_out "cd $(BE) && FACTORY_TEAM=backend claude --agent backend-lead -n backend"
  expect_out "cd $TEST_TMP/app && bash $SCRIPTS/sweep.sh --loop"
}

test_a_stored_bot_token_that_does_not_work_stops_everything() {
  kit; fake_app; fake_keychain 'not a token'
  run "$U"; expect_rc 1; expect_err "the keychain holds a bot token (factory-github-bot), and it does not work"
  [ ! -e "$(BE)" ] || fail "made a worktree with a broken bot token"
  grep -q '^do ' "$TEST_TMP/app.log" 2>/dev/null && fail "started a tab with a broken bot token"
  true
}

test_refuses_a_token_that_is_yours() {
  kit; fake_app; fake_keychain ghp_HUMANSOWNTOKEN0000000000000000; export FAKE_GH_USER=ghp_humansowntoken0000000000000000
  run "$U"; expect_rc 1; expect_err "token is yours (ghp_humansowntoken"
  grep -q '^do ' "$TEST_TMP/app.log" 2>/dev/null && fail "started a tab with your token"
  true
}

test_sweep_is_not_a_team_name() {
  kit; jq '.teams.sweep = {owns: ["x/*"]}' factory/teams.json > t.json && cp t.json factory/teams.json
  echo agent > .claude/agents/sweep-lead.md
  run "$U" --print; expect_rc 1; expect_err "'sweep' is the name of the sweep's tab"
}

run_tests
