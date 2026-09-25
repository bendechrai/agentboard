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
import { resolveTicketId } from '../board/resolve.js';
import { loadSnapshot } from '../board/snapshot.js';
import { errorDocument } from '../cli/main.js';
import type { HintContext } from '../guidance/hints.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { VERSION } from '../version.js';
import { agentLanes } from '../view/lanes.js';

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
  /**
   * The server's write actor (`ServerOptions.actor`), or null or undefined
   * for a read-only server (`/api/session`).
   */
  readonly actor?: string | null;
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
  if (!(error instanceof BoardError)) {
    return 500;
  }
  switch (error.reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden-host':
      return 403;
    case 'not-found':
    case 'unknown-ticket':
      return 404;
    case 'method-not-allowed':
      return 405;
    case 'too-many-streams':
      return 503;
    default:
      return error.exitCode === 1 ? 400 : 500;
  }
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
 * - `/api/session`: `{ version, boardDir, writable, actor }` with the keys
 *   in this order: `VERSION`, `board.dir`, then `writable` true and `actor`
 *   `ctx.actor` when `ctx.actor` is a non-empty string, else false and
 *   null (board-web: "JSON API" as modified by add-board-web-actions). No
 *   other key (no CSRF token or field of any kind). Reads nothing from the
 *   cache.
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
  try {
    return { status: 200, body: route(ctx, path, query) };
  } catch (error) {
    return { status: httpStatus(error), body: errorDocument(error, API_HINT_CONTEXT) };
  }
}

/** The prefix of the ticket detail route. */
const TICKETS_PREFIX = '/api/tickets/';

/** The body of a successful API response; throws on any failure. */
function route(ctx: ApiContext, path: string, query: URLSearchParams): unknown {
  const { board, cache } = ctx;
  switch (path) {
    case '/api/session':
      return { version: VERSION, boardDir: board.dir, writable: false, actor: null };
    case '/api/board': {
      const snapshot = loadSnapshot(board, { cache });
      const tickets = Object.values(snapshot.tickets).sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      return { tickets, meta: snapshot.meta, id: snapshot.id };
    }
    case '/api/events':
      return eventsPage(ctx, query);
    case '/api/actors':
      return agentLanes(loadSnapshot(board, { cache }), ctx.now());
    default:
      break;
  }
  if (path.startsWith(TICKETS_PREFIX)) {
    const segment = path.slice(TICKETS_PREFIX.length);
    if (segment !== '' && !segment.includes('/')) {
      return ticketDetail(ctx, decodeSegment(segment));
    }
  }
  throw new BoardError(
    1,
    'not-found',
    'no such API route; the routes are /api/session, /api/board, /api/tickets/<id>, /api/events, /api/actors and /api/stream',
  );
}

/** The percent-decoded ticket id segment; malformed percent-encoding is a usage error. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BoardError(1, 'usage', 'the ticket id in the path is not valid percent-encoding');
  }
}

/** `/api/tickets/<id>`: the ticket and its events, from one snapshot. */
function ticketDetail(ctx: ApiContext, text: string): unknown {
  const snapshot = loadSnapshot(ctx.board, { cache: ctx.cache });
  const id = resolveTicketId({ tickets: snapshot.tickets, meta: snapshot.meta }, text);
  const ticket = snapshot.tickets[id];
  return { ticket, events: snapshot.events.filter((e) => e.ticket === id) };
}

/** A `limit` value: digits only, from 1 to `EVENTS_PAGE_MAX`. */
const LIMIT = /^[0-9]+$/;

/** `/api/events`: one page of the well-formed events in fold order. */
function eventsPage(ctx: ApiContext, query: URLSearchParams): unknown {
  const rawLimit = query.get('limit');
  let limit = EVENTS_PAGE_DEFAULT;
  if (rawLimit !== null) {
    const value = LIMIT.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > EVENTS_PAGE_MAX) {
      throw new BoardError(
        1,
        'usage',
        `limit must be an integer from 1 to ${String(EVENTS_PAGE_MAX)}`,
      );
    }
    limit = value;
  }
  const after = query.get('after');
  const { events } = loadSnapshot(ctx.board, { cache: ctx.cache });
  let start = 0;
  if (after !== null) {
    const index = events.findIndex((e) => e.hash === after);
    if (index < 0) {
      throw new BoardError(
        1,
        'unknown-cursor',
        'after is not the hash of a recorded well-formed event',
      );
    }
    start = index + 1;
  }
  const page = events.slice(start, start + limit);
  const more = start + limit < events.length;
  return { events: page, next: more ? (page.at(-1)?.hash ?? null) : null };
}
