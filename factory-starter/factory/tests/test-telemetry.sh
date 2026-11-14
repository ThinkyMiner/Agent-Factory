# Tests for factory/hooks/telemetry.sh: one lifecycle line per hook call in .factory/events.jsonl.
# It observes only, so it must exit 0 whatever it is given.
. "$(dirname "$0")/lib.sh"
T="$HOOKS/telemetry.sh"

hook() {  # hook <json>: run telemetry with the project at $TEST_TMP/r
  printf '%s' "$1" > "$TEST_TMP/in"
  CLAUDE_PROJECT_DIR="$TEST_TMP/r" run "$T" < "$TEST_TMP/in"
}
log() { echo "$TEST_TMP/r/.factory/events.jsonl"; }
field() { tail -n 1 "$(log)" | jq -r "$1"; }

test_session_start_line() {
  mkrepo r
  hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"startup","transcript_path":"/t/s1.jsonl"}'
  expect_rc 0
  expect_eq "$(lines "$(log)")" 1
  expect_eq "$(field .type)" lifecycle
  expect_eq "$(field .event)" SessionStart
  expect_eq "$(field .session_id)" s1
  expect_eq "$(field .branch)" main
  expect_eq "$(field .work_id)" ""
  expect_eq "$(field .reason)" startup
  expect_eq "$(field .transcript_path)" /t/s1.jsonl
  field .ts | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || fail "ts format"
}

test_subagent_stop_uses_agent_transcript() {
  mkrepo r
  hook '{"hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a7","agent_type":"builder","transcript_path":"/t/main.jsonl","agent_transcript_path":"/t/a7.jsonl"}'
  expect_eq "$(field .agent_type)" builder
  expect_eq "$(field .agent_id)" a7
  expect_eq "$(field .transcript_path)" /t/a7.jsonl
}

test_work_branch_sets_work_id() {
  mkrepo r && git -C r switch -q -c work/42-share-links
  hook '{"hook_event_name":"Stop","session_id":"s1"}'
  expect_eq "$(field .work_id)" 42
  expect_eq "$(field .branch)" work/42-share-links
}

test_message_truncated_to_300() {
  mkrepo r
  local long; long=$(printf 'x%.0s' $(seq 1 500))
  hook "{\"hook_event_name\":\"Notification\",\"message\":\"$long\"}"
  expect_eq "$(field '.message | length')" 300
}

test_non_string_message_dropped() {
  mkrepo r
  hook '{"hook_event_name":"Notification","message":{"evil":true}}'
  expect_eq "$(field 'has("message")')" false
}

test_null_fields_omitted() {
  mkrepo r
  hook '{"hook_event_name":"SessionEnd"}'
  expect_eq "$(field 'has("agent_type") or has("session_id")')" false
}

test_hostile_values_stay_one_json_line() {
  mkrepo r
  hook '{"hook_event_name":"Notification","session_id":"a\"b\nc\u0000d","message":"$(touch pwned) `id`"}'
  expect_eq "$(lines "$(log)")" 1
  jq -e . "$(log)" > /dev/null || fail "not valid JSON"
  [ ! -e pwned ] || fail "value was executed"
}

test_invalid_json_writes_nothing() {
  mkrepo r
  hook 'not json{'; expect_rc 0
  expect_eq "$(lines "$(log)")" 0
}

test_empty_input_writes_no_line() {
  mkrepo r
  hook ''; expect_rc 0
  [ ! -s "$(log)" ] || fail "wrote [$(cat "$(log)")] for empty input"
}

test_missing_jq_exits_0() {
  mkrepo r; printf '{"hook_event_name":"Stop"}' > in
  PATH=$(path_without jq) CLAUDE_PROJECT_DIR="$TEST_TMP/r" run "$T" < in
  expect_rc 0; expect_eq "$(lines "$(log)")" 0
}

test_unwritable_log_exits_0() {
  mkrepo r; mkdir -p r/.factory; chmod 500 r/.factory
  hook '{"hook_event_name":"Stop"}'
  chmod 700 r/.factory
  expect_rc 0
}

test_not_a_git_repo() {
  mkdir r
  hook '{"hook_event_name":"Stop"}'
  expect_rc 0; expect_eq "$(field .branch)" ""
}

test_worktree_session_writes_main_checkout_log() {
  mkrepo r && git -C r worktree add -q ../wt -b team/frontend
  printf '{"hook_event_name":"SessionStart","session_id":"w1"}' > in
  CLAUDE_PROJECT_DIR="$TEST_TMP/wt" run "$T" < in
  expect_rc 0
  expect_eq "$(lines "$TEST_TMP/r/.factory/events.jsonl")" 1
  expect_eq "$(tail -n 1 "$TEST_TMP/r/.factory/events.jsonl" | jq -r .branch)" team/frontend
  [ ! -e wt/.factory ] || fail "wrote a log inside the worktree"
}

run_tests
