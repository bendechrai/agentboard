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
 * - Only direct children of `assetsDir` are served, without a token (round
 *   2): `/` serves `index.html`, and `/<name>` serves the file `<name>`
 *   when `<name>` matches `ASSET_NAME` (no `/`, `\` or `%`, no leading
 *   dot, so no traversal and no hidden file). The file is opened once with
 *   `O_RDONLY | O_NONBLOCK | O_NOFOLLOW` and served only when `fstat` of
 *   that descriptor says it is a regular file, so a FIFO (with or without
 *   a writer), a device, a directory or a symbolic link (even one to a
 *   regular file inside `assetsDir`) is 404 at once and never blocks the
 *   event loop, and nothing can be swapped between the check and the
 *   read. Anything else outside `/api` is 404 `not-found`.
 * - Malformed HTTP (a `clientError` of the parser, for example a raw NUL
 *   in the request target) is answered `400 Bad Request` with
 *   `securityHeaders(false)`, `Content-Length: 0` and `Connection: close`,
 *   never Node's bare 400 page; when the connection is still sending an
 *   earlier response (bytes after a request that had no body framing,
 *   such as a `DELETE` with an unframed body), it is closed instead, as
 *   Node's own handler does.
 * - Plain text pages (refusals outside `/api`) are `text/plain;
 *   charset=utf-8`, one or two short lines naming the reason, never the
 *   token.
 * - The stream buffer limit is checked before every write to a stream
 *   (a feed message, a problem or a keepalive): when the response already
 *   holds more unwritten data (`writableLength`) than the limit, that
 *   client's connection is destroyed instead of writing (it reconnects and
 *   resumes with `Last-Event-ID`). So one message larger than the limit is
 *   still delivered to a client that reads it, and a client that does not
 *   read is disconnected at the next write, at the latest the next
 *   keepalive.
 * - A tick failure is written to `stderr` as `agentboard: <message>` and
 *   a newline, once per distinct message for as long as the failure
 *   repeats, and sent to every open stream as a `problem` event
 *   (`sseProblem(errorDocument(error, API_HINT_CONTEXT))`).
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createEventCache,
  joinBoardFeed,
  watchBoard,
  type EventCache,
  type WatchBoardOptions,
} from '../board/feed.js';
import type { TickerTimers, WatchDir } from '../board/ticker.js';
import type { Env } from '../cli/types.js';
import { errorDocument } from '../cli/main.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { checkCache } from '../store/rebuild.js';
import type { FeedMessage } from '../view/types.js';
import { API_HINT_CONTEXT, apiResponse, httpStatus } from './api.js';
import {
  createCacheChecker,
  createObservedLog,
  type CacheCheckOutcome,
  type HealthResponse,
} from './health.js';
import { ACTION_BODY_LIMIT, actionRoot, csrfRefusal, runAction } from './actions.js';
import {
  ACTIONS_PREFIX,
  checkRequest,
  newToken,
  securityHeaders,
  type Guard,
  type RequestHead,
} from './security.js';
import {
  KEEPALIVE_MS,
  MAX_STREAMS,
  STREAM_BUFFER_BYTES,
  sseKeepalive,
  sseMessage,
  sseProblem,
  sseRetry,
} from './stream.js';

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
export const PLACEHOLDER_PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>agentboard</title></head>',
  '<body>',
  '<h1>agentboard</h1>',
  '<p>The web assets are not built: dist/web is missing. Run npm run build in the agentboard package, then restart agentboard serve.</p>',
  '<p>The read-only JSON API under /api/ is available.</p>',
  '</body>',
  '</html>',
  '',
].join('\n');

/**
 * The content type of an asset by the extension of its name: `.html`
 * `text/html; charset=utf-8`, `.js` and `.mjs` `text/javascript;
 * charset=utf-8`, `.css` `text/css; charset=utf-8`, `.json` and `.map`
 * `application/json; charset=utf-8`, `.svg` `image/svg+xml`, `.png`
 * `image/png`, `.ico` `image/x-icon`, `.txt` `text/plain; charset=utf-8`,
 * anything else `application/octet-stream`. Pure.
 */
export function contentTypeOf(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The default assets directory: the directory `web` beside the module at
 * `moduleUrl` (a `file:` URL; defaults to this module's own
 * `import.meta.url`). For the built CLI (`dist/cli.js` and its chunks in
 * `dist/`) that is `dist/web`. Pure.
 */
export function defaultAssetsDir(moduleUrl?: string): string {
  return join(dirname(fileURLToPath(moduleUrl ?? import.meta.url)), 'web');
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
  /**
   * Runs the cache comparison of `GET /api/health/check` (through the
   * server's `CacheChecker`, `src/web/health.ts`); default `() =>
   * checkCache(board)` (`src/store/rebuild.ts`). Called only for that
   * route, never otherwise (tests count its calls and control when it
   * completes).
   */
  readonly checkCache?: (board: Board) => CacheCheckOutcome | Promise<CacheCheckOutcome>;
  /**
   * The write actor (board-web-actions: "Write mode is opt-in with an
   * explicit actor"; add-board-web-actions task 1.1): a non-empty string
   * makes the server writable as that actor, recorded on every event
   * written through it; undefined or null (the default) makes it read-only.
   * An empty string rejects with `BoardError(1, 'usage')` before
   * listening. The environment (`AGENTBOARD_ACTOR`) is never consulted.
   */
  readonly actor?: string | null;
  /**
   * The `cwd` of every action (`ActionContext.root`, `src/web/actions.ts`):
   * the root of the working tree `serve` was started in. Default
   * `actionRoot(process.cwd(), env)`.
   */
  readonly root?: string;
  /** The environment of every action's run context; default `process.env`. */
  readonly env?: Env;
}

/** A running server. */
export interface RunningServer {
  /**
   * `http://127.0.0.1:<port>/#token=<token>`: the start-up URL, with the
   * token in the fragment, which a browser never sends to a server.
   */
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
 * (`src/web/security.ts`) with this port and token, `req.headers` and
 * `req.headersDistinct`. A request without a `Host` header reaches that
 * check too (it is 403 `forbidden-host`, not Node's own 400: the
 * `node:http` server is created with `requireHostHeader: false`), and so
 * does one with two `Host` headers (403). An API request with two or more
 * `Authorization` headers is 401 `unauthorized` even when the first is
 * valid (`req.headers` keeps only the first; the check counts them in
 * `req.headersDistinct`).
 * - `refuse`: the status, `securityHeaders(api)`, `Allow: <allow>` on a
 *   405; the body is `errorDocument(error, API_HINT_CONTEXT)` as JSON on an
 *   API path, else a plain text page. A 401 happens only on API paths.
 * - `route` with method `POST` (an action path, authenticated): the action
 *   checks and `runAction` in the order of the module comment of
 *   `src/web/actions.ts` (CSRF 403 `csrf-failed`, then the 64 KiB body
 *   limit 413 `body-too-large`, then `read-only`, the action name and the
 *   command), with `{ board, actor, root, env }` as its `ActionContext`;
 *   the result is sent as JSON with its status. A write made this way
 *   commits on the server's own connection, and the feed's change marker
 *   counts it, so it reaches every open stream at the next tick.
 * - `route` with method `GET`: `/` serves `<assetsDir>/index.html` (or
 *   `PLACEHOLDER_PAGE`), `/<name>` an asset (see the module comment),
 *   `/api/stream` the stream, and every other API path `apiResponse`
 *   (`src/web/api.ts`) with `{ board, cache, now, actor }`, sent as JSON
 *   with its status.
 * Every response, whatever its status, carries `securityHeaders(api)`
 * (so `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Resource-Policy: same-origin` on every response, the 400
 * of a malformed request included, and `Cache-Control: no-store` on API
 * and stream responses) and never an
 * `Access-Control-Allow-*` header, and never a `Set-Cookie` header. No
 * response, body or header, ever contains the token. Nothing is logged per
 * request. A response body is written only after every read
 * transaction of the request has been committed (`board.db.isTransaction`
 * is false whenever the server writes to a response), and no transaction
 * is ever held across network IO or a timer.
 *
 * Health (board-insights: "Health in the web app"; add-board-insights
 * task 3.1). The server keeps one `ObservedLog` (`createObservedLog()`,
 * `src/web/health.ts`) and one `CacheChecker` (`createCacheChecker({
 * check: () => checkCache(board), now })`, with `options.checkCache` when
 * given) for its whole life. Every message of its feed is passed to
 * `log.observe(message, now())` before it is written to the streams (a
 * joiner's own first message is not a feed message and is not observed).
 * Behind the same Host, token and method checks as every API route:
 * - `GET /api/health`: 200 with `HealthResponse` `{ late: log.list(),
 *   check: checker.last() }`; never runs the comparison;
 * - `GET /api/health/check`: 200 with the `HealthCheck` of
 *   `await checker.run()` (single flight, reused for `CHECK_REUSE_MS`);
 *   when it rejects, `httpStatus(error)` with `errorDocument(error,
 *   API_HINT_CONTEXT)`. A check that completes after the client went away,
 *   or after `close()`, writes nothing.
 * Any other path under `/api/health/` is 404 `not-found` as usual.
 *
 * The stream (`GET /api/stream`, board-web: "Live event stream"). The
 * server runs one board feed (`watchBoard`, `src/board/feed.ts`, with
 * `cache` and `feed`) for its whole life and forwards each of its
 * messages to every open stream. When `maxStreams` streams are already
 * open, the request is answered 503 with `BoardError(1,
 * 'too-many-streams')` as JSON. Otherwise the response is 200,
 * `Content-Type: text/event-stream`, and writes `sseRetry()` first. Its
 * start position is the `Last-Event-ID` header when present, else the
 * `since` query parameter when present, else none. Its first message is
 * `joinBoardFeed` of the shared feed (`src/board/feed.ts`), called in the
 * same synchronous turn in which the stream joins the fan-out (so no feed
 * message falls between the two). That join first brings the feed up to
 * date (one catch-up and examination, whose message, if any, goes to the
 * streams already open), so the position is compared with the board, not
 * with what the feed had delivered before (board-feed: "Joining a running
 * feed"; board-web scenario "Stream from a fresh snapshot"): a stream
 * started with the id of any `/api/board` snapshot taken before it gets an
 * `append` of exactly the events after it, or nothing, never a `resync`
 * or an event the snapshot held. In detail:
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
export async function startServer(
  board: Board,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const requested = options.port ?? 0;
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
    throw new BoardError(1, 'usage', 'the port must be an integer from 0 to 65535');
  }
  if (options.actor === '') {
    throw new BoardError(
      1,
      'usage',
      'the actor must not be empty; leave it out to serve read-only',
    );
  }
  const actor = options.actor ?? null;
  const env = options.env ?? process.env;
  const root = options.root ?? actionRoot(process.cwd(), env);
  const token = options.token ?? newToken();
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const now = options.now ?? Date.now;
  const cache = options.cache ?? createEventCache();
  const stderr = options.stderr ?? ((): void => undefined);
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const maxStreams = options.maxStreams ?? MAX_STREAMS;
  const bufferLimit = options.streamBufferBytes ?? STREAM_BUFFER_BYTES;
  const compare = options.checkCache ?? checkCache;
  const observed = createObservedLog();
  const checker = createCacheChecker({ check: () => compare(board), now });

  // Set once listening; no request is handled before that.
  let guard: Guard = { port: requested, token };
  const clients = new Set<StreamClient>();
  const controller = new AbortController();
  // Set by `close()`: a cache check settling afterwards writes nothing.
  let stopped = false;

  /** Writes `text` to a stream, or disconnects a client that is too far behind. */
  const send = (client: StreamClient, text: string): void => {
    if (client.res.destroyed) {
      return;
    }
    if (client.res.writableLength > bufferLimit) {
      drop(client);
      return;
    }
    client.res.write(text);
  };
  const drop = (client: StreamClient): void => {
    clients.delete(client);
    client.res.destroy();
  };

  // Diagnostics: each distinct line once, for as long as it repeats.
  let lastProblem: string | null = null;
  let lastWarning: string | null = null;

  const feedOptions: WatchBoardOptions = {
    signal: controller.signal,
    cache,
    onMessage: (message: FeedMessage) => {
      observed.observe(message, now());
      lastProblem = null;
      lastWarning = null;
      const frame = sseMessage(message);
      const waiting: StreamClient[] = [];
      for (const client of clients) {
        if (client.waiting) {
          waiting.push(client);
        } else {
          send(client, frame);
        }
      }
      // Streams opened before the feed's first message join after it.
      for (const client of waiting) {
        joinWaiting(client);
      }
    },
    onWarning: (line: string) => {
      if (line !== lastWarning) {
        lastWarning = line;
        stderr(`agentboard: ${line}\n`);
      }
    },
    onProblem: (error: unknown) => {
      const doc = errorDocument(error, API_HINT_CONTEXT);
      if (doc.error.message !== lastProblem) {
        lastProblem = doc.error.message;
        stderr(`agentboard: ${doc.error.message}\n`);
      }
      const frame = sseProblem(doc);
      for (const client of clients) {
        send(client, frame);
      }
    },
    ...feedTuning(options.feed),
  };

  /** Sends a waiting stream its first message, inside the feed's `onMessage`. */
  const joinWaiting = (client: StreamClient): void => {
    let first: FeedMessage | null | undefined;
    try {
      first = joinBoardFeed(feedOptions, client.since);
    } catch (error) {
      send(client, sseProblem(errorDocument(error, API_HINT_CONTEXT)));
      clients.delete(client);
      client.res.end();
      return;
    }
    if (first === undefined) {
      return;
    }
    client.waiting = false;
    if (first !== null) {
      send(client, sseMessage(first));
    }
  };

  /** `GET /api/stream`, authenticated. */
  const openStream = (req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void => {
    if (clients.size >= maxStreams) {
      sendJson(
        res,
        503,
        errorDocument(
          new BoardError(
            1,
            'too-many-streams',
            `${String(maxStreams)} streams are already open on this server`,
          ),
          API_HINT_CONTEXT,
        ),
      );
      return;
    }
    const header = req.headers['last-event-id'];
    const since = typeof header === 'string' ? header : (query.get('since') ?? undefined);
    let first: FeedMessage | null | undefined;
    try {
      // Synchronous with joining the fan-out below: no feed message falls between.
      first = joinBoardFeed(feedOptions, since);
    } catch (error) {
      sendJson(res, httpStatus(error), errorDocument(error, API_HINT_CONTEXT));
      return;
    }
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.writeHead(200, {
      ...securityHeaders(true),
      'Content-Type': 'text/event-stream; charset=utf-8',
    });
    const client: StreamClient = { res, waiting: first === undefined, since };
    clients.add(client);
    res.on('close', () => {
      clients.delete(client);
    });
    res.write(sseRetry());
    if (first !== undefined && first !== null) {
      send(client, sseMessage(first));
    }
  };

  /** `GET /api/health/check`, authenticated: answers once the shared check settles. */
  const runCheck = (res: ServerResponse): void => {
    const answer = (status: number, body: unknown): void => {
      if (stopped || res.destroyed || res.writableEnded) {
        return;
      }
      sendJson(res, status, body);
    };
    checker.run().then(
      (result) => {
        answer(200, result);
      },
      (error: unknown) => {
        answer(httpStatus(error), errorDocument(error, API_HINT_CONTEXT));
      },
    );
  };

  /**
   * `POST /api/actions/<action>`, authenticated: the CSRF rules, the body
   * limit, then `runAction` (the order of `src/web/actions.ts`). Every
   * refusal writes nothing; no body is held beyond `ACTION_BODY_LIMIT`.
   */
  const handleAction = (
    req: IncomingMessage,
    res: ServerResponse,
    head: RequestHead,
    path: string,
  ): void => {
    // A client that goes away mid-body is not an error of the server.
    req.on('error', () => undefined);
    const csrf = csrfRefusal(head, guard.port);
    if (csrf !== null) {
      discard(req, res);
      sendJson(res, 403, errorDocument(csrf, API_HINT_CONTEXT));
      return;
    }
    const tooLarge = (): void => {
      discard(req, res);
      sendJson(
        res,
        413,
        errorDocument(
          new BoardError(
            1,
            'body-too-large',
            `the action body is larger than ${String(ACTION_BODY_LIMIT / 1024)} KiB`,
          ),
          API_HINT_CONTEXT,
        ),
      );
    };
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > ACTION_BODY_LIMIT) {
      tooLarge();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > ACTION_BODY_LIMIT) {
        chunks.length = 0;
        req.off('data', onData);
        req.off('end', onEnd);
        tooLarge();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      // Run nothing whose answer cannot be delivered: a request aborted, a
      // response already ended or destroyed, or a socket no longer
      // writable (the clientError handler has ended it after malformed
      // bytes pipelined behind this body). Otherwise the write would
      // commit while the client was told something else.
      if (stopped || req.destroyed || res.destroyed || res.writableEnded || !req.socket.writable) {
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      try {
        const result = runAction(
          { board, actor, root, env },
          path.slice(ACTIONS_PREFIX.length),
          text,
        );
        sendJson(res, result.status, result.body);
      } catch (error) {
        // Unexpected (runAction never throws): as in `handle`.
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 500, errorDocument(error, API_HINT_CONTEXT));
        }
      }
    };
    req.on('data', onData);
    req.on('end', onEnd);
  };

  // The response in progress on each connection (see the clientError handler).
  const answering = new WeakMap<Socket, ServerResponse>();

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    answering.set(req.socket, res);
    res.once('finish', () => {
      if (answering.get(req.socket) === res) {
        answering.delete(req.socket);
      }
    });
    let api = true;
    try {
      const head: RequestHead = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        headersDistinct: req.headersDistinct,
      };
      const verdict = checkRequest(head, guard);
      api = verdict.api;
      if (verdict.kind === 'route' && verdict.method === 'POST') {
        handleAction(req, res, head, verdict.path);
        return;
      }
      // No other request has a body worth reading; let it drain.
      req.resume();
      switch (verdict.kind) {
        case 'refuse':
          refuse(res, verdict.status, verdict.error, verdict.api, verdict.allow);
          return;
        case 'route':
          if (verdict.path === '/api/stream') {
            openStream(req, res, verdict.query);
          } else if (verdict.path === '/api/health') {
            const body: HealthResponse = { late: observed.list(), check: checker.last() };
            sendJson(res, 200, body);
          } else if (verdict.path === '/api/health/check') {
            runCheck(res);
          } else if (verdict.api) {
            const result = apiResponse({ board, cache, now, actor }, verdict.path, verdict.query);
            sendJson(res, result.status, result.body);
          } else {
            servePage(res, assetsDir, verdict.path);
          }
          return;
      }
    } catch (error) {
      // Unexpected: answer 500 without detail beyond the error document.
      req.resume();
      if (!res.headersSent) {
        if (api) {
          sendJson(res, 500, errorDocument(error, API_HINT_CONTEXT));
        } else {
          sendText(res, 500, 'agentboard: internal error\n');
        }
      } else {
        res.destroy();
      }
    }
  };

  const server = createServer({ requireHostHeader: false }, handle);
  // Malformed requests: answer 400 with the security headers, never Node's bare page.
  server.on('clientError', (_error: Error, socket: Socket) => {
    // As Node's own handler: never write a second response into one already begun.
    if (socket.writable && answering.get(socket)?.headersSent !== true) {
      const lines = Object.entries({
        ...securityHeaders(false),
        'Content-Length': '0',
        Connection: 'close',
      }).map(([name, value]) => `${name}: ${value}\r\n`);
      socket.end(`HTTP/1.1 400 Bad Request\r\n${lines.join('')}\r\n`);
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new BoardError(
            1,
            'port-in-use',
            `port ${String(requested)} is already in use on ${LOOPBACK}`,
          ),
        );
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen({ port: requested, host: LOOPBACK, exclusive: true }, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    server.close();
    throw new Error('the server has no TCP address');
  }
  const port = bound.port;
  guard = { port, token };

  const feedDone = watchBoard(board, feedOptions).catch(() => undefined);
  const keepalive = setInterval(() => {
    const frame = sseKeepalive();
    for (const client of clients) {
      send(client, frame);
    }
  }, keepaliveMs);

  let closing: Promise<void> | null = null;
  return {
    url: `http://${LOOPBACK}:${String(port)}/#token=${token}`,
    port,
    token,
    address: bound.address,
    streamCount: () => clients.size,
    close(): Promise<void> {
      closing ??= (async () => {
        stopped = true;
        controller.abort();
        clearInterval(keepalive);
        for (const client of clients) {
          client.res.end();
        }
        clients.clear();
        const closed = new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        server.closeAllConnections();
        await closed;
        await feedDone;
      })();
      return closing;
    },
  };
}

/** An open `/api/stream` response. */
interface StreamClient {
  readonly res: ServerResponse;
  /** True until the stream has its first message (the feed had not delivered yet). */
  waiting: boolean;
  /** The start position asked for. */
  readonly since: string | undefined;
}

/** Content types by lower-case extension; see `contentTypeOf`. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** The feed options of the server's tuning, without undefined values. */
function feedTuning(tuning: FeedTuning | undefined): Partial<WatchBoardOptions> {
  if (tuning === undefined) {
    return {};
  }
  return {
    ...(tuning.pollMs === undefined ? {} : { pollMs: tuning.pollMs }),
    ...(tuning.fsWatch === undefined ? {} : { fsWatch: tuning.fsWatch }),
    ...(tuning.timers === undefined ? {} : { timers: tuning.timers }),
    ...(tuning.watchDir === undefined ? {} : { watchDir: tuning.watchDir }),
  };
}

/** Sends `body` as JSON with the API headers. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: OutgoingHttpHeaders = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(true),
    ...extra,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/** Sends a plain text page with the page headers. */
function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  extra: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    ...securityHeaders(false),
    ...extra,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/**
 * Reads and throws away the rest of a refused action's body, holding none
 * of it, so the connection stays usable and the client can read the
 * response; a client that keeps sending past `DISCARD_LIMIT` bytes is
 * disconnected once the response has been sent.
 */
function discard(req: IncomingMessage, res: ServerResponse): void {
  let discarded = 0;
  req.on('data', (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > DISCARD_LIMIT) {
      if (res.writableFinished) {
        req.socket.destroy();
      } else {
        res.once('finish', () => {
          req.socket.destroy();
        });
      }
    }
  });
  req.resume();
}

/** Bytes of a refused action body read and thrown away before disconnecting: 1 MiB. */
const DISCARD_LIMIT = 1024 * 1024;

/** A refusal: an `ErrorDocument` on an API path, a plain text page otherwise. */
function refuse(
  res: ServerResponse,
  status: number,
  error: BoardError,
  api: boolean,
  allow: 'GET' | 'POST' = 'GET',
): void {
  const extra: OutgoingHttpHeaders = status === 405 ? { Allow: allow } : {};
  if (api) {
    sendJson(res, status, errorDocument(error, API_HINT_CONTEXT), extra);
  } else {
    sendText(res, status, `agentboard: ${error.message}\n`, extra);
  }
}

/** `/` and `/<name>` outside the API: the page, an asset, or 404. */
function servePage(res: ServerResponse, assetsDir: string, path: string): void {
  const name = path === '/' ? 'index.html' : path.slice(1);
  const content = readAsset(assetsDir, name);
  if (content !== null) {
    res.writeHead(200, {
      ...securityHeaders(false),
      'Content-Type': contentTypeOf(name),
      'Content-Length': String(content.length),
    });
    res.end(content);
    return;
  }
  if (path === '/') {
    res.writeHead(200, {
      ...securityHeaders(false),
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(PLACEHOLDER_PAGE)),
    });
    res.end(PLACEHOLDER_PAGE);
    return;
  }
  const error = new BoardError(1, 'not-found', 'no such page or asset on this server');
  sendText(res, 404, `agentboard: ${error.message}\n`);
}

/**
 * The bytes of the regular file `<dir>/<name>`, or null when `name` is not
 * a plain asset name (`ASSET_NAME`: no separator, no percent sign, no
 * leading dot) or the file is missing, not a regular file, a symbolic
 * link, or unreadable. Opened once and checked on the open descriptor, so
 * nothing can swap the file between the check and the read.
 */
function readAsset(dir: string, name: string): Buffer | null {
  if (!ASSET_NAME.test(name)) {
    return null;
  }
  let fd: number;
  try {
    // O_NONBLOCK and O_NOFOLLOW are absent on Windows; 0 there leaves the flags unchanged.
    // Non-blocking: opening a FIFO never waits for a writer.
    fd = openSync(
      join(dir, name),
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return null;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
