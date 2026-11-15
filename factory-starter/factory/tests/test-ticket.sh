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

test_github_failures_stop_without_a_false_record() {
  setup; echo 'issue create' > "$FAKE_GH/fail"
  ask; expect_rc 1; expect_err "GitHub refused the ticket"
  expect_eq "$(events)" 0
  rm "$FAKE_GH/fail"; ask; echo 'issue comment' > "$FAKE_GH/fail"
  as backend accept 1; expect_rc 1; expect_err "refused the comment"
  expect_eq "$(labels 1 | grep -o 'state:[a-z]*')" state:open
  expect_eq "$(events)" 1
}

run_tests
