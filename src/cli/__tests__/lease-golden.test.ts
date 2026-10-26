/**
 * Golden CLI outputs of leases and queues (add-claim-leases task 3.2;
 * board-cli: "Leases on the command line", "Forced release on the command
 * line", "Lease and queue events in the inbox"): `show`, `list` and
 * `inbox`, human and `--json`, on the lease fixture board
 * (`lease-fixture.ts`) at its fixed clock, with tickets that are free, in
 * grace, confirmed, expired, claimable, queued with three waiters, granted
 * and pending acceptance, taken over and force-released.
 *
 * The CLI runs in process with the clock injected through vitest fake
 * timers (`Date` only). The goldens live in `golden/leases/` and were
 * derived from the spec and the stub contracts, not recorded from the
 * implementation.
 */

import { readdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { oneJson, run, type Run } from './cli-helpers.js';
import {
  LEASE_ID,
  LEASE_NOW,
  LEASE_TICKETS,
  fixtureNames,
  golden,
  goldenJson,
  leaseFixture,
} from './lease-fixture.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(LEASE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function ok(out: Run): Run {
  expect(out.code, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  return out;
}

describe('list on the fixture board', () => {
  it('human: one token per assignee column with lease and queue suffixes', () => {
    const { root } = leaseFixture();
    expect(ok(run(['list'], root)).stdout).toBe(golden('list.txt'));
  });

  it('--json: each ticket with lease {ttl, expiresAt, event, confirmed, state, claimableAt} and its queue', () => {
    const { root } = leaseFixture();
    expect(oneJson(ok(run(['list', '--json'], root)))).toEqual(goldenJson('list.json'));
  });

  it('reading the fixture at its clock writes no event file (no grant is due)', () => {
    const { root, eventsDir } = leaseFixture();
    ok(run(['list'], root));
    for (const id of Object.values(LEASE_ID)) {
      ok(run(['show', id], root));
    }
    expect(readdirSync(eventsDir).sort()).toEqual(fixtureNames());
  });

  it('the state is computed from the clock at read time, never stored', () => {
    const { root } = leaseFixture();
    ok(run(['list'], root));
    // 41 s later the expired lease is claimable and the grace lease has 49 s left.
    vi.setSystemTime(LEASE_NOW + 41_000);
    const lines = ok(run(['list'], root)).stdout.split('\n');
    expect(lines).toContain(`${LEASE_ID.expired}  todo  impl-2*!claimable  [adhoc] Expired lock`);
    expect(lines).toContain(`${LEASE_ID.grace}  todo  merger-1*+49s  [adhoc] Lock in grace`);
    // Back at the fixture clock the outputs are the goldens again.
    vi.setSystemTime(LEASE_NOW);
    expect(ok(run(['list'], root)).stdout).toBe(golden('list.txt'));
  });
});

describe('show on the fixture board', () => {
  it.each(LEASE_TICKETS)('%s: human', (name) => {
    const { root } = leaseFixture();
    expect(ok(run(['show', LEASE_ID[name]], root)).stdout).toBe(golden(`show-${name}.txt`));
  });

  it.each(LEASE_TICKETS)('%s: --json', (name) => {
    const { root } = leaseFixture();
    expect(oneJson(ok(run(['show', LEASE_ID[name], '--json'], root)))).toEqual(
      goldenJson(`show-${name}.json`),
    );
  });

  it('a ticket without lease, queue, grant, takeover or forced release prints no lease line', () => {
    const { root } = leaseFixture();
    const text = ok(run(['show', LEASE_ID.free], root)).stdout;
    for (const label of [
      'lease:',
      'granted:',
      'next grant:',
      'queue:',
      'takeover:',
      'forced release:',
    ]) {
      expect(text).not.toContain(label);
    }
    const doc = oneJson(ok(run(['show', LEASE_ID.free, '--json'], root))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(doc).sort()).toEqual(['events', 'ticket', 'unknown']);
  });
});

describe('inbox on the fixture board', () => {
  it.each(['merger-6', 'impl-4', 'merger-7'])(
    'human for %s: GRANTED: for its grant, LOST: where it is affected',
    (reader) => {
      const { root } = leaseFixture();
      expect(ok(run(['inbox', '--as', reader, '--peek'], root)).stdout).toBe(
        golden(`inbox-${reader}.txt`),
      );
    },
  );

  it('--json: grant to, forced release note and affects, takeover affects', () => {
    const { root } = leaseFixture();
    expect(oneJson(ok(run(['inbox', '--as', 'merger-6', '--peek', '--json'], root)))).toEqual(
      goldenJson('inbox-merger-6.json'),
    );
  });

  it('an actor neither granted nor affected gets no prefix on any line', () => {
    const { root } = leaseFixture();
    const text = ok(run(['inbox', '--as', 'observer', '--peek'], root)).stdout;
    expect(text).not.toMatch(/^(GRANTED|LOST): /m);
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(fixtureNames().length);
  });
});
