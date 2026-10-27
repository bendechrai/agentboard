/**
 * keep-cursors-on-upgrade, tasks 1.1 and 1.2 (board-cache: "Cache is
 * derived and disposable"; design.md: "Carry the cursor tables inside the
 * recreate's transaction", "The expected shape", "Remember what the old
 * cache applied until the first fold", "Why no event is skipped").
 *
 * The old caches are the 0.2.0 fixtures of `v020-cache.ts` (made by the
 * published 0.2.0) or constructions from the verbatim 0.2.0 and 0.1.0
 * schemas; never today's schema with the version row changed. Expected
 * rows are read from the old cache with `node:sqlite` directly.
 */

import { readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { readInbox, type InboxEntry } from '../../board/inbox.js';
import { openBoard, type Board } from '../board.js';
import { CACHE_FILE, CACHE_SCHEMA_VERSION, dumpCache, openCache } from '../cache.js';
import { isPending, type Cursor } from '../cursors.js';
import { priorApplied, recordedFlags } from '../engine.js';
import { checkCache, diffCaches, rebuild } from '../rebuild.js';
import { P, T1, copyBoard, ev, putEvent, tempBoard } from './helpers.js';
import {
  atMinute,
  carriedApplied,
  constructCache,
  corruptRecords,
  corruptRootPage,
  cursorRows,
  effectiveHashes,
  fixtureBoard,
  fixtureEvents,
  foldedRows,
  hasTable,
  lateHashes,
  minuteOf,
  readOldRows,
  rowPositionOf,
  withDb,
  type FixtureName,
  type OldRows,
  type Row,
} from './v020-cache.js';

const open: Board[] = [];
const dbs: DatabaseSync[] = [];

function openB(dir: string, options?: Parameters<typeof openBoard>[1]): Board {
  const board = openBoard(dir, options);
  open.push(board);
  return board;
}

function openC(path: string): DatabaseSync {
  const db = openCache(path);
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
});

const HOUR = 3_600_000;

function cachePath(dir: string): string {
  return join(dir, CACHE_FILE);
}

function version(db: DatabaseSync): unknown {
  return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}

/** Minutes of inbox entries, in the order returned. */
function minutes(entries: readonly InboxEntry[]): number[] {
  return entries.map((e) => minuteOf(e.ts.wall));
}

/** A fixture board, its old rows and its events. */
function fixture(
  name: FixtureName,
  options?: { late?: boolean },
): { dir: string; old: OldRows; events: ReturnType<typeof fixtureEvents> } {
  const dir = fixtureBoard(name, options);
  return { dir, old: readOldRows(cachePath(dir)), events: fixtureEvents(join(dir, 'events')) };
}

function cursorOf(old: OldRows, actor: string): Row {
  const row = old.cursors.find((r) => r.actor === actor);
  if (row === undefined) {
    throw new Error(`fixture has no cursor for ${actor}`);
  }
  return row;
}

function seenOf(old: OldRows, actor: string): Set<string> {
  return new Set(old.seen.filter((r) => r.actor === actor).map((r) => String(r.hash)));
}

/** The `cursors` row now stored for `actor`. */
function storedCursor(db: DatabaseSync, actor: string): Row | undefined {
  const row = db.prepare('SELECT * FROM cursors WHERE actor = ?').get(actor);
  return row === undefined ? undefined : { ...row };
}

/** The `cursors` row that points at `hash` (with its timestamp). */
function cursorAt(
  actor: string,
  event: { hash: string; event: { ts: { wall: number; counter: number; actor: string } } },
): Row {
  return {
    actor,
    last_wall: event.event.ts.wall,
    last_counter: event.event.ts.counter,
    last_actor: event.event.ts.actor,
    last_hash: event.hash,
  };
}

// ---------------------------------------------------------------------------
// 1.1 The carry in openCache

describe('openCache carries the cursor tables of an earlier schema version (1.1)', () => {
  it('a 0.2.0 cache: schema version 5, cursors and cursor_seen rows equal to the old ones, carried_applied equal to the old applied hashes, derived tables empty', () => {
    const { dir, old } = fixture('plain');
    expect(withDb(cachePath(dir), version)).toBe('4');
    expect(old.cursors.map((r) => r.actor)).toEqual(['alice', 'bob']);
    expect(old.seen.length).toBeGreaterThan(0);

    const db = openC(cachePath(dir));
    expect(version(db)).toBe(String(CACHE_SCHEMA_VERSION));
    const now = cursorRows(db);
    expect(now.cursors).toEqual(old.cursors);
    expect(now.seen).toEqual(old.seen);
    expect(carriedApplied(db)).toEqual(old.applied);
    // Nothing derived until the first catch-up.
    for (const table of ['tickets', 'comments', 'links', 'waiters', 'folded']) {
      expect(count(db, table)).toBe(0);
    }
    expect(
      db
        .prepare('SELECT key, value FROM meta ORDER BY key')
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([
      { key: 'last_position', value: 'null' },
      { key: 'schema_version', value: String(CACHE_SCHEMA_VERSION) },
    ]);
    // The current schema: tickets has the schema 5 columns.
    const columns = db
      .prepare('PRAGMA table_info(tickets)')
      .all()
      .map((r) => String(r.name));
    expect(columns).toContain('superseded');
  });

  it('carries only the folded = 1 hashes: the unknown kinds 0.2.0 recorded are not in carried_applied', () => {
    const { dir, old } = fixture('unknown');
    const unknown = foldedRows(cachePath(dir)).filter((r) => r.reason === 'unknown-kind');
    expect(unknown).toHaveLength(3);
    const db = openC(cachePath(dir));
    const carried = carriedApplied(db);
    expect(carried).toEqual(old.applied);
    for (const row of unknown) {
      expect(carried).not.toContain(row.hash);
    }
    expect(cursorRows(db).cursors).toEqual(old.cursors);
    expect(cursorRows(db).seen).toEqual(old.seen);
  });

  it('a schema 1 cache (the 0.1.0 SCHEMA text verbatim) carries the same way', () => {
    const { dir, old } = fixture('plain');
    const rows = foldedRows(cachePath(dir));
    rmSync(cachePath(dir));
    constructCache(cachePath(dir), '0.1.0', { cursors: old.cursors, seen: old.seen, folded: rows });
    expect(withDb(cachePath(dir), version)).toBe('1');
    const db = openC(cachePath(dir));
    expect(version(db)).toBe(String(CACHE_SCHEMA_VERSION));
    expect(cursorRows(db).cursors).toEqual(old.cursors);
    expect(cursorRows(db).seen).toEqual(old.seen);
    expect(carriedApplied(db)).toEqual(old.applied);
    expect(count(db, 'folded')).toBe(0);
  });

  it('a constructed 0.2.0 cache (the 0.2.0 SCHEMA text verbatim) carries the same way', () => {
    const { dir, old } = fixture('unknown');
    const rows = foldedRows(cachePath(dir));
    rmSync(cachePath(dir));
    constructCache(cachePath(dir), '0.2.0', { cursors: old.cursors, seen: old.seen, folded: rows });
    const db = openC(cachePath(dir));
    expect(cursorRows(db).cursors).toEqual(old.cursors);
    expect(cursorRows(db).seen).toEqual(old.seen);
    expect(carriedApplied(db)).toEqual(old.applied);
  });

  it('declared types compare case-insensitively, and extra folded columns do not matter', () => {
    const { dir, old } = fixture('plain');
    withDb(cachePath(dir), (db) => {
      db.exec(`ALTER TABLE cursors RENAME TO cursors_old;
        CREATE TABLE cursors (
          actor        text PRIMARY KEY,
          last_wall    integer,
          last_counter Integer,
          last_actor   Text,
          last_hash    TEXT
        );
        INSERT INTO cursors SELECT * FROM cursors_old;
        DROP TABLE cursors_old;
        ALTER TABLE folded ADD COLUMN later TEXT;`);
    });
    const db = openC(cachePath(dir));
    expect(cursorRows(db).cursors).toEqual(old.cursors);
    expect(cursorRows(db).seen).toEqual(old.seen);
    expect(carriedApplied(db)).toEqual(old.applied);
  });

  const noCarry: [string, string][] = [
    ['cursor_seen missing', 'DROP TABLE cursor_seen'],
    ['cursors missing', 'DROP TABLE cursors'],
    ['folded missing', 'DROP TABLE folded'],
    ['cursors with an extra column', 'ALTER TABLE cursors ADD COLUMN note TEXT'],
    ['cursors with last_wall missing', 'ALTER TABLE cursors DROP COLUMN last_wall'],
    [
      'cursors.last_wall declared TEXT',
      `ALTER TABLE cursors RENAME TO cursors_old;
       CREATE TABLE cursors (actor TEXT PRIMARY KEY, last_wall TEXT, last_counter INTEGER,
         last_actor TEXT, last_hash TEXT);
       INSERT INTO cursors SELECT * FROM cursors_old;
       DROP TABLE cursors_old;`,
    ],
    [
      'cursors.actor not the primary key',
      `ALTER TABLE cursors RENAME TO cursors_old;
       CREATE TABLE cursors (actor TEXT, last_wall INTEGER, last_counter INTEGER,
         last_actor TEXT, last_hash TEXT);
       INSERT INTO cursors SELECT * FROM cursors_old;
       DROP TABLE cursors_old;`,
    ],
    ['cursor_seen with an extra column', 'ALTER TABLE cursor_seen ADD COLUMN note TEXT'],
    [
      'cursor_seen without its primary key',
      `ALTER TABLE cursor_seen RENAME TO seen_old;
       CREATE TABLE cursor_seen (actor TEXT NOT NULL, hash TEXT NOT NULL, wall INTEGER NOT NULL);
       INSERT INTO cursor_seen SELECT * FROM seen_old;
       DROP TABLE seen_old;`,
    ],
    ['folded without the folded column', 'ALTER TABLE folded DROP COLUMN folded'],
    [
      'folded.hash not the primary key',
      `ALTER TABLE folded RENAME TO folded_old;
       CREATE TABLE folded (hash TEXT, folded INTEGER NOT NULL, reason TEXT, position TEXT);
       INSERT INTO folded SELECT * FROM folded_old;
       DROP TABLE folded_old;`,
    ],
    [
      'a stored version of 6 (a later version)',
      "UPDATE meta SET value = '6' WHERE key = 'schema_version'",
    ],
    ['a stored version of 999', "UPDATE meta SET value = '999' WHERE key = 'schema_version'"],
    ['a stored version of abc', "UPDATE meta SET value = 'abc' WHERE key = 'schema_version'"],
    ['a stored version of 0', "UPDATE meta SET value = '0' WHERE key = 'schema_version'"],
    ['a stored version of -1', "UPDATE meta SET value = '-1' WHERE key = 'schema_version'"],
    ['a stored version of 4.0', "UPDATE meta SET value = '4.0' WHERE key = 'schema_version'"],
    ['a stored version of 04', "UPDATE meta SET value = '04' WHERE key = 'schema_version'"],
    ['a stored version of " 4"', "UPDATE meta SET value = ' 4' WHERE key = 'schema_version'"],
    ['no schema_version row', "DELETE FROM meta WHERE key = 'schema_version'"],
    ['no meta table', 'DROP TABLE meta'],
  ];

  it.each(noCarry)('no carry and no cursor rows for %s', (_label, sql) => {
    const { dir } = fixture('plain');
    withDb(cachePath(dir), (db) => {
      db.exec(sql);
    });
    const db = openC(cachePath(dir));
    expect(version(db)).toBe(String(CACHE_SCHEMA_VERSION));
    expect(count(db, 'cursors')).toBe(0);
    expect(count(db, 'cursor_seen')).toBe(0);
    expect(carriedApplied(db)).toBeNull();
  });

  it('scenario: cache without the expected cursor tables loses its cursors, and each actor is given every effective event', () => {
    const { dir, events } = fixture('plain');
    withDb(cachePath(dir), (db) => {
      db.exec('ALTER TABLE cursors ADD COLUMN note TEXT');
    });
    const board = openB(dir);
    expect(count(board.db, 'cursors')).toBe(0);
    const all = events.map((e) => e.minute);
    expect(minutes(readInbox(board, 'alice', { peek: true }).entries)).toEqual(all);
    expect(minutes(readInbox(board, 'bob', { peek: true }).entries)).toEqual(all);
  });

  it('a non-cache file is recreated as today, with no cursors', () => {
    const dir = tempBoard();
    writeFileSync(cachePath(dir), '');
    const db = openC(cachePath(dir));
    expect(version(db)).toBe(String(CACHE_SCHEMA_VERSION));
    expect(count(db, 'cursors')).toBe(0);
    expect(carriedApplied(db)).toBeNull();
  });

  it('a current (schema 5) cache is not recreated: cursors are untouched and no carried_applied is created', () => {
    const { dir } = fixture('plain');
    const board = openB(dir);
    readInbox(board, 'carol');
    const before = cursorRows(board.db);
    board.close();
    open.pop();
    const db = openC(cachePath(dir));
    expect(cursorRows(db)).toEqual(before);
    expect(carriedApplied(db)).toBeNull();
  });

  it('leaves out an ill-typed cursors row and its seen rows, an ill-typed seen row and stray seen rows, and ill-typed folded rows, carrying the rest', () => {
    const { dir, old } = fixture('plain');
    const aliceSeen = old.seen.filter((r) => r.actor === 'alice');
    const victim = String(aliceSeen[0]?.hash);
    withDb(cachePath(dir), (db) => {
      db.exec(`
        INSERT INTO cursors VALUES ('dave', 'soon', 0, 'impl', 'h');
        INSERT INTO cursor_seen VALUES ('dave', 'dddd', 1);
        INSERT INTO cursors VALUES ('erin', NULL, 0, 'impl', 'h');
        INSERT INTO cursor_seen VALUES ('erin', 'eeee', 1);
        INSERT INTO cursors VALUES ('fay', 1, 0, 'impl', X'00');
        INSERT INTO cursors VALUES (X'07', 1, 0, 'impl', 'h');
        INSERT INTO cursors VALUES ('frank', NULL, NULL, NULL, NULL);
        INSERT INTO cursor_seen VALUES ('frank', 'ffff', 5);
        INSERT INTO cursor_seen VALUES ('ghost', 'gggg', 1);
        INSERT INTO cursor_seen VALUES ('bob', X'01', 1);
        INSERT INTO folded VALUES ('two', 2, NULL, NULL);
        INSERT INTO folded VALUES (X'02', 1, NULL, NULL);
        INSERT INTO folded VALUES ('text-flag', '1x', NULL, NULL);
      `);
      db.prepare("UPDATE cursor_seen SET wall = 'late' WHERE actor = 'alice' AND hash = ?").run(
        victim,
      );
    });
    const db = openC(cachePath(dir));
    const now = cursorRows(db);
    expect(now.cursors).toEqual([
      ...old.cursors,
      { actor: 'frank', last_wall: null, last_counter: null, last_actor: null, last_hash: null },
    ]);
    expect(now.seen).toEqual(
      [
        ...old.seen.filter((r) => r.hash !== victim),
        { actor: 'frank', hash: 'ffff', wall: 5 },
      ].sort(
        (a, b) =>
          String(a.actor).localeCompare(String(b.actor)) ||
          (String(a.hash) < String(b.hash) ? -1 : 1),
      ),
    );
    expect(carriedApplied(db)).toEqual(old.applied);
  });

  it('a corrupted cursors table (SQLITE_CORRUPT on read) recreates the cache with no cursors instead of failing the open', () => {
    const { dir } = fixture('plain');
    corruptRecords(cachePath(dir), 'cursors');
    expect(() => withDb(cachePath(dir), (db) => db.prepare('SELECT * FROM cursors').all())).toThrow(
      /malformed/,
    );
    const db = openC(cachePath(dir));
    expect(version(db)).toBe(String(CACHE_SCHEMA_VERSION));
    expect(count(db, 'cursors')).toBe(0);
    expect(count(db, 'cursor_seen')).toBe(0);
    expect(carriedApplied(db)).toBeNull();
  });

  it('a corrupted cursor_seen table recreates the cache with no cursors instead of failing the open', () => {
    const { dir } = fixture('plain');
    corruptRecords(cachePath(dir), 'cursor_seen');
    const db = openC(cachePath(dir));
    expect(version(db)).toBe(String(CACHE_SCHEMA_VERSION));
    expect(count(db, 'cursors')).toBe(0);
    expect(count(db, 'cursor_seen')).toBe(0);
    expect(carriedApplied(db)).toBeNull();
  });

  it('a corruption that makes the recreate itself fail still fails the open, as today', () => {
    const { dir } = fixture('plain');
    corruptRootPage(cachePath(dir), 'cursors');
    expect(() => openCache(cachePath(dir))).toThrow(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// 1.2 The prior applied set

describe('priorApplied (1.2)', () => {
  it('is recordedFlags when folded has rows, ignoring a stale carried_applied', () => {
    const dir = tempBoard();
    putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
    putEvent(join(dir, 'events'), ev(P.comment('01CAAAAAAAAAAAAAAAAAAAAAAA', 'x'), 'orch', 2000));
    const board = openB(dir);
    board.db.exec(
      "CREATE TABLE carried_applied (hash TEXT PRIMARY KEY); INSERT INTO carried_applied VALUES ('zzz')",
    );
    expect([...priorApplied(board.db)].sort()).toEqual([...recordedFlags(board.db)].sort());
    expect(priorApplied(board.db).has('zzz')).toBe(false);
    expect(carriedApplied(board.db)).toEqual(['zzz']);
  });

  it('is the carried hashes, each mapped to 1, when folded is empty, and reads without dropping', () => {
    const { dir, old } = fixture('unknown');
    const db = openC(cachePath(dir));
    const prior = priorApplied(db);
    expect([...prior.keys()].sort()).toEqual(old.applied);
    expect([...prior.values()].every((v) => v === 1)).toBe(true);
    expect(carriedApplied(db)).toEqual(old.applied);
  });

  it('is empty when folded is empty and there is no carried_applied', () => {
    const db = openC(join(tempBoard(), CACHE_FILE));
    expect(priorApplied(db).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1.2 The first fold after the upgrade

/** How the first fold runs: a command's catch-up, or rebuild. */
type FirstFold = 'catch-up' | 'rebuild';

function upgrade(
  dir: string,
  how: FirstFold,
): { board: Board; late: ReturnType<typeof rebuild>['late'] | null } {
  if (how === 'catch-up') {
    return { board: openB(dir), late: null };
  }
  const board = openB(dir, { catchUp: false });
  return { board, late: rebuild(board).late };
}

describe.each<FirstFold>(['catch-up', 'rebuild'])(
  'the first fold after the upgrade, by %s (1.2)',
  (how) => {
    it("scenario: upgrade from a 0.2.0 cache keeps every actor's position", () => {
      const { dir, old, events } = fixture('plain');
      const { board, late } = upgrade(dir, how);
      if (late !== null) {
        expect(late).toEqual([]);
      }
      // Both cursors kept, rows unchanged, by the fold too.
      expect(cursorRows(board.db).cursors).toEqual(old.cursors);
      expect(cursorRows(board.db).seen).toEqual(old.seen);
      expect(carriedApplied(board.db)).toBeNull();

      // alice: cursor at minute 30 (within an hour of the first event).
      expect(minuteOf(Number(cursorOf(old, 'alice').last_wall))).toBe(30);
      const alice = readInbox(board, 'alice', { peek: true });
      expect(minutes(alice.entries)).toEqual([45, 60, 75, 90, 105, 120, 140, 160, 180, 190]);
      // bob: cursor at minute 180, more than an hour after the first event.
      expect(minuteOf(Number(cursorOf(old, 'bob').last_wall))).toBe(180);
      const bob = readInbox(board, 'bob', { peek: true });
      expect(minutes(bob.entries)).toEqual([190]);
      // None of the events already given.
      for (const [actor, entries] of [
        ['alice', alice.entries],
        ['bob', bob.entries],
      ] as const) {
        const given = seenOf(old, actor);
        const position = String(cursorOf(old, actor).last_hash);
        for (const entry of entries) {
          expect(given.has(entry.hash)).toBe(false);
          expect(entry.hash).not.toBe(position);
        }
      }
      // An actor with no cursor still gets every effective event.
      expect(minutes(readInbox(board, 'carol', { peek: true }).entries)).toEqual(
        events.map((e) => e.minute),
      );
      // Peeking changed nothing; a real inbox returns the same and then nothing.
      expect(cursorRows(board.db).cursors).toEqual(old.cursors);
      expect(minutes(readInbox(board, 'alice').entries)).toEqual(minutes(alice.entries));
      expect(readInbox(board, 'alice').entries).toEqual([]);
      expect(minutes(readInbox(board, 'bob').entries)).toEqual([190]);
    });

    it('scenario: upgrade delivers an event the old version did not apply (behind the window: the cursor moves back; inside it: delivered without moving)', () => {
      const { dir, old, events } = fixture('unknown');
      const supersede = atMinute(events, 10);
      const reconcile = atMinute(events, 15);
      const renumber = atMinute(events, 150);
      const first = atMinute(events, 0);
      expect(supersede.event.kind).toBe('ticket.supersede');
      expect(reconcile.event.kind).toBe('ticket.reconcile');
      expect(renumber.event.kind).toBe('ticket.renumber');
      const { board, late } = upgrade(dir, how);
      if (late !== null) {
        expect(late.map((l) => [l.actor, l.hash, l.cursor.hash])).toEqual([
          ['alice', supersede.hash, cursorOf(old, 'alice').last_hash],
          ['alice', reconcile.hash, cursorOf(old, 'alice').last_hash],
          ['bob', supersede.hash, cursorOf(old, 'bob').last_hash],
          ['bob', reconcile.hash, cursorOf(old, 'bob').last_hash],
        ]);
      }
      expect(carriedApplied(board.db)).toBeNull();

      // alice and bob: more than an hour past the supersede; their cursors
      // move back to the greatest effective event before it (minute 0).
      for (const actor of ['alice', 'bob']) {
        expect(storedCursor(board.db, actor)).toEqual(cursorAt(actor, first));
        // The seen set is kept as it was.
        expect(cursorRows(board.db).seen.filter((r) => r.actor === actor)).toEqual(
          old.seen.filter((r) => r.actor === actor),
        );
        const given = seenOf(old, actor);
        const expected = events
          .filter((e) => e.minute > 0 && !given.has(e.hash))
          .map((e) => e.minute);
        const entries = readInbox(board, actor, { peek: true }).entries;
        expect(minutes(entries)).toEqual(expected);
        expect(entries.map((e) => e.hash)).toContain(supersede.hash);
        expect(entries.map((e) => e.hash)).toContain(renumber.hash);
        // Nothing sorting before the supersede that was already given.
        expect(entries.map((e) => e.hash)).not.toContain(first.hash);
      }

      // carol: cursor at minute 50, the supersede and reconcile inside her
      // window: delivered without moving the cursor.
      expect(storedCursor(board.db, 'carol')).toEqual(cursorOf(old, 'carol'));
      const carol = readInbox(board, 'carol', { peek: true }).entries;
      expect(minutes(carol)).toEqual([10, 15, 70, 90, 110, 130, 150, 160, 170, 180, 190]);
      // A real inbox returns the same entries and acknowledges them.
      expect(minutes(readInbox(board, 'carol').entries)).toEqual(minutes(carol));
      expect(readInbox(board, 'carol').entries).toEqual([]);
      expect(readInbox(board, 'alice').entries.map((e) => e.hash)).toContain(supersede.hash);
    });

    it('scenario: upgrade delivers an event the old cache had not recorded', () => {
      const { dir, old, events } = fixture('plain', { late: true });
      const [lateHash] = lateHashes();
      const lateEvent = events.find((e) => e.hash === lateHash);
      expect(lateEvent?.minute).toBe(20);
      expect(old.recorded).not.toContain(lateHash);
      const { board, late } = upgrade(dir, how);
      if (late !== null) {
        expect(late.map((l) => [l.actor, l.hash])).toEqual([['bob', lateHash]]);
      }
      // bob: more than an hour past it, moved back to the minute 10 event.
      expect(storedCursor(board.db, 'bob')).toEqual(cursorAt('bob', atMinute(events, 10)));
      expect(readInbox(board, 'bob', { peek: true }).entries.map((e) => e.hash)).toContain(
        lateHash,
      );
      // alice: inside her window, delivered without moving the cursor.
      expect(storedCursor(board.db, 'alice')).toEqual(cursorOf(old, 'alice'));
      expect(minutes(readInbox(board, 'alice', { peek: true }).entries)).toEqual([
        20, 45, 60, 75, 90, 105, 120, 140, 160, 180, 190,
      ]);
    });

    it('carried_applied is gone after the first fold, and the canonical dump equals a fresh rebuild before and after it', () => {
      const { dir } = fixture('unknown');
      // Right after the recreate: the dump covers the derived tables only,
      // so the carried set does not show and it equals an empty cache's.
      const recreated = openC(cachePath(dir));
      expect(carriedApplied(recreated)).not.toBeNull();
      const empty = openC(':memory:');
      expect(dumpCache(recreated)).toBe(dumpCache(empty));
      expect(diffCaches(recreated, empty)).toEqual([]);
      recreated.close();
      dbs.splice(dbs.indexOf(recreated), 1);

      const { board } = upgrade(dir, how);
      expect(hasTable(board.db, 'carried_applied')).toBe(false);
      const fresh = openB(copyBoard(join(dir, 'events')));
      expect(dumpCache(board.db)).toBe(dumpCache(fresh.db));
      expect(checkCache(board).ok).toBe(true);
    });
  },
);

describe('a carried_applied found later (1.2)', () => {
  /** A board with a cursor more than an hour past its first event and a stale carried_applied. */
  function staleBoard(stale: string[]): { dir: string; events: string } {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 0));
    for (const h of [1, 2, 3]) {
      putEvent(events, ev(P.comment(T1, `hour ${String(h)}`), 'impl', h * HOUR));
    }
    const board = openB(dir);
    expect(readInbox(board, 'alice').entries).toHaveLength(4);
    board.db.exec('CREATE TABLE carried_applied (hash TEXT PRIMARY KEY)');
    const insert = board.db.prepare('INSERT INTO carried_applied (hash) VALUES (?)');
    for (const hash of stale) {
      insert.run(hash);
    }
    board.close();
    open.pop();
    return { dir, events };
  }

  it('beside a non-empty folded is not consulted: a late event it lists still moves the cursor back, and it is dropped', () => {
    const late = ev(P.comment(T1, 'late'), 'impl', HOUR / 2);
    const lateHash = putEvent(join(tempBoard(), 'events'), late);
    const { dir, events } = staleBoard([lateHash]);
    putEvent(events, late);
    const board = openB(dir);
    expect(board.opened?.refolded).toBe(true);
    expect(hasTable(board.db, 'carried_applied')).toBe(false);
    const entries = readInbox(board, 'alice').entries;
    expect(entries.map((e) => e.hash)).toContain(lateHash);
  });

  it('beside a non-empty folded is dropped by an incremental fold too', () => {
    const { dir, events } = staleBoard(['0'.repeat(64)]);
    putEvent(events, ev(P.comment(T1, 'next'), 'impl', 4 * HOUR));
    const board = openB(dir);
    expect(board.opened?.refolded).toBe(false);
    expect(hasTable(board.db, 'carried_applied')).toBe(false);
  });

  it('is left by a locked catch-up that records nothing', () => {
    const { dir, old } = fixture('plain');
    for (const name of readdirSync(join(dir, 'events'))) {
      rmSync(join(dir, 'events', name));
    }
    const temp = join(dir, 'events', '.tmp-aaaaaaaaaaaaaaaa');
    writeFileSync(temp, 'x');
    const then = (Date.now() - 600_000) / 1000;
    utimesSync(temp, then, then);
    const board = openB(dir);
    expect(board.opened?.reaped).toEqual([temp]);
    expect(carriedApplied(board.db)).toEqual(old.applied);
  });

  it('is not compared by dumpCache, diffCaches or rebuild --check, which leaves it', () => {
    const dir = tempBoard();
    putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
    const board = openB(dir);
    const before = dumpCache(board.db);
    board.db.exec(
      "CREATE TABLE carried_applied (hash TEXT PRIMARY KEY); INSERT INTO carried_applied VALUES ('x')",
    );
    expect(dumpCache(board.db)).toBe(before);
    const fresh = openB(copyBoard(join(dir, 'events')));
    expect(diffCaches(board.db, fresh.db)).toEqual([]);
    expect(checkCache(board).ok).toBe(true);
    expect(carriedApplied(board.db)).toEqual(['x']);
  });
});

describe('the no-skip invariant on the fixtures (1.2)', () => {
  it.each<[FixtureName, boolean]>([
    ['plain', false],
    ['plain', true],
    ['unknown', false],
  ])(
    '%s (with the late file: %s): every effective event is delivered by the first inbox or was delivered before',
    (name, withLate) => {
      const { dir, old, events } = fixture(name, { late: withLate });
      const effective = effectiveHashes(join(dir, 'events'));
      const applied = new Set(old.applied);
      const board = openB(dir);
      for (const row of old.cursors) {
        const actor = String(row.actor);
        const before: Cursor = {
          actor,
          position: rowPositionOf(row),
          seen: old.seen
            .filter((r) => r.actor === actor)
            .map((r) => ({ hash: String(r.hash), wall: Number(r.wall) })),
        };
        const now = new Set(readInbox(board, actor).entries.map((e) => e.hash));
        for (const e of events.filter((x) => effective.has(x.hash))) {
          // Delivered before: applied by the old cache and not pending for
          // the old cursor (the old delivery invariant).
          const deliveredBefore =
            applied.has(e.hash) && !isPending(before, { hash: e.hash, ts: e.event.ts });
          expect(
            now.has(e.hash) || deliveredBefore,
            `${actor} misses minute ${String(e.minute)}`,
          ).toBe(true);
        }
      }
    },
  );
});
