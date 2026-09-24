/**
 * `watchInbox` (board-cli: `watch`; design.md: "`watch`"). Task group 5.2.
 * In-process tests of the library function; the child-process test of the
 * built CLI is `src/cli/__tests__/watch-spawn.test.ts`.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readCursor } from '../../store/cursors.js';
import { commentTicket } from '../actions.js';
import { readInbox, type InboxEntry } from '../inbox.js';
import { WATCH_POLL_MS, watchInbox } from '../watch.js';
import { create, openTracked, setup } from './helpers.js';

/** Resolves when `check` returns true, polling every 10 ms; rejects after `ms`. */
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('WATCH_POLL_MS', () => {
  it('is the 2 second polling fallback of the design', () => {
    expect(WATCH_POLL_MS).toBe(2000);
  });
});

describe('watchInbox', () => {
  it('passes on the pending entries at once, even when already stopped, and resolves', async () => {
    const { board } = setup();
    const ticket = create(board);
    commentTicket(board, 'impl', { id: ticket.id, text: 'x' });
    const calls: (readonly InboxEntry[])[] = [];
    await watchInbox(board, 'orch', {
      signal: aborted(),
      onEntries: (entries) => calls.push(entries),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(readInbox(board, 'orch', { peek: true }).entries);
  });

  it('never calls onEntries with nothing', async () => {
    const { board } = setup();
    let called = 0;
    await watchInbox(board, 'orch', {
      signal: aborted(),
      onEntries: () => {
        called += 1;
      },
    });
    expect(called).toBe(0);
  });

  it('does not advance the cursor', async () => {
    const { board } = setup();
    create(board);
    await watchInbox(board, 'orch', { signal: aborted(), onEntries: () => undefined });
    expect(readCursor(board.db, 'orch')).toEqual({ actor: 'orch', position: null, seen: [] });
    expect(readInbox(board, 'orch').entries).toHaveLength(1);
  });

  it(
    'passes on an event written through another connection, once, by polling alone',
    { timeout: 10_000 },
    async () => {
      const { board, root } = setup();
      const ticket = create(board);
      const seen: InboxEntry[] = [];
      const controller = new AbortController();
      const done = watchInbox(board, 'orch', {
        signal: controller.signal,
        pollMs: 50,
        fsWatch: false,
        onEntries: (entries) => seen.push(...entries),
      });
      try {
        await until(() => seen.length === 1, 2000, 'the initial entry');
        const writer = openTracked(join(root, '.board'));
        const c = commentTicket(writer, 'impl', { id: ticket.id, text: 'hello' });
        await until(() => seen.some((e) => e.hash === c.hash), 2000, 'the new comment');
        // A few more polls pass nothing new.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(seen.map((e) => e.kind)).toEqual(['ticket.create', 'ticket.comment']);
      } finally {
        controller.abort();
        await done;
      }
      expect(readCursor(board.db, 'orch').position).toBeNull();
    },
  );

  it('wakes up on fs.watch well before the polling interval', { timeout: 10_000 }, async () => {
    const { board, root } = setup();
    const ticket = create(board);
    const seen: InboxEntry[] = [];
    const controller = new AbortController();
    const done = watchInbox(board, 'orch', {
      signal: controller.signal,
      pollMs: 60_000,
      onEntries: (entries) => seen.push(...entries),
    });
    try {
      await until(() => seen.length === 1, 2000, 'the initial entry');
      // Give the watcher a moment to be registered.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const writer = openTracked(join(root, '.board'));
      const c = commentTicket(writer, 'impl', { id: ticket.id, text: 'hello' });
      await until(() => seen.some((e) => e.hash === c.hash), 3000, 'the new comment');
    } finally {
      controller.abort();
      await done;
    }
  });

  it('stops passing on entries once aborted', { timeout: 10_000 }, async () => {
    const { board, root } = setup();
    const ticket = create(board);
    const seen: InboxEntry[] = [];
    const controller = new AbortController();
    const done = watchInbox(board, 'orch', {
      signal: controller.signal,
      pollMs: 20,
      fsWatch: false,
      onEntries: (entries) => seen.push(...entries),
    });
    await until(() => seen.length === 1, 2000, 'the initial entry');
    controller.abort();
    await done;
    const writer = openTracked(join(root, '.board'));
    commentTicket(writer, 'impl', { id: ticket.id, text: 'after the end' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toHaveLength(1);
  });

  it('rejects, after cleanup, when a tick fails', { timeout: 10_000 }, async () => {
    const { board } = setup();
    create(board);
    const controller = new AbortController();
    let first = true;
    const done = watchInbox(board, 'orch', {
      signal: controller.signal,
      pollMs: 20,
      fsWatch: false,
      onEntries: () => {
        if (first) {
          first = false;
          // The next tick reads through a closed connection and throws.
          board.close();
        }
      },
    });
    try {
      await expect(done).rejects.toThrow();
    } finally {
      controller.abort();
    }
  });

  it('refuses an empty actor', async () => {
    const { board } = setup();
    await expect(
      watchInbox(board, '', { signal: aborted(), onEntries: () => undefined }),
    ).rejects.toMatchObject({ exitCode: 1, reason: 'missing-actor' });
  });
});
