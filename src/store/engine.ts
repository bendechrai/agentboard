/**
 * Internal machinery shared by `cache.ts`, `transaction.ts` and `rebuild.ts`:
 * transactions with busy retry, row encoding of tickets, and applying events
 * to the cache rows with the fold's own per-event step (`applyEvent`), so
 * that the incremental path, the full refold and the command transaction
 * all produce exactly the rows a fresh fold would. Not part of the public
 * API (not re-exported from `src/index.ts`).
 */

import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';

import { canonicalEncode, canonicalHash, type JsonValue } from '../events/canonical.js';
import {
  applyEvent,
  compareFoldOrder,
  dueGrant,
  type ApplyOutcome,
  type Availability,
  type BoardState,
  type ChecklistItem,
  type FoldInput,
  type Lease,
  type Rejected,
  type Ticket,
  type TicketLink,
  type UnknownReport,
  type UnplannedDisposition,
  type Waiter,
} from '../events/fold.js';
import { dueGrants } from '../events/grants.js';
import { compareHlc, decodeHlc, encodeHlc, type Hlc } from '../events/hlc.js';
import { SYSTEM_ACTOR, isKnownEvent, type Status } from '../events/schema.js';
import type { Board } from './board.js';
import type { CatchUpReport, DumpTable } from './cache.js';
import { resetLateCursors, type CursorPosition, type LateEvent } from './cursors.js';
import { BoardError } from './errors.js';
import {
  STALE_TEMP_MS,
  TEMP_PREFIX,
  listEventFiles,
  readEventFile,
  readEventLog,
  reapStaleTemps,
  type EventLog,
  writeEventFile,
  type ReadOutcome,
  type CorruptFile,
  type MalformedFile,
  type WriteHooks,
} from './eventfile.js';
import { recordedPositions } from './folded.js';
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
export function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === 5
  );
}

/**
 * `BEGIN IMMEDIATE`, retried once when still busy after the busy timeout;
 * a second busy failure is `BoardError(5, 'busy')` (add-board-core design.md, Risks).
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

/** Longest single sleep between two attempts of `retryBusy`, in milliseconds. */
const MAX_BUSY_SLEEP_MS = 25;

/**
 * Runs `fn`, running it again while it throws SQLITE_BUSY, until `deadline`
 * (ms since the epoch) has passed; then throws `BoardError(5, 'busy')`.
 * Any other error propagates at once. Between attempts the thread sleeps
 * (`Atomics.wait`, never a spin) for a short, growing, jittered interval
 * capped at `MAX_BUSY_SLEEP_MS` and at the time left, so racing processes
 * spread out instead of retrying in lockstep.
 *
 * For statements SQLite may fail with SQLITE_BUSY without consulting the
 * busy handler, notably `PRAGMA journal_mode = WAL` while another
 * connection is creating or converting the same database file. `fn` must be
 * safe to run again after a busy failure.
 *
 * `fn` is always run at least once, even when `deadline` has already
 * passed; the deadline is only checked after a busy failure. The deadline
 * bounds when a new attempt may start, not how long one attempt blocks: an
 * attempt that waits in SQLite's busy handler (or in `beginImmediate`'s
 * retry) can end up to that wait after the deadline. A `BoardError`
 * (including `BoardError(5, 'busy')` from `beginImmediate`) is not
 * SQLITE_BUSY and propagates at once.
 */
export function retryBusy<T>(fn: () => T, deadline: number): T {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusy(error)) {
        throw error;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new BoardError(
          5,
          'busy',
          'the board cache stayed locked by another process; try again',
        );
      }
      const ceiling = Math.min(MAX_BUSY_SLEEP_MS, 2 ** Math.min(attempt, 5));
      Atomics.wait(cell, 0, 0, Math.min(left, 1 + Math.random() * ceiling));
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

/**
 * Runs `fn` inside one deferred read transaction (`BEGIN` ... `COMMIT`)
 * unless the connection is already in a transaction, in which case `fn`
 * runs inside the caller's. A deferred `BEGIN` takes no lock until the
 * first read, and a WAL reader never waits for the write lock.
 */
export function inSnapshot<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    return fn();
  }
  db.exec('BEGIN');
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

/** The lease of a ticket row: null when `lease_ttl` is null (the four columns go together). */
function toLease(row: Row): Lease | null {
  if (row.lease_ttl === null) {
    return null;
  }
  return {
    ttl: int(row, 'lease_ttl'),
    expiresAt: int(row, 'lease_expires_at'),
    event: text(row, 'lease_event'),
    confirmed: int(row, 'lease_confirmed') === 1,
  };
}

/** The availability of a ticket row: null when `available_at` is null. */
function toAvailability(row: Row): Availability | null {
  if (row.available_at === null) {
    return null;
  }
  return { at: int(row, 'available_at'), event: text(row, 'available_event') };
}

function toWaiter(row: Row): Waiter {
  return {
    actor: text(row, 'actor'),
    ttl: int(row, 'ttl'),
    event: text(row, 'hash'),
    joined: decodeHlc(text(row, 'ts')),
  };
}

/**
 * `Ticket.unplanned` from the `unplanned` column: null, or the canonical
 * JSON of an `UnplannedDisposition` that `saveTicket` wrote.
 */
function toUnplanned(row: Row): UnplannedDisposition | null {
  const json = nullableText(row, 'unplanned');
  return json === null ? null : (JSON.parse(json) as UnplannedDisposition);
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

function toTicket(row: Row, comments: Row[], links: Row[], waiters: Row[]): Ticket {
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
    lease: toLease(row),
    queue: waiters.map(toWaiter),
    available: toAvailability(row),
    labels: JSON.parse(text(row, 'labels')) as string[],
    task:
      source === null ? null : { source, ref: text(row, 'task_ref'), item: text(row, 'task_item') },
    adhoc: nullableText(row, 'adhoc'),
    unplanned: toUnplanned(row),
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
  const waiters = stmt(db, 'SELECT * FROM waiters WHERE ticket = ? ORDER BY position').all(id);
  return toTicket(row, comments, links, waiters);
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
  const waiters = byTicket('SELECT * FROM waiters ORDER BY ticket, position');
  const tickets: Record<string, Ticket> = {};
  for (const row of stmt(db, 'SELECT * FROM tickets ORDER BY id').all()) {
    const id = text(row, 'id');
    tickets[id] = toTicket(row, comments.get(id) ?? [], links.get(id) ?? [], waiters.get(id) ?? []);
  }
  return { tickets, meta: loadMeta(db) };
}

/** The board `meta` settings from the cache rows, as a null-prototype object. */
export function loadMeta(db: DatabaseSync): Record<string, JsonValue> {
  const meta = Object.create(null) as Record<string, JsonValue>;
  const metaRows = stmt(
    db,
    "SELECT key, value FROM meta WHERE substr(key, 1, 6) = 'board.' ORDER BY key",
  ).all();
  for (const row of metaRows) {
    meta[text(row, 'key').slice(META_PREFIX.length)] = JSON.parse(text(row, 'value')) as JsonValue;
  }
  return meta;
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
 * fold, so only those beyond the counts already stored are inserted. The
 * queue is not append-only (leaves, grants and hand-offs remove waiters
 * from anywhere in it), so its rows are replaced.
 */
function saveTicket(db: DatabaseSync, ticket: Ticket, stored: Stored | null): void {
  const { disposition, lease, available } = ticket;
  stmt(
    db,
    `INSERT INTO tickets (id, title, description, status, blocked_from, assignee, lease_ttl,
       lease_expires_at, lease_event, lease_confirmed, available_at, available_event, version,
       updated_at, created_by, created_at, task_source, task_ref, task_item, adhoc, unplanned,
       labels, closed, decision, checklist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       title = excluded.title, description = excluded.description, status = excluded.status,
       blocked_from = excluded.blocked_from, assignee = excluded.assignee,
       lease_ttl = excluded.lease_ttl, lease_expires_at = excluded.lease_expires_at,
       lease_event = excluded.lease_event, lease_confirmed = excluded.lease_confirmed,
       available_at = excluded.available_at, available_event = excluded.available_event,
       version = excluded.version, updated_at = excluded.updated_at,
       created_by = excluded.created_by, created_at = excluded.created_at,
       task_source = excluded.task_source, task_ref = excluded.task_ref,
       task_item = excluded.task_item, adhoc = excluded.adhoc, unplanned = excluded.unplanned,
       labels = excluded.labels, closed = excluded.closed, decision = excluded.decision,
       checklist = excluded.checklist`,
  ).run(
    ticket.id,
    ticket.title,
    ticket.description,
    ticket.status,
    ticket.blockedFrom,
    ticket.assignee,
    lease?.ttl ?? null,
    lease?.expiresAt ?? null,
    lease?.event ?? null,
    lease === null ? null : lease.confirmed ? 1 : 0,
    available?.at ?? null,
    available?.event ?? null,
    ticket.version,
    encodeHlc(ticket.updatedAt),
    ticket.createdBy,
    encodeHlc(ticket.createdAt),
    ticket.task?.source ?? null,
    ticket.task?.ref ?? null,
    ticket.task?.item ?? null,
    ticket.adhoc,
    ticket.unplanned === null ? null : jsonText(ticket.unplanned),
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
  saveWaiters(db, ticket);
}

/** Replaces the `waiters` rows of `ticket` with its queue, in order. */
function saveWaiters(db: DatabaseSync, ticket: Ticket): void {
  stmt(db, 'DELETE FROM waiters WHERE ticket = ?').run(ticket.id);
  const insertWaiter = stmt(
    db,
    'INSERT INTO waiters (ticket, position, actor, ttl, hash, ts) VALUES (?, ?, ?, ?, ?, ?)',
  );
  ticket.queue.forEach((w, position) => {
    insertWaiter.run(ticket.id, position, w.actor, w.ttl, w.event, encodeHlc(w.joined));
  });
}

// ---------------------------------------------------------------------------
// Applying events to rows

/**
 * Applies events to the cache rows with the fold's own step. Tickets are
 * loaded from the rows on first use and written back by `flush`, so a
 * rejected event (which `applyEvent` never applies) changes no row. The
 * board settings are loaded from the rows when the session starts, because
 * the fold reads them (a grant's window) at the position of each event.
 *
 * Every event a session applies must sort after `last_position` (the
 * incremental path, the command's own event, and a refold, which starts
 * from empty rows). The session also keeps the `grant_watermark` meta row
 * (see `GRANT_WATERMARK_KEY`): the slot time of the first grant that would
 * be due and is not folded. When the stored watermark sorts strictly before
 * the first event applied, that grant is still the first missing one and
 * the row is left alone. Otherwise the stored value can only have come from
 * the state at `last_position`, so the session derives it again: before
 * each event, the grant `dueGrant` derives for each waiting ticket that
 * sorts strictly before that event is missing, and the first one found
 * gives the watermark; when there is none, the earliest grant due in the
 * final state does, and when no ticket has a grant due the row is removed.
 * This is the first grant `dueGrants` returns with no bound on the clock,
 * so catch-up and `rebuild` write the same row.
 */
export class FoldSession {
  private readonly db: DatabaseSync;
  private readonly state: BoardState;
  private readonly stored = new Map<string, Stored | null>();
  private readonly dirty = new Set<string>();
  private readonly metaKeys = new Set<string>();
  /** Null until the first event is applied; then whether the watermark is kept as stored. */
  private frozen: boolean | null = null;
  /** Ids of the tickets with a non-empty queue, loaded on first use. */
  private waitingIds: Set<string> | null = null;
  /** Slot of the first missing grant found before an applied event, if any. */
  private mark: number | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.state = { tickets: {}, meta: loadMeta(db) };
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
    if (this.frozen === null) {
      const stored = readWatermark(this.db);
      this.frozen = stored !== null && compareHlc(slotTs(stored), event.ts) < 0;
    }
    if (!this.frozen && this.mark === null) {
      this.mark = this.firstSlot(input);
    }
    if (isKnownEvent(event) && event.kind !== 'board.meta') {
      this.ticket(event.ticket);
    }
    const outcome = applyEvent(this.state, input);
    if (outcome.status === 'applied' && isKnownEvent(event)) {
      if (event.kind === 'board.meta') {
        this.metaKeys.add(event.body.key);
      } else {
        this.dirty.add(event.ticket);
        if (!this.frozen) {
          const waiting = this.waiting();
          if ((this.state.tickets[event.ticket]?.queue.length ?? 0) > 0) {
            waiting.add(event.ticket);
          } else {
            waiting.delete(event.ticket);
          }
        }
      }
    }
    return outcome;
  }

  /** Writes every changed ticket, board setting and the grant watermark to the rows. */
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
    if (this.frozen === false) {
      writeWatermark(this.db, this.mark ?? this.firstSlot(null));
    }
  }

  private waiting(): Set<string> {
    if (this.waitingIds === null) {
      this.waitingIds = new Set(
        stmt(this.db, 'SELECT DISTINCT ticket FROM waiters')
          .all()
          .map((row) => text(row, 'ticket')),
      );
    }
    return this.waitingIds;
  }

  /**
   * The earliest slot time of a grant due in the current state that sorts
   * strictly before `next` (any, when `next` is null), or null.
   */
  private firstSlot(next: FoldInput | null): number | null {
    let first: number | null = null;
    for (const id of this.waiting()) {
      const ticket = this.ticket(id);
      const grant = ticket === null ? null : dueGrant(ticket, this.state.meta);
      if (grant === null || (first !== null && grant.ts.wall >= first)) {
        continue;
      }
      if (next !== null) {
        const order = compareHlc(grant.ts, next.event.ts);
        // Equal timestamps happen only between grants; the hash then decides.
        if (order > 0 || (order === 0 && canonicalHash(grant) >= next.hash)) {
          continue;
        }
      }
      first = grant.ts.wall;
    }
    return first;
  }
}

/**
 * Key of the `meta` row holding the grant watermark: the slot time, as a
 * JSON number, of the first grant that would be due and is not folded,
 * absent when there is none (board-cache: "Cache schema"). Catch-up reads
 * event files to derive grants only once the clock reaches it.
 */
export const GRANT_WATERMARK_KEY = 'grant_watermark';

/** The grant watermark, or null when the row is absent. */
export function readWatermark(db: DatabaseSync): number | null {
  const row = stmt(db, 'SELECT value FROM meta WHERE key = ?').get(GRANT_WATERMARK_KEY);
  return row === undefined ? null : (JSON.parse(text(row, 'value')) as number);
}

function writeWatermark(db: DatabaseSync, slot: number | null): void {
  if (slot === null) {
    stmt(db, 'DELETE FROM meta WHERE key = ?').run(GRANT_WATERMARK_KEY);
  } else {
    setMeta(db, GRANT_WATERMARK_KEY, jsonText(slot));
  }
}

/** The timestamp of a grant with slot time `wall`. */
function slotTs(wall: number): Hlc {
  return { wall, counter: 0, actor: SYSTEM_ACTOR };
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
 * Deletes every derived row (all but `cursors`, `cursor_seen` and
 * `meta.schema_version`), board settings and the grant watermark included,
 * and folds every event file from scratch: `log` when given (catch-up
 * passes the log it read through the board's read outcomes), otherwise
 * `readEventLog(eventsDir)`. Caller holds the transaction.
 */
export function refold(db: DatabaseSync, eventsDir: string, log?: EventLog): RefoldResult {
  db.exec(`DELETE FROM comments; DELETE FROM links; DELETE FROM waiters; DELETE FROM tickets;
    DELETE FROM folded;
    DELETE FROM meta WHERE key <> 'schema_version';
    INSERT INTO meta (key, value) VALUES ('last_position', 'null');`);
  return foldAll(db, log ?? readEventLog(eventsDir));
}

function foldAll(db: DatabaseSync, log: EventLog): RefoldResult {
  return {
    ...applyBatch(db, log.inputs, log.malformed),
    malformed: log.malformed,
    corrupt: log.corrupt,
  };
}

/**
 * The lock-free first look of `catchUp`: when there is no stale temporary
 * file to reap, every unrecorded event file name (if any) is corrupt, and
 * the clock is before the grant watermark (or there is none), returns the
 * (empty) report, with those corrupt files, without taking the write lock.
 * It lists the event file names and reads the cache; the only files it
 * reads are unrecorded ones, so a warm look with nothing due reads none.
 * Returns null when there is work, which must then be redone under the
 * lock by `catchUpLocked` (another process may have done it meanwhile).
 */
export function catchUpUnlocked(
  board: Board,
  now: number,
  probe?: ReadProbe,
): CatchUpReport | null {
  const { eventsDir } = board;
  if (staleTemps(eventsDir, TEMP_PREFIX, now - STALE_TEMP_MS).length > 0) {
    return null;
  }
  const log = readNewFiles(board, recordedHashes(board.db), probe);
  if (log.inputs.length > 0 || log.malformed.length > 0) {
    return null;
  }
  const watermark = readWatermark(board.db);
  if (watermark !== null && now >= watermark) {
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

/** Called with an event file's name each time catch-up reads its bytes. */
export type ReadProbe = (name: string) => void;

/**
 * The read outcome of the event file `name`. Event files are immutable and
 * named by the hash of their bytes, so the outcome of a well-formed or
 * malformed file is kept for the life of `board` (`readOutcomes`) and a
 * process that catches up repeatedly (the web server, `watch`) reads each
 * file once. A corrupt outcome is not kept, so such a file is read again
 * every time. `probe` is called for every read from disk.
 */
function readOutcome(board: Board, name: string, probe: ReadProbe | undefined): ReadOutcome {
  let known = readOutcomes.get(board);
  if (known === undefined) {
    known = new Map();
    readOutcomes.set(board, known);
  }
  let outcome = known.get(name);
  if (outcome === undefined) {
    probe?.(name);
    outcome = readEventFile(board.eventsDir, name);
    if (outcome.status !== 'corrupt') {
      known.set(name, outcome);
    }
  }
  return outcome;
}

/** The read outcomes of `readOutcome`, per open board, by file name. */
const readOutcomes = new WeakMap<Board, Map<string, ReadOutcome>>();

/**
 * Reads the event files whose name is not a recorded hash, partitioned as
 * `readEventLog` does. A recorded file is not read, so one changed in place
 * after it was recorded is invisible here; `rebuild` and `rebuild --check`
 * report it.
 */
function readNewFiles(
  board: Board,
  recorded: ReadonlySet<string>,
  probe: ReadProbe | undefined,
): EventLog {
  return readFiles(
    board,
    listEventFiles(board.eventsDir).filter((name) => !recorded.has(name.replace(/\.json$/, ''))),
    probe,
  );
}

/** Every event file, partitioned as `readEventLog` does, through `readOutcome`. */
function readAllFiles(board: Board, probe: ReadProbe | undefined): EventLog {
  return readFiles(board, listEventFiles(board.eventsDir), probe);
}

function readFiles(board: Board, names: readonly string[], probe: ReadProbe | undefined): EventLog {
  const log: EventLog = { inputs: [], corrupt: [], malformed: [] };
  for (const name of names) {
    const outcome = readOutcome(board, name, probe);
    if (outcome.status === 'ok') {
      log.inputs.push(outcome.input);
    } else if (outcome.status === 'malformed') {
      log.malformed.push(outcome.file);
    } else {
      log.corrupt.push(outcome.file);
    }
  }
  return log;
}

function recordedHashes(db: DatabaseSync): Set<string> {
  return new Set(
    stmt(db, 'SELECT hash FROM folded')
      .all()
      .map((row) => text(row, 'hash')),
  );
}

/** The `folded` flag of every recorded hash (1 applied, 0 anything else). */
export function recordedFlags(db: DatabaseSync): Map<string, number> {
  return new Map(
    stmt(db, 'SELECT hash, folded FROM folded')
      .all()
      .map((row) => [text(row, 'hash'), int(row, 'folded')]),
  );
}

/**
 * The events applied now that were not applied according to `prior` (a
 * `recordedFlags` snapshot taken before a refold): recorded for the first
 * time, or flipped from rejected to applied.
 */
export function becameEffective(
  db: DatabaseSync,
  prior: ReadonlyMap<string, number>,
): CursorPosition[] {
  return recordedPositions(db, { effectiveOnly: true })
    .filter((recorded) => prior.get(recorded.hash) !== 1)
    .map(({ hash, ts }) => ({ hash, ts }));
}

/**
 * `refold` followed by `resetLateCursors` for every event it made
 * effective (see `RebuildReport.late`). Caller holds the transaction.
 */
export function refoldWithCursors(
  db: DatabaseSync,
  eventsDir: string,
): { result: RefoldResult; late: LateEvent[] } {
  const prior = recordedFlags(db);
  const result = refold(db, eventsDir);
  return { result, late: resetLateCursors(db, becameEffective(db, prior)) };
}

/** Options of `catchUpLocked`. */
export interface LockedOptions {
  hooks?: WriteHooks | undefined;
  probe?: ReadProbe | undefined;
}

/**
 * `catchUp` with the transaction already held by the caller. Reaps stale
 * temporaries and folds the files not yet recorded (`foldNew`). Then, only
 * when the clock has reached the grant watermark, reads every event file,
 * writes the grants `dueGrants` returns at `now` (`writeEventFile` with
 * `hooks`, so a file already there is left as it is) and folds them the
 * same way. The report covers both steps, its event arrays in fold order.
 */
export function catchUpLocked(board: Board, now: number, options?: LockedOptions): CatchUpReport {
  const { db } = board;
  const probe = options?.probe;
  const reaped = reapStaleTemps(board.eventsDir, { now });
  const fresh = readNewFiles(board, new Set(recordedFlags(db).keys()), probe);
  const first = foldNew(board, fresh.inputs, fresh.malformed, probe);
  const watermark = readWatermark(db);
  if (watermark === null || now < watermark) {
    return { ...first, corrupt: first.corrupt ?? fresh.corrupt, reaped };
  }
  const walked = readAllFiles(board, probe);
  const grants = dueGrants(walked.inputs, now);
  for (const grant of grants) {
    writeEventFile(board.eventsDir, grant.event, options?.hooks);
  }
  const second = foldNew(board, grants, [], probe);
  const order = new Map(
    [...fresh.inputs, ...grants].map((input): [string, FoldInput] => [input.hash, input]),
  );
  const byFoldOrder = (a: { hash: string }, b: { hash: string }): number =>
    compareFoldOrder(order.get(a.hash) as FoldInput, order.get(b.hash) as FoldInput);
  return {
    applied: [...first.applied, ...second.applied]
      .map((hash) => ({ hash }))
      .sort(byFoldOrder)
      .map(({ hash }) => hash),
    rejected: [...first.rejected, ...second.rejected].sort(byFoldOrder),
    unknown: [...first.unknown, ...second.unknown].sort(byFoldOrder),
    malformed: first.malformed,
    // The walk reads recorded files too, so it also sees one corrupted in place.
    corrupt: byName([...(second.corrupt ?? first.corrupt ?? fresh.corrupt), ...walked.corrupt]),
    reaped,
    refolded: first.refolded || second.refolded,
  };
}

/** `files` without repeated names, in name order. */
function byName(files: readonly CorruptFile[]): CorruptFile[] {
  const unique = new Map(files.map((file): [string, CorruptFile] => [file.name, file]));
  return [...unique.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What `foldNew` did; `corrupt` is set only by a refold, which lists every corrupt file. */
interface FoldNewReport extends BatchReport {
  malformed: MalformedFile[];
  corrupt: CorruptFile[] | null;
  refolded: boolean;
}

/**
 * Folds `inputs` and `malformed`, none of them recorded yet: incrementally
 * when every input sorts after `last_position`, and otherwise by a full
 * refold (through the board's read outcomes), moving inbox cursors back for
 * every event the refold made effective. The arrays list only the events
 * given, in fold order.
 */
function foldNew(
  board: Board,
  inputs: readonly FoldInput[],
  malformed: readonly MalformedFile[],
  probe: ReadProbe | undefined,
): FoldNewReport {
  const { db } = board;
  const last = readLastPosition(db);
  const late = last !== null && inputs.some((input) => compareToPosition(input, last) < 0);
  if (!late) {
    const batch = applyBatch(db, inputs, malformed);
    const applied = new Set(batch.applied);
    // Every event here sorts after last_position, so after every cursor (a
    // cursor only points at a folded event): this moves no cursor, grants
    // included, and keeps the incremental path to the same contract.
    resetLateCursors(
      db,
      inputs
        .filter((input) => applied.has(input.hash))
        .map((input) => ({ hash: input.hash, ts: input.event.ts })),
    );
    return { ...batch, malformed: [...malformed], corrupt: null, refolded: false };
  }
  const prior = recordedFlags(db);
  const full = refold(db, board.eventsDir, readAllFiles(board, probe));
  resetLateCursors(db, becameEffective(db, prior));
  const isNew = (hash: string): boolean => !prior.has(hash);
  return {
    applied: full.applied.filter(isNew),
    rejected: full.rejected.filter((r) => isNew(r.hash)),
    unknown: full.unknown.filter((u) => isNew(u.hash)),
    malformed: full.malformed.filter((m) => isNew(m.hash)),
    corrupt: full.corrupt,
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
  waiters: 'ticket, position',
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
        case 'waiters':
          return {
            key: `${String(row.ticket)}#${String(row.position)}`,
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
