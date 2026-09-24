/**
 * The board feed against real CLI processes (board-feed: "Board-wide
 * change feed" scenario "Event written by another process", "The feed
 * never blocks writers" scenario "Stalled consumer"; add-board-web task
 * 2.2). Runs the built CLI through the multi-process harness; run
 * `npm run build` first when running vitest directly.
 */

import { describe, expect, it } from 'vitest';

import { watchBoard } from '../board/feed.js';
import { openBoard, type Board } from '../store/board.js';
import { BUSY_TIMEOUT_MS } from '../store/cache.js';
import type { FeedMessage } from '../view/types.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  startGated,
  type ProcessResult,
} from './harness/processes.js';

const TASK = ['--task', 'openspec:add-board-web#2'];

/** Creates a ticket through the CLI and returns its id. */
async function newTicket(root: string): Promise<string> {
  const out = await runCliAsync(['new', 'Watched', ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(ms)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The comment texts delivered by the appends among `messages`. */
function commentTexts(messages: readonly FeedMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.type !== 'append') {
      continue;
    }
    for (const e of m.events) {
      if (e.event.kind === 'ticket.comment' && 'body' in e.event) {
        const body = e.event.body as { text?: unknown };
        if (typeof body.text === 'string') {
          out.push(body.text);
        }
      }
    }
  }
  return out;
}

function cursorRows(board: Board): unknown {
  return {
    cursors: board.db.prepare('SELECT * FROM cursors ORDER BY actor').all(),
    seen: board.db.prepare('SELECT * FROM cursor_seen ORDER BY actor, hash').all(),
  };
}

describe('scenario: Event written by another process', () => {
  it(
    'reports a comment written by a CLI process within 3 seconds, with no cursor changed',
    { timeout: 30_000 },
    async () => {
      const { root, boardDir } = boardProject();
      const id = await newTicket(root);
      // An actor with a stored cursor, acknowledged through the CLI.
      const inbox = await runCliAsync(['inbox', '--as', 'orch', '--json'], root);
      expect(inbox.code, inbox.stderr).toBe(0);
      const board = openBoard(boardDir);
      const before = cursorRows(board);
      expect((before as { cursors: unknown[] }).cursors).toHaveLength(1);
      const messages: FeedMessage[] = [];
      const controller = new AbortController();
      // Default timing: fs.watch with the settle delay, and 2 s polling.
      const done = watchBoard(board, {
        signal: controller.signal,
        onMessage: (m) => messages.push(m),
      });
      try {
        await until(() => messages.length === 1, 3000, 'the first append');
        const out = await runCliAsync(['comment', id, '--as', 'impl', 'hi', '--json'], root);
        expect(out.code, out.stderr).toBe(0);
        const written = Date.now();
        await until(() => commentTexts(messages).includes('hi'), 3000, 'the comment');
        expect(Date.now() - written).toBeLessThan(3000);
        const last = messages.at(-1);
        expect(last?.type).toBe('append');
        if (last?.type === 'append') {
          expect(last.events.map((e) => [e.kind, e.actor])).toEqual([['ticket.comment', 'impl']]);
          expect(last.tickets.map((t) => [t.id, t.comments.length])).toEqual([[id, 1]]);
        }
      } finally {
        controller.abort();
        await done;
      }
      expect(cursorRows(board)).toEqual(before);
      board.close();
    },
  );
});

describe('scenario: Stalled consumer', () => {
  it(
    'twenty concurrent comment processes all exit 0 while the consumer callback blocks',
    { timeout: 90_000 },
    async () => {
      const { root, boardDir } = boardProject();
      const id = await newTicket(root);
      const texts = Array.from({ length: 20 }, (_, n) => `c${String(n)}`);
      const gated = await startGated(
        texts.map((text, n) => ({
          argv: ['comment', id, '--as', `agent-${String(n)}`, text, '--json'],
        })),
        root,
      );
      const board = openBoard(boardDir);
      const messages: FeedMessage[] = [];
      const inTransaction: boolean[] = [];
      const controller = new AbortController();
      // Longer than a writer can wait for the lock (the busy timeout, and
      // one retry of BEGIN IMMEDIATE), so a feed holding a lock while its
      // consumer blocks would make the writers fail.
      const blockMs = 2 * BUSY_TIMEOUT_MS + 1000;
      let blocked = false;
      const done = watchBoard(board, {
        signal: controller.signal,
        pollMs: 50,
        onMessage: (m) => {
          inTransaction.push(board.db.isTransaction);
          messages.push(m);
          if (!blocked) {
            blocked = true;
            gated.open();
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
          }
        },
      });
      try {
        const results: ProcessResult[] = await Promise.all(gated.procs.map((p) => p.exited));
        expect(results).toHaveLength(20);
        for (const result of results) {
          expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
        }
        // The feed carries on after the consumer resumes: every comment arrives.
        await until(() => commentTexts(messages).length === 20, 10_000, 'the twenty comments');
        expect([...commentTexts(messages)].sort()).toEqual([...texts].sort());
        expect(inTransaction.every((x) => !x)).toBe(true);
      } finally {
        controller.abort();
        await done;
        board.close();
      }
    },
  );
});
