/**
 * The single command transaction (board-cache: "One command, one
 * transaction"; board-concurrency: "Crash consistency"; add-board-core design.md: "One
 * transaction per command, event file inside it").
 */

import { writeSync } from 'node:fs';

import { canonicalHash } from '../events/canonical.js';
import type { ApplyOutcome, BoardState, FoldInput, Ticket } from '../events/fold.js';
import { nextHlc, type Hlc } from '../events/hlc.js';
import { formatTaskRef, validateEvent, type BoardEvent, type TaskRef } from '../events/schema.js';
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
 * An ordered list of one or two events an operation asks to write in one
 * transaction (board-cache: "One command, one transaction"): for a `move
 * merged` or `close` given a scope disposition, the `ticket.unplanned` or
 * `ticket.link` first and then the `ticket.move` or `ticket.close`. The
 * tuple type is the whole contract on length: there is no runtime check
 * for a longer list.
 */
export type ProposedEvents = readonly [ProposedEvent] | readonly [ProposedEvent, ProposedEvent];

/**
 * An operation's answer: the event to write, an ordered list of one or two
 * events to write together (`events`; a one-element list behaves exactly
 * as `event`), or a refusal.
 *
 * A refusal carries the exit code class (1 usage, 4 rejected by board
 * state, 5 integrity), a reason token (for exit 4, a fold rejection reason
 * where one applies, such as `already-assigned`) and an ASCII message (for
 * `already-assigned`, naming the current assignee).
 */
export type Decision =
  | { ok: true; event: ProposedEvent }
  | { ok: true; events: ProposedEvents }
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

/** One event file a command wrote. */
export interface WrittenEvent {
  /** Hash (file name without `.json`) of the written event. */
  hash: string;
  /** Absolute path of the written event file. */
  path: string;
  /** The event as written: `canonicalEncode(event)` is the file's bytes. */
  event: BoardEvent;
}

/**
 * Result of a successful `runCommand`. `hash`, `path` and `event` describe
 * the last event written (the only one for a single-event command), so a
 * caller that knows nothing of two-event commands keeps working; `events`
 * lists every event written, in write order (one or two entries, the last
 * equal to `hash`, `path` and `event`).
 */
export interface CommandResult {
  /** Hash (file name without `.json`) of the last written event. */
  hash: string;
  /** Absolute path of the last written event file. */
  path: string;
  /** The last event as written: `canonicalEncode(event)` is the file's bytes. */
  event: BoardEvent;
  /** Every event written by this command, in write order. */
  events: WrittenEvent[];
  /**
   * The last event's ticket after every event was applied (`readTicket`),
   * or null for `board.meta`.
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
 *    that crashed after its rename, are folded before validation, and the
 *    grants due at `t` are written and folded (with the command's write
 *    hooks), so the operation decides against the granted state.
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
 * Two events (board-cache: "One command, one transaction"; design.md
 * section 4). When the operation answers with `events` of length two, steps
 * 3 to 6 run for each in order against one fold session: the first event
 * gets `nextHlc(latest, t, actor)` and the second `nextHlc(<first ts>, t,
 * actor)` (the same `t`: `now` is still called exactly once), so the
 * second always sorts after the first; each is validated by `validateEvent`
 * and then folded in memory against the state the earlier one leaves. A
 * malformed event (either one) is `BoardError(1, 'malformed-event')`; a
 * fold rejection of either is `BoardError(4, <that event's reason>)`, for
 * example `already-linked` from a `ticket.unplanned` on a linked ticket
 * before the move is even looked at, or `invalid-transition` from the
 * close of a ticket in `implementing` after its `ticket.link` was accepted
 * in memory. Any refusal refuses the whole command: no file of either event
 * is written, not even a temporary one, and no row changes (board-cache:
 * "Second event refused"). Only once both are accepted are the files
 * written, first then second, each with `writeEventFile` and the `existed`
 * check of step 5; then the rows of both are applied, both are recorded in
 * `folded`, `last_position` is the second, and one commit follows. A crash
 * after the first rename and before the second leaves the disposition
 * without its move or close, which the next catch-up folds as a valid
 * state (board-cache: "Crash between the disposition and the move"); the
 * reverse cannot happen. `CommandResult.events` lists both, and `hash`,
 * `path` and `event` are the second's.
 *
 * If steps 2 to 4 refuse, the command's own event is never written (no file,
 * not even a temporary one, and no row of its own), and the transaction is
 * committed with only what step 1 did: a grant catch-up wrote is a derived
 * event independent of this command, so its file stays and the cache keeps
 * it folded. If anything else throws after `BEGIN` (including a hook, which
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
    // 1. Catch-up, under the write lock, writing the grants due at t.
    const catchUp = catchUpLocked(board, t, { hooks });

    // 2 to 4. Decide. A refusal commits what catch-up did (folded files and
    // written grants, which do not depend on this command) and nothing else.
    let decided: Decided;
    try {
      decided = decide(board, actor, operation, t);
    } catch (error) {
      if (error instanceof BoardError) {
        db.exec('COMMIT');
      }
      throw error;
    }
    const { session, events: accepted } = decided;

    // 5. Write the event files (atomic), in order. Every event was accepted
    // in memory before the first file is written, so a refusal never
    // leaves a file behind.
    const write = (event: BoardEvent, before: readonly WrittenEvent[]): WrittenEvent => {
      const written = writeEventFile(board.eventsDir, event, hooks);
      if (written.existed) {
        // Catch-up recorded every file and ts sorts after all of them, so the
        // file can only have been dropped out of band since: never fold it here.
        // An earlier event of the same command is already on disk and is folded
        // by the next catch-up, so the message names it.
        const left =
          before.length === 0
            ? 'nothing was written'
            : `${before.map((w) => w.path).join(', ')} was written and is folded by the next command`;
        throw new BoardError(
          5,
          'integrity',
          `event file ${written.path} appeared while the command ran; ${left}`,
        );
      }
      return { hash: written.hash, path: written.path, event };
    };
    const [firstAccepted, ...moreAccepted] = accepted;
    let last = write(firstAccepted.event, []);
    const events = [last];
    for (const next of moreAccepted) {
      last = write(next.event, events);
      events.push(last);
    }

    // 6. Apply to rows (the session holds the state after every event; the
    // first flush writes it and each event is recorded in turn, so the last
    // position is the last event's), then 7. commit.
    for (const { input, outcome } of accepted) {
      commitOwnEvent(db, session, input, outcome);
    }
    const ticket = last.event.kind === 'board.meta' ? null : readTicket(db, last.event.ticket);
    db.exec('COMMIT');
    return { hash: last.hash, path: last.path, event: last.event, events, ticket, catchUp };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

/** One of the command's events, validated and applied in memory by steps 3 and 4. */
interface Accepted {
  event: BoardEvent;
  input: FoldInput;
  outcome: ApplyOutcome;
}

/**
 * The command's events in write order, validated and applied in memory by
 * steps 2 to 4 against one fold session.
 */
interface Decided {
  session: FoldSession;
  events: readonly [Accepted, ...Accepted[]];
}

/**
 * Steps 2 to 4 of `runCommand`: the operation decides against the
 * caught-up state, then each proposed event in order is built later than
 * every folded event and than the one before it, and validated with the
 * fold's own rules against the state the earlier events leave. Writes
 * nothing (the fold session only applies the events in memory); a refusal
 * of any event is a `BoardError`.
 */
function decide(board: Board, actor: string, operation: Operation, t: number): Decided {
  const { db } = board;
  const decision = operation({
    actor,
    ticket: (id) => readTicket(db, id),
    state: () => readState(db),
  });
  if (!decision.ok) {
    throw new BoardError(decision.exitCode, decision.reason, decision.message);
  }
  const proposed: ProposedEvents = 'events' in decision ? decision.events : [decision.event];
  const [firstProposed, ...moreProposed] = proposed;
  const session = new FoldSession(db);
  let ts = nextHlc(readLastPosition(db)?.ts ?? null, t, actor);
  const first = accept(session, build(firstProposed, actor, ts));
  const more: Accepted[] = [];
  for (const next of moreProposed) {
    ts = nextHlc(ts, t, actor);
    more.push(accept(session, build(next, actor, ts)));
  }
  return { session, events: [first, ...more] };
}

/**
 * Step 3: the full event of a proposed one, with `v` 1, the actor and
 * `ts`, or `BoardError(1, 'malformed-event')` naming the offending fields
 * or the unknown kind.
 */
function build(proposed: ProposedEvent, actor: string, ts: Hlc): BoardEvent {
  const built = { v: 1, ...proposed, actor, ts };
  const validated = validateEvent(built);
  if (!validated.ok) {
    const fields = validated.reasons.map((r) => `${r.field}: ${r.message}`).join('; ');
    throw new BoardError(1, 'malformed-event', `the event is malformed (${fields})`);
  }
  if (!validated.known) {
    throw new BoardError(1, 'malformed-event', `unknown event kind ${built.kind}`);
  }
  return validated.event;
}

/**
 * The message of a `BoardError(4, 'already-linked')`: the fold's refusal of
 * `kind` (a `ticket.unplanned`) on `ticket`, naming the task reference
 * `task` it already has. Shared with `closeTicket` (`src/board/actions.ts`),
 * which raises the same refusal before its decision guard.
 */
export function alreadyLinkedMessage(kind: string, ticket: string, task: TaskRef): string {
  return `${kind} on ticket ${ticket} refused: already-linked (it is linked to ${formatTaskRef(task)})`;
}

/**
 * Step 4: applies `event` to `session` in memory with the fold's own rules,
 * or throws `BoardError(4, <fold rejection reason>)`; the message of
 * `already-assigned` names the current assignee and that of
 * `already-linked` the task reference the ticket already has.
 */
function accept(session: FoldSession, event: BoardEvent): Accepted {
  const input = { hash: canonicalHash(event), event };
  const before = event.kind === 'board.meta' ? null : session.ticket(event.ticket);
  const outcome = session.apply(input);
  if (outcome.status === 'rejected') {
    const { reason, ticket, kind } = outcome.rejected;
    const task = before?.task ?? null;
    const message =
      reason === 'already-assigned'
        ? `ticket ${ticket} is already assigned to ${String(before?.assignee)}`
        : reason === 'already-linked' && task !== null
          ? alreadyLinkedMessage(kind, ticket, task)
          : `${kind} on ticket ${ticket} refused: ${reason}`;
    throw new BoardError(4, reason, message);
  }
  return { event, input, outcome };
}

/**
 * Environment variable for crash injection. When set to one of the
 * `PausePoint` values, a command pauses at that point of the first event
 * file it writes, whether its own event or a grant written by its catch-up
 * (when the board is opened or inside the command transaction), so a
 * read-only command that writes a due grant pauses too: it prints
 * `agentboard: paused at <point> <path>` plus a newline to stderr and then
 * blocks synchronously (never returning) until the process is killed. A
 * test kills it with SIGKILL there. Any other value, and the empty string,
 * is ignored.
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
