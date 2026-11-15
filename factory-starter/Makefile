# The factory's single definition of "green". Agents, hooks and CI all call these
# targets, so swapping the stack means editing this file and nothing else.
.PHONY: check accept dev

check:
	@echo "Define 'make check' (lint + typecheck + unit tests) for your stack." && exit 1

accept:
	@echo "Define 'make accept' (run tests/acceptance/) for your stack." && exit 1

dev:
	@echo "Define 'make dev' for your stack." && exit 1

# Screenshots and an axe scan of the running product, for the ui-reviewer (ui-review.md).
.PHONY: ui-shots
ui-shots:
	@echo "Define 'make ui-shots' for your stack: start the app, then node factory/scripts/ui-shots.mjs --out $(OUT) <url>" && exit 1

# Contracts (contracts/): CI's check job runs factory/scripts/check-contracts.sh, which fails when
# contract-gen changes any file (generated code drifted) or contract-check fails. These defaults
# pass while contracts/ has no files, so a factory without contracts stays green.
.PHONY: contract-gen contract-check
contract-gen:
	@if [ -n "$$(find contracts -type f ! -name '.*' 2>/dev/null | head -1)" ]; then \
	  echo "Define 'make contract-gen' (generate both sides' code from contracts/) for your stack." && exit 1; fi

contract-check:
	@if [ -n "$$(find contracts -type f ! -name '.*' 2>/dev/null | head -1)" ]; then \
	  echo "Define 'make contract-check' (check the code against contracts/) for your stack." && exit 1; fi
