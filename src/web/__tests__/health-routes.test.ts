/**
 * `GET /api/health` and `GET /api/health/check` on a running server
 * (board-insights: "Health in the web app", scenarios "Late arrival shown
 * in health" and "Check is single-flight and cached"; board-web: "Access
 * token", "Host header check", "No cross-origin access and security
 * headers", "Read-only server"), with an
 * injected clock and an injected cache comparison the test counts and
 * completes by hand.
 */

import { describe, expect, it } from 'vitest';

import type { Board } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { checkCache } from '../../store/rebuild.js';
import { P, T1, ev, putEvent } from '../../store/__tests__/helpers.js';
import type { HealthCheck, LateArrival } from '../../view/health.js';
import type { CacheCheckOutcome } from '../health.js';
import type { ServerOptions } from '../server.js';
import {
  expectSecurityHeaders,
  get,
  json,
  open,
  openStream,
  pause,
  project,
  request,
  serve,
  served,
  until,
} from './web-helpers.js';

const NOW = 1_800_000_000_000;
const FAST: ServerOptions = { feed: { pollMs: 50 } };

interface HealthBody {
  late: LateArrival[];
  check: HealthCheck | null;
}

/** A comparison counted and completed by hand. */
function manualCheck(): {
  checkCache: (board: Board) => Promise<CacheCheckOutcome>;
  runs: () => number;
  resolve: (outcome: CacheCheckOutcome) => void;
} {
  let runs = 0;
  let settle: ((o: CacheCheckOutcome) => void) | null = null;
  return {
    checkCache: () => {
      runs += 1;
      return new Promise<CacheCheckOutcome>((resolve) => {
        settle = resolve;
      });
    },
    runs: () => runs,
    resolve: (outcome) => {
      settle?.(outcome);
    },
  };
}

/** A counting wrapper around the store's own comparison. */
function countingCheck(): { checkCache: (board: Board) => CacheCheckOutcome; runs: () => number } {
  let runs = 0;
  return {
    checkCache: (board) => {
      runs += 1;
      return checkCache(board);
    },
    runs: () => runs,
  };
}

async function health(server: { port: number; token: string }): Promise<HealthBody> {
  const res = await get(server, '/api/health');
  expect(res.status).toBe(200);
  return json(res) as HealthBody;
}

describe('access to the health routes', () => {
  it('refuses both routes without the bearer token (401) and never runs the check', async () => {
    const counting = countingCheck();
    const { server } = await served({ checkCache: counting.checkCache });
    for (const path of ['/api/health', '/api/health/check']) {
      const res = await request(server.port, path);
      expect(res.status, path).toBe(401);
      expect((json(res) as { error: { reason: string } }).error.reason).toBe('unauthorized');
      expectSecurityHeaders(res.headers, true);
      const wrong = await request(server.port, path, {
        headers: { Authorization: `Bearer ${server.token.slice(0, -1)}x` },
      });
      expect(wrong.status, path).toBe(401);
      const query = await request(server.port, `${path}?token=${server.token}`);
      expect(query.status, path).toBe(401);
    }
    expect(counting.runs()).toBe(0);
  });

  it('refuses both routes with a foreign Host (403), even with a valid token', async () => {
    const counting = countingCheck();
    const { server } = await served({ checkCache: counting.checkCache });
    for (const path of ['/api/health', '/api/health/check']) {
      const res = await request(server.port, path, {
        host: `attacker.example:${String(server.port)}`,
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(res.status, path).toBe(403);
      expect((json(res) as { error: { reason: string } }).error.reason).toBe('forbidden-host');
      expect(res.body).not.toContain('late');
      expectSecurityHeaders(res.headers, true);
    }
    expect(counting.runs()).toBe(0);
  });

  it('refuses POST with 405 and does not run the check', async () => {
    const counting = countingCheck();
    const { server } = await served({ checkCache: counting.checkCache });
    const res = await request(server.port, '/api/health/check', {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect(counting.runs()).toBe(0);
  });

  it('answers other paths under /api/health/ with 404 not-found', async () => {
    const { server } = await served();
    const res = await get(server, '/api/health/nope');
    expect(res.status).toBe(404);
    expect((json(res) as { error: { reason: string } }).error.reason).toBe('not-found');
  });
});

describe('GET /api/health', () => {
  it('answers {late: [], check: null} on a fresh server, with the API headers', async () => {
    const { server } = await served({ now: () => NOW });
    const res = await get(server, '/api/health');
    expect(res.status).toBe(200);
    expectSecurityHeaders(res.headers, true);
    expect(json(res)).toEqual({ late: [], check: null });
  });

  it('scenario: Late arrival shown in health, with the time the server observed it', async () => {
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'Early'), 'orch', 1000));
    putEvent(dirs.eventsDir, ev(P.comment(T1, 'head'), 'orch', 2000));
    let now = NOW;
    const server = await serve(open(dirs.boardDir), { ...FAST, now: () => now });
    // The feed has delivered the board; nothing is late yet.
    await pause(150);
    expect((await health(server)).late).toEqual([]);
    now = NOW + 5000;
    const late = putEvent(dirs.eventsDir, ev(P.comment(T1, 'from sync'), 'remote', 1500));
    let body: HealthBody = { late: [], check: null };
    const deadline = Date.now() + 3000;
    while (body.late.length === 0 && Date.now() < deadline) {
      body = await health(server);
      await pause(20);
    }
    expect(body.late).toEqual([
      { hash: late, kind: 'ticket.comment', ticket: T1, type: 'late', observedAt: NOW + 5000 },
    ]);
    expect(body.check).toBeNull();
  });

  it('lists an event that stopped being effective as removed, with its kind and ticket, newest first', async () => {
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'Contested'), 'orch', 1000));
    const second = putEvent(dirs.eventsDir, ev(P.claim(T1), 'impl-2', 2000));
    const server = await serve(open(dirs.boardDir), { ...FAST, now: () => NOW });
    await pause(150);
    // An earlier claim synced late wins; the delivered claim is now rejected.
    const first = putEvent(dirs.eventsDir, ev(P.claim(T1), 'impl-1', 1500));
    let body: HealthBody = { late: [], check: null };
    const deadline = Date.now() + 3000;
    while (body.late.length < 2 && Date.now() < deadline) {
      body = await health(server);
      await pause(20);
    }
    expect(body.late).toEqual([
      { hash: second, kind: 'ticket.claim', ticket: T1, type: 'removed', observedAt: NOW },
      { hash: first, kind: 'ticket.claim', ticket: T1, type: 'late', observedAt: NOW },
    ]);
  });

  it('does not count a stream joiner with an unknown position as an observation', async () => {
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'One'), 'orch', 1000));
    const server = await serve(open(dirs.boardDir), FAST);
    const client = await openStream(server, { headers: { 'Last-Event-ID': 'garbage' } });
    await client.until((c) => c.events().length >= 1, 3000, 'the resync');
    expect(client.events()[0]?.event).toBe('resync');
    expect((await health(server)).late).toEqual([]);
  });
});

describe('the cache check', () => {
  it('never runs without a request: not at start, not for /api/health, the board or a stream', async () => {
    const counting = countingCheck();
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'One'), 'orch', 1000));
    const server = await serve(open(dirs.boardDir), {
      ...FAST,
      now: () => NOW,
      checkCache: counting.checkCache,
    });
    const client = await openStream(server);
    await client.until((c) => c.events().length >= 1, 3000, 'the first append');
    for (const path of [
      '/api/health',
      '/api/board',
      '/api/session',
      '/api/events',
      '/api/actors',
    ]) {
      expect((await get(server, path)).status, path).toBe(200);
    }
    await pause(300);
    expect(counting.runs()).toBe(0);
    expect((await health(server)).check).toBeNull();

    const res = await get(server, '/api/health/check');
    expect(res.status).toBe(200);
    expectSecurityHeaders(res.headers, true);
    const result = json(res);
    expect(result).toEqual({ ranAt: NOW, matches: true, differingRows: 0 });
    expect(counting.runs()).toBe(1);
    expect((await health(server)).check).toEqual(result);
    expect(counting.runs()).toBe(1);
  });

  it('scenario: Check is single-flight and cached (two together, a third 10 seconds later)', async () => {
    let now = NOW;
    const manual = manualCheck();
    const { server } = await served({ now: () => now, checkCache: manual.checkCache });
    const a = get(server, '/api/health/check');
    const b = get(server, '/api/health/check');
    await until(() => manual.runs() === 1, 3000, 'the comparison to start');
    // Give the second request time to reach the server while the first runs.
    await pause(150);
    expect(manual.runs()).toBe(1);
    manual.resolve({ ok: true, differences: [] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const expected = { ranAt: NOW, matches: true, differingRows: 0 };
    expect(json(ra)).toEqual(expected);
    expect(json(rb)).toEqual(expected);
    now = NOW + 10_000;
    const rc = await get(server, '/api/health/check');
    expect(json(rc)).toEqual(expected);
    expect(manual.runs()).toBe(1);
  });

  it('runs again once the result is 30 seconds old', async () => {
    let now = NOW;
    const counting = countingCheck();
    const { server } = await served({ now: () => now, checkCache: counting.checkCache });
    expect(json(await get(server, '/api/health/check'))).toMatchObject({ ranAt: NOW });
    now = NOW + 29_999;
    expect(json(await get(server, '/api/health/check'))).toMatchObject({ ranAt: NOW });
    expect(counting.runs()).toBe(1);
    now = NOW + 30_000;
    expect(json(await get(server, '/api/health/check'))).toMatchObject({ ranAt: NOW + 30_000 });
    expect(counting.runs()).toBe(2);
  });

  it('uses the store comparison by default and reports a matching cache', async () => {
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'One'), 'orch', 1000));
    putEvent(dirs.eventsDir, ev(P.comment(T1, 'two'), 'orch', 2000));
    const board = open(dirs.boardDir);
    const server = await serve(board, { now: () => NOW });
    // Let the board catch up through a read route first.
    expect((await get(server, '/api/board')).status).toBe(200);
    const res = await get(server, '/api/health/check');
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ranAt: NOW, matches: true, differingRows: 0 });
    expect(board.db.isTransaction).toBe(false);
  });

  it('reports differing rows', async () => {
    const { server } = await served({
      now: () => NOW,
      checkCache: () => ({
        ok: false,
        differences: [
          { table: 'tickets', key: T1, ticket: T1, live: null, rebuilt: {} },
          { table: 'meta', key: 'k', ticket: null, live: {}, rebuilt: null },
        ],
      }),
    });
    expect(json(await get(server, '/api/health/check'))).toEqual({
      ranAt: NOW,
      matches: false,
      differingRows: 2,
    });
  });

  it('answers a failed comparison with its error document, keeps nothing and retries next time', async () => {
    let fail = true;
    let runs = 0;
    const { server } = await served({
      now: () => NOW,
      checkCache: () => {
        runs += 1;
        if (fail) {
          throw new BoardError(5, 'busy', 'the board is busy');
        }
        return { ok: true, differences: [] };
      },
    });
    const res = await get(server, '/api/health/check');
    expect(res.status).toBe(500);
    expectSecurityHeaders(res.headers, true);
    const doc = json(res) as { error: { exitCode: number; reason: string } };
    expect(doc.error.exitCode).toBe(5);
    expect(doc.error.reason).toBe('busy');
    expect((await health(server)).check).toBeNull();
    fail = false;
    expect(json(await get(server, '/api/health/check'))).toEqual({
      ranAt: NOW,
      matches: true,
      differingRows: 0,
    });
    expect(runs).toBe(2);
  });

  it('never includes the token in a health response', async () => {
    const { server } = await served({ now: () => NOW });
    for (const path of ['/api/health', '/api/health/check']) {
      const res = await get(server, path);
      expect(res.body).not.toContain(server.token);
      expect(JSON.stringify(res.headers)).not.toContain(server.token);
    }
  });
});
