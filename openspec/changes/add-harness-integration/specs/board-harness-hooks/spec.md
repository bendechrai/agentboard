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
payload shape, an internal error or running past its time budget of 2
seconds SHALL each end in exit 0 without blocking, and at most one line on
stderr. The command SHALL NOT write events, run `sync`, or touch the
network; the only state it may write is the inbox cursor in `session-start`.
Setting `AGENTBOARD_HOOKS=off` SHALL make every event exit 0 immediately.

#### Scenario: No board
- **WHEN** `agentboard hook pre-tool-use --strict` runs in a directory with no board
- **THEN** it exits 0 and prints nothing to stdout

#### Scenario: Garbage payload
- **WHEN** `agentboard hook stop` runs with stdin `not json`
- **THEN** it exits 0

#### Scenario: Time budget
- **WHEN** the cache is locked by another process for longer than 2 seconds and `agentboard hook pre-tool-use --strict` runs
- **THEN** it exits 0 within 3 seconds and does not block the tool call

#### Scenario: Escape hatch
- **WHEN** `AGENTBOARD_HOOKS=off` is set and `agentboard hook stop --strict` runs with a claimed, un-handed-off ticket
- **THEN** it exits 0 and prints nothing

#### Scenario: Read-only
- **WHEN** `pre-tool-use` and `stop` run against a board
- **THEN** the board's event files, cache and cursors are byte-identical afterwards

### Requirement: Hook actor resolution
The hook command SHALL take the actor from `--as` or `AGENTBOARD_ACTOR` only,
never from the OS user or the payload. With no actor, `session-start` SHALL
print one line telling the agent to set `AGENTBOARD_ACTOR` or pass `--as`,
and `stop` and `pre-tool-use` SHALL do nothing. Subagents and linked
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
actor currently holds. An empty inbox SHALL print only that line. The
output SHALL be at most 4000 characters, truncated with a line saying how
many entries were omitted and naming `agentboard inbox --as <actor>`.

#### Scenario: Inbox is delivered
- **WHEN** `hook session-start` runs for actor `impl` with two pending inbox entries
- **THEN** the context contains both entries and the held-ticket line, and a second run prints no entries

#### Scenario: Large inbox
- **WHEN** the inbox is larger than 4000 characters
- **THEN** the output is truncated at an entry boundary with the omitted count and the inbox command

### Requirement: Stop hook
`hook stop` SHALL check whether the actor still holds a ticket that is not
`blocked` and has no comment by the actor since its latest claim. When there is
none it SHALL do nothing. Otherwise, without `--strict` it SHALL exit 0 with
a `systemMessage` naming the ticket and the `handoff` and `comment` plus
`move ... blocked` commands; with `--strict` it SHALL exit 2 with the same
text on stderr, except that when the payload has `stop_hook_active` true it
SHALL NOT block again, so one stop produces at most one block.

#### Scenario: Forgot to hand off, warn mode
- **WHEN** `impl` holds T1 with no comment since the claim and `hook stop` runs
- **THEN** it exits 0 with a message naming T1 and `agentboard handoff`

#### Scenario: Forgot to hand off, strict mode
- **WHEN** the same state runs `hook stop --strict` with `stop_hook_active` false
- **THEN** it exits 2 and stderr names T1

#### Scenario: Strict mode does not loop
- **WHEN** the same state runs `hook stop --strict` with `stop_hook_active` true
- **THEN** it exits 0

#### Scenario: Blocked ticket is fine
- **WHEN** `impl` holds T1 in status `blocked` with a comment
- **THEN** `hook stop --strict` exits 0 with no output

#### Scenario: No claimed tickets
- **WHEN** the actor holds nothing
- **THEN** `hook stop --strict` exits 0 with no output

### Requirement: Pre-tool-use claim check
`hook pre-tool-use` SHALL act only when the payload's `tool_name` is `Edit`,
`Write`, `MultiEdit` or `NotebookEdit` and the target path is inside the
project root and not under `.board/`. It SHALL pass silently when the actor
holds at least one ticket. Otherwise, without `--strict`, it SHALL exit 0
with context telling the agent to claim a ticket (naming `agentboard
claim` and `agentboard inbox`) or to carry on if the work is not
ticketed; with `--strict` it SHALL deny the tool call with that text (exit
2). A given session SHALL be warned at most once per 10 minutes in warn mode,
tracked outside the board, so that a run of edits is not a run of warnings.

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
