# Tests for the contracts parts of factory/hooks/guard.sh. In team mode contracts/ is written only
# while a grant in <main checkout>/.factory/grants/ names the session's team (ticket.sh writes it
# when the team accepts a contract-change ticket), and no session ever writes a grant itself.
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
# grant <n> <json>: a grant file as ticket.sh writes it, in the main checkout
grant() { mkdir -p "$MAIN/.factory/grants"; printf '%s' "$2" > "$MAIN/.factory/grants/contract-$1.json"; }
writes_contracts() {  # writes_contracts <team> <checkout> <allows|blocks> <why>
  local t=$1 d=$2 v=$3
  tw "$t" "$d" Write contracts/api.openapi.yaml; $v "$4: Write"
  tw "$t" "$d" Edit "$d/contracts/design/tokens.json"; $v "$4: Edit, absolute"
  tb "$t" "$d" 'echo "openapi: 3.1.0" > contracts/api.openapi.yaml'; $v "$4: redirect"
  tb "$t" "$d" "sed -i '' s/a/b/ contracts/data-model.md"; $v "$4: sed -i"
  tb "$t" "$d" 'cp /tmp/draft.yaml contracts/api.openapi.yaml'; $v "$4: cp"
  tb "$t" "$d" 'mkdir -p contracts/design'; $v "$4: mkdir"
}

test_single_team_factories_keep_todays_behaviour() {
  edit Write contracts/api.openapi.yaml; allows "no roster: contracts are product files"
  edit Edit "$TEST_TMP/root/contracts/design/tokens.json"; allows "absolute"
}

test_no_grant_no_contract_writes() {
  team_setup
  writes_contracts backend "$BE" blocks "backend without a grant"
  expect_err "contract-change ticket"; expect_err "owned by no team"
  writes_contracts orchestrator "$MAIN" blocks "the orchestrator promotes with contracts.sh, never by hand"
  tw backend "$BE" Write CONTRACTS/API.yaml; blocks "case variant"
  tw backend "$BE" Write server/../contracts/api.yaml; blocks "climbing into contracts with .."
  mkdir -p "$BE/server" "$BE/contracts" && ln -s ../contracts "$BE/server/c"
  tw backend "$BE" Write server/c/api.yaml; blocks "a symlink from own path into contracts"
  tb backend "$BE" "echo x > 'contracts/\$(touch pwned).yaml'"; blocks "\$(...) in the target"
  tb backend "$BE" 'echo x > contracts/`touch pwned`.yaml'; blocks "backticks in the target"
  [ ! -e pwned ] && [ ! -e "$BE/pwned" ] || fail "a target was executed"
}

test_a_grant_opens_contracts_to_its_team_only() {
  team_setup; grant 7 '{"ticket":7,"team":"backend","ts":"2026-11-15T10:00:00Z"}'
  writes_contracts backend "$BE" allows "backend with its grant"
  tw backend "$BE" Write $'contracts/new\nline.yaml'; allows "a newline in the name is still under contracts/"
  writes_contracts frontend "$FE" blocks "frontend: the grant is backend's"
  writes_contracts orchestrator "$MAIN" blocks "orchestrator: the grant is backend's"
  tw backend "$BE" Write "$MAIN/contracts/api.yaml"; blocks "the main checkout's contracts from a worktree"
  tw backend "$BE" Write "$FE/contracts/api.yaml"; blocks "another team's worktree"
  tw backend "$BE" Write web/app.js; blocks "a grant opens contracts/ only"
  tb backend "$BE" 'rm -rf contracts'; blocks "the folder itself is not a contract"
  cd "$FE"; tw backend "$FE" Write contracts/api.yaml; blocks "a spoofed FACTORY_TEAM in another worktree"
  tw "" "$BE" Write contracts/api.yaml; blocks "no team at all"
  rm "$MAIN/.factory/grants/contract-7.json"
  tw backend "$BE" Write contracts/api.yaml; blocks "the grant is gone (ticket done)"
}

test_damaged_or_forged_grants_grant_nothing() {
  team_setup
  local g
  for g in '{"ticket":7,"team":"backend"' '{"ticket":7,"team":"frontend"}' '{"ticket":8,"team":"backend"}' \
           '{"ticket":"7","team":"backend"}' '{"team":"backend"}' '["backend"]' '"backend"' '' 'backend' \
           '{"ticket":7,"team":"backend\r"}' '{"ticket":7,"team":"../backend"}' '{"ticket":7,"team":"$(id)"}' \
           '{"ticket":7,"team":["backend"]}' '{"ticket":7,"team":"BACKEND"}'; do
    grant 7 "$g"; tw backend "$BE" Write contracts/api.yaml; blocks "grant [$g]"
  done
  grant 7 "$(head -c 1048576 /dev/zero | tr '\0' x)"; tw backend "$BE" Write contracts/api.yaml; blocks "a 1 MB garbage grant"
  rm -f "$MAIN/.factory/grants/contract-7.json"
  for n in abc 07 0 -1 '7.json' ''; do
    grant "$n" '{"ticket":7,"team":"backend"}'; tw backend "$BE" Write contracts/api.yaml; blocks "file name contract-$n.json"
    rm -f "$MAIN/.factory/grants/contract-$n.json"
  done
  mkdir -p "$TEST_TMP/elsewhere" && printf '{"ticket":7,"team":"backend"}' > "$TEST_TMP/elsewhere/contract-7.json"
  ln -s "$TEST_TMP/elsewhere/contract-7.json" "$MAIN/.factory/grants/contract-7.json"
  tw backend "$BE" Write contracts/api.yaml; blocks "a grant that is a symlink"
  rm -rf "$MAIN/.factory/grants" && ln -s "$TEST_TMP/elsewhere" "$MAIN/.factory/grants"
  tw backend "$BE" Write contracts/api.yaml; blocks "a grants folder that is a symlink (to a place sessions may write)"
  rm "$MAIN/.factory/grants"; mkdir -p "$BE/.factory/grants" && printf '{"ticket":7,"team":"backend"}' > "$BE/.factory/grants/contract-7.json"
  tw backend "$BE" Write contracts/api.yaml; blocks "a grant in the team's own worktree is not the factory's"
  grant 7 $'{"ticket":7,"team":"backend"}\r\n'
  tw backend "$BE" Write contracts/api.yaml; allows "a CRLF line ending is still the grant ticket.sh wrote"
}

test_sessions_never_write_grants() {
  team_setup; grant 7 '{"ticket":7,"team":"backend"}'
  local d="$MAIN/.factory/grants" c
  for c in Write Edit; do
    tw backend "$BE" "$c" "$d/contract-9.json"; blocks "backend $c into the main checkout's grants"
    tw orchestrator "$MAIN" "$c" .factory/grants/contract-9.json; blocks "orchestrator $c"
    tw orchestrator "$MAIN" "$c" "$d/contract-7.json"; blocks "orchestrator $c, absolute"
    tw backend "$BE" "$c" .factory/grants/contract-9.json; blocks "backend $c in its own worktree's .factory"
  done
  for c in "echo '{\"ticket\":9,\"team\":\"frontend\"}' > $d/contract-9.json" "cp /tmp/g.json $d/contract-9.json" \
           "printf x | tee $d/contract-9.json" "mkdir -p $d" "rm -f $d/contract-7.json" "ln -s /tmp $d" \
           "mv /tmp/g.json $d/" "touch $d/contract-9.json"; do
    tb frontend "$FE" "$c"; blocks "frontend: $c"
    tb orchestrator "$MAIN" "${c//$MAIN\//}"; blocks "orchestrator: ${c//$MAIN\//}"
  done
  tb orchestrator "$MAIN" 'ln -s /tmp/mine .factory/grants'; blocks "replacing the folder with a symlink"
  tb orchestrator "$MAIN" 'rm -rf .factory'; blocks "removing .factory"
  jq -n '{tool_name:"Write", tool_input:{file_path:".factory/grants/contract-9.json"}}' > in
  FACTORY_ALLOW_SELF_EDIT=1 CLAUDE_PROJECT_DIR="$MAIN" run "$G" < in; blocks "a self-edit session in team mode"
  tw backend "$BE" Write contracts/api.yaml; allows "and the real grant still works"
}

test_contract_promotions_are_written_only_by_contracts_sh() {
  team_setup
  tw orchestrator "$MAIN" Write planning/c001-share/contracts.jsonl; blocks "Write"
  expect_err "contracts.sh"
  tw orchestrator "$MAIN" Edit planning/c001-share/CONTRACTS.JSONL; blocks "case variant"
  tb orchestrator "$MAIN" "echo '{}' >> planning/c001-share/contracts.jsonl"; blocks "append"
  tb orchestrator "$MAIN" 'factory/scripts/contracts.sh promote c001-share backend-api.yaml contracts/api.openapi.yaml'; allows "the script itself"
}

run_tests
