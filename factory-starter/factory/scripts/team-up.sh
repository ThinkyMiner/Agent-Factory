#!/usr/bin/env bash
# Launch a team-mode factory: one worktree and one Claude Code session per active team.
#   team-up.sh [--print]          (the human runs it as `factory team-up`, from a terminal)
# For each active team in factory/teams.json:
#   - the orchestrator gets the main checkout;
#   - every other team gets a worktree at ../<repo>.teams/<team> on branch team/<team>, made from
#     origin/main (main without a remote); an existing branch or worktree is reused;
#   - a tab named <team> in this factory's space in Herdr (the app; the space is named <repo>),
#     running `env FACTORY_TEAM=<team> CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 bot-session.sh claude
#     --agent <agent> -n <team>`. <agent> is the team's "agent" in the roster, else orchestrator /
#     <team>-lead. The survey is off because it reads the digits the sweep types (autostart.sh);
# plus a tab named sweep running `sweep.sh --loop` in the main checkout.
# With a bot token in the keychain (item factory-github-bot), every session works on GitHub as
# the bot (bot-session.sh), and team-up refuses to start anything until that token works and is
# not your own. Without one, sessions work as you, and team-up says what that costs.
# Idempotent: a team whose tab runs claude is skipped, so this also restarts a closed tab.
# --print makes the worktrees, then prints plain launch commands instead of using Herdr.
# Sessions cannot run this (the guard blocks it): identities are handed out by the human.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "team-up: $*" >&2; exit 1; }
bot="$here/bot-session.sh"

print=0
case "${1:-}" in --print) print=1 ;; '') ;; *) die "usage: team-up.sh [--print]" ;; esac
command -v jq >/dev/null 2>&1 || die "jq is not installed"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
home=$(cd "$(factory_home "$top")" && pwd -P)
teams=$(teams_file "$home") || die "no factory/teams.json in $home: this factory runs as a single team (see 'factory teams init')"
jq -e '.teams | type == "object"' "$teams" >/dev/null 2>&1 || die "factory/teams.json is unreadable"
tdir=$(teams_dir "$home")
label=$(basename "$home")

checkout_of() {  # checkout_of <team>: its directory, making the worktree if it is missing
  local t=$1 wt base
  [ "$t" = orchestrator ] && { echo "$home"; return; }
  wt="$tdir/$t"
  if [ -e "$wt" ]; then
    git -C "$home" worktree list --porcelain | grep -qxF "worktree $(cd "$wt" && pwd -P)" ||
      die "$wt exists but is not a worktree of $home. Move it away and run again."
    echo "$wt"; return
  fi
  mkdir -p "$tdir"
  git -C "$home" fetch -q origin 2>/dev/null || true
  if git -C "$home" rev-parse -q --verify "refs/heads/team/$t" >/dev/null; then
    git -C "$home" worktree add -q "$wt" "team/$t" >&2
  else
    base=main
    git -C "$home" rev-parse -q --verify refs/remotes/origin/main >/dev/null && base=origin/main
    git -C "$home" worktree add -q -b "team/$t" "$wt" "$base" >&2
  fi
  echo "made worktree $wt (branch team/$t)" >&2
  echo "$wt"
}

agent_of() {
  local a
  a=$(jq -r --arg t "$1" '.teams[$t].agent // empty' "$teams")
  [ -n "$a" ] || { [ "$1" = orchestrator ] && a=orchestrator || a="$1-lead"; }
  printf '%s' "$a" | grep -Eq '^[a-z][a-z0-9-]{0,63}$' || die "team $1 has an invalid agent name: $a"
  [ -f "$home/.claude/agents/$a.md" ] || die "team $1 runs agent $a, but .claude/agents/$a.md does not exist"
  echo "$a"
}

# Orchestrator first: it owns the main checkout and, in Herdr, the space's first tab.
list=$(team_names "$teams" | awk '$0 == "orchestrator" {print; next} {rest = rest $0 "\n"} END {printf "%s", rest}')
[ -n "$list" ] || die "factory/teams.json has no active team"
bad=$(jq -c '.teams | keys[] | select(test("^[a-z][a-z0-9_-]{0,31}$") | not)' "$teams" | head -1)
[ -z "$bad" ] || die "invalid team name in factory/teams.json: $bad (lowercase letters, digits, - and _)"
! grep -qx sweep <<<"$list" || die "'sweep' is the name of the sweep's tab; give that team another name"

# Whose GitHub identity the agents get: the bot's if its token is stored (it must work and must
# not be yours), else yours.
command -v gh >/dev/null 2>&1 || die "gh is not installed"
you=$(env -u GH_TOKEN gh api user --jq .login 2>/dev/null) || die "gh is not logged in as you (run gh auth login)"
as=()
if security find-generic-password -s factory-github-bot -w >/dev/null 2>&1; then
  botlogin=$("$bot" gh api user --jq .login 2>&1) || die "the keychain holds a bot token (factory-github-bot), and it does not work: $botlogin"
  [ "$(tr '[:upper:]' '[:lower:]' <<<"$botlogin")" != "$(tr '[:upper:]' '[:lower:]' <<<"$you")" ] ||
    die "the keychain's factory-github-bot token is yours ($you). Store the bot account's own token, or delete the item to run agents as you."
  as=("$bot")
  echo "agents work on GitHub as $botlogin"
else
  echo "agents work on GitHub as you ($you): there is no bot token in the keychain. risk-gate cannot tell"
  echo "  your human-approved label from an agent's; only the guard keeps agents from adding it (docs/factory/TEAMS.md)."
fi

if [ "$print" = 1 ]; then
  echo "# One terminal per team:"
  for t in $list; do
    a=$(agent_of "$t"); dir=$(checkout_of "$t")
    printf 'cd %q && FACTORY_TEAM=%q CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 %sclaude --agent %q -n %q\n' "$dir" "$t" "${as[*]:+$(printf '%q ' "${as[@]}")}" "$a" "$t"
  done
  echo "# And one for the sweep:"
  printf 'cd %q && %sbash %q --loop\n' "$home" "${as[*]:+$(printf '%q ' "${as[@]}")}" "$here/sweep.sh"
  exit 0
fi

command -v herdr-app >/dev/null 2>&1 || die "Herdr is not installed. Use 'factory team-up --print' to launch the sessions yourself."
lay=$(herdr-app ls 2>/dev/null) && jq -e '.spaces | type == "array"' <<<"$lay" >/dev/null 2>&1 ||
  die "Herdr is not open. Open it, then run this again (or use --print)."
space=$(jq -r --arg l "$label" '[.spaces[] | select(.name == $l)][0].id // empty' <<<"$lay")
started=0
for t in $list; do
  # The team's tab in this factory's space, as "<terminal> <app> <status>", or nothing.
  tab=$(jq -r --arg s "$space" --arg t "$t" '[.spaces[] | select(.id == $s) | .tabs[] | select(.name == $t)
    | .terminals[0] | select(.)][0] | select(.) | "\(.terminal) \(.app) \(.status)"' <<<"$lay")
  if [ -n "$tab" ]; then
    read -r term app status <<<"$tab"
    [ "$app" = claude-code ] || die "tab $t in Herdr space '$label' is not running claude ($term). Close that tab, then run this again."
    case "$status" in blocked) echo "$t: running in $term, waiting for you (a trust or sign-in prompt): answer it there" ;;
                      *) echo "$t: already running in $term" ;; esac
    continue
  fi
  a=$(agent_of "$t"); dir=$(checkout_of "$t")
  argv=$(jq -nc --arg t "$t" --arg a "$a" '$ARGS.positional as $as | ["env", "FACTORY_TEAM=\($t)", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1"] + $as + ["claude", "--agent", $a, "-n", $t]' --args ${as[@]+"${as[@]}"})
  if [ -z "$space" ]; then
    out=$(herdr-app do space.new --name "$label" --folder "$dir" --tab "$t" --argv "$argv") || die "Herdr did not start $t: $out"
    space=$(jq -r '.space // empty' <<<"$out" 2>/dev/null)
  else
    out=$(herdr-app do tab.new --space "$space" --name "$t" --folder "$dir" --argv "$argv") || die "Herdr did not start $t: $out"
  fi
  term=$(jq -r '.terminal // empty' <<<"$out" 2>/dev/null)
  [ -n "$term" ] && [ -n "$space" ] || die "Herdr did not start $t: $out"
  # A new folder asks whether you trust it; that answer is yours, so team-up leaves it to you.
  echo "$t: started $a in $term ($dir). If it asks whether you trust the folder, answer it there."
  started=$((started + 1))
done
# The sweep: a plain loop, no model. Its tab is reused while it exists.
sw=$(jq -r --arg s "$space" '[.spaces[] | select(.id == $s) | .tabs[] | select(.name == "sweep") | .terminals[0].terminal // empty][0] // empty' <<<"$lay")
if [ -n "$sw" ]; then
  echo "sweep: already running in $sw"
else
  argv=$(jq -nc --arg s "$here/sweep.sh" '$ARGS.positional + ["bash", $s, "--loop"]' --args ${as[@]+"${as[@]}"})
  out=$(herdr-app do tab.new --space "$space" --name sweep --folder "$home" --argv "$argv") || die "Herdr did not start the sweep: $out"
  echo "sweep: started in $(jq -r '.terminal // "?"' <<<"$out" 2>/dev/null) (every 2 minutes)"
fi
echo "team-up: $started started. Space '$label' in Herdr, one tab per team, and the sweep."
