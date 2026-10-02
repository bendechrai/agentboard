/**
 * The snapshot loader (add-board-web design.md: "Interfaces (sketch)", "Reads never
 * block writers"): tickets, meta, every
 * well-formed event with its outcome in fold order, and the position id,
 * from one read snapshot.
 *
 * Expected values are computed independently of the loader: outcomes and
 * state by `fold` (`src/events/fold.ts`) over the event files
 * (`foldDir`), the fold order by `compareFoldOrder` over the files, and the digest by XOR with
 * `Buffer`. The one comparison with the feed is the point of the test
 * "equals the id of a feed started on the same board".
 */

import { describe, expect, it } from 'vitest';

import { compareFoldOrder, type FoldInput } from '../../events/fold.js';
import { readEventFile, type ReadOutcome } from '../../store/eventfile.js';
import { P, T1, T2, ev, eventNames, foldDir, seedRich } from '../../store/__tests__/helpers.js';
import type { EventView, FeedMessage } from '../../view/types.js';
import { commentTicket } from '../actions.js';
import { EMPTY_POSITION_ID, createEventCache, watchBoard } from '../feed.js';
import { loadSnapshot, type BoardSnapshot } from '../snapshot.js';
import { makeBoardDir, openTracked, putEvent, setup, tempDir } from './helpers.js';

/** Bytewise XOR of the hex hashes, as 64 lowercase hex characters. */
function xorHex(hashes: Iterable<string>): string {
  const acc = Buffer.alloc(32);
  for (const hash of new Set(hashes)) {
    const bytes = Buffer.from(hash, 'hex');
    for (let i = 0; i < 32; i += 1) {
      acc[i] = (acc[i] ?? 0) ^ (bytes[i] ?? 0);
    }
  }
  return acc.toString('hex');
}

/** Every well-formed event file of `eventsDir`, in fold order. */
function inputsOf(eventsDir: string): FoldInput[] {
  const out: FoldInput[] = [];
  for (const name of eventNames(eventsDir)) {
    const outcome = readEventFile(eventsDir, name);
    if (outcome.status === 'ok') {
      out.push(outcome.input as FoldInput);
    }
  }
  return out.sort(compareFoldOrder);
}

/** The expected snapshot of `eventsDir`, by an independent fold. */
function expected(eventsDir: string): BoardSnapshot {
  const result = foldDir(eventsDir);
  const rejected = new Map(result.rejected.map((r) => [r.hash, r.reason]));
  const unknown = new Set(result.unknown.map((u) => u.hash));
  const events: EventView[] = inputsOf(eventsDir).map((input) => {
    const { event } = input;
    const reason = rejected.get(input.hash) ?? null;
    return {
      hash: input.hash,
      kind: event.kind,
      ticket: 'ticket' in event && typeof event.ticket === 'string' ? event.ticket : null,
      actor: event.actor,
      ts: event.ts,
      outcome: unknown.has(input.hash) ? 'unknown' : reason === null ? 'applied' : 'rejected',
      reason,
      event,
    };
  });
  const applied = events.filter((e) => e.outcome === 'applied');
  const head = applied.at(-1)?.hash ?? null;
  return {
    tickets: result.state.tickets,
    meta: result.state.meta,
    events,
    head,
    id: head === null ? EMPTY_POSITION_ID : `${head}.${xorHex(applied.map((e) => e.hash))}`,
  };
}

/** JSON round trip, as the API sends it. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('loadSnapshot', () => {
  it('gives an empty board as no ticket, no meta, no event, head null and the empty id', () => {
    const { board } = setup();
    expect(loadSnapshot(board)).toEqual({
      tickets: {},
      meta: {},
      events: [],
      head: null,
      id: EMPTY_POSITION_ID,
    });
  });

  it('loads every ticket, the meta and every well-formed event with its outcome in fold order', () => {
    const dir = makeBoardDir(tempDir());
    seedRich(`${dir}/events`);
    const board = openTracked(dir);
    const snapshot = loadSnapshot(board);
    const want = expected(board.eventsDir);
    // The fixture has rejected, unknown-kind and board.meta events, and closed tickets.
    expect(want.events.some((e) => e.outcome === 'rejected')).toBe(true);
    expect(want.events.some((e) => e.outcome === 'unknown')).toBe(true);
    expect(want.events.some((e) => e.kind === 'board.meta' && e.ticket === null)).toBe(true);
    expect(Object.values(want.tickets).some((t) => t.closed)).toBe(true);
    expect(plain(snapshot)).toEqual(plain(want));
    expect(snapshot.events.map((e) => e.hash)).toEqual(want.events.map((e) => e.hash));
  });

  it('leaves malformed files out', () => {
    const dir = makeBoardDir(tempDir());
    const eventsDir = `${dir}/events`;
    putEvent(eventsDir, ev(P.create(T1, 'One'), 'orch', 1000));
    const malformed = putEvent(eventsDir, { v: 1, kind: 'ticket.comment', actor: 'x' });
    const board = openTracked(dir);
    const snapshot = loadSnapshot(board);
    expect(snapshot.events.map((e) => e.hash)).not.toContain(malformed);
    expect(snapshot.events).toHaveLength(1);
  });

  it('equals the position id of a feed started on the same board', async () => {
    const dir = makeBoardDir(tempDir());
    seedRich(`${dir}/events`);
    const board = openTracked(dir);
    const messages: FeedMessage[] = [];
    const controller = new AbortController();
    controller.abort();
    await watchBoard(board, { signal: controller.signal, onMessage: (m) => messages.push(m) });
    expect(messages).toHaveLength(1);
    expect(loadSnapshot(board).id).toBe(messages[0]?.id);
    // And after more events, on a board a feed has never seen.
    commentTicket(board, 'impl', { id: T2, text: 'later' });
    const again: FeedMessage[] = [];
    await watchBoard(board, { signal: controller.signal, onMessage: (m) => again.push(m) });
    expect(loadSnapshot(board).id).toBe(again[0]?.id);
    expect(again[0]?.id).not.toBe(messages[0]?.id);
  });

  it('catches up first, so an event file written by another process is included', () => {
    const { board } = setup();
    putEvent(board.eventsDir, ev(P.create(T1, 'Late file'), 'other', 1000));
    const snapshot = loadSnapshot(board);
    expect(Object.keys(snapshot.tickets)).toEqual([T1]);
    expect(snapshot.events.map((e) => e.kind)).toEqual(['ticket.create']);
  });

  it('commits its read transaction before returning, and writes no cursor', () => {
    const dir = makeBoardDir(tempDir());
    seedRich(`${dir}/events`);
    const board = openTracked(dir);
    const rows = (): unknown => ({
      cursors: board.db.prepare('SELECT * FROM cursors').all(),
      seen: board.db.prepare('SELECT * FROM cursor_seen').all(),
    });
    const before = rows();
    loadSnapshot(board);
    expect(board.db.isTransaction).toBe(false);
    expect(rows()).toEqual(before);
  });

  it('reads each event file through the cache it is given, at most once', () => {
    const dir = makeBoardDir(tempDir());
    const count = seedRich(`${dir}/events`).length;
    const board = openTracked(dir);
    const reads: string[] = [];
    const cache = createEventCache((eventsDir, name): ReadOutcome => {
      reads.push(name);
      return readEventFile(eventsDir, name);
    });
    const first = loadSnapshot(board, { cache });
    expect(first.events).toHaveLength(count);
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads.length).toBeLessThanOrEqual(count);
    const n = reads.length;
    expect(plain(loadSnapshot(board, { cache }))).toEqual(plain(first));
    expect(reads).toHaveLength(n);
  });
});
