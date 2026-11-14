# Helpers for the factory's script tests. Plain bash 3.2 (macOS) compatible, no framework.
# A test file sources this, defines functions named
#   test_*  must pass
#   gap_*   a known hole, expected to fail until fixed; if it passes it is reported as XPASS
#           (and fails the run) so that it gets renamed to test_* instead of silently rotting
# and ends with `run_tests`. Each test runs in a subshell, in its own temp dir, under `set -e`.
set -uo pipefail

KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPTS="$KIT/factory/scripts"
HOOKS="$KIT/factory/hooks"

# Isolate git from the user's config (signing, hooks, default branch, identity).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=factory-test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=factory-test GIT_COMMITTER_EMAIL=test@example.invalid
unset FACTORY_ALLOW_SELF_EDIT CLAUDE_PROJECT_DIR

fail() { echo "      $*" >&2; return 1; }

# run <cmd...>: exit code in $RC, stdout in file $OUT, stderr in file $ERR.
run() { RC=0; "$@" >"$OUT" 2>"$ERR" || RC=$?; }
expect_rc()   { [ "$RC" = "$1" ] || fail "exit $RC, expected $1. stderr: $(head -c 400 "$ERR")"; }
expect_out()  { grep -qF -- "$1" "$OUT" || fail "stdout lacks [$1]; got: $(head -c 300 "$OUT")"; }
expect_err()  { grep -qF -- "$1" "$ERR" || fail "stderr lacks [$1]; got: $(head -c 300 "$ERR")"; }
expect_eq()   { [ "$1" = "$2" ] || fail "expected [$2], got [$1]${3:+ ($3)}"; }
lines()       { if [ -f "$1" ]; then awk 'END{print NR}' "$1"; else echo 0; fi; }

# mkrepo <dir>: a git repo on main with one empty commit.
mkrepo() { git init -q -b main "$1" && git -C "$1" commit -q --allow-empty -m init; }

# path_without <tool...>: prints a directory to use as PATH that has the usual tools minus these.
path_without() {
  local d tool p
  d=$(mktemp -d "$TEST_TMP/bin.XXXX")
  for tool in bash sh env cat grep egrep sed awk git date mkdir dirname basename head tail tr wc \
              rm mv cp ls sleep touch xcrun jq perl; do
    case " $* " in *" $tool "*) continue ;; esac
    p=$(command -v "$tool" 2>/dev/null) || continue
    case "$p" in /*) ln -s "$p" "$d/$tool" ;; esac
  done
  echo "$d"
}

run_tests() {
  local file fn rc p=0 f=0 g=0 x=0
  file=$(basename "${BASH_SOURCE[1]}" .sh)
  echo "$file"
  for fn in $(declare -F | awk '{print $3}' | grep -E '^(test|gap)_'); do
    TEST_TMP=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/factory-test.XXXXXX")" && pwd -P)
    OUT=$TEST_TMP/.out ERR=$TEST_TMP/.err
    export TEST_TMP OUT ERR
    ( cd "$TEST_TMP" || exit 99; set -e; "$fn" ) 2>"$TEST_TMP/.log"
    rc=$?
    case "$fn:$rc" in
      test_*:0) p=$((p+1)); echo "  ok     $fn" ;;
      test_*)   f=$((f+1)); echo "  FAIL   $fn"; sed 's/^/         /' "$TEST_TMP/.log" ;;
      gap_*:0)  x=$((x+1)); echo "  XPASS  $fn  (gap is closed: rename it to test_)" ;;
      gap_*)    g=$((g+1)); echo "  gap    $fn  (known, still open)" ;;
    esac
    rm -rf "$TEST_TMP"
  done
  echo "  -> $p passed, $f failed, $g known gaps, $x unexpectedly passing"
  [ -n "${FACTORY_TEST_TALLY:-}" ] && echo "$p $f $g $x" >> "$FACTORY_TEST_TALLY"
  [ "$f" -eq 0 ] && [ "$x" -eq 0 ]
}
