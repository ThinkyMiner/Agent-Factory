#!/usr/bin/env bash
# Run a command as the factory's bot on GitHub.
#   bot-session.sh <command> [args...]        (team-up starts every agent session through it)
# GH_TOKEN becomes the bot's token, read from the macOS keychain item "factory-github-bot"
# (security add-generic-password -s factory-github-bot -a factory -w), and git pushes to
# github.com go through gh with that token, whatever helper or SSH remote your own git uses.
# The token never goes into a file, an argument or the repository. Store a classic token with
# only the repo scope: without "workflow", GitHub refuses the bot any push that changes
# .github/workflows/, so a pull request cannot rewrite its own gates.
set -euo pipefail
die() { echo "bot-session: $*" >&2; exit 1; }
[ $# -gt 0 ] || die "usage: bot-session.sh <command> [args...]"
command -v security >/dev/null 2>&1 || die "no macOS keychain here (the security command is missing)"
gh=$(command -v gh) || die "gh is not installed"
tok=$(security find-generic-password -s factory-github-bot -w 2>/dev/null) ||
  die "no bot token in the keychain. Store the bot account's token once with: security add-generic-password -s factory-github-bot -a factory -w"
[[ "$tok" =~ ^[A-Za-z0-9_]{20,255}$ ]] || die "the keychain item factory-github-bot does not hold a GitHub token"
export GH_TOKEN=$tok
# An empty helper drops every helper configured before it; these entries come after all config files.
export GIT_CONFIG_COUNT=4 \
  GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0= \
  GIT_CONFIG_KEY_1=credential.https://github.com.helper GIT_CONFIG_VALUE_1="!$gh auth git-credential" \
  GIT_CONFIG_KEY_2=url.https://github.com/.pushInsteadOf GIT_CONFIG_VALUE_2=git@github.com: \
  GIT_CONFIG_KEY_3=url.https://github.com/.pushInsteadOf GIT_CONFIG_VALUE_3=ssh://git@github.com/
exec "$@"
