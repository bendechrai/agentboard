/**
 * The read-only JSON API of `agentboard serve` (board-web: "JSON API",
 * "Reads never block writers"; add-board-web task 3.2). The server
 * (`src/web/server.ts`) calls `apiResponse` for every authenticated `GET`
 * of an API path other than `/api/stream`, after the security checks, and
 * writes the result: `apiResponse` returns only once every read
 * transaction it opened is committed, so nothing it read is held while
 * the response goes to the network.
 *
 * Decisions recorded here (test author, add-board-web group 3):
 * - `/api/board` gives `tickets` as an array sorted by ascending id (like
 *   the `tickets` of a feed `append`), not keyed by id; a client keys them
 *   itself.
 * - An error's `hint` is `renderHint(reason, API_HINT_CONTEXT)`: the CLI
 *   hint of its reason with the command `serve`.
 * - Unknown query parameters are ignored. Only the first `after` and the
 *   first `limit` count.
 */

import type { EventCache } from '../board/feed.js';
import type { HintContext } from '../guidance/hints.js';
import type { Board } from '../store/board.js';

/** Default `limit` of `/api/events`. */
export const EVENTS_PAGE_DEFAULT = 1000;

/** Greatest `limit` of `/api/events`. */
export const EVENTS_PAGE_MAX = 5000;

/** The hint context of every API error: the CLI surface, command `serve`. */
export const API_HINT_CONTEXT: HintContext = { surface: 'cli', command: 'serve' };

/** What an API request reads. */
export interface ApiContext {
  readonly board: Board;
  /** The server's event cache, shared with its feed. */
  readonly cache: EventCache;
  /** The current time in milliseconds since the Unix epoch (`/api/actors`). */
  readonly now: () => number;
}

/** A JSON response: the status and the value to send as JSON. */
export interface ApiResult {
  readonly status: number;
  /** Sent as `JSON.stringify(body)` with `Content-Type: application/json; charset=utf-8`. */
  readonly body: unknown;
}

/**
 * The HTTP status of a failure:
 * - `BoardError` reason `unauthorized`: 401; `forbidden-host`: 403;
 *   `not-found` and `unknown-ticket`: 404; `method-not-allowed`: 405;
 *   `too-many-streams`: 503;
 * - any other `BoardError` of exit class 1 (`usage`, `unknown-cursor`,
 *   `id-too-short`, `ambiguous-id`, ...): 400;
 * - anything else (other exit classes, including `busy` and `integrity`,
 *   and errors that are not `BoardError`s): 500.
 * Pure.
 */
export function httpStatus(error: unknown): number {
  void error;
  throw new Error('not implemented');
}

/**
 * The response to `GET <path>?<query>` for an API path (`isApiPath`)
 * other than `/api/stream`. `path` is the URL path as received (not
 * decoded); the `<id>` segment of `/api/tickets/<id>` is percent-decoded.
 * Never throws: a failure is `{ status: httpStatus(error), body:
 * errorDocument(error, API_HINT_CONTEXT) }` (`src/cli/main.ts`).
 *
 * Every route that reads the board first runs the catch-up of a read
 * command and then reads inside one read snapshot (through `loadSnapshot`,
 * `src/board/snapshot.ts`, or an equivalent single `inSnapshot`), committed
 * before this function returns. No route writes an event or a cursor.
 *
 * Routes (board-web: "JSON API"), each answering 200 on success:
 * - `/api/session`: `{ version, boardDir, writable, actor }`: `VERSION`,
 *   `board.dir`, false and null. Reads nothing from the cache.
 * - `/api/board`: `{ tickets, meta, id }`: every ticket, open and closed,
 *   sorted by ascending id; the board meta; the snapshot's position id.
 * - `/api/tickets/<id>`: `{ ticket, events }` for a full id or a unique
 *   prefix of at least 6 characters (resolved as `show` resolves it);
 *   `events` is every well-formed event of that ticket (`EventView.ticket`
 *   equal to its id: applied, rejected and unknown kinds) in fold order,
 *   with outcome and reason. Refusals as `show`: `id-too-short` and
 *   `ambiguous-id` (400), `unknown-ticket` (404). Any path with more
 *   segments, or `/api/tickets/` with an empty id, is `not-found`.
 * - `/api/events?after=<hash>&limit=<n>`: `{ events, next }`: the
 *   well-formed events sorting after the event `after` in fold order (from
 *   the first without `after`), at most `limit` of them, each an
 *   `EventView`; `next` is the hash of the last event returned when at
 *   least one more event follows it, else null (a page that reaches the
 *   end, even exactly, has `next` null). `limit` is a decimal integer of
 *   digits only (no sign, no point, not empty) from 1 to `EVENTS_PAGE_MAX`,
 *   default `EVENTS_PAGE_DEFAULT`; anything else is `BoardError(1,
 *   'usage')` (400). An `after` that is not the hash of a well-formed
 *   event recorded in `folded` (including an empty one) is `BoardError(1,
 *   'unknown-cursor')` (400).
 * - `/api/actors`: `agentLanes(snapshot, now())` (`src/view/lanes.ts`),
 *   the array of lanes.
 * - any other API path (`/api`, `/api/`, `/api/nope`, `/api/board/x`):
 *   `BoardError(1, 'not-found')` (404).
 */
export function apiResponse(ctx: ApiContext, path: string, query: URLSearchParams): ApiResult {
  void ctx;
  void path;
  void query;
  throw new Error('not implemented');
}
