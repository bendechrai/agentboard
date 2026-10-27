/**
 * `claim --wait --timeout` as a real process (add-claim-leases task 4.1;
 * board-cli: "Waiting on the command line", scenarios "Waiter is granted
 * on release", "Interrupted wait leaves the queue" and "Killed waiter
 * stays queued"; board-concurrency: "Crashed holder recovery through
 * lease expiry", scenario "Waiter killed while waiting").
 *
 * Every waiter is the built CLI (`dist/cli.js`) on the real clock. Each
 * test waits for the waiter's queued line on stdout before acting, which
 * the wait prints only after its join is written and its signal handlers
 * are in place, so nothing depends on how fast the child starts on a
 * loaded host. The holder's release runs in this process through the
 * library, and the one timed assertion (granted within 3 seconds of the
 * release) is measured from the moment that release returns. The lapse of
 * a dead waiter's grant is observed by a `show` whose clock runs ahead
 * through the harness's clock preload, not by sleeping.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { claimTicket, releaseTicket } from '../board/actions.js';
import type { Ticket } from '../events/fold.js';
import { openBoard, type Board } from '../store/board.js';
import { P, ev, putEvent } from '../store/__tests__/helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  scratchDir,
  startCli,
  type CliProcess,
} from './harness/processes.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const WINDOW = 120_000;
const SKEW = 60_000;

const PROCESSES = { timeout: 60_000 };

/** A board whose ticket T1 is held by `merger-1` (a plain claim a second ago). */
function seed(): { root: string; boardDir: string } {
  const { root, boardDir, eventsDir } = boardProject();
  const base = Date.now() - 1000;
  putEvent(eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', base - 1000));
  putEvent(eventsDir, ev(P.claim(T1), 'merger-1', base));
  return { root, boardDir };
}

/** Runs `fn` on a library handle of the board, closed afterwards. */
function withBoard<T>(boardDir: string, fn: (board: Board) => T): T {
  const board = openBoard(boardDir);
  try {
    return fn(board);
  } finally {
    board.close();
  }
}

/** Starts `claim T1 --as <actor> --ttl 30m --wait --timeout 10m [--json]`. */
function waiter(root: string, actor: string, json = false): CliProcess {
  const argv = ['claim', T1, '--as', actor, '--ttl', '30m', '--wait', '--timeout', '10m'];
  return startCli({ argv: json ? [...argv, '--json'] : argv }, root);
}

/** Resolves once the waiter has printed its queued line; fails if it exits first. */
async function queuedLine(proc: CliProcess): Promise<void> {
  const end = Date.now() + 30_000;
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  while (!/queued for |"queued":true/.test(proc.stdout())) {
    if (exited) {
      throw new Error(`waiter exited before queuing: ${proc.stdout()} ${proc.stderr()}`);
    }
    if (Date.now() > end) {
      throw new Error(`waiter never printed its queued line: ${proc.stderr()}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** `show T1 --json` in a child, its clock `offset` ms ahead. */
async function show(root: string, offset?: number): Promise<Ticket> {
  const out = await startCli(
    offset === undefined
      ? { argv: ['show', T1, '--json'] }
      : { argv: ['show', T1, '--json'], clockOffsetMs: offset },
    root,
  ).exited;
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: Ticket }).ticket;
}

describe('scenario: waiter is granted on release', PROCESSES, () => {
  it('exits 0 within 3 seconds of the release, naming agentboard renew T1', async () => {
    const { root, boardDir } = seed();
    const proc = waiter(root, 'merger-2');
    await queuedLine(proc);
    expect((await show(root)).queue.map((w) => w.actor)).toEqual(['merger-2']);
    withBoard(boardDir, (board) => releaseTicket(board, 'merger-1', { id: T1 }));
    const released = performance.now();
    const result = await proc.exited;
    const elapsed = performance.now() - released;
    expect(result.code, result.stderr).toBe(0);
    expect(elapsed).toBeLessThan(3000);
    expect(result.stdout).toContain(`agentboard renew ${T1} --as merger-2`);
    const ticket = await show(root);
    expect(ticket.assignee).toBe('merger-2');
    expect(ticket.queue).toEqual([]);
    expect(ticket.lease).toMatchObject({ confirmed: false });
  });
});

describe('scenario: interrupted wait leaves the queue', PROCESSES, () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    '%s: writes the leave and exits 4 wait-interrupted',
    async (signal) => {
      const { root } = seed();
      const proc = waiter(root, 'merger-2', true);
      await queuedLine(proc);
      process.kill(proc.pid, signal);
      const result = await proc.exited;
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr).toBe(4);
      const docs = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(docs[0]).toEqual({ queued: true, position: 1, holder: 'merger-1', ticket: T1 });
      expect(docs[1]).toMatchObject({ error: { exitCode: 4, reason: 'wait-interrupted' } });
      const ticket = await show(root);
      expect(ticket.queue).toEqual([]);
      expect(ticket.assignee).toBe('merger-1');
    },
  );
});

describe('scenario: killed waiter stays queued', PROCESSES, () => {
  it('SIGKILL leaves it queued; its grant lapses after the window and passes to the next waiter', async () => {
    const { root, boardDir } = seed();
    const proc = waiter(root, 'merger-2');
    await queuedLine(proc);
    withBoard(boardDir, (board) =>
      claimTicket(board, 'merger-3', { id: T1, ttl: 1_800_000, wait: true }),
    );
    const killed = await proc.kill();
    expect(killed.signal).toBe('SIGKILL');
    expect((await show(root)).queue.map((w) => w.actor)).toEqual(['merger-2', 'merger-3']);
    withBoard(boardDir, (board) => releaseTicket(board, 'merger-1', { id: T1 }));
    // The next command writes the grant to the dead waiter...
    const granted = await show(root);
    expect(granted.assignee).toBe('merger-2');
    expect(granted.queue.map((w) => w.actor)).toEqual(['merger-3']);
    // ...which lapses after its window plus the tolerance and passes on.
    const passed = await show(root, WINDOW + SKEW + 20_000);
    expect(passed.assignee).toBe('merger-3');
    expect(passed.queue).toEqual([]);
    const check = await runCliAsync(['rebuild', '--check'], root);
    expect(check.code, check.stderr).toBe(0);
  });
});

/**
 * A preload that, when the child exits, prints how many SIGINT and SIGTERM
 * listeners the process still has (review round 1: the handlers the CLI
 * installs for a waiting claim are removed once the command returns).
 */
function listenerProbe(): string[] {
  const path = join(scratchDir(), 'listeners.mjs');
  writeFileSync(
    path,
    "process.on('exit', () => { process.stderr.write(`listeners SIGINT=${String(process.listenerCount('SIGINT'))} SIGTERM=${String(process.listenerCount('SIGTERM'))}\\n`); });\n",
  );
  return ['--import', pathToFileURL(path).href];
}

describe(
  'review round 1: the signal handlers are removed (already correct at 090db5f)',
  PROCESSES,
  () => {
    it('after a wait that timed out', async () => {
      const { root } = seed();
      const argv = ['claim', T1, '--as', 'merger-2', '--ttl', '30m', '--wait', '--timeout', '1s'];
      const result = await startCli({ argv }, root, listenerProbe()).exited;
      expect(result.code, result.stderr).toBe(4);
      expect(result.stderr).toContain('listeners SIGINT=0 SIGTERM=0\n');
    });

    it('after a wait that was granted', async () => {
      const { root, boardDir } = seed();
      const argv = ['claim', T1, '--as', 'merger-2', '--ttl', '30m', '--wait', '--timeout', '10m'];
      const proc = startCli({ argv }, root, listenerProbe());
      await queuedLine(proc);
      withBoard(boardDir, (board) => releaseTicket(board, 'merger-1', { id: T1 }));
      const result = await proc.exited;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('listeners SIGINT=0 SIGTERM=0\n');
    });
  },
);

describe('review round 1 addendum: the human hint of an interrupted wait', PROCESSES, () => {
  it('SIGINT without --json: stderr names the wait-again command', async () => {
    const { root } = seed();
    const proc = waiter(root, 'merger-2');
    await queuedLine(proc);
    process.kill(proc.pid, 'SIGINT');
    const result = await proc.exited;
    expect(result.code, result.stderr).toBe(4);
    expect(result.stdout).toBe(`queued for ${T1} at position 1, held by merger-1\n`);
    expect(result.stderr).toMatch(/^agentboard: .*interrupted.*\n/m);
    expect(result.stderr).toContain(
      `hint: the wait was interrupted and you left the queue; to wait again run 'agentboard claim ${T1} --ttl <duration> --wait --timeout <duration> --as merger-2'\n`,
    );
  });
});
