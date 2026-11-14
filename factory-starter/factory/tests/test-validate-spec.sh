# Tests for factory/scripts/validate-spec.sh (exit 0 valid, 1 malformed, 3 blocking questions).
. "$(dirname "$0")/lib.sh"
V="$SCRIPTS/validate-spec.sh"

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
  run "$V" spec.md; expect_rc 0; expect_out "spec ok"
}

test_missing_file_is_malformed() {
  run "$V" nope.md; expect_rc 1; expect_err "file not found"
}

test_no_argument_is_malformed() {
  run "$V"; expect_rc 1
}

test_directory_is_malformed() {
  mkdir d; run "$V" d; expect_rc 1
}

test_each_required_field_is_checked() {
  local pat
  for pat in '^id:' '^title:' '^risk_floor:' '^tests:' '^## Problem' '^## Acceptance criteria' \
             '^- AC-1:' '^## Out of scope' '^## Assumptions' '^## Blocking questions'; do
    good_spec | grep -v -- "$pat" > spec.md
    run "$V" spec.md
    [ "$RC" = 1 ] || fail "removing [$pat] gave exit $RC, expected 1"
  done
}

test_placeholder_title_is_rejected() {
  good_spec | sed 's/^title: .*/title: <outcome, in a few words>/' > spec.md
  run "$V" spec.md; expect_rc 1; expect_err "title"
}

test_placeholder_id_is_rejected() {
  good_spec | sed 's/^id: .*/id: <issue number>/' > spec.md
  run "$V" spec.md; expect_rc 1; expect_err "id"
}

test_invalid_risk_floor_is_rejected() {
  good_spec | sed 's/^risk_floor: .*/risk_floor: R4/' > spec.md
  run "$V" spec.md; expect_rc 1; expect_err "risk_floor"
}

test_invalid_tests_value_is_rejected() {
  good_spec | sed 's/^tests: .*/tests: maybe/' > spec.md
  run "$V" spec.md; expect_rc 1
}

test_placeholder_in_criterion_is_rejected() {
  good_spec | sed 's/^- AC-1: .*/- AC-1: Given <starting state>, when <action>, then <result>./' > spec.md
  run "$V" spec.md; expect_rc 1; expect_err "placeholder"
}

test_blocking_question_stops_with_exit_3() {
  good_spec | sed 's/^None$/- Should drafts expire after a week?/' > spec.md
  run "$V" spec.md; expect_rc 3; expect_err "Should drafts expire"
}

test_none_variants_count_as_no_questions() {
  local v
  for v in 'None' 'none' '- None.' '-  none ' ''; do
    good_spec | sed "s/^None\$/$v/" > spec.md
    run "$V" spec.md
    [ "$RC" = 0 ] || fail "blocking questions [$v] gave exit $RC, expected 0"
  done
}

test_hostile_question_text_is_printed_not_run() {
  good_spec | awk '{ if ($0 == "None") print "- $(touch pwned) `touch pwned2` ; rm -rf ./x/"; else print }' > spec.md
  run "$V" spec.md; expect_rc 3; expect_err '$(touch pwned)'
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "question text was executed"
}

test_filename_starting_with_dash() {
  good_spec > ./-n.md
  run "$V" ./-n.md; expect_rc 0
  good_spec > ./--version
  run "$V" --version; expect_rc 0
}

test_binary_garbage_is_malformed() {
  head -c 4096 /dev/urandom > spec.md
  run "$V" spec.md; expect_rc 1
}

test_huge_spec_is_handled() {
  { good_spec; i=0; while [ $i -lt 20000 ]; do echo "- filler line $i with some text to make it big"; i=$((i+1)); done; } > spec.md
  run "$V" spec.md; expect_rc 0
}

test_crlf_spec_is_rejected_not_misread() {
  # Windows line endings break the frontmatter patterns; the script fails closed rather than passing.
  good_spec | sed 's/$/\r/' > spec.md
  run "$V" spec.md; expect_rc 1
}

run_tests
