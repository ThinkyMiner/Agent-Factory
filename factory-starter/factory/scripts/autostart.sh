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
#   /integrate <f>        orchestrator: feature/<f> or integrate/<f> moved, or one of its open
#                         tickets on <f> changed state (a team declined or finished it), since it
#                         was last typed: nothing else tells the orchestrator a ticket came back
# Only into a tab of this factory's Herdr space that waits for input, one command per tab per pass,
# lowest issue first. /dispatch and /work are typed again after retry_minutes [30] while nothing
# came of them. Work outside a dispatched feature (an item for main, a ticket without feature:<f>)
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

f=$(git -C "$home" for-each-ref --format='%(refname:lstrip=4)' refs/remotes/origin/feature/ |
  grep -E '^[a-z0-9][a-z0-9-]{0,47}$' | head -1)
if [ -z "$f" ]; then
  # ---- dispatch: an approved cycle, no feature open ----
  for c in $(git -C "$home" ls-tree --name-only origin/main planning/ 2>/dev/null | sed 's|^planning/||'); do
    [[ "$c" =~ ^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || continue
    st=$(git -C "$home" show "origin/main:planning/$c/state.json" 2>/dev/null | jq -r '.status // empty | strings' 2>/dev/null)
    [ "$st" = approval ] && git -C "$home" cat-file -e "origin/main:planning/$c/DECISIONS.md" 2>/dev/null || continue
    due "dispatch:$c" && type_into orchestrator "/dispatch $c" && mark "dispatch:$c" "$now"
    break
  done
else
  # ---- work: the feature's items and accepted tickets, lowest first ----
  if items=$(gh issue list --state open --label "feature:$f" --limit 200 --json number,labels 2>/dev/null) &&
     jq -e 'type == "array"' <<<"$items" >/dev/null 2>&1; then
    while IFS=$'\t' read -r t n; do
      [[ "$n" =~ ^[0-9]{1,9}$ ]] && valid_team_name "$t" && [ "$t" != orchestrator ] || continue
      [ -z "$(git -C "$home" for-each-ref --format=x "refs/heads/work/$n-*" "refs/remotes/origin/work/$n-*")" ] || continue
      due "work:$n" || continue
      cmd="/work $n"; [ "$t" = research ] && cmd="/research-work $n"
      type_into "$t" "$cmd" && mark "work:$n" "$now"
    done < <(jq -r '.[] | [.labels[]?.name | strings] as $l
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
    tk=$(jq -r '[.[] | [.labels[]?.name | strings] as $l | select(($l | index("ticket")) and ($l | index("from:orchestrator")))
      | "\(.number):\([$l[] | select(startswith("state:")) | ltrimstr("state:")] | join("+"))"] | sort | join(",")' <<<"$items")
  else tk=${was#* }; tk=${tk#* }; fi     # the third field; the second may be empty
  key="$(git -C "$home" rev-parse -q --verify "refs/remotes/origin/feature/$f") $(git -C "$home" rev-parse -q --verify "refs/remotes/origin/integrate/$f") $tk"
  if [ "$was" != "$key" ] && type_into orchestrator "/integrate $f"; then
    mark "integrate:$f" "$(jq -n --arg v "$key" '$v')"
  fi
fi
printf '%s\n' "$state" > "$sf.new" && mv "$sf.new" "$sf"
