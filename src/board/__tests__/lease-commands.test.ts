/**
 * The lease, queue, forced-release and config operations (add-claim-leases
 * task 3.1; board-cli: "Claim, release and handoff", "Leases on the
 * command line", "Waiting on the command line" (the non-blocking join),
 * "Forced release on the command line", "Board settings command";
 * design.md: "Command-time validation matches the fold", "Takeover
 * rule").
 *
 * In process, with the clock injected through vitest fake timers (`Date`
 * only), which the board open, `runCommand` and the reads all use. Every
 * refusal is checked to leave the events directory (temporary files
 * included) and the cache dump unchanged.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalDecode } from '../../events/canonical.js';
import { validateEvent, type BoardEvent } from '../../events/schema.js';
import { openBoard, type Board } from '../../store/board.js';
import { catchUp, dumpCache } from '../../store/cache.js';
import { BoardError } from '../../store/errors.js';
import { runCommand } from '../../store/transaction.js';
import { P, allNames, ev, eventNames, putEvent, propose } from '../../store/__tests__/helpers.js';
import {
  ClaimRefusedError,
  claimTicket,
  moveTicket,
  releaseTicket,
  renewTicket,
  unqueueTicket,
} from '../actions.js';
import { getConfig, setConfig } from '../config.js';
import { showTicket } from '../tickets.js';
import { SAMPLES, create, expectBoardError, setup } from './helpers.js';

/** The base clock of every test. */
const T = 1_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let board: Board;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T);
  board = setup().board;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock to `T + ms`. */
function at(ms: number): void {
  vi.setSystemTime(T + ms);
}

/** A fresh ad hoc mutex ticket, created at the current clock. */
function lock(): string {
  return create(board, { title: 'Merge lock', adhoc: 'merge lock' }).id;
}

/** The event in the file of `hash`. */
function eventOf(hash: string | null): BoardEvent {
  expect(hash).not.toBeNull();
  const bytes = readFileSync(join(board.eventsDir, `${String(hash)}.json`));
  const result = validateEvent(canonicalDecode(new Uint8Array(bytes)));
  if (!result.ok || !result.known) {
    throw new Error(`not a well-formed known event: ${hash}`);
  }
  return result.event;
}

/** Runs `fn`, expecting the BoardError, and that no file and no cache row changed. */
function refused(fn: () => unknown, exitCode: number, reason: string): BoardError {
  const names = allNames(board.eventsDir);
  const dump = dumpCache(board.db);
  const err = expectBoardError(fn, exitCode, reason);
  expect(allNames(board.eventsDir)).toEqual(names);
  expect(dumpCache(board.db)).toEqual(dump);
  return err;
}

/** `h` claims `id` with a 30m lease at the current clock; returns the claim's hash. */
function leased(id: string, h = 'merger-1', ttl = 1_800_000): string {
  const out = claimTicket(board, h, { id, ttl });
  expect(out.queued).toBe(undefined);
  return String(out.hash);
}

describe('claim with a lease', () => {
  it('scenario: claim with a lease starts in grace (default grace 120000)', () => {
    const id = lock();
    at(5000);
    const out = claimTicket(board, 'merger-1', { id, ttl: 1_800_000 });
    const event = eventOf(out.hash);
    expect(event).toMatchObject({ kind: 'ticket.claim', actor: 'merger-1', ticket: id });
    expect(event.ts.wall).toBe(T + 5000);
    expect(event.body).toEqual({
      lease: { ttl: 1_800_000, grace: 120_000, expiresAt: T + 5000 + 120_000 },
    });
    expect(out.events).toEqual([out.hash]);
    expect(out.ticket.assignee).toBe('merger-1');
    expect(out.ticket.lease).toEqual({
      ttl: 1_800_000,
      expiresAt: T + 125_000,
      event: out.hash,
      confirmed: false,
    });
    expect('queued' in out).toBe(false);
  });

  it('a ttl shorter than the grace sets expiresAt to wall + ttl, recording the grace', () => {
    const id = lock();
    const out = claimTicket(board, 'merger-1', { id, ttl: 30_000 });
    expect(eventOf(out.hash).body).toEqual({
      lease: { ttl: 30_000, grace: 120_000, expiresAt: T + 30_000 },
    });
  });

  it('records the board lease.grace setting as folded', () => {
    const id = lock();
    runCommand(board, 'orchestrator', propose(P.meta('lease.grace', 300_000)));
    const out = claimTicket(board, 'merger-1', { id, ttl: 1_800_000 });
    expect(eventOf(out.hash).body).toEqual({
      lease: { ttl: 1_800_000, grace: 300_000, expiresAt: T + 300_000 },
    });
  });

  it('an out-of-range lease.grace setting means the default', () => {
    const id = lock();
    runCommand(board, 'orchestrator', propose(P.meta('lease.grace', 5000)));
    const out = claimTicket(board, 'merger-1', { id, ttl: 1_800_000 });
    expect(eventOf(out.hash).body).toMatchObject({ lease: { grace: 120_000 } });
  });

  it('builds the timestamp before validating: expiresAt follows the hybrid wall, not the clock', () => {
    const id = lock();
    const other = lock();
    // A folded event from a clock 500 s fast pushes the hybrid timestamp ahead.
    putEvent(board.eventsDir, ev(P.comment(other, 'from a fast clock'), 'remote', T + 500_000));
    const out = claimTicket(board, 'merger-1', { id, ttl: 1_800_000 });
    const event = eventOf(out.hash);
    expect(event.ts).toEqual({ wall: T + 500_000, counter: 1, actor: 'merger-1' });
    expect(event.body).toEqual({
      lease: { ttl: 1_800_000, grace: 120_000, expiresAt: T + 500_000 + 120_000 },
    });
  });

  it('a plain claim without a ttl is unchanged: empty body, no lease', () => {
    const id = lock();
    const out = claimTicket(board, 'impl', { id });
    expect(eventOf(out.hash).body).toEqual({});
    expect(out.ticket.lease).toBeNull();
  });

  it.each([1000, 29_999, 604_800_001, 1.5, Number.NaN])(
    'a ttl of %d is a usage error before anything is written',
    (ttl) => {
      const id = lock();
      refused(() => claimTicket(board, 'merger-1', { id, ttl }), 1, 'usage');
    },
  );

  it('wait without a ttl is a usage error naming --ttl', () => {
    const id = lock();
    const err = refused(() => claimTicket(board, 'merger-1', { id, wait: true }), 1, 'usage');
    expect(err.message).toContain('--ttl');
  });
});

describe('a claim by the current holder', () => {
  it('writes nothing with or without --ttl or --wait and reports the current lease', () => {
    const id = lock();
    const first = leased(id);
    at(10_000);
    const before = eventNames(board.eventsDir);
    for (const input of [{ id }, { id, ttl: 600_000 }, { id, ttl: 600_000, wait: true }]) {
      const out = claimTicket(board, 'merger-1', input);
      expect(out.queued === true).toBe(false);
      if (out.queued !== true) {
        expect(out.hash).toBeNull();
        expect(out.events).toEqual([]);
        expect(out.ticket.lease).toEqual({
          ttl: 1_800_000,
          expiresAt: T + 120_000,
          event: first,
          confirmed: false,
        });
      }
    }
    expect(eventNames(board.eventsDir)).toEqual(before);
  });

  it('with wait the result carries queued false', () => {
    const id = lock();
    leased(id);
    expect(claimTicket(board, 'merger-1', { id, ttl: 600_000, wait: true })).toMatchObject({
      hash: null,
      queued: false,
    });
  });
});

describe('scenario: refusal names the lease', () => {
  it('a live lease: exit 4 already-assigned naming the holder, the expiry and the claimable time', () => {
    const id = lock();
    leased(id);
    at(30_000);
    const err = refused(
      () => claimTicket(board, 'merger-2', { id, ttl: 1_800_000 }),
      4,
      'already-assigned',
    );
    expect(err).toBeInstanceOf(ClaimRefusedError);
    expect(err.message).toBe(
      `ticket ${id} is already assigned to merger-1 (lease expires ${iso(T + 120_000)}, claimable from ${iso(T + 180_000)})`,
    );
    expect(err instanceof ClaimRefusedError ? [err.holder, err.lease] : null).toEqual([
      'merger-1',
      { expiresAt: T + 120_000, claimableAt: T + 180_000 },
    ]);
  });

  it('a hold without a lease never becomes claimable, and the message has no lease part', () => {
    const id = lock();
    claimTicket(board, 'impl', { id });
    at(1_000_000_000);
    const err = refused(
      () => claimTicket(board, 'merger-2', { id, ttl: 1_800_000 }),
      4,
      'already-assigned',
    );
    expect(err.message).toBe(`ticket ${id} is already assigned to impl`);
    expect(err).toBeInstanceOf(ClaimRefusedError);
    expect(err instanceof ClaimRefusedError ? err.lease : 'not a ClaimRefusedError').toBeNull();
  });

  it('scenario: expired but not yet claimable (20 s after expiry) is refused and writes nothing', () => {
    const id = lock();
    leased(id);
    at(140_000);
    refused(() => claimTicket(board, 'merger-2', { id, ttl: 1_800_000 }), 4, 'already-assigned');
  });
});

describe('takeover of a claimable lease', () => {
  it('scenario: 181 s after an unrenewed claim, claim --ttl takes over with supersedes', () => {
    const id = lock();
    const claim = leased(id);
    at(181_000);
    const out = claimTicket(board, 'merger-2', { id, ttl: 1_800_000 });
    expect(out.ticket.assignee).toBe('merger-2');
    const event = eventOf(out.hash);
    expect(event.body).toEqual({
      lease: { ttl: 1_800_000, grace: 120_000, expiresAt: T + 181_000 + 120_000 },
      supersedes: { holder: 'merger-1', expiresAt: T + 120_000, event: claim },
    });
    expect(out.ticket.lease).toEqual({
      ttl: 1_800_000,
      expiresAt: T + 301_000,
      event: out.hash,
      confirmed: false,
    });
  });

  it('is accepted at exactly expiresAt + 60000 and refused 1 ms before', () => {
    const id = lock();
    leased(id);
    at(179_999);
    refused(() => claimTicket(board, 'merger-2', { id, ttl: 60_000 }), 4, 'already-assigned');
    at(180_000);
    const out = claimTicket(board, 'merger-2', { id, ttl: 60_000 });
    expect(eventOf(out.hash).ts.wall).toBe(T + 180_000);
    expect(out.ticket.assignee).toBe('merger-2');
  });

  it('is refused when the hybrid wall is past the tolerance but the local clock is not', () => {
    const id = lock();
    const other = lock();
    leased(id);
    // A folded event from a clock 400 s fast: the next hybrid wall is T + 400000.
    putEvent(board.eventsDir, ev(P.comment(other, 'fast'), 'remote', T + 400_000));
    at(100_000);
    // Fold it first, so the refusal below has nothing to catch up.
    catchUp(board);
    refused(() => claimTicket(board, 'merger-2', { id, ttl: 60_000 }), 4, 'already-assigned');
    // The fold would accept a takeover by its wall alone; the writer is stricter.
    expect(showTicket(board, id).ticket.assignee).toBe('merger-1');
  });

  it('scenario: takeover needs a ttl (exit 1 usage naming --ttl, nothing written)', () => {
    const id = lock();
    leased(id);
    at(181_000);
    const err = refused(() => claimTicket(board, 'merger-2', { id }), 1, 'usage');
    expect(err.message).toContain('--ttl');
    expect(showTicket(board, id).ticket.assignee).toBe('merger-1');
  });

  it('names the renew that set a renewed lease', () => {
    const id = lock();
    leased(id);
    at(60_000);
    const renew = renewTicket(board, 'merger-1', { id, ttl: 60_000 });
    at(60_000 + 60_000 + 60_000);
    const out = claimTicket(board, 'merger-2', { id, ttl: 60_000 });
    expect(eventOf(out.hash).body).toMatchObject({
      supersedes: { holder: 'merger-1', expiresAt: T + 120_000, event: renew.hash },
    });
  });

  it('names an unaccepted grant after catch-up wrote it in the same command', () => {
    const id = lock();
    claimTicket(board, 'merger-1', { id });
    at(1000);
    claimTicket(board, 'merger-2', { id, ttl: 60_000, wait: true });
    at(2000);
    const release = releaseTicket(board, 'merger-1', { id });
    // Grant to merger-2 at 2001 with the default window; it lapses at 122001
    // and is claimable from 182001. One command catches the grant up and
    // takes it over.
    at(182_001);
    const out = claimTicket(board, 'merger-3', { id, ttl: 60_000 });
    const grantHash = eventNames(board.eventsDir)
      .map((name) => name.slice(0, -5))
      .find((hash) => eventOf(hash).kind === 'ticket.grant');
    expect(grantHash).toBeDefined();
    expect(eventOf(grantHash ?? null)).toMatchObject({
      actor: 'agentboard',
      ts: { wall: T + 2001, counter: 0, actor: 'agentboard' },
      body: { to: 'merger-2', ttl: 60_000, window: 120_000, after: { released: release.hash } },
    });
    expect(eventOf(out.hash).body).toMatchObject({
      supersedes: { holder: 'merger-2', expiresAt: T + 122_001, event: grantHash },
    });
    expect(out.ticket.assignee).toBe('merger-3');
  });
});

describe('claim with wait (non-blocking join)', () => {
  it('on a held ticket writes ticket.queue.join {ttl} and returns exactly {queued, position, holder, ticket}', () => {
    const id = lock();
    claimTicket(board, 'merger-1', { id });
    at(1000);
    const out = claimTicket(board, 'merger-2', { id, ttl: 1_800_000, wait: true });
    expect(out).toEqual({ queued: true, position: 1, holder: 'merger-1', ticket: id });
    expect(Object.keys(out)).toEqual(['queued', 'position', 'holder', 'ticket']);
    const joins = eventNames(board.eventsDir)
      .map((name) => eventOf(name.slice(0, -5)))
      .filter((e) => e.kind === 'ticket.queue.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ actor: 'merger-2', ticket: id, body: { ttl: 1_800_000 } });
    expect(showTicket(board, id).ticket.queue.map((w) => w.actor)).toEqual(['merger-2']);
  });

  it('the second waiter is at position 2; a repeated wait writes nothing and keeps the position', () => {
    const id = lock();
    leased(id);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    const out = claimTicket(board, 'merger-3', { id, ttl: 600_000, wait: true });
    expect(out).toEqual({ queued: true, position: 2, holder: 'merger-1', ticket: id });
    const before = eventNames(board.eventsDir);
    expect(claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true })).toEqual({
      queued: true,
      position: 1,
      holder: 'merger-1',
      ticket: id,
    });
    expect(eventNames(board.eventsDir)).toEqual(before);
  });

  it('on a free ticket with an empty queue claims at once with the lease, queued false', () => {
    const id = lock();
    const out = claimTicket(board, 'merger-1', { id, ttl: 1_800_000, wait: true });
    expect(out).toMatchObject({ queued: false, ticket: { assignee: 'merger-1' } });
    if (out.queued !== true) {
      expect(eventOf(out.hash)).toMatchObject({
        kind: 'ticket.claim',
        body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: T + 120_000 } },
      });
    }
  });

  it('on a claimable lease with an empty queue joins, and the lapse grant follows at join wall + 1', () => {
    const id = lock();
    const claim = leased(id);
    at(200_000);
    const out = claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    expect(out).toEqual({ queued: true, position: 1, holder: 'merger-1', ticket: id });
    at(200_001);
    // The next command catches the grant up (here a repeated wait, which
    // then finds merger-2 holding the ticket and writes nothing of its own).
    expect(claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true })).toMatchObject({
      hash: null,
      queued: false,
      ticket: { assignee: 'merger-2', queue: [] },
    });
    const grant = eventNames(board.eventsDir)
      .map((name) => eventOf(name.slice(0, -5)))
      .find((e) => e.kind === 'ticket.grant');
    expect(grant).toMatchObject({
      ts: { wall: T + 200_001, counter: 0, actor: 'agentboard' },
      body: {
        to: 'merger-2',
        ttl: 600_000,
        after: { lease: { holder: 'merger-1', expiresAt: T + 120_000, event: claim } },
      },
    });
  });

  it('scenario: a claim without wait while others wait is refused queued, naming the count', () => {
    const id = lock();
    leased(id);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    claimTicket(board, 'merger-3', { id, ttl: 600_000, wait: true });
    const err = refused(() => claimTicket(board, 'merger-4', { id }), 4, 'queued');
    expect(err).toBeInstanceOf(ClaimRefusedError);
    expect(err.message).toBe(`ticket ${id} has 2 actor(s) waiting for it, who have priority`);
    // A takeover of the lapsed lease cannot jump the queue either: at 200 s
    // the catch-up grants the ticket to merger-2, and merger-3 still waits.
    at(200_000);
    expectBoardError(() => claimTicket(board, 'merger-4', { id, ttl: 60_000 }), 4, 'queued');
    expect(showTicket(board, id).ticket.assignee).toBe('merger-2');
  });
});

describe('renew', () => {
  it('scenario: renew confirms with the requested ttl', () => {
    const id = lock();
    leased(id);
    at(60_000);
    const out = renewTicket(board, 'merger-1', { id });
    expect(eventOf(out.hash)).toMatchObject({
      kind: 'ticket.renew',
      actor: 'merger-1',
      body: { ttl: 1_800_000, expiresAt: T + 60_000 + 1_800_000 },
    });
    expect(out.ticket.lease).toEqual({
      ttl: 1_800_000,
      expiresAt: T + 1_860_000,
      event: out.hash,
      confirmed: true,
    });
  });

  it('with --ttl sets the lease to that ttl from the renew', () => {
    const id = lock();
    leased(id);
    const out = renewTicket(board, 'merger-1', { id, ttl: 3_600_000 });
    expect(eventOf(out.hash).body).toEqual({ ttl: 3_600_000, expiresAt: T + 3_600_000 });
  });

  it('after expiry, with nothing taken over, is accepted and confirms', () => {
    const id = lock();
    leased(id);
    at(10_000_000);
    const out = renewTicket(board, 'merger-1', { id });
    expect(out.ticket.lease).toMatchObject({
      confirmed: true,
      expiresAt: T + 10_000_000 + 1_800_000,
    });
  });

  it('scenario: renew by someone else is exit 4 not-assignee and writes nothing', () => {
    const id = lock();
    leased(id);
    refused(() => renewTicket(board, 'merger-2', { id }), 4, 'not-assignee');
  });

  it('renew of an unassigned ticket is not-assignee', () => {
    const id = lock();
    refused(() => renewTicket(board, 'merger-1', { id, ttl: 60_000 }), 4, 'not-assignee');
  });

  it('renew without --ttl on a hold with no lease is exit 1 usage; with --ttl it starts a confirmed lease', () => {
    const id = lock();
    claimTicket(board, 'impl', { id });
    const err = refused(() => renewTicket(board, 'impl', { id }), 1, 'usage');
    expect(err.message).toContain('--ttl');
    const out = renewTicket(board, 'impl', { id, ttl: 600_000 });
    expect(out.ticket.lease).toMatchObject({
      ttl: 600_000,
      confirmed: true,
      expiresAt: T + 600_000,
    });
  });

  it('a grantee accepts its grant by renewing with the ttl it asked for', () => {
    const id = lock();
    claimTicket(board, 'merger-1', { id });
    claimTicket(board, 'merger-2', { id, ttl: 900_000, wait: true });
    at(1000);
    releaseTicket(board, 'merger-1', { id });
    at(2000);
    const out = renewTicket(board, 'merger-2', { id });
    expect(eventOf(out.hash).body).toEqual({ ttl: 900_000, expiresAt: T + 2000 + 900_000 });
    expect(out.ticket).toMatchObject({ assignee: 'merger-2', lease: { confirmed: true } });
  });

  it.each([1000, 604_800_001])('a ttl of %d is a usage error', (ttl) => {
    const id = lock();
    leased(id);
    refused(() => renewTicket(board, 'merger-1', { id, ttl }), 1, 'usage');
  });
});

describe('unqueue', () => {
  it('scenario: leave the queue', () => {
    const id = lock();
    leased(id);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    claimTicket(board, 'merger-3', { id, ttl: 600_000, wait: true });
    const out = unqueueTicket(board, 'merger-3', { id });
    expect(eventOf(out.hash)).toMatchObject({
      kind: 'ticket.queue.leave',
      actor: 'merger-3',
      body: {},
    });
    expect(out.ticket.queue.map((w) => w.actor)).toEqual(['merger-2']);
  });

  it('an actor that is not queued is exit 4 invalid-queue and nothing is written', () => {
    const id = lock();
    leased(id);
    refused(() => unqueueTicket(board, 'merger-3', { id }), 4, 'invalid-queue');
  });
});

describe('forced release', () => {
  it('scenario: orchestrator breaks a stale lock (no waiters: no assignee, status unchanged)', () => {
    const id = lock();
    moveTicket(board, 'orchestrator', { id, to: 'tests' });
    leased(id);
    at(5000);
    const out = releaseTicket(board, 'orchestrator', {
      id,
      force: true,
      reason: 'merger-1 crashed',
    });
    expect(eventOf(out.hash)).toMatchObject({
      kind: 'ticket.release.force',
      actor: 'orchestrator',
      body: { holder: 'merger-1', reason: 'merger-1 crashed' },
    });
    expect(out.ticket).toMatchObject({ assignee: null, lease: null, status: 'tests' });
  });

  it('with waiters, the grant to the head waiter is due at once after the forced release', () => {
    const id = lock();
    leased(id);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    at(5000);
    const out = releaseTicket(board, 'orchestrator', { id, force: true, reason: 'stalled' });
    expect(out.ticket.assignee).toBeNull();
    expect(out.ticket.queue.map((w) => w.actor)).toEqual(['merger-2']);
    at(5001);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    const grant = eventNames(board.eventsDir)
      .map((name) => eventOf(name.slice(0, -5)))
      .find((e) => e.kind === 'ticket.grant');
    expect(grant).toMatchObject({
      ts: { wall: T + 5001 },
      body: { to: 'merger-2', after: { released: out.hash } },
    });
  });

  it('works without a lease and for any actor (no allowlist)', () => {
    const id = lock();
    claimTicket(board, 'impl', { id });
    const out = releaseTicket(board, 'merger-9', { id, force: true, reason: 'impl is gone' });
    expect(out.ticket.assignee).toBeNull();
  });

  it('scenario: force without a reason, or with an empty one, is exit 1 usage and writes nothing', () => {
    const id = lock();
    leased(id);
    refused(() => releaseTicket(board, 'orchestrator', { id, force: true }), 1, 'usage');
    refused(
      () => releaseTicket(board, 'orchestrator', { id, force: true, reason: '' }),
      1,
      'usage',
    );
  });

  it('a reason without force is exit 1 usage', () => {
    const id = lock();
    leased(id);
    refused(() => releaseTicket(board, 'merger-1', { id, reason: 'done' }), 1, 'usage');
  });

  it('scenario: force by the holder is exit 1 usage naming plain release', () => {
    const id = lock();
    leased(id);
    const err = refused(
      () => releaseTicket(board, 'merger-1', { id, force: true, reason: 'x' }),
      1,
      'usage',
    );
    expect(err.message).toContain('without --force');
  });

  it('force on an unassigned ticket is exit 4 not-assignee', () => {
    const id = lock();
    refused(
      () => releaseTicket(board, 'orchestrator', { id, force: true, reason: 'x' }),
      4,
      'not-assignee',
    );
  });

  it('a secret-looking reason is refused like comment text, unless allowSecretLike', () => {
    const id = lock();
    leased(id);
    const reason = `stalled ${SAMPLES['github-token']}`;
    const err = refused(
      () => releaseTicket(board, 'orchestrator', { id, force: true, reason }),
      1,
      'secret-like',
    );
    expect(err.message).not.toContain(SAMPLES['github-token']);
    const out = releaseTicket(board, 'orchestrator', {
      id,
      force: true,
      reason,
      allowSecretLike: true,
    });
    expect(eventOf(out.hash).body).toEqual({ holder: 'merger-1', reason });
  });

  it('a plain release by the holder is unchanged', () => {
    const id = lock();
    leased(id);
    const out = releaseTicket(board, 'merger-1', { id });
    expect(eventOf(out.hash)).toMatchObject({ kind: 'ticket.release', body: {} });
    expect(out.ticket).toMatchObject({ assignee: null, lease: null });
  });
});

describe('config set and config get', () => {
  it('scenario: set the acceptance window', () => {
    const out = setConfig(board, 'orchestrator', { key: 'queue.window', value: 300_000 });
    expect(out).toEqual({ hash: out.hash, key: 'queue.window', value: 300_000 });
    expect(eventOf(out.hash)).toMatchObject({
      kind: 'board.meta',
      actor: 'orchestrator',
      body: { key: 'queue.window', value: 300_000 },
    });
    expect(getConfig(board, 'queue.window')).toEqual({
      settings: [{ key: 'queue.window', value: 300_000, default: false }],
    });
  });

  it('get with no key reports both, marking defaults', () => {
    expect(getConfig(board)).toEqual({
      settings: [
        { key: 'lease.grace', value: 120_000, default: true },
        { key: 'queue.window', value: 120_000, default: true },
      ],
    });
    setConfig(board, 'orchestrator', { key: 'lease.grace', value: 60_000 });
    expect(getConfig(board)).toEqual({
      settings: [
        { key: 'lease.grace', value: 60_000, default: false },
        { key: 'queue.window', value: 120_000, default: true },
      ],
    });
  });

  it('a stored value the fold ignores is reported as the default', () => {
    runCommand(board, 'orchestrator', propose(P.meta('queue.window', 5000)));
    expect(getConfig(board, 'queue.window')).toEqual({
      settings: [{ key: 'queue.window', value: 120_000, default: true }],
    });
  });

  it('scenario: unknown key is exit 1 usage listing the two keys, nothing written', () => {
    const err = refused(
      () => setConfig(board, 'orchestrator', { key: 'columns', value: 60_000 }),
      1,
      'usage',
    );
    expect(err.message).toContain('lease.grace');
    expect(err.message).toContain('queue.window');
    expect(err.message).toContain('columns');
    const get = expectBoardError(() => getConfig(board, 'columns'), 1, 'usage');
    expect(get.message).toContain('lease.grace');
  });

  it.each([29_999, 600_001, 0, 1.5])('a value of %d is exit 1 usage', (value) => {
    refused(() => setConfig(board, 'orchestrator', { key: 'lease.grace', value }), 1, 'usage');
  });

  it('the grace setting applies to later leased claims', () => {
    const id = lock();
    setConfig(board, 'orchestrator', { key: 'lease.grace', value: 30_000 });
    const out = claimTicket(board, 'merger-1', { id, ttl: 1_800_000 });
    expect(eventOf(out.hash).body).toEqual({
      lease: { ttl: 1_800_000, grace: 30_000, expiresAt: T + 30_000 },
    });
  });

  it('the window setting applies to later grants', () => {
    const id = lock();
    setConfig(board, 'orchestrator', { key: 'queue.window', value: 300_000 });
    claimTicket(board, 'merger-1', { id });
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    at(1000);
    releaseTicket(board, 'merger-1', { id });
    at(1001);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    const grant = eventNames(board.eventsDir)
      .map((name) => eventOf(name.slice(0, -5)))
      .find((e) => e.kind === 'ticket.grant');
    expect(grant).toMatchObject({ body: { to: 'merger-2', window: 300_000 } });
  });
});

describe('the show document of a leased ticket', () => {
  it('carries the lease state at the given clock', () => {
    const id = lock();
    leased(id);
    expect(showTicket(board, id, { now: T + 119_999 }).ticket.lease).toMatchObject({
      state: 'live',
      claimableAt: T + 180_000,
    });
    expect(showTicket(board, id, { now: T + 120_000 }).ticket.lease?.state).toBe('expired');
    expect(showTicket(board, id, { now: T + 180_000 }).ticket.lease?.state).toBe('claimable');
  });
});

describe('pinned by review round 1', () => {
  it('a claim that writes nothing (NoWrite) still commits the grant its catch-up wrote', () => {
    const id = lock();
    claimTicket(board, 'merger-1', { id });
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    at(1000);
    releaseTicket(board, 'merger-1', { id });
    at(2000);
    // The catch-up writes the grant to merger-2, who then already holds the
    // ticket: the claim itself writes nothing.
    const out = claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    expect(out).toMatchObject({ hash: null, queued: false, ticket: { assignee: 'merger-2' } });
    const grants = eventNames(board.eventsDir).filter(
      (name) => eventOf(name.slice(0, -5)).kind === 'ticket.grant',
    );
    expect(grants).toHaveLength(1);
    // The cache committed it: a read without catch-up sees the grantee, and
    // a fresh open reads no event file for it.
    expect(showTicket(board, id).ticket).toMatchObject({ assignee: 'merger-2', queue: [] });
    const read: string[] = [];
    const fresh = openBoard(board.dir, { onReadEventFile: (name) => read.push(name) });
    try {
      expect(read).toEqual([]);
      expect(dumpCache(fresh.db)).toEqual(dumpCache(board.db));
    } finally {
      fresh.close();
    }
  });

  it('show reports no takeover for a claim with supersedes applied on a free ticket', () => {
    const id = lock();
    putEvent(
      board.eventsDir,
      ev(
        {
          kind: 'ticket.claim',
          ticket: id,
          body: { supersedes: { holder: 'gone', expiresAt: T - 500_000, event: 'b'.repeat(64) } },
        },
        'merger-2',
        T + 1000,
      ),
    );
    at(2000);
    catchUp(board);
    const shown = showTicket(board, id);
    expect(shown.ticket.assignee).toBe('merger-2');
    expect(shown.takeover).toBeUndefined();
  });

  it('show drops the granted line once the grantee renews', () => {
    const id = lock();
    claimTicket(board, 'merger-1', { id });
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    at(1000);
    releaseTicket(board, 'merger-1', { id });
    at(2000);
    catchUp(board);
    expect(showTicket(board, id).grant).toEqual({
      to: 'merger-2',
      at: T + 1001,
      acceptBy: T + 1001 + 120_000,
    });
    at(3000);
    renewTicket(board, 'merger-2', { id });
    expect(showTicket(board, id).grant).toBeUndefined();
  });

  it('show reports the most recent takeover of a ticket taken over twice', () => {
    const id = lock();
    leased(id, 'merger-1', 60_000);
    at(180_000);
    claimTicket(board, 'merger-2', { id, ttl: 60_000 });
    // merger-2's grace lease expires at 180000 + 60000 and is claimable 60 s later.
    at(300_000);
    const second = claimTicket(board, 'merger-3', { id, ttl: 60_000 });
    expect(showTicket(board, id).takeover).toEqual({
      actor: 'merger-3',
      at: T + 300_000,
      holder: 'merger-2',
      expiresAt: T + 240_000,
      event: second.hash,
    });
  });

  it('renew sets expiresAt from the hybrid wall when a folded event put it ahead of the clock', () => {
    const id = lock();
    const other = lock();
    leased(id);
    // A folded event from a clock 500 s fast: the renew's wall is T + 500000.
    putEvent(board.eventsDir, ev(P.comment(other, 'fast'), 'remote', T + 500_000));
    at(1000);
    const out = renewTicket(board, 'merger-1', { id });
    const event = eventOf(out.hash);
    expect(event.ts).toEqual({ wall: T + 500_000, counter: 1, actor: 'merger-1' });
    expect(event.body).toEqual({ ttl: 1_800_000, expiresAt: T + 500_000 + 1_800_000 });
  });
});
