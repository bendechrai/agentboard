#!/bin/sh
# End-to-end walkthrough of board sharing (add-board-sharing task 6.2),
# following README.md "Set up a project", "Sync between machines",
# "Keeping the board in a separate repository" and "Moving a board into
# the host repository" exactly, on temporary repositories with bare
# remotes on local disk. Run by hand, not by `make check`; its output is
# the transcript recorded in the pull request description.
#
#   make build && sh src/__tests__/walkthroughs/board-sharing.sh
#
# Part 1: clone A creates a host-model board, clone B joins it, both
# create and claim tickets, both sync, and the two boards are identical.
# Part 2, in a separate project: clones C and D share a standalone board
# through a bare board repository (init --remote), C moves it into the
# host (init --into-host), D edits .board/.gitignore and syncs to the old
# remote while C edits the same file and syncs to the host, D's move stops
# on that conflict, a human resolves it with the README's steps (resolve,
# git add, git rebase --continue, init --into-host again), and both clones
# end with every event and the merged .gitignore.
#
# AGENTBOARD names the command under test (default: the built CLI of this
# checkout). WALKTHROUGH_DIR keeps the repositories at a path of your
# choosing instead of a fresh temporary directory; the directory is never
# deleted, and its path is printed at the end. Git is isolated from your
# configuration (GIT_CONFIG_GLOBAL points at a file made here with the
# human identity the conflict resolution commits with), so nothing of
# yours is read or written.

set -eu

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
if [ -z "${AGENTBOARD:-}" ]; then
  if [ ! -f "$repo/dist/cli.js" ]; then
    echo "board-sharing.sh: $repo/dist/cli.js is missing; run make build first" >&2
    exit 1
  fi
  AGENTBOARD="node $repo/dist/cli.js"
fi

work="${WALKTHROUGH_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/board-sharing.XXXXXX")}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"

# Isolated git: a global configuration of our own, no system one, no
# editor, a deterministic default branch, and no agentboard variables that
# would point at another board or actor.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$work/gitconfig"
export GIT_EDITOR=true
export GIT_TERMINAL_PROMPT=0
unset AGENTBOARD_DIR AGENTBOARD_ACTOR
git config --file "$GIT_CONFIG_GLOBAL" user.name 'Walkthrough Human'
git config --file "$GIT_CONFIG_GLOBAL" user.email 'human@example.invalid'
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
git config --file "$GIT_CONFIG_GLOBAL" advice.detachedHead false

# ---------------------------------------------------------------------------
# Transcript helpers. Every command is printed as `[dir] $ command` before
# it runs, with its output below, so the whole run reads as a transcript.
# `run` fails the walkthrough on a non-zero exit; `expect_exit N` requires
# exactly N; both keep the output in $out for the checks that follow.
# `in` is the directory under $work the command runs in.
# ---------------------------------------------------------------------------

out=''
step=0

say() {
  printf '\n### %s\n\n' "$*"
}

show() {
  printf '[%s] $ %s\n' "$1" "$2"
}

run_in() {
  # run_in <dir> <command...>: runs the command, prints its output and
  # returns its status (an assignment with `|| status=$?` never trips
  # errexit, so the caller decides what a non-zero status means).
  dir="$1"
  shift
  show "$dir" "$*"
  status=0
  out="$(cd "$work/$dir" && "$@" 2>&1)" || status=$?
  [ -z "$out" ] || printf '%s\n' "$out"
  return $status
}

run() {
  got=0
  run_in "$@" || got=$?
  if [ "$got" -ne 0 ]; then
    echo "board-sharing.sh: '$*' exited $got; the walkthrough stops here" >&2
    exit 1
  fi
}

expect_exit() {
  # expect_exit <status> <dir> <command...>
  want="$1"
  shift
  got=0
  run_in "$@" || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "board-sharing.sh: '$*' exited $got, expected $want" >&2
    exit 1
  fi
  printf '(exit %s)\n' "$got"
}

expect_output() {
  # expect_output <text>: the last command's output contains <text>.
  case "$out" in
    *"$1"*) ;;
    *)
      echo "board-sharing.sh: expected the output above to contain: $1" >&2
      exit 1
      ;;
  esac
}

ab() {
  # ab <dir> <agentboard arguments...>: the command under test in <dir>.
  dir="$1"
  shift
  # shellcheck disable=SC2086
  run "$dir" $AGENTBOARD "$@"
}

ab_exit() {
  # ab_exit <status> <dir> <agentboard arguments...>
  want="$1"
  dir="$2"
  shift 2
  # shellcheck disable=SC2086
  expect_exit "$want" "$dir" $AGENTBOARD "$@"
}

ticket=''
new_ticket() {
  # new_ticket <dir> <actor> <title>: creates a ticket; its id is in $ticket.
  ab "$1" new "$3" --adhoc walkthrough --as "$2"
  ticket="$(printf '%s\n' "$out" | sed -n 's/^created \([A-Z0-9]*\).*/\1/p' | head -n 1)"
  [ -n "$ticket" ] || { echo "board-sharing.sh: no ticket id in the output above" >&2; exit 1; }
}

same_boards() {
  # same_boards <dir1> <dir2>: both clones list the same tickets and their
  # event directories hold the same files.
  a="$(cd "$work/$1" && $AGENTBOARD list --as walkthrough)"
  b="$(cd "$work/$2" && $AGENTBOARD list --as walkthrough)"
  if [ "$a" != "$b" ]; then
    echo "board-sharing.sh: $1 and $2 list different tickets" >&2
    exit 1
  fi
  if [ "$(ls "$work/$1/.board/events")" != "$(ls "$work/$2/.board/events")" ]; then
    echo "board-sharing.sh: $1 and $2 hold different event files" >&2
    exit 1
  fi
  printf '%s and %s hold the same %s event files and list the same tickets\n' "$1" "$2" "$(ls "$work/$1/.board/events" | grep -c json)"
}

project() {
  # project <name> <clone>: a bare remote <name>.git with one commit,
  # cloned as <clone> with origin set and main pushed.
  run . git init --bare "$1.git"
  run . git clone "$work/$1.git" "$2"
  (cd "$work/$2" && printf '# %s\n' "$1" > README.md)
  run "$2" git add README.md
  run "$2" git commit -q -m "Start $1"
  run "$2" git push -q -u origin main
}

printf 'board sharing walkthrough in %s\n' "$work"
printf 'agentboard: %s\n' "$AGENTBOARD"
run . sh -c "$AGENTBOARD version"
run . git --version

# ===========================================================================
say 'Part 1: a host-model board created in clone A and joined from clone B'
# README "Set up a project": init once at the root of the main checkout.
# ===========================================================================

project project A

ab A init
expect_output 'host model: a worktree of the host repository at refs/agentboard/board'
expect_output 'a new empty board'
# README: init adds .board/ to the host .gitignore; commit that change.
run A git status --porcelain
expect_output '?? .gitignore'
run A git add .gitignore
run A git commit -q -m 'Ignore the board'
run A git push -q origin main
run A git worktree list
run A git for-each-ref refs/agentboard/
run A git branch --list

new_ticket A agent-a 'Set up CI'
ticket_a="$ticket"
ab A claim "$ticket_a" --as agent-a
ab A list --as agent-a

# README "Sync between machines": sync commits the events and pushes the ref.
ab A sync
expect_output 'pushed refs/agentboard/board to origin'
run . git -C project.git for-each-ref refs/agentboard/
run . git -C project.git branch --list

# A second clone: clone the project and run init at its root.
run . git clone "$work/project.git" B
ab B init
expect_output 'joined 2 events from origin'
ab B list --as agent-b
expect_output "$ticket_a"
ab B remote
expect_output 'host'

new_ticket B agent-b 'Write the docs'
ticket_b="$ticket"
ab B claim "$ticket_b" --as agent-b
ab B sync
expect_output 'pushed refs/agentboard/board to origin'

# Back in A: sync integrates B's events.
ab A sync
expect_output 'arrived'
ab A list --as agent-a
expect_output "$ticket_b"
ab A rebuild --check
ab B rebuild --check
same_boards A B

# Nothing of the board is a branch anywhere, and the ref is the same everywhere.
run A git branch -a
run . sh -c "git -C A rev-parse refs/agentboard/board; git -C B rev-parse refs/agentboard/board; git -C project.git rev-parse refs/agentboard/board"
ab A remote
ab B init
expect_output 'board already exists'

# ===========================================================================
say 'Part 2: a standalone board shared by clones C and D, moved into the host'
# README "Keeping the board in a separate repository", then "Moving a
# board into the host repository".
# ===========================================================================

project project2 C

# C: a standalone board in a bare repository beside the project, created
# by init --remote (the path is relative to the project's top level).
ab C init --remote ../boards/project2.git
expect_output 'standalone model'
run . git -C boards/project2.git branch --list
run C git add .gitignore
run C git commit -q -m 'Ignore the board'
run C git push -q origin main
new_ticket C agent-c 'Design the schema'
ticket_c="$ticket"
ab C claim "$ticket_c" --as agent-c
ab C sync

# D: the same command on another clone clones the board.
run . git clone "$work/project2.git" D
ab D init --remote ../boards/project2.git
expect_output 'cloned the board at'
expect_output 'standalone model'
ab D list --as agent-d
expect_output "$ticket_c"
new_ticket D agent-d 'Review the schema'
ticket_d="$ticket"
ab D claim "$ticket_d" --as agent-d
ab D sync
ab C sync
same_boards C D
ab C remote
expect_output 'standalone'

# Move, first clone first. C's standalone board is fully synced, so the
# move is allowed; it publishes refs/agentboard/board on project2.git.
ab C init --into-host
expect_output 'moved the board at'
expect_output 'the old board repository is kept at'
expect_output 'its remote was'
expect_output 'pushed refs/agentboard/board to origin'
ab C remote
expect_output 'host'
ab C init --into-host
expect_output 'is already in the host repository'
run . git -C project2.git for-each-ref refs/agentboard/

# Meanwhile D, not moved yet, keeps syncing through the old remote: a
# ticket comment and an edit to .board/.gitignore (the one path that can
# conflict), while C edits the same file differently in the host model.
ab D comment "$ticket_d" --as agent-d 'Reviewed in clone D before its move'
(cd "$work/D" && printf '# notes kept by clone D\n' >> .board/.gitignore)
ab D sync
expect_output 'committed'
(cd "$work/C" && printf '# scratch files of clone C\n' >> .board/.gitignore)
ab C sync
expect_output 'committed'
expect_output 'pushed refs/agentboard/board to origin'

# D's move finds C's ref on origin and rebases D's history onto it; the
# two .gitignore edits conflict, so the move stops with exit 3 and leaves
# the rebase in a temporary worktree, the old .board untouched.
ab_exit 3 D init --into-host
expect_output 'stopped on a conflict in the temporary worktree'
expect_output 'git rebase --continue'
ab D remote
expect_output 'standalone'
temp="$(find "$work/D/.git/agentboard/migrating" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -n "$temp" ] || { echo 'board-sharing.sh: no temporary worktree under D/.git/agentboard/migrating' >&2; exit 1; }
printf 'temporary worktree: %s\n' "$temp"
run . git -C "$temp" status --short
expect_output 'UU .gitignore'

# A re-run while the rebase is in progress refuses and removes nothing.
ab_exit 3 D init --into-host
expect_output 'is still in progress in the temporary worktree'

# The human's steps from the README: resolve the paths (keep both lines),
# git add them, git rebase --continue in that worktree.
run . git -C "$temp" diff
(cd "$temp" && grep -v '^[<=>|]\{7\}' .gitignore > .gitignore.resolved && mv .gitignore.resolved .gitignore)
run . cat "$temp/.gitignore"
run . git -C "$temp" add .gitignore
run . git -C "$temp" rebase --continue
run . git -C "$temp" status --short

# Then init --into-host again, which adopts the finished rebase.
ab D init --into-host
expect_output 'moved the board at'
expect_output 'pushed refs/agentboard/board to origin'
ab D remote
expect_output 'host'
run D sh -c 'ls .git/agentboard; ls .git/agentboard/migrating 2>/dev/null || echo "(no temporary worktree)"'

# Both clones sync and agree, .gitignore included.
ab C sync
expect_output 'arrived'
ab D sync
ab C list --as agent-c
ab C show "$ticket_d" --as agent-c
expect_output 'Reviewed in clone D before its move'
ab C rebuild --check
ab D rebuild --check
same_boards C D
run . diff C/.board/.gitignore D/.board/.gitignore
run . cat C/.board/.gitignore
expect_output '# notes kept by clone D'
expect_output '# scratch files of clone C'
run . sh -c "git -C C rev-parse refs/agentboard/board; git -C D rev-parse refs/agentboard/board; git -C project2.git rev-parse refs/agentboard/board"

# Retire the old remote once remote reports host in every clone.
ab C remote
expect_output 'host'
ab D remote
expect_output 'host'
run . rm -rf boards/project2.git
ab C sync
ab D sync

say "done; the repositories are kept in $work"
