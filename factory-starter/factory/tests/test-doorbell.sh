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

run_tests
