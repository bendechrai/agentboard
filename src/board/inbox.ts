/**
 * `inbox` (board-concurrency: "Inbox never misses an event";
 * board-openspec-integration: "Orchestrator inbox protocol"; board-cli:
 * "Command surface", "Actor is explicit").
 *
 * The inbox of an actor is every effective event (an event the fold
 * applied: `folded.folded = 1`; rejected, unknown-kind and malformed events
 * are never listed) that is pending for the actor's cursor
 * (`isPending`, `src/store/cursors.ts`), in fold order. It includes events
 * of every kind, `board.meta` included, on every ticket, and the actor's
 * own events: the spec asks for every effective event, and an orchestrator
 * that also writes (import, close) still sees one ordered record of the
 * board. Consumers that want only others' events filter on `from`.
 */

import type { Hlc } from '../events/hlc.js';
import type { BoardEvent, KnownKind, Status } from '../events/schema.js';
import type { Board } from '../store/board.js';
import { catchUp } from '../store/cache.js';
import {
  advanceCursor,
  comparePositions,
  readCursor,
  writeCursor,
  type Cursor,
} from '../store/cursors.js';
import { inImmediate, inSnapshot } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { readEventFile } from '../store/eventfile.js';
import { recordedPosition, recordedPositions } from '../store/folded.js';
import { pendingPositions, toEntries } from './pending.js';

/**
 * One inbox entry: an effective event, with the fields an orchestrator
 * acts on lifted out of its body. Also the `--json` form of each entry and
 * of each `watch --json` line.
 */
export interface InboxEntry {
  /** The event hash (its file name without `.json`); usable with `--since`. */
  hash: string;
  kind: KnownKind;
  /** The ticket id, or null for `board.meta`. */
  ticket: string | null;
  /** The event's actor: who did it. */
  from: string;
  ts: Hlc;
  /**
   * The actor the event hands the ticket to: `body.to` of
   * `ticket.handoff` and `ticket.assign`; null for every other kind.
   */
  to: string | null;
  /**
   * The status the event moves the ticket to: `body.status` of
   * `ticket.handoff`, `body.to` of `ticket.move`; null for every other
   * kind.
   */
  status: Status | null;
  /**
   * The free text a reader acts on: `body.note` of `ticket.handoff`,
   * `body.text` of `ticket.comment`; null for every other kind.
   */
  note: string | null;
  /** The whole event as written (its canonical encoding is the file). */
  event: BoardEvent;
}

/** Options of `readInbox`. */
export interface InboxOptions {
  /**
   * `--peek`: list the pending entries without advancing the stored
   * cursor. No cursor row is written.
   */
  peek?: boolean | undefined;
  /**
   * `--since <hash>`: list the effective events that sort strictly after
   * the event with this hash, in fold order, ignoring the stored cursor
   * entirely (neither read nor written: `--since` implies `--peek`). The
   * hash must be a full 64-character lowercase hex hash of a well-formed
   * event on this board (any fold outcome; a rejected event's position is
   * a valid starting point).
   */
  since?: string | undefined;
}

/** Result of `readInbox`; also the `inbox --json` document. */
export interface InboxResult {
  actor: string;
  /** In fold order; empty when nothing is pending. */
  entries: InboxEntry[];
  /**
   * The hash of the stored cursor's position after the call (the last
   * event acknowledged), or null when the actor has none. With `peek` or
   * `since`, the stored cursor as it was.
   */
  cursor: string | null;
  /** True exactly when this call wrote a new cursor (entries were delivered). */
  advanced: boolean;
}

/**
 * `inbox --as <actor> [--since <hash>] [--peek]`.
 *
 * Without `peek` or `since`, in one `BEGIN IMMEDIATE` transaction on
 * `board.db` (with the busy retry, then `BoardError(5, 'busy')`): catch-up
 * (so events written or synced since the board was opened are folded, and
 * late events have reset the cursor); reads the cursor; lists the effective
 * events for which `isPending` is true, in fold order; stores
 * `advanceCursor(cursor, <entries>)` when there is at least one; commits.
 * Two concurrent calls for one actor therefore never deliver the same
 * event twice. A second call with no new events returns no entries.
 *
 * With `peek`: the same entries (catch-up, then a read), and the stored
 * cursor is not changed, so two peeks with nothing new in between return
 * the same entries, and a later `inbox` still returns them.
 *
 * With `since`: see `InboxOptions.since`.
 *
 * Event bodies are read from the event files of the listed events; ticket
 * state is not consulted.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 * @throws BoardError exit 1 `usage` when `since` is not a 64-character
 *   lowercase hex string.
 * @throws BoardError exit 1 `unknown-cursor` when `since` names no
 *   well-formed event of this board.
 */
export function readInbox(board: Board, actor: string, options?: InboxOptions): InboxResult {
  if (actor === '') {
    throw new BoardError(
      1,
      'missing-actor',
      'inbox needs an actor: pass --as <actor> or set AGENTBOARD_ACTOR',
    );
  }
  const { since } = options ?? {};
  if (since !== undefined) {
    return readSince(board, actor, since);
  }
  const { db } = board;
  if (options?.peek === true) {
    catchUp(board);
    return inSnapshot(db, () => {
      const cursor = readCursor(db, actor);
      return result(
        actor,
        toEntries(board, pendingPositions(db, cursor), readEventFile),
        cursor,
        false,
      );
    });
  }
  return inImmediate(db, () => {
    catchUp(board);
    const cursor = readCursor(db, actor);
    const entries = toEntries(board, pendingPositions(board.db, cursor), readEventFile);
    if (entries.length === 0) {
      return result(actor, entries, cursor, false);
    }
    const next = advanceCursor(cursor, entries);
    writeCursor(db, next);
    return result(actor, entries, next, true);
  });
}

/** `readInbox` with `since`. */
function readSince(board: Board, actor: string, since: string): InboxResult {
  if (!/^[0-9a-f]{64}$/.test(since)) {
    throw new BoardError(
      1,
      'usage',
      '--since takes the full 64-character lowercase hex hash of an event',
    );
  }
  const { db } = board;
  catchUp(board);
  return inSnapshot(db, () => {
    const start = recordedPosition(db, since);
    if (start === null) {
      throw new BoardError(1, 'unknown-cursor', `no event ${since} on this board`);
    }
    const after = recordedPositions(db, { effectiveOnly: true, minWall: start.ts.wall }).filter(
      (p) => comparePositions(p, start) > 0,
    );
    return result(actor, toEntries(board, after, readEventFile), readCursor(db, actor), false);
  });
}

function result(
  actor: string,
  entries: InboxEntry[],
  cursor: Cursor,
  advanced: boolean,
): InboxResult {
  return { actor, entries, cursor: cursor.position?.hash ?? null, advanced };
}
