/**
 * The two-event command transaction under real processes
 * (add-adhoc-ticket-lifecycle task 1.3; board-cache: "Crash between the
 * disposition and the move"; board-concurrency: "Crash consistency"):
 *
 * - a writer killed with SIGKILL after its first event file (the
 *   `ticket.unplanned`) is renamed into place, using the existing pause
 *   hook (`AGENTBOARD_TEST_PAUSE=after-rename` pauses at the first file a
 *   command writes), leaves the disposition without its move; the next
 *   command's catch-up folds it, the ticket is still in `review` with the
 *   disposition, and `move merged` without a disposition then succeeds;
 * - two processes racing the same pair on one ticket leave exactly one
 *   applied move, and `rebuild --check` is clean, twenty times over.
 *
 * The first two describes drive the operation through the built library
 * (`dist/index.js`, next to `dist/cli.js`) with a small child script:
 * `runCommand` with the two proposed events, reading the pause hooks from
 * the environment exactly as the CLI does. The last describe drives the
 * CLI form itself, `move <id> merged --unplanned "<reason>"` (task 2.1),
 * through the same two scenarios. Run `npm run build` first when running
 * vitest directly.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { canonicalDecode } from '../events/canonical.js';
import type { Ticket } from '../events/fold.js';
import { eventNames, foldDir } from '../store/__tests__/helpers.js';
import {
  BUILT_CLI,
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  startCli,
  waitForPause,
  type ProcessResult,
  type RunEnv,
} from './harness/processes.js';

const PROCESSES = { timeout: 60_000 };

/**
 * The child writer: `node merge-unplanned.mjs <board dir> <ticket> <actor>
 * <reason>` proposes the `ticket.unplanned` and the `ticket.move` to
 * `merged` as one command and prints one JSON line: the hashes written
 * (`{"hash","events","status"}`) or the refusal (`{"error":{...}}`),
 * exiting with the BoardError's exit code.
 */
const WRITER = `
import { BoardError, openBoard, runCommand } from ${JSON.stringify(
  pathToFileURL(join(dirname(BUILT_CLI), 'index.js')).href,
)};
const [dir, ticket, actor, reason] = process.argv.slice(2);
const board = openBoard(dir);
try {
  const result = runCommand(board, actor, () => ({
    ok: true,
    events: [
      { kind: 'ticket.unplanned', ticket, body: { reason } },
      { kind: 'ticket.move', ticket, body: { to: 'merged' } },
    ],
  }));
  process.stdout.write(JSON.stringify({
    hash: result.hash,
    events: result.events.map((e) => e.hash),
    status: result.ticket === null ? null : result.ticket.status,
  }) + '\\n');
} catch (error) {
  if (!(error instanceof BoardError)) {
    throw error;
  }
  process.stdout.write(JSON.stringify({
    error: { exitCode: error.exitCode, reason: error.reason, message: error.message },
  }) + '\\n');
  process.exitCode = error.exitCode;
} finally {
  board.close();
}
`;

let writerPath: string | null = null;

function writer(): string {
  if (writerPath === null) {
    requireBuiltCli();
    writerPath = join(scratchDir(), 'merge-unplanned.mjs');
    writeFileSync(writerPath, WRITER);
  }
  return writerPath;
}

interface Child {
  readonly exited: Promise<ProcessResult>;
  stderr(): string;
  kill(): Promise<ProcessResult>;
}

const live = new Set<Child>();

afterAll(async () => {
  for (const child of live) {
    await child.kill();
  }
});

/** Spawns the writer on `boardDir` for `ticket` as `actor`, with `env`. */
function startWriter(
  boardDir: string,
  ticket: string,
  actor: string,
  reason: string,
  env: RunEnv = cliEnv(),
): Child {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      defined[key] = value;
    }
  }
  const child = spawn(process.execPath, [writer(), boardDir, ticket, actor, reason], {
    env: defined,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  let done = false;
  const exited = new Promise<ProcessResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done = true;
      live.delete(handle);
      resolve({ code, signal, stdout: out, stderr: err });
    });
  });
  const handle: Child = {
    exited,
    stderr: () => err,
    kill() {
      if (!done) {
        child.kill('SIGKILL');
      }
      return exited;
    },
  };
  live.add(handle);
  return handle;
}

/** Waits until the child prints the pause line for `after-rename` and returns the path. */
async function waitForFirstRename(child: Child): Promise<string> {
  const pattern = /^agentboard: paused at after-rename (.+)$/m;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const match = pattern.exec(child.stderr());
    if (match?.[1] !== undefined) {
      return match[1];
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the pause line: ${child.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** An ad hoc ticket in review, through the CLI; returns its id. */
async function adhocInReview(root: string, title: string): Promise<string> {
  const out = await runCliAsync(
    ['new', title, '--adhoc', 'seen in production', '--as', 'orch', '--json'],
    root,
  );
  expect(out.code, out.stderr).toBe(0);
  const id = (oneDocument(out) as { ticket: { id: string } }).ticket.id;
  for (const to of ['tests', 'implementing', 'review']) {
    const moved = await runCliAsync(['move', id, to, '--as', 'orch'], root);
    expect(moved.code, moved.stderr).toBe(0);
  }
  return id;
}

async function show(root: string, id: string): Promise<Ticket> {
  const out = await runCliAsync(['show', id, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: Ticket }).ticket;
}

describe('scenario: crash between the disposition and the move', PROCESSES, () => {
  it('the next command folds the disposition, the ticket stays in review, and move merged then succeeds', async () => {
    const { root, boardDir, eventsDir } = boardProject();
    const id = await adhocInReview(root, 'Fragile');
    const namesBefore = eventNames(eventsDir);

    // Killed at the first file the command renames into place: the
    // ticket.unplanned. The ticket.move is never written.
    const child = startWriter(
      boardDir,
      id,
      'merger',
      'hotfix',
      cliEnv({ AGENTBOARD_TEST_PAUSE: 'after-rename' }),
    );
    const path = await waitForFirstRename(child);
    const killed = await child.kill();
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.stdout).toBe('');

    expect(dirname(path)).toBe(eventsDir);
    expect(existsSync(path)).toBe(true);
    const written = canonicalDecode(new Uint8Array(readFileSync(path))) as {
      kind: string;
      body: { reason: string };
    };
    expect(written.kind).toBe('ticket.unplanned');
    expect(written.body).toEqual({ reason: 'hotfix' });
    expect(eventNames(eventsDir)).toEqual([...namesBefore, basename(path)].sort());

    // The independent fold: a valid state, the disposition without its move.
    const folded = foldDir(eventsDir).state.tickets[id];
    expect(folded).toMatchObject({ status: 'review', unplanned: { reason: 'hotfix', actor: 'merger' } });

    // rebuild --check never catches up: the unfolded file is a divergence.
    const check = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(check.code).toBe(1);

    // The next command folds it.
    const shown = await show(root, id);
    expect(shown.status).toBe('review');
    expect(shown.unplanned).toMatchObject({ reason: 'hotfix', actor: 'merger' });
    const clean = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(clean.code, clean.stderr).toBe(0);

    // move merged without a disposition now succeeds.
    const merged = await runCliAsync(['move', id, 'merged', '--as', 'merger', '--json'], root);
    expect(merged.code, merged.stderr).toBe(0);
    expect(oneDocument(merged)).toMatchObject({
      ticket: { status: 'merged', unplanned: { reason: 'hotfix' } },
    });
    expect((await show(root, id)).status).toBe('merged');
  });

  it('a writer that is not killed writes both files and the ticket is merged', async () => {
    const { root, boardDir, eventsDir } = boardProject();
    const id = await adhocInReview(root, 'Whole');
    const result = await startWriter(boardDir, id, 'merger', 'hotfix').exited;
    expect(result.code, result.stderr).toBe(0);
    const doc = oneDocument(result) as { hash: string; events: string[]; status: string };
    expect(doc.events).toHaveLength(2);
    expect(doc.hash).toBe(doc.events[1]);
    expect(doc.status).toBe('merged');
    expect(eventNames(eventsDir)).toHaveLength(6);
    expect(await show(root, id)).toMatchObject({
      status: 'merged',
      unplanned: { reason: 'hotfix', actor: 'merger' },
    });
  });
});

describe('two concurrent writers of the same pair', { timeout: 180_000 }, () => {
  const ROUNDS = 20;

  it(`leave exactly one applied move and a clean rebuild --check, ${String(ROUNDS)} times`, async () => {
    const { root, boardDir, eventsDir } = boardProject();
    const ids: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      ids.push(await adhocInReview(root, `Contested ${String(round)}`));
    }
    const filesBefore = eventNames(eventsDir).length;

    for (const [round, id] of ids.entries()) {
      const [left, right] = await Promise.all([
        startWriter(boardDir, id, 'left', `left ${String(round)}`).exited,
        startWriter(boardDir, id, 'right', `right ${String(round)}`).exited,
      ]);
      const results = [left, right];
      for (const result of results) {
        expect(result.signal, result.stderr).toBeNull();
        expect(result.stderr).not.toMatch(/database is locked|SQLITE_BUSY|\bbusy\b/i);
      }
      const winners = results.filter((r) => r.code === 0);
      const losers = results.filter((r) => r.code === 4);
      expect(winners, `round ${String(round)}: ${left.stderr}${right.stderr}`).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const won = oneDocument(winners[0] as ProcessResult) as { events: string[]; status: string };
      expect(won.events).toHaveLength(2);
      expect(won.status).toBe('merged');
      // The loser's disposition folded in memory, then its move was refused
      // by the state the winner left: nothing of its own was written.
      expect(oneDocument(losers[0] as ProcessResult)).toMatchObject({
        error: { exitCode: 4, reason: 'invalid-transition' },
      });
      const actor = winners[0] === left ? 'left' : 'right';
      const folded = foldDir(eventsDir).state.tickets[id];
      expect(folded).toMatchObject({
        status: 'merged',
        unplanned: { reason: `${actor} ${String(round)}`, actor },
      });
    }

    expect(eventNames(eventsDir)).toHaveLength(filesBefore + 2 * ROUNDS);
    expect(foldDir(eventsDir).rejected).toEqual([]);
    const check = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(oneDocument(check)).toMatchObject({ ok: true, differences: [] });
  });
});

describe('the CLI form: move <id> merged --unplanned "<reason>" (task 2.1)', PROCESSES, () => {
  it('killed after the ticket.unplanned is renamed: show folds the disposition, the ticket is in review, and move <id> merged then succeeds', async () => {
    const { root, eventsDir } = boardProject();
    const id = await adhocInReview(root, 'Fragile CLI');
    const namesBefore = eventNames(eventsDir);

    const proc = startCli(
      {
        argv: ['move', id, 'merged', '--unplanned', 'hotfix', '--as', 'merger', '--json'],
        env: cliEnv({ AGENTBOARD_TEST_PAUSE: 'after-rename' }),
      },
      root,
    );
    const path = await waitForPause(proc, 'after-rename');
    const killed = await proc.kill();
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.stdout).toBe('');

    expect(dirname(path)).toBe(eventsDir);
    const written = canonicalDecode(new Uint8Array(readFileSync(path))) as {
      kind: string;
      actor: string;
      body: { reason: string };
    };
    expect(written).toMatchObject({
      kind: 'ticket.unplanned',
      actor: 'merger',
      body: { reason: 'hotfix' },
    });
    expect(eventNames(eventsDir)).toEqual([...namesBefore, basename(path)].sort());
    expect(foldDir(eventsDir).state.tickets[id]).toMatchObject({
      status: 'review',
      unplanned: { reason: 'hotfix', actor: 'merger' },
    });

    const shown = await show(root, id);
    expect(shown.status).toBe('review');
    expect(shown.unplanned).toMatchObject({ reason: 'hotfix', actor: 'merger' });
    const clean = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(clean.code, clean.stderr).toBe(0);

    const merged = await runCliAsync(['move', id, 'merged', '--as', 'merger', '--json'], root);
    expect(merged.code, merged.stderr).toBe(0);
    expect(oneDocument(merged)).toMatchObject({
      ticket: { status: 'merged', unplanned: { reason: 'hotfix', actor: 'merger' } },
    });
    expect(eventNames(eventsDir)).toHaveLength(namesBefore.length + 2);
  });

  it('a run that is not killed writes both files, lists both hashes and merges the ticket', async () => {
    const { root, eventsDir } = boardProject();
    const id = await adhocInReview(root, 'Whole CLI');
    const out = await runCliAsync(
      ['move', id, 'merged', '--unplanned', 'hotfix', '--as', 'merger', '--json'],
      root,
    );
    expect(out.code, out.stderr).toBe(0);
    const doc = oneDocument(out) as { hash: string; events: string[]; ticket: Ticket };
    expect(doc.events).toHaveLength(2);
    expect(doc.hash).toBe(doc.events[1]);
    expect(doc.ticket).toMatchObject({ status: 'merged', unplanned: { reason: 'hotfix' } });
    expect(eventNames(eventsDir)).toHaveLength(6);
  });
});

describe('two concurrent move <id> merged --unplanned processes', { timeout: 180_000 }, () => {
  const ROUNDS = 20;

  it(`leave exactly one applied move and a clean rebuild --check, ${String(ROUNDS)} times`, async () => {
    const { root, eventsDir } = boardProject();
    const ids: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      ids.push(await adhocInReview(root, `Contested CLI ${String(round)}`));
    }
    const filesBefore = eventNames(eventsDir).length;

    for (const [round, id] of ids.entries()) {
      const argv = (actor: string): string[] => [
        'move',
        id,
        'merged',
        '--unplanned',
        `${actor} ${String(round)}`,
        '--as',
        actor,
        '--json',
      ];
      const [left, right] = await Promise.all([
        runCliAsync(argv('left'), root),
        runCliAsync(argv('right'), root),
      ]);
      const results = [left, right];
      for (const result of results) {
        expect(result.signal, result.stderr).toBeNull();
        expect(result.stderr).not.toMatch(/database is locked|SQLITE_BUSY|\bbusy\b/i);
      }
      const winners = results.filter((r) => r.code === 0);
      const losers = results.filter((r) => r.code === 4);
      expect(winners, `round ${String(round)}: ${left.stderr}${right.stderr}`).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const won = oneDocument(winners[0] as ProcessResult) as {
        events: string[];
        ticket: { status: string };
      };
      expect(won.events).toHaveLength(2);
      expect(won.ticket.status).toBe('merged');
      // The loser's disposition folded in memory, then its move was refused
      // by the state the winner left: nothing of its own was written.
      expect(oneDocument(losers[0] as ProcessResult)).toMatchObject({
        error: { exitCode: 4, reason: 'invalid-transition' },
      });
      const actor = winners[0] === left ? 'left' : 'right';
      expect(foldDir(eventsDir).state.tickets[id]).toMatchObject({
        status: 'merged',
        unplanned: { reason: `${actor} ${String(round)}`, actor },
      });
    }

    expect(eventNames(eventsDir)).toHaveLength(filesBefore + 2 * ROUNDS);
    expect(foldDir(eventsDir).rejected).toEqual([]);
    const check = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(oneDocument(check)).toMatchObject({ ok: true, differences: [] });
  });
});
