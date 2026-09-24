/**
 * The local web server of `agentboard serve` (board-web: "Serve command",
 * "Loopback only", "Access token", "Host header check", "No cross-origin
 * access and security headers", "Read-only server", "Reads never block
 * writers", "JSON API", "Live event stream"; design.md: "The server is
 * `node:http`, with a small router of our own" and the sections after
 * it; add-board-web tasks 3.1 to 3.3).
 *
 * Decisions recorded here (test author, add-board-web group 3):
 * - Assets. The page, script and stylesheet are served from one flat
 *   directory, `assetsDir`, by default `defaultAssetsDir()`: the directory
 *   `web` next to the running module, which is `dist/web` in the built
 *   package (the CLI bundle and its chunks live in `dist/`). Tests pass
 *   their own `assetsDir`. Until the client is built (add-board-web group
 *   4), `dist/web` may not exist: when `<assetsDir>/index.html` cannot be
 *   read, `GET /` answers 200 with `PLACEHOLDER_PAGE`, a short built-in
 *   HTML page with no script that says the web assets are not built
 *   (naming `dist/web` and `npm run build`), so `serve` and the whole API
 *   still work.
 * - Only direct children of `assetsDir` are served: `/` serves
 *   `index.html`, and `/<name>` serves the file `<name>` when `<name>`
 *   matches `ASSET_NAME` (no `/`, no `%`, no leading dot, so no traversal
 *   and no hidden file) and is a regular file; anything else outside
 *   `/api` is 404 `not-found`.
 * - Plain text pages (refusals outside `/api`) are `text/plain;
 *   charset=utf-8`, one or two short lines naming the reason, never the
 *   token.
 * - The stream buffer limit is checked on every write to a stream: when,
 *   after a write, the response's buffered data (`writableLength`) exceeds
 *   the limit, that client's connection is destroyed at once (it
 *   reconnects and resumes with `Last-Event-ID`).
 * - A tick failure is written to `stderr` as `agentboard: <message>` and
 *   a newline, once per distinct message for as long as the failure
 *   repeats, and sent to every open stream as a `problem` event
 *   (`sseProblem(errorDocument(error, API_HINT_CONTEXT))`).
 */

import type { EventCache } from '../board/feed.js';
import type { TickerTimers, WatchDir } from '../board/ticker.js';
import type { Board } from '../store/board.js';

/** The only address the server listens on. */
export const LOOPBACK = '127.0.0.1';

/** Names of the files served from the assets directory (`/<name>`). */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The page served on `GET /` when `<assetsDir>/index.html` cannot be read:
 * a complete HTML document without script, style or external reference,
 * saying that the web assets are not built, naming `dist/web` and
 * `npm run build`, and that the JSON API under `/api/` is available.
 */
export const PLACEHOLDER_PAGE = '';

/**
 * The content type of an asset by the extension of its name: `.html`
 * `text/html; charset=utf-8`, `.js` and `.mjs` `text/javascript;
 * charset=utf-8`, `.css` `text/css; charset=utf-8`, `.json` and `.map`
 * `application/json; charset=utf-8`, `.svg` `image/svg+xml`, `.png`
 * `image/png`, `.ico` `image/x-icon`, `.txt` `text/plain; charset=utf-8`,
 * anything else `application/octet-stream`. Pure.
 */
export function contentTypeOf(name: string): string {
  void name;
  throw new Error('not implemented');
}

/**
 * The default assets directory: the directory `web` beside the module at
 * `moduleUrl` (a `file:` URL; defaults to this module's own
 * `import.meta.url`). For the built CLI (`dist/cli.js` and its chunks in
 * `dist/`) that is `dist/web`. Pure.
 */
export function defaultAssetsDir(moduleUrl?: string): string {
  void moduleUrl;
  throw new Error('not implemented');
}

/** Timing of the server's board feed (tests); see `WatchBoardOptions`. */
export interface FeedTuning {
  readonly pollMs?: number;
  readonly fsWatch?: boolean;
  readonly timers?: TickerTimers;
  readonly watchDir?: WatchDir;
}

/** Options of `startServer`; every one has a default. */
export interface ServerOptions {
  /**
   * The port, an integer from 0 to 65535; default 0 (the operating system
   * picks a free port).
   */
  readonly port?: number;
  /** The access token; default `newToken()` (`src/web/security.ts`). */
  readonly token?: string;
  /** The directory the page and assets are served from; default `defaultAssetsDir()`. */
  readonly assetsDir?: string;
  /** The clock of `/api/actors`; default `Date.now`. */
  readonly now?: () => number;
  /**
   * The one event cache shared by the feed and every API request; default
   * a new `createEventCache()`.
   */
  readonly cache?: EventCache;
  /**
   * Receives the server's diagnostics (tick failures, whole lines); default
   * ignores them. Never receives the token.
   */
  readonly stderr?: (text: string) => void;
  /** Passed to the board feed; defaults are the feed's own. */
  readonly feed?: FeedTuning;
  /** Keepalive interval of the streams; default `KEEPALIVE_MS`. */
  readonly keepaliveMs?: number;
  /** Streams open at once; default `MAX_STREAMS`. */
  readonly maxStreams?: number;
  /** Unread bytes per stream client before it is disconnected; default `STREAM_BUFFER_BYTES`. */
  readonly streamBufferBytes?: number;
}

/** A running server. */
export interface RunningServer {
  /** `http://127.0.0.1:<port>/?token=<token>`: the entry URL. */
  readonly url: string;
  /** The port listened on (the one chosen by the system for port 0). */
  readonly port: number;
  /** The access token of this run. */
  readonly token: string;
  /** The address listened on, as `server.address()` reports it: always `127.0.0.1`. */
  readonly address: string;
  /** The number of `/api/stream` responses open now. */
  streamCount(): number;
  /**
   * Stops the server: stops the feed, ends every open stream, closes every
   * connection (idle keep-alive ones included) and resolves when the
   * listening socket is closed and the feed has stopped. Does not close
   * `board`. Idempotent: later calls return the same promise.
   */
  close(): Promise<void>;
}

/**
 * Starts the server for `board` on `127.0.0.1` only (never another
 * address, never `::`) and resolves once it listens.
 *
 * @throws (rejects with) BoardError exit 1 `port-in-use` naming the port
 *   when the port is in use (`EADDRINUSE`), before serving anything and
 *   without starting the feed; exit 1 `usage` for a port that is not an
 *   integer from 0 to 65535.
 *
 * Requests. For every request, before anything else, `checkRequest`
 * (`src/web/security.ts`) with this port and token:
 * - `refuse`: the status, `securityHeaders(api)`, `Allow: GET` on a 405;
 *   the body is `errorDocument(error, API_HINT_CONTEXT)` as JSON on an API
 *   path, else a plain text page. For 401 the page tells the user to open
 *   the URL printed by `agentboard serve` at start-up.
 * - `enter`: `303 See Other`, `Location: /`, the `Set-Cookie`, no board
 *   data.
 * - `route`: `/` serves `<assetsDir>/index.html` (or `PLACEHOLDER_PAGE`),
 *   `/<name>` an asset (see the module comment), `/api/stream` the stream,
 *   and every other API path `apiResponse` (`src/web/api.ts`) with
 *   `{ board, cache, now }`, sent as JSON with its status.
 * Every response, whatever its status, carries `securityHeaders(api)`
 * (so `Cache-Control: no-store` on API and stream responses) and never an
 * `Access-Control-Allow-*` header. No response body ever contains the
 * token; the only header that does is the 303's `Set-Cookie`. Nothing is
 * logged per request. A response body is written only after every read
 * transaction of the request has been committed (`board.db.isTransaction`
 * is false whenever the server writes to a response), and no transaction
 * is ever held across network IO or a timer.
 *
 * The stream (`GET /api/stream`, board-web: "Live event stream"). The
 * server runs one board feed (`watchBoard`, `src/board/feed.ts`, with
 * `cache` and `feed`) for its whole life and forwards each of its
 * messages to every open stream. When `maxStreams` streams are already
 * open, the request is answered 503 with `BoardError(1,
 * 'too-many-streams')` as JSON. Otherwise the response is 200,
 * `Content-Type: text/event-stream`, and writes `sseRetry()` first. Its
 * start position is the `Last-Event-ID` header when present, else the
 * `since` query parameter when present, else none. Its first message,
 * computed in the same synchronous turn in which it joins the fan-out (so
 * no feed message falls between the two), and relative to the messages
 * the shared feed has delivered:
 * - no start position: an `append` of every effective event (on an empty
 *   board an `append` with no event and id `EMPTY_POSITION_ID`);
 * - a start position that resumes (board-feed: "Resume from a position
 *   id"): an `append` of exactly the effective events after it, or no
 *   message when there is none;
 * - otherwise (an unparsable id, an unknown head, a digest mismatch): a
 *   `resync` with the current id, no late event and nothing removed.
 * Every later feed message is written as `sseMessage(message)`; a tick
 * failure other than `busy` is written as a `problem` event (see the
 * module comment) and the stream stays open; `sseKeepalive()` is written
 * every `keepaliveMs`. A client whose unread data exceeds
 * `streamBufferBytes` is disconnected. A stream ends when the client
 * disconnects or the server closes.
 */
export function startServer(board: Board, options?: ServerOptions): Promise<RunningServer> {
  void board;
  void options;
  throw new Error('not implemented');
}
