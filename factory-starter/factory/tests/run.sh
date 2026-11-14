#!/usr/bin/env bash
# Run the tests for the factory's own scripts and hooks.
#   factory/tests/run.sh          every test-*.sh
#   factory/tests/run.sh guard    only test-guard.sh
# Exit 1 if any test fails or a known gap unexpectedly passes. Needs bash, git, jq and perl.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
FACTORY_TEST_TALLY=$(mktemp "${TMPDIR:-/tmp}/factory-tally.XXXXXX")
export FACTORY_TEST_TALLY
status=0
for f in test-${1:-*}.sh; do
  [ -f "$f" ] || { echo "no such test file: $f" >&2; exit 1; }
  bash "$f" || status=1
done
awk '{p+=$1; f+=$2; g+=$3; x+=$4} END {printf "\nTOTAL: %d passed, %d failed, %d known gaps, %d unexpectedly passing\n", p, f, g, x}' "$FACTORY_TEST_TALLY"
rm -f "$FACTORY_TEST_TALLY"
exit $status
