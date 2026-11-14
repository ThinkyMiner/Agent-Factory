#!/usr/bin/env bash
# PreToolUse guard for Claude Code. Reads the hook JSON on stdin.
# Exit 2 blocks the tool call and shows the message to the agent.
# Requires jq. This is a guardrail against drift and mistakes, not a sandbox:
# the real boundaries are branch protection and which credentials exist on the machine.
#
# To work on the factory itself (agents, skills, rules, CI), start the session with
#   FACTORY_ALLOW_SELF_EDIT=1 claude
set -euo pipefail

block() { echo "factory guard: $1" >&2; exit 2; }

# Fail closed: a guard that cannot parse its input must not wave the call through.
command -v jq >/dev/null 2>&1 || block "jq is not installed, so the guard cannot run. Install jq."

input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")
root="${CLAUDE_PROJECT_DIR:-$PWD}"

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
    rel="${path#"$root"/}"
    case "$rel" in
      .env|.env.*|*/.env|*/.env.*)
        case "$rel" in
          *.env.example) ;;
          *) block "writing $rel is not allowed. Secrets are handled by the human." ;;
        esac ;;
    esac
    if [ "${FACTORY_ALLOW_SELF_EDIT:-0}" != "1" ]; then
      case "$rel" in
        .claude/*|factory/*|.github/*|memory/lessons.md|memory/reflections/*)
          block "$rel is part of the factory's own controls. Stop and report instead of editing it." ;;
      esac
    fi
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
    if grep -Eq 'git +push[^;&|]*( --force| -f( |$)|--force-with-lease)' <<<"$cmd"; then
      block "force push is not allowed. Merge main into the branch instead of rewriting it."
    fi
    if grep -Eq 'git +push[^;&|]*[ :](main|master)( |$|[;&|])' <<<"$cmd"; then
      block "pushing to the default branch is not allowed. Open a pull request."
    fi
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
    ;;
esac
exit 0
