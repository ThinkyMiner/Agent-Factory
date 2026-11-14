#!/usr/bin/env bash
# Check that a spec is complete enough to hand to the next stage.
#   exit 0  valid
#   exit 1  malformed (missing fields or criteria)
#   exit 3  well-formed but has blocking questions: stop and ask the human
set -uo pipefail

f="${1:-}"
[ -n "$f" ] && [ -f "$f" ] || { echo "validate-spec: file not found: $f" >&2; exit 1; }

fail=0
need() { grep -Eq -- "$1" "$f" || { echo "spec invalid: $2" >&2; fail=1; }; }

need '^id: *[A-Za-z0-9._-]+ *$'            "frontmatter 'id' is missing or still a placeholder"
need '^title: *[^<[:space:]].*$'           "frontmatter 'title' is missing or still a placeholder"
need '^risk_floor: *R[0-3] *$'             "frontmatter 'risk_floor' must be R0, R1, R2 or R3"
need '^tests: *(required|none) *$'         "frontmatter 'tests' must be 'required' or 'none'"
need '^## Problem'                         "missing '## Problem'"
need '^## Acceptance criteria'             "missing '## Acceptance criteria'"
need '^- AC-[0-9]+: '                      "no acceptance criteria in the form '- AC-1: Given ..., when ..., then ...'"
need '^## Out of scope'                    "missing '## Out of scope'"
need '^## Assumptions'                     "missing '## Assumptions'"
need '^## Blocking questions'              "missing '## Blocking questions'"

if grep -Eq -- '^- AC-[0-9]+: .*<' "$f"; then
  echo "spec invalid: an acceptance criterion still contains a <placeholder>" >&2
  fail=1
fi
[ "$fail" -eq 0 ] || exit 1

questions=$(awk '
  /^## Blocking questions/ { on=1; next }
  /^## /                   { on=0 }
  on { line=$0; gsub(/^[ \t-]+|[ \t.]+$/, "", line);
       if (line != "" && tolower(line) != "none") print $0 }
' < "$f")

if [ -n "$questions" ]; then
  echo "spec has blocking questions:" >&2
  echo "$questions" >&2
  exit 3
fi
echo "spec ok: $f"
