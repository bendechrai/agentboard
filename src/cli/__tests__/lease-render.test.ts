/**
 * Rendering leases and queues, pure (add-claim-leases task 3.2; board-cli:
 * "Leases on the command line", "Lease and queue events in the inbox",
 * "Board settings command"): the `list` line with a clock reading, the
 * `show` lease, grant, queue, takeover and forced-release lines, the
 * `GRANTED: ` and `LOST: ` inbox prefixes, and `config get`.
 */

import { describe, expect, it } from 'vitest';

import type { InboxEntry } from '../../board/inbox.js';
import type { ShowResult, TicketDocument } from '../../board/tickets.js';
import type { BoardEvent } from '../../events/schema.js';
import { renderConfig, renderInboxLine, renderListLine, renderShow } from '../render.js';

const ID = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const TS = { wall: 1000, counter: 0, actor: 'orch' };
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const H = 'a'.repeat(64);

function doc(extra: Partial<TicketDocument> = {}): TicketDocument {
  return {
    id: ID,
    title: 'Merge lock',
    description: null,
    status: 'todo',
    blockedFrom: null,
    assignee: null,
    lease: null,
    queue: [],
    available: null,
    labels: [],
    task: null,
    adhoc: 'merge lock',
    unplanned: null,
    checklist: [],
    comments: [],
    links: [],
    closed: false,
    superseded: null,
    disposition: null,
    createdBy: 'orch',
    createdAt: TS,
    version: 1,
    updatedAt: TS,
    ...extra,
  };
}

describe('renderListLine with a clock reading', () => {
  it('scenario: the assignee token merger-1*+2m', () => {
    const ticket = doc({
      assignee: 'merger-1',
      lease: {
        ttl: 1_800_000,
        expiresAt: NOW + 120_000,
        event: H,
        confirmed: false,
        state: 'live',
        claimableAt: NOW + 180_000,
      },
    });
    expect(renderListLine(ticket, NOW)).toBe(`${ID}  todo  merger-1*+2m  [adhoc] Merge lock`);
    // Without a clock reading the assignee is printed alone, as before.
    expect(renderListLine(ticket)).toBe(`${ID}  todo  merger-1  [adhoc] Merge lock`);
  });

  it('the queue suffix, for a free ticket too', () => {
    const waiter = { actor: 'w', ttl: 60_000, event: H, joined: TS };
    expect(renderListLine(doc({ assignee: 'impl', queue: [waiter, waiter] }), NOW)).toBe(
      `${ID}  todo  impl^2  [adhoc] Merge lock`,
    );
    expect(renderListLine(doc({ queue: [waiter] }), NOW)).toBe(
      `${ID}  todo  -^1  [adhoc] Merge lock`,
    );
  });

  it('a ticket without lease or queue is unchanged with a clock reading', () => {
    expect(renderListLine(doc({ assignee: 'impl' }), NOW)).toBe(
      `${ID}  todo  impl  [adhoc] Merge lock`,
    );
  });
});

function show(extra: Partial<ShowResult>, ticket: Partial<TicketDocument> = {}): string[] {
  return renderShow({ ticket: doc(ticket), events: 4, unknown: [], ...extra }).split('\n');
}

describe('renderShow lease lines', () => {
  const lease = {
    ttl: 1_800_000,
    expiresAt: NOW + 120_000,
    event: H,
    confirmed: false,
    state: 'live' as const,
    claimableAt: NOW + 180_000,
  };

  it('the lease line follows the assignee line: state, grace while unconfirmed, ttl, expiry, claimable time', () => {
    const lines = show({}, { assignee: 'merger-1', lease });
    const at = lines.indexOf('assignee: merger-1');
    expect(lines[at + 1]).toBe(
      `lease: live (grace), ttl 30m, expires ${iso(NOW + 120_000)}, claimable from ${iso(NOW + 180_000)}`,
    );
    expect(lines[at + 2]).toBe('adhoc: merge lock');
  });

  it('a confirmed lease has no (grace); the states expired and claimable', () => {
    for (const state of ['live', 'expired', 'claimable'] as const) {
      const lines = show(
        {},
        { assignee: 'h', lease: { ...lease, confirmed: true, ttl: 90_000, state } },
      );
      expect(lines).toContain(
        `lease: ${state}, ttl 90s, expires ${iso(NOW + 120_000)}, claimable from ${iso(NOW + 180_000)}`,
      );
    }
  });

  it('granted, next grant, queue, takeover and forced release, in that order after the lease', () => {
    const lines = show(
      {
        grant: { to: 'merger-6', at: NOW - 1000, acceptBy: NOW + 119_000 },
        nextGrant: { to: 'merger-2', at: NOW + 180_001, acceptBy: NOW + 300_001 },
        takeover: {
          actor: 'merger-6',
          at: NOW - 5000,
          holder: 'merger-5',
          expiresAt: NOW - 70_000,
          event: H,
        },
        forcedRelease: {
          actor: 'orchestrator',
          at: NOW - 9000,
          holder: 'merger-4',
          reason: 'merger-4 crashed',
          event: H,
        },
      },
      {
        assignee: 'merger-6',
        lease,
        queue: [
          {
            actor: 'merger-2',
            ttl: 1_800_000,
            event: H,
            joined: { wall: NOW - 50_000, counter: 0, actor: 'merger-2' },
          },
          {
            actor: 'merger-3',
            ttl: 3_600_000,
            event: H,
            joined: { wall: NOW - 40_000, counter: 2, actor: 'merger-3' },
          },
        ],
      },
    );
    const at = lines.indexOf('assignee: merger-6');
    expect(lines.slice(at + 1, at + 9)).toEqual([
      `lease: live (grace), ttl 30m, expires ${iso(NOW + 120_000)}, claimable from ${iso(NOW + 180_000)}`,
      `granted: merger-6 at ${iso(NOW - 1000)}, accept by ${iso(NOW + 119_000)}`,
      `next grant: merger-2 at ${iso(NOW + 180_001)}, accept by ${iso(NOW + 300_001)}`,
      'queue:',
      `  1 merger-2 (joined ${iso(NOW - 50_000)}, ttl 30m)`,
      `  2 merger-3 (joined ${iso(NOW - 40_000)}, ttl 1h)`,
      `takeover: merger-6 at ${iso(NOW - 5000)} from merger-5 (lease expired ${iso(NOW - 70_000)})`,
      `forced release: orchestrator at ${iso(NOW - 9000)} from merger-4: merger-4 crashed`,
    ]);
  });

  it('user text in these lines passes through asciiText', () => {
    const E = String.fromCharCode(0xe9);
    const lines = show({
      forcedRelease: { actor: `r${E}`, at: NOW, holder: `h${E}`, reason: `caf${E}`, event: H },
    });
    expect(lines).toContain(`forced release: r\\u00E9 at ${iso(NOW)} from h\\u00E9: caf\\u00E9`);
  });
});

/** Any event: the line is built from the entry's lifted fields only. */
const EVENT: BoardEvent = {
  v: 1,
  kind: 'ticket.comment',
  ticket: ID,
  actor: 'x',
  ts: TS,
  body: { text: 'x' },
};

function entry(extra: Partial<InboxEntry>): InboxEntry {
  return {
    hash: H,
    kind: 'ticket.comment',
    ticket: ID,
    from: 'x',
    ts: TS,
    to: null,
    status: null,
    note: null,
    affects: null,
    event: EVENT,
    ...extra,
  };
}

describe('renderInboxLine prefixes', () => {
  it('scenario: grantee is told (GRANTED: for a grant to the reader)', () => {
    const grant = entry({ kind: 'ticket.grant', from: 'agentboard', to: 'merger-2' });
    expect(renderInboxLine(grant, 'merger-2')).toBe(
      `GRANTED: ${ID}  ticket.grant  agentboard  to merger-2`,
    );
    expect(renderInboxLine(grant, 'merger-3')).toBe(`${ID}  ticket.grant  agentboard  to merger-2`);
    expect(renderInboxLine(grant)).toBe(`${ID}  ticket.grant  agentboard  to merger-2`);
  });

  it('a hand-off to the reader is not a grant', () => {
    expect(
      renderInboxLine(entry({ kind: 'ticket.handoff', to: 'r', status: 'review', note: 'n' }), 'r'),
    ).toBe(`${ID}  ticket.handoff  x  to r  status review  note n`);
  });

  it('scenario: previous holder is told (LOST: when affects is the reader)', () => {
    const force = entry({
      kind: 'ticket.release.force',
      from: 'orchestrator',
      note: 'stalled',
      affects: 'merger-1',
    });
    expect(renderInboxLine(force, 'merger-1')).toBe(
      `LOST: ${ID}  ticket.release.force  orchestrator  note stalled`,
    );
    expect(renderInboxLine(force, 'merger-2')).toBe(
      `${ID}  ticket.release.force  orchestrator  note stalled`,
    );
    const takeover = entry({ kind: 'ticket.claim', from: 'merger-2', affects: 'merger-1' });
    expect(renderInboxLine(takeover, 'merger-1')).toBe(`LOST: ${ID}  ticket.claim  merger-2`);
  });
});

describe('renderConfig', () => {
  const settings = [
    { key: 'lease.grace' as const, value: 120_000, default: true },
    { key: 'queue.window' as const, value: 300_000, default: false },
  ];

  it('both keys, defaults marked', () => {
    expect(renderConfig({ settings }, false)).toBe('lease.grace 2m (default)\nqueue.window 5m\n');
  });

  it('one key: the value alone', () => {
    expect(
      renderConfig({ settings: [{ key: 'queue.window', value: 300_000, default: false }] }, true),
    ).toBe('5m\n');
    expect(
      renderConfig({ settings: [{ key: 'lease.grace', value: 90_000, default: false }] }, true),
    ).toBe('90s\n');
    expect(
      renderConfig({ settings: [{ key: 'lease.grace', value: 120_000, default: true }] }, true),
    ).toBe('2m (default)\n');
  });
});
