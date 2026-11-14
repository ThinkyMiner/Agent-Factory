# Tests for factory/scripts/classify-risk.sh (prints R0..R3; highest file wins; unmatched is R1).
. "$(dirname "$0")/lib.sh"
C="$SCRIPTS/classify-risk.sh"

tier_of() { printf '%s\n' "$@" | "$C" --stdin 2>/dev/null; }

test_single_paths() {
  expect_eq "$(tier_of docs/setup.md)" R0 docs
  expect_eq "$(tier_of work/12-x/spec.md)" R0 work
  expect_eq "$(tier_of README.md)" R0 "*.md"
  expect_eq "$(tier_of src/notes/list.ts)" R1 "no rule"
  expect_eq "$(tier_of package.json)" R2 package.json
  expect_eq "$(tier_of src/auth/session.ts)" R2 "*auth*"
  expect_eq "$(tier_of .claude/settings.json)" R2 .claude
  expect_eq "$(tier_of factory/risk-rules.txt)" R2 factory
  expect_eq "$(tier_of db/migrations/001.sql)" R2 migrations
  expect_eq "$(tier_of .env.local)" R3 .env
  expect_eq "$(tier_of web/.env)" R3 "*/.env*"
  expect_eq "$(tier_of src/billing/invoice.ts)" R3 billing
}

test_highest_rule_wins_per_file() {
  expect_eq "$(tier_of CLAUDE.md)" R2 "CLAUDE.md is R2 even though *.md is R0"
  expect_eq "$(tier_of docs/auth.md)" R2 "*auth* beats docs/*"
}

test_change_takes_highest_file() {
  expect_eq "$(tier_of docs/a.md src/b.ts)" R1
  expect_eq "$(tier_of docs/a.md src/b.ts package.json)" R2
  expect_eq "$(tier_of docs/a.md .env)" R3
}

test_reasoning_goes_to_stderr() {
  printf 'package.json\n' > in
  run "$C" --stdin < in
  expect_out R2; expect_err "package.json  (package.json)"
}

test_empty_change_is_r0() {
  run "$C" --stdin < /dev/null; expect_rc 0; expect_out R0
}

test_blank_lines_ignored() {
  printf '\n\nsrc/a.ts\n\n' > in
  run "$C" --stdin < in; expect_out R1
}

test_missing_rules_file_exits_2() {
  RISK_RULES=/nonexistent run "$C" --stdin < /dev/null
  expect_rc 2; expect_err "rules file not found"
}

test_custom_rules_and_comments() {
  printf '# comment\n\nR3 secret/*\nR0 notes/*\n' > rules
  expect_eq "$(printf 'secret/x\n' | RISK_RULES=rules "$C" --stdin 2>/dev/null)" R3
  expect_eq "$(printf 'notes/x\n' | RISK_RULES=rules "$C" --stdin 2>/dev/null)" R0
  expect_eq "$(printf 'other\n' | RISK_RULES=rules "$C" --stdin 2>/dev/null)" R1
}

test_hostile_filenames_are_data() {
  expect_eq "$(tier_of '$(touch pwned).ts' '`touch pwned2`.ts' 'a;rm -rf x.ts')" R1
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "a filename was executed"
  # A path made of glob characters must not act as a pattern.
  expect_eq "$(tier_of '*')" R1 "bare * is a filename, not a wildcard"
  expect_eq "$(tier_of 'src/[abc].ts' 'src/?.ts')" R1
  expect_eq "$(tier_of 'src/with space/auth file.ts')" R2
  expect_eq "$(tier_of 'docs/é-ünïcode.md')" R0
}

test_git_mode_reads_the_diff() {
  mkrepo r && cd r
  git switch -q -c work/1-x
  mkdir -p docs && echo hi > docs/a.md && git add . && git commit -qm docs
  run "$C" main; expect_out R0
  echo '{}' > package.json && git add . && git commit -qm pkg
  run "$C" main; expect_out R2
}

test_git_mode_bad_base_fails() {
  mkrepo r && cd r
  run "$C" no-such-ref
  [ "$RC" != 0 ] || fail "an unknown base ref must not classify as R0"
}

run_tests
