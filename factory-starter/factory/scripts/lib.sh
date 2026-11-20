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

# team_owns_under <teams.json> <team> <dir/>: the team owns a file that could sit in <dir>: some
# owned glob matches <dir> plus that glob's last part (features/f002/ + acceptance.md). For mkdir.
team_owns_under() {
  local pat
  while IFS= read -r pat; do
    [ -n "$pat" ] && team_owns "$1" "$2" "$3${pat##*/}" && return 0
  done < <(jq -r --arg t "$2" '.teams[$t].owns[]?' "$1" 2>/dev/null)
  return 1
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

# ---- GitHub text ----

# clean_text <text>: safe to post on GitHub. An @name cannot notify anyone (a zero-width space
# follows the @), HTML is escaped so it cannot render or hide text, control characters go.
clean_text() { printf '%s' "$1" | perl -pe 's/&/&amp;/g; s/</&lt;/g; s/>/&gt;/g; s/\@(?=[A-Za-z0-9])/\@\xE2\x80\x8B/g; s/[\x00-\x08\x0B-\x1F\x7F]//g'; }

# ensure_labels <label>...: create the labels that do not exist yet, since gh cannot apply a
# missing one. Returns 1 if the labels cannot be listed.
ensure_labels() {
  local have l
  have=$(gh label list --limit 1000 --json name --jq '.[].name') || return 1
  for l in "$@"; do grep -qxF -- "$l" <<<"$have" || gh label create "$l" >/dev/null 2>&1 || true; done
}

# ---- planning (team mode) ----
# A cycle's record lives in the main checkout, on branch planning/<cycle>, in planning/<cycle>/:
# BRIEF.md, state.json (round.sh only), discussion.jsonl (say.sh and round.sh only), positions/,
# attachments/, DECISIONS.md, dispatch.jsonl. Version 1 runs one cycle at a time; the one in
# progress is named in .factory/planning/active. Sealed positions wait in
# .factory/planning/<cycle>/sealed/ until round.sh publishes them all at once.

# active_cycle <home>: the cycle in progress, or nothing (returns 1).
active_cycle() {
  local c; c=$(head -1 "$1/.factory/planning/active" 2>/dev/null) || return 1
  printf '%s' "$c" | grep -Eq '^c[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$' || return 1
  echo "$c"
}

# planning_limit <teams.json> <key> <default>: a non-negative integer from .limits.
planning_limit() {
  local v; v=$(jq -r --arg k "$2" '.limits[$k] // empty' "$1" 2>/dev/null)
  [[ "$v" =~ ^[0-9]{1,6}$ ]] && echo "$v" || echo "$3"
}

# transcript_append <file> <lock> <id-prefix> <json-object>: append one transcript line, stamped
# with the next id (<prefix>-mNNN) and the time in front of the caller's fields, under an
# exclusive lock. Prints the id. Exit 75 when the lock is not free within FACTORY_LOCK_TIMEOUT:
# the transcript is never written unlocked, so the caller fails loudly and can retry.
transcript_append() {
  perl -e '
    use strict; use Fcntl qw(:flock); use Time::HiRes qw(time sleep); use POSIX qw(strftime);
    my ($file, $lock, $prefix, $json, $timeout) = @ARGV;
    $json =~ /^\{"/ or exit 65;
    open(my $lk, ">>", $lock) or exit 74;
    my $deadline = time + $timeout;
    until (flock($lk, LOCK_EX | LOCK_NB)) { exit 75 if time >= $deadline; sleep 0.02 }
    my $n = 0; if (open(my $in, "<", $file)) { $n++ while <$in>; close $in }
    my $id = sprintf("%s-m%03d", $prefix, $n + 1);
    my $ts = strftime("%Y-%m-%dT%H:%M:%SZ", gmtime);
    open(my $out, ">>", $file) or exit 74;
    print $out "{\"id\":\"$id\",\"ts\":\"$ts\"," . substr($json, 1) . "\n";
    close $out or exit 74;
    print $id;
  ' "$1" "$2" "$3" "$4" "${FACTORY_LOCK_TIMEOUT:-5}"
}

# ring_team <home> <team> <text>: the doorbell. Types a fixed line into the team's tab in this
# factory's Herdr space, only if that session is waiting for input. Never carries content: the
# line says where to look. Returns 1 when it could not ring (no Herdr, no such tab, or the session
# is busy). With Herdr running, a ring that could not go is kept (ring_later) and the sweep rings
# that team once its tab waits for input.
ring_team() {
  local term
  command -v herdr-app >/dev/null 2>&1 && command -v hc >/dev/null 2>&1 || return 1
  term=$(herdr-app ls 2>/dev/null | jq -r --arg l "$(basename "$1")" --arg t "$2" \
    '[.spaces[]? | select(.name == $l)][0].tabs[]? | select(.name == $t) | .terminals[0].terminal // empty' 2>/dev/null | head -1)
  if [ -n "$term" ] && hc_ring "$term" "$3"; then return 0; fi
  ring_later "$1" "$2"; return 1
}

# ring_later <home> <team>: note that <team> is owed a doorbell, as an empty file
# .factory/rings/<team>. Only that one is owed is kept, never the words: the sweep rings with
# later_line, its own fixed sentence, so nothing written there can reach another session.
ring_later() { valid_team_name "$2" && mkdir -p "$1/.factory/rings" 2>/dev/null && : > "$1/.factory/rings/$2"; }
later_line() {
  if [ "$1" = orchestrator ]; then echo "Planning: a round can close. Run /plan."
  else echo "Something is waiting for you: run /inbox."; fi
}

# hc_ring <terminal> <text>: type text into a terminal that is waiting for input. hc calls such a
# session idle before its first turn and done after one, and `hc send --if` knows only idle, so
# `--if idle` never rang a session that had already worked. A plain send still refuses a blocked
# terminal (one showing a dialog), so a ring never answers a dialog: never add --force here.
# ponytail: checked, then sent; a session that starts a turn in between gets the line queued.
hc_ring() { hc_waiting "$1" && hc send "$1" "$2" >/dev/null 2>&1; }
# hc_agent <terminal>: the program hc sees in front in that terminal (claude-code, zsh, ...), or nothing.
hc_agent() { hc ls --json 2>/dev/null | jq -r --arg t "$1" 'first(.terminals[]? | select(.address == $t) | .agent // empty) // empty' 2>/dev/null; }
hc_waiting() {
  local st
  st=$(hc ls --json 2>/dev/null | jq -r --arg t "$1" 'first(.terminals[]? | select(.address == $t) | .status) // empty' 2>/dev/null)
  case "$st" in idle|done) return 0 ;; *) return 1 ;; esac
}

# hc_type <terminal> <command>: type a slash command into a terminal waiting for input, key by key,
# then enter. hc send marks its text as a note from another program, and a skill only a person may
# start runs only when typed, so this is how a script starts one (autostart.sh). Only a slash
# command of a-z, 0-9, space and - is typed: anything else exits 2. ctrl+u first clears whatever was
# left in the input box, or "ae/work 7" would go to the model as a message and the skill never start.
hc_type() {
  local i k keys=()
  [[ "$2" =~ ^/[a-z][a-z0-9\ -]{0,79}$ ]] || return 2
  hc_waiting "$1" || return 1
  for ((i = 0; i < ${#2}; i++)); do k=${2:i:1}; [ "$k" = " " ] && k=space; keys+=("$k"); done
  hc keys "$1" ctrl+u "${keys[@]}" enter >/dev/null 2>&1
}

# ---- contracts ----
# contracts/ is owned by no team. Its first author is a planning cycle (contracts.sh promote);
# after that it changes only under a type:contract-change ticket the receiving team accepted,
# which leaves a grant in <home>/.factory/grants/contract-<n>.json (ticket.sh) until it is done.

# valid_contract_path <path>: a clean relative path of a file under contracts/. Each part starts
# with a letter or digit and holds only letters, digits, . _ -; no .., at most 200 characters.
valid_contract_path() {
  [ "${#1}" -le 200 ] && [[ "$1" =~ ^contracts(/[A-Za-z0-9][A-Za-z0-9._-]*)+$ ]] && [[ "$1" != *..* ]]
}

# decision_contracts <DECISIONS.md>: "<record id> <path>" for each record's contract: line, the
# #fragment dropped. Only a record's field lines count, not the text of its ### sections.
decision_contracts() {
  perl -ne 'chomp;      # a CRLF file works too: \S+ stops at the \r
    if (/^## (c\d{3}-D\d{2}):/) { $id = $1; $sec = 0; next }
    if (/^## /) { $id = undef; next }
    next unless defined $id;
    if (/^### /) { $sec = 1; next }
    if (!$sec && /^- contract:\s*(\S+)/) { (my $p = $1) =~ s/#.*//; print "$id $p\n" }' "$1" 2>/dev/null
}

# contract_grant_file <home> <ticket number>: where ticket.sh keeps that ticket's grant.
contract_grant_file() { echo "$1/.factory/grants/contract-$2.json"; }

# has_contract_grant <home> <team>: does a grant name the team? A grant is a regular file
# contract-<n>.json holding {"ticket": <n>, "team": ...}; anything else grants nothing.
has_contract_grant() {
  local g n
  [ ! -L "$1/.factory" ] && [ ! -L "$1/.factory/grants" ] || return 1
  for g in "$1"/.factory/grants/contract-*.json; do
    n=${g##*/contract-}; n=${n%.json}
    [[ "$n" =~ ^[1-9][0-9]{0,8}$ ]] && [ -f "$g" ] && [ ! -L "$g" ] || continue
    [ "$(jq -r --argjson n "$n" 'if type == "object" and .ticket == $n then .team // empty else empty end' "$g" 2>/dev/null || true)" = "$2" ] && return 0
  done
  return 1
}

# A sync/<f> pull request merges main into feature/<f>, so the factory's own changes reach a feature
# dispatched before them. It may only bring what main has, over paths the feature never changed.
# sync_refs <main-ref> <base-ref> <head>: sets sync_s, the newest main commit <head> holds (so a sync
# stays valid when main moves on), and sync_mb, where <base-ref> and sync_s meet. 1: no shared history.
sync_refs() {
  sync_s=$(git merge-base "$3" "$1" 2>/dev/null) && sync_mb=$(git merge-base "$sync_s" "$2" 2>/dev/null)
}
# sync_verdict <base-ref> <head> <path>, after sync_refs: ok (as on main, untouched by the feature),
# main (not as on main), or both (the feature changed it too since it left main). A git error is not ok.
sync_verdict() {
  if ! git diff --quiet --no-ext-diff --no-textconv "$sync_s" "$2" -- ":(literal)$3" 2>/dev/null; then echo main
  elif ! git diff --quiet --no-ext-diff --no-textconv "$sync_mb" "$1" -- ":(literal)$3" 2>/dev/null; then echo both
  else echo ok; fi
}

# rigor [<dir>]: "mvp" when main's factory/policy.env says RIGOR=mvp, else "full". Main's copy
# (refs/remotes/origin/main), never the checkout's, so a pull request cannot lighten its own
# checks; the checkout's copy only where there is no origin/main at all (a repository not pushed
# yet). Any other value, a missing line or an unreadable file is "full", the stricter one.
rigor() {
  local d=${1:-.} v
  if git -C "$d" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
    v=$(git -C "$d" show refs/remotes/origin/main:factory/policy.env 2>/dev/null || true)
  else
    v=$(cat "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || echo "$d")/factory/policy.env" 2>/dev/null || true)
  fi
  v=$(printf '%s\n' "$v" | sed -n 's/^RIGOR=//p' | tail -1 | tr -d '[:space:]')
  if [ "$v" = mvp ]; then echo mvp; else echo full; fi
}
