/**
 * The single command transaction (board-cache: "One command, one
 * transaction"; board-concurrency: "Crash consistency"; design.md: "One
 * transaction per command, event file inside it").
 */

import type { BoardState, Ticket } from '../events/fold.js';
import type { BoardEvent } from '../events/schema.js';
import type { Board } from './board.js';
import type { CatchUpReport } from './cache.js';
import type { WriteHooks } from './eventfile.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The event an operation asks to write: a `BoardEvent` without `v`, `actor`
 * and `ts`, which the transaction fills in (`v` 1, the command's actor, and
 * the hybrid timestamp). For a `ticket.create` the operation chooses the
 * ticket id (normally `newUlid()`).
 */
export type ProposedEvent = DistributiveOmit<BoardEvent, 'v' | 'actor' | 'ts'>;

/**
 * An operation's answer: the event to write, or a refusal.
 *
 * A refusal carries the exit code class (1 usage, 4 rejected by board
 * state, 5 integrity), a reason token (for exit 4, a fold rejection reason
 * where one applies, such as `already-assigned`) and an ASCII message (for
 * `already-assigned`, naming the current assignee).
 */
export type Decision =
  | { ok: true; event: ProposedEvent }
  | { ok: false; exitCode: 1 | 4 | 5; reason: string; message: string };

/**
 * What an operation sees: the command's actor and the cache state after
 * catch-up, read inside the write lock.
 */
export interface TxContext {
  readonly actor: string;
  /** `readTicket` on the transaction's connection. */
  ticket(id: string): Ticket | null;
  /** `readState` on the transaction's connection. */
  state(): BoardState;
}

/**
 * A command's logic: inspects the current state and proposes one event or
 * refuses. Must be synchronous and must not write to the board itself. It
 * may throw; the exception propagates after rollback.
 */
export type Operation = (ctx: TxContext) => Decision;

/** Options for `runCommand`. */
export interface CommandOptions {
  /** Wall clock in ms since the epoch. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Crash-injection hooks passed to `writeEventFile`. When given they
   * replace the hooks derived from the environment (`pauseHooks`).
   */
  hooks?: WriteHooks;
  /** Environment for `pauseHooks`. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Result of a successful `runCommand`. */
export interface CommandResult {
  /** Hash (file name without `.json`) of the written event. */
  hash: string;
  /** Absolute path of the written event file. */
  path: string;
  /** The event as written: `canonicalEncode(event)` is the file's bytes. */
  event: BoardEvent;
  /**
   * The event's ticket after the event was applied (`readTicket`), or null
   * for `board.meta`.
   */
  ticket: Ticket | null;
  /** Report of the catch-up run at the start of the transaction. */
  catchUp: CatchUpReport;
}

/**
 * Runs one writing command as one transaction. `options.now` is called
 * exactly once, after the write lock is taken; its value `t` is the clock
 * for both steps 1 and 3. Order, inside a single `BEGIN IMMEDIATE` on
 * `board.db`:
 *
 * 1. Catch-up (`catchUp` with `now: t`, so stale temp reaping uses the same
 *    clock), so files written by other processes, or left by a command
 *    that crashed after its rename, are folded before validation.
 * 2. `operation(ctx)`. A refusal rolls back and throws
 *    `BoardError(decision.exitCode, decision.reason, decision.message)`.
 * 3. Builds the event: `{ v: 1, ...proposed, actor, ts }` with
 *    `ts = nextHlc(latest, t, actor)`, where `latest` is the fold
 *    position of the greatest well-formed event in the cache (so `ts` is
 *    later than every folded event, even one from the future). If
 *    `validateEvent` reports it malformed, or it is of an unknown kind,
 *    rolls back and throws `BoardError(1, 'malformed-event', ...)` naming the
 *    offending fields.
 * 4. Validates it against the current state with the fold's own rules
 *    (state machine, assignment, existence, checklist range, task link),
 *    reusing the rules in `src/events/fold.ts` rather than restating them. If
 *    the fold would reject it, rolls back and throws `BoardError(4, <fold
 *    rejection reason>, ...)`; for `already-assigned` the message names the
 *    current assignee.
 * 5. Writes the event file with `writeEventFile` (atomic temp write, fsync,
 *    rename, directory fsync), passing the hooks.
 * 6. Applies the event to the cache rows, records it in `folded` as
 *    applied, and updates `last_position`.
 * 7. Commits.
 *
 * If steps 2 to 4 refuse, no file is created (not even a temporary one) and
 * no row changes. If anything throws after `BEGIN` (including a hook, which
 * is how tests simulate a crash), the transaction is rolled back and the
 * exception propagates; an event file already renamed into place stays and
 * is folded by the next catch-up. If `BEGIN IMMEDIATE` is still busy after
 * the busy timeout it is retried once; a second failure throws
 * `BoardError(5, 'busy', ...)`.
 *
 * @throws BoardError exit 1 reason `missing-actor` when `actor` is empty,
 *   before anything is read or written.
 */
export function runCommand(
  board: Board,
  actor: string,
  operation: Operation,
  options?: CommandOptions,
): CommandResult {
  void board;
  void actor;
  void operation;
  void options;
  throw new Error('not implemented');
}

/**
 * Environment variable for crash injection (task 4.4). When set to one of
 * the `PausePoint` values, a writing command pauses at that point of the
 * event write: it prints `agentboard: paused at <point> <path>` plus a
 * newline to stderr and then blocks synchronously (never returning) until
 * the process is killed. A test kills it with SIGKILL there. Any other
 * value, and the empty string, is ignored.
 */
export const TEST_PAUSE_ENV = 'AGENTBOARD_TEST_PAUSE';

/**
 * Points where `AGENTBOARD_TEST_PAUSE` can pause: after the temporary file
 * is written and fsynced (before the rename), and after the rename (before
 * the cache transaction commits).
 */
export type PausePoint = 'after-temp-write' | 'after-rename';

/**
 * Builds the write hooks for `env[TEST_PAUSE_ENV]`: for `after-temp-write`
 * only `afterTempWrite` is set, for `after-rename` only `afterRename`, and
 * for anything else (including unset) neither. The hook prints the pause
 * line and blocks forever, as described on `TEST_PAUSE_ENV`.
 */
export function pauseHooks(env: Readonly<Record<string, string | undefined>>): WriteHooks {
  void env;
  throw new Error('not implemented');
}
