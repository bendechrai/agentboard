/**
 * Grant materialisation in catch-up (add-claim-leases task 2.1; board-cli:
 * "Due grants are written during catch-up"; board-cache: "Cache schema";
 * board-events: "Grants").
 *
 * Every clock is injected (`openBoard` and `catchUp` take `now`), so
 * whether a grant is due never depends on the machine's clock. Expected
 * grants are written out by hand from board-events "Grants" (slot time
 * `max(F, J) + 1`, a lapse at `expiresAt + 60000`), never derived with the
 * code under test, and every resulting cache is compared with a rebuild
 * of a copy of the events directory.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash } from '../../events/canonical.js';
import type { BoardEvent, TicketGrantBody, TicketGrantEvent } from '../../events/schema.js';
import { openBoard, type Board, type OpenBoardOptions } from '../board.js';
import { catchUp, dumpCache, readTicket } from '../cache.js';
import { BoardError } from '../errors.js';
import { checkCache, rebuild } from '../rebuild.js';
import { runCommand } from '../transaction.js';
import { P, T1, T2, copyBoard, ev, eventNames, propose, putEvent, tempBoard } from './helpers.js';

const SKEW = 60_000;
const WINDOW = 120_000;
const GRACE = 120_000;
const TTL = 1_800_000;

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

const L = {
  leased(actor: string, wall: number, ttl = TTL, grace = GRACE): BoardEvent {
    return ev(
      {
        kind: 'ticket.claim',
        ticket: T1,
        body: { lease: { ttl, grace, expiresAt: wall + Math.min(ttl, grace) } },
      },
      actor,
      wall,
    );
  },
  renew(actor: string, wall: number, ttl = TTL): BoardEvent {
    return ev(
      { kind: 'ticket.renew', ticket: T1, body: { ttl, expiresAt: wall + ttl } },
      actor,
      wall,
    );
  },
  join(actor: string, wall: number, ttl: number): BoardEvent {
    return ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl } }, actor, wall);
  },
  release(actor: string, wall: number): BoardEvent {
    return ev({ kind: 'ticket.release', ticket: T1, body: {} }, actor, wall);
  },
};

/** The grant with slot time `wall`, written out by hand. */
function grant(wall: number, body: TicketGrantBody): TicketGrantEvent {
  return {
    v: 1,
    kind: 'ticket.grant',
    ticket: T1,
    actor: 'agentboard',
    ts: { wall, counter: 0, actor: 'agentboard' },
    body,
  };
}

interface Seeded {
  dir: string;
  events: string;
  release: string;
  /** The grants due after the release when nobody renews, in order. */
  chain: TicketGrantEvent[];
}

const TTLS: Record<string, number> = { a: 600_000, b: 900_000, c: 1_200_000 };

/**
 * T1 held by `h` with a plain claim, waiters joined in the order given
 * (from wall 3000, 500 apart), released by `h` at 5000; nothing else. The
 * chain is the grant to each waiter in turn, each passing on after the
 * window plus the tolerance.
 */
function seedReleased(waiters: readonly string[] = ['a', 'b']): Seeded {
  const dir = tempBoard();
  const events = join(dir, 'events');
  putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
  putEvent(events, ev(P.claim(T1), 'h', 2000));
  waiters.forEach((w, i) => putEvent(events, L.join(w, 3000 + 500 * i, TTLS[w] ?? 600_000)));
  const release = putEvent(events, L.release('h', 5000));
  const chain: TicketGrantEvent[] = [];
  let wall = 5001;
  for (const w of waiters) {
    const previous = chain.at(-1);
    const g = grant(wall, {
      to: w,
      ttl: TTLS[w] ?? 600_000,
      window: WINDOW,
      after:
        previous === undefined
          ? { released: release }
          : {
              lease: {
                holder: previous.body.to,
                expiresAt: previous.ts.wall + WINDOW,
                event: canonicalHash(previous),
              },
            },
    });
    chain.push(g);
    wall += WINDOW + SKEW + 1;
  }
  return { dir, events, release, chain };
}

function fileOf(events: string, event: BoardEvent): string {
  return join(events, `${canonicalHash(event)}.json`);
}

function grantFiles(events: string): string[] {
  return eventNames(events).filter((name) => {
    const doc = JSON.parse(readFileSync(join(events, name), 'utf8')) as { kind: string };
    return doc.kind === 'ticket.grant';
  });
}

function foldedRow(board: Board, hash: string): unknown {
  return board.db.prepare('SELECT folded, reason FROM folded WHERE hash = ?').get(hash);
}

function holdWriteLock(board: Board): { release: () => void } {
  const holder = new DatabaseSync(board.cachePath);
  holder.exec('BEGIN IMMEDIATE');
  return {
    release: () => {
      if (holder.isOpen) {
        holder.exec('ROLLBACK');
        holder.close();
      }
    },
  };
}

describe('catch-up writes the grants that are due', () => {
  it('writes the derived grant as its canonical bytes under its hash and folds it', () => {
    const { dir, events, chain } = seedReleased();
    const [g1] = chain as [TicketGrantEvent];
    const board = openB(dir, 5000);
    expect(grantFiles(events)).toEqual([]);

    const report = catchUp(board, { now: 5001 });

    const hash = canonicalHash(g1);
    expect(report.applied).toEqual([hash]);
    expect(grantFiles(events)).toEqual([`${hash}.json`]);
    expect(readFileSync(fileOf(events, g1))).toEqual(Buffer.from(canonicalEncode(g1)));
    expect(foldedRow(board, hash)).toEqual({ folded: 1, reason: null });
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: 'a',
      lease: { ttl: 600_000, expiresAt: 5001 + WINDOW, event: hash, confirmed: false },
      queue: [{ actor: 'b' }],
    });
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(checkCache(board).ok).toBe(true);
  });

  it('writes the due grant when the board is opened', () => {
    const { dir, events, chain } = seedReleased();
    const board = openB(dir, 5001);
    const hash = canonicalHash(chain[0]);
    expect(board.opened?.applied).toContain(hash);
    expect(grantFiles(events)).toEqual([`${hash}.json`]);
    expect(readTicket(board.db, T1)?.assignee).toBe('a');
  });

  it('does not write a grant whose slot time is after the local clock', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 4000);
    expect(catchUp(board, { now: 5000 }).applied).toEqual([]);
    expect(grantFiles(events)).toEqual([]);
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: null });
    expect(catchUp(board, { now: 5001 }).applied).toHaveLength(1);
    expect(grantFiles(events)).toHaveLength(1);
  });

  it('writes a chain of three lapsed grants in one catch-up, in order', () => {
    const { dir, events, chain } = seedReleased(['a', 'b', 'c']);
    const board = openB(dir, 5000);

    const report = catchUp(board, { now: 10_000_000 });

    const hashes = chain.map((g) => canonicalHash(g));
    expect(report.applied).toEqual(hashes);
    expect(grantFiles(events).sort()).toEqual(hashes.map((h) => `${h}.json`).sort());
    for (const g of chain) {
      expect(readFileSync(fileOf(events, g))).toEqual(Buffer.from(canonicalEncode(g)));
      expect(foldedRow(board, canonicalHash(g))).toEqual({ folded: 1, reason: null });
    }
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: 'c',
      lease: { event: hashes[2], confirmed: false },
      queue: [],
    });
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('scenario: grant written late is still exact', () => {
    // A release with a window of 2 minutes and waiters a and b, and no
    // command for ten minutes.
    const { dir, events, chain } = seedReleased(['a', 'b']);
    const [g1, g2] = chain as [TicketGrantEvent, TicketGrantEvent];
    expect(g1.ts.wall).toBe(5001);
    expect(g2.ts.wall).toBe(5001 + WINDOW + SKEW + 1);
    const board = openB(dir, 5000);

    const report = catchUp(board, { now: 5000 + 600_000 });

    expect(report.applied).toEqual([canonicalHash(g1), canonicalHash(g2)]);
    expect(grantFiles(events)).toHaveLength(2);
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'b', queue: [] });
    // rebuild on another clone of the same events produces identical state.
    const clone = openBoard(copyBoard(events), { catchUp: false });
    open.push(clone);
    rebuild(clone);
    expect(dumpCache(clone.db)).toBe(dumpCache(board.db));
  });

  it('a later catch-up writes the grant that has become due since the last one', () => {
    const { dir, events, chain } = seedReleased(['a', 'b']);
    const board = openB(dir, 5001);
    expect(grantFiles(events)).toHaveLength(1);
    const g2 = chain[1] as TicketGrantEvent;
    expect(catchUp(board, { now: g2.ts.wall - 1 }).applied).toEqual([]);
    expect(catchUp(board, { now: g2.ts.wall }).applied).toEqual([canonicalHash(g2)]);
    expect(readTicket(board.db, T1)?.assignee).toBe('b');
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });
});

describe('each grant is derived from the state at its own fold position', () => {
  /**
   * `h` claims T1 at 1000 with a grace lease (lapsing at 121000, claimable
   * from 181000), `b` joins at 2000, and `h` renews at 200000: after the
   * grant's slot, as a renew from a fast clock or a late sync would be.
   */
  function seedLateRenew(): { dir: string; events: string; g: TicketGrantEvent; renew: string } {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 0));
    const claim = putEvent(events, L.leased('h', 1000));
    putEvent(events, L.join('b', 2000, 600_000));
    const renew = putEvent(events, L.renew('h', 200_000));
    const g = grant(1000 + GRACE + SKEW + 1, {
      to: 'b',
      ttl: 600_000,
      window: WINDOW,
      after: { lease: { holder: 'h', expiresAt: 1000 + GRACE, event: claim } },
    });
    return { dir, events, g, renew };
  }

  it('writes the lapse grant before a renew that sorts after its slot (first open)', () => {
    const { dir, events, g, renew } = seedLateRenew();
    const board = openB(dir, 250_000);
    expect(grantFiles(events)).toEqual([`${canonicalHash(g)}.json`]);
    expect(readFileSync(fileOf(events, g))).toEqual(Buffer.from(canonicalEncode(g)));
    expect(readTicket(board.db, T1)?.assignee).toBe('b');
    expect(foldedRow(board, renew)).toEqual({ folded: 0, reason: 'not-assignee' });
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('writes it once due even when the renew was folded first and no file is new', () => {
    const { dir, events, g, renew } = seedLateRenew();
    // Folded before the slot time: the renew applies and the lease is confirmed.
    const board = openB(dir, 150_000);
    expect(readTicket(board.db, T1)?.lease).toMatchObject({ event: renew, confirmed: true });
    expect(grantFiles(events)).toEqual([]);

    const report = catchUp(board, { now: 250_000 });

    expect(report.applied).toEqual([canonicalHash(g)]);
    expect(grantFiles(events)).toEqual([`${canonicalHash(g)}.json`]);
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'b', queue: [] });
    expect(foldedRow(board, renew)).toEqual({ folded: 0, reason: 'not-assignee' });
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(checkCache(board).ok).toBe(true);
  });

  it('uses the queue.window folded at the grant position, not a later setting', () => {
    const { dir, events, chain } = seedReleased(['a']);
    putEvent(events, ev(P.meta('queue.window', 300_000), 'orch', 6000));
    const board = openB(dir, 4000);
    catchUp(board, { now: 7000 });
    expect(grantFiles(events)).toEqual([`${canonicalHash(chain[0])}.json`]);
    expect((chain[0] as TicketGrantEvent).body.window).toBe(WINDOW);
    expect(readTicket(board.db, T1)?.lease?.expiresAt).toBe(5001 + WINDOW);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });
});

describe('a grant file already present', () => {
  it('a grant file left by a crashed writer is folded, not rewritten or refused', () => {
    const { dir, events, chain } = seedReleased();
    const g1 = chain[0] as TicketGrantEvent;
    const board = openB(dir, 5000);
    // Another command renamed the grant into place and died before commit.
    const hash = putEvent(events, g1);
    const report = catchUp(board, { now: 5001 });
    expect(report.applied).toEqual([hash]);
    expect(grantFiles(events)).toEqual([`${hash}.json`]);
    expect(readTicket(board.db, T1)?.assignee).toBe('a');
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('a second connection finds the grant written by the first and writes nothing', () => {
    const { dir, events } = seedReleased();
    const first = openB(dir, 5000);
    const second = openB(dir, 5000);
    expect(catchUp(first, { now: 5001 }).applied).toHaveLength(1);
    let locked = 0;
    const report = catchUp(second, { now: 5001, onWriteLock: () => (locked += 1) });
    expect(report.applied).toEqual([]);
    expect(locked).toBe(0);
    expect(grantFiles(events)).toHaveLength(1);
    expect(readTicket(second.db, T1)?.assignee).toBe('a');
  });
});

describe('the write lock is taken only when something is due (lock probe)', () => {
  it('a catch-up with nothing to fold, reap or grant takes no write lock', () => {
    const { dir } = seedReleased();
    const board = openB(dir, 5000);
    let locked = 0;
    const report = catchUp(board, { now: 5000, onWriteLock: () => (locked += 1) });
    expect(locked).toBe(0);
    expect(report.applied).toEqual([]);
  });

  it('nothing due: it is not blocked by a writer holding the lock', () => {
    const { dir } = seedReleased();
    const board = openB(dir, 5000);
    board.db.exec('PRAGMA busy_timeout = 50');
    const lock = holdWriteLock(board);
    try {
      expect(catchUp(board, { now: 5000 }).applied).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it('a grant due by the clock alone takes the write lock once and writes it', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 5000);
    let locked = 0;
    catchUp(board, { now: 5001, onWriteLock: () => (locked += 1) });
    expect(locked).toBe(1);
    expect(grantFiles(events)).toHaveLength(1);
    // Nothing more is due until a's window and the tolerance pass.
    catchUp(board, { now: 5002, onWriteLock: () => (locked += 1) });
    expect(locked).toBe(1);
  });

  it('a due grant needs the write lock: with it held, catch-up reports busy', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 5000);
    board.db.exec('PRAGMA busy_timeout = 50');
    const lock = holdWriteLock(board);
    try {
      expect(() => catchUp(board, { now: 5001 })).toThrow(BoardError);
    } finally {
      lock.release();
    }
    expect(grantFiles(events)).toEqual([]);
  });

  it('a ticket held without a lease never lapses, so its waiters never take the lock', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
    putEvent(events, ev(P.claim(T1), 'h', 2000));
    putEvent(events, L.join('a', 3000, 600_000));
    const board = openB(dir, 5000);
    let locked = 0;
    catchUp(board, { now: 1e13, onWriteLock: () => (locked += 1) });
    expect(locked).toBe(0);
    expect(grantFiles(events)).toEqual([]);
  });

  it('a new event file takes the lock and calls the probe once', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 5000);
    putEvent(events, ev(P.comment(T1, 'new'), 'orch', 4500));
    let locked = 0;
    catchUp(board, { now: 5000, onWriteLock: () => (locked += 1) });
    expect(locked).toBe(1);
  });

  it('inside the caller transaction the probe is not called, and the grant is still written', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 5000);
    let locked = 0;
    board.db.exec('BEGIN IMMEDIATE');
    try {
      catchUp(board, { now: 5001, onWriteLock: () => (locked += 1) });
      board.db.exec('COMMIT');
    } catch (error) {
      board.db.exec('ROLLBACK');
      throw error;
    }
    expect(locked).toBe(0);
    expect(grantFiles(events)).toHaveLength(1);
    expect(readTicket(board.db, T1)?.assignee).toBe('a');
  });

  it('openBoard passes the probe to its catch-up', () => {
    const { dir } = seedReleased();
    openB(dir, 5000).close();
    let locked = 0;
    openB(dir, 5000, { onWriteLock: () => (locked += 1) });
    expect(locked).toBe(0);
    openB(dir, 5001, { onWriteLock: () => (locked += 1) });
    expect(locked).toBe(1);
  });
});

describe('rebuild and rebuild --check never write grants', () => {
  it('rebuild folds the files as they are, writing no grant', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 5000);
    const before = eventNames(events);
    rebuild(board);
    expect(eventNames(events)).toEqual(before);
    expect(readTicket(board.db, T1)).toMatchObject({
      assignee: null,
      queue: [{ actor: 'a' }, { actor: 'b' }],
    });
  });

  it('rebuild --check writes no grant and finds the cache consistent', () => {
    const { dir, events } = seedReleased();
    const board = openB(dir, 5000);
    const before = eventNames(events);
    expect(checkCache(board).ok).toBe(true);
    expect(eventNames(events)).toEqual(before);
  });

  it('opening without catch-up writes no grant', () => {
    const { dir, events } = seedReleased();
    const before = eventNames(events);
    const board = openB(dir, 1e13, { catchUp: false });
    rebuild(board);
    expect(eventNames(events)).toEqual(before);
  });
});

describe('a command transaction writes due grants before deciding', () => {
  it('a comment at the slot time writes the grant first, in the same transaction', () => {
    const { dir, events, chain } = seedReleased();
    const board = openB(dir, 5000);
    const hash = canonicalHash(chain[0]);
    const result = runCommand(board, 'z', propose(P.comment(T1, 'next')), { now: () => 5001 });
    expect(result.catchUp.applied).toEqual([hash]);
    expect(grantFiles(events)).toEqual([`${hash}.json`]);
    expect(result.ticket).toMatchObject({ assignee: 'a', queue: [{ actor: 'b' }] });
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('a claim at the slot time is refused already-assigned to the grantee, not queued', () => {
    // One waiter: before the grant a plain claim is refused `queued`; after
    // it the queue is empty and the ticket is held by the grantee.
    const { dir } = seedReleased(['a']);
    const board = openB(dir, 5000);
    let caught: unknown = null;
    try {
      runCommand(board, 'z', propose(P.claim(T1)), { now: () => 5001 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).reason).toBe('already-assigned');
    expect((caught as BoardError).message).toContain('assigned to a');
  });
});

describe('scenario: refused command keeps its catch-up', () => {
  it('a refused claim commits the grant its catch-up wrote, and nothing of its own', () => {
    // One waiter: the grant to a is due at 5001 and not yet written.
    const { dir, events, chain } = seedReleased(['a']);
    const board = openB(dir, 5000);
    const before = eventNames(events);
    const hash = canonicalHash(chain[0]);
    expect(() => runCommand(board, 'z', propose(P.claim(T1)), { now: () => 5001 })).toThrow(
      BoardError,
    );
    // The only new event file is the grant.
    expect(eventNames(events)).toEqual([...before, `${hash}.json`].sort());
    expect(readFileSync(fileOf(events, chain[0] as TicketGrantEvent))).toEqual(
      Buffer.from(canonicalEncode(chain[0])),
    );
    // The cache committed the catch-up: the grantee holds T1 with an empty queue.
    expect(foldedRow(board, hash)).toEqual({ folded: 1, reason: null });
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'a', queue: [] });
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(checkCache(board).ok).toBe(true);
  });

  it('a refusal with nothing to catch up writes nothing and leaves the cache unchanged', () => {
    const { dir, events } = seedReleased(['a']);
    const board = openB(dir, 5000);
    const before = eventNames(events);
    const dump = dumpCache(board.db);
    expect(() =>
      runCommand(board, 'z', propose(P.move(T1, 'merged')), { now: () => 5000 }),
    ).toThrow(BoardError);
    expect(eventNames(events)).toEqual(before);
    expect(dumpCache(board.db)).toBe(dump);
  });
});

describe('a writing command killed after its catch-up renamed a grant into place', () => {
  it('the next catch-up folds the grant once, and the command left no event of its own', () => {
    const { dir, events, chain } = seedReleased(['a']);
    const board = openB(dir, 5000);
    const before = eventNames(events);
    const hash = canonicalHash(chain[0]);
    const renamed: string[] = [];
    // The hook throws where the process would die: after the first rename
    // of the command, which is the grant written by its catch-up.
    const crash = new Error('killed after rename');
    expect(() =>
      runCommand(board, 'z', propose(P.comment(T1, 'never written')), {
        now: () => 5001,
        hooks: {
          afterRename: (path) => {
            renamed.push(path);
            throw crash;
          },
        },
      }),
    ).toThrow(crash);

    expect(renamed).toEqual([fileOf(events, chain[0] as TicketGrantEvent)]);
    // Only the grant is on disk: no comment event, no temporary file.
    expect(eventNames(events)).toEqual([...before, `${hash}.json`].sort());
    expect(readdirSync(events).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    // The transaction was rolled back, so the grant is not folded yet.
    expect(foldedRow(board, hash)).toBeUndefined();
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: null, queue: [{ actor: 'a' }] });

    const report = catchUp(board, { now: 5001 });
    expect(report.applied).toEqual([hash]);
    expect(eventNames(events)).toEqual([...before, `${hash}.json`].sort());
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'a', queue: [] });
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(catchUp(board, { now: 5002 }).applied).toEqual([]);
    expect(checkCache(board).ok).toBe(true);
  });
});

describe('recorded event files corrupted or deleted in place', () => {
  /**
   * `seedReleased(['a'])` (the grant to a due at 5001) plus T2 with a
   * comment, and optionally a later comment on T2 at 9000 so that the
   * grant sorts before `last_position` and is folded by a refold. Folded
   * at 5000, so every file is recorded and nothing is due yet. Returns a
   * fresh board handle (a new process), the seed and the T2 comment's file
   * name.
   */
  function folded(later: boolean): { board: Board; seed: Seeded; comment: string } {
    const seed = seedReleased(['a']);
    putEvent(seed.events, ev(P.create(T2, 'Other'), 'orch', 1100));
    const comment = `${putEvent(seed.events, ev(P.comment(T2, 'unrelated'), 'orch', 1200))}.json`;
    if (later) {
      putEvent(seed.events, ev(P.comment(T2, 'later'), 'orch', 9000));
    }
    openB(seed.dir, 5000).close();
    // A fresh handle, as a new process: it has read no event file yet, and
    // opening at 5000 (no new file, the clock before the watermark) reads none.
    const board = openB(seed.dir, 5000);
    return { board, seed, comment };
  }

  /** Changes a file's bytes in place, so its name no longer hashes them. */
  function corrupt(events: string, name: string): void {
    writeFileSync(join(events, name), `${readFileSync(join(events, name), 'utf8')} `);
  }

  for (const later of [false, true]) {
    const how = later ? 'by a refold' : 'incrementally';
    it(`reports a corrupted recorded file once and still writes the due grant (${how})`, () => {
      const { board, seed, comment } = folded(later);
      corrupt(seed.events, comment);
      const hash = canonicalHash(seed.chain[0]);

      const report = catchUp(board, { now: 5001 });

      expect(report.corrupt.map((file) => file.name)).toEqual([comment]);
      expect(report.corrupt[0]?.path).toBe(join(seed.events, comment));
      expect(report.applied).toEqual([hash]);
      expect(readFileSync(fileOf(seed.events, seed.chain[0] as TicketGrantEvent))).toEqual(
        Buffer.from(canonicalEncode(seed.chain[0])),
      );
      expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'a', queue: [] });
      // rebuild --check skips the corrupt file. After a refold the cache
      // already skips it too; after an incremental catch-up it still holds
      // T2's comment, which is all the check flags.
      const check = checkCache(board);
      expect(check.report.corruptFiles.map((file) => file.name)).toEqual([comment]);
      expect(check.ok).toBe(later);
      for (const difference of check.differences) {
        expect(difference.ticket === T2 || difference.key === comment.replace(/\.json$/, '')).toBe(
          true,
        );
      }
    });
  }

  it('reports corrupted files the grant needs on every walk, by name, each once', () => {
    const { board, seed, comment } = folded(false);
    const release = `${seed.release}.json`;
    const dump = dumpCache(board.db);
    corrupt(seed.events, release);
    corrupt(seed.events, comment);
    const expected = [release, comment].sort();
    for (const now of [5001, 5002]) {
      // Without the release no grant is derivable: nothing is written, but
      // each walk shows why.
      const report = catchUp(board, { now });
      expect(report.corrupt.map((file) => file.name)).toEqual(expected);
      expect(report.applied).toEqual([]);
    }
    expect(grantFiles(seed.events)).toEqual([]);
    expect(dumpCache(board.db)).toBe(dump);
    expect(checkCache(board).ok).toBe(false);
  });

  it('a recorded file deleted in place: no crash, and the derivable grant is written', () => {
    const { board, seed, comment } = folded(false);
    rmSync(join(seed.events, comment));
    const report = catchUp(board, { now: 5001 });
    expect(report.applied).toEqual([canonicalHash(seed.chain[0])]);
    expect(readTicket(board.db, T1)).toMatchObject({ assignee: 'a', queue: [] });
  });

  it('the deleted release: no crash, nothing written, the cache unchanged', () => {
    const { board, seed } = folded(false);
    const dump = dumpCache(board.db);
    rmSync(join(seed.events, `${seed.release}.json`));
    expect(catchUp(board, { now: 5001 }).applied).toEqual([]);
    expect(grantFiles(seed.events)).toEqual([]);
    expect(dumpCache(board.db)).toBe(dump);
  });
});
