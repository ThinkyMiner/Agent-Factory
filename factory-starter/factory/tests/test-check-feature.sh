# Tests for factory/scripts/check-feature.sh, the CI feature gate: a feature reaches main only from
# integrate/<f>, once its e2e report and research's acceptance review pass, feature/<f> is protected
# like main and make e2e passes; a feature branch takes only its own feature's items. Each test builds
# a bare origin with main, feature/<f> and integrate/<f>, and a fake gh that answers for protection.
. "$(dirname "$0")/lib.sh"
C="$SCRIPTS/check-feature.sh"
F=f001-share-links
CHECKS='["check","secrets","factory-tests","ownership","risk-gate"]'

commit() { git add -A && git commit -qm "${1:-change}"; }
head_is() { HEAD_REF=$1; HEAD_SHA=$(git rev-parse HEAD); export HEAD_REF HEAD_SHA; }
gate() { run "$C" "${1:-origin/main}"; }
# gh_branch <name> <protected> <contexts json> [enforcement level]: GitHub's answer for that branch
gh_branch() {
  mkdir -p "$(dirname "$TEST_TMP/gh/branches/$1")"
  jq -n --arg n "$1" --argjson p "$2" --argjson c "$3" --arg e "${4:-non_admins}" \
    '{name: $n, protected: $p, protection: {enabled: $p, required_status_checks: {enforcement_level: $e,
      contexts: $c, checks: ($c | map({context: ., app_id: 15368}))}}}' > "$TEST_TMP/gh/branches/$1.json"
}
# fake_branches: a gh on PATH answering `gh api repos/o/r/branches/<name>` from
# $TEST_TMP/gh/branches/<name>.json (404 when there is none). A line in $TEST_TMP/gh/fail is a
# pattern: a call matching it fails. Every call goes to $TEST_TMP/gh/log.
fake_branches() {
  mkdir -p "$TEST_TMP/ghbin" "$TEST_TMP/gh/branches"
  cat > "$TEST_TMP/ghbin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_TMP/gh/log"
if [ -f "$TEST_TMP/gh/fail" ]; then
  while IFS= read -r p; do [ -n "$p" ] && [[ "$*" == *$p* ]] && { echo "HTTP 502: fake failure" >&2; exit 1; }; done < "$TEST_TMP/gh/fail"
fi
[ "$1" = api ] && [ $# -eq 2 ] && [[ "$2" == repos/o/r/branches/* ]] || { echo "fake gh: unsupported: $*" >&2; exit 1; }
f="$TEST_TMP/gh/branches/${2#repos/o/r/branches/}.json"
[ -f "$f" ] || { echo "HTTP 404: Branch not found" >&2; exit 1; }
cat "$f"
SH
  chmod +x "$TEST_TMP/ghbin/gh"
  export PATH="$TEST_TMP/ghbin:$PATH" GH_REPO=o/r GH_TOKEN=fake
  gh_branch main true "$CHECKS"; gh_branch "feature/$F" true "$CHECKS"
}
# report <pass|fail> <commit> [round]: features/$F/e2e-report.md as integrate.sh writes it
report() {
  mkdir -p "features/$F"
  printf '# E2E report: %s\nE2E: %s\nround: %s\ncommit: %s\nfeature: %s\nmain: %s\nexit: %s\nran: 2026-11-16T10:00:00Z\n\n## Output (last 200 lines)\n    AC1: a share link works ... ok\n' \
    "$F" "$1" "${3:-1}" "$2" "$(git rev-parse "origin/feature/$F")" "$(git rev-parse origin/main)" "$([ "$1" = pass ] && echo 0 || echo 2)" > "features/$F/e2e-report.md"
}
# review <verdict> <e2e-commit>: features/$F/acceptance-review.md as research writes it
review() {
  mkdir -p "features/$F"
  printf '# Acceptance review: %s\nVERDICT: %s\ne2e-commit: %s\n- AC1: met | AC1 passes, report line 11\n' "$F" "$1" "$2" > "features/$F/acceptance-review.md"
}
# item <id-slug> <extra frontmatter line or "">: a backend work folder
item() { mkdir -p "work/$1"; { echo '---'; echo "id: ${1%%-*}"; echo 'team: backend'; [ -z "$2" ] || echo "$2"; echo '---'; } > "work/$1/spec.md"; }

# world [product]: origin.git with main (a roster; a Makefile whose e2e runs tests/e2e/*/*.sh),
# feature/$F (a backend item writing server/share.js, research's acceptance.md, then research's
# acceptance review of the passing round) and integrate/$F (the e2e tests, the round's report, then
# feature/$F merged, as integrate.sh pr leaves it). The checkout $TEST_TMP/app is on integrate/$F,
# HEAD_REF and HEAD_SHA name it, E2E is the tested commit. [product] is what the item writes
# (default "share: works", which the e2e test wants).
world() {
  mkrepo seed && cd seed && mkdir -p factory server
  cat > factory/teams.json <<'JSON'
{ "version": 1, "default_team": "backend",
  "teams": { "orchestrator": { "owns": ["planning/*", "tests/e2e/*", "features/*/e2e-report.md", "features/*/attribution.md",
                                        "features/*/FEATURE.md", "features/*/tickets.jsonl"] },
             "backend":  { "owns": ["server/*"] },
             "research": { "owns": ["research/*", "features/*/acceptance.md", "features/*/acceptance-review.md"] } } }
JSON
  printf 'e2e:\n\t@for t in tests/e2e/*/*.sh; do [ -f "$$t" ] || continue; sh "$$t" || exit 1; done\n' > Makefile
  echo 'share: todo' > server/share.js; commit base
  cd "$TEST_TMP" && git clone -q --bare seed origin.git && git clone -q origin.git app && cd app
  git switch -q -c "feature/$F"
  item 12-share "feature: $F"; echo "${1:-share: works}" > server/share.js; commit "share links"
  mkdir -p "features/$F"; printf '# Acceptance: %s\n\n## AC1: A share link works\n- decisions: c001-D01\n- check: open it\n' "$F" > "features/$F/acceptance.md"
  commit acceptance; git push -q origin "feature/$F"
  git switch -q -c "integrate/$F"
  mkdir -p "tests/e2e/$F"; echo 'grep -q "share: works" server/share.js' > "tests/e2e/$F/ac1.sh"; commit "e2e tests"
  git merge -q --no-edit origin/main
  E2E=$(git rev-parse HEAD)
  report pass "$E2E"; commit "round 1"; git push -q origin "integrate/$F"
  git switch -q "feature/$F"; review accept "$E2E"; commit "acceptance review"; git push -q origin "feature/$F"
  git switch -q "integrate/$F"; git merge -q --no-edit "origin/feature/$F"; git push -q origin "integrate/$F"
  head_is "integrate/$F"
  fake_branches
}

# ---- done when: integrate/<f> -> main is blocked until e2e and acceptance pass ----

test_integrate_pr_passes_when_everything_holds() {
  world; gate; expect_rc 0
  expect_out "feature: integrate/$F -> main"
  expect_out "ok       base is main"; expect_out "ok       origin/feature/$F exists"
  expect_out "ok       the e2e report says E2E: pass for commit $E2E (round 1)"
  expect_out "ok       the acceptance review says VERDICT: accept for commit $E2E"
  expect_out "ok       nothing but records (features/$F/, work/, memory/observations/) changed since commit $E2E"
  expect_out "ok       feature/$F is protected and requires main's checks (check, factory-tests, ownership, risk-gate, secrets)"
  expect_out "ok       make e2e passes"; expect_out "feature: ok"
  expect_eq "$(grep -c 'branches/' "$TEST_TMP/gh/log")" 2 "one gh call per branch"
  # Reports are read at HEAD_SHA, never from the working tree.
  review reject "$E2E"; gate; expect_rc 0
  commit; head_is "integrate/$F"; review accept "$E2E"
  gate; expect_rc 1; expect_out "NOT OK   the acceptance review does not say VERDICT: accept (found: reject)"
}

test_integrate_pr_fails_without_an_accepting_acceptance_review() {
  world; git rm -q "features/$F/acceptance-review.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "NOT OK   features/$F/acceptance-review.md is missing at the head commit"
  expect_out "NOT RUN  make e2e"; expect_err "cannot reach main yet"
  local v
  for v in reject 'accept | reject' Accept ACCEPT accepted 'accept, mostly' 'accept (all met)' '' '$(touch pwned)'; do
    review "$v" "$E2E"; commit; head_is "integrate/$F"
    gate; [ "$RC" = 1 ] || fail "VERDICT [$v] passed"; expect_out "NOT OK   the acceptance review does not say VERDICT: accept"
  done
  [ ! -e pwned ] || fail "a verdict was executed"
  printf '# Acceptance review: %s\nAll criteria met.\ne2e-commit: %s\n' "$F" "$E2E" > "features/$F/acceptance-review.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "(found: no exact verdict)"                                      # no VERDICT line
  printf 'VERDICT: reject\nVERDICT: accept\ne2e-commit: %s\n' "$E2E" > "features/$F/acceptance-review.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "(found: reject)"                                                # the first one counts
  printf 'Summary.\r\nVERDICT:\taccept  \r\ne2e-commit: %s \r\n' "$E2E" > "features/$F/acceptance-review.md"; commit; head_is "integrate/$F"
  gate; expect_rc 0                                                                              # CR and blanks around the word
}

test_acceptance_review_must_be_of_the_tested_commit() {
  world
  review accept "$(git rev-parse origin/main)"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "NOT OK   the acceptance review is of commit $(git rev-parse origin/main), not of the e2e report's commit $E2E"
  local c
  for c in "${E2E:0:12}" "$(printf '%s' "$E2E" | tr a-f A-F)" "$E2E extra" "${E2E}0" "<the commit: line of the e2e report it reviewed>"; do
    review accept "$c"; commit; head_is "integrate/$F"
    gate; [ "$RC" = 1 ] || fail "e2e-commit [$c] passed"; expect_out "no 'e2e-commit: <40-hex sha>' line"
  done
  printf '# Acceptance review: %s\nVERDICT: accept\n' "$F" > "features/$F/acceptance-review.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "no 'e2e-commit: <40-hex sha>' line"
}

test_integrate_pr_fails_when_make_e2e_fails() {
  # The report says pass and research accepted it, but the product does not do what the e2e test
  # checks: CI's own make e2e has the last word.
  world "share: broken"; gate; expect_rc 1
  expect_out "ok       the acceptance review says VERDICT: accept"; expect_out "ok       feature/$F is protected"
  expect_out "running make e2e"; expect_out "NOT OK   make e2e fails"
}

test_integrate_pr_fails_when_feature_branch_is_unprotected() {
  world
  gh_branch "feature/$F" false '[]' off
  gate; expect_rc 1; expect_out "NOT OK   feature/$F is not protected on GitHub"; expect_out "NOT RUN  make e2e"
  gh_branch "feature/$F" true '["check","secrets","factory-tests","ownership"]'
  gate; expect_rc 1; expect_out "NOT OK   feature/$F does not require main's checks: risk-gate"
  gh_branch "feature/$F" true '[]'; gate; expect_rc 1; expect_out "does not require main's checks: check, factory-tests, ownership, risk-gate, secrets"
  gh_branch "feature/$F" true "$CHECKS" off; gate; expect_rc 1; expect_out "required status checks are switched off"
  gh_branch "feature/$F" true '["check","secrets","factory-tests","ownership","risk-gate","lint"]'; gate; expect_rc 0   # more than main is fine
  jq '.protection.required_status_checks.contexts = []' "$TEST_TMP/gh/branches/feature/$F.json" > t && mv t "$TEST_TMP/gh/branches/feature/$F.json"
  gate; expect_rc 0                                                                              # checks[] alone counts
  jq '.protection.required_status_checks.checks = []' "$TEST_TMP/gh/branches/feature/$F.json" > t && mv t "$TEST_TMP/gh/branches/feature/$F.json"
  gate; expect_rc 1                                                                              # and then there is nothing
  gh_branch "feature/$F" true "$CHECKS"
  jq '.protected = "true"' "$TEST_TMP/gh/branches/feature/$F.json" > t && mv t "$TEST_TMP/gh/branches/feature/$F.json"
  gate; expect_rc 1; expect_out "is not protected"                                               # only the boolean
  gh_branch "feature/$F" true "$CHECKS"; gh_branch main false '[]' off
  gate; expect_rc 1; expect_out "main requires no status checks on GitHub"                       # nothing to compare with
}

test_a_gh_failure_fails_the_gate() {
  world
  echo "branches/feature" > "$TEST_TMP/gh/fail"; gate; expect_rc 1; expect_out "NOT OK   cannot read branch protection from GitHub: HTTP 502"
  echo "branches/main" > "$TEST_TMP/gh/fail"; gate; expect_rc 1; expect_out "cannot read branch protection"
  rm "$TEST_TMP/gh/fail" "$TEST_TMP/gh/branches/feature/$F.json"; gate; expect_rc 1; expect_out "HTTP 404"
  local j
  for j in '{"protected": true' '[]' '"x"' '' '{"protected": true, "protection": "x"}' \
           '{"protected": true, "protection": {"required_status_checks": {"contexts": "check"}}}' \
           '{"protected": true, "protection": {"required_status_checks": {"checks": [1, 2]}}}'; do
    printf '%s' "$j" > "$TEST_TMP/gh/branches/feature/$F.json"; gate; [ "$RC" = 1 ] || fail "feature answer [$j] passed"
    gh_branch "feature/$F" true "$CHECKS"; printf '%s' "$j" > "$TEST_TMP/gh/branches/main.json"; gate; [ "$RC" = 1 ] || fail "main answer [$j] passed"
    gh_branch main true "$CHECKS"
  done
  expect_out "cannot read the required checks from GitHub's answer"
  gate; expect_rc 0
  for j in '' 'o' 'o/r/x' '../r' 'o/r;id' $'o/r\nx'; do GH_REPO=$j gate; [ "$RC" = 1 ] || fail "GH_REPO [$j] passed"; done
  expect_out "GH_REPO is not owner/name"
}

test_feature_branch_into_main_always_fails() {
  world; git switch -q "feature/$F"; head_is "feature/$F"
  gate; expect_rc 1; expect_err "A feature reaches main only from integrate/$F, opened by integrate.sh pr"
  git merge -q --no-edit "origin/integrate/$F"; head_is "feature/$F"                           # even holding all of it
  gate; expect_rc 1; expect_err "A feature reaches main only from integrate/$F"
  [ ! -f "$TEST_TMP/gh/log" ] || fail "asked GitHub about a pull request that fails anyway"
}

# ---- the integration branch's own requirements ----

test_e2e_report_problems() {
  world
  report fail "$E2E"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "NOT OK   the e2e report says E2E: fail (round: 1)"
  { cat "features/$F/e2e-report.md"; printf '    filler\n%.0s' 1 2 3 4 5 6 7 8; printf 'E2E: pass\n'; } > r && mv r "features/$F/e2e-report.md"
  [ "$(grep -n '^E2E: pass' "features/$F/e2e-report.md" | cut -d: -f1)" = 20 ] || fail "the test's pass line is not line 20"
  commit; head_is "integrate/$F"; gate; expect_rc 1; expect_out "says E2E: fail"                  # pass on line 20, fail on its E2E line
  report pass "$E2E"; sed -i.bak '/^E2E:/d' "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "second line is not 'E2E: pass': round: 1"                     # no E2E line
  local l
  for l in 'E2E: PASS' 'E2E: pass (flaky)' 'E2E:pass' ' E2E: pass' 'E2E: pass | fail'; do
    report pass "$E2E"; L=$l perl -pi -e '$_ = "$ENV{L}\n" if $. == 2' "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
    gate; [ "$RC" = 1 ] || fail "E2E line [$l] passed"
  done
  report pass "${E2E:0:7}"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "fourth line is not 'commit: <40-hex sha>': commit: ${E2E:0:7}"; expect_out "no tested commit to compare"
  report pass "$(printf '%s' "$E2E" | tr a-f A-F)"; commit; head_is "integrate/$F"; gate; expect_rc 1; expect_out "fourth line is not"
  report pass "$E2E"; perl -pi -e 's/^commit: /commit:  /' "features/$F/e2e-report.md"; commit; head_is "integrate/$F"; gate; expect_rc 1
  report pass "$E2E"; perl -ni -e 'print unless $. == 3' "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "fourth line is not"                                             # lines out of order
  local ghost=0123456789abcdef0123456789abcdef01234567
  report pass "$ghost"; review accept "$ghost"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "NOT OK   the tested commit $ghost is not in this repository"
  report pass "$E2E"; review accept "$E2E"; perl -pi -e 's/f001-share-links/f002-other/ if $. == 1' "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "is not this feature's e2e report"                              # another feature's report
  report pass "$E2E"; perl -pi -e 's/\n/\r\n/' "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
  gate; expect_rc 0                                                                              # CRLF is still the report
  git rm -q "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "NOT OK   features/$F/e2e-report.md is missing at the head commit"
}

test_code_changed_after_the_tested_commit_fails() {
  world
  echo 'share: works, faster' > server/share.js; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "NOT OK   code changed since the tested commit $E2E (run integrate.sh run again): server/share.js"
  expect_out "NOT RUN  make e2e"
  git reset -q --hard "origin/integrate/$F"
  echo true > "tests/e2e/$F/ac1.sh"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "changed since the tested commit $E2E (run integrate.sh run again): tests/e2e/$F/ac1.sh"   # a test weakened after the round
  git reset -q --hard "origin/integrate/$F"
  mkdir -p "features/${F}x"; echo x > "features/${F}x/notes.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "features/${F}x/notes.md"                                       # a look-alike folder is outside
  git reset -q --hard "origin/integrate/$F"
  echo '# generated' > "features/$F/FEATURE.md"; echo '{}' > "features/$F/tickets.jsonl"; commit; head_is "integrate/$F"
  gate; expect_rc 0                                                                              # records may change after the round
  # research's acceptance review brings its work folder and an observation with it
  mkdir -p work/9-acceptance-review memory/observations; echo 'team: research' > work/9-acceptance-review/spec.md
  echo obs > memory/observations/9.md; commit; head_is "integrate/$F"
  gate; expect_rc 0
  for p in work/notes.md workers/x.js memory/lessons.md memory/observationsx/a.md; do
    git reset -q --hard "origin/integrate/$F"; mkdir -p "$(dirname "$p")"; echo x > "$p"; commit; head_is "integrate/$F"
    gate; [ "$RC" = 1 ] || fail "$p after the round passed"; expect_out "$p"
  done
  git reset -q --hard "origin/integrate/$F"
  # main moved on after the round: merging it changes code, so a new round is needed
  git switch -q -c m origin/main; echo 'hotfix' > server/other.js; commit; git push -q origin m:main
  git switch -q "integrate/$F"; git merge -q --no-edit origin/main; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "code changed since the tested commit $E2E (run integrate.sh run again): server/other.js"
}

test_symlinks_are_not_reports() {
  world
  git mv "features/$F/e2e-report.md" "features/$F/real-report.md"; ln -s real-report.md "features/$F/e2e-report.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "features/$F/e2e-report.md is missing at the head commit, or not a regular file"
  git reset -q --hard "origin/integrate/$F"
  git mv "features/$F/acceptance-review.md" "features/$F/r.md"; ln -s r.md "features/$F/acceptance-review.md"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "acceptance-review.md is missing at the head commit, or not a regular file"
  git reset -q --hard "origin/integrate/$F"
  git mv "features/$F" elsewhere; ln -s elsewhere "features/$F"; commit; head_is "integrate/$F"
  gate; expect_rc 1; expect_out "e2e-report.md is missing"; expect_out "no tested commit"      # the folder itself a link
}

test_integrate_pr_goes_to_main_only() {
  world; gate "origin/feature/$F"; expect_rc 1
  expect_out "NOT OK   base is feature/$F: integrate/$F goes to main only"; expect_out "NOT RUN  make e2e"
}

test_integrate_pr_needs_the_feature_branch() {
  world; git push -q origin --delete "feature/$F"
  gate; expect_rc 1; expect_out "NOT OK   origin/feature/$F does not exist"
}

test_the_integration_pull_request_passes_ownership_and_specialists() {
  world
  HEAD_REF=integrate/$F run "$SCRIPTS/check-ownership.sh" origin/main; expect_rc 0; expect_out "integration pull request for $F"
  HEAD_REF=integrate/$F run "$SCRIPTS/check-specialists.sh" origin/main R1; expect_rc 0; expect_out "exempt"
}

# ---- hostile and malformed input ----

test_hostile_head_refs() {
  world
  local r
  for r in 'integrate/../x' "integrate/$F/../../main" 'integrate/$(touch pwned)' 'integrate/`touch pwned`' 'integrate/' \
           'integrate/f1-x' "Integrate/$F" "INTEGRATE/$F" 'integrate/F001-share-links' 'integrate/f001-x;id' "integrate/$F " \
           'feature/../x' "Feature/$F" "feature/$F extra" 'feature/login'; do
    HEAD_REF=$r gate; [ "$RC" = 1 ] || fail "head ref [$r] gave exit $RC"; expect_err "cannot parse the branch"
  done
  for r in $'integrate/f001-share-links\nfoo' $'integrate/f001-share-links\n' $'work/12-x\rintegrate/f001-share-links'; do
    HEAD_REF=$r gate; expect_rc 1; expect_err "control characters"
  done
  HEAD_REF='' gate; expect_rc 2; expect_err "HEAD_REF is not set"
  local s
  for s in '' HEAD "${HEAD_SHA:0:12}" '$(touch pwned)' 0000000000000000000000000000000000000000 "--output=x" "$(printf '%s' "$HEAD_SHA" | tr a-f A-F)"; do
    HEAD_SHA=$s gate; [ "$RC" = 2 ] || fail "HEAD_SHA [$s] gave exit $RC"
  done
  [ ! -e pwned ] && [ ! -e "$TEST_TMP/pwned" ] && [ ! -e x ] || fail "a head ref or sha was run"
  [ ! -f "$TEST_TMP/gh/log" ] || fail "asked GitHub about an unparseable pull request"
}

test_work_items_go_to_their_feature_branch() {
  world
  git switch -q -c work/13-more "origin/feature/$F"; item 13-more "feature: $F"; echo 'share: works, more' > server/share.js; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 0; expect_out "ok       work/13-more is an item of feature $F"; expect_out "feature: ok"
  item 13-more "feature: f002-other"; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 1; expect_out "is an item of feature f002-other: feature/$F takes only feature $F's items"
  item 13-more ""; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 1; expect_out "is not a feature's item (no feature: in its spec)"
  printf -- '---\nid: 13\nteam: backend\n---\nfeature: %s\n' "$F" > work/13-more/spec.md; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 1                                                          # only the frontmatter counts
  printf -- '---\r\nid: 13\r\nteam: backend\r\nfeature: %s \r\n---\r\n' "$F" > work/13-more/spec.md; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 0                                                          # CRLF and a trailing blank
  # Into main, from main.
  git switch -q -c work/14-main origin/main; item 14-main "feature: $F"; echo x > server/other.js; commit; head_is work/14-main
  gate origin/main; expect_rc 1; expect_out "NOT OK   work/14-main is an item of feature $F: its pull request goes to feature/$F, not main"
  item 14-main "feature: f002-other"; commit; head_is work/14-main
  gate origin/main; expect_rc 1; expect_out "goes to feature/f002-other, not main"                # even a feature with no branch yet
  item 14-main ""; commit; head_is work/14-main
  gate origin/main; expect_rc 0; expect_out "feature: not a feature pull request"
  printf -- '---\nid: 14\nteam: backend\n---\nfeature: %s\n' "$F" > work/14-main/spec.md; commit; head_is work/14-main
  gate origin/main; expect_rc 0
}

test_malformed_and_hostile_specs() {
  world; git switch -q -c work/13-more "origin/feature/$F"
  local v
  for v in "$F, f002-other" '$(touch pwned)' F001-share-links "$F extra" 'f1-x' "../$F" '<feature id>'; do
    item 13-more "feature: $v"; commit; head_is work/13-more
    gate "origin/feature/$F"; [ "$RC" = 1 ] || fail "feature [$v] passed into feature/$F"
    gate origin/main; [ "$RC" = 1 ] || fail "feature [$v] passed into main"; expect_out "its spec's feature: is not a feature id"
  done
  [ ! -e pwned ] || fail "a spec value was run"
  printf -- '---\nid: 13\nfeature: %s\nfeature: f002-other\n---\n' "$F" > work/13-more/spec.md; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 1; expect_out "its spec names more than one feature"
  item $'13-new\nline $(touch pwned)' "feature: $F"; item 13-more "feature: $F"; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 1; expect_err "carries exactly one work folder (an item of $F); this one has 2"
  [ ! -e pwned ] || fail "a folder name was run"
  git rm -rq -- work/13-*; mkdir -p work/13-more; printf -- '---\nfeature: %s\n---\n' "$F" > "$TEST_TMP/spec.md"
  ln -s "$TEST_TMP/spec.md" work/13-more/spec.md; commit; head_is work/13-more
  gate "origin/feature/$F"; expect_rc 1; expect_out "is not a feature's item"                    # a linked spec is not read through
}

test_feature_branch_takes_one_item_only() {
  world; git switch -q -c human "origin/feature/$F"; mkdir -p docs; echo x > docs/notes.md; commit; head_is human
  gate "origin/feature/$F"; expect_rc 1; expect_err "carries exactly one work folder (an item of $F); this one has 0"
  git update-ref refs/remotes/origin/feature/oops HEAD
  gate origin/feature/oops; expect_rc 1; expect_err "cannot parse the branch 'feature/oops'"     # a base that is not a feature's
}

test_single_team_mode_has_no_gate() {
  mkrepo r && cd r && git switch -q -c feature/login && echo x > a && commit && head_is feature/login
  run "$C" main; expect_rc 0; expect_out "single-team mode"
}

test_usage_and_environment_errors_exit_2() {
  world
  local a
  for a in "" "origin/main extra" "--help" "-x"; do run "$C" $a; [ "$RC" = 2 ] || fail "args [$a] gave exit $RC"; done
  run "$C" no-such-ref; expect_rc 2; expect_err "unknown base ref"
  cd "$TEST_TMP" && run "$C" origin/main; expect_rc 2; expect_err "inside the repository"
}

test_runs_from_a_ci_copy_and_a_subfolder() {
  world; mkdir "$TEST_TMP/ci"; cat "$C" > "$TEST_TMP/ci/check-feature.sh"
  run bash "$TEST_TMP/ci/check-feature.sh" origin/main; expect_rc 0
  cd server && run bash "$TEST_TMP/ci/check-feature.sh" origin/main; expect_rc 0
}

run_tests
