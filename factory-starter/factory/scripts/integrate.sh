#!/usr/bin/env bash
# Integration of a dispatched feature: the e2e gate between feature/<f> and main. The orchestrator
# runs it in the main checkout; `ready` is open to every team.
#   integrate.sh tests <f>                  check out integrate/<f> (from origin, with origin/feature/<f>
#                                           merged) for integration-qa to write tests/e2e/<f>/ (and,
#                                           after a failed round, features/<f>/attribution.md). Needs a
#                                           valid features/<f>/acceptance.md on feature/<f>. The
#                                           checkout stays on integrate/<f> until save.
#   integrate.sh save <f> --message <text> [--dispute <ticket>]
#                                           commit and push those files only. A committed e2e test is
#                                           locked: changing or deleting one needs --dispute naming an
#                                           open bug ticket from orchestrator for <f> in state declined.
#                                           The first save with tests rings the feature's teams.
#                                           Its commits carry "Factory-Stage: integrate-save".
#   integrate.sh run <f>                    one integration round: refuse unless tests/e2e/<f>/ is as the
#                                           last save left it (integrate/<f> is not protected), merge
#                                           origin/feature/<f> and origin/main into integrate/<f> (which
#                                           must not change the tests either), run `make e2e` (killed after
#                                           FACTORY_E2E_TIMEOUT seconds, default 1800), write
#                                           features/<f>/e2e-report.md, render FEATURE.md, push.
#                                           pass: an acceptance-review request ticket to research.
#   integrate.sh tickets <f>                after a failed round: check features/<f>/attribution.md and
#                                           file one bug ticket per team it names (all or nothing)
#   integrate.sh pr <f>                     open the pull request integrate/<f> -> main, once e2e passed
#                                           and research's acceptance-review.md accepts that round
#   integrate.sh close <f>                  after that pull request merged: delete feature/<f> and
#                                           integrate/<f>; the next cycle may be dispatched
#   integrate.sh drop <f> --reason <text>   the human stopped the feature: keep feature/<f> and
#                                           integrate/<f> as tags stopped/feature/<f> and
#                                           stopped/integrate/<f>, close the pull requests into
#                                           feature/<f> and from integrate/<f> and the open issues
#                                           labelled feature:<f> (saying why), delete the branches
#                                           (and sync/<f>); the next cycle may be dispatched
#   integrate.sh ready <f>                  exit 0 when origin/integrate/<f> holds tests/e2e/<f>/
#   integrate.sh sync <f>                   when main has moved on (a factory change merged after
#                                           dispatch): push sync/<f>, origin/main merged into
#                                           origin/feature/<f>, and open its pull request to feature/<f>.
#                                           Refuses when the two conflict or both changed a file: they
#                                           meet at integration. Touches no checkout, so it runs during
#                                           planning too. Its tier comes from its paths (factory
#                                           files: R2, the human approves); it merges with a merge
#                                           commit, never a squash, so main becomes part of feature/<f>.
#                                           Pushes nothing when sync/<f> already holds main and
#                                           still merges cleanly into feature/<f>.
# Exit codes: 0 ok; 1 refused or failed (run: e2e failed in round 1); 3 escalated to the human (e2e
# failed in two rounds); 4 a merge conflict, ticketed to the owning teams.
# Refuses while a planning cycle is open (planning and integration share the main checkout in
# version 1; sync excepted) or the checkout has uncommitted changes (save, sync excepted). Every
# subcommand but tests leaves the checkout on main, unless that would carry uncommitted work
# there; then it says so.
# Text posted to GitHub goes through ticket.sh or clean_text; nothing read is ever run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "integrate: $*" >&2; exit 1; }
say() { echo "integrate: $*"; }

cmd=${1:-}; f=${2:-}
case "$cmd" in tests|save|run|tickets|pr|close|drop|ready|sync) ;; *) sed -n '2,49p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;; esac
[[ "$f" =~ ^f[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || die "usage: integrate.sh $cmd <feature> (like f001-share-links)"
shift 2
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams_file "$home" >/dev/null || die "integration is for team mode, and this factory has no factory/teams.json"
cd "$home"

if [ "$cmd" = ready ]; then
  git fetch -q origin 2>/dev/null || die "cannot reach origin"
  if [ "$(git cat-file -t "refs/remotes/origin/integrate/$f:tests/e2e/$f" 2>/dev/null)" = tree ]; then
    say "the e2e tests for $f are on integrate/$f: its build items may start"; exit 0
  fi
  say "the e2e tests for $f are not written yet: wait for the orchestrator's doorbell, then run /inbox"; exit 1
fi

me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
[ "$me" = orchestrator ] || die "only the orchestrator integrates; $me can check integrate.sh ready $f"

if [ "$cmd" = sync ]; then
  command -v gh >/dev/null 2>&1 || die "gh is not installed"
  git fetch -q --prune origin || die "cannot reach origin"
  F="refs/remotes/origin/feature/$f" M=refs/remotes/origin/main
  git rev-parse -q --verify "$F^{commit}" >/dev/null || die "feature/$f is not on origin: dispatch.sh makes it"
  git rev-parse -q --verify "$M^{commit}" >/dev/null || die "origin/main does not exist"
  if git merge-base --is-ancestor "$M" "$F"; then say "feature/$f already holds everything on main: nothing to sync"; exit 0; fi
  S="refs/remotes/origin/sync/$f" pushed=""
  # Already pushed and holding main: push nothing, so a label on its pull request stays valid. That
  # holds when the feature has moved on since (an item merged) too, as long as the two still merge
  # cleanly and the feature changed none of the files the sync brings.
  keep=0
  if git rev-parse -q --verify "$S^{commit}" >/dev/null && git merge-base --is-ancestor "$M" "$S"; then
    if git merge-base --is-ancestor "$F" "$S"; then keep=1
    elif git merge-tree --write-tree --no-messages "$F" "$S" >/dev/null 2>&1 && sync_refs "$M" "$F" "$S"; then
      keep=1
      while IFS= read -r -d '' p; do
        [ "$(sync_verdict "$F" "$S" "$p")" = ok ] || keep=0
      done < <(git diff -z --name-only --no-renames "$F...$S")
    fi
  fi
  if [ "$keep" = 0 ]; then
    rc=0; t=$(git merge-tree --write-tree --no-messages "$F" "$M" 2>/dev/null) || rc=$?
    t=${t%%$'\n'*}
    [ "$rc" = 0 ] && git cat-file -e "$t^{tree}" 2>/dev/null ||
      die "main and feature/$f conflict, so main cannot be merged in: they meet at integration (integrate.sh run)"
    c=$(git commit-tree "$t" -p "$F" -p "$M" -m "Sync main into feature/$f") || die "cannot make the merge commit"
    sync_refs "$M" "$F" "$c" || die "feature/$f shares no history with main"
    bad=""
    while IFS= read -r -d '' p; do
      [ "$(sync_verdict "$F" "$c" "$p")" = ok ] || bad+=" $(printf '%s' "$p" | tr -d '\000-\037\177' | cut -c1-80)"
    done < <(git diff -z --name-only --no-renames "$F...$c")
    [ -z "$bad" ] || die "main and feature/$f both changed:$bad. A sync brings only files the feature never changed; they meet at integration (integrate.sh run)"
    git push -q -f origin "$c:refs/heads/sync/$f" || die "cannot push sync/$f"
    pushed=" (updated)"
  fi
  n=$(gh pr list --head "sync/$f" --base "feature/$f" --state open --json number --jq '.[0].number // empty' </dev/null) ||
    die "cannot list pull requests on GitHub"
  if [ -z "$n" ]; then
    url=$(gh pr create --base "feature/$f" --head "sync/$f" --title "Sync main into feature/$f" \
      --body "Merges main into feature/$f, so the factory changes made since dispatch reach this feature's sessions and scripts. Every path is as on main and untouched by the feature (the ownership check makes sure). Merge it with a merge commit, not a squash, so main becomes part of feature/$f and the next sync starts from here." </dev/null) ||
      die "cannot open the pull request sync/$f -> feature/$f"
    n=${url##*/}; [[ "$n" =~ ^[0-9]+$ ]] || die "unexpected answer from gh: $url"; pushed=" (opened)"
  fi
  say "sync/$f -> feature/$f: pull request #$n$pushed"
  say "the human approves it (human-approved) and merges it with a merge commit, not a squash, so main becomes part of feature/$f: gh pr merge $n --merge"
  exit 0
fi
if c=$(active_cycle "$home"); then
  die "planning cycle $c is open, and planning and integration share the main checkout in version 1: finish it (or round.sh abandon), then run this again"
fi
[ "$cmd" = save ] || [ -z "$(git status --porcelain)" ] || die "the main checkout has uncommitted changes: commit or remove them (git status), then run this again"
command -v gh >/dev/null 2>&1 || die "gh is not installed"
# One integrate.sh at a time: a round runs for up to half an hour in this checkout.
if [ -z "${FACTORY_INTEGRATE_LOCKED:-}" ]; then
  mkdir -p "$home/.factory"; rc=0
  FACTORY_INTEGRATE_LOCKED=1 with_lock "$home/.factory/integrate.lock" bash "$0" "$cmd" "$f" "$@" || rc=$?
  [ "$rc" != 75 ] || die "another integrate.sh is running in $home: wait for it to finish"
  exit "$rc"
fi

cyc="c${f#f}"; I="integrate/$f"
tmp=$(mktemp -d)
finish() {  # back to main, unless that would carry uncommitted work there
  git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && git merge --abort >/dev/null 2>&1
  local b; b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "$b" != main ]; then
    if [ -z "$(git status --porcelain 2>/dev/null)" ]; then git switch -q main 2>/dev/null || true
    else echo "integrate: the main checkout stays on $b: it has uncommitted changes (git status)" >&2; fi
  fi
  rm -rf "$tmp"
}
trap finish EXIT
event() { "$here/emit-event.sh" "$@" >/dev/null 2>&1 || true; }
git fetch -q --prune origin || die "cannot reach origin"
git rev-parse -q --verify "refs/remotes/origin/feature/$f" >/dev/null || die "feature/$f is not on origin: dispatch.sh makes it"
git show origin/main:factory/teams.json > "$tmp/teams.json" 2>/dev/null || die "origin/main has no factory/teams.json"
has_integrate() { git rev-parse -q --verify "refs/remotes/origin/$I" >/dev/null; }
has_tests() { [ "$(git cat-file -t "$1:tests/e2e/$f" 2>/dev/null)" = tree ]; }
no_links() { local p; for p in "$@"; do [ ! -L "$p" ] || die "$p is a symbolic link; remove it (git rm), then run this again"; done; }

# report <rev>: "<verdict> <round> <commit>" from features/<f>/e2e-report.md there; nothing if it has
# none; exit 1 if it is damaged. Only this script writes it, in the fixed first lines below.
report() {
  git cat-file -e "$1:features/$f/e2e-report.md" 2>/dev/null || return 0
  local r; r=$(git show "$1:features/$f/e2e-report.md" | F=$f perl -ne 's/\r?\n\z//;
    if ($. == 1) { exit 1 if $_ ne "# E2E report: $ENV{F}" }
    elsif ($. == 2) { /^E2E: (pass|fail)$/ or exit 1; $v = $1 }
    elsif ($. == 3) { /^round: ([1-9][0-9]{0,3})$/ or exit 1; $r = $1 }
    elsif ($. == 4) { /^commit: ([0-9a-f]{40})$/ or exit 1; print "$v $r $1"; exit 0 }') || true
  [ -n "$r" ] || return 1
  echo "$r"
}
damaged() { die "features/$f/e2e-report.md on $I is damaged (only integrate.sh writes it): restore it from its git history, then run this again"; }

# checkout_integrate: integrate/<f> as on origin, or new from origin/feature/<f>; then merge that in.
checkout_integrate() {
  if has_integrate; then
    git switch -q -C "$I" "origin/$I" || die "could not check out $I"
    git merge -q --no-edit "origin/feature/$f" >/dev/null 2>&1 ||
      die "merging origin/feature/$f into $I conflicts: integrate.sh run tickets the owning teams"
  else
    git switch -q -C "$I" "origin/feature/$f" || die "could not make $I"
  fi
}

open_bug() {  # open_bug <team>: does it already hold an open bug ticket from orchestrator for <f>?
  local n; n=$(gh issue list --label ticket --label from:orchestrator --label "to:$1" --label type:bug --label "feature:$f" \
                 --state open --limit 50 --json number --jq length) || die "cannot list tickets on GitHub"
  [ "${n:-0}" -gt 0 ]
}
escalate() {  # escalate <round>
  event escalation reason="integration failed twice" refs="$f $I:features/$f/e2e-report.md" \
    detail="the e2e tests of $f failed in integration round $1 after an earlier failed round"
  say "STOP: the e2e tests of $f failed in two integration rounds (latest: round $1)."
  say "Tell the human, with features/$f/attribution.md and both reports (git log -p origin/$I -- features/$f/e2e-report.md)."
  say "The human decides what happens next: more time, a changed criterion (a ticket to research), or dropping the feature."
  exit 3
}

case "$cmd" in
tests)
  git cat-file -e "origin/feature/$f:features/$f/acceptance.md" 2>/dev/null ||
    die "features/$f/acceptance.md is not on feature/$f yet: research writes it (its acceptance item); run this when that pull request has merged"
  checkout_integrate
  no_links tests tests/e2e "tests/e2e/$f" features "features/$f" "features/$f/acceptance.md" "features/$f/attribution.md"
  bash "$here/feature.sh" check-acceptance "features/$f/acceptance.md" "planning/$cyc/DECISIONS.md" >&2 ||
    die "features/$f/acceptance.md is not valid (above): it goes back to research, as a ticket"
  mkdir -p "tests/e2e/$f"
  trap 'rm -rf "$tmp"' EXIT
  say "the main checkout is on $I. The criteria: $home/features/$f/acceptance.md"
  say "integration-qa writes only in $home/tests/e2e/$f/ (and, after a failed round, features/$f/attribution.md)"
  say "then: integrate.sh save $f --message \"<what was written>\""
  ;;

save)
  msg="" dispute=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in --message) msg=$2 ;; --dispute) dispute=$2 ;; *) die "unknown option $1" ;; esac
    shift 2
  done
  msg=$(printf '%s' "$msg" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  [ -n "$msg" ] || die "save needs --message <what was written>"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$I" ] || die "the main checkout is not on $I: run integrate.sh tests $f first"
  no_links tests tests/e2e "tests/e2e/$f" features "features/$f" "features/$f/attribution.md"
  : > "$tmp/mine"; : > "$tmp/other"
  while IFS= read -r -d '' e; do
    p=${e:3}
    case "$p" in
      "tests/e2e/$f/"*|"features/$f/attribution.md") no_links "$p"; printf '%s\0' "$p" >> "$tmp/mine" ;;
      *) printf '%s\n' "$p" | tr -d '\000-\037' >> "$tmp/other" ;;
    esac
  done < <(git status --porcelain -z --untracked-files=all --no-renames)
  [ ! -s "$tmp/other" ] || die "changed outside tests/e2e/$f/ and features/$f/attribution.md, which is all integration-qa may write: $(tr '\n' ' ' < "$tmp/other")- undo those, then run save again"
  [ -s "$tmp/mine" ] || die "nothing to save in tests/e2e/$f/ or features/$f/attribution.md"
  not=("origin/feature/$f" origin/main); has_integrate && not+=("origin/$I")
  [ -z "$(git rev-list --no-merges -1 HEAD --not "${not[@]}")" ] ||
    die "$I has commits of its own that are on no origin branch: save makes the commit. Undo them (git reset --soft origin/$I), then run save again"
  had=0; has_integrate && has_tests "origin/$I" && had=1
  if has_integrate; then
    locked=$(git diff --name-only --no-renames --diff-filter=MDT "origin/$I" -- "tests/e2e/$f/" | tr -d '\000-\037' | tr '\n' ' ')
    if [ -n "$locked" ]; then
      [ -n "$dispute" ] || die "the e2e tests are locked once saved, and these are changed or deleted: $locked- a test changes only after its team declined the bug ticket: save --dispute <ticket>"
      [[ "$dispute" =~ ^[1-9][0-9]{0,8}$ ]] || die "--dispute takes the number of a declined bug ticket"
      j=$(gh issue view "$dispute" --json state,labels) || die "cannot read issue #$dispute"
      jq -e --arg f "$f" '.state == "OPEN" and ([.labels[]?.name] as $l
          | all("ticket", "from:orchestrator", "type:bug", "feature:\($f)", "state:declined"; . as $x | $l | index($x)))' >/dev/null <<<"$j" ||
        die "#$dispute is not an open bug ticket from orchestrator for $f that its team declined (state:declined); only that unlocks a saved test"
      say "the locked tests change under dispute #$dispute: $locked"
    fi
  fi
  while IFS= read -r -d '' p; do git --literal-pathspecs add -A -- "$p"; done < "$tmp/mine"
  git commit -q -m "integrate $f: $(clean_text "${msg:0:200}")" -m "Factory-Stage: integrate-save" || die "could not commit"
  git push -q -u origin "$I" 2>/dev/null ||
    die "could not push $I. The commit is on the local branch only: push it (git push origin $I) before any other integrate.sh, which starts from origin"
  say "saved and pushed $I"
  if [ "$had" = 0 ] && has_tests HEAD; then
    while IFS= read -r t; do
      valid_team_name "$t" && [ "$t" != orchestrator ] || continue
      ring_team "$home" "$t" "The e2e tests for $f are written; its build items may start: run /inbox." &&
        say "rang $t" || say "could not ring $t (busy, or no Herdr): tell it to run /inbox"
    done < <(git show "HEAD:planning/$cyc/dispatch.jsonl" 2>/dev/null | jq -Rr 'fromjson? | objects | .team | strings' 2>/dev/null | sort -u)
  fi
  ;;

run)
  has_integrate || die "$I is not on origin: write the e2e tests first: integrate.sh tests $f"
  prev=$(report "origin/$I") || damaged
  round=1; [ -z "$prev" ] || round=$(( $(cut -d' ' -f2 <<<"$prev") + 1 ))
  case "$prev" in "fail "*) [ "$round" -le 2 ] || escalate $((round - 1)) ;; esac
  has_tests "origin/$I" || die "tests/e2e/$f/ is not on $I: write the e2e tests first: integrate.sh tests $f"
  git switch -q -C "$I" "origin/$I" || die "could not check out $I"
  # The e2e lock, here too: only save changes tests/e2e/<f>/, so the tests are exactly the last
  # save's. A commit pushed to integrate/<f> some other way (it is not protected) stops the round.
  last=$(git log -1 --format=%H --grep='^Factory-Stage: integrate-save$' "origin/$I")
  tests_now() { git rev-parse -q --verify "HEAD:tests/e2e/$f" 2>/dev/null || true; }
  [ -n "$last" ] && [ "$(git rev-parse -q --verify "$last:tests/e2e/$f" 2>/dev/null)" = "$(tests_now)" ] ||
    die "tests/e2e/$f/ on $I is not as the last integrate.sh save left it (${last:-no save found}): someone changed the e2e tests outside save. Tell the human; do not run the round."
  for ref in "origin/feature/$f" origin/main; do
    git merge -q --no-edit "$ref" > "$tmp/merge" 2>&1 && continue
    git rev-parse -q --verify MERGE_HEAD >/dev/null || { cat "$tmp/merge" >&2; die "could not merge $ref into $I (above)"; }
    git diff --name-only -z --diff-filter=U > "$tmp/conflicts"
    git merge --abort; git switch -q main
    : > "$tmp/owned"; : > "$tmp/unowned"
    while IFS= read -r -d '' p; do
      o=$(path_owner "$tmp/teams.json" "$p" || true); shown=$(printf '%s' "$p" | tr '\000-\037' '?')
      if [ -n "$o" ] && [ "$o" != orchestrator ]; then printf '%s\t%s\n' "$o" "$shown" >> "$tmp/owned"; else printf '%s\n' "$shown" >> "$tmp/unowned"; fi
    done < "$tmp/conflicts"
    say "round $round: merging $ref into $I conflicts"
    while IFS= read -r -u 3 t; do
      paths=$(awk -F'\t' -v t="$t" '$1 == t {print $2}' "$tmp/owned" | head -20 | tr '\n' ',' | sed 's/,$//; s/,/, /g')
      if open_bug "$t"; then say "$t already has an open bug ticket for $f; not filing another (its paths: $paths)"; continue; fi
      "$here/ticket.sh" create --to "$t" --type bug --feature "$f" \
        --needs "Merging $ref into $I conflicts in paths $t owns: $paths. Change them on feature/$f (a pull request into it) so they merge cleanly with origin/main." \
        --why "Feature $f reaches main only through $I, and integration round $round stopped at this merge." \
        --blocks "feature $f: integration round $round" \
        --done "integrate.sh run merges origin/feature/$f and origin/main into $I with no conflict in these paths." ||
        die "could not file the conflict ticket to $t (above); file it by hand"
    done 3< <(cut -f1 "$tmp/owned" | sort -u)
    [ ! -s "$tmp/unowned" ] || say "no team owns these conflicting paths; tell the human: $(tr '\n' ' ' < "$tmp/unowned")"
    event integration feature="$f" step=merge-main status=conflict round="$round"
    exit 4
  done
  [ "$(git rev-parse -q --verify "$last:tests/e2e/$f" 2>/dev/null)" = "$(tests_now)" ] ||
    die "merging origin/feature/$f or origin/main changed tests/e2e/$f/, which only integrate.sh save changes. Tell the human; do not run the round."
  commit=$(git rev-parse HEAD); fsha=$(git rev-parse "origin/feature/$f"); msha=$(git rev-parse origin/main)
  timeout=${FACTORY_E2E_TIMEOUT:-1800}; [[ "$timeout" =~ ^[1-9][0-9]{0,5}$ ]] || timeout=1800
  say "round $round: make e2e at $commit (at most $timeout seconds)"
  rc=0
  perl -e '
    my $t = shift; my $timed = 0;
    my $pid = fork; defined $pid or exit 125;
    if (!$pid) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127 }
    $SIG{ALRM} = sub { $timed = 1; kill "KILL", -$pid; print "integrate: make e2e ran longer than $t seconds and was killed\n" };
    alarm $t; waitpid($pid, 0); my $rc = $?; alarm 0;
    if ($timed) { waitpid($pid, 0); exit 124 }
    exit($rc & 127 ? 128 + ($rc & 127) : $rc >> 8)' "$timeout" make e2e < /dev/null > "$tmp/out" 2>&1 || rc=$?
  verdict=fail; [ "$rc" = 0 ] && verdict=pass
  no_links features "features/$f" "features/$f/e2e-report.md"
  mkdir -p "features/$f"
  { printf '# E2E report: %s\nE2E: %s\nround: %s\ncommit: %s\nfeature: %s\nmain: %s\nexit: %s\nran: %s\n\n## Output (last 200 lines)\n' \
      "$f" "$verdict" "$round" "$commit" "$fsha" "$msha" "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    tail -n 200 "$tmp/out" | perl -ne 'chomp; s/[\x00-\x08\x0a-\x1f\x7f]//g; print "    ", substr($_, 0, 1000), "\n"'
  } > "features/$f/e2e-report.md"
  bash "$here/feature.sh" render "$f" || say "feature.sh render failed (above); FEATURE.md is rendered again next round"
  for p in e2e-report.md FEATURE.md tickets.jsonl; do [ ! -f "features/$f/$p" ] || git add -- "features/$f/$p"; done
  git commit -q -m "integrate $f: round $round, e2e $verdict" -- "features/$f" || die "could not commit the e2e report"
  git push -q -u origin "$I" 2>/dev/null || die "could not push $I; the round's report is only on the local branch: run integrate.sh run again"
  git switch -q main
  event integration feature="$f" step=e2e status="$verdict" round="$round"
  say "round $round: e2e $verdict (make e2e exit $rc); report: features/$f/e2e-report.md on $I"
  if [ "$verdict" = pass ]; then
    open=$(gh issue list --label ticket --label from:orchestrator --label to:research --label type:request --label "feature:$f" \
             --state open --limit 50 --json body --jq "[.[] | select(.body | contains(\"$commit\"))] | length") || die "cannot list tickets on GitHub"
    if [ "${open:-0}" -gt 0 ]; then say "research already has an open acceptance-review ticket for $commit"; exit 0; fi
    "$here/ticket.sh" create --to research --type request --feature "$f" \
      --needs "Review integration round $round of $f, whose e2e tests passed at commit $commit on $I: write features/$f/acceptance-review.md (VERDICT: accept or reject, e2e-commit: $commit, one line per criterion with its evidence) through a pull request into feature/$f." \
      --why "Feature $f reaches main only when research, who wrote its acceptance criteria, accepts an integration round that passed e2e." \
      --blocks "feature $f: its pull request to main (integrate.sh pr)" \
      --done "features/$f/acceptance-review.md on feature/$f gives a VERDICT for e2e-commit $commit, criterion by criterion." ||
      die "e2e passed, but the acceptance-review ticket to research could not be filed (above); file it by hand"
    exit 0
  fi
  [ "$round" -lt 2 ] || escalate "$round"
  say "next: integration-qa attributes each failing test (integrate.sh tests $f, then it writes features/$f/attribution.md),"
  say "then integrate.sh save $f --message \"attribution, round $round\", then integrate.sh tickets $f"
  exit 1
  ;;

tickets)
  has_integrate || die "$I is not on origin: nothing has been integrated yet"
  rep=$(report "origin/$I") || damaged
  [ -n "$rep" ] || die "there is no e2e report on $I yet: integrate.sh run $f"
  read -r verdict round _ <<<"$rep"
  [ "$verdict" = fail ] || die "integration round $round passed: there is nothing to ticket"
  git show "origin/$I:features/$f/attribution.md" > "$tmp/att" 2>/dev/null ||
    die "features/$f/attribution.md is not on $I: integration-qa writes it (integrate.sh tests $f), then integrate.sh save"
  git show "origin/$I:features/$f/acceptance.md" > "$tmp/acc" 2>/dev/null || die "features/$f/acceptance.md is not on $I"
  [ "$(wc -c < "$tmp/att")" -le 65536 ] || die "features/$f/attribution.md is larger than 64 KB: one short line per failing test. Nothing was filed."
  active=$(team_names "$tmp/teams.json" | grep -vx orchestrator | tr '\n' ',' || true)
  F=$f perl -e '
    use strict;
    my ($att, $acc, $round, $teams) = @ARGV;
    my %team = map { $_ => 1 } grep { length } split /,/, $teams;
    my (%crit, $c, @err, %by, @order, $rounds, $n);
    open(my $a, "<", $acc) or die; while (<$a>) { s/\r?\n\z//;
      if (/^## (AC[1-9][0-9]*):/) { $c = $1; $crit{$c} ||= {} } elsif (/^## /) { $c = undef }
      elsif (defined $c && /^- decisions:(.*)$/) { $crit{$c}{$_} = 1 for grep { length } map { s/^\s+|\s+$//gr } split /,/, $1 } }
    open(my $fh, "<", $att) or die;
    while (my $l = <$fh>) {
      $n = $.; $l =~ s/\r?\n\z//; $l =~ s/\t/ /g; $l =~ s/[\x00-\x1f\x7f]//g;
      my $e = sub { push @err, "attribution.md:$n: $_[0]" };
      if (length $l > 2000) { $e->("longer than 2000 characters: keep each line short, the detail is in the e2e report"); next }
      if ($n == 1) { $l eq "# Attribution: $ENV{F}" or $e->("the first line must be \"# Attribution: $ENV{F}\""); next }
      next if $l =~ /^\s*$/;
      if ($l =~ /^round:/) { $rounds++; $l =~ /^round: ([0-9]{1,4})$/ && $1 == $round or $e->("the round must be $round, the latest e2e report\x27s"); next }
      if ($l !~ /^- test:/) { $e->("not a line of the format: - test: ... | criterion: ... | decision: ... | contract: ... | team: ... | evidence: ..."); next }
      my @k = qw(test criterion decision contract team evidence);
      my @f = split / \| /, substr($l, 2), -1;
      if (@f != 6) { $e->(scalar(@f) . " fields, not 6 separated by \" | \" (no field may contain \" | \")"); next }
      my (%v, $ok); $ok = 1;
      for my $i (0 .. 5) { if ($f[$i] =~ /^$k[$i]:\s*(.*?)\s*$/) { $v{$k[$i]} = $1 } else { $e->("field " . ($i + 1) . " must start with \"$k[$i]:\""); $ok = 0 } }
      next unless $ok;
      my $bad = 0; my $no = sub { $e->($_[0]); $bad = 1 };
      length $v{test} or $no->("the test name is empty");
      length $v{test} <= 300 or $no->("the test name is longer than 300 characters");
      if (!$crit{$v{criterion}}) { $no->("criterion \"$v{criterion}\" is not in acceptance.md") }
      elsif (!$crit{$v{criterion}}{$v{decision}}) { $no->("decision \"$v{decision}\" is not one that $v{criterion} names in acceptance.md") }
      my ($path, $frag) = $v{contract} =~ /^([^#]*)(#.*)?$/;
      $v{contract} eq "none" or (length $path <= 200 && $path =~ m{^contracts(/[A-Za-z0-9][A-Za-z0-9._-]*)+$} && $path !~ /\.\./ && (!defined $frag || $frag =~ /^#\S*$/))
        or $no->("contract must be a path under contracts/ (optionally #fragment) or none");
      $team{$v{team}} or $no->("team \"$v{team}\" is not an active team other than orchestrator (" . join(", ", sort keys %team) . ")");
      length $v{evidence} or $no->("the evidence is empty");
      next if $bad;
      push @order, $v{team} unless $by{$v{team}};
      push @{$by{$v{team}}}, [$v{test}, $v{decision}];
    }
    push @err, "attribution.md: no round: line" if !$rounds;
    push @err, "attribution.md: more than one round: line" if $rounds && $rounds > 1;
    push @err, "attribution.md: no \"- test:\" line" if !@order && !@err;
    if (@err) { print STDERR "$_\n" for @err; exit 1 }
    for my $t (@order) { print join("\t", $t, $by{$t}[0][1], join("; ", map { $_->[0] } @{$by{$t}})), "\n" }
  ' "$tmp/att" "$tmp/acc" "$round" "$active" > "$tmp/plan" || die "features/$f/attribution.md has the problems above: nothing was filed. integration-qa fixes it, integrate.sh save, then run this again."
  while IFS=$'\t' read -r -u 3 t _ _; do open_bug "$t" && echo "$t" >> "$tmp/skip"; done 3< "$tmp/plan"
  while IFS=$'\t' read -r -u 3 t d tests; do
    if grep -qxF -- "$t" "$tmp/skip" 2>/dev/null; then say "$t already has an open bug ticket for $f: not filing another"; continue; fi
    [ "${#tests}" -le 6000 ] || tests="${tests:0:6000}... (all of them in attribution.md)"
    "$here/ticket.sh" create --to "$t" --type bug --feature "$f" --decision "$d" \
      --needs "Integration round $round of $f failed these e2e tests, attributed to $t: $tests. The evidence is in features/$f/attribution.md and features/$f/e2e-report.md on branch $I." \
      --why "Feature $f reaches main only when its e2e tests pass; integration-qa attributed these failures to $t from the e2e report, the code and the decision records." \
      --blocks "feature $f: integration round $((round + 1))" \
      --done "These e2e tests pass in integration round $((round + 1)) (integrate.sh run $f)." ||
      die "could not file the bug ticket to $t (above). Tickets already filed stay; run this again, it skips teams that have one."
  done 3< "$tmp/plan"
  event integration feature="$f" step=tickets status=filed round="$round"
  say "round $round: bug tickets filed; when the teams' fixes are merged into feature/$f, run integrate.sh run $f (round $((round + 1)))"
  ;;

pr)
  has_integrate || die "$I is not on origin: integrate.sh run $f first"
  checkout_integrate
  rep=$(report HEAD) || damaged
  [ -n "$rep" ] || die "there is no e2e report on $I: integrate.sh run $f"
  read -r verdict round commit <<<"$rep"
  [ "$verdict" = pass ] || die "the e2e report of round $round says fail: the feature cannot reach main"
  git cat-file -e "HEAD:features/$f/acceptance-review.md" 2>/dev/null ||
    die "features/$f/acceptance-review.md is not on feature/$f yet: research reviews round $round first (its ticket)"
  rv=$(git show "HEAD:features/$f/acceptance-review.md" | perl -ne 's/\r//g; if (/^VERDICT:/) { print /^VERDICT:[ \t]*accept[ \t]*$/ ? "accept" : "no"; exit }')
  [ "$rv" = accept ] || die "research's acceptance review does not say VERDICT: accept: tell the human, with features/$f/acceptance-review.md"
  rc_=$(git show "HEAD:features/$f/acceptance-review.md" | perl -ne 's/\r//g; if (/^e2e-commit:/) { print $1 if /^e2e-commit:[ \t]*([0-9a-f]{40})[ \t]*$/; exit }')
  [ "$rc_" = "$commit" ] || die "the acceptance review is of e2e commit ${rc_:-none}, not round $round's $commit: research reviews the latest round"
  git merge-base --is-ancestor "$commit" HEAD 2>/dev/null || die "round $round's commit $commit is not in $I: integrate.sh run $f"
  # Records may arrive after the round (research's review brings its work folder and observation);
  # anything else is a change the round did not test. check-feature.sh applies the same rule in CI.
  changed=$(git diff --name-only --no-renames "$commit" HEAD | grep -Ev "^(features/$f/|work/[^/]+/|memory/observations/)" | tr '\n' ' ' || true)
  [ -z "$changed" ] || die "code changed since round $round ($changed): run integrate.sh run $f"
  bash "$here/feature.sh" render "$f" || say "feature.sh render failed (above); FEATURE.md is not up to date"
  for p in FEATURE.md tickets.jsonl; do [ ! -f "features/$f/$p" ] || git add -- "features/$f/$p"; done
  git diff --cached --quiet || git commit -q -m "integrate $f: feature record for the pull request" -- "features/$f" || die "could not commit"
  git push -q -u origin "$I" 2>/dev/null || die "could not push $I"
  tier=$(bash "$here/risk-tier.sh" origin/main 2>/dev/null) || die "risk-tier.sh failed: run it on $I to see why"
  git switch -q main
  n=$(gh pr list --head "$I" --base main --state open --json number --jq '.[0].number // empty') || die "cannot list pull requests on GitHub"
  ensure_labels "risk:$tier" || die "cannot list labels on GitHub"
  if [ -z "$n" ]; then
    url=$(printf 'Feature `%s`, integrated on `%s`: e2e passed in integration round %s at %s, and the acceptance review says accept.\nSee features/%s/FEATURE.md and features/%s/e2e-report.md. Opened by factory/scripts/integrate.sh pr.\n' \
            "$f" "$I" "$round" "$commit" "$f" "$f" | gh pr create --base main --head "$I" --title "Feature $f" --body-file - --label "risk:$tier") ||
      die "GitHub refused the pull request"
    n=${url##*/}; [[ "$n" =~ ^[0-9]+$ ]] || die "unexpected answer from gh: $url"
    say "opened pull request #$n: $I -> main, risk:$tier"
  else
    gh pr edit "$n" --add-label "risk:$tier" >/dev/null || die "could not label pull request #$n"
    say "pull request #$n ($I -> main) is already open; risk:$tier"
  fi
  max=$(git show origin/main:factory/policy.env 2>/dev/null | sed -n 's/^AUTO_MERGE_MAX_TIER=//p' | tail -1 | tr -d '[:space:]' || true)
  if [[ "$max" =~ ^R[0-3]$ ]] && [ "${tier#R}" -le "${max#R}" ]; then
    gh pr merge "$n" --auto --squash >/dev/null && say "auto-merge is on: $tier is within AUTO_MERGE_MAX_TIER=$max" ||
      say "could not turn on auto-merge for #$n; it waits for the human"
  else
    say "$tier is above AUTO_MERGE_MAX_TIER=${max:-none}: the pull request waits for the human"
  fi
  event integration feature="$f" step=pr status=opened round="$round"
  ;;

close)
  merged=$(gh pr list --head "$I" --base main --state merged --json number --jq length) || die "cannot list pull requests on GitHub"
  [ "${merged:-0}" -gt 0 ] || die "the pull request $I -> main is not merged; close runs after it merges"
  gh api -X DELETE "repos/{owner}/{repo}/branches/feature/$f/protection" >/dev/null 2>&1 ||
    say "could not remove feature/$f's branch protection (it may have none); deleting the branch anyway"
  git switch -q main
  for b in "feature/$f" "$I"; do
    if git rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null; then git push -q origin --delete "$b" 2>/dev/null || die "could not delete $b on origin"; fi
    if git rev-parse -q --verify "refs/heads/$b" >/dev/null; then git branch -q -D "$b"; fi
  done
  event integration feature="$f" step=closed status=done
  say "feature $f is closed: feature/$f and $I are deleted. dispatch.sh may run the next cycle."
  ;;
drop)
  [ $# -eq 2 ] && [ "$1" = --reason ] || die "usage: integrate.sh drop $f --reason <why the human stopped it>"
  why=$(clean_text "$2" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//' | cut -c1-300)
  [ -n "$why" ] || die "drop needs --reason <why the human stopped it>, for the record"
  # Kept first: nothing is deleted unless every branch is safe as a tag.
  kept=""
  for b in "feature/$f" "$I"; do
    git rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null || continue
    git push -q origin "refs/remotes/origin/$b:refs/tags/stopped/$b" 2>/dev/null ||
      die "could not keep $b as the tag stopped/$b (is there one already, at another commit?); nothing was deleted"
    kept+=" stopped/$b"
  done
  note="Feature $f was stopped by the human: $why. Its branches are kept as the tags${kept:- (none)}."
  prs=$( { gh pr list --base "feature/$f" --state open --json number --jq '.[].number' &&
           gh pr list --head "$I" --base main --state open --json number --jq '.[].number'; } </dev/null) || die "cannot list pull requests on GitHub"
  for n in $prs; do gh pr close "$n" --comment "$note" >/dev/null </dev/null || die "could not close pull request #$n"; done
  iss=$(gh issue list --label "feature:$f" --state open --limit 200 --json number --jq '.[].number' </dev/null) || die "cannot list issues on GitHub"
  for n in $iss; do gh issue close "$n" --comment "$note" >/dev/null </dev/null || die "could not close issue #$n"; done
  gh api -X DELETE "repos/{owner}/{repo}/branches/feature/$f/protection" >/dev/null 2>&1 ||
    say "could not remove feature/$f's branch protection (it may have none); deleting the branch anyway"
  git switch -q main
  for b in "feature/$f" "$I" "sync/$f"; do
    if git rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null; then git push -q origin --delete "$b" 2>/dev/null || die "could not delete $b on origin"; fi
    if git rev-parse -q --verify "refs/heads/$b" >/dev/null; then git branch -q -D "$b"; fi
  done
  event integration feature="$f" step=dropped status=done detail="$why"
  say "feature $f is stopped: kept as${kept:- nothing}; closed pull requests: $(echo ${prs:-none}); closed issues: $(echo ${iss:-none})."
  say "dispatch.sh may run the next cycle."
  ;;
esac
