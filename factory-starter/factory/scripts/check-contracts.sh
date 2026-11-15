#!/usr/bin/env bash
# CI check that the code generated from contracts/ is current and the code keeps to them.
#   check-contracts.sh                   (in the repository; CI runs the base branch's copy)
# Runs `make contract-gen`. If that changed or created any file, tracked or untracked (ignored
# files aside), the generated code has drifted from contracts/: prints git status and the diff,
# exit 1. Then runs `make contract-check` (conformance, for example contract tests), exit 1 when
# it fails. No contracts/ directory, or none with files in it: "no contracts", exit 0.
# The Makefile defines both targets for the stack; the kit's defaults fail while contracts/ has files.
# Exit 0 ok, 1 drift or a failed target, 2 usage or environment.
set -uo pipefail
die() { echo "contracts: $*" >&2; exit "${2:-1}"; }

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the repository" 2
cd "$top" || die "cannot enter $top" 2
command -v make >/dev/null 2>&1 || die "make is not installed" 2
[ -n "$(find contracts -type f ! -name '.*' 2>/dev/null | head -1)" ] || { echo "contracts: no contracts"; exit 0; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# snap: a tree of the working directory as it is (tracked and untracked files), in a scratch index.
snap() { GIT_INDEX_FILE="$tmp/index" git read-tree HEAD && GIT_INDEX_FILE="$tmp/index" git add -A . && GIT_INDEX_FILE="$tmp/index" git write-tree; }
before=$(snap) || die "cannot read the working tree" 2
make contract-gen || die "make contract-gen failed"
after=$(snap) || die "cannot read the working tree" 2
if [ "$before" != "$after" ]; then
  echo "contracts: the generated code has drifted from contracts/. Run 'make contract-gen' and commit what it changes." >&2
  git status --porcelain
  git --no-pager diff --stat "$before" "$after"
  git --no-pager diff "$before" "$after" | head -c 200000
  exit 1
fi
make contract-check || die "make contract-check failed: the code does not keep to contracts/"
echo "contracts: generated code is current and contract-check passes"
