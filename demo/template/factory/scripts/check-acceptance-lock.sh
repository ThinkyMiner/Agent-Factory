#!/usr/bin/env bash
# Fail if acceptance tests were changed after the test-author committed them.
# The test-author marks its commit with the trailer "Factory-Stage: tests".
# Anything under tests/acceptance/ that differs between the latest such commit
# and HEAD was edited by someone else, usually to make a failing test pass.
#   check-acceptance-lock.sh [base-ref]   (default base: origin/main)
# This catches drift and shortcuts. It is not proof against a determined author,
# who could forge the trailer; the reviewer and the weekly audit cover that.
set -euo pipefail

base="${1:-origin/main}"
dir="${ACCEPTANCE_DIR:-tests/acceptance}"

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
