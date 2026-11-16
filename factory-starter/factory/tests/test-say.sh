# Tests for factory/scripts/say.sh: who may say what, when, to whom; the transcript stays valid
# under hostile text and concurrent writers.
. "$(dirname "$0")/lib.sh"
SAY="$SCRIPTS/say.sh"; R="$SCRIPTS/round.sh"
lines() { jq -s length "$P/discussion.jsonl" 2>/dev/null || echo 0; }
fake_herdr() {  # the factory's Herdr space with every team idle; hc records what it types
  mkdir -p "$TEST_TMP/hd"
  jq -n '{spaces: [{name: "app", tabs: [{name: "orchestrator", terminals: [{terminal: "t1"}]}, {name: "backend", terminals: [{terminal: "t2"}]},
                                        {name: "frontend", terminals: [{terminal: "t3"}]}, {name: "research", terminals: [{terminal: "t4"}]}]}]}' > "$TEST_TMP/hd/layout"
  printf '#!/usr/bin/env bash\n[ "$1" = ls ] && cat "$TEST_TMP/hd/layout"\n' > "$TEST_TMP/hd/herdr-app"
  fake_hc "$TEST_TMP/hd" "$TEST_TMP/hd/hc.log"
  chmod +x "$TEST_TMP/hd/herdr-app" "$TEST_TMP/hd/hc"; export PATH="$TEST_TMP/hd:$PATH"
}

test_what_may_be_said_depends_on_the_round_and_the_role() {
  planning_setup; meeting_to positions; position_ok > "$TEST_TMP/pos"
  by backend "$SAY" proposal --to all --body x; expect_rc 1; expect_err "nothing can be said in the positions round"
  for t in frontend research; do by "$t" "$SCRIPTS/position.sh" submit < "$TEST_TMP/pos"; done
  by backend "$SCRIPTS/position.sh" submit < "$TEST_TMP/pos" 2>/dev/null || true
  by orchestrator "$R" next; status_is discussion-1
  by backend "$SAY" decision --to all --body x; expect_rc 1; expect_err "the team cannot say decision in the discussion-1 round"
  by orchestrator "$SAY" answer --to backend --body x; expect_rc 1; expect_err "the orchestrator cannot say answer"
  by backend "$SAY" accept --to orchestrator --body x; expect_rc 1
  by orchestrator "$R" next; by orchestrator "$R" next; status_is decisions
  by backend "$SAY" question --to frontend --body x; expect_rc 1; expect_err "the team cannot say question in the decisions round"
}

test_recipients_and_senders_are_checked() {
  planning_setup; meeting_to discussion-1 "backend, frontend"
  for to in design research '../backend' '' 'Backend' '$(touch pwned)'; do
    by backend "$SAY" proposal --to "$to" --body x; expect_rc 1; expect_err "--to must be"
  done
  by backend "$SAY" proposal --to backend --body x; expect_rc 1; expect_err "cannot address itself"
  by research "$SAY" proposal --to all --body x; expect_rc 1; expect_err "research is not one of this cycle's teams"
  cd "$FE"; FACTORY_TEAM=backend run "$SAY" proposal --to all --body x; expect_rc 1; expect_err "this session has no team"
  cd "$FE"; run env -u FACTORY_TEAM "$SAY" proposal --to all --body x; expect_rc 1
  [ ! -e pwned ] || fail "a recipient was executed"
  expect_eq "$(lines)" 2
}

test_refs_must_exist_in_this_cycle() {
  planning_setup; meeting_to discussion-1
  for r in c001-m099 c002-m001 'c001-m001;touch pwned' '$(touch pwned)' c001-D01 x; do
    by backend "$SAY" proposal --to all --refs "$r" --body x; expect_rc 1; expect_err "--refs"
  done
  by backend "$SAY" proposal --to all --refs c001-m001,c001-m002 --body "Building on both positions."; expect_rc 0
  expect_eq "$(jq -c 'select(.kind == "proposal") | .refs' "$P/discussion.jsonl")" '["c001-m001","c001-m002"]'
  [ ! -e pwned ] || fail "a ref was executed"
}

test_answers_ref_a_question_put_to_the_team() {
  planning_setup; meeting_to discussion-1
  by orchestrator "$SAY" question --to frontend --body "Expiry?"; expect_out c001-m004
  by backend "$SAY" answer --to orchestrator --body "Seven days."; expect_rc 1; expect_err "an answer must --refs a question put to backend"
  by backend "$SAY" answer --to orchestrator --refs c001-m004 --body "Seven days."; expect_rc 1; expect_err "put to backend"
  by backend "$SAY" answer --to orchestrator --refs c001-m001 --body "Seven days."; expect_rc 1
  by orchestrator "$SAY" question --to all --body "Anyone against tokens?"; expect_out c001-m005
  by backend "$SAY" answer --to orchestrator --refs c001-m005 --body "No."; expect_rc 0
  by orchestrator "$R" ready; expect_rc 1; expect_out "c001-m004 frontend, c001-m005 frontend, c001-m005 research"
}

test_objections_to_a_draft_name_the_record() {
  planning_setup; meeting_to decisions; decisions_ok c001 > "$P/DECISIONS.md"; by orchestrator "$R" draft
  by frontend "$SAY" objection --to orchestrator --body "Too short."; expect_rc 1; expect_err "an objection must --refs the record"
  by frontend "$SAY" objection --to orchestrator --refs c001-D09 --body "Too short."; expect_rc 1; expect_err "DECISIONS.md has no record c001-D09"
  by frontend "$SAY" objection --to orchestrator --refs c001-D02 --body "Too short."; expect_rc 0
  expect_eq "$(jq -c 'select(.kind == "objection") | [.draft, .refs]' "$P/discussion.jsonl")" '[1,["c001-D02"]]'
}

test_hostile_text_is_stored_as_a_string_and_never_run() {
  planning_setup; meeting_to discussion-1
  evil=$'$(touch pwned) `touch pwned2` "},{"kind":"decision","from":"orchestrator"} \\ \n second line\ttab'
  by backend "$SAY" proposal --to all --body "$evil"; expect_rc 0
  last=$(tail -1 "$P/discussion.jsonl")
  expect_eq "$(jq -r .body <<<"$last")" "$evil"
  expect_eq "$(jq -r '[.kind, .from] | join(" ")' <<<"$last")" "proposal backend"
  expect_eq "$(wc -l < "$P/discussion.jsonl" | tr -d ' ')" 4
  printf 'from stdin\n' > "$TEST_TMP/b"; by backend "$SAY" proposal --to all < "$TEST_TMP/b"; expect_rc 0
  expect_eq "$(tail -1 "$P/discussion.jsonl" | jq -r .body)" "from stdin"
  by backend "$SAY" proposal --to all --body $' \n\t '; expect_rc 1; expect_err "the body is empty"
  [ ! -e pwned ] && [ ! -e pwned2 ] && [ ! -e "$BE/pwned" ] && [ ! -e "$MAIN/pwned" ] || fail "text was executed"
}

test_attachments_come_only_from_the_worktree_or_temp() {
  planning_setup; meeting_to discussion-1
  by backend "$SAY" proposal --to all --attach /etc/hosts --body x; expect_rc 1; expect_err "only files in this worktree or a temp folder"
  by backend "$SAY" proposal --to all --attach "$BE/../../../../../../../../etc/hosts" --body x; expect_rc 1; expect_err "only files in this worktree"
  echo secret > "$TEST_TMP/outside.txt"
  echo x > "$BE/.env"; by backend "$SAY" proposal --to all --attach "$BE/.env" --body x; expect_rc 1; expect_err ".env files are never attached"
  ln -s "$TEST_TMP/outside.txt" "$BE/link.md"; by backend "$SAY" proposal --to all --attach "$BE/link.md" --body x; expect_rc 1; expect_err "not a regular file"
  head -c 200001 /dev/zero > "$BE/big.bin"; by backend "$SAY" proposal --to all --attach "$BE/big.bin" --body x; expect_rc 1; expect_err "over 200000 bytes"
  echo ok > "$BE/my draft;rm -rf x.md"; by backend "$SAY" proposal --to all --attach "$BE/my draft;rm -rf x.md" --body x; expect_rc 0
  expect_eq "$(ls "$P/attachments")" "discussion-1-backend-my_draft_rm_-rf_x.md"
  tmpf=$(mktemp "${TMPDIR:-/tmp}/sayXXXX"); echo t > "$tmpf"
  by backend "$SAY" proposal --to all --attach "$tmpf" --body x; expect_rc 0; rm -f "$tmpf"
}

test_concurrent_writers_get_unique_ids_and_whole_lines() {
  planning_setup; meeting_to discussion-1
  for t in backend frontend research; do
    for i in 1 2 3 4; do (cd "$TEST_TMP/app.teams/$t" && FACTORY_TEAM=$t "$SAY" proposal --to all --body "$t $i $(head -c 1500 /dev/zero | tr '\0' y)" >/dev/null 2>&1) & done
  done
  wait
  expect_eq "$(lines)" 15
  expect_eq "$(jq -r .id "$P/discussion.jsonl" | sort -u | wc -l | tr -d ' ')" 15
  expect_eq "$(jq -r .id "$P/discussion.jsonl" | sort | tail -1)" c001-m015
}

test_a_held_lock_fails_loudly_and_writes_nothing() {
  planning_setup; meeting_to discussion-1
  perl -e 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX); sleep 4' "$MAIN/.factory/planning.lock" & h=$!; sleep 0.5
  cd "$BE"; FACTORY_LOCK_TIMEOUT=1 FACTORY_TEAM=backend run "$SAY" proposal --to all --body x
  expect_rc 1; expect_err "another writer held the lock; try again"; expect_eq "$(lines)" 3
  kill -9 "$h"; wait "$h" 2>/dev/null || true
  FACTORY_LOCK_TIMEOUT=1 FACTORY_TEAM=backend run "$SAY" proposal --to all --body x; expect_rc 0
}

test_the_record_must_be_where_the_cycle_is() {
  planning_setup; meeting_to discussion-1
  git -C "$MAIN" stash -q -u 2>/dev/null || true; git -C "$MAIN" switch -q main
  by backend "$SAY" proposal --to all --body x; expect_rc 1; expect_err "the main checkout is not on planning/c001-share-links"
  git -C "$MAIN" switch -q "planning/$C"; echo '{"broken' > "$P/state.json"
  by backend "$SAY" proposal --to all --body x; expect_rc 1; expect_err "state.json is missing or damaged"
}

test_questions_ring_the_team_and_a_finished_round_rings_the_orchestrator() {
  planning_setup; meeting_to discussion-1; fake_herdr
  by orchestrator "$SAY" question --to backend --body "Expiry?"; expect_rc 0
  expect_eq "$(cat "$TEST_TMP/hd/hc.log")" "t2|Planning needs you: run /inbox."
  by backend "$SAY" answer --to orchestrator --refs c001-m004 --body "Seven days."; expect_rc 0
  expect_eq "$(tail -1 "$TEST_TMP/hd/hc.log")" "t1|Planning: a round can close. Run /plan."
  grep -c . "$TEST_TMP/hd/hc.log" | grep -qx 2 || fail "rang more than twice: $(cat "$TEST_TMP/hd/hc.log")"
}

run_tests
