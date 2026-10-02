/**
 * Opening the cache for inspection only (`openCache(path, { prepare:
 * false })`, `openBoard(dir, { prepare: false })`), which `rebuild --check`
 * uses so that it never modifies the live cache file (board-cache:
 * "Rebuild").
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { openBoard } from '../board.js';
import { CACHE_FILE, dumpCache, openCache } from '../cache.js';
import { P, T1, ev, putEvent, tempBoard, tempDir } from './helpers.js';

/** A board whose cache holds one folded ticket, closed, with no WAL left. */
function builtBoard(): { dir: string; cache: string } {
  const dir = tempBoard();
  putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
  openBoard(dir).close();
  const cache = join(dir, CACHE_FILE);
  for (const name of [`${CACHE_FILE}-wal`, `${CACHE_FILE}-shm`]) {
    rmSync(join(dir, name), { force: true });
  }
  return { dir, cache };
}

function exec(cache: string, sql: string): void {
  const db = new DatabaseSync(cache);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe('openCache with prepare: false', () => {
  it('opens a current cache for reading and leaves its bytes unchanged', () => {
    const { cache } = builtBoard();
    const bytes = readFileSync(cache);
    const db = openCache(cache, { prepare: false });
    try {
      expect(db.prepare('SELECT id FROM tickets').all()).toEqual([{ id: T1 }]);
      expect(dumpCache(db)).toContain(T1);
    } finally {
      db.close();
    }
    expect(readFileSync(cache).equals(bytes)).toBe(true);
  });

  it('never creates a missing file: BoardError(5, no-cache)', () => {
    const path = join(tempDir(), CACHE_FILE);
    const err = expectBoardError(() => openCache(path, { prepare: false }), 5, 'no-cache');
    expect(err.message).toContain(path);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses another schema_version without migrating: BoardError(5, schema-mismatch)', () => {
    const { cache } = builtBoard();
    exec(cache, "UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    exec(
      cache,
      "INSERT INTO cursors (actor, last_wall, last_counter, last_actor, last_hash) VALUES ('a', 1, 0, 'a', 'h')",
    );
    rmSync(`${cache}-wal`, { force: true });
    rmSync(`${cache}-shm`, { force: true });
    const bytes = readFileSync(cache);
    const err = expectBoardError(() => openCache(cache, { prepare: false }), 5, 'schema-mismatch');
    expect(err.message).toContain(cache);
    expect(readFileSync(cache).equals(bytes)).toBe(true);
  });

  it.each([
    ['an empty file', ''],
    ['a file that is not a SQLite database', 'garbage\n'.repeat(100)],
  ])('refuses %s as schema-mismatch and leaves it as it is', (_label, content) => {
    const path = join(tempDir(), CACHE_FILE);
    writeFileSync(path, content);
    expectBoardError(() => openCache(path, { prepare: false }), 5, 'schema-mismatch');
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('refuses a SQLite file with no meta table as schema-mismatch', () => {
    const path = join(tempDir(), CACHE_FILE);
    exec(path, 'CREATE TABLE other (x INTEGER)');
    const bytes = readFileSync(path);
    expectBoardError(() => openCache(path, { prepare: false }), 5, 'schema-mismatch');
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});

describe('openBoard with prepare: false', () => {
  it('never catches up, even when catchUp is true', () => {
    const { dir } = builtBoard();
    const late = putEvent(join(dir, 'events'), ev(P.comment(T1, 'late'), 'sync', 2000));
    const board = openBoard(dir, { prepare: false, catchUp: true });
    try {
      expect(board.opened).toBeNull();
      expect(board.db.prepare('SELECT hash FROM folded WHERE hash = ?').get(late)).toBeUndefined();
    } finally {
      board.close();
    }
  });

  it('passes the refusals through and creates nothing', () => {
    const dir = tempBoard();
    expectBoardError(() => openBoard(dir, { prepare: false }), 5, 'no-cache');
    expect(existsSync(join(dir, CACHE_FILE))).toBe(false);
  });
});
