// @vitest-environment happy-dom
/**
 * The ticket detail view (board-web: "Board views", scenario "Conversation
 * highlights a decision"; board-view-model: "Conversation view";
 * add-board-web task 4.4): fields, checklist, links, disposition, the
 * conversation with decisions, retractions and hand-offs, and the events
 * with their outcomes, including a rejected event with its reason, read
 * from `/api/tickets/<id>`.
 */

import { cleanup, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BoardModel } from '../../../view/types.js';
import {
  E,
  FakeApi,
  FakeClock,
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

const WALL = 4_000_000;
const NOW = WALL + 600_000;

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

/**
 * T1: created with a task, labels, a description and a checklist; handed
 * off to test-1, claimed again by impl-2 (rejected, already-assigned), a
 * decision later retracted, a decision kept, a hand-off to impl-1, one
 * line checked, links, moved to blocked and closed with a decision.
 */
function detailInputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(
      T1,
      {
        title: 'Session storage',
        description: 'Store sessions server side',
        task: TASK,
        labels: ['auth', 'backend'],
        checklist: ['schema', 'migration'],
      },
      { actor: 'orch', wall: WALL },
    ),
    E.create(T2, { title: 'Unrelated' }, { actor: 'orch', wall: WALL + 5 }),
    E.handoff(T1, 'test-1', 'tests', 'write the tests', { actor: 'orch', wall: WALL + 10 }),
    E.claim(T1, { actor: 'impl-2', wall: WALL + 20 }),
    E.comment(T1, 'DECISION: use cookies', { actor: 'test-1', wall: WALL + 30 }),
    E.comment(T1, 'RETRACTED: see ADR 0006', { actor: 'test-1', wall: WALL + 40 }),
    E.comment(T1, 'DECISION: use sessions', { actor: 'test-1', wall: WALL + 50 }),
    E.handoff(T1, 'impl-1', 'implementing', 'tests are red', { actor: 'test-1', wall: WALL + 60 }),
    E.check(T1, 0, true, { actor: 'impl-1', wall: WALL + 70 }),
    E.link(T1, { pr: 42 }, { actor: 'impl-1', wall: WALL + 80 }),
    E.link(T1, { decision: 'docs/adr/0006.md' }, { actor: 'impl-1', wall: WALL + 90 }),
    E.move(T1, 'blocked', { actor: 'impl-1', wall: WALL + 100 }),
    E.close(T1, { decision: 'docs/adr/0006.md' }, { actor: 'orch', wall: WALL + 110 }),
  ];
}

async function openDetail(
  id: string,
  inputs = detailInputs(),
): Promise<{ api: FakeApi; snapshot: BoardModel }> {
  setHash(`#/ticket/${id}`);
  const snapshot = withDigest(model(inputs), '1');
  const api = new FakeApi(snapshot);
  renderApp(api, new FakeClock(NOW));
  await waitFor(() => {
    expect(document.querySelector('article.ticket')).not.toBeNull();
  });
  return { api, snapshot };
}

function detail(): Element {
  const el = document.querySelector('article.ticket');
  if (el === null) {
    throw new Error('no ticket detail');
  }
  return el;
}

/** The `dd` of the `dt` named `name` in the fields list. */
function field(name: string): string | null {
  const dts = all(detail(), 'dl.fields dt');
  const dt = dts.find((d) => d.textContent?.trim() === name);
  const dd = dt?.nextElementSibling;
  return dd === null || dd === undefined ? null : (dd.textContent?.trim() ?? null);
}

function message(snapshot: BoardModel, text: string): Element | null {
  const view = snapshot.events.find(
    (e) =>
      e.outcome === 'applied' &&
      'body' in e.event &&
      JSON.stringify(e.event.body).includes(JSON.stringify(text).slice(1, -1)),
  );
  return document.querySelector(`ol.conversation li.message[data-hash="${view?.hash ?? 'none'}"]`);
}

describe('ticket detail', () => {
  it('loads the detail from the API by the id in the hash, prefix included', async () => {
    const { api } = await openDetail(T1.slice(0, 8));
    expect(api.requests.some((r) => r.url === `/api/tickets/${T1.slice(0, 8)}`)).toBe(true);
    expect(detail().getAttribute('data-ticket')).toBe(T1);
    expect(detail().querySelector('h2, h1, h3')?.textContent).toContain('Session storage');
  });

  it('shows the fields', async () => {
    await openDetail(T1);
    expect(field('Id')).toBe(T1);
    expect(field('Status')).toBe('blocked');
    expect(field('Assignee')).toBe('impl-1');
    expect(field('Blocked from')).toBe('implementing');
    expect(field('Task')).toBe('openspec:add-board-web#1');
    expect(field('Labels')).toBe('auth, backend');
    expect(field('Created by')).toBe('orch');
    expect(field('Description')).toBe('Store sessions server side');
  });

  it('shows the checklist, the links and the disposition', async () => {
    await openDetail(T1);
    const lines = all(detail(), 'ul.checklist li');
    expect(lines.map((li) => li.textContent?.trim())).toEqual(['schema', 'migration']);
    expect(lines.map((li) => li.classList.contains('done'))).toEqual([true, false]);
    expect(all(detail(), 'ul.links li').map((li) => li.textContent?.trim())).toEqual([
      'pr 42',
      'decision docs/adr/0006.md',
    ]);
    expect(detail().querySelector('.disposition')?.textContent).toContain(
      'closed (decision docs/adr/0006.md)',
    );
  });

  it('shows the conversation in order with system lines', async () => {
    const { snapshot } = await openDetail(T1);
    const items = all(detail(), 'ol.conversation li.message');
    const expected = snapshot.events.filter((e) => e.ticket === T1 && e.outcome === 'applied');
    expect(items.map((li) => li.getAttribute('data-hash'))).toEqual(expected.map((e) => e.hash));
    expect(items[0]?.classList.contains('system')).toBe(true);
    expect(items[0]?.textContent).toContain('created Session storage');
  });

  it('highlights a decision, a retracted decision and a retraction', async () => {
    const { snapshot } = await openDetail(T1);
    const kept = message(snapshot, 'DECISION: use sessions');
    const dropped = message(snapshot, 'DECISION: use cookies');
    const retraction = message(snapshot, 'RETRACTED: see ADR 0006');

    expect(kept?.classList.contains('comment')).toBe(true);
    expect(kept?.classList.contains('decision')).toBe(true);
    expect(kept?.classList.contains('retracted')).toBe(false);
    expect(kept?.textContent).toContain('DECISION: use sessions');
    expect(kept?.textContent).toContain('test-1');

    expect(dropped?.classList.contains('decision')).toBe(true);
    expect(dropped?.classList.contains('retracted')).toBe(true);

    expect(retraction?.classList.contains('retraction')).toBe(true);
    expect(retraction?.classList.contains('decision')).toBe(false);
  });

  it('shows hand-offs as messages naming the recipient, the status and the note', async () => {
    const { snapshot } = await openDetail(T1);
    const handoff = message(snapshot, 'tests are red');
    expect(handoff?.classList.contains('handoff')).toBe(true);
    const text = handoff?.textContent ?? '';
    expect(text).toContain('test-1');
    expect(text).toContain('to impl-1');
    expect(text).toContain('implementing');
    expect(text).toContain('tests are red');
  });

  it('lists the events with their outcomes, a rejected claim with its reason', async () => {
    const { snapshot } = await openDetail(T1);
    const rows = all(detail(), 'ol.events li.event');
    const own = snapshot.events.filter((e) => e.ticket === T1);
    expect(rows.map((li) => li.getAttribute('data-hash'))).toEqual(own.map((e) => e.hash));

    const rejected = all(detail(), 'ol.events li.event[data-outcome="rejected"]');
    expect(rejected).toHaveLength(1);
    const text = rejected[0]?.textContent ?? '';
    expect(text).toContain('ticket.claim');
    expect(text).toContain('impl-2');
    expect(text).toContain('rejected');
    expect(text).toContain('already-assigned');
    expect(all(detail(), 'ol.events li.event[data-outcome="applied"]')).toHaveLength(
      own.length - 1,
    );
  });

  it('shows an unassigned open ticket without a disposition', async () => {
    await openDetail(T2);
    expect(field('Assignee')).toBe('none');
    expect(field('Blocked from')).toBeNull();
    expect(field('Description')).toBeNull();
    expect(detail().querySelector('.disposition')).toBeNull();
    expect(all(detail(), 'ul.checklist li')).toEqual([]);
  });

  it('shows an ad hoc task', async () => {
    const T9 = '01H0000000ACTAV9WEVGEMMVRZ';
    await openDetail(T9, [E.create(T9, { title: 'Chore', adhoc: 'cleanup' }, { wall: WALL })]);
    expect(field('Task')).toBe('ad hoc: cleanup');
  });

  it('reloads the detail when the model changes', async () => {
    const inputs = detailInputs();
    const { api, snapshot } = await openDetail(T2, inputs);
    const extra = E.comment(T2, 'new comment', { actor: 'impl-1', wall: WALL + 200 });
    const after = withDigest(model([...inputs, extra]), '2');
    api.board = after;
    (await streamOf(api)).append(appendOf(after, snapshot.events.length));
    await waitFor(() => {
      expect(detail().querySelector(`li.message[data-hash="${extra.hash}"]`)).not.toBeNull();
    });
    expect(api.requests.filter((r) => r.url.startsWith('/api/tickets/')).length).toBe(2);
  });

  it('shows an unknown ticket as an alert', async () => {
    setHash('#/ticket/01ZZZZZZZZ');
    renderApp(new FakeApi(model(detailInputs())), new FakeClock(NOW));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('no ticket 01ZZZZZZZZ');
  });
});
