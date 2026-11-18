#!/usr/bin/env bash
# policy.sh rigor   prints "mvp" or "full": RIGOR in main's factory/policy.env (lib.sh, rigor).
# For skills and agents; scripts call rigor from lib.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
[ $# -eq 1 ] && [ "$1" = rigor ] || { echo "usage: policy.sh rigor" >&2; exit 2; }
rigor "$(pwd)"
