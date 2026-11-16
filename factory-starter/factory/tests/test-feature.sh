# Tests for factory/scripts/feature.sh: acceptance criteria are checked line by line, and the feature
# record is rendered from GitHub and the files with untrusted text neutralised, or not written at all.
. "$(dirname "$0")/lib.sh"
FS="$SCRIPTS/feature.sh"
F=f001-share-links; C=c001-share-links
SHA=0123456789abcdef0123456789abcdef01234567

acc_ok() {
  cat <<'EOF'
# Acceptance: f001-share-links

Free text before the first criterion, ## AC lookalikes in prose included.

## AC1: A shared link opens the note read-only
- decisions: c001-D01
- check: Open a share link signed out. The note shows; no edit control is present.

## AC2: A link expires after 7 days
- decisions: c001-D01, c001-D02
- check: Move the clock 8 days on and open the link.
  It answers 410.
### Notes
Sub-headings inside a criterion are its text.
EOF
}
# bad <content> <expected line>: the file is refused with that problem
bad() { printf '%b' "$1" > b.md; run "$FS" check-acceptance b.md D.md; expect_rc 1; expect_out "$2"; }

test_valid_acceptance_passes() {
  acc_ok > a.md; decisions_ok c001 > D.md
  run "$FS" check-acceptance a.md D.md; expect_rc 0; expect_out "a.md: 2 criteria"
  run "$FS" check-acceptance a.md; expect_rc 0
  perl -pe 's/\n/\r\n/' a.md > crlf.md; run "$FS" check-acceptance crlf.md D.md; expect_rc 0
}

test_malformed_acceptance_is_refused_line_by_line() {
  decisions_ok c001 > D.md
  bad '# Acceptance\n\nno criteria here\n' 'b.md: no criteria'
  bad '## AC0: zero\n- decisions: c001-D01\n- check: x\n' 'b.md:1: "## AC0: zero" is not a criterion heading'
  bad '## AC01: leading zero\n- decisions: c001-D01\n- check: x\n' 'b.md:1: "## AC01: leading zero" is not a criterion heading'
  bad '## AC1:\n- decisions: c001-D01\n- check: x\n' 'b.md:1: "## AC1:" is not a criterion heading'
  bad '## AC1: a\n- decisions: c001-D01\n- check: x\n\n## AC1: again\n- decisions: c001-D01\n- check: y\n' 'b.md:5: AC1 appears twice'
  bad '## AC1: a\n- check: x\n' 'b.md:1: AC1 has no "- decisions:" line'
  bad '## AC1: a\n- decisions: c001-D01\n- decisions: c001-D02\n- check: x\n' 'b.md:1: AC1 has 2 "- decisions:" lines'
  bad '## AC1: a\n- decisions:\n- check: x\n' 'b.md:2: AC1 names no decision'
  bad '## AC1: a\n- decisions: D2, c001-D01\n- check: x\n' 'b.md:2: "D2" is not a decision id like c001-D02'
  bad '## AC1: a\n- decisions: c001-D09\n- check: x\n' 'b.md:2: c001-D09 is not a record in D.md'
  bad '## AC1: a\n- decisions: c001-D01\n- check:   \n' 'b.md:3: AC1: the check is empty'
  bad '## AC1: a\n- decisions: c001-D01\n' 'b.md:1: AC1 has no "- check:" line'
  bad '## AC1: a\n- decisions: c001-D01\n- check: x\n- check: y\n' 'b.md:1: AC1 has 2 "- check:" lines'
  bad '## AC1: a\n- decisions: c001-D01\n- check: x\n\n## Notes\nfree text after the criteria\n' 'b.md:5: "## Notes" is not a criterion heading'
  # every problem is reported, one line each
  printf '## AC1: a\n- decisions: X\n\n## AC1: b\n- check:\n' > m.md
  run "$FS" check-acceptance m.md D.md; expect_rc 1
  expect_eq "$(lines "$OUT")" 5 "problems in m.md: $(cat "$OUT")"
  run "$FS" check-acceptance missing.md D.md; expect_rc 1; expect_out "missing.md: cannot read it"
  acc_ok > a.md; run "$FS" check-acceptance a.md nope.md; expect_rc 1; expect_out "nope.md: cannot read it"
  run "$FS" check-acceptance; expect_rc 1; expect_err "usage"
  run "$FS" frobnicate; expect_rc 1
}

test_hostile_acceptance_text_is_never_run() {
  decisions_ok c001 > D.md
  printf '## AC1: $(touch pwned) `touch pwned2`\n- decisions: c001-D01, $(touch pwned3)\n- check: \x1b[31m$(touch pwned4)\n' > h.md
  run "$FS" check-acceptance h.md D.md; expect_rc 1; expect_out '"$(touch pwned3)" is not a decision id'
  grep -q "$(printf '\x1b')" "$OUT" && fail "a control character was echoed"
  for p in pwned pwned2 pwned3 pwned4; do [ ! -e "$p" ] || fail "$p: text was executed"; done
  head -c 1048576 /dev/zero | tr '\0' 'a' > big.md
  run "$FS" check-acceptance big.md D.md; expect_rc 1; expect_out "no criteria"
}

# a checkout on integrate/<f> with the records, and the fake gh holding the feature's issues
render_setup() {
  mkrepo app && cd app && git switch -q -c "integrate/$F"
  mkdir -p "features/$F" "planning/$C"
  acc_ok > "features/$F/acceptance.md"
  printf '%s\n' '{"item":"share-api","team":"backend","delivers":"POST /shares | GET /s/:token"}' 'not json' \
    '{"item":"share-button","team":"frontend","delivers":"a <b>Share</b> button"}' > "planning/$C/dispatch.jsonl"
  printf '# E2E report: %s\nE2E: pass\nround: 2\ncommit: %s\n' "$F" "$SHA" > "features/$F/e2e-report.md"
  printf '# Acceptance review: %s\nVERDICT: accept\ne2e-commit: %s\n' "$F" "$SHA" > "features/$F/acceptance-review.md"
  fake_gh
  T='x | y <script>alert(1)</script> @someone $(touch pwned) `touch pwned2`'$'\n''| injected | row |'
  jq -n --arg t "$T" --arg f "feature:$F" '[
    {number: 1, title: "share-api: POST /shares", state: "OPEN", labels: [{name: "team:backend"}, {name: $f}]},
    {number: 4, title: "older ticket", state: "CLOSED", labels: [{name: "ticket"}, {name: "from:frontend"}, {name: "to:backend"},
       {name: "type:request"}, {name: "state:verified"}, {name: $f}]},
    {number: 3, title: $t, state: "OPEN", labels: [{name: "ticket"}, {name: "from:orchestrator"}, {name: "to:backend"},
       {name: "type:bug"}, {name: "state:declined"}, {name: $f}]},
    {number: 5, title: "another feature", state: "OPEN", labels: [{name: "ticket"}, {name: "feature:f002-other"}]},
    {number: 6, title: "work item\n| fake | work row |", state: "OPEN", labels: [{name: "team:frontend"}, {name: $f}]}]' > "$FAKE_GH/issues.json"
  printf '%s\n' '{"item":"x","team":"frontend","delivers":"line one\n| fake | item row |"}' >> "planning/$C/dispatch.jsonl"
}

test_render_writes_the_feature_record() {
  render_setup
  run "$FS" render "$F"; expect_rc 0; expect_out "rendered features/$F/FEATURE.md"
  d="features/$F"
  expect_eq "$(jq -c '[.number, .from, .to, .type, .state, .closed]' "$d/tickets.jsonl" | tr '\n' ' ')" \
    '[3,"orchestrator","backend","bug","declined",false] [4,"frontend","backend","request","verified",true] '
  head -1 "$d/FEATURE.md" | grep -q "Generated by factory/scripts/feature.sh render $F. Do not edit" || fail "first line: $(head -1 "$d/FEATURE.md")"
  for want in "| AC1 | A shared link opens the note read-only |" "| AC2 | A link expires after 7 days |" \
              '| share-api | backend | POST /shares \| GET /s/:token |' "| share-button | frontend | a &lt;b&gt;Share&lt;/b&gt; button |" \
              "| #1 | backend | share-api: POST /shares | open |" "| #4 | frontend | backend | request | verified | older ticket |" \
              "- E2E report (features/$F/e2e-report.md): pass, round 2, commit $SHA" \
              "- Acceptance review (features/$F/acceptance-review.md): accept (e2e-commit $SHA)"; do
    grep -qF -- "$want" "$d/FEATURE.md" || fail "FEATURE.md lacks [$want]"
  done
  grep -q 'another feature' "$d/FEATURE.md" "$d/tickets.jsonl" && fail "another feature's issue was rendered"
  true
}

test_render_neutralises_untrusted_text() {
  render_setup
  run "$FS" render "$F"; expect_rc 0
  d="features/$F"
  row=$(grep '^| #3 ' "$d/FEATURE.md")
  expect_eq "$(grep -c '^| #3 ' "$d/FEATURE.md")" 1 "rows for ticket 3"
  case "$row" in *' |') ;; *) fail "ticket 3's row is broken: $row" ;; esac
  printf '%s' "$row" | grep -qF 'x \| y &lt;script&gt;alert(1)&lt;/script&gt; @'"$(printf '\xe2\x80\x8b')"'someone $(touch pwned)' || fail "row not neutralised: $row"
  printf '%s' "$row" | grep -qF '\| injected \| row \|' || fail "an embedded row was not escaped: $row"
  grep -q '<script>\|@someone' "$d/FEATURE.md" "$d/tickets.jsonl" && fail "raw HTML or a live @mention was written"
  grep -q '^| injected\|^| fake' "$d/FEATURE.md" && fail "a newline in a title or an item started a table row"
  grep -qF '| #6 | frontend | work item \| fake \| work row \| | open |' "$d/FEATURE.md" || fail "work issue 6's row: $(grep '#6' "$d/FEATURE.md")"
  jq -e . "$d/tickets.jsonl" >/dev/null || fail "tickets.jsonl is not JSON lines"
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "a title was executed"
}

test_render_writes_nothing_when_gh_fails_or_the_place_is_wrong() {
  render_setup
  d="features/$F"; echo old > "$d/FEATURE.md"; echo old > "$d/tickets.jsonl"
  echo "issue list" > "$FAKE_GH/fail"
  run "$FS" render "$F"; expect_rc 1; expect_err "nothing was written"
  expect_eq "$(cat "$d/FEATURE.md") $(cat "$d/tickets.jsonl")" "old old"
  rm "$FAKE_GH/fail"
  for x in '' F001-x '../f001-share-links' 'f001-x;touch pwned' "$F/../x"; do run "$FS" render "$x"; expect_rc 1; expect_err "usage"; done
  run "$FS" render f002-other; expect_rc 1; expect_err "render runs on integrate/f002-other"
  git switch -q -c main-ish; run "$FS" render "$F"; expect_rc 1; expect_err "render runs on integrate/$F"
  git switch -q "integrate/$F"
  echo secret > "$TEST_TMP/outside"; rm "$d/FEATURE.md"; ln -s "$TEST_TMP/outside" "$d/FEATURE.md"
  run "$FS" render "$F"; expect_rc 1; expect_err "is a symbolic link"
  expect_eq "$(cat "$TEST_TMP/outside")" secret
  [ ! -e pwned ] || fail "an argument was executed"
}

test_render_without_reports_says_so() {
  render_setup
  rm "features/$F/e2e-report.md" "features/$F/acceptance-review.md" "planning/$C/dispatch.jsonl"
  echo '[]' > "$FAKE_GH/issues.json"
  run "$FS" render "$F"; expect_rc 0
  grep -qF "e2e-report.md): none yet" "features/$F/FEATURE.md" || fail "no 'none yet' for the report"
  grep -qF "acceptance-review.md): none yet" "features/$F/FEATURE.md" || fail "no 'none yet' for the review"
  expect_eq "$(lines "features/$F/tickets.jsonl")" 0
  printf 'VERDICT: pass | reject\n' > "features/$F/acceptance-review.md"
  run "$FS" render "$F"; expect_rc 0
  grep -qF "acceptance-review.md): unreadable" "features/$F/FEATURE.md" || fail "a copied verdict template was not called unreadable"
}

run_tests
