#!/usr/bin/env bash
# CI feature gate (team mode): a feature reaches main only from integrate/<f>, once its e2e tests and
# its acceptance review pass, and a feature branch takes only its own feature's work items.
#   check-feature.sh <base-ref>        (CI runs the base branch's copy, in the check job)
# Env: HEAD_REF (the pull request's head branch), HEAD_SHA (its head commit), GH_TOKEN, GH_REPO.
# <f> is a feature id, f<NNN>-<slug>. By head branch, then by base branch:
#   feature/<f> into main: fails. A feature reaches main only from integrate/<f> (integrate.sh pr).
#   integrate/<f>: one line per requirement. The base is main; origin/feature/<f> exists; at HEAD_SHA
#     (read with git, never from the working tree) features/<f>/e2e-report.md is a regular file whose
#     first line is "# E2E report: <f>", second "E2E: pass", fourth "commit: <40-hex sha>";
#     features/<f>/acceptance-review.md is a regular file whose first line starting VERDICT: is
#     exactly "VERDICT: accept" and whose e2e-commit: is that commit; nothing but records
#     (features/<f>/, work/<id>/, memory/observations/) differs between that commit and HEAD_SHA;
#     GitHub shows feature/<f> protected and requiring every status check main requires (main must
#     require some; a gh failure fails); then, only if all of that holds, `make e2e` passes in the
#     checked-out tree.
#   sync/<f>: into feature/<f> only, where it passes here (main merged into the feature branch, by
#     integrate.sh sync: check-ownership.sh makes sure every path it changes is as on main).
#   base feature/<g>: the pull request carries exactly one work folder, whose spec says feature: <g>.
#   any other base: no work folder's spec names a feature (a feature's item goes to feature/<f>).
#   Otherwise: "not a feature pull request", exit 0.
# A head or base branch starting feature/ or integrate/ (any case) that is not exactly that plus a
# feature id fails, as does a HEAD_REF with control characters. A spec's feature: is read from its
# frontmatter at HEAD_SHA; more than one, or a malformed one, fails.
# No factory/teams.json on the base branch: single-team mode, nothing to check.
# Self-contained: CI copies this file alone. Nothing read is run; make e2e runs the checked-out tree.
# Exit 0 ok, 1 the gate fails, 2 usage or environment.
set -uo pipefail
die() { echo "feature: $*" >&2; exit "${2:-1}"; }
usage() { die "usage: check-feature.sh <base-ref>   (env HEAD_REF, HEAD_SHA, GH_TOKEN, GH_REPO)" 2; }
fid='f[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}'

[ $# -eq 1 ] || usage
base=$1
case "$base" in -*|'') usage ;; esac
for t in git jq perl; do command -v "$t" >/dev/null 2>&1 || die "$t is not installed" 2; done
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the repository" 2
cd "$top" || die "cannot enter $top" 2
git rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1 || die "unknown base ref $base" 2
head_ref=${HEAD_REF-}
sha=${HEAD_SHA-}
show() { printf '%s' "$1" | tr -d '\000-\037\177' | cut -c1-120; }   # safe to print
[ -n "$head_ref" ] || die "HEAD_REF is not set (the pull request's head branch)" 2
[ "$(printf '%s' "$head_ref" | tr -d '\000-\037\177')" = "$head_ref" ] || die "cannot parse the head branch '$(show "$head_ref")': it has control characters"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$sha^{commit}" 2>/dev/null ||
  die "HEAD_SHA '$(show "$sha")' is not the 40-hex sha of a commit in this repository" 2
if ! git cat-file -e "$base:factory/teams.json" 2>/dev/null; then
  echo "feature: no factory/teams.json on $base: single-team mode, no feature gate"; exit 0
fi
tmp=$(mktemp -d) || die "cannot make a temp dir" 2; trap 'rm -rf "$tmp"' EXIT

bb=${base#refs/remotes/}; bb=${bb#origin/}                  # the base branch's name
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
# branch_feature <branch> <prefix>: sets $bf to <f> for <prefix>/<f>. Returns 1 when the branch does
# not start with <prefix>/ in any case; fails the gate for a look-alike (another case, a bad id).
branch_feature() {
  bf=""
  case "$(lower "$1")" in "$2"/*) ;; *) return 1 ;; esac
  [[ "$1" =~ ^$2/($fid)$ ]] || die "cannot parse the branch '$(show "$1")': $2/ branches are $2/<feature id>, like $2/f001-share-links"
  bf=${BASH_REMATCH[1]}
}
kind=""
if branch_feature "$head_ref" feature; then kind=feature
elif branch_feature "$head_ref" integrate; then kind=integrate
elif branch_feature "$head_ref" sync; then kind=sync
fi
hf=$bf

if [ "$kind" = sync ]; then
  [ "$bb" = "feature/$hf" ] || die "sync/$hf goes to feature/$hf only, not $(show "$bb")"
  echo "feature: sync/$hf -> feature/$hf: main merged into the feature branch (the ownership check makes sure every path is as on main)"
  exit 0
fi

if [ "$kind" = feature ] && [ "$bb" = main ]; then
  echo "feature: $head_ref -> main: NOT OK. A feature reaches main only from integrate/$hf, opened by integrate.sh pr." >&2
  exit 1
fi

if [ "$kind" = integrate ]; then
  f=$hf bad=0 commit=""
  line() { printf '  %-8s %s\n' "$1" "$2"; [ "$1" = ok ] || bad=1; }
  echo "feature: integrate/$f -> $(show "$bb")"
  if [ "$bb" = main ]; then line ok "base is main"; else line "NOT OK" "base is $(show "$bb"): integrate/$f goes to main only"; fi
  if git rev-parse -q --verify "refs/remotes/origin/feature/$f^{commit}" >/dev/null; then line ok "origin/feature/$f exists"
  else line "NOT OK" "origin/feature/$f does not exist"; fi

  # regular <path>: a regular file at HEAD_SHA (a symlink's blob is its target's name, not a report)
  regular() { [[ "$(git ls-tree "$sha" -- "$1" | cut -c1-6)" =~ ^100(644|755)$ ]] && git cat-file blob "$sha:$1" > "$tmp/blob" 2>/dev/null; }
  rep="features/$f/e2e-report.md"
  if ! regular "$rep"; then line "NOT OK" "$rep is missing at the head commit, or not a regular file"
  else
    l1="" l2="" l3="" l4=""
    { IFS= read -r l1; IFS= read -r l2; IFS= read -r l3; IFS= read -r l4; } < "$tmp/blob"
    l1=${l1%$'\r'} l2=${l2%$'\r'} l3=${l3%$'\r'} l4=${l4%$'\r'}
    round=${l3#round: }
    if [ "$l1" != "# E2E report: $f" ]; then line "NOT OK" "$rep is not this feature's e2e report: its first line is not '# E2E report: $f'"
    elif [ "$l2" = "E2E: fail" ]; then line "NOT OK" "the e2e report says E2E: fail ($(show "$l3"))"
    elif [ "$l2" != "E2E: pass" ]; then line "NOT OK" "the e2e report's second line is not 'E2E: pass': $(show "$l2")"
    elif ! [[ "$l4" =~ ^commit:\ ([0-9a-f]{40})$ ]]; then line "NOT OK" "the e2e report's fourth line is not 'commit: <40-hex sha>': $(show "$l4")"
    else commit=${BASH_REMATCH[1]}; line ok "the e2e report says E2E: pass for commit $commit (round $(show "$round"))"; fi
  fi

  rev="features/$f/acceptance-review.md"
  if ! regular "$rev"; then line "NOT OK" "$rev is missing at the head commit, or not a regular file (research's acceptance review, merged into feature/$f)"
  else
    v=$(perl -ne 's/\r//g; if (/^VERDICT:/) { print $1 if /^VERDICT:[ \t]*([a-z-]+)[ \t]*$/; exit }' "$tmp/blob")
    ec=$(perl -ne 's/\r//g; if (/^e2e-commit:/) { print $1 if /^e2e-commit:[ \t]*([0-9a-f]{40})[ \t]*$/; exit }' "$tmp/blob")
    if [ "$v" != accept ]; then line "NOT OK" "the acceptance review does not say VERDICT: accept (found: ${v:-no exact verdict})"
    elif [ -z "$ec" ]; then line "NOT OK" "the acceptance review has no 'e2e-commit: <40-hex sha>' line"
    elif [ "$ec" != "$commit" ]; then line "NOT OK" "the acceptance review is of commit $ec, not of the e2e report's commit ${commit:-(none)}"
    else line ok "the acceptance review says VERDICT: accept for commit $commit"; fi
  fi

  if [ -z "$commit" ]; then line "NOT OK" "no tested commit to compare the head with (the e2e report above)"
  elif ! git cat-file -e "$commit^{commit}" 2>/dev/null; then line "NOT OK" "the tested commit $commit is not in this repository"
  elif ! git diff -z --name-only --no-renames "$commit" "$sha" > "$tmp/changed"; then line "NOT OK" "cannot compare commit $commit with the head"
  else
    # Records may arrive after the round: this feature's folder, the work folder and observation
    # that come with research's acceptance review. Anything else is a change the round did not test.
    P="features/$f/" perl -0ne 'chomp; print "$_\0" unless index($_, $ENV{P}) == 0 || m{^work/[^/]+/} || m{^memory/observations/}' "$tmp/changed" > "$tmp/outside"
    if [ -s "$tmp/outside" ]; then
      line "NOT OK" "code changed since the tested commit $commit (run integrate.sh run again): $(tr '\0' ' ' < "$tmp/outside" | tr -d '\001-\037\177' | cut -c1-200)"
    else line ok "nothing but records (features/$f/, work/, memory/observations/) changed since commit $commit"; fi
  fi

  # Protection, read from GitHub: feature/<f> must hold team pull requests to main's checks.
  checks='[(.protection.required_status_checks.contexts // [])[], ((.protection.required_status_checks.checks // [])[] | .context)] | map(strings) | unique'
  if ! [[ "${GH_REPO-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then line "NOT OK" "GH_REPO is not owner/name, so feature/$f's protection cannot be read"
  elif ! gh api "repos/$GH_REPO/branches/main" > "$tmp/main.json" 2> "$tmp/gh.err" < /dev/null ||
       ! gh api "repos/$GH_REPO/branches/feature/$f" > "$tmp/feat.json" 2>> "$tmp/gh.err" < /dev/null; then
    line "NOT OK" "cannot read branch protection from GitHub: $(head -c 200 "$tmp/gh.err" | tr -d '\000-\037\177')"
  elif ! jq -e 'type == "object"' "$tmp/main.json" >/dev/null 2>&1 || ! jq -e 'type == "object"' "$tmp/feat.json" >/dev/null 2>&1 ||
       ! need=$(jq -ce "$checks" "$tmp/main.json" 2>/dev/null) || ! have=$(jq -ce "$checks" "$tmp/feat.json" 2>/dev/null) ||
       ! missing=$(jq -nr --argjson n "$need" --argjson h "$have" '$n - $h | map(gsub("[\\p{Cc}]"; "")) | join(", ")' 2>/dev/null); then
    line "NOT OK" "cannot read the required checks from GitHub's answer about main or feature/$f"
  else
    if [ "$need" = "[]" ]; then line "NOT OK" "main requires no status checks on GitHub, so there is nothing to hold feature/$f to (make ci's jobs required on main)"
    elif ! jq -e '.protected == true' "$tmp/feat.json" >/dev/null; then line "NOT OK" "feature/$f is not protected on GitHub (dispatch.sh copies main's protection onto it)"
    elif jq -e '.protection.required_status_checks.enforcement_level == "off"' "$tmp/feat.json" >/dev/null; then line "NOT OK" "feature/$f's required status checks are switched off"
    elif [ -n "$missing" ]; then line "NOT OK" "feature/$f does not require main's checks: $missing"
    else line ok "feature/$f is protected and requires main's checks ($(jq -nr --argjson n "$need" '$n | map(gsub("[\\p{Cc}]"; "")) | join(", ")'))"; fi
  fi

  if [ "$bad" -ne 0 ]; then line "NOT RUN" "make e2e (the requirements above come first)"
  elif ! command -v make >/dev/null 2>&1; then line "NOT OK" "make is not installed, so make e2e cannot run"
  else
    echo "  running make e2e"
    if make e2e < /dev/null; then line ok "make e2e passes"; else line "NOT OK" "make e2e fails"; fi
  fi
  if [ "$bad" -ne 0 ]; then
    echo "feature: integrate/$f cannot reach main yet (above). integrate.sh pr opens this pull request once the round passed and research accepted it." >&2
    exit 1
  fi
  echo "feature: ok"; exit 0
fi

# Work items: a feature's item goes to its feature branch, and a feature branch takes only those.
git diff -z --name-only --no-renames "$base...$sha" > "$tmp/files" || die "cannot diff $base...$sha" 2
perl -0ne 'print "$1\0" if m{^work/([^/]+)/}' "$tmp/files" | sort -zu > "$tmp/items"
n=$(tr -cd '\0' < "$tmp/items" | wc -c | tr -d ' ')
# spec_feature <item>: the feature: values in the frontmatter of its spec at HEAD_SHA, one per line.
spec_feature() {
  git cat-file blob "$sha:work/$1/spec.md" 2>/dev/null |
    perl -ne 's/\r?\n\z//; if ($. == 1) { exit unless $_ eq "---"; next } exit if $_ eq "---"; print "$1\n" if /^feature:[ \t]*(.*?)[ \t]*$/'
}
gf=""
if branch_feature "$bb" feature; then gf=$bf; fi
bad=0
while IFS= read -r -d '' item; do
  w="work/$(show "$item")"
  fs=$(spec_feature "$item")
  if [ "$(printf '%s' "$fs" | grep -c '')" -gt 1 ]; then echo "  NOT OK   $w: its spec names more than one feature"; bad=1; continue; fi
  if [ -n "$fs" ] && ! [[ "$fs" =~ ^$fid$ ]]; then echo "  NOT OK   $w: its spec's feature: is not a feature id: $(show "$fs")"; bad=1; continue; fi
  if [ -n "$gf" ]; then
    if [ "$fs" = "$gf" ]; then echo "  ok       $w is an item of feature $gf"
    elif [ -n "$fs" ]; then echo "  NOT OK   $w is an item of feature $fs: feature/$gf takes only feature $gf's items"; bad=1
    else echo "  NOT OK   $w is not a feature's item (no feature: in its spec): feature/$gf takes only feature $gf's items"; bad=1; fi
  elif [ -n "$fs" ]; then
    echo "  NOT OK   $w is an item of feature $fs: its pull request goes to feature/$fs, not $(show "$bb")"; bad=1
  fi
done < "$tmp/items"
if [ -n "$gf" ] && [ "$n" -ne 1 ]; then
  echo "feature: a pull request into feature/$gf carries exactly one work folder (an item of $gf); this one has $n" >&2; exit 1
fi
[ "$bad" -eq 0 ] || { echo "feature: a work item is going to the wrong branch (above)" >&2; exit 1; }
if [ -n "$gf" ]; then echo "feature: ok, an item of $gf into feature/$gf"
else echo "feature: not a feature pull request"; fi
exit 0
