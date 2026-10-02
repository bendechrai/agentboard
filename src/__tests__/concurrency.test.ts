/**
 * Real CLI processes racing on one board (board-concurrency: "Claim race has exactly one
 * winner", "Concurrent comments are never lost"; board-cache: "Cache
 * connection settings"), started together through the start gate of the
 * harness and checked against the CLI's own view (`show`, `rebuild --check`)
 * and against an independent fold of the event files built on the events
 * layer (`src/events`) only.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { Ticket } from '../events/fold.js';
import { compareHlc } from '../events/hlc.js';
import { canon, eventNames, foldDir } from '../store/__tests__/helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  runTogether,
  type ProcessResult,
} from './harness/processes.js';

const TASK = ['--task', 'openspec:add-board-core#4'];

/** Creates a ticket through the CLI and returns its id. */
async function newTicket(root: string, title: string): Promise<string> {
  const out = await runCliAsync(['new', title, ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

/** `show <id> --json` through the CLI. */
async function show(root: string, id: string): Promise<{ ticket: Ticket; events: number }> {
  const out = await runCliAsync(['show', id, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return oneDocument(out) as { ticket: Ticket; events: number };
}

/** No process reports a locked or busy database on stderr. */
function expectNoLockErrors(results: readonly ProcessResult[]): void {
  for (const result of results) {
    expect(result.stderr).not.toMatch(/database is locked|SQLITE_BUSY|\bbusy\b/i);
  }
}

describe('scenario: ten concurrent claims', () => {
  let root = '';
  let eventsDir = '';
  let id = '';
  let results: ProcessResult[] = [];
  const actors = Array.from({ length: 10 }, (_, n) => `agent-${String(n)}`);

  beforeAll(async () => {
    ({ root, eventsDir } = boardProject());
    id = await newTicket(root, 'Contested');
    ({ results } = await runTogether(
      actors.map((actor) => ({ argv: ['claim', id, '--as', actor, '--json'] })),
      root,
    ));
  }, 60_000);

  function winner(): string {
    const index = results.findIndex((r) => r.code === 0);
    return actors[index] ?? '';
  }

  it('exactly one process exits 0 and nine exit 4', () => {
    expect(results.map((r) => r.signal)).toEqual(actors.map(() => null));
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 4)).toHaveLength(9);
  });

  it('every loser reports already-assigned naming the winner', () => {
    const won = winner();
    for (const [n, result] of results.entries()) {
      if (result.code === 0) {
        expect(oneDocument(result)).toMatchObject({ ticket: { id, assignee: won } });
        expect(result.stderr).toBe('');
        continue;
      }
      expect(oneDocument(result), actors[n]).toMatchObject({
        error: { exitCode: 4, reason: 'already-assigned' },
      });
      const { message } = (oneDocument(result) as { error: { message: string } }).error;
      expect(message).toContain(won);
      expect(result.stderr).toContain(won);
    }
  });

  it('show reports the single winner as assignee', async () => {
    const shown = await show(root, id);
    expect(shown.ticket.assignee).toBe(winner());
    expect(shown.events).toBe(2);
  });

  it('writes one claim event: losers are refused before writing', () => {
    // create + the winning claim; validation under BEGIN IMMEDIATE refuses
    // the nine others without a file (board-cache: "Validation failure
    // writes nothing").
    expect(eventNames(eventsDir)).toHaveLength(2);
    const independent = foldDir(eventsDir);
    expect(independent.rejected).toEqual([]);
    expect(independent.state.tickets[id]?.assignee).toBe(winner());
  });

  it('rebuild --check reports no divergence', async () => {
    const out = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(oneDocument(out)).toMatchObject({ ok: true, differences: [] });
  });

  it('rebuild reports at most nine rejected claim events', async () => {
    const out = await runCliAsync(['rebuild', '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    const report = oneDocument(out) as {
      folded: number;
      rejected: number;
      rejectedEvents: { kind: string }[];
    };
    expect(report.rejected).toBeLessThanOrEqual(9);
    expect(report.rejectedEvents.every((r) => r.kind === 'ticket.claim')).toBe(true);
    expect(report.folded).toBe(2);
    expect((await show(root, id)).ticket.assignee).toBe(winner());
  });
});

describe('scenario: twenty concurrent comments', () => {
  let root = '';
  let eventsDir = '';
  let id = '';
  let results: ProcessResult[] = [];
  const texts = Array.from({ length: 20 }, (_, n) => `c${String(n)}`);

  beforeAll(async () => {
    ({ root, eventsDir } = boardProject());
    id = await newTicket(root, 'Chatty');
    ({ results } = await runTogether(
      texts.map((text, n) => ({
        argv: ['comment', id, '--as', `agent-${String(n)}`, text, '--json'],
      })),
      root,
    ));
  }, 60_000);

  it('every comment command succeeds without a locked-database error', () => {
    for (const result of results) {
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
    }
    expectNoLockErrors(results);
  });

  it('show lists all twenty comments, each by its own actor', async () => {
    const { ticket, events } = await show(root, id);
    expect(ticket.comments).toHaveLength(20);
    expect(events).toBe(21);
    expect(ticket.comments.map((c) => c.text).sort()).toEqual([...texts].sort());
    for (const comment of ticket.comments) {
      expect(comment.actor).toBe(`agent-${comment.text.slice(1)}`);
    }
  });

  it('lists the comments in fold order, the same as an independent fold', async () => {
    const { ticket } = await show(root, id);
    const ordered = [...ticket.comments].sort(
      (a, b) => compareHlc(a.ts, b.ts) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
    );
    expect(ticket.comments.map((c) => c.hash)).toEqual(ordered.map((c) => c.hash));
    // Hybrid timestamps are strictly increasing: each writer saw the
    // previous one's event under the write lock.
    for (let i = 1; i < ticket.comments.length; i += 1) {
      const prev = ticket.comments[i - 1];
      const cur = ticket.comments[i];
      if (prev !== undefined && cur !== undefined) {
        expect(compareHlc(prev.ts, cur.ts)).toBe(-1);
      }
    }
    const independent = foldDir(eventsDir).state.tickets[id];
    expect(canon(ticket)).toBe(canon(independent));
  });

  it('the order is deterministic: a cache rebuilt from scratch lists the same order', async () => {
    const before = (await show(root, id)).ticket.comments.map((c) => c.hash);
    const rebuilt = await runCliAsync(['rebuild'], root);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect((await show(root, id)).ticket.comments.map((c) => c.hash)).toEqual(before);
  });

  it('rebuild --check reports no divergence', async () => {
    const out = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(oneDocument(out)).toMatchObject({ ok: true, differences: [] });
  });
});

// The two ten-round tests start 20 and 200 CLI processes; they take 5 to 35
// seconds depending on load, and the 200-process one can exceed 40 seconds in
// the floor container on a heavily loaded machine. Each child is still
// bounded by the harness's own per-child timeout, so a hang still fails.
const TEN_ROUNDS_TIMEOUT_MS = 90_000;

describe('busy timeout: concurrent writers wait instead of failing', () => {
  it(
    'scenario: two writers started in the same millisecond both succeed (ten rounds)',
    { timeout: TEN_ROUNDS_TIMEOUT_MS },
    async () => {
      const { root, eventsDir } = boardProject();
      const id = await newTicket(root, 'Pairs');
      for (let round = 0; round < 10; round += 1) {
        const { results } = await runTogether(
          ['left', 'right'].map((side) => ({
            argv: ['comment', id, `${side}-${String(round)}`, '--as', side],
          })),
          root,
        );
        for (const result of results) {
          expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
        }
        expectNoLockErrors(results);
      }
      expect(eventNames(eventsDir)).toHaveLength(21);
      expect((await show(root, id)).ticket.comments).toHaveLength(20);
    },
  );

  it(
    'twenty processes opening a board with no cache yet all succeed (ten rounds)',
    { timeout: TEN_ROUNDS_TIMEOUT_MS },
    async () => {
      // The first open creates cache.sqlite and switches it to WAL; racing
      // first opens must wait for each other like any other writers
      // (board-cache: "Cache is derived and disposable", "Cache connection
      // settings").
      const { root, boardDir } = boardProject();
      const id = await newTicket(root, 'Reopened');
      for (let round = 0; round < 10; round += 1) {
        for (const name of ['cache.sqlite', 'cache.sqlite-wal', 'cache.sqlite-shm']) {
          rmSync(join(boardDir, name), { force: true });
        }
        const { results } = await runTogether(
          Array.from({ length: 20 }, (_, n) =>
            n % 2 === 0
              ? { argv: ['list', '--json'] }
              : { argv: ['comment', id, `r${String(round)}-${String(n)}`, '--as', 'w'] },
          ),
          root,
        );
        for (const result of results) {
          expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
        }
        expectNoLockErrors(results);
      }
      expect((await show(root, id)).ticket.comments).toHaveLength(100);
    },
  );

  it(
    'twenty writers started together all succeed, each creating its ticket',
    { timeout: 40_000 },
    async () => {
      const { root, eventsDir } = boardProject();
      const titles = Array.from({ length: 20 }, (_, n) => `ticket ${String(n)}`);
      const { results } = await runTogether(
        titles.map((title, n) => ({
          argv: ['new', title, ...TASK, '--as', `writer-${String(n)}`, '--json'],
        })),
        root,
      );
      for (const result of results) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
      }
      expectNoLockErrors(results);
      expect(eventNames(eventsDir)).toHaveLength(20);
      const listed = await runCliAsync(['list', '--json'], root);
      expect(listed.code).toBe(0);
      const tickets = oneDocument(listed) as { title: string }[];
      expect(tickets.map((t) => t.title).sort()).toEqual([...titles].sort());
    },
  );
});
