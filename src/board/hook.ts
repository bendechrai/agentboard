/**
 * `agentboard hook <event> [--strict]`: the harness hook command
 * (add-harness-integration; board-harness-hooks "Hook command and
 * protocol", "Hook actor resolution"; board-cli "Exit codes", "Due grants
 * are written during catch-up"; design.md decisions 1, 3 and 11).
 *
 * A coding harness (Claude Code) runs the command on an event, with a
 * JSON payload on stdin, and reads the answer from the exit code, stdout
 * and stderr: exit 0 continues (stdout, when not empty, is one JSON
 * document for the harness), exit 2 blocks (stderr is the reason, fed
 * back to the agent). The command is a guest in the agent's loop, so it
 * fails open: whatever goes wrong (no board, an unreadable, missing,
 * locked or older cache, no actor, a payload of any shape, an argument
 * error, an internal error, the 2 second budget running out) ends in exit
 * 0, never blocking, with at most one line on stderr that repeats no
 * input. Only `--strict` can block, and only for the reasons the event
 * requirements name.
 *
 * Read-only. The command writes no event, never runs `sync` and never
 * touches the network. It reads the cache as it is: it never catches up
 * (folds no event file, writes no due grant, reaps no temporary file) and
 * never creates, recreates, migrates or rebuilds the cache, so a missing
 * cache or one of another schema version counts as unreadable (opening it
 * the ordinary way would recreate it). The only state it may write is the
 * inbox cursor of the actor in `session-start` (board-harness-hooks
 * "Session start hook"). It never claims, renews, releases, queues or
 * unqueues.
 *
 * The event behaviour itself (what each event prints) is specified by
 * board-harness-hooks "Session start hook", "Stop hook" and "Pre-tool-use
 * claim check"; this module owns the protocol around it: arguments,
 * payload, actor, board discovery, the read-only view of the board, the
 * budget and the escape hatch.
 */

import type { BoardState, Ticket } from '../events/fold.js';
import type { Env } from './text.js';

/** The events, in the order help and the argument-error line name them. */
export const HOOK_EVENTS = ['session-start', 'stop', 'pre-tool-use'] as const;

/** One hook event. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The internal time budget of one hook run, in milliseconds (design.md
 * decision 3; the settings `timeout` the `claude-hooks` target writes is 5
 * seconds). For the executable it runs from the start of the process
 * (`performance.timeOrigin`), not from the start of `runHookProcess`, so
 * Node's own start-up and module loading count against it and a loaded
 * machine still gets its answer within about the budget.
 */
export const HOOK_BUDGET_MS = 2000;

/**
 * The escape hatch: when this environment variable is exactly `off`,
 * every hook run exits 0 at once with no output on stdout or stderr,
 * before reading stdin, parsing its arguments or looking for a board.
 * Any other value (`on`, `0`, `OFF`, empty) leaves the hooks on.
 */
export const HOOKS_ENV = 'AGENTBOARD_HOOKS';

/** A parsed hook payload: always a plain object. */
export type HookPayload = Readonly<Record<string, unknown>>;

/**
 * Parses the harness payload. An empty text, text that is not JSON, and
 * JSON whose top level is not an object (an array, `null`, a string, a
 * number, a boolean) all give `{}`. Never throws. Pure.
 */
export function parseHookPayload(text: string): HookPayload {
  void text;
  throw new Error('not implemented');
}

/**
 * The actor of a hook run (board-harness-hooks "Hook actor resolution"):
 * `given` (the `--as` value) when it is a non-empty string, else
 * `AGENTBOARD_ACTOR` from `env` when non-empty, else null. Never the OS
 * user (`USER`, `LOGNAME`, `USERNAME`) and never anything from the
 * payload.
 *
 * A resolved name that could not be used by a writing command is treated
 * as no actor (null) rather than refused, since a hook never fails:
 * the reserved actor `agentboard` (board-events "Reserved system actor"),
 * a name in which `secretPatternsIn` finds a secret pattern, and a name
 * outside the actor form `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$` (the form
 * the pending change `actor-secret-check` makes the rule for every
 * command). Such a name is therefore never repeated in hook output. Pure.
 */
export function resolveHookActor(given: string | undefined, env: Env): string | null {
  void given;
  void env;
  throw new Error('not implemented');
}

/** What a hook reads of the board: a snapshot, with no connection left open. */
export interface HookView {
  /** Absolute path of the board directory found by discovery. */
  readonly boardDir: string;
  /** The folded state exactly as the cache holds it (`readState`), not caught up. */
  readonly state: BoardState;
}

/** Options of `readHookView`. */
export interface HookViewOptions {
  /**
   * Directory discovery starts from: the payload's `cwd` when it is a
   * non-empty string naming an existing directory (resolved against the
   * process directory when relative), else the process directory. The
   * usual discovery rules apply (`locateBoard`: `AGENTBOARD_DIR`, then the
   * git common directory, so a linked worktree finds the main checkout's
   * board, then `./.board`).
   */
  readonly cwd: string;
  /** Environment for discovery (`AGENTBOARD_DIR`) and its git child. */
  readonly env: Env;
  /**
   * The time, on the `now` clock, by which the read must be over; a read
   * that would wait past it (a locked cache) gives up and returns null.
   */
  readonly deadline: number;
  /** The clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Reads the board for a hook, read-only: discovery from `options.cwd`,
 * then the cache opened for inspection only (as `rebuild --check` opens
 * it: never created, migrated or written, no catch-up, no reaping, no
 * grant), the state read in one snapshot, the connection closed.
 *
 * Returns null, writing nothing and creating no file in the board
 * directory, when there is no board, when the cache file is missing,
 * is not a cache of the current schema version (an earlier or later
 * agentboard's) or cannot be read, and when the cache stays locked
 * until `options.deadline`. Never throws.
 */
export function readHookView(options: HookViewOptions): HookView | null {
  void options;
  throw new Error('not implemented');
}

/**
 * The tickets `actor` holds (board-harness-hooks "Hook actor resolution";
 * design.md decision 11): every ticket of `state` that is not closed and
 * whose `assignee` is `actor`, whatever the state of its lease (live,
 * expired or claimable: a lapsed lease is held until another actor takes
 * it over), in ticket id order. Being queued for a ticket (a waiter in
 * its `queue`) is not holding it, and a grant that is due but not yet
 * written (so not in `state`) makes no one the holder. Pure.
 */
export function heldTickets(state: BoardState, actor: string): Ticket[] {
  void state;
  void actor;
  throw new Error('not implemented');
}

/** One hook run, with the payload already read. */
export interface HookRequest {
  /** The arguments after `hook`: `<event> [--strict] [--as <actor>] [--json]`. */
  readonly argv: readonly string[];
  /** The raw payload text from stdin (`parseHookPayload` reads it). */
  readonly payload: string;
  /** The process directory (discovery uses the payload's `cwd` first). */
  readonly cwd: string;
  readonly env: Env;
  /** The clock for the budget and for lease states; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * When the run started, on the `now` clock; defaults to `now()` at the
   * call. The deadline is `startedAt + budgetMs`.
   */
  readonly startedAt?: number;
  /** The budget of this run in milliseconds; defaults to `HOOK_BUDGET_MS`. */
  readonly budgetMs?: number;
}

/** The answer of one hook run. */
export interface HookOutcome {
  /** 0 continues; 2 blocks, only ever with `--strict`. */
  readonly exitCode: 0 | 2;
  /** Empty, or exactly one JSON document followed by a newline. */
  readonly stdout: string;
  /** Empty, or exactly one line ending with a newline. */
  readonly stderr: string;
}

/**
 * Runs one hook (the core of `agentboard hook`, with the payload already
 * read). Never throws and never writes events.
 *
 * 1. When `HOOKS_ENV` is `off`: exit 0, stdout and stderr empty.
 * 2. Arguments: exactly one event of `HOOK_EVENTS`, then any of
 *    `--strict`, `--as <actor>` and `--json` (accepted and ignored: the
 *    answer is always the hook protocol). Anything else (no event, an
 *    unknown event, an unknown flag, a missing `--as` value, an extra
 *    positional) is exit 0, stdout empty, and one stderr line naming
 *    `session-start`, `stop` and `pre-tool-use` that repeats no part of
 *    the arguments or the payload (board-cli "Refusals never repeat the
 *    refused input").
 * 3. The payload is parsed with `parseHookPayload`.
 * 4. The actor is `resolveHookActor(--as, env)`. With no actor, `stop`
 *    and `pre-tool-use` answer exit 0 with stdout and stderr empty, and
 *    `session-start` answers exit 0 with stderr empty and, when discovery
 *    (as in step 5) finds a board (`boardExists`; its cache is not
 *    needed), stdout exactly one JSON document,
 *    `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}`
 *    and a newline, whose text is one line naming `AGENTBOARD_ACTOR` and
 *    `--as` (and no actor value); where there is no board, stdout is
 *    empty. The cache is not read.
 * 5. The board is read with `readHookView` (discovery from the payload's
 *    `cwd`, see `HookViewOptions.cwd`), with the deadline
 *    `startedAt + budgetMs`. A null view is exit 0 with stdout empty and
 *    at most one stderr line.
 * 6. The event answers as its requirement says (board-harness-hooks
 *    "Session start hook", "Stop hook", "Pre-tool-use claim check"),
 *    holding computed with `heldTickets`.
 *
 * Any error thrown inside, and running past the deadline, is exit 0
 * with stdout empty and at most one stderr line. The answer is given by
 * the deadline plus the time of one bounded step, so well within 3
 * seconds of `startedAt` for the default budget.
 */
export function runHook(request: HookRequest): HookOutcome {
  void request;
  throw new Error('not implemented');
}

/** Where the payload is read from: `process.stdin` for the executable. */
export type HookInput = AsyncIterable<string | Uint8Array> & { readonly isTTY?: boolean };

/**
 * Reads the whole payload from `input` as UTF-8, resolving at end of
 * input. Resolves `''` at once when `input.isTTY` is true (a person ran
 * the command in a terminal), and resolves `''` when the input has not
 * ended within `timeoutMs`, or fails. Never rejects, and never keeps the
 * process alive after it has resolved.
 */
export function readHookStdin(input: HookInput, timeoutMs: number): Promise<string> {
  void input;
  void timeoutMs;
  throw new Error('not implemented');
}

/**
 * True when the executable should hand `argv` (the arguments after the
 * program name) to `runHookProcess` rather than to the ordinary CLI:
 * `argv[0]` is `hook` and no `--help` or `-h` appears before a lone `--`
 * (`agentboard hook --help` prints the command's help like every other
 * command). Pure.
 */
export function isHookInvocation(argv: readonly string[]): boolean {
  void argv;
  throw new Error('not implemented');
}

/** The process surroundings of `runHookProcess`. */
export interface HookProcessIo {
  /** The arguments after `hook`. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Env;
  readonly stdin: HookInput;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * `agentboard hook` for the executable (`src/cli.ts` calls it, instead of
 * the ordinary CLI, when `isHookInvocation` holds): when `HOOKS_ENV` is
 * `off`, resolves 0 at once without reading stdin; otherwise reads the
 * payload with `readHookStdin` until the deadline, the process start
 * (`performance.timeOrigin`) plus `HOOK_BUDGET_MS`, runs `runHook` with
 * `startedAt` the process start, writes its stdout and stderr, stops
 * reading stdin (so an input that never ends does not keep the process
 * alive), and resolves its exit code. The process therefore exits within
 * about `HOOK_BUDGET_MS` of its start, Node's start-up included. Never rejects; never resolves any code but 0 or
 * 2 (board-cli "Exit codes": the codes 1, 3, 4 and 5 and the board-error
 * 2 are never reported).
 */
export function runHookProcess(io: HookProcessIo): Promise<0 | 2> {
  void io;
  throw new Error('not implemented');
}
