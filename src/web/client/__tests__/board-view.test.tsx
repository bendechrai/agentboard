// @vitest-environment happy-dom
/**
 * The live board view (board-web: "Board views", scenario "Card moves
 * live"; board-view-model: "Board columns and cards"; add-board-web task
 * 4.3): cards per column, the changed highlight, the change and assignee
 * filters, the closed toggle, all driven through the real app and kept in
 * the URL hash.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatHash, parseHash } from '../hash.js';
import {
  E,
  FakeApi,
  FakeClock,
  OTHER,
  T1,
  T2,
  T3,
  T4,
  TASK,
  TASK2,
  appendOf,
  card,
  cardIds,
  column,
  model,
  renderApp,
  streamOf,
  setHash,
  withDigest,
} from './client-helpers.js';

const WALL = 2_000_000;
const NOW = WALL + 3_600_000;

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

/**
 * T1 (TASK, impl-1, implementing then blocked, checklist 1/2, open
 * decision), T2 (TASK2 of the same change, impl-2, tests), T3 (other
 * change, impl-1, todo), T4 (ad hoc, blocked from todo then closed).
 */
function boardInputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(
      T1,
      { title: 'Parser', task: TASK, labels: ['core', 'p1'], checklist: ['a', 'b'] },
      { actor: 'orch', wall: WALL },
    ),
    E.create(T2, { title: 'Docs', task: TASK2 }, { actor: 'orch', wall: WALL + 10 }),
    E.create(T3, { title: 'TUI', task: OTHER }, { actor: 'orch', wall: WALL + 20 }),
    E.create(T4, { title: 'Chore', adhoc: 'cleanup' }, { actor: 'orch', wall: WALL + 30 }),
    E.handoff(T1, 'impl-1', 'tests', 'go', { actor: 'orch', wall: WALL + 40 }),
    E.move(T1, 'implementing', { actor: 'impl-1', wall: WALL + 50 }),
    E.check(T1, 0, true, { actor: 'impl-1', wall: WALL + 60 }),
    E.comment(T1, 'DECISION: use sessions', { actor: 'impl-1', wall: WALL + 70 }),
    E.move(T1, 'blocked', { actor: 'impl-1', wall: WALL + 80 }),
    E.handoff(T2, 'impl-2', 'tests', 'go', { actor: 'orch', wall: WALL + 90 }),
    E.assign(T3, 'impl-1', { actor: 'orch', wall: WALL + 100 }),
    E.move(T4, 'blocked', { actor: 'orch', wall: WALL + 110 }),
    E.close(T4, { noDecision: true }, { actor: 'orch', wall: WALL + 120 }),
  ];
}

async function open(
  hash = '#/board',
  inputs = boardInputs(),
  clock = new FakeClock(NOW),
): Promise<FakeApi> {
  setHash(hash);
  const api = new FakeApi(withDigest(model(inputs), '1'));
  renderApp(api, clock);
  await waitFor(() => {
    expect(document.querySelectorAll('section.column')).toHaveLength(6);
  });
  return api;
}

function route(): ReturnType<typeof parseHash> {
  return parseHash(window.location.hash);
}

describe('columns and cards', () => {
  it('puts every open ticket in its status column and hides closed ones', async () => {
    await open();
    expect(cardIds(column(document, 'todo'))).toEqual([T3]);
    expect(cardIds(column(document, 'tests'))).toEqual([T2]);
    expect(cardIds(column(document, 'implementing'))).toEqual([]);
    expect(cardIds(column(document, 'blocked'))).toEqual([T1]);
    expect(card(document, T4)).toBeNull();
    expect(column(document, 'blocked').textContent).toContain('blocked');
  });

  it('shows the card fields as text', async () => {
    await open();
    const t1 = card(document, T1);
    const text = t1?.textContent ?? '';
    expect(text).toContain('Parser');
    expect(text).toContain(T1.slice(0, 10));
    expect(text).toContain('impl-1');
    expect(text).toContain('openspec:add-board-web#1');
    expect(text).toContain('core');
    expect(text).toContain('p1');
    expect(text).toContain('1/2');
    expect(text).toContain('from implementing');
    expect(t1?.querySelector(`a[href="#/ticket/${T1}"]`)?.textContent).toContain('Parser');
  });

  it('marks cards changed within 5 seconds of now only', async () => {
    const lastWall = WALL + 120;
    await open('#/board', boardInputs(), new FakeClock(lastWall + 4_000));
    // T3 was last updated at WALL + 100 and T1 at WALL + 80: all within 5 s.
    expect(card(document, T3)?.classList.contains('changed')).toBe(true);
    cleanup();
    await open('#/board', boardInputs(), new FakeClock(WALL + 100 + 5_000));
    expect(card(document, T3)?.classList.contains('changed')).toBe(false);
    expect(card(document, T2)?.classList.contains('changed')).toBe(false);
  });

  it('moves a card live on an append and marks it changed', async () => {
    const inputs = boardInputs();
    const clock = new FakeClock(NOW);
    const api = await open('#/board', inputs, clock);
    const before = api.board;
    expect(card(column(document, 'todo'), T3)?.classList.contains('changed')).toBe(false);

    const wall = NOW + 1_000;
    const after = withDigest(
      model([...inputs, E.move(T3, 'tests', { actor: 'impl-1', wall })]),
      '2',
    );
    clock.now = wall + 200;
    (await streamOf(api)).append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(cardIds(column(document, 'tests'))).toEqual([T3, T2]);
    });
    expect(cardIds(column(document, 'todo'))).toEqual([]);
    expect(card(document, T3)?.classList.contains('changed')).toBe(true);
    expect(card(document, T2)?.classList.contains('changed')).toBe(false);
  });
});

describe('filters', () => {
  it('filters by change and keeps the filter in the hash', async () => {
    await open();
    const select = screen.getByLabelText('Change') as HTMLSelectElement;
    const options = [...select.options].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', 'all'],
      ['openspec:add-board-tui', 'openspec:add-board-tui'],
      ['openspec:add-board-web', 'openspec:add-board-web'],
    ]);

    fireEvent.change(select, { target: { value: 'openspec:add-board-web' } });
    await waitFor(() => {
      expect(cardIds(document).sort()).toEqual([T1, T2].sort());
    });
    expect(route()).toEqual({
      view: 'board',
      change: 'openspec:add-board-web',
      assignee: null,
      closed: false,
    });
  });

  it('filters by assignee, combined with the change filter', async () => {
    await open(`#/board?change=${encodeURIComponent('openspec:add-board-web')}`);
    const select = screen.getByLabelText('Assignee') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'impl-1', 'impl-2']);

    fireEvent.change(select, { target: { value: 'impl-1' } });
    await waitFor(() => {
      expect(cardIds(document)).toEqual([T1]);
    });
    expect(route()).toEqual({
      view: 'board',
      change: 'openspec:add-board-web',
      assignee: 'impl-1',
      closed: false,
    });

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      expect(cardIds(document).sort()).toEqual([T1, T2].sort());
    });
    expect(route()).toMatchObject({ assignee: null });
  });

  it('shows closed tickets on request', async () => {
    await open();
    const toggle = screen.getByLabelText('Show closed') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(card(document, T4)).not.toBeNull();
    });
    expect(cardIds(column(document, 'blocked')).sort()).toEqual([T1, T4].sort());
    expect(card(document, T4)?.classList.contains('closed')).toBe(true);
    expect(window.location.hash).toBe(
      formatHash({ view: 'board', change: null, assignee: null, closed: true }),
    );

    fireEvent.click(screen.getByLabelText('Show closed'));
    await waitFor(() => {
      expect(card(document, T4)).toBeNull();
    });
  });
});
