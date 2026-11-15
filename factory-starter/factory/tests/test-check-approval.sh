# Tests for factory/scripts/check-approval.sh: risk-gate's check that the human, not the bot,
# added the label, after the newest push. gh is faked (factory/tests/fake-gh).
. "$(dirname "$0")/lib.sh"
A="$SCRIPTS/check-approval.sh"
export FACTORY_HUMAN=human

pr() {  # pr [head] [head repo]: pull request #7, its branch pushed at 10:00
  fake_gh
  jq -n --arg h "${1:-work/7-x}" --arg r "${2:-o/r}" '{head: {ref: $h, repo: {full_name: $r}}, base: {repo: {full_name: "o/r"}}}' > "$FAKE_GH/pulls/7.json"
  jq -n --arg h "refs/heads/${1:-work/7-x}" '[{ref: $h, activity_type: "branch_creation", timestamp: "2026-11-15T09:00:00Z"},
    {ref: $h, activity_type: "push", timestamp: "2026-11-15T10:00:00Z"},
    {ref: "refs/heads/other", activity_type: "push", timestamp: "2026-11-15T23:00:00Z"}]' > "$FAKE_GH/activity.json"
  echo '[]' > "$FAKE_GH/events/7.json"
}
ev() {  # ev <id> labeled|unlabeled <label> <actor> <HH:MM:SS>
  jq --argjson id "$1" --arg e "$2" --arg l "$3" --arg a "$4" --arg t "2026-11-15T$5Z" \
    '. + [{id: $id, event: $e, label: {name: $l}, actor: {login: $a}, created_at: $t}]' "$FAKE_GH/events/7.json" > "$FAKE_GH/e" &&
    mv "$FAKE_GH/e" "$FAKE_GH/events/7.json"
}

test_your_label_after_the_last_push_passes() {
  pr; ev 1 labeled human-approved human 10:05:00
  run "$A" 7; expect_rc 0; expect_out "added by human at 2026-11-15T10:05:00Z, after the last push at 2026-11-15T10:00:00Z"
}

test_a_label_the_bot_added_fails() {
  pr; ev 1 labeled human-approved factory-bot 10:05:00
  run "$A" 7; expect_rc 1; expect_err "added by factory-bot, not by human (FACTORY_HUMAN)"
}

test_a_label_older_than_the_last_push_fails() {
  pr; ev 1 labeled human-approved human 09:30:00
  run "$A" 7; expect_rc 1; expect_err "before the last push to work/7-x at 2026-11-15T10:00:00Z"
  pr; ev 1 labeled human-approved human 10:00:00          # the same second is not after it
  run "$A" 7; expect_rc 1; expect_err "before the last push"
}

test_the_bot_cannot_take_over_your_label() {
  pr; ev 1 labeled human-approved human 10:05:00; ev 2 unlabeled human-approved factory-bot 10:06:00; ev 3 labeled human-approved factory-bot 10:07:00
  run "$A" 7; expect_rc 1; expect_err "added by factory-bot"
  ev 4 unlabeled human-approved human 10:08:00; ev 5 labeled human-approved human 10:09:00
  run "$A" 7; expect_rc 0
}

test_a_removed_or_missing_label_fails() {
  pr; run "$A" 7; expect_rc 1; expect_err "'human-approved' is not on #7"
  ev 1 labeled human-approved human 10:05:00; ev 2 unlabeled human-approved human 10:06:00
  run "$A" 7; expect_rc 1; expect_err "was removed from #7"
}

test_only_the_named_label_counts() {
  pr; ev 1 labeled human-approved factory-bot 10:05:00; ev 2 labeled risk:R2 human 10:06:00
  run "$A" 7; expect_rc 1; expect_err "added by factory-bot"
  ev 3 labeled brief-approved human 10:07:00
  run "$A" 7 brief-approved; expect_rc 0
}

test_events_are_ordered_by_id_not_by_position() {
  pr; ev 9 labeled human-approved factory-bot 10:09:00; ev 3 labeled human-approved human 10:03:00
  run "$A" 7; expect_rc 1; expect_err "added by factory-bot"
}

test_logins_compare_without_case() {
  pr; ev 1 labeled human-approved Human 10:05:00
  FACTORY_HUMAN=HUMAN run "$A" 7; expect_rc 0
}

test_pushes_to_other_branches_and_deletions_do_not_count() {
  pr; ev 1 labeled human-approved human 10:05:00
  jq '. + [{ref: "refs/heads/work/7-x", activity_type: "branch_deletion", timestamp: "2026-11-15T22:00:00Z"}]' "$FAKE_GH/activity.json" > a && mv a "$FAKE_GH/activity.json"
  run "$A" 7; expect_rc 0
}

test_branch_names_are_encoded_in_the_query() {
  pr 'work/7-a&ref=refs/heads/other#x'; ev 1 labeled human-approved human 10:05:00
  run "$A" 7; expect_rc 0; expect_out "after the last push at 2026-11-15T10:00:00Z"
}

test_without_a_valid_factory_human_it_fails_closed() {
  pr; ev 1 labeled human-approved human 10:05:00
  for h in '' 'two words' '$(touch pwned)' '-leading' "$(printf 'a%.0s' {1..40})" $'human\nbot'; do
    FACTORY_HUMAN=$h run "$A" 7; expect_rc 2; expect_err "FACTORY_HUMAN is not a GitHub login"
  done
  [ ! -e pwned ] || fail "FACTORY_HUMAN was executed"
}

test_hostile_arguments_fail_closed() {
  pr; ev 1 labeled human-approved human 10:05:00
  for n in '' 0 -1 '7;touch pwned' '../7' '7 8' '$(touch pwned)' 12345678901; do run "$A" "$n"; expect_rc 2; done
  for l in 'Human-Approved' 'a,b' 'x y' '$(touch pwned)' ''; do run "$A" 7 "$l"; expect_rc 2; done
  [ ! -e pwned ] || fail "an argument was executed"
}

test_fork_and_undatable_pushes_fail_closed() {
  pr work/7-x someone/fork; ev 1 labeled human-approved human 10:05:00
  run "$A" 7; expect_rc 2; expect_err "comes from a fork"
  pr; ev 1 labeled human-approved human 10:05:00; echo '[]' > "$FAKE_GH/activity.json"
  run "$A" 7; expect_rc 2; expect_err "no record of a push"
}

test_broken_answers_from_github_fail_closed() {
  pr; ev 1 labeled human-approved human 10:05:00
  echo '{"head": {"ref": "work/7-x", "repo"' > "$FAKE_GH/pulls/7.json"
  run "$A" 7; expect_rc 2
  pr; printf '[{"id": 1, "event": "labeled", "label"' > "$FAKE_GH/events/7.json"
  run "$A" 7; expect_rc 2
  pr; ev 1 labeled human-approved human 10:05:00; echo 'activity' > "$FAKE_GH/fail"
  run "$A" 7; expect_rc 2; expect_err "cannot read when work/7-x was last pushed"
  pr; run "$A" 8; expect_rc 2; expect_err "cannot read pull request #8"
}

run_tests
