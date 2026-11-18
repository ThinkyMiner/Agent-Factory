#!/usr/bin/env bash
# Fail if acceptance tests were changed after the test-author committed them.
# The test-author marks its commit with the trailer "Factory-Stage: tests".
# Anything under tests/acceptance/ that differs between the latest such commit
# and HEAD was edited by someone else, usually to make a failing test pass.
#   check-acceptance-lock.sh [base-ref]   (default base: origin/main)
# HEAD_REF sync/<f> (main merged into feature/<f>, in CI): exempt. It brings main's files unchanged
# (check-ownership.sh makes sure), and each passed this check on its way into main.
# This catches drift and shortcuts. It is not proof against a determined author,
# who could forge the trailer; the reviewer and the weekly audit cover that.
set -euo pipefail

base="${1:-origin/main}"
dir="${ACCEPTANCE_DIR:-tests/acceptance}"

case "${HEAD_REF:-}" in sync/*)
  if ! [[ "$HEAD_REF" =~ ^sync/f[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]]; then
    echo "acceptance lock: the head branch is not a feature's sync branch (sync/f001-slug)" >&2; exit 1
  fi
  echo "acceptance lock: $HEAD_REF brings main's files unchanged (the ownership check makes sure): exempt"
  exit 0 ;;
esac

lock=$(git log --format=%H --grep='^Factory-Stage: tests$' "$base"..HEAD | head -n 1)

if [ -z "$lock" ]; then
  if [ -n "$(git diff --name-only "$base"...HEAD -- "$dir")" ]; then
    echo "acceptance lock: $dir changed but no commit carries 'Factory-Stage: tests'" >&2
    exit 1
  fi
  echo "acceptance lock: no acceptance tests in this change"
  exit 0
fi

changed=$(git diff --name-only "$lock" HEAD -- "$dir")
if [ -n "$changed" ]; then
  echo "acceptance lock: files changed after the tests commit ${lock:0:8}:" >&2
  echo "$changed" >&2
  exit 1
fi
echo "acceptance lock: ok (locked at ${lock:0:8})"
