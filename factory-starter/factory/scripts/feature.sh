#!/usr/bin/env bash
# A dispatched feature's records.
#   feature.sh check-acceptance <acceptance.md> [<DECISIONS.md>]
#       Checks features/<f>/acceptance.md, which research writes:
#         ## AC1: <title>                 at least one; ids AC<n>, n from 1 without a leading zero, unique
#         - decisions: c001-D02, c001-D03 exactly one such line, one or more record ids
#         - check: <how to tell>          exactly one, with text on the line (it may go on below)
#       Text before the first "## AC" is free; after it, every "## " heading is a criterion. With a
#       DECISIONS.md, every id named must be a record there (## c001-D02: ...). CR is ignored.
#       Prints each problem as <file>:<line>: <problem>. Exit 0 ok, 1 otherwise.
#   feature.sh render <f>
#       In the current checkout, which must be on integrate/<f> (integrate.sh runs it): writes
#       features/<f>/tickets.jsonl (every issue labelled ticket and feature:<f>, any state, by number)
#       and features/<f>/FEATURE.md (criteria, items from planning/c<NNN>-<slug>/dispatch.jsonl,
#       the feature's work issues and tickets, the e2e report's verdict and the acceptance review's).
#       Text from GitHub and from the records is untrusted: control characters go, | is escaped in
#       tables, and the files pass through clean_text. A gh failure writes nothing and exits 1.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "feature: $*" >&2; exit 1; }

case "${1:-}" in
check-acceptance)
  [ $# -ge 2 ] && [ $# -le 3 ] || die "usage: feature.sh check-acceptance <acceptance.md> [<DECISIONS.md>]"
  perl -e '
    use strict;
    my ($file, $dec) = @ARGV;
    my (%rec, @err, %seen, $cur, $n);
    my $show = sub { (my $s = substr($_[0], 0, 80)) =~ s/[\x00-\x1f\x7f]//g; $s };
    if (defined $dec) {
      open(my $d, "<", $dec) or do { print "$dec: cannot read it\n"; exit 1 };
      while (<$d>) { s/\r//g; $rec{$1} = 1 if /^## (c[0-9]{3}-D[0-9]{2}):/ }
    }
    open(my $fh, "<", $file) or do { print "$file: cannot read it\n"; exit 1 };
    my $err = sub { push @err, "$file:$_[0]: $_[1]" };
    my $end = sub {
      return unless $cur;
      $err->($cur->{line}, "$cur->{id} has no \"- decisions:\" line") if !$cur->{dec};
      $err->($cur->{line}, "$cur->{id} has $cur->{dec} \"- decisions:\" lines; it needs exactly one") if $cur->{dec} > 1;
      $err->($cur->{line}, "$cur->{id} has no \"- check:\" line") if !$cur->{check};
      $err->($cur->{line}, "$cur->{id} has $cur->{check} \"- check:\" lines; it needs exactly one") if $cur->{check} > 1;
    };
    my $count = 0;
    while (my $l = <$fh>) {
      $n = $.; $l =~ s/\r?\n\z//; $l =~ s/\r//g;
      if ($l =~ /^## /) {
        $end->(); $cur = undef;
        if ($l =~ /^## (AC[1-9][0-9]*):[ \t]*\S/) {
          $err->($n, "$1 appears twice") if $seen{$1}++;
          $cur = { id => $1, line => $n, dec => 0, check => 0 }; $count++;
        } elsif ($count || $l =~ /^## AC/) {
          $err->($n, "\"" . $show->($l) . "\" is not a criterion heading \"## AC<n>: <title>\" (n from 1, no leading zero)");
        }
        next;
      }
      next unless $cur;
      if ($l =~ /^- decisions:(.*)$/) {
        $cur->{dec}++;
        my @ids = grep { length } map { s/^\s+|\s+$//gr } split /,/, $1;
        $err->($n, "$cur->{id} names no decision") if !@ids;
        for (@ids) {
          if (!/^c[0-9]{3}-D[0-9]{2}$/) { $err->($n, "\"" . $show->($_) . "\" is not a decision id like c001-D02") }
          elsif (defined $dec && !$rec{$_}) { $err->($n, "$_ is not a record in $dec") }
        }
      } elsif ($l =~ /^- check:(.*)$/) {
        $cur->{check}++;
        $err->($n, "$cur->{id}: the check is empty") if $1 !~ /\S/;
      }
    }
    $end->();
    push @err, "$file: no criteria: add at least one \"## AC1: <title>\"" if !$count;
    if (@err) { print "$_\n" for @err; exit 1 }
    print "acceptance: $file: $count criteria\n";
  ' "$2" ${3+"$3"}
  ;;

render)
  f=${2:-}
  [[ "$f" =~ ^f[0-9]{3}-[a-z0-9][a-z0-9-]{0,40}$ ]] || die "usage: feature.sh render <feature> (like f001-share-links)"
  top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside the factory's repository"
  cd "$top"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "integrate/$f" ] || die "render runs on integrate/$f (integrate.sh runs it there)"
  d="features/$f"; cyc="c${f#f}"
  for p in features "$d" "$d/FEATURE.md" "$d/tickets.jsonl"; do [ ! -L "$p" ] || die "$p is a symbolic link; nothing was written"; done
  command -v gh >/dev/null 2>&1 || die "gh is not installed"
  issues=$(gh issue list --label "feature:$f" --state all --limit 1000 --json number,title,state,labels) || die "cannot list the feature's issues on GitHub; nothing was written"
  jq -e 'type == "array"' >/dev/null 2>&1 <<<"$issues" || die "unexpected answer from gh; nothing was written"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  # one jq program for everything from GitHub: lab(p) is the value of the one label starting with p
  J='def lab($p): [.labels[]?.name | strings | select(startswith($p)) | ltrimstr($p)] | if length == 1 then .[0] else "" end;
     def cell: tostring | gsub("[[:cntrl:]]+"; " ") | gsub("\\|"; "\\|") | .[0:200];
     def ticket: [.labels[]?.name] | index("ticket") != null;'
  jq -c "$J"' map(select(ticket)) | sort_by(.number)[]
     | {number, title: (.title | tostring | gsub("[[:cntrl:]]+"; " ")), from: lab("from:"), to: lab("to:"), type: lab("type:"),
        state: lab("state:"), closed: (.state == "CLOSED")}' <<<"$issues" > "$tmp/tickets" || die "unexpected answer from gh; nothing was written"
  report="none yet"; review="none yet"
  if [ -f "$d/e2e-report.md" ]; then
    report=$(perl -ne 's/\r?\n\z//; $v = $1 if $. == 2 && /^E2E: (pass|fail)$/; $r = $1 if $. == 3 && /^round: ([0-9]+)$/;
      $c = $1 if $. == 4 && /^commit: ([0-9a-f]{40})$/; last if $. >= 4; END { print $v ? "$v, round $r, commit $c" : "unreadable" }' "$d/e2e-report.md")
  fi
  if [ -f "$d/acceptance-review.md" ]; then
    review=$(perl -ne 's/\r//g; if (!defined $v && /^VERDICT:/) { $v = /^VERDICT:[ \t]*(accept|reject)[ \t]*$/ ? $1 : "unreadable" }
      $c = $1 if !defined $c && /^e2e-commit:[ \t]*([0-9a-f]{40})[ \t]*$/; END { print defined $v ? $v . ($c ? " (e2e-commit $c)" : "") : "no VERDICT line" }' "$d/acceptance-review.md")
  fi
  {
    echo "Generated by factory/scripts/feature.sh render $f. Do not edit: each integration round rewrites it."
    echo; echo "# Feature $f"
    echo; echo "## Acceptance criteria (features/$f/acceptance.md)"; echo; echo "| id | title |"; echo "|---|---|"
    perl -ne 's/\r?\n\z//; if (/^## (AC[1-9][0-9]*):[ \t]*(.*?)[ \t]*$/) { (my $t = substr($2, 0, 200)) =~ s/[\x00-\x1f\x7f]+/ /g; $t =~ s/\|/\\|/g; print "| $1 | $t |\n" }' "$d/acceptance.md" 2>/dev/null || true
    echo; echo "## Items (planning/$cyc/dispatch.jsonl)"; echo; echo "| item | team | delivers |"; echo "|---|---|---|"
    jq -Rr "$J"' fromjson? | objects | "| \(.item | cell) | \(.team | cell) | \(.delivers | cell) |"' "planning/$cyc/dispatch.jsonl" 2>/dev/null || true
    echo; echo "## Work issues"; echo; echo "| issue | team | title | state |"; echo "|---|---|---|---|"
    jq -r "$J"' map(select(ticket | not)) | sort_by(.number)[] | "| #\(.number) | \(lab("team:") | cell) | \(.title | cell) | \(.state // "" | tostring | ascii_downcase | cell) |"' <<<"$issues"
    echo; echo "## Tickets (features/$f/tickets.jsonl)"; echo; echo "| ticket | from | to | type | state | title |"; echo "|---|---|---|---|---|---|"
    jq -rs "$J"' .[] | "| #\(.number) | \(.from | cell) | \(.to | cell) | \(.type | cell) | \(.state | cell) | \(.title | cell) |"' "$tmp/tickets"
    echo; echo "## Integration"; echo
    echo "- E2E report (features/$f/e2e-report.md): $report"
    echo "- Acceptance review (features/$f/acceptance-review.md): $review"
  } > "$tmp/md" || die "could not render FEATURE.md; nothing was written"
  mkdir -p "$d"
  clean_text "$(cat "$tmp/md")" > "$tmp/FEATURE.md"; echo >> "$tmp/FEATURE.md"
  if [ -s "$tmp/tickets" ]; then clean_text "$(cat "$tmp/tickets")" > "$tmp/tickets.jsonl"; echo >> "$tmp/tickets.jsonl"; else : > "$tmp/tickets.jsonl"; fi
  mv "$tmp/tickets.jsonl" "$d/tickets.jsonl" && mv "$tmp/FEATURE.md" "$d/FEATURE.md" || die "could not write $d"
  echo "feature: rendered $d/FEATURE.md and $d/tickets.jsonl"
  ;;

*) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
