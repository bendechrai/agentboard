/**
 * The derived SQLite cache (board-cache: "Cache is derived and disposable",
 * "Cache schema", "Cache connection settings"; add-board-core design.md: "One transaction
 * per command, event file inside it").
 *
 * The cache holds nothing that cannot be derived from the event files,
 * except the `cursors` table (acknowledgement state owned by `inbox`), which
 * is preserved by rebuilds and excluded from the canonical dump.
 *
 * Schema (version `CACHE_SCHEMA_VERSION`). Timestamps are stored as
 * `encodeHlc` text; JSON columns hold canonical JSON text (`canonicalEncode`
 * decoded as UTF-8); booleans are INTEGER 0 or 1.
 *
 * ```sql
 * CREATE TABLE tickets (
 *   id           TEXT PRIMARY KEY,
 *   title        TEXT NOT NULL,
 *   description  TEXT,            -- null when not given
 *   status       TEXT NOT NULL,
 *   blocked_from TEXT,            -- Ticket.blockedFrom
 *   assignee     TEXT,
 *   lease_ttl        INTEGER,     -- Ticket.lease: the four lease_* columns
 *   lease_expires_at INTEGER,     --   are all null (no lease) or all
 *   lease_event      TEXT,        --   non-null; lease_confirmed is 0 or 1
 *   lease_confirmed  INTEGER,
 *   available_at     INTEGER,     -- Ticket.available: both null or both
 *   available_event  TEXT,        --   non-null
 *   version      INTEGER NOT NULL,
 *   updated_at   TEXT NOT NULL,   -- encodeHlc(Ticket.updatedAt)
 *   created_by   TEXT NOT NULL,
 *   created_at   TEXT NOT NULL,   -- encodeHlc(Ticket.createdAt)
 *   task_source  TEXT,            -- the three task_* columns are all null
 *   task_ref     TEXT,            --   (no task) or all non-null
 *   task_item    TEXT,
 *   adhoc        TEXT,
 *   unplanned    TEXT,            -- Ticket.unplanned as canonical JSON
 *                                 --   {"actor","reason","ts"}; null without one
 *   labels       TEXT NOT NULL,   -- JSON array of strings
 *   closed       INTEGER NOT NULL,
 *   superseded   TEXT,            -- Ticket.superseded: the supersede reason,
 *                                 --   null when not superseded
 *   decision     TEXT,            -- decision path when closed with one;
 *                                 --   null when open or closed with noDecision
 *   checklist    TEXT NOT NULL    -- JSON array of {"done":bool,"text":string},
 *                                 --   plus "removed":true on a removed line
 *                                 --   (Ticket.checklist, canonical JSON)
 * );
 * CREATE TABLE waiters (
 *   ticket   TEXT NOT NULL REFERENCES tickets(id),
 *   position INTEGER NOT NULL,    -- 0-based index in Ticket.queue
 *   actor    TEXT NOT NULL,
 *   ttl      INTEGER NOT NULL,
 *   hash     TEXT NOT NULL,       -- Waiter.event, the join event
 *   ts       TEXT NOT NULL,       -- encodeHlc(Waiter.joined)
 *   PRIMARY KEY (ticket, position)
 * );
 * CREATE TABLE comments (
 *   ticket TEXT NOT NULL REFERENCES tickets(id),
 *   seq    INTEGER NOT NULL,      -- 0-based index in Ticket.comments
 *   actor  TEXT NOT NULL,
 *   ts     TEXT NOT NULL,         -- encodeHlc
 *   text   TEXT NOT NULL,
 *   hash   TEXT NOT NULL,
 *   PRIMARY KEY (ticket, seq)
 * );
 * CREATE TABLE links (
 *   ticket TEXT NOT NULL REFERENCES tickets(id),
 *   seq    INTEGER NOT NULL,      -- 0-based index in Ticket.links
 *   kind   TEXT NOT NULL,         -- 'pr' or 'decision'
 *   value  TEXT NOT NULL,         -- JSON of the pr (string or number) or path
 *   actor  TEXT NOT NULL,
 *   ts     TEXT NOT NULL,
 *   hash   TEXT NOT NULL,
 *   PRIMARY KEY (ticket, seq)
 * );
 * CREATE TABLE cursors (
 *   actor        TEXT PRIMARY KEY,
 *   last_wall    INTEGER,
 *   last_counter INTEGER,
 *   last_actor   TEXT,
 *   last_hash    TEXT
 * );
 * CREATE TABLE folded (
 *   hash     TEXT PRIMARY KEY,
 *   folded   INTEGER NOT NULL,    -- 1 applied (known kind), 0 otherwise
 *   reason   TEXT,                -- null when applied; else a fold
 *                                 --   RejectionReason, 'unknown-kind' or
 *                                 --   'malformed'
 *   position TEXT                 -- encodeHlc(ts); null for malformed
 * );
 * CREATE TABLE meta (
 *   key   TEXT PRIMARY KEY,
 *   value TEXT NOT NULL
 * );
 * ```
 *
 * `meta` rows: `schema_version` (decimal text of `CACHE_SCHEMA_VERSION`);
 * `last_position` (JSON `{"hash":...,"ts":{...}}` of the greatest
 * well-formed event in fold order, or `null`); and one row per board meta
 * key `k` from `board.meta` events, keyed `board.<k>` with the JSON of its
 * value; and `grant_watermark` (a JSON number: the slot time of the first
 * grant that would be due and is not folded; absent when there is none,
 * see `FoldSession` in `src/store/engine.ts`). Every table above has
 * exactly these columns.
 *
 * Every event file with a valid name is recorded in `folded` once it has
 * been read (applied, rejected, unknown kind or malformed), so catch-up
 * reads only files not yet recorded, and the whole log only once the clock
 * reaches `grant_watermark`. Corrupt files (a name that is not
 * `<sha256>.json` of the bytes) are never recorded and are reported by every
 * catch-up and rebuild. Dot-named entries of `events/` (temporary files,
 * `.gitkeep`) are ignored entirely, as `listEventFiles` documents.
 *
 * The `cursors` table is the one non-derivable table (board-cache: losing
 * cursors only causes redelivery, never a skipped event): `rebuild` keeps its
 * rows and `rebuild --check` does not compare it.
 *
 * Cursor seen sets (`src/store/cursors.ts`) are stored in one
 * more table, `cursor_seen (actor, hash, wall)`, documented there. It is
 * part of the cursors and is treated exactly like `cursors`: kept by
 * `rebuild`, not covered by `dumpCache` or `rebuild --check`, and carried
 * with it across a schema upgrade (below). The schema step does not create
 * it on a recreate that carries nothing: `openCache` creates it, when
 * missing, on every preparing open, after the schema step.
 *
 * Schema upgrade (board-cache: "Cache is derived and disposable";
 * keep-cursors-on-upgrade design.md). When a preparing open finds a stored
 * version that is an earlier one (the exact decimal text of an integer from
 * 1 to `CACHE_SCHEMA_VERSION - 1`), the recreate keeps the cursor tables:
 * inside its `BEGIN IMMEDIATE` it reads the old `cursors` and `cursor_seen`
 * rows and the hashes the old `folded` table records as applied, drops and
 * recreates every table, and writes the cursor rows back and the applied
 * hashes into a transient table that only such a recreate creates:
 *
 * ```sql
 * CREATE TABLE carried_applied (
 *   hash TEXT PRIMARY KEY
 * );
 * ```
 *
 * The carry happens only when the three old tables have the expected shape
 * (`PRAGMA table_info`: `cursors` exactly `actor TEXT` primary key,
 * `last_wall INTEGER`, `last_counter INTEGER`, `last_actor TEXT`,
 * `last_hash TEXT`; `cursor_seen` exactly `actor TEXT`, `hash TEXT` (the
 * primary key) and `wall INTEGER`; `folded` at least `hash TEXT` primary
 * key and `folded INTEGER`), and rows are filtered by `typeof()`, never
 * repaired (a cursor row with an ill-typed value is left out with its seen
 * rows, so that actor is redelivered everything). Otherwise, for a later
 * version, no version, or a SQLite error while reading the old tables, the
 * recreate drops the cursors as it always did. `carried_applied` is read
 * by the first fold that records events into the recreated cache
 * (`priorApplied`, `src/store/engine.ts`), which treats an event as newly
 * effective only when the old cache had not applied it, and drops the
 * table; it is not covered by `dumpCache`, `diffCaches` or
 * `rebuild --check`. The inspect-only open never carries. The carry is
 * only sound while the delivery rule and the fold order of positions are
 * the ones the old version used; see `src/store/cursors.ts`.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

import { canonicalEncode } from '../events/canonical.js';
import type { BoardState, Rejected, Ticket, UnknownReport } from '../events/fold.js';
import type { Board } from './board.js';
import { BoardError } from './errors.js';
import {
  catchUpLocked,
  catchUpUnlocked,
  inImmediate,
  isBusy,
  loadState,
  inSnapshot,
  loadTicket,
  retryBusy,
  stmt,
  tableRows,
} from './engine.js';
import type { CorruptFile, MalformedFile, WriteHooks } from './eventfile.js';

/** File name of the cache inside the board directory. */
export const CACHE_FILE = 'cache.sqlite';

/**
 * Version of the cache schema above, stored in `meta.schema_version`: 5,
 * the version with the `tickets.unplanned` column, the `tickets.superseded`
 * column and the per-line `removed` flag of the checklist (board-cache:
 * "Cache schema", scenario "Cache from an earlier schema is rebuilt"), so a
 * cache of version 4 or older (version 3: lease and queue columns,
 * `waiters`, `grant_watermark`) is dropped and rebuilt from the event files
 * on first open.
 */
export const CACHE_SCHEMA_VERSION = 5;

/** Minimum busy timeout on every connection, in milliseconds. */
export const BUSY_TIMEOUT_MS = 5000;

/** Options of `openCache`. */
export interface OpenCacheOptions {
  /**
   * True (the default): the open described on `openCache` (creates the
   * file, switches to WAL, creates or recreates the schema).
   *
   * False: open an existing cache for inspection without modifying the
   * file in any way (board-cache: `rebuild --check` SHALL NOT modify the
   * live cache file). The file is never created, the journal mode is never
   * switched (a WAL cache stays WAL: the mode is stored in the file), no
   * table is created, dropped or migrated, and no row is written; only
   * `busy_timeout` and `foreign_keys`, which are per connection, are set.
   * - When `path` does not exist: `BoardError(5, 'no-cache')` naming it.
   * - When the file is not a cache of `CACHE_SCHEMA_VERSION` (empty, not a
   *   SQLite database, no `meta` table, or a `meta.schema_version` other
   *   than `CACHE_SCHEMA_VERSION`): the connection is closed and
   *   `BoardError(5, 'schema-mismatch')` naming the path and, when there is
   *   one, the stored version, is thrown. The file is left byte for byte
   *   unchanged, cursor rows included.
   */
  readonly prepare?: boolean;
  /**
   * With `prepare` false only: the busy timeout of the connection and the
   * deadline of the busy retry, in milliseconds, in place of
   * `BUSY_TIMEOUT_MS`. `agentboard hook` passes what is left of its
   * budget, so a locked cache makes it give up in time instead of waiting
   * the usual 5 seconds; zero waits not at all. Ignored by a preparing
   * open.
   */
  readonly busyTimeoutMs?: number;
}

/**
 * Opens (creating when absent) the SQLite database at `path` and prepares
 * the connection: `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout` of at
 * least `BUSY_TIMEOUT_MS`, `PRAGMA foreign_keys = ON`. Creates the schema
 * when the database has no `meta.schema_version`, recording
 * `CACHE_SCHEMA_VERSION` and `last_position` `null`. When the stored
 * `schema_version` differs from `CACHE_SCHEMA_VERSION`, every table is
 * dropped and recreated empty (the cache is disposable), except that an
 * earlier version's cursor tables are carried across the recreate when
 * they have the expected shape (see the module documentation and
 * `schemaStep`). Never folds events.
 *
 * Every statement of the open waits on the busy timeout, including the
 * switch to WAL, which SQLite can fail with SQLITE_BUSY without consulting
 * the busy handler while another process creates the same file: such a
 * step is retried (`retryBusy`) with a short sleep until a deadline of
 * `BUSY_TIMEOUT_MS` after the open began, then `BoardError(5, 'busy')` is
 * thrown. Many processes opening a board with no cache at once therefore
 * all succeed.
 *
 * Worst-case wait: the deadline bounds the retries, not each attempt. The
 * schema step runs `BEGIN IMMEDIATE` (`beginImmediate`), which itself waits
 * up to the busy timeout and retries once, so an attempt started just
 * before the deadline can wait about `2 * BUSY_TIMEOUT_MS` more. An open
 * therefore gives up after at most about `3 * BUSY_TIMEOUT_MS` (15 s), and
 * never hangs. A `BoardError(5, 'busy')` from `beginImmediate` is not
 * retried.
 *
 * With `options.prepare` false the open only inspects (see
 * `OpenCacheOptions`).
 *
 * `path` may be `':memory:'` (journal mode is then `memory`; used for the
 * temporary database of `checkCache`).
 *
 * On every preparing open, whatever the stored version, it also ensures
 * the `cursor_seen` table exists (`CREATE TABLE IF NOT EXISTS`, see
 * `src/store/cursors.ts`); recreating the schema drops it too, and a
 * carrying recreate creates it again with the carried rows. An
 * inspect-only open (`prepare: false`) never creates it.
 */
export function openCache(path: string, options?: OpenCacheOptions): DatabaseSync {
  if (options?.prepare === false) {
    return inspectCache(path, options.busyTimeoutMs);
  }
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const db = new DatabaseSync(path);
  try {
    // The busy timeout comes first so that every later statement waits for
    // a concurrent opener. SQLite can still fail the switch to WAL (and the
    // first reads of a file another connection is creating) with
    // SQLITE_BUSY without waiting, so each step is also retried with a
    // short sleep until the busy timeout has passed (board-cache: opening
    // waits on the busy timeout for every statement).
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    retryBusy(() => db.exec('PRAGMA journal_mode = WAL'), deadline);
    db.exec('PRAGMA foreign_keys = ON');
    retryBusy(() => {
      if (storedSchemaVersion(db) !== String(CACHE_SCHEMA_VERSION)) {
        schemaStep(db);
      }
    }, deadline);
    // After the schema step, which drops it along with every table.
    retryBusy(() => {
      ensureCursorSeen(db);
    }, deadline);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * The schema step of a preparing open that found another stored version:
 * recreates the schema under the write lock, carrying the cursor tables
 * when the stored version is an earlier one and the old tables have the
 * expected shape (`readCarry`). When reading the carry fails with a SQLite
 * error other than busy, the whole transaction is rolled back (SQLite
 * refuses every later statement of a transaction after SQLITE_CORRUPT, the
 * recreate's `DROP TABLE`s included) and the step runs again in a fresh
 * `BEGIN IMMEDIATE`, re-checking the version, without reading the carry;
 * the recreate then fails only where it fails today.
 */
function schemaStep(db: DatabaseSync): void {
  try {
    recreateSchema(db, true);
  } catch (error) {
    if (!(error instanceof CarryReadError)) {
      throw error;
    }
    recreateSchema(db, false);
  }
}

/**
 * One `BEGIN IMMEDIATE` ... `COMMIT` that re-checks the stored version (a
 * concurrent opener may have won) and, when it still differs, reads the
 * carry (with `carry` true and an earlier stored version), drops and
 * recreates every table, records the version and `last_position` `null`,
 * and writes the carried rows and `carried_applied`. All of it commits or
 * rolls back as one transaction, so a concurrent opener sees either the
 * old cache or the new one with its cursors in place.
 */
function recreateSchema(db: DatabaseSync, carry: boolean): void {
  inImmediate(db, () => {
    const stored = storedSchemaVersion(db);
    if (stored === String(CACHE_SCHEMA_VERSION)) {
      return;
    }
    const carried = carry && isEarlierVersion(stored) ? readCarry(db) : null;
    db.exec(SCHEMA);
    stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(CACHE_SCHEMA_VERSION),
    );
    stmt(db, "INSERT INTO meta (key, value) VALUES ('last_position', 'null')").run();
    if (carried !== null) {
      writeCarry(db, carried);
    }
  });
}

/**
 * Whether `stored` is an earlier schema version: exactly the decimal text
 * `String(n)` of an integer `n` from 1 to `CACHE_SCHEMA_VERSION - 1`. A
 * later version (a downgrade), no version, `04`, `4.0`, ` 4`, `0` or `-1`
 * is not one, and carries nothing.
 */
function isEarlierVersion(stored: string | null): boolean {
  for (let n = 1; n < CACHE_SCHEMA_VERSION; n += 1) {
    if (stored === String(n)) {
      return true;
    }
  }
  return false;
}

/** The cursor tables and applied hashes read from an old cache. */
interface Carry {
  cursors: SQLOutputValue[][];
  seen: SQLOutputValue[][];
  applied: string[];
}

/** A SQLite error (other than busy) while reading the carry; see `schemaStep`. */
class CarryReadError extends Error {
  constructor(cause: unknown) {
    super('reading the cursor tables of the old cache failed', { cause });
  }
}

/** One column of an expected table shape, as `PRAGMA table_info` reports it. */
interface ColumnShape {
  name: string;
  type: string;
  pk: boolean;
}

const CURSORS_SHAPE: readonly ColumnShape[] = [
  { name: 'actor', type: 'TEXT', pk: true },
  { name: 'last_wall', type: 'INTEGER', pk: false },
  { name: 'last_counter', type: 'INTEGER', pk: false },
  { name: 'last_actor', type: 'TEXT', pk: false },
  { name: 'last_hash', type: 'TEXT', pk: false },
];

const CURSOR_SEEN_SHAPE: readonly ColumnShape[] = [
  { name: 'actor', type: 'TEXT', pk: true },
  { name: 'hash', type: 'TEXT', pk: true },
  { name: 'wall', type: 'INTEGER', pk: false },
];

const FOLDED_SHAPE: readonly ColumnShape[] = [
  { name: 'hash', type: 'TEXT', pk: true },
  { name: 'folded', type: 'INTEGER', pk: false },
];

/**
 * Whether `table` has every column of `shape` (names exactly, declared
 * types case-insensitively, primary key membership) and, when `exact`, no
 * other column. A missing table has no columns and fails.
 */
function hasShape(
  db: DatabaseSync,
  table: string,
  shape: readonly ColumnShape[],
  exact: boolean,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (exact && columns.length !== shape.length) {
    return false;
  }
  return shape.every((expected) =>
    columns.some(
      (column) =>
        column.name === expected.name &&
        String(column.type).toUpperCase() === expected.type &&
        Number(column.pk) > 0 === expected.pk,
    ),
  );
}

/**
 * Reads the carry from the old `cursors`, `cursor_seen` and `folded`
 * tables, or returns null when any of them lacks the expected shape
 * (design.md "The expected shape"). Rows are filtered by `typeof()`, never
 * repaired: a `cursors` row needs a TEXT actor and position columns that
 * are all NULL or INTEGER, INTEGER, TEXT, TEXT; a `cursor_seen` row needs
 * TEXT actor and hash, an INTEGER wall and a carried actor; an applied
 * hash is a TEXT hash whose `folded` is the INTEGER 1. Any SQLite error
 * other than busy becomes `CarryReadError` (a busy one cannot happen under
 * the lock and propagates as it is).
 */
function readCarry(db: DatabaseSync): Carry | null {
  try {
    if (
      !hasShape(db, 'cursors', CURSORS_SHAPE, true) ||
      !hasShape(db, 'cursor_seen', CURSOR_SEEN_SHAPE, true) ||
      !hasShape(db, 'folded', FOLDED_SHAPE, false)
    ) {
      return null;
    }
    const cursors = db
      .prepare(
        `SELECT actor, last_wall, last_counter, last_actor, last_hash FROM cursors
         WHERE typeof(actor) = 'text'
           AND ((typeof(last_wall) = 'null' AND typeof(last_counter) = 'null'
                 AND typeof(last_actor) = 'null' AND typeof(last_hash) = 'null')
             OR (typeof(last_wall) = 'integer' AND typeof(last_counter) = 'integer'
                 AND typeof(last_actor) = 'text' AND typeof(last_hash) = 'text'))`,
      )
      .all()
      .map((row) => CURSORS_SHAPE.map((column) => value(row, column.name)));
    const actors = new Set(cursors.map((row) => row[0]));
    const seen = db
      .prepare(
        `SELECT actor, hash, wall FROM cursor_seen
         WHERE typeof(actor) = 'text' AND typeof(hash) = 'text' AND typeof(wall) = 'integer'`,
      )
      .all()
      .filter((row) => actors.has(row.actor))
      .map((row) => CURSOR_SEEN_SHAPE.map((column) => value(row, column.name)));
    const applied = db
      .prepare(
        `SELECT hash FROM folded
         WHERE typeof(hash) = 'text' AND typeof(folded) = 'integer' AND folded = 1`,
      )
      .all()
      .map((row) => String(row.hash));
    return { cursors, seen, applied };
  } catch (error) {
    // Under the write lock no reader can be busy; if SQLite ever reports it
    // anyway, it is the open's retry that must handle it, not the fallback.
    if (isBusy(error)) {
      throw error;
    }
    throw new CarryReadError(error);
  }
}

/** A column of a row read by `readCarry`, whose SELECT names every column it reads. */
function value(row: Record<string, SQLOutputValue>, column: string): SQLOutputValue {
  return row[column] ?? null;
}

/**
 * Writes the carry into the recreated schema: creates `cursor_seen` and
 * `carried_applied`, then inserts the carried rows. Runs inside the
 * recreate's transaction.
 */
function writeCarry(db: DatabaseSync, carry: Carry): void {
  db.exec(CURSOR_SEEN);
  db.exec(CARRIED_APPLIED);
  const cursor = db.prepare(
    'INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of carry.cursors) {
    cursor.run(...row);
  }
  const seen = db.prepare('INSERT INTO cursor_seen (actor, hash, wall) VALUES (?, ?, ?)');
  for (const row of carry.seen) {
    seen.run(...row);
  }
  const applied = db.prepare('INSERT INTO carried_applied (hash) VALUES (?)');
  for (const hash of carry.applied) {
    applied.run(hash);
  }
}

/**
 * The hashes the old cache had applied, kept by a carrying recreate until
 * the first fold that records events consumes and drops it (see
 * `priorApplied` in `src/store/engine.ts`).
 */
const CARRIED_APPLIED = `
CREATE TABLE carried_applied (
  hash TEXT PRIMARY KEY
);
`;

/**
 * Creates `cursor_seen` when it is missing (the schema step drops it and
 * does not create it).
 * Looks first, so an open that finds the table never
 * writes and never waits for a concurrent writer's lock.
 */
function ensureCursorSeen(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursor_seen'")
    .get();
  if (table === undefined) {
    db.exec(CURSOR_SEEN);
  }
}

/** The seen sets of the cursors (see `src/store/cursors.ts`). */
const CURSOR_SEEN = `
CREATE TABLE IF NOT EXISTS cursor_seen (
  actor TEXT NOT NULL,
  hash  TEXT NOT NULL,
  wall  INTEGER NOT NULL,
  PRIMARY KEY (actor, hash)
);
`;

/** SQLITE_NOTADB and SQLITE_CORRUPT: the file is not a (valid) database. */
function isNotADatabase(error: unknown): boolean {
  if (!(error instanceof Error) || !('errcode' in error) || typeof error.errcode !== 'number') {
    return false;
  }
  const primary = error.errcode & 0xff;
  return primary === 26 || primary === 11;
}

/**
 * `openCache(path, { prepare: false })`: opens an existing cache without
 * writing to the file. Only per-connection pragmas are set and the schema
 * version is read (retried on SQLITE_BUSY like any open, with
 * `busyTimeoutMs` as both the busy timeout and the retry deadline).
 */
function inspectCache(path: string, busyTimeoutMs: number = BUSY_TIMEOUT_MS): DatabaseSync {
  if (!existsSync(path)) {
    throw new BoardError(5, 'no-cache', `there is no cache file at ${path}`);
  }
  const wait = Math.max(0, Math.floor(busyTimeoutMs));
  const deadline = Date.now() + wait;
  const db = new DatabaseSync(path);
  let stored: string | null;
  try {
    db.exec(`PRAGMA busy_timeout = ${String(wait)}`);
    db.exec('PRAGMA foreign_keys = ON');
    stored = retryBusy(() => inSnapshot(db, () => storedSchemaVersion(db)), deadline);
  } catch (error) {
    db.close();
    if (isNotADatabase(error)) {
      throw schemaMismatch(path, null);
    }
    throw error;
  }
  if (stored !== String(CACHE_SCHEMA_VERSION)) {
    db.close();
    throw schemaMismatch(path, stored);
  }
  return db;
}

function schemaMismatch(path: string, stored: string | null): BoardError {
  const found = stored === null ? '' : ` (it has schema version ${stored})`;
  return new BoardError(
    5,
    'schema-mismatch',
    `the cache file at ${path} is not a cache of schema version ${String(CACHE_SCHEMA_VERSION)}${found}`,
  );
}

/** `meta.schema_version`, or null when there is no such row or no meta table. */
function storedSchemaVersion(db: DatabaseSync): string | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (table === undefined) {
    return null;
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return typeof row?.value === 'string' ? row.value : null;
}

/**
 * Drops every table (children first), `carried_applied` included, and
 * creates the schema documented above.
 */
const SCHEMA = `
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS waiters;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS cursors;
DROP TABLE IF EXISTS cursor_seen;
DROP TABLE IF EXISTS folded;
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS carried_applied;
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
  superseded   TEXT,
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

/**
 * What one catch-up did. The event arrays list only events newly recorded
 * in `folded` by this call, in fold order (malformed by file name), even
 * when a full refold happened; `corrupt` lists every corrupt file present.
 */
export interface CatchUpReport {
  /** Hashes of newly recorded events that were applied (folded = 1). */
  applied: string[];
  /** Newly recorded events the fold rejected. */
  rejected: Rejected[];
  /** Newly recorded events of an unknown kind. */
  unknown: UnknownReport[];
  /** Newly recorded malformed files. */
  malformed: MalformedFile[];
  /** Every corrupt file currently in the events directory. */
  corrupt: CorruptFile[];
  /** Absolute paths of stale temporary files removed (see `reapStaleTemps`). */
  reaped: string[];
  /**
   * True when the cache's derived tables were rebuilt from every event file
   * rather than extended incrementally (required when a new event sorts
   * before `last_position`, for example a late event synced from another
   * machine).
   */
  refolded: boolean;
}

/** Options for `catchUp`. */
export interface CatchUpOptions {
  /**
   * The local clock reading, in ms since the epoch, used both for temp
   * reaping and for deciding which grants are due (a grant is written when
   * its slot time `ts.wall` is at or before it). Defaults to `Date.now()`,
   * read once per call.
   */
  now?: number;
  /**
   * Lock probe: called exactly once, with no arguments, immediately before
   * this call itself issues `BEGIN IMMEDIATE`, that is whenever it found
   * something to fold, reap or grant. Never called when the call returns
   * from its lock-free first look, and never when it runs inside the
   * caller's transaction (`board.db.isTransaction`), whose lock the caller
   * took. An exception it throws propagates before the lock is taken.
   */
  onWriteLock?: () => void;
  /**
   * Crash-injection hooks passed to `writeEventFile` for every grant file
   * this call writes (see `WriteHooks`). Defaults to none. The CLI passes
   * the hooks of `pauseHooks` for its environment, so
   * `AGENTBOARD_TEST_PAUSE` also pauses inside the grant write of a
   * command's catch-up.
   */
  hooks?: WriteHooks;
  /**
   * Read probe: called with the file name (`<hash>.json`) each time this
   * call reads the bytes of an event file from disk, whether for folding or
   * for deriving grants, and never for listing the events directory or for
   * a file whose outcome was already read earlier on the same board handle.
   * A call that finds no unrecorded file name, no stale temporary file and
   * a clock before the cache's `grant_watermark` (or no watermark) calls it
   * zero times (board-cache: "Cache schema", scenario "List reads the
   * cache").
   */
  onReadEventFile?: (name: string) => void;
}

/**
 * Brings the cache up to date with the events directory.
 *
 * Reaps stale temporary files (`reapStaleTemps`), then reads every event
 * file whose hash is not in `folded` and records it. A recorded file is
 * not read at this step, so one changed in place after it was recorded is
 * never folded again; it is reported when the grant walk below reads it
 * (`corrupt` is then deduplicated and in name order), and by `rebuild` and
 * `rebuild --check`. When every newly read well-formed event sorts after
 * `last_position` in fold order, they are applied incrementally in fold
 * order; otherwise all derived tables (everything but `cursors`) are
 * refolded from every event file. Either way, afterwards
 * `dumpCache(board.db)` equals the dump of a fresh rebuild of the same
 * events directory (the incremental and full paths are indistinguishable
 * except for `refolded`). Each file is read from disk at most once per
 * open board (files are immutable and named by their hash), and
 * `onReadEventFile` is called for every such read.
 *
 * Runs inside the caller's transaction when `board.db.isTransaction` is
 * true. Otherwise it first looks without taking the write lock: it reads
 * `folded` and the `grant_watermark` row, lists `events/` and the stale
 * temporaries, and reads only the event files not yet recorded. When there
 * is no stale temporary file to reap, no unrecorded file to record (every
 * unrecorded name, if any, is corrupt) and the clock is before the grant
 * watermark (or there is none), it returns at once without ever taking the
 * write lock, with empty event arrays, `reaped` empty, `refolded` false and
 * `corrupt` listing the corrupt files; a concurrent writer holding `BEGIN
 * IMMEDIATE` therefore never blocks it, and a warm cache with nothing due
 * reads no event file. Otherwise it calls `onWriteLock`, takes `BEGIN
 * IMMEDIATE` (with the busy retry, then `BoardError(5, 'busy')`), redoes
 * the work under the lock, and `COMMIT`s (rolled back on error). A call
 * that finds nothing new changes no rows.
 *
 * Late events: after the derived rows are up to date, the
 * events this call newly recorded as applied, plus (after a refold) every
 * event already recorded whose `folded` flag went from 0 to 1, are passed to
 * `resetLateCursors` (`src/store/cursors.ts`) in the same transaction, so an
 * event that becomes effective behind an actor's cursor and outside its
 * seen-set window (late itself, or made effective by a late event) moves
 * that cursor back and is delivered by the next `inbox`. The report does
 * not list them; `rebuild` does.
 *
 * Grants (board-cli: "Due grants are written during catch-up"). After the
 * new files are folded, and in the same transaction, when the clock `now`
 * has reached the grant watermark (the slot time of the first grant that
 * would be due and is not folded, kept in `meta` by every fold; see
 * `FoldSession`), every event file is read and every grant that `dueGrants`
 * (`src/events/grants.ts`) returns for the board's well-formed events and
 * `now` is written with `writeEventFile` (so its file holds exactly
 * `canonicalEncode` of the derived grant, named by its hash, and a file
 * already present with those bytes is not rewritten) and folded exactly
 * like a late-arriving event: when it sorts before `last_position` the
 * derived tables are refolded, and `resetLateCursors` is called for it (and
 * for every event a refold made effective), so an actor whose cursor is
 * past the grant and outside its seen window gets it from the next `inbox`.
 * Afterwards `dumpCache(board.db)` equals the dump of a fresh rebuild of the
 * events directory, grant files and watermark included, and no grant due at
 * `now` is missing. Each grant written is recorded in `folded` by this call
 * and so listed in `applied`, in fold order with the other new events. A
 * grant whose slot time is after `now` is not written. Grants are derived
 * from the state at their own fold position (see `dueGrants`), never from
 * the latest state alone, so an event sorting after a grant's slot never
 * changes or suppresses it. Under the lock the watermark is read again,
 * after the new files are folded, because another process may have written
 * the grants meanwhile and a late event may have lowered it.
 *
 * `rebuild` and `rebuild --check` never call this and never write grants.
 */
export function catchUp(board: Board, options?: CatchUpOptions): CatchUpReport {
  const now = options?.now ?? Date.now();
  const locked = { hooks: options?.hooks, probe: options?.onReadEventFile };
  if (board.db.isTransaction) {
    return catchUpLocked(board, now, locked);
  }
  const quiet = catchUpUnlocked(board, now, locked.probe);
  if (quiet !== null) {
    return quiet;
  }
  options?.onWriteLock?.();
  return inImmediate(board.db, () => catchUpLocked(board, now, locked));
}

/**
 * Reconstructs one ticket from the cache rows, or null when there is no row
 * for `id` (exact id; prefix resolution is the CLI's job). Reads only the
 * cache. For a cache that is up to date the result deep-equals
 * `fold(<all well-formed events>).state.tickets[id]`, field for field.
 *
 * Snapshot: every row of the result (the ticket row, its comments and its
 * links) comes from one read snapshot. When `db.isTransaction` is false the
 * reads are wrapped in a deferred `BEGIN` ... `COMMIT` (never `BEGIN
 * IMMEDIATE`, so a reader never takes or waits for the write lock); inside
 * the caller's transaction (for example `runCommand`'s) no transaction
 * statement is issued. A writer committing on another connection while the
 * reads run is therefore either entirely visible or entirely invisible, and
 * `version` always agrees with the comment list.
 */
export function readTicket(db: DatabaseSync, id: string): Ticket | null {
  return inSnapshot(db, () => loadTicket(db, id));
}

/**
 * Reconstructs the whole board state from the cache rows (tickets keyed by
 * id; `meta` from the `board.<k>` rows, as a null-prototype object). For an
 * up-to-date cache, `canonicalEncode(readState(db))` equals
 * `canonicalEncode(fold(<all well-formed events>).state)`.
 *
 * Snapshot: as for `readTicket`, all rows come from one read snapshot (a
 * deferred `BEGIN` ... `COMMIT` when `db.isTransaction` is false; nothing
 * when already inside a transaction).
 */
export function readState(db: DatabaseSync): BoardState {
  return inSnapshot(db, () => loadState(db));
}

/**
 * Tables covered by the canonical dump, in dump key order: `comments`,
 * `folded`, `links`, `meta`, `tickets` and `waiters` (by ticket, then
 * position; a `CacheDifference` key `<ticket>#<position>`).
 */
export const DUMP_TABLES = ['comments', 'folded', 'links', 'meta', 'tickets', 'waiters'] as const;

/** A table covered by the canonical dump. */
export type DumpTable = (typeof DUMP_TABLES)[number];

/**
 * Canonical dump of the derived tables, for comparing caches byte for byte.
 *
 * The result is the UTF-8 text of `canonicalEncode` applied to an object
 * with one key per `DUMP_TABLES` entry, each an array of that table's rows in
 * ascending primary key order (`tickets` by id; `comments` and `links` by
 * ticket then seq; `waiters` by ticket then position; `folded` by hash;
 * `meta` by key), each row an object
 * mapping every column name to its value (INTEGER as a number, TEXT as a
 * string, NULL as null). `cursors` is excluded. Two caches holding the same
 * derived rows produce identical strings.
 */
export function dumpCache(db: DatabaseSync): string {
  const dump: Record<string, unknown[]> = {};
  for (const table of DUMP_TABLES) {
    dump[table] = tableRows(db, table).map((keyed) => keyed.row);
  }
  return new TextDecoder().decode(canonicalEncode(dump));
}
