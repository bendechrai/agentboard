import { describe, expect, it } from 'vitest';

import { openDecisions } from '../../events/decisions.js';
import { boardColumns, ticketCard } from '../columns.js';
import { conversation } from '../conversation.js';
import { describeEvent } from '../describe.js';
import { feedEntries } from '../feed.js';
import { agentLanes } from '../lanes.js';
import { relativeTime } from '../time.js';
import { E, OTHER, T1, T2, T3, TASK, model, ticketOf } from './helpers.js';

// board-view-model: "Pure view-model layer", scenario "Deterministic output".
const inputs = [
  E.create(T1, { title: 'one', task: TASK, labels: ['a'], checklist: ['x', 'y'] }),
  E.create(T2, { title: 'two', task: OTHER }),
  E.create(T3, { title: 'three', adhoc: 'hotfix' }),
  E.claim(T1, { actor: 'impl' }),
  E.claim(T1, { actor: 'late' }),
  E.comment(T1, 'DECISION: one', { actor: 'impl' }),
  E.check(T1, 1, true),
  E.handoff(T1, 'rev', 'tests', 'RETRACTED: one', { actor: 'impl' }),
  E.move(T2, 'blocked'),
  E.meta('project', 'agentboard'),
  E.unknown(T2),
  E.assign(T3, 'nobody-yet'),
];
const m = model(inputs, [inputs[6]?.hash ?? '']);
const NOW = 1_000_500;

/** Calls `f` on two deep-equal copies of `args` and checks the results match and the inputs are untouched. */
function twice<A extends unknown[], R>(f: (...args: A) => R, ...args: A): R {
  const copyA = structuredClone(args);
  const copyB = structuredClone(args);
  const first = f(...copyA);
  const second = f(...copyB);
  expect(second).toEqual(first);
  expect(copyA).toEqual(args);
  expect(copyB).toEqual(args);
  return first;
}

describe('view-model functions are deterministic and leave their inputs unchanged', () => {
  it('boardColumns', () => {
    twice(boardColumns, m.tickets, NOW, {});
    twice(boardColumns, m.tickets, NOW, { task: 'openspec:add-board-web', assignee: 'impl' });
    twice(boardColumns, m.tickets, NOW, { includeClosed: true });
  });

  it('ticketCard', () => {
    twice(ticketCard, ticketOf(m, T1), NOW);
  });

  it('feedEntries', () => {
    twice(feedEntries, m, {});
    twice(feedEntries, m, {
      actor: 'impl',
      kinds: ['ticket.handoff'],
      change: 'openspec:add-board-web',
    });
  });

  it('describeEvent', () => {
    for (const input of inputs) {
      twice(describeEvent, input.event);
    }
  });

  it('conversation', () => {
    twice(conversation, m, T1);
    twice(conversation, m, T2);
  });

  it('agentLanes', () => {
    twice(agentLanes, m, NOW);
  });

  it('relativeTime', () => {
    for (const ms of [-5, 0, 10_000, 299_999, 86_400_000]) {
      twice(relativeTime, ms);
    }
  });

  it('openDecisions', () => {
    twice(openDecisions, ticketOf(m, T1).comments);
  });
});
