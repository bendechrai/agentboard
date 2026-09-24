/**
 * Cursors: position plus bounded seen set (board-concurrency: "Inbox never
 * misses an event"; board-cache: "Cache is derived and disposable";
 * design.md: "Cursors as position plus seen set"). Task group 5.
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Hlc } from '../../events/hlc.js';
import { openBoard, type Board } from '../board.js';
import { dumpCache, openCache } from '../cache.js';
import {
  SEEN_WINDOW_MS,
  advanceCursor,
  comparePositions,
  isPending,
  readCursor,
  resetLateCursors,
  writeCursor,
  type Cursor,
  type CursorPosition,
} from '../cursors.js';
import { checkCache, rebuild } from '../rebuild.js';
import { P, T1, ev, putEvent, tempBoard } from './helpers.js';

const open: Board[] = [];

function openB(dir: string, options?: Parameters<typeof openBoard>[1]): Board {
  const board = openBoard(dir, options);
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

const HOUR = 3_600_000;

/** A position with a synthetic hash of `c` repeated. */
function pos(wall: number, c = 'a', counter = 0, actor = 'x'): CursorPosition {
  return { hash: c.repeat(64), ts: { wall, counter, actor } };
}

function ts(wall: number, actor = 'x', counter = 0): Hlc {
  return { wall, counter, actor };
}

function cursor(position: CursorPosition | null, seen: CursorPosition[] = []): Cursor {
  return {
    actor: 'orch',
    position,
    seen: seen
      .map((p) => ({ hash: p.hash, wall: p.ts.wall }))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1)),
  };
}

/** Runs `fn` inside BEGIN IMMEDIATE ... COMMIT on the board's connection. */
function locked<T>(board: Board, fn: () => T): T {
  board.db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    board.db.exec('COMMIT');
    return out;
  } catch (error) {
    board.db.exec('ROLLBACK');
    throw error;
  }
}

function columns(board: Board, table: string): string[] {
  return board.db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => String(r.name))
    .sort();
}

describe('SEEN_WINDOW_MS', () => {
  it('is one hour of wall time', () => {
    expect(SEEN_WINDOW_MS).toBe(HOUR);
  });
});

describe('comparePositions', () => {
  it('orders by timestamp first, then by hash', () => {
    expect(comparePositions(pos(1, 'f'), pos(2, 'a'))).toBe(-1);
    expect(comparePositions(pos(2, 'a'), pos(1, 'f'))).toBe(1);
    expect(comparePositions(pos(5, 'a', 1), pos(5, 'f', 0))).toBe(1);
    expect(comparePositions(pos(5, 'a', 0, 'b'), pos(5, 'f', 0, 'a'))).toBe(1);
    expect(comparePositions(pos(5, 'a'), pos(5, 'b'))).toBe(-1);
    expect(comparePositions(pos(5, 'b'), pos(5, 'b'))).toBe(0);
  });
});

describe('isPending', () => {
  const P0 = pos(10 * HOUR, 'p');

  it('delivers everything to a cursor with no position', () => {
    expect(isPending(cursor(null), pos(1))).toBe(true);
    expect(isPending(cursor(null), pos(10 * HOUR))).toBe(true);
  });

  it('delivers an event after the position', () => {
    expect(isPending(cursor(P0), pos(10 * HOUR + 1))).toBe(true);
    // Same timestamp, greater hash: after in fold order.
    expect(isPending(cursor(P0), pos(10 * HOUR, 'q'))).toBe(true);
  });

  it('never redelivers the event at the position itself', () => {
    expect(isPending(cursor(P0), P0)).toBe(false);
  });

  it('never delivers a seen event, before or after the position', () => {
    const before = pos(10 * HOUR - 5, 'b');
    const after = pos(10 * HOUR + 5, 'c');
    const c = cursor(P0, [P0, before, after]);
    expect(isPending(c, before)).toBe(false);
    expect(isPending(c, after)).toBe(false);
  });

  it('delivers an unseen event before the position inside the window (late arrival)', () => {
    const c = cursor(P0, [P0]);
    expect(isPending(c, pos(10 * HOUR - 1, 'l'))).toBe(true);
    // Same timestamp, smaller hash: before the position in fold order.
    expect(isPending(c, pos(10 * HOUR, 'e'))).toBe(true);
  });

  it('includes the window boundary and nothing older', () => {
    const c = cursor(P0, [P0]);
    expect(isPending(c, pos(9 * HOUR, 'l'))).toBe(true);
    expect(isPending(c, pos(9 * HOUR - 1, 'l'))).toBe(false);
    expect(isPending(c, pos(1, 'l'))).toBe(false);
  });
});

describe('advanceCursor', () => {
  it('leaves the cursor unchanged when nothing was delivered', () => {
    const c = cursor(pos(5, 'p'), [pos(5, 'p')]);
    expect(advanceCursor(c, [])).toEqual(c);
    expect(advanceCursor(cursor(null), [])).toEqual(cursor(null));
  });

  it('moves the position to the last delivered event and records every delivered hash', () => {
    const a = pos(100, 'a');
    const b = pos(200, 'b');
    expect(advanceCursor(cursor(null), [a, b])).toEqual(cursor(b, [a, b]));
  });

  it('never moves the position backwards when only late events are delivered', () => {
    const p = pos(1000, 'p');
    const late = pos(500, 'l');
    expect(advanceCursor(cursor(p, [p]), [late])).toEqual(cursor(p, [p, late]));
  });

  it('prunes seen hashes older than the window before the new position', () => {
    const old = pos(1, 'o');
    const edge = pos(2 * HOUR, 'e');
    const top = pos(3 * HOUR, 't');
    const out = advanceCursor(cursor(old, [old]), [edge, top]);
    expect(out.position).toEqual(top);
    expect(out.seen).toEqual([
      { hash: 'e'.repeat(64), wall: 2 * HOUR },
      { hash: 't'.repeat(64), wall: 3 * HOUR },
    ]);
  });

  it('keeps the seen set sorted by hash without duplicates', () => {
    const p = pos(10, 'm');
    const out = advanceCursor(cursor(p, [p]), [pos(5, 'z'), pos(6, 'b'), p]);
    expect(out.seen.map((s) => s.hash[0])).toEqual(['b', 'm', 'z']);
  });

  it('does not mutate its input', () => {
    const c = cursor(pos(5, 'p'), [pos(5, 'p')]);
    const copy = structuredClone(c);
    advanceCursor(c, [pos(9, 'q')]);
    expect(c).toEqual(copy);
  });
});

describe('cursor storage', () => {
  it('reads the empty cursor for an actor with no row', () => {
    const board = openB(tempBoard());
    expect(readCursor(board.db, 'nobody')).toEqual({ actor: 'nobody', position: null, seen: [] });
  });

  it('stores the position in the cursors row and the seen set in cursor_seen', () => {
    const board = openB(tempBoard());
    const p = pos(7000, 'p', 2, 'impl');
    const c: Cursor = {
      actor: 'orch',
      position: p,
      seen: [
        { hash: 'a'.repeat(64), wall: 6000 },
        { hash: 'p'.repeat(64), wall: 7000 },
      ],
    };
    locked(board, () => {
      writeCursor(board.db, c);
    });
    expect(readCursor(board.db, 'orch')).toEqual(c);
    expect(board.db.prepare('SELECT * FROM cursors').all()).toEqual([
      {
        actor: 'orch',
        last_wall: 7000,
        last_counter: 2,
        last_actor: 'impl',
        last_hash: 'p'.repeat(64),
      },
    ]);
    expect(board.db.prepare('SELECT * FROM cursor_seen ORDER BY hash').all()).toEqual([
      { actor: 'orch', hash: 'a'.repeat(64), wall: 6000 },
      { actor: 'orch', hash: 'p'.repeat(64), wall: 7000 },
    ]);
  });

  it('replaces the seen set on each write and leaves other actors alone', () => {
    const board = openB(tempBoard());
    const other: Cursor = {
      actor: 'impl',
      position: pos(1, 'i'),
      seen: [{ hash: 'i'.repeat(64), wall: 1 }],
    };
    locked(board, () => {
      writeCursor(board.db, other);
      writeCursor(board.db, cursor(pos(5, 'a'), [pos(4, 'b'), pos(5, 'a')]));
      writeCursor(board.db, cursor(pos(9, 'c'), [pos(9, 'c')]));
    });
    expect(readCursor(board.db, 'orch')).toEqual(cursor(pos(9, 'c'), [pos(9, 'c')]));
    expect(readCursor(board.db, 'impl')).toEqual(other);
  });

  it('stores a cursor with no position as null columns', () => {
    const board = openB(tempBoard());
    locked(board, () => {
      writeCursor(board.db, cursor(null));
    });
    expect(board.db.prepare('SELECT * FROM cursors').all()).toEqual([
      { actor: 'orch', last_wall: null, last_counter: null, last_actor: null, last_hash: null },
    ]);
    expect(readCursor(board.db, 'orch')).toEqual(cursor(null));
  });

  it('creates cursor_seen with exactly the documented columns', () => {
    const board = openB(tempBoard());
    expect(columns(board, 'cursor_seen')).toEqual(['actor', 'hash', 'wall']);
  });

  it('adds cursor_seen to an existing cache that lacks it, keeping its rows', () => {
    const dir = tempBoard();
    putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
    const first = openBoard(dir);
    first.db.exec('DROP TABLE cursor_seen');
    const before = dumpCache(first.db);
    first.close();
    const second = openB(dir);
    expect(columns(second, 'cursor_seen')).toEqual(['actor', 'hash', 'wall']);
    expect(dumpCache(second.db)).toBe(before);
  });

  it('drops cursor_seen rows when the cache is recreated for another schema version', () => {
    const dir = tempBoard();
    const first = openBoard(dir);
    locked(first, () => {
      writeCursor(first.db, cursor(pos(5, 'a'), [pos(5, 'a')]));
    });
    first.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    first.close();
    const second = openB(dir);
    expect(second.db.prepare('SELECT * FROM cursor_seen').all()).toEqual([]);
    expect(readCursor(second.db, 'orch')).toEqual(cursor(null));
  });

  it('is excluded from the canonical dump and from rebuild --check', () => {
    const dir = tempBoard();
    putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
    const board = openB(dir);
    const before = dumpCache(board.db);
    locked(board, () => {
      writeCursor(board.db, cursor(pos(5, 'a'), [pos(5, 'a')]));
    });
    expect(dumpCache(board.db)).toBe(before);
    expect(checkCache(board).ok).toBe(true);
  });

  it('survives rebuild, seen set included', () => {
    const dir = tempBoard();
    putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
    const board = openB(dir);
    const c = cursor(pos(5, 'a'), [pos(4, 'b'), pos(5, 'a')]);
    locked(board, () => {
      writeCursor(board.db, c);
    });
    rebuild(board);
    expect(readCursor(board.db, 'orch')).toEqual(c);
  });

  it('works on a fresh in-memory cache too', () => {
    const db = openCache(':memory:');
    try {
      expect(readCursor(db, 'a')).toEqual({ actor: 'a', position: null, seen: [] });
    } finally {
      db.close();
    }
  });
});

/**
 * A board with a create at wall 1000, a comment at wall 5 hours and a
 * comment at wall 10 hours, all folded; returns their positions.
 */
function threeEvents(): {
  board: Board;
  events: string;
  create: CursorPosition;
  mid: CursorPosition;
  top: CursorPosition;
} {
  const dir = tempBoard();
  const events = join(dir, 'events');
  const e1 = ev(P.create(T1), 'orch', 1000);
  const e2 = ev(P.comment(T1, 'mid'), 'impl', 5 * HOUR);
  const e3 = ev(P.comment(T1, 'top'), 'impl', 10 * HOUR);
  const create = { hash: putEvent(events, e1), ts: e1.ts };
  const mid = { hash: putEvent(events, e2), ts: e2.ts };
  const top = { hash: putEvent(events, e3), ts: e3.ts };
  return { board: openB(dir), events, create, mid, top };
}

describe('resetLateCursors', () => {
  it('moves a cursor back to the event before a late arrival older than the window', () => {
    const { board, create, mid, top } = threeEvents();
    const before = cursor(top, [top]);
    locked(board, () => {
      writeCursor(board.db, before);
    });
    const late = locked(board, () => resetLateCursors(board.db, [mid]));
    expect(late).toEqual([{ actor: 'orch', hash: mid.hash, ts: mid.ts, cursor: top }]);
    expect(readCursor(board.db, 'orch')).toEqual({ ...before, position: create });
    // The late event is now due, and nothing already seen is.
    const after = readCursor(board.db, 'orch');
    expect(isPending(after, mid)).toBe(true);
    expect(isPending(after, top)).toBe(false);
    expect(isPending(after, create)).toBe(false);
  });

  it('resets to no position when nothing sorts before the late event', () => {
    const { board, create, top } = threeEvents();
    locked(board, () => {
      writeCursor(board.db, cursor(top, [top]));
    });
    const late = locked(board, () => resetLateCursors(board.db, [create]));
    expect(late).toEqual([{ actor: 'orch', hash: create.hash, ts: create.ts, cursor: top }]);
    expect(readCursor(board.db, 'orch').position).toBeNull();
    expect(readCursor(board.db, 'orch').seen).toEqual(cursor(top, [top]).seen);
  });

  it('leaves alone cursors behind the event, cursors with no position and arrivals inside the window', () => {
    const { board, create, mid } = threeEvents();
    const behind: Cursor = {
      actor: 'behind',
      position: create,
      seen: [{ hash: create.hash, wall: create.ts.wall }],
    };
    const fresh: Cursor = { actor: 'fresh', position: null, seen: [] };
    const near: Cursor = {
      actor: 'near',
      position: { hash: 'f'.repeat(64), ts: ts(5 * HOUR + HOUR - 1, 'zz') },
      seen: [],
    };
    locked(board, () => {
      writeCursor(board.db, behind);
      writeCursor(board.db, fresh);
      writeCursor(board.db, near);
    });
    const late = locked(board, () => resetLateCursors(board.db, [mid]));
    expect(late).toEqual([]);
    expect(readCursor(board.db, 'behind')).toEqual(behind);
    expect(readCursor(board.db, 'fresh')).toEqual(fresh);
    expect(readCursor(board.db, 'near')).toEqual(near);
  });

  it('uses the earliest late event and reports each one per actor, sorted', () => {
    const { board, create, mid, top } = threeEvents();
    locked(board, () => {
      writeCursor(board.db, { ...cursor(top, [top]), actor: 'b' });
      writeCursor(board.db, { ...cursor(top, [top]), actor: 'a' });
    });
    const late = locked(board, () => resetLateCursors(board.db, [mid, create]));
    expect(late.map((l) => [l.actor, l.hash])).toEqual([
      ['a', create.hash],
      ['a', mid.hash],
      ['b', create.hash],
      ['b', mid.hash],
    ]);
    expect(readCursor(board.db, 'a').position).toBeNull();
    expect(readCursor(board.db, 'b').position).toBeNull();
  });

  it('changes no derived row', () => {
    const { board, mid, top } = threeEvents();
    locked(board, () => {
      writeCursor(board.db, cursor(top, [top]));
    });
    const dump = dumpCache(board.db);
    locked(board, () => resetLateCursors(board.db, [mid]));
    expect(dumpCache(board.db)).toBe(dump);
  });
});

describe('late events found by folding', () => {
  /** A board whose cursor for orch sits on a comment at wall 10 hours. */
  function acknowledged(): { board: Board; dir: string; events: string; top: CursorPosition } {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const e = ev(P.comment(T1, 'top'), 'impl', 10 * HOUR);
    const top = { hash: putEvent(events, e), ts: e.ts };
    const board = openB(dir);
    locked(board, () => {
      writeCursor(board.db, cursor(top, [top]));
    });
    return { board, dir, events, top };
  }

  it('rebuild reports an event older than the window that it folds for the first time, and resets the cursor', () => {
    const { board, events, top } = acknowledged();
    const e = ev(P.comment(T1, 'synced late'), 'remote', 2 * HOUR);
    const hash = putEvent(events, e);
    const report = rebuild(board);
    expect(report.late).toEqual([{ actor: 'orch', hash, ts: e.ts, cursor: top }]);
    const c = readCursor(board.db, 'orch');
    expect(isPending(c, { hash, ts: e.ts })).toBe(true);
    expect(isPending(c, top)).toBe(false);
  });

  it('rebuild does not report an event it had already folded', () => {
    const { board } = acknowledged();
    expect(rebuild(board).late).toEqual([]);
  });

  it('rebuild does not report a late event inside the window (the seen set covers it)', () => {
    const { board, events, top } = acknowledged();
    const e = ev(P.comment(T1, 'near'), 'remote', 10 * HOUR - 10);
    const hash = putEvent(events, e);
    expect(rebuild(board).late).toEqual([]);
    const c = readCursor(board.db, 'orch');
    expect(c.position).toEqual(top);
    expect(isPending(c, { hash, ts: e.ts })).toBe(true);
  });

  it('catch-up resets the cursor for a late event older than the window', () => {
    const { dir, events } = acknowledged();
    const e = ev(P.comment(T1, 'synced late'), 'remote', 2 * HOUR);
    const hash = putEvent(events, e);
    const again = openB(dir);
    expect(isPending(readCursor(again.db, 'orch'), { hash, ts: e.ts })).toBe(true);
  });

  it('rebuild --check never reports late events or touches cursors', () => {
    const { board, events } = acknowledged();
    putEvent(events, ev(P.comment(T1, 'synced late'), 'remote', 2 * HOUR));
    const before = readCursor(board.db, 'orch');
    const check = checkCache(board);
    expect(check.report.late).toEqual([]);
    expect(readCursor(board.db, 'orch')).toEqual(before);
  });
});
