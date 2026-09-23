/**
 * The single command transaction (board-cache: "One command, one
 * transaction"; board-concurrency: "Crash consistency"; design.md: "One
 * transaction per command, event file inside it").
 */

import { writeSync } from 'node:fs';

import { canonicalHash } from '../events/canonical.js';
import type { BoardState, Ticket } from '../events/fold.js';
import { nextHlc } from '../events/hlc.js';
import { validateEvent, type BoardEvent } from '../events/schema.js';
import type { Board } from './board.js';
import { readState, readTicket, type CatchUpReport } from './cache.js';
import {
  FoldSession,
  beginImmediate,
  catchUpLocked,
  commitOwnEvent,
  readLastPosition,
  rollback,
} from './engine.js';
import { BoardError } from './errors.js';
import { writeEventFile, type WriteHooks } from './eventfile.js';

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
 *    rename, directory fsync), passing the hooks. The event's `ts` sorts
 *    after every event catch-up recorded, so its file cannot legitimately
 *    exist yet: if `writeEventFile` reports `existed: true` (a file with the
 *    event's exact bytes appeared that catch-up did not record), or throws
 *    `BoardError(5, 'integrity')` because a file of that name holds other
 *    bytes, the command rolls back and throws `BoardError(5, 'integrity',
 *    ...)` naming the path. No file is written or modified and no row
 *    changes.
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
 * @throws BoardError exit 5 reason `integrity` as described in step 5.
 */
export function runCommand(
  board: Board,
  actor: string,
  operation: Operation,
  options?: CommandOptions,
): CommandResult {
  if (actor === '') {
    throw new BoardError(1, 'missing-actor', 'an actor is required to write to the board');
  }
  const hooks = options?.hooks ?? pauseHooks(options?.env ?? process.env);
  const now = options?.now ?? Date.now;
  const { db } = board;
  beginImmediate(db);
  try {
    const t = now();
    // 1. Catch-up, under the write lock.
    const catchUp = catchUpLocked(board, t);

    // 2. The operation decides against the caught-up state.
    const decision = operation({
      actor,
      ticket: (id) => readTicket(db, id),
      state: () => readState(db),
    });
    if (!decision.ok) {
      throw new BoardError(decision.exitCode, decision.reason, decision.message);
    }

    // 3. Build the event, later than every folded event.
    const ts = nextHlc(readLastPosition(db)?.ts ?? null, t, actor);
    const built = { v: 1, ...decision.event, actor, ts };
    const validated = validateEvent(built);
    if (!validated.ok) {
      const fields = validated.reasons.map((r) => `${r.field}: ${r.message}`).join('; ');
      throw new BoardError(1, 'malformed-event', `the event is malformed (${fields})`);
    }
    if (!validated.known) {
      throw new BoardError(1, 'malformed-event', `unknown event kind ${built.kind}`);
    }
    const event = validated.event;

    // 4. Validate against the current state with the fold's own rules.
    const input = { hash: canonicalHash(event), event };
    const session = new FoldSession(db);
    const holder = event.kind === 'board.meta' ? null : session.ticket(event.ticket)?.assignee;
    const outcome = session.apply(input);
    if (outcome.status === 'rejected') {
      const { reason, ticket, kind } = outcome.rejected;
      const message =
        reason === 'already-assigned'
          ? `ticket ${ticket} is already assigned to ${String(holder)}`
          : `${kind} on ticket ${ticket} refused: ${reason}`;
      throw new BoardError(4, reason, message);
    }

    // 5. Write the event file (atomic), then 6. apply to rows and 7. commit.
    const written = writeEventFile(board.eventsDir, event, hooks);
    if (written.existed) {
      // Catch-up recorded every file and ts sorts after all of them, so the
      // file can only have been dropped out of band since: never fold it here.
      throw new BoardError(
        5,
        'integrity',
        `event file ${written.path} appeared while the command ran; nothing was written`,
      );
    }
    commitOwnEvent(db, session, input, outcome);
    const ticket = event.kind === 'board.meta' ? null : readTicket(db, event.ticket);
    db.exec('COMMIT');
    return { hash: written.hash, path: written.path, event, ticket, catchUp };
  } catch (error) {
    rollback(db);
    throw error;
  }
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
  const point = env[TEST_PAUSE_ENV];
  if (point === 'after-temp-write') {
    return { afterTempWrite: (path) => pauseForever(point, path) };
  }
  if (point === 'after-rename') {
    return { afterRename: (path) => pauseForever(point, path) };
  }
  return {};
}

/** Prints the pause line to stderr and blocks the thread until the process is killed. */
function pauseForever(point: PausePoint, path: string): never {
  writeSync(2, `agentboard: paused at ${point} ${path}\n`);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    Atomics.wait(cell, 0, 0);
  }
}
