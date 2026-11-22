#!/usr/bin/env bash
# autonomy-gate.sh <base-ref> <rules-ref> <tier>: may this pull request merge without the human's
# label? CI's risk-gate runs main's copy (rules-ref is main) for an R2 change, before it asks for
# human-approved. Yes (exit 0) only when all of these hold:
#   - main's factory/policy.env says AUTONOMY=on;
#   - the tier (risk-tier.sh's, which CI passes in) is R0, R1 or R2; R3 never;
#   - every path the change touches under the factory's controls (factory/, .claude/, .github/,
#     teams/, docs/factory/, memory/lessons.md, memory/reflections/: the paths the guard keeps
#     from workers) is exactly as it is on rules-ref, mode and content: a sync that only carries
#     main's kit qualifies, a change to the kit does not.
# No (exit 1) with one line saying why. Cannot tell (exit 2): bad arguments or unreadable refs, so
# the caller falls back to the label. The change is <base-ref>...HEAD, as classify-risk.sh reads it.
set -uo pipefail
say() { printf 'autonomy-gate: %s\n' "$*"; }
cannot() { say "$*" >&2; exit 2; }
[ $# -eq 3 ] || cannot "usage: autonomy-gate.sh <base-ref> <rules-ref> <tier>"
base=$1 rules=$2 tier=$3
for r in "$base" "$rules"; do
  git rev-parse -q --verify "$r^{commit}" >/dev/null 2>&1 || cannot "not a commit: $r"   # "-x", "--help": no such ref
done
[[ "$tier" =~ ^R[0-3]$ ]] || cannot "not a tier: $tier"

v=$(git show "$rules:factory/policy.env" 2>/dev/null | sed -n 's/^AUTONOMY=//p' | tail -1 | tr -d '[:space:]')
[ "$v" = on ] || { say "AUTONOMY is not on in main's factory/policy.env"; exit 1; }
[ "$tier" != R3 ] || { say "R3: the factory never makes these changes"; exit 1; }

# Paths may hold newlines, so they are read NUL-separated from a file.
list=$(mktemp) || cannot "no temp file"
trap 'rm -f "$list"' EXIT
git diff -z --name-only --no-renames "$base...HEAD" > "$list" 2>/dev/null || cannot "cannot diff $base...HEAD"
# Mode, type and object of <path> in <ref>; empty when it is not there. Every path checked starts
# with a control folder, so pathspec magic (only at a path's start) cannot apply.
entry() { git ls-tree -z "$1" -- "$2" 2>/dev/null | tr '\0' '\n' | head -1 | cut -f1; }
while IFS= read -r -d '' p; do
  case "$p" in
    factory/*|.claude/*|.github/*|teams/*|docs/factory/*|memory/lessons.md|memory/reflections/*) ;;
    *) continue ;;
  esac
  if [ "$(entry HEAD "$p")" != "$(entry "$rules" "$p")" ]; then
    say "changes the factory itself, so it needs your label: $(printf '%s' "$p" | tr -d '\000-\037\177' | cut -c1-80)"
    exit 1
  fi
done < "$list"
say "no label needed: AUTONOMY=on, $tier, nothing of the factory beyond main's"
