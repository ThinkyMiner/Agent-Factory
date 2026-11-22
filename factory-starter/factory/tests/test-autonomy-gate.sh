# Tests for factory/scripts/autonomy-gate.sh: with AUTONOMY=on in main's policy, an R0-R2 change
# that leaves the factory as main has it needs no label (exit 0); anything else needs it (exit 1),
# and what cannot be read is exit 2. Each test builds main and a branch on top of it.
. "$(dirname "$0")/lib.sh"
G="$SCRIPTS/autonomy-gate.sh"

setup() {  # setup [on|off|none]: main with a policy, the kit and product code; cwd on branch pr
  mkrepo r && cd r
  mkdir -p factory/scripts .claude/agents .github/workflows teams/backend docs/factory memory/reflections server
  case "${1:-on}" in on) echo AUTONOMY=on > factory/policy.env ;; off) echo AUTONOMY=off > factory/policy.env ;; esac
  echo '#!/bin/sh' > factory/scripts/x.sh; echo prompt > .claude/agents/a.md; echo ci > .github/workflows/ci.yml
  echo charter > teams/backend/CHARTER.md; echo doc > docs/factory/TEAMS.md; echo '# Lessons' > memory/lessons.md
  echo r > memory/reflections/r1.md; echo base > server/a.js; echo old > factory/scripts/gone.sh
  git add -A && git commit -qm main && git switch -q -c pr
}
gate() { run "$G" main main "${1:-R2}"; }
change() {  # change <path> <content>: commit it on the current branch
  mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" > "$1" && git add -A && git commit -qm "change" -- . >/dev/null
}

test_off_or_no_policy_needs_the_label() {
  setup off; change server/a.js new
  gate; expect_rc 1; expect_out "AUTONOMY is not on"
  cd "$TEST_TMP" && rm -rf r && setup none; change server/a.js new
  gate; expect_rc 1; expect_out "AUTONOMY is not on"
  local v
  for v in ON yes '"on"' 'on; touch pwned' '$(touch pwned)' '`touch pwned`' onn; do
    git switch -q main; printf 'AUTONOMY=%s\n' "$v" > factory/policy.env; git add factory/policy.env; git commit -qm "policy $v"; git switch -q pr
    gate; expect_rc 1; expect_out "AUTONOMY is not on"
  done
  [ ! -e pwned ] || fail "a policy value was executed"
}

test_on_a_product_change_up_to_r2_needs_no_label() {
  setup; change server/a.js new; change package.json '{}'; change docs/notes.md n
  local t
  for t in R0 R1 R2; do gate "$t"; expect_rc 0; expect_out "no label needed: AUTONOMY=on, $t"; done
  gate R3; expect_rc 1; expect_out "R3: the factory never makes these changes"
}

test_on_a_change_to_the_factory_needs_the_label() {
  local p
  for p in factory/scripts/x.sh factory/policy.env factory/scripts/new.sh .claude/agents/a.md .claude/settings.json \
           .github/workflows/ci.yml teams/backend/CHARTER.md docs/factory/TEAMS.md memory/lessons.md memory/reflections/r2.md; do
    cd "$TEST_TMP" && rm -rf r && setup; change server/a.js new; change "$p" "a change"
    gate; expect_rc 1; expect_out "changes the factory itself, so it needs your label: $p"
  done
  cd "$TEST_TMP" && rm -rf r && setup; git rm -q factory/scripts/gone.sh && git commit -qm rm
  gate; expect_rc 1; expect_out "factory/scripts/gone.sh"                            # deleting a kit file changes it
  cd "$TEST_TMP" && rm -rf r && setup; chmod +x factory/scripts/x.sh && git commit -qam mode
  gate; expect_rc 1; expect_out "factory/scripts/x.sh"                               # so does its mode
  cd "$TEST_TMP" && rm -rf r && setup; change memory/observations/1.md o; change docs/factory-notes.md n
  gate; expect_rc 0                                                                  # look-alike paths are not the factory
}

test_a_sync_that_only_carries_mains_kit_needs_no_label() {
  setup; git switch -q -c feature; change server/a.js "the feature"
  git switch -q main
  change factory/scripts/x.sh "kit v2"; change .claude/agents/new.md "a new prompt"
  git rm -q factory/scripts/gone.sh && git commit -qm "kit drops a script"
  git switch -q -c sync feature && git merge -q --no-edit main
  run "$G" feature main R2; expect_rc 0; expect_out "no label needed"
  change .claude/agents/new.md "the sync's own edit"                                 # a sync that changes the kit itself
  run "$G" feature main R2; expect_rc 1; expect_out "changes the factory itself, so it needs your label: .claude/agents/new.md"
}

test_hostile_paths_are_read_whole_and_never_run() {
  setup
  change "server/a b.js" s; change "server/-x.js" d; change 'server/q"uote.js' q; change "server/\$(touch pwned).js" p
  change "$(printf 'server/new\nline.js')" nl; change 'server/:(glob)*' magic
  gate; expect_rc 0; expect_out "no label needed"
  change "$(printf 'factory/-evil\nname.sh')" k
  gate; expect_rc 1; expect_out "factory/-evilname.sh"                               # the newline is stripped from the message
  expect_eq "$(wc -l < "$OUT" | tr -d ' ')" 1 "lines of output"
  cd "$TEST_TMP" && rm -rf r && setup; change 'factory/:(glob)*' magic                # pathspec magic in a kit path
  gate; expect_rc 1; expect_out "factory/:(glob)*"
  cd "$TEST_TMP" && rm -rf r && setup; change 'factory/*' star                        # a file named *
  gate; expect_rc 1; expect_out "factory/*"
  [ ! -e pwned ] && [ ! -e server/pwned ] || fail "a path was executed"
}

test_what_cannot_be_read_is_exit_2() {
  setup; change server/a.js new
  run "$G"; expect_rc 2; expect_err "usage:"
  run "$G" main main; expect_rc 2; expect_err "usage:"
  run "$G" main main R2 extra; expect_rc 2
  local t
  for t in R4 r2 '' 'R2;touch pwned' ' R2' '$(touch pwned)'; do run "$G" main main "$t"; expect_rc 2; expect_err "not a tier"; done
  run "$G" nope main R2; expect_rc 2; expect_err "not a commit: nope"
  run "$G" main nope R2; expect_rc 2; expect_err "not a commit: nope"
  run "$G" --help main R2; expect_rc 2; expect_err "not a commit: --help"
  run "$G" main -x R2; expect_rc 2
  run "$G" 'main;touch pwned' main R2; expect_rc 2
  git switch -q --orphan lone && git commit -q --allow-empty -m lone                # no merge base with main
  run "$G" main main R2; expect_rc 2; expect_err "cannot diff"
  [ ! -e pwned ] || fail "an argument was executed"
}

test_ci_takes_the_autonomy_gate_from_main_only() {
  local y=$KIT/.github/workflows/ci.yml
  grep -qF 'git show "$RULES:factory/scripts/autonomy-gate.sh" > /tmp/autonomy-gate.sh' "$y" || fail "ci.yml does not take autonomy-gate.sh from main"
  grep -qF 'bash /tmp/autonomy-gate.sh "$BASE" "$RULES" "$TIER"' "$y" || fail "ci.yml does not run main's autonomy-gate.sh"
  ! grep -n 'cp factory/scripts/autonomy-gate.sh\|scripts/autonomy-gate.sh.*; do\|for f in .*autonomy-gate' "$y" || fail "ci.yml may run the pull request's own autonomy-gate.sh"
  # it runs only for R2, before the label check, and R3 still always fails
  awk '/^            R2\)/{r2=1} /autonomy-gate/{if(!r2) bad=1} /^            R3\)/{exit} END{exit bad}' "$y" || fail "autonomy-gate.sh runs outside the R2 branch"
  grep -A2 '^            R3)' "$y" | grep -q 'exit 1' || fail "R3 no longer always fails"
}

run_tests
