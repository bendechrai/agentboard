/**
 * Shared fixtures for the web server tests (add-board-web group 3): a
 * temporary board with test assets, servers started in process on
 * 127.0.0.1 port 0 and closed after each test, a raw HTTP client that
 * controls every header (the `Host` header included, which `fetch` does
 * not allow), and a Server-Sent Events client that can stop reading.
 *
 * Nothing here binds anything but 127.0.0.1, and every server uses port 0
 * unless a test asks for a specific port it has just found free.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect } from 'vitest';

import { openBoard, type Board } from '../../store/board.js';
import { startServer, type RunningServer, type ServerOptions } from '../server.js';

/** The page, script and stylesheet served by the test servers. */
export const ASSETS = {
  'index.html': '<!doctype html><html><head><title>test page</title></head><body></body></html>',
  'app.js': 'console.log("test bundle");\n',
  'app.css': 'body { margin: 0; }\n',
} as const;

/** The Content-Security-Policy of board-web, written out independently of the source. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const dirs: string[] = [];
const servers: RunningServer[] = [];
const boards: Board[] = [];
const clients: StreamClient[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
  for (const blocker of blockers.splice(0)) {
    blocker.close();
  }
  for (const board of boards.splice(0)) {
    board.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temporary directory (realpath), removed after the test. */
export function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-web-')));
  dirs.push(dir);
  return dir;
}

/** A directory holding `ASSETS`, removed after the test. */
export function assetsDir(): string {
  const dir = scratch();
  for (const [name, text] of Object.entries(ASSETS)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** A project root with an empty board at `<root>/.board`. */
export function project(): { root: string; boardDir: string; eventsDir: string } {
  const root = scratch();
  const boardDir = join(root, '.board');
  const eventsDir = join(boardDir, 'events');
  mkdirSync(eventsDir, { recursive: true });
  return { root, boardDir, eventsDir };
}

/** Opens the board at `dir`; closed after the test (after every server). */
export function open(dir: string): Board {
  const board = openBoard(dir);
  boards.push(board);
  return board;
}

/** Starts a server on `board` with the test assets unless given; closed after the test. */
export async function serve(board: Board, options: ServerOptions = {}): Promise<RunningServer> {
  const server = await startServer(board, { assetsDir: assetsDir(), ...options });
  servers.push(server);
  return server;
}

/** A project with a board, opened, and a server on it. */
export async function served(options: ServerOptions = {}): Promise<{
  server: RunningServer;
  board: Board;
  root: string;
  boardDir: string;
  eventsDir: string;
}> {
  const dirs = project();
  const board = open(dirs.boardDir);
  const server = await serve(board, options);
  return { server, board, ...dirs };
}

/** A port that was free on 127.0.0.1 a moment ago (nothing listens on it now). */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Listens on 127.0.0.1 at a free port until the end of the test; returns the port. */
export async function occupiedPort(): Promise<number> {
  const blocker = createServer();
  blockers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const address = blocker.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** One HTTP response, read to the end. */
export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Options of `request`. */
export interface RequestOptions {
  method?: string;
  /** Extra headers (names in any case). */
  headers?: Record<string, string>;
  /**
   * The `Host` header: default `127.0.0.1:<port>`; null sends no `Host`
   * header at all.
   */
  host?: string | null;
  /** A request body. */
  body?: string;
}

/** Sends one request to 127.0.0.1:`port` and reads the whole response. */
export function request(
  port: number,
  path: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers };
  const host = options.host === undefined ? `127.0.0.1:${String(port)}` : options.host;
  if (host !== null) {
    headers.Host = host;
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers,
        setHost: false,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** What a client needs to reach a server: its port and token. */
export type Endpoint = Pick<RunningServer, 'port' | 'token'>;

/** `Authorization: Bearer <token>`. */
export function bearer(server: Endpoint): Record<string, string> {
  return { Authorization: `Bearer ${server.token}` };
}

/** The session cookie, written out from the spec (`agentboard-<port>=<token>`). */
export function cookie(server: Endpoint): Record<string, string> {
  return { Cookie: `agentboard-${String(server.port)}=${server.token}` };
}

/** GET with the bearer token. */
export function get(
  server: Endpoint,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return request(server.port, path, { headers: { ...bearer(server), ...headers } });
}

/** A JSON body. */
export function json(result: HttpResult): unknown {
  expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
  return JSON.parse(result.body) as unknown;
}

/** The `Access-Control-*` header names of a response. */
export function corsHeaders(headers: IncomingHttpHeaders): string[] {
  return Object.keys(headers).filter((name) => name.toLowerCase().startsWith('access-control-'));
}

/** Asserts the security headers every response carries (board-web). */
export function expectSecurityHeaders(headers: IncomingHttpHeaders, api: boolean): void {
  expect(headers['content-security-policy']).toBe(CSP);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  if (api) {
    expect(headers['cache-control']).toBe('no-store');
  }
  expect(corsHeaders(headers)).toEqual([]);
}

/** One dispatched SSE event. */
export interface SseEvent {
  /** The `event` field, or null (a message without one). */
  event: string | null;
  /** The `id` field, or null when the event had none. */
  id: string | null;
  data: string;
}

/** A parsed SSE text. */
export interface SseParse {
  /** The `retry` values in order. */
  retries: string[];
  /** Comment lines (without the leading `:`), in order. */
  comments: string[];
  /** Dispatched events (blocks with data), in order. */
  events: SseEvent[];
}

/** Parses complete SSE blocks (each ended by a blank line) of `text`; an incomplete tail is ignored. */
export function parseSse(text: string): SseParse {
  const out: SseParse = { retries: [], comments: [], events: [] };
  const blocks = text.split('\n\n');
  blocks.pop();
  for (const block of blocks) {
    let event: string | null = null;
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        out.comments.push(line.slice(1));
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') {
        event = value;
      } else if (field === 'id') {
        id = value;
      } else if (field === 'data') {
        data.push(value);
      } else if (field === 'retry') {
        out.retries.push(value);
      }
    }
    if (data.length > 0) {
      out.events.push({ event, id, data: data.join('\n') });
    }
  }
  return out;
}

/** An open `/api/stream` (or any streamed response). */
export interface StreamClient {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Everything received so far. */
  raw(): string;
  /** Bytes received so far. */
  bytes(): number;
  /** The parsed events received so far. */
  events(): SseEvent[];
  /** The parsed text received so far. */
  parsed(): SseParse;
  /** True once the response ended, closed or failed. */
  ended(): boolean;
  /** Resolves when `check` holds, polling every 10 ms; rejects after `ms`. */
  until(check: (client: StreamClient) => boolean, ms: number, what: string): Promise<void>;
  /** Stops reading from the socket (TCP backpressure builds up at the server). */
  pause(): void;
  /** Reads again. */
  resume(): void;
  /** Destroys the connection. */
  close(): void;
}

/** Options of `openStream`. */
export interface StreamOptions {
  /** Default `/api/stream`. */
  path?: string;
  /** Extra headers; the bearer token is added unless `auth` is false. */
  headers?: Record<string, string>;
  auth?: boolean;
  /** Pause the response as soon as it arrives, before reading any data. */
  paused?: boolean;
}

/** Opens a streamed GET on `server` and resolves once the response head has arrived. */
export function openStream(server: Endpoint, options: StreamOptions = {}): Promise<StreamClient> {
  const headers: Record<string, string> = {
    Host: `127.0.0.1:${String(server.port)}`,
    ...(options.auth === false ? {} : bearer(server)),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path: options.path ?? '/api/stream',
        method: 'GET',
        headers,
        setHost: false,
        agent: false,
      },
      (res: IncomingMessage) => {
        if (options.paused === true) {
          res.pause();
        }
        let text = '';
        let size = 0;
        let done = false;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          size += Buffer.byteLength(chunk);
        });
        const finish = (): void => {
          done = true;
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
        req.on('error', finish);
        const client: StreamClient = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          raw: () => text,
          bytes: () => size,
          events: () => parseSse(text).events,
          parsed: () => parseSse(text),
          ended: () => done,
          async until(check, ms, what) {
            const deadline = Date.now() + ms;
            while (!check(client)) {
              if (Date.now() > deadline) {
                throw new Error(
                  `timed out after ${String(ms)} ms waiting for ${what}; received: ${text.slice(0, 2000)}`,
                );
              }
              await new Promise((r) => setTimeout(r, 10));
            }
          },
          pause: () => {
            res.pause();
          },
          resume: () => {
            res.resume();
          },
          close: () => {
            req.destroy();
            res.destroy();
          },
        };
        clients.push(client);
        resolve(client);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Polls `check` every 10 ms until it holds; rejects after `ms`. */
export async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves after `ms`. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
