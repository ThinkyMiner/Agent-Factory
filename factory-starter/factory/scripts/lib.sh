# Shared helpers for factory scripts and hooks. Source it; it only defines functions.
# bash 3.2 compatible (macOS).

# factory_home [dir]: the main checkout that every worktree of this repo shares. Live state
# (.factory/) goes there, so sessions in different worktrees write one event log, not one each.
# Outside a git repo, or in a submodule, falls back to the worktree top level or the dir itself.
factory_home() {
  local from=${1:-$PWD} common
  common=$(git -C "$from" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "$from"; return; }
  case "$common" in
    */.git) echo "${common%/.git}" ;;
    *) git -C "$from" rev-parse --show-toplevel 2>/dev/null || echo "$from" ;;
  esac
}

# with_lock <lockfile> <cmd> [args...]: run cmd holding an exclusive flock on lockfile.
# The kernel releases the lock when its holder exits, crash included, so a dead writer never
# leaves a stale lock. A holder that hangs is waited for at most FACTORY_LOCK_TIMEOUT seconds
# (default 5); then with_lock returns 75 without running cmd. perl is used because macOS has no
# flock command; it ships with macOS and the Ubuntu runners. stdin passes through to cmd.
with_lock() {
  local lock=$1; shift
  perl -e '
    use strict; use Fcntl qw(:flock); use Time::HiRes qw(time sleep);
    my ($lock, $timeout) = (shift @ARGV, shift @ARGV);
    $^F = 255;                                   # keep the lock fd open across exec
    open(my $fh, ">>", $lock) or exit 74;
    my $deadline = time + $timeout;
    until (flock($fh, LOCK_EX | LOCK_NB)) { exit 75 if time >= $deadline; sleep 0.02; }
    exec { $ARGV[0] } @ARGV or exit 127;
  ' "$lock" "${FACTORY_LOCK_TIMEOUT:-5}" "$@"
}

# append_jsonl <lockfile> <file> <line>: append one line to file while holding lockfile. Never
# loses the line: when the lock is not free within the timeout it appends unlocked (a short line
# is one O_APPEND write) and returns 75 so the caller can record that. Without perl: unlocked.
append_jsonl() {
  local lock=$1 file=$2 line=$3 rc=0
  command -v perl >/dev/null 2>&1 || { printf '%s\n' "$line" >> "$file"; return; }
  printf '%s\n' "$line" | with_lock "$lock" sh -c 'cat >> "$1"' sh "$file" || rc=$?
  [ "$rc" = 75 ] && printf '%s\n' "$line" >> "$file"
  return "$rc"
}

# append_event <home> <line> [per-item-file]: append an event to <home>/.factory/events.jsonl and,
# if given, to the item's own events.jsonl, under the one event lock. A timed-out lock leaves a
# lock_timeout event behind so it shows up in the record. Always returns 0: telemetry must not
# break a run.
append_event() {
  local dir="$1/.factory" line=$2 also=${3:-} rc=0
  mkdir -p "$dir" 2>/dev/null || return 0
  append_jsonl "$dir/events.lock" "$dir/events.jsonl" "$line" 2>/dev/null || rc=$?
  if [ -n "$also" ]; then append_jsonl "$dir/events.lock" "$also" "$line" 2>/dev/null || rc=$?; fi
  if [ "$rc" = 75 ]; then
    printf '{"ts":"%s","type":"lock_timeout","lock":".factory/events.lock","pid":%d}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" >> "$dir/events.jsonl" 2>/dev/null
  fi
  return 0
}
