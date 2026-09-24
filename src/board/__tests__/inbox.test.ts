/**
 * `readInbox` (board-concurrency: "Inbox never misses an event";
 * board-openspec-integration: "Orchestrator inbox protocol"; board-cache:
 * losing cursors only causes redelivery). Task group 5.1.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BoardEvent } from '../../events/schema.js';
import { openBoard } from '../../store/board.js';
import { CACHE_FILE } from '../../store/cache.js';
import { readCursor } from '../../store/cursors.js';
import { rebuild } from '../../store/rebuild.js';
import { P, T1, T2, ev } from '../../store/__tests__/helpers.js';
import { claimTicket, commentTicket, handoffTicket, moveTicket } from '../actions.js';
import { readInbox, type InboxEntry } from '../inbox.js';
import {
  create,
  expectBoardError,
  makeBoardDir,
  openTracked,
  putEvent,
  setup,
  tempDir,
} from './helpers.js';

const HOUR = 3_600_000;

function hashes(entries: readonly InboxEntry[]): string[] {
  return entries.map((e) => e.hash);
}

/** A board directory seeded with raw event files, and its events path. */
function seededDir(events: readonly BoardEvent[]): {
  dir: string;
  eventsDir: string;
  hashes: string[];
} {
  const dir = makeBoardDir(tempDir());
  const eventsDir = join(dir, 'events');
  return { dir, eventsDir, hashes: events.map((e) => putEvent(eventsDir, e)) };
}

describe('orchestrator inbox protocol', () => {
  it('lists a handoff with ticket, from, to, status and note, and a second call returns nothing new', () => {
    const { board } = setup();
    const ticket = create(board);
    moveTicket(board, 'orch', { id: ticket.id, to: 'tests' });
    moveTicket(board, 'orch', { id: ticket.id, to: 'implementing' });
    claimTicket(board, 'impl', { id: ticket.id });
    const handed = handoffTicket(board, 'impl', {
      id: ticket.id,
      to: 'reviewer',
      status: 'review',
      note: 'done',
    });
    const first = readInbox(board, 'orchestrator');
    const entry = first.entries.find((e) => e.kind === 'ticket.handoff');
    expect(entry).toMatchObject({
      hash: handed.hash,
      ticket: ticket.id,
      from: 'impl',
      to: 'reviewer',
      status: 'review',
      note: 'done',
    });
    expect(first.advanced).toBe(true);
    expect(first.cursor).toBe(handed.hash);
    const second = readInbox(board, 'orchestrator');
    expect(second.entries).toEqual([]);
    expect(second.advanced).toBe(false);
    expect(second.cursor).toBe(handed.hash);
  });

  it('delivers events written after the previous call, and only those', () => {
    const { board } = setup();
    const ticket = create(board);
    expect(readInbox(board, 'orch').entries).toHaveLength(1);
    const c = commentTicket(board, 'impl', { id: ticket.id, text: 'hello' });
    const next = readInbox(board, 'orch');
    expect(hashes(next.entries)).toEqual([c.hash]);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });
});

describe('inbox entries', () => {
  it('lists every effective event in fold order with the fields lifted from each kind', () => {
    const { dir, hashes: h } = seededDir([
      ev(P.create(T1, 'First'), 'orch', 1000),
      ev(P.claim(T1), 'impl', 1100),
      ev(P.move(T1, 'tests'), 'impl', 1200),
      ev(P.comment(T1, 'a comment'), 'impl', 1300),
      ev({ kind: 'ticket.assign', ticket: T1, body: { to: 'rev' } }, 'orch', 1400),
      ev(P.handoff(T1, 'impl', 'implementing', 'your turn'), 'rev', 1500),
      ev(P.pr(T1, 7), 'impl', 1600),
      ev(P.meta('columns', ['a']), 'orch', 1700),
    ]);
    const board = openTracked(dir);
    const out = readInbox(board, 'watcher');
    expect(out.actor).toBe('watcher');
    expect(hashes(out.entries)).toEqual(h);
    const pick = (e: InboxEntry): unknown => [e.kind, e.ticket, e.from, e.to, e.status, e.note];
    expect(out.entries.map(pick)).toEqual([
      ['ticket.create', T1, 'orch', null, null, null],
      ['ticket.claim', T1, 'impl', null, null, null],
      ['ticket.move', T1, 'impl', null, 'tests', null],
      ['ticket.comment', T1, 'impl', null, null, 'a comment'],
      ['ticket.assign', T1, 'orch', 'rev', null, null],
      ['ticket.handoff', T1, 'rev', 'impl', 'implementing', 'your turn'],
      ['ticket.link', T1, 'impl', null, null, null],
      ['board.meta', null, 'orch', null, null, null],
    ]);
    const first = out.entries[0];
    expect(first?.ts).toEqual({ wall: 1000, counter: 0, actor: 'orch' });
    expect(first?.event).toEqual(ev(P.create(T1, 'First'), 'orch', 1000));
  });

  it('never lists rejected, unknown-kind or malformed events', () => {
    const { dir, hashes: h } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.claim(T1), 'impl', 1100),
      ev(P.claim(T1), 'intruder', 1200),
      ev(P.comment(T2, 'no such ticket'), 'orch', 1300),
    ]);
    putEvent(join(dir, 'events'), {
      v: 1,
      kind: 'ticket.estimate',
      ticket: T1,
      actor: 'orch',
      ts: { wall: 1400, counter: 0, actor: 'orch' },
      body: { points: 3 },
    });
    putEvent(join(dir, 'events'), { v: 1, kind: 'ticket.comment', ticket: T1, body: {} });
    const board = openTracked(dir);
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([h[0], h[1]]);
  });

  it("includes the actor's own events", () => {
    const { board } = setup();
    const ticket = create(board, {}, 'orch');
    const out = readInbox(board, 'orch');
    expect(out.entries.map((e) => [e.ticket, e.from])).toEqual([[ticket.id, 'orch']]);
  });

  it('returns nothing and stores no cursor on an empty board', () => {
    const { board } = setup();
    const out = readInbox(board, 'orch');
    expect(out).toEqual({ actor: 'orch', entries: [], cursor: null, advanced: false });
    expect(board.db.prepare('SELECT * FROM cursors').all()).toEqual([]);
  });

  it('keeps one cursor per actor', () => {
    const { board } = setup();
    create(board);
    expect(readInbox(board, 'a').entries).toHaveLength(1);
    expect(readInbox(board, 'b').entries).toHaveLength(1);
    expect(readInbox(board, 'a').entries).toHaveLength(0);
  });

  it('refuses an empty actor', () => {
    const { board } = setup();
    expectBoardError(() => readInbox(board, ''), 1, 'missing-actor');
  });
});

describe('--peek', () => {
  it('returns the same events twice and does not advance the cursor', () => {
    const { board } = setup();
    const ticket = create(board);
    commentTicket(board, 'impl', { id: ticket.id, text: 'x' });
    const first = readInbox(board, 'orch', { peek: true });
    const second = readInbox(board, 'orch', { peek: true });
    expect(first.entries).toHaveLength(2);
    expect(second).toEqual(first);
    expect(first.advanced).toBe(false);
    expect(first.cursor).toBeNull();
    expect(board.db.prepare('SELECT * FROM cursors').all()).toEqual([]);
    // A plain inbox still delivers them, then a peek shows nothing.
    expect(readInbox(board, 'orch').entries).toEqual(first.entries);
    expect(readInbox(board, 'orch', { peek: true }).entries).toEqual([]);
  });

  it('reports the stored cursor unchanged', () => {
    const { board } = setup();
    const ticket = create(board);
    const acked = readInbox(board, 'orch');
    commentTicket(board, 'impl', { id: ticket.id, text: 'x' });
    const peek = readInbox(board, 'orch', { peek: true });
    expect(peek.cursor).toBe(acked.cursor);
    expect(peek.entries).toHaveLength(1);
    expect(readCursor(board.db, 'orch').position?.hash).toBe(acked.cursor);
  });
});

describe('late-arriving events', () => {
  it('delivers a synced event with an earlier timestamp than the cursor (inside the window)', () => {
    const { dir, eventsDir } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'at 2000'), 'impl', 2000),
    ]);
    const board = openTracked(dir);
    expect(readInbox(board, 'orch').entries).toHaveLength(2);
    // Another machine's event, synced in after the cursor moved to wall 2000.
    const late = putEvent(eventsDir, ev(P.comment(T1, 'at 1500'), 'remote', 1500));
    const next = readInbox(board, 'orch');
    expect(hashes(next.entries)).toEqual([late]);
    expect(next.entries[0]?.ts.wall).toBe(1500);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('delivers late events together with new ones, in fold order', () => {
    const { dir, eventsDir } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'at 2000'), 'impl', 2000),
    ]);
    const board = openTracked(dir);
    readInbox(board, 'orch');
    const newer = putEvent(eventsDir, ev(P.comment(T1, 'at 3000'), 'remote', 3000));
    const late = putEvent(eventsDir, ev(P.comment(T1, 'at 1500'), 'remote', 1500));
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([late, newer]);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('delivers a late event older than the seen-set window, found by the next catch-up', () => {
    const { dir, eventsDir } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR),
    ]);
    const board = openTracked(dir);
    expect(readInbox(board, 'orch').entries).toHaveLength(2);
    const late = putEvent(eventsDir, ev(P.comment(T1, 'at 2h'), 'remote', 2 * HOUR));
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([late]);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('delivers a late event older than the window that rebuild reported', () => {
    const { dir, eventsDir } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR),
    ]);
    const board = openTracked(dir);
    readInbox(board, 'orch');
    const late = putEvent(eventsDir, ev(P.comment(T1, 'at 2h'), 'remote', 2 * HOUR));
    const report = rebuild(board);
    expect(report.late.map((l) => [l.actor, l.hash])).toEqual([['orch', late]]);
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([late]);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('delivers an event that becomes effective when a late event is folded before it', () => {
    // The comment names a ticket whose create has not arrived yet: rejected.
    const { dir, eventsDir } = seededDir([ev(P.comment(T1, 'early comment'), 'impl', 2000)]);
    const board = openTracked(dir);
    expect(readInbox(board, 'orch').entries).toEqual([]);
    create(board, { title: 'unrelated' });
    const acked = readInbox(board, 'orch');
    expect(acked.entries).toHaveLength(1);
    // The create arrives from another machine with an earlier timestamp.
    const createHash = putEvent(eventsDir, ev(P.create(T1), 'remote', 1000));
    const next = readInbox(board, 'orch');
    expect(next.entries.map((e) => e.kind)).toEqual(['ticket.create', 'ticket.comment']);
    expect(next.entries[0]?.hash).toBe(createHash);
  });
});

describe('events made effective behind the cursor', () => {
  /** A board acknowledged by orch up to a comment at wall 10 hours, plus an orphan comment. */
  function withOrphan(orphanWall: number): {
    board: ReturnType<typeof openTracked>;
    eventsDir: string;
    orphan: string;
  } {
    const { dir, eventsDir } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR),
      // T2 has no create yet: rejected as unknown-ticket.
      ev(P.comment(T2, 'orphan'), 'remote', orphanWall),
    ]);
    const board = openTracked(dir);
    const first = readInbox(board, 'orch');
    expect(first.entries).toHaveLength(2);
    return {
      board,
      eventsDir,
      orphan: putEvent(eventsDir, ev(P.comment(T2, 'orphan'), 'remote', orphanWall)),
    };
  }

  it('delivers an old rejected comment (outside the window) once its late create arrives', () => {
    const { board, eventsDir, orphan } = withOrphan(3 * HOUR);
    const created = putEvent(eventsDir, ev(P.create(T2), 'remote', 2 * HOUR));
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([created, orphan]);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('delivers it too when rebuild is what folds the late create', () => {
    const { board, eventsDir, orphan } = withOrphan(3 * HOUR);
    const created = putEvent(eventsDir, ev(P.create(T2), 'remote', 2 * HOUR));
    rebuild(board);
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([created, orphan]);
  });

  it('delivers a rejected comment inside the window once its late create arrives', () => {
    const { board, eventsDir, orphan } = withOrphan(9 * HOUR + 30 * 60_000);
    const created = putEvent(eventsDir, ev(P.create(T2), 'remote', 9 * HOUR + 10 * 60_000));
    expect(hashes(readInbox(board, 'orch').entries)).toEqual([created, orphan]);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });
});

describe('cursor persistence', () => {
  it('survives closing and reopening the board (another process)', () => {
    const { board, root } = setup();
    create(board);
    expect(readInbox(board, 'orch').entries).toHaveLength(1);
    board.close();
    const again = openTracked(join(root, '.board'));
    expect(readInbox(again, 'orch').entries).toEqual([]);
  });

  it('is shared by two open handles on one board', () => {
    const { board, root } = setup();
    create(board);
    const other = openTracked(join(root, '.board'));
    expect(readInbox(other, 'orch').entries).toHaveLength(1);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('redelivers rather than skips when the cache (and with it the cursor) is deleted', () => {
    const { board, root } = setup();
    const ticket = create(board);
    commentTicket(board, 'impl', { id: ticket.id, text: 'x' });
    const first = readInbox(board, 'orch');
    expect(first.entries).toHaveLength(2);
    board.close();
    const dir = join(root, '.board');
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(join(dir, CACHE_FILE + suffix), { force: true });
    }
    const again = openBoard(dir);
    try {
      expect(readInbox(again, 'orch').entries).toEqual(first.entries);
      expect(readInbox(again, 'orch').entries).toEqual([]);
    } finally {
      again.close();
    }
  });

  it('keeps the cursor across rebuild', () => {
    const { board } = setup();
    create(board);
    readInbox(board, 'orch');
    rebuild(board);
    expect(readInbox(board, 'orch').entries).toEqual([]);
  });

  it('stores the position and prunes the seen set to the window', () => {
    const { dir, hashes: h } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR),
    ]);
    const board = openTracked(dir);
    readInbox(board, 'orch');
    const cursor = readCursor(board.db, 'orch');
    expect(cursor.position).toEqual({
      hash: h[1],
      ts: { wall: 10 * HOUR, counter: 0, actor: 'impl' },
    });
    expect(cursor.seen).toEqual([{ hash: h[1], wall: 10 * HOUR }]);
  });
});

describe('--since', () => {
  function threeComments(): { dir: string; h: string[] } {
    const { dir, hashes: h } = seededDir([
      ev(P.create(T1), 'orch', 1000),
      ev(P.comment(T1, 'one'), 'impl', 2000),
      ev(P.claim(T1), 'impl', 2500),
      ev(P.claim(T1), 'late-claimer', 2600),
      ev(P.comment(T1, 'two'), 'impl', 3000),
    ]);
    return { dir, h };
  }

  it('lists the effective events after the given event, in fold order', () => {
    const { dir, h } = threeComments();
    const board = openTracked(dir);
    const out = readInbox(board, 'orch', { since: h[1] });
    expect(hashes(out.entries)).toEqual([h[2], h[4]]);
  });

  it('accepts a rejected event as the starting point', () => {
    const { dir, h } = threeComments();
    const board = openTracked(dir);
    expect(hashes(readInbox(board, 'orch', { since: h[3] }).entries)).toEqual([h[4]]);
  });

  it('neither reads nor advances the stored cursor', () => {
    const { dir, h } = threeComments();
    const board = openTracked(dir);
    readInbox(board, 'orch');
    const before = readCursor(board.db, 'orch');
    const out = readInbox(board, 'orch', { since: h[0] });
    expect(hashes(out.entries)).toEqual([h[1], h[2], h[4]]);
    expect(out.advanced).toBe(false);
    expect(out.cursor).toBe(before.position?.hash);
    expect(readCursor(board.db, 'orch')).toEqual(before);
    const fresh = readInbox(board, 'other', { since: h[4] });
    expect(fresh.entries).toEqual([]);
    expect(board.db.prepare("SELECT * FROM cursors WHERE actor = 'other'").all()).toEqual([]);
  });

  it('refuses a value that is not a full lowercase hash', () => {
    const { dir, h } = threeComments();
    const board = openTracked(dir);
    for (const bad of ['', 'abc', String(h[0]).toUpperCase(), `${String(h[0])}0`]) {
      expectBoardError(() => readInbox(board, 'orch', { since: bad }), 1, 'usage');
    }
  });

  it('refuses a hash that names no well-formed event of the board', () => {
    const { dir } = threeComments();
    const malformed = putEvent(join(dir, 'events'), {
      v: 1,
      kind: 'ticket.comment',
      ticket: T1,
      body: {},
    });
    const board = openTracked(dir);
    expectBoardError(
      () => readInbox(board, 'orch', { since: 'f'.repeat(64) }),
      1,
      'unknown-cursor',
    );
    expectBoardError(() => readInbox(board, 'orch', { since: malformed }), 1, 'unknown-cursor');
  });
});
