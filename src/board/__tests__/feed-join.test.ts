/**
 * Joining a running board feed (board-feed: "Joining a running feed";
 * add-board-web task 3.3, round 2 after the security review, finding B1):
 * `joinBoardFeed` compares the joiner's position with the board, not with
 * what the feed has delivered, by first bringing the feed up to date in
 * the same turn.
 *
 * The feed runs with timers that never fire on their own and without
 * `fs.watch`, so it examines only at start, at a join, and when the test
 * fires its poll by hand: "before the feed's next tick" is exact, not a
 * race.
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Board } from '../../store/board.js';
import type { AppendMessage, FeedMessage } from '../../view/types.js';
import { commentTicket } from '../actions.js';
import { EMPTY_POSITION_ID, joinBoardFeed, watchBoard, type WatchBoardOptions } from '../feed.js';
import { loadSnapshot } from '../snapshot.js';
import type { TickerTimers } from '../ticker.js';
import { create, openTracked, setup } from './helpers.js';

/** Ticker timers that fire only when `fire()` is called. */
function frozenTimers(): TickerTimers & { fire(): void } {
  let next = 0;
  const pending = new Map<number, () => void>();
  const add = (callback: () => void): number => {
    next += 1;
    pending.set(next, callback);
    return next;
  };
  return {
    setInterval: (callback) => add(callback),
    setTimeout: (callback) => add(callback),
    clearInterval: (handle) => {
      pending.delete(handle as number);
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
    fire: () => {
      for (const callback of [...pending.values()]) {
        callback();
      }
    },
  };
}

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

/** A running feed on a board with one ticket, a writer on the same board, and the feed's options. */
function running(): {
  board: Board;
  writer: Board;
  ticket: string;
  options: WatchBoardOptions;
  messages: FeedMessage[];
  timers: ReturnType<typeof frozenTimers>;
} {
  const { board, root } = setup();
  const ticket = create(board).id;
  const writer = openTracked(join(root, '.board'));
  const timers = frozenTimers();
  const messages: FeedMessage[] = [];
  const controller = new AbortController();
  const options: WatchBoardOptions = {
    signal: controller.signal,
    fsWatch: false,
    timers,
    onMessage: (m) => {
      messages.push(m);
    },
  };
  const done = watchBoard(board, options);
  stops.push(async () => {
    controller.abort();
    await done;
  });
  return { board, writer, ticket, options, messages, timers };
}

/** The comment texts of an append. */
function texts(m: FeedMessage | null | undefined): string[] {
  expect(m?.type).toBe('append');
  return (m as AppendMessage).events.flatMap((e) => {
    const body = (e.event as { body?: { text?: unknown } }).body;
    return e.kind === 'ticket.comment' && typeof body?.text === 'string' ? [body.text] : [];
  });
}

/** Every event hash carried by `messages`. */
function hashes(messages: readonly FeedMessage[]): string[] {
  return messages.flatMap((m) => (m.type === 'append' ? m.events : m.late).map((e) => e.hash));
}

describe('joinBoardFeed', () => {
  it('starts after the feed first examined the board, with its first message delivered at once', () => {
    const { messages } = running();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe('append');
  });

  it(
    'scenario: Join from a snapshot ahead of the feed: nothing for the joiner, the append for the others',
    { timeout: 10_000 },
    () => {
      const { writer, ticket, options, messages, timers } = running();
      const written = commentTicket(writer, 'impl', { id: ticket, text: 'ahead' });
      // The feed has not ticked: a snapshot of the board already holds the comment.
      const snapshot = loadSnapshot(writer);
      expect(snapshot.head).toBe(written.hash);
      expect(messages).toHaveLength(1);

      const first = joinBoardFeed(options, snapshot.id);
      expect(first).toBeNull();
      // The join brought the feed up to date: the consumer already joined got the comment.
      expect(messages).toHaveLength(2);
      expect(texts(messages[1])).toEqual(['ahead']);
      expect(messages[1]?.id).toBe(snapshot.id);

      // The next tick finds nothing new, so nothing carries the comment again.
      timers.fire();
      expect(messages).toHaveLength(2);
      expect(hashes(messages).filter((h) => h === written.hash)).toHaveLength(1);
    },
  );

  it(
    'scenario: Join from an older snapshot: an append of exactly the two comments the feed had not examined',
    { timeout: 10_000 },
    () => {
      const { writer, ticket, options, messages } = running();
      const before = loadSnapshot(writer);
      expect(before.id).toBe(messages[0]?.id);
      commentTicket(writer, 'impl', { id: ticket, text: 'one' });
      commentTicket(writer, 'impl', { id: ticket, text: 'two' });

      const first = joinBoardFeed(options, before.id);
      expect(first?.type).toBe('append');
      expect(texts(first)).toEqual(['one', 'two']);
      expect((first as AppendMessage).events).toHaveLength(2);
      expect(first?.id).toBe(loadSnapshot(writer).id);
      // The consumers already joined got the same two comments, once.
      expect(messages).toHaveLength(2);
      expect(texts(messages[1])).toEqual(['one', 'two']);
    },
  );

  it('a join without a position gets every effective event, including an unexamined write', () => {
    const { writer, ticket, options, messages } = running();
    const written = commentTicket(writer, 'impl', { id: ticket, text: 'unexamined' });
    const first = joinBoardFeed(options);
    expect(first?.type).toBe('append');
    expect((first as AppendMessage).events.map((e) => e.hash)).toEqual(
      loadSnapshot(writer)
        .events.filter((e) => e.outcome === 'applied')
        .map((e) => e.hash),
    );
    expect(hashes([first as FeedMessage])).toContain(written.hash);
    expect(messages).toHaveLength(2);
  });

  it('a join with the current id and nothing new gets nothing and delivers nothing', () => {
    const { options, messages } = running();
    expect(joinBoardFeed(options, messages[0]?.id)).toBeNull();
    expect(messages).toHaveLength(1);
  });

  it('a join with an unparsable id still gets a resync of the current id', () => {
    const { writer, ticket, options } = running();
    commentTicket(writer, 'impl', { id: ticket, text: 'x' });
    expect(joinBoardFeed(options, 'garbage')).toEqual({
      type: 'resync',
      id: loadSnapshot(writer).id,
      late: [],
      removed: [],
    });
  });

  it('returns undefined for a feed that is not running', async () => {
    const { board } = setup();
    const controller = new AbortController();
    controller.abort();
    const options: WatchBoardOptions = { signal: controller.signal, onMessage: () => undefined };
    await watchBoard(board, options);
    expect(joinBoardFeed(options, EMPTY_POSITION_ID)).toBeUndefined();
  });
});
