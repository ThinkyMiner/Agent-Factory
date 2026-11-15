# Tests for factory/scripts/validate-spec.sh (exit 0 valid, 1 malformed, 3 blocking questions).
. "$(dirname "$0")/lib.sh"
# single <args>: the validator in single-team mode, from a copy of the scripts with no roster next
# to it, because the repository running these tests may itself be in team mode.
single() {
  local k="$TEST_TMP/.single/factory/scripts"
  [ -x "$k/validate-spec.sh" ] || { mkdir -p "$k" && cp "$SCRIPTS/validate-spec.sh" "$SCRIPTS/lib.sh" "$k/"; }
  "$k/validate-spec.sh" "$@"
}

good_spec() {
  cat <<'EOF'
---
id: 42
title: Save an entry offline
risk_floor: R1
tests: required
status: specified
---

## Problem
A user who loses connection loses what they typed.

## Acceptance criteria
- AC-1: Given no network, when the user saves, then the text stays in the editor and a message says it was not saved.

## Out of scope
- Sync.

## Assumptions
- None.

## Blocking questions
None

## Expected touch points
- src/main.ts
EOF
}

test_valid_spec_passes() {
  good_spec > spec.md
  run single spec.md; expect_rc 0; expect_out "spec ok"
}

test_missing_file_is_malformed() {
  run single nope.md; expect_rc 1; expect_err "file not found"
}

test_no_argument_is_malformed() {
  run single; expect_rc 1
}

test_directory_is_malformed() {
  mkdir d; run single d; expect_rc 1
}

test_each_required_field_is_checked() {
  local pat
  for pat in '^id:' '^title:' '^risk_floor:' '^tests:' '^## Problem' '^## Acceptance criteria' \
             '^- AC-1:' '^## Out of scope' '^## Assumptions' '^## Blocking questions'; do
    good_spec | grep -v -- "$pat" > spec.md
    run single spec.md
    [ "$RC" = 1 ] || fail "removing [$pat] gave exit $RC, expected 1"
  done
}

test_placeholder_title_is_rejected() {
  good_spec | sed 's/^title: .*/title: <outcome, in a few words>/' > spec.md
  run single spec.md; expect_rc 1; expect_err "title"
}

test_placeholder_id_is_rejected() {
  good_spec | sed 's/^id: .*/id: <issue number>/' > spec.md
  run single spec.md; expect_rc 1; expect_err "id"
}

test_invalid_risk_floor_is_rejected() {
  good_spec | sed 's/^risk_floor: .*/risk_floor: R4/' > spec.md
  run single spec.md; expect_rc 1; expect_err "risk_floor"
}

test_invalid_tests_value_is_rejected() {
  good_spec | sed 's/^tests: .*/tests: maybe/' > spec.md
  run single spec.md; expect_rc 1
}

test_placeholder_in_criterion_is_rejected() {
  good_spec | sed 's/^- AC-1: .*/- AC-1: Given <starting state>, when <action>, then <result>./' > spec.md
  run single spec.md; expect_rc 1; expect_err "placeholder"
}

test_blocking_question_stops_with_exit_3() {
  good_spec | sed 's/^None$/- Should drafts expire after a week?/' > spec.md
  run single spec.md; expect_rc 3; expect_err "Should drafts expire"
}

test_none_variants_count_as_no_questions() {
  local v
  for v in 'None' 'none' '- None.' '-  none ' ''; do
    good_spec | sed "s/^None\$/$v/" > spec.md
    run single spec.md
    [ "$RC" = 0 ] || fail "blocking questions [$v] gave exit $RC, expected 0"
  done
}

test_hostile_question_text_is_printed_not_run() {
  good_spec | awk '{ if ($0 == "None") print "- $(touch pwned) `touch pwned2` ; rm -rf ./x/"; else print }' > spec.md
  run single spec.md; expect_rc 3; expect_err '$(touch pwned)'
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "question text was executed"
}

test_filename_starting_with_dash() {
  good_spec > ./-n.md
  run single ./-n.md; expect_rc 0
  good_spec > ./--version
  run single --version; expect_rc 0
}

test_binary_garbage_is_malformed() {
  head -c 4096 /dev/urandom > spec.md
  run single spec.md; expect_rc 1
}

test_huge_spec_is_handled() {
  { good_spec; i=0; while [ $i -lt 20000 ]; do echo "- filler line $i with some text to make it big"; i=$((i+1)); done; } > spec.md
  run single spec.md; expect_rc 0
}

test_crlf_spec_is_rejected_not_misread() {
  # Windows line endings break the frontmatter patterns; the script fails closed rather than passing.
  good_spec | perl -pe 's/\n/\r\n/' > spec.md
  run single spec.md; expect_rc 1
}

# Team mode: the validator reads the roster next to itself, so these run a copy of the scripts.
team_kit() {
  mkdir -p k/factory/scripts && cp "$SCRIPTS/validate-spec.sh" "$SCRIPTS/lib.sh" k/factory/scripts/
  printf '%s' '{"teams":{"backend":{"owns":["server/*"]},"research":{"owns":["research/*"],"active":false}}}' > k/factory/teams.json
}
with_team() { good_spec | awk -v t="$1" '{print} NR==2 && t != "-" {print "team: " t}' > s.md; }

test_team_mode_requires_an_active_team() {
  team_kit
  with_team backend;   run k/factory/scripts/validate-spec.sh s.md; expect_rc 0
  with_team -;         run k/factory/scripts/validate-spec.sh s.md; expect_rc 1; expect_err "active team"
  with_team research;  run k/factory/scripts/validate-spec.sh s.md; expect_rc 1
  with_team marketing; run k/factory/scripts/validate-spec.sh s.md; expect_rc 1
  with_team '.*';      run k/factory/scripts/validate-spec.sh s.md; expect_rc 1
  with_team '$(touch pwned)'; run k/factory/scripts/validate-spec.sh s.md; expect_rc 1
  [ ! -e pwned ] || fail "a team value was executed"
}

# with_line <line>: the good spec with one more frontmatter line
with_line() { good_spec | awk -v l="$1" '{print} NR==2 {print l}' > s.md; }

test_feature_and_decisions_are_optional_and_checked_when_present() {
  local v
  for v in 'feature: f001-share-links' 'feature: f999-a' 'decisions: c001-D01' \
           'decisions: c001-D01, c002-D12' 'decisions: c001-D01,c001-D02 ' 'feature: f001-share-links  ' "feature: f001-$(printf 'a%.0s' $(seq 1 41))"; do
    with_line "$v"; run single s.md; [ "$RC" = 0 ] || fail "[$v] gave exit $RC, expected 0: $(cat "$ERR")"
  done
  for v in 'feature:' 'feature: <the feature it is part of>' 'feature: f1-share' 'feature: f001-Share' \
           'feature: f001-' 'feature: f001-a b' 'feature: f001-../x' 'feature: f001-$(touch pwned)' \
           'feature: f001-a,f002-b' "feature: f001-$(printf 'a%.0s' $(seq 1 42))" \
           'decisions:' 'decisions: c001-D01,' 'decisions: c001-D1' 'decisions: c001-d01' \
           'decisions: c001-D01; c001-D02' 'decisions: c001-D01 c001-D02' 'decisions: `touch pwned2`' \
           'decisions: <the decision records it carries out>' 'decisions: c001-D01, ../c002-D02'; do
    with_line "$v"; run single s.md; [ "$RC" = 1 ] || fail "[$v] gave exit $RC, expected 1"
  done
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "a value was executed"
  with_line 'feature: nope'; run single s.md; expect_err "'feature' must name one feature"
  with_line 'decisions: nope'; run single s.md; expect_err "'decisions' must be decision ids"
}

test_feature_and_decisions_hostile_inputs() {
  # Outside the frontmatter the words are prose, not fields.
  good_spec > s.md; printf 'feature: whatever the text says\ndecisions: none yet\n' >> s.md
  run single s.md; expect_rc 0
  # A second, bad line is not hidden by a good one; CRLF fails closed; a 1 MB value is refused.
  good_spec | awk '{print} NR==2 {print "feature: f001-ok"; print "feature: f002-$(id)"}' > s.md
  run single s.md; expect_rc 1
  good_spec | awk '{print} NR==2 {print "decisions: c001-D01"}' | perl -pe 's/\n/\r\n/' > s.md
  run single s.md; expect_rc 1
  { echo '---'; echo 'id: 42'; printf 'decisions: c001-D01'; head -c 1048576 /dev/zero | tr '\0' ','; echo
    good_spec | sed 1,2d; } > s.md
  run single s.md; expect_rc 1; expect_err "'decisions'"
  # Valid in team mode too.
  team_kit; good_spec | awk '{print} NR==2 {print "team: backend"; print "feature: f001-share-links"; print "decisions: c001-D01, c001-D02"}' > s.md
  run k/factory/scripts/validate-spec.sh s.md; expect_rc 0
}

test_template_lines_are_placeholders_until_filled() {
  # Copied as is, the template's feature and decisions lines are placeholders, so it is not valid.
  grep -E '^(feature|decisions): <' "$KIT/factory/templates/spec.md" > lines
  expect_eq "$(lines lines)" 2 "the template has both optional lines"
  while IFS= read -r l; do with_line "$l"; run single s.md; expect_rc 1; done < lines
}

test_team_placeholder_rejected_outside_team_mode() {
  with_team '<your team>'; run single s.md; expect_rc 1; expect_err "placeholder"
  with_team -; run single s.md; expect_rc 0
}

run_tests
