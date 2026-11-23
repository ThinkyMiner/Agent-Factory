# Tests for factory/scripts/ui-shots.mjs's input checks: usage, --out inside the repository and
# without .., http/https/file URLs only and file URLs inside the repository, and the message when
# the product has no playwright. These run before any browser, so they need node only (skipped
# without it). Rendering itself needs the product's playwright and is checked by hand.
. "$(dirname "$0")/lib.sh"

# app: a repository at $TEST_TMP/app holding a copy of the script (its root is two folders up)
# and a page; cwd is the app, which has no node_modules.
app() {
  mkdir -p app/factory/scripts app/web app/work/1-x outside
  cp "$SCRIPTS/ui-shots.mjs" app/factory/scripts/
  echo '<h1>hi</h1>' > app/web/index.html; echo secret > outside/secret.txt
  cd app
}
shots() { run env -u NODE_PATH node factory/scripts/ui-shots.mjs "$@"; }
PAGE() { echo "file://$TEST_TMP/app/web/index.html"; }

test_usage_errors_exit_2() {
  command -v node >/dev/null || return 0
  app
  shots; expect_rc 2; expect_err "usage:"
  shots --out; expect_rc 2
  shots --out work/1-x/screens; expect_rc 2; expect_err "usage:"
  shots "$(PAGE)"; expect_rc 2
  shots --out --evil "$(PAGE)"; expect_rc 2
  shots --evil --out work/1-x/screens "$(PAGE)"; expect_rc 2; expect_err "unknown option --evil"
}

test_out_stays_inside_the_repository() {
  command -v node >/dev/null || return 0
  app
  ln -s "$TEST_TMP/outside" work/link; ln -s "$TEST_TMP/nowhere" work/dangling
  local o
  for o in ../x work/../../x 'work/1-x/..' /etc/x "$TEST_TMP/outside/s" work/link/screens work/dangling/screens "$TEST_TMP/app"; do
    shots --out "$o" "$(PAGE)"; expect_rc 2
    grep -q "needs playwright" "$ERR" && fail "--out $o got past the check"
  done
  [ ! -e "$TEST_TMP/nowhere" ] && [ "$(ls "$TEST_TMP/outside")" = secret.txt ] || fail "wrote outside the repository"
}

test_urls_are_http_https_or_file_inside_the_repository() {
  command -v node >/dev/null || return 0
  app
  ln -s "$TEST_TMP/outside/secret.txt" web/peek.html
  local u
  for u in 'javascript:alert(1)' 'data:text/html,<h1>x</h1>' 'ftp://example.com/x' 'chrome://settings' 'not a url' '' \
           file:///etc/passwd "file://$TEST_TMP/outside/secret.txt" "file://$TEST_TMP/app/web/../../outside/secret.txt" \
           "file://$TEST_TMP/app/web/%2e%2e/%2e%2e/outside/secret.txt" "file://$TEST_TMP/app/web/peek.html" 'file://host/etc/passwd'; do
    shots --out work/1-x/screens "$(PAGE)" "$u"; expect_rc 2
    grep -q "needs playwright" "$ERR" && fail "URL [$u] got past the check"
  done
  return 0
}

test_valid_input_without_playwright_says_how_to_install_and_writes_nothing() {
  command -v node >/dev/null || return 0
  app
  for u in "$(PAGE)" http://localhost:3000/settings 'https://staging.example.com/a b' "file://$TEST_TMP/app/web/missing.html"; do
    shots --out work/1-x/screens "$u"; expect_rc 2; expect_err "needs playwright and @axe-core/playwright"; expect_err "npm install --save-dev"
  done
  shots --out "$TEST_TMP/app/work/1-x/screens" "$(PAGE)"; expect_rc 2; expect_err "needs playwright"
  [ ! -e work/1-x/screens ] || fail "made the output folder before it could render"
}

# fake_playwright: a playwright and an @axe-core/playwright in the app's node_modules that render
# nothing. A screenshot is the text "png <scheme> <width>x<height>"; a URL with "missing" in it
# does not load, one with "gone" answers 404; every scan finds one serious violation.
fake_playwright() {
  mkdir -p node_modules/playwright node_modules/@axe-core/playwright
  cat > node_modules/playwright/index.js <<'JS'
let count = 0;   // clicks on Count, across every page and state, as a server keeps its data
exports.chromium = { launch: async () => ({ close: async () => {}, newContext: async () => ({ close: async () => {},
  newPage: async () => { let scheme, size, url, did = []; return {
    emulateMedia: async (o) => { scheme = o.colorScheme; },
    setViewportSize: async (s) => { size = s; },
    goto: async (u) => { url = u; did = []; if (u.includes('missing')) throw new Error('net::ERR_FILE_NOT_FOUND'); const s = u.includes('gone') ? 404 : 200; return { ok: () => s === 200, status: () => s }; },
    getByLabel: (l) => ({ fill: async (v) => { if (l === 'Nowhere') throw new Error('Timeout 5000ms exceeded.\nwaiting for getByLabel'); did.push(`fill ${l}=${v}`); },
      selectOption: async (o) => { did.push(`select ${l}=${o.label}`); } }),
    getByRole: (r, o) => { const b = { click: async () => { if (o.name === 'Leave') url = 'https://elsewhere.example/'; if (o.name === 'Count') count++; did.push(`click ${r} ${o.name}${o.name === 'Count' ? ' ' + count : ''}`); } }; return { ...b, first: () => b }; },
    url: () => url,
    screenshot: async () => Buffer.from(`png ${scheme} ${size.width}x${size.height}${did.length ? ' ' + did.join(',') : ''}`) }; } }) }) };
JS
  cat > node_modules/@axe-core/playwright/index.js <<'JS'
module.exports = class { async analyze() { return { violations: [{ id: 'color-contrast', impact: 'serious', help: 'h', helpUrl: 'u', nodes: [{ target: ['p'], failureSummary: 's' }] }] }; } };
JS
}

test_renders_every_scheme_and_width_with_an_axe_report() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  shots --out work/1-x/screens "$(PAGE)" http://localhost:3000/settings/profile http://localhost:3000/settings/profile; expect_rc 0
  expect_eq "$(ls work/1-x/screens | tr '\n' ' ')" "axe.json index-dark-desktop.png index-dark-phone.png index-light-desktop.png index-light-phone.png settings-profile-2-dark-desktop.png settings-profile-2-dark-phone.png settings-profile-2-light-desktop.png settings-profile-2-light-phone.png settings-profile-dark-desktop.png settings-profile-dark-phone.png settings-profile-light-desktop.png settings-profile-light-phone.png "
  expect_eq "$(cat work/1-x/screens/index-dark-phone.png)" "png dark 390x844"
  expect_eq "$(cat work/1-x/screens/index-light-desktop.png)" "png light 1280x800"
  expect_eq "$(jq -c '[.[] | [.page, .scheme, .violations[0].impact]] | .[0:2]' work/1-x/screens/axe.json)" '[["index","light","serious"],["index","dark","serious"]]'
  expect_out "wrote 13 files"; expect_out "axe violations: 0 critical, 6 serious, 0 moderate, 0 minor"
  expect_out "index dark: color-contrast (serious, 1 nodes)"
}

test_a_page_that_does_not_load_exits_1_and_the_rest_still_render() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  shots --out work/1-x/screens "file://$TEST_TMP/app/web/missing.html" "$(PAGE)" http://localhost:3000/gone; expect_rc 1
  expect_err "missing.html failed: net::ERR_FILE_NOT_FOUND"; expect_err "/gone failed: HTTP 404"
  expect_eq "$(jq -c '[.[] | .error // .scheme]' work/1-x/screens/axe.json)" '["net::ERR_FILE_NOT_FOUND","light","dark","HTTP 404"]'
  [ -f work/1-x/screens/index-dark-phone.png ] || fail "the page that loads was not rendered"
}

test_links_planted_in_the_output_folder_are_replaced_not_followed() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  echo victim > "$TEST_TMP/outside/victim"; mkdir -p work/1-x/screens
  ln -s "$TEST_TMP/outside/victim" work/1-x/screens/index-light-desktop.png
  ln -s "$TEST_TMP/outside/axe" work/1-x/screens/axe.json
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 0
  expect_eq "$(cat "$TEST_TMP/outside/victim")" victim
  [ ! -e "$TEST_TMP/outside/axe" ] || fail "wrote axe.json through a dangling link"
  [ ! -L work/1-x/screens/index-light-desktop.png ] && [ ! -L work/1-x/screens/axe.json ] || fail "a planted link is still there"
}

test_states_in_the_work_folder_are_shot_and_scanned_after_their_steps() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  cat > work/1-x/ui-states.txt <<'TXT'
# states the spec asks to see
long-title: fill Title = A very long title that wraps;  select Layout = Left with accent bar

bad-colour: fill Background = $(touch pwned) `touch pwned2` <script>x</script>; click Download PNG
TXT
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 0
  expect_eq "$(ls work/1-x/screens | tr '\n' ' ')" "axe.json index--bad-colour-dark-desktop.png index--bad-colour-dark-phone.png index--bad-colour-light-desktop.png index--bad-colour-light-phone.png index--long-title-dark-desktop.png index--long-title-dark-phone.png index--long-title-light-desktop.png index--long-title-light-phone.png index-dark-desktop.png index-dark-phone.png index-light-desktop.png index-light-phone.png "
  expect_eq "$(cat work/1-x/screens/index--long-title-dark-phone.png)" "png dark 390x844 fill Title=A very long title that wraps,select Layout=Left with accent bar"
  expect_eq "$(cat work/1-x/screens/index--bad-colour-light-desktop.png)" 'png light 1280x800 fill Background=$(touch pwned) `touch pwned2` <script>x</script>,click button Download PNG'
  expect_eq "$(cat work/1-x/screens/index-light-desktop.png)" "png light 1280x800"     # the page as it loads, no steps
  expect_eq "$(jq -c '[.[] | [.page, .state, .scheme]]' work/1-x/screens/axe.json)" '[["index",null,"light"],["index",null,"dark"],["index","long-title","light"],["index","long-title","dark"],["index","bad-colour","light"],["index","bad-colour","dark"]]'
  expect_out "wrote 13 files"; expect_out "index--long-title dark: color-contrast (serious, 1 nodes)"
  [ ! -e pwned ] && [ ! -e pwned2 ] || fail "a step's text ran as a command"
}

test_a_states_steps_run_once_and_every_shot_shows_their_result() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  printf 'saved: click Count\nlater: click Count\n' > work/1-x/ui-states.txt
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 0
  for f in light-desktop light-phone dark-desktop dark-phone; do
    expect_eq "$(cat work/1-x/screens/index--saved-$f.png | sed 's/^png [a-z]* [0-9x]* //')" "click button Count 1"
    expect_eq "$(cat work/1-x/screens/index--later-$f.png | sed 's/^png [a-z]* [0-9x]* //')" "click button Count 2"
  done
}

test_a_bad_states_file_is_a_usage_error_and_nothing_renders() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  local bad
  for bad in 'Long-Title: fill Title = x' 'x: drop table cards' 'x: fill = y' 'x: fill Title y' 'x:' 'x: ; ;' \
             'x: click' "x: fill $(printf 'L%.0s' {1..101}) = y" "$(printf 'n%.0s' {1..31}): click Go" \
             '-x: click Go' 'x/../y: click Go' 'x: click Go
x: click Go'; do
    printf '# ok\n%s\n' "$bad" > work/1-x/ui-states.txt
    shots --out work/1-x/screens "$(PAGE)"; expect_rc 2; expect_err "ui-states.txt:"
    [ ! -e work/1-x/screens ] || fail "rendered with a bad line: $bad"
  done
  : > work/1-x/ui-states.txt; for i in $(seq 21); do echo "s$i: click Go" >> work/1-x/ui-states.txt; done
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 2; expect_err "at most 20 states"
  head -c 20001 /dev/zero | tr '\0' '#' > work/1-x/ui-states.txt
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 2; expect_err "over 20000 bytes"
  rm work/1-x/ui-states.txt; ln -s "$TEST_TMP/outside/secret.txt" work/1-x/ui-states.txt
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 2; expect_err "must be a plain file"
  rm work/1-x/ui-states.txt; mkdir work/1-x/ui-states.txt
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 2; expect_err "must be a plain file"
  [ ! -e work/1-x/screens ] || fail "rendered with a bad states file"
}

test_a_step_that_fails_or_leaves_the_page_fails_only_its_state() {
  command -v node >/dev/null || return 0
  app; fake_playwright
  printf 'gone: fill Nowhere = x\naway: click Leave\nfine: fill Title = y\n' > work/1-x/ui-states.txt
  shots --out work/1-x/screens "$(PAGE)"; expect_rc 1
  expect_err 'state gone failed: step "fill Nowhere": Timeout 5000ms exceeded.'
  expect_err "state away failed: a step left the page for https://elsewhere.example/"
  expect_eq "$(ls work/1-x/screens | grep -c -e '--gone-' -e '--away-')" 0
  [ -f work/1-x/screens/index--fine-dark-phone.png ] && [ -f work/1-x/screens/index-dark-phone.png ] || fail "the other states were not rendered"
  expect_eq "$(jq -c '[.[] | select(.error) | [.state, .error]]' work/1-x/screens/axe.json)" '[["gone","step \"fill Nowhere\": Timeout 5000ms exceeded."],["away","a step left the page for https://elsewhere.example/"]]'
  expect_out "index--gone: did not render"
}

run_tests
