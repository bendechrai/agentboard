# Proposal

## Why

Multiple coding agents work on one project at the same time, in separate git
worktrees and sometimes on different machines, and today the only shared view
of who is doing what is the orchestrator's memory. OpenSpec `tasks.md` records
what a change consists of and whether each piece is done, but it is a plain
checklist: it cannot say who holds a task right now, what it is blocked on,
what was decided in a hand-off, or which agent should pick it up next. Agents
need a local, offline board for that coordination that cannot lose or clobber
updates when two of them write at once, and that moves between a desktop and
a laptop through git without a hosted service.

## What Changes

- A per-project `.board/` directory, itself a small git repository and
  gitignored by the host project, holding an append-only, content-addressed
  event log as the only source of truth for tickets.
- A SQLite cache derived from the event log for fast queries, disposable and
  rebuildable at any time.
- An `agentboard` CLI covering the ticket lifecycle (`init`, `new`, `show`,
  `list`, `claim`, `release`, `move`, `comment`, `handoff`, `link`,
  `checklist`, `close`), change awareness (`inbox`, `watch`), maintenance
  (`rebuild`, `sync`), and OpenSpec integration (`import-change`,
  `close-merged`), with `--json` output everywhere and stable exit codes.
- Concurrency guarantees that are stated as testable properties: a race on
  `claim` has exactly one winner, concurrent comments are never lost, a crash
  between the event write and the cache write is reconciled by `rebuild`,
  `inbox` never misses an event, and two clones with divergent events converge
  after `sync`.
- The rules that keep the board and OpenSpec from becoming two sources of
  truth: every ticket references a task, completion truth stays in
  `tasks.md`, in-flight truth lives on the board, and a decision made in a
  ticket thread must be promoted to a spec delta or ADR before the ticket can
  close.
- A reserved `mcp` command that will expose the same operations as MCP tools
  over stdio; it is specified here so the CLI surface and the MCP surface stay
  one set of operations, but its implementation is the last, optional task
  group.

## Capabilities

### New Capabilities
- `board-events`: the `.board/` directory, its discovery from any worktree,
  the immutable content-addressed event files, the event envelope and kinds,
  ordering, and the fold from events to ticket state.
- `board-cache`: the derived SQLite cache, its tables, the single-transaction
  write discipline that makes every command atomic, and `rebuild`.
- `board-cli`: the command surface, argument and output conventions, the
  ticket status state machine, exit codes, and the reserved `mcp` command.
- `board-concurrency`: the externally observable guarantees under concurrent
  processes, crashes and cross-machine sync, stated so they can be tested by
  racing real child processes.
- `board-openspec-integration`: how tickets relate to OpenSpec changes and
  tasks, `import-change`, `close-merged`, the decision-promotion rule on
  `close`, and how an orchestrator is expected to use `inbox` between
  dispatches.

### Modified Capabilities
None. The baseline is empty.

## Impact

- New source under `src/`: pure event and fold logic, a store layer over the
  filesystem and `node:sqlite`, and the CLI. `src/index.ts` exports the
  library surface so other tools can embed the board.
- New runtime dependency footprint is intentionally small: `node:sqlite`
  (built into Node 22.13+), `git` on the PATH for `sync`, and `gh` on the PATH
  only for `close-merged`. A ULID implementation is hand-rolled to avoid a
  dependency; see design.md.
- Host projects add `.board/` to their `.gitignore` and run
  `agentboard init` once per clone. The board data itself is versioned in its
  own repository, so the host project's history is never touched by board
  activity.
- Every host project's contributing guide gains one rule: coordination goes
  through the board, decisions go back into specs.
