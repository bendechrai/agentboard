/**
 * The derived SQLite cache (board-cache: "Cache is derived and disposable",
 * "Cache schema", "Cache connection settings"; design.md: "One transaction
 * per command, event file inside it").
 *
 * The cache holds nothing that cannot be derived from the event files,
 * except the `cursors` table (acknowledgement state owned by `inbox`, task
 * group 5), which is preserved by rebuilds and excluded from the canonical
 * dump.
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
 *   version      INTEGER NOT NULL,
 *   updated_at   TEXT NOT NULL,   -- encodeHlc(Ticket.updatedAt)
 *   created_by   TEXT NOT NULL,
 *   created_at   TEXT NOT NULL,   -- encodeHlc(Ticket.createdAt)
 *   task_source  TEXT,            -- the three task_* columns are all null
 *   task_ref     TEXT,            --   (no task) or all non-null
 *   task_item    TEXT,
 *   adhoc        TEXT,
 *   labels       TEXT NOT NULL,   -- JSON array of strings
 *   closed       INTEGER NOT NULL,
 *   decision     TEXT,            -- decision path when closed with one;
 *                                 --   null when open or closed with noDecision
 *   checklist    TEXT NOT NULL    -- JSON array of {"done":bool,"text":string}
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
 * value. Every table above has exactly these columns.
 *
 * Every event file with a valid name is recorded in `folded` once it has
 * been read (applied, rejected, unknown kind or malformed), so catch-up only
 * reads files not yet recorded. Corrupt files (a name that is not
 * `<sha256>.json` of the bytes) are never recorded and are reported by every
 * catch-up and rebuild. Dot-named entries of `events/` (temporary files,
 * `.gitkeep`) are ignored entirely, as `listEventFiles` documents.
 *
 * The `cursors` table is the one non-derivable table (board-cache: losing
 * cursors only causes redelivery, never a skipped event): `rebuild` keeps its
 * rows and `rebuild --check` does not compare it.
 *
 * Cursor seen sets (task group 5, `src/store/cursors.ts`) are stored in one
 * more table, `cursor_seen (actor, hash, wall)`, documented there. It is
 * part of the cursors and is treated exactly like `cursors`: kept by
 * `rebuild`, not covered by `dumpCache` or `rebuild --check`, dropped with
 * every other table when the schema version differs. `openCache` creates it
 * with `CREATE TABLE IF NOT EXISTS` on every open, so a version 1 cache made
 * before group 5 gains it without a version change.
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { canonicalEncode } from '../events/canonical.js';
import type { BoardState, Rejected, Ticket, UnknownReport } from '../events/fold.js';
import type { Board } from './board.js';
import { BoardError } from './errors.js';
import {
  catchUpLocked,
  catchUpUnlocked,
  inImmediate,
  loadState,
  inSnapshot,
  loadTicket,
  retryBusy,
  stmt,
  tableRows,
} from './engine.js';
import type { CorruptFile, MalformedFile } from './eventfile.js';

/** File name of the cache inside the board directory. */
export const CACHE_FILE = 'cache.sqlite';

/** Version of the cache schema above, stored in `meta.schema_version`. */
export const CACHE_SCHEMA_VERSION = 1;

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
}

/**
 * Opens (creating when absent) the SQLite database at `path` and prepares
 * the connection: `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout` of at
 * least `BUSY_TIMEOUT_MS`, `PRAGMA foreign_keys = ON`. Creates the schema
 * when the database has no `meta.schema_version`, recording
 * `CACHE_SCHEMA_VERSION` and `last_position` `null`. When the stored
 * `schema_version` differs from `CACHE_SCHEMA_VERSION`, every table is
 * dropped and recreated empty (the cache is disposable). Never folds events.
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
 * `src/store/cursors.ts`); recreating the schema drops it too. An
 * inspect-only open (`prepare: false`) never creates it.
 */
export function openCache(path: string, options?: OpenCacheOptions): DatabaseSync {
  if (options?.prepare === false) {
    return inspectCache(path);
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
        inImmediate(db, () => {
          // Re-checked under the write lock: a concurrent opener may have won.
          if (storedSchemaVersion(db) !== String(CACHE_SCHEMA_VERSION)) {
            db.exec(SCHEMA);
            stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?)').run(
              'schema_version',
              String(CACHE_SCHEMA_VERSION),
            );
            stmt(db, "INSERT INTO meta (key, value) VALUES ('last_position', 'null')").run();
          }
        });
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
 * Creates `cursor_seen` when it is missing (a version 1 cache made before
 * task group 5). Looks first, so an open that finds the table never
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
 * version is read (retried on SQLITE_BUSY like any open).
 */
function inspectCache(path: string): DatabaseSync {
  if (!existsSync(path)) {
    throw new BoardError(5, 'no-cache', `there is no cache file at ${path}`);
  }
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const db = new DatabaseSync(path);
  let stored: string | null;
  try {
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
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

/** Drops every table (children first) and creates the schema documented above. */
const SCHEMA = `
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
  /** Clock for temp reaping, in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Brings the cache up to date with the events directory.
 *
 * Reaps stale temporary files (`reapStaleTemps`), then reads every event file
 * whose hash is not in `folded` and records it. When every newly read
 * well-formed event sorts after `last_position` in fold order, they are
 * applied incrementally in fold order; otherwise all derived tables
 * (everything but `cursors`) are refolded from every event file. Either way,
 * afterwards `dumpCache(board.db)` equals the dump of a fresh rebuild of the
 * same events directory (the incremental and full paths are
 * indistinguishable except for `refolded`).
 *
 * Runs inside the caller's transaction when `board.db.isTransaction` is
 * true. Otherwise it first looks without taking the write lock (a plain read
 * of `folded`, a listing of `events/` and of stale temporaries): when there
 * is no stale temporary file to reap and no unrecorded file to record
 * (every unrecorded name, if any, is corrupt), it returns at once without
 * ever taking the write lock, with empty event arrays, `reaped` empty,
 * `refolded` false and `corrupt` listing the corrupt files; a concurrent
 * writer holding `BEGIN IMMEDIATE` therefore never blocks it. Only when
 * there is something to fold or reap does it take `BEGIN IMMEDIATE` (with
 * the busy retry, then `BoardError(5, 'busy')`), redo the work above under
 * the lock, and `COMMIT` (rolled back on error). A call that finds nothing
 * new changes no rows.
 *
 * Late events (task group 5): after the derived rows are up to date, the
 * events this call newly recorded as applied, plus (after a refold) every
 * event already recorded whose `folded` flag went from 0 to 1, are passed to
 * `resetLateCursors` (`src/store/cursors.ts`) in the same transaction, so an
 * event that becomes effective behind an actor's cursor and outside its
 * seen-set window (late itself, or made effective by a late event) moves
 * that cursor back and is delivered by the next `inbox`. The report does
 * not list them; `rebuild` does.
 */
export function catchUp(board: Board, options?: CatchUpOptions): CatchUpReport {
  const now = options?.now ?? Date.now();
  if (board.db.isTransaction) {
    return catchUpLocked(board, now);
  }
  const quiet = catchUpUnlocked(board, now);
  return quiet ?? inImmediate(board.db, () => catchUpLocked(board, now));
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

/** Tables covered by the canonical dump, in dump key order. */
export const DUMP_TABLES = ['comments', 'folded', 'links', 'meta', 'tickets'] as const;

/** A table covered by the canonical dump. */
export type DumpTable = (typeof DUMP_TABLES)[number];

/**
 * Canonical dump of the derived tables, for comparing caches byte for byte.
 *
 * The result is the UTF-8 text of `canonicalEncode` applied to an object
 * with one key per `DUMP_TABLES` entry, each an array of that table's rows in
 * ascending primary key order (`tickets` by id; `comments` and `links` by
 * ticket then seq; `folded` by hash; `meta` by key), each row an object
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
