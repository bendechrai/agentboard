/**
 * Reconcile, renumber and supersede state in the cache (add-claim-leases
 * task 8.1 and 8.2; board-cache: "Cache schema"): the per-line `removed`
 * flag in the checklist JSON, the `superseded` column, the schema version
 * bump to 4, and `rebuild` and `rebuild --check` covering them.
 *
 * Events are written as files (`putEvent`), as another process or a sync
 * leaves them; expected values are written out by hand from the spec.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { BoardEvent, TicketReconcileBody } from '../../events/schema.js';
import { openBoard, type Board } from '../board.js';
import { CACHE_FILE, CACHE_SCHEMA_VERSION, catchUp, dumpCache, readTicket } from '../cache.js';
import { checkCache, rebuild } from '../rebuild.js';
import { P, T1, T2, canon, copyBoard, ev, foldDir, putEvent, tempBoard } from './helpers.js';

const open: Board[] = [];

function openB(dir: string): Board {
  const board = openBoard(dir, { now: 0 });
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

type Row = Record<string, unknown>;

const SOURCE = `openspec/changes/add-board-core/tasks.md@sha256:${'3'.repeat(64)}`;

const R = {
  reconcile(wall: number, body: Partial<TicketReconcileBody>, ticket = T1): BoardEvent {
    return ev(
      {
        kind: 'ticket.reconcile',
        ticket,
        body: { updated: [], removed: [], added: [], forced: false, source: SOURCE, ...body },
      },
      'orch',
      wall,
    );
  },
  renumber(wall: number, from: string, to: string, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.renumber', ticket, body: { from, to } }, 'orch', wall);
  },
  supersede(wall: number, reason: string, ticket = T1): BoardEvent {
    return ev({ kind: 'ticket.supersede', ticket, body: { reason } }, 'orch', wall);
  },
};

/**
 * Two tickets: T1 (checklist `one`, `two`; labels `change:add-board-core`,
 * `group:2`; task item 2) ticked, reconciled (renamed, line 1 removed, a
 * done line added) and renumbered from 2 to 3; T2 superseded. Plus a
 * rejected tick of the removed line and a rejected stale renumber. Keyed
 * by name, in write order.
 */
function seedEvents(): Record<string, BoardEvent> {
  return {
    create1: ev(
      P.create(T1, 'First', { labels: ['change:add-board-core', 'group:2'] }),
      'orch',
      1000,
    ),
    create2: ev(P.create(T2, 'Second'), 'orch', 1001),
    tick: ev(P.tick(T1, 0), 'impl', 1100),
    reconcile: R.reconcile(1200, {
      title: 'First, revised',
      removed: [1],
      added: [{ text: 'three', done: true }],
    }),
    tickRemoved: ev(P.tick(T1, 1), 'impl', 1300),
    renumber: R.renumber(1400, '2', '3'),
    staleRenumber: R.renumber(1500, '2', '3'),
    supersede: R.supersede(1600, 'group removed from tasks.md', T2),
  };
}

/** Writes `seedEvents()` into `eventsDir`; returns their hashes by name. */
function seed(eventsDir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(seedEvents()).map(([name, event]) => [name, putEvent(eventsDir, event)]),
  );
}

function ticketRow(board: Board, id: string): Row {
  return board.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row;
}

function foldedRow(board: Board, hash: string): Row {
  return board.db.prepare('SELECT folded, reason FROM folded WHERE hash = ?').get(hash) as Row;
}

describe('cache schema version 5', () => {
  it('is 5, with a superseded column on tickets', () => {
    expect(CACHE_SCHEMA_VERSION).toBe(5);
    const board = openB(tempBoard());
    const columns = (board.db.prepare('PRAGMA table_info(tickets)').all() as Row[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('superseded');
    expect(board.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: '5',
    });
  });

  it('rebuilds a version 4 cache from the events before the command proceeds', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    seed(events);
    openB(dir).close();
    open.pop();
    const old = new DatabaseSync(join(dir, CACHE_FILE));
    old.exec("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
    old.exec("UPDATE tickets SET superseded = NULL, checklist = '[]'");
    old.close();
    const board = openB(dir);
    expect(board.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: '5',
    });
    expect(readTicket(board.db, T2)?.superseded).toBe('group removed from tasks.md');
    expect(readTicket(board.db, T1)?.checklist).toHaveLength(3);
  });
});

describe('reconcile, renumber and supersede in the cache', () => {
  it('stores the removed flag in the checklist JSON and the reason in superseded', () => {
    const dir = tempBoard();
    seed(join(dir, 'events'));
    const board = openB(dir);
    expect(ticketRow(board, T1)).toMatchObject({
      title: 'First, revised',
      task_item: '3',
      labels: '["change:add-board-core","group:3"]',
      checklist:
        '[{"done":true,"text":"one"},{"done":false,"removed":true,"text":"two"},{"done":true,"text":"three"}]',
      superseded: null,
    });
    expect(ticketRow(board, T2)).toMatchObject({ superseded: 'group removed from tasks.md' });
  });

  it('reads back exactly the folded tickets', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    seed(events);
    const board = openB(dir);
    const expected = foldDir(events).state.tickets;
    expect(canon(readTicket(board.db, T1))).toBe(canon(expected[T1]));
    expect(canon(readTicket(board.db, T2))).toBe(canon(expected[T2]));
  });

  it('records the rejected tick and the stale renumber with their reasons', () => {
    const dir = tempBoard();
    const hashes = seed(join(dir, 'events'));
    const board = openB(dir);
    expect(foldedRow(board, hashes.tickRemoved ?? '')).toEqual({
      folded: 0,
      reason: 'checklist-index',
    });
    expect(foldedRow(board, hashes.staleRenumber ?? '')).toEqual({
      folded: 0,
      reason: 'stale-import',
    });
    expect(foldedRow(board, hashes.reconcile ?? '')).toEqual({ folded: 1, reason: null });
  });

  it('folds incrementally to the same cache as a rebuild, and rebuild twice is byte-identical', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    const board = openB(dir);
    for (const event of Object.values(seedEvents())) {
      putEvent(events, event);
      catchUp(board, { now: 0 });
    }
    const incremental = dumpCache(board.db);
    rebuild(board);
    const once = dumpCache(board.db);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(once);
    expect(incremental).toBe(once);
    expect(dumpCache(openB(copyBoard(events)).db)).toBe(once);
    expect(checkCache(board).ok).toBe(true);
  });

  it('rebuild --check detects a hand-edited superseded column', () => {
    const dir = tempBoard();
    seed(join(dir, 'events'));
    const board = openB(dir);
    expect(checkCache(board).ok).toBe(true);
    board.db.prepare('UPDATE tickets SET superseded = NULL WHERE id = ?').run(T2);
    expect(checkCache(board).ok).toBe(false);
  });

  it('rebuild --check detects a dropped removed flag', () => {
    const dir = tempBoard();
    seed(join(dir, 'events'));
    const board = openB(dir);
    board.db
      .prepare('UPDATE tickets SET checklist = ? WHERE id = ?')
      .run(
        '[{"done":true,"text":"one"},{"done":false,"text":"two"},{"done":true,"text":"three"}]',
        T1,
      );
    expect(checkCache(board).ok).toBe(false);
  });
});
