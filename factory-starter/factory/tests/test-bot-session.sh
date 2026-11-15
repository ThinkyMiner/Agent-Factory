# Tests for factory/scripts/bot-session.sh: agent sessions get the bot's token from the keychain,
# and git pushes to GitHub use it too. The keychain (`security`) and gh are faked.
. "$(dirname "$0")/lib.sh"
B="$SCRIPTS/bot-session.sh"
TOK=ghp_factorybot0000000000000000000000

test_runs_the_command_with_the_bots_token() {
  fake_gh; fake_keychain "$TOK"
  run "$B" sh -c 'printf "%s|%s" "$GH_TOKEN" "$1"' sh 'two words'; expect_rc 0
  expect_eq "$(cat "$OUT")" "$TOK|two words"
  run "$B" gh api user --jq .login; expect_out "$TOK"         # the fake gh answers as the token's owner
}

test_git_uses_the_bot_not_your_helper_or_ssh() {
  fake_gh; fake_keychain "$TOK"; mkrepo r
  git -C r config credential.https://github.com.helper '!f() { echo username=you; echo password=your-secret; }; f'
  git -C r remote add origin git@github.com:o/r.git
  printf 'protocol=https\nhost=github.com\n\n' > q
  run "$B" git -C r credential fill < q; expect_rc 0
  expect_out "password=$TOK"; grep -q your-secret "$OUT" && fail "your own credential helper answered"
  run "$B" git -C r remote get-url --push origin; expect_out "https://github.com/o/r.git"
  run git -C r remote get-url --push origin; expect_out "git@github.com:o/r.git"   # outside, unchanged
}

test_without_a_token_it_refuses() {
  fake_gh; fake_keychain
  run "$B" touch ran; expect_rc 1; expect_err "no bot token in the keychain"
  [ ! -e ran ] || fail "ran the command without the bot's token"
}

test_a_keychain_item_that_is_not_a_token_is_refused() {
  fake_gh
  for t in short 'has space in it 000000000000' '$(touch pwned)0000000000000000' "$TOK;touch pwned" ''; do
    fake_keychain "$t"; run "$B" touch ran; expect_rc 1; expect_err "does not hold a GitHub token"
  done
  [ ! -e ran ] && [ ! -e pwned ] || fail "something ran"
}

test_needs_a_command_gh_and_a_keychain() {
  fake_gh; fake_keychain "$TOK"
  run "$B"; expect_rc 1; expect_err "usage"
  PATH="$TEST_TMP/kc:$(path_without gh)" run "$B" true; expect_rc 1; expect_err "gh is not installed"
  PATH="$FAKE_GH/bin:$(path_without security)" run "$B" true; expect_rc 1; expect_err "no macOS keychain"
}

run_tests
