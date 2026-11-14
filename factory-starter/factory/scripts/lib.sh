# Shared helpers for factory scripts and hooks. Source it; it only defines functions.
# bash 3.2 compatible (macOS).

# factory_home [dir]: the main checkout that every worktree of this repo shares. Live state
# (.factory/) goes there, so sessions in different worktrees write one event log, not one each.
# A dir below the top level maps to the same dir in the main checkout (a kit kept in a subfolder).
# Outside a git repo, or in a submodule, falls back to the worktree top level or the dir itself.
factory_home() {
  local from=${1:-$PWD} common prefix
  common=$(git -C "$from" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "$from"; return; }
  prefix=$(git -C "$from" rev-parse --show-prefix 2>/dev/null)
  case "$common" in
    */.git) prefix=${prefix%/}; echo "${common%/.git}${prefix:+/$prefix}" ;;
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

# ---- team mode ----
# A factory is in team mode when factory/teams.json exists in the checkout. Without it every
# team check below is a no-op and the factory behaves as a single team.

# teams_file <root>: path of the roster in that checkout, or nothing.
teams_file() { [ -f "$1/factory/teams.json" ] && echo "$1/factory/teams.json"; }

# valid_team_name <name>: a lowercase name, safe as a branch, folder and Herdr tab name.
valid_team_name() { printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9_-]{0,31}$'; }

# team_names <teams.json>: the active teams, one per line. A key that is not a valid team name
# (a newline, a space, ../) is never a team.
team_names() { jq -r '.teams | to_entries[] | select(.value.active != false) | .key | select(test("^[a-z][a-z0-9_-]{0,31}$"))' "$1" 2>/dev/null; }

# teams_dir <home>: where the leads' worktrees live: next to the main checkout, never inside it.
teams_dir() { echo "$(dirname "$1")/$(basename "$1").teams"; }

# team_at <root>: the team a checkout belongs to by where it is. The main checkout is the
# orchestrator's; <home>/../<name>.teams/<team> is that team's worktree; anything else is nobody's.
team_at() {
  local root home dir
  root=$(cd "$1" 2>/dev/null && pwd -P) || return 0
  home=$(cd "$(factory_home "$root")" 2>/dev/null && pwd -P) || return 0
  dir=$(teams_dir "$home")
  if [ "$root" = "$home" ]; then echo orchestrator; return 0; fi
  case "$root" in
    "$dir"/*) case "${root#"$dir"/}" in */*) ;; *) echo "${root#"$dir"/}" ;; esac ;;
  esac
}

# session_team <root>: prints FACTORY_TEAM when it names an active team and matches the checkout
# the session runs in; returns 1 (printing nothing) otherwise. Identity needs both: the variable
# set at launch, and the worktree, so neither alone is enough to speak as another team.
session_team() {
  local t=${FACTORY_TEAM:-} f
  f=$(teams_file "$1") || return 1
  [ -n "$t" ] && valid_team_name "$t" || return 1
  team_names "$f" | grep -qxF -- "$t" || return 1
  [ "$(team_at "$1")" = "$t" ] || return 1
  echo "$t"
}

# team_owns <teams.json> <team> <relpath>: does the team own the path? Globs as in risk-rules.txt
# (* also matches /), compared without case, since macOS volumes ignore it.
team_owns() {
  local pat rc=1
  shopt -s nocasematch
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    # $pat is deliberately unquoted so it is treated as a glob.
    if [[ "$3" == $pat ]]; then rc=0; break; fi
  done < <(jq -r --arg t "$2" '.teams[$t].owns[]?' "$1" 2>/dev/null)
  shopt -u nocasematch
  return $rc
}

# path_owner <teams.json> <relpath>: the first active team owning the path, or nothing.
path_owner() {
  local t
  for t in $(team_names "$1"); do team_owns "$1" "$t" "$2" && { echo "$t"; return 0; }; done
}

# is_append_only <teams.json> <relpath>
is_append_only() {
  local pat rc=1
  shopt -s nocasematch
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    if [[ "$2" == $pat ]]; then rc=0; break; fi
  done < <(jq -r '.append_only[]?' "$1" 2>/dev/null)
  shopt -u nocasematch
  return $rc
}

# spec_team <spec.md> [default]: the team: field of a spec's frontmatter, or the default.
spec_team() {
  local t
  t=$(awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} /^team:/ {sub(/^team:[ \t]*/, ""); sub(/[ \t]+$/, ""); print; exit}' < "$1" 2>/dev/null)
  echo "${t:-${2:-}}"
}
