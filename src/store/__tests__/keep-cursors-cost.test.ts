/**
 * keep-cursors-on-upgrade task 1.2, cost guard (orchestrator review round
 * 1): the prior applied set is read from `carried_applied` only when
 * `folded` is empty, and an incremental fold on a cache that has already
 * folded costs no extra read of `folded`. The incremental path needs no
 * prior there: its inputs are unrecorded by contract, so no recorded flag
 * can apply to them.
 *
 * Counted with a spy on `StatementSync` (every `all`, `get`, `iterate` and
 * `run` call, by its SQL text) around one locked catch-up. A whole-table
 * read of `folded` is a SELECT from `folded` with no WHERE and no LIMIT.
 * The locked catch-up itself reads every recorded hash once, to find the
 * event files not yet recorded; any further whole-table read is the cost
 * this guards against.
 */

import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { openBoard, type Board } from '../board.js';
import { catchUp } from '../cache.js';
import { P, T1, ev, putEvent, tempBoard } from './helpers.js';

const open: Board[] = [];

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

type Method = 'all' | 'get' | 'iterate' | 'run';

/** Runs `fn`, returning the SQL text of every statement call it made. */
function statementsDuring(fn: () => void): string[] {
  const seen: string[] = [];
  const methods: Method[] = ['all', 'get', 'iterate', 'run'];
  const saved = methods.map(
    (m) => [m, Object.getOwnPropertyDescriptor(StatementSync.prototype, m)] as const,
  );
  for (const m of methods) {
    const original = StatementSync.prototype[m] as (...args: unknown[]) => unknown;
    Object.defineProperty(StatementSync.prototype, m, {
      configurable: true,
      writable: true,
      value: function (this: StatementSync, ...args: unknown[]): unknown {
        seen.push(this.sourceSQL);
        return original.apply(this, args);
      },
    });
  }
  try {
    fn();
  } finally {
    for (const [m, descriptor] of saved) {
      if (descriptor !== undefined) {
        Object.defineProperty(StatementSync.prototype, m, descriptor);
      }
    }
  }
  return seen;
}

/** A SELECT reading every row of `folded`. */
function readsAllFolded(sql: string): boolean {
  const flat = sql.replace(/\s+/g, ' ');
  return /^\s*SELECT\b.*\bFROM folded\b/i.test(flat) && !/\b(WHERE|LIMIT)\b/i.test(flat);
}

describe('an incremental fold on a cache that has folded (1.2, cost)', () => {
  it('reads the whole folded table once, to find the new files, and not again for the prior', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1), 'orch', 1000));
    for (let i = 1; i <= 20; i++) {
      putEvent(events, ev(P.comment(T1, `comment ${String(i)}`), 'impl', 1000 + i * 1000));
    }
    const board = openBoard(dir);
    open.push(board);
    expect(Number(board.db.prepare('SELECT count(*) AS n FROM folded').get()?.n)).toBe(21);
    putEvent(events, ev(P.comment(T1, 'next'), 'impl', 100_000));

    board.db.exec('BEGIN IMMEDIATE');
    let report: ReturnType<typeof catchUp> | undefined;
    const sql = statementsDuring(() => {
      report = catchUp(board);
    });
    board.db.exec('COMMIT');

    expect(report?.refolded).toBe(false);
    expect(report?.applied).toHaveLength(1);
    expect(sql.filter(readsAllFolded)).toHaveLength(1);
  });

  it('a spy check: the counter sees whole-table reads of folded', () => {
    const dir = tempBoard();
    putEvent(join(dir, 'events'), ev(P.create(T1), 'orch', 1000));
    const board = openBoard(dir);
    open.push(board);
    const sql = statementsDuring(() => {
      board.db.prepare('SELECT hash, folded FROM folded').all();
      board.db.prepare('SELECT 1 FROM folded LIMIT 1').get();
      board.db.prepare('SELECT folded FROM folded WHERE hash = ?').get('x');
    });
    expect(sql.filter(readsAllFolded)).toEqual(['SELECT hash, folded FROM folded']);
  });
});
