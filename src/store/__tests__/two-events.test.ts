/**
 * Two events in one command transaction (add-adhoc-ticket-lifecycle task
 * 1.3; board-cache: "One command, one transaction", scenarios "Second event
 * refused" and "Crash between the disposition and the move"; design.md
 * section 4). An operation may answer with `events`, an ordered list of
 * one or two proposed events: each is folded in memory against the state
 * the earlier one leaves, each gets the next hybrid timestamp, a refusal
 * of either writes nothing, and the files are written in order before one
 * commit. The CLI forms (`move merged --unplanned`, `close --task`) are
 * group 2's; here the operations propose the same pairs directly.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { compareHlc, nextHlc } from '../../events/hlc.js';
import type { Status } from '../../events/schema.js';
import { openBoard, type Board } from '../board.js';
import { dumpCache, readTicket } from '../cache.js';
import { readLastPosition } from '../engine.js';
import { BoardError } from '../errors.js';
import { checkCache } from '../rebuild.js';
import {
  runCommand,
  type CommandResult,
  type Operation,
  type ProposedEvent,
  type ProposedEvents,
} from '../transaction.js';
import {
  P,
  T1,
  T2,
  TASK,
  allNames,
  canon,
  clock,
  copyBoard,
  foldDir,
  propose,
  tempBoard,
} from './helpers.js';

const open: Board[] = [];

function openB(dir: string): Board {
  const board = openBoard(dir);
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

const START = 1_700_000_000_000;

function setup(): { board: Board; events: string; now: () => number } {
  const board = openB(tempBoard());
  return { board, events: board.eventsDir, now: clock(START) };
}

function one(board: Board, actor: string, event: ProposedEvent, now: () => number): CommandResult {
  return runCommand(board, actor, propose(event), { now, env: {} });
}

/** An operation that proposes `events` as one command. */
function together(events: ProposedEvents): Operation {
  return () => ({ ok: true, events });
}

function two(
  board: Board,
  actor: string,
  events: ProposedEvents,
  now: () => number,
): CommandResult {
  return runCommand(board, actor, together(events), { now, env: {} });
}

function adhocCreate(ticket: string, adhoc = 'hotfix'): ProposedEvent {
  return { kind: 'ticket.create', ticket, body: { title: 'Fix login redirect', adhoc } };
}

/** An ad hoc ticket (no task) moved to `status` by `orch`. */
function adhocIn(board: Board, status: Status, now: () => number, ticket = T1): void {
  one(board, 'orch', adhocCreate(ticket), now);
  const paths: Record<Status, Status[]> = {
    todo: [],
    tests: ['tests'],
    implementing: ['tests', 'implementing'],
    review: ['tests', 'implementing', 'review'],
    merged: ['tests', 'implementing', 'review', 'merged'],
    blocked: ['tests', 'blocked'],
  };
  for (const to of paths[status]) {
    one(board, 'orch', P.move(ticket, to), now);
  }
}

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

/** Asserts `fn` fails and leaves the events directory (temporaries included) and the cache untouched. */
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

describe('runCommand with events: one event', () => {
  it('a one-element list behaves exactly as event: same bytes, hash and result shape', () => {
    const a = setup();
    const b = setup();
    one(a.board, 'orch', P.create(T1), a.now);
    one(b.board, 'orch', P.create(T1), b.now);
    const viaEvent = one(a.board, 'impl', P.comment(T1, 'x'), a.now);
    const viaEvents = two(b.board, 'impl', [P.comment(T1, 'x')], b.now);
    expect(viaEvents.event).toEqual(viaEvent.event);
    expect(viaEvents.hash).toBe(viaEvent.hash);
    expect(readFileSync(viaEvents.path)).toEqual(readFileSync(viaEvent.path));
    expect(viaEvents.events).toEqual([
      { hash: viaEvents.hash, path: viaEvents.path, event: viaEvents.event },
    ]);
    expect(viaEvent.events).toEqual([{ hash: viaEvent.hash, path: viaEvent.path, event: viaEvent.event }]);
    expect(dumpCache(a.board.db)).toBe(dumpCache(b.board.db));
  });
});

describe('runCommand with events: two events written together', () => {
  it('writes the disposition then the move, in order, as one command', () => {
    const { board, events, now } = setup();
    adhocIn(board, 'review', now);
    const before = readTicket(board.db, T1);
    const namesBefore = allNames(events);
    let calls = 0;
    const counted = (): number => {
      calls += 1;
      return now();
    };
    const result = runCommand(
      board,
      'orch',
      together([P.unplanned(T1, 'production hotfix, no plan'), P.move(T1, 'merged')]),
      { now: counted, env: {} },
    );
    expect(calls).toBe(1);

    // Two files, in write order, each canonical and named by its hash.
    expect(result.events).toHaveLength(2);
    const [first, second] = result.events;
    if (first === undefined || second === undefined) {
      throw new Error('expected two written events');
    }
    expect(first.event.kind).toBe('ticket.unplanned');
    expect(second.event.kind).toBe('ticket.move');
    for (const written of [first, second]) {
      const bytes = canonicalEncode(written.event);
      expect(written.hash).toBe(sha256Hex(bytes));
      expect(written.path).toBe(join(events, `${written.hash}.json`));
      expect(Buffer.compare(readFileSync(written.path), Buffer.from(bytes))).toBe(0);
    }
    expect(allNames(events)).toEqual(
      [...namesBefore, basename(first.path), basename(second.path)].sort(),
    );

    // hash, path and event are the last event's.
    expect({ hash: result.hash, path: result.path, event: result.event }).toEqual(second);

    // Each got the next hybrid timestamp, from one clock reading.
    const t = START + 4000;
    expect(first.event.ts).toEqual({ wall: t, counter: 0, actor: 'orch' });
    expect(second.event.ts).toEqual(nextHlc(first.event.ts, t, 'orch'));
    expect(compareHlc(first.event.ts, second.event.ts)).toBe(-1);
    expect(first.event.actor).toBe('orch');
    expect(second.event.actor).toBe('orch');

    // The ticket after both: merged, disposed, version up by two.
    expect(result.ticket).toEqual(readTicket(board.db, T1));
    expect(result.ticket).toMatchObject({
      status: 'merged',
      adhoc: 'hotfix',
      task: null,
      unplanned: { reason: 'production hotfix, no plan', actor: 'orch', ts: first.event.ts },
      version: (before?.version ?? 0) + 2,
    });
    expect(result.ticket?.updatedAt).toEqual(second.event.ts);

    // Both recorded as applied, the last position is the second, one commit.
    for (const written of [first, second]) {
      expect(board.db.prepare('SELECT folded, reason FROM folded WHERE hash = ?').get(written.hash))
        .toEqual({ folded: 1, reason: null });
    }
    expect(readLastPosition(board.db)).toEqual({ hash: second.hash, ts: second.event.ts });
    expect(board.db.isTransaction).toBe(false);
    expect(canon(readTicket(board.db, T1))).toBe(canon(foldDir(events).state.tickets[T1]));
    expect(dumpCache(board.db)).toBe(dumpCache(openB(copyBoard(events)).db));
    expect(checkCache(board).ok).toBe(true);
  });

  it('writes a task link then a close as one command', () => {
    const { board, events, now } = setup();
    adhocIn(board, 'blocked', now);
    const result = two(board, 'orch', [P.task(T1), P.close(T1)], now);
    expect(result.events.map((e) => e.event.kind)).toEqual(['ticket.link', 'ticket.close']);
    expect(result.ticket).toMatchObject({
      closed: true,
      disposition: { noDecision: true },
      task: TASK,
      adhoc: null,
      unplanned: null,
    });
    expect(allNames(events)).toHaveLength(5);
    expect(foldDir(events).rejected).toEqual([]);
  });

  it('writes a disposition then a hand-off into merged as one command', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    const result = two(
      board,
      'reviewer',
      [P.unplanned(T1, 'hotfix'), P.handoff(T1, 'merger', 'merged', 'landed')],
      now,
    );
    expect(result.ticket).toMatchObject({
      status: 'merged',
      assignee: 'merger',
      unplanned: { reason: 'hotfix', actor: 'reviewer' },
    });
    expect(result.ticket?.comments.map((c) => c.text)).toEqual(['landed']);
  });

  it('records a second unplanned reason on a ticket already disposed, with its move', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    one(board, 'orch', P.unplanned(T1, 'first thought'), now);
    const result = two(board, 'rev', [P.unplanned(T1, 'on reflection'), P.move(T1, 'merged')], now);
    expect(result.ticket?.unplanned).toMatchObject({ reason: 'on reflection', actor: 'rev' });
    expect(result.ticket?.status).toBe('merged');
  });

  it('the catch-up before the command sees other writers, and the pair folds after their events', () => {
    const { board, events, now } = setup();
    adhocIn(board, 'review', now);
    const other = openB(copyBoard(events));
    one(other, 'other', P.comment(T1, 'from another process'), clock(START + 60_000));
    const theirs = allNames(other.eventsDir).filter((n) => !allNames(events).includes(n));
    for (const name of theirs) {
      writeFileSync(join(events, name), readFileSync(join(other.eventsDir, name)));
    }
    const result = two(board, 'orch', [P.unplanned(T1, 'x'), P.move(T1, 'merged')], now);
    expect(result.catchUp.applied).toHaveLength(1);
    expect(result.ticket?.comments.map((c) => c.text)).toEqual(['from another process']);
    const [first] = result.events;
    expect(first?.event.ts.wall).toBe(START + 60_000);
    expect(first?.event.ts.counter).toBe(1);
  });
});

describe('runCommand with events: any refusal writes nothing', () => {
  it('scenario: second event refused (link then close in implementing) is exit 4 invalid-transition, nothing written', () => {
    const { board, now } = setup();
    adhocIn(board, 'implementing', now);
    let hooks = 0;
    const count = { afterTempWrite: () => (hooks += 1), afterRename: () => (hooks += 1) };
    const err = expectNoWrite(
      board,
      () =>
        runCommand(board, 'orch', together([P.task(T1), P.close(T1)]), { now, hooks: count }),
      4,
      'invalid-transition',
    );
    expect(hooks).toBe(0);
    expect(err.message).toContain('ticket.close');
    const t = readTicket(board.db, T1);
    expect(t?.closed).toBe(false);
    expect(t?.task).toBeNull();
    expect(t?.adhoc).toBe('hotfix');
    expect(foldDir(board.eventsDir).state.tickets[T1]?.task).toBeNull();
  });

  it('first event refused: unplanned on a linked ticket is exit 4 already-linked before the move is looked at', () => {
    const { board, now } = setup();
    one(board, 'orch', P.create(T1), now);
    // In todo, the move to merged would be invalid-transition; the
    // disposition is folded first, so already-linked wins.
    const err = expectNoWrite(
      board,
      () => two(board, 'orch', [P.unplanned(T1, 'y'), P.move(T1, 'merged')], now),
      4,
      'already-linked',
    );
    expect(err.message).toContain('ticket.unplanned');
    expect(readTicket(board.db, T1)?.unplanned).toBeNull();
  });

  it('second event refused for want of a disposition cannot happen after an applied disposition: the pair applies', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    expect(() => two(board, 'orch', [P.unplanned(T1, 'x'), P.move(T1, 'merged')], now)).not.toThrow();
  });

  it('single move into merged: invalid-transition from todo, needs-scope-disposition from review', () => {
    const { board, now } = setup();
    adhocIn(board, 'todo', now);
    expectNoWrite(board, () => one(board, 'orch', P.move(T1, 'merged'), now), 4, 'invalid-transition');
    for (const to of ['tests', 'implementing', 'review'] as const) {
      one(board, 'orch', P.move(T1, to), now);
    }
    const err = expectNoWrite(
      board,
      () => one(board, 'orch', P.move(T1, 'merged'), now),
      4,
      'needs-scope-disposition',
    );
    expect(err.message).toContain(T1);
    expect(err.message).toContain('needs-scope-disposition');
  });

  it('a malformed second event is exit 1 malformed-event naming the field, nothing written', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    // The first event is accepted in memory; the second is malformed.
    const err = expectNoWrite(
      board,
      () => two(board, 'orch', [P.comment(T1, 'about to merge'), P.unplanned(T1, '')], now),
      1,
      'malformed-event',
    );
    expect(err.message).toContain('body.reason');
    expect(readTicket(board.db, T1)?.comments).toEqual([]);
  });

  it('a first event the fold rejects refuses the command before the second is validated', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    // The move is refused (needs-scope-disposition); the malformed second
    // event is never reached.
    expectNoWrite(
      board,
      () => two(board, 'orch', [P.move(T1, 'merged'), P.unplanned(T1, '')], now),
      4,
      'needs-scope-disposition',
    );
  });

  it('a malformed first event is exit 1 malformed-event, nothing written', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    const err = expectNoWrite(
      board,
      () => two(board, 'orch', [P.unplanned(T1, ''), P.move(T1, 'merged')], now),
      1,
      'malformed-event',
    );
    expect(err.message).toContain('body.reason');
  });

  it('a second event for an unknown ticket is exit 4 unknown-ticket, nothing written', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    expectNoWrite(
      board,
      () => two(board, 'orch', [P.unplanned(T1, 'x'), P.move(T2, 'merged')], now),
      4,
      'unknown-ticket',
    );
    expect(readTicket(board.db, T1)?.unplanned).toBeNull();
  });

  it('a refusal still commits what catch-up folded', () => {
    const { board, events, now } = setup();
    adhocIn(board, 'implementing', now);
    const other = openB(copyBoard(events));
    const theirs = one(other, 'other', P.comment(T1, 'orphan'), clock(START + 60_000));
    writeFileSync(join(events, basename(theirs.path)), readFileSync(theirs.path));
    expectBoardError(
      () => two(board, 'orch', [P.task(T1), P.close(T1)], now),
      4,
      'invalid-transition',
    );
    expect(board.db.isTransaction).toBe(false);
    expect(readTicket(board.db, T1)?.comments.map((c) => c.text)).toEqual(['orphan']);
  });
});

describe('runCommand with events: crashes between the two files', () => {
  it('scenario: killed after the first rename leaves the disposition without its move; the next catch-up folds it', () => {
    const { board, events, now } = setup();
    adhocIn(board, 'review', now);
    const dump = dumpCache(board.db);
    const renamed: string[] = [];
    expect(() =>
      runCommand(
        board,
        'orch',
        together([P.unplanned(T1, 'hotfix'), P.move(T1, 'merged')]),
        {
          now,
          hooks: {
            afterRename: (path) => {
              renamed.push(path);
              throw new Error('SIGKILL');
            },
          },
        },
      ),
    ).toThrow('SIGKILL');
    expect(board.db.isTransaction).toBe(false);
    expect(renamed).toHaveLength(1);
    const [path] = renamed;
    expect(existsSync(path ?? '')).toBe(true);
    expect(allNames(events).filter((n) => !n.startsWith('.tmp-'))).toHaveLength(5);
    expect(dumpCache(board.db)).toBe(dump);
    expect(readTicket(board.db, T1)?.unplanned).toBeNull();

    // The file is a complete, well-formed disposition.
    const orphan = foldDir(events);
    expect(orphan.rejected).toEqual([]);
    expect(orphan.state.tickets[T1]).toMatchObject({
      status: 'review',
      unplanned: { reason: 'hotfix', actor: 'orch' },
    });

    // The next command folds it: T1 is still in review with the disposition.
    const next = one(board, 'other', P.comment(T1, 'after the crash'), now);
    expect(next.catchUp.applied).toEqual([basename(path ?? '', '.json')]);
    expect(next.ticket).toMatchObject({
      status: 'review',
      unplanned: { reason: 'hotfix', actor: 'orch' },
    });
    expect(checkCache(board).ok).toBe(true);

    // A move to merged without another disposition then succeeds.
    const merged = one(board, 'orch', P.move(T1, 'merged'), now);
    expect(merged.ticket?.status).toBe('merged');
    expect(merged.ticket?.unplanned?.reason).toBe('hotfix');
    expect(dumpCache(board.db)).toBe(dumpCache(openB(copyBoard(events)).db));
  });

  it('killed after the second rename leaves both files; the next catch-up folds both in order', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    const dump = dumpCache(board.db);
    const renamed: string[] = [];
    expect(() =>
      runCommand(
        board,
        'orch',
        together([P.unplanned(T1, 'hotfix'), P.move(T1, 'merged')]),
        {
          now,
          hooks: {
            afterRename: (path) => {
              renamed.push(path);
              if (renamed.length === 2) {
                throw new Error('SIGKILL');
              }
            },
          },
        },
      ),
    ).toThrow('SIGKILL');
    expect(renamed).toHaveLength(2);
    expect(dumpCache(board.db)).toBe(dump);
    const next = one(board, 'other', P.comment(T1, 'after'), now);
    expect(next.catchUp.applied).toEqual(renamed.map((p) => basename(p, '.json')));
    expect(next.ticket).toMatchObject({ status: 'merged', unplanned: { reason: 'hotfix' } });
    expect(checkCache(board).ok).toBe(true);
  });

  it('killed during the first temporary write leaves no hash-named file and no disposition', () => {
    const { board, events, now } = setup();
    adhocIn(board, 'review', now);
    const before = allNames(events);
    let temp = '';
    expect(() =>
      runCommand(
        board,
        'orch',
        together([P.unplanned(T1, 'hotfix'), P.move(T1, 'merged')]),
        {
          now,
          hooks: {
            afterTempWrite: (path) => {
              temp = path;
              throw new Error('SIGKILL');
            },
          },
        },
      ),
    ).toThrow('SIGKILL');
    expect(allNames(events).filter((n) => !n.startsWith('.tmp-'))).toEqual(before);
    expect(existsSync(temp)).toBe(true);
    expect(foldDir(events).state.tickets[T1]).toMatchObject({ status: 'review', unplanned: null });
  });

  it('the write lock is held across both files and the commit', () => {
    const { board, now } = setup();
    adhocIn(board, 'review', now);
    const probe = new DatabaseSync(board.cachePath);
    probe.exec('PRAGMA busy_timeout = 0');
    const locked: boolean[] = [];
    const canLock = (): boolean => {
      try {
        probe.exec('BEGIN IMMEDIATE');
      } catch {
        return false;
      }
      probe.exec('ROLLBACK');
      return true;
    };
    try {
      runCommand(board, 'orch', together([P.unplanned(T1, 'x'), P.move(T1, 'merged')]), {
        now,
        hooks: { afterRename: () => locked.push(!canLock()) },
      });
      expect(locked).toEqual([true, true]);
      expect(canLock()).toBe(true);
    } finally {
      probe.close();
    }
  });
});
