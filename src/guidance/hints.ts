/**
 * Error hints (board-agent-guidance: "Error hints"; add-agent-guidance task
 * 2.2): every refusal carries one line naming what moves the caller
 * forward, printed by the CLI on stderr as `hint: <hint>` and carried by
 * MCP tool errors as the `hint` field.
 *
 * Decisions recorded here (test author, task group 2):
 * - Every reason token the board can throw has a hint, not only the exit 1
 *   and exit 4 ones the spec names: exit 2, 3 and 5 reasons get one too
 *   (for example `board-not-found` hints `agentboard init`). An error with
 *   no reason (an unexpected failure, exit 5) has no hint.
 * - Hints depend on the surface. On the CLI a suggested command is written
 *   as a shell command line; over MCP a suggested command that is an MCP
 *   tool is written as a tool call, and the actor advice names the `as`
 *   argument and `agentboard mcp --as <actor>` instead of the `--as` flag
 *   and `AGENTBOARD_ACTOR`, which an agent talking to a running server
 *   cannot set.
 * - The error message itself is unchanged by this group: board-cli says a
 *   tool call without an actor "SHALL fail exactly as the CLI does", so the
 *   MCP `missing-actor` message stays the CLI one and the hint carries the
 *   MCP-specific advice.
 * - The holder of a ticket is not a hint parameter: the `already-assigned`
 *   message already names it, and `BoardError` carries no structured
 *   details.
 *
 * Nothing here reads the board, the environment or the clock. All output
 * is plain ASCII on one line.
 */

import type { ExitCode } from '../store/errors.js';

/** Where a hint is shown: the shell CLI or an MCP tool error. */
export type HintSurface = 'cli' | 'mcp';

/**
 * What a hint is rendered with. Every field but `surface` may be unknown;
 * an unknown value is written as its placeholder (`<id>`, `<actor>`).
 */
export interface HintContext {
  readonly surface: HintSurface;
  /**
   * The registry name of the command that failed (`claim`, `checklist
   * tick`), or null when it is not known (an unknown command, an unknown
   * MCP tool name, or a failure before a command was selected). Over MCP
   * it is the tool's command, not the tool name.
   */
  readonly command: string | null;
  /**
   * The ticket id argument exactly as the caller gave it (a full id or a
   * prefix), when the command has one and it was parsed; else undefined.
   */
  readonly id?: string;
  /**
   * The actor, when known: on the CLI the `--as` value or else
   * `AGENTBOARD_ACTOR`; over MCP the call's `as`, else the server's
   * `--as`, else the server's `AGENTBOARD_ACTOR`. Undefined (or empty)
   * when none is known.
   */
  readonly actor?: string;
}

/**
 * Every reason token that has a hint, sorted. This is exactly the set of
 * reasons the board can put in a `BoardError`: every literal
 * `new BoardError(<code>, '<reason>', ...)` under `src/`, every
 * `RejectionReason` of the fold (`src/events/fold.ts`), and every
 * `ExclusiveGroup.reason` and `ExitCodeSpec.reason` in the registry. A
 * test derives that set from the source and compares.
 */
export const HINT_REASONS: readonly string[] = [];

/**
 * The exit code class of each reason in `HINT_REASONS` (a reason belongs to
 * exactly one class: for example `usage` and `missing-actor` are 1,
 * `board-not-found` 2, `sync-conflict` 3, `already-assigned` 4, `busy` 5).
 */
export const HINT_EXIT_CODES: Readonly<Record<string, Exclude<ExitCode, 0>>> = {};

/**
 * One suggested command inside a hint, rendered for `surface`:
 *
 * - CLI: `'agentboard <command> <args>'`, in single quotes: the command
 *   words, then each argument in order, where a key that is a positional of
 *   the command is written as its value and any other key as `--<key>
 *   <value>` (`--<key>` alone for the value `true`). A value containing a
 *   space is written in double quotes. The result, without the quotes,
 *   parses with `parseArgs` to `command` (placeholders such as `<id>`,
 *   `<path>` and `<source>:<ref>#<item>` are ordinary string values).
 * - MCP, when `command` is an MCP tool (`toolName`, not in
 *   `EXCLUDED_COMMANDS`): `<tool> <json>` without quotes, where `<json>` is
 *   `JSON.stringify` of `args` with its keys in the order given (for
 *   example `board_inbox {"as":"reviewer"}`), and `true` stays a JSON
 *   boolean. The JSON is accepted by `toolArguments` for that tool.
 * - MCP, when `command` is not a tool (`init`, `sync`, `rebuild`, `watch`,
 *   `mcp`, `version`, `help`): the CLI form, which the agent runs in a
 *   shell.
 *
 * `args` keys are registry argument names (`id`, `task`,
 * `decision-recorded-in`, `as`). Pure.
 */
export function hintStep(
  surface: HintSurface,
  command: string,
  args: readonly (readonly [string, string | true])[],
): string {
  void surface;
  void command;
  void args;
  throw new Error('not implemented');
}

/**
 * The hint for `reason` in `context`, or null when `reason` is null or not
 * in `HINT_REASONS`. A hint is one non-empty line of plain ASCII (no
 * newline, no leading or trailing space), not starting with `hint:`, whose
 * suggested commands are written with `hintStep`. In it, `<id>` stands for
 * `context.id` and `<actor>` for `context.actor` whenever those are
 * unknown; a known id or actor always replaces its placeholder.
 *
 * Contract per reason (I is the id or `<id>`, A the actor or `<actor>`; a
 * step `X` below means `hintStep(context.surface, ...)` of it, so on MCP
 * a tool step becomes a tool call):
 *
 * Exit 1:
 * - `usage`: CLI: step `help <command>` when the command is known and is
 *   not `help`, else step `help`. MCP: names the tool (`board_<name>`) and
 *   says to check its input schema in `tools/list`; with no known command,
 *   says to call `tools/list`.
 * - `missing-actor`: CLI: says to pass `--as <actor>` or set
 *   `AGENTBOARD_ACTOR` (both texts appear literally), and does not mention
 *   `agentboard mcp`. MCP: says to pass the `as` argument (the words
 *   `as argument` appear) or to start the server with
 *   `'agentboard mcp --as <actor>'` (that step, in its CLI form), and does
 *   not tell the agent to set `AGENTBOARD_ACTOR`.
 * - `malformed-event`: an agentboard bug; names step `version` to include in
 *   a report.
 * - `id-too-short`, `ambiguous-id`: give a longer unique prefix; step
 *   `list`.
 * - `secret-like`: remove the secret, or pass `--allow-secret-like` (the
 *   text `--allow-secret-like` appears) for a false positive.
 * - `malformed-task-ref`: the form `<source>:<ref>#<item>` and the
 *   OpenSpec shorthand `--change <name> --group <n>`, both literally.
 * - `missing-status`: step `move` with `id` I, `status` `<status>`, `as` A.
 * - `needs-task-or-adhoc`: `--task <source>:<ref>#<item>`,
 *   `--change <name> --group <n>` and `--adhoc <reason>`, literally.
 * - `no-disposition`: steps `close` with I, `decision-recorded-in`
 *   `<path>`, A and `close` with I, `no-decision`, A.
 * - `path-outside-tree`: the path must be inside the working tree; names
 *   `--decision-recorded-in <path>` for close and `--decision <path>` for
 *   link, as fits the command (both when the command is unknown).
 * - `decision-path-missing`: write and commit the spec delta or ADR first,
 *   then step `close` with I, `decision-recorded-in` `<path>`, A.
 * - `unpromoted-decision`: step `show` with I (to read the decisions); then
 *   promote them and step `close` with I, `decision-recorded-in` `<path>`,
 *   A; or retract with a comment beginning `RETRACTED:` (step `comment`
 *   with I, `text` `RETRACTED: <why>`, A).
 * - `unknown-cursor`: step `inbox` with `as` A (and `peek`).
 * - `unsupported-source`: only the `openspec` adapter ships; step `new`
 *   with `title` `<title>`, `task` `<source>:<ref>#<item>`, A.
 * - `tasks-not-found`, `malformed-tasks`: names
 *   `openspec/changes/<name>/tasks.md`.
 * - `git-missing`, `gh-missing`: install `git` or `gh` and put it on the
 *   `PATH` (the word `PATH` appears); `gh-missing` also names
 *   `gh auth login`.
 * - `ambiguous-remote`: set an upstream or a remote named `origin` in the
 *   board repository, then step `sync`.
 * - `streaming-command`: run the command from the agentboard executable
 *   (step `<command>` when the command is known).
 *
 * Exit 2: `board-not-found`: step `init`, and `AGENTBOARD_DIR`;
 * `board-not-a-repository`: step `help sync`.
 *
 * Exit 3: `sync-in-progress`, `detached-head`, `sync-conflict`,
 * `sync-failed`: what a human does in the board repository, then step
 * `sync`; `sync-conflict` names `git rebase --continue`.
 *
 * Exit 4:
 * - `unknown-ticket`, `duplicate-create`: step `list`.
 * - `invalid-transition`: step `show` with I (for the current status) and
 *   step `help move`.
 * - `already-assigned`: step `show` with I and step `inbox` with `as` A
 *   (board-agent-guidance scenario: the loser of a claim race is told to
 *   run `agentboard inbox --as <itself>`).
 * - `not-assignee`: step `show` with I.
 * - `checklist-index`: step `show` with I.
 * - `needs-task-link`: step `link` with I, `task`
 *   `<source>:<ref>#<item>`, A.
 *
 * Exit 5: `integrity`: a human must inspect the file named in the
 * message; step `rebuild --check`. `busy`: retry the command. `no-cache`,
 * `schema-mismatch`: step `rebuild`.
 *
 * Pure.
 */
export function renderHint(reason: string | null, context: HintContext): string | null {
  void reason;
  void context;
  throw new Error('not implemented');
}

/**
 * The hint of a thrown value: `renderHint(error.reason, context)` for a
 * `BoardError`, null for anything else. Pure.
 */
export function hintFor(error: unknown, context: HintContext): string | null {
  void error;
  void context;
  throw new Error('not implemented');
}
