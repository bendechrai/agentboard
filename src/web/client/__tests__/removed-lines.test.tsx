// @vitest-environment happy-dom
/**
 * Removed checklist lines in the web app (add-claim-leases task 8.4;
 * board-web: "Removed lines in the ticket detail"; board-web-actions: "No
 * checklist control for a removed line"; board-view-model: "Checklist
 * progress counts active lines"). A removed line is shown as an `li` with
 * the class `removed` (and no other class) whose text ends with
 * ` (removed)`, and has no checkbox; card progress leaves it out.
 */

import { cleanup, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Session } from '../api.js';
import {
  E,
  FakeApi,
  FakeClock,
  SESSION,
  T1,
  TASK,
  WRITABLE,
  all,
  model,
  renderApp,
  setHash,
  withDigest,
} from './client-helpers.js';

const WALL = 9_000_000;
const NOW = WALL + 600_000;
const HASH = 'b'.repeat(64);

beforeEach(() => {
  setHash('');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  setHash('');
  window.sessionStorage.clear();
});

/** T1 in `tests` with `1.1 A` (done), `1.2 B` (done, then removed) and `1.3 C`. */
function inputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(
      T1,
      { title: 'Lines', task: TASK, checklist: ['1.1 A', '1.2 B', '1.3 C'] },
      { actor: 'orch', wall: WALL },
    ),
    E.move(T1, 'tests', { actor: 'orch', wall: WALL + 1 }),
    E.check(T1, 0, true, { actor: 'orch', wall: WALL + 2 }),
    E.check(T1, 1, true, { actor: 'orch', wall: WALL + 3 }),
    E.reconcile(T1, { removed: [1] }, { actor: 'orch', wall: WALL + 4 }),
  ];
}

async function openTicket(session: Session): Promise<FakeApi> {
  setHash(`#/ticket/${T1}`);
  const snapshot = withDigest(model(inputs()), '1');
  const api = new FakeApi(snapshot);
  api.session = session;
  api.onAction = () => ({ status: 200, body: { hash: HASH, ticket: snapshot.tickets[T1] } });
  renderApp(api, new FakeClock(NOW));
  await waitFor(() => {
    expect(document.querySelector('article.ticket')).not.toBeNull();
  });
  return api;
}

function detail(): Element {
  const el = document.querySelector('article.ticket');
  if (el === null) {
    throw new Error('no ticket detail');
  }
  return el;
}

function lines(): { text: string; className: string; boxes: number }[] {
  return all(detail(), 'ul.checklist li').map((li) => ({
    text: li.textContent?.trim() ?? '',
    className: li.className,
    boxes: li.querySelectorAll('input[type="checkbox"]').length,
  }));
}

describe('a removed line in the ticket detail', () => {
  it('scenario: a read-only page shows it marked as removed', async () => {
    await openTicket({ ...SESSION });
    expect(lines()).toEqual([
      { text: '1.1 A', className: 'done', boxes: 0 },
      { text: '1.2 B (removed)', className: 'removed', boxes: 0 },
      { text: '1.3 C', className: '', boxes: 0 },
    ]);
  });

  it('scenario: a writable page offers checkboxes for the active lines only', async () => {
    await openTicket(WRITABLE);
    expect(lines()).toEqual([
      { text: '1.1 A', className: 'done', boxes: 1 },
      { text: '1.2 B (removed)', className: 'removed', boxes: 0 },
      { text: '1.3 C', className: '', boxes: 1 },
    ]);
    const indices = all(detail(), 'ul.checklist input[type="checkbox"]').map((b) =>
      b.getAttribute('data-index'),
    );
    expect(indices).toEqual(['0', '2']);
  });
});

describe('card progress', () => {
  it('counts only active lines on the board card', async () => {
    setHash('#/board');
    const api = new FakeApi(withDigest(model(inputs()), '1'));
    renderApp(api, new FakeClock(NOW));
    await waitFor(() => {
      expect(document.querySelectorAll('section.column')).toHaveLength(6);
    });
    const card = document.querySelector(`article[data-ticket="${T1}"]`);
    expect(card?.querySelector('.progress')?.textContent).toBe('1/2');
  });
});
