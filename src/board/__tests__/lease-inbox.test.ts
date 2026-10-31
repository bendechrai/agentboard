/**
 * Lease and queue events in the inbox (add-claim-leases task 3.2;
 * board-cli: "Lease and queue events in the inbox"): `affects` is the
 * previous holder of a forced release, a takeover and a grant after a
 * lapse, and null otherwise; a grant's `to` is the grantee; a forced
 * release's `note` is its reason. Through `readInbox`, with the clock
 * injected through vitest fake timers (`Date` only) and the events written
 * as files at fixed walls.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { TicketGrantEvent } from '../../events/schema.js';
import { openBoard, type Board } from '../../store/board.js';
import { P, T1, ev, putEvent, tempBoard } from '../../store/__tests__/helpers.js';
import { readInbox, type InboxEntry } from '../inbox.js';

const open: Board[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
  vi.useRealTimers();
});

function openAt(dir: string, now: number): Board {
  vi.setSystemTime(now);
  const board = openBoard(dir, { now });
  open.push(board);
  return board;
}

function entryOf(entries: readonly InboxEntry[], hash: string): InboxEntry | undefined {
  return entries.find((e) => e.hash === hash);
}

describe('scenario: previous holder is told', () => {
  it('a forced release: affects the holder, note the reason', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orchestrator', 1000));
    putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
    const force = putEvent(
      events,
      ev(
        {
          kind: 'ticket.release.force',
          ticket: T1,
          body: { holder: 'merger-1', reason: 'stalled' },
        },
        'orchestrator',
        3000,
      ),
    );
    const entries = readInbox(openAt(dir, 4000), 'merger-1').entries;
    expect(entryOf(entries, force)).toMatchObject({
      kind: 'ticket.release.force',
      from: 'orchestrator',
      to: null,
      status: null,
      note: 'stalled',
      affects: 'merger-1',
    });
  });

  it('a takeover: affects the holder whose lease was taken over', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orchestrator', 1000));
    const claim = putEvent(
      events,
      ev(
        {
          kind: 'ticket.claim',
          ticket: T1,
          body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: 122_000 } },
        },
        'merger-1',
        2000,
      ),
    );
    const takeover = putEvent(
      events,
      ev(
        {
          kind: 'ticket.claim',
          ticket: T1,
          body: {
            lease: { ttl: 60_000, grace: 120_000, expiresAt: 242_000 },
            supersedes: { holder: 'merger-1', expiresAt: 122_000, event: claim },
          },
        },
        'merger-2',
        182_000,
      ),
    );
    const entries = readInbox(openAt(dir, 183_000), 'merger-1').entries;
    expect(entryOf(entries, takeover)).toMatchObject({
      kind: 'ticket.claim',
      from: 'merger-2',
      affects: 'merger-1',
    });
    expect(entryOf(entries, claim)).toMatchObject({ affects: null });
  });

  it('a grant after a lapse: affects the holder of the lapsed lease, to the grantee', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orchestrator', 1000));
    const claim = putEvent(
      events,
      ev(
        {
          kind: 'ticket.claim',
          ticket: T1,
          body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: 122_000 } },
        },
        'merger-1',
        2000,
      ),
    );
    putEvent(
      events,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
    );
    // The lapse grant is due at 122000 + 60000 + 1; the inbox call writes it.
    const grant: TicketGrantEvent = {
      v: 1,
      kind: 'ticket.grant',
      ticket: T1,
      actor: 'agentboard',
      ts: { wall: 182_001, counter: 0, actor: 'agentboard' },
      body: {
        to: 'merger-2',
        ttl: 600_000,
        window: 120_000,
        after: { lease: { holder: 'merger-1', expiresAt: 122_000, event: claim } },
      },
    };
    const board = openAt(dir, 182_000);
    vi.setSystemTime(182_001);
    const forHolder = readInbox(board, 'merger-1').entries;
    expect(entryOf(forHolder, canonicalHash(grant))).toMatchObject({
      kind: 'ticket.grant',
      from: 'agentboard',
      to: 'merger-2',
      affects: 'merger-1',
      note: null,
    });
  });
});

describe('scenario: grantee is told', () => {
  it('a grant after a release: to the grantee, affects null', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orchestrator', 1000));
    putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
    putEvent(
      events,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
    );
    const release = putEvent(
      events,
      ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', 5000),
    );
    const grant: TicketGrantEvent = {
      v: 1,
      kind: 'ticket.grant',
      ticket: T1,
      actor: 'agentboard',
      ts: { wall: 5001, counter: 0, actor: 'agentboard' },
      body: { to: 'merger-2', ttl: 600_000, window: 120_000, after: { released: release } },
    };
    const entries = readInbox(openAt(dir, 5001), 'merger-2').entries;
    expect(entryOf(entries, canonicalHash(grant))).toMatchObject({
      kind: 'ticket.grant',
      to: 'merger-2',
      affects: null,
      status: null,
      note: null,
    });
    expect(entryOf(entries, release)).toMatchObject({
      kind: 'ticket.release',
      to: null,
      affects: null,
    });
  });

  it('joins, leaves and renews carry no to, note or affects', () => {
    const dir = tempBoard();
    const events = join(dir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orchestrator', 1000));
    putEvent(
      events,
      ev(
        {
          kind: 'ticket.claim',
          ticket: T1,
          body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: 122_000 } },
        },
        'merger-1',
        2000,
      ),
    );
    const renew = putEvent(
      events,
      ev(
        { kind: 'ticket.renew', ticket: T1, body: { ttl: 1_800_000, expiresAt: 1_803_000 } },
        'merger-1',
        3000,
      ),
    );
    const joined = putEvent(
      events,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 4000),
    );
    const left = putEvent(
      events,
      ev({ kind: 'ticket.queue.leave', ticket: T1, body: {} }, 'merger-2', 5000),
    );
    const entries = readInbox(openAt(dir, 6000), 'x').entries;
    for (const hash of [renew, joined, left]) {
      expect(entryOf(entries, hash)).toMatchObject({
        to: null,
        status: null,
        note: null,
        affects: null,
      });
    }
  });
});
