/**
 * The snapshot loader (design.md: "Interfaces (sketch)", "Reads never
 * block writers"; add-board-web task 3.2): the whole board as the web API
 * and, in `add-board-tui`, `top` load it, from one read snapshot of the
 * cache.
 *
 * Internal to the server and the terminal UI; not re-exported from
 * `src/index.ts`.
 */

import type { Board } from '../store/board.js';
import type { BoardModel } from '../view/types.js';
import type { EventCache } from './feed.js';

/**
 * A snapshot of the board: a `BoardModel` without the client-side `late`
 * list.
 * - `tickets`: every ticket, open and closed, keyed by id.
 * - `meta`: the board meta settings (`{}` when there is none).
 * - `events`: every well-formed event recorded in `folded` (applied,
 *   rejected and unknown kinds alike; malformed files, which have no
 *   position, are left out), in fold order (`compareFoldOrder`: `ts` by
 *   `compareHlc`, then hash), each an `EventView` whose `outcome` is
 *   `applied` (reason null) for `folded` 1, `unknown` (reason null) for
 *   reason `unknown-kind`, and otherwise `rejected` with the fold's
 *   rejection reason.
 * - `head`: the hash of the greatest applied event, or null when none is
 *   applied.
 * - `id`: the board feed position id of the same snapshot, `<head>.<digest>`
 *   over every applied event (`positionId(head, effectiveDigest(...))`,
 *   `src/board/feed.ts`), `EMPTY_POSITION_ID` when none is applied. It is
 *   the id a feed started on the same board state gives its first message,
 *   so a client that loads a snapshot resumes its stream from it.
 */
export type BoardSnapshot = Omit<BoardModel, 'late'>;

/** Options of `loadSnapshot`. */
export interface LoadSnapshotOptions {
  /**
   * The event cache to read event bodies through (the server shares one
   * with its feed); defaults to a new cache (`createEventCache()`).
   */
  readonly cache?: EventCache;
}

/**
 * Loads the snapshot of `board`. First runs the catch-up of any read
 * command (`catchUp(board)`, which takes the write lock only when there is
 * something to fold or reap), then reads the tickets, the meta, the
 * `folded` rows and the position id inside one deferred read transaction
 * (`inSnapshot`), reading the body of each well-formed event through
 * `cache` (so a file is read at most once per cache). The transaction is
 * committed before this function returns, so no transaction is open on
 * `board.db` afterwards. Writes no event, no cursor and no `folded` row
 * (other than what the catch-up folds). Does not close `board`.
 *
 * @throws BoardError exit 5 `integrity` when a file recorded as
 *   well-formed is not (`EventCache.get`), and whatever the catch-up throws
 *   (for example `BoardError(5, 'busy')`).
 */
export function loadSnapshot(board: Board, options?: LoadSnapshotOptions): BoardSnapshot {
  void board;
  void options;
  throw new Error('not implemented');
}
