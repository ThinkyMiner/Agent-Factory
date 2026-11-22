#!/usr/bin/env bash
# Autostart: types the next command of approved work into the factory tab that runs it, so no
# person has to. A script, not a model. The human decides what gets built by approving a cycle's
# decisions (human-approved, merged); everything typed here follows from that, and each skill still
# checks all it checks when a person types it.
#   /dispatch <cycle>     orchestrator: the cycle's state on origin/main is "approval", its
#                         DECISIONS.md is there, and no feature branch is open
#   /work <n>             team <t>: an open issue labelled feature:<f> for the open feature branch,
#   /research-work <n>    and team:<t> (an item from dispatch) or ticket, to:<t> and state:accepted;
#                         with no work/<n>-* branch yet. The research team gets /research-work.
#                         Typed again into an item that has its branch when a ticket naming it
#                         under "blocks" (with feature:<f>) was answered (done, verified) or
#                         declined since autostart last saw it: the item stopped to wait for it.
#   /integrate <f>        orchestrator: feature/<f> or integrate/<f> moved, the factory on main
#                         (factory/, .claude/) changed, or one of its open tickets on <f> changed
#                         state (a team declined or finished it), since it was last typed: nothing
#                         else tells the orchestrator a ticket came back or main has a kit to sync;
#                         and once the pull request integrate/<f> -> main has merged, so it closes
# Only into a tab of this factory's Herdr space that waits for input, one command per tab per pass,
# lowest issue first. /dispatch and /work are typed again after retry_minutes [30] while nothing
# came of them, or at once when what they wait on moves: origin/main for /dispatch, the feature
# branch for /work (the item it waited for merged). Work outside a dispatched feature (an item for main, a ticket without feature:<f>)
# still waits for a person to type /work.
#   autostart.sh     one pass; sweep.sh runs it every pass. FACTORY_AUTOSTART=0: does nothing.
# State: .factory/autostart.json. Reads GitHub; writes only its state and events.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "autostart: $*" >&2; exit 1; }
[ $# -eq 0 ] || die "usage: autostart.sh"
[ "${FACTORY_AUTOSTART:-1}" != 0 ] || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams=$(teams_file "$home") || die "autostart is for team mode, and this factory has no factory/teams.json"
quiet() { echo "autostart: $*" >&2; exit 0; }
command -v herdr-app >/dev/null 2>&1 && command -v hc >/dev/null 2>&1 || quiet "Herdr is not running: nothing typed"
lay=$(herdr-app ls 2>/dev/null) && jq -e '.spaces | type == "array"' <<<"$lay" >/dev/null 2>&1 || quiet "Herdr is not running: nothing typed"
git -C "$home" fetch -q --prune origin 2>/dev/null || quiet "cannot reach origin: nothing typed"

sf="$home/.factory/autostart.json"; mkdir -p "$home/.factory"
state=$(jq -c 'select(type == "object")' "$sf" 2>/dev/null) || true; [ -n "$state" ] || state='{}'
now=$(date -u +%s); retry=$(( $(planning_limit "$teams" retry_minutes 30) * 60 ))
label=$(basename "$home"); typed=" "
# type_into <team> <command>: type it into the team's tab unless that tab is busy, missing, or
# already typed into this pass.
type_into() {
  local term
  team_names "$teams" | grep -qxF -- "$1" || return 1
  term=$(jq -r --arg l "$label" --arg t "$1" '[.spaces[] | select(.name == $l)][0].tabs[]? | select(.name == $t)
    | .terminals[0].terminal // empty' <<<"$lay" 2>/dev/null | head -1)
  [ -n "$term" ] && [[ "$typed" != *" $term "* ]] || return 1
  hc_type "$term" "$2" || return 1
  typed+="$term "
  echo "autostart: typed $2 into $1 ($term)"
  "$here/emit-event.sh" autostart team="$1" detail="$2" >/dev/null 2>&1 || true
}
due() { local t; t=$(jq -r --arg k "$1" '.[$k] // 0 | numbers' <<<"$state" 2>/dev/null); [ $((now - ${t:-0})) -ge "$retry" ]; }
mark() { state=$(jq -c --arg k "$1" --argjson v "$2" '.[$k] = $v' <<<"$state"); }
# again <key> <sha>: due, or <sha> (the branch the command waits on) moved since it was typed.
again() { due "$1" || [ "$(jq -r --arg k "$1@" '.[$k] // "" | strings' <<<"$state")" != "$2" ]; }
typed_at() { mark "$1" "$now"; mark "$1@" "$(jq -n --arg v "$2" '$v')"; }

f=$(git -C "$home" for-each-ref --format='%(refname:lstrip=4)' refs/remotes/origin/feature/ |
  grep -E '^[a-z0-9][a-z0-9-]{0,47}$' | head -1)
if [ -z "$f" ]; then
  main=$(git -C "$home" rev-parse -q --verify refs/remotes/origin/main)
  # ---- dispatch: an approved cycle, no feature open ----
  for c in $(git -C "$home" ls-tree --name-only origin/main planning/ 2>/dev/null | sed 's|^planning/||'); do
    [[ "$c" =~ ^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || continue
    st=$(git -C "$home" show "origin/main:planning/$c/state.json" 2>/dev/null | jq -r '.status // empty | strings' 2>/dev/null)
    [ "$st" = approval ] && git -C "$home" cat-file -e "origin/main:planning/$c/DECISIONS.md" 2>/dev/null || continue
    again "dispatch:$c" "$main" && type_into orchestrator "/dispatch $c" && typed_at "dispatch:$c" "$main"
    break
  done
else
  fsha=$(git -C "$home" rev-parse -q --verify "refs/remotes/origin/feature/$f")
  # ---- work: the feature's items and accepted tickets, lowest first ----
  # Closed issues too, for the tickets: answering one may close it (verified) before this pass.
  # ponytail: the newest 300 issues of the feature; page through them if a feature ever has more.
  if items=$(gh issue list --state all --label "feature:$f" --limit 300 --json number,state,labels,body 2>/dev/null) &&
     jq -e 'type == "array"' <<<"$items" >/dev/null 2>&1; then
    # "<item> <ticket> answered|declined" for every ticket whose "blocks" names an issue.
    blk=$(jq -r '.[] | [.labels[]?.name | strings] as $l | select($l | index("ticket")) | .number as $t
        | ([$l[] | select(startswith("state:")) | ltrimstr("state:")]
           | if (index("done") or index("verified")) then "answered" elif index("declined") then "declined" else empty end) as $c
        | (.body // "" | strings | try (capture("<!-- factory-ticket (?<j>[^\n]*) -->").j | fromjson | .blocks) catch null)
        | if type == "array" then .[] else empty end
        | (numbers, (strings | ltrimstr("#") | select(test("^[0-9]{1,9}$")) | tonumber))
        | "\(.)\t\($t)\t\($c)"' <<<"$items" 2>/dev/null | sort -u)
    while IFS=$'\t' read -r t n; do
      [[ "$n" =~ ^[0-9]{1,9}$ ]] && valid_team_name "$t" && [ "$t" != orchestrator ] || continue
      cmd="/work $n"; [ "$t" = research ] && cmd="/research-work $n"
      if [ -n "$(git -C "$home" for-each-ref --format=x "refs/heads/work/$n-*" "refs/remotes/origin/work/$n-*")" ]; then
        # Started: resume it once per ticket answer it was waiting for.
        pend=""
        while IFS=$'\t' read -r bt bc; do
          [[ "$bt" =~ ^[0-9]{1,9}$ ]] || continue
          [ "$(jq -r --arg k "resume:$n:$bt" '.[$k] // "" | strings' <<<"$state")" = "$bc" ] || pend+="$bt=$bc "
        done < <(awk -F'\t' -v n="$n" '$1 == n { print $2 "\t" $3 }' <<<"$blk")
        if [ -n "$pend" ] && type_into "$t" "$cmd"; then
          for kv in $pend; do mark "resume:$n:${kv%%=*}" "\"${kv#*=}\""; done
        fi
        continue
      fi
      again "work:$n" "$fsha" || continue
      type_into "$t" "$cmd" && typed_at "work:$n" "$fsha"
    done < <(jq -r '.[] | select((.state // "OPEN" | ascii_upcase) == "OPEN") | [.labels[]?.name | strings] as $l
        | (if ($l | index("ticket")) then (if ($l | index("state:accepted")) then [$l[] | select(startswith("to:")) | ltrimstr("to:")] else [] end)
           else [$l[] | select(startswith("team:")) | ltrimstr("team:")] end) as $who
        | select($who | length == 1) | [$who[0], .number] | @tsv' <<<"$items" | sort -t$'\t' -k2,2n)
  else
    echo "autostart: cannot read the items of $f from GitHub this pass" >&2
  fi
  # ---- integrate: whenever the feature moved ----
  # ponytail: the orchestrator's own pushes to integrate/<f> also count as a move, so it may be
  # typed once more and find nothing to do; key on merged pull requests if that ever costs.
  was=$(jq -r --arg k "integrate:$f" '.[$k] // "" | strings' <<<"$state")
  # Its tickets as "<n>:<state>,..."; when GitHub cannot be read, the last ones seen.
  if jq -e 'type == "array"' <<<"${items:-}" >/dev/null 2>&1; then
    tk=$(jq -r '[.[] | select((.state // "OPEN" | ascii_upcase) == "OPEN") | [.labels[]?.name | strings] as $l | select(($l | index("ticket")) and ($l | index("from:orchestrator")))
      | "\(.number):\([$l[] | select(startswith("state:")) | ltrimstr("state:")] | join("+"))"] | sort | join(",")' <<<"$items")
  else tk=${was#* }; tk=${tk#* }; tk=${tk#* }; tk=${tk#* }; fi     # the fifth field; the second may be empty
  # The pull request to main, once merged: the orchestrator closes the feature. When GitHub cannot
  # be read, the last value seen (the fourth field).
  if m=$(gh pr list --head "integrate/$f" --base main --state merged --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null); then
    [[ "$m" =~ ^[0-9]{1,9}$ ]] && m="merged:$m" || m=-
  else m=${was#* }; m=${m#* }; m=${m#* }; m=${m%% *}; fi
  # The factory on main, as its trees: /integrate syncs main into the feature when it changed.
  kit="$(git -C "$home" rev-parse -q --verify "refs/remotes/origin/main:factory")+$(git -C "$home" rev-parse -q --verify "refs/remotes/origin/main:.claude")"
  key="$fsha $(git -C "$home" rev-parse -q --verify "refs/remotes/origin/integrate/$f") $kit ${m:--} $tk"
  if [ "$was" != "$key" ] && type_into orchestrator "/integrate $f"; then
    mark "integrate:$f" "$(jq -n --arg v "$key" '$v')"
  fi
fi
printf '%s\n' "$state" > "$sf.new" && mv "$sf.new" "$sf"
