/**
 * The web client's side of the JSON API and the event stream of
 * `agentboard serve` (board-web: "JSON API", "Live event stream";
 * `src/web/api.ts` and `src/web/stream.ts` hold the server's contract;
 * add-board-web task 4.2).
 *
 * The client talks only to its own origin, by absolute paths (`/api/...`),
 * and is authenticated by the session cookie the server set when the entry
 * URL was opened. It never reads, stores, sends or embeds the access
 * token: no request carries an `Authorization` header or a `token`
 * parameter, and `fetch` is called with no `credentials` override (the
 * default, `same-origin`, sends the cookie). `EventSource` sends the cookie
 * on its own.
 *
 * Every IO goes through `ClientDeps`, so tests pass a stubbed `fetch`, a
 * fake `EventSource`, a clock and timers.
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

import type { JsonValue } from '../../events/json.js';
import type { Ticket } from '../../events/fold.js';
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

/** The part of `EventSource` the client uses. */
export interface EventSourceLike {
  /**
   * Registers a listener for the named SSE events (`append`, `resync`,
   * `problem`, whose `data` is JSON text) and for `open` and `error`.
   */
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  /** Closes the stream; no event is delivered after it. */
  close(): void;
}

/** Everything the client does IO or reads time through. */
export interface ClientDeps {
  /** Same-origin `fetch`. */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Opens an event stream on a same-origin path. */
  readonly EventSource: new (url: string) => EventSourceLike;
  /** The current time in milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** Schedules `callback` every `ms` milliseconds; returns a handle for `clearInterval`. */
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  /** Cancels a handle returned by `setInterval`. */
  readonly clearInterval: (handle: unknown) => void;
}

/**
 * The browser's own dependencies, read from `globalThis` when called:
 * `fetch` (bound to `globalThis`), `EventSource`, `Date.now`,
 * `setInterval` and `clearInterval`.
 */
export function defaultDeps(): ClientDeps {
  throw new Error('not implemented');
}

/**
 * `GET path` (an absolute same-origin path such as `/api/board`) with the
 * header `Accept: application/json`, resolving to the parsed JSON body of
 * a 2xx response. Rejects with an `ApiError`: the status and the
 * `ErrorDocument` for any other status (document null when the body is not
 * one), status 0 when `fetch` itself rejects.
 */
export function getJson(deps: ClientDeps, path: string): Promise<unknown> {
  void deps;
  void path;
  throw new Error('not implemented');
}

/** `GET /api/session`. Rejects as `getJson`. */
export function loadSession(deps: ClientDeps): Promise<Session> {
  void deps;
  throw new Error('not implemented');
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
export function loadModel(deps: ClientDeps, late: readonly string[]): Promise<BoardModel> {
  void deps;
  void late;
  throw new Error('not implemented');
}

/**
 * `GET /api/tickets/<encodeURIComponent(id)>`: the ticket and all its
 * well-formed events, applied, rejected and unknown (the feed carries only
 * effective events, so the detail view reads rejected ones here;
 * board-view-model: "Applying feed messages"). Rejects as `getJson` (for
 * example 404 with reason `unknown-ticket`).
 */
export function loadTicketDetail(deps: ClientDeps, id: string): Promise<TicketDetail> {
  void deps;
  void id;
  throw new Error('not implemented');
}

/** The stream path for a position id: `/api/stream?since=<encodeURIComponent(id)>`. */
export function streamUrl(id: string): string {
  void id;
  throw new Error('not implemented');
}
