// @vitest-environment happy-dom
/**
 * The unplanned disposition in the web views (ADR 0013; board-view-model:
 * "Board columns and cards", scenario "Unplanned card", and "Activity feed
 * entries", scenario "Unplanned summary"; board-web: "Board text is never
 * markup"): the card shows `unplanned` and the reason in place of `ad hoc`,
 * the ticket detail shows the reason and the actor as `show` prints them,
 * the feed shows the summary, and a reason holding markup is text, never an
 * element.
 */

import { cleanup, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FoldInput } from '../../../events/fold.js';
import {
  E,
  FakeApi,
  FakeClock,
  OTHER,
  T1,
  T2,
  T3,
  T4,
  all,
  card,
  column,
  model,
  renderApp,
  setHash,
} from './client-helpers.js';

const WALL = 9_000_000;
const NOW = WALL + 600_000;
const MARKUP = '<script>alert(1)</script><b>bold</b><img src=x onerror=alert(2)>';

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

/** Moves `ticket` from `todo` to `review` as `impl-1`, one wall apart from `wall`. */
function toReview(ticket: string, wall: number): FoldInput[] {
  return [
    E.move(ticket, 'tests', { actor: 'impl-1', wall }),
    E.move(ticket, 'implementing', { actor: 'impl-1', wall: wall + 1 }),
    E.move(ticket, 'review', { actor: 'impl-1', wall: wall + 2 }),
  ];
}

/**
 * T1: ad hoc (`found in prod`), merged by orch with `move T1 merged
 * --unplanned hotfix`. T2: ad hoc (`cleanup`) in todo, no disposition.
 * T3: ad hoc, then linked to a task, in tests. T4: ad hoc, merged as
 * unplanned with a reason made of markup.
 */
function inputs(): FoldInput[] {
  return [
    E.create(T1, { title: 'Hotfix one', adhoc: 'found in prod' }, { actor: 'orch', wall: WALL }),
    E.create(T2, { title: 'Chore', adhoc: 'cleanup' }, { actor: 'orch', wall: WALL + 10 }),
    E.create(T3, { title: 'Linked later', adhoc: 'spike' }, { actor: 'orch', wall: WALL + 20 }),
    E.create(T4, { title: 'Markup one', adhoc: 'markup' }, { actor: 'orch', wall: WALL + 30 }),
    ...toReview(T1, WALL + 100),
    ...toReview(T4, WALL + 110),
    E.link(T3, { task: OTHER }, { actor: 'orch', wall: WALL + 120 }),
    E.move(T3, 'tests', { actor: 'orch', wall: WALL + 121 }),
    E.unplanned(T1, 'hotfix', { actor: 'orch', wall: WALL + 200 }),
    E.move(T1, 'merged', { actor: 'orch', wall: WALL + 201 }),
    E.unplanned(T4, MARKUP, { actor: 'orch', wall: WALL + 300 }),
    E.move(T4, 'merged', { actor: 'orch', wall: WALL + 301 }),
  ];
}

async function open(hash: string, ready: string): Promise<FakeApi> {
  setHash(hash);
  const m = model(inputs());
  expect(m.events.every((e) => e.outcome === 'applied')).toBe(true);
  const api = new FakeApi(m);
  renderApp(api, new FakeClock(NOW));
  await waitFor(() => {
    expect(document.querySelector(ready)).not.toBeNull();
  });
  return api;
}

function cardOf(id: string): Element {
  const el = card(document, id);
  if (el === null) {
    throw new Error(`no card ${id}`);
  }
  return el;
}

function detail(): Element {
  const el = document.querySelector('article.ticket');
  if (el === null) {
    throw new Error('no ticket detail');
  }
  return el;
}

/** The `dd` of the `dt` named `name` in the fields list, or null when there is no such `dt`. */
function field(name: string): string | null {
  const dt = all(detail(), 'dl.fields dt').find((d) => d.textContent?.trim() === name);
  const dd = dt?.nextElementSibling;
  return dd === null || dd === undefined ? null : (dd.textContent?.trim() ?? null);
}

/** The `dt` names of the fields list, in order. */
function fieldNames(): string[] {
  return all(detail(), 'dl.fields dt').map((d) => d.textContent?.trim() ?? '');
}

/** No element was made from the markup in a reason. */
function expectNoInjectedElements(root: ParentNode): void {
  for (const tag of ['script', 'b', 'img']) {
    expect(root.querySelector(tag), tag).toBeNull();
  }
  const handlers = [...root.querySelectorAll('*')].filter((el) =>
    el.getAttributeNames().some((name) => name.startsWith('on')),
  );
  expect(handlers).toEqual([]);
}

describe('the card (scenario "Unplanned card")', () => {
  it('shows unplanned and the reason in place of ad hoc for a merged unplanned ticket', async () => {
    await open('#/board', 'article.card');
    const t1 = cardOf(T1);
    expect(column(document, 'merged').contains(t1)).toBe(true);
    const marker = t1.querySelector('.task.unplanned');
    expect(marker?.textContent?.trim()).toBe('unplanned');
    expect(t1.querySelector('.unplanned-reason')?.textContent).toBe('hotfix');
    expect(t1.querySelector('.task.adhoc')).toBeNull();
    expect(t1.textContent).not.toContain('ad hoc');
    expect(t1.textContent).toContain('Hotfix one');
  });

  it('still shows ad hoc for an undisposed ad hoc ticket, and the reference for a linked one', async () => {
    await open('#/board', 'article.card');
    const t2 = cardOf(T2);
    expect(t2.querySelector('.task.adhoc')?.textContent?.trim()).toBe('ad hoc');
    expect(t2.querySelector('.unplanned')).toBeNull();
    expect(t2.querySelector('.unplanned-reason')).toBeNull();
    expect(t2.textContent).not.toContain('unplanned');
    const t3 = cardOf(T3);
    expect(t3.querySelector('.task')?.textContent).toBe('openspec:add-board-tui#1');
    expect(t3.querySelector('.task.adhoc')).toBeNull();
    expect(t3.querySelector('.unplanned')).toBeNull();
  });

  it('renders a reason holding markup as text, never as markup', async () => {
    await open('#/board', 'article.card');
    const t4 = cardOf(T4);
    expect(t4.querySelector('.unplanned-reason')?.textContent).toBe(MARKUP);
    expectNoInjectedElements(document.body);
    expect([...document.body.querySelectorAll('[style]')]).toEqual([]);
  });

  it('shows the same marker in the agent lanes', async () => {
    // A lane holds the cards of its assigned tickets, so T1 is assigned here.
    setHash('#/lanes');
    const api = new FakeApi(
      model([...inputs(), E.assign(T1, 'impl-1', { actor: 'orch', wall: WALL + 400 })]),
    );
    renderApp(api, new FakeClock(NOW));
    await waitFor(() => {
      expect(card(document, T1)).not.toBeNull();
    });
    const t1 = cardOf(T1);
    expect(t1.querySelector('.task.unplanned')?.textContent?.trim()).toBe('unplanned');
    expect(t1.querySelector('.unplanned-reason')?.textContent).toBe('hotfix');
    expect(t1.textContent).not.toContain('ad hoc');
  });
});

describe('the ticket detail', () => {
  it('shows the ad hoc reason as the task and the unplanned reason with its actor, as show prints them', async () => {
    await open(`#/ticket/${T1}`, 'article.ticket');
    expect(field('Status')).toBe('merged');
    expect(field('Task')).toBe('ad hoc: found in prod');
    expect(field('Unplanned')).toBe('hotfix (by orch)');
    const names = fieldNames();
    expect(names.indexOf('Unplanned')).toBe(names.indexOf('Task') + 1);
    expect(names.filter((n) => n === 'Unplanned')).toHaveLength(1);
  });

  it('shows the disposition in the conversation and the events', async () => {
    await open(`#/ticket/${T1}`, 'ol.conversation li.message');
    const system = all(detail(), 'ol.conversation li.message.system').map(
      (li) => li.querySelector('.message-text')?.textContent ?? '',
    );
    const at = system.indexOf('recorded as unplanned: hotfix');
    expect(at).toBeGreaterThan(0);
    expect(system[at + 1]).toBe('moved to merged');
    const kinds = all(detail(), 'ol.events li.event .kind').map((k) => k.textContent);
    expect(kinds.slice(-2)).toEqual(['ticket.unplanned', 'ticket.move']);
    expect(all(detail(), 'ol.events li.event[data-outcome="applied"]')).toHaveLength(kinds.length);
  });

  it('shows no Unplanned field for an undisposed ad hoc ticket or a linked one', async () => {
    await open(`#/ticket/${T2}`, 'article.ticket');
    expect(field('Task')).toBe('ad hoc: cleanup');
    expect(field('Unplanned')).toBeNull();
    expect(detail().textContent).not.toContain('unplanned');
    cleanup();
    await open(`#/ticket/${T3}`, 'article.ticket');
    expect(field('Task')).toBe('openspec:add-board-tui#1');
    expect(field('Unplanned')).toBeNull();
  });

  it('renders a reason holding markup as text, never as markup', async () => {
    await open(`#/ticket/${T4}`, 'ol.conversation li.message');
    expect(field('Unplanned')).toBe(`${MARKUP} (by orch)`);
    expect(detail().textContent).toContain(`recorded as unplanned: ${MARKUP}`);
    expectNoInjectedElements(document.body);
    expect([...document.body.querySelectorAll('[style]')]).toEqual([]);
  });
});

describe('the feed (scenario "Unplanned summary")', () => {
  it('shows moved to merged and then recorded as unplanned: hotfix, both by orch, newest first', async () => {
    await open('#/feed', 'li.entry');
    const entries = all(document, 'ol.feed li.entry');
    const texts = entries.map((li) => li.textContent ?? '');
    const moved = texts.findIndex((t) => t.includes('moved to merged') && t.includes('Hotfix one'));
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(texts[moved + 1]).toContain('recorded as unplanned: hotfix');
    expect(texts[moved]).toContain('orch');
    expect(texts[moved + 1]).toContain('orch');
    expect(texts[moved + 1]).toContain('Hotfix one');
  });

  it('renders a reason holding markup as text in the feed', async () => {
    await open('#/feed', 'li.entry');
    expect(document.querySelector('ol.feed')?.textContent).toContain(
      `recorded as unplanned: ${MARKUP}`,
    );
    expectNoInjectedElements(document.body);
  });
});
