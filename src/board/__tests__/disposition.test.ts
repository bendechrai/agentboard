/**
 * The scope disposition on `moveTicket` and `closeTicket`
 * (add-adhoc-ticket-lifecycle task 2.1; board-cli: "Scope disposition on
 * the command line"; board-openspec-integration: "Scope disposition at
 * merge and close", "Tickets reference tasks or are ad hoc"; design.md
 * sections 4 to 6), through the library: the disposition event and the
 * move or close written together or not at all, the check order of each
 * command, and `scopeDispositionFromArgs`, which turns the flags into a
 * disposition with `link`'s own validation. The CLI forms are in
 * src/cli/__tests__/disposition-cli.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalDecode } from '../../events/canonical.js';
import type { Ticket } from '../../events/fold.js';
import { compareHlc } from '../../events/hlc.js';
import type { BoardEvent, Status, TaskRef } from '../../events/schema.js';
import type { Board } from '../../store/board.js';
import { readTicket } from '../../store/cache.js';
import { runCommand } from '../../store/transaction.js';
import { allNames, eventNames, P } from '../../store/__tests__/helpers.js';
import { ADHOC, LINKED, writePreDispositionBoard } from '../../store/__tests__/pre-disposition.js';
import {
  claimTicket,
  closeTicket,
  commentTicket,
  handoffTicket,
  linkTicket,
  moveTicket,
  releaseTicket,
  scopeDispositionFromArgs,
  type ScopeDisposition,
} from '../actions.js';
import { taskRefFromArgs } from '../resolve.js';
import { showTicket } from '../tickets.js';
import {
  B64,
  SAMPLES,
  TASK,
  create,
  eventCount,
  expectBoardError,
  makeBoardDir,
  openTracked,
  setup,
  tempDir,
  ticketIn,
} from './helpers.js';

const LOGIN: TaskRef = { source: 'openspec', ref: 'add-login', item: '2' };

/** An ad hoc ticket (reason `hotfix`) moved to `status` through the library. */
function adhocIn(board: Board, status: 'todo' | 'tests' | 'review' | 'blocked'): Ticket {
  let ticket = create(board, { adhoc: 'hotfix' });
  const path: Record<typeof status, readonly Status[]> = {
    todo: [],
    tests: ['tests'],
    review: ['tests', 'implementing', 'review'],
    blocked: ['tests', 'implementing', 'blocked'],
  };
  for (const to of path[status]) {
    ticket = moveTicket(board, 'orch', { id: ticket.id, to }).ticket;
  }
  return ticket;
}

/** The event file `hash` of `board`, decoded. */
function eventOf(board: Board, hash: string): BoardEvent {
  return canonicalDecode(
    new Uint8Array(readFileSync(join(board.eventsDir, `${hash}.json`))),
  ) as unknown as BoardEvent;
}

/** The current ticket from the cache. */
function current(board: Board, id: string): Ticket {
  const ticket = readTicket(board.db, id);
  if (ticket === null) {
    throw new Error(`no ticket ${id}`);
  }
  return ticket;
}

describe('scopeDispositionFromArgs', () => {
  it('is undefined when no disposition flag is given', () => {
    expect(scopeDispositionFromArgs({})).toBeUndefined();
    expect(scopeDispositionFromArgs({ allowSecretLike: true })).toBeUndefined();
  });

  it('scenario: the OpenSpec shorthand is the same task reference', () => {
    const byTask = scopeDispositionFromArgs({ task: 'openspec:add-login#2' });
    const byChange = scopeDispositionFromArgs({ change: 'add-login', group: '2' });
    expect(byTask).toEqual({ task: LOGIN });
    expect(byChange).toEqual(byTask);
  });

  it('scenario: a malformed task reference is refused exactly as link refuses it', () => {
    const err = expectBoardError(
      () => scopeDispositionFromArgs({ task: 'add-login-2' }),
      1,
      'malformed-task-ref',
    );
    expect(err.message).toContain('<source>:<ref>#<item>');
    const link = expectBoardError(
      () => taskRefFromArgs({ task: 'add-login-2' }),
      1,
      'malformed-task-ref',
    );
    expect(err.message).toBe(link.message);
    expectBoardError(() => scopeDispositionFromArgs({ change: 'add-login' }), 1, 'usage');
    expectBoardError(() => scopeDispositionFromArgs({ group: '2' }), 1, 'usage');
    expectBoardError(
      () => scopeDispositionFromArgs({ change: 'add-login', group: 'two' }),
      1,
      'malformed-task-ref',
    );
  });

  it('scenario: both dispositions are a usage error naming both flags', () => {
    const err = expectBoardError(
      () => scopeDispositionFromArgs({ task: 'openspec:x#1', unplanned: 'y' }),
      1,
      'usage',
    );
    expect(err.message).toContain('--task');
    expect(err.message).toContain('--unplanned');
    const shorthand = expectBoardError(
      () => scopeDispositionFromArgs({ change: 'x', group: '1', unplanned: 'y' }),
      1,
      'usage',
    );
    expect(shorthand.message).toContain('--unplanned');
  });

  it('refuses an empty unplanned reason with exit 1 usage', () => {
    const err = expectBoardError(() => scopeDispositionFromArgs({ unplanned: '' }), 1, 'usage');
    expect(err.message).toMatch(/unplanned/);
    expect(err.message).toMatch(/empty/);
  });

  it('returns the unplanned reason verbatim', () => {
    expect(scopeDispositionFromArgs({ unplanned: 'production hotfix, no plan' })).toEqual({
      unplanned: 'production hotfix, no plan',
    });
  });

  it('scenario: a secret-like unplanned reason is refused naming the pattern, not the text', () => {
    const reason = `token: ${B64}`;
    const err = expectBoardError(
      () => scopeDispositionFromArgs({ unplanned: reason }),
      1,
      'secret-like',
    );
    expect(err.message).toContain('generic-secret-assignment');
    expect(err.message).not.toContain(B64);
    expect(err.message).toContain('--allow-secret-like');
    for (const [name, sample] of Object.entries(SAMPLES)) {
      expect(
        expectBoardError(() => scopeDispositionFromArgs({ unplanned: sample }), 1, 'secret-like')
          .message,
        name,
      ).toContain(name);
    }
    expect(scopeDispositionFromArgs({ unplanned: reason, allowSecretLike: true })).toEqual({
      unplanned: reason,
    });
  });

  it('allowSecretLike changes nothing for a task reference', () => {
    expect(scopeDispositionFromArgs({ task: 'openspec:x#1', allowSecretLike: true })).toEqual({
      task: { source: 'openspec', ref: 'x', item: '1' },
    });
  });
});

describe('moveTicket: merge with a disposition', () => {
  it('scenario: merge with a task link writes the ticket.link then the ticket.move', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    const before = eventNames(board.eventsDir);
    const out = moveTicket(board, 'orch', {
      id: t.id,
      to: 'merged',
      disposition: { task: LOGIN },
    });
    expect(out.events).toHaveLength(2);
    expect(out.hash).toBe(out.events[1]);
    expect(eventNames(board.eventsDir)).toEqual(
      [...before, ...out.events.map((h) => `${h}.json`)].sort(),
    );
    const [link, move] = out.events.map((h) => eventOf(board, h));
    expect(link).toMatchObject({
      kind: 'ticket.link',
      ticket: t.id,
      actor: 'orch',
      body: { task: LOGIN },
    });
    expect(move).toMatchObject({
      kind: 'ticket.move',
      ticket: t.id,
      actor: 'orch',
      body: { to: 'merged' },
    });
    expect(compareHlc((link as BoardEvent).ts, (move as BoardEvent).ts)).toBeLessThan(0);
    expect(out.ticket).toMatchObject({
      status: 'merged',
      task: LOGIN,
      adhoc: null,
      unplanned: null,
    });
    expect(current(board, t.id)).toEqual(out.ticket);
  });

  it('scenario: merge as unplanned writes the ticket.unplanned then the ticket.move', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    const out = moveTicket(board, 'orch', {
      id: t.id,
      to: 'merged',
      disposition: { unplanned: 'production hotfix, no plan' },
    });
    expect(out.events).toHaveLength(2);
    expect(out.hash).toBe(out.events[1]);
    const [unplanned, move] = out.events.map((h) => eventOf(board, h));
    expect(unplanned).toMatchObject({
      kind: 'ticket.unplanned',
      ticket: t.id,
      actor: 'orch',
      body: { reason: 'production hotfix, no plan' },
    });
    expect(move).toMatchObject({ kind: 'ticket.move', body: { to: 'merged' } });
    expect(out.ticket).toMatchObject({
      status: 'merged',
      task: null,
      adhoc: 'hotfix',
      unplanned: {
        reason: 'production hotfix, no plan',
        actor: 'orch',
        ts: (unplanned as BoardEvent).ts,
      },
    });
    expect(out.ticket.version).toBe(t.version + 2);
    expect(showTicket(board, t.id).ticket).toEqual(out.ticket);
  });

  it('a task disposition on a linked ticket replaces the reference, as link does', () => {
    const { board } = setup();
    const t = ticketIn(board, 'review');
    const out = moveTicket(board, 'orch', {
      id: t.id,
      to: 'merged',
      disposition: { task: LOGIN },
    });
    expect(out.events).toHaveLength(2);
    expect(out.ticket).toMatchObject({ status: 'merged', task: LOGIN });
  });

  it('an unplanned disposition on a ticket already unplanned records the new reason', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    runCommand(board, 'orch', () => ({ ok: true, event: P.unplanned(t.id, 'first') }));
    const out = moveTicket(board, 'orch', {
      id: t.id,
      to: 'merged',
      disposition: { unplanned: 'second' },
    });
    expect(out.events).toHaveLength(2);
    expect(out.ticket.unplanned).toMatchObject({ reason: 'second', actor: 'orch' });
    expect(eventOf(board, out.events[0] ?? '')).toMatchObject({
      kind: 'ticket.unplanned',
      body: { reason: 'second' },
    });
  });

  it('scenario: a ticket linked earlier needs no disposition', () => {
    const { board } = setup();
    const t = create(board, { adhoc: 'hotfix' });
    for (const to of ['tests', 'implementing'] as const) {
      moveTicket(board, 'orch', { id: t.id, to });
    }
    linkTicket(board, 'orch', { id: t.id, target: { task: LOGIN } });
    moveTicket(board, 'orch', { id: t.id, to: 'review' });
    const out = moveTicket(board, 'orch', { id: t.id, to: 'merged' });
    expect(out.events).toHaveLength(1);
    expect(out.ticket).toMatchObject({ status: 'merged', task: LOGIN, adhoc: null });
  });

  it('scenario: disposition without its move (a ticket unplanned earlier) needs no flag', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    runCommand(board, 'merger', () => ({ ok: true, event: P.unplanned(t.id, 'hotfix') }));
    const out = moveTicket(board, 'orch', { id: t.id, to: 'merged' });
    expect(out.events).toHaveLength(1);
    expect(out.ticket).toMatchObject({
      status: 'merged',
      unplanned: { reason: 'hotfix', actor: 'merger' },
    });
  });

  it('scenario: a planned ticket is unaffected by the flags being absent', () => {
    const { board } = setup();
    const t = ticketIn(board, 'review');
    expect(moveTicket(board, 'orch', { id: t.id, to: 'merged' }).events).toHaveLength(1);
    expect(closeTicket(board, 'orch', { id: t.id, noDecision: true }).events).toHaveLength(1);
  });
});

describe('moveTicket: refusals with a disposition write nothing', () => {
  const unplanned: ScopeDisposition = { unplanned: 'y' };

  it.each(['todo', 'tests', 'implementing', 'review', 'blocked'] as const)(
    'scenario: a disposition on a move to %s is exit 1 usage',
    (to) => {
      const { board } = setup();
      const t = adhocIn(board, 'tests');
      const names = allNames(board.eventsDir);
      const err = expectBoardError(
        () => moveTicket(board, 'orch', { id: t.id, to, disposition: unplanned }),
        1,
        'usage',
      );
      expect(err.message).toContain('merged');
      expect(allNames(board.eventsDir)).toEqual(names);
      expect(current(board, t.id).status).toBe('tests');
    },
  );

  it('scenario: a disposition on the target-less return from blocked is exit 1 usage', () => {
    const { board } = setup();
    const t = adhocIn(board, 'blocked');
    const names = allNames(board.eventsDir);
    const err = expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, disposition: { task: LOGIN } }),
      1,
      'usage',
    );
    expect(err.message).toContain('merged');
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id).status).toBe('blocked');
  });

  it('refuses an empty unplanned reason with exit 1 usage before reading the ticket', () => {
    const { board } = setup();
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => moveTicket(board, 'orch', { id: '01NOPE00', to: 'merged', disposition: { unplanned: '' } }),
      1,
      'usage',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
  });

  it('scenario: a secret-like unplanned reason is refused, and --allow-secret-like writes it', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    const names = allNames(board.eventsDir);
    const reason = `token: ${B64}`;
    const err = expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged', disposition: { unplanned: reason } }),
      1,
      'secret-like',
    );
    expect(err.message).toContain('generic-secret-assignment');
    expect(err.message).not.toContain(B64);
    expect(allNames(board.eventsDir)).toEqual(names);
    const out = moveTicket(board, 'orch', {
      id: t.id,
      to: 'merged',
      disposition: { unplanned: reason },
      allowSecretLike: true,
    });
    expect(out.ticket).toMatchObject({ status: 'merged', unplanned: { reason } });
  });

  it('scenario: unplanned on a linked ticket is exit 4 already-linked naming the reference', () => {
    const { board } = setup();
    const t = ticketIn(board, 'review');
    const names = allNames(board.eventsDir);
    const err = expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged', disposition: unplanned }),
      4,
      'already-linked',
    );
    expect(err.message).toContain('openspec:add-board-core#3');
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id)).toEqual(t);
  });

  it('already-linked comes before invalid-transition (the disposition is folded first)', () => {
    const { board } = setup();
    const t = ticketIn(board, 'todo');
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged', disposition: unplanned }),
      4,
      'already-linked',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
  });

  it('scenario: a disposition with an invalid move writes neither event, not even a temporary file', () => {
    const { board } = setup();
    const t = adhocIn(board, 'todo');
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged', disposition: unplanned }),
      4,
      'invalid-transition',
    );
    expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged', disposition: { task: LOGIN } }),
      4,
      'invalid-transition',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id)).toMatchObject({ status: 'todo', unplanned: null, task: null });
  });

  it('invalid-transition comes before needs-scope-disposition', () => {
    const { board } = setup();
    const t = adhocIn(board, 'todo');
    expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged' }),
      4,
      'invalid-transition',
    );
  });

  it('scenario: merge without a disposition is refused and the ticket stays in review', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    const names = allNames(board.eventsDir);
    const err = expectBoardError(
      () => moveTicket(board, 'orch', { id: t.id, to: 'merged' }),
      4,
      'needs-scope-disposition',
    );
    expect(err.message).toContain(t.id);
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id).status).toBe('review');
  });

  it('scenario: a hand-off into merged needs a disposition first', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => handoffTicket(board, 'rev', { id: t.id, to: 'orch', status: 'merged', note: 'done' }),
      4,
      'needs-scope-disposition',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
  });
});

describe('closeTicket: the scope disposition', () => {
  it('scenario: close with each disposition', () => {
    const { board } = setup();
    const a = adhocIn(board, 'blocked');
    const b = adhocIn(board, 'blocked');
    const closedA = closeTicket(board, 'orch', {
      id: a.id,
      noDecision: true,
      disposition: { task: { source: 'openspec', ref: 'add-login', item: '3' } },
    });
    expect(closedA.events).toHaveLength(2);
    expect(closedA.hash).toBe(closedA.events[1]);
    expect(closedA.ticket).toMatchObject({
      closed: true,
      disposition: { noDecision: true },
      task: { source: 'openspec', ref: 'add-login', item: '3' },
      adhoc: null,
      unplanned: null,
      status: 'blocked',
    });
    const [link, close] = closedA.events.map((h) => eventOf(board, h));
    expect(link).toMatchObject({ kind: 'ticket.link', ticket: a.id });
    expect(close).toMatchObject({ kind: 'ticket.close', ticket: a.id, body: { noDecision: true } });
    expect(compareHlc((link as BoardEvent).ts, (close as BoardEvent).ts)).toBeLessThan(0);

    const closedB = closeTicket(board, 'orch', {
      id: b.id,
      noDecision: true,
      disposition: { unplanned: 'abandoned, duplicate of A' },
    });
    expect(closedB.events).toHaveLength(2);
    expect(closedB.ticket).toMatchObject({
      closed: true,
      adhoc: 'hotfix',
      unplanned: { reason: 'abandoned, duplicate of A', actor: 'orch' },
    });
    expect(eventOf(board, closedB.events[0] ?? '')).toMatchObject({
      kind: 'ticket.unplanned',
      body: { reason: 'abandoned, duplicate of A' },
    });
  });

  it('scenario: close without a disposition is exit 4 needs-scope-disposition and writes nothing', () => {
    const { board } = setup();
    const t = adhocIn(board, 'blocked');
    const names = allNames(board.eventsDir);
    const err = expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      4,
      'needs-scope-disposition',
    );
    expect(err.message).toContain(t.id);
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id)).toEqual(t);
  });

  it('a merged ticket that lost its disposition outside agentboard is refused too', () => {
    // The fold never lets an undisposed ticket into merged, so the state
    // can only come from outside: here, a hand-edited cache row.
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    board.db
      .prepare('UPDATE tickets SET task_source = NULL, task_ref = NULL, task_item = NULL WHERE id = ?')
      .run(t.id);
    expect(current(board, t.id)).toMatchObject({ task: null, unplanned: null, status: 'merged' });
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      4,
      'needs-scope-disposition',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
  });

  it('scenario: the check order puts the scope disposition before the decision guard', () => {
    const { board } = setup();
    const t = adhocIn(board, 'blocked');
    commentTicket(board, 'impl', { id: t.id, text: 'DECISION: keep the old parser' });
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      4,
      'needs-scope-disposition',
    );
    expectBoardError(
      () =>
        closeTicket(board, 'orch', { id: t.id, noDecision: true, disposition: { unplanned: 'spike' } }),
      1,
      'unpromoted-decision',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id)).toMatchObject({ closed: false, unplanned: null });
  });

  it('closability comes before the scope disposition', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true }),
      4,
      'invalid-transition',
    );
    expectBoardError(
      () =>
        closeTicket(board, 'orch', { id: t.id, noDecision: true, disposition: { unplanned: 'x' } }),
      4,
      'invalid-transition',
    );
  });

  it('the decision path checks come before the scope disposition', () => {
    const { board, root } = setup();
    const t = adhocIn(board, 'blocked');
    const names = allNames(board.eventsDir);
    expectBoardError(
      () =>
        closeTicket(board, 'orch', {
          id: t.id,
          decisionRecordedIn: 'docs/adr/0099.md',
          cwd: root,
          env: {},
        }),
      1,
      'decision-path-missing',
    );
    expect(allNames(board.eventsDir)).toEqual(names);
  });

  it('an unplanned reason on a linked ticket is exit 4 already-linked and writes nothing', () => {
    const { board } = setup();
    const t = ticketIn(board, 'blocked');
    const names = allNames(board.eventsDir);
    const err = expectBoardError(
      () =>
        closeTicket(board, 'orch', { id: t.id, noDecision: true, disposition: { unplanned: 'y' } }),
      4,
      'already-linked',
    );
    expect(err.message).toContain('openspec:add-board-core#3');
    expect(allNames(board.eventsDir)).toEqual(names);
    expect(current(board, t.id).closed).toBe(false);
  });

  it('a task disposition on a linked ticket replaces the reference and closes', () => {
    const { board } = setup();
    const t = ticketIn(board, 'merged');
    const out = closeTicket(board, 'orch', {
      id: t.id,
      noDecision: true,
      disposition: { task: LOGIN },
    });
    expect(out.events).toHaveLength(2);
    expect(out.ticket).toMatchObject({ closed: true, task: LOGIN });
  });

  it('refuses an empty or secret-like unplanned reason before reading the ticket', () => {
    const { board } = setup();
    const t = adhocIn(board, 'blocked');
    const names = allNames(board.eventsDir);
    expectBoardError(
      () => closeTicket(board, 'orch', { id: t.id, noDecision: true, disposition: { unplanned: '' } }),
      1,
      'usage',
    );
    const reason = `password=${B64}`;
    const err = expectBoardError(
      () =>
        closeTicket(board, 'orch', {
          id: t.id,
          noDecision: true,
          disposition: { unplanned: reason },
        }),
      1,
      'secret-like',
    );
    expect(err.message).toContain('generic-secret-assignment');
    expect(err.message).not.toContain(B64);
    expect(allNames(board.eventsDir)).toEqual(names);
    const out = closeTicket(board, 'orch', {
      id: t.id,
      noDecision: true,
      disposition: { unplanned: reason },
      allowSecretLike: true,
    });
    expect(out.ticket).toMatchObject({ closed: true, unplanned: { reason } });
  });

  it('scenario: a ticket linked earlier closes with no disposition flag', () => {
    const { board } = setup();
    const t = adhocIn(board, 'blocked');
    linkTicket(board, 'orch', { id: t.id, target: { task: LOGIN } });
    const out = closeTicket(board, 'orch', { id: t.id, noDecision: true });
    expect(out.events).toHaveLength(1);
    expect(out.ticket).toMatchObject({ closed: true, task: LOGIN });
  });

  it('a ticket merged as unplanned closes with no disposition flag, the disposition unchanged', () => {
    const { board } = setup();
    const t = adhocIn(board, 'review');
    const merged = moveTicket(board, 'orch', {
      id: t.id,
      to: 'merged',
      disposition: { unplanned: 'hotfix' },
    }).ticket;
    const out = closeTicket(board, 'orch', { id: t.id, noDecision: true });
    expect(out.events).toHaveLength(1);
    expect(out.ticket).toMatchObject({ closed: true, unplanned: merged.unplanned });
  });
});

describe('scenario: ad hoc tickets are worked like any other ticket', () => {
  it('moves through the work statuses, is blocked, returned and handed off', () => {
    const { board } = setup();
    const t = create(board, { adhoc: 'found in CI' });
    claimTicket(board, 'impl-1', { id: t.id });
    for (const to of ['tests', 'implementing'] as const) {
      expect(moveTicket(board, 'impl-1', { id: t.id, to }).ticket.status).toBe(to);
    }
    expect(moveTicket(board, 'impl-1', { id: t.id, to: 'blocked' }).ticket.status).toBe('blocked');
    expect(moveTicket(board, 'impl-1', { id: t.id }).ticket.status).toBe('implementing');
    const handed = handoffTicket(board, 'impl-1', {
      id: t.id,
      to: 'reviewer',
      status: 'review',
      note: 'ready',
    }).ticket;
    expect(handed).toMatchObject({
      status: 'review',
      assignee: 'reviewer',
      adhoc: 'found in CI',
      task: null,
      unplanned: null,
    });
  });

  it('scenario: a mutex ticket is claimed and released many times and never refused', () => {
    const { board } = setup();
    const t = create(board, { adhoc: 'mutex: the deploy lock' });
    for (let round = 0; round < 5; round += 1) {
      const holder = `agent-${String(round)}`;
      expect(claimTicket(board, holder, { id: t.id }).ticket.assignee).toBe(holder);
      expect(releaseTicket(board, holder, { id: t.id }).ticket.assignee).toBeNull();
    }
    expect(current(board, t.id)).toMatchObject({ status: 'todo', closed: false, unplanned: null });
    expect(eventCount(board)).toBe(11);
  });
});

describe('scenario: a board written before this change', () => {
  function olderBoard(): Board {
    const dir = makeBoardDir(tempDir());
    writePreDispositionBoard(dir);
    return openTracked(dir);
  }

  it('an ad hoc ticket in todo gains the ability to move', () => {
    const board = olderBoard();
    const others = Object.values(ADHOC)
      .filter((id) => id !== ADHOC.todo)
      .map((id) => current(board, id));
    expect(moveTicket(board, 'orch', { id: ADHOC.todo, to: 'tests' }).ticket.status).toBe('tests');
    expect(moveTicket(board, 'orch', { id: ADHOC.todo, to: 'implementing' }).ticket.status).toBe(
      'implementing',
    );
    expect(others.map((t) => current(board, t.id))).toEqual(others);
  });

  it('linked tickets move on and close with no disposition flag', () => {
    const board = olderBoard();
    expect(current(board, LINKED.review).status).toBe('review');
    expect(moveTicket(board, 'orch', { id: LINKED.review, to: 'merged' }).ticket.status).toBe(
      'merged',
    );
    expect(closeTicket(board, 'orch', { id: LINKED.merged, noDecision: true }).ticket.closed).toBe(
      true,
    );
  });

  it('an ad hoc ticket in blocked needs a disposition to close', () => {
    const board = olderBoard();
    expectBoardError(
      () => closeTicket(board, 'orch', { id: ADHOC.blocked, noDecision: true }),
      4,
      'needs-scope-disposition',
    );
    const out = closeTicket(board, 'orch', {
      id: ADHOC.blocked,
      noDecision: true,
      disposition: { unplanned: 'abandoned: flaky test fixed elsewhere' },
    });
    expect(out.events).toHaveLength(2);
    expect(out.ticket).toMatchObject({
      closed: true,
      adhoc: 'flaky test in CI',
      unplanned: { reason: 'abandoned: flaky test fixed elsewhere', actor: 'orch' },
    });
  });

  it('a ticket closed before this change stays closed and undisposed', () => {
    const board = olderBoard();
    expect(current(board, ADHOC.closed)).toMatchObject({
      closed: true,
      task: null,
      unplanned: null,
      adhoc: 'idea, abandoned',
    });
  });
});

describe('moveTicket and closeTicket keep their single-event behaviour', () => {
  it('writes one event and one hash without a disposition', () => {
    const { board } = setup();
    const t = ticketIn(board, 'review');
    const moved = moveTicket(board, 'orch', { id: t.id, to: 'merged' });
    expect(moved.events).toEqual([moved.hash]);
    const closed = closeTicket(board, 'orch', { id: t.id, noDecision: true });
    expect(closed.events).toEqual([closed.hash]);
    expect(eventCount(board)).toBe(7);
  });

  it('the TASK of the helpers is the reference already-linked names', () => {
    expect(TASK).toEqual({ source: 'openspec', ref: 'add-board-core', item: '3' });
  });
});
