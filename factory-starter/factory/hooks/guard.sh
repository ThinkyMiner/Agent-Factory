#!/usr/bin/env bash
# PreToolUse guard for Claude Code. Reads the hook JSON on stdin.
# Exit 2 blocks the tool call and shows the message to the agent. Any other exit lets the call
# through, so this script exits 2 on every error it hits, including ones it does not expect.
# Requires jq and perl. This is a guardrail against drift and mistakes, not a sandbox: the real
# boundaries are branch protection, the CI ownership check and which credentials are on the machine.
#
# Always: no writes to .env files, to the factory's own controls (.claude/, factory/, .github/,
# teams/, docs/factory/ except its audits/, memory/lessons.md, memory/reflections/), or to Claude Code's own configuration in
# ~/.claude; no force push, no push to main, no --no-verify, no admin merge, no self-approval, no
# approval labels; no Read, Grep or Glob of sealed planning positions; the planning record's
# transcript, state, positions and attachments only through the planning scripts.
# Paths are compared after resolving .. and symlinks, and without case (macOS volumes ignore it).
# Shell commands are read for the files they write (best effort, see guard-paths.pl).
#
# Team mode (factory/teams.json exists): a session may write only inside its own worktree, and
# there only its team's paths, its own work folders and the append-only locations (by appending);
# contracts/ only while a grant in <factory home>/.factory/grants/ names its team (ticket.sh).
# Integration records: features/*/e2e-report.md, FEATURE.md and tickets.jsonl only through the
# scripts; tests/e2e/ and features/*/attribution.md only by the orchestrator's session (integration-qa),
# even if the roster gives another team a covering glob, and there only if the roster gives them to it.
# Only the orchestrator's session pushes an integrate/<feature> branch or opens a pull request into one.
# Its team is FACTORY_TEAM, which must also match the worktree it runs in (see lib.sh).
# It works on GitHub as the factory's bot: no credential commands, issues and labels only through
# ticket.sh and item.sh, gh api read-only.
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
# The subagent making the call, compared without case, whitespace, control characters or a plugin
# prefix (plugin:name), so a variant of a limited agent's name is still limited.
agent=$(jq -r '.agent_type | if type == "string" then ascii_downcase | gsub("[\\s\\p{Cc}\\p{Cf}]"; "") | sub("^.*:"; "")
               elif . == null then "" else "not a string" end' <<<"$input")
[ "$agent" != "not a string" ] || block "the hook payload's agent_type is not a string."

# The ui-reviewer's one shell command is the browser tooling, `make ui-shots URL=<url> OUT=<dir>`,
# with plain values: no shell syntax, quotes, globs, spaces, newlines or `..`. In and out of team
# mode. An allowed command still meets every check below.
if [ "$tool" = Bash ] && [ "$agent" = ui-reviewer ]; then
  jq -e '.tool_input.command | ((contains("\n") or contains("..")) | not)
         and test("^make ui-shots URL=[A-Za-z0-9._/:%+@,-]+ OUT=[A-Za-z0-9._/:%+@,-]+$")' >/dev/null 2>&1 <<<"$input" ||
    block "the ui-reviewer only runs make ui-shots, exactly: make ui-shots URL=<url> OUT=<work folder>/screens (values made of letters, digits and . _ / : % + @ , -)."
fi

root_raw="${CLAUDE_PROJECT_DIR:-$PWD}"
resolve() { perl "$here/guard-paths.pl" resolve "$root_raw" "$1"; }
root=$(resolve "$root_raw")
home_dir=$(resolve "${HOME:-/nonexistent}")

# The research agents read the open web and user-submitted text. In and out of team mode they
# read only this checkout's evidence folders, the researcher writes only research/, the
# evidence-reviewer writes nothing, and neither runs a shell command. A relative path counts from
# the payload's cwd, as the tools count it. An allowed call still meets every check below.
if [ "$agent" = researcher ] || [ "$agent" = evidence-reviewer ]; then
  shopt -s nocasematch
  dirs="research product planning features contracts" key=file_path
  why="research agents read only evidence folders: research/, product/, planning/, features/ and contracts/ of $root. Name a path inside one (a Grep or Glob too), with a glob that is not absolute and has no '..'."
  case "$tool" in
    Bash) block "research agents run no shell commands." ;;
    Edit|Write|MultiEdit|NotebookEdit)
      [ "$agent" = researcher ] || block "the evidence-reviewer writes nothing: the lead saves its reply."
      dirs=research why="the researcher writes only in research/ of $root." ;;
    Grep|Glob) key=path
      if jq -e --arg t "$tool" '(if $t == "Glob" then .tool_input.pattern else .tool_input.glob end) | strings
                                | test("(^|[\\s{,])[/~]") or contains("..")' >/dev/null 2>&1 <<<"$input"; then block "$why"; fi ;;
    Read) ;;
    *) dirs="" ;;
  esac
  if [ -n "$dirs" ]; then
    jq -e --arg k "$key" '.tool_input[$k] | strings | length > 0' >/dev/null 2>&1 <<<"$input" || block "$why"
    base=$(jq -r '.cwd | strings' <<<"$input")
    while IFS= read -r -d '' p; do
      rp=$(perl "$here/guard-paths.pl" resolve "${base:-$root_raw}" "$p") ok=0
      for d in $dirs; do case "$rp" in "$root/$d"|"$root/$d"/*) ok=1 ;; esac; done
      [ "$ok" = 1 ] || block "$p: $why"
    done < <(jq -j '.tool_input | (.file_path, .path, .notebook_path) | strings | . + "\u0000"' <<<"$input")
  fi
fi

# Sealed planning positions (.factory/planning/<cycle>/sealed/) are published by round.sh when the
# positions round closes. Until then no session reads them, its own team's included.
case "$tool" in
  Read|Grep|Glob)
    sealed_why="sealed planning positions are read by round.sh when the round closes, never by a session."
    p=$(jq -r '.tool_input.file_path // .tool_input.path // empty' <<<"$input")
    if [ -n "$p" ]; then
      rp=$(resolve "$p")
      [ "$rp" != '!loop' ] || block "$p is a symlink loop."
      shopt -s nocasematch
      case "$tool:$rp" in
        Read:*/.factory/planning/*/sealed|Read:*/.factory/planning/*/sealed/*) block "$sealed_why" ;;
        Read:*) ;;
        *:*/.factory|*:*/.factory/planning|*:*/.factory/planning/*) block "$sealed_why" ;;
      esac
    fi
    q=$(jq -r '[.tool_input.pattern, .tool_input.glob] | map(strings) | join(" ")' <<<"$input")
    if [ "$tool" != Read ] && [[ "$q" =~ (\.factory|sealed) ]]; then block "$sealed_why"; fi
    exit 0 ;;
esac
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
  case "$rel" in
    planning/*/discussion.jsonl|planning/*/state.json|planning/*/dispatch.jsonl|planning/*/contracts.jsonl|planning/*/positions/*|planning/*/attachments/*)
      block "$rel is written only by the planning scripts (say.sh, position.sh, round.sh, dispatch.sh, contracts.sh)." ;;
  esac
  [ -n "$teams" ] || return 0
  [ -n "$team" ] || block "this factory runs in team mode and this session has no valid team (FACTORY_TEAM=${FACTORY_TEAM:-unset}, checkout $root). Start sessions with 'factory team-up'."
  [ "${3:-0}" = 1 ] && rel="$rel/"
  case "$rel" in   # the human's, even inside research/: which feedback the research team reads
    research/feedback/SOURCES.md) block "$rel lists the feedback sources the research team reads; only the human changes it. Stop and report the source you would add." ;;
  esac
  case "$rel" in   # owned by no team: only under a grant from an accepted contract-change ticket
    contracts/*) has_contract_grant "$fhome" "$team" && return 0
      block "$rel is owned by no team: a contract changes only under a contract-change ticket your team accepted (ticket.sh accept). Stop and report, so the team that needs the change asks for one (ticket.sh create --type contract-change)." ;;
  esac
  case "$rel" in   # integration records, even if a roster glob covers them
    features/*/e2e-report.md|features/*/FEATURE.md|features/*/tickets.jsonl)
      block "$rel is written only by the integration scripts (integrate.sh writes the e2e report, feature.sh render the rest)." ;;
    tests/e2e|tests/e2e/*|features/*/attribution.md)
      [ "$team" = orchestrator ] || block "$rel is an integration record: integration-qa writes it in the orchestrator's checkout, so nobody tests their own work. Stop and report; a test you think is wrong is disputed on its bug ticket (ticket.sh decline with evidence)." ;;
  esac
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
    # Team mode: integrate/<f> is unprotected (integrate.sh merges main into it), so only the
    # orchestrator's session pushes it or opens pull requests into it.
    integ_re='(^|[[:space:]:+/])(refs/heads/)?integrate/'
    integ_why="integrate/<feature> is the orchestrator's integration branch: only integrate.sh pushes to it. Push your work branch and open its pull request into feature/<feature>."
    while IFS= read -r seg; do
      [[ "$seg" =~ $push_re ]] || continue
      args=${seg#*"${BASH_REMATCH[0]}"}
      [[ " $args" =~ $force_re ]] && block "force push is not allowed. Merge main into the branch instead of rewriting it."
      [[ " $args" =~ $main_re ]] && block "pushing to the default branch is not allowed. Open a pull request."
      if [ -n "$teams" ] && [ "$team" != orchestrator ]; then
        if [[ " $args" =~ $integ_re ]] || [[ "$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" == integrate/* ]]; then block "$integ_why"; fi
      fi
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
    if grep -Eq 'human-approved|brief-approved' <<<"$cmd"; then
      block "the 'human-approved' and 'brief-approved' labels are applied by the human only."
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
      # GitHub: a session acts as the factory's bot (team-up starts it with the bot's token) and
      # never reaches for another identity: yours is on the same machine. Issues and labels change
      # only through ticket.sh and item.sh, and gh api only reads.
      cred_re='(^|[^A-Za-z0-9_])(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GH_HOST|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_[A-Z0-9_]*)([^A-Za-z0-9_]|$)'
      if [[ "$cmd" =~ $cred_re ]] || [[ "$cmd" =~ \.config/gh([^A-Za-z0-9_.-]|$) ]] || [[ "$cmd" =~ (^|[^A-Za-z0-9_])\.ssh(/|[^A-Za-z0-9_.-]|$) ]]; then
        block "a session works as the GitHub identity it was started with (the factory's bot). It does not set, unset or read GitHub credentials."
      fi
      while IFS=$'\x1f' read -r -a w; do
        case "${w[0]:-}" in
          security|git-credential*) block "sessions do not read the keychain or git's credentials." ;;
          git)
            for ((k = 1; k < ${#w[@]}; k++)); do
              case "${w[k]}" in
                -c|--config-env) [[ "${w[k+1]:-}" == credential* ]] && block "sessions do not change git's credentials."; k=$((k + 1)) ;;
                --config-env=credential*) block "sessions do not change git's credentials." ;;
                -C) k=$((k + 1)) ;;
                -*) ;;
                credential*) block "sessions do not read git's credentials." ;;
                *) break ;;
              esac
            done ;;
          gh)
            if [ "$team" != orchestrator ] && [ "${w[1]:-}" = pr ]; then
              prev=""
              for a in "${w[@]:2}"; do
                if [[ "$prev" =~ ^(-B|--base)$ && "$a" == integrate/* ]] || [[ "$a" == --base=integrate/* ]]; then block "$integ_why"; fi
                prev=$a
              done
            fi
            gh_why="issues and labels change only through factory/scripts/ticket.sh (requests to other teams) and item.sh (your team's work items)."
            # Factory feedback goes to the kit's repository (CLAUDE.md, "Rules for every agent").
            kit=0; prev=""
            for a in "${w[@]:3}"; do
              [[ "$prev" =~ ^(-R|--repo)$ && "$a" == [Tt]hinky[Mm]iner/[Aa]gent-[Ff]actory ]] && kit=1
              [[ "$a" == --repo=[Tt]hinky[Mm]iner/[Aa]gent-[Ff]actory ]] && kit=1
              prev=$a
            done
            [[ "$kit" = 1 && "${w[1]:-}" = issue && "${w[2]:-}" =~ ^(create|comment|list|view)$ ]] && continue
            case "${w[1]:-}:${w[2]:-}" in
              auth:*|alias:*|extension:*) block "sessions do not change gh's login, aliases or extensions." ;;
              issue:create|issue:edit|issue:close|issue:reopen|issue:delete|issue:comment|issue:transfer|issue:pin|issue:unpin|issue:lock|issue:unlock|issue:develop) block "$gh_why" ;;
              label:|label:list) ;;
              label:*) block "$gh_why" ;;
              pr:edit) for a in "${w[@]:3}"; do case "$a" in --add-label*|--remove-label*) block "$gh_why" ;; esac; done ;;
              api:*) for a in "${w[@]:2}"; do case "$a" in -X*|--method*|-f*|-F*|--field*|--raw-field*|--input*)
                       block "gh api only reads in a session. $gh_why" ;; esac; done ;;
            esac ;;
        esac
      done < <(perl "$here/guard-paths.pl" commands "$cmd")
      if [[ "$cmd" =~ \.factory/+planning ]] || { [[ "$cmd" == *.factory* ]] && [[ "$cmd" == *sealed* ]]; }; then
        block "planning state is changed only by the planning scripts (round.sh, position.sh, say.sh), and sealed positions are read by none of them until the round closes."
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
