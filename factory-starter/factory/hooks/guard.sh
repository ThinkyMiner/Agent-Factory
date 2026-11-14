#!/usr/bin/env bash
# PreToolUse guard for Claude Code. Reads the hook JSON on stdin.
# Exit 2 blocks the tool call and shows the message to the agent. Any other exit lets the call
# through, so this script exits 2 on every error it hits, including ones it does not expect.
# Requires jq and perl. This is a guardrail against drift and mistakes, not a sandbox: the real
# boundaries are branch protection, the CI ownership check and which credentials are on the machine.
#
# Always: no writes to .env files, to the factory's own controls (.claude/, factory/, .github/,
# teams/, docs/factory/ except its audits/, memory/lessons.md, memory/reflections/), or to Claude Code's own configuration in
# ~/.claude; no force push, no push to main, no --no-verify, no admin merge, no self-approval.
# Paths are compared after resolving .. and symlinks, and without case (macOS volumes ignore it).
# Shell commands are read for the files they write (best effort, see guard-paths.pl).
#
# Team mode (factory/teams.json exists): a session may write only inside its own worktree, and
# there only its team's paths, its own work folders and the append-only locations (by appending).
# Its team is FACTORY_TEAM, which must also match the worktree it runs in (see lib.sh).
#
# To work on the factory itself (agents, skills, rules, CI), start the session with
#   FACTORY_ALLOW_SELF_EDIT=1 claude
set -euo pipefail

block() { echo "factory guard: $1" >&2; exit 2; }
trap 'echo "factory guard: internal error at line $LINENO; blocking to be safe" >&2; exit 2' ERR

command -v jq >/dev/null 2>&1 || block "jq is not installed, so the guard cannot run. Install jq."
command -v perl >/dev/null 2>&1 || block "perl is not installed, so the guard cannot run."
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../scripts/lib.sh
. "$here/../scripts/lib.sh" 2>/dev/null || block "factory/scripts/lib.sh is missing."

input=$(cat)
jq -e 'type == "object"' >/dev/null 2>&1 <<<"$input" || block "the hook payload is not a JSON object."
tool=$(jq -r '.tool_name // empty' <<<"$input")

root_raw="${CLAUDE_PROJECT_DIR:-$PWD}"
resolve() { perl "$here/guard-paths.pl" resolve "$root_raw" "$1"; }
root=$(resolve "$root_raw")
home_dir=$(resolve "${HOME:-/nonexistent}")
self_edit=${FACTORY_ALLOW_SELF_EDIT:-0}
teams=$(teams_file "$root_raw" || true)
team=""
if [ -n "$teams" ]; then
  jq -e '.teams | type == "object"' "$teams" >/dev/null 2>&1 || block "factory/teams.json is unreadable."
  team=$(session_team "$root_raw" || true)
  fhome=$(resolve "$(factory_home "$root_raw")")
  tdir=$(resolve "$(teams_dir "$fhome")")
fi
shopt -s nocasematch

# check_write <path> <appends> [<dir>]: block unless this session may write <path>. <appends> is 1
# when the write only adds (a new file, an edit that keeps the old text in front, a >> redirect).
# <dir> is 1 for a directory made by mkdir: in team mode it may be made wherever the team could
# add a file to it (its own paths, its own work folder, an append-only location).
check_write() {
  local p rel item owner
  p=$(resolve "$1")
  [ "$p" != '!loop' ] || block "$1 is a symlink loop."
  case "$p" in
    "$root") block "$1 is the project root itself." ;;
    "$root"/*) rel=${p#"$root"/} ;;
    *) rel="" ;;
  esac
  if [ -z "$rel" ]; then
    case "$p" in
      "$home_dir"/.claude|"$home_dir"/.claude/*|"$home_dir"/.claude.json*)
        block "$1 is Claude Code's own configuration, which can switch the guard off. Not allowed." ;;
    esac
    if [ -n "$teams" ]; then
      case "$p" in
        "$fhome"|"$fhome"/*|"$tdir"/*) block "$1 is in another checkout of this factory. Write only inside your own worktree ($root)." ;;
        /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) return 0 ;;
      esac
      block "$1 is outside this session's worktree ($root). Write only inside it."
    fi
    return 0
  fi
  case "$rel" in
    .env|.env.*|*/.env|*/.env.*)
      case "$rel" in
        *.env.example) ;;
        *) block "writing $rel is not allowed. Secrets are handled by the human." ;;
      esac ;;
  esac
  case "$rel" in
    .claude|factory|.github|teams|docs|docs/factory|memory|memory/reflections)   # holds controls
      [ "$self_edit" = 1 ] || [ "${3:-0}" = 1 ] && return 0   # (mkdir removes nothing)
      block "$rel holds the factory's own controls; removing, moving or overwriting it is not allowed. Name the file you mean." ;;
    docs/factory/audits/*) ;;                     # written by /audit
    .claude/*|factory/*|.github/*|teams/*|docs/factory/*|memory/lessons.md|memory/reflections/*)
      [ "$self_edit" = 1 ] && return 0
      block "$rel is part of the factory's own controls. Stop and report instead of editing it." ;;
  esac
  [ -n "$teams" ] || return 0
  [ -n "$team" ] || block "this factory runs in team mode and this session has no valid team (FACTORY_TEAM=${FACTORY_TEAM:-unset}, checkout $root). Start sessions with 'factory team-up'."
  [ "${3:-0}" = 1 ] && rel="$rel/"
  team_owns "$teams" "$team" "$rel" && return 0
  case "$rel" in
    work/*/*)
      item=${rel#work/}; item=${item%%/*}
      if [ -f "$root/work/$item/spec.md" ]; then
        [ "$(spec_team "$root/work/$item/spec.md" "$(jq -r '.default_team // empty' "$teams")")" = "$team" ] && return 0
        block "work/$item belongs to another team's item. Write only in your own work folders."
      fi
      [ "$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" = "work/$item" ] && return 0
      block "work/$item is not this session's item: create it on branch work/$item." ;;
  esac
  if is_append_only "$teams" "$rel"; then
    [ "$2" = 1 ] && return 0
    block "$rel is append-only: add a new file, or add to the end without changing what is there."
  fi
  owner=$(path_owner "$teams" "$rel" || true)
  block "$rel is owned by ${owner:-no team}, not $team. A team changes only its own paths: stop and report what you need from ${owner:-the orchestrator} (cross-team requests go through tickets)."
}

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
    [ -n "$path" ] || block "the $tool call has no file path."
    appends=0
    case "$tool" in
      Write) [ -e "$(resolve "$path")" ] || appends=1 ;;
      Edit)
        jq -e '.tool_input as $e | (($e.replace_all // false) | not) and (($e.old_string // "") | length > 0)
               and (($e.new_string // "") | startswith($e.old_string))' >/dev/null 2>&1 <<<"$input" && appends=1 ;;
      MultiEdit)
        jq -e '[.tool_input.edits[]? | . as $e | (($e.replace_all // false) | not) and (($e.old_string // "") | length > 0)
               and (($e.new_string // "") | startswith($e.old_string))] | length > 0 and all' >/dev/null 2>&1 <<<"$input" && appends=1 ;;
    esac
    check_write "$path" "$appends"
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // empty' <<<"$input")

    re='(^|[^A-Za-z0-9_])(FACTORY_TEAM|FACTORY_ALLOW_SELF_EDIT)[[:space:]]*\+?='
    re2='(export|unset|declare|typeset|readonly|local)[[:space:]][^;&|]*(FACTORY_TEAM|FACTORY_ALLOW_SELF_EDIT)'
    re3='(^|[[:space:];&|])env[[:space:]]+(-[a-zA-Z]*[iu]|--unset|--ignore-environment)'
    if [[ "$cmd" =~ $re ]] || [[ "$cmd" =~ $re2 ]] || [[ "$cmd" =~ $re3 ]]; then
      block "a session's team and self-edit switch are set when it starts, never by a command."
    fi

    push_re='git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--[a-z-]+(=[^[:space:]]+)?|-[a-zA-Z]+))*[[:space:]]+push([[:space:]]|$)'
    force_re='(^|[[:space:]])(--force|--force-with-lease|--force-if-includes|--mirror)([[:space:]=]|$)|(^|[[:space:]])-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|(^|[[:space:]])\+[^[:space:]]'
    main_re='(^|[[:space:]:+/])(refs/heads/)?(main|master)([[:space:]]|$)'
    while IFS= read -r seg; do
      [[ "$seg" =~ $push_re ]] || continue
      args=${seg#*"${BASH_REMATCH[0]}"}
      [[ " $args" =~ $force_re ]] && block "force push is not allowed. Merge main into the branch instead of rewriting it."
      [[ " $args" =~ $main_re ]] && block "pushing to the default branch is not allowed. Open a pull request."
    done < <(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')

    if grep -Eq -- '--no-verify' <<<"$cmd"; then
      block "--no-verify is not allowed. Fix what the check reports."
    fi
    if grep -Eq 'gh +pr +merge[^;&|]*--admin' <<<"$cmd"; then
      block "admin merge is not allowed."
    fi
    if grep -Eq 'gh +pr +review[^;&|]*--approve' <<<"$cmd"; then
      block "the factory does not approve its own pull requests."
    fi
    if grep -Eq 'human-approved' <<<"$cmd"; then
      block "the 'human-approved' label is applied by the human only."
    fi

    if [ -n "$teams" ]; then
      wt_re='git([[:space:]]+-[^[:space:]]+)*[[:space:]]+worktree'
      if [[ "$cmd" =~ $wt_re ]]; then
        block "worktrees are made by 'factory team-up', not by a session."
      fi
      # Herdr: the herdr CLI, the app (herdr-app, Herdr.app), its core (hc, herdr-core) and the
      # core's socket, which every terminal Herdr starts has in $HC_TERMINAL_SOCKET.
      hr_re='(^|[^A-Za-z0-9_-])([Hh]erdr(-app|-core)?|HC_TERMINAL_[A-Z]+|team-up)([^A-Za-z0-9_-]|$)|(^|[^A-Za-z0-9_.-])hc([[:space:];|&)]|$)'
      if [[ "$cmd" =~ $hr_re ]]; then
        block "sessions do not drive Herdr or launch sessions: that would let one session type into another. Teams talk through files and tickets."
      fi
      hname="$(basename "$(factory_home "$root_raw")").teams/"
      for t in $(team_names "$teams"); do
        [ "$t" = "$team" ] && continue
        case "$cmd" in *"$hname$t"*) block "that command reaches into the $t team's worktree." ;; esac
      done
    fi

    while IFS= read -r target; do
      app=0 dir=0
      case "$target" in +*) app=1; target=${target#+} ;; @*) app=1 dir=1; target=${target#@} ;; esac
      if [ -n "$teams" ] && [[ "$target" == *'$'* ]]; then
        block "the guard cannot tell where $target points. Write it with a literal path (only \$HOME, \$TMPDIR and \$CLAUDE_PROJECT_DIR are expanded)."
      fi
      [ -e "$(resolve "$target")" ] || app=1     # a new file only adds, as with the Write tool
      check_write "$target" "$app" "$dir"
    done < <(perl "$here/guard-paths.pl" targets "$cmd")
    ;;
esac
exit 0
