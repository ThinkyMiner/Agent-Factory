#!/usr/bin/env bash
# A team's position for the planning cycle, written before it can see anyone else's.
#   position.sh submit < position.md      (again to replace it, until the round closes)
#   position.sh attach <name> < file      a contract draft or other long material, published with it
# Only during the positions round, only by the cycle's teams (the session's team, never an
# argument). The position is sealed in .factory/planning/<cycle>/sealed/, which no session may
# read (the guard), and round.sh publishes every position at once when the round closes.
# A position has these sections, each with content:
#   ## Build   ## Needs from others   ## Risks   ## Open questions   ## What I would object to in the brief
# At most limits.position_chars [20000] characters; an attachment at most 200000 bytes.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "position: $*" >&2; exit 1; }

cmd=${1:-}
case "$cmd" in submit|attach) ;; *) die "usage: position.sh submit < position.md | position.sh attach <name> < file" ;; esac
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(factory_home "$top")
teams=$(teams_file "$top") || die "planning is for team mode, and this factory has no factory/teams.json"
me=$(session_team "$top") || die "this session has no team (FACTORY_TEAM=${FACTORY_TEAM:-unset} in $top)"
cyc=$(active_cycle "$home") || die "no planning cycle is open"
[ "$(git -C "$home" rev-parse --abbrev-ref HEAD)" = "planning/$cyc" ] || die "the main checkout is not on planning/$cyc; ask the orchestrator"
S=$(jq -c 'select(type == "object" and (.teams | type == "array"))' "$home/planning/$cyc/state.json" 2>/dev/null) || true
[ -n "$S" ] || die "the cycle's state.json is missing or damaged"
[ "$(jq -r .status <<<"$S")" = positions ] || die "positions are taken only in the positions round (the cycle is $(jq -r .status <<<"$S"))"
jq -e --arg t "$me" '.teams | index($t)' >/dev/null <<<"$S" || die "$me is not one of this cycle's teams; the orchestrator chairs and has no position"
[ ! -t 0 ] || die "give the text on stdin"
sealed="$home/.factory/planning/$cyc/sealed"; mkdir -p "$sealed"

if [ "$cmd" = attach ]; then
  name=${2:-}; [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$ ]] || die "usage: position.sh attach <name> (letters, digits, . _ -)"
  mkdir -p "$sealed/$me-attachments"; head -c 200001 > "$sealed/$me-attachments/.new"
  [ "$(wc -c < "$sealed/$me-attachments/.new" | tr -d ' ')" -le 200000 ] || { rm -f "$sealed/$me-attachments/.new"; die "the attachment is over 200000 bytes"; }
  mv "$sealed/$me-attachments/.new" "$sealed/$me-attachments/$name"
  echo "position: $name sealed with $me's position"
  exit 0
fi

text=$(head -c 400000)
max=$(planning_limit "$teams" position_chars 20000)
[ "${#text}" -le "$max" ] || die "the position has ${#text} characters, over $max; put long material in attachments (position.sh attach)"
for h in "Build" "Needs from others" "Risks" "Open questions" "What I would object to in the brief"; do
  printf '%s\n' "$text" | awk -v h="## $h" 'tolower($0) == tolower(h) {on = 1; next} /^## / {on = 0} on && NF {found = 1} END {exit !found}' ||
    die "the position needs a '## $h' section with content (write 'none' if there is nothing)"
done
printf '%s\n' "$text" > "$sealed/.$me.new" && mv "$sealed/.$me.new" "$sealed/$me.md"
"$here/emit-event.sh" position cycle="$cyc" action=submitted >/dev/null 2>&1 || true
echo "position: $me's position for $cyc is sealed; it is published with the others when the round closes."
if bash "$here/round.sh" ready >/dev/null 2>&1; then ring_team "$home" orchestrator "Planning: a round can close. Run /plan." || true; fi
