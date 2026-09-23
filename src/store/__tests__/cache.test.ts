import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalDecode } from '../../events/canonical.js';
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
