# Tests for factory/scripts/ticket.sh: tickets between teams, against the fake gh. Sessions are
# simulated by running in each team's worktree with its FACTORY_TEAM, as team-up starts them.
. "$(dirname "$0")/lib.sh"
T="$SCRIPTS/ticket.sh"
NEEDS="An endpoint GET /api/notes/:id that returns one note as JSON"
WHY="The share page renders a single note and has no other way to fetch it"
DONE="GET /api/notes/42 returns 200 with the note, and 404 for a missing id"

setup() { team_setup; fake_gh; echo '{"number": 5}' > "$FAKE_GH/pulls/5.json"; }
as() {  # as <team> <ticket.sh args...>: run in that team's session
  local t=$1; shift
  case "$t" in orchestrator) cd "$MAIN" ;; backend) cd "$BE" ;; frontend) cd "$FE" ;; *) cd "$TEST_TMP" ;; esac
  FACTORY_TEAM=$t run "$T" "$@"
}
ask() { as "${1:-frontend}" create --to "${2:-backend}" --type request --needs "$NEEDS" --why "$WHY" --blocks "#12 (share page)" --done "$DONE" "${@:3}"; }
issue() { jq --argjson n "$1" '.[] | select(.number == $n)' "$FAKE_GH/issues.json"; }
labels() { issue "$1" | jq -r '[.labels[].name] | sort | join(" ")'; }
events() { cat "$MAIN/.factory/events.jsonl" 2>/dev/null | grep -c '"type":"ticket"' || true; }

test_create_posts_a_labelled_ticket_and_an_event() {
  setup; ask frontend backend --feature f001-share --decision c001-D02
  expect_rc 0; expect_out "ticket #1: frontend → backend (request)"
  expect_eq "$(labels 1)" "feature:f001-share from:frontend state:open ticket to:backend type:request"
  head=$(issue 1 | jq -r .body | sed -n 's/^<!-- factory-ticket \(.*\) -->$/\1/p')
  expect_eq "$(jq -c '[.from, .to, .type, .feature, .decision, .blocks]' <<<"$head")" '["frontend","backend","request","f001-share","c001-D02",[12]]'
  issue 1 | jq -r .body | grep -qF "## Done when" || fail "body lacks its sections"
  expect_eq "$(issue 1 | jq -r .title)" "[frontend → backend] request: $NEEDS"
  ev=$(grep '"type":"ticket"' "$MAIN/.factory/events.jsonl")
  expect_eq "$(jq -c '[.team, .number, .action, .from, .to, .state]' <<<"$ev")" '["frontend","1","create","frontend","backend","open"]'
}

test_full_round_trip() {
  setup; ask
  as backend accept 1; expect_rc 0; expect_out "open → accepted"
  as backend done 1 --pr 5; expect_rc 0; expect_out "accepted → done"
  as frontend verify 1; expect_rc 0; expect_out "done → verified"
  expect_eq "$(issue 1 | jq -r .state)" CLOSED
  expect_eq "$(labels 1)" "from:frontend state:verified ticket to:backend type:request"
  expect_eq "$(issue 1 | jq -c '[.comments[].body | capture("^<!-- factory-ticket-action (?<j>.*) -->").j | fromjson | [.action, .by, .state]]')" \
    '[["accept","backend","accepted"],["done","backend","done"],["verify","frontend","verified"]]'
  issue 1 | jq -r '.comments[1].body' | grep -qF "Pull request #5" || fail "done does not name the pull request"
  expect_eq "$(events)" 4
}

test_only_the_right_side_may_act() {
  setup; ask
  as frontend accept 1; expect_rc 1; expect_err "only backend, the receiving team, can accept #1"
  as orchestrator decline 1 --reason "$WHY"; expect_rc 1; expect_err "only backend"
  as backend accept 1; as backend done 1 --pr 5
  as backend verify 1; expect_rc 1; expect_err "only frontend, the team that asked, can verify #1"
  as orchestrator dispute 1 --reason "$WHY"; expect_rc 1; expect_err "only frontend"
}

test_impossible_transitions_are_refused() {
  setup; ask
  as frontend verify 1; expect_rc 1; expect_err "#1 is open; verify is not possible from there"
  as backend done 1 --pr 5; expect_rc 1; expect_err "#1 is open; done is not possible"
  as backend accept 1
  as backend done 1; expect_rc 1; expect_err "done needs --pr"
  as backend done 1 --pr 99; expect_rc 1; expect_err "there is no pull request #99"
  as backend done 1 --pr '5;touch pwned'; expect_rc 1
  as backend done 1 --pr 5
  as frontend withdraw 1 --reason "We will render the share page from the list for now"; expect_rc 1; expect_err "#1 is done; withdraw is not possible"
  as frontend verify 1
  as backend accept 1; expect_rc 1; expect_err "#1 is closed"
  [ ! -e pwned ] || fail "a --pr value was executed"
}

test_a_dispute_is_allowed_once() {
  setup; ask
  as backend decline 1 --reason "short"; expect_rc 1; expect_err "--reason needs at least 30"
  as backend decline 1 --reason "We serve notes by slug, not id; use GET /api/notes/by-slug/:slug instead"; expect_rc 0
  as frontend dispute 1 --reason "Share links carry ids, decided in c001-D02; slugs are not stable"; expect_rc 0; expect_out "declined → disputed"
  as backend accept 1; as backend done 1 --pr 5
  as frontend dispute 1 --reason "Still returns the whole list rather than a single note for any id"; expect_rc 1; expect_err "disputed once already"
  as frontend verify 1; expect_rc 0
}

test_thin_or_invalid_tickets_are_refused() {
  setup
  as frontend create --to backend --type request --needs "fix it" --why "$WHY" --blocks x --done "$DONE"; expect_rc 1; expect_err "--needs needs at least 30"
  as frontend create --to backend --type request --needs "a                                   b" --why "$WHY" --blocks x --done "$DONE"; expect_rc 1; expect_err "--needs needs at least 30"
  as frontend create --to backend --type request --needs "$NEEDS" --why "$WHY" --done "$DONE"; expect_rc 1; expect_err "--blocks is required"
  ask frontend frontend; expect_rc 1; expect_err "a ticket goes to another team"
  ask frontend research; expect_rc 1; expect_err "--to must be an active team"
  ask frontend '../backend'; expect_rc 1; expect_err "--to must be an active team"
  ask frontend backend --feature 'F 1'; expect_rc 1; expect_err "--feature must look like"
  ask frontend backend --feature 'a,b'; expect_rc 1; expect_err "--feature must look like"
  ask frontend backend --decision '$(touch pwned)'; expect_rc 1; expect_err "--decision must look like"
  as frontend create --to backend --type wish --needs "$NEEDS" --why "$WHY" --blocks x --done "$DONE"; expect_rc 1; expect_err "--type must be"
  as frontend create --to backend --bogus x; expect_rc 1; expect_err "unknown option --bogus"
  as frontend create --to; expect_rc 1; expect_err "--to needs a value"
  as frontend create --to backend --type request --needs "$(head -c 9000 /dev/zero | tr '\0' x)" --why "$WHY" --blocks x --done "$DONE"
  expect_rc 1; expect_err "longer than 8000"
  [ ! -s "$FAKE_GH/issues.json" ] || expect_eq "$(jq length "$FAKE_GH/issues.json")" 0
  [ ! -e pwned ] || fail "an argument was executed"
}

test_budgets_are_enforced() {
  setup
  ask frontend backend; ask frontend backend
  ask frontend backend; expect_rc 1; expect_err "frontend already has 2 open tickets with backend"
  ask frontend orchestrator; ask frontend orchestrator; expect_rc 0
  ask frontend orchestrator; expect_rc 1; expect_err "2 open tickets with orchestrator"
  as orchestrator decline 3 --reason "$WHY that we need first"
  as frontend withdraw 3 --reason "We will render the share page from the list for now"; expect_rc 0; expect_out "declined → withdrawn"
  expect_eq "$(issue 3 | jq -r .state)" CLOSED
  as frontend withdraw 4 --reason "We will render the share page from the list for now"; expect_rc 0
  ask frontend orchestrator; expect_rc 0
  ask frontend orchestrator; expect_rc 1; expect_err "frontend has opened 5 tickets today, its daily budget"
  jq '.limits = {tickets_per_day: 1, open_tickets_per_pair: 9}' "$BE/factory/teams.json" > t && mv t "$BE/factory/teams.json"
  ask backend frontend; expect_rc 0
  ask backend frontend; expect_rc 1; expect_err "backend has opened 1 tickets today"
}

test_the_team_comes_from_the_session_not_the_caller() {
  setup
  cd "$FE"; FACTORY_TEAM=backend run "$T" create --to orchestrator; expect_rc 1; expect_err "this session has no team"
  cd "$FE"; run env -u FACTORY_TEAM "$T" create --to backend; expect_rc 1; expect_err "FACTORY_TEAM=unset"
  mkrepo solo && cd solo; FACTORY_TEAM=backend run "$T" create --to frontend; expect_rc 1; expect_err "tickets are for team mode"
}

test_hostile_text_is_posted_harmlessly() {
  setup
  evil=$'@octocat and @org/team: see <script>alert(1)</script> --> <!-- x\n`touch pwned` $(touch pwned2) "q" \x07bell'
  as frontend create --to backend --type bug --needs "$evil and a long enough request" --why "$WHY" --blocks "#3, #3 and #x9" --done "$DONE"
  expect_rc 0
  b=$(issue 1 | jq -r .body)
  grep -qF '@​octocat' <<<"$b" && grep -qF '@​org/team' <<<"$b" || fail "a mention was not neutralised: $b"
  grep -qE '@[a-z]' <<<"$b" && fail "a live @mention is left: $b"
  grep -qF '&lt;script&gt;' <<<"$b" || fail "HTML was not escaped"
  expect_eq "$(grep -o -- '-->' <<<"$b" | wc -l | tr -d ' ')" 1
  grep -q $'\x07' <<<"$b" && fail "a control character was posted"
  grep -qF '`touch pwned` $(touch pwned2) "q"' <<<"$b" || fail "the text was changed beyond neutralising"
  expect_eq "$(sed -n 's/^<!-- factory-ticket \(.*\) -->$/\1/p' <<<"$b" | jq -c .blocks)" '[3]'
  issue 1 | jq -r .title | grep -qE '@[a-z]' && fail "a mention in the title"
  [ ! -e pwned ] && [ ! -e pwned2 ] && [ ! -e "$FE/pwned" ] || fail "text was executed"
}

test_not_a_ticket_or_a_damaged_one_is_refused() {
  setup; printf 'x' | gh issue create --title plain --body-file - >/dev/null
  as backend accept 1; expect_rc 1; expect_err "#1 is not a ticket"
  for n in '' 0 -1 '1;touch pwned' '../1'; do as backend accept "$n"; expect_rc 1; expect_err "usage"; done
  ask; jq 'map(if .number == 2 then .labels |= map(select(.name != "from:frontend")) else . end)' "$FAKE_GH/issues.json" > i && mv i "$FAKE_GH/issues.json"
  as backend accept 2; expect_rc 1; expect_err "lost its from:, to: or state: label"
  as backend accept 77; expect_rc 1; expect_err "cannot read issue #77"
}

# ---- contract-change tickets leave a grant in the main checkout while accepted ----
ask_contract() { as frontend create --to backend --type contract-change --needs "$NEEDS" --why "$WHY" --blocks "#12" --done "$DONE"; }
grant() { cat "$MAIN/.factory/grants/contract-$1.json" 2>/dev/null; }
no_grant() { [ ! -e "$MAIN/.factory/grants/contract-$1.json" ] || fail "a grant for #$1 is left: $(grant "$1")"; }

test_accepting_a_contract_change_grants_contracts_until_done() {
  setup; ask_contract; expect_rc 0
  no_grant 1
  as backend accept 1; expect_rc 0; expect_out "backend may now change contracts/ for #1"
  expect_eq "$(grant 1 | jq -c '[.ticket, .team]')" '[1,"backend"]'
  grant 1 | jq -e '.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$")' >/dev/null || fail "no time in the grant: $(grant 1)"
  [ ! -e "$BE/.factory/grants" ] || fail "the grant went to the worktree, not the main checkout"
  as backend done 1 --pr 5; expect_rc 0; no_grant 1
  as frontend dispute 1 --reason "The new field is optional in the contract but the client needs it"; no_grant 1
  as backend accept 1; expect_rc 0; expect_eq "$(grant 1 | jq -r .team)" backend
  as frontend withdraw 1 --reason "We will keep the old field and drop this change for now"; expect_rc 0; no_grant 1
  expect_eq "$(issue 1 | jq -r .state)" CLOSED
}

test_only_an_accepted_contract_change_ticket_grants() {
  setup; jq '.limits = {open_tickets_per_pair: 9}' "$FE/factory/teams.json" > t && mv t "$FE/factory/teams.json"
  ask; as backend accept 1; expect_rc 0; no_grant 1                             # a request
  ask_contract; as backend decline 2 --reason "The contract already has this field under another name"; no_grant 2
  ask_contract; as frontend accept 3; expect_rc 1; no_grant 3                    # the asking side
  cd "$FE"; FACTORY_TEAM=backend run "$T" accept 3; expect_rc 1; no_grant 3      # spoofed team
  echo 'issue edit' > "$FAKE_GH/fail"; as backend accept 3; expect_rc 1; no_grant 3   # GitHub refused
  rm "$FAKE_GH/fail"
  jq 'map(if .number == 3 then .labels += [{name: "type:request"}] else . end)' "$FAKE_GH/issues.json" > i && mv i "$FAKE_GH/issues.json"
  as backend accept 3; expect_rc 0; no_grant 3                                   # two type: labels are no type
  ls "$MAIN/.factory/grants" 2>/dev/null | grep . && fail "grants were written"
  return 0
}

test_github_failures_stop_without_a_false_record() {
  setup; echo 'issue create' > "$FAKE_GH/fail"
  ask; expect_rc 1; expect_err "GitHub refused the ticket"
  expect_eq "$(events)" 0
  rm "$FAKE_GH/fail"; ask; echo 'issue comment' > "$FAKE_GH/fail"
  as backend accept 1; expect_rc 1; expect_err "refused the comment"
  expect_eq "$(labels 1 | grep -o 'state:[a-z]*')" state:open
  expect_eq "$(events)" 1
}

test_a_new_ticket_rings_the_team_it_is_for() {
  setup; fake_herdr; ask frontend backend; expect_rc 0
  expect_eq "$(cat "$TEST_TMP/hd/hc.log")" "t2|A ticket for you: run /inbox."
  echo working > "$TEST_TMP/hc-status-t3"; ask backend frontend; expect_rc 0
  [ -f "$MAIN/.factory/rings/frontend" ] || fail "a busy receiver's ring was not kept for the sweep"
  rm -rf "$MAIN/.factory/rings"; PATH="$(path_without herdr-app hc):$FAKE_GH/bin"; ask frontend backend
  expect_rc 0; [ ! -e "$MAIN/.factory/rings" ] || fail "kept a ring without Herdr"
}

test_a_declined_or_finished_ticket_rings_the_team_that_asked() {
  setup; fake_herdr; ask frontend backend; rm "$TEST_TMP/hd/hc.log"
  as backend accept 1; expect_rc 0; [ ! -s "$TEST_TMP/hd/hc.log" ] || fail "accept rang someone: $(cat "$TEST_TMP/hd/hc.log")"
  as backend done 1 --pr 5; expect_rc 0; expect_eq "$(cat "$TEST_TMP/hd/hc.log")" "t3|Something is waiting for you: run /inbox."
  rm "$TEST_TMP/hd/hc.log"; ask frontend backend; rm "$TEST_TMP/hd/hc.log"
  as backend decline 2 --reason "The endpoint exists already as GET /api/notes?id=, see server/routes.js"; expect_rc 0
  expect_eq "$(cat "$TEST_TMP/hd/hc.log")" "t3|Something is waiting for you: run /inbox."
  rm "$TEST_TMP/hd/hc.log"; as orchestrator create --to backend --type bug --needs "$NEEDS" --why "$WHY" --blocks "feature f001" --done "$DONE"
  rm "$TEST_TMP/hd/hc.log"; as backend decline 3 --reason "The e2e test checks a field the criterion never names, line 12"; expect_rc 0
  [ ! -s "$TEST_TMP/hd/hc.log" ] || fail "rang the orchestrator, which autostart serves: $(cat "$TEST_TMP/hd/hc.log")"
}

test_a_question_is_answered_and_wakes_the_team_that_asked() {
  setup; fake_herdr
  Q="Should the subtitle cut with an ellipsis or wrap to a second line when it is too long?"
  as frontend create --to orchestrator --type question --needs "$Q" --why "The spec and the brief disagree on long subtitles" --blocks "#9" --done "An answer the spec can record as the decision for #9"
  expect_rc 0; expect_out "ticket #1: frontend → orchestrator (question)"
  expect_eq "$(labels 1)" "from:frontend state:open ticket to:orchestrator type:question"
  rm -f "$TEST_TMP/hd/hc.log"
  as frontend answer 1 --answer "Wrap it to a second line"; expect_rc 1; expect_err "only orchestrator, the receiving team, can answer"
  as orchestrator answer 1 --answer "short"; expect_rc 1; expect_err "--answer needs at least 10 characters"
  as orchestrator answer 1 --reason "Wrap it to a second line, never cut"; expect_rc 1; expect_err "unknown option --reason"
  as orchestrator answer 1; expect_rc 1
  as orchestrator answer 1 --pr 5; expect_rc 1; expect_err "unknown option --pr"
  as orchestrator answer 1 --answer 'Wrap it, never cut. @everyone <img src=x onerror=alert(1)> $(touch pwned)'; expect_rc 0; expect_out "open → done"
  expect_eq "$(labels 1)" "from:frontend state:done ticket to:orchestrator type:question"
  last=$(issue 1 | jq -r '.comments[-1].body')
  printf '%s' "$last" | grep -q '"action":"answer"' || fail "no machine line for the answer: $last"
  printf '%s' "$last" | grep -qF 'Wrap it, never cut.' || fail "the answer is not on the ticket: $last"
  printf '%s' "$last" | grep -qF '@everyone' && fail "an @mention went out raw: $last"
  printf '%s' "$last" | grep -qF '<img' && fail "HTML went out raw: $last"
  [ ! -e pwned ] && [ ! -e "$MAIN/pwned" ] || fail "the answer was executed"
  expect_eq "$(cat "$TEST_TMP/hd/hc.log")" "t3|Something is waiting for you: run /inbox."     # frontend is woken
  as frontend verify 1; expect_rc 0; expect_out "done → verified"
  expect_eq "$(grep '"type":"ticket"' "$MAIN/.factory/events.jsonl" | jq -r 'select(.action == "answer") | .state')" done
}

test_answer_is_only_for_questions_and_open_ones() {
  setup; ask frontend backend
  as backend answer 1 --answer "Use GET /api/notes?id= instead of a new route"; expect_rc 1; expect_err "answer is for questions (done --pr for work)"
  as frontend create --to backend --type question --needs "Which field holds the note's owner in the API response?" --why "The share page shows who wrote the note" --blocks "nothing" --done "The field name, so the page can read it"
  as backend answer 2 --answer "owner_id, an integer, see server/notes.js"; expect_rc 0
  as backend answer 2 --answer "owner_id, an integer, see server/notes.js"; expect_rc 1; expect_err "#2 is done; answer is not possible from there"
  as frontend done 2 --pr 5; expect_rc 1
}

run_tests
