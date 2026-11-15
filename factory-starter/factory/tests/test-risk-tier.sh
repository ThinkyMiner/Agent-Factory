# Tests for factory/scripts/risk-tier.sh, the tier risk-gate applies: the highest of the path rules,
# the spec's risk_floor, the floors of the decision records it names (from base) and the reports'
# RISK. Each test builds a base branch (main) and a pull-request branch on top of it.
. "$(dirname "$0")/lib.sh"
T="$SCRIPTS/risk-tier.sh"

setup() {
  mkrepo r && cd r
  mkdir -p server planning/c001-share factory/scripts
  echo base > server/a.js; echo '#!/bin/sh' > factory/scripts/x.sh
  cat > planning/c001-share/DECISIONS.md <<'EOF'
# Decisions: c001

## c001-D01: Share links are signed tokens
- owner: backend
- risk_floor: R2
### Decision
- risk_floor: R3
A field after a section heading is text, not a field.

## c001-D02: Links expire after 7 days
- owner: backend
### Decision
Seven days.

## c001-D03: Tokens are stored hashed
- risk_floor: R3
### Decision
x

## c001-D04: A garbled floor
- risk_floor: R9
### Decision
x

## c001-D05: A floor with a comment
- risk_floor: R2 # leaks are costly
### Decision
x
EOF
  git add -A && git commit -qm base
  git switch -q -c work/12-share
}
# spec <folder> [frontmatter line...]: a work folder's spec; the default risk_floor is R0
spec() {
  local d=$1; shift; mkdir -p "work/$d"
  { echo '---'; echo 'id: 12'; [ $# -gt 0 ] && printf '%s\n' "$@"; echo '---'; echo '## Problem'; } > "work/$d/spec.md"
}
report() { mkdir -p "work/$1"; printf '%s\n' "$3" > "work/$1/$2"; }   # report <folder> <file> <text>
commit() { git add -A && git commit -qm change; }
tier_is() { run "$T" main; expect_rc 0; expect_eq "$(cat "$OUT")" "$1" "${2:-tier}"; }

test_path_rules_alone() {
  setup; echo x >> server/a.js; commit
  tier_is R1; expect_err "R1  server/a.js"; expect_err "R1  path rules"
  echo '{}' > package.json; commit
  tier_is R2
}

test_spec_floor_raises_the_tier() {
  setup; spec 12-share 'risk_floor: R2'; echo x >> server/a.js; commit
  tier_is R2; expect_err "R2  work/12-share/spec.md risk_floor"
  spec 12-share 'risk_floor: R3'; commit
  tier_is R3
}

test_each_report_raises_the_tier() {
  local r
  for r in review.md ui-review.md security.md db-review.md; do
    setup; spec 12-share 'risk_floor: R1'; report 12-share "$r" $'VERDICT: pass\nRISK: R2   (touches login)'; commit
    tier_is R2 "$r"; expect_err "R2  work/12-share/$r RISK"
  done
  report 12-share security.md $'VERDICT: escalate\nRISK: R3'; commit
  tier_is R3
}

test_lower_values_never_lower_the_tier() {
  setup; echo '{}' > package.json
  spec 12-share 'risk_floor: R0' 'decisions: c001-D02'
  report 12-share review.md $'VERDICT: pass\nRISK: R0'; report 12-share security.md $'VERDICT: pass\nRISK: R1'; commit
  tier_is R2 "package.json is R2 by path; a lower floor, record or RISK does not lower it"
  setup; spec 12-share 'risk_floor: R2'; report 12-share review.md $'RISK: R0\nRISK: R3'; commit
  tier_is R2 "the first RISK line counts, and R0 does not lower the spec's R2"
}

test_decision_records_raise_the_tier() {
  setup; spec 12-share 'decisions: c001-D01'; echo x >> server/a.js; commit
  tier_is R2; expect_err "R2  decision c001-D01 risk_floor (planning/c001-share/DECISIONS.md)"
  spec 12-share 'decisions: c001-D02, c001-D03'; commit
  tier_is R3
  spec 12-share 'decisions: c001-D05'; commit
  tier_is R2 "a trailing comment after the floor"
  spec 12-share 'decisions: c001-D02'; commit
  tier_is R1 "a record without a floor; text after ### Decision is not a field"
}

test_decision_floors_come_from_base_only() {
  # The pull request lowers a record and adds a new one: neither counts, base's copy does.
  setup; spec 12-share 'decisions: c001-D03, c002-D01'
  sed -i.bak 's/^- risk_floor: R3$/- risk_floor: R0/' planning/c001-share/DECISIONS.md; rm planning/c001-share/DECISIONS.md.bak
  mkdir -p planning/c002-more; printf '## c002-D01: New\n- risk_floor: R3\n### Decision\nx\n' > planning/c002-more/DECISIONS.md
  commit
  run "$T" main; expect_rc 0
  expect_err "R3  decision c001-D03 risk_floor"; expect_err "1 decision(s) not on the base branch, ignored (first: c002-D01)"
  expect_eq "$(cat "$OUT")" R3
}

test_garbled_floor_on_base_is_ignored() {
  setup; spec 12-share 'decisions: c001-D04'; echo x >> server/a.js; commit
  tier_is R1; expect_err "decision c001-D04: risk_floor 'R9' in planning/c001-share/DECISIONS.md is not R0..R3, ignored"
}

test_single_team_mode_counts_the_floor_and_reports() {
  # setup() has no factory/teams.json: the floor and the reports count all the same.
  setup; [ ! -e factory/teams.json ] || fail "setup is meant to be single-team"
  spec 12-share 'risk_floor: R2'; echo x >> server/a.js; commit
  tier_is R2
  spec 12-share 'risk_floor: R1'; report 12-share review.md $'VERDICT: pass\nRISK: R2'; commit
  tier_is R2
  # The same in team mode.
  git switch -q main; echo '{"teams":{"backend":{"owns":["server/*"]}}}' > factory/teams.json; commit
  git switch -q work/12-share; git rebase -q main
  tier_is R2
}

test_hostile_values_are_ignored_not_run() {
  setup; echo x >> server/a.js
  spec 12-share 'risk_floor: R9' 'risk_floor: $(touch pwned)' 'risk_floor: `touch pwned2`'
  report 12-share review.md 'RISK: $(touch pwned3)'
  report 12-share security.md $'RISK: R10\nRISK: r3\nRISK:\nVERDICT: pass'
  commit
  tier_is R1
  expect_err "risk_floor 'R9' is not R0..R3, ignored"; expect_err "risk_floor '\$(touch pwned)' is not R0..R3"
  expect_err "work/12-share/review.md: no RISK line with R0..R3, ignored"
  expect_err "work/12-share/security.md: no RISK line with R0..R3, ignored"
  report 12-share review.md 'RISK: R2; rm -rf ./server'; commit
  tier_is R2 "the tier is read, the rest of the line is not run"
  [ -f server/a.js ] || fail "a RISK line was executed"
  spec 12-share 'decisions: c001-D01, ../../etc/passwd, $(touch pwned4), c1-D1, `id`, c001-D03,,c001-D03'; commit
  tier_is R3; expect_err "4 decision id(s) not like c001-D02, ignored (first: '../../etc/passwd')"
  for f in pwned pwned2 pwned3 pwned4; do [ ! -e "$f" ] || fail "$f: a value was executed"; done
}

test_missing_spec_and_garbled_files() {
  setup; report 12-share review.md $'VERDICT: pass\nRISK: R2'; commit
  tier_is R2; expect_err "work/12-share/spec.md: missing at HEAD"
  setup; mkdir -p work/12-share; head -c 4096 /dev/urandom > work/12-share/spec.md
  printf 'VERDICT: pa' > work/12-share/review.md; echo x >> server/a.js; commit         # truncated
  tier_is R1; expect_err "no risk_floor"; expect_err "review.md: no RISK line"
  setup; spec 12-share 'decisions:' 'decisions: ,,, ' 'risk_floor:'; echo x >> server/a.js; commit
  tier_is R1; expect_err "risk_floor '' is not R0..R3"
}

test_crlf_files_are_read() {
  setup; spec 12-share 'risk_floor: R2'; perl -pi -e 's/\n/\r\n/' work/12-share/spec.md
  printf 'VERDICT: pass\r\nRISK: R3\r\n' > work/12-share/review.md; commit
  tier_is R3; expect_err "R2  work/12-share/spec.md risk_floor"; expect_err "R3  work/12-share/review.md RISK"
  setup; perl -pi -e 's/\n/\r\n/' planning/c001-share/DECISIONS.md; git commit -qam crlf
  git switch -q main; git merge -q --ff-only work/12-share; git switch -q -c work/13-x
  spec 13-x $'decisions: c001-D03\r'; echo x >> server/a.js; commit
  tier_is R3 "a CRLF DECISIONS.md on base and a CRLF decisions line"
}

test_huge_inputs() {
  setup; mkdir -p work/12-share
  { echo '---'; printf 'decisions: '; head -c 1048576 /dev/zero | tr '\0' 'x' | sed 's/x\{9\}/c1-D1,../g'; echo ', c001-D03'; echo '---'; } > work/12-share/spec.md
  { head -c 1048576 /dev/zero | tr '\0' 'y'; echo; echo 'RISK: R2'; } > work/12-share/review.md
  echo x >> server/a.js; commit
  tier_is R3 "a 1 MB decisions line still finds its one real record"
  expect_err "decision id(s) not like c001-D02"
  [ "$(wc -l < "$ERR")" -lt 20 ] || fail "1 MB of garbage made $(wc -l < "$ERR") lines of stderr"
}

test_symlinks_are_not_followed() {
  setup; spec 12-share 'risk_floor: R0'
  printf 'RISK: R3\n' > other-risk.md; ln -s ../../other-risk.md work/12-share/review.md
  mkdir -p elsewhere; printf -- '---\nrisk_floor: R3\n---\n' > elsewhere/spec.md; ln -s ../elsewhere work/13-link
  echo x >> server/a.js; commit
  run "$T" main; expect_rc 0
  expect_err "work/12-share/review.md: no RISK line"     # the link's text, not its target
  [ "$(cat "$OUT")" = R1 ] || fail "a symlink was followed: $(cat "$OUT")"
}

test_hostile_folder_names() {
  setup; spec '12 $(touch pwned)' 'risk_floor: R2'; spec $'13-new\nline' 'risk_floor: R3'; commit
  run "$T" main; expect_rc 0; expect_eq "$(cat "$OUT")" R3
  expect_err 'R2  work/12 $(touch pwned)/spec.md risk_floor'; expect_err "work/13-newline/spec.md"
  [ ! -e pwned ] || fail "a folder name was executed"
}

test_rename_counts_both_names() {
  # git diff --name-only shows only the new name of a rename; the old one is R2 here.
  setup; mkdir -p docs; git mv factory/scripts/x.sh docs/x.md; commit
  tier_is R2; expect_err "R2  factory/scripts/x.sh"
}

test_highest_of_several_folders() {
  setup; spec 12-share 'risk_floor: R1'; spec 13-other 'risk_floor: R3'; report 14-third review.md 'RISK: R2'; commit
  tier_is R3
}

test_risk_rules_pass_through_and_ci_copy() {
  setup; spec 12-share 'risk_floor: R1'; echo x >> server/a.js; commit
  printf 'R3 server/*\n' > "$TEST_TMP/rules"
  RISK_RULES="$TEST_TMP/rules" run "$T" main; expect_rc 0; expect_eq "$(cat "$OUT")" R3
  # As risk-gate runs it: plain copies (no exec bit) in one flat temp dir.
  mkdir "$TEST_TMP/ci"; for f in risk-tier.sh classify-risk.sh; do cat "$SCRIPTS/$f" > "$TEST_TMP/ci/$f"; done
  cat "$KIT/factory/risk-rules.txt" > "$TEST_TMP/ci/risk-rules.txt"
  spec 12-share 'risk_floor: R2'; commit
  RISK_RULES="$TEST_TMP/ci/risk-rules.txt" run bash "$TEST_TMP/ci/risk-tier.sh" main; expect_rc 0; expect_eq "$(cat "$OUT")" R2
}

test_usage_and_environment_errors_exit_2() {
  setup; echo x >> server/a.js; commit
  run "$T" no-such-ref; expect_rc 2; expect_err "unknown base ref"
  run "$T" main extra; expect_rc 2; expect_err usage
  run "$T" --help; expect_rc 2
  RISK_RULES=/nonexistent run "$T" main; expect_rc 2; expect_err "rules file not found"
  cd "$TEST_TMP" && mkdir plain && cd plain && run "$T" main; expect_rc 2
}

run_tests
