#!/usr/bin/env bash
# Classify the risk tier of a change from the paths it touches.
#   classify-risk.sh [base-ref]   changed files from git (default base: origin/main)
#   classify-risk.sh --stdin      file list on stdin, one path per line
# Prints the tier (R0..R3) on stdout and the per-file reasoning on stderr.
# Rules file: factory/risk-rules.txt, or the path in $RISK_RULES.
set -euo pipefail

rules="${RISK_RULES:-$(cd "$(dirname "$0")/.." && pwd)/risk-rules.txt}"
[ -f "$rules" ] || { echo "classify-risk: rules file not found: $rules" >&2; exit 2; }

if [ "${1:-}" = "--stdin" ]; then
  files=$(cat)
else
  base="${1:-origin/main}"
  files=$(git diff --name-only "$base"...HEAD)
fi

max=0
while IFS= read -r f; do
  if [ -z "$f" ]; then continue; fi
  tier=-1
  why="no rule, default"
  while read -r t pat _; do
    case "$t" in ''|\#*) continue ;; esac
    n="${t#R}"
    # $pat is deliberately unquoted so it is treated as a glob.
    if [[ "$f" == $pat ]] && [ "$n" -gt "$tier" ]; then
      tier="$n"
      why="$pat"
    fi
  done < "$rules"
  if [ "$tier" -lt 0 ]; then tier=1; fi
  echo "R$tier  $f  ($why)" >&2
  if [ "$tier" -gt "$max" ]; then max="$tier"; fi
done <<< "$files"

echo "R$max"
