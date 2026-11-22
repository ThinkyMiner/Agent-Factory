#!/usr/bin/env bash
# policy.sh rigor      prints "mvp" or "full": RIGOR in main's factory/policy.env (lib.sh, rigor).
# policy.sh autonomy   prints "on" or "off": AUTONOMY in main's factory/policy.env (lib.sh, autonomy).
# For skills and agents; scripts call rigor from lib.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
case "${1:-}:$#" in
  rigor:1) rigor "$(pwd)" ;;
  autonomy:1) autonomy "$(pwd)" ;;
  *) echo "usage: policy.sh rigor|autonomy" >&2; exit 2 ;;
esac
