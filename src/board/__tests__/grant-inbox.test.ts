/**
 * Grants written by catch-up, seen through `inbox` (add-claim-leases task
 * 2.1; board-cli: "Due grants are written during catch-up", scenario
 * "Inbox writes the due grant"; board-concurrency: "Inbox never misses an
 * event").
 *
 * `readInbox` catches up with the default clock, so the clock is injected
 * by faking `Date` (vitest fake timers, `Date` only); `openBoard` is given
 * the same reading. Event walls are small numbers, and the fake clock is
 * set just before or after the grant's slot time.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { BoardEvent, TicketGrantEvent } from '../../events/schema.js';
import { openBoard, type Board } from '../../store/board.js';
import { P, T1, T2, ev, eventNames, putEvent, tempBoard } from '../../store/__tests__/helpers.js';
import { readInbox } from '../inbox.js';

const open: Board[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
  vi.useRealTimers();
});

/** Opens `dir` with the clock at `now` (the fake clock is set to it too). */
function openAt(dir: string, now: number): Board {
  vi.setSystemTime(now);
  const board = openBoard(dir, { now });
  open.push(board);
  return board;
}

/**
 * `merger-1` claimed T1 at 2000, `merger-2` joined at 3000 asking for
 * 600000, and `merger-1` released at 5000: the grant to `merger-2` is due
 * at 5001.
 */
function seed(): { dir: string; events: string; g: TicketGrantEvent } {
  const dir = tempBoard();
  const events = join(dir, 'events');
  putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
  putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
  putEvent(
    events,
    ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
  );
  const release = putEvent(
    events,
    ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', 5000),
  );
  const g: TicketGrantEvent = {
    v: 1,
    kind: 'ticket.grant',
    ticket: T1,
    actor: 'agentboard',
    ts: { wall: 5001, counter: 0, actor: 'agentboard' },
    body: { to: 'merger-2', ttl: 600_000, window: 120_000, after: { released: release } },
  };
  return { dir, events, g };
}

function hashes(entries: readonly { hash: string }[]): string[] {
  return entries.map((e) => e.hash);
}

describe('scenario: inbox writes the due grant', () => {
  it('the grant to merger-2 is written and returned in that inbox call', () => {
    const { dir, events, g } = seed();
    const hash = canonicalHash(g);
    const board = openAt(dir, 5001);
    const result = readInbox(board, 'merger-2');
    expect(eventNames(events)).toContain(`${hash}.json`);
    const entry = result.entries.find((e) => e.hash === hash);
    expect(entry).toMatchObject({ kind: 'ticket.grant', ticket: T1, from: 'agentboard' });
    expect(entry?.event).toEqual(g);
  });

  it('a board opened before the slot time writes the grant in the inbox call itself', () => {
    const { dir, events, g } = seed();
    const hash = canonicalHash(g);
    const board = openAt(dir, 5000);
    expect(eventNames(events)).not.toContain(`${hash}.json`);
    vi.setSystemTime(5001);
    const result = readInbox(board, 'merger-2');
    expect(eventNames(events)).toContain(`${hash}.json`);
    expect(hashes(result.entries)).toContain(hash);
  });

  it('peek also writes and returns the due grant', () => {
    const { dir, g } = seed();
    const board = openAt(dir, 5000);
    vi.setSystemTime(5001);
    expect(hashes(readInbox(board, 'merger-2', { peek: true }).entries)).toContain(
      canonicalHash(g),
    );
  });
});

describe('the grantee inbox returns the grant exactly once', () => {
  it('first call returns it once, later calls never again', () => {
    const { dir, g } = seed();
    const hash = canonicalHash(g);
    const board = openAt(dir, 4000);
    // merger-2 read its inbox before the grant was due.
    expect(hashes(readInbox(board, 'merger-2').entries)).not.toContain(hash);
    vi.setSystemTime(5001);
    const first = readInbox(board, 'merger-2');
    expect(hashes(first.entries).filter((h) => h === hash)).toHaveLength(1);
    vi.setSystemTime(6000);
    expect(hashes(readInbox(board, 'merger-2').entries)).not.toContain(hash);
    expect(hashes(readInbox(board, 'merger-2', { peek: true }).entries)).not.toContain(hash);
  });

  it('a fresh process (a new board handle) does not deliver it again', () => {
    const { dir, g } = seed();
    const hash = canonicalHash(g);
    const first = openAt(dir, 5001);
    expect(hashes(readInbox(first, 'merger-2').entries)).toContain(hash);
    first.close();
    const second = openAt(dir, 6000);
    expect(hashes(readInbox(second, 'merger-2').entries)).not.toContain(hash);
  });
});

describe('inbox cursors move back for a grant folded behind them', () => {
  it('a grant written behind a cursor and outside its seen window is delivered', () => {
    const { dir, events, g } = seed();
    const hash = canonicalHash(g);
    // An event from a machine whose clock runs ahead: more than the
    // one-hour seen window after the grant's slot.
    const future = 5001 + 2 * 3_600_000;
    putEvent(events, ev(P.create(T2, 'Other'), 'orch', 1100));
    const ahead: BoardEvent = ev(P.comment(T2, 'from the future'), 'remote', future);
    const aheadHash = putEvent(events, ahead);
    const board = openAt(dir, 5000);
    const before = readInbox(board, 'orch');
    // orch's cursor is now at the future event.
    expect(hashes(before.entries)).toContain(aheadHash);
    expect(before.cursor).toBe(aheadHash);

    vi.setSystemTime(6000);
    const after = readInbox(board, 'orch');
    expect(eventNames(events)).toContain(`${hash}.json`);
    expect(hashes(after.entries)).toContain(hash);
    expect(hashes(readInbox(board, 'orch').entries)).not.toContain(hash);
  });
});
