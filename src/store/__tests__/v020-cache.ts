/**
 * Caches made by released versions, for keep-cursors-on-upgrade.
 *
 * Fixtures (`fixtures/v020-cache/`, written by `make-fixture.sh` there,
 * which runs the published 0.2.0 on two scratch boards with a shifted
 * clock; see the script for the exact commands and timeline). Each holds
 * `events/` and the `cache.sqlite` 0.2.0 left (schema version 4, WAL
 * checkpointed):
 *
 * - `plain`: two tickets and comments 0.2.0 knows, at minutes 0 to 190
 *   after `FIXTURE_BASE`; `alice` ran `inbox` at minute 35 (cursor at the
 *   minute 30 event), `bob` at minute 185 (cursor at minute 180); `carol`
 *   never did. `late/` holds one comment at minute 20 that is not in
 *   `events/`: an event file the 0.2.0 cache never recorded.
 * - `unknown`: a `ticket.supersede` at minute 10, a `ticket.reconcile` at
 *   minute 15 and a `ticket.renumber` at minute 150, which 0.2.0 recorded
 *   as unknown kinds (`folded` 0, `unknown-kind`); the only event before
 *   the supersede is the create of the ticket it supersedes (minute 0).
 *   `carol` ran `inbox` at minute 55 (cursor at minute 50), `alice` at
 *   175 (cursor at 170), `bob` at 185 (cursor at 180).
 *
 * Event walls are `FIXTURE_BASE + minute * 60000` plus the few
 * milliseconds a 0.2.0 process ran; `minuteOf` recovers the minute. Ids
 * and hashes are random per generation, so tests read them from the
 * fixture (`fixtureEvents`, `readOldRows`).
 *
 * Constructions: the `SCHEMA` and `CURSOR_SEEN` text of `src/store/cache.ts`
 * at v0.2.0 and v0.1.0, copied verbatim (`git show v0.2.0:src/store/cache.ts`),
 * for caches a test needs with other rows (`constructCache`).
 *
 * Everything here reads and writes SQLite with `node:sqlite` directly and
 * events with the events layer only, never with the store code under test.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { canonicalDecode } from '../../events/canonical.js';
import type { Hlc } from '../../events/hlc.js';
import type { BoardEvent } from '../../events/schema.js';
import { foldDir, makeBoardDir, tempDir } from './helpers.js';

/** The fixture directory. */
export const V020_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'v020-cache',
);

/** The wall of minute 0 of both fixtures (`make-fixture.sh`, clock.mjs). */
export const FIXTURE_BASE = 1_790_000_000_000;

/** The fixture boards. */
export type FixtureName = 'plain' | 'unknown';

/** A row as `node:sqlite` returns it. */
export type Row = Record<string, SQLOutputValue>;

/** The minute of a fixture event's wall. */
export function minuteOf(wall: number): number {
  return Math.floor((wall - FIXTURE_BASE) / 60_000);
}

/** One event file of a fixture, decoded. */
export interface FixtureEvent {
  hash: string;
  event: BoardEvent;
  minute: number;
}

/** Every event file of an events directory, decoded, sorted by wall then hash. */
export function fixtureEvents(eventsDir: string): FixtureEvent[] {
  return readdirSync(eventsDir)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => {
      const event = canonicalDecode(readFileSync(join(eventsDir, name))) as unknown as BoardEvent;
      return { hash: name.slice(0, 64), event, minute: minuteOf(event.ts.wall) };
    })
    .sort((a, b) => a.event.ts.wall - b.event.ts.wall || (a.hash < b.hash ? -1 : 1));
}

/** The event of a fixture at `minute` (exactly one, or the test is wrong). */
export function atMinute(events: readonly FixtureEvent[], minute: number): FixtureEvent {
  const found = events.filter((e) => e.minute === minute);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(
      `expected one fixture event at minute ${String(minute)}, found ${String(found.length)}`,
    );
  }
  return found[0];
}

/**
 * A fresh project whose `.board` holds a copy of fixture `name`: its
 * `events/` (plus the `late/` files when `late` is true) and its
 * `cache.sqlite`. Returns the board directory.
 */
export function fixtureBoard(name: FixtureName, options?: { late?: boolean }): string {
  const board = makeBoardDir(tempDir());
  const source = join(V020_FIXTURES, name);
  cpSync(join(source, 'events'), join(board, 'events'), { recursive: true });
  if (options?.late === true) {
    cpSync(join(source, 'late'), join(board, 'events'), { recursive: true });
  }
  cpSync(join(source, 'cache.sqlite'), join(board, 'cache.sqlite'));
  return board;
}

/** The hashes of the `late/` files of the plain fixture. */
export function lateHashes(): string[] {
  return readdirSync(join(V020_FIXTURES, 'plain', 'late'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, 64))
    .sort();
}

/** The cursor rows of a cache, as SQLite holds them. */
export interface OldRows {
  /** `cursors` rows, sorted by actor. */
  cursors: Row[];
  /** `cursor_seen` rows, sorted by actor then hash. */
  seen: Row[];
  /** Hashes of the `folded` rows with `folded` = 1, sorted. */
  applied: string[];
  /** Hashes of every `folded` row, sorted. */
  recorded: string[];
}

/** Runs `fn` on a raw connection to `path` and closes it. */
export function withDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function plain(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...row }));
}

/** Whether a table exists in the cache open on `db`. */
export function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** The cursor rows and applied hashes of the cache open on `db`. */
export function cursorRows(db: DatabaseSync): OldRows {
  const has = (name: string): boolean => hasTable(db, name);
  return {
    cursors: has('cursors') ? plain(db.prepare('SELECT * FROM cursors ORDER BY actor').all()) : [],
    seen: has('cursor_seen')
      ? plain(db.prepare('SELECT * FROM cursor_seen ORDER BY actor, hash').all())
      : [],
    applied: has('folded')
      ? db
          .prepare('SELECT hash FROM folded WHERE folded = 1 ORDER BY hash')
          .all()
          .map((r) => String(r.hash))
      : [],
    recorded: has('folded')
      ? db
          .prepare('SELECT hash FROM folded ORDER BY hash')
          .all()
          .map((r) => String(r.hash))
      : [],
  };
}

/** `cursorRows` of the cache file at `path`. */
export function readOldRows(path: string): OldRows {
  return withDb(path, cursorRows);
}

/** The hashes in `carried_applied`, sorted, or null when there is no such table. */
export function carriedApplied(db: DatabaseSync): string[] | null {
  if (!hasTable(db, 'carried_applied')) {
    return null;
  }
  return db
    .prepare('SELECT hash FROM carried_applied ORDER BY hash')
    .all()
    .map((r) => String(r.hash));
}

/** SHA-256 of a file's bytes, or null when it does not exist. */
export function fileHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** `fileHash` of a cache file and its WAL and SHM companions. */
export function cacheHashes(path: string): (string | null)[] {
  return ['', '-wal', '-shm'].map((suffix) => fileHash(path + suffix));
}

/** The cursor position a `cursors` row holds, or null for an empty position. */
export function rowPositionOf(row: Row): { hash: string; ts: Hlc } | null {
  const { last_wall: wall, last_counter: counter, last_actor: actor, last_hash: hash } = row;
  if (
    typeof wall !== 'number' ||
    typeof counter !== 'number' ||
    typeof actor !== 'string' ||
    typeof hash !== 'string'
  ) {
    return null;
  }
  return { hash, ts: { wall, counter, actor } };
}

/**
 * Overwrites the record header of every row of `table`'s b-tree root page
 * (a table leaf page, every cell with a one-byte payload size and rowid),
 * so reading any column of the table fails with SQLITE_CORRUPT while
 * listing it in `sqlite_master`, `PRAGMA table_info` and `DROP TABLE` still
 * work. Throws when the page is not such a page (then the test needs
 * another corruption).
 */
export function corruptRecords(path: string, table: string): void {
  const { root, pageSize } = withDb(path, (db) => {
    const row = db.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(table);
    const size = db.prepare('PRAGMA page_size').get();
    return { root: Number(row?.rootpage), pageSize: Number(size?.page_size) };
  });
  const bytes = readFileSync(path);
  const page = (root - 1) * pageSize;
  if (bytes[page] !== 13) {
    throw new Error(`the root page of ${table} is not a table leaf page`);
  }
  const cells = bytes.readUInt16BE(page + 3);
  for (let i = 0; i < cells; i++) {
    const cell = page + bytes.readUInt16BE(page + 8 + 2 * i);
    if ((bytes[cell] ?? 0x80) >= 0x80 || (bytes[cell + 1] ?? 0x80) >= 0x80) {
      throw new Error(`a cell of ${table} has a multi-byte payload size or rowid`);
    }
    // The record header size varint: larger than the payload, so the
    // record cannot be decoded.
    bytes[cell + 2] = 0x7f;
  }
  writeFileSync(path, bytes);
}

/**
 * Overwrites the page type byte of `table`'s root page, so that the table
 * cannot even be dropped (the recreate itself fails).
 */
export function corruptRootPage(path: string, table: string): void {
  const { root, pageSize } = withDb(path, (db) => {
    const row = db.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(table);
    const size = db.prepare('PRAGMA page_size').get();
    return { root: Number(row?.rootpage), pageSize: Number(size?.page_size) };
  });
  const bytes = readFileSync(path);
  bytes[(root - 1) * pageSize] = 0x42;
  writeFileSync(path, bytes);
}

// ---------------------------------------------------------------------------
// Verbatim schemas of released versions

/** `CURSOR_SEEN` of `git show v0.2.0:src/store/cache.ts`, verbatim. */
export const V020_CURSOR_SEEN = `
CREATE TABLE IF NOT EXISTS cursor_seen (
  actor TEXT NOT NULL,
  hash  TEXT NOT NULL,
  wall  INTEGER NOT NULL,
  PRIMARY KEY (actor, hash)
);
`;

/** `SCHEMA` of `git show v0.2.0:src/store/cache.ts` (schema version 4), verbatim. */
export const V020_SCHEMA = `
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS waiters;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS cursors;
DROP TABLE IF EXISTS cursor_seen;
DROP TABLE IF EXISTS folded;
DROP TABLE IF EXISTS meta;
CREATE TABLE tickets (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL,
  blocked_from TEXT,
  assignee     TEXT,
  lease_ttl        INTEGER,
  lease_expires_at INTEGER,
  lease_event      TEXT,
  lease_confirmed  INTEGER,
  available_at     INTEGER,
  available_event  TEXT,
  version      INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  task_source  TEXT,
  task_ref     TEXT,
  task_item    TEXT,
  adhoc        TEXT,
  unplanned    TEXT,
  labels       TEXT NOT NULL,
  closed       INTEGER NOT NULL,
  decision     TEXT,
  checklist    TEXT NOT NULL
);
CREATE TABLE waiters (
  ticket   TEXT NOT NULL REFERENCES tickets(id),
  position INTEGER NOT NULL,
  actor    TEXT NOT NULL,
  ttl      INTEGER NOT NULL,
  hash     TEXT NOT NULL,
  ts       TEXT NOT NULL,
  PRIMARY KEY (ticket, position)
);
CREATE TABLE comments (
  ticket TEXT NOT NULL REFERENCES tickets(id),
  seq    INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  ts     TEXT NOT NULL,
  text   TEXT NOT NULL,
  hash   TEXT NOT NULL,
  PRIMARY KEY (ticket, seq)
);
CREATE TABLE links (
  ticket TEXT NOT NULL REFERENCES tickets(id),
  seq    INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  value  TEXT NOT NULL,
  actor  TEXT NOT NULL,
  ts     TEXT NOT NULL,
  hash   TEXT NOT NULL,
  PRIMARY KEY (ticket, seq)
);
CREATE TABLE cursors (
  actor        TEXT PRIMARY KEY,
  last_wall    INTEGER,
  last_counter INTEGER,
  last_actor   TEXT,
  last_hash    TEXT
);
CREATE TABLE folded (
  hash     TEXT PRIMARY KEY,
  folded   INTEGER NOT NULL,
  reason   TEXT,
  position TEXT
);
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** `CURSOR_SEEN` of `git show v0.1.0:src/store/cache.ts`, verbatim. */
export const V010_CURSOR_SEEN = `
CREATE TABLE IF NOT EXISTS cursor_seen (
  actor TEXT NOT NULL,
  hash  TEXT NOT NULL,
  wall  INTEGER NOT NULL,
  PRIMARY KEY (actor, hash)
);
`;

/** `SCHEMA` of `git show v0.1.0:src/store/cache.ts` (schema version 1), verbatim. */
export const V010_SCHEMA = `
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS cursors;
DROP TABLE IF EXISTS cursor_seen;
DROP TABLE IF EXISTS folded;
DROP TABLE IF EXISTS meta;
CREATE TABLE tickets (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL,
  blocked_from TEXT,
  assignee     TEXT,
  version      INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  task_source  TEXT,
  task_ref     TEXT,
  task_item    TEXT,
  adhoc        TEXT,
  labels       TEXT NOT NULL,
  closed       INTEGER NOT NULL,
  decision     TEXT,
  checklist    TEXT NOT NULL
);
CREATE TABLE comments (
  ticket TEXT NOT NULL REFERENCES tickets(id),
  seq    INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  ts     TEXT NOT NULL,
  text   TEXT NOT NULL,
  hash   TEXT NOT NULL,
  PRIMARY KEY (ticket, seq)
);
CREATE TABLE links (
  ticket TEXT NOT NULL REFERENCES tickets(id),
  seq    INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  value  TEXT NOT NULL,
  actor  TEXT NOT NULL,
  ts     TEXT NOT NULL,
  hash   TEXT NOT NULL,
  PRIMARY KEY (ticket, seq)
);
CREATE TABLE cursors (
  actor        TEXT PRIMARY KEY,
  last_wall    INTEGER,
  last_counter INTEGER,
  last_actor   TEXT,
  last_hash    TEXT
);
CREATE TABLE folded (
  hash     TEXT PRIMARY KEY,
  folded   INTEGER NOT NULL,
  reason   TEXT,
  position TEXT
);
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** One `folded` row as a released version writes it. */
export interface FoldedRow {
  hash: string;
  folded: 0 | 1;
  reason: string | null;
  position: string | null;
}

/** Rows of a constructed cache. */
export interface ConstructedRows {
  cursors: Row[];
  seen: Row[];
  folded: FoldedRow[];
  /** `meta.last_position` (JSON text); defaults to `null`. */
  lastPosition?: string;
}

/**
 * Writes a cache as version `release` would leave it (its `SCHEMA` then
 * `CURSOR_SEEN`, verbatim, in WAL mode, `schema_version` 4 for 0.2.0 and 1
 * for 0.1.0), holding the given cursor, seen and `folded` rows. The derived
 * ticket tables are left empty: the recreate drops them unread.
 */
export function constructCache(
  path: string,
  release: '0.2.0' | '0.1.0',
  rows: ConstructedRows,
): void {
  mkdirSync(dirname(path), { recursive: true });
  withDb(path, (db) => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(release === '0.2.0' ? V020_SCHEMA : V010_SCHEMA);
    db.exec(release === '0.2.0' ? V020_CURSOR_SEEN : V010_CURSOR_SEEN);
    db.exec('BEGIN');
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      release === '0.2.0' ? '4' : '1',
    );
    db.prepare("INSERT INTO meta (key, value) VALUES ('last_position', ?)").run(
      rows.lastPosition ?? 'null',
    );
    const cursor = db.prepare(
      'INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of rows.cursors) {
      cursor.run(
        r.actor ?? null,
        r.last_wall ?? null,
        r.last_counter ?? null,
        r.last_actor ?? null,
        r.last_hash ?? null,
      );
    }
    const seen = db.prepare('INSERT INTO cursor_seen (actor, hash, wall) VALUES (?, ?, ?)');
    for (const r of rows.seen) {
      seen.run(r.actor ?? null, r.hash ?? null, r.wall ?? null);
    }
    const folded = db.prepare(
      'INSERT INTO folded (hash, folded, reason, position) VALUES (?, ?, ?, ?)',
    );
    for (const r of rows.folded) {
      folded.run(r.hash, r.folded, r.reason, r.position);
    }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  });
}

/** Every `folded` row of a cache, as written. */
export function foldedRows(path: string): FoldedRow[] {
  return withDb(path, (db) =>
    db
      .prepare('SELECT hash, folded, reason, position FROM folded ORDER BY hash')
      .all()
      .map((r) => ({
        hash: String(r.hash),
        folded: r.folded === 1 ? 1 : 0,
        reason: r.reason === null ? null : String(r.reason),
        position: r.position === null ? null : String(r.position),
      })),
  );
}

/**
 * The hashes of the events an independent fold (`foldDir`, the events
 * layer only) applies: every well-formed event that is neither rejected
 * nor of an unknown kind.
 */
export function effectiveHashes(eventsDir: string): Set<string> {
  const result = foldDir(eventsDir);
  const out = new Set(fixtureEvents(eventsDir).map((e) => e.hash));
  for (const r of result.rejected) {
    out.delete(r.hash);
  }
  for (const u of result.unknown) {
    out.delete(u.hash);
  }
  return out;
}
