import { spawn } from 'node:child_process';
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { openBoard, type Board } from '../board.js';
import { canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { dumpCache, openCache, readTicket } from '../cache.js';
import { BoardError } from '../errors.js';
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
  tempDir,
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
  // The placeholder init creates: ignored, never counted.
  writeFileSync(join(events, '.gitkeep'), '');
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

/**
 * A separate writer process that behaves like a committing command, holding
 * the lock for `holdMs`: it takes BEGIN IMMEDIATE on the live cache, renames
 * a new event file into place, replaces the derived rows with those of a
 * cache that already contains that event, prints "locked", waits, then
 * commits. Pure SQL and fs, so it does not depend on the code under test.
 */
const WRITER = `
import { renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [cache, after, staged, final, holdMs] = process.argv.slice(2);
const db = new DatabaseSync(cache);
db.exec('PRAGMA busy_timeout = 5000');
db.exec("ATTACH DATABASE '" + after.replaceAll("'", "''") + "' AS a");
db.exec('BEGIN IMMEDIATE');
renameSync(staged, final);
db.exec(\`
  DELETE FROM main.comments; DELETE FROM main.links; DELETE FROM main.tickets;
  DELETE FROM main.folded; DELETE FROM main.meta;
  INSERT INTO main.tickets SELECT * FROM a.tickets;
  INSERT INTO main.comments SELECT * FROM a.comments;
  INSERT INTO main.links SELECT * FROM a.links;
  INSERT INTO main.folded SELECT * FROM a.folded;
  INSERT INTO main.meta SELECT * FROM a.meta;
\`);
process.stdout.write('locked\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
db.exec('COMMIT');
db.close();
`;

interface Writer {
  exited: Promise<number | null>;
}

/** Starts the writer and resolves once it holds the lock with the file renamed. */
async function startWriter(board: Board, event: unknown, holdMs: number): Promise<Writer> {
  const work = tempDir();
  // A cache that already contains `event`, built from a copy of the events.
  const afterDir = copyBoard(board.eventsDir);
  putEvent(join(afterDir, 'events'), event);
  openBoard(afterDir).close();
  const bytes = canonicalEncode(event);
  const staged = join(work, 'staged.json');
  writeFileSync(staged, bytes);
  const script = join(work, 'writer.mjs');
  writeFileSync(script, WRITER);
  const final = join(board.eventsDir, `${sha256Hex(bytes)}.json`);
  const child = spawn(
    process.execPath,
    [script, board.cachePath, join(afterDir, 'cache.sqlite'), staged, final, String(holdMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('locked')) {
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`writer exited ${String(code)}: ${stderr}`)));
  });
  return { exited };
}

describe('checkCache while a writer runs', () => {
  it('waits for a writer holding the lock and reports no divergence', async () => {
    const { board, events } = seeded();
    const hold = 400;
    const writer = await startWriter(board, ev(P.comment(T3, 'concurrent'), 'orch', 99_000), hold);
    // The writer's file is already renamed into place, its rows not yet committed.
    expect(listEventFiles(events)).toHaveLength(24);
    const started = Date.now();
    const result = checkCache(board);
    const waited = Date.now() - started;
    expect(await writer.exited).toBe(0);
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(hold - 150);
    expect(board.db.isTransaction).toBe(false);
    expect(readTicket(board.db, T3)?.comments.map((c) => c.text)).toEqual(['concurrent']);
    expect(checkCache(board).ok).toBe(true);
  }, 20_000);

  it('holds the write lock: with the lock taken elsewhere it fails busy instead of racing', () => {
    const { board } = seeded();
    board.db.exec('PRAGMA busy_timeout = 50');
    const holder = new DatabaseSync(board.cachePath);
    holder.exec('BEGIN IMMEDIATE');
    const dump = dumpCache(board.db);
    try {
      checkCache(board);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BoardError);
      expect([(error as BoardError).exitCode, (error as BoardError).reason]).toEqual([5, 'busy']);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(board.db.isTransaction).toBe(false);
    expect(dumpCache(board.db)).toBe(dump);
    expect(checkCache(board).ok).toBe(true);
  });

  it('releases the lock afterwards (rolls back), so a writer can proceed', () => {
    const { board } = seeded();
    checkCache(board);
    const other = new DatabaseSync(board.cachePath);
    try {
      other.exec('PRAGMA busy_timeout = 0');
      expect(() => {
        other.exec('BEGIN IMMEDIATE');
        other.exec('ROLLBACK');
      }).not.toThrow();
    } finally {
      other.close();
    }
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
