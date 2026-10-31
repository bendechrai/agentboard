/**
 * Summaries of the re-import kinds (add-claim-leases tasks 8.1 and 8.2;
 * board-view-model: "Activity feed entries").
 */

import { describe, expect, it } from 'vitest';

import type { BoardEvent, TicketReconcileBody } from '../../events/schema.js';
import { describeEvent } from '../describe.js';

const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const SOURCE = `openspec/changes/add-x/tasks.md@sha256:${'2'.repeat(64)}`;

function event(kind: BoardEvent['kind'], body: unknown): BoardEvent {
  return {
    v: 1,
    kind,
    ticket: T1,
    actor: 'orch',
    ts: { wall: 1, counter: 0, actor: 'orch' },
    body,
  } as BoardEvent;
}

function reconcile(body: Partial<TicketReconcileBody>): BoardEvent {
  return event('ticket.reconcile', {
    updated: [],
    removed: [],
    added: [],
    forced: false,
    source: SOURCE,
    ...body,
  });
}

const line = { text: 'x', done: false };

describe('describeEvent: re-import kinds', () => {
  it.each<[string, BoardEvent, string]>([
    [
      'a reconcile with every list',
      reconcile({
        updated: [{ index: 1, ...line }],
        removed: [2, 3],
        added: [line, line, line],
      }),
      'reconciled with tasks (1 updated, 2 removed, 3 added)',
    ],
    [
      'a reconcile with only additions',
      reconcile({ added: [line] }),
      'reconciled with tasks (0 updated, 0 removed, 1 added)',
    ],
    [
      'a renaming reconcile',
      reconcile({ title: 'New', removed: [0] }),
      'reconciled with tasks (0 updated, 1 removed, 0 added, renamed)',
    ],
    [
      'a forced reconcile',
      reconcile({ updated: [{ index: 0, ...line }], forced: true, holder: 'impl' }),
      'reconciled with tasks (1 updated, 0 removed, 0 added, forced)',
    ],
    [
      'a renaming forced reconcile',
      reconcile({ title: 'New', removed: [1], forced: true }),
      'reconciled with tasks (0 updated, 1 removed, 0 added, renamed, forced)',
    ],
    [
      'a title-only reconcile',
      reconcile({ title: 'New' }),
      'reconciled with tasks (0 updated, 0 removed, 0 added, renamed)',
    ],
    [
      'a renumber',
      event('ticket.renumber', { from: '5', to: '6' }),
      'renumbered from group 5 to 6',
    ],
    [
      'a supersede',
      event('ticket.supersede', { reason: 'group removed from tasks.md' }),
      'superseded: group removed from tasks.md',
    ],
    [
      'a supersede reason with line breaks',
      event('ticket.supersede', { reason: 'gone\nfor good' }),
      'superseded: gone for good',
    ],
  ])('%s', (_name, value, summary) => {
    expect(describeEvent(value)).toBe(summary);
  });
});
