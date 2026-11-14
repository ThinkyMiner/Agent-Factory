#!/usr/bin/env bash
# Append one structured event to the factory's event log.
#   emit-event.sh <type> key=value [key=value ...]
#   emit-event.sh stage stage=build status=started round=0
# Writes to .factory/events.jsonl (local, live, not committed) and, when the
# current branch is work/<id>-<slug> and its folder exists, also to
# work/<id>-<slug>/events.jsonl (committed with the item: the durable record).
# work_id and branch are filled in from the branch name unless passed.
# Never fails the caller: telemetry must not break a run.
set -uo pipefail

type="${1:-}"
[ -n "$type" ] || { echo "usage: emit-event.sh <type> key=value ..." >&2; exit 0; }
shift
command -v jq >/dev/null 2>&1 || exit 0

root=$(git rev-parse --show-toplevel 2>/dev/null) || root="$PWD"
branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
work_id=""
work_dir=""
case "$branch" in
  work/*)
    name="${branch#work/}"
    work_id="${name%%-*}"
    [ -d "$root/work/$name" ] && work_dir="$root/work/$name"
    ;;
esac

args=(--arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg type "$type" --arg branch "$branch" --arg work_id "$work_id")
filter='{ts: $ts, type: $type, work_id: $work_id, branch: $branch}'
i=0
for kv in "$@"; do
  case "$kv" in
    *=*)
      k="${kv%%=*}"; v="${kv#*=}"
      case "$k" in ''|*[!A-Za-z0-9_]*) continue ;; esac
      args+=(--arg "k$i" "$k" --arg "v$i" "$v")
      filter="$filter + {(\$k$i): \$v$i}"
      i=$((i+1))
      ;;
  esac
done

line=$(jq -cn "${args[@]}" "$filter" 2>/dev/null) || exit 0
mkdir -p "$root/.factory" 2>/dev/null
echo "$line" >> "$root/.factory/events.jsonl" 2>/dev/null
[ -n "$work_dir" ] && echo "$line" >> "$work_dir/events.jsonl" 2>/dev/null
exit 0
