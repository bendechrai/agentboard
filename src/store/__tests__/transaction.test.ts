import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { openBoard, type Board } from '../board.js';
import { dumpCache, readState, readTicket } from '../cache.js';
import { BoardError } from '../errors.js';
import {
  TEST_PAUSE_ENV,
  pauseHooks,
  runCommand,
  type Decision,
  type Operation,
  type ProposedEvent,
  type TxContext,
} from '../transaction.js';
import {
  MISSING,
  P,
  T1,
  T2,
  allNames,
  canon,
  clock,
  copyBoard,
  ev,
  foldDir,
  propose,
  putEvent,
  tempBoard,
} from './helpers.js';

const open: Board[] = [];
const extra: DatabaseSync[] = [];

function openB(dir: string): Board {
  const board = openBoard(dir);
  open.push(board);
  return board;
}

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

const START = 1_700_000_000_000;

/** A fresh board with its own deterministic clock. */
function setup(): { board: Board; events: string; now: () => number } {
  const board = openB(tempBoard());
  return { board, events: board.eventsDir, now: clock(START) };
}

function run(
  board: Board,
  actor: string,
  event: ProposedEvent | Operation,
  now: () => number,
): ReturnType<typeof runCommand> {
  const op = typeof event === 'function' ? event : propose(event);
  return runCommand(board, actor, op, { now, env: {} });
}

/** Asserts `fn` throws a BoardError with this exit code and reason. */
function expectBoardError(fn: () => unknown, exitCode: number, reason: string): BoardError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BoardError);
    const err = error as BoardError;
    expect({ exitCode: err.exitCode, reason: err.reason }).toEqual({ exitCode, reason });
    return err;
  }
  throw new Error('expected a BoardError');
}

/** Asserts that `fn` fails and leaves the events directory and the cache untouched. */
function expectNoWrite(
  board: Board,
  fn: () => unknown,
  exitCode: number,
  reason: string,
): BoardError {
  const names = allNames(board.eventsDir);
  const dump = dumpCache(board.db);
  const err = expectBoardError(fn, exitCode, reason);
  expect(allNames(board.eventsDir)).toEqual(names);
  expect(dumpCache(board.db)).toBe(dump);
  expect(board.db.isTransaction).toBe(false);
  return err;
}

/** A second connection with no busy timeout, to probe the write lock. */
function probe(board: Board): DatabaseSync {
  const db = new DatabaseSync(board.cachePath);
  db.exec('PRAGMA busy_timeout = 0');
  extra.push(db);
  return db;
}

function canTakeWriteLock(db: DatabaseSync): boolean {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch {
    return false;
  }
  db.exec('ROLLBACK');
  return true;
}

describe('runCommand: successful writes', () => {
  it('writes exactly one event file and applies it to the cache', () => {
    const { board, events, now } = setup();
    const result = run(board, 'orch', P.create(T1, 'First'), now);

    expect(result.event).toEqual(ev(P.create(T1, 'First'), 'orch', START));
    const bytes = canonicalEncode(result.event);
    expect(result.hash).toBe(sha256Hex(bytes));
    expect(result.path).toBe(join(events, `${result.hash}.json`));
    expect(Buffer.compare(readFileSync(result.path), Buffer.from(bytes))).toBe(0);
    expect(allNames(events)).toEqual([basename(result.path)]);

    expect(result.ticket).toEqual(readTicket(board.db, T1));
    expect(result.ticket?.title).toBe('First');
    expect(result.ticket?.status).toBe('todo');
    const folded = board.db
      .prepare('SELECT folded, reason FROM folded WHERE hash = ?')
      .get(result.hash);
    expect(folded).toEqual({ folded: 1, reason: null });
    expect(board.db.isTransaction).toBe(false);
  });

  it('keeps the cache equal to a fresh rebuild after a sequence of commands', () => {
    const { board, events, now } = setup();
    run(board, 'orch', P.create(T1), now);
    run(board, 'orch', P.create(T2, 'Second'), now);
    run(board, 'impl', P.claim(T1), now);
    run(board, 'impl', P.move(T1, 'tests'), now);
    run(board, 'impl', P.comment(T1, 'note'), now);
    run(board, 'impl', P.handoff(T1, 'rev', 'implementing', 'go'), now);
    run(board, 'rev', P.pr(T1, 7), now);
    run(board, 'rev', P.tick(T1, 0), now);
    run(board, 'orch', P.meta('columns', ['x']), now);
    expect(allNames(events)).toHaveLength(9);

    expect(canon(readState(board.db))).toBe(canon(foldDir(events).state));
    const fresh = openB(copyBoard(events));
    expect(dumpCache(board.db)).toBe(dumpCache(fresh.db));
  });

  it('applies a handoff as one event with three effects', () => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    run(board, 'impl', P.claim(T1), now);
    run(board, 'impl', P.move(T1, 'tests'), now);
    run(board, 'impl', P.move(T1, 'implementing'), now);
    const before = readTicket(board.db, T1);
    const result = run(board, 'impl', P.handoff(T1, 'reviewer', 'review', 'green, 96%'), now);
    expect(result.ticket?.assignee).toBe('reviewer');
    expect(result.ticket?.status).toBe('review');
    expect(result.ticket?.comments.map((c) => [c.actor, c.text])).toEqual([['impl', 'green, 96%']]);
    expect(result.ticket?.version).toBe((before?.version ?? 0) + 1);
  });

  it('returns a null ticket for board.meta', () => {
    const { board, now } = setup();
    const result = run(board, 'orch', P.meta('columns', ['a']), now);
    expect(result.ticket).toBeNull();
    expect(readState(board.db).meta).toEqual({ columns: ['a'] });
  });

  it('defaults to the real clock', () => {
    const board = openB(tempBoard());
    const before = Date.now();
    const result = runCommand(board, 'orch', propose(P.create(T1)), { env: {} });
    expect(result.event.ts.wall).toBeGreaterThanOrEqual(before);
    expect(result.event.ts.wall).toBeLessThanOrEqual(Date.now());
  });
});

describe('runCommand: hybrid timestamps', () => {
  it('uses the wall clock with counter 0 when it moves forward, calling it once per command', () => {
    const { board, now } = setup();
    const a = run(board, 'orch', P.create(T1), now);
    const b = run(board, 'orch', P.comment(T1, 'x'), now);
    expect(a.event.ts).toEqual({ wall: START, counter: 0, actor: 'orch' });
    expect(b.event.ts).toEqual({ wall: START + 1000, counter: 0, actor: 'orch' });
  });

  it('carries the latest wall forward when the clock moves backwards', () => {
    const { board } = setup();
    run(board, 'orch', P.create(T1), () => 1000);
    const r = run(board, 'impl', P.comment(T1, 'x'), () => 900);
    expect(r.event.ts).toEqual({ wall: 1000, counter: 1, actor: 'impl' });
    const r2 = run(board, 'impl', P.comment(T1, 'y'), () => 1000);
    expect(r2.event.ts).toEqual({ wall: 1000, counter: 2, actor: 'impl' });
  });

  it('writes after an unfolded event from the future', () => {
    const { board, events, now } = setup();
    run(board, 'orch', P.create(T1), now);
    putEvent(events, ev(P.comment(T1, 'from the future'), 'other', START + 10_000_000, 4));
    const r = run(board, 'impl', P.comment(T1, 'now'), now);
    expect(r.event.ts).toEqual({ wall: START + 10_000_000, counter: 5, actor: 'impl' });
  });

  it('writes after the latest event even when that event was rejected or of an unknown kind', () => {
    const { board, events, now } = setup();
    run(board, 'orch', P.create(T1), now);
    putEvent(events, ev(P.comment(MISSING, 'rejected'), 'x', START + 50_000, 0));
    const r = run(board, 'impl', P.comment(T1, 'after'), now);
    expect(r.event.ts).toEqual({ wall: START + 50_000, counter: 1, actor: 'impl' });
  });
});

describe('runCommand: validation failures write nothing', () => {
  it('refuses a move the state machine forbids (todo to merged) with exit 4', () => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    let hooks = 0;
    const count = { afterTempWrite: () => (hooks += 1), afterRename: () => (hooks += 1) };
    expectNoWrite(
      board,
      () => runCommand(board, 'orch', propose(P.move(T1, 'merged')), { now, hooks: count }),
      4,
      'invalid-transition',
    );
    expect(hooks).toBe(0);
    expect(readTicket(board.db, T1)?.status).toBe('todo');
  });

  it('refuses a claim on an assigned ticket, naming the assignee', () => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    run(board, 'impl', P.claim(T1), now);
    const err = expectNoWrite(
      board,
      () => run(board, 'reviewer', P.claim(T1), now),
      4,
      'already-assigned',
    );
    expect(err.message).toContain('impl');
  });

  it.each<[string, (id: string) => ProposedEvent, string]>([
    [
      'a comment on an unknown ticket',
      (id) => P.comment(id === T1 ? MISSING : id, 'x'),
      'unknown-ticket',
    ],
    ['a second create for an existing id', (id) => P.create(id), 'duplicate-create'],
    ['a checklist index out of range', (id) => P.tick(id, 2), 'checklist-index'],
    [
      'a release by a non-assignee',
      (id) => ({ kind: 'ticket.release', ticket: id, body: {} }),
      'not-assignee',
    ],
    ['a close from todo', (id) => P.close(id), 'invalid-transition'],
  ])('refuses %s with exit 4', (_label, make, reason) => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    expectNoWrite(board, () => run(board, 'orch', make(T1), now), 4, reason);
  });

  it('refuses moving an ad hoc ticket into implementing with needs-task-link', () => {
    const { board, now } = setup();
    run(
      board,
      'orch',
      { kind: 'ticket.create', ticket: T1, body: { title: 'x', adhoc: 'why' } },
      now,
    );
    run(board, 'orch', P.move(T1, 'tests'), now);
    expectNoWrite(
      board,
      () => run(board, 'orch', P.move(T1, 'implementing'), now),
      4,
      'needs-task-link',
    );
  });

  it("passes an operation's refusal through unchanged", () => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    const refuse: Operation = () => ({
      ok: false,
      exitCode: 4,
      reason: 'already-assigned',
      message: 'T1 is held by someone',
    });
    const err = expectNoWrite(board, () => run(board, 'orch', refuse, now), 4, 'already-assigned');
    expect(err.message).toBe('T1 is held by someone');
    const usage: Operation = () => ({ ok: false, exitCode: 1, reason: 'usage', message: 'bad' });
    expectNoWrite(board, () => run(board, 'orch', usage, now), 1, 'usage');
  });

  it('refuses a malformed proposal with exit 1 naming the field', () => {
    const { board, now } = setup();
    const err = expectNoWrite(
      board,
      () => run(board, 'orch', { kind: 'ticket.create', ticket: T1, body: { title: '' } }, now),
      1,
      'malformed-event',
    );
    expect(err.message).toContain('body.title');
  });

  it('refuses a proposal of an unknown kind with exit 1', () => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    const unknown = { kind: 'ticket.estimate', ticket: T1, body: {} } as unknown as ProposedEvent;
    expectNoWrite(board, () => run(board, 'orch', unknown, now), 1, 'malformed-event');
  });

  it('refuses an empty actor with exit 1 before calling the operation', () => {
    const { board, now } = setup();
    let called = false;
    const op: Operation = (): Decision => {
      called = true;
      return { ok: true, event: P.create(T1) };
    };
    expectNoWrite(board, () => run(board, '', op, now), 1, 'missing-actor');
    expect(called).toBe(false);
  });

  it('rolls back and rethrows when the operation throws', () => {
    const { board, events, now } = setup();
    run(board, 'orch', P.create(T1), now);
    const names = allNames(events);
    const op: Operation = () => {
      throw new Error('boom');
    };
    expect(() => run(board, 'orch', op, now)).toThrow('boom');
    expect(allNames(events)).toEqual(names);
    expect(board.db.isTransaction).toBe(false);
  });
});

describe('runCommand: order inside the transaction', () => {
  it('catches up before the operation runs, and folds a file left by a crash before commit', () => {
    const { board, events, now } = setup();
    run(board, 'orch', P.create(T1), now);
    // A previous command renamed its file into place, then died before commit.
    const orphan = putEvent(events, ev(P.comment(T1, 'orphan'), 'ghost', START + 500));
    let seen: string[] = [];
    const op: Operation = (ctx: TxContext) => {
      seen = ctx.ticket(T1)?.comments.map((c) => c.text) ?? [];
      expect(ctx.actor).toBe('impl');
      expect(Object.keys(ctx.state().tickets)).toEqual([T1]);
      return { ok: true, event: P.comment(T1, 'mine') };
    };
    const result = run(board, 'impl', op, now);
    expect(seen).toEqual(['orphan']);
    expect(result.catchUp.applied).toEqual([orphan]);
    expect(result.ticket?.comments.map((c) => c.text)).toEqual(['orphan', 'mine']);
    const fresh = openB(copyBoard(events));
    expect(dumpCache(board.db)).toBe(dumpCache(fresh.db));
  });

  it('holds the write lock while the operation runs', () => {
    const { board, now } = setup();
    const other = probe(board);
    let lockedDuringOp: boolean | null = null;
    run(
      board,
      'orch',
      () => {
        lockedDuringOp = !canTakeWriteLock(other);
        return { ok: true, event: P.create(T1) };
      },
      now,
    );
    expect(lockedDuringOp).toBe(true);
    expect(canTakeWriteLock(other)).toBe(true);
  });

  it('writes the file before committing the rows, under the lock', () => {
    const { board, now } = setup();
    run(board, 'orch', P.create(T1), now);
    const other = probe(board);
    const observed: Record<string, unknown> = {};
    runCommand(board, 'impl', propose(P.comment(T1, 'c')), {
      now,
      hooks: {
        afterTempWrite: () => {
          observed.lockedAtTemp = !canTakeWriteLock(other);
        },
        afterRename: (path) => {
          observed.fileExists = existsSync(path);
          observed.lockedAtRename = !canTakeWriteLock(other);
          observed.commentsVisibleElsewhere = (
            other.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }
          ).n;
        },
      },
    });
    expect(observed).toEqual({
      lockedAtTemp: true,
      fileExists: true,
      lockedAtRename: true,
      commentsVisibleElsewhere: 0,
    });
    expect((other.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(1);
  });

  it('after a crash between rename and commit, the cache is unchanged and the next command folds the file', () => {
    const { board, events, now } = setup();
    run(board, 'orch', P.create(T1), now);
    const dump = dumpCache(board.db);
    let crashedPath = '';
    expect(() =>
      runCommand(board, 'impl', propose(P.claim(T1)), {
        now,
        hooks: {
          afterRename: (path) => {
            crashedPath = path;
            throw new Error('SIGKILL');
          },
        },
      }),
    ).toThrow('SIGKILL');
    expect(board.db.isTransaction).toBe(false);
    expect(existsSync(crashedPath)).toBe(true);
    expect(dumpCache(board.db)).toBe(dump);
    expect(readTicket(board.db, T1)?.assignee).toBeNull();

    const next = run(board, 'impl', P.comment(T1, 'after crash'), now);
    expect(next.catchUp.applied).toEqual([basename(crashedPath, '.json')]);
    expect(next.ticket?.assignee).toBe('impl');
    const fresh = openB(copyBoard(events));
    expect(dumpCache(board.db)).toBe(dumpCache(fresh.db));
  });

  it('after a crash during the temporary write, no hash file exists and the stale temp is reaped later', () => {
    const { board, events } = setup();
    run(board, 'orch', P.create(T1), () => START);
    let tempPath = '';
    expect(() =>
      runCommand(board, 'impl', propose(P.claim(T1)), {
        now: () => START + 1,
        hooks: {
          afterTempWrite: (path) => {
            tempPath = path;
            throw new Error('SIGKILL');
          },
        },
      }),
    ).toThrow('SIGKILL');
    expect(existsSync(tempPath)).toBe(true);
    expect(allNames(events).filter((n) => !n.startsWith('.tmp-'))).toHaveLength(1);
    expect(readTicket(board.db, T1)?.assignee).toBeNull();

    // Make the temp two minutes older than the next command's clock.
    const later = START + 10 * 60_000;
    const old = (later - 120_000) / 1000;
    utimesSync(tempPath, old, old);
    const next = runCommand(board, 'impl', propose(P.comment(T1, 'x')), {
      now: () => later,
      env: {},
    });
    expect(next.catchUp.reaped).toEqual([tempPath]);
    expect(existsSync(tempPath)).toBe(false);
    expect(next.ticket?.assignee).toBeNull();
  });

  it('does not reap a temporary file younger than one minute', () => {
    const { board, events } = setup();
    run(board, 'orch', P.create(T1), () => START);
    const temp = join(events, '.tmp-0123456789abcdef');
    writeFileSync(temp, 'in progress');
    const t = (START + 30_000) / 1000;
    utimesSync(temp, t, t);
    const next = runCommand(board, 'impl', propose(P.comment(T1, 'x')), {
      now: () => START + 60_000,
      env: {},
    });
    expect(next.catchUp.reaped).toEqual([]);
    expect(existsSync(temp)).toBe(true);
  });
});

describe("runCommand: an existing file at the new event's name", () => {
  /** The event `run(board, 'impl', P.comment(T1, text), () => START + 1000)` builds after a create at START. */
  const next = (text: string): ReturnType<typeof ev> =>
    ev(P.comment(T1, text), 'impl', START + 1000);

  it('refuses with exit 5 integrity when a corrupt file sits at that name, changing no rows', () => {
    const { board, events } = setup();
    run(board, 'orch', P.create(T1), () => START);
    const hash = sha256Hex(canonicalEncode(next('x')));
    const planted = join(events, `${hash}.json`);
    writeFileSync(planted, 'planted junk');

    const err = expectNoWrite(
      board,
      () => run(board, 'impl', P.comment(T1, 'x'), () => START + 1000),
      5,
      'integrity',
    );
    expect(err.message).toContain(planted);
    expect(readFileSync(planted, 'utf8')).toBe('planted junk');
    expect(readTicket(board.db, T1)?.comments).toEqual([]);
    expect(board.db.prepare('SELECT COUNT(*) AS n FROM folded WHERE hash = ?').get(hash)).toEqual({
      n: 0,
    });
  });

  it('refuses with exit 5 integrity when its exact file appears after catch-up, changing no rows', () => {
    const { board, events } = setup();
    run(board, 'orch', P.create(T1), () => START);
    const dump = dumpCache(board.db);
    const before = allNames(events);
    const event = next('y');
    const hash = sha256Hex(canonicalEncode(event));
    let planted = '';
    const op: Operation = () => {
      // An out-of-band writer (not holding the lock) drops the identical file now.
      planted = join(events, `${putEvent(events, event)}.json`);
      return { ok: true, event: P.comment(T1, 'y') };
    };
    expectBoardError(() => run(board, 'impl', op, () => START + 1000), 5, 'integrity');
    expect(planted).toBe(join(events, `${hash}.json`));
    expect(allNames(events)).toEqual([...before, `${hash}.json`].sort());
    expect(dumpCache(board.db)).toBe(dump);
    expect(board.db.isTransaction).toBe(false);
  });

  it('folds the identical file normally once it is recorded by a later catch-up', () => {
    const { board, events } = setup();
    run(board, 'orch', P.create(T1), () => START);
    const event = next('z');
    const op: Operation = () => {
      putEvent(events, event);
      return { ok: true, event: P.comment(T1, 'z') };
    };
    expect(() => run(board, 'impl', op, () => START + 1000)).toThrow(BoardError);
    const later = run(board, 'impl', P.comment(T1, 'after'), () => START + 2000);
    expect(later.catchUp.applied).toEqual([sha256Hex(canonicalEncode(event))]);
    expect(later.ticket?.comments.map((c) => c.text)).toEqual(['z', 'after']);
  });
});

describe('crash injection hook', () => {
  it('names the environment variable', () => {
    expect(TEST_PAUSE_ENV).toBe('AGENTBOARD_TEST_PAUSE');
  });

  it('builds no hooks when the variable is unset, empty or unrecognised', () => {
    for (const env of [{}, { AGENTBOARD_TEST_PAUSE: '' }, { AGENTBOARD_TEST_PAUSE: 'sometime' }]) {
      const hooks = pauseHooks(env);
      expect(hooks.afterTempWrite).toBeUndefined();
      expect(hooks.afterRename).toBeUndefined();
    }
  });

  it('builds only the hook for the named point', () => {
    const temp = pauseHooks({ AGENTBOARD_TEST_PAUSE: 'after-temp-write' });
    expect(typeof temp.afterTempWrite).toBe('function');
    expect(temp.afterRename).toBeUndefined();
    const rename = pauseHooks({ AGENTBOARD_TEST_PAUSE: 'after-rename' });
    expect(rename.afterTempWrite).toBeUndefined();
    expect(typeof rename.afterRename).toBe('function');
  });
});
