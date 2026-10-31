## Purpose

Defines the `agentboard hook` command and the Claude Code hooks that call
it, so that a coding harness reminds its agent to check the inbox, claim
before editing and hand off before stopping, without ever making the board
a point of failure for the agent's work.

## ADDED Requirements

### Requirement: Hook command and protocol
`agentboard hook <event> [--strict]`, where `<event>` is `session-start`,
`stop` or `pre-tool-use`, SHALL read the harness's JSON payload from stdin
(an absent, empty or malformed payload is treated as `{}`) and answer in
Claude Code's hook protocol: exit 0 with an optional JSON document on
stdout, or, only in strict mode, exit 2 with the reason on stderr. Any
other outcome SHALL be exit 0 and no output. The command SHALL fail open:
no board, an unreadable or locked cache, an unresolvable actor, an unknown
payload shape, a process directory that no longer exists, stdout or
stderr closed early or failing (a broken pipe, a full device), an
internal error or running past its time budget of 2 seconds SHALL each
end in exit 0 without blocking (or the strict exit 2 the event's
requirement gives), with at most one line on stderr and never a stack
trace. So SHALL an unknown event or any other error in the command's own
arguments, whose line names the three events. The budget is measured
from the start of the process and covers everything the command does,
Node's start-up and board discovery (its `git` child included) among
them; a `git` child of discovery that has not answered when the budget
runs out counts as git failing, so discovery falls back to `./.board`
(board-events discovery rules); so does a `git` child that ignores
being told to stop. No stderr line SHALL repeat any part of the payload
(its `cwd` included), the actor, the event argument or other refused
input (board-cli "Refusals never repeat the refused input"). The command
SHALL NOT write events, run `sync`, or touch the network; the only board
state it may write is the inbox cursor in `session-start`, and outside the
board only `pre-tool-use` in warn mode writes, its rate-limit file in the
OS temporary directory. It SHALL read the cache as
it is and SHALL NOT catch up: it folds no event file, writes no due grant
(board-cli "Due grants are written during catch-up"), reaps no temporary
file, and never creates, recreates or rebuilds the cache; a missing cache,
or one of another schema version, counts as unreadable. Known limit: the
cache is opened read-write for inspection, as `rebuild --check` opens it,
so after an unclean shutdown that left a non-empty write-ahead log, the
hook's connection, being the last one to close, checkpoints that log into
`cache.sqlite` and removes it; the cache's content is unchanged but its
bytes may differ. Every scenario below assumes a cleanly closed cache. It SHALL never
claim, renew, release or join or leave a queue. Setting
`AGENTBOARD_HOOKS=off` (exactly `off`) SHALL make every event exit 0
immediately, with no output, before stdin, the arguments or the board are
read.

#### Scenario: No board
- **WHEN** `agentboard hook pre-tool-use --strict` runs in a directory with no board
- **THEN** it exits 0 and prints nothing to stdout

#### Scenario: Garbage payload
- **WHEN** `agentboard hook stop` runs with stdin `not json`
- **THEN** it exits 0

#### Scenario: Unknown event is not repeated
- **WHEN** `agentboard hook <token>` runs with a token-shaped word, with and without `--json`
- **THEN** it exits 0, prints at most one line on stderr naming `session-start`, `stop` and `pre-tool-use`, and the token appears nowhere in stdout or stderr

#### Scenario: Cache of another schema version
- **WHEN** the board's cache was made by an earlier agentboard and `agentboard hook pre-tool-use --strict` runs
- **THEN** it exits 0 without blocking, and the cache file is byte-identical afterwards

#### Scenario: Time budget
- **WHEN** the cache is locked by another process for longer than 2 seconds and `agentboard hook pre-tool-use --strict` runs
- **THEN** it exits 0 within 3 seconds and does not block the tool call

#### Scenario: Removed working directory
- **WHEN** the hook process starts in a directory that has been removed (an agent's worktree deleted under it)
- **THEN** it exits 0 with at most one line on stderr and no stack trace

#### Scenario: Output closed or failing
- **WHEN** the hook's stdout is a pipe the reader has closed, or a device that is full
- **THEN** it exits 0 with at most one line on stderr and no stack trace

#### Scenario: Slow discovery
- **WHEN** the `git` that board discovery runs does not answer and `agentboard hook pre-tool-use --strict` runs
- **THEN** it exits 0 within 3 seconds of the start of its process

#### Scenario: Slow start-up
- **WHEN** the process takes 1.5 seconds to start before the hook code runs, and the cache is locked
- **THEN** it exits 0 within 3 seconds of the start of its process

#### Scenario: Escape hatch
- **WHEN** `AGENTBOARD_HOOKS=off` is set and `agentboard hook stop --strict` runs with a claimed, un-handed-off ticket
- **THEN** it exits 0 and prints nothing

#### Scenario: Read-only
- **WHEN** `pre-tool-use` and `stop` run against a board, including one where a grant is due and not yet written and one with a stale temporary file in its events directory
- **THEN** the board's event files, temporary files, cache and cursors are byte-identical afterwards

### Requirement: Hook actor resolution
The hook command SHALL take the actor from `--as` or `AGENTBOARD_ACTOR` only,
never from the OS user or the payload. A ticket the actor holds is an open
ticket whose assignee is the actor, whatever the state of its lease (a
lapsed lease is held until another actor takes it over, as board-cli
"Leases on the command line" defines); being queued for a ticket is not
holding it. A name a writing command could not use (the reserved actor
`agentboard`, a name matching a secret pattern, or one outside the actor
form of the change `actor-secret-check`) counts as no actor and is never
repeated. With no actor, `session-start` SHALL, where a board is found,
print one line telling the agent to set `AGENTBOARD_ACTOR` or pass `--as`,
and `stop` and `pre-tool-use` SHALL do nothing. The payload's `cwd` is
used when it names an existing directory, and the process directory
otherwise. Subagents and linked
worktrees of the same session inherit the process environment and are
therefore the same actor; board discovery in a linked worktree uses the
payload's `cwd` and the usual discovery rules.

#### Scenario: Unresolvable actor at session start
- **WHEN** `agentboard hook session-start` runs with no actor
- **THEN** it exits 0 and prints one line naming `AGENTBOARD_ACTOR` and `--as`

#### Scenario: Unresolvable actor elsewhere
- **WHEN** `agentboard hook pre-tool-use --strict` runs with no actor
- **THEN** it exits 0 and prints nothing

#### Scenario: Worktree
- **WHEN** the payload's `cwd` is a linked worktree of the project that owns the board
- **THEN** the hook finds the board and answers as in the main checkout

### Requirement: Session start hook
`hook session-start` SHALL print, as context for the agent, the output of
`agentboard inbox` for the actor (advancing the actor's cursor like the
command does), preceded by one line naming the actor and the tickets the
actor currently holds, each with its assignee token as `list` shows it
(so an unconfirmed, expired or claimable lease is visible, for example
`impl*+2m`, written `<id> <token>`). Each inbox entry is one line, as
`agentboard inbox` prints it. Because the hook does not catch up, a grant
that is due but not yet written, and any event file not yet folded into
the cache, is not delivered (nor skipped) until the next `inbox`. An empty
inbox SHALL print only that line, and SHALL write nothing. The output SHALL
be at most 4000 characters, truncated at an entry boundary with a line
saying how many entries were omitted and naming `agentboard inbox --as
<actor>`; the cursor SHALL then advance over the delivered entries only,
so the next `inbox` lists exactly the omitted ones. The held-ticket line is
cut at a ticket boundary to at most 2000 characters, ending with `and <n>
more`. The answer is the `SessionStart` `additionalContext`.

#### Scenario: Inbox is delivered
- **WHEN** `hook session-start` runs for actor `impl` with two pending inbox entries
- **THEN** the context contains both entries and the held-ticket line, and a second run prints no entries

#### Scenario: Held lease is shown with its state
- **WHEN** `merger-1` holds T1 under an unconfirmed lease and `hook session-start --as merger-1` runs
- **THEN** the held-ticket line names T1 with the token `list` shows for it, including `*`

#### Scenario: Large inbox
- **WHEN** the inbox is larger than 4000 characters
- **THEN** the output is truncated at an entry boundary with the omitted count and the inbox command

#### Scenario: Omitted entries stay in the inbox
- **WHEN** a truncated `hook session-start` has run
- **THEN** the next `agentboard inbox` lists exactly the omitted entries

#### Scenario: A hand-off or a grant makes a holder
- **WHEN** `reviewer` hands T1 to `impl`, or the queue grants M1 to `merger-2`
- **THEN** the held-ticket line of `impl`, or of `merger-2`, names that ticket with its token

### Requirement: Stop hook
`hook stop` SHALL check whether the actor still holds a ticket that is not
`blocked` and has no comment by the actor since the actor last became its
assignee (by a claim, a grant from the queue or a hand-off to it); a
comment is a `ticket.comment` or a hand-off note. When there is
none it SHALL do nothing. Every such ticket is named, in id order. Otherwise, without `--strict` it SHALL exit 0 with
a `systemMessage` naming the ticket and the `handoff` and `comment` plus
`move ... blocked` commands, and, for a ticket held under a lease (such as
a mutex ticket), first `agentboard release <id> --as <actor>`, since a
lock is released when done (board-agent-guidance "Mutex ticket recipe");
with `--strict` it SHALL exit 2 with the same
text on stderr, except that when the payload has `stop_hook_active` true it
SHALL NOT block again, so one stop produces at most one block: it answers
as warn mode does. `release` is named only for a ticket with a lease, and
the warn answer never carries a `decision`.

#### Scenario: Forgot to hand off, warn mode
- **WHEN** `impl` holds T1 with no comment since the claim and `hook stop` runs
- **THEN** it exits 0 with a message naming T1 and `agentboard handoff`

#### Scenario: Forgot to hand off, strict mode
- **WHEN** the same state runs `hook stop --strict` with `stop_hook_active` false
- **THEN** it exits 2 and stderr names T1

#### Scenario: Strict mode does not loop
- **WHEN** the same state runs `hook stop --strict` with `stop_hook_active` true
- **THEN** it exits 0

#### Scenario: Held mutex names release
- **WHEN** `merger-1` holds the mutex ticket M1 under a lease, granted from the queue, with no comment since, and `hook stop` runs
- **THEN** it exits 0 with a message naming M1 and `agentboard release`

#### Scenario: Handed back without a new comment
- **WHEN** `impl` commented on T1, handed it to `reviewer`, and `reviewer` handed it back to `impl`
- **THEN** `hook stop` names T1

#### Scenario: Blocked ticket is fine
- **WHEN** `impl` holds T1 in status `blocked` with a comment
- **THEN** `hook stop --strict` exits 0 with no output

#### Scenario: No claimed tickets
- **WHEN** the actor holds nothing
- **THEN** `hook stop --strict` exits 0 with no output

### Requirement: Pre-tool-use claim check
`hook pre-tool-use` SHALL act only when the payload's `tool_name` is `Edit`,
`Write`, `MultiEdit` or `NotebookEdit` and the target path
(`tool_input.file_path`, or `notebook_path` for `NotebookEdit`, resolved
against the payload's `cwd` when relative) is inside the project and not
under `.board/`. The project is the directory holding the board directory
and the checkout or linked worktree the payload's `cwd` is in (the nearest
directory at or above it holding a `.git` entry); a sibling directory
sharing a name prefix is outside. It SHALL pass silently when the actor
holds at least one ticket. Otherwise, without `--strict`, it SHALL exit 0
with context telling the agent to claim a ticket (naming `agentboard
claim` and `agentboard inbox`) or to carry on if the work is not
ticketed, and never with a `permissionDecision` (an `allow` would skip
the user's permission prompt); with `--strict` it SHALL deny the tool call
with that text (exit 2), every time. A given session (the payload's
`session_id`) SHALL be warned at most once per 10 minutes in warn mode,
tracked outside the board in a file of the OS temporary directory named by
a hash of the session id and replaced atomically, so that a run of edits is
not a run of warnings; a payload without a session id is warned every
time.

#### Scenario: Edit with a claim
- **WHEN** `impl` holds T1 and the payload is an `Edit` of a project file
- **THEN** the hook exits 0 and prints nothing

#### Scenario: Edit without a claim, warn mode
- **WHEN** `impl` holds nothing and the payload is a `Write` of a project file
- **THEN** it exits 0 with context naming `agentboard claim`

#### Scenario: Edit without a claim, strict mode
- **WHEN** the same runs with `--strict`
- **THEN** it exits 2 with the reason on stderr

#### Scenario: Other tools and paths
- **WHEN** the tool is `Read`, or the path is outside the project root, or under `.board/`
- **THEN** it exits 0 with no output in both modes

#### Scenario: Warnings are rate limited
- **WHEN** warn mode runs for five consecutive edits in one session without a claim
- **THEN** only the first prints a warning

#### Scenario: The warning comes back after 10 minutes
- **WHEN** 10 minutes have passed since a session's last warning and it edits without a claim
- **THEN** it is warned again

#### Scenario: Edit in a linked worktree
- **WHEN** the payload's `cwd` is a linked worktree and the target is a file of that worktree
- **THEN** the edit is checked as a project file

### Requirement: Hooks installed in Claude settings
The `claude-hooks` target SHALL merge three hook entries into the project's
`.claude/settings.json`, creating it if absent: `SessionStart` running
`hook session-start`, `Stop` running `hook stop` and `PreToolUse` with
matcher `Edit|Write|MultiEdit|NotebookEdit` running `hook pre-tool-use`.
Each is a `command` hook with a `timeout` of at most 5 seconds and a command
ending in the comment `# agentboard-hooks: v<N>`, which marks it as owned.
The executable is `npx -y @bendechrai/agentboard`, or the `--command`
executable when given. The hooks SHALL be in warn mode unless `agents
install --hooks-strict` is given, which appends `--strict`; reinstalling in
the other mode SHALL update the owned entries without `--force`. Existing
keys, other hooks and their order SHALL be preserved, and reinstalling
SHALL add no duplicate entry.

#### Scenario: Fresh install is warn-only
- **WHEN** `agents install --target claude-hooks` runs in a project with no `.claude/settings.json`
- **THEN** the file has the three entries, none containing `--strict`, each with a marker and a timeout of 5 or less

#### Scenario: Strict is opt-in
- **WHEN** `agents install --target claude-hooks --hooks-strict` runs over a warn-mode install
- **THEN** the three commands gain `--strict` and nothing else in the file changes

#### Scenario: Idempotent
- **WHEN** the install runs twice
- **THEN** the second run changes no byte and the file has exactly three agentboard entries

#### Scenario: Local executable
- **WHEN** `agents install --target claude-hooks --command agentboard` runs
- **THEN** the hook commands begin `agentboard hook`
