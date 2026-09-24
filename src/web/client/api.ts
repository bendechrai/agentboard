/**
 * The web client's side of the JSON API of `agentboard serve` (board-web:
 * "Access token", "JSON API"; `src/web/api.ts` holds the server's contract;
 * add-board-web task 4.2). The stream is read by `stream.ts`.
 *
 * The client talks only to its own origin, by absolute paths (`/api/...`).
 * Every API request carries `Authorization: Bearer <token>`, the token
 * taken from the URL fragment by `takeToken` (`token.ts`). No cookie is
 * used, the token is never put in a URL, and it is never written anywhere
 * but `sessionStorage`. The page and its assets are served without a token.
 *
 * Every IO goes through `ClientDeps`, so tests pass a stubbed `fetch`, a
 * clock and timers.
 *
 * Decisions recorded here (test author, add-board-web group 4):
 * - `/api/board` and the pages of `/api/events` are separate requests, so
 *   separate read snapshots: events written between them appear in the
 *   events but not in the board. `loadModel` requests the board first and
 *   then keeps only the events up to and including the board's head (the
 *   `<head>` of its position id): the stream, opened with `since` the
 *   board's id, delivers the later effective events as an append. On an
 *   empty board (head `none`) it keeps the events before the first
 *   applied one. When the head is not among the events, every event is
 *   kept.
 * - The shapes the client relies on are declared here, structurally, so
 *   the client project imports no module that needs Node.
 */

import type { Ticket } from '../../events/fold.js';
import type { JsonValue } from '../../events/json.js';
import type { BoardModel, EventView } from '../../view/types.js';

/** The error document of every API refusal and of a stream `problem` (as `src/cli/main.ts`). */
export interface ErrorDocument {
  error: {
    exitCode: number;
    /** The `BoardError` reason, or null. */
    reason: string | null;
    message: string;
    /** The CLI hint of the reason, or null. */
    hint: string | null;
  };
}

/** `GET /api/session`. */
export interface Session {
  version: string;
  boardDir: string;
  writable: boolean;
  actor: string | null;
}

/** `GET /api/board`: tickets ascending by id, the meta and the position id. */
export interface BoardResponse {
  tickets: Ticket[];
  meta: Record<string, JsonValue>;
  id: string;
}

/** `GET /api/events?after=<hash>&limit=<n>`. */
export interface EventsPage {
  events: EventView[];
  /** The `after` of the next page, or null on the last page. */
  next: string | null;
}

/** `GET /api/tickets/<id>`: the ticket and every well-formed event of it, with outcomes. */
export interface TicketDetail {
  ticket: Ticket;
  events: EventView[];
}

/** A failed API request. */
export class ApiError extends Error {
  /** The HTTP status, or 0 when no response was received (a network failure). */
  readonly status: number;
  /** The response's `ErrorDocument` when its body was one; otherwise null. */
  readonly document: ErrorDocument | null;

  /**
   * `message` is the document's `error.message` when there is a document,
   * else a short text naming the path and the status (or the network
   * failure).
   */
  constructor(message: string, status: number, document: ErrorDocument | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.document = document;
  }
}

/** Everything the client does IO or reads time through. */
export interface ClientDeps {
  /** Same-origin `fetch`. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The current time in milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** Schedules `callback` every `ms` milliseconds; returns a handle for `clearInterval`. */
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  /** Cancels a handle returned by `setInterval`. */
  readonly clearInterval: (handle: unknown) => void;
  /** Schedules `callback` once after `ms` milliseconds; returns a handle for `clearTimeout`. */
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  /** Cancels a handle returned by `setTimeout`. */
  readonly clearTimeout: (handle: unknown) => void;
}

/** What every API request needs: the dependencies and the access token. */
export interface Connection {
  readonly deps: ClientDeps;
  /** The access token, sent as `Authorization: Bearer <token>`. */
  readonly token: string;
}

/**
 * The browser's own dependencies, read from `globalThis` when called:
 * `fetch` (called on `globalThis`), `Date.now`, `setInterval`,
 * `clearInterval`, `setTimeout` and `clearTimeout`.
 */
export function defaultDeps(): ClientDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (handle) => {
      globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
    },
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  };
}

/**
 * The headers of an API request: `Accept: application/json` and
 * `Authorization: Bearer <token>`.
 */
export function apiHeaders(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` has the shape of an `ErrorDocument`. */
export function isErrorDocument(value: unknown): value is ErrorDocument {
  if (!isRecord(value) || !isRecord(value['error'])) {
    return false;
  }
  const error = value['error'];
  return (
    typeof error['exitCode'] === 'number' &&
    (error['reason'] === null || typeof error['reason'] === 'string') &&
    typeof error['message'] === 'string' &&
    (error['hint'] === null || typeof error['hint'] === 'string')
  );
}

/** The error document of any failure: its own for an `ApiError` that has one. */
export function errorDocumentOf(error: unknown): ErrorDocument {
  if (error instanceof ApiError && error.document !== null) {
    return error.document;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: { exitCode: 1, reason: null, message, hint: null } };
}

/**
 * `GET path` (an absolute same-origin path such as `/api/board`) with
 * `apiHeaders(conn.token)` and no other request option, resolving to the
 * parsed JSON body of a 2xx response. Rejects with an `ApiError`: the
 * status and the `ErrorDocument` for any other status (document null when
 * the body is not one; 401 for a missing or wrong token), status 0 when
 * `fetch` itself rejects.
 */
export async function getJson(conn: Connection, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await conn.deps.fetch(path, { headers: apiHeaders(conn.token) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(`GET ${path} failed: ${reason}`, 0, null);
  }
  let body: unknown = null;
  let parsed = true;
  try {
    body = await response.json();
  } catch {
    parsed = false;
  }
  if (response.ok && parsed) {
    return body;
  }
  const document = isErrorDocument(body) ? body : null;
  const message =
    document?.error.message ??
    (response.ok
      ? `GET ${path} answered ${String(response.status)} with a body that is not JSON`
      : `GET ${path} answered ${String(response.status)}`);
  throw new ApiError(message, response.status, document);
}

/** `GET /api/session`. Rejects as `getJson`. */
export async function loadSession(conn: Connection): Promise<Session> {
  return (await getJson(conn, '/api/session')) as Session;
}

/** The events of a snapshot cut at `head` (see the module comment). */
function cutAtHead(events: EventView[], head: string | null): EventView[] {
  if (head === null) {
    const first = events.findIndex((e) => e.outcome === 'applied');
    return first < 0 ? events : events.slice(0, first);
  }
  const index = events.findIndex((e) => e.hash === head);
  return index < 0 ? events : events.slice(0, index + 1);
}

/**
 * A snapshot of the board as a `BoardModel`: `GET /api/board`, then every
 * page of `/api/events` in order (the first without `after`, each next one
 * with `after=<next>` of the previous page, until `next` is null; `limit`
 * is not sent, so the server's default applies), cut at the board's head
 * as the module comment describes. The model's `tickets` are the board's
 * tickets keyed by id, `meta` the board's, `events` the kept events in the
 * order received, `head` the `<head>` part of the board's id (null for
 * `none`), `id` the board's id, and `late` the given list. Rejects as
 * `getJson` on the first failed request.
 */
export async function loadModel(conn: Connection, late: readonly string[]): Promise<BoardModel> {
  const board = (await getJson(conn, '/api/board')) as BoardResponse;
  const events: EventView[] = [];
  let after: string | null = null;
  do {
    const path: string =
      after === null ? '/api/events' : `/api/events?after=${encodeURIComponent(after)}`;
    const page = (await getJson(conn, path)) as EventsPage;
    events.push(...page.events);
    after = page.next;
  } while (after !== null);
  const headPart = board.id.slice(0, Math.max(0, board.id.indexOf('.')));
  const head = headPart === 'none' || headPart === '' ? null : headPart;
  const tickets: Record<string, Ticket> = {};
  for (const ticket of board.tickets) {
    tickets[ticket.id] = ticket;
  }
  return {
    tickets,
    meta: board.meta,
    events: cutAtHead(events, head),
    head,
    id: board.id,
    late: [...late],
  };
}

/**
 * `GET /api/tickets/<encodeURIComponent(id)>`: the ticket and all its
 * well-formed events, applied, rejected and unknown (the feed carries only
 * effective events, so the detail view reads rejected ones here;
 * board-view-model: "Applying feed messages"). Rejects as `getJson` (for
 * example 404 with reason `unknown-ticket`).
 */
export async function loadTicketDetail(conn: Connection, id: string): Promise<TicketDetail> {
  return (await getJson(conn, `/api/tickets/${encodeURIComponent(id)}`)) as TicketDetail;
}
