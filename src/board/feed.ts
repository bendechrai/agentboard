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

import type { JsonValue } from '../events/canonical.js';
import type { Ticket } from '../events/fold.js';
import type { Hlc } from '../events/hlc.js';
import type { BoardEvent, UnknownKindEvent } from '../events/schema.js';
import type { Board } from '../store/board.js';
import { catchUp } from '../store/cache.js';
import { comparePositions } from '../store/cursors.js';
import { inSnapshot, loadMeta, loadTicket } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { readEventFile } from '../store/eventfile.js';
import { changeMarker, recordedPositions } from '../store/folded.js';
import type { EventView, FeedMessage } from '../view/types.js';
import type { EventReader } from './pending.js';
import { runTicker, type TickerOptions, type TickerTimers, type WatchDir } from './ticker.js';

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
  return `${head ?? 'none'}.${digest}`;
}

/** A position id: `none` or a 64-hex head, a dot, a 64-hex digest. */
const POSITION_ID = /^(none|[0-9a-f]{64})\.([0-9a-f]{64})$/;

/**
 * Parses a position id. Returns null (never throws) unless `text` is
 * exactly `<head>.<digest>` where `<head>` is 64 lowercase hex characters
 * or the word `none`, and `<digest>` is 64 lowercase hex characters, with
 * nothing before, between or after them (no whitespace, no upper case).
 * `none` gives `head` null; `none` with a digest other than
 * `EMPTY_DIGEST` parses (and then never matches a board). Pure.
 */
export function parsePositionId(text: string): Position | null {
  // `$` would also match before a final newline; exclude one explicitly.
  if (text.endsWith('\n')) {
    return null;
  }
  const match = POSITION_ID.exec(text);
  const head = match?.[1];
  const digest = match?.[2];
  if (head === undefined || digest === undefined) {
    return null;
  }
  return { head: head === 'none' ? null : head, digest };
}

/**
 * The digest of a set of events: the bytewise XOR of their SHA-256 values
 * (32 bytes each), where each event's SHA-256 value is its hash (64
 * lowercase hex characters) decoded from hex, rendered as 64 lowercase hex
 * characters. `EMPTY_DIGEST` for no hash. Order independent. A hash given
 * more than once counts once (the argument is a set of events). Pure.
 */
export function effectiveDigest(hashes: Iterable<string>): string {
  const acc = new Uint8Array(32);
  for (const hash of new Set(hashes)) {
    xorInto(acc, hash);
  }
  return toHex(acc);
}

/** XORs the 32 bytes of the 64-hex `hash` into `acc`. */
function xorInto(acc: Uint8Array, hash: string): void {
  for (let i = 0; i < 32; i += 1) {
    acc[i] = (acc[i] ?? 0) ^ Number.parseInt(hash.slice(2 * i, 2 * i + 2), 16);
  }
}

/** Lowercase hex of `bytes`. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
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
export function createEventCache(read: EventReader = readEventFile): EventCache {
  const kept = new Map<string, BoardEvent | UnknownKindEvent>();
  return {
    get(eventsDir: string, hash: string): BoardEvent | UnknownKindEvent {
      const hit = kept.get(hash);
      if (hit !== undefined) {
        return hit;
      }
      const outcome = read(eventsDir, `${hash}.json`);
      if (outcome.status !== 'ok') {
        throw new BoardError(
          5,
          'integrity',
          `event ${hash} is recorded as well-formed but its file is not a well-formed event`,
        );
      }
      kept.set(hash, outcome.input.event);
      return outcome.input.event;
    },
    get size(): number {
      return kept.size;
    },
  };
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
  /**
   * Lists the effective events recorded in `folded` (hash and `ts`, in any
   * order), with the contract of `recordedPositions(db, { effectiveOnly:
   * true })` (`src/store/folded.ts`), which is the default. Every read of
   * `folded` rows the feed makes itself (catch-up's own reads excepted)
   * goes through this function, called on `board.db` inside the tick's
   * read snapshot, so tests can count them: a tick that ends at the quiet
   * check (catch-up folded nothing and the change marker has not moved)
   * does not call it.
   */
  readonly listEffective?: (db: Board['db']) => readonly { hash: string; ts: Hlc }[];
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
  const { db, eventsDir } = board;
  const cache = options.cache ?? createEventCache();
  // The feed state; replaced only when a tick succeeds.
  let state: FeedState | null = null;
  let version: string | null = null;

  const views = (list: readonly Effective[]): EventView[] =>
    list.map((p) => eventView(p.hash, cache.get(eventsDir, p.hash)));

  /** An append of `list` (in fold order), read in the caller's snapshot. */
  const appendOf = (list: readonly Effective[], id: string): FeedMessage => {
    const events = views(list);
    const ids = [...new Set(events.flatMap((e) => (e.ticket === null ? [] : [e.ticket])))].sort(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const tickets = ids.map((ticketId): Ticket => {
      const ticket = loadTicket(db, ticketId);
      if (ticket === null) {
        throw new BoardError(
          5,
          'integrity',
          `ticket ${ticketId} is named by an applied event but has no cache row`,
        );
      }
      return ticket;
    });
    const meta: Record<string, JsonValue> | null = events.some((e) => e.kind === 'board.meta')
      ? loadMeta(db)
      : null;
    return { type: 'append', id, events, tickets, meta };
  };

  /**
   * The first message for a consumer at `since` (or at no position) that
   * joins when the effective events are `all` (in fold order) and their
   * position id is `id`: a full append, a resume, or a resync.
   */
  const startAt = (
    all: readonly Effective[],
    id: string,
    since: string | undefined,
  ): FeedMessage | null => {
    if (since === undefined) {
      return appendOf(all, id);
    }
    const position = parsePositionId(since);
    if (position !== null) {
      let prefix = -1;
      if (position.head !== null) {
        const index = all.findIndex((p) => p.hash === position.head);
        prefix =
          index >= 0 &&
          effectiveDigest(all.slice(0, index + 1).map((p) => p.hash)) === position.digest
            ? index + 1
            : -1;
      } else if (position.digest === EMPTY_DIGEST) {
        prefix = 0;
      }
      if (prefix >= 0) {
        const rest = all.slice(prefix);
        return rest.length === 0 ? null : appendOf(rest, id);
      }
    }
    return { type: 'resync', id, late: [], removed: [] };
  };

  /** The first examination: a full append, or resume from `since`. */
  const first = (all: Effective[], next: FeedState): FeedMessage | null =>
    startAt(all, next.id, options.since);

  /** A later examination against the delivered state `prev`. */
  const later = (all: Effective[], prev: FeedState, next: FeedState): FeedMessage | null => {
    const fresh = all.filter((p) => !prev.delivered.has(p.hash));
    const removed = [...prev.delivered.values()]
      .filter((p) => !next.delivered.has(p.hash))
      .sort(comparePositions);
    if (fresh.length === 0 && removed.length === 0) {
      return null;
    }
    const { head } = prev;
    if (
      removed.length === 0 &&
      fresh.every((p) => head === null || comparePositions(p, head) > 0)
    ) {
      return appendOf(fresh, next.id);
    }
    const late = fresh.filter((p) => head !== null && comparePositions(p, head) < 0);
    return { type: 'resync', id: next.id, late: views(late), removed: removed.map((p) => p.hash) };
  };

  const listEffective =
    options.listEffective ?? ((d: Board['db']) => recordedPositions(d, { effectiveOnly: true }));

  const examine = (): void => {
    const report = catchUp(board);
    const current = changeMarker(db);
    if (state !== null && current === version && report.applied.length === 0 && !report.refolded) {
      return;
    }
    const prev = state;
    const { next, message } = inSnapshot(db, () => {
      const all = listEffective(db)
        .map(({ hash, ts }) => ({ hash, ts }))
        .sort(comparePositions);
      const nextState = stateOf(all, prev);
      return {
        next: nextState,
        message: prev === null ? first(all, nextState) : later(all, prev, nextState),
      };
    });
    // The snapshot is committed: no transaction is open while the consumer runs.
    if (message !== null) {
      // A consumer joining from inside onMessage joins after this message.
      delivering = next;
      try {
        options.onMessage(message);
      } finally {
        delivering = null;
      }
    }
    state = next;
    version = current;
  };

  // The state a consumer joining now joins at (`joinBoardFeed`).
  let delivering: FeedState | null = null;
  joins.set(options, (since) => {
    const at = delivering ?? state;
    if (at === null) {
      return undefined;
    }
    const all = [...at.delivered.values()];
    return inSnapshot(db, () => startAt(all, at.id, since));
  });

  const ticker: TickerOptions = {
    signal: options.signal,
    examine,
    dir: eventsDir,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.fsWatch === undefined ? {} : { fsWatch: options.fsWatch }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    ...(options.onProblem === undefined ? {} : { onFailure: options.onProblem }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.watchDir === undefined ? {} : { watchDir: options.watchDir }),
  };
  return runTicker(ticker).finally(() => {
    joins.delete(options);
  });
}

/** How a consumer joins each running feed, by the options it was started with. */
const joins = new WeakMap<
  WatchBoardOptions,
  (since: string | undefined) => FeedMessage | null | undefined
>();

/**
 * The first message for a consumer joining the running feed that was
 * started with `watchBoard(board, options)` (this exact options object),
 * relative to the effective events that feed has delivered (added by the
 * add-board-web group 3 implementer, so that one feed can serve many
 * consumers, each starting at its own position; design.md: "One feed per
 * server, fanned out to every client"). Call it synchronously with the
 * consumer's subscription, so no message of the feed falls between the
 * two. Called from inside that feed's `onMessage`, it joins after the
 * message being delivered.
 *
 * With the delivered effective events `D` (in fold order) and their
 * position id `id` (the id of the feed's last message):
 * - `since` undefined: an `append` of every event of `D` (an append with
 *   no event, no ticket, meta null and `EMPTY_POSITION_ID` when `D` is
 *   empty);
 * - `since` resumes against `D` exactly as a feed's first tick resumes
 *   against the effective events (see `watchBoard`): an `append` of the
 *   events of `D` after its head, or null when there is none;
 * - otherwise (unparsable, unknown head, digest mismatch): a `resync` with
 *   `id`, no late event and nothing removed.
 * An append carries the state of the tickets its events name and the meta
 * (when one of them is a `board.meta`) as they are in the cache now, read
 * in one read snapshot committed before this returns; event bodies are
 * read through the feed's cache. Returns undefined when that feed is not
 * running or has not delivered its first message yet (the consumer then
 * waits for the feed's first message and joins from inside `onMessage`).
 *
 * @throws BoardError exit 5 `integrity` (a delivered event whose file is
 *   no longer well-formed, or a named ticket without a cache row), and
 *   the event reader's errors.
 */
export function joinBoardFeed(
  options: WatchBoardOptions,
  since?: string,
): FeedMessage | null | undefined {
  return joins.get(options)?.(since);
}

/** An effective event's hash and timestamp. */
interface Effective {
  hash: string;
  ts: Hlc;
}

/** What the feed has delivered. */
interface FeedState {
  /** Every delivered effective event, by hash. */
  delivered: Map<string, Effective>;
  /** The greatest delivered event in fold order, or null. */
  head: Effective | null;
  /** The digest of every delivered event, as bytes. */
  digest: Uint8Array;
  /** The position id of this state. */
  id: string;
}

/**
 * The state after delivering every event of `all` (in fold order). The
 * digest is updated from `prev` by XOR of what was added and removed, so a
 * tick costs work in the size of the change, plus the listing.
 */
function stateOf(all: readonly Effective[], prev: FeedState | null): FeedState {
  const delivered = new Map(all.map((p) => [p.hash, p]));
  let digest: Uint8Array;
  if (prev === null) {
    digest = new Uint8Array(32);
    for (const p of all) {
      xorInto(digest, p.hash);
    }
  } else {
    digest = Uint8Array.from(prev.digest);
    for (const p of all) {
      if (!prev.delivered.has(p.hash)) {
        xorInto(digest, p.hash);
      }
    }
    for (const hash of prev.delivered.keys()) {
      if (!delivered.has(hash)) {
        xorInto(digest, hash);
      }
    }
  }
  const head = all.at(-1) ?? null;
  return { delivered, head, digest, id: positionId(head?.hash ?? null, toHex(digest)) };
}

/** The `EventView` of an applied event. */
function eventView(hash: string, event: BoardEvent | UnknownKindEvent): EventView {
  return {
    hash,
    kind: event.kind,
    ticket: 'ticket' in event && typeof event.ticket === 'string' ? event.ticket : null,
    actor: event.actor,
    ts: event.ts,
    outcome: 'applied',
    reason: null,
    event,
  };
}
