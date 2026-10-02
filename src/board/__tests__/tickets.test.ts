import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalDecode } from '../../events/canonical.js';
import { isUlid } from '../../events/ulid.js';
import { readTicket } from '../../store/cache.js';
import { ev, eventNames } from '../../store/__tests__/helpers.js';
import { claimTicket, closeTicket, commentTicket, moveTicket } from '../actions.js';
import { SECRET_PATTERN_NAMES } from '../secrets.js';
import { listTickets, newTicket, showRaw, showTicket } from '../tickets.js';
import {
  SAMPLES,
  TASK,
  create,
  eventCount,
  expectBoardError,
  openTracked,
  putEvent,
  setup,
  ticketIn,
} from './helpers.js';

const A = '01J9K3AAAAAAAAAAAAAAAAAAAA';
const B = '01J9K3BBBBBBBBBBBBBBBBBBBB';

/** The body of the event file named `hash`. */
function bodyOf(eventsDir: string, hash: string): Record<string, unknown> {
  const event = canonicalDecode(readFileSync(join(eventsDir, `${hash}.json`))) as {
    body: Record<string, unknown>;
  };
  return event.body;
}

describe('newTicket', () => {
  it('writes one ticket.create and returns its hash and the ticket in todo', () => {
    const { board } = setup();
    const out = newTicket(board, 'orch', {
      title: 'Build the CLI',
      description: 'all of group 3',
      labels: ['cli', 'group:3'],
      task: TASK,
      checklist: ['registry', 'parser'],
    });
    expect(eventNames(board.eventsDir)).toEqual([`${String(out.hash)}.json`]);
    expect(isUlid(out.ticket.id)).toBe(true);
    expect(out.ticket).toMatchObject({
      title: 'Build the CLI',
      description: 'all of group 3',
      status: 'todo',
      assignee: null,
      labels: ['cli', 'group:3'],
      task: TASK,
      adhoc: null,
      checklist: [
        { text: 'registry', done: false },
        { text: 'parser', done: false },
      ],
      createdBy: 'orch',
      version: 1,
    });
    expect(out.ticket).toEqual(readTicket(board.db, out.ticket.id));
    expect(bodyOf(board.eventsDir, String(out.hash))).toEqual({
      title: 'Build the CLI',
      description: 'all of group 3',
      labels: ['cli', 'group:3'],
      task: TASK,
      checklist: ['registry', 'parser'],
    });
  });

  it('omits absent fields and empty arrays from the event body', () => {
    const { board } = setup();
    const out = newTicket(board, 'orch', {
      title: 'Bare',
      adhoc: 'hotfix',
      labels: [],
      checklist: [],
    });
    expect(bodyOf(board.eventsDir, String(out.hash))).toEqual({ title: 'Bare', adhoc: 'hotfix' });
    expect(out.ticket).toMatchObject({ task: null, adhoc: 'hotfix', labels: [], checklist: [] });
  });

  it('accepts a task reference from a source without an adapter', () => {
    const { board } = setup();
    const task = { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' };
    expect(newTicket(board, 'orch', { title: 'x', task }).ticket.task).toEqual(task);
  });

  it('gives each ticket a fresh id', () => {
    const { board } = setup();
    const a = create(board);
    const b = create(board);
    expect(a.id).not.toBe(b.id);
  });

  it('refuses a ticket with neither task nor ad hoc reason, explaining the rule', () => {
    const { board } = setup();
    const err = expectBoardError(
      () => newTicket(board, 'orch', { title: 'Fix thing' }),
      1,
      'needs-task-or-adhoc',
    );
    expect(err.message).toContain('--task');
    expect(err.message).toContain('--adhoc');
    expect(eventCount(board)).toBe(0);
  });

  it('refuses both a task and an ad hoc reason', () => {
    const { board } = setup();
    expectBoardError(
      () => newTicket(board, 'orch', { title: 'x', task: TASK, adhoc: 'why' }),
      1,
      'usage',
    );
    expect(eventCount(board)).toBe(0);
  });

  it.each([
    ['an empty title', { title: '' }],
    ['an empty label', { title: 'x', labels: ['ok', ''] }],
    ['an empty checklist line', { title: 'x', checklist: [''] }],
    ['an empty ad hoc reason', { title: 'x', adhoc: '', task: undefined }],
  ])('refuses %s with exit 1 usage', (_label, input) => {
    const { board } = setup();
    const withTask = 'adhoc' in input ? input : { task: TASK, ...input };
    expectBoardError(() => newTicket(board, 'orch', withTask), 1, 'usage');
    expect(eventCount(board)).toBe(0);
  });

  it('refuses an empty actor', () => {
    const { board } = setup();
    expectBoardError(() => newTicket(board, '', { title: 'x', task: TASK }), 1, 'missing-actor');
  });

  it.each(SECRET_PATTERN_NAMES)(
    'refuses %s in the title, naming the pattern, writing nothing',
    (name) => {
      const { board } = setup();
      const err = expectBoardError(
        () => newTicket(board, 'orch', { title: `oops ${SAMPLES[name]}`, task: TASK }),
        1,
        'secret-like',
      );
      expect(err.message).toContain(name);
      expect(err.message).not.toContain(SAMPLES[name]);
      expect(eventCount(board)).toBe(0);
    },
  );

  it.each([
    ['description', { description: SAMPLES['pem-private-key'] }],
    ['a label', { labels: [SAMPLES['aws-access-key-id']] }],
    ['a checklist line', { checklist: ['fine', SAMPLES['github-token']] }],
  ])('refuses secret-looking text in %s', (_label, extra) => {
    const { board } = setup();
    expectBoardError(
      () => newTicket(board, 'orch', { title: 'x', task: TASK, ...extra }),
      1,
      'secret-like',
    );
    expect(eventCount(board)).toBe(0);
  });

  it('refuses secret-looking text in the ad hoc reason', () => {
    const { board } = setup();
    expectBoardError(
      () => newTicket(board, 'orch', { title: 'x', adhoc: SAMPLES['generic-secret-assignment'] }),
      1,
      'secret-like',
    );
  });

  it('writes secret-looking text with allowSecretLike', () => {
    const { board } = setup();
    const out = newTicket(board, 'orch', {
      title: SAMPLES['pem-private-key'],
      task: TASK,
      allowSecretLike: true,
    });
    expect(out.ticket.title).toBe(SAMPLES['pem-private-key']);
    expect(eventCount(board)).toBe(1);
  });
});

describe('showTicket', () => {
  it('returns the full record with ordered comments and the event count', () => {
    const { board } = setup();
    const t = create(board);
    commentTicket(board, 'a', { id: t.id, text: 'first' });
    commentTicket(board, 'b', { id: t.id, text: 'second' });
    claimTicket(board, 'impl', { id: t.id });
    const shown = showTicket(board, t.id);
    expect(shown.ticket).toEqual(readTicket(board.db, t.id));
    expect(shown.ticket.comments.map((c) => [c.actor, c.text])).toEqual([
      ['a', 'first'],
      ['b', 'second'],
    ]);
    expect(shown.events).toBe(4);
    expect(shown.events).toBe(shown.ticket.version);
    expect(shown.unknown).toEqual([]);
  });

  it('resolves a unique prefix of at least 6 characters', () => {
    const { board } = setup();
    const t = create(board);
    expect(showTicket(board, t.id.slice(0, 20)).ticket.id).toBe(t.id);
  });

  it('refuses an ambiguous prefix listing both full ids, and resolves longer prefixes', () => {
    const { board } = setup();
    putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.create', ticket: A, body: { title: 'a', task: TASK } }, 'orch', 1000),
    );
    putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.create', ticket: B, body: { title: 'b', task: TASK } }, 'orch', 1001),
    );
    const fresh = openTracked(board.dir);
    const err = expectBoardError(() => showTicket(fresh, '01J9K3'), 1, 'ambiguous-id');
    expect(err.message).toContain(A);
    expect(err.message).toContain(B);
    expect(showTicket(fresh, '01J9K3B').ticket.title).toBe('b');
  });

  it('reports an unknown ticket with exit 4', () => {
    const { board } = setup();
    expectBoardError(() => showTicket(board, '01NOPE00'), 4, 'unknown-ticket');
  });

  it('shows a closed ticket', () => {
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    closeTicket(board, 'orch', { id: t.id, noDecision: true });
    expect(showTicket(board, t.id).ticket.closed).toBe(true);
  });

  it('lists unknown-kind events of the ticket with kind and hash, in fold order', () => {
    const { board } = setup();
    putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.create', ticket: A, body: { title: 'a', task: TASK } }, 'orch', 1000),
    );
    putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.create', ticket: B, body: { title: 'b', task: TASK } }, 'orch', 1001),
    );
    const unknown = (ticket: string, wall: number, kind: string): string =>
      putEvent(board.eventsDir, {
        v: 1,
        kind,
        ticket,
        actor: 'future',
        ts: { wall, counter: 0, actor: 'future' },
        body: { points: 3 },
      });
    const second = unknown(A, 3000, 'ticket.archive');
    const first = unknown(A, 2000, 'ticket.estimate');
    unknown(B, 2500, 'ticket.estimate');
    const fresh = openTracked(board.dir);
    const shown = showTicket(fresh, A);
    expect(shown.unknown).toEqual([
      { hash: first, kind: 'ticket.estimate' },
      { hash: second, kind: 'ticket.archive' },
    ]);
    expect(shown.events).toBe(1);
  });
});

describe('showRaw', () => {
  it("returns the ticket's event files in fold order, byte for byte, rejected and unknown included", () => {
    const { board } = setup();
    const create1 = putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.create', ticket: A, body: { title: 'a', task: TASK } }, 'orch', 1000),
    );
    const other = putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.create', ticket: B, body: { title: 'b', task: TASK } }, 'orch', 1001),
    );
    const rejected = putEvent(
      board.eventsDir,
      ev({ kind: 'ticket.release', ticket: A, body: {} }, 'x', 1500),
    );
    const unknown = putEvent(board.eventsDir, {
      v: 1,
      kind: 'ticket.estimate',
      ticket: A,
      actor: 'future',
      ts: { wall: 1200, counter: 0, actor: 'future' },
      body: {},
    });
    const fresh = openTracked(board.dir);
    const raw = showRaw(fresh, '01J9K3A');
    expect(raw.map((r) => r.hash)).toEqual([create1, unknown, rejected]);
    expect(raw.map((r) => r.hash)).not.toContain(other);
    for (const r of raw) {
      const bytes = readFileSync(join(board.eventsDir, `${r.hash}.json`), 'utf8');
      expect(r.text).toBe(bytes);
      expect(r.event).toEqual(JSON.parse(bytes));
    }
  });

  it('refuses an unknown ticket with exit 4', () => {
    const { board } = setup();
    expectBoardError(() => showRaw(board, '01NOPE00'), 4, 'unknown-ticket');
  });
});

describe('listTickets', () => {
  it('returns open tickets ascending by id and excludes closed ones unless asked', () => {
    const { board } = setup();
    const a = create(board, { title: 'a' });
    const merged = ticketIn(board, 'merged');
    const c = create(board, { title: 'c' });
    closeTicket(board, 'orch', { id: merged.id, noDecision: true });
    expect(listTickets(board).map((t) => t.id)).toEqual([a.id, c.id]);
    expect(listTickets(board, {}).map((t) => t.id)).toEqual([a.id, c.id]);
    expect(listTickets(board, { closed: true }).map((t) => t.id)).toEqual([a.id, merged.id, c.id]);
    expect(listTickets(board)[0]).toEqual(readTicket(board.db, a.id));
  });

  it('returns an empty array for an empty board', () => {
    const { board } = setup();
    expect(listTickets(board)).toEqual([]);
  });

  it('filters by status', () => {
    const { board } = setup();
    create(board);
    const t = ticketIn(board, 'implementing');
    expect(listTickets(board, { status: 'implementing' }).map((x) => x.id)).toEqual([t.id]);
    expect(listTickets(board, { status: 'review' })).toEqual([]);
  });

  it('filters by assignee', () => {
    const { board } = setup();
    const t = create(board);
    create(board);
    claimTicket(board, 'impl', { id: t.id });
    expect(listTickets(board, { assignee: 'impl' }).map((x) => x.id)).toEqual([t.id]);
    expect(listTickets(board, { assignee: 'other' })).toEqual([]);
  });

  it('filters by task reference, with or without an item', () => {
    const { board } = setup();
    const g3 = create(board, { task: { source: 'openspec', ref: 'add-board-core', item: '3' } });
    const g4 = create(board, { task: { source: 'openspec', ref: 'add-board-core', item: '4' } });
    create(board, { task: { source: 'openspec', ref: 'other-change', item: '3' } });
    create(board, { task: { source: 'speckit', ref: 'add-board-core', item: '3' } });
    create(board, { adhoc: 'why' });
    const ids = (filter: Parameters<typeof listTickets>[1]): string[] =>
      listTickets(board, filter).map((x) => x.id);
    expect(ids({ task: { source: 'openspec', ref: 'add-board-core', item: '3' } })).toEqual([
      g3.id,
    ]);
    expect(ids({ task: { source: 'openspec', ref: 'add-board-core' } })).toEqual([g3.id, g4.id]);
  });

  it('filters by labels, requiring every label given', () => {
    const { board } = setup();
    const both = create(board, { labels: ['cli', 'urgent'] });
    const one = create(board, { labels: ['cli'] });
    create(board);
    expect(listTickets(board, { labels: ['cli'] }).map((x) => x.id)).toEqual([both.id, one.id]);
    expect(listTickets(board, { labels: ['cli', 'urgent'] }).map((x) => x.id)).toEqual([both.id]);
  });

  it('combines filters', () => {
    const { board } = setup();
    const t = create(board, { labels: ['cli'] });
    create(board, { labels: ['cli'] });
    moveTicket(board, 'orch', { id: t.id, to: 'tests' });
    expect(listTickets(board, { status: 'tests', labels: ['cli'] }).map((x) => x.id)).toEqual([
      t.id,
    ]);
    expect(listTickets(board, { status: 'tests', labels: ['docs'] })).toEqual([]);
  });
});
