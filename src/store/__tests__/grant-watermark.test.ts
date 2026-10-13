/**
 * The grant watermark (add-claim-leases board-cache: "Cache schema", the
 * `grant_watermark` meta row and the scenarios "List reads the cache" and
 * "A due grant is the only reason to read the log"; board-cli: "Due grants
 * are written during catch-up").
 *
 * The watermark is the slot time of the first grant that would be due and
 * is not folded, and catch-up reads event files only for an unrecorded
 * name, a stale temporary file or a clock that has reached it. Reads are
 * counted with the read probe (`onReadEventFile`); every board handle here
 * is fresh, so nothing was read before through it. Clocks are injected.
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { BoardEvent, TicketGrantEvent } from '../../events/schema.js';
import { openBoard, type Board, type OpenBoardOptions } from '../board.js';
import { catchUp, dumpCache, readTicket } from '../cache.js';
import { rebuild } from '../rebuild.js';
import { P, T1, T2, copyBoard, ev, eventNames, putEvent, tempBoard } from './helpers.js';

const SKEW = 60_000;
const WINDOW = 120_000;
const GRACE = 120_000;
const TTL = 1_800_000;
/** The lapse slot of `h`'s grace lease claimed at 1000. */
const LAPSE = 1000 + GRACE + SKEW + 1;

const open: Board[] = [];

function openB(dir: string, now: number, options: OpenBoardOptions = {}): Board {
  const board = openBoard(dir, { now, ...options });
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

/** The dump of a rebuild over a copy of `eventsDir` (no catch-up, so no clock). */
function freshDump(eventsDir: string): string {
  const board = openBoard(copyBoard(eventsDir), { catchUp: false });
  open.push(board);
  rebuild(board);
  return dumpCache(board.db);
}

/** The `grant_watermark` meta row as a number, or null when the row is absent. */
function watermark(board: Board): number | null {
  const row = board.db.prepare("SELECT value FROM meta WHERE key = 'grant_watermark'").get();
  return row === undefined ? null : (JSON.parse(String(row.value)) as number);
}

/** A read probe and the names it saw. */
function probe(): { names: string[]; onReadEventFile: (name: string) => void } {
  const names: string[] = [];
  return { names, onReadEventFile: (name) => names.push(name) };
}

const L = {
  leased(actor: string, wall: number, ticket = T1): BoardEvent {
    return ev(
      {
        kind: 'ticket.claim',
        ticket,
        body: { lease: { ttl: TTL, grace: GRACE, expiresAt: wall + GRACE } },
      },
      actor,
      wall,
    );
  },
  join(actor: string, wall: number, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.queue.join', ticket, body: { ttl: 600_000 } }, actor, wall);
  },
  release(actor: string, wall: number, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.release', ticket, body: {} }, actor, wall);
  },
};

/**
 * T1 claimed by `h` at 1000 with a grace lease and never renewed, `b`
 * queued at 2000: the grant to `b` is due at `LAPSE`.
 */
function seedLease(): { dir: string; events: string; g: TicketGrantEvent } {
  const dir = tempBoard();
  const events = join(dir, 'events');
  putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 0));
  const claim = putEvent(events, L.leased('h', 1000));
  putEvent(events, L.join('b', 2000));
  const g: TicketGrantEvent = {
    v: 1,
    kind: 'ticket.grant',
    ticket: T1,
    actor: 'agentboard',
    ts: { wall: LAPSE, counter: 0, actor: 'agentboard' },
    body: {
      to: 'b',
      ttl: 600_000,
      window: WINDOW,
      after: { lease: { holder: 'h', expiresAt: 1000 + GRACE, event: claim } },
    },
  };
  return { dir, events, g };
}

describe('the grant_watermark row', () => {
  it('is the lapse slot of a held lease with a waiter', () => {
    const { dir } = seedLease();
    expect(watermark(openB(dir, 0))).toBe(LAPSE);
  });

  it('is cleared once the last waiter is granted', () => {
    const { dir } = seedLease();
    const board = openB(dir, LAPSE);
    expect(readTicket(board.db, T1)?.assignee).toBe('b');
    // b's grant lapses after the window and the tolerance, but nobody waits
    // behind b, so no grant can follow it.
    expect(watermark(board)).toBeNull();
  });

  it('is the next waiter slot while waiters remain', () => {
    const { dir, events } = seedLease();
    putEvent(events, L.join('c', 3000));
    const board = openB(dir, LAPSE);
    expect(readTicket(board.db, T1)?.assignee).toBe('b');
    expect(watermark(board)).toBe(LAPSE + WINDOW + SKEW + 1);
  });

  it('is absent for a held lease with no waiters, a holder without a lease, or no queue', () => {
    const lease = tempBoard();
    putEvent(join(lease, 'events'), ev(P.create(T1, 'Merge lock'), 'orch', 0));
    putEvent(join(lease, 'events'), L.leased('h', 1000));
    expect(watermark(openB(lease, 0))).toBeNull();

    const plain = tempBoard();
    putEvent(join(plain, 'events'), ev(P.create(T1, 'Merge lock'), 'orch', 0));
    putEvent(join(plain, 'events'), ev(P.claim(T1), 'h', 1000));
    putEvent(join(plain, 'events'), L.join('b', 2000));
    expect(watermark(openB(plain, 0))).toBeNull();

    const released = tempBoard();
    putEvent(join(released, 'events'), ev(P.create(T1, 'Merge lock'), 'orch', 0));
    putEvent(join(released, 'events'), ev(P.claim(T1), 'h', 1000));
    putEvent(join(released, 'events'), L.release('h', 2000));
    expect(watermark(openB(released, 0))).toBeNull();

    expect(watermark(openB(tempBoard(), 0))).toBeNull();
  });
});

describe('catch-up reads event files only when it must', () => {
  it('a cold open reads the event files (the probe sees reads)', () => {
    const { dir, events } = seedLease();
    const reads = probe();
    openB(dir, 0, { onReadEventFile: reads.onReadEventFile });
    expect([...new Set(reads.names)].sort()).toEqual(eventNames(events));
  });

  it('a warm open with nothing due reads no event file', () => {
    const { dir } = seedLease();
    openB(dir, 0).close();
    const reads = probe();
    const board = openB(dir, LAPSE - 1, { onReadEventFile: reads.onReadEventFile });
    expect(reads.names).toEqual([]);
    expect(board.opened?.applied).toEqual([]);
  });

  it('at slot - 1 it reads nothing and writes nothing; at the slot it writes exactly the grant', () => {
    const { dir, events, g } = seedLease();
    const board = openB(dir, 0);
    const before = eventNames(events);
    const early = probe();
    expect(
      catchUp(board, { now: LAPSE - 1, onReadEventFile: early.onReadEventFile }),
    ).toMatchObject({ applied: [] });
    expect(early.names).toEqual([]);
    expect(eventNames(events)).toEqual(before);

    const report = catchUp(board, { now: LAPSE });
    const hash = canonicalHash(g);
    expect(report.applied).toEqual([hash]);
    expect(eventNames(events)).toEqual([...before, `${hash}.json`].sort());
  });

  it('a new event file is read even when nothing is due', () => {
    const { dir, events } = seedLease();
    const board = openB(dir, 0);
    const name = `${putEvent(events, ev(P.comment(T1, 'new'), 'orch', 3000))}.json`;
    const reads = probe();
    catchUp(board, { now: 4000, onReadEventFile: reads.onReadEventFile });
    expect(reads.names).toContain(name);
  });
});

describe('the watermark is derived like any other row', () => {
  it('rebuild twice is byte-identical, includes the row, and equals catch-up', () => {
    const { dir, events } = seedLease();
    const board = openB(dir, 0);
    const incremental = dumpCache(board.db);
    expect(JSON.parse(incremental)).toMatchObject({
      meta: expect.arrayContaining([{ key: 'grant_watermark', value: String(LAPSE) }]) as unknown,
    });
    rebuild(board);
    const first = dumpCache(board.db);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(first);
    expect(first).toBe(incremental);
    expect(first).toBe(freshDump(events));
  });

  it('incremental catch-ups (a join, then the grant) equal a rebuild at every step', () => {
    const { dir, events } = seedLease();
    const board = openB(dir, 0);
    putEvent(events, L.join('c', 3000));
    catchUp(board, { now: 4000 });
    expect(watermark(board)).toBe(LAPSE);
    expect(dumpCache(board.db)).toBe(freshDump(events));
    catchUp(board, { now: LAPSE });
    expect(watermark(board)).toBe(LAPSE + WINDOW + SKEW + 1);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('a late release synced in lowers the watermark, and the next command writes that grant', () => {
    const { dir, events } = seedLease();
    // T2: held by k without a lease, a waiting; a later event on T1 sets last_position.
    putEvent(events, ev(P.create(T2, 'Other lock'), 'orch', 1100));
    putEvent(events, ev(P.claim(T2), 'k', 2100));
    putEvent(events, L.join('a', 3100, T2));
    putEvent(events, ev(P.comment(T1, 'later'), 'orch', 9000));
    const board = openB(dir, 4000);
    expect(watermark(board)).toBe(LAPSE);

    // k's release, written at 5000 on another machine, arrives late.
    const release = putEvent(events, L.release('k', 5000, T2));
    expect(catchUp(board, { now: 4500 }).refolded).toBe(true);
    expect(watermark(board)).toBe(5001);
    expect(readTicket(board.db, T2)).toMatchObject({ assignee: null, queue: [{ actor: 'a' }] });

    const g: TicketGrantEvent = {
      v: 1,
      kind: 'ticket.grant',
      ticket: T2,
      actor: 'agentboard',
      ts: { wall: 5001, counter: 0, actor: 'agentboard' },
      body: { to: 'a', ttl: 600_000, window: WINDOW, after: { released: release } },
    };
    const report = catchUp(board, { now: 6000 });
    expect(report.applied).toEqual([canonicalHash(g)]);
    expect(readTicket(board.db, T2)).toMatchObject({ assignee: 'a', queue: [] });
    expect(watermark(board)).toBe(LAPSE);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });
});
