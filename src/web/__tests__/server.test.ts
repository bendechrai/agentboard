/**
 * The server over real HTTP, in process (board-web: "Loopback only",
 * "Access token", "Host header check", "No cross-origin access and
 * security headers", "Read-only server"; add-board-web task 3.1): every
 * security check, the cookie flow, the assets and the placeholder page,
 * the start-up errors, and what the server must never do (echo or log the
 * token, write an event or a cursor).
 *
 * Servers listen on 127.0.0.1, port 0, unless a test needs a port it has
 * just found free or occupied.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
  bearer,
  cookie,
  corsHeaders,
  expectSecurityHeaders,
  get,
  json,
  occupiedPort,
  open,
  openStream,
  project,
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
  it('listens on 127.0.0.1 and prints the entry URL with the token', async () => {
    const { server } = await served();
    expect(server.address).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/?token=${server.token}`);
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

describe('scenario: Entry URL sets the cookie (Access token)', () => {
  it('answers GET /?token=<token> with 303 to / and the session cookie', async () => {
    const { server } = await served();
    const result = await request(server.port, `/?token=${server.token}`);
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe('/');
    const setCookie = result.headers['set-cookie'] ?? [];
    expect(setCookie).toHaveLength(1);
    const parts = (setCookie[0] ?? '').split(';').map((p) => p.trim());
    expect(parts[0]).toBe(`agentboard-${String(server.port)}=${server.token}`);
    expect(parts.slice(1).sort()).toEqual(['HttpOnly', 'Path=/', 'SameSite=Strict']);
    expect(result.body).not.toContain(server.token);
    expectSecurityHeaders(result.headers, false);
  });

  it('serves the page to the cookie the 303 set', async () => {
    const { server } = await served();
    const entry = await request(server.port, `/?token=${server.token}`);
    const pair = (entry.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const page = await request(server.port, '/', { headers: { Cookie: pair } });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toBe(ASSETS['index.html']);
    // And the API to the same cookie.
    expect((await request(server.port, '/api/session', { headers: { Cookie: pair } })).status).toBe(
      200,
    );
  });

  it('accepts localhost:<port> as the host', async () => {
    const { server } = await served();
    const result = await request(server.port, '/api/session', {
      headers: bearer(server),
      host: `localhost:${String(server.port)}`,
    });
    expect(result.status).toBe(200);
  });
});

describe('scenario: Query token is not accepted on the API', () => {
  it('answers GET /api/board?token=<token> with 401 unauthorized', async () => {
    const { server } = await served();
    const result = await request(server.port, `/api/board?token=${server.token}`);
    expectError(result, 401, 'unauthorized');
    expectSecurityHeaders(result.headers, true);
  });

  it('does not accept the query token on an asset or the stream either', async () => {
    const { server } = await served();
    expectText(await request(server.port, `/app.js?token=${server.token}`), 401);
    expectError(
      await request(server.port, `/api/stream?token=${server.token}`),
      401,
      'unauthorized',
    );
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

  it('answers a wrong cookie, another port cookie and no token with 401', async () => {
    const { server } = await served();
    for (const headers of [
      { Cookie: `agentboard-${String(server.port)}=${'x'.repeat(43)}` },
      { Cookie: `agentboard-${String(server.port + 1)}=${server.token}` },
      { Authorization: `Basic ${server.token}` },
      {},
    ]) {
      expectError(await request(server.port, '/api/board', { headers }), 401, 'unauthorized');
    }
  });

  it('answers the page without a token with a plain text 401 that points to the start-up URL', async () => {
    const { server } = await served();
    const result = await request(server.port, '/');
    expectText(result, 401);
    expect(result.body).toContain('agentboard serve');
    expect(result.body).not.toContain(server.token);
    expectSecurityHeaders(result.headers, false);
  });
});

describe('scenario: DNS rebinding (Host header check)', () => {
  it('answers a valid cookie with Host attacker.example:<port> with 403 and no board data', async () => {
    const { server, board } = await served();
    const created = newTicket(board, 'orch', { title: 'Secret plans', task: TASK }).ticket;
    const host = `attacker.example:${String(server.port)}`;
    const api = await request(server.port, '/api/board', { headers: cookie(server), host });
    expectError(api, 403, 'forbidden-host');
    expect(api.body).not.toContain(created.id);
    expect(api.body).not.toContain('Secret plans');
    expectSecurityHeaders(api.headers, true);
    const page = await request(server.port, '/', { headers: cookie(server), host });
    expectText(page, 403);
    expect(page.body).not.toContain('test page');
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
  });
});

describe('scenario: Preflight is refused (No cross-origin access)', () => {
  it('answers OPTIONS /api/board with an Origin with 405 and no Access-Control-Allow-* header', async () => {
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

  it('refuses an unauthenticated preflight (no credentials) with 401 and no CORS header', async () => {
    const { server } = await served();
    const result = await request(server.port, '/api/board', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expectError(result, 401, 'unauthorized');
    expect(corsHeaders(result.headers)).toEqual([]);
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
  it('carries the security headers on the page, an asset, the API, a stream and every refusal', async () => {
    const { server } = await served();
    const port = server.port;
    const cases: [string, Promise<HttpResult>, boolean][] = [
      ['page', request(port, '/', { headers: cookie(server) }), false],
      ['asset', request(port, '/app.js', { headers: cookie(server) }), false],
      ['api', get(server, '/api/board'), true],
      ['api error', get(server, '/api/nope'), true],
      ['401 api', request(port, '/api/board'), true],
      ['401 page', request(port, '/'), false],
      ['403', request(port, '/api/board', { headers: bearer(server), host: 'evil.example' }), true],
      ['404 page', request(port, '/nope.js', { headers: cookie(server) }), false],
      ['405', request(port, '/api/board', { method: 'POST', headers: bearer(server) }), true],
      ['303', request(port, `/?token=${server.token}`), false],
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
      const page = await request(server.port, '/', { method, headers: cookie(server) });
      expect(page.status, method).toBe(405);
      expect(page.headers.allow).toBe('GET');
    }
    expectText(await request(server.port, '/', { method: 'POST', headers: cookie(server) }), 405);
    expect(eventNames(eventsDir)).toEqual(before);
  });
});

describe('assets', () => {
  it('serves the files of the assets directory with their content types', async () => {
    const { server } = await served();
    const js = await request(server.port, '/app.js', { headers: cookie(server) });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toBe(ASSETS['app.js']);
    const css = await request(server.port, '/app.css', { headers: bearer(server) });
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body).toBe(ASSETS['app.css']);
    const html = await request(server.port, '/index.html', { headers: bearer(server) });
    expect(html.status).toBe(200);
    expect(html.body).toBe(ASSETS['index.html']);
  });

  it('serves nothing outside the assets directory, no hidden file and no subdirectory', async () => {
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
    writeFileSync(join(base, `secret-${String(process.pid)}.txt`), 'the secret');
    const server = await serve(board, { assetsDir: assets });
    const paths = [
      '/.hidden',
      '/sub/x.js',
      '/sub',
      `/../secret-${String(process.pid)}.txt`,
      `/..%2Fsecret-${String(process.pid)}.txt`,
      `/%2e%2e/secret-${String(process.pid)}.txt`,
      `/%2E%2E%2Fsecret-${String(process.pid)}.txt`,
      '/..%5c..%5ccache.sqlite',
      `/${encodeURIComponent(join(boardDir, 'cache.sqlite'))}`,
      '/missing.js',
      '/app.js%00.css',
    ];
    for (const path of paths) {
      const result = await request(server.port, path, { headers: cookie(server) });
      expect(result.status, path).toBe(404);
      expect(result.headers['content-type'], path).toBe('text/plain; charset=utf-8');
      expect(result.body, path).not.toContain('hidden');
      expect(result.body, path).not.toContain('nested');
      expect(result.body, path).not.toContain('the secret');
      expect(result.body, path).not.toContain('SQLite');
    }
  });

  it('serves the placeholder page on / when the assets are not built', async () => {
    expect(PLACEHOLDER_PAGE).toContain('dist/web');
    expect(PLACEHOLDER_PAGE).toContain('npm run build');
    expect(PLACEHOLDER_PAGE).toMatch(/^<!doctype html>/i);
    expect(PLACEHOLDER_PAGE).not.toMatch(/<script|<link|<style|https?:\/\//i);
    const { board } = await served();
    const server = await serve(board, { assetsDir: scratch() });
    const page = await request(server.port, '/', { headers: cookie(server) });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toBe(PLACEHOLDER_PAGE);
    expect((await request(server.port, '/app.js', { headers: cookie(server) })).status).toBe(404);
    // The API works without assets.
    expect((await get(server, '/api/session')).status).toBe(200);
    // And so does a directory that does not exist at all.
    const missing = await serve(board, { assetsDir: join(scratch(), 'no-such-dir') });
    expect((await request(missing.port, '/', { headers: cookie(missing) })).body).toBe(
      PLACEHOLDER_PAGE,
    );
  });

  it('answers an unknown page path with a plain text 404', async () => {
    const { server } = await served();
    expectText(await request(server.port, '/nope', { headers: cookie(server) }), 404);
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
  it('appears in no response body and in no header but the Set-Cookie of the 303', async () => {
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
    await add('303', request(port, `/?token=${t}`));
    await add('page', request(port, '/', { headers: cookie(server) }));
    await add('asset', request(port, '/app.js', { headers: cookie(server) }));
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
    await add('401 page', request(port, `/app.js?token=${t}`));
    await add(
      '403',
      request(port, '/api/board', { headers: bearer(server), host: 'evil.example' }),
    );
    await add('405', request(port, '/api/board', { method: 'POST', headers: bearer(server) }));
    for (const [name, result] of responses) {
      expect(result.body, name).not.toContain(t);
      for (const [header, value] of Object.entries(result.headers)) {
        if (name === '303' && header === 'set-cookie') {
          continue;
        }
        expect(JSON.stringify(value), `${name} ${header}`).not.toContain(t);
      }
    }
    const stream = await openStream(server);
    await stream.until((c) => c.events().length > 0, 3000, 'the first stream event');
    expect(stream.raw()).not.toContain(t);
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
