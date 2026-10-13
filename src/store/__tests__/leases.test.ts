/**
 * Lease, availability and queue state in the cache (add-claim-leases task
 * 1.4; board-cache: "Cache schema" and its scenarios "Lease survives a
 * rebuild", "Queue survives a rebuild" and "Old cache is rebuilt").
 *
 * Events are written as files (`putEvent`), as another process or a sync
 * leaves them, and grants are written out by hand from board-events
 * "Grants", so these tests depend on the fold only through the store.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import { encodeHlc } from '../../events/hlc.js';
import type { BoardEvent, TicketGrantBody } from '../../events/schema.js';
import { openBoard, type Board } from '../board.js';
import {
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  catchUp,
  dumpCache,
  readState,
  readTicket,
} from '../cache.js';
import { checkCache, rebuild } from '../rebuild.js';
import { P, T1, T2, canon, copyBoard, ev, foldDir, putEvent, tempBoard } from './helpers.js';

const open: Board[] = [];

/**
 * The clock every open and catch-up here runs at: before any slot time of
 * these boards, so catch-up writes no grant (grant materialisation is
 * tested in grant-catchup.test.ts) and each board holds exactly the events
 * a test writes.
 */
const NOW = 0;

function openB(dir: string): Board {
  const board = openBoard(dir, { now: NOW });
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

type Row = Record<string, unknown>;

/** The dump of a cache built from scratch over a copy of `eventsDir`. */
function freshDump(eventsDir: string): string {
  return dumpCache(openB(copyBoard(eventsDir)).db);
}

function ticketRow(board: Board, id = T1): Row {
  return board.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row;
}

function waiterRows(board: Board, id = T1): Row[] {
  return board.db
    .prepare('SELECT * FROM waiters WHERE ticket = ? ORDER BY position')
    .all(id) as Row[];
}

function folded(board: Board, hash: string): Row | undefined {
  return board.db.prepare('SELECT * FROM folded WHERE hash = ?').get(hash) as Row | undefined;
}

// Event builders. Each returns the full event; `putEvent` names it by hash.
const L = {
  leased(actor: string, wall: number, ttl: number, grace = 120_000, ticket = T1): BoardEvent {
    return ev(
      {
        kind: 'ticket.claim',
        ticket,
        body: { lease: { ttl, grace, expiresAt: wall + Math.min(ttl, grace) } },
      },
      actor,
      wall,
    );
  },
  renew(actor: string, wall: number, ttl: number, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.renew', ticket, body: { ttl, expiresAt: wall + ttl } }, actor, wall);
  },
  join(actor: string, wall: number, ttl: number, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.queue.join', ticket, body: { ttl } }, actor, wall);
  },
  leave(actor: string, wall: number, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.queue.leave', ticket, body: {} }, actor, wall);
  },
  release(actor: string, wall: number, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.release', ticket, body: {} }, actor, wall);
  },
  force(actor: string, wall: number, holder: string, ticket = T1): BoardEvent {
    return ev(
      { kind: 'ticket.release.force', ticket, body: { holder, reason: 'holder is gone' } },
      actor,
      wall,
    );
  },
  grant(wall: number, body: TicketGrantBody, ticket = T1): BoardEvent {
    return {
      v: 1,
      kind: 'ticket.grant',
      ticket,
      actor: 'agentboard',
      ts: { wall, counter: 0, actor: 'agentboard' },
      body,
    };
  },
};

/** Writes `events` as files and returns their hashes, in order. */
function put(eventsDir: string, ...events: BoardEvent[]): string[] {
  return events.map((e) => putEvent(eventsDir, e));
}

/**
 * A board exercising every new column: T1 with a waiting queue served by a
 * grant after a release (under a 300000 window), and T2 with a renewed
 * lease. Returns the board directory, its
 * events directory and the hashes by name.
 */
function seedLeases(): { dir: string; events: string; h: Record<string, string> } {
  const dir = tempBoard();
  const events = join(dir, 'events');
  const [create1, window, claim1, joinA, joinB, joinC, leaveB, rejoinB, release] = put(
    events,
    ev(P.create(T1, 'Merge lock'), 'orch', 1000),
    ev(P.meta('queue.window', 300_000), 'orch', 1500),
    ev(P.claim(T1), 'h', 2000),
    L.join('a', 3000, 600_000),
    L.join('b', 4000, 900_000),
    L.join('c', 5000, 1_200_000),
    L.leave('b', 6000),
    L.join('b', 7000, 300_000),
    L.release('h', 8000),
  );
  const [grant] = put(
    events,
    L.grant(8001, {
      to: 'a',
      ttl: 600_000,
      window: 300_000,
      after: { released: release as string },
    }),
  );
  const [create2, claim2, renew2] = put(
    events,
    ev(P.create(T2, 'Second lock'), 'orch', 1100),
    L.leased('k', 1_000_000, 1_800_000, 120_000, T2),
    L.renew('k', 1_060_000, 1_800_000, T2),
  );
  const h = {
    create1,
    window,
    claim1,
    joinA,
    joinB,
    joinC,
    leaveB,
    rejoinB,
    release,
    grant,
    create2,
    claim2,
    renew2,
  } as Record<string, string>;
  return { dir, events, h };
}

describe('lease and queue columns', () => {
  it('lease survives a rebuild (spec scenario)', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const [, claim, renew] = put(
      events,
      ev(P.create(T1), 'orch', 1000),
      L.leased('h', 1_000_000, 1_800_000),
      L.renew('h', 1_060_000, 1_800_000),
    );
    const board = openB(dir);
    rebuild(board);
    expect(ticketRow(board)).toMatchObject({
      assignee: 'h',
      lease_ttl: 1_800_000,
      lease_expires_at: 2_860_000,
      lease_event: renew,
      lease_confirmed: 1,
      available_at: 2_920_000,
      available_event: renew,
    });
    expect(claim).not.toBe(renew);
    expect(readTicket(board.db, T1)?.lease).toEqual({
      ttl: 1_800_000,
      expiresAt: 2_860_000,
      event: renew,
      confirmed: true,
    });
    expect(checkCache(board)).toMatchObject({ ok: true, differences: [] });
  });

  it('queue survives a rebuild (spec scenario)', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const joins = [L.join('a', 3000, 600_000), L.join('c', 5000, 1_200_000)];
    const rejoin = L.join('b', 7000, 300_000);
    put(
      events,
      ev(P.create(T1), 'orch', 1000),
      ev(P.claim(T1), 'h', 2000),
      joins[0] as BoardEvent,
      L.join('b', 4000, 900_000),
      joins[1] as BoardEvent,
      L.leave('b', 6000),
      rejoin,
    );
    const board = openB(dir);
    rebuild(board);
    expect(waiterRows(board)).toEqual(
      [...joins, rejoin].map((join, position) => ({
        ticket: T1,
        position,
        actor: join.actor,
        ttl: join.kind === 'ticket.queue.join' ? join.body.ttl : null,
        hash: canonicalHash(join),
        ts: encodeHlc(join.ts),
      })),
    );
    expect(readTicket(board.db, T1)?.queue.map((w) => w.actor)).toEqual(['a', 'c', 'b']);
    expect(checkCache(board)).toMatchObject({ ok: true, differences: [] });
  });

  it('stores a ticket without a lease as nulls, and an unconfirmed lease as 0', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const [, , claim] = put(
      events,
      ev(P.create(T1), 'orch', 1000),
      ev(P.create(T2, 'Second'), 'orch', 1100),
      L.leased('h', 1_000_000, 60_000, 120_000, T2),
    );
    const board = openB(dir);
    expect(ticketRow(board, T1)).toMatchObject({
      assignee: null,
      lease_ttl: null,
      lease_expires_at: null,
      lease_event: null,
      lease_confirmed: null,
      available_at: null,
      available_event: null,
    });
    expect(ticketRow(board, T2)).toMatchObject({
      assignee: 'h',
      lease_ttl: 60_000,
      lease_expires_at: 1_060_000,
      lease_event: claim,
      lease_confirmed: 0,
      available_at: 1_120_000,
      available_event: claim,
    });
    expect(waiterRows(board, T1)).toEqual([]);
  });

  it('stores the release that freed a ticket as its availability', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const [, , release] = put(
      events,
      ev(P.create(T1), 'orch', 1000),
      L.leased('h', 2000, 60_000),
      L.release('h', 3000),
    );
    const board = openB(dir);
    expect(ticketRow(board)).toMatchObject({
      assignee: null,
      lease_ttl: null,
      available_at: 3000,
      available_event: release,
    });
  });

  it('enforces the foreign key from waiters to tickets', () => {
    const board = openB(tempBoard());
    expect(() =>
      board.db
        .prepare(
          "INSERT INTO waiters (ticket, position, actor, ttl, hash, ts) VALUES ('nope', 0, 'a', 30000, 'h', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('readTicket and readState reconstruct the folded lease, queue and availability', () => {
    const { dir, events, h } = seedLeases();
    const board = openB(dir);
    const expected = foldDir(events).state;
    expect(readTicket(board.db, T1)).toEqual(expected.tickets[T1]);
    expect(readTicket(board.db, T2)).toEqual(expected.tickets[T2]);
    expect(canon(readState(board.db))).toBe(canon(expected));
    // The seed is what it says: a grant applied after the release, under the window setting.
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: 'a',
      lease: { ttl: 600_000, expiresAt: 308_001, event: h.grant, confirmed: false },
      available: { at: 368_001, event: h.grant },
    });
    expect(readTicket(board.db, T1)?.queue.map((w) => [w.actor, w.event])).toEqual([
      ['c', h.joinC],
      ['b', h.rejoinB],
    ]);
    expect(folded(board, h.grant ?? '')).toMatchObject({ folded: 1, reason: null });
  });
});

describe('rebuild and rebuild --check with leases and queues', () => {
  it('rebuild twice gives byte-identical dumps, equal to the incremental cache and another clone', () => {
    const { dir, events } = seedLeases();
    const board = openB(dir);
    const incremental = dumpCache(board.db);
    rebuild(board);
    const first = dumpCache(board.db);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(first);
    expect(first).toBe(incremental);
    expect(first).toBe(freshDump(events));
    expect(JSON.parse(first)).toHaveProperty('waiters');
  });

  it('rebuild --check detects a hand-edited lease_expires_at', () => {
    const { dir } = seedLeases();
    const board = openB(dir);
    board.db
      .prepare('UPDATE tickets SET lease_expires_at = lease_expires_at + 1 WHERE id = ?')
      .run(T2);
    const result = checkCache(board);
    expect(result.ok).toBe(false);
    expect(
      result.differences.map((d) => [
        d.table,
        d.key,
        d.ticket,
        d.live?.lease_expires_at,
        d.rebuilt?.lease_expires_at,
      ]),
    ).toEqual([['tickets', T2, T2, 2_860_001, 2_860_000]]);
  });

  it('rebuild --check detects a reordered waiters row', () => {
    const { dir } = seedLeases();
    const board = openB(dir);
    const [first, second] = waiterRows(board);
    const swap = board.db.prepare(
      'UPDATE waiters SET actor = ?, ttl = ?, hash = ?, ts = ? WHERE ticket = ? AND position = ?',
    );
    swap.run(
      String(second?.actor),
      Number(second?.ttl),
      String(second?.hash),
      String(second?.ts),
      T1,
      0,
    );
    swap.run(
      String(first?.actor),
      Number(first?.ttl),
      String(first?.hash),
      String(first?.ts),
      T1,
      1,
    );
    const result = checkCache(board);
    expect(result.ok).toBe(false);
    expect(result.differences.map((d) => [d.table, d.key, d.ticket])).toEqual([
      ['waiters', `${T1}#0`, T1],
      ['waiters', `${T1}#1`, T1],
    ]);
    expect(result.differences[0]?.live?.actor).toBe('b');
    expect(result.differences[0]?.rebuilt?.actor).toBe('c');
  });

  it('rebuild --check detects a waiters row missing or added', () => {
    const { dir } = seedLeases();
    const board = openB(dir);
    board.db.prepare('DELETE FROM waiters WHERE ticket = ? AND position = 1').run(T1);
    board.db
      .prepare(
        "INSERT INTO waiters (ticket, position, actor, ttl, hash, ts) VALUES (?, 5, 'z', 30000, 'x', 'y')",
      )
      .run(T1);
    const result = checkCache(board);
    expect(
      result.differences.map((d) => [d.table, d.key, d.live === null, d.rebuilt === null]),
    ).toEqual([
      ['waiters', `${T1}#1`, true, false],
      ['waiters', `${T1}#5`, false, true],
    ]);
  });

  it('rebuild repairs hand-edited lease and waiters rows', () => {
    const { dir } = seedLeases();
    const board = openB(dir);
    const good = dumpCache(board.db);
    board.db.prepare('UPDATE tickets SET lease_confirmed = 0, available_at = 1').run();
    board.db.prepare('DELETE FROM waiters').run();
    rebuild(board);
    expect(dumpCache(board.db)).toBe(good);
  });
});

describe('old cache is rebuilt (spec scenario)', () => {
  /** The cache schema written by versions without leases (schema version 1). */
  const V1_SCHEMA = `
CREATE TABLE tickets (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL,
  blocked_from TEXT, assignee TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, task_source TEXT, task_ref TEXT,
  task_item TEXT, adhoc TEXT, labels TEXT NOT NULL, closed INTEGER NOT NULL, decision TEXT,
  checklist TEXT NOT NULL
);
CREATE TABLE comments (
  ticket TEXT NOT NULL REFERENCES tickets(id), seq INTEGER NOT NULL, actor TEXT NOT NULL,
  ts TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (ticket, seq)
);
CREATE TABLE links (
  ticket TEXT NOT NULL REFERENCES tickets(id), seq INTEGER NOT NULL, kind TEXT NOT NULL,
  value TEXT NOT NULL, actor TEXT NOT NULL, ts TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (ticket, seq)
);
CREATE TABLE cursors (
  actor TEXT PRIMARY KEY, last_wall INTEGER, last_counter INTEGER, last_actor TEXT,
  last_hash TEXT
);
CREATE TABLE cursor_seen (
  actor TEXT NOT NULL, hash TEXT NOT NULL, wall INTEGER NOT NULL, PRIMARY KEY (actor, hash)
);
CREATE TABLE folded (hash TEXT PRIMARY KEY, folded INTEGER NOT NULL, reason TEXT, position TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('last_position', 'null');
`;

  it('rebuilds a version 1 cache from the events before the command proceeds', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const [create, claim, renew] = put(
      events,
      ev(P.create(T1), 'orch', 1000),
      L.leased('h', 1_000_000, 1_800_000),
      L.renew('h', 1_060_000, 1_800_000),
      L.join('a', 1_070_000, 600_000),
    );
    // A version 1 cache, as an older agentboard left it: it recorded the
    // leased claim as malformed, and holds a cursor.
    const old = new DatabaseSync(join(dir, CACHE_FILE));
    old.exec(V1_SCHEMA);
    old
      .prepare(
        "INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES ('a', 1000, 0, 'orch', ?)",
      )
      .run(create ?? '');
    old
      .prepare("INSERT INTO cursor_seen (actor, hash, wall) VALUES ('a', ?, 1000)")
      .run(create ?? '');
    old
      .prepare(
        "INSERT INTO folded (hash, folded, reason, position) VALUES (?, 0, 'malformed', NULL)",
      )
      .run(claim ?? '');
    old.close();

    const board = openB(dir);
    expect(board.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(CACHE_SCHEMA_VERSION),
    });
    expect(CACHE_SCHEMA_VERSION).toBe(4);
    // Cursors are dropped: entries may be delivered again, none is skipped.
    expect(board.db.prepare('SELECT * FROM cursors').all()).toEqual([]);
    expect(board.db.prepare('SELECT * FROM cursor_seen').all()).toEqual([]);
    // The leased claim it had recorded as malformed is folded now.
    expect(folded(board, claim ?? '')).toMatchObject({ folded: 1, reason: null });
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: 'h',
      lease: { ttl: 1_800_000, expiresAt: 2_860_000, event: renew, confirmed: true },
    });
    expect(waiterRows(board).map((r) => r.actor)).toEqual(['a']);
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(checkCache(board).ok).toBe(true);
  });
});

describe('cache without the watermark is rebuilt (spec scenario)', () => {
  it('drops a version 2 cache and rebuilds it with the grant watermark', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(
      events,
      ev(P.create(T1), 'orch', 0),
      L.leased('h', 1000, 1_800_000),
      L.join('b', 2000, 600_000),
    );
    const lapse = 1000 + 120_000 + 60_000 + 1;
    openB(dir).close();
    // A version 2 cache, as task group 1 left it: the lease and queue
    // tables, every event recorded, no grant_watermark row, and a cursor.
    const old = new DatabaseSync(join(dir, CACHE_FILE));
    old.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version';
      DELETE FROM meta WHERE key = 'grant_watermark';
      INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash)
        VALUES ('b', 0, 0, 'orch', 'x');`);
    old.close();

    const board = openB(dir);
    expect(CACHE_SCHEMA_VERSION).toBe(4);
    expect(board.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: '4',
    });
    expect(board.db.prepare('SELECT * FROM cursors').all()).toEqual([]);
    expect(board.db.prepare("SELECT value FROM meta WHERE key = 'grant_watermark'").get()).toEqual({
      value: String(lapse),
    });
    expect(dumpCache(board.db)).toBe(freshDump(events));
    // So the grant is written once the clock reaches the slot.
    expect(catchUp(board, { now: lapse }).applied).toHaveLength(1);
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'b', queue: [] });
  });
});

describe('catch-up keeps lease and queue rows equal to a rebuild', () => {
  it('a grant caught up incrementally uses the window folded in an earlier catch-up', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(
      events,
      ev(P.create(T1), 'orch', 1000),
      ev(P.claim(T1), 'h', 2000),
      L.join('a', 3000, 600_000),
      ev(P.meta('queue.window', 300_000), 'orch', 3500),
    );
    const board = openB(dir);
    const [release] = put(events, L.release('h', 5000));
    expect(catchUp(board, { now: NOW }).refolded).toBe(false);
    expect(waiterRows(board).map((r) => r.actor)).toEqual(['a']);
    const [grant] = put(
      events,
      L.grant(5001, { to: 'a', ttl: 600_000, window: 300_000, after: { released: release ?? '' } }),
    );
    const report = catchUp(board, { now: NOW });
    expect(report.refolded).toBe(false);
    expect(report.applied).toEqual([grant]);
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: 'a',
      lease: { ttl: 600_000, expiresAt: 305_001, event: grant, confirmed: false },
      queue: [],
    });
    expect(waiterRows(board)).toEqual([]);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('a late renew refolds and makes the grant written meanwhile stale', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const [, , , , release] = put(
      events,
      ev(P.create(T1), 'orch', 1000),
      ev(P.claim(T1), 'h', 2000),
      L.join('a', 3000, 600_000),
      L.join('b', 4000, 900_000),
      L.release('h', 5000),
    );
    const [first] = put(
      events,
      L.grant(5001, { to: 'a', ttl: 600_000, window: 120_000, after: { released: release ?? '' } }),
    );
    const [second] = put(
      events,
      L.grant(185_002, {
        to: 'b',
        ttl: 900_000,
        window: 120_000,
        after: { lease: { holder: 'a', expiresAt: 125_001, event: first ?? '' } },
      }),
    );
    const board = openB(dir);
    expect(readTicket(board.db, T1)?.assignee).toBe('b');
    expect(waiterRows(board)).toEqual([]);

    // a renewed in time on another machine; the renew arrives by sync.
    const [renew] = put(events, L.renew('a', 100_000, 600_000));
    const report = catchUp(board, { now: NOW });
    expect(report.refolded).toBe(true);
    expect(report.applied).toEqual([renew]);
    expect(folded(board, second ?? '')).toMatchObject({ folded: 0, reason: 'stale-grant' });
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: 'a',
      lease: { ttl: 600_000, expiresAt: 700_000, event: renew, confirmed: true },
    });
    expect(waiterRows(board).map((r) => r.actor)).toEqual(['b']);
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(checkCache(board).ok).toBe(true);
  });

  it('joins, leaves and a forced release caught up one by one match a rebuild', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ev(P.create(T1), 'orch', 1000), L.leased('h', 2000, 600_000));
    const board = openB(dir);
    const steps: BoardEvent[] = [
      L.renew('h', 3000, 600_000),
      L.join('a', 4000, 60_000),
      L.join('b', 5000, 60_000),
      L.leave('a', 6000),
      L.join('a', 7000, 90_000),
      L.force('orch', 8000, 'h'),
      L.join('c', 9000, 30_000),
    ];
    for (const step of steps) {
      put(events, step);
      catchUp(board, { now: NOW });
      expect(dumpCache(board.db)).toBe(freshDump(events));
    }
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: null, lease: null });
    expect(waiterRows(board).map((r) => [r.position, r.actor])).toEqual([
      [0, 'b'],
      [1, 'a'],
      [2, 'c'],
    ]);
  });
});
