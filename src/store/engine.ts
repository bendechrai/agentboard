/**
 * Internal machinery shared by `cache.ts`, `transaction.ts` and `rebuild.ts`:
 * transactions with busy retry, row encoding of tickets, and applying events
 * to the cache rows with the fold's own per-event step (`applyEvent`), so
 * that the incremental path, the full refold and the command transaction
 * all produce exactly the rows a fresh fold would. Not part of the public
 * API (not re-exported from `src/index.ts`).
 */

import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';

import { canonicalEncode, type JsonValue } from '../events/canonical.js';
import {
  applyEvent,
  compareFoldOrder,
  type ApplyOutcome,
  type BoardState,
  type ChecklistItem,
  type FoldInput,
  type Rejected,
  type Ticket,
  type TicketLink,
  type UnknownReport,
} from '../events/fold.js';
import { compareHlc, decodeHlc, encodeHlc, type Hlc } from '../events/hlc.js';
import { isKnownEvent, type Status } from '../events/schema.js';
import type { Board } from './board.js';
import type { CatchUpReport, DumpTable } from './cache.js';
import { BoardError } from './errors.js';
import {
  STALE_TEMP_MS,
  TEMP_PREFIX,
  readEventLog,
  reapStaleTemps,
  type CorruptFile,
  type MalformedFile,
} from './eventfile.js';
import { staleTemps } from './temps.js';

/** A row as `node:sqlite` returns it. */
export type Row = Record<string, SQLOutputValue>;

// ---------------------------------------------------------------------------
// Statements and transactions

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** A prepared statement for `sql`, cached per connection. */
export function stmt(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (cache === undefined) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

/** True for SQLITE_BUSY (and its extended codes) from `node:sqlite`. */
function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === 5
  );
}

/**
 * `BEGIN IMMEDIATE`, retried once when still busy after the busy timeout;
 * a second busy failure is `BoardError(5, 'busy')` (design.md, Risks).
 */
export function beginImmediate(db: DatabaseSync): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if (!isBusy(error)) {
        throw error;
      }
      if (attempt === 2) {
        throw new BoardError(
          5,
          'busy',
          'the board cache stayed locked by another process; try again',
        );
      }
    }
  }
}

/** Rolls back the open transaction, if any. */
export function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // No transaction was open (it failed to begin or SQLite already ended it).
  }
}

/** Runs `fn` inside `BEGIN IMMEDIATE` ... `COMMIT`, rolling back on any error. */
export function inImmediate<T>(db: DatabaseSync, fn: () => T): T {
  beginImmediate(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Column helpers

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`cache column ${column} is not text`);
  }
  return value;
}

function nullableText(row: Row, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new Error(`cache column ${column} is not an integer`);
  }
  return value;
}

/** Canonical JSON text of a value, as stored in JSON columns. */
export function jsonText(value: unknown): string {
  return new TextDecoder().decode(canonicalEncode(value));
}

/** A row as JSON values (INTEGER as number, TEXT as string, NULL as null). */
export function jsonRow(row: Row): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [column, value] of Object.entries(row)) {
    if (value !== null && typeof value !== 'number' && typeof value !== 'string') {
      throw new Error(`cache column ${column} holds a value that is not INTEGER, TEXT or NULL`);
    }
    out[column] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tickets <-> rows

function toTicket(row: Row, comments: Row[], links: Row[]): Ticket {
  const closed = int(row, 'closed') === 1;
  const decision = nullableText(row, 'decision');
  const source = nullableText(row, 'task_source');
  return {
    id: text(row, 'id'),
    title: text(row, 'title'),
    description: nullableText(row, 'description'),
    status: text(row, 'status') as Status,
    blockedFrom: nullableText(row, 'blocked_from') as Status | null,
    assignee: nullableText(row, 'assignee'),
    labels: JSON.parse(text(row, 'labels')) as string[],
    task:
      source === null ? null : { source, ref: text(row, 'task_ref'), item: text(row, 'task_item') },
    adhoc: nullableText(row, 'adhoc'),
    checklist: JSON.parse(text(row, 'checklist')) as ChecklistItem[],
    comments: comments.map((c) => ({
      actor: text(c, 'actor'),
      ts: decodeHlc(text(c, 'ts')),
      text: text(c, 'text'),
      hash: text(c, 'hash'),
    })),
    links: links.map(toLink),
    closed,
    disposition: closed ? (decision === null ? { noDecision: true } : { decision }) : null,
    createdBy: text(row, 'created_by'),
    createdAt: decodeHlc(text(row, 'created_at')),
    version: int(row, 'version'),
    updatedAt: decodeHlc(text(row, 'updated_at')),
  };
}

function toLink(row: Row): TicketLink {
  const common = {
    actor: text(row, 'actor'),
    ts: decodeHlc(text(row, 'ts')),
    hash: text(row, 'hash'),
  };
  const value = JSON.parse(text(row, 'value')) as string | number;
  return text(row, 'kind') === 'pr'
    ? { type: 'pr', pr: value, ...common }
    : { type: 'decision', path: String(value), ...common };
}

/** One ticket from the cache rows, or null. */
export function loadTicket(db: DatabaseSync, id: string): Ticket | null {
  const row = stmt(db, 'SELECT * FROM tickets WHERE id = ?').get(id);
  if (row === undefined) {
    return null;
  }
  const comments = stmt(db, 'SELECT * FROM comments WHERE ticket = ? ORDER BY seq').all(id);
  const links = stmt(db, 'SELECT * FROM links WHERE ticket = ? ORDER BY seq').all(id);
  return toTicket(row, comments, links);
}

/** The whole board state from the cache rows. */
export function loadState(db: DatabaseSync): BoardState {
  const byTicket = (sql: string): Map<string, Row[]> => {
    const map = new Map<string, Row[]>();
    for (const row of stmt(db, sql).all()) {
      const id = text(row, 'ticket');
      const list = map.get(id);
      if (list === undefined) {
        map.set(id, [row]);
      } else {
        list.push(row);
      }
    }
    return map;
  };
  const comments = byTicket('SELECT * FROM comments ORDER BY ticket, seq');
  const links = byTicket('SELECT * FROM links ORDER BY ticket, seq');
  const tickets: Record<string, Ticket> = {};
  for (const row of stmt(db, 'SELECT * FROM tickets ORDER BY id').all()) {
    const id = text(row, 'id');
    tickets[id] = toTicket(row, comments.get(id) ?? [], links.get(id) ?? []);
  }
  const meta = Object.create(null) as Record<string, JsonValue>;
  const metaRows = stmt(
    db,
    "SELECT key, value FROM meta WHERE substr(key, 1, 6) = 'board.' ORDER BY key",
  ).all();
  for (const row of metaRows) {
    meta[text(row, 'key').slice(META_PREFIX.length)] = JSON.parse(text(row, 'value')) as JsonValue;
  }
  return { tickets, meta };
}

/** Prefix of `meta` keys holding `board.meta` settings. */
const META_PREFIX = 'board.';

/** How many comments and links a ticket had in the rows when it was loaded. */
interface Stored {
  comments: number;
  links: number;
}

/**
 * Writes `ticket` to the rows. Comments and links are append-only in the
 * fold, so only those beyond the counts already stored are inserted.
 */
function saveTicket(db: DatabaseSync, ticket: Ticket, stored: Stored | null): void {
  const disposition = ticket.disposition;
  stmt(
    db,
    `INSERT INTO tickets (id, title, description, status, blocked_from, assignee, version,
       updated_at, created_by, created_at, task_source, task_ref, task_item, adhoc, labels,
       closed, decision, checklist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       title = excluded.title, description = excluded.description, status = excluded.status,
       blocked_from = excluded.blocked_from, assignee = excluded.assignee,
       version = excluded.version, updated_at = excluded.updated_at,
       created_by = excluded.created_by, created_at = excluded.created_at,
       task_source = excluded.task_source, task_ref = excluded.task_ref,
       task_item = excluded.task_item, adhoc = excluded.adhoc, labels = excluded.labels,
       closed = excluded.closed, decision = excluded.decision, checklist = excluded.checklist`,
  ).run(
    ticket.id,
    ticket.title,
    ticket.description,
    ticket.status,
    ticket.blockedFrom,
    ticket.assignee,
    ticket.version,
    encodeHlc(ticket.updatedAt),
    ticket.createdBy,
    encodeHlc(ticket.createdAt),
    ticket.task?.source ?? null,
    ticket.task?.ref ?? null,
    ticket.task?.item ?? null,
    ticket.adhoc,
    jsonText(ticket.labels),
    ticket.closed ? 1 : 0,
    disposition !== null && 'decision' in disposition ? disposition.decision : null,
    jsonText(ticket.checklist),
  );
  const insertComment = stmt(
    db,
    'INSERT INTO comments (ticket, seq, actor, ts, text, hash) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let seq = stored?.comments ?? 0; seq < ticket.comments.length; seq += 1) {
    const c = ticket.comments[seq] as Ticket['comments'][number];
    insertComment.run(ticket.id, seq, c.actor, encodeHlc(c.ts), c.text, c.hash);
  }
  const insertLink = stmt(
    db,
    'INSERT INTO links (ticket, seq, kind, value, actor, ts, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let seq = stored?.links ?? 0; seq < ticket.links.length; seq += 1) {
    const l = ticket.links[seq] as TicketLink;
    const value = jsonText(l.type === 'pr' ? l.pr : l.path);
    insertLink.run(ticket.id, seq, l.type, value, l.actor, encodeHlc(l.ts), l.hash);
  }
}

// ---------------------------------------------------------------------------
// Applying events to rows

/**
 * Applies events to the cache rows with the fold's own step. Tickets are
 * loaded from the rows on first use and written back by `flush`, so a
 * rejected event (which `applyEvent` never applies) changes no row.
 */
export class FoldSession {
  private readonly db: DatabaseSync;
  private readonly state: BoardState = {
    tickets: {},
    meta: Object.create(null) as Record<string, JsonValue>,
  };
  private readonly stored = new Map<string, Stored | null>();
  private readonly dirty = new Set<string>();
  private readonly metaKeys = new Set<string>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The ticket as of the events applied so far in this session. */
  ticket(id: string): Ticket | null {
    if (!this.stored.has(id)) {
      const ticket = loadTicket(this.db, id);
      this.stored.set(
        id,
        ticket === null ? null : { comments: ticket.comments.length, links: ticket.links.length },
      );
      if (ticket !== null) {
        this.state.tickets[id] = ticket;
      }
    }
    return this.state.tickets[id] ?? null;
  }

  /** Applies one event in memory; `flush` writes the effects. */
  apply(input: FoldInput): ApplyOutcome {
    const { event } = input;
    if (isKnownEvent(event) && event.kind !== 'board.meta') {
      this.ticket(event.ticket);
    }
    const outcome = applyEvent(this.state, input);
    if (outcome.status === 'applied' && isKnownEvent(event)) {
      if (event.kind === 'board.meta') {
        this.metaKeys.add(event.body.key);
      } else {
        this.dirty.add(event.ticket);
      }
    }
    return outcome;
  }

  /** Writes every changed ticket and board setting to the rows. */
  flush(): void {
    for (const id of this.dirty) {
      const ticket = this.state.tickets[id] as Ticket;
      saveTicket(this.db, ticket, this.stored.get(id) ?? null);
      this.stored.set(id, { comments: ticket.comments.length, links: ticket.links.length });
    }
    this.dirty.clear();
    for (const key of this.metaKeys) {
      setMeta(this.db, `${META_PREFIX}${key}`, jsonText(this.state.meta[key]));
    }
    this.metaKeys.clear();
  }
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  stmt(
    db,
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** A fold position: the hash and timestamp of an event. */
export interface Position {
  hash: string;
  ts: Hlc;
}

/** `meta.last_position`, or null for a cache with no well-formed event. */
export function readLastPosition(db: DatabaseSync): Position | null {
  const row = stmt(db, "SELECT value FROM meta WHERE key = 'last_position'").get();
  return row === undefined ? null : (JSON.parse(text(row, 'value')) as Position | null);
}

function writeLastPosition(db: DatabaseSync, input: FoldInput): void {
  setMeta(db, 'last_position', jsonText({ hash: input.hash, ts: input.event.ts }));
}

/** Fold order between an input and a position. */
function compareToPosition(input: FoldInput, position: Position): number {
  return compareHlc(input.event.ts, position.ts) || (input.hash < position.hash ? -1 : 1);
}

/** Records one applied, rejected or unknown event in `folded`. */
function recordOutcome(db: DatabaseSync, input: FoldInput, outcome: ApplyOutcome): void {
  let reason: string | null = null;
  if (outcome.status === 'rejected') {
    reason = outcome.rejected.reason;
  } else if (outcome.status === 'unknown') {
    reason = 'unknown-kind';
  }
  stmt(db, 'INSERT INTO folded (hash, folded, reason, position) VALUES (?, ?, ?, ?)').run(
    input.hash,
    outcome.status === 'applied' ? 1 : 0,
    reason,
    encodeHlc(input.event.ts),
  );
}

/** What applying a batch of events did, in fold order. */
export interface BatchReport {
  applied: string[];
  rejected: Rejected[];
  unknown: UnknownReport[];
}

/**
 * Applies `inputs` (unique hashes, each sorting after `last_position`) and
 * records them and `malformed` in `folded`, then advances `last_position`.
 */
function applyBatch(
  db: DatabaseSync,
  inputs: readonly FoldInput[],
  malformed: readonly MalformedFile[],
): BatchReport {
  const report: BatchReport = { applied: [], rejected: [], unknown: [] };
  const ordered = [...inputs].sort(compareFoldOrder);
  const session = new FoldSession(db);
  for (const input of ordered) {
    const outcome = session.apply(input);
    recordOutcome(db, input, outcome);
    if (outcome.status === 'applied') {
      report.applied.push(input.hash);
    } else if (outcome.status === 'rejected') {
      report.rejected.push(outcome.rejected);
    } else {
      report.unknown.push(outcome.unknown);
    }
  }
  session.flush();
  const insertMalformed = stmt(
    db,
    "INSERT INTO folded (hash, folded, reason, position) VALUES (?, 0, 'malformed', NULL)",
  );
  for (const file of malformed) {
    insertMalformed.run(file.hash);
  }
  const top = ordered.at(-1);
  if (top !== undefined) {
    writeLastPosition(db, top);
  }
  return report;
}

/** Result of `refold`. */
export interface RefoldResult extends BatchReport {
  malformed: MalformedFile[];
  corrupt: CorruptFile[];
}

/**
 * Deletes every derived row (all but `cursors` and `meta.schema_version`)
 * and folds every event file from scratch. Caller holds the transaction.
 */
export function refold(db: DatabaseSync, eventsDir: string): RefoldResult {
  db.exec(`DELETE FROM comments; DELETE FROM links; DELETE FROM tickets; DELETE FROM folded;
    DELETE FROM meta WHERE key <> 'schema_version';
    INSERT INTO meta (key, value) VALUES ('last_position', 'null');`);
  const log = readEventLog(eventsDir);
  return {
    ...applyBatch(db, log.inputs, log.malformed),
    malformed: log.malformed,
    corrupt: log.corrupt,
  };
}

/**
 * The lock-free first look of `catchUp`: when there is no stale temporary
 * file to reap and no unrecorded event or malformed file to record, returns
 * the (empty) report, with the corrupt files, without taking the write
 * lock. Returns null when there is work, which must then be redone under the
 * lock by `catchUpLocked` (another process may have done it meanwhile).
 */
export function catchUpUnlocked(board: Board, now: number): CatchUpReport | null {
  const { eventsDir } = board;
  if (staleTemps(eventsDir, TEMP_PREFIX, now - STALE_TEMP_MS).length > 0) {
    return null;
  }
  const log = readEventLog(eventsDir, recordedHashes(board.db));
  if (log.inputs.length > 0 || log.malformed.length > 0) {
    return null;
  }
  const report: CatchUpReport = {
    applied: [],
    rejected: [],
    unknown: [],
    malformed: [],
    corrupt: log.corrupt,
    reaped: [],
    refolded: false,
  };
  return report;
}

function recordedHashes(db: DatabaseSync): Set<string> {
  return new Set(
    stmt(db, 'SELECT hash FROM folded')
      .all()
      .map((row) => text(row, 'hash')),
  );
}

/** `catchUp` with the transaction already held by the caller. */
export function catchUpLocked(board: Board, now: number): CatchUpReport {
  const { db, eventsDir } = board;
  const reaped = reapStaleTemps(eventsDir, { now });
  const recorded = recordedHashes(db);
  const log = readEventLog(eventsDir, recorded);
  const last = readLastPosition(db);
  const late = last !== null && log.inputs.some((input) => compareToPosition(input, last) < 0);
  if (!late) {
    return {
      ...applyBatch(db, log.inputs, log.malformed),
      malformed: log.malformed,
      corrupt: log.corrupt,
      reaped,
      refolded: false,
    };
  }
  const full = refold(db, eventsDir);
  const isNew = (hash: string): boolean => !recorded.has(hash);
  return {
    applied: full.applied.filter(isNew),
    rejected: full.rejected.filter((r) => isNew(r.hash)),
    unknown: full.unknown.filter((u) => isNew(u.hash)),
    malformed: full.malformed.filter((m) => isNew(m.hash)),
    corrupt: full.corrupt,
    reaped,
    refolded: true,
  };
}

/**
 * Records the command transaction's own event, already applied to
 * `session` and written to disk: its rows, its `folded` row and
 * `last_position` (it sorts after every folded event by construction).
 */
export function commitOwnEvent(
  db: DatabaseSync,
  session: FoldSession,
  input: FoldInput,
  outcome: ApplyOutcome,
): void {
  session.flush();
  recordOutcome(db, input, outcome);
  writeLastPosition(db, input);
}

// ---------------------------------------------------------------------------
// Dump rows

const PRIMARY_KEY: Record<DumpTable, string> = {
  comments: 'ticket, seq',
  folded: 'hash',
  links: 'ticket, seq',
  meta: 'key',
  tickets: 'id',
};

/** One dumped row with its primary key as text and its ticket, if any. */
export interface KeyedRow {
  key: string;
  ticket: string | null;
  row: Record<string, JsonValue>;
}

/** Every row of a derived table, in ascending primary key order. */
export function tableRows(db: DatabaseSync, table: DumpTable): KeyedRow[] {
  return stmt(db, `SELECT * FROM ${table} ORDER BY ${PRIMARY_KEY[table]}`)
    .all()
    .map((raw) => {
      const row = jsonRow(raw);
      switch (table) {
        case 'tickets':
          return { key: String(row.id), ticket: String(row.id), row };
        case 'comments':
        case 'links':
          return {
            key: `${String(row.ticket)}#${String(row.seq)}`,
            ticket: String(row.ticket),
            row,
          };
        case 'folded':
          return { key: String(row.hash), ticket: null, row };
        case 'meta':
          return { key: String(row.key), ticket: null, row };
      }
    });
}
