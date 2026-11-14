#!/usr/bin/perl
# Helper for guard.sh. Two jobs, both pure text in and text out:
#
#   guard-paths.pl resolve <base> <path>...
#       Prints each path made absolute (relative ones against <base>) with every symlink in it
#       resolved and every . and .. applied, one per line. Works for paths that do not exist yet,
#       which a write usually targets. A symlink loop prints "!loop".
#
#   guard-paths.pl targets <shell command>
#       Prints the files a shell command would write, one per line, as written in the command
#       (not resolved). A target written only by appending (>>) is prefixed with "+",
#       a directory made by mkdir with "@".
#       Best effort: it reads redirections and the usual writing tools (tee, cp, mv, sed -i ...).
#       A heredoc's body is data and is skipped, unless its line runs a shell (bash <<EOF,
#       cat <<EOF | sh), which would run the body: then the body is read as commands too.
#       $HOME, $TMPDIR and $CLAUDE_PROJECT_DIR are expanded from the environment unless the
#       command sets them itself; any other variable is left in the target as written.
#       It cannot see through eval, scripts or other languages; the guard is a drift layer
#       and CI is the wall.
use strict;
use warnings;

sub split_path { grep { length && $_ ne '.' } split m{/}, $_[0] }

sub resolve {
  my ($base, $p) = @_;
  $p = "$base/$p" unless $p =~ m{^/};
  my @todo = split_path($p);
  my $cur  = '';
  my $hops = 0;
  while (@todo) {
    my $c = shift @todo;
    if ($c eq '..') { $cur =~ s{/[^/]*$}{}; next; }
    my $next = "$cur/$c";
    if (-l $next) {
      return '!loop' if ++$hops > 40;
      my $t = readlink $next;
      unshift @todo, split_path($t);
      $cur = '' if $t =~ m{^/};
      next;
    }
    $cur = $next;
  }
  return $cur eq '' ? '/' : $cur;
}

# A small shell lexer: returns one [ [words], [redirect targets] ] per simple command.
sub lex {
  my ($s) = @_;
  my (@cmds, @w, @r, @heredocs);           # @heredocs: [delimiter, strip tabs] waiting for the line's end
  my ($cur, $have, $redir) = ('', 0, 0);    # $redir: 0 none, 1 write, 2 append, 3 read
  my $line_start = 0;
  my $word = sub {
    if ($have) {
      if    ($redir == 1) { push @r, $cur }
      elsif ($redir == 2) { push @r, "+$cur" }
      elsif ($redir == 0) { push @w, $cur }
      $redir = 0;
    }
    ($cur, $have) = ('', 0);
  };
  my $cmd = sub { $word->(); push @cmds, [ [@w], [@r] ] if @w || @r; @w = (); @r = (); };
  my ($i, $n) = (0, length $s);
  while ($i < $n) {
    my $c = substr($s, $i, 1);
    if ($c eq "'") {
      my $j = index($s, "'", $i + 1); $j = $n if $j < 0;
      $cur .= substr($s, $i + 1, $j - $i - 1); $have = 1; $i = $j + 1; next;
    }
    if ($c eq '"') {
      my $j = $i + 1;
      while ($j < $n && substr($s, $j, 1) ne '"') {
        if (substr($s, $j, 1) eq '\\' && $j + 1 < $n) { $cur .= substr($s, $j + 1, 1); $j += 2; next; }
        $cur .= substr($s, $j, 1); $j++;
      }
      $have = 1; $i = $j + 1; next;
    }
    if ($c eq '\\' && $i + 1 < $n) { $cur .= substr($s, $i + 1, 1); $have = 1; $i += 2; next; }
    if ($c =~ /[ \t]/)            { $word->(); $i++; next; }
    if ($c eq "\n" && @heredocs) {
      $cmd->();
      my $runs_shell = substr($s, $line_start, $i - $line_start)
        =~ m{(?:^|[\s;&|(`/])(?:(?:ba|z|da|k|fi)?sh|eval|source)(?:\s|$)};
      $i++;
      for my $h (@heredocs) {                 # each body runs up to its delimiter line, or the end
        my ($delim, $strip) = @$h;
        my $body = '';
        while ($i < $n) {
          my $e = index($s, "\n", $i); $e = $n if $e < 0;
          my $l = substr($s, $i, $e - $i);
          $i = $e + 1;
          (my $t = $l) =~ s/^\t+// if $strip;
          last if ($strip ? $t : $l) eq $delim;
          $body .= "$l\n";
        }
        push @cmds, lex($body) if $runs_shell;
      }
      @heredocs = (); $line_start = $i; next;
    }
    if ($c =~ /[;&|\n()`]/)       { $cmd->(); $line_start = $i + 1 if $c eq "\n"; $i++; next; }
    if ($c eq '>') {
      if ($have && $cur =~ /^\d+$/) { ($cur, $have) = ('', 0) } else { $word->() }
      $i++;
      my $mode = 1;
      if ($i < $n && substr($s, $i, 1) eq '>') { $mode = 2; $i++ }
      elsif ($i < $n && substr($s, $i, 1) eq '|') { $i++ }
      if ($i < $n && substr($s, $i, 1) eq '&') {          # >&2, >&-: a descriptor, not a file
        $i++;
        if (substr($s, $i) =~ /^(\d+|-)/) { $i += length $1; next; }
      }
      $redir = $mode; next;
    }
    if ($c eq '<' && substr($s, $i, 3) =~ /^<<(?!<)/) {   # a heredoc: <<WORD, <<-WORD, <<'WORD'
      $word->(); $i += 2;
      my $strip = 0;
      if ($i < $n && substr($s, $i, 1) eq '-') { $strip = 1; $i++ }
      $i++ while $i < $n && substr($s, $i, 1) =~ /[ \t]/;
      my $delim = '';
      while ($i < $n && substr($s, $i, 1) !~ /[\s;&|<>()]/) {
        my $d = substr($s, $i, 1);
        if ($d eq "'" || $d eq '"') {
          my $j = index($s, $d, $i + 1); $j = $n if $j < 0;
          $delim .= substr($s, $i + 1, $j - $i - 1); $i = $j + 1; next;
        }
        if ($d eq '\\' && $i + 1 < $n) { $delim .= substr($s, $i + 1, 1); $i += 2; next; }
        $delim .= $d; $i++;
      }
      push @heredocs, [$delim, $strip] if length $delim;
      next;
    }
    if ($c eq '<') { $word->(); $i++; $i++ while $i < $n && substr($s, $i, 1) =~ /[<&]/; $redir = 3; next; }
    $cur .= $c; $have = 1; $i++;
  }
  $cmd->();
  return @cmds;
}

sub targets {
  my ($s) = @_;
  my @out;
  for my $c (lex($s)) {
    my ($w, $r) = @$c;
    push @out, @$r;
    my @w = @$w;
    shift @w while @w && $w[0] =~ /^[A-Za-z_][A-Za-z0-9_]*=/;                 # VAR=value prefixes
    shift @w while @w && $w[0] =~ m{^(?:.*/)?(?:sudo|env|command|nohup|nice|time|exec)$};
    next unless @w;
    (my $prog = shift @w) =~ s{.*/}{};
    my @args = grep { !/^-/ } @w;
    if    ($prog eq 'tee')                                   { push @out, @args }
    elsif ($prog =~ /^(?:cp|mv|install|ln|rsync)$/)          {
      for my $k (0 .. $#w) { push @out, $w[$k + 1] if $w[$k] eq '-t' && defined $w[$k + 1] }
      push @out, $args[-1] if @args;
    }
    elsif ($prog eq 'mkdir')                                 { push @out, map { "\@$_" } @args }
    elsif ($prog =~ /^(?:rm|rmdir|unlink|truncate|touch|shred)$/) { push @out, @args }
    elsif ($prog =~ /^(?:chmod|chown|chgrp)$/)               { shift @args; push @out, @args }
    elsif ($prog eq 'sed' && grep { /^-[A-Za-z]*i|^--in-place/ } @w) {
      my (@f, $script);
      for (my $k = 0; $k < @w; $k++) {
        my $t = $w[$k];
        if ($t =~ /^(?:-e|-f|--expression|--file)$/) { $script = 1; $k++; next }  # script given by option
        if ($t =~ /^--(?:expression|file)=/) { $script = 1; next }
        if ($t eq '-i' && defined $w[$k + 1] && $w[$k + 1] eq '') { $k++; next }   # BSD: -i ''
        next if $t =~ /^-/ || $t eq '';
        push @f, $t;
      }
      shift @f unless $script;                                                  # first word is the script
      push @out, @f;
    }
    elsif ($prog =~ /^(?:perl|ruby)$/ && grep { /^-[A-Za-z]*i/ } @w) {
      my @f; for (my $k = 0; $k < @w; $k++) { if ($w[$k] =~ /^-[A-Za-z]*e$/) { $k++; next } push @f, $w[$k] unless $w[$k] =~ /^-/ }
      push @out, @f;
    }
    elsif ($prog eq 'dd')                                    { push @out, map { /^of=(.*)/ ? $1 : () } @w }
    elsif ($prog =~ /^(?:curl|wget)$/)                       {
      for my $k (0 .. $#w) { push @out, $w[$k + 1] if $w[$k] =~ /^(?:-o|--output|-O)$/ && defined $w[$k + 1] }
    }
    elsif ($prog eq 'git' && @args) {
      my $sub = $args[0];
      if ($sub =~ /^(?:checkout|restore)$/) {
        my $seen = 0; for (@w) { if ($_ eq '--') { $seen = 1; next } push @out, $_ if $seen }
      }
      elsif ($sub eq 'rm') { push @out, @args[1 .. $#args] }
      elsif ($sub eq 'mv' && @args > 2) { push @out, $args[-1] }
    }
  }
  # $HOME always expands (a command that resets HOME still gets checked against the real one);
  # $TMPDIR and $CLAUDE_PROJECT_DIR only when the command does not set them itself.
  my %env;
  for my $v (qw(HOME TMPDIR CLAUDE_PROJECT_DIR)) {
    next unless defined $ENV{$v} && length $ENV{$v};
    (my $rest = $s) =~ s/\$(?:\{$v\}|$v(?![A-Za-z0-9_]))//g;
    next if $v ne 'HOME' && $rest =~ /(?<![A-Za-z0-9_])$v(?![A-Za-z0-9_])/;
    $env{$v} = $ENV{$v};
  }
  for (@out) {
    s{^([+@]?)~(?=/|$)}{$1$env{HOME}} if exists $env{HOME};
    s{\$(?:\{(HOME|TMPDIR|CLAUDE_PROJECT_DIR)\}|(HOME|TMPDIR|CLAUDE_PROJECT_DIR)(?![A-Za-z0-9_]))}
     {my $v = $1 // $2; exists $env{$v} ? $env{$v} : "\$$v"}ge;
  }
  return grep { length && !m{^\+?/dev/} } @out;
}

my $mode = shift @ARGV // '';
if ($mode eq 'resolve') { my $base = shift @ARGV; print resolve($base, $_), "\n" for @ARGV }
elsif ($mode eq 'targets') { print "$_\n" for targets(join ' ', @ARGV) }
else { print STDERR "usage: guard-paths.pl resolve <base> <path>... | targets <command>\n"; exit 64 }
