#!/usr/bin/env bash
# DECISIONS.md: the record a planning cycle ends with. Read-only; anyone may run it.
#   decisions.sh validate [<planning dir>] [--new-draft]   (default: the cycle in progress)
#   decisions.sh items <planning dir>         for dispatch: valid, no needs-human record left; prints
#                                             the work breakdown as JSON lines
#   decisions.sh check-append-only <base>     CI: records approved on <base> are unchanged here, except
#                                             that one may gain status: superseded and superseded_by
# A record:
#   ## c001-D02: Title
#   - owner: <team>            - affects: <teams> | none      - status: decided | needs-human
#   - risk_floor: R0..R3 (opt) - supersedes: c000-D03 (opt)   - contract: contracts/... (opt)
#   - refs: c001-m014, ... (opt: transcript ids it settles)
#   ### Decision / ### Reasoning / ### Alternatives rejected / ### Dissent   (each non-empty)
# then "## Work breakdown", a table: | item | team | delivers | after | contract | decisions |
# validate also checks, from state.json and the transcript: every question left open in discussion
# is in the refs of a needs-human record, and every objection to the current draft made its record
# needs-human with the objecting team named under Dissent (skipped with --new-draft).
# validate and items also read the specialists' raises: a line "RAISE: c001-D02 R2 <why>" in the
# cycle's threat-model.md or db-review.md (a plain file; either may be missing) needs that record of
# this cycle to have risk_floor at least R2. A raise that is malformed, or names any other record, fails.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
die() { echo "decisions: $*" >&2; exit 1; }

# check <file> <cycle> <teams,> <unanswered,> <objections team:id,> <mode: validate|items> [raise file...]
check() {
  perl -e '
    use strict; use warnings;
    my ($file, $cycle, $teams, $unans, $objs, $mode, @raises) = @ARGV;
    my %team = map { $_ => 1 } grep { length } split /,/, $teams;
    my ($pre) = $cycle =~ /^(c\d{3})-/ or die "decisions: bad cycle id\n";
    open(my $fh, "<", $file) or do { print STDERR "decisions: $file is missing\n"; exit 1 };
    my (@recs, %by, $cur, $sec, $wb, @rows, @err);
    while (my $l = <$fh>) {
      chomp $l; $l =~ s/\r$//;
      if ($l =~ /^##\s+Work breakdown\s*$/i) { $wb = 1; $cur = undef; next }
      if ($l =~ /^## (\S+?):\s*(.*)$/) { $wb = 0; $cur = { id => $1, title => $2, f => {}, s => {}, line => $. }; $sec = undef; push @recs, $cur; next }
      if ($l =~ /^## /) { $cur = undef; $wb = 0; next }
      if ($wb) { push @rows, [$l, $.] if $l =~ /^\s*\|/; next }
      next unless $cur;
      if ($l =~ /^### (.+?)\s*$/) { $sec = lc $1; $cur->{s}{$sec} = ""; next }
      if (!defined $sec && $l =~ /^- ([a-z_]+):\s*(.*)$/) { (my $v = $2) =~ s/\s+#\s.*$//; $v =~ s/\s+$//; $cur->{f}{$1} = $v; next }
      $cur->{s}{$sec} .= "$l\n" if defined $sec;
    }
    my $e = sub { push @err, "$_[0]" };
    my $list = sub { my $v = shift // ""; return () if $v =~ /^\s*(none|-)?\s*$/i; return grep { length } map { s/^\s+|\s+$//gr } split /,/, $v };
    @recs or $e->("no decision records (## $pre-D01: ...)");
    for my $r (@recs) {
      my $id = $r->{id}; my $where = "$id (line $r->{line})";
      $id =~ /^\Q$pre\E-D\d{2}$/ or $e->("$where: an id must look like $pre-D01");
      $by{$id}++ and $e->("$where: the id is used twice");
      my $f = $r->{f};
      defined $f->{owner} && $team{$f->{owner}} or $e->("$where: owner must be one of the cycle teams (" . join(", ", sort keys %team) . ")");
      defined $f->{affects} or $e->("$where: affects is missing (teams, or none)");
      for ($list->($f->{affects})) { $team{$_} or $e->("$where: affects names $_, not a cycle team") }
      ($f->{status} // "") =~ /^(decided|needs-human)$/ or $e->("$where: status must be decided or needs-human");
      !defined $f->{risk_floor} || $f->{risk_floor} =~ /^R[0-3]$/ or $e->("$where: risk_floor must be R0 to R3");
      !defined $f->{supersedes} || $f->{supersedes} =~ /^c\d{3}-D\d{2}$/ && $f->{supersedes} !~ /^\Q$pre\E-/ or $e->("$where: supersedes must name a record of an earlier cycle");
      !defined $f->{contract} || $f->{contract} =~ m{^contracts/[^\s]+$} && $f->{contract} !~ m{\.\.} or $e->("$where: contract must be a path under contracts/");
      for ($list->($f->{refs})) { /^\Q$pre\E-m\d{3}$/ or $e->("$where: refs must be transcript ids like $pre-m014") }
      for my $s ("decision", "reasoning", "alternatives rejected", "dissent") {
        ($r->{s}{$s} // "") =~ /\S/ or $e->("$where: the section ### " . ucfirst($s) . " is missing or empty");
      }
    }
    my %nh = map { $_->{id} => $_ } grep { ($_->{f}{status} // "") eq "needs-human" } @recs;
    for my $q (grep { length } split /,/, $unans) {
      grep { my $r = $_; grep { $_ eq $q } $list->($r->{f}{refs}) } values %nh
        or $e->("question $q was left open in discussion: a needs-human record must list it under refs");
    }
    for my $o (grep { length } split /,/, $objs) {
      my ($t, $id) = split /:/, $o, 2;
      my ($r) = grep { $_->{id} eq $id } @recs;
      if (!$r) { $e->("$t objected to $id, which is not in DECISIONS.md"); next }
      ($r->{f}{status} // "") eq "needs-human" && ($r->{s}{dissent} // "") =~ /\b\Q$t\E\b/i
        or $e->("$t objected to $id: an objection stands until the record is needs-human with $t named under Dissent");
    }
    for my $rf (@raises) {
      next unless -e $rf || -l $rf;
      (my $n = $rf) =~ s{.*/}{};
      if (-l $rf || !-f $rf) { $e->("$n must be a plain file, not a link or a folder"); next }
      open(my $rh, "<", $rf) or do { $e->("$n cannot be read"); next };
      while (my $l = <$rh>) {
        next unless $l =~ /^[\s>*`_-]*(?:RAISE\b|(?i:raise)[\s*`_]*:)/;   # anything that looks like one must be one
        my $w = "$n line $.";   # a CR before the newline is \s, so CRLF reads the same
        my ($id, $t) = $l =~ /^\s*(?:[-*]\s+)?RAISE:\s+(\S+)\s+(\S+)(?:\s|$)/;
        defined $t && $id =~ /^c\d{3}-D\d{2}$/ && $t =~ /^R[0-3]$/ or do { $e->("$w: a raise must read RAISE: <record id like $pre-D01> <R0..R3> <why>"); next };
        $id =~ /^\Q$pre\E-/ or do { $e->("$w: $id is not a record of this cycle; raise the record here that settles it"); next };
        my ($r) = grep { $_->{id} eq $id } @recs;
        $r or do { $e->("$w: raises $id, which is not in DECISIONS.md"); next };
        (($r->{f}{risk_floor} // "R0") =~ /^R([0-3])$/ ? $1 : -1) >= substr($t, 1)
          or $e->("$w: raises $id to $t, so its risk_floor must be at least $t");
      }
    }
    my (@items, %item);
    if (!@rows) { $e->("no ## Work breakdown table") }
    else {
      my ($h, @body) = @rows;
      my @cols = map { lc s/^\s+|\s+$//gr } grep { 1 } (split /\|/, $h->[0]);
      shift @cols if @cols && $cols[0] eq "";
      join(",", map { $_ // "" } @cols[0..5]) eq "item,team,delivers,after,contract,decisions" or $e->("the work breakdown header must be | item | team | delivers | after | contract | decisions |");
      for my $row (@body) {
        next if $row->[0] =~ /^\s*\|[\s:|-]+\|?\s*$/;
        my @c = map { s/^\s+|\s+$//gr } split /\|/, $row->[0]; shift @c if @c && $c[0] eq "";
        my ($it, $tm, $dv, $af, $ct, $dc) = @c;
        my $w = "work breakdown line $row->[1]";
        defined $dc or do { $e->("$w: needs six cells"); next };
        $it =~ /^[a-z0-9][a-z0-9-]{0,40}$/ or $e->("$w: item must be a short slug");
        $item{$it}++ and $e->("$w: item $it is listed twice");
        $team{$tm} or $e->("$w: team $tm is not a cycle team");
        $dv =~ /\S/ or $e->("$w: delivers is empty");
        $ct =~ /^(-|none|)$/i || $ct =~ m{^contracts/\S+$} && $ct !~ /\.\./ or $e->("$w: contract must be - or a path under contracts/");
        my @dcs = $list->($dc); for (@dcs) { $by{$_} or $e->("$w: decision $_ is not in DECISIONS.md") }
        push @items, { item => $it, team => $tm, delivers => $dv, after => [ $list->($af) ], contract => ($ct =~ /^(-|none)?$/i ? "" : $ct), decisions => [ @dcs ] };
      }
      @items or $e->("the work breakdown has no rows");
      for my $i (@items) { for (@{ $i->{after} }) { $item{$_} or $e->("work breakdown: $i->{item} comes after $_, which is not an item") } }
      my %seen; my $loop;
      my $visit; $visit = sub { my ($n, %path) = @_; return if $loop; if ($path{$n}) { $loop = $n; return } return if $seen{$n}++;
        my ($i) = grep { $_->{item} eq $n } @items; $visit->($_, %path, $n => 1) for @{ $i ? $i->{after} : [] } };
      $visit->($_->{item}) for @items;
      $loop and $e->("work breakdown: the after column has a loop through $loop");
    }
    if ($mode eq "items") { keys %nh and $e->(scalar(keys %nh) . " needs-human record(s) left: " . join(", ", sort keys %nh) . ". The human decides them before dispatch.") }
    if (@err) { print STDERR "decisions: $_\n" for @err; exit 1 }
    if ($mode eq "items") {
      sub js { my $s = shift; $s =~ s/(["\\])/\\$1/g; $s =~ s/\n/\\n/g; $s =~ s/([\x00-\x1f])/sprintf("\\u%04x", ord $1)/ge; "\"$s\"" }
      for my $i (@items) {
        print "{\"item\":", js($i->{item}), ",\"team\":", js($i->{team}), ",\"delivers\":", js($i->{delivers}),
          ",\"after\":[", join(",", map { js($_) } @{ $i->{after} }), "],\"contract\":", js($i->{contract}),
          ",\"decisions\":[", join(",", map { js($_) } @{ $i->{decisions} }), "]}\n";
      }
    } else {
      printf "decisions: ok, %d record(s), %d needs-human, %d item(s)\n", scalar @recs, scalar keys %nh, scalar @items;
    }
  ' "$@"
}

cmd=${1:-}; [ $# -gt 0 ] && shift
case "$cmd" in
validate|items)
  dir="" newdraft=0
  for a in "$@"; do case "$a" in --new-draft) newdraft=1 ;; *) dir=$a ;; esac; done
  top=$(git rev-parse --show-toplevel 2>/dev/null) || top=$PWD
  home=$(factory_home "$top")
  if [ -z "$dir" ]; then
    [ "$cmd" = validate ] || die "usage: decisions.sh items <planning dir>"
    c=$(active_cycle "$home") || die "no planning cycle is open; name its folder"
    dir="$home/planning/$c"
  fi
  st="$dir/state.json"
  S=$(jq -c 'select(type == "object" and (.teams | type == "array"))' "$st" 2>/dev/null) || true
  [ -n "$S" ] || die "$st is missing or damaged"
  cyc=$(jq -r .cycle <<<"$S"); [[ "$cyc" =~ ^c[0-9]{3}-[a-z0-9-]+$ ]] || die "state.json names no cycle"
  tm=$(jq -r '[.teams[] | strings | select(test("^[a-z][a-z0-9_-]{0,31}$"))] | join(",")' <<<"$S")
  un=$(jq -r '[.unanswered[]? | strings] | join(",")' <<<"$S")
  ob=""
  if [ "$cmd" = validate ] && [ "$newdraft" = 0 ]; then
    ob=$(cat "$dir/discussion.jsonl" 2>/dev/null | jq -r --argjson d "$(jq '.draft // 0' <<<"$S")" \
      'select(type == "object" and .round == "decisions" and .kind == "objection" and .draft == $d) | .from as $f | (.refs // [])[] | strings | "\($f):\(.)"' 2>/dev/null | paste -sd, - || true)
  fi
  check "$dir/DECISIONS.md" "$cyc" "$tm" "$un" "$ob" "$cmd" "$dir/threat-model.md" "$dir/db-review.md"
  ;;
check-append-only)
  base=${1:-}; [ -n "$base" ] || die "usage: decisions.sh check-append-only <base-ref>"
  git rev-parse -q --verify "$base^{commit}" >/dev/null || die "unknown base ref $base"
  # Compare with where this branch left $base: a record approved on $base after that is not in
  # this branch, and merging the branch does not delete it.
  mb=$(git merge-base "$base" HEAD) || die "HEAD shares no history with $base"
  bad=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! git cat-file -e "HEAD:$f" 2>/dev/null; then echo "decisions: $f was approved and is now deleted" >&2; bad=1; continue; fi
    perl -e '
      use strict; my ($f, $old, $new) = @ARGV; my $bad = 0;
      sub recs { my %r; my $id; for (split /\n/, $_[0]) { if (/^## (\S+?):/ && !/^## Work breakdown/i) { $id = $1 } elsif (/^## /) { $id = undef }
        push @{ $r{$id} }, $_ if defined $id } return \%r }
      my ($o, $n) = (recs($old), recs($new));
      for my $id (sort keys %$o) {
        if (!$n->{$id}) { print STDERR "decisions: $f: approved record $id was removed\n"; $bad = 1; next }
        my $st = sub { (grep { /^- status:/ } @{ $_[0] })[0] // "" };
        my $strip = sub { join "\n", grep { !/^- (status|superseded_by):/ } @{ $_[0] } };
        $strip->($o->{$id}) eq $strip->($n->{$id}) or do { print STDERR "decisions: $f: approved record $id was changed\n"; $bad = 1; next };
        my ($os, $ns) = ($st->($o->{$id}), $st->($n->{$id}));
        next if $os eq $ns && !grep { /^- superseded_by:/ } @{ $n->{$id} };
        $ns =~ /^- status:\s*superseded\b/ && grep { /^- superseded_by:\s*c\d{3}-D\d{2}\s*$/ } @{ $n->{$id} }
          or do { print STDERR "decisions: $f: approved record $id may only become status: superseded, with superseded_by\n"; $bad = 1 };
      }
      exit $bad;
    ' "$f" "$(git show "$mb:$f")" "$(git show "HEAD:$f")" || bad=1
  done < <(git ls-tree -r --name-only "$mb" -- planning/ | grep -E '^planning/[^/]+/DECISIONS\.md$' || true)
  [ "$bad" = 0 ] && echo "decisions: approved records unchanged"
  exit "$bad"
  ;;
*) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
