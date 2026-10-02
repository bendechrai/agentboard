/**
 * The server over real HTTP, in process (board-web: "Loopback only",
 * "Access token", "Host header check", "No cross-origin access and
 * security headers", "Read-only server", the server side of
 * "Self-contained front end"): every
 * security check (bearer token only, on the API only; no cookie ever; one
 * Host header), the assets (no token, regular files only, a FIFO never
 * blocks) and the placeholder page,
 * the start-up errors, and what the server must never do (echo or log the
 * token, write an event or a cursor).
 *
 * Servers listen on 127.0.0.1, port 0, unless a test needs a port it has
 * just found free or occupied.
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { commentTicket } from '../../board/actions.js';
import { newTicket } from '../../board/tickets.js';
import { renderHint } from '../../guidance/hints.js';
import { BoardError } from '../../store/errors.js';
import { eventNames } from '../../store/__tests__/helpers.js';
import {
  PLACEHOLDER_PAGE,
  contentTypeOf,
  defaultAssetsDir,
  startServer,
  type RunningServer,
} from '../server.js';
import {
  ASSETS,
  CSP,
  bearer,
  corsHeaders,
  expectSecurityHeaders,
  get,
  json,
  occupiedPort,
  open,
  openStream,
  project,
  rawRequest,
  request,
  scratch,
  serve,
  served,
  type HttpResult,
} from './web-helpers.js';

const SERVE = { surface: 'cli', command: 'serve' } as const;
const TASK = { source: 'openspec', ref: 'add-board-web', item: '3' };

/** Asserts an `ErrorDocument` response of `reason` with its CLI hint. */
function expectError(result: HttpResult, status: number, reason: string): void {
  expect(result.status).toBe(status);
  expect(json(result)).toEqual({
    error: {
      exitCode: 1,
      reason,
      message: expect.any(String) as unknown,
      hint: renderHint(reason, SERVE),
    },
  });
}

/** Asserts a plain text refusal page. */
function expectText(result: HttpResult, status: number): void {
  expect(result.status).toBe(status);
  expect(result.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(result.body.length).toBeGreaterThan(0);
}

/** Does connecting to `host`:`port` fail? */
function refusesConnection(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(true);
    });
  });
}

describe('scenario: Bound address (Loopback only)', () => {
  it('listens on 127.0.0.1 and gives the start-up URL with the token in the fragment', async () => {
    const { server } = await served();
    expect(server.address).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/#token=${server.token}`);
  });

  it('does not accept connections on any other address', async () => {
    const { server } = await served();
    const others = ['::1'];
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) {
        if (!info.internal && info.family === 'IPv4') {
          others.push(info.address);
        }
      }
    }
    for (const host of others) {
      expect(await refusesConnection(host, server.port), host).toBe(true);
    }
    expect(await refusesConnection('127.0.0.1', server.port)).toBe(false);
  });

  it('draws a new token and a free port at every start', async () => {
    const { board } = await served();
    const a = await serve(board);
    const b = await serve(board);
    expect(a.token).not.toBe(b.token);
    expect(a.port).not.toBe(b.port);
  });

  it('uses the token and port it is given', async () => {
    const { board } = await served();
    const token = 'T'.repeat(43);
    const server = await serve(board, { token });
    expect(server.token).toBe(token);
    expect((await get(server, '/api/session')).status).toBe(200);
  });
});

describe('start-up errors', () => {
  it('scenario: a port in use is BoardError exit 1 port-in-use naming the port', async () => {
    const port = await occupiedPort();
    const board = open(project().boardDir);
    const error = await startServer(board, { port, assetsDir: scratch() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BoardError);
    expect({
      exitCode: (error as BoardError).exitCode,
      reason: (error as BoardError).reason,
    }).toEqual({
      exitCode: 1,
      reason: 'port-in-use',
    });
    expect((error as BoardError).message).toContain(String(port));
  });

  it('refuses a port outside 0 to 65535 as usage', async () => {
    const board = open(project().boardDir);
    for (const port of [-1, 65536, 1.5, Number.NaN]) {
      const error = await startServer(board, { port, assetsDir: scratch() }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, String(port)).toBeInstanceOf(BoardError);
      expect((error as BoardError).reason).toBe('usage');
    }
  });
});

/** A GET request text with the given header lines, for `rawRequest`. */
function rawGet(path: string, lines: readonly string[]): string {
  return `GET ${path} HTTP/1.1\r\n${[...lines, 'Connection: close'].join('\r\n')}\r\n\r\n`;
}

describe('scenario: Page is served without a token (Access token)', () => {
  it('serves GET / and GET /app.js with no Authorization header: 200, security headers, no cookie, no board data', async () => {
    const { server, board } = await served();
    newTicket(board, 'orch', { title: 'Secret plans', task: TASK });
    const page = await request(server.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toBe(ASSETS['index.html']);
    const js = await request(server.port, '/app.js');
    expect(js.status).toBe(200);
    expect(js.body).toBe(ASSETS['app.js']);
    for (const result of [page, js]) {
      expectSecurityHeaders(result.headers, false);
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(result.body).not.toContain('Secret plans');
    }
  });

  it('answers the old entry URL /?token=<token> with the page itself: no 303, no cookie', async () => {
    const { server } = await served();
    const result = await request(server.port, `/?token=${server.token}`);
    expect(result.status).toBe(200);
    expect(result.headers.location).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.body).toBe(ASSETS['index.html']);
    expect(result.body).not.toContain(server.token);
  });
});

describe('scenario: API requires the bearer header', () => {
  it('answers /api/board and /api/stream without Authorization with 401 unauthorized', async () => {
    const { server } = await served();
    for (const path of ['/api/board', '/api/stream', '/api/session', '/api/nope']) {
      const result = await request(server.port, path);
      expectError(result, 401, 'unauthorized');
      expectSecurityHeaders(result.headers, true);
    }
  });

  it('accepts the bearer header, from 127.0.0.1 and localhost', async () => {
    const { server } = await served();
    expect((await get(server, '/api/session')).status).toBe(200);
    const local = await request(server.port, '/api/session', {
      headers: bearer(server),
      host: `localhost:${String(server.port)}`,
    });
    expect(local.status).toBe(200);
  });
});

describe('scenario: Query token and cookie are ignored', () => {
  it('answers /api/board?token=<token> with the old cookie and no Authorization with 401', async () => {
    const { server } = await served();
    const oldCookie = { Cookie: `agentboard-${String(server.port)}=${server.token}` };
    for (const path of [`/api/board?token=${server.token}`, `/api/stream?token=${server.token}`]) {
      const result = await request(server.port, path, { headers: oldCookie });
      expectError(result, 401, 'unauthorized');
      expect(result.body).not.toContain(server.token);
    }
  });

  it('never sends a Set-Cookie header, on any response', async () => {
    const { server } = await served();
    const port = server.port;
    const results = await Promise.all([
      request(port, '/'),
      request(port, `/?token=${server.token}`),
      request(port, '/app.js'),
      request(port, '/nope'),
      get(server, '/api/board'),
      request(port, '/api/board'),
      request(port, '/', { method: 'POST' }),
      request(port, '/api/board', { host: 'evil.example' }),
    ]);
    for (const result of results) {
      expect(result.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('scenario: Wrong token', () => {
  it('answers a bearer token differing in one character with 401', async () => {
    const { server } = await served();
    const t = server.token;
    const wrong = `${t.slice(0, 20)}${t[20] === 'A' ? 'B' : 'A'}${t.slice(21)}`;
    expect(wrong).toHaveLength(43);
    const result = await request(server.port, '/api/board', {
      headers: { Authorization: `Bearer ${wrong}` },
    });
    expectError(result, 401, 'unauthorized');
    expect(result.body).not.toContain(wrong);
  });

  it('answers other schemes and a bare token with 401', async () => {
    const { server } = await served();
    for (const headers of [
      { Authorization: `Basic ${server.token}` },
      { Authorization: server.token },
      { Authorization: `Bearer ${'x'.repeat(43)}` },
      {},
    ]) {
      expectError(await request(server.port, '/api/board', { headers }), 401, 'unauthorized');
    }
  });
});

describe('scenario: Duplicate Authorization header (Access token)', () => {
  it(
    'answers a request with two Authorization headers, the first valid, with 401 and no board data',
    { timeout: 30_000 },
    async () => {
      const { server, board } = await served();
      newTicket(board, 'orch', { title: 'Secret plans', task: TASK });
      const host = `Host: 127.0.0.1:${String(server.port)}`;
      const valid = `Authorization: Bearer ${server.token}`;
      for (const second of [
        valid,
        `Authorization: Bearer ${'x'.repeat(43)}`,
        'Authorization: Basic eDp5',
        'authorization: Bearer',
      ]) {
        for (const path of ['/api/board', '/api/session', '/api/stream']) {
          const result = await rawRequest(server.port, rawGet(path, [host, valid, second]));
          expect(result.status, `${path} | ${second}`).toBe(401);
          expect(JSON.parse(result.body)).toMatchObject({ error: { reason: 'unauthorized' } });
          expect(result.body).not.toContain('Secret plans');
          expect(result.body).not.toContain(server.token);
          expect(result.headers['cache-control']).toEqual(['no-store']);
        }
      }
      // The same request with the one valid header is served.
      const one = await rawRequest(server.port, rawGet('/api/board', [host, valid]));
      expect(one.status).toBe(200);
      expect(one.body).toContain('Secret plans');
    },
  );

  it('does not let a duplicate Authorization header matter on the page and assets', async () => {
    const { server } = await served();
    const host = `Host: 127.0.0.1:${String(server.port)}`;
    const valid = `Authorization: Bearer ${server.token}`;
    for (const path of ['/', '/app.js']) {
      const result = await rawRequest(server.port, rawGet(path, [host, valid, valid]));
      expect(result.status, path).toBe(200);
    }
  });
});

describe('scenario: DNS rebinding (Host header check)', () => {
  it('answers a valid bearer token with Host attacker.example:<port> with 403 and no board data', async () => {
    const { server, board } = await served();
    const created = newTicket(board, 'orch', { title: 'Secret plans', task: TASK }).ticket;
    const host = `attacker.example:${String(server.port)}`;
    const api = await request(server.port, '/api/board', { headers: bearer(server), host });
    expectError(api, 403, 'forbidden-host');
    expect(api.body).not.toContain(created.id);
    expect(api.body).not.toContain('Secret plans');
    expectSecurityHeaders(api.headers, true);
  });

  it('scenario: rebinding the page is 403 forbidden-host', async () => {
    const { server } = await served();
    const host = `attacker.example:${String(server.port)}`;
    for (const path of ['/', '/app.js']) {
      const page = await request(server.port, path, { host });
      expectText(page, 403);
      expect(page.body).not.toContain('test page');
      expectSecurityHeaders(page.headers, false);
    }
  });

  it('checks the Host before the token, and refuses other and missing hosts', async () => {
    const { server } = await served();
    const port = String(server.port);
    for (const host of [
      'attacker.example',
      `127.0.0.1`,
      `[::1]:${port}`,
      `127.0.0.1:1`,
      `LOCALHOST:${port}`,
    ]) {
      expectError(
        await request(server.port, '/api/board', { headers: bearer(server), host }),
        403,
        'forbidden-host',
      );
      // No token at all: still 403, not 401.
      expectError(await request(server.port, '/api/board', { host }), 403, 'forbidden-host');
    }
    expectError(
      await request(server.port, '/api/board', { headers: bearer(server), host: null }),
      403,
      'forbidden-host',
    );
    expectText(await request(server.port, '/', { host: null }), 403);
  });
});

describe('scenario: Duplicate Host header', () => {
  it('answers a valid bearer request with a second Host header with 403 and no board data', async () => {
    const { server, board } = await served();
    newTicket(board, 'orch', { title: 'Secret plans', task: TASK });
    const good = `Host: 127.0.0.1:${String(server.port)}`;
    for (const lines of [
      [good, 'Host: attacker.example'],
      ['Host: attacker.example', good],
      [good, good],
    ]) {
      const result = await rawRequest(
        server.port,
        rawGet('/api/board', [...lines, `Authorization: Bearer ${server.token}`]),
      );
      expect(result.status, lines.join(' | ')).toBe(403);
      expect(JSON.parse(result.body)).toMatchObject({ error: { reason: 'forbidden-host' } });
      expect(result.body).not.toContain('Secret plans');
      const page = await rawRequest(server.port, rawGet('/', lines));
      expect(page.status, lines.join(' | ')).toBe(403);
    }
  });
});

describe('malformed requests', () => {
  it('answers a request the parser rejects with 400 and the security headers', async () => {
    const { server } = await served();
    for (const text of [
      `GET /\u0000 HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\n\r\n`,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n`,
      'NOT HTTP AT ALL\r\n\r\n',
    ]) {
      const result = await rawRequest(server.port, text);
      expect(result.status, JSON.stringify(text)).toBe(400);
      expect(result.headers['content-security-policy']).toEqual([CSP]);
      expect(result.headers['x-content-type-options']).toEqual(['nosniff']);
      expect(result.headers['referrer-policy']).toEqual(['no-referrer']);
      expect(result.headers['x-frame-options']).toEqual(['DENY']);
      expect(result.headers['cross-origin-opener-policy']).toEqual(['same-origin']);
      expect(result.headers['cross-origin-resource-policy']).toEqual(['same-origin']);
      expect(Object.keys(result.headers).filter((h) => h.startsWith('access-control-'))).toEqual(
        [],
      );
      expect(result.headers['set-cookie']).toBeUndefined();
    }
    // The server still answers afterwards.
    expect((await get(server, '/api/session')).status).toBe(200);
  });
});

describe('scenario: Preflight is refused (No cross-origin access)', () => {
  it('answers an authenticated OPTIONS /api/board with an Origin with 405 and no Access-Control-Allow-* header', async () => {
    const { server } = await served();
    const result = await request(server.port, '/api/board', {
      method: 'OPTIONS',
      headers: {
        ...bearer(server),
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expectError(result, 405, 'method-not-allowed');
    expect(result.headers.allow).toBe('GET');
    expect(corsHeaders(result.headers)).toEqual([]);
  });

  it('refuses an unauthenticated preflight on the API with 401, and on the page with 405, no CORS header', async () => {
    const { server } = await served();
    const preflight = { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' };
    const api = await request(server.port, '/api/board', { method: 'OPTIONS', headers: preflight });
    expectError(api, 401, 'unauthorized');
    expect(corsHeaders(api.headers)).toEqual([]);
    const page = await request(server.port, '/', { method: 'OPTIONS', headers: preflight });
    expectText(page, 405);
    expect(page.headers.allow).toBe('GET');
    expect(corsHeaders(page.headers)).toEqual([]);
  });

  it('never adds a CORS header to a GET from another origin', async () => {
    const { server } = await served();
    for (const path of ['/', '/app.js', '/api/board', '/api/session', '/api/nope']) {
      const result = await request(server.port, path, {
        headers: { ...bearer(server), Origin: 'https://evil.example' },
      });
      expect(corsHeaders(result.headers), path).toEqual([]);
    }
  });
});

describe('scenario: Headers on every response', () => {
  it('carries the security headers on the page, an asset, the API, a stream, a 401, a 403 and every refusal', async () => {
    const { server } = await served();
    const port = server.port;
    const cases: [string, Promise<HttpResult>, boolean][] = [
      ['page', request(port, '/'), false],
      ['asset', request(port, '/app.js'), false],
      ['api', get(server, '/api/board'), true],
      ['api error', get(server, '/api/nope'), true],
      ['401', request(port, '/api/board'), true],
      [
        '403 api',
        request(port, '/api/board', { headers: bearer(server), host: 'evil.example' }),
        true,
      ],
      ['403 page', request(port, '/', { host: 'evil.example' }), false],
      ['404 page', request(port, '/nope.js'), false],
      ['405 api', request(port, '/api/board', { method: 'POST', headers: bearer(server) }), true],
      ['405 page', request(port, '/', { method: 'POST' }), false],
    ];
    for (const [name, pending, api] of cases) {
      const result = await pending;
      expect(result.status, name).toBeGreaterThan(0);
      expectSecurityHeaders(result.headers, api);
    }
    const stream = await openStream(server);
    expect(stream.status).toBe(200);
    expectSecurityHeaders(stream.headers, true);
    stream.close();
  });
});

describe('Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy', () => {
  it('sends COOP same-origin and CORP same-origin, once each, on the page, an asset, an API response and an error', async () => {
    const { server } = await served();
    const port = server.port;
    const host = `Host: 127.0.0.1:${String(port)}`;
    const auth = `Authorization: Bearer ${server.token}`;
    const cases: [string, string, readonly string[], number][] = [
      ['page', '/', [host], 200],
      ['asset', '/app.js', [host], 200],
      ['stylesheet', '/app.css', [host], 200],
      ['api', '/api/board', [host, auth], 200],
      ['api 404', '/api/nope', [host, auth], 404],
      ['401', '/api/board', [host], 401],
      ['403', '/api/board', ['Host: evil.example', auth], 403],
      ['page 404', '/nope.js', [host], 404],
    ];
    for (const [name, path, lines, status] of cases) {
      const result = await rawRequest(port, rawGet(path, lines));
      expect(result.status, name).toBe(status);
      expect(result.headers['cross-origin-opener-policy'], name).toEqual(['same-origin']);
      expect(result.headers['cross-origin-resource-policy'], name).toEqual(['same-origin']);
    }
    const refused = await request(port, '/api/board', { method: 'POST', headers: bearer(server) });
    expect(refused.status).toBe(405);
    expect(refused.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(refused.headers['cross-origin-resource-policy']).toBe('same-origin');
    const stream = await openStream(server);
    expect(stream.status).toBe(200);
    expect(stream.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(stream.headers['cross-origin-resource-policy']).toBe('same-origin');
    stream.close();
  });
});

describe('scenario: POST is refused (Read-only server)', () => {
  it('answers an authenticated POST /api/board with 405 method-not-allowed and writes no event', async () => {
    const { server, board, eventsDir } = await served();
    newTicket(board, 'orch', { title: 'One', task: TASK });
    const before = eventNames(eventsDir);
    const result = await request(server.port, '/api/board', {
      method: 'POST',
      headers: { ...bearer(server), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'ticket.create', title: 'Injected' }),
    });
    expectError(result, 405, 'method-not-allowed');
    expect(result.headers.allow).toBe('GET');
    expect(eventNames(eventsDir)).toEqual(before);
    // Without a token the API answers 401 first.
    expectError(await request(server.port, '/api/board', { method: 'POST' }), 401, 'unauthorized');
  });

  it('refuses every other method with 405 and Allow: GET, on the API and the page', async () => {
    const { server, eventsDir } = await served();
    const before = eventNames(eventsDir);
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const api = await request(server.port, '/api/tickets/01J9K3', {
        method,
        headers: bearer(server),
      });
      expect(api.status, method).toBe(405);
      expect(api.headers.allow).toBe('GET');
      const page = await request(server.port, '/', { method });
      expect(page.status, method).toBe(405);
      expect(page.headers.allow).toBe('GET');
    }
    expectText(await request(server.port, '/', { method: 'POST' }), 405);
    expect(eventNames(eventsDir)).toEqual(before);
  });
});

describe('assets', () => {
  it('serves the files of the assets directory with their content types, without a token', async () => {
    const { server } = await served();
    const js = await request(server.port, '/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toBe(ASSETS['app.js']);
    const css = await request(server.port, '/app.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body).toBe(ASSETS['app.css']);
    const html = await request(server.port, '/index.html');
    expect(html.status).toBe(200);
    expect(html.body).toBe(ASSETS['index.html']);
  });

  it('serves nothing outside the assets directory, no hidden file, no subdirectory and no symbolic link', async () => {
    const { board, boardDir } = await served();
    const base = scratch();
    const assets = join(base, 'web');
    mkdirSync(assets);
    for (const [name, text] of Object.entries(ASSETS)) {
      writeFileSync(join(assets, name), text);
    }
    writeFileSync(join(assets, '.hidden'), 'hidden');
    mkdirSync(join(assets, 'sub'));
    writeFileSync(join(assets, 'sub', 'x.js'), 'nested');
    // A secret file beside the assets directory, as dist/cli.js is beside dist/web.
    const secret = `secret-${String(process.pid)}.txt`;
    writeFileSync(join(base, secret), 'the secret');
    // Symbolic links, to a file outside and to a regular file inside.
    symlinkSync(join(base, secret), join(assets, 'outside.txt'));
    symlinkSync(join(assets, 'app.js'), join(assets, 'inside.js'));
    symlinkSync(join(assets, 'sub'), join(assets, 'dirlink'));
    const server = await serve(board, { assetsDir: assets });
    const paths = [
      '/.hidden',
      '/sub/x.js',
      '/sub',
      '/outside.txt',
      '/inside.js',
      '/dirlink',
      `/../${secret}`,
      `/..%2F${secret}`,
      `/%2e%2e/${secret}`,
      `/%2E%2E%2F${secret}`,
      '/..%5c..%5ccache.sqlite',
      '/..\\cache.sqlite',
      `/${encodeURIComponent(join(boardDir, 'cache.sqlite'))}`,
      '/missing.js',
      '/app.js%00.css',
    ];
    for (const path of paths) {
      const result = await request(server.port, path);
      expect(result.status, path).toBe(404);
      expect(result.headers['content-type'], path).toBe('text/plain; charset=utf-8');
      expect(result.body, path).not.toContain('hidden');
      expect(result.body, path).not.toContain('nested');
      expect(result.body, path).not.toContain('the secret');
      expect(result.body, path).not.toContain('test bundle');
      expect(result.body, path).not.toContain('SQLite');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'scenario: a FIFO among the assets is 404 at once, and a concurrent API request is not held up',
    { timeout: 30_000 },
    async () => {
      const { board } = await served();
      const assets = scratch();
      for (const [name, text] of Object.entries(ASSETS)) {
        writeFileSync(join(assets, name), text);
      }
      const fifo = join(assets, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const server = await serve(board, { assetsDir: assets });
      // A helper process that opens the FIFO for writing after 2 seconds. A
      // server that opened it blocking would be stuck until then, and with it
      // this whole process (the test's own timers included).
      const writer = spawn(
        process.execPath,
        [
          '-e',
          `setTimeout(() => require('fs').closeSync(require('fs').openSync(${JSON.stringify(fifo)}, 'w')), 2000)`,
        ],
        { stdio: 'ignore' },
      );
      try {
        const started = Date.now();
        let sessionMs = -1;
        const [pipe, session] = await Promise.all([
          request(server.port, '/pipe'),
          get(server, '/api/session').then((result) => {
            sessionMs = Date.now() - started;
            return result;
          }),
        ]);
        expect(pipe.status).toBe(404);
        expect(session.status).toBe(200);
        expect(sessionMs).toBeLessThan(1500);
        expect(Date.now() - started).toBeLessThan(1500);
      } finally {
        writer.kill('SIGKILL');
      }
    },
  );

  it('serves the placeholder page on / when the assets are not built', async () => {
    expect(PLACEHOLDER_PAGE).toContain('dist/web');
    expect(PLACEHOLDER_PAGE).toContain('npm run build');
    expect(PLACEHOLDER_PAGE).toMatch(/^<!doctype html>/i);
    expect(PLACEHOLDER_PAGE).not.toMatch(/<script|<link|<style|https?:\/\//i);
    const { board } = await served();
    const server = await serve(board, { assetsDir: scratch() });
    const page = await request(server.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toBe(PLACEHOLDER_PAGE);
    expect((await request(server.port, '/app.js')).status).toBe(404);
    // The API works without assets.
    expect((await get(server, '/api/session')).status).toBe(200);
    // And so does a directory that does not exist at all.
    const missing = await serve(board, { assetsDir: join(scratch(), 'no-such-dir') });
    expect((await request(missing.port, '/')).body).toBe(PLACEHOLDER_PAGE);
  });

  it('answers an unknown page path with a plain text 404', async () => {
    const { server } = await served();
    expectText(await request(server.port, '/nope'), 404);
  });

  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['chunk.mjs', 'text/javascript; charset=utf-8'],
    ['app.css', 'text/css; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['app.js.map', 'application/json; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['logo.png', 'image/png'],
    ['favicon.ico', 'image/x-icon'],
    ['notes.txt', 'text/plain; charset=utf-8'],
    ['blob.bin', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('contentTypeOf(%s) is %s', (name, type) => {
    expect(contentTypeOf(name)).toBe(type);
  });

  it('defaults the assets directory to web beside the module (dist/web for the built CLI)', () => {
    const dist = join(scratch(), 'dist');
    expect(defaultAssetsDir(pathToFileURL(join(dist, 'cli.js')).href)).toBe(join(dist, 'web'));
    expect(defaultAssetsDir(pathToFileURL(join(dist, 'serve-ABC123.js')).href)).toBe(
      join(dist, 'web'),
    );
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts');
    expect(defaultAssetsDir()).toBe(join(dirname(source), 'web'));
  });
});

/** Every file under `dir`, recursively. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...files(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe('the token is never echoed, logged or written', () => {
  it('appears in no response body and no response header', { timeout: 30_000 }, async () => {
    let logged = '';
    const { server, board, root } = await served({
      stderr: (text) => {
        logged += text;
      },
    });
    const ticket = newTicket(board, 'orch', { title: 'One', task: TASK }).ticket;
    commentTicket(board, 'impl', { id: ticket.id, text: 'hello' });
    const port = server.port;
    const t = server.token;
    const responses: [string, HttpResult][] = [];
    const add = async (name: string, pending: Promise<HttpResult>): Promise<void> => {
      responses.push([name, await pending]);
    };
    await add('old entry URL', request(port, `/?token=${t}`));
    await add('page', request(port, '/'));
    await add('asset', request(port, '/app.js'));
    for (const path of [
      '/api/session',
      '/api/board',
      `/api/tickets/${ticket.id}`,
      '/api/events',
      '/api/actors',
    ]) {
      await add(path, get(server, path));
    }
    await add('404', get(server, '/api/nope'));
    await add('400', get(server, '/api/events?limit=0'));
    await add('401 query', request(port, `/api/board?token=${t}`));
    await add(
      '401 cookie',
      request(port, '/api/board', { headers: { Cookie: `agentboard-${String(port)}=${t}` } }),
    );
    await add(
      '403',
      request(port, '/api/board', { headers: bearer(server), host: 'evil.example' }),
    );
    await add('405', request(port, '/api/board', { method: 'POST', headers: bearer(server) }));
    for (const [name, result] of responses) {
      expect(result.body, name).not.toContain(t);
      for (const [header, value] of Object.entries(result.headers)) {
        expect(JSON.stringify(value), `${name} ${header}`).not.toContain(t);
      }
    }
    const stream = await openStream(server);
    await stream.until((c) => c.events().length > 0, 3000, 'the first stream event');
    expect(stream.raw()).not.toContain(t);
    expect(JSON.stringify(stream.headers)).not.toContain(t);
    stream.close();
    // Nothing is logged per request.
    expect(logged).toBe('');
    // No file of the project or the board holds the token.
    for (const path of files(root)) {
      expect(readFileSync(path).includes(Buffer.from(t)), path).toBe(false);
    }
  });
});

describe('serving writes nothing (Read-only server)', () => {
  it('leaves the event files and the cursor tables unchanged across every route and a stream', async () => {
    const { server, board, eventsDir } = await served();
    const ticket = newTicket(board, 'orch', { title: 'One', task: TASK }).ticket;
    const rows = (): unknown => ({
      cursors: board.db.prepare('SELECT * FROM cursors').all(),
      seen: board.db.prepare('SELECT * FROM cursor_seen').all(),
    });
    const before = { events: eventNames(eventsDir), rows: rows() };
    for (const path of [
      '/api/session',
      '/api/board',
      `/api/tickets/${ticket.id}`,
      '/api/events',
      '/api/actors',
    ]) {
      expect((await get(server, path)).status, path).toBe(200);
    }
    const stream = await openStream(server);
    await stream.until((c) => c.events().length > 0, 3000, 'the first stream event');
    stream.close();
    expect({ events: eventNames(eventsDir), rows: rows() }).toEqual(before);
  });
});

describe('close', () => {
  it('ends open streams, refuses new connections and is idempotent', async () => {
    const { server } = await served();
    const stream = await openStream(server);
    await stream.until((c) => c.events().length > 0, 3000, 'the first stream event');
    const closing = server.close();
    expect(server.close()).toBe(closing);
    await closing;
    await stream.until((c) => c.ended(), 3000, 'the stream to end');
    expect(await refusesConnection('127.0.0.1', server.port)).toBe(true);
    expect(server.streamCount()).toBe(0);
  });

  it('does not close the board', async () => {
    const { board } = await served();
    const server: RunningServer = await serve(board);
    await server.close();
    expect(() => board.db.prepare('SELECT 1').get()).not.toThrow();
  });
});
