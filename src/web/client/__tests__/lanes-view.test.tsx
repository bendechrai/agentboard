// @vitest-environment happy-dom
/**
 * The agent lanes view (board-web: "Board views"; board-view-model: "Agent
 * lanes", scenarios "Last seen" and "Assignee without events";
 * add-board-web task 4.4).
 */

import { cleanup, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  E,
  FakeApi,
  FakeClock,
  T1,
  T2,
  T3,
  TASK,
  all,
  cardIds,
  model,
  renderApp,
  setHash,
} from './client-helpers.js';

const WALL = 1_000_000;

beforeEach(() => {
  setHash('#/lanes');
});

afterEach(() => {
  cleanup();
  setHash('');
});

function laneInputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(T1, { title: 'Parser', task: TASK }, { actor: 'orch', wall: WALL - 50 }),
    E.create(T2, { title: 'Docs' }, { actor: 'orch', wall: WALL - 40 }),
    E.create(T3, { title: 'Chore' }, { actor: 'orch', wall: WALL - 30 }),
    E.claim(T2, { actor: 'impl-1', wall: WALL - 20 }),
    E.handoff(T1, 'reviewer-1', 'tests', 'please', { actor: 'orch', wall: WALL - 10 }),
    E.comment(T2, 'working', { actor: 'impl-1', wall: WALL }),
  ];
}

async function open(now: number): Promise<void> {
  renderApp(new FakeApi(model(laneInputs())), new FakeClock(now));
  await waitFor(() => {
    expect(document.querySelectorAll('section.lane').length).toBeGreaterThan(0);
  });
}

function lane(actor: string): Element {
  const el = document.querySelector(`section.lane[data-actor="${actor}"]`);
  if (el === null) {
    throw new Error(`no lane ${actor}`);
  }
  return el;
}

describe('agent lanes', () => {
  it('orders lanes by last event, then assignees without events', async () => {
    await open(1_300_000);
    expect(all(document, 'section.lane').map((l) => l.getAttribute('data-actor'))).toEqual([
      'impl-1',
      'orch',
      'reviewer-1',
    ]);
    expect(lane('impl-1').textContent).toContain('impl-1');
  });

  it('shows "last seen" from the last event wall (scenario "Last seen")', async () => {
    await open(1_300_000);
    const lastSeen = lane('impl-1').querySelector('.last-seen');
    expect(lastSeen?.textContent).toContain('last seen 5m ago');
    expect(lastSeen?.textContent).toContain('ticket.comment');
    expect(lane('orch').querySelector('.last-seen')?.textContent).toContain('last seen 5m ago');
  });

  it('shows a future wall as just now', async () => {
    await open(WALL - 5_000);
    expect(lane('impl-1').querySelector('.last-seen')?.textContent).toContain('last seen just now');
  });

  it('holds the tickets of an assignee without events (scenario "Assignee without events")', async () => {
    await open(1_300_000);
    const reviewer = lane('reviewer-1');
    expect(cardIds(reviewer)).toEqual([T1]);
    expect(reviewer.querySelector('.last-seen')).toBeNull();
    expect(reviewer.textContent).toContain('no events');
    expect(cardIds(lane('impl-1'))).toEqual([T2]);
    expect(cardIds(lane('orch'))).toEqual([]);
  });
});
