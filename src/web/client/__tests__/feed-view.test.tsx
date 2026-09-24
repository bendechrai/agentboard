// @vitest-environment happy-dom
/**
 * The activity feed view (board-web: "Board views"; board-view-model:
 * "Activity feed entries", scenario "Filter by actor and kind";
 * add-board-web task 4.3): entries newest first, filters by change, actor
 * and kind through the controls, kept in the URL hash, and live appends.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KNOWN_KINDS } from '../../../events/schema.js';
import type { BoardModel } from '../../../view/types.js';
import { parseHash } from '../hash.js';
import {
  E,
  FakeApi,
  FakeClock,
  OTHER,
  T1,
  T2,
  TASK,
  all,
  appendOf,
  model,
  renderApp,
  streamOf,
  setHash,
  withDigest,
} from './client-helpers.js';

const WALL = 3_000_000;
const NOW = WALL + 120_000;

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

function feedInputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(T1, { title: 'Parser', task: TASK }, { actor: 'orch', wall: WALL }),
    E.create(T2, { title: 'TUI', task: OTHER }, { actor: 'orch', wall: WALL + 10 }),
    E.handoff(T1, 'impl-1', 'tests', 'write tests', { actor: 'orch', wall: WALL + 20 }),
    E.comment(T1, 'on it', { actor: 'impl-1', wall: WALL + 30 }),
    E.handoff(T2, 'impl-2', 'tests', 'yours', { actor: 'impl-1', wall: WALL + 40 }),
    E.claim(T1, { actor: 'impl-2', wall: WALL + 45 }),
    E.handoff(T1, 'reviewer', 'tests', 'green', { actor: 'impl-1', wall: WALL + 50 }),
    E.meta('wip', 2, { actor: 'orch', wall: WALL + 60 }),
  ];
}

async function open(hash: string): Promise<{ api: FakeApi; snapshot: BoardModel }> {
  setHash(hash);
  const snapshot = withDigest(model(feedInputs()), '1');
  const api = new FakeApi(snapshot);
  renderApp(api, new FakeClock(NOW));
  await waitFor(() => {
    expect(document.querySelector('ol.feed')).not.toBeNull();
    expect(document.querySelectorAll('li.entry').length).toBeGreaterThan(0);
  });
  return { api, snapshot };
}

function shown(): (string | null)[] {
  return all(document, 'li.entry').map((li) => li.getAttribute('data-hash'));
}

function applied(
  snapshot: BoardModel,
  keep: (e: BoardModel['events'][number]) => boolean,
): string[] {
  return snapshot.events
    .filter((e) => e.outcome === 'applied' && keep(e))
    .map((e) => e.hash)
    .reverse();
}

describe('entries', () => {
  it('lists every applied event newest first, without the rejected claim', async () => {
    const { snapshot } = await open('#/feed');
    expect(snapshot.events.some((e) => e.outcome === 'rejected')).toBe(true);
    expect(shown()).toEqual(applied(snapshot, () => true));
    const newest = document.querySelector('li.entry');
    expect(newest?.getAttribute('data-kind')).toBe('board.meta');
    expect(newest?.getAttribute('data-actor')).toBe('orch');
    expect(newest?.textContent).toContain('set wip');
    expect(newest?.textContent).toContain('1m ago');
  });

  it('shows the summary, actor and a link to the ticket', async () => {
    const { snapshot } = await open('#/feed');
    const last = snapshot.events.filter((e) => e.kind === 'ticket.handoff').at(-1);
    const li = document.querySelector(`li.entry[data-hash="${last?.hash ?? ''}"]`);
    expect(li?.textContent).toContain('handed off to reviewer (tests): green');
    expect(li?.textContent).toContain('impl-1');
    expect(li?.querySelector(`a[href="#/ticket/${T1}"]`)?.textContent).toContain('Parser');
  });

  it('adds live appends at the top', async () => {
    const { api, snapshot } = await open('#/feed');
    const extra = E.comment(T2, 'live one', { actor: 'impl-2', wall: WALL + 70 });
    const after = withDigest(model([...feedInputs(), extra]), '2');
    (await streamOf(api)).append(appendOf(after, snapshot.events.length));
    await waitFor(() => {
      expect(shown()[0]).toBe(extra.hash);
    });
    expect(document.querySelector('li.entry')?.textContent).toContain('commented: live one');
    expect(api.count('/api/board')).toBe(1);
  });
});

describe('filters', () => {
  it('filters by actor', async () => {
    const { snapshot } = await open('#/feed');
    const select = screen.getByLabelText('Actor') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'impl-1', 'orch']);

    fireEvent.change(select, { target: { value: 'impl-1' } });
    await waitFor(() => {
      expect(shown()).toEqual(applied(snapshot, (e) => e.actor === 'impl-1'));
    });
    expect(parseHash(window.location.hash)).toEqual({
      view: 'feed',
      change: null,
      actor: 'impl-1',
      kinds: null,
    });
  });

  it('filters by actor and kind together (scenario "Filter by actor and kind")', async () => {
    const { snapshot } = await open('#/feed?actor=impl-1');
    const kinds = all(document, 'fieldset input[type="checkbox"]');
    expect(kinds).toHaveLength(KNOWN_KINDS.length);

    fireEvent.click(screen.getByLabelText('ticket.handoff'));
    await waitFor(() => {
      expect(shown()).toEqual(
        applied(snapshot, (e) => e.actor === 'impl-1' && e.kind === 'ticket.handoff'),
      );
    });
    expect(shown()).toHaveLength(2);
    expect(parseHash(window.location.hash)).toEqual({
      view: 'feed',
      change: null,
      actor: 'impl-1',
      kinds: ['ticket.handoff'],
    });

    fireEvent.click(screen.getByLabelText('ticket.comment'));
    await waitFor(() => {
      expect(parseHash(window.location.hash)).toMatchObject({
        kinds: ['ticket.comment', 'ticket.handoff'],
      });
    });
    expect(shown()).toEqual(
      applied(
        snapshot,
        (e) => e.actor === 'impl-1' && (e.kind === 'ticket.handoff' || e.kind === 'ticket.comment'),
      ),
    );
  });

  it('filters by change', async () => {
    const { snapshot } = await open('#/feed');
    const select = screen.getByLabelText('Change') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'openspec:add-board-tui',
      'openspec:add-board-web',
    ]);

    fireEvent.change(select, { target: { value: 'openspec:add-board-tui' } });
    await waitFor(() => {
      expect(shown()).toEqual(applied(snapshot, (e) => e.ticket === T2));
    });
    expect(parseHash(window.location.hash)).toMatchObject({ change: 'openspec:add-board-tui' });
  });

  it('unchecking the last kind shows every kind again', async () => {
    const { snapshot } = await open('#/feed?kind=ticket.comment');
    expect(shown()).toEqual(applied(snapshot, (e) => e.kind === 'ticket.comment'));
    fireEvent.click(screen.getByLabelText('ticket.comment'));
    await waitFor(() => {
      expect(shown()).toEqual(applied(snapshot, () => true));
    });
    expect(parseHash(window.location.hash)).toMatchObject({ kinds: null });
  });
});
