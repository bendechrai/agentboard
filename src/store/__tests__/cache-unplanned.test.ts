/**
 * The unplanned disposition in the cache (add-adhoc-ticket-lifecycle task
 * 1.4; board-cache: "Cache schema", scenarios "Unplanned disposition
 * survives a rebuild" and "Cache from an earlier schema is rebuilt").
 *
 * Events are written as files (`putEvent`), as another process or a sync
 * leaves them, so these tests depend on the fold only through the store;
 * the `move merged --unplanned` command the scenarios name is group 2's,
 * and its two events are written here by hand in the order it writes them.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeHlc } from '../../events/hlc.js';
import type { BoardEvent, TaskRef } from '../../events/schema.js';
import { openBoard, type Board } from '../board.js';
import {
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  dumpCache,
  openCache,
  readState,
  readTicket,
} from '../cache.js';
import { checkCache, rebuild } from '../rebuild.js';
import { P, T1, T2, canon, copyBoard, ev, foldDir, putEvent, tempBoard, tempDir } from './helpers.js';

const open: Board[] = [];

function openB(dir: string): Board {
  const board = openBoard(dir, { now: 0 });
  open.push(board);
  return board;
}

const extra: DatabaseSync[] = [];

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

function freshDump(eventsDir: string): string {
  return dumpCache(openB(copyBoard(eventsDir)).db);
}

/** Every row of `table`, as plain objects. */
function rows(db: DatabaseSync, table: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM ${table}`)
    .all()
    .map((r) => ({ ...r }));
}

function ticketRow(board: Board, id = T1): Row {
  return board.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[])
    .map((r) => String(r.name))
    .sort();
}

const OTHER_TASK: TaskRef = { source: 'openspec', ref: 'add-login', item: '2' };

/** Writes `events` as files and returns their hashes, in order. */
function put(eventsDir: string, ...events: BoardEvent[]): string[] {
  return events.map((e) => putEvent(eventsDir, e));
}

/** An ad hoc ticket created at wall 1000 and moved to review by 4000. */
function adhocInReview(ticket = T1): BoardEvent[] {
  return [
    ev({ kind: 'ticket.create', ticket, body: { title: 'Hotfix', adhoc: 'seen in prod' } }, 'orch', 1000),
    ev(P.move(ticket, 'tests'), 'orch', 2000),
    ev(P.move(ticket, 'implementing'), 'orch', 3000),
    ev(P.move(ticket, 'review'), 'orch', 4000),
  ];
}

/** The two events `move <id> merged --unplanned "hotfix"` writes, at wall 5000. */
function mergedAsUnplanned(ticket = T1, reason = 'hotfix'): BoardEvent[] {
  return [
    ev(P.unplanned(ticket, reason), 'merger', 5000),
    ev(P.move(ticket, 'merged'), 'merger', 5000, 1),
  ];
}

const UNPLANNED_JSON =
  '{"actor":"merger","reason":"hotfix","ts":{"actor":"merger","counter":0,"wall":5000}}';

describe('the unplanned column', () => {
  it('is part of the tickets table and the schema version is 5', () => {
    const db = openCache(join(tempDir(), 'c.sqlite'));
    extra.push(db);
    expect(columns(db, 'tickets')).toContain('unplanned');
    expect(CACHE_SCHEMA_VERSION).toBe(5);
  });

  it('holds the disposition as canonical JSON, and null without one', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ...mergedAsUnplanned());
    put(events, ev(P.create(T2, 'Planned'), 'orch', 1500));
    const board = openB(dir);
    expect(ticketRow(board).unplanned).toBe(UNPLANNED_JSON);
    expect(ticketRow(board, T2).unplanned).toBeNull();
    expect(readTicket(board.db, T1)?.unplanned).toEqual({
      reason: 'hotfix',
      actor: 'merger',
      ts: { wall: 5000, counter: 0, actor: 'merger' },
    });
    expect(readTicket(board.db, T2)?.unplanned).toBeNull();
  });

  it('reconstructs exactly the folded state, disposition included', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ...mergedAsUnplanned());
    put(events, ...adhocInReview(T2), ev(P.unplanned(T2, 'left in review'), 'orch', 6000));
    const board = openB(dir);
    const expected = foldDir(events).state;
    expect(readTicket(board.db, T1)).toEqual(expected.tickets[T1]);
    expect(readTicket(board.db, T2)).toEqual(expected.tickets[T2]);
    expect(canon(readState(board.db))).toBe(canon(expected));
    expect(ticketRow(board).status).toBe('merged');
    expect(ticketRow(board, T2).status).toBe('review');
  });

  it('is cleared by a later task link, in the row and the ticket', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(
      events,
      ...adhocInReview(),
      ...mergedAsUnplanned(),
      ev({ kind: 'ticket.link', ticket: T1, body: { task: OTHER_TASK } }, 'orch', 6000),
    );
    const board = openB(dir);
    expect(ticketRow(board)).toMatchObject({
      unplanned: null,
      adhoc: null,
      task_source: 'openspec',
      task_ref: 'add-login',
      task_item: '2',
    });
    expect(readTicket(board.db, T1)?.unplanned).toBeNull();
  });

  it('is replaced by a later disposition, keeping the latest', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ...mergedAsUnplanned());
    const board = openB(dir);
    put(events, ev(P.unplanned(T1, 'on reflection'), 'orch', 7000));
    board.close();
    const reopened = openB(dir);
    expect(reopened.opened?.applied).toHaveLength(1);
    expect(ticketRow(reopened).unplanned).toBe(
      '{"actor":"orch","reason":"on reflection","ts":{"actor":"orch","counter":0,"wall":7000}}',
    );
    expect(dumpCache(reopened.db)).toBe(freshDump(events));
  });

  it('a rejected disposition (already-linked) leaves the column null', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const [, , , , rejected] = put(
      events,
      ev(P.create(T1), 'orch', 1000),
      ev(P.move(T1, 'tests'), 'orch', 2000),
      ev(P.move(T1, 'implementing'), 'orch', 3000),
      ev(P.move(T1, 'review'), 'orch', 4000),
      ev(P.unplanned(T1, 'y'), 'orch', 5000),
    );
    const board = openB(dir);
    expect(ticketRow(board).unplanned).toBeNull();
    expect(
      board.db.prepare('SELECT folded, reason FROM folded WHERE hash = ?').get(rejected ?? ''),
    ).toEqual({ folded: 0, reason: 'already-linked' });
  });

  it('a late disposition sorting before the last position refolds the row', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ev(P.comment(T1, 'later'), 'orch', 9000));
    const board = openB(dir);
    // Synced in afterwards, written on another machine at wall 5000.
    put(events, ...mergedAsUnplanned());
    board.close();
    const reopened = openB(dir);
    expect(reopened.opened?.refolded).toBe(true);
    expect(ticketRow(reopened)).toMatchObject({ status: 'merged', unplanned: UNPLANNED_JSON });
    expect(dumpCache(reopened.db)).toBe(freshDump(events));
  });
});

describe('scenario: unplanned disposition survives a rebuild', () => {
  function merged(): { board: Board; events: string } {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ...mergedAsUnplanned());
    return { board: openB(dir), events };
  }

  it('rebuild twice gives byte-identical dumps and the same unplanned each time', () => {
    const { board, events } = merged();
    const before = readTicket(board.db, T1)?.unplanned;
    rebuild(board);
    const first = dumpCache(board.db);
    expect(readTicket(board.db, T1)?.unplanned).toEqual(before);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(first);
    expect(readTicket(board.db, T1)?.unplanned).toEqual(before);
    expect(first).toBe(freshDump(events));
    expect(ticketRow(board).unplanned).toBe(UNPLANNED_JSON);
    expect(checkCache(board).ok).toBe(true);
  });

  it('rebuild --check detects a hand-edited unplanned value and leaves the live cache unchanged', () => {
    const { board } = merged();
    const edited =
      '{"actor":"merger","reason":"edited by hand","ts":{"actor":"merger","counter":0,"wall":5000}}';
    board.db.prepare('UPDATE tickets SET unplanned = ? WHERE id = ?').run(edited, T1);
    const dump = dumpCache(board.db);
    const result = checkCache(board);
    expect(result.ok).toBe(false);
    expect(result.differences).toHaveLength(1);
    const [diff] = result.differences;
    expect(diff).toMatchObject({ table: 'tickets', key: T1, ticket: T1 });
    expect(diff?.live?.unplanned).toBe(edited);
    expect(diff?.rebuilt?.unplanned).toBe(UNPLANNED_JSON);
    expect(dumpCache(board.db)).toBe(dump);
    expect(readTicket(board.db, T1)?.unplanned?.reason).toBe('edited by hand');
  });

  it('rebuild --check detects an unplanned value nulled by hand', () => {
    const { board } = merged();
    board.db.prepare('UPDATE tickets SET unplanned = NULL WHERE id = ?').run(T1);
    const result = checkCache(board);
    expect(result.ok).toBe(false);
    expect(result.differences.map((d) => [d.table, d.key])).toEqual([['tickets', T1]]);
    expect(result.differences[0]?.live?.unplanned).toBeNull();
    expect(result.differences[0]?.rebuilt?.unplanned).toBe(UNPLANNED_JSON);
  });

  it('rebuild repairs a hand-edited unplanned value', () => {
    const { board, events } = merged();
    board.db.prepare('UPDATE tickets SET unplanned = NULL WHERE id = ?').run(T1);
    rebuild(board);
    expect(ticketRow(board).unplanned).toBe(UNPLANNED_JSON);
    expect(dumpCache(board.db)).toBe(freshDump(events));
  });
});

describe('scenario: cache from an earlier schema is rebuilt', () => {
  it('drops a version 3 cache without the unplanned column and rebuilds it with the column', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ...mergedAsUnplanned());
    openB(dir).close();
    // A version 3 cache, as the previous release left it: no `unplanned`
    // column, every event recorded (the disposition as an unknown kind),
    // and a cursor.
    const old = new DatabaseSync(join(dir, CACHE_FILE));
    old.exec(`ALTER TABLE tickets DROP COLUMN unplanned;
      UPDATE meta SET value = '3' WHERE key = 'schema_version';
      UPDATE tickets SET status = 'review';
      INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash)
        VALUES ('b', 0, 0, 'orch', 'x');`);
    expect(columns(old, 'tickets')).not.toContain('unplanned');
    old.close();

    const board = openB(dir);
    expect(board.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: '5',
    });
    expect(columns(board.db, 'tickets')).toContain('unplanned');
    // The cursor is carried across the recreate (keep-cursors-on-upgrade):
    // the version 3 tables have the expected shape.
    expect(rows(board.db, 'cursors')).toEqual([
      { actor: 'b', last_wall: 0, last_counter: 0, last_actor: 'orch', last_hash: 'x' },
    ]);
    expect(
      board.db.prepare("SELECT name FROM sqlite_master WHERE name = 'carried_applied'").get(),
    ).toBeUndefined();
    expect(ticketRow(board)).toMatchObject({ status: 'merged', unplanned: UNPLANNED_JSON });
    expect(readTicket(board.db, T1)?.unplanned?.reason).toBe('hotfix');
    expect(dumpCache(board.db)).toBe(freshDump(events));
    expect(checkCache(board).ok).toBe(true);
  });

  it('an inspect-only open refuses a version 3 cache with schema-mismatch', () => {
    const dir = tempBoard();
    put(join(dir, 'events'), ...adhocInReview());
    openB(dir).close();
    const old = new DatabaseSync(join(dir, CACHE_FILE));
    old.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
    old.close();
    expect(() => openCache(join(dir, CACHE_FILE), { prepare: false })).toThrow(
      /schema version 5.*schema version 3/,
    );
  });
});

describe('the disposition in the row encodings', () => {
  it('stores the event timestamp inside the JSON, not as a separate column', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    put(events, ...adhocInReview(), ...mergedAsUnplanned());
    const board = openB(dir);
    const row = ticketRow(board);
    expect(Object.keys(row).filter((k) => k.startsWith('unplanned'))).toEqual(['unplanned']);
    expect(row.updated_at).toBe(encodeHlc({ wall: 5000, counter: 1, actor: 'merger' }));
    const parsed = JSON.parse(String(row.unplanned)) as { ts: { wall: number } };
    expect(parsed.ts.wall).toBe(5000);
  });
});

describe('a malformed ticket.unplanned on disk is not folded (scenario: Unplanned body is checked)', () => {
  function board(): { dir: string; events: string; ticketWall: number } {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(
      events,
      ev({ kind: 'ticket.create', ticket: T1, body: { title: 'Adhoc', adhoc: 'hotfix' } }, 'orch', 1000),
    );
    for (const [n, to] of (['tests', 'implementing', 'review'] as const).entries()) {
      putEvent(events, ev(P.move(T1, to), 'impl', 1100 + n * 100));
    }
    return { dir, events, ticketWall: 1300 };
  }

  it.each([
    ['an empty reason', { reason: '' }, 'body.reason'],
    ['a missing reason', {}, 'body.reason'],
    ['an extra field', { reason: 'hotfix', note: 'x' }, 'body.note'],
  ])('%s: catch-up records the file as malformed naming the field and leaves unplanned null', (_name, body, field) => {
    const { dir, events } = board();
    const malformed = putEvent(events, {
      v: 1,
      kind: 'ticket.unplanned',
      ticket: T1,
      actor: 'orch',
      ts: { wall: 2000, counter: 0, actor: 'orch' },
      body,
    });
    const b = openB(dir);
    expect(b.opened?.malformed.map((m) => m.hash)).toEqual([malformed]);
    expect(b.opened?.malformed[0]?.reasons.map((r) => r.field)).toContain(field);
    expect(b.opened?.applied).toHaveLength(4);
    expect(readTicket(b.db, T1)).toMatchObject({ status: 'review', unplanned: null, version: 4 });
    const row = b.db.prepare('SELECT folded, reason FROM folded WHERE hash = ?').get(malformed);
    expect(row).toEqual({ folded: 0, reason: 'malformed' });
    expect(foldDir(events).state.tickets[T1]?.unplanned).toBeNull();
    // The malformed file is left where it is and reported once.
    expect(existsSync(join(events, `${malformed}.json`))).toBe(true);
    b.close();
    const again = openB(dir);
    expect(again.opened?.malformed).toEqual([]);
    expect(readTicket(again.db, T1)?.unplanned).toBeNull();
  });

  it('a later well-formed ticket.unplanned is applied as usual', () => {
    const { dir, events } = board();
    putEvent(events, {
      v: 1,
      kind: 'ticket.unplanned',
      ticket: T1,
      actor: 'orch',
      ts: { wall: 2000, counter: 0, actor: 'orch' },
      body: { reason: '' },
    });
    const good = putEvent(events, ev(P.unplanned(T1, 'hotfix'), 'orch', 2100));
    const b = openB(dir);
    expect(b.opened?.applied).toContain(good);
    expect(readTicket(b.db, T1)?.unplanned).toEqual({
      reason: 'hotfix',
      actor: 'orch',
      ts: { wall: 2100, counter: 0, actor: 'orch' },
    });
  });
});
