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
import { errorDocument } from '../cli/main.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import type { FeedMessage } from '../view/types.js';
import { API_HINT_CONTEXT, apiResponse, httpStatus } from './api.js';
import { checkRequest, newToken, securityHeaders, type Guard } from './security.js';
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
 * (`src/web/security.ts`) with this port and token. A request without a
 * `Host` header reaches that check too (it is 403 `forbidden-host`, not
 * Node's own 400: the `node:http` server is created with
 * `requireHostHeader: false`).
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
export async function startServer(
  board: Board,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const requested = options.port ?? 0;
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
    throw new BoardError(1, 'usage', 'the port must be an integer from 0 to 65535');
  }
  const token = options.token ?? newToken();
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const now = options.now ?? Date.now;
  const cache = options.cache ?? createEventCache();
  const stderr = options.stderr ?? ((): void => undefined);
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const maxStreams = options.maxStreams ?? MAX_STREAMS;
  const bufferLimit = options.streamBufferBytes ?? STREAM_BUFFER_BYTES;

  // Set once listening; no request is handled before that.
  let guard: Guard = { port: requested, token };
  const clients = new Set<StreamClient>();
  const controller = new AbortController();

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

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // A body is never read; let it drain.
    req.resume();
    let api = true;
    try {
      const verdict = checkRequest(
        { method: req.method ?? '', url: req.url ?? '', headers: req.headers },
        guard,
      );
      api = verdict.kind === 'enter' ? false : verdict.api;
      switch (verdict.kind) {
        case 'refuse':
          refuse(res, verdict.status, verdict.error, verdict.api);
          return;
        case 'enter':
          res.writeHead(303, {
            ...securityHeaders(false),
            Location: '/',
            'Set-Cookie': verdict.setCookie,
            'Content-Length': '0',
          });
          res.end();
          return;
        case 'route':
          if (verdict.path === '/api/stream') {
            openStream(req, res, verdict.query);
          } else if (verdict.api) {
            const result = apiResponse({ board, cache, now }, verdict.path, verdict.query);
            sendJson(res, result.status, result.body);
          } else {
            servePage(res, assetsDir, verdict.path);
          }
          return;
      }
    } catch (error) {
      // Unexpected: answer 500 without detail beyond the error document.
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
    if (socket.writable) {
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
    url: `http://${LOOPBACK}:${String(port)}/?token=${token}`,
    port,
    token,
    address: bound.address,
    streamCount: () => clients.size,
    close(): Promise<void> {
      closing ??= (async () => {
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

/** A refusal: an `ErrorDocument` on an API path, a plain text page otherwise. */
function refuse(res: ServerResponse, status: number, error: BoardError, api: boolean): void {
  const extra: OutgoingHttpHeaders = status === 405 ? { Allow: 'GET' } : {};
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
    // O_NOFOLLOW is absent on Windows; 0 there leaves the flags unchanged.
    fd = openSync(join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
