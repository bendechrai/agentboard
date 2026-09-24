/**
 * `watchInbox` (board-cli: `watch`; design.md: "`watch`"). Task group 5.2.
 * In-process tests of the library function; the child-process test of the
 * built CLI is `src/cli/__tests__/watch-spawn.test.ts`.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openCache } from '../../store/cache.js';
import { readCursor } from '../../store/cursors.js';
import { readEventFile, type ReadOutcome } from '../../store/eventfile.js';
import { P, T1, T2, ev } from '../../store/__tests__/helpers.js';
import { commentTicket } from '../actions.js';
import { readInbox, type InboxEntry } from '../inbox.js';
import { WATCH_POLL_MS, watchInbox } from '../watch.js';
import { create, makeBoardDir, openTracked, putEvent, setup, tempDir } from './helpers.js';

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
    let calls = 0;
    const done = watchInbox(board, 'orch', {
      signal: controller.signal,
      pollMs: 20,
      fsWatch: false,
      onEntries: () => {
        calls += 1;
        // The next tick reads through a closed connection and throws.
        board.close();
      },
    });
    try {
      // It rejects on its own, without the signal, with the tick's error.
      await expect(done).rejects.toThrow(/not open/i);
      // The first tick ran and passed the pending entry on before the failure.
      expect(calls).toBe(1);
      // Cleanup: the timer is cleared, so nothing runs any more.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls).toBe(1);
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

const HOUR = 3_600_000;

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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchInbox bounds the work of each tick (round 2)', () => {
  it(
    'reads one file per pending entry at first, none on a tick with nothing new, one per new event',
    { timeout: 10_000 },
    async () => {
      const { board, root } = setup();
      const ticket = create(board);
      commentTicket(board, 'impl', { id: ticket.id, text: 'a' });
      commentTicket(board, 'impl', { id: ticket.id, text: 'b' });
      const reader = countingReader();
      const seen: InboxEntry[] = [];
      const controller = new AbortController();
      const done = watchInbox(board, 'orch', {
        signal: controller.signal,
        pollMs: 20,
        fsWatch: false,
        readEventFile: reader.read,
        onEntries: (entries) => seen.push(...entries),
      });
      try {
        await until(() => seen.length === 3, 2000, 'the pending entries');
        expect(reader.count()).toBe(3);
        // Many ticks with nothing new: no event file is read.
        await pause(200);
        expect(reader.count()).toBe(3);
        const writer = openTracked(join(root, '.board'));
        const c = commentTicket(writer, 'impl', { id: ticket.id, text: 'new' });
        await until(() => seen.some((e) => e.hash === c.hash), 2000, 'the new comment');
        await pause(200);
        expect(reader.count()).toBe(4);
        expect(seen).toHaveLength(4);
      } finally {
        controller.abort();
        await done;
      }
      expect(readCursor(board.db, 'orch').position).toBeNull();
    },
  );

  it(
    'still passes on a late event older than the window behind its bookmark',
    { timeout: 10_000 },
    async () => {
      const dir = makeBoardDir(tempDir());
      const eventsDir = join(dir, 'events');
      putEvent(eventsDir, ev(P.create(T1), 'orch', 1000));
      putEvent(eventsDir, ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR));
      const board = openTracked(dir);
      const seen: InboxEntry[] = [];
      const controller = new AbortController();
      const done = watchInbox(board, 'orch', {
        signal: controller.signal,
        pollMs: 20,
        fsWatch: false,
        onEntries: (entries) => seen.push(...entries),
      });
      try {
        await until(() => seen.length === 2, 2000, 'the pending entries');
        const late = putEvent(eventsDir, ev(P.comment(T1, 'at 2h'), 'remote', 2 * HOUR));
        await until(() => seen.some((e) => e.hash === late), 2000, 'the late comment');
        await pause(100);
        expect(seen).toHaveLength(3);
      } finally {
        controller.abort();
        await done;
      }
    },
  );

  it(
    'passes on an old rejected event that a late event made effective',
    { timeout: 10_000 },
    async () => {
      const dir = makeBoardDir(tempDir());
      const eventsDir = join(dir, 'events');
      putEvent(eventsDir, ev(P.create(T1), 'orch', 1000));
      putEvent(eventsDir, ev(P.comment(T1, 'at 10h'), 'impl', 10 * HOUR));
      // Rejected as unknown-ticket until T2's create arrives.
      const orphan = putEvent(eventsDir, ev(P.comment(T2, 'orphan'), 'remote', 3 * HOUR));
      const board = openTracked(dir);
      const seen: InboxEntry[] = [];
      const controller = new AbortController();
      const done = watchInbox(board, 'orch', {
        signal: controller.signal,
        pollMs: 20,
        fsWatch: false,
        onEntries: (entries) => seen.push(...entries),
      });
      try {
        await until(() => seen.length === 2, 2000, 'the pending entries');
        const created = putEvent(eventsDir, ev(P.create(T2), 'remote', 2 * HOUR));
        await until(() => seen.length === 4, 2000, 'the create and the orphan');
        expect(seen.slice(2).map((e) => e.hash)).toEqual([created, orphan]);
      } finally {
        controller.abort();
        await done;
      }
    },
  );
});

describe('watchInbox and a busy cache (round 2)', () => {
  it(
    'warns and carries on after a tick that finds the cache busy',
    { timeout: 20_000 },
    async () => {
      const { board, root } = setup();
      const ticket = create(board);
      // Keep the busy wait short for this test.
      board.db.exec('PRAGMA busy_timeout = 50');
      const seen: InboxEntry[] = [];
      const warnings: string[] = [];
      const controller = new AbortController();
      let settled = false;
      const done = watchInbox(board, 'orch', {
        signal: controller.signal,
        pollMs: 30,
        fsWatch: false,
        onEntries: (entries) => seen.push(...entries),
        onWarning: (line) => warnings.push(line),
      }).finally(() => {
        settled = true;
      });
      const locker = openCache(join(root, '.board', 'cache.sqlite'));
      try {
        await until(() => seen.length === 1, 2000, 'the pending entry');
        // Another process holds the write lock while a new event file appears,
        // so the watch's catch-up cannot fold it.
        locker.exec('BEGIN IMMEDIATE');
        const late = putEvent(
          join(root, '.board', 'events'),
          ev(P.comment(ticket.id, 'while locked'), 'remote', Date.now()),
        );
        await until(() => warnings.length > 0, 5000, 'a busy warning');
        expect(warnings[0]).toMatch(/locked/);
        expect(warnings[0]).not.toContain('\n');
        expect(settled).toBe(false);
        locker.exec('COMMIT');
        await until(() => seen.some((e) => e.hash === late), 5000, 'the event after the lock');
        expect(settled).toBe(false);
      } finally {
        if (locker.isTransaction) {
          locker.exec('ROLLBACK');
        }
        locker.close();
        controller.abort();
        await done;
      }
    },
  );
});
