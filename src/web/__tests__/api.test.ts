/**
 * The JSON API over HTTP, in process (board-web: "JSON API", "Reads never
 * block writers"; add-board-web task 3.2): every route and every error,
 * the rejected-claim detail, paging 2500 events, `unknown-cursor`, a bad
 * `limit`, the catch-up of a read, and a check that no transaction is
 * open on the server's connection whenever a response body is written.
 *
 * Expected values are computed independently of the server: outcomes and
 * state by the group 1 `fold` over the event files (`foldDir`), fold order
 * by `compareFoldOrder`, the digest by XOR with `Buffer`.
 */

import { ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEventCache, EMPTY_POSITION_ID, type EventCache } from '../../board/feed.js';
import { compareFoldOrder, type FoldInput, type Ticket } from '../../events/fold.js';
import { renderHint } from '../../guidance/hints.js';
import { readEventFile } from '../../store/eventfile.js';
import { BoardError } from '../../store/errors.js';
import {
  MISSING,
  P,
  T1,
  T2,
  T3,
  ev,
  eventNames,
  foldDir,
  putEvent,
  seedRich,
} from '../../store/__tests__/helpers.js';
import { VERSION } from '../../version.js';
import { agentLanes } from '../../view/lanes.js';
import type { EventView } from '../../view/types.js';
import {
  API_HINT_CONTEXT,
  EVENTS_PAGE_DEFAULT,
  EVENTS_PAGE_MAX,
  apiResponse,
  httpStatus,
} from '../api.js';
import { get, json, open, openStream, project, serve, type HttpResult } from './web-helpers.js';

const SERVE = { surface: 'cli', command: 'serve' } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Asserts an `ErrorDocument` response with the CLI hint of `reason`. */
function expectError(result: HttpResult, status: number, exitCode: number, reason: string): void {
  expect(result.status).toBe(status);
  expect(json(result)).toEqual({
    error: {
      exitCode,
      reason,
      message: expect.any(String) as unknown,
      hint: renderHint(reason, SERVE),
    },
  });
}

/** Every well-formed event file of `eventsDir` as a view with its outcome, in fold order. */
function views(eventsDir: string): EventView[] {
  const result = foldDir(eventsDir);
  const rejected = new Map(result.rejected.map((r) => [r.hash, r.reason]));
  const unknown = new Set(result.unknown.map((u) => u.hash));
  const inputs: FoldInput[] = [];
  for (const name of eventNames(eventsDir)) {
    const outcome = readEventFile(eventsDir, name);
    if (outcome.status === 'ok') {
      inputs.push(outcome.input as FoldInput);
    }
  }
  return inputs.sort(compareFoldOrder).map(({ hash, event }) => {
    const reason = rejected.get(hash) ?? null;
    return {
      hash,
      kind: event.kind,
      ticket: 'ticket' in event && typeof event.ticket === 'string' ? event.ticket : null,
      actor: event.actor,
      ts: event.ts,
      outcome: unknown.has(hash) ? 'unknown' : reason === null ? 'applied' : 'rejected',
      reason,
      event,
    };
  });
}

/** XOR of the hex hashes. */
function xorHex(hashes: readonly string[]): string {
  const acc = Buffer.alloc(32);
  for (const hash of hashes) {
    const bytes = Buffer.from(hash, 'hex');
    for (let i = 0; i < 32; i += 1) {
      acc[i] = (acc[i] ?? 0) ^ (bytes[i] ?? 0);
    }
  }
  return acc.toString('hex');
}

/** The position id of every applied event of `eventsDir`. */
function positionOf(eventsDir: string): string {
  const applied = views(eventsDir).filter((e) => e.outcome === 'applied');
  const head = applied.at(-1);
  return head === undefined
    ? EMPTY_POSITION_ID
    : `${head.hash}.${xorHex(applied.map((e) => e.hash))}`;
}

/** JSON round trip. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A board seeded by `seed` (writing event files directly), opened, with a server. */
async function seeded(seed: (eventsDir: string) => void, now?: () => number) {
  const dirs = project();
  seed(dirs.eventsDir);
  const board = open(dirs.boardDir);
  const server = await serve(board, now === undefined ? {} : { now });
  return { ...dirs, board, server };
}

// Two tickets whose ids share a 6-character prefix, for ambiguous-id.
const TWIN_A = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const TWIN_B = '01ARYZ6S41TSV4RRFFQ69G5FAW';

describe('/api/session', () => {
  it('gives the version, the board directory, writable false and actor null', async () => {
    const { server, board } = await seeded(() => undefined);
    const result = await get(server, '/api/session');
    expect(result.status).toBe(200);
    expect(json(result)).toEqual({
      version: VERSION,
      boardDir: board.dir,
      writable: false,
      actor: null,
    });
  });

  // add-board-web-actions task 1.1 (board-web: "JSON API" as modified).
  it('gives writable true and the actor of a writable context, and no other key', () => {
    const board = open(project().boardDir);
    const base = { board, cache: createEventCache(), now: () => 0 };
    const writable = apiResponse({ ...base, actor: 'ben' }, '/api/session', new URLSearchParams());
    expect(writable.status).toBe(200);
    expect(Object.keys(writable.body as object)).toEqual([
      'version',
      'boardDir',
      'writable',
      'actor',
    ]);
    expect(writable.body).toEqual({
      version: VERSION,
      boardDir: board.dir,
      writable: true,
      actor: 'ben',
    });
    for (const actor of [undefined, null, '']) {
      const ctx = actor === undefined ? base : { ...base, actor };
      expect(apiResponse(ctx, '/api/session', new URLSearchParams()).body, String(actor)).toEqual({
        version: VERSION,
        boardDir: board.dir,
        writable: false,
        actor: null,
      });
    }
  });
});

describe('/api/board', () => {
  it('gives every ticket (open and closed, by id), the meta and the position id', async () => {
    const { server, eventsDir } = await seeded((dir) => seedRich(dir));
    const result = await get(server, '/api/board');
    expect(result.status).toBe(200);
    const body = json(result) as { tickets: Ticket[]; meta: unknown; id: string };
    expect(Object.keys(body).sort()).toEqual(['id', 'meta', 'tickets']);
    const state = foldDir(eventsDir).state;
    const tickets = Object.values(state.tickets).sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(tickets.some((t) => t.closed)).toBe(true);
    expect(body.tickets).toEqual(plain(tickets));
    expect(body.meta).toEqual(plain(state.meta));
    expect(body.id).toBe(positionOf(eventsDir));
  });

  it('gives an empty board as no ticket, empty meta and the empty position id', async () => {
    const { server } = await seeded(() => undefined);
    expect(json(await get(server, '/api/board'))).toEqual({
      tickets: [],
      meta: {},
      id: EMPTY_POSITION_ID,
    });
  });

  it('catches up first: an event file written after start-up is in the next response', async () => {
    const { server, eventsDir } = await seeded((dir) => {
      putEvent(dir, ev(P.create(T1, 'One'), 'orch', 1000));
    });
    putEvent(eventsDir, ev(P.comment(T1, 'written by another process'), 'other', 2000));
    const body = json(await get(server, '/api/board')) as { tickets: Ticket[]; id: string };
    expect(body.tickets[0]?.comments.map((c) => c.text)).toEqual(['written by another process']);
    expect(body.id).toBe(positionOf(eventsDir));
  });
});

describe('/api/tickets/<id>', () => {
  it('scenario: ticket detail includes a rejected claim, both claims in fold order', async () => {
    const { server, eventsDir } = await seeded((dir) => {
      putEvent(dir, ev(P.create(T1, 'Contested'), 'orch', 1000));
      putEvent(dir, ev(P.claim(T1), 'a', 2000));
      putEvent(dir, ev(P.claim(T1), 'b', 3000));
      putEvent(dir, ev(P.create(T2, 'Other'), 'orch', 4000));
    });
    const result = await get(server, `/api/tickets/${T1.slice(0, 8)}`);
    expect(result.status).toBe(200);
    const body = json(result) as { ticket: Ticket; events: EventView[] };
    expect(Object.keys(body).sort()).toEqual(['events', 'ticket']);
    expect(body.ticket).toEqual(plain(foldDir(eventsDir).state.tickets[T1]));
    const claims = body.events.filter((e) => e.kind === 'ticket.claim');
    expect(claims.map((e) => [e.actor, e.outcome, e.reason])).toEqual([
      ['a', 'applied', null],
      ['b', 'rejected', 'already-assigned'],
    ]);
    expect(body.events).toEqual(plain(views(eventsDir).filter((e) => e.ticket === T1)));
  });

  it('lists applied, rejected and unknown-kind events of the ticket, by full id too', async () => {
    const { server, eventsDir } = await seeded((dir) => seedRich(dir));
    const body = json(await get(server, `/api/tickets/${T1}`)) as { events: EventView[] };
    const want = views(eventsDir).filter((e) => e.ticket === T1);
    expect(new Set(want.map((e) => e.outcome))).toEqual(
      new Set(['applied', 'rejected', 'unknown']),
    );
    expect(body.events).toEqual(plain(want));
  });

  it('refuses as show refuses: id-too-short and ambiguous-id 400, unknown-ticket 404', async () => {
    const { server } = await seeded((dir) => {
      putEvent(dir, ev(P.create(TWIN_A, 'A'), 'orch', 1000));
      putEvent(dir, ev(P.create(TWIN_B, 'B'), 'orch', 2000));
    });
    expectError(await get(server, '/api/tickets/01ARY'), 400, 1, 'id-too-short');
    expectError(await get(server, '/api/tickets/01ARYZ6S'), 400, 1, 'ambiguous-id');
    expectError(await get(server, `/api/tickets/${MISSING}`), 404, 4, 'unknown-ticket');
    expect((await get(server, `/api/tickets/${TWIN_B}`)).status).toBe(200);
  });

  it('answers an empty id or extra segments with 404 not-found', async () => {
    const { server } = await seeded((dir) => {
      putEvent(dir, ev(P.create(T1, 'One'), 'orch', 1000));
    });
    expectError(await get(server, '/api/tickets/'), 404, 1, 'not-found');
    expectError(await get(server, '/api/tickets'), 404, 1, 'not-found');
    expectError(await get(server, `/api/tickets/${T1}/events`), 404, 1, 'not-found');
  });
});

/** 2500 well-formed events: a create, a rejected duplicate create, an unknown kind and comments. */
function seed2500(dir: string): void {
  putEvent(dir, ev(P.create(T1, 'Busy ticket'), 'orch', 1000));
  putEvent(dir, ev(P.create(T1, 'Duplicate'), 'orch', 1001));
  putEvent(dir, {
    v: 1,
    kind: 'ticket.estimate',
    ticket: T1,
    actor: 'orch',
    ts: { wall: 1002, counter: 0, actor: 'orch' },
    body: { points: 5 },
  });
  // Written out of order, with shared walls, so fold order is not file order.
  for (let n = 2496; n >= 0; n -= 1) {
    const wall = 2000 + Math.floor(n / 3);
    putEvent(dir, ev(P.comment(T1, `comment ${String(n)}`), `agent-${String(n % 7)}`, wall, n % 3));
  }
}

describe('/api/events', () => {
  it(
    'scenario: pages 2500 events as 1000, 1000 and 500 in fold order, next null on the last page',
    { timeout: 60_000 },
    async () => {
      const { server, eventsDir } = await seeded(seed2500);
      const want = views(eventsDir);
      expect(want).toHaveLength(2500);
      expect(new Set(want.map((e) => e.outcome))).toEqual(
        new Set(['applied', 'rejected', 'unknown']),
      );
      expect(EVENTS_PAGE_DEFAULT).toBe(1000);
      expect(EVENTS_PAGE_MAX).toBe(5000);
      const pages: { events: EventView[]; next: string | null }[] = [];
      let path = '/api/events';
      for (;;) {
        const result = await get(server, path);
        expect(result.status).toBe(200);
        const page = json(result) as { events: EventView[]; next: string | null };
        expect(Object.keys(page).sort()).toEqual(['events', 'next']);
        pages.push(page);
        if (page.next === null) {
          break;
        }
        expect(pages.length).toBeLessThan(4);
        path = `/api/events?after=${page.next}`;
      }
      expect(pages.map((p) => p.events.length)).toEqual([1000, 1000, 500]);
      expect(pages.map((p) => p.next)).toEqual([want[999]?.hash, want[1999]?.hash, null]);
      expect(pages.flatMap((p) => p.events)).toEqual(plain(want));
    },
  );

  it(
    'gives next null on a page that ends exactly at the last event',
    { timeout: 60_000 },
    async () => {
      const { server, eventsDir } = await seeded(seed2500);
      const want = views(eventsDir);
      const all = json(await get(server, '/api/events?limit=2500')) as {
        events: EventView[];
        next: string | null;
      };
      expect(all.events).toHaveLength(2500);
      expect(all.next).toBeNull();
      const max = json(await get(server, '/api/events?limit=5000')) as { events: EventView[] };
      expect(max.events).toHaveLength(2500);
      const last = json(await get(server, `/api/events?after=${want[2499]?.hash ?? ''}&limit=1`));
      expect(last).toEqual({ events: [], next: null });
      const tail = json(await get(server, `/api/events?after=${want[2497]?.hash ?? ''}&limit=1`));
      expect(tail).toEqual({ events: plain([want[2498]]), next: want[2498]?.hash });
    },
  );

  it('accepts a rejected or unknown-kind event as after (both are recorded well-formed events)', async () => {
    const { server, eventsDir } = await seeded((dir) => seedRich(dir));
    const want = views(eventsDir);
    for (const outcome of ['rejected', 'unknown'] as const) {
      const index = want.findIndex((e) => e.outcome === outcome);
      const page = json(await get(server, `/api/events?after=${want[index]?.hash ?? ''}`)) as {
        events: EventView[];
      };
      expect(page.events).toEqual(plain(want.slice(index + 1)));
    }
  });

  it('answers an after that is not a recorded event with 400 unknown-cursor', async () => {
    const { server } = await seeded((dir) => seedRich(dir));
    for (const after of ['f'.repeat(64), 'nope', '', T1]) {
      expectError(await get(server, `/api/events?after=${after}`), 400, 1, 'unknown-cursor');
    }
    const hint = renderHint('unknown-cursor', SERVE) ?? '';
    expect(hint).toContain('after');
  });

  it('answers a bad limit with 400 usage', async () => {
    const { server } = await seeded((dir) => seedRich(dir));
    for (const limit of [
      '0',
      '-1',
      '5001',
      'abc',
      '1.5',
      '',
      '+5',
      '%205',
      '1e3',
      '0x10',
      '99999999999999999999',
    ]) {
      expectError(await get(server, `/api/events?limit=${limit}`), 400, 1, 'usage');
    }
    expect((await get(server, '/api/events?limit=1')).status).toBe(200);
  });
});

describe('/api/actors', () => {
  it('gives the agent lanes of the board at the request time', async () => {
    const now = 1_000_000;
    const { server, eventsDir } = await seeded(
      (dir) => seedRich(dir),
      () => now,
    );
    const result = await get(server, '/api/actors');
    expect(result.status).toBe(200);
    const state = foldDir(eventsDir).state;
    const want = agentLanes({ tickets: state.tickets, events: views(eventsDir) }, now);
    expect(want.length).toBeGreaterThan(1);
    expect(json(result)).toEqual(plain(want));
  });
});

describe('unknown API paths', () => {
  it('answer 404 not-found as JSON with the hint', async () => {
    const { server } = await seeded(() => undefined);
    for (const path of [
      '/api',
      '/api/',
      '/api/nope',
      '/api/board/x',
      '/api/Board',
      '/api/session/',
    ]) {
      const result = await get(server, path);
      expectError(result, 404, 1, 'not-found');
    }
  });
});

describe('failures', () => {
  it('answers a read failure with 500 and its ErrorDocument, and the server keeps serving', async () => {
    const dirs = project();
    seedRich(dirs.eventsDir);
    const board = open(dirs.boardDir);
    let failing = true;
    const real = createEventCache();
    const cache: EventCache = {
      get(eventsDir, hash) {
        if (failing) {
          throw new Error('injected read failure');
        }
        return real.get(eventsDir, hash);
      },
      get size() {
        return real.size;
      },
    };
    const server = await serve(board, { cache });
    const result = await get(server, '/api/board');
    expect(result.status).toBe(500);
    expect(json(result)).toEqual({
      error: { exitCode: 5, reason: null, message: 'injected read failure', hint: null },
    });
    expect((await get(server, '/api/session')).status).toBe(200);
    failing = false;
    expect((await get(server, '/api/board')).status).toBe(200);
  });

  it.each([
    [new BoardError(1, 'unauthorized', 'x'), 401],
    [new BoardError(1, 'forbidden-host', 'x'), 403],
    [new BoardError(1, 'not-found', 'x'), 404],
    [new BoardError(4, 'unknown-ticket', 'x'), 404],
    [new BoardError(1, 'method-not-allowed', 'x'), 405],
    [new BoardError(1, 'too-many-streams', 'x'), 503],
    [new BoardError(1, 'usage', 'x'), 400],
    [new BoardError(1, 'unknown-cursor', 'x'), 400],
    [new BoardError(1, 'id-too-short', 'x'), 400],
    [new BoardError(1, 'ambiguous-id', 'x'), 400],
    [new BoardError(2, 'board-not-found', 'x'), 500],
    [new BoardError(5, 'busy', 'x'), 500],
    [new BoardError(5, 'integrity', 'x'), 500],
    [new Error('x'), 500],
    ['a string', 500],
  ])('httpStatus(%s) is %s', (error, status) => {
    expect(httpStatus(error)).toBe(status);
  });

  it('apiResponse never throws, even for a path it does not serve', () => {
    const board = open(project().boardDir);
    const ctx = { board, cache: createEventCache(), now: () => 0 };
    expect(API_HINT_CONTEXT).toEqual(SERVE);
    for (const path of ['/api/stream', '/api/%zz', '/api/tickets/a/b']) {
      const result = apiResponse(ctx, path, new URLSearchParams());
      expect(result.status, path).toBe(404);
      expect(result.body, path).toMatchObject({ error: { reason: 'not-found' } });
    }
    expect(
      apiResponse(ctx, '/api/tickets/%E0%A4%A', new URLSearchParams()).status,
    ).toBeGreaterThanOrEqual(400);
    expect(board.db.isTransaction).toBe(false);
  });
});

describe('reads never block writers', () => {
  it(
    'has no transaction open on the server connection whenever a response is written',
    { timeout: 30_000 },
    async () => {
      const { server, board } = await seeded((dir) => {
        putEvent(dir, ev(P.create(T1, 'One'), 'orch', 1000));
        putEvent(dir, ev(P.create(T3, 'Three'), 'orch', 1500));
        putEvent(dir, ev(P.claim(T1), 'a', 2000));
        putEvent(dir, ev(P.claim(T1), 'b', 3000));
      });
      const seen: boolean[] = [];
      const record = (): void => {
        seen.push(board.db.isTransaction);
      };
      const write = ServerResponse.prototype.write;
      const end = ServerResponse.prototype.end;
      vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<typeof write>
      ) {
        record();
        return write.apply(this, args);
      });
      vi.spyOn(ServerResponse.prototype, 'end').mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<typeof end>
      ) {
        record();
        return end.apply(this, args);
      });
      const paths = [
        '/api/session',
        '/api/board',
        `/api/tickets/${T1}`,
        '/api/tickets/01ARY',
        `/api/tickets/${MISSING}`,
        '/api/events',
        '/api/events?limit=1',
        '/api/events?after=nope',
        '/api/events?limit=0',
        '/api/actors',
        '/api/nope',
      ];
      for (const path of paths) {
        expect((await get(server, path)).status, path).toBeGreaterThan(0);
      }
      const stream = await openStream(server);
      await stream.until((c) => c.events().length > 0, 3000, 'the first stream event');
      stream.close();
      expect(seen.length).toBeGreaterThanOrEqual(paths.length + 1);
      expect(seen.every((open) => !open)).toBe(true);
    },
  );
});
