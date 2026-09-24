import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalDecode, canonicalEncode } from '../../events/canonical.js';
import { openBoard, type Board } from '../board.js';
import {
  BUSY_TIMEOUT_MS,
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  DUMP_TABLES,
  catchUp,
  dumpCache,
  openCache,
  readState,
  readTicket,
} from '../cache.js';
import { BoardError } from '../errors.js';
import { checkCache, rebuild } from '../rebuild.js';
import { runCommand } from '../transaction.js';
import {
  MISSING,
  P,
  T1,
  T2,
  allNames,
  canon,
  copyBoard,
  ev,
  foldDir,
  putEvent,
  seedRich,
  tempBoard,
  tempDir,
} from './helpers.js';

const open: Board[] = [];

/** openBoard, closed automatically after the test. */
function openB(dir: string, options?: Parameters<typeof openBoard>[1]): Board {
  const board = openBoard(dir, options);
  open.push(board);
  return board;
}

const extra: DatabaseSync[] = [];

function openDb(path: string): DatabaseSync {
  const db = openCache(path);
  extra.push(db);
  return db;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
  for (const db of extra.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
});

type Row = Record<string, unknown>;

function pragma(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[])
    .map((r) => String(r.name))
    .sort();
}

/** The dump of a cache built from scratch over a copy of `eventsDir`. */
function freshDump(eventsDir: string): string {
  const other = openB(copyBoard(eventsDir));
  return dumpCache(other.db);
}

function removeCache(board: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(board, CACHE_FILE + suffix), { force: true });
  }
}

describe('openBoard', () => {
  it('exits 2 for a missing directory and creates nothing', () => {
    const missing = join(tempDir(), 'nope');
    try {
      openBoard(missing);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect((error as BoardError).exitCode).toBe(2);
      expect((error as BoardError).reason).toBe('board-not-found');
      expect((error as BoardError).message).toContain(missing);
    }
    expect(existsSync(missing)).toBe(false);
  });

  it('exits 2 for a directory without events and creates no cache', () => {
    const dir = tempDir();
    expect(() => openBoard(dir)).toThrow(BoardError);
    expect(existsSync(join(dir, CACHE_FILE))).toBe(false);
  });

  it('exposes absolute paths and creates the cache file', () => {
    const dir = tempBoard();
    const board = openB(dir);
    expect(board.dir).toBe(dir);
    expect(board.eventsDir).toBe(join(dir, 'events'));
    expect(board.cachePath).toBe(join(dir, 'cache.sqlite'));
    expect(CACHE_FILE).toBe('cache.sqlite');
    expect(existsSync(board.cachePath)).toBe(true);
  });

  it('enables WAL, a busy timeout of at least 5000 ms and foreign keys', () => {
    const board = openB(tempBoard());
    expect(BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(pragma(board.db, 'journal_mode')).toBe('wal');
    expect(Number(pragma(board.db, 'busy_timeout'))).toBeGreaterThanOrEqual(5000);
    expect(Number(pragma(board.db, 'foreign_keys'))).toBe(1);
  });

  it('builds a new cache from existing event files', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const hashes = seedRich(events);
    const board = openB(dir);
    expect(canon(readState(board.db))).toBe(canon(foldDir(events).state));
    const opened = board.opened;
    expect(opened).not.toBeNull();
    const recorded = [
      ...(opened?.applied ?? []),
      ...(opened?.rejected.map((r) => r.hash) ?? []),
      ...(opened?.unknown.map((u) => u.hash) ?? []),
    ];
    expect(recorded.sort()).toEqual([...hashes].sort());
  });

  it('rebuilds a deleted cache transparently with the same result', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const first = openBoard(dir);
    const dumpBefore = dumpCache(first.db);
    const stateBefore = canon(readState(first.db));
    first.close();
    removeCache(dir);
    expect(existsSync(join(dir, CACHE_FILE))).toBe(false);

    const second = openB(dir);
    expect(dumpCache(second.db)).toBe(dumpBefore);
    expect(canon(readState(second.db))).toBe(stateBefore);
  });

  it('reopening an up-to-date cache records nothing new', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const first = openBoard(dir);
    const dump = dumpCache(first.db);
    first.close();
    const second = openB(dir);
    expect(second.opened?.applied).toEqual([]);
    expect(second.opened?.rejected).toEqual([]);
    expect(second.opened?.unknown).toEqual([]);
    expect(dumpCache(second.db)).toBe(dump);
  });

  it('with catchUp false reads no event file and reaps nothing', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const temp = join(events, '.tmp-0000000000000000');
    writeFileSync(temp, 'partial');
    utimesSync(temp, 0, 0);
    const board = openB(dir, { catchUp: false });
    expect(board.opened).toBeNull();
    expect(readTicket(board.db, T1)).toBeNull();
    expect(existsSync(temp)).toBe(true);
  });

  it('reaps stale temporary files on open and reports them', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const now = 1_700_000_000_000;
    const stale = join(events, '.tmp-aaaaaaaaaaaaaaaa');
    const fresh = join(events, '.tmp-bbbbbbbbbbbbbbbb');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'y');
    utimesSync(stale, (now - 120_000) / 1000, (now - 120_000) / 1000);
    utimesSync(fresh, (now - 1_000) / 1000, (now - 1_000) / 1000);
    const board = openB(dir, { now });
    expect(board.opened?.reaped).toEqual([stale]);
    expect(allNames(events)).toEqual(['.tmp-bbbbbbbbbbbbbbbb']);
  });

  it('recreates a cache written with a different schema version', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const first = openBoard(dir);
    const dump = dumpCache(first.db);
    first.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    first.db.prepare("UPDATE tickets SET title = 'stale'").run();
    first.close();
    const second = openB(dir);
    expect(dumpCache(second.db)).toBe(dump);
  });

  it('drops cursor rows when it recreates a cache of a different schema version', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const first = openBoard(dir);
    first.db
      .prepare(
        "INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES ('orch', 1, 0, 'orch', 'h')",
      )
      .run();
    first.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    first.close();
    const second = openB(dir);
    expect(second.db.prepare('SELECT * FROM cursors').all()).toEqual([]);
    expect(second.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(CACHE_SCHEMA_VERSION),
    });
  });

  it('close is idempotent', () => {
    const board = openBoard(tempBoard());
    board.close();
    expect(() => board.close()).not.toThrow();
  });
});

describe('openCache', () => {
  it('prepares every connection, not only the first', () => {
    const board = openB(tempBoard());
    const second = openDb(board.cachePath);
    expect(pragma(second, 'journal_mode')).toBe('wal');
    expect(Number(pragma(second, 'busy_timeout'))).toBeGreaterThanOrEqual(5000);
    expect(Number(pragma(second, 'foreign_keys'))).toBe(1);
  });

  it('creates the schema of board-cache with exactly the documented columns', () => {
    const db = openDb(join(tempDir(), 'c.sqlite'));
    expect(columns(db, 'tickets')).toEqual(
      [
        'id',
        'title',
        'description',
        'status',
        'blocked_from',
        'assignee',
        'version',
        'updated_at',
        'created_by',
        'created_at',
        'task_source',
        'task_ref',
        'task_item',
        'adhoc',
        'labels',
        'closed',
        'decision',
        'checklist',
      ].sort(),
    );
    expect(columns(db, 'comments')).toEqual(['actor', 'hash', 'seq', 'text', 'ticket', 'ts']);
    expect(columns(db, 'links')).toEqual(['actor', 'hash', 'kind', 'seq', 'ticket', 'ts', 'value']);
    expect(columns(db, 'cursors')).toEqual([
      'actor',
      'last_actor',
      'last_counter',
      'last_hash',
      'last_wall',
    ]);
    expect(columns(db, 'folded')).toEqual(['folded', 'hash', 'position', 'reason']);
    expect(columns(db, 'meta')).toEqual(['key', 'value']);
  });

  it('records the schema version and an empty last position', () => {
    const db = openDb(join(tempDir(), 'c.sqlite'));
    const rows = db.prepare('SELECT key, value FROM meta ORDER BY key').all() as Row[];
    expect(rows).toEqual([
      { key: 'last_position', value: 'null' },
      { key: 'schema_version', value: String(CACHE_SCHEMA_VERSION) },
    ]);
    expect(CACHE_SCHEMA_VERSION).toBe(1);
  });

  it('enforces the foreign key from comments to tickets', () => {
    const db = openDb(join(tempDir(), 'c.sqlite'));
    expect(() =>
      db
        .prepare(
          "INSERT INTO comments (ticket, seq, actor, ts, text, hash) VALUES ('nope', 0, 'a', 't', 'x', 'h')",
        )
        .run(),
    ).toThrow();
  });

  it('opens an in-memory database', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'tickets')).toContain('title');
  });
});

describe('catchUp', () => {
  it('folds event files not yet recorded, in fold order', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir);
    const c = putEvent(events, ev(P.comment(T1, 'later'), 'impl', 3000));
    const a = putEvent(events, ev(P.create(T1), 'orch', 1000));
    const b = putEvent(events, ev(P.claim(T1), 'impl', 2000));
    const report = catchUp(board);
    expect(report.applied).toEqual([a, b, c]);
    expect(report.rejected).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.malformed).toEqual([]);
    expect(report.corrupt).toEqual([]);
    expect(report.reaped).toEqual([]);
    expect(readTicket(board.db, T1)).toEqual(foldDir(events).state.tickets[T1]);
    expect(board.db.isTransaction).toBe(false);
  });

  it('changes nothing when there is nothing new', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const board = openB(dir);
    const dump = dumpCache(board.db);
    const report = catchUp(board);
    expect(report.applied).toEqual([]);
    expect(report.rejected).toEqual([]);
    expect(report.refolded).toBe(false);
    expect(dumpCache(board.db)).toBe(dump);
  });

  it('extends incrementally when new events sort after the last position', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    seedRich(events);
    const board = openB(dir);
    const h = putEvent(events, ev(P.comment(T2, 'new'), 'orch', 9000));
    const report = catchUp(board);
    expect(report.applied).toEqual([h]);
    expect(report.refolded).toBe(false);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });

  it('refolds when a late event sorts before the last position, changing the winner', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const bClaim = putEvent(events, ev(P.claim(T1), 'bob', 2000));
    const board = openB(dir);
    expect(readTicket(board.db, T1)?.assignee).toBe('bob');

    // A claim from another machine with an earlier timestamp arrives by sync.
    const aClaim = putEvent(events, ev(P.claim(T1), 'amy', 1500));
    const report = catchUp(board);
    expect(report.refolded).toBe(true);
    expect(report.applied).toEqual([aClaim]);
    expect(readTicket(board.db, T1)?.assignee).toBe('amy');
    const folded = board.db
      .prepare('SELECT folded, reason FROM folded WHERE hash = ?')
      .get(bClaim) as Row;
    expect(folded).toEqual({ folded: 0, reason: 'already-assigned' });
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(canon(readState(board.db))).toBe(canon(foldDir(events).state));
  });

  it('records rejected, unknown and malformed events once and reports corrupt files every time', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir);
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const rejected = putEvent(events, ev(P.comment(MISSING, 'x'), 'orch', 1100));
    const unknown = putEvent(events, {
      v: 1,
      kind: 'board.archive',
      actor: 'orch',
      ts: { wall: 1200, counter: 0, actor: 'orch' },
      body: {},
    });
    const malformed = putEvent(events, { v: 1, kind: 'ticket.comment', ticket: T1 });
    const corruptPath = join(events, `${'f'.repeat(64)}.json`);
    writeFileSync(corruptPath, '{}');

    const first = catchUp(board);
    expect(first.rejected).toEqual([
      { hash: rejected, kind: 'ticket.comment', ticket: MISSING, reason: 'unknown-ticket' },
    ]);
    expect(first.unknown.map((u) => [u.hash, u.kind])).toEqual([[unknown, 'board.archive']]);
    expect(first.malformed.map((m) => m.hash)).toEqual([malformed]);
    expect(first.corrupt.map((c) => c.path)).toEqual([corruptPath]);

    const rows = board.db
      .prepare('SELECT hash, folded, reason FROM folded ORDER BY hash')
      .all() as Row[];
    const byHash = new Map(rows.map((r) => [r.hash, r]));
    expect(byHash.get(rejected)).toMatchObject({ folded: 0, reason: 'unknown-ticket' });
    expect(byHash.get(unknown)).toMatchObject({ folded: 0, reason: 'unknown-kind' });
    expect(byHash.get(malformed)).toMatchObject({ folded: 0, reason: 'malformed' });
    expect(rows.some((r) => String(r.hash).startsWith('ffff'))).toBe(false);

    const second = catchUp(board);
    expect(second.rejected).toEqual([]);
    expect(second.unknown).toEqual([]);
    expect(second.malformed).toEqual([]);
    expect(second.corrupt.map((c) => c.path)).toEqual([corruptPath]);
  });

  it('ignores .gitkeep: never corrupt, never recorded, never reaped', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const keep = join(events, '.gitkeep');
    writeFileSync(keep, '');
    utimesSync(keep, 0, 0);
    const h = putEvent(events, ev(P.create(T1), 'orch', 1000));
    const board = openB(dir, { now: 1_700_000_000_000 });
    expect(board.opened?.corrupt).toEqual([]);
    expect(board.opened?.malformed).toEqual([]);
    expect(board.opened?.reaped).toEqual([]);
    expect(board.opened?.applied).toEqual([h]);
    expect(existsSync(keep)).toBe(true);
    const hashes = board.db.prepare('SELECT hash FROM folded').all() as Row[];
    expect(hashes.map((r) => r.hash)).toEqual([h]);
  });

  it('keeps folding the rest of the log around a corrupt file', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    writeFileSync(join(events, `${'0'.repeat(64)}.json`), 'garbage');
    putEvent(events, ev(P.comment(T1, 'after'), 'orch', 2000));
    const board = openB(dir);
    expect(board.opened?.corrupt).toHaveLength(1);
    expect(readTicket(board.db, T1)?.comments.map((c) => c.text)).toEqual(['after']);
  });

  it("runs inside the caller's transaction when one is open", () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir);
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    board.db.exec('BEGIN IMMEDIATE');
    catchUp(board);
    expect(board.db.isTransaction).toBe(true);
    expect(readTicket(board.db, T1)).not.toBeNull();
    board.db.exec('ROLLBACK');
    expect(readTicket(board.db, T1)).toBeNull();
  });

  it('reaps stale temporary files using the given clock', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir, { now: 0 });
    const temp = join(events, '.tmp-cccccccccccccccc');
    writeFileSync(temp, 'x');
    utimesSync(temp, 100, 100);
    expect(catchUp(board, { now: 100_000 + 60_000 }).reaped).toEqual([]);
    expect(catchUp(board, { now: 100_000 + 60_001 }).reaped).toEqual([temp]);
  });
});

/** A second connection holding the write lock until `release` is called. */
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

/** Asserts `fn` fails with BoardError(5, 'busy'), i.e. it tried to take the write lock. */
function expectBusy(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BoardError);
    expect({
      exitCode: (error as BoardError).exitCode,
      reason: (error as BoardError).reason,
    }).toEqual({ exitCode: 5, reason: 'busy' });
    return;
  }
  throw new Error('expected BoardError(5, busy)');
}

describe('catch-up and the write lock', () => {
  it('with nothing to fold or reap, catchUp does not take the write lock', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    seedRich(events);
    const young = join(events, '.tmp-5555555555555555');
    writeFileSync(young, 'in progress');
    const board = openB(dir);
    board.db.exec('PRAGMA busy_timeout = 50');
    const dump = dumpCache(board.db);
    const lock = holdWriteLock(board);
    try {
      const report = catchUp(board, { now: Date.now() });
      expect(report).toEqual({
        applied: [],
        rejected: [],
        unknown: [],
        malformed: [],
        corrupt: [],
        reaped: [],
        refolded: false,
      });
    } finally {
      lock.release();
    }
    expect(dumpCache(board.db)).toBe(dump);
    expect(existsSync(young)).toBe(true);
    expect(board.db.isTransaction).toBe(false);
  });

  it('reports corrupt files without taking the write lock when nothing else is new', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const corrupt = join(events, 'notes.txt');
    writeFileSync(corrupt, 'hello');
    const board = openB(dir);
    board.db.exec('PRAGMA busy_timeout = 50');
    const lock = holdWriteLock(board);
    try {
      const report = catchUp(board);
      expect(report.corrupt.map((c) => c.path)).toEqual([corrupt]);
      expect(report.applied).toEqual([]);
    } finally {
      lock.release();
    }
  });

  it('openBoard on a current cache with nothing new returns promptly while a writer holds the lock', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const first = openBoard(dir);
    const dump = dumpCache(first.db);
    const lock = holdWriteLock(first);
    const started = Date.now();
    let second: Board | null = null;
    try {
      second = openBoard(dir);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(second.opened?.applied).toEqual([]);
      expect(second.opened?.refolded).toBe(false);
    } finally {
      lock.release();
      second?.close();
    }
    expect(dumpCache(first.db)).toBe(dump);
    first.close();
  }, 30_000);

  it('with an unrecorded event file, catchUp takes the write lock', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const board = openB(dir);
    board.db.exec('PRAGMA busy_timeout = 50');
    const h = putEvent(events, ev(P.comment(T1, 'new'), 'orch', 2000));
    const lock = holdWriteLock(board);
    try {
      expectBusy(() => catchUp(board));
    } finally {
      lock.release();
    }
    expect(readTicket(board.db, T1)?.comments).toEqual([]);
    expect(catchUp(board).applied).toEqual([h]);
  });

  it('with an unrecorded malformed file, catchUp takes the write lock', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir);
    board.db.exec('PRAGMA busy_timeout = 50');
    const bad = putEvent(events, { v: 1, kind: 'ticket.comment' });
    const lock = holdWriteLock(board);
    try {
      expectBusy(() => catchUp(board));
    } finally {
      lock.release();
    }
    expect(catchUp(board).malformed.map((m) => m.hash)).toEqual([bad]);
  });

  it('with a stale temporary file to reap, catchUp takes the write lock and reaps nothing without it', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir);
    board.db.exec('PRAGMA busy_timeout = 50');
    const stale = join(events, '.tmp-6666666666666666');
    writeFileSync(stale, 'x');
    utimesSync(stale, 0, 0);
    const lock = holdWriteLock(board);
    try {
      expectBusy(() => catchUp(board));
      expect(existsSync(stale)).toBe(true);
    } finally {
      lock.release();
    }
    expect(catchUp(board).reaped).toEqual([stale]);
  });
});

describe('late events that are themselves rejected or unknown', () => {
  it('a late event rejected at its position still triggers a refold (it would apply incrementally)', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    putEvent(events, ev(P.move(T1, 'tests'), 'orch', 3000));
    const board = openB(dir);
    // At wall 2000 the ticket is still in todo, so this move is invalid there,
    // although applying it to the current state (tests) would succeed.
    const late = putEvent(events, ev(P.move(T1, 'implementing'), 'orch', 2000));
    const report = catchUp(board);
    expect(report.refolded).toBe(true);
    expect(report.applied).toEqual([]);
    expect(report.rejected).toEqual([
      { hash: late, kind: 'ticket.move', ticket: T1, reason: 'invalid-transition' },
    ]);
    expect(readTicket(board.db, T1)?.status).toBe('tests');
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(canon(readState(board.db))).toBe(canon(foldDir(events).state));
  });

  it('a late event of an unknown kind still triggers a refold', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    putEvent(events, ev(P.comment(T1, 'c'), 'orch', 3000));
    const board = openB(dir);
    const late = putEvent(events, {
      v: 1,
      kind: 'ticket.estimate',
      ticket: T1,
      actor: 'orch',
      ts: { wall: 2000, counter: 0, actor: 'orch' },
      body: { points: 1 },
    });
    const report = catchUp(board);
    expect(report.refolded).toBe(true);
    expect(report.unknown.map((u) => u.hash)).toEqual([late]);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });
});

describe('an event file tampered with after it was recorded', () => {
  it('is invisible to catch-up but reported by rebuild --check and rebuild', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    const comment = putEvent(events, ev(P.comment(T1, 'original'), 'orch', 2000));
    const board = openB(dir);
    const dump = dumpCache(board.db);
    const path = join(events, `${comment}.json`);
    // Overwrite in place with another valid event: the name no longer matches.
    writeFileSync(path, canonicalEncode(ev(P.comment(T1, 'forged'), 'orch', 2000)));

    const report = catchUp(board);
    expect(report.applied).toEqual([]);
    expect(report.corrupt).toEqual([]);
    expect(dumpCache(board.db)).toBe(dump);
    expect(readTicket(board.db, T1)?.comments.map((c) => c.text)).toEqual(['original']);

    const check = checkCache(board);
    expect(check.ok).toBe(false);
    expect(check.report.corruptFiles.map((c) => c.path)).toEqual([path]);
    expect(check.differences.some((d) => d.table === 'comments' && d.ticket === T1)).toBe(true);
    expect(dumpCache(board.db)).toBe(dump);

    const rebuilt = rebuild(board);
    expect(rebuilt.corruptFiles.map((c) => c.path)).toEqual([path]);
    expect(readTicket(board.db, T1)?.comments).toEqual([]);
  });
});

describe('readTicket and readState', () => {
  it('reconstruct exactly the folded state for every column', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    seedRich(events);
    const board = openB(dir);
    const expected = foldDir(events).state;
    for (const id of Object.keys(expected.tickets)) {
      expect(readTicket(board.db, id)).toEqual(expected.tickets[id]);
    }
    expect(canon(readState(board.db))).toBe(canon(expected));
    expect(readState(board.db).meta).toEqual({ columns: ['todo', 'doing'] });
  });

  it('returns null for an unknown id and an empty state for an empty board', () => {
    const board = openB(tempBoard());
    expect(readTicket(board.db, MISSING)).toBeNull();
    expect(canon(readState(board.db))).toBe(canon({ tickets: {}, meta: {} }));
  });

  it('stores the documented column encodings', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    seedRich(events);
    const board = openB(dir);
    const t1 = board.db.prepare('SELECT * FROM tickets WHERE id = ?').get(T1) as Row;
    expect(t1).toMatchObject({
      title: 'First',
      description: 'desc',
      status: 'blocked',
      blocked_from: 'implementing',
      assignee: 'rev',
      created_by: 'orch',
      created_at: '0000000000001000-0000000000000000-orch',
      updated_at: '0000000000002600-0000000000000000-rev',
      task_source: 'openspec',
      task_ref: 'add-board-core',
      task_item: '2',
      adhoc: null,
      labels: '["store"]',
      closed: 1,
      decision: 'docs/adr/0002-x.md',
      checklist: '[{"done":false,"text":"one"},{"done":true,"text":"two"}]',
    });
    const t2 = board.db.prepare('SELECT * FROM tickets WHERE id = ?').get(T2) as Row;
    expect(t2).toMatchObject({ closed: 1, decision: null, adhoc: null, task_source: 'openspec' });
    const links = board.db
      .prepare('SELECT seq, kind, value FROM links WHERE ticket = ? ORDER BY seq')
      .all(T1) as Row[];
    expect(links).toEqual([
      { seq: 0, kind: 'pr', value: '42' },
      { seq: 1, kind: 'pr', value: '"https://example.invalid/pr/1"' },
      { seq: 2, kind: 'decision', value: '"docs/adr/0002-x.md"' },
    ]);
    const comments = board.db
      .prepare('SELECT seq, actor, text FROM comments WHERE ticket = ? ORDER BY seq')
      .all(T1) as Row[];
    expect(comments).toEqual([
      { seq: 0, actor: 'impl', text: 'first comment' },
      { seq: 1, actor: 'impl', text: 'over to you' },
      { seq: 2, actor: 'amy', text: 'same wall, other actor' },
      { seq: 3, actor: 'zed', text: 'same wall' },
    ]);
    const meta = board.db
      .prepare("SELECT value FROM meta WHERE key = 'board.columns'")
      .get() as Row;
    expect(meta.value).toBe('["todo","doing"]');
  });
});

describe('dumpCache', () => {
  it('is canonical JSON of the derived tables, rows in primary key order, without cursors', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const board = openB(dir);
    const text = dumpCache(board.db);
    const parsed = canonicalDecode(new TextEncoder().encode(text)) as Record<string, Row[]>;
    expect(Object.keys(parsed)).toEqual([...DUMP_TABLES]);
    expect(DUMP_TABLES).toEqual(['comments', 'folded', 'links', 'meta', 'tickets']);
    const ids = (parsed.tickets ?? []).map((r) => String(r.id));
    expect(ids).toEqual([...ids].sort());
    const hashes = (parsed.folded ?? []).map((r) => String(r.hash));
    expect(hashes).toEqual([...hashes].sort());
    // Ticket ids are 26 characters and seq is small, so a padded key sorts correctly.
    const comments = (parsed.comments ?? []).map(
      (r) => `${String(r.ticket)}#${String(r.seq).padStart(6, '0')}`,
    );
    expect(comments.length).toBeGreaterThan(1);
    expect(comments).toEqual([...comments].sort());
    expect(parsed.tickets?.[0]).toHaveProperty('checklist');
    expect(parsed.tickets?.[0]).toHaveProperty('blocked_from');
  });

  it('ignores cursor rows', () => {
    const board = openB(tempBoard());
    const before = dumpCache(board.db);
    board.db
      .prepare(
        "INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES ('a', 1, 0, 'a', 'h')",
      )
      .run();
    expect(dumpCache(board.db)).toBe(before);
  });

  it('changes when a derived row changes', () => {
    const dir = tempBoard();
    seedRich(join(dir, 'events'));
    const board = openB(dir);
    const before = dumpCache(board.db);
    board.db.prepare("UPDATE tickets SET title = 'x' WHERE id = ?").run(T1);
    expect(dumpCache(board.db)).not.toBe(before);
  });
});

/**
 * A view of `db` that, right after the first statement read (get, all or
 * iterate) made through it, runs `write` once: a writer on another
 * connection committing in the middle of a multi-statement read.
 */
function interleaved(db: DatabaseSync, write: () => void): DatabaseSync {
  let fired = false;
  const afterFirstRead = (): void => {
    if (!fired) {
      fired = true;
      write();
    }
  };
  const wrap = (statement: StatementSync): StatementSync =>
    new Proxy(statement, {
      get(target, prop): unknown {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') {
          return value;
        }
        if (prop === 'get' || prop === 'all' || prop === 'iterate') {
          return (...args: unknown[]): unknown => {
            const result: unknown = value.apply(target, args);
            afterFirstRead();
            return result;
          };
        }
        return value.bind(target);
      },
    });
  return new Proxy(db, {
    get(target, prop): unknown {
      if (prop === 'prepare') {
        return (sql: string): StatementSync => wrap(target.prepare(sql));
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('readTicket and readState read one snapshot', () => {
  /** A board with T1 created and commented twice (version 3), and a second connection to it. */
  function seeded(): { board: Board; other: Board; late: () => void } {
    const events = tempBoard();
    putEvent(join(events, 'events'), ev(P.create(T1), 'orch', 1000));
    putEvent(join(events, 'events'), ev(P.comment(T1, 'one'), 'orch', 2000));
    putEvent(join(events, 'events'), ev(P.comment(T1, 'two'), 'orch', 3000));
    const board = openB(events);
    const other = openB(events);
    const late = (): void => {
      runCommand(other, 'late', () => ({ ok: true, event: P.comment(T1, 'late') }), { env: {} });
    };
    return { board, other, late };
  }

  it('readTicket: a commit between its statements is invisible, so version matches comments', () => {
    const { board, late } = seeded();
    const ticket = readTicket(interleaved(board.db, late), T1);
    expect(ticket?.version).toBe(3);
    expect(ticket?.comments.map((c) => c.text)).toEqual(['one', 'two']);
    expect(board.db.isTransaction).toBe(false);
    // The write did happen, and the next read sees all of it.
    const after = readTicket(board.db, T1);
    expect(after?.version).toBe(4);
    expect(after?.comments).toHaveLength(3);
  });

  it('readState: a commit between its statements is invisible', () => {
    const { board, late } = seeded();
    const state = readState(interleaved(board.db, late));
    const ticket = state.tickets[T1];
    expect(ticket?.version).toBe(3);
    expect(ticket?.comments).toHaveLength(2);
    expect(board.db.isTransaction).toBe(false);
    expect(readState(board.db).tickets[T1]?.comments).toHaveLength(3);
  });

  it('reads inside the caller transaction without starting another', () => {
    const { board } = seeded();
    board.db.exec('BEGIN');
    try {
      expect(readTicket(board.db, T1)?.version).toBe(3);
      expect(Object.keys(readState(board.db).tickets)).toEqual([T1]);
      expect(board.db.isTransaction).toBe(true);
    } finally {
      board.db.exec('ROLLBACK');
    }
  });

  it('never waits for the write lock held by another connection', () => {
    const { board, other } = seeded();
    other.db.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      expect(readTicket(board.db, T1)?.version).toBe(3);
      expect(readState(board.db).tickets[T1]?.version).toBe(3);
      expect(Date.now() - started).toBeLessThan(BUSY_TIMEOUT_MS / 5);
    } finally {
      other.db.exec('ROLLBACK');
    }
  });
});
