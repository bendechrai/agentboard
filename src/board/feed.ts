/**
 * The board feed (board-feed; design.md: "The board feed: append or
 * resync", "Position ids and resume with a set digest", "Event files are
 * cached by hash"; add-board-web tasks 2.2 and 2.3): a stream of every
 * effective event of the board, of every kind and on every ticket,
 * independent of any actor, as `append` and `resync` messages
 * (`FeedMessage`, `src/view/types.ts`) with position ids.
 *
 * Internal to the server and the terminal UI; not re-exported from
 * `src/index.ts`.
 */

import type { BoardEvent, UnknownKindEvent } from '../events/schema.js';
import type { Board } from '../store/board.js';
import type { FeedMessage } from '../view/types.js';
import type { EventReader } from './pending.js';
import type { TickerTimers, WatchDir } from './ticker.js';

/** The digest of no event: 64 zeros. */
export const EMPTY_DIGEST = '0'.repeat(64);

/** The position id of a board with no effective event: `none.` then 64 zeros. */
export const EMPTY_POSITION_ID = `none.${EMPTY_DIGEST}`;

/** A parsed position id. */
export interface Position {
  /** The head's 64-character lowercase hex hash, or null for `none`. */
  head: string | null;
  /** 64 lowercase hex characters. */
  digest: string;
}

/**
 * The position id `<head>.<digest>`: `head` (a 64-character lowercase hex
 * hash), or `none` when `head` is null, then a dot, then `digest` (64
 * lowercase hex characters). Pure; the arguments are not checked.
 */
export function positionId(head: string | null, digest: string): string {
  void head;
  void digest;
  throw new Error('not implemented');
}

/**
 * Parses a position id. Returns null (never throws) unless `text` is
 * exactly `<head>.<digest>` where `<head>` is 64 lowercase hex characters
 * or the word `none`, and `<digest>` is 64 lowercase hex characters, with
 * nothing before, between or after them (no whitespace, no upper case).
 * `none` gives `head` null; `none` with a digest other than
 * `EMPTY_DIGEST` parses (and then never matches a board). Pure.
 */
export function parsePositionId(text: string): Position | null {
  void text;
  throw new Error('not implemented');
}

/**
 * The digest of a set of events: the bytewise XOR of their SHA-256 values
 * (32 bytes each), where each event's SHA-256 value is its hash (64
 * lowercase hex characters) decoded from hex, rendered as 64 lowercase hex
 * characters. `EMPTY_DIGEST` for no hash. Order independent. A hash given
 * more than once counts once (the argument is a set of events). Pure.
 */
export function effectiveDigest(hashes: Iterable<string>): string {
  void hashes;
  throw new Error('not implemented');
}

/**
 * A process-wide map from event hash to parsed event (design.md: "Event
 * files are cached by hash"). Event files are named by the hash of their
 * content and never modified, so each file is read at most once per cache.
 */
export interface EventCache {
  /**
   * The event of the well-formed file `<eventsDir>/<hash>.json`. The first
   * call for a hash reads the file through the cache's reader (once) and
   * keeps the event; later calls for that hash return the kept event
   * without reading anything, whatever `eventsDir` is. Callers pass only
   * hashes that `folded` records as well-formed.
   *
   * @throws BoardError exit 5 `integrity` when the file is not a
   *   well-formed event (read outcome other than `ok`); nothing is kept,
   *   so a later call reads the file again.
   * @throws the reader's error (for example an IO error) as it is; nothing
   *   is kept.
   */
  get(eventsDir: string, hash: string): BoardEvent | UnknownKindEvent;
  /** The number of events kept. */
  readonly size: number;
}

/**
 * A new, empty event cache reading files through `read` (default
 * `readEventFile`, `src/store/eventfile.ts`), so tests can count reads.
 */
export function createEventCache(read?: EventReader): EventCache {
  void read;
  throw new Error('not implemented');
}

/** Options of `watchBoard`. */
export interface WatchBoardOptions {
  /** Stops the feed. Aborting resolves the promise (after cleanup). */
  readonly signal: AbortSignal;
  /**
   * The position id the consumer last received (from a snapshot, or a
   * previous feed message). When absent, the first message is an `append`
   * of every effective event. See `watchBoard` for resume.
   */
  readonly since?: string;
  /**
   * Receives each message, synchronously, outside any transaction:
   * `board.db.isTransaction` is false while it runs, however long it
   * takes. An exception it throws is a tick failure (see `onProblem`).
   */
  onMessage(message: FeedMessage): void;
  /**
   * Receives one plain ASCII line (no newline) for each tick that failed
   * with `BoardError(5, 'busy')`; the feed carries on at the next tick.
   * Defaults to ignoring it.
   */
  onWarning?(line: string): void;
  /**
   * Receives every other error a tick throws; the feed then carries on,
   * and since its state changes only when a tick succeeds, the next tick
   * retries the same examination. When absent, such an error stops the
   * feed: cleanup as on abort, and the promise rejects with it.
   */
  onProblem?(error: unknown): void;
  /** Polling interval; defaults to `TICK_POLL_MS` (`src/board/ticker.ts`). */
  readonly pollMs?: number;
  /** When false, only polling runs. Defaults to true. */
  readonly fsWatch?: boolean;
  /**
   * The event cache to read event bodies through; defaults to a new cache
   * of this feed (`createEventCache()`). The server passes one cache shared
   * with its snapshot loader. Every event file the feed reads is read
   * through it (catch-up's own reading of newly written files is not).
   */
  readonly cache?: EventCache;
  /** Passed to the ticker (tests). */
  readonly timers?: TickerTimers;
  /** Passed to the ticker (tests). */
  readonly watchDir?: WatchDir;
}

/**
 * Follows every effective event of `board` (an event recorded in `folded`
 * as applied), running on the shared ticker (`runTicker`,
 * `src/board/ticker.ts`) over `board.eventsDir`: one tick at once (even
 * when `signal` is already aborted, so a feed started with an aborted
 * signal runs exactly its first tick and resolves), then on `fs.watch`
 * notifications and every `pollMs`.
 *
 * State. The feed keeps the set of effective events it has delivered, its
 * head (the greatest delivered event in fold order, `compareFoldOrder`:
 * `ts` by `compareHlc`, then hash) and the change marker of its last
 * examination (`PRAGMA data_version` and the connection's
 * `total_changes()`, as `watchInbox` keeps it). The state changes only
 * when a tick succeeds, including delivering its message.
 *
 * Every tick runs `catchUp(board)` first, which takes the write lock only
 * when there is something to fold or reap. When that catch-up folded
 * nothing and the change marker has not moved since the previous
 * examination, the tick ends there: it reads no event file and no
 * `folded` row, and emits nothing. Otherwise, inside one read snapshot
 * (`inSnapshot`) it lists the effective events (from `folded`, without
 * reading files), compares them with the delivered set, reads the bodies
 * of the newly effective events (through `cache`) and the ticket states
 * and meta the message needs, and computes the message's position id;
 * the snapshot is committed before `onMessage` is called. The message:
 * - an `append` when every newly effective event sorts after the head
 *   and no delivered event has stopped being effective, carrying the
 *   newly effective events in fold order (as `EventView`s with outcome
 *   `applied` and reason null), the current state of every ticket they
 *   name, and the whole `meta` when one of them is a `board.meta`;
 * - otherwise a `resync`, carrying the late events (newly effective and
 *   sorting before the head, in fold order) and the hashes of the
 *   delivered events no longer effective (in fold order);
 * - nothing when there is no newly effective event and nothing stopped
 *   being effective.
 * After a message the delivered set is every effective event, the head is
 * the greatest of them, and the message's id is `positionId(head,
 * effectiveDigest(<every effective event at or before the head>))` (all
 * of them, since the head is the greatest), computed from the same
 * snapshot.
 *
 * First tick without `since`: an `append` of every effective event, in
 * fold order, with every ticket they name; on a board with no effective
 * event, an `append` with no event, no ticket, meta null and id
 * `EMPTY_POSITION_ID`. This first message is always emitted.
 *
 * First tick with `since` (resume, board-feed: "Resume from a position
 * id"): when `since` parses (`parsePositionId`), its head is an event
 * recorded in `folded` as effective, and the digest of the effective
 * events at or before that head equals its digest, the first message is
 * an `append` of the effective events after that head (with the state of
 * the tickets they name and meta as above), or nothing when there are
 * none. The head `none` with `EMPTY_DIGEST` is the position before every
 * event: the first message is an `append` of every effective event, or
 * nothing on a board still empty. In every other case (an unparsable id,
 * a head not recorded or not effective, a digest mismatch) the first
 * message is a `resync` with the current id, no late event and nothing
 * removed; never an error. Either way the delivered set then holds every
 * effective event.
 *
 * Never reads or writes a cursor (`cursors` and `cursor_seen` rows are
 * unchanged by the feed; catch-up's own `resetLateCursors` for late
 * events is unchanged too) and writes no event. Never holds a transaction
 * while `onMessage` runs or while waiting for a timer or IO. Does not
 * close `board`.
 */
export function watchBoard(board: Board, options: WatchBoardOptions): Promise<void> {
  void board;
  void options;
  throw new Error('not implemented');
}
