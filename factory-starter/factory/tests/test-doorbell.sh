# The doorbell (lib.sh ring_team) types a fixed line such as "run /inbox" into a session. The model
# can only act on it if that skill is model-invocable: a skill with disable-model-invocation is not
# even listed to the model (checked live: it answered "not in the list of available skills").
. "$(dirname "$0")/lib.sh"

skill_flag() { awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} NR>1' "$KIT/.claude/skills/$1/SKILL.md" | grep -c "^disable-model-invocation: true$" || true; }

rung_skills() {  # every /skill a doorbell line or a lead's "when rung" sentence names
  { grep -ho 'ring_team [^|]*' "$SCRIPTS"/*.sh; grep -ho 'rung ([^)]*)' "$KIT"/.claude/agents/*.md; } |
    grep -oi 'run /[a-z-]*' | sed 's|.*/||' | sort -u
}

test_every_rung_skill_exists_and_the_model_can_start_it() {
  local s n=0
  for s in $(rung_skills); do
    n=$((n+1))
    [ -f "$KIT/.claude/skills/$s/SKILL.md" ] || fail "a doorbell names /$s, which does not exist"
    expect_eq "$(skill_flag "$s")" 0 "/$s is rung but only a person can start it"
  done
  [ "$n" -ge 2 ] || fail "found only $n rung skills; the extraction is broken"
  rung_skills | grep -qx inbox && rung_skills | grep -qx plan || fail "inbox and plan should both be rung"
}

test_skills_that_start_work_stay_human_only() {  # the human decides what gets built and merged
  local s
  for s in work research-work dispatch integrate reflect groom audit; do
    expect_eq "$(skill_flag "$s")" 1 "/$s must keep disable-model-invocation: true"
  done
}

test_flag_check_sees_a_flag_only_in_frontmatter() {  # hostile: the line in the body does not count
  mkdir -p fake/.claude/skills/x
  printf -- '---\nname: x\n---\ndisable-model-invocation: true\n' > fake/.claude/skills/x/SKILL.md
  expect_eq "$(KIT=$TEST_TMP/fake skill_flag x)" 0
  printf -- '---\nname: x\ndisable-model-invocation: true\n---\n' > fake/.claude/skills/x/SKILL.md
  expect_eq "$(KIT=$TEST_TMP/fake skill_flag x)" 1
}

# ring <status> [layout]: ring backend (terminal t2) in the factory "app" whose session has <status>
# in hc; RC is ring_team's exit, hc.log what hc typed.
ring() {
  mkdir -p hd; printf '%s' "$1" > hc-status; rm -f hd/hc.log
  local here='{"spaces":[{"name":"app","tabs":[{"name":"backend","terminals":[{"terminal":"t2"}]}]}]}'
  printf '%s' "${2:-$here}" > hd/layout
  printf '#!/usr/bin/env bash\n[ "$1" = ls ] && cat "$TEST_TMP/hd/layout"\n' > hd/herdr-app; chmod +x hd/herdr-app
  fake_hc "$TEST_TMP/hd" "$TEST_TMP/hd/hc.log"
  RC=0; ( PATH="$TEST_TMP/hd:$PATH"; . "$SCRIPTS/lib.sh"; ring_team "$TEST_TMP/app" backend "Planning needs you: run /inbox." ) || RC=$?
}
rang() { cat hd/hc.log 2>/dev/null; }

test_a_session_waiting_for_input_is_rung_after_its_first_turn_too() {
  # hc says idle before a session's first turn and done after it; --if idle missed every lead
  # that had already worked (found in the dry run: backend was done, the ring never came)
  ring idle; expect_rc 0; expect_eq "$(rang)" "t2|Planning needs you: run /inbox."
  ring done; expect_rc 0; expect_eq "$(rang)" "t2|Planning needs you: run /inbox."
}

test_a_busy_or_unknown_session_is_not_rung() {
  local st
  for st in working blocked "" "idle done" "IDLE" "done; rm -rf x"; do
    ring "$st"; expect_rc 1; expect_eq "$(rang)" "" "status [$st]"
  done
}

test_a_ring_never_forces_past_a_dialog() {  # only the terminal and the text; no --force, no --if
  ring done; expect_eq "$(rang | grep -c '|.*|' || true)" 0 "hc got extra arguments: $(rang)"
}

test_the_status_read_is_the_rung_terminal_s_own() {  # hostile: every other terminal says the opposite
  echo working > hc-status-t2; ring idle; expect_rc 1; expect_eq "$(rang)" ""
  echo done > hc-status-t2; ring working; expect_rc 0; expect_eq "$(rang)" "t2|Planning needs you: run /inbox."
  rm hc-status-t2
}

test_no_ring_without_a_readable_hc_list() {  # hc ls failing or printing junk
  ring done; printf '#!/usr/bin/env bash\n[ "$1" = ls ] && { echo "not json"; exit 0; }\necho sent >> "$TEST_TMP/hd/hc.log"\n' > hd/hc
  rm -f hd/hc.log; RC=0; ( PATH="$TEST_TMP/hd:$PATH"; . "$SCRIPTS/lib.sh"; ring_team "$TEST_TMP/app" backend "x" ) || RC=$?
  expect_rc 1; expect_eq "$(rang)" ""
}

test_no_ring_when_the_tab_is_not_in_this_factory_s_space() {
  ring done '{"spaces":[{"name":"other","tabs":[{"name":"backend","terminals":[{"terminal":"t2"}]}]}]}'
  expect_rc 1; expect_eq "$(rang)" ""
}

test_a_ring_that_cannot_go_is_kept_for_the_sweep_without_its_words() {
  ring working; expect_rc 1; [ -f app/.factory/rings/backend ] || fail "a busy session's ring was dropped"
  expect_eq "$(wc -c < app/.factory/rings/backend | tr -d ' ')" 0 "the kept ring holds words"
  rm -rf app/.factory; ring done; expect_rc 0; [ ! -e app/.factory/rings/backend ] || fail "a ring that went was kept"
  ring idle '{"spaces":[{"name":"app","tabs":[]}]}'; expect_rc 1; [ -f app/.factory/rings/backend ] || fail "a closed tab's ring was dropped"
  rm -rf app/.factory; RC=0; ( PATH="$(path_without herdr-app hc)"; . "$SCRIPTS/lib.sh"; ring_team "$TEST_TMP/app" backend x ) || RC=$?
  expect_rc 1; [ ! -e app/.factory/rings ] || fail "kept a ring without Herdr, where nothing will ring it"
  local bad
  for bad in "../evil" "a/b" "" "Backend" '$(touch pwned)'; do
    ( . "$SCRIPTS/lib.sh"; ring_later "$TEST_TMP/app" "$bad" ) && fail "ring_later took [$bad]"
  done
  [ ! -e evil ] && [ ! -e pwned ] && [ ! -e app/.factory/evil ] || fail "a hostile team name wrote outside rings/"
}

run_tests
