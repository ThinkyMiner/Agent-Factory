# Baseline tests for factory/hooks/guard.sh, the PreToolUse guard. Exit 2 blocks the tool call.
# test_* pins what the guard guarantees today. gap_* records holes found while writing these
# tests; Phase 1 (team mode) must close them.
. "$(dirname "$0")/lib.sh"
G="$HOOKS/guard.sh"

# edit <tool> <path>, bash <command>: run the guard on a hook payload, with the project at $TEST_TMP/root.
edit() {
  mkdir -p "$TEST_TMP/root"
  jq -n --arg t "$1" --arg p "$2" '{tool_name:$t, tool_input:{file_path:$p, notebook_path:$p}}' > "$TEST_TMP/in"
  CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < "$TEST_TMP/in"
}
bash_cmd() {
  mkdir -p "$TEST_TMP/root"
  jq -n --arg c "$1" '{tool_name:"Bash", tool_input:{command:$c}}' > "$TEST_TMP/in"
  CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < "$TEST_TMP/in"
}
blocks()  { [ "$RC" = 2 ] || fail "expected the guard to block (exit 2), got $RC: $1"; }
allows()  { [ "$RC" = 0 ] || fail "expected the guard to allow (exit 0), got $RC: $1. $(cat "$ERR")"; }

test_env_files_blocked() {
  local p
  for p in .env .env.local .env.production web/.env web/.env.local; do
    edit Write "$p"; blocks "$p"; expect_err "Secrets are handled by the human"
    edit Edit "$TEST_TMP/root/$p"; blocks "absolute $p"
  done
}

test_env_example_allowed() {
  edit Write .env.example; allows .env.example
  edit Write web/.env.example; allows web/.env.example
}

test_factory_paths_blocked() {
  local p
  for p in .claude/settings.json .claude/agents/builder.md factory/policy.env factory/hooks/guard.sh \
           .github/workflows/ci.yml memory/lessons.md memory/reflections/2026-01-01.md; do
    edit Edit "$p"; blocks "$p"; expect_err "factory's own controls"
    edit Write "$TEST_TMP/root/$p"; blocks "absolute $p"
  done
}

test_every_edit_tool_is_guarded() {
  local t
  for t in Edit Write MultiEdit NotebookEdit; do
    edit "$t" factory/x.ipynb; blocks "$t"
  done
}

test_self_edit_flag_opens_factory_paths_only() {
  FACTORY_ALLOW_SELF_EDIT=1 edit Edit .claude/settings.json; allows "self-edit .claude"
  FACTORY_ALLOW_SELF_EDIT=1 edit Edit factory/policy.env; allows "self-edit factory"
  FACTORY_ALLOW_SELF_EDIT=1 edit Write .env; blocks "self-edit still blocks .env"
  FACTORY_ALLOW_SELF_EDIT=0 edit Edit factory/policy.env; blocks "flag set to 0"
}

test_product_paths_allowed() {
  local p
  for p in src/a.ts docs/x.md memory/observations/2026-01-01-1-x.md work/1-x/spec.md tests/acceptance/a.test; do
    edit Edit "$p"; allows "$p"
  done
}

test_other_tools_pass_through() {
  mkdir -p root; echo '{"tool_name":"Read","tool_input":{"file_path":".env"}}' > in
  CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < in; allows "Read is not guarded"
}

test_force_push_blocked() {
  local c
  for c in 'git push --force' 'git push -f origin work/1-x' 'git push origin work/1-x --force' \
           'git push --force-with-lease origin work/1-x' 'git  push   -f'; do
    bash_cmd "$c"; blocks "$c"
  done
}

test_push_to_default_branch_blocked() {
  local c
  for c in 'git push origin main' 'git push origin master' 'git push origin HEAD:main' \
           'git push origin main && echo done' 'git push -u origin main'; do
    bash_cmd "$c"; blocks "$c"
  done
}

test_push_to_work_branches_allowed() {
  local c
  for c in 'git push -u origin work/12-foo' 'git push origin maintenance' 'git push origin work/3-main-menu'; do
    bash_cmd "$c"; allows "$c"
  done
}

test_bypass_flags_blocked() {
  local c
  for c in 'git commit --no-verify -m x' 'gh pr merge 5 --admin' 'gh pr merge 5 --squash --admin' \
           'gh pr review 5 --approve' 'gh pr edit 5 --add-label human-approved' \
           'gh issue edit 3 --add-label "human-approved"'; do
    bash_cmd "$c"; blocks "$c"
  done
}

test_ordinary_commands_allowed() {
  local c
  for c in 'make check' 'git status' 'git push -u origin work/1-x' 'gh pr create --fill' \
           'factory/scripts/classify-risk.sh' 'gh pr merge 5 --auto --squash'; do
    bash_cmd "$c"; allows "$c"
  done
}

test_missing_jq_fails_closed() {
  mkdir -p root; echo '{"tool_name":"Write","tool_input":{"file_path":"src/a.ts"}}' > in
  PATH=$(path_without jq) CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < in
  blocks "no jq"; expect_err "jq is not installed"
}

# ---- known gaps (Phase 1 closes these) ----

gap_dotdot_path_reaches_factory_files() {
  edit Edit 'src/../.claude/settings.json'; blocks "src/../.claude/settings.json"
}

gap_symlink_reaches_factory_files() {
  mkdir -p root/src root/.claude; ln -s ../.claude root/src/cfg
  edit Edit "$TEST_TMP/root/src/cfg/settings.json"; blocks "symlink into .claude"
}

gap_case_variant_reaches_factory_files() {
  # macOS volumes are case-insensitive by default: .CLAUDE/settings.json is .claude/settings.json.
  edit Edit '.CLAUDE/settings.json'; blocks ".CLAUDE"
  edit Write '.ENV'; blocks ".ENV"
}

gap_user_settings_outside_project() {
  # ~/.claude/settings.json can switch hooks off (disableAllHooks) for every later session.
  edit Write "$HOME/.claude/settings.json"; blocks "user settings"
}

gap_push_main_via_git_dash_c() {
  bash_cmd 'git -C . push origin main'; blocks "git -C . push origin main"
}

gap_push_main_via_full_ref() {
  bash_cmd 'git push origin HEAD:refs/heads/main'; blocks "refs/heads/main"
}

gap_force_push_via_plus_refspec() {
  bash_cmd 'git push origin +work/1-x'; blocks "+refspec"
}

gap_malformed_input_fails_open() {
  # Any exit other than 2 lets the call through, so a payload the guard cannot parse must exit 2.
  mkdir -p root; printf 'not json{' > in
  CLAUDE_PROJECT_DIR="$TEST_TMP/root" run "$G" < in; blocks "malformed payload"
}

gap_shell_write_to_factory_files() {
  local c
  for c in 'echo x > .claude/settings.json' "sed -i '' s/R1/none/ factory/policy.env" \
           'cp /tmp/x factory/hooks/guard.sh' 'printf x | tee memory/lessons.md'; do
    bash_cmd "$c"; blocks "$c"
  done
}

run_tests
