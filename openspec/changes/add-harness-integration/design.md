# Design

## Context

`agents install` (src/guidance) owns marked regions in `SKILL.md`,
`AGENTS.md`, `openspec/config.yaml` and `.mcp.json`, refuses foreign
content unless `--force`, and `agents check` reports `current`, `stale` or
`modified`. Harness files differ in format (markdown, JSON, TOML, mdc) but
every one fits "marked block in text" or "owned key in JSON". Claude Code
hooks run a shell command on an event, pass JSON on stdin, and treat exit 0
as continue and exit 2 as block (stderr is fed back to the agent). See
proposal.md for motivation.

## Goals / Non-Goals

**Goals:** reuse the existing region, refusal and check machinery for every
new target; make hooks safe to leave on; make each target provably loadable.

**Non-Goals:** user-level config under `~`; enforcement for harnesses
without hooks; the release workflow; a general TOML library.

## Decisions

1. **One command, `hook <event>`, not shell snippets.** Logic lives in
   tested TypeScript behind the registry. Alternative: inline shell in
   settings.json; rejected as untestable and hard to version. The command
   is excluded from MCP and exempt from the usual exit codes (0 and 2 are the
   harness protocol; the usual 2 "board not found" would otherwise block).
2. **Hooks are warn-only by default; `--hooks-strict` is an explicit opt-in.**
   Warn output goes to the agent as context (`session-start`, `pre-tool-use`)
   or to the user as a `systemMessage` (`stop`).
3. **Fail open and be fast.** Hook mode is read-only, never syncs, never
   catches up (no fold, no due grant, no reaping, no cache rebuild), has a 2
   second internal deadline and a settings `timeout` of 5 seconds, and
   treats every error as "allow". A hook that cannot do its job must be
   invisible rather than a reason the agent cannot edit.
4. **Ownership marker for hooks is a shell comment** (`# agentboard-hooks:
   v<N>`) at the end of each command string, since JSON has no comments. The
   whole entry is owned if its command ends with the marker; `check` renders
   the three expected commands for the recorded version and mode and
   compares.
5. **Global MCP config is never edited by default.** Codex
   (`$CODEX_HOME/config.toml`) and Antigravity (`~/.gemini/config/mcp_config.json`)
   keep MCP servers in the user's global config, shared by all projects.
   `agents install` prints the exact `codex mcp add` / `agy mcp add` command
   instead, and edits the file only for an explicit `--target` with `--global`.
   Alternative: write it silently; rejected as surprising and unsafe.
   Under `--global`, Codex's `config.toml` gets a block between `# agentboard:start v<N>` and `# agentboard:end` holding
   `[mcp_servers.agentboard]`. Install refuses when a table of that name
   exists outside the markers (a line scan for the header). Avoids a
   dependency and preserves user bytes. Alternative: a TOML library that
   round-trips comments; none is dependency-free and comment-preserving.
5a. **Antigravity reuses the `AGENTS.md` block.** `agy` reads `AGENTS.md` or
   `GEMINI.md` workspace rules from the cwd up to the repo root (24 KB per file,
   20000 tokens in total), so no new rules file is written and the block is
   capped at 4096 bytes with a check warning for an oversized `AGENTS.md`.
   `.agents/skills.json` and `.agents/plugins.json` are not written: `agy
   --help` documents no schema for them (see Open Questions). The
   global MCP file format is confirmed by the sandbox suite with `agy mcp add`
   into a scratch HOME before the `--global` edit is implemented.
6. **Separate, opt-in `claude-hooks` target**, never auto-selected, so
   `agents install` never edits `.claude/settings.json` unless asked with
   `--target claude-hooks`. Alternative: auto-select beside `claude`;
   rejected because hooks change agent behavior.
7. **Hook executable, set by `--command`.** `--command` is the neutral name
   for what `--mcp-command` did; `--mcp-command` remains a deprecated alias.
   Default `npx -y @bendechrai/agentboard hook ...`;
   with `--command <exe>` the hooks run `<exe> hook ...`. `npx` adds
   hundreds of milliseconds per call, which matters for `PreToolUse`, so the
   README recommends a local executable when hooks are enabled.
8. **Prompts only on a real terminal** (stdin and stdout TTY, no `--json`);
   anything else keeps today's non-interactive behavior, so scripts and CI
   do not change. `init` defaults its question to Yes (Enter installs); the bare-project
   prompt takes an explicit list and treats empty as none.
9. **Verification is part of the product, and free of model calls.** A
   sandbox suite creates a temp project per target, runs the built CLI for
   real and asserts files, `check`, idempotency, refusal and config format.
   Smoke tests use config-loading commands only (`claude mcp list`, `codex mcp
   list`, `codex --version`, `agy mcp list`, `--help`), run with HOME and
   CODEX_HOME in the sandbox, and are skipped, not passed, when the binary is
   absent. A guard fails the suite on any change to the real `~/.codex`,
   `~/.gemini`, `~/.cursor` or `~/.claude`. Live model tests are manual, behind
   `AGENTBOARD_LIVE_HARNESS`; cursor-agent (about 25 free headless runs, use
   `--model auto`) and agy (about 5 requests, then a week) have tiny quotas,
   and `codex exec` costs money, so none runs by default; `claude` may.

10. **The agent guide gains no line.** Since `add-claim-leases`, the
   orchestrator output of `help agents --role orchestrator` is exactly at
   the 180-line limit, and every line added to the guide body lands in all
   four role outputs. The change makes room rather than raising the limit:
   it adds `hook` to the guide's list of commands that are not MCP tools by
   reflowing the existing lines, and documents hooks, `--hooks-strict` and
   `AGENTBOARD_HOOKS=off` in the README and in `help hook` instead. Agents
   meet hooks only through hook output, which names the commands to run,
   while hooks are installed and tuned by a human, who reads the README.
   Raising the limit would reopen a budget `add-claim-leases` (ADR 0014)
   has just settled, for text that every agent would read on every start.
11. **Hooks respect leases and the mutex recipe.** A ticket the actor holds
   is one it is the assignee of, whatever its lease state (as `claim`
   treats it); `session-start` shows each held ticket with the `list`
   assignee token so an unconfirmed or lapsed lease is visible; `stop`
   names `release` first for a ticket held under a lease, because a lock is
   released when done; no hook ever claims, renews or queues, so a hook is
   never the background process the worker rules forbid.

12. **One guidance version, raised only for changed text.** Ben decided
   on PR #67 that a target whose installed text is unchanged keeps its
   version and is not reported `stale`, and that a new target installs at
   the then-current version. The existing design has one constant,
   `GUIDANCE_VERSION`, which every marker records and `agents check`
   compares with `N != v`. This change alters no existing text, so the
   constant stays 3 and the new targets install with version 3 markers;
   no per-target version table is needed. The rule is written into
   "Installing guidance into a host project" and "Checking installed
   guidance". Limit: a later change that alters one target's text while
   others stay unchanged would, with one constant, mark them all stale;
   such a change would have to introduce per-target versions in its own
   delta.

## Re-sync with the main specs

Re-synced on 2026-10-31 with the main specs as of `a455011` (after the
archives of `add-claim-leases`, `guard-stale-temporary`,
`keep-cursors-on-upgrade` and `no-echo-refusals`). The MODIFIED text
restates the current main text of board-cli "Command surface", "Exit
codes" and "MCP server" and board-agent-guidance "Help is not an MCP
tool", "Installing guidance into a host project", "Installed guidance
never clobbers user content" and "Checking installed guidance" (those four
are unchanged in main since 0.2.0), so archiving keeps `renew`,
`unqueue`, `config`, the lease flags, CLI-only flags and the `config` MCP
exclusion. Places where the main specs forced a change of substance:

- **Hooks never catch up.** board-cli "Due grants are written during
  catch-up" makes every command except `rebuild` write due grants, which
  contradicts "the hook writes no events". The change keeps the hook
  read-only and adds `hook` to that requirement's exceptions (MODIFIED).
  Consequence: `session-start` does not deliver a grant that is due but
  not yet written (Ben confirmed this on PR #67). A cache of another schema
  version counts as unreadable, since opening it would recreate it
  (`keep-cursors-on-upgrade`).
- **The guidance version stays 3.** The branch planned
  `GUIDANCE_VERSION` 4, which would have reported every 0.3.0 install
  `stale` although this change alters no existing target's text. Decided
  by Ben on PR #67 (decision 12): the version is raised only when an
  existing target's installed text changes.
- **Cursor and Copilot carry the mutex short form.** "Mutex ticket recipe"
  puts a short form in all installed project guidance; to keep the
  proposal's "same rules in every target", the `cursor` rule and the
  `copilot` block are the `AGENTS.md` block's text (codex and antigravity
  already use that block), with the recipe's line limits. The block is
  2868 bytes at 0.3.0, within the 4096-byte Antigravity cap.
- **Hook output follows leases and the mutex recipe** (decision 11): the
  held-ticket line shows lease state, "since its latest claim" becomes
  "since it last became the assignee" (a grant makes an assignee without
  a claim), and `stop` names `release` for a leased ticket.
- **No refused input is repeated** (`no-echo-refusals`): an unknown hook
  event or argument, an unknown answer at the bare-project prompt, and an
  empty or multi-line `--command` are refused without repeating the input.
- **The guide line budget** (decision 10): no guide line is added.
- **ADR 0016**, since 0014 and 0015 are taken.

## Rulings from task group 1 (test author)

Taken while writing the group 1 tests, posted as `DECISION:` comments on
the group's ticket and pinned by the tests and the stub contracts in
`src/board/hook.ts`:

- **Routing.** The executable hands `agentboard hook ...` to the hook
  runner before the ordinary parser (as it does for `mcp`), so an
  argument error is the hook's exit 0 and one line, never the parser's
  exit 1. `agentboard hook --help` and `help hook` still print the help.
  The registry entry's `run`, reachable only through the in-process
  `runCli`, refuses with `streaming-command` like `mcp`.
- **The budget runs from the process start** (`performance.timeOrigin`),
  so Node's start-up counts against it and the 3 second bound of the
  "Time budget" scenario holds on a loaded machine; stdin is read only
  until the deadline and then let go.
- **Actor names.** A resolved name that a writing command could not use
  (the reserved `agentboard`, a secret pattern, outside the actor form
  `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$` of `actor-secret-check`, which is
  not merged yet) is no actor: the hook is silent (session-start prints
  its no-actor line) and never repeats it. Since `actor-secret-check`
  landed (#128) the hook calls the check's own predicate, `isActorName`
  in `src/board/secrets.ts`, which `checkActorName` (`src/cli/parse.ts`)
  shares; the hook cannot import `src/cli` (the layering rule), so the
  predicate lives below it. The registry entry lists exit 1
  `invalid-actor` like every command, reachable only through the
  in-process registry; the executable never reports it.
- **No-actor line.** session-start prints it only where a board is found
  (the cache is not needed), as one JSON document
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}`;
  with no board it prints nothing.
- **Escape hatch.** Only the exact value `off`; it is checked first, so
  even an argument error is silent and stdin is not read.
- **Payload `cwd`.** Used when it is a non-empty string naming an existing
  directory (relative to the process directory), else the process
  directory; `AGENTBOARD_DIR` still wins, as in every discovery.
- **Flags.** `--json` is accepted and changes nothing (the answer is the
  protocol); `--as` has its own help line (`actorHelp`), not "ignored".
- **Unreadable cache** includes a file that is not SQLite; a missing cache
  is never created.
- **Holding** is computed on the cache as it is: a grant that is due but
  not written makes no one the holder (the grantee holds once a catching-up
  command writes it). Held tickets are listed in ticket id order.
- **The guide line moves to group 1.** Adding `hook` to the MCP
  exclusions (task 1.2) makes the existing tests that require the guide
  and the `mcp` description to name every excluded command fail, so the
  reflow that adds `hook` to the guide's list of commands that are not
  tools (decision 10, no line added) is done in task 1.2, not 7.1;
  task 7.1 keeps the README and checks the line counts.

## Rulings from review round 1 of task group 1

- **Fail open beyond the runner.** A removed process directory and a
  stdout or stderr that is closed or failing (EPIPE, ENOSPC) are failures
  of the hook like any other: exit 0, at most one stderr line, no stack
  trace. So `src/cli.ts` reads `process.cwd()` inside the hook's guard (a
  missing directory leaves only the payload `cwd` for discovery) and the
  hook path ignores stream errors.
- **The budget covers discovery.** `git rev-parse` in board discovery is
  bounded by the time left; a `git` that does not answer in time counts as
  git failing (discovery falls back to `./.board`, the usual rule when git
  fails), so the hook still answers within the budget.
- **No stderr line names the payload `cwd` or the actor**, on every path
  (unreadable, missing, older or locked cache, out of time), not only on
  argument errors.
- **WAL checkpoint limit.** The inspect-only open is read-write (a
  `readOnly` connection leaves empty `-wal` and `-shm` files behind on a
  clean cache). After an unclean shutdown that left a non-empty `-wal`,
  the hook's connection is the last to close and checkpoints the log into
  `cache.sqlite`: the content is the same, the bytes are not. Accepted
  and recorded in the spec delta rather than fixed in this change;
  `rebuild --check` has the same property.

## Rulings from task group 2 (test author)

Taken while writing the group 2 tests, posted as `DECISION:` comments on
the group's ticket and pinned by the tests and the contracts in
`src/board/hook.ts` (`runHook` step 6, `warnStatePath`):

- **Answer shapes.** `session-start` always answers with the
  `SessionStart` `additionalContext` document for a resolved actor on a
  readable board. `stop` warns with `{"systemMessage": ...}` and nothing
  else (never `decision`); strict blocks with exit 2, stdout empty and
  the same text on stderr, which may span lines. `pre-tool-use` warns with
  the `PreToolUse` `additionalContext` document and never a
  `permissionDecision`: `allow` would skip the user's permission prompt
  and `deny` or `ask` would stop the agent in warn mode; strict blocks
  with exit 2 and the text on stderr.
- **Held-ticket line.** Each held ticket is written `<id> <token>`, the
  full id and the `list` assignee token at the hook's clock, in id order;
  the line is cut at a ticket boundary to 2000 characters, ending with
  `and <n> more`, so the inbox always has room.
- **Truncation advances the cursor over the delivered entries only.**
  The truncation line sends the agent to `agentboard inbox`, which would
  show nothing if the cursor had passed the omitted entries; so the cursor
  advances to the last entry shown and the next `inbox` lists exactly the
  omitted ones. Inbox lines are the `inbox` text lines, `GRANTED:` and
  `LOST:` prefixes included. With no entry delivered nothing is written
  (the cache is byte-identical). An event file not folded into the cache
  is neither delivered nor skipped, since the hook does not catch up.
- **Stop.** A comment is a `ticket.comment` or a hand-off note by the
  actor, after the event that last made the actor the assignee (claim,
  takeover, grant, hand-off or assignment to it); every such ticket is
  named, in id order. `release` is named, first, only for a ticket with a
  lease. Strict mode with `stop_hook_active` exactly `true` answers as
  warn mode (a `systemMessage`, exit 0), so the user still sees the
  reminder and one stop blocks at most once. (Narrowed in review round 1
  below: strict blocks only when the field is exactly `false`.)
- **Pre-tool-use target and project.** The target is
  `tool_input.file_path`, or `notebook_path` (then `file_path`) for
  `NotebookEdit`, resolved against the discovery directory when relative;
  a missing or non-string target passes silently. The project is the
  board directory's parent plus the nearest directory at or above the
  discovery directory holding a `.git` entry, so an edit in a linked
  worktree (outside the main checkout) is checked, with no extra `git`
  child. Inside is decided component by component, so a sibling sharing a
  name prefix is outside; a target in the board directory, or with a
  `.board` component below the project, is exempt. Tool names match
  exactly, case included.
- **Rate-limit state.** One file per session in the OS temporary
  directory (`os.tmpdir()`, which honours `TMPDIR`; `HookRequest.stateDir`
  in process), named `agentboard-hook-<sha256 of session_id>` so it never
  repeats the id; it holds the time of the last warning in milliseconds.
  Garbage, a missing file or a time later than now counts as no warning.
  It is written only when a warn-mode warning is printed, replaced
  atomically through a temporary file and a rename (a symbolic link at
  the name is replaced, never followed), and a failure to read or write
  it never stops the warning. Strict mode neither reads nor writes it. No
  `session_id` means a warning every time and no file. The spec's
  read-only sentence now says "the only board state", since this file is
  outside the board.
- **No loop, no lock work.** No hook text names `renew`, a queue,
  `--wait`, `--ttl`, `watch`, or waiting, polling, sleeping or retrying;
  every `agentboard <command>` a hook names is a registry command.

## Rulings from review round 1 of task group 2

Taken by the orchestrator on the two reviews of PR #133 (reviewer-hk2-1
F1; reviewer-hk2-2 F1 to F10), posted as `DECISION:` comments on the
group's ticket, written into the spec delta where they change behaviour
and pinned by the tests and the contracts in `src/board/hook.ts`:

- **R1 The budget covers the whole event.** The 2 second budget from the
  process start covers the event's own work, not only the steps before
  it. Every event checks the deadline while it works (after the cache
  read, between event-file reads, before its one write); a run that
  finds the budget spent ends in exit 0 with nothing on stdout and at
  most the out-of-time line, never a strict exit 2 and never a cursor
  write. In-process tests pin it with an injected clock: once any reading
  of `HookRequest.now` is past the deadline, the answer is fail-open, and
  no event file is opened after the clock has passed it.
  `session-start` reads the event files of only the entries it can
  deliver (at most one more than it shows), takes the omitted count from
  the cache, and holds the write lock only for the cursor update: one
  attempt bounded by the time left, never retried past the deadline
  (`beginImmediate`'s second attempt is not used). The lock not had in
  time means a run out of time: nothing delivered, nothing written. When
  the cursor has moved since the entries were chosen, nothing is
  delivered or written and the answer is the held-ticket line alone, so
  two runs never deliver one entry twice. `stop` derives "became
  assignee" and "commented since" from the cache or bounded reads and in
  any case honours the deadline. A 24 000-event board timing test runs
  locally only (`AGENTBOARD_HOOK_TIMING=1`), like the 500-ticket one of
  task 2.2.
- **R2 Strict stop blocks only on `stop_hook_active` exactly `false`.**
  Missing, `true`, any other value, an empty or invalid payload and an
  oversized one (R8) answer as warn mode: the hook cannot see the field,
  so blocking would make "one block per stop" depend on something it
  cannot check (ADR 0016, fail open). Claude Code always sends the
  boolean.
- **R3 The strict pre-tool-use denial does not say "carry on".** The
  edit is denied every time, so "carry on" invites retrying the same
  edit into the same denial. Strict text: the edit is refused because the
  actor holds no ticket; claim the ticket it belongs to (the same `inbox`
  and `claim` commands); if the work is not ticketed, stop and ask the
  user rather than retrying the edit. No waiting or retry wording. The
  warn text keeps "carry on".
- **R4 The stop text is bounded.** Tickets are named in id order, each
  with its commands, as many as fit in 2000 characters (`STOP_TEXT_LIMIT`,
  the `HELD_LINE_LIMIT` style), cut at a ticket boundary, ending with
  `and <n> more` when any are left out. `release` stays first for a
  leased ticket among those shown.
- **R5 A hand-off note to oneself counts.** The note event at or after
  the event that made the actor assignee counts (`>=`, not `>`), so the
  hook's own suggested `handoff <id> --to <actor> ... --note` satisfies
  it when `<actor>` is the holder. Only the actor's own notes count, so a
  hand-off to the actor by someone else is unaffected.
- **R6 pre-tool-use compares real paths.** The target (or, for a new
  file, its nearest existing ancestor with the rest appended), the board
  directory and the project roots are resolved through symbolic links
  before containment, so `/tmp` against `/private/tmp` and a session
  working through a link are checked like the real path; a link inside
  the project that leads outside it is outside.
- **R7 The rate-limit read never follows a link and never blocks.** Opened
  `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, required to be a regular file
  (`fstat`), at most 64 bytes read; anything else counts as no earlier
  warning. The write is unchanged (temporary file and rename).
- **R8 stdin is capped at 1 MiB** (`HOOK_STDIN_LIMIT`, 1048576 bytes). A
  payload over the cap is not read further and is treated as an
  unreadable payload (`{}`): silent exit 0 for `pre-tool-use`, and strict
  `stop` answers as warn mode (R2). Exactly the cap is read and parsed.
- **R9 An invalid actor has its own line.** An actor that is set but not
  usable (the reserved actor, a secret pattern, outside the actor form)
  gets a `session-start` line saying the actor is not a valid actor name,
  naming `AGENTBOARD_ACTOR` and `--as`, distinct from the no-actor line
  and never repeating the value.
- **R10 Tests for the surviving mutants.** The board-directory exemption
  (a board directory not named `.board`, through `AGENTBOARD_DIR`); the
  cursor write really persisted and re-checked under the write lock;
  `ticket.grant` and `ticket.assign` in the became-assignee scan (a
  comment from an earlier hold does not count after the ticket comes
  back by grant or assignment); `effectiveOnly` (a rejected assigning
  event after the actor's comment is ignored); both character limits at
  exactly the limit and one over; the deadline check after the cache
  read.
- **No change:** the per-session warning files in the OS temporary
  directory are not cleaned up (one small file per session, outside the
  board); a warn-mode `stop` `systemMessage` reaches only the user, not
  the model, as the spec intends (group 7's README says so).

## Rulings from review round 2 of task group 2

Taken by the orchestrator on reviewer-hk2-2's round 2 report on PR #133
(reviewer-hk2-1 approved 52d1947), posted as `DECISION:` comments on the
group's ticket:

- **R11 stop reads no more than it needs** (finding 2). (a) A ticket
  whose cache `updated_at` is not later than the actor's last comment on
  it is decided with no read: nothing can have reassigned it since.
  `updated_at` is `encodeHlc(Ticket.updatedAt)`, the `ts` of the last
  applied event on the ticket in fold order, and positions compare by
  `compareHlc` first, so the two are comparable (an event whose `ts`
  equals `updated_at` counts as at or before it). (b) For the rest, only
  applied events after the actor's last comment and at or before the
  ticket's `updated_at` can be the assigning event; only those are read
  (known comments still skipped), in fold order, and the reading stops as
  soon as every ticket in question is decided. (c) Known limit, also in
  ADR 0016: a ticket updated long after the actor's comment, with many
  unrelated events between, may still run out of budget; `stop` then
  fails open (out-of-time line, exit 0). No cache schema change in this
  group (an index of the ticket per folded event would remove the
  limit).
- **Tests for round 2 findings 1, 3 and 4.** Finding 1 (major): the
  deadline checks in the stop read loop and before the stop answer, and
  the check before the pre-tool-use block, each have a test that fails
  when the check is removed or reads `Date.now()` instead of the run's
  clock: a holder that commented and got the ticket back after many
  non-comment events, with slow reads crossing the deadline mid-loop and
  at the last read. Finding 3: the 2000-character stop text at exactly
  the limit and one over, for the uncut and the cut text. Finding 4:
  with the budget spent from the start, the outcome is exactly the
  out-of-time line (a discovery that swallowed the signal would answer
  silently).

## Rulings from task group 3 (test author)

Taken while writing the group 3 tests, posted as `DECISION:` comments on
the group's ticket and pinned by the tests and the contracts in
`src/guidance/install.ts` (`installGuidance`, `claude-hooks`;
`RefusalReason`; `installCommand`), `src/guidance/check.ts`,
`src/guidance/installed-text.ts` (`hookExecutable`, `hookCommand`,
`hookGroup`) and `src/guidance/markers.ts` (`hookMarkerVersion`,
`parseHookCommand`):

- **Entry shape.** Each key (`SessionStart`, `Stop`, `PreToolUse`) gets
  one matcher group holding one handler, `{"type": "command", "command":
  ..., "timeout": 5}`; `PreToolUse` has `"matcher":
  "Edit|Write|MultiEdit|NotebookEdit"` first, the other two no matcher.
  The timeout is exactly 5. The command is `<executable> hook <event>[
  --strict] # agentboard-hooks: v<N>`; no `--as` (the actor comes from the
  environment). A fresh file is `JSON.stringify(..., null, 2)` plus a
  line feed, keys in that order.
- **The executable is one shell word.** `--command` names an executable,
  as for `.mcp.json`, so in a hook command it is written as given when it
  holds only `A-Z a-z 0-9 _ . / @ % + = : , -`, and otherwise single-quoted
  (`'` as `'\''`): a path with spaces runs, and `$VAR` or `~` is not
  expanded. Without `--command` it is `npx -y @bendechrai/agentboard`.
- **Ownership.** A handler is agentboard's when its `command` ends exactly
  with `# agentboard-hooks: v<N>` (no leading zero, nothing after it, not
  even a space). Only the three keys are inspected; other keys of `hooks`
  and elements of any shape in the three arrays are user content. A user
  hook that looks like agentboard's but lacks the exact marker is kept
  and agentboard's own entry is added beside it.
- **Merge.** Per key: up to date when it holds exactly one owned group,
  deep-equal to the wanted group (so an up-to-date file in another
  formatting, key order or line ending is not written at all). Otherwise
  every owned handler is removed, a group left empty goes, a group that
  still holds user handlers stays, and the wanted group takes the place
  of the first owned group (right after it when it stayed), or is
  appended. Missing keys are appended in the order above, a missing
  `hooks` as the last top-level key. Duplicates therefore collapse to
  one, at the first position.
- **The executable is kept, the mode is not.** Without `--command`, a
  reinstall keeps the executable the installed commands share (when every
  owned command parses and they agree), as the `.mcp.json` entry keeps a
  local command; otherwise it uses `npx`. The mode follows
  `--hooks-strict` on every run, as the spec says.
- **Refusals.** `malformed-settings`: not valid JSON (comments, trailing
  commas, an empty or truncated file) or a top level that is not an
  object; `--force` replaces the whole file by a fresh one, as `--force`
  replaces a foreign `SKILL.md`. `hooks-shape`: `hooks` present and not an
  object (`null` included) or one of the three keys present and not an
  array; `--force` replaces each offending value in place. Both are named
  in the spec's list of refusals `--force` overrides. Neither message
  quotes the file or the JSON parser's error, which can quote it.
- **File handling.** A leading UTF-8 byte order mark is accepted and kept;
  a rewrite uses line feeds (insignificant formatting). No size limit. A
  symbolic link inside the tree is followed and kept; one leading outside
  (a `.claude` linked to a home directory, say) is refused
  `outside-tree`, like every target. The file is replaced atomically (a
  temporary file beside it, given its mode, renamed over it), so Claude
  Code never reads half a file; a file the process may not write is
  refused `unwritable` rather than replaced by the rename, and a
  directory where the temporary file cannot be created is `unwritable`
  too. `.claude/settings.local.json` is never read or written.
- **Check.** Found when an owned handler is under one of the three keys,
  or, for a file that cannot be read as settings, when its text contains
  `# agentboard-hooks:` (then `modified`, version unknown). Version: the
  one every owned handler records, else unknown (`modified`); another
  version is `stale` whatever the text. `current` needs one owned group
  per key, every command parsing with its key's event, one executable and
  one mode across the three, and each group deep-equal to its rendering.
- **Selection.** Auto-detection never selects `claude-hooks`, also where
  it is installed (an old install is not upgraded by a bare `agents
  install`). `--command` selects `mcp-json` as the spec says, also next to
  `--target claude-hooks` alone. `--hooks-strict` without `claude-hooks`
  changes nothing and prints nothing. `claude-hooks` follows `mcp-json`
  in the target order.
- **The alias.** `--command` and `--mcp-command` together are a usage
  error from the parser (`give only one of --command, --mcp-command`, an
  exclusive group), repeating neither value. The reason is `requested
  with --command` for either flag. `--mcp-command` prints `agentboard:
  --mcp-command is deprecated; use --command, which does the same` as the
  first stderr line of every run that returns (also `--json`, also with a
  refused target); a usage error prints only itself and names the flag
  that was given (`--mcp-command must not be empty`).

## Rulings from review round 1 of task group 3

Taken by the orchestrator on the two reviews of PR #136 (reviewer-hk3
approved with nits; reviewer-hk3-2 requested changes), posted as
`DECISION:` comments on the group's ticket, written into the spec deltas
where they change behaviour and pinned by the tests and the contracts in
`src/guidance/install.ts` (`RefusalReason`, `validateCommand`),
`src/guidance/markers.ts` (`readUtf8Json`, `jsonRewriteIsLossless`) and
`src/guidance/installed-text.ts` (`hookExecutable`,
`SHELL_RESERVED_WORDS`, `SHELL_SPECIAL_BUILTINS`):

- **R1 Strict UTF-8 (blocking).** `.claude/settings.json` and `.mcp.json`
  are decoded strictly (`readUtf8Json`): after one leading byte order mark,
  bytes that are not valid UTF-8 (a Latin-1 byte, an overlong sequence, an
  encoded surrogate, a truncated sequence) are refused, never turned into
  U+FFFD and written back. For settings.json that is `malformed-settings`
  (`--force` replaces the file as for invalid JSON, keeping a leading byte
  order mark); for `.mcp.json` it is its `malformed-file` refusal (refused
  even with `--force`, as for invalid JSON). `check` treats such a file
  like invalid JSON: settings.json is `modified` (version unknown) when its
  raw bytes contain `# agentboard-hooks:`, else not found; `.mcp.json` is
  not found. No refusal repeats the file's content.
- **R2 Never silently change user data.** When settings.json or `.mcp.json`
  must be rewritten and `JSON.stringify(JSON.parse(text))` would not give
  back every value and key order (`jsonRewriteIsLossless`), the target is
  refused as `lossy-json` and nothing changes. The cases: a number literal
  whose exact decimal value differs from that of the literal the rewrite
  writes (`1e400`, `12345678901234567890`, `0.10000000000000000001`,
  `18446744073709551616`); `-0` in any spelling; a duplicate key in any
  object (escapes decoded); array-index keys (canonical `"0"` to
  `"4294967294"`) not all before the other keys in ascending order.
  Spellings of the same value (`1.0`, `1e2`, an escaped key) are
  formatting and are normalised as before. A file that needs no write is
  never refused. `--force` rewrites anyway, discarding exactly those
  differences: the nearest JS number (or `null` for a literal out of
  range), the sign of `-0`, every occurrence of a duplicate key but the
  last, and the order of array-index keys. The check runs after
  `malformed-settings` and `hooks-shape`. It applies to `.mcp.json` as well,
  since that file is rewritten the same way and one pure function serves
  both.
- **R3 Shell words.** A `--command` (or `--mcp-command`) value starting
  with `-` is a usage error, `--<flag> must not start with a hyphen` (a
  hook command beginning with `-` is read as shell options). A value equal
  to a POSIX special built-in is a usage error, `--<flag> must not be a
  shell special built-in; give the path of the executable`, since the
  shell finds the built-in before any file, quoted or not: `break`, `:`,
  `continue`, `.`, `eval`, `exec`, `exit`, `export`, `readonly`, `return`,
  `set`, `shift`, `times`, `trap`, `unset` (a path such as
  `/usr/local/bin/exec` is fine). Both checks come after the empty and
  newline checks and name the flag, never the value. A value containing
  `=` (read as an assignment) or equal to a reserved word is single-quoted:
  `!`, `{`, `}`, `case`, `do`, `done`, `elif`, `else`, `esac`, `fi`, `for`,
  `if`, `in`, `then`, `until`, `while` (POSIX), and `[[`, `]]`,
  `function`, `select`, `time` (reserved in bash and other shells). The
  unquoted set is now `A-Z a-z 0-9 _ . / @ % + : , -` without a leading
  `-`. Tests run the rendered command in `/bin/sh` (and bash when present)
  against fake executables of those names on the PATH.
- **R4 Tests for the surviving mutants:** the temporary file's mode set
  explicitly (a 0666 file under the usual umask), the temporary file
  removed when the rename or the fsync fails, a command under the wrong
  key stopping the executable from being kept, `--force` keeping the byte
  order mark of an unparseable file (ruled: kept), the non-markers
  `#agentboard-hooks: v3`, `# agentboard-hooks: 3` and `#  agentboard-hooks:
  v3` as user hooks, and mixed v2 and v3 entries in check (`modified`,
  version unknown, whichever comes first).
- **R5 Durability and help.** The temporary file is opened with `openSync`
  and flushed with `fsyncSync` on that descriptor before `renameSync`
  (tested through a `node:fs` wrapper). The `agents install` help says the
  `--command` value is quoted where needed in the hooks, not "written as
  given", and its usage exit code names the hyphen and special built-in
  refusals. The unrelated prettier reflows in `src/cli/registry.ts` are
  reverted (implementer).
- **Accepted, no change:** a temporary file left by a run killed between
  writing and renaming it (`.claude/.settings.json.<pid>.<random>.tmp`,
  never read by Claude Code; a user removes it); the rename replacing a
  hard-linked file by a new inode and dropping ACLs, extended attributes
  and, when another user runs the install, the owner (the trade-off of an
  atomic replace); an empty settings.json refused as `malformed-settings`
  (the README in group 7 says so).

## Risks / Trade-offs

- **PreToolUse is intrusive and adds latency to every edit** -> warn-only
  default, rate-limited warnings (once per 10 minutes per session),
  matcher limited to file-writing tools, 2 second deadline, read-only cache
  lookup, local executable recommended over `npx`, and `AGENTBOARD_HOOKS=off`.
- **Stop blocking can loop** -> strict mode blocks at most once per stop
  (it blocks only when `stop_hook_active` is exactly `false`; true,
  missing or unreadable always allows); warn mode never blocks.
- **Actor identity must be resolvable** -> `AGENTBOARD_ACTOR`/`--as` only;
  unresolved means silent allow (one explanatory line at session start).
  Never inferred from the OS user, matching board-cli.
- **Work not tied to a ticket** (quick fixes, docs) -> the warning says
  carrying on is fine, strict mode is for projects that mean it, and
  not installing `claude-hooks` or `AGENTBOARD_HOOKS=off` removes it.
- **Subagents and worktrees** -> they inherit the environment, so share the
  actor and its claims (a subagent edit counts as the parent's claimed
  work); board discovery uses the payload `cwd`, which finds the board
  from linked worktrees. A subagent that should be a distinct actor must set
  its own `AGENTBOARD_ACTOR`.
- **Editing the user's settings.json** -> merge only owned entries, refuse
  invalid JSON or an unexpected `hooks` shape, preserve everything else.
- **Harness config formats drift** (Codex, Cursor, Antigravity change often)
  -> config-format validation and non-model smoke tests in the sandbox suite;
  a failure blocks release.
- **Editing a user's global config** -> never by default; `--global` plus an
  explicit target, marked and refused when foreign, tests run on a scratch
  HOME with a guard on the real one.
- **Antigravity may prefer `GEMINI.md` over `AGENTS.md`** -> the sandbox suite
  records which `agy` reads when both exist; the block is small enough for
  either.

## Migration Plan

Existing installs are unaffected until `agents install` runs again; `check`
does not report `claude-hooks` unless it was installed. Rollback: delete the
three marked entries, or install with an explicit `--target` list.

## Open Questions

- Antigravity project registration (`.agents/skills.json`,
  `.agents/plugins.json`) is left out because `--help` shows no schema; add it
  in a follow-up if the schema is documented.
- Whether Codex reads `AGENTS.md` is confirmed in the sandbox suite; if it does
  not, the `codex` target only prints its command and the spec changes.
- An ADR (0016) recording decisions 2 and 3 is planned in task group 1.
- Decided by Ben on PR #67: `hook session-start` does not catch up or
  write due grants; hooks stay read-only (decision 3).
