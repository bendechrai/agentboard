/**
 * Due grants written by CLI commands (add-claim-leases task 2.1; board-cli:
 * "Due grants are written during catch-up"): every command that catches
 * up, read-only ones included, writes the grants due at its clock, while
 * `rebuild` and `rebuild --check` never do, and a read-only command with
 * nothing due takes no write lock.
 *
 * The CLI runs in process with an injected clock (vitest fake timers,
 * `Date` only), except for the lock test, which uses the real clock with
 * a board where nothing can become due while it runs.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { Ticket } from '../../events/fold.js';
import type { TicketGrantEvent } from '../../events/schema.js';
import { P, T1, ev, eventNames, putEvent } from '../../store/__tests__/helpers.js';
import { oneJson, project, run } from './cli-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `merger-1` claimed T1 at 2000, `merger-2` joined at 3000 asking for
 * 600000, and `merger-1` released at 5000, written as files with no cache:
 * no command has run. The grant to `merger-2` is due at 5001.
 */
function seed(): { root: string; events: string; g: TicketGrantEvent } {
  const { root, boardDir } = project();
  const events = join(boardDir, 'events');
  putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
  putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
  putEvent(
    events,
    ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
  );
  const release = putEvent(
    events,
    ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', 5000),
  );
  const g: TicketGrantEvent = {
    v: 1,
    kind: 'ticket.grant',
    ticket: T1,
    actor: 'agentboard',
    ts: { wall: 5001, counter: 0, actor: 'agentboard' },
    body: { to: 'merger-2', ttl: 600_000, window: 120_000, after: { released: release } },
  };
  return { root, events, g };
}

interface InboxDoc {
  entries: { hash: string; kind: string; event: unknown }[];
}

function inbox(root: string, actor: string): InboxDoc {
  const out = run(['inbox', '--as', actor, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return oneJson(out) as InboxDoc;
}

function show(root: string): Ticket {
  const out = run(['show', T1, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneJson(out) as { ticket: Ticket }).ticket;
}

describe('scenario: inbox writes the due grant', () => {
  it('inbox --as merger-2 writes the grant and returns it in that call, and only once', () => {
    const { root, events, g } = seed();
    const hash = canonicalHash(g);
    vi.setSystemTime(5001);
    const first = inbox(root, 'merger-2');
    expect(existsSync(join(events, `${hash}.json`))).toBe(true);
    const granted = first.entries.filter((e) => e.hash === hash);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ kind: 'ticket.grant', event: g });
    vi.setSystemTime(6000);
    expect(inbox(root, 'merger-2').entries.map((e) => e.hash)).not.toContain(hash);
  });
});

describe('read-only commands write due grants', () => {
  it('list writes the due grant, and show then reports the grantee', () => {
    const { root, events, g } = seed();
    vi.setSystemTime(5000);
    expect(run(['list', '--json'], root).code).toBe(0);
    expect(eventNames(events)).not.toContain(`${canonicalHash(g)}.json`);
    vi.setSystemTime(5001);
    const out = run(['list', '--json'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(eventNames(events)).toContain(`${canonicalHash(g)}.json`);
    expect(show(root)).toMatchObject({ assignee: 'merger-2', queue: [] });
  });

  it('show writes the due grant itself', () => {
    const { root, events, g } = seed();
    vi.setSystemTime(5001);
    expect(show(root)).toMatchObject({ assignee: 'merger-2' });
    expect(eventNames(events)).toContain(`${canonicalHash(g)}.json`);
  });
});

describe('rebuild and rebuild --check never write grants', () => {
  it('neither writes the grant that is due; the next ordinary command does', () => {
    const { root, events, g } = seed();
    vi.setSystemTime(5000);
    expect(run(['list'], root).code).toBe(0);
    const before = eventNames(events);
    vi.setSystemTime(10_000_000);
    const check = run(['rebuild', '--check', '--json'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(eventNames(events)).toEqual(before);
    const rebuilt = run(['rebuild', '--json'], root);
    expect(rebuilt.code, rebuilt.stderr).toBe(0);
    expect(eventNames(events)).toEqual(before);
    expect(run(['list'], root).code).toBe(0);
    expect(eventNames(events)).toContain(`${canonicalHash(g)}.json`);
  });
});

describe('a read-only command with nothing due takes no write lock', () => {
  it('list and show return at once while another connection holds the write lock', () => {
    vi.useRealTimers();
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    const now = Date.now();
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', now - 10_000));
    // A grace lease that lapses three minutes from now, with a waiter.
    putEvent(
      events,
      ev(
        {
          kind: 'ticket.claim',
          ticket: T1,
          body: { lease: { ttl: 1_800_000, grace: 120_000, expiresAt: now + 120_000 } },
        },
        'merger-1',
        now,
      ),
    );
    putEvent(
      events,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', now + 1),
    );
    expect(run(['list'], root).code).toBe(0);
    const holder = new DatabaseSync(join(boardDir, 'cache.sqlite'));
    holder.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      const list = run(['list', '--json'], root);
      const shown = run(['show', T1, '--json'], root);
      expect(list.code, list.stderr).toBe(0);
      expect(shown.code, shown.stderr).toBe(0);
      // A command waiting for the lock would wait at least the 5 s busy timeout.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  }, 30_000);
});
