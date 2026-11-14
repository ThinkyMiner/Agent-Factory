#!/usr/bin/env bash
# Records Claude Code lifecycle events (sessions, subagents, notifications) in
# .factory/events.jsonl in the main checkout (shared by every worktree), under the
# event lock, so the control room can show what is running.
# Registered for SessionStart, SessionEnd, SubagentStart, SubagentStop, Stop and
# Notification in .claude/settings.json. Reads the hook JSON on stdin.
# Always exits 0: this hook observes and never blocks.
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0
. "$(dirname "$0")/../scripts/lib.sh" 2>/dev/null || exit 0

input=$(cat)
[ -n "$input" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
work_id=""
case "$branch" in work/*) n="${branch#work/}"; work_id="${n%%-*}" ;; esac

line=$(jq -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg branch "$branch" --arg work_id "$work_id" '
  {
    ts: $ts,
    type: "lifecycle",
    work_id: $work_id,
    branch: $branch,
    event: (.hook_event_name // "unknown"),
    session_id: (.session_id // null),
    agent_type: (.agent_type // null),
    agent_id: (.agent_id // null),
    transcript_path: (.agent_transcript_path // .transcript_path // null),
    reason: (.reason // .source // .notification_type // null),
    message: ((.message // null) | if type == "string" then .[0:300] else null end)
  } | with_entries(select(.value != null))' <<<"$input" 2>/dev/null) || exit 0
[ -n "$line" ] || exit 0

append_event "$(factory_home "$root")" "$line"
exit 0
