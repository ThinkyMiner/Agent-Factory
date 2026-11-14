# The factory's single definition of "green". Agents, hooks and CI all call these
# targets, so swapping the stack means editing this file and nothing else.
.PHONY: check accept dev

check:
	@echo "Define 'make check' (lint + typecheck + unit tests) for your stack." && exit 1

accept:
	@echo "Define 'make accept' (run tests/acceptance/) for your stack." && exit 1

dev:
	@echo "Define 'make dev' for your stack." && exit 1
