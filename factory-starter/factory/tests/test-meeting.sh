# Phase 3's "done when": a scripted three-lead planning meeting, run through round.sh, position.sh,
# say.sh, decisions.sh and dispatch.sh, reaches approved decisions; every limit fires; and a second
# cycle cannot open while one is open. gh is faked; git and origin are real.
. "$(dirname "$0")/lib.sh"
R="$SCRIPTS/round.sh"; SAY="$SCRIPTS/say.sh"; POS="$SCRIPTS/position.sh"; DIS="$SCRIPTS/dispatch.sh"

test_three_lead_meeting_reaches_approved_decisions_and_dispatch() {
  planning_setup; fake_branches
  by orchestrator "$R" open share-links; expect_rc 0; expect_out "opened c001-share-links"
  C=c001-share-links; P="$MAIN/planning/$C"; status_is brief
  by orchestrator "$R" brief; expect_rc 1; expect_err "template lines"
  brief_ok "$C" "backend, frontend, research"
  by orchestrator "$R" brief; expect_rc 0; expect_out "draft pull request #1"
  jq -e '.draft == true and .head.ref == "planning/c001-share-links"' "$FAKE_GH/pulls/1.json" >/dev/null || fail "no draft PR for the brief"
  git -C "$TEST_TMP/origin.git" rev-parse -q --verify refs/heads/planning/$C >/dev/null || fail "the planning branch was not pushed"

  # Round 0: only your brief-approved label, after the last push, opens the meeting.
  by orchestrator "$R" next; expect_rc 1; expect_err "the brief is not approved: 'brief-approved' is not on #1"
  approve 1 brief-approved factory-bot; by orchestrator "$R" next; expect_rc 1; expect_err "added by factory-bot, not by human"
  approve 1; by orchestrator "$R" next; expect_rc 0; status_is positions

  # Round 1: positions are sealed until all are in, then published at once.
  cd "$TEST_TMP"; position_ok "POST /shares and GET /s/:token." > pb; position_ok "A Share button." > pf; position_ok "Interviews on sharing." > pr
  by backend "$POS" submit < "$TEST_TMP/pb"; expect_rc 0
  by orchestrator "$R" next; expect_rc 1; expect_err "waiting for positions from: frontend research"
  [ ! -e "$P/positions" ] || fail "a position was published before the round closed"
  by frontend "$POS" submit < "$TEST_TMP/pf"; by research "$POS" submit < "$TEST_TMP/pr"; expect_rc 0
  by orchestrator "$R" next; expect_rc 0; status_is discussion-1
  expect_eq "$(ls "$P/positions" | tr '\n' ' ')" "backend.md frontend.md research.md "
  grep -q "A Share button." "$P/positions/frontend.md" || fail "frontend's position was not published"
  expect_eq "$(jq -r 'select(.kind == "position") | .from' "$P/discussion.jsonl" | tr '\n' ' ')" "backend frontend research "

  # Round 2: discussion. The orchestrator names conflicts; teams answer.
  by orchestrator "$SAY" question --to frontend --body "Do share links expire? Your position says temporary."; expect_out c001-m004
  by orchestrator "$SAY" question --to backend --body "Can GET /s/:token return the note as JSON?"; expect_out c001-m005
  by frontend "$SAY" question --to backend --body "Is the token in the path or the query string?"; expect_out c001-m006
  by orchestrator "$R" next; expect_rc 1; expect_err "waiting for answers: c001-m004 frontend, c001-m005 backend, c001-m006 backend"
  by frontend "$SAY" answer --to orchestrator --refs c001-m004 --body "Yes: seven days unless decided otherwise."; expect_rc 0
  by backend "$SAY" answer --to orchestrator --refs c001-m005 --body "Yes, with Content-Type application/json."; expect_rc 0
  by backend "$SAY" answer --to frontend --refs c001-m006 --body "In the path: /s/:token."; expect_rc 0
  by orchestrator "$R" next --again; expect_rc 0; status_is discussion-2
  by orchestrator "$SAY" question --to research --body "Do people expect shared links to stop working?"; expect_rc 0
  by research "$SAY" answer --to orchestrator --refs c001-m010 --body "Most expect them to last about a week."; expect_rc 0
  by orchestrator "$R" next --again; expect_rc 1; expect_err "limit: 2 discussion rounds"
  by orchestrator "$R" next; expect_rc 0; status_is review
  by orchestrator "$R" next; expect_rc 0; status_is decisions

  # Round 4: decisions. One accept or objection per team per draft; objections stand until settled.
  by backend "$SAY" accept --to orchestrator --body "ok"; expect_rc 1; expect_err "no draft yet"
  decisions_ok c001 > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0; expect_out "draft 1 is out"
  by backend "$SAY" accept --to orchestrator --body "Accept draft 1."; expect_rc 0
  by frontend "$SAY" objection --to orchestrator --refs c001-D02 --body "Seven days is too short for links in a newsletter."; expect_rc 0
  by frontend "$SAY" accept --to orchestrator --body "Changed my mind."; expect_rc 1; expect_err "already answered draft 1"
  by research "$SAY" accept --to orchestrator --body "Accept draft 1."; expect_rc 0
  by orchestrator "$R" next; expect_rc 1; expect_err "frontend objected to c001-D02: an objection stands until the record is needs-human"
  decisions_ok c001 decided none | sed 's/expire seven days after/expire fourteen days after/; s/after 7 days/after 14 days/' > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0; expect_out "draft 2 is out"
  for t in backend frontend research; do by "$t" "$SAY" accept --to orchestrator --body "Accept draft 2."; expect_rc 0; done
  by orchestrator "$R" next; expect_rc 0; expect_out "pull request #1 is ready"; status_is approval
  jq -e '.draft == false' "$FAKE_GH/pulls/1.json" >/dev/null || fail "the planning PR was not marked ready"

  # Round 5: you approve by merging; then dispatch hands out the work breakdown.
  by orchestrator "$DIS" "$C"; expect_rc 1; expect_err "is not on origin/main"
  git -C "$MAIN" push -q origin "planning/$C:main"                       # the human merges the planning PR
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "c001-share-links is feature/f001-share-links, 4 item(s)"; expect_out "main has no branch protection"
  expect_eq "$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)" main
  d=$(git -C "$TEST_TMP/origin.git" show "feature/f001-share-links:planning/$C/dispatch.jsonl")
  expect_eq "$(jq -r '"\(.team):\(.item):\(.after | join(","))"' <<<"$d" | tr '\n' ' ')" "backend:share-api: frontend:share-button:share-api research:share-research: research:acceptance: "
  expect_eq "$(git -C "$TEST_TMP/origin.git" show "feature/f001-share-links:planning/$C/state.json" | jq -r .status)" dispatched
  expect_eq "$(grep -c '"type":"dispatch"' "$MAIN/.factory/events.jsonl")" 4
  [ ! -e "$MAIN/.factory/planning/active" ] || fail "the cycle is still marked open after dispatch"

  # The whole record is files in the repository: brief, positions, transcript, decisions, dispatch.
  t=$(git -C "$TEST_TMP/origin.git" ls-tree -r --name-only main "planning/$C" | tr '\n' ' ')
  for f in BRIEF.md DECISIONS.md discussion.jsonl state.json positions/backend.md positions/frontend.md positions/research.md; do
    case " $t " in *" planning/$C/$f "*) ;; *) fail "planning/$C/$f is not in the approved record: $t" ;; esac
  done
  expect_eq "$(jq -s length "$P/discussion.jsonl")" 19        # refused messages are never written
  jq -e -s 'all(.[]; (.id | test("^c001-m[0-9]{3}$")) and .cycle == "c001-share-links" and (.ts | test("Z$")))' "$P/discussion.jsonl" >/dev/null || fail "a transcript line lacks its stamps"
}

test_second_cycle_cannot_open_while_one_is_open() {
  planning_setup; meeting_to positions
  for s in positions; do by orchestrator "$R" open another-thing; expect_rc 1; expect_err "cycle c001-share-links is still open"; done
  by orchestrator "$R" abandon --reason "The brief turned out to need research first."; expect_rc 0
  expect_eq "$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)" main
  by orchestrator "$R" open another-thing; expect_rc 0; expect_out "opened c002-another-thing"
  by orchestrator "$R" open third-thing; expect_rc 1; expect_err "cycle c002-another-thing is still open"
}

test_limit_messages_per_team_per_round() {
  planning_setup; meeting_to discussion-1
  for i in 1 2 3 4; do by backend "$SAY" proposal --to all --body "Proposal $i: keep tokens short."; expect_rc 0; done
  by backend "$SAY" proposal --to all --body "Proposal 5."; expect_rc 1; expect_err "limit: backend has said 4 things in the discussion-1 round"
  by frontend "$SAY" proposal --to all --body "Another team still may."; expect_rc 0
}

test_a_team_that_has_used_its_messages_can_still_answer_what_it_owes() {
  planning_setup; meeting_to discussion-1
  for i in 1 2 3; do by backend "$SAY" proposal --to all --body "Proposal $i."; expect_rc 0; done
  by orchestrator "$SAY" question --to backend --body "Expiry?"; q=$(tail -1 "$P/discussion.jsonl" | jq -r .id)
  by backend "$SAY" answer --to orchestrator --refs "$q" --body "Seven days."; expect_rc 0
  by backend "$SAY" proposal --to all --body "Proposal 4: the answer did not use a message."; expect_rc 0
  by orchestrator "$SAY" question --to backend --body "Rate limit?"; q2=$(tail -1 "$P/discussion.jsonl" | jq -r .id)
  by backend "$SAY" answer --to orchestrator --refs "$q2" --body "Ten a minute."; expect_rc 0     # all 4 used: still owed
  by backend "$SAY" answer --to orchestrator --refs "$q" --body "Seven days, again."; expect_rc 1; expect_err "that backend has not answered yet"
  by backend "$SAY" proposal --to all --body "Proposal 5."; expect_rc 1; expect_err "limit: backend has said 4 things"
  by orchestrator "$R" ready; grep -q "$q backend" "$OUT" && fail "an answered question is still owed"
  expect_eq "$(jq -s '[.[] | select(.kind == "answer")] | length' "$P/discussion.jsonl")" 2
}

test_limit_orchestrator_questions_per_team_per_round() {
  planning_setup; meeting_to discussion-1
  for i in 1 2 3; do by orchestrator "$SAY" question --to backend --body "Question $i?"; expect_rc 0; done
  by orchestrator "$SAY" question --to backend --body "Question 4?"; expect_rc 1; expect_err "limit: the orchestrator has asked backend 3 questions"
  by orchestrator "$SAY" question --to frontend --body "Another team may still be asked."; expect_rc 0
}

test_limit_message_length_sends_long_material_to_an_attachment() {
  planning_setup; meeting_to discussion-1
  long=$(head -c 2001 /dev/zero | tr '\0' x)
  by backend "$SAY" proposal --to all --body "$long"; expect_rc 1; expect_err "2001 characters, over the limit of 2000"
  printf '%s\n' "$long" > "$BE/share-api-draft.md"
  by backend "$SAY" proposal --to all --attach "$BE/share-api-draft.md" --body "The full API draft is attached."; expect_rc 0
  expect_eq "$(jq -r 'select(.attach) | .attach' "$P/discussion.jsonl")" "attachments/discussion-1-backend-share-api-draft.md"
  cmp -s "$BE/share-api-draft.md" "$P/attachments/discussion-1-backend-share-api-draft.md" || fail "the attachment was not copied"
}

test_limit_discussion_rounds() {
  planning_setup; meeting_to discussion-1
  by orchestrator "$R" next --again; expect_rc 0; status_is discussion-2
  by orchestrator "$R" next --again; expect_rc 1; expect_err "limit: 2 discussion rounds"
  limits '{"discussion_rounds": 3}'; by orchestrator "$R" next --again; expect_rc 0; status_is discussion-3
}

test_limit_round_time_strikes_and_two_strikes_stop_the_meeting() {
  planning_setup; meeting_to positions
  by backend "$POS" submit < "$TEST_TMP/pos" 2>/dev/null || { position_ok > "$TEST_TMP/pos"; by backend "$POS" submit < "$TEST_TMP/pos"; }
  by orchestrator "$R" next; expect_rc 1; expect_err "waiting for positions from: frontend research"
  limits '{"round_minutes": 0}'
  by orchestrator "$R" next; expect_rc 0; expect_out "a strike for: frontend research"; status_is discussion-1
  expect_eq "$(ls "$P/positions")" backend.md
  by orchestrator "$SAY" question --to frontend --body "Where is your position?"; expect_rc 0
  by orchestrator "$R" next; expect_rc 1; expect_err "frontend  missed two rounds' time: the meeting stops here"
  status_is escalated
  grep -q '"type":"escalation".*"reason":"planning-strikes"' "$MAIN/.factory/events.jsonl" || fail "no escalation event"
  by orchestrator "$R" next; expect_rc 1; expect_err "nothing to move: the cycle is escalated"
  by orchestrator "$R" abandon --reason "Two teams missed their rounds."; expect_rc 0
}

test_open_questions_after_time_become_needs_human_records() {
  planning_setup; meeting_to discussion-1
  by orchestrator "$SAY" question --to backend --body "Rate limits on the share endpoint?"; expect_out c001-m004
  limits '{"round_minutes": 0}'
  by orchestrator "$R" next; expect_rc 0; expect_out "each must become a needs-human decision record: c001-m004"
  expect_eq "$(jq -c .unanswered "$P/state.json")" '["c001-m004"]'
  by orchestrator "$R" next; by orchestrator "$R" next 2>/dev/null; status_is decisions
  decisions_ok c001 > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 1; expect_err "question c001-m004 was left open in discussion"
  decisions_ok c001 needs-human "backend could not answer in time" c001-m004 > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0
}

test_limit_drafts() {
  planning_setup; meeting_to decisions
  decisions_ok c001 > "$P/DECISIONS.md"
  for i in 1 2 3; do by orchestrator "$R" draft; expect_rc 0; done
  by orchestrator "$R" draft; expect_rc 1; expect_err "limit: 3 drafts"
}

# AUTONOMY=on on main: the same meeting with nobody to wait for. The orchestrator settles the brief,
# the open question and the objection; the planning PR is set to merge itself.
test_with_autonomy_three_leads_reach_decisions_and_dispatch_without_the_human() {
  planning_setup; fake_branches
  echo AUTONOMY=on >> "$MAIN/factory/policy.env"; git -C "$MAIN" add -A; git -C "$MAIN" commit -qm autonomy; git -C "$MAIN" push -q origin main
  by orchestrator "$R" open share-links; expect_rc 0; expect_out "from the human's proposal"
  C=c001-share-links; P="$MAIN/planning/$C"
  brief_ok "$C" "backend, frontend, research"
  by orchestrator "$R" brief; expect_rc 0; expect_out "no approval to wait for"
  by orchestrator "$R" next; expect_rc 0; status_is positions                  # no brief-approved label
  position_ok > "$TEST_TMP/pos"
  for t in backend frontend research; do by "$t" "$POS" submit < "$TEST_TMP/pos"; expect_rc 0; done
  by orchestrator "$R" next; expect_rc 0; status_is discussion-1

  # A question nobody answers in time goes to the orchestrator, not the human.
  by orchestrator "$SAY" question --to frontend --body "Do share links expire?"; expect_out c001-m004
  limits '{"round_minutes": 0}'
  by orchestrator "$R" next; expect_rc 0; expect_out "the orchestrator decides each (decided_by: orchestrator), with each team's dissent recorded: c001-m004"
  for d in "$MAIN" "$BE" "$FE" "$RE"; do git -C "$d" checkout -q -- factory/teams.json; done   # back to the default limits
  by orchestrator "$R" next; expect_rc 0; status_is decisions
  decisions_ok c001 needs-human "frontend did not answer in time" c001-m004 > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0                                    # needs-human is still allowed
  decisions_ok c001 decided none c001-m004 > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 1; expect_err "question c001-m004 was left open in discussion"
  decisions_ok c001 decided none c001-m004 | perl -pe 's/^(- refs: c001-m004)$/$1\n- decided_by: orchestrator/' > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0; expect_out "draft 2 is out"

  # An objection stands until the orchestrator decides with the objecting team named under Dissent.
  by backend "$SAY" accept --to orchestrator --body "Accept draft 2."; expect_rc 0
  by frontend "$SAY" objection --to orchestrator --refs c001-D02 --body "Seven days is too short for links in a newsletter."; expect_rc 0
  by research "$SAY" accept --to orchestrator --body "Accept draft 2."; expect_rc 0
  by orchestrator "$R" next; expect_rc 1; expect_err "frontend objected to c001-D02: an objection stands until the record is decided by the orchestrator (decided_by: orchestrator) or needs-human with frontend named under Dissent"
  decisions_ok c001 decided "frontend: seven days is too short for newsletter links; kept to limit leaked links." c001-m004 \
    | perl -pe 's/^(- refs: c001-m004)$/$1\n- decided_by: orchestrator/' > "$P/DECISIONS.md"
  by orchestrator "$R" draft; expect_rc 0; expect_out "draft 3 is out"
  for t in backend frontend research; do by "$t" "$SAY" accept --to orchestrator --body "Accept draft 3."; expect_rc 0; done
  : > "$FAKE_GH/log"
  by orchestrator "$R" next; expect_rc 0; status_is approval; expect_out "merges itself once CI is green (AUTONOMY=on)"
  grep -qx "pr merge 1 --auto --merge" "$FAKE_GH/log" || fail "the planning PR was not set to merge itself: $(cat "$FAKE_GH/log")"
  jq -e '.draft == false and .auto_merge != null' "$FAKE_GH/pulls/1.json" >/dev/null || fail "pull request #1 is not ready with auto-merge"
  [ -z "$(ls "$FAKE_GH/events")" ] || fail "something looked for the human's label: $(ls "$FAKE_GH/events")"

  # GitHub merges it on green CI; dispatch takes the orchestrator's record like the human's.
  git -C "$MAIN" push -q origin "planning/$C:main"
  by orchestrator "$DIS" "$C"; expect_rc 0; expect_out "c001-share-links is feature/f001-share-links, 4 item(s)"
  d=$(git -C "$TEST_TMP/origin.git" show "main:planning/$C/DECISIONS.md")
  grep -q "^- decided_by: orchestrator$" <<<"$d" && grep -q "^frontend: seven days" <<<"$d" || fail "the merged record lost the orchestrator's decision or frontend's dissent"
}

test_one_team_cycle_skips_positions_and_discussion() {
  planning_setup; meeting_to brief-approved "backend"
  status_is decisions
  by backend "$POS" submit < /dev/null; expect_rc 1; expect_err "only in the positions round"
}

run_tests
