/**
 * keep-cursors-on-upgrade task 1.1: the carry is read and written inside
 * the recreate's one `BEGIN IMMEDIATE` (design.md "Carry the cursor tables
 * inside the recreate's transaction"), and the retry after a failed carry
 * read re-checks the version ("The expected shape"), pinned
 * deterministically.
 *
 * The racing tests of keep-cursors-processes.test.ts leave these windows
 * to chance, and they are microseconds wide. Here the upgrading child is
 * held at an exact SQL statement by the harness's statement gate
 * (`startHeld`, `harness/upgrade.ts`); the test acts through other
 * processes while it is held, then releases it. Every wait is on a
 * condition, never a fixed sleep.
 *
 * - Held before its first `BEGIN IMMEDIATE` (the schema step's): nothing of
 *   the carry may have been read yet, so an old-version advance of alice's
 *   cursor committed meanwhile is carried. Reading the carry before the
 *   lock would carry alice's earlier position.
 * - Held right after its first `COMMIT` (the schema step's): the carried
 *   cursors and `carried_applied` are committed already, so another
 *   process sees them and its first fold moves them back over the events
 *   0.2.0 did not apply. Writing the carry in a second transaction lets
 *   that fold run with no cursors and no prior, and the supersede behind
 *   alice's carried cursor is then never delivered.
 * - On a cache whose `cursors` records are corrupt, held before its second
 *   `BEGIN IMMEDIATE` (the retry without the carry): another process
 *   recreates, folds and advances bob meanwhile; the retry finds the
 *   current version and recreates nothing, so bob's cursor survives.
 */

import { describe, expect, it } from 'vitest';

import { corruptRecords, cursorRows, withDb } from '../store/__tests__/v020-cache.js';
import { cliEnv, runCliAsync } from './harness/processes.js';
import {
  advanceTarget,
  fixtureProject,
  inboxDoc,
  minutesOf,
  oldAdvance,
  startHeld,
} from './harness/upgrade.js';

/** How many times each scenario runs (as the 1.3 process tests). */
const ROUNDS = 20;

const SLOW = { timeout: 600_000 };

const PEEK_DAVE = ['inbox', '--peek', '--as', 'dave', '--json'] as const;

function peek(root: string, actor: string): Promise<ReturnType<typeof inboxDoc>> {
  return runCliAsync(['inbox', '--peek', '--as', actor, '--json'], root, cliEnv()).then(inboxDoc);
}

describe('the carry and the recreate share one transaction (1.1)', () => {
  it(
    'an old-version advance committed before the schema step takes the lock is carried',
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache, events } = fixtureProject('plain');
        expect(events.at(-1)?.minute).toBe(190);
        const target = advanceTarget(events);
        const upgrader = await startHeld(PEEK_DAVE, root, {
          sql: '^BEGIN IMMEDIATE$',
          when: 'before',
        });
        try {
          // The schema step has not taken the lock: the advance lands in
          // the 0.2.0 cache.
          expect(await oldAdvance(cache, target).exited).toBe('advanced 4\n');
        } finally {
          expect((await upgrader.release()).code).toBe(0);
        }
        withDb(cache, (db) => {
          const alice = cursorRows(db).cursors.find((r) => r.actor === 'alice');
          expect(alice?.last_hash, `round ${String(round)}`).toBe(target.hash);
        });
        expect((await peek(root, 'alice')).entries).toEqual([]);
      }
    },
  );

  it(
    "another process right after the recreate's commit sees the carried cursors, and the supersede is not skipped",
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache, old, events } = fixtureProject('unknown');
        const supersede = events.find((e) => e.event.kind === 'ticket.supersede');
        expect(supersede?.minute).toBe(10);
        const upgrader = await startHeld(PEEK_DAVE, root, { sql: '^COMMIT$', when: 'after' });
        try {
          // The schema step has committed: its cursors are there already.
          withDb(cache, (db) => {
            expect(cursorRows(db).cursors, `round ${String(round)}`).toEqual(old.cursors);
          });
          expect(minutesOf(await peek(root, 'carol'))).toEqual([
            10, 15, 70, 90, 110, 130, 150, 160, 170, 180, 190,
          ]);
        } finally {
          expect((await upgrader.release()).code).toBe(0);
        }
        // alice's carried cursor (minute 170) is hours past the supersede,
        // which 0.2.0 did not apply: it is still delivered.
        expect(
          (await peek(root, 'alice')).entries.map((e) => e.hash),
          `round ${String(round)}`,
        ).toContain(supersede?.hash);
      }
    },
  );

  it(
    'after a failed carry read, the retry re-checks the version and does not recreate over a winner',
    SLOW,
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { root, cache } = fixtureProject('plain');
        corruptRecords(cache, 'cursors');
        const loser = await startHeld(PEEK_DAVE, root, {
          sql: '^BEGIN IMMEDIATE$',
          when: 'before',
          nth: 2,
        });
        try {
          // Meanwhile another process recreates, folds and advances bob.
          const bob = inboxDoc(
            await runCliAsync(['inbox', '--as', 'bob', '--json'], root, cliEnv()),
          );
          expect(bob.entries.length).toBeGreaterThan(0);
        } finally {
          expect((await loser.release()).code).toBe(0);
        }
        expect((await peek(root, 'bob')).entries, `round ${String(round)}`).toEqual([]);
      }
    },
  );
});
