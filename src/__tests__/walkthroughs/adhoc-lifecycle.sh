#!/bin/sh
# End-to-end walkthrough of the ad hoc ticket lifecycle
# (add-adhoc-ticket-lifecycle task 6.1), following README.md "Tickets and
# task references", "Working a ticket", "Decisions and closing tickets" and
# "Board health" exactly, on a temporary board. Run by hand, not by `make
# check`; its output is the transcript recorded in the pull request
# description. When it diverges from the README, the README is wrong: fix
# the README, not this script.
#
#   make build && sh src/__tests__/walkthroughs/adhoc-lifecycle.sh
#
# An ad hoc ticket is created, claimed and moved from todo through tests
# and implementing to review like any other ticket; `move merged` is
# refused with needs-scope-disposition and the hint naming both flags;
# `move merged --unplanned` succeeds and the ticket shows [unplanned]; a
# second disposition on a linked ticket is refused already-linked; and
# `health` lists the unplanned scope, in text and in JSON.
#
# AGENTBOARD names the command under test (default: the built CLI of this
# checkout). WALKTHROUGH_DIR keeps the board at a path of your choosing
# instead of a fresh temporary directory; the directory is never deleted,
# and its path is printed at the end.

set -eu

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
if [ -z "${AGENTBOARD:-}" ]; then
  if [ ! -f "$repo/dist/cli.js" ]; then
    echo "adhoc-lifecycle.sh: $repo/dist/cli.js is missing; run make build first" >&2
    exit 1
  fi
  AGENTBOARD="node $repo/dist/cli.js"
fi

work="${WALKTHROUGH_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/adhoc-lifecycle.XXXXXX")}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"

# No agentboard variables that would point at another board or actor, and
# git isolated from your configuration (init makes a standalone board,
# which is a git repository of its own).
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_TERMINAL_PROMPT=0
unset AGENTBOARD_DIR AGENTBOARD_ACTOR
git config --file "$GIT_CONFIG_GLOBAL" user.name 'Walkthrough Human'
git config --file "$GIT_CONFIG_GLOBAL" user.email 'human@example.invalid'
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

# ---------------------------------------------------------------------------
# Transcript helpers, as in board-sharing.sh: every command is printed as
# `$ command` before it runs, with its output below. `run` fails the
# walkthrough on a non-zero exit; `expect_exit N` requires exactly N; both
# keep the output in $out for the checks that follow.
# ---------------------------------------------------------------------------

out=''

say() {
  printf '\n### %s\n\n' "$*"
}

run_cmd() {
  printf '$ %s\n' "$*"
  status=0
  out="$(cd "$work" && "$@" 2>&1)" || status=$?
  [ -z "$out" ] || printf '%s\n' "$out"
  return $status
}

run() {
  got=0
  run_cmd "$@" || got=$?
  if [ "$got" -ne 0 ]; then
    echo "adhoc-lifecycle.sh: '$*' exited $got; the walkthrough stops here" >&2
    exit 1
  fi
}

expect_exit() {
  # expect_exit <status> <command...>
  want="$1"
  shift
  got=0
  run_cmd "$@" || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "adhoc-lifecycle.sh: '$*' exited $got, expected $want" >&2
    exit 1
  fi
  printf '(exit %s)\n' "$got"
}

expect_output() {
  # expect_output <text>: the last command's output contains <text>.
  case "$out" in
    *"$1"*) ;;
    *)
      echo "adhoc-lifecycle.sh: expected the output above to contain: $1" >&2
      exit 1
      ;;
  esac
}

refuse_output() {
  # refuse_output <text>: the last command's output does not contain <text>.
  case "$out" in
    *"$1"*)
      echo "adhoc-lifecycle.sh: expected the output above not to contain: $1" >&2
      exit 1
      ;;
    *) ;;
  esac
}

ab() {
  # shellcheck disable=SC2086
  run $AGENTBOARD "$@"
}

ab_exit() {
  want="$1"
  shift
  # shellcheck disable=SC2086
  expect_exit "$want" $AGENTBOARD "$@"
}

ticket_id() {
  # ticket_id: the id in the last command's `created <id>` line.
  id="$(printf '%s\n' "$out" | sed -n 's/^created \([A-Z0-9]*\).*/\1/p' | head -n 1)"
  [ -n "$id" ] || { echo "adhoc-lifecycle.sh: no ticket id in the output above" >&2; exit 1; }
  printf '%s' "$id"
}

printf 'ad hoc lifecycle walkthrough in %s\n' "$work"
printf 'agentboard: %s\n' "$AGENTBOARD"
run sh -c "$AGENTBOARD version"

# ===========================================================================
say 'An ad hoc ticket is worked like any other: todo, tests, implementing, review'
# README "Tickets and task references": a ticket that is not planned work
# says why with --adhoc, and moves through every status like any other.
# ===========================================================================

ab init
ab new "Fix typo in footer" --as orchestrator --adhoc "reported by a user"
expect_output '[adhoc] Fix typo in footer'
t="$(ticket_id)"
ab claim "$t" --as impl-1
ab move "$t" tests --as impl-1
expect_output "$t  tests  impl-1  [adhoc] Fix typo in footer"
ab move "$t" implementing --as impl-1
expect_output "$t  implementing  impl-1  [adhoc] Fix typo in footer"
ab move "$t" review --as impl-1
expect_output "$t  review  impl-1  [adhoc] Fix typo in footer"
ab list --as impl-1
expect_output '[adhoc]'

# ===========================================================================
say 'Merging needs the scope disposition: refused without one, with the hint'
# README: move merged on an undisposed ad hoc ticket exits 4
# needs-scope-disposition; the hint names --task and --unplanned and says
# not to create an issue or task only to satisfy it.
# ===========================================================================

ab_exit 4 move "$t" merged --as reviewer-1
expect_output "agentboard: ticket.move on ticket $t refused: needs-scope-disposition"
expect_output "hint: merging needs the scope of the work: run 'agentboard move $t merged --task <source>:<ref>#<item> --as reviewer-1' (or --change <name> --group <n>) naming the planned task it delivered, or 'agentboard move $t merged --unplanned \"<reason>\" --as reviewer-1' saying why it was never planned; do not create an issue or task only to satisfy this"
ab_exit 4 move "$t" merged --as reviewer-1 --json
expect_output '{"error":{"exitCode":4,"reason":"needs-scope-disposition"'
# A flag without the target merged is a usage error, before the board is read.
ab_exit 1 move "$t" implementing --unplanned "x" --as reviewer-1
# The ticket is still in review, and nothing was written.
ab show "$t" --as reviewer-1
expect_output 'status: review'
expect_output 'events: 5'

# ===========================================================================
say 'move merged --unplanned records the disposition and the move together'
# ===========================================================================

ab move "$t" merged --as reviewer-1 --unplanned "production hotfix"
expect_output "$t  merged  impl-1  [unplanned] Fix typo in footer"
ab list --as reviewer-1
expect_output '[unplanned]'
refuse_output '[adhoc]'
ab show "$t" --as reviewer-1
expect_output 'status: merged'
expect_output 'adhoc: reported by a user'
expect_output 'unplanned: production hotfix (by reviewer-1)'
expect_output 'events: 7'
ab show "$t" --as reviewer-1 --json
expect_output '"unplanned":{"actor":"reviewer-1","reason":"production hotfix"'

# ===========================================================================
say 'A ticket that names a planned task needs no disposition, and refuses one'
# README: --unplanned on a linked ticket exits 4 already-linked.
# ===========================================================================

ab new "Login form" --as orchestrator --change add-login --group 2
p="$(ticket_id)"
ab move "$p" tests --as test-1
ab move "$p" implementing --as impl-1
ab move "$p" review --as impl-1
ab_exit 4 move "$p" merged --as reviewer-1 --unplanned "not planned"
expect_output "refused: already-linked (it is linked to openspec:add-login#2)"
expect_output "run 'agentboard move $p merged --as reviewer-1' (without --unplanned)"
ab move "$p" merged --as reviewer-1
expect_output "$p  merged  -  Login form"

# An ad hoc ticket linked at merge with --task is indistinguishable from
# one linked earlier: it shows the task reference and no marker.
ab new "Validate the form" --as orchestrator --adhoc "found while testing"
l="$(ticket_id)"
ab move "$l" tests --as test-1
ab move "$l" implementing --as impl-1
ab move "$l" review --as impl-1
ab move "$l" merged --as reviewer-1 --task openspec:add-login#2
expect_output "$l  merged  -  Validate the form"
ab show "$l" --as reviewer-1
expect_output 'task: openspec:add-login#2'
refuse_output 'adhoc:'

# ===========================================================================
say 'Closing an abandoned ad hoc ticket from blocked takes the same flags'
# README "Decisions and closing tickets".
# ===========================================================================

ab new "Try a new parser" --as orchestrator --adhoc "spike"
s="$(ticket_id)"
ab move "$s" blocked --as impl-2
ab comment "$s" --as impl-2 "superseded by the planned parser work"
ab_exit 4 close "$s" --as orchestrator --no-decision
expect_output "cannot be closed: needs-scope-disposition (it has neither a task reference nor an unplanned disposition; give --task or --unplanned)"
expect_output "run 'agentboard close $s --no-decision --task <source>:<ref>#<item> --as orchestrator'"
expect_output "'agentboard close $s --no-decision --unplanned \"<reason>\" --as orchestrator'"
ab close "$s" --as orchestrator --no-decision --unplanned "abandoned: superseded"
ab list --as orchestrator --closed
expect_output "$s  blocked  -  [unplanned] [closed] Try a new parser"

# ===========================================================================
say 'health lists the unplanned scope as information'
# README "Board health": the unplanned scope section, in text and in JSON.
# ===========================================================================

ab health
expect_output 'unplanned scope: 2 in the last 7d (2 in all)'
expect_output "$s  blocked  -  [unplanned] [closed] Try a new parser  closed just now, unplanned: abandoned: superseded"
expect_output "$t  merged  impl-1  [unplanned] Fix typo in footer  merged just now, unplanned: production hotfix"
ab health --unplanned-within 1m
expect_output 'unplanned scope: 2 in the last 1m (2 in all)'
ab_exit 1 health --unplanned-within 7days
expect_output 'invalid --unplanned-within 7days'
run sh -c "$AGENTBOARD health --json | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);console.log(JSON.stringify({thresholds:j.thresholds,unplannedScope:{total:j.unplannedScope.total,tickets:j.unplannedScope.tickets.map(t=>({ticket:t.ticket.shortId,adhoc:t.adhoc,reason:t.reason,outcome:t.outcome,since:t.since.kind,ageMs:t.ageMs}))}},null,2))})'"
expect_output '"unplannedWithin": 604800000'
expect_output '"total": 2'
expect_output '"outcome": "closed"'
expect_output '"outcome": "merged"'
expect_output '"reason": "production hotfix"'
expect_output '"since": "ticket.unplanned"'

# The README's single-ticket example: the section with one unplanned merge.
ab health --json
expect_output '"unplannedScope"'
ab rebuild --check

say "done; the board is kept in $work"
