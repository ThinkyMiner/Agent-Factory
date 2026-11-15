#!/usr/bin/env bash
# The risk tier of a pull request, as risk-gate applies it: the highest of
#   - the path rules: classify-risk.sh next to this script (rules: $RISK_RULES, or its default),
#     on every path the diff adds, changes or deletes, both names of a rename included;
#   - the risk_floor of the spec of each work folder the diff touches (work/<id>/spec.md);
#   - the risk_floor of every decision record named on that spec's `decisions:` line, read from
#     planning/*/DECISIONS.md on the base branch, never from the pull request;
#   - the RISK line of each report in the folder: review.md, ui-review.md, security.md, db-review.md.
#   risk-tier.sh [base-ref]        (default origin/main)
# Work folders are read at HEAD. Prints the tier on stdout and one line per input on stderr.
# Single-team mode too: the spec's floor and the reports count with or without factory/teams.json.
# A value it cannot read (risk_floor: R9, a RISK line without R0..R3, a decision id not like
# c001-D02, a record missing on base, a missing spec) is ignored and named on stderr: it never
# lowers the tier and never stops the script. Nothing read is ever run.
# Exit 0, or 2 on a usage or environment error (unknown base ref, no rules file).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
die() { echo "risk-tier: $*" >&2; exit 2; }

[ $# -le 1 ] || die "usage: risk-tier.sh [base-ref]"
case "${1:-}" in -*) die "usage: risk-tier.sh [base-ref]" ;; esac
base=${1:-origin/main}
git rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1 || die "unknown base ref $base"
tmp=$(mktemp -d) || die "cannot make a temp dir"; trap 'rm -rf "$tmp"' EXIT

# -z and --no-renames: a renamed file counts under its old name too, and no name comes quoted.
git diff -z --name-only --no-renames "$base"...HEAD > "$tmp/files" || die "cannot diff $base...HEAD"
max=$(tr '\0' '\n' < "$tmp/files" | bash "$here/classify-risk.sh" --stdin) || exit 2
case "$max" in R[0-3]) ;; *) die "classify-risk.sh printed '$max', not a tier" ;; esac
echo "$max  path rules" >&2

raise() { echo "$1  $2" >&2; [ "${1#R}" -gt "${max#R}" ] && max=$1; return 0; }
skip()  { echo "--  $*" >&2; }
show()  { printf '%s' "$1" | tr -d '\000-\037' | cut -c1-60; }   # a value, printable and short
tier_re='^(R[0-3])([^0-9]|$)'

# Every decision record on base: "<id> TAB <file> TAB" once, plus "... TAB <value>" per risk_floor.
git ls-tree -r -z --name-only "$base" -- planning 2>/dev/null | while IFS= read -r -d '' p; do
  case "$p" in planning/*/DECISIONS.md) ;; *) continue ;; esac
  git cat-file blob "$base:$p" 2>/dev/null | P=$p perl -ne '
    s/\r//g; chomp;
    if (/^## /) { ($id) = /^## (c[0-9]{3}-D[0-9]{2}):/; print "$id\t$ENV{P}\t\n" if defined $id; next }
    if (/^#/) { $id = undef; next }                         # a section: fields come before it
    print "$id\t$ENV{P}\t$1\n" if defined $id && /^- risk_floor:[ \t]*(.*?)[ \t]*$/;'
done > "$tmp/records"

while IFS= read -r -d '' item; do
  w="work/$(show "$item")"
  if git cat-file blob "HEAD:work/$item/spec.md" > "$tmp/spec" 2>/dev/null; then
    found=0
    while IFS= read -r v; do
      found=1
      if [[ $v =~ $tier_re ]]; then raise "${BASH_REMATCH[1]}" "$w/spec.md risk_floor"
      else skip "$w/spec.md: risk_floor '$(show "$v")' is not R0..R3, ignored"; fi
    done < <(perl -ne 's/\r//g; print "$1\n" if /^risk_floor:[ \t]*(.*?)[ \t]*$/' "$tmp/spec")
    [ "$found" = 1 ] || skip "$w/spec.md: no risk_floor"
    # The records the spec names: one line per floor found, "R2 TAB what"; the rest to stderr.
    perl -ne 's/\r//g; print "$1\n" if /^decisions:[ \t]*(.*)$/' "$tmp/spec" |
      W=$w perl -e '
        my (%rec, %seen, @bad, @gone);
        open(my $fh, "<", $ARGV[0]) or exit 0;
        while (<$fh>) { chomp; my ($id, $f, $v) = split /\t/, $_, 3; $rec{$id}{$f} = 1; push @{$rec{$id}{" floors"}}, [$f, $v] if length $v }
        while (my $l = <STDIN>) { chomp $l;
          for my $id (split /,/, $l) {
            $id =~ s/^[ \t]+|[ \t]+$//g; next if $id eq "" || $seen{$id}++;
            if ($id !~ /^c[0-9]{3}-D[0-9]{2}\z/) { push @bad, $id; next }
            if (!$rec{$id}) { push @gone, $id; next }
            for (@{$rec{$id}{" floors"} || []}) { my ($f, $v) = @$_;
              if ($v =~ /^(R[0-3])([^0-9]|$)/) { print "$1\tdecision $id risk_floor ($f)\n" }
              else { (my $s = substr($v, 0, 60)) =~ s/[\x00-\x1f]//g; print STDERR "--  decision $id: risk_floor \x27$s\x27 in $f is not R0..R3, ignored\n" } } } }
        my $clean = sub { (my $s = substr($_[0], 0, 60)) =~ s/[\x00-\x1f]//g; $s };
        printf STDERR "--  %s/spec.md: %d decision id(s) not like c001-D02, ignored (first: \x27%s\x27)\n", $ENV{W}, scalar @bad, $clean->($bad[0]) if @bad;
        printf STDERR "--  %s/spec.md: %d decision(s) not on the base branch, ignored (first: %s)\n", $ENV{W}, scalar @gone, $gone[0] if @gone;
      ' "$tmp/records" > "$tmp/floors"
    while IFS="$(printf '\t')" read -r t what; do raise "$t" "$what"; done < "$tmp/floors"
  else
    skip "$w/spec.md: missing at HEAD, so no risk_floor and no decisions"
  fi
  for r in review.md ui-review.md security.md db-review.md; do
    git cat-file blob "HEAD:work/$item/$r" > "$tmp/report" 2>/dev/null || continue
    t=$(perl -ne 's/\r//g; if (/^RISK:[ \t]*(R[0-3])([^0-9]|$)/) { print $1; exit }' "$tmp/report")
    if [ -n "$t" ]; then raise "$t" "$w/$r RISK"; else skip "$w/$r: no RISK line with R0..R3, ignored"; fi
  done
done < <(perl -0ne 'print "$1\0" if m{^work/([^/]+)/}' "$tmp/files" | sort -zu)

echo "$max"
