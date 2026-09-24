/**
 * The board feed (board-feed; add-board-web tasks 2.2 and 2.3), in
 * process: position ids and the digest, the event cache, append and
 * resync messages, idle ticks, cursors, and resume from a position id.
 * The child-process scenarios (a CLI write, twenty concurrent comments
 * while the consumer blocks) are in `src/__tests__/feed-processes.test.ts`.
 *
 * Expected values are computed independently of the feed: the digest by
 * XOR over the hex-decoded hashes with `Buffer`, and the effective events
 * and ticket states by the group 1 `fold` over the event files
 * (`foldDir`).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalEncode, sha256Hex } from '../../events/canonical.js';
import { compareFoldOrder, type FoldInput } from '../../events/fold.js';
import type { BoardEvent } from '../../events/schema.js';
import type { Board } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { readEventFile, type ReadOutcome } from '../../store/eventfile.js';
import { P, T1, T2, ev, eventNames, foldDir, seedRich } from '../../store/__tests__/helpers.js';
import type { EventView, FeedMessage } from '../../view/types.js';
import { commentTicket, moveTicket } from '../actions.js';
import { readInbox } from '../inbox.js';
import {
  EMPTY_DIGEST,
  EMPTY_POSITION_ID,
  createEventCache,
  effectiveDigest,
  parsePositionId,
  positionId,
  watchBoard,
  type EventCache,
  type WatchBoardOptions,
} from '../feed.js';
import { create, makeBoardDir, openTracked, putEvent, setup, tempDir } from './helpers.js';

// ---------------------------------------------------------------------------
// Independent expectations

/** Bytewise XOR of the distinct hex hashes, as 64 lowercase hex characters. */
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

/** Every well-formed event file of `eventsDir` as a fold input. */
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

/** The effective events of `eventsDir` in fold order, by an independent fold. */
function effective(eventsDir: string): FoldInput[] {
  const result = foldDir(eventsDir);
  const out = new Set([
    ...result.rejected.map((r) => r.hash),
    ...result.unknown.map((u) => u.hash),
  ]);
  return inputsOf(eventsDir).filter((input) => !out.has(input.hash));
}

/** The `EventView` of an effective event. */
function view(input: FoldInput): EventView {
  const { event } = input;
  return {
    hash: input.hash,
    kind: event.kind,
    ticket: 'ticket' in event && typeof event.ticket === 'string' ? event.ticket : null,
    actor: event.actor,
    ts: event.ts,
    outcome: 'applied',
    reason: null,
    event,
  };
}

/** The position id of the whole effective set of `eventsDir`. */
function expectedId(eventsDir: string): string {
  const all = effective(eventsDir);
  const head = all.at(-1);
  return head === undefined ? EMPTY_POSITION_ID : `${head.hash}.${xorHex(all.map((e) => e.hash))}`;
}

/** Writes `event` into `eventsDir` and returns it as a fold input. */
function put(eventsDir: string, event: BoardEvent): FoldInput {
  return { hash: putEvent(eventsDir, event), event };
}

// ---------------------------------------------------------------------------
// Running feeds

const HOUR = 3_600_000;

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    }
    await pause(10);
  }
}

/** The messages of a feed that ran only its first tick. */
async function firstTick(
  board: Board,
  extra: Partial<Omit<WatchBoardOptions, 'signal' | 'onMessage'>> = {},
): Promise<FeedMessage[]> {
  const messages: FeedMessage[] = [];
  await watchBoard(board, {
    ...extra,
    signal: aborted(),
    onMessage: (m) => messages.push(m),
  });
  return messages;
}

interface Running {
  messages: FeedMessage[];
  /** True if any `onMessage` call ran inside a transaction. */
  inTransaction: () => boolean;
  stop(): Promise<void>;
  done: Promise<void>;
}

/** A polling feed (20 ms, no fs.watch) recording its messages. */
function start(
  board: Board,
  extra: Partial<Omit<WatchBoardOptions, 'signal' | 'onMessage'>> = {},
): Running {
  const messages: FeedMessage[] = [];
  let inTx = false;
  const controller = new AbortController();
  const done = watchBoard(board, {
    pollMs: 20,
    fsWatch: false,
    ...extra,
    signal: controller.signal,
    onMessage: (m) => {
      inTx ||= board.db.isTransaction;
      messages.push(m);
    },
  });
  return {
    messages,
    inTransaction: () => inTx,
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

/** A `readEventFile` that counts its calls. */
function countingReader(): {
  read: (eventsDir: string, name: string) => ReadOutcome;
  count: () => number;
} {
  let n = 0;
  return {
    read: (eventsDir, name) => {
      n += 1;
      return readEventFile(eventsDir, name);
    },
    count: () => n,
  };
}

/**
 * An `EventCache` that keeps nothing: every `get` reads the file through
 * `read`, so a test counts every body the feed asks for.
 */
function forgetfulCache(read: (eventsDir: string, name: string) => ReadOutcome): EventCache {
  return {
    get(eventsDir, hash) {
      const outcome = read(eventsDir, `${hash}.json`);
      if (outcome.status !== 'ok') {
        throw new Error(`not well-formed: ${hash}`);
      }
      return outcome.input.event;
    },
    size: 0,
  };
}

/** Hashes of every event delivered by the appends among `messages`, in order. */
function appended(messages: readonly FeedMessage[]): string[] {
  return messages.flatMap((m) => (m.type === 'append' ? m.events.map((e) => e.hash) : []));
}

/** A fresh board directory (not opened) and its events directory. */
function boardDir(): { dir: string; eventsDir: string } {
  const dir = makeBoardDir(tempDir());
  return { dir, eventsDir: join(dir, 'events') };
}

// ---------------------------------------------------------------------------

describe('position ids (board-feed: "Position ids")', () => {
  const A = 'a'.repeat(64);
  const B = `${'0'.repeat(63)}1`;

  it('EMPTY_POSITION_ID is none. followed by 64 zeros', () => {
    expect(EMPTY_DIGEST).toBe('0'.repeat(64));
    expect(EMPTY_POSITION_ID).toBe(`none.${'0'.repeat(64)}`);
    expect(positionId(null, EMPTY_DIGEST)).toBe(EMPTY_POSITION_ID);
  });

  it('positionId joins the head and the digest with a dot', () => {
    expect(positionId(A, B)).toBe(`${A}.${B}`);
  });

  it('parsePositionId reads back what positionId writes', () => {
    expect(parsePositionId(`${A}.${B}`)).toEqual({ head: A, digest: B });
    expect(parsePositionId(EMPTY_POSITION_ID)).toEqual({ head: null, digest: EMPTY_DIGEST });
    expect(parsePositionId(`none.${B}`)).toEqual({ head: null, digest: B });
  });

  it.each([
    ['garbage'],
    [''],
    ['none'],
    [A],
    [`${A}.`],
    [`.${B}`],
    [`${A}.${B}.`],
    [`${A}.${B}x`],
    [` ${A}.${B}`],
    [`${A}.${B}\n`],
    [`${A.toUpperCase()}.${B}`],
    [`${A}.${'F'.repeat(64)}`],
    [`${A.slice(1)}.${B}`],
    [`${A}.${B.slice(1)}`],
    [`${A}0.${B}`],
    [`NONE.${B}`],
    [`${'g'.repeat(64)}.${B}`],
    [`${A}:${B}`],
  ])('parsePositionId(%j) is null, never a throw', (text) => {
    expect(parsePositionId(text)).toBeNull();
  });
});

describe('effectiveDigest', () => {
  const hashes = ['1', '2', '3', 'f'].map((c) => sha256Hex(new TextEncoder().encode(c)));

  it('is 64 zeros for no event', () => {
    expect(effectiveDigest([])).toBe(EMPTY_DIGEST);
  });

  it('is the bytewise XOR of the hashes decoded from hex', () => {
    expect(effectiveDigest(hashes)).toBe(xorHex(hashes));
    expect(effectiveDigest(hashes.slice(0, 1))).toBe(hashes[0]);
    expect(effectiveDigest(hashes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order independent', () => {
    expect(effectiveDigest([...hashes].reverse())).toBe(effectiveDigest(hashes));
    expect(effectiveDigest(new Set(hashes))).toBe(effectiveDigest(hashes));
  });

  it('counts a repeated hash once', () => {
    const [a = '', b = ''] = hashes;
    expect(effectiveDigest([a, b, a])).toBe(xorHex([a, b]));
    expect(effectiveDigest([a, a])).toBe(a);
  });
});

describe('createEventCache (design.md: "Event files are cached by hash")', () => {
  it('reads each file once and returns the validated event', () => {
    const { eventsDir } = boardDir();
    const one = put(eventsDir, ev(P.create(T1), 'orch', 1000));
    const two = put(eventsDir, ev(P.comment(T1, 'hi'), 'impl', 2000));
    const reader = countingReader();
    const cache: EventCache = createEventCache(reader.read);
    expect(cache.size).toBe(0);
    expect(cache.get(eventsDir, one.hash)).toEqual(one.event);
    expect(cache.get(eventsDir, one.hash)).toEqual(one.event);
    expect(cache.get(eventsDir, two.hash)).toEqual(two.event);
    expect(cache.get(eventsDir, two.hash)).toEqual(two.event);
    expect(reader.count()).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('is keyed by hash alone: another directory with the same file is not read again', () => {
    const a = boardDir();
    const b = boardDir();
    const event = ev(P.create(T1), 'orch', 1000);
    const hash = putEvent(a.eventsDir, event);
    putEvent(b.eventsDir, event);
    const reader = countingReader();
    const cache = createEventCache(reader.read);
    cache.get(a.eventsDir, hash);
    expect(cache.get(b.eventsDir, hash)).toEqual(event);
    expect(reader.count()).toBe(1);
  });

  it('refuses a file that is not a well-formed event, and keeps nothing', () => {
    const { eventsDir } = boardDir();
    const bytes = canonicalEncode({ v: 1, kind: 'ticket.comment' });
    const hash = sha256Hex(bytes);
    writeFileSync(join(eventsDir, `${hash}.json`), bytes);
    const reader = countingReader();
    const cache = createEventCache(reader.read);
    for (let i = 0; i < 2; i += 1) {
      let thrown: unknown = null;
      try {
        cache.get(eventsDir, hash);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BoardError);
      expect(thrown).toMatchObject({ exitCode: 5, reason: 'integrity' });
    }
    expect(reader.count()).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('passes a read error on and keeps nothing', () => {
    const { eventsDir } = boardDir();
    const cache = createEventCache();
    expect(() => cache.get(eventsDir, 'b'.repeat(64))).toThrow(/ENOENT/);
    expect(cache.size).toBe(0);
  });

  it('defaults to readEventFile', () => {
    const { eventsDir } = boardDir();
    const one = put(eventsDir, ev(P.create(T1), 'orch', 1000));
    expect(createEventCache().get(eventsDir, one.hash)).toEqual(one.event);
  });
});

describe('watchBoard: the first message', () => {
  it('scenario Empty board: an empty append with id none. and 64 zeros', async () => {
    const { board } = setup();
    expect(await firstTick(board)).toEqual([
      { type: 'append', id: EMPTY_POSITION_ID, events: [], tickets: [], meta: null },
    ]);
  });

  it('is an append of every effective event in fold order, with every ticket and the meta', async () => {
    const { dir, eventsDir } = boardDir();
    seedRich(eventsDir);
    const board = openTracked(dir);
    const messages = await firstTick(board);
    const fold = foldDir(eventsDir);
    const all = effective(eventsDir);
    // The seed holds rejected and unknown-kind events, which are left out.
    expect(all.length).toBeLessThan(inputsOf(eventsDir).length);
    expect(messages).toEqual([
      {
        type: 'append',
        id: expectedId(eventsDir),
        events: all.map(view),
        tickets: Object.values(fold.state.tickets).sort((a, b) => (a.id < b.id ? -1 : 1)),
        meta: fold.state.meta,
      },
    ]);
  });

  it('has meta null when no event is a board.meta', async () => {
    const { dir, eventsDir } = boardDir();
    const create = put(eventsDir, ev(P.create(T1), 'orch', 1000));
    const board = openTracked(dir);
    const [message] = await firstTick(board);
    expect(message).toEqual({
      type: 'append',
      id: `${create.hash}.${create.hash}`,
      events: [view(create)],
      tickets: [foldDir(eventsDir).state.tickets[T1]],
      meta: null,
    });
  });

  it('reads the event bodies through the given cache', async () => {
    const { dir, eventsDir } = boardDir();
    put(eventsDir, ev(P.create(T1), 'orch', 1000));
    put(eventsDir, ev(P.comment(T1, 'a'), 'impl', 2000));
    const board = openTracked(dir);
    const reader = countingReader();
    const cache = createEventCache(reader.read);
    await firstTick(board, { cache });
    expect(reader.count()).toBe(2);
    expect(cache.size).toBe(2);
    // A second feed sharing the cache reads nothing.
    await firstTick(board, { cache });
    expect(reader.count()).toBe(2);
  });
});

describe('watchBoard: append and resync (board-feed: "Append and resync messages")', () => {
  it(
    'scenario New event after the head: an append with the move and the moved ticket',
    { timeout: 10_000 },
    async () => {
      const { dir, eventsDir } = boardDir();
      put(eventsDir, ev(P.create(T1), 'orch', 1000));
      put(eventsDir, ev(P.create(T2, 'Other'), 'orch', 1100));
      put(eventsDir, ev(P.comment(T1, 'at 2000'), 'impl', 2000));
      const board = openTracked(dir);
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        const move = put(eventsDir, ev(P.move(T1, 'tests'), 'impl', 3000));
        await until(() => feed.messages.length === 2, 2000, 'the move');
        expect(feed.messages[1]).toEqual({
          type: 'append',
          id: expectedId(eventsDir),
          events: [view(move)],
          tickets: [foldDir(eventsDir).state.tickets[T1]],
          meta: null,
        });
        expect(feed.messages[1]?.id.startsWith(`${move.hash}.`)).toBe(true);
        // Quiet afterwards: nothing more.
        await pause(150);
        expect(feed.messages).toHaveLength(2);
        expect(feed.inTransaction()).toBe(false);
      } finally {
        await feed.stop();
      }
    },
  );

  it(
    'names each ticket once, ascending by id, and carries the meta for a board.meta',
    { timeout: 10_000 },
    async () => {
      const { dir, eventsDir } = boardDir();
      put(eventsDir, ev(P.create(T2, 'Second'), 'orch', 1000));
      put(eventsDir, ev(P.create(T1), 'orch', 1100));
      const board = openTracked(dir);
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        const events = [
          put(eventsDir, ev(P.comment(T2, 'x'), 'a', 3000)),
          put(eventsDir, ev(P.meta('columns', ['todo']), 'orch', 3001)),
          put(eventsDir, ev(P.comment(T1, 'y'), 'b', 3002)),
          put(eventsDir, ev(P.comment(T2, 'z'), 'c', 3003)),
        ];
        await until(
          () => feed.messages.flatMap((m) => (m.type === 'append' ? m.events : [])).length === 6,
          2000,
          'the four events',
        );
        const appended = feed.messages.slice(1);
        expect(appended.every((m) => m.type === 'append')).toBe(true);
        const fold = foldDir(eventsDir);
        const last = appended.at(-1);
        expect(last?.id).toBe(expectedId(eventsDir));
        // Written in one burst they may arrive in one or more appends; each
        // is in fold order and names its tickets once, ascending.
        const flat = appended.flatMap((m) => (m.type === 'append' ? m.events : []));
        expect(flat).toEqual(events.map(view));
        for (const m of appended) {
          if (m.type !== 'append') {
            continue;
          }
          const named = [
            ...new Set(m.events.flatMap((e) => (e.ticket === null ? [] : [e.ticket]))),
          ];
          expect(m.tickets.map((t) => t.id)).toEqual(named.sort());
          const hasMeta = m.events.some((e) => e.kind === 'board.meta');
          expect(m.meta).toEqual(hasMeta ? fold.state.meta : null);
        }
      } finally {
        await feed.stop();
      }
    },
  );

  it(
    'scenario Late event from sync: a resync listing it as late',
    { timeout: 10_000 },
    async () => {
      const { dir, eventsDir } = boardDir();
      put(eventsDir, ev(P.create(T1), 'orch', 1000));
      put(eventsDir, ev(P.comment(T1, 'at 2000'), 'impl', 2000));
      const board = openTracked(dir);
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        // Copied into events/ as sync would: behind the head.
        const late = put(eventsDir, ev(P.comment(T1, 'at 1500'), 'remote', 1500));
        await until(() => feed.messages.length === 2, 2000, 'the resync');
        expect(feed.messages[1]).toEqual({
          type: 'resync',
          id: expectedId(eventsDir),
          late: [view(late)],
          removed: [],
        });
        // The feed carries on: a new event after the head is an append.
        const next = put(eventsDir, ev(P.comment(T1, 'at 3000'), 'impl', 3000));
        await until(() => feed.messages.length === 3, 2000, 'the next append');
        expect(feed.messages[2]).toMatchObject({
          type: 'append',
          id: expectedId(eventsDir),
          events: [view(next)],
        });
      } finally {
        await feed.stop();
      }
    },
  );

  it(
    'scenario An event stops being effective: the claim race gives one late and one removed claim',
    { timeout: 10_000 },
    async () => {
      const { dir, eventsDir } = boardDir();
      put(eventsDir, ev(P.create(T1), 'orch', 1000));
      const byA = put(eventsDir, ev(P.claim(T1), 'a', 3000));
      const board = openTracked(dir);
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        expect(feed.messages[0]).toMatchObject({ type: 'append' });
        // An earlier claim by b arrives from another machine: it wins, and
        // a's claim is refolded as already-assigned.
        const byB = put(eventsDir, ev(P.claim(T1), 'b', 2000));
        await until(() => feed.messages.length === 2, 2000, 'the resync');
        expect(foldDir(eventsDir).rejected.map((r) => r.hash)).toEqual([byA.hash]);
        expect(feed.messages[1]).toEqual({
          type: 'resync',
          id: expectedId(eventsDir),
          late: [view(byB)],
          removed: [byA.hash],
        });
        expect(feed.messages[1]?.id.startsWith(`${byB.hash}.`)).toBe(true);
        // Afterwards the removed claim is no longer delivered, and a new
        // event is an append again.
        const next = put(eventsDir, ev(P.comment(T1, 'after'), 'b', 4000));
        await until(() => feed.messages.length === 3, 2000, 'the next append');
        expect(feed.messages[2]).toMatchObject({ type: 'append', events: [view(next)] });
      } finally {
        await feed.stop();
      }
    },
  );

  it(
    'lists a rejected event made effective by a late create as late',
    { timeout: 10_000 },
    async () => {
      const { dir, eventsDir } = boardDir();
      put(eventsDir, ev(P.create(T1), 'orch', 1000));
      put(eventsDir, ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR));
      const orphan = put(eventsDir, ev(P.comment(T2, 'orphan'), 'remote', 3 * HOUR));
      const board = openTracked(dir);
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        const created = put(eventsDir, ev(P.create(T2, 'Two'), 'remote', 2 * HOUR));
        await until(() => feed.messages.length === 2, 2000, 'the resync');
        expect(feed.messages[1]).toEqual({
          type: 'resync',
          id: expectedId(eventsDir),
          late: [view(created), view(orphan)],
          removed: [],
        });
      } finally {
        await feed.stop();
      }
    },
  );

  it('emits nothing for a new event that is not effective', { timeout: 10_000 }, async () => {
    const { dir, eventsDir } = boardDir();
    put(eventsDir, ev(P.create(T1), 'orch', 1000));
    const board = openTracked(dir);
    const feed = start(board);
    try {
      await until(() => feed.messages.length === 1, 2000, 'the first append');
      put(eventsDir, ev(P.comment(T2, 'no such ticket'), 'x', 5000));
      await pause(200);
      expect(feed.messages).toHaveLength(1);
    } finally {
      await feed.stop();
    }
  });

  it(
    'passes on events written through its own Board (same connection)',
    { timeout: 10_000 },
    async () => {
      const { board } = setup();
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        const ticket = create(board);
        const c = commentTicket(board, 'impl', { id: ticket.id, text: 'same handle' });
        await until(() => appended(feed.messages).includes(c.hash ?? ''), 1000, 'the comment');
        expect(appended(feed.messages)).toHaveLength(2);
        expect(feed.messages.every((m) => m.type === 'append')).toBe(true);
        expect(feed.messages.at(-1)?.id).toBe(expectedId(board.eventsDir));
      } finally {
        await feed.stop();
      }
    },
  );
});

describe('watchBoard: bounded work and no cursor (board-feed: "Board-wide change feed")', () => {
  it(
    'scenario Idle ticks read nothing: no event file is read while nothing is written',
    { timeout: 10_000 },
    async () => {
      const { board, root } = setup();
      const ticket = create(board);
      commentTicket(board, 'impl', { id: ticket.id, text: 'a' });
      commentTicket(board, 'impl', { id: ticket.id, text: 'b' });
      // A cache that keeps nothing, so every event file the feed asks for
      // is read and counted, even one it asked for before.
      const reader = countingReader();
      const feed = start(board, { cache: forgetfulCache(reader.read) });
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        expect(reader.count()).toBe(3);
        // Many polls with nothing new: no event file is read.
        await pause(250);
        expect(reader.count()).toBe(3);
        expect(feed.messages).toHaveLength(1);
        // One new event from another connection: one file read.
        const writer = openTracked(join(root, '.board'));
        const c = commentTicket(writer, 'impl', { id: ticket.id, text: 'new' });
        await until(() => appended(feed.messages).includes(c.hash ?? ''), 2000, 'the new comment');
        await pause(150);
        expect(reader.count()).toBe(4);
        expect(feed.messages).toHaveLength(2);
      } finally {
        await feed.stop();
      }
    },
  );

  it(
    'scenario Event written by another process (in process): no cursor row changes and no event is written',
    { timeout: 10_000 },
    async () => {
      const { board, root } = setup();
      const ticket = create(board);
      commentTicket(board, 'impl', { id: ticket.id, text: 'a' });
      // Two actors have stored cursors; a third has none.
      readInbox(board, 'orch');
      readInbox(board, 'impl');
      const rows = (): unknown => ({
        cursors: board.db.prepare('SELECT * FROM cursors ORDER BY actor').all(),
        seen: board.db.prepare('SELECT * FROM cursor_seen ORDER BY actor, hash').all(),
      });
      const before = rows();
      expect((before as { cursors: unknown[] }).cursors).toHaveLength(2);
      const files = eventNames(board.eventsDir).length;
      const feed = start(board);
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        const writer = openTracked(join(root, '.board'));
        const c = commentTicket(writer, 'rev', { id: ticket.id, text: 'hi' });
        const m = moveTicket(writer, 'orch', { id: ticket.id, to: 'tests' });
        await until(() => appended(feed.messages).includes(m.hash ?? ''), 2000, 'the move');
        expect(appended(feed.messages)).toContain(c.hash ?? '');
        // A resumed feed does not touch cursors either.
        await firstTick(board, { since: feed.messages[0]?.id ?? '' });
        await firstTick(board, { since: 'garbage' });
      } finally {
        await feed.stop();
      }
      expect(rows()).toEqual(before);
      expect(eventNames(board.eventsDir)).toHaveLength(files + 2);
    },
  );

  it(
    'scenario Digest is order independent: the same effective set folded from files in another order gives the same id',
    { timeout: 15_000 },
    async () => {
      const events = [
        ev(P.create(T1), 'orch', 1000),
        ev(P.comment(T1, 'two'), 'impl', 2000),
        ev(P.claim(T1), 'a', 3000),
        ev(P.claim(T1), 'b', 2500),
        ev(P.create(T2, 'Two'), 'orch', 2600),
        ev(P.comment(T2, 'late'), 'x', 2700),
        ev(P.comment(T1, 'four'), 'impl', 4000),
      ];
      // Board A: every file present before the feed starts.
      const a = boardDir();
      for (const event of events) {
        putEvent(a.eventsDir, event);
      }
      const [first] = await firstTick(openTracked(a.dir));
      expect(first?.id).toBe(expectedId(a.eventsDir));
      // Board B: the files arrive one by one, in another order, while a
      // feed runs (appends and resyncs, including the claim swap).
      const b = boardDir();
      const feed = start(openTracked(b.dir));
      try {
        await until(() => feed.messages.length === 1, 2000, 'the empty append');
        for (const index of [6, 2, 0, 5, 1, 4, 3]) {
          const event = events[index];
          if (event !== undefined) {
            putEvent(b.eventsDir, event);
          }
          await pause(60);
        }
        await until(() => feed.messages.at(-1)?.id === first?.id, 3000, 'the same id');
      } finally {
        await feed.stop();
      }
      // And a feed started afresh on B agrees.
      const [again] = await firstTick(openTracked(b.dir));
      expect(again?.id).toBe(first?.id);
    },
  );
});

describe('watchBoard: tick failures', () => {
  it(
    'reports a failing tick through onProblem, keeps its state and retries at the next tick',
    { timeout: 10_000 },
    async () => {
      const { dir, eventsDir } = boardDir();
      put(eventsDir, ev(P.create(T1), 'orch', 1000));
      const board = openTracked(dir);
      let failNext = false;
      const boom = new Error('read failed once');
      const cache = createEventCache((d, name) => {
        if (failNext) {
          failNext = false;
          throw boom;
        }
        return readEventFile(d, name);
      });
      const problems: unknown[] = [];
      const feed = start(board, { cache, onProblem: (error) => problems.push(error) });
      const settled = { done: false };
      void feed.done.finally(() => {
        settled.done = true;
      });
      try {
        await until(() => feed.messages.length === 1, 2000, 'the first append');
        failNext = true;
        const c = put(eventsDir, ev(P.comment(T1, 'x'), 'impl', 2000));
        await until(() => feed.messages.length === 2, 2000, 'the retried append');
        expect(problems).toEqual([boom]);
        expect(feed.messages[1]).toMatchObject({ type: 'append', events: [view(c)] });
        await pause(100);
        expect(feed.messages).toHaveLength(2);
        expect(settled.done).toBe(false);
      } finally {
        await feed.stop();
      }
    },
  );

  it(
    'without onProblem, rejects after cleanup when a tick fails',
    { timeout: 10_000 },
    async () => {
      const { board } = setup();
      create(board);
      const controller = new AbortController();
      let calls = 0;
      const done = watchBoard(board, {
        signal: controller.signal,
        pollMs: 20,
        fsWatch: false,
        onMessage: () => {
          calls += 1;
          // The next tick reads through a closed connection and throws.
          board.close();
        },
      });
      try {
        await expect(done).rejects.toThrow(/not open/i);
        expect(calls).toBe(1);
        await pause(150);
        expect(calls).toBe(1);
      } finally {
        controller.abort();
      }
    },
  );
});

describe('watchBoard: resume from a position id (board-feed: "Resume from a position id")', () => {
  /** A board with a ticket and one comment, and the id a consumer last received. */
  async function resumable(): Promise<{
    board: Board;
    eventsDir: string;
    id: string;
  }> {
    const { dir, eventsDir } = boardDir();
    put(eventsDir, ev(P.create(T1), 'orch', 1000));
    put(eventsDir, ev(P.comment(T1, 'at 2000'), 'impl', 2000));
    const board = openTracked(dir);
    const [first] = await firstTick(board);
    return { board, eventsDir, id: first?.id ?? '' };
  }

  it('scenario Resume after missed appends: one append of exactly the missed events', async () => {
    const { board, eventsDir, id } = await resumable();
    const one = put(eventsDir, ev(P.comment(T1, 'missed 1'), 'impl', 3000));
    const two = put(eventsDir, ev(P.comment(T1, 'missed 2'), 'rev', 4000));
    expect(await firstTick(board, { since: id })).toEqual([
      {
        type: 'append',
        id: expectedId(eventsDir),
        events: [view(one), view(two)],
        tickets: [foldDir(eventsDir).state.tickets[T1]],
        meta: null,
      },
    ]);
  });

  it('emits nothing when nothing was missed', async () => {
    const { board, id } = await resumable();
    expect(await firstTick(board, { since: id })).toEqual([]);
  });

  it(
    'after resuming, carries on with appends and never repeats an event',
    { timeout: 10_000 },
    async () => {
      const { board, eventsDir, id } = await resumable();
      const missed = put(eventsDir, ev(P.comment(T1, 'missed'), 'impl', 3000));
      const feed = start(board, { since: id });
      try {
        await until(() => feed.messages.length === 1, 2000, 'the resumed append');
        const next = put(eventsDir, ev(P.comment(T1, 'next'), 'impl', 4000));
        await until(() => feed.messages.length === 2, 2000, 'the next append');
        expect(appended(feed.messages)).toEqual([missed.hash, next.hash]);
      } finally {
        await feed.stop();
      }
    },
  );

  it('scenario Late arrival while disconnected: a resync', async () => {
    const { board, eventsDir, id } = await resumable();
    put(eventsDir, ev(P.comment(T1, 'late'), 'remote', 1500));
    const messages = await firstTick(board, { since: id });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'resync', id: expectedId(eventsDir) });
  });

  it('a late arrival plus an append while disconnected is still a resync', async () => {
    const { board, eventsDir, id } = await resumable();
    put(eventsDir, ev(P.comment(T1, 'late'), 'remote', 1500));
    put(eventsDir, ev(P.comment(T1, 'new'), 'impl', 3000));
    const messages = await firstTick(board, { since: id });
    expect(messages.map((m) => m.type)).toEqual(['resync']);
  });

  it('a claim swapped while disconnected (same count of effective events) is a resync', async () => {
    const { dir, eventsDir } = boardDir();
    put(eventsDir, ev(P.create(T1), 'orch', 1000));
    put(eventsDir, ev(P.comment(T1, 'c'), 'impl', 2000));
    put(eventsDir, ev(P.claim(T1), 'a', 3000));
    put(eventsDir, ev(P.comment(T1, 'd'), 'impl', 4000));
    const board = openTracked(dir);
    const [first] = await firstTick(board);
    // b's earlier claim wins; the head (the comment at 4000) is unchanged
    // and the number of effective events up to it is unchanged too.
    put(eventsDir, ev(P.claim(T1), 'b', 2500));
    const messages = await firstTick(board, { since: first?.id ?? '' });
    expect(first?.id.split('.')[0]).toBe(messages[0]?.id.split('.')[0]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'resync', id: expectedId(eventsDir) });
  });

  it('a head that is no longer effective is a resync', async () => {
    const { dir, eventsDir } = boardDir();
    put(eventsDir, ev(P.create(T1), 'orch', 1000));
    put(eventsDir, ev(P.claim(T1), 'a', 3000));
    const board = openTracked(dir);
    const [first] = await firstTick(board);
    put(eventsDir, ev(P.claim(T1), 'b', 2000));
    const messages = await firstTick(board, { since: first?.id ?? '' });
    expect(messages.map((m) => m.type)).toEqual(['resync']);
  });

  it('scenario Unparsable id: garbage gives a resync, never an error', async () => {
    const { board, eventsDir } = await resumable();
    expect(await firstTick(board, { since: 'garbage' })).toEqual([
      { type: 'resync', id: expectedId(eventsDir), late: [], removed: [] },
    ]);
  });

  it.each([
    ['an empty id', (): string => ''],
    ['an upper-case id', (id: string) => id.toUpperCase()],
    ['an id with a trailing newline', (id: string) => `${id}\n`],
    ['an unknown head', (id: string) => `${'c'.repeat(64)}.${id.split('.')[1] ?? ''}`],
    ['a wrong digest', (id: string) => `${id.split('.')[0] ?? ''}.${'1'.repeat(64)}`],
    [
      'the empty digest on a known head',
      (id: string) => `${id.split('.')[0] ?? ''}.${EMPTY_DIGEST}`,
    ],
    ['none with a digest that is not zero', (): string => `none.${'1'.repeat(64)}`],
  ])('%s gives a resync', async (_name, mangle) => {
    const { board, id } = await resumable();
    const messages = await firstTick(board, { since: mangle(id) });
    expect(messages.map((m) => m.type)).toEqual(['resync']);
  });

  it('a resync on resume is followed by appends as usual', { timeout: 10_000 }, async () => {
    const { board, eventsDir } = await resumable();
    const feed = start(board, { since: 'garbage' });
    try {
      await until(() => feed.messages.length === 1, 2000, 'the resync');
      const next = put(eventsDir, ev(P.comment(T1, 'next'), 'impl', 3000));
      await until(() => feed.messages.length === 2, 2000, 'the append');
      expect(feed.messages[1]).toMatchObject({ type: 'append', events: [view(next)] });
    } finally {
      await feed.stop();
    }
  });

  it('the empty-board id resumes as the position before every event', async () => {
    const { board, eventsDir } = await resumable();
    const all = effective(eventsDir);
    expect(await firstTick(board, { since: EMPTY_POSITION_ID })).toEqual([
      {
        type: 'append',
        id: expectedId(eventsDir),
        events: all.map(view),
        tickets: [foldDir(eventsDir).state.tickets[T1]],
        meta: null,
      },
    ]);
    const empty = setup().board;
    expect(await firstTick(empty, { since: EMPTY_POSITION_ID })).toEqual([]);
  });
});
