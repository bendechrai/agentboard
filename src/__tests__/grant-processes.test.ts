/**
 * Grant materialisation across processes (add-claim-leases task 2.1;
 * board-cli: "Due grants are written during catch-up"; board-concurrency:
 * "Crash consistency"; board-events: "Grants", scenario "Identical grants
 * from two writers"):
 *
 * - two read-only commands that find the same grant due at once leave
 *   exactly one grant file, and the cache matches a rebuild;
 * - a command killed after the grant file is renamed into place but before
 *   its transaction commits leaves a complete grant that the next command
 *   folds.
 *
 * The board is written as event files with walls taken from the real
 * clock: `holder` claims T1 with a grace lease and `waiter` joins, so the
 * grant to `waiter` is due three minutes after the claim. The children that
 * must see it due run ten minutes ahead through the harness's clock
 * preload (`clockOffsetMs`); every other child runs on the real clock, on
 * which nothing is due while the test runs.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalEncode, canonicalHash } from '../events/canonical.js';
import type { Ticket } from '../events/fold.js';
import type { TicketGrantEvent } from '../events/schema.js';
import { P, ev, eventNames, putEvent } from '../store/__tests__/helpers.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  runCliAsync,
  runTogether,
  startCli,
  waitForPause,
} from './harness/processes.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const GRACE = 120_000;
const SKEW = 60_000;
/** How far ahead the children that must see the grant due run. */
const AHEAD = 600_000;

const PROCESSES = { timeout: 60_000 };

/**
 * A board whose only due grant (once the clock passes `claim wall + grace
 * + 60000 + 1`) is the grant to `waiter`, with the cache already built on
 * the real clock. Returns the project root, the events directory and that
 * grant written out by hand.
 */
async function seed(): Promise<{ root: string; eventsDir: string; g: TicketGrantEvent }> {
  const { root, eventsDir } = boardProject();
  const base = Date.now();
  putEvent(eventsDir, ev(P.create(T1, 'Merge lock'), 'orch', base - 1000));
  const claim = putEvent(
    eventsDir,
    ev(
      {
        kind: 'ticket.claim',
        ticket: T1,
        body: { lease: { ttl: 1_800_000, grace: GRACE, expiresAt: base + GRACE } },
      },
      'holder',
      base,
    ),
  );
  putEvent(
    eventsDir,
    ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'waiter', base + 1),
  );
  const g: TicketGrantEvent = {
    v: 1,
    kind: 'ticket.grant',
    ticket: T1,
    actor: 'agentboard',
    ts: { wall: base + GRACE + SKEW + 1, counter: 0, actor: 'agentboard' },
    body: {
      to: 'waiter',
      ttl: 600_000,
      window: 120_000,
      after: { lease: { holder: 'holder', expiresAt: base + GRACE, event: claim } },
    },
  };
  const built = await runCliAsync(['list'], root);
  expect(built.code, built.stderr).toBe(0);
  expect(grantFiles(eventsDir)).toEqual([]);
  return { root, eventsDir, g };
}

function grantFiles(eventsDir: string): string[] {
  return eventNames(eventsDir).filter((name) => {
    const doc = JSON.parse(readFileSync(join(eventsDir, name), 'utf8')) as { kind: string };
    return doc.kind === 'ticket.grant';
  });
}

function temps(eventsDir: string): string[] {
  return readdirSync(eventsDir).filter((name) => name.startsWith('.tmp-'));
}

async function showAhead(root: string): Promise<Ticket> {
  const out = await startCli({ argv: ['show', T1, '--json'], clockOffsetMs: AHEAD }, root).exited;
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: Ticket }).ticket;
}

describe('two processes materialise the same grant concurrently', PROCESSES, () => {
  it('leaves exactly one grant file, every time', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { root, eventsDir, g } = await seed();
      const { results, readyAtGate } = await runTogether(
        [
          { argv: ['list', '--json'], clockOffsetMs: AHEAD },
          { argv: ['list', '--json'], clockOffsetMs: AHEAD },
        ],
        root,
      );
      expect(readyAtGate).toBe(2);
      for (const result of results) {
        expect(result.code, result.stderr).toBe(0);
      }
      const hash = canonicalHash(g);
      expect(grantFiles(eventsDir)).toEqual([`${hash}.json`]);
      expect(readFileSync(join(eventsDir, `${hash}.json`))).toEqual(
        Buffer.from(canonicalEncode(g)),
      );
      expect(temps(eventsDir)).toEqual([]);
      const check = await runCliAsync(['rebuild', '--check'], root);
      expect(check.code, check.stderr).toBe(0);
      expect(await showAhead(root)).toMatchObject({ assignee: 'waiter', queue: [] });
    }
  });
});

describe('scenario: killed after the grant file is renamed, before commit', PROCESSES, () => {
  it('the next command folds the grant exactly as if the killed one had completed', async () => {
    const { root, eventsDir, g } = await seed();
    const hash = canonicalHash(g);
    const proc = startCli(
      {
        argv: ['list', '--json'],
        env: cliEnv({ AGENTBOARD_TEST_PAUSE: 'after-rename' }),
        clockOffsetMs: AHEAD,
      },
      root,
    );
    const path = await waitForPause(proc, 'after-rename');
    const killed = await proc.kill();
    expect(killed.signal).toBe('SIGKILL');
    expect(killed.stdout).toBe('');

    // The grant file is complete under its hash name; nothing else was written.
    expect(path).toBe(join(eventsDir, `${hash}.json`));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(Buffer.from(canonicalEncode(g)));
    expect(grantFiles(eventsDir)).toEqual([`${hash}.json`]);
    expect(temps(eventsDir)).toEqual([]);

    // rebuild --check never catches up, so it sees the unfolded grant.
    const diverged = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(diverged.code, diverged.stderr).toBe(1);
    const doc = oneDocument(diverged) as { differences: { ticket: string | null }[] };
    expect(doc.differences.some((d) => d.ticket === T1)).toBe(true);

    // The next command folds it, and writes nothing more.
    expect(await showAhead(root)).toMatchObject({
      assignee: 'waiter',
      queue: [],
      lease: { ttl: 600_000, expiresAt: g.ts.wall + 120_000, event: hash, confirmed: false },
    });
    expect(grantFiles(eventsDir)).toEqual([`${hash}.json`]);
    const check = await runCliAsync(['rebuild', '--check'], root);
    expect(check.code, check.stderr).toBe(0);
  });
});
