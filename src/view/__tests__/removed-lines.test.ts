/**
 * Removed checklist lines in the view-model (add-claim-leases task 8.4;
 * board-view-model: "Checklist progress counts active lines"; board-cli:
 * "Removed checklist lines are inactive", scenario "Count after a
 * removal").
 */

import { describe, expect, it } from 'vitest';

import { boardColumns, ticketCard } from '../columns.js';
import { E, T1, TASK, model, ticketOf } from './helpers.js';

const NOW = 2_000_000_000;

/** T1 with `1.1 A` (done), `1.2 B` and `1.3 C`, after `removed` are removed. */
function removedModel(removed: number[], tickRemoved = false) {
  return model([
    E.create(T1, { title: 'Lines', task: TASK, checklist: ['1.1 A', '1.2 B', '1.3 C'] }),
    E.check(T1, 0, true),
    ...(tickRemoved ? [E.check(T1, 1, true)] : []),
    E.reconcile(T1, { removed }),
  ]);
}

describe('checklist progress counts active lines', () => {
  it('scenario: count after a removal (1 done of 2)', () => {
    const m = removedModel([1]);
    expect(ticketCard(ticketOf(m, T1), NOW).checklist).toEqual({ done: 1, total: 2 });
  });

  it('scenario: a removed done line is in neither count', () => {
    const m = removedModel([1], true);
    expect(ticketOf(m, T1).checklist[1]).toEqual({ text: '1.2 B', done: true, removed: true });
    expect(ticketCard(ticketOf(m, T1), NOW).checklist).toEqual({ done: 1, total: 2 });
  });

  it('a ticket whose only open line is removed shows complete progress', () => {
    const m = removedModel([1, 2]);
    expect(ticketCard(ticketOf(m, T1), NOW).checklist).toEqual({ done: 1, total: 1 });
  });

  it('boardColumns carries the same counts', () => {
    const m = removedModel([2]);
    const card = boardColumns(m.tickets, NOW)
      .flatMap((c) => c.cards)
      .find((c) => c.id === T1);
    expect(card?.checklist).toEqual({ done: 1, total: 2 });
  });
});
