# Tests for factory/scripts/check-contracts.sh: generated code must match contracts/ (make
# contract-gen changes nothing) and make contract-check must pass. The fixture's generator turns
# each contracts/*.txt into gen/<name> with every line prefixed "// ".
. "$(dirname "$0")/lib.sh"
CC="$SCRIPTS/check-contracts.sh"

# fixture: a repo with one contract, its generated file committed in sync, and a Makefile whose
# contract-check fails while the file FAIL exists.
fixture() {
  mkrepo r && cd r
  printf 'contract-gen:\n\t@mkdir -p gen && for f in contracts/*.txt; do sed "s|^|// |" "$$f" > "gen/$${f#contracts/}"; done\n\ncontract-check:\n\t@test ! -e FAIL || { echo "route /shares is not in the contract"; exit 1; }\n' > Makefile
  mkdir contracts && printf 'GET /shares\n' > contracts/api.txt
  make -s contract-gen && git add -A && git commit -qm contracts
}

test_in_sync_is_green() {
  fixture; run "$CC"; expect_rc 0; expect_out "generated code is current"
}

test_contract_changed_without_regenerating_is_red() {
  fixture; printf 'GET /shares\nPOST /shares\n' > contracts/api.txt; git commit -qam "contract only"
  run "$CC"; expect_rc 1; expect_err "the generated code has drifted from contracts/"
  expect_out "M gen/api.txt"; expect_out "+// POST /shares"
  git checkout -q -- . ; git clean -qfd
  printf 'x\n' > contracts/more.txt; git add -A; git commit -qm "a new contract, no generated file"
  run "$CC"; expect_rc 1; expect_out "?? gen/more.txt"
  make -s contract-gen; git add -A; git commit -qm regenerated
  run "$CC"; expect_rc 0
}

test_generated_code_edited_by_hand_is_red() {
  fixture; echo '// GET /everything' >> gen/api.txt; git commit -qam "hand edit"
  run "$CC"; expect_rc 1; expect_out "-// GET /everything"
}

test_contract_check_failing_is_red() {
  fixture; touch FAIL; echo FAIL > .gitignore; git add -A; git commit -qm fail
  run "$CC"; expect_rc 1; expect_err "make contract-check failed"; expect_out "route /shares is not in the contract"
}

test_contract_gen_failing_is_red() {
  fixture; printf 'contract-gen:\n\t@exit 3\n' > Makefile; git commit -qam broken
  run "$CC"; expect_rc 1; expect_err "make contract-gen failed"
}

test_no_contracts_is_green() {
  mkrepo r && cd r; run "$CC"; expect_rc 0; expect_out "no contracts"
  mkdir -p contracts/design && touch contracts/.gitkeep contracts/design/.keep; run "$CC"; expect_rc 0; expect_out "no contracts"
  cp "$KIT/Makefile" .; run make -s contract-gen; expect_rc 0; run make -s contract-check; expect_rc 0
  rm -rf contracts; run make -s contract-gen; expect_rc 0
}

test_contracts_with_the_kits_default_makefile_are_red() {
  mkrepo r && cd r; cp "$KIT/Makefile" .; mkdir -p contracts/design && echo '{}' > contracts/design/tokens.json
  git add -A && git commit -qm contracts
  run "$CC"; expect_rc 1; expect_err "make contract-gen failed"; expect_out "Define 'make contract-gen'"
  run make -s contract-check; expect_rc 2; expect_out "Define 'make contract-check'"
}

test_unrelated_untracked_and_ignored_files_are_not_drift() {
  fixture; echo build > notes.tmp                                   # left by an earlier step
  printf 'contract-gen:\n\t@mkdir -p gen node_modules && sed "s|^|// |" contracts/api.txt > gen/api.txt && date > node_modules/stamp\n\ncontract-check:\n\t@true\n' > Makefile
  echo node_modules/ > .gitignore; git add Makefile .gitignore; git commit -qm "ignored output"
  run "$CC"; expect_rc 0
  echo dirty >> gen/api.txt                                          # dirty before, regenerated after
  run "$CC"; expect_rc 1; expect_out "-dirty"
}

test_hostile_contract_names_and_contents() {
  fixture
  printf 'GET /a\r\n$(touch pwned) `touch pwned2`\n' > 'contracts/$(touch pwned3) x.txt'
  printf 'y\n' > $'contracts/new\nline.txt'
  head -c 1048576 /dev/zero | tr '\0' 'a' > contracts/big.txt
  make -s contract-gen; git add -A; git commit -qm hostile
  run "$CC"; expect_rc 0
  rm 'gen/$(touch pwned3) x.txt'; git commit -qam "lost one"
  run "$CC"; expect_rc 1; expect_err "drifted"
  [ ! -e pwned ] && [ ! -e pwned2 ] && [ ! -e pwned3 ] || fail "a name or content was executed"
}

test_outside_a_repository_is_an_environment_error() {
  mkdir plain && cd plain; run "$CC"; expect_rc 2
}

run_tests
