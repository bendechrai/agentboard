import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openBoard, type Board } from '../board.js';
import { dumpCache, openCache, readTicket } from '../cache.js';
import { listEventFiles } from '../eventfile.js';
import { checkCache, diffCaches, rebuild } from '../rebuild.js';
import {
  P,
  T1,
  T2,
  T3,
  allNames,
  copyBoard,
  ev,
  putEvent,
  seedRich,
  tempBoard,
} from './helpers.js';

const open: Board[] = [];

function openB(dir: string, options?: Parameters<typeof openBoard>[1]): Board {
  const board = openBoard(dir, options);
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

/** A board seeded with the rich set plus one malformed and one corrupt file. */
function seeded(): {
  board: Board;
  dir: string;
  events: string;
  corrupt: string;
  malformed: string;
} {
  const dir = tempBoard();
  const events = join(dir, 'events');
  seedRich(events);
  const malformed = putEvent(events, { v: 1, kind: 'ticket.comment', ticket: T1, body: {} });
  const corrupt = join(events, `${'a'.repeat(64)}.json`);
  writeFileSync(corrupt, 'not json');
  return { board: openB(dir), dir, events, corrupt, malformed };
}

function insertCursor(board: Board): void {
  board.db
    .prepare(
      "INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES ('orch', 1, 2, 'orch', 'h')",
    )
    .run();
}

function cursors(board: Board): unknown[] {
  return board.db.prepare('SELECT * FROM cursors ORDER BY actor').all();
}

describe('rebuild', () => {
  it('reports counts of folded, rejected, malformed, corrupt and unknown events', () => {
    const { board, events, corrupt, malformed } = seeded();
    const report = rebuild(board);
    expect({
      folded: report.folded,
      rejected: report.rejected,
      malformed: report.malformed,
      corrupt: report.corrupt,
      unknown: report.unknown,
    }).toEqual({ folded: 19, rejected: 1, malformed: 1, corrupt: 1, unknown: 1 });
    expect(
      report.folded + report.rejected + report.malformed + report.corrupt + report.unknown,
    ).toBe(listEventFiles(events).length);
    expect(report.rejectedEvents.map((r) => [r.ticket, r.kind, r.reason])).toEqual([
      [T1, 'ticket.claim', 'already-assigned'],
    ]);
    expect(report.unknownEvents.map((u) => u.kind)).toEqual(['ticket.estimate']);
    expect(report.malformedFiles.map((m) => m.hash)).toEqual([malformed]);
    expect(report.corruptFiles.map((c) => c.path)).toEqual([corrupt]);
  });

  it('is deterministic: two rebuilds give byte-identical dumps', () => {
    const { board } = seeded();
    rebuild(board);
    const first = dumpCache(board.db);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(first);
  });

  it('gives the same dump as a cache built elsewhere from the same files', () => {
    const { board, events } = seeded();
    rebuild(board);
    const other = openB(copyBoard(events));
    rebuild(other);
    expect(dumpCache(board.db)).toBe(dumpCache(other.db));
  });

  it('matches the incrementally maintained cache', () => {
    const { board } = seeded();
    const incremental = dumpCache(board.db);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(incremental);
  });

  it('repairs a hand-edited cache', () => {
    const { board } = seeded();
    const good = dumpCache(board.db);
    board.db.prepare("UPDATE tickets SET title = 'hacked' WHERE id = ?").run(T1);
    board.db.prepare('DELETE FROM comments WHERE ticket = ?').run(T1);
    board.db.prepare("INSERT INTO meta (key, value) VALUES ('board.bogus', '1')").run();
    rebuild(board);
    expect(dumpCache(board.db)).toBe(good);
    expect(readTicket(board.db, T1)?.title).toBe('First');
  });

  it('keeps cursor rows', () => {
    const { board } = seeded();
    insertCursor(board);
    const before = cursors(board);
    rebuild(board);
    expect(cursors(board)).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it('folds event files the cache had not recorded', () => {
    const { board, events } = seeded();
    putEvent(events, ev(P.comment(T3, 'late'), 'orch', 500));
    rebuild(board);
    expect(readTicket(board.db, T3)?.comments.map((c) => c.text)).toEqual([]);
    putEvent(events, ev(P.comment(T3, 'on time'), 'orch', 99_000));
    rebuild(board);
    expect(readTicket(board.db, T3)?.comments.map((c) => c.text)).toEqual(['on time']);
  });

  it('does not reap temporary files and commits its transaction', () => {
    const { board, events } = seeded();
    const temp = join(events, '.tmp-9999999999999999');
    writeFileSync(temp, 'x');
    utimesSync(temp, 0, 0);
    rebuild(board);
    expect(existsSync(temp)).toBe(true);
    expect(board.db.isTransaction).toBe(false);
  });
});

describe('checkCache', () => {
  it('reports no difference on a consistent cache', () => {
    const { board } = seeded();
    const result = checkCache(board);
    expect(result.ok).toBe(true);
    expect(result.differences).toEqual([]);
    expect(result.report.folded).toBe(19);
    expect(result.report.corrupt).toBe(1);
  });

  it('ignores cursors', () => {
    const { board } = seeded();
    insertCursor(board);
    expect(checkCache(board).ok).toBe(true);
  });

  it('detects a hand-edited title, reports the ticket and leaves the live cache unchanged', () => {
    const { board, dir, events } = seeded();
    board.db.prepare("UPDATE tickets SET title = 'hacked' WHERE id = ?").run(T1);
    const dump = dumpCache(board.db);
    const boardFiles = readdirSync(dir).sort();
    const eventFiles = allNames(events);

    const result = checkCache(board);

    expect(result.ok).toBe(false);
    expect(result.differences).toHaveLength(1);
    const [diff] = result.differences;
    expect(diff?.table).toBe('tickets');
    expect(diff?.key).toBe(T1);
    expect(diff?.ticket).toBe(T1);
    expect(diff?.live?.title).toBe('hacked');
    expect(diff?.rebuilt?.title).toBe('First');

    expect(dumpCache(board.db)).toBe(dump);
    expect(readTicket(board.db, T1)?.title).toBe('hacked');
    expect(readdirSync(dir).sort()).toEqual(boardFiles);
    expect(allNames(events)).toEqual(eventFiles);
  });

  it('reports rows missing on either side with null for the absent side', () => {
    const { board } = seeded();
    board.db.prepare('DELETE FROM comments WHERE ticket = ? AND seq = 0').run(T1);
    board.db.prepare("INSERT INTO meta (key, value) VALUES ('board.bogus', '1')").run();
    const result = checkCache(board);
    expect(result.ok).toBe(false);
    expect(
      result.differences.map((d) => [
        d.table,
        d.key,
        d.ticket,
        d.live === null,
        d.rebuilt === null,
      ]),
    ).toEqual([
      ['comments', `${T1}#0`, T1, true, false],
      ['meta', 'board.bogus', null, false, true],
    ]);
  });

  it('shows an event file the live cache has not folded, without folding it or reaping temps', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    openBoard(dir).close();
    putEvent(events, ev(P.create(T2, 'Second'), 'orch', 2000));
    const temp = join(events, '.tmp-7777777777777777');
    writeFileSync(temp, 'x');
    utimesSync(temp, 0, 0);

    const board = openB(dir, { catchUp: false });
    const dump = dumpCache(board.db);
    const result = checkCache(board);
    expect(result.ok).toBe(false);
    expect(
      result.differences.some((d) => d.table === 'tickets' && d.ticket === T2 && d.live === null),
    ).toBe(true);
    expect(result.differences.some((d) => d.table === 'folded' && d.live === null)).toBe(true);
    expect(dumpCache(board.db)).toBe(dump);
    expect(readTicket(board.db, T2)).toBeNull();
    expect(existsSync(temp)).toBe(true);
  });
});

describe('diffCaches', () => {
  it('sorts differences by table then key and is empty for identical caches', () => {
    const { board, events } = seeded();
    const copy = openB(copyBoard(events));
    expect(diffCaches(board.db, copy.db)).toEqual([]);

    board.db.prepare("UPDATE tickets SET title = 'x' WHERE id IN (?, ?)").run(T3, T1);
    board.db.prepare("UPDATE comments SET text = 'y' WHERE ticket = ? AND seq = 1").run(T1);
    const diffs = diffCaches(board.db, copy.db);
    expect(diffs.map((d) => [d.table, d.key])).toEqual([
      ['comments', `${T1}#1`],
      ['tickets', T1],
      ['tickets', T3],
    ]);
  });

  it('compares against an in-memory cache', () => {
    const { board } = seeded();
    const empty = openCache(':memory:');
    try {
      const diffs = diffCaches(board.db, empty);
      expect(diffs.length).toBeGreaterThan(0);
      expect(diffs.every((d) => d.rebuilt === null || d.table === 'meta')).toBe(true);
    } finally {
      empty.close();
    }
  });
});
