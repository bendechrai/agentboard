// @vitest-environment happy-dom
/**
 * The hand-off graph view (board-insights: "Hand-off graph", scenarios
 * "Counts per pair", "Claims are not hand-offs", "Filter by change";
 * add-board-insights task 3.3), driven through the real app on a fake API
 * and a fake clock: nodes on a circle in name order, directed edges with
 * their counts, the change and time filters kept in the URL hash, the
 * 3 second animation of an edge when a hand-off on it arrives from the
 * stream, actor names never rendered as markup (inside SVG text too), and
 * no inline style or external reference.
 */

import { cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FoldInput } from '../../../events/fold.js';
import type { TaskRef } from '../../../events/schema.js';
import type { BoardModel } from '../../../view/types.js';
import { parseHash } from '../hash.js';
import { GRAPH_ANIMATION_MS, GRAPH_CENTER, GRAPH_RADIUS, GRAPH_SIZE } from '../views/GraphView.js';
import {
  E,
  FakeApi,
  T1,
  T2,
  T3,
  TASK,
  all,
  appendOf,
  model,
  setHash,
  streamOf,
} from './client-helpers.js';
import { TimedClock, advance, field, one, renderTimed, styled } from './insight-helpers.js';

const HOUR = 3_600_000;
const W = 10_000_000;
const NOW = W + 5 * HOUR;
const LOGIN: TaskRef = { source: 'openspec', ref: 'add-login', item: '1' };

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

/** Scenario "Counts per pair": test-1 to impl-1 twice, impl-1 to reviewer-1 once. */
function pairs(): FoldInput[] {
  return [
    E.create(T1, { title: 'one', task: TASK }, { wall: W }),
    E.create(T2, { title: 'two', task: TASK }, { wall: W + 10 }),
    E.handoff(T1, 'impl-1', 'todo', 'tests ready', { actor: 'test-1', wall: W + 100 }),
    E.handoff(T2, 'impl-1', 'todo', 'more tests', { actor: 'test-1', wall: W + 200 }),
    E.handoff(T1, 'reviewer-1', 'todo', 'please review', { actor: 'impl-1', wall: W + 300 }),
  ];
}

function constants(): void {
  expect(GRAPH_SIZE).toBe(600);
  expect(GRAPH_CENTER).toBe(300);
  expect(GRAPH_RADIUS).toBe(220);
  expect(GRAPH_ANIMATION_MS).toBe(3000);
}

function svg(): Element {
  return one(document, 'svg.handoff-graph');
}

/** `[from, to, count]` of every edge group, in document order. */
function edges(): [string, string, string][] {
  return all(svg(), 'g.edge').map((g) => [
    g.getAttribute('data-from') ?? '',
    g.getAttribute('data-to') ?? '',
    g.getAttribute('data-count') ?? '',
  ]);
}

function edge(from: string, to: string): Element {
  return one(svg(), `g.edge[data-from="${from}"][data-to="${to}"]`);
}

function nodes(): Element[] {
  return all(svg(), 'g.node');
}

function animated(): [string, string][] {
  return all(svg(), 'g.edge.animated').map((g) => [
    g.getAttribute('data-from') ?? '',
    g.getAttribute('data-to') ?? '',
  ]);
}

async function openGraph(
  hash: string,
  m: BoardModel,
  clock = new TimedClock(NOW),
): Promise<{ api: FakeApi; clock: TimedClock }> {
  setHash(hash);
  const api = new FakeApi(m);
  renderTimed(api, clock);
  await waitFor(() => {
    expect(document.querySelector('svg.handoff-graph, p.empty')).not.toBeNull();
  });
  return { api, clock };
}

describe('scenario: Counts per pair', () => {
  it('draws each directed pair once with its count, and each actor with its totals', async () => {
    constants();
    await openGraph('#/graph', model(pairs()));
    expect(svg().getAttribute('viewBox')).toBe('0 0 600 600');
    expect(svg().getAttribute('role')).toBe('img');
    expect(svg().getAttribute('aria-label')).toBe('Hand-off graph');
    expect(edges()).toEqual([
      ['impl-1', 'reviewer-1', '1'],
      ['test-1', 'impl-1', '2'],
    ]);
    expect(one(edge('test-1', 'impl-1'), 'text.edge-count').textContent?.trim()).toBe('2');
    expect(one(edge('impl-1', 'reviewer-1'), 'text.edge-count').textContent?.trim()).toBe('1');
    expect(
      nodes().map((g) => [
        g.getAttribute('data-actor'),
        g.getAttribute('data-sent'),
        g.getAttribute('data-received'),
      ]),
    ).toEqual([
      ['impl-1', '1', '2'],
      ['reviewer-1', '0', '1'],
      ['test-1', '2', '0'],
    ]);
    const impl = one(svg(), 'g.node[data-actor="impl-1"]');
    expect(one(impl, 'text').textContent).toBe('impl-1');
    expect(one(impl, 'title').textContent).toBe('impl-1: sent 1, received 2');
  });

  it('lists the edges in a table, in the same order', async () => {
    await openGraph('#/graph', model(pairs()));
    const rows = all(one(document, 'table.edge-table'), 'tbody tr');
    expect(rows.map((r) => [r.getAttribute('data-from'), r.getAttribute('data-to')])).toEqual([
      ['impl-1', 'reviewer-1'],
      ['test-1', 'impl-1'],
    ]);
    expect(all(rows[1] as Element, 'td').map((td) => td.textContent?.trim())).toEqual([
      'test-1',
      'impl-1',
      '2',
    ]);
  });

  it('draws edges as arrows whose width grows with the count', async () => {
    await openGraph('#/graph', model(pairs()));
    const marker = one(svg(), 'defs marker');
    expect(marker.getAttribute('id')).toBe('graph-arrow');
    const width = (from: string, to: string): number => {
      const path = one(edge(from, to), 'path');
      expect(path.getAttribute('marker-end')).toBe('url(#graph-arrow)');
      return Number(path.getAttribute('stroke-width'));
    };
    expect(width('impl-1', 'reviewer-1')).toBe(1);
    expect(width('test-1', 'impl-1')).toBeGreaterThan(1);
  });
});

describe('layout', () => {
  it('puts the nodes on a circle in actor name order, the first at the top, clockwise', async () => {
    const actors = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const inputs: FoldInput[] = [E.create(T1, { title: 'one', task: TASK }, { wall: W })];
    actors.forEach((actor, i) => {
      const to = actors[(i + 1) % actors.length] ?? 'alpha';
      inputs.push(E.handoff(T1, to, 'todo', 'next', { actor, wall: W + 10 + i }));
    });
    await openGraph('#/graph', model(inputs));
    const placed = nodes();
    expect(placed.map((g) => g.getAttribute('data-actor'))).toEqual(actors);
    placed.forEach((g, i) => {
      const circle = one(g, 'circle');
      const cx = Number(circle.getAttribute('cx'));
      const cy = Number(circle.getAttribute('cy'));
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / actors.length;
      expect(Math.hypot(cx - GRAPH_CENTER, cy - GRAPH_CENTER)).toBeCloseTo(GRAPH_RADIUS, 3);
      expect(cx).toBeCloseTo(GRAPH_CENTER + GRAPH_RADIUS * Math.cos(angle), 3);
      expect(cy).toBeCloseTo(GRAPH_CENTER + GRAPH_RADIUS * Math.sin(angle), 3);
    });
  });

  it('places a single actor (a self hand-off) at the top, with a self-loop edge', async () => {
    await openGraph(
      '#/graph',
      model([
        E.create(T1, { title: 'one', task: TASK }, { wall: W }),
        E.handoff(T1, 'solo', 'todo', 'note to self', { actor: 'solo', wall: W + 10 }),
      ]),
    );
    expect(edges()).toEqual([['solo', 'solo', '1']]);
    const circle = one(svg(), 'g.node[data-actor="solo"] circle');
    expect(Number(circle.getAttribute('cx'))).toBeCloseTo(GRAPH_CENTER, 3);
    expect(Number(circle.getAttribute('cy'))).toBeCloseTo(GRAPH_CENTER - GRAPH_RADIUS, 3);
  });
});

describe('scenario: Claims are not hand-offs', () => {
  it('draws no edge between the releasing and the claiming actor', async () => {
    await openGraph(
      '#/graph',
      model([
        E.create(T1, { title: 'one', task: TASK }, { wall: W }),
        E.claim(T1, { actor: 'impl-1', wall: W + 10 }),
        E.release(T1, { actor: 'impl-1', wall: W + 20 }),
        E.claim(T1, { actor: 'impl-2', wall: W + 30 }),
        E.assign(T1, 'impl-3', { actor: 'orch', wall: W + 40 }),
      ]),
    );
    expect(document.querySelector('svg.handoff-graph')).toBeNull();
    expect(one(document, 'p.empty').textContent).toContain('No hand-offs match.');
  });
});

describe('filters', () => {
  /** pairs() plus a self hand-off on a ticket of the change openspec:add-login. */
  function withLogin(): FoldInput[] {
    return [
      ...pairs(),
      E.create(T3, { title: 'login', task: LOGIN }, { wall: W + 400 }),
      E.handoff(T3, 'orch', 'todo', 'self', { actor: 'orch', wall: W + 500 }),
    ];
  }

  it('scenario: Filter by change, from the URL hash', async () => {
    await openGraph('#/graph?change=openspec:add-login', model(withLogin()));
    expect(edges()).toEqual([['orch', 'orch', '1']]);
    expect(nodes().map((g) => g.getAttribute('data-actor'))).toEqual(['orch']);
    expect(field('graph-change').value).toBe('openspec:add-login');
  });

  it('offers every change and writes the chosen one into the URL hash', async () => {
    await openGraph('#/graph', model(withLogin()));
    expect(edges()).toHaveLength(3);
    const select = field('graph-change') as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'openspec:add-board-web',
      'openspec:add-login',
    ]);
    expect(one(document, 'label[for="graph-change"]').textContent).toContain('Change');
    fireEvent.change(select, { target: { value: 'openspec:add-board-web' } });
    await waitFor(() => {
      expect(parseHash(window.location.hash)).toEqual({
        view: 'graph',
        change: 'openspec:add-board-web',
        since: null,
      });
    });
    await waitFor(() => {
      expect(edges()).toEqual([
        ['impl-1', 'reviewer-1', '1'],
        ['test-1', 'impl-1', '2'],
      ]);
    });
  });

  it('counts only hand-offs within the chosen time window', async () => {
    const recent = E.handoff(T1, 'reviewer-1', 'todo', 'fresh', {
      actor: 'impl-1',
      wall: NOW - HOUR / 2,
    });
    const m = model([...pairs(), recent]);
    await openGraph('#/graph?since=1h', m);
    expect(edges()).toEqual([['impl-1', 'reviewer-1', '1']]);
    const select = field('graph-since') as unknown as HTMLSelectElement;
    expect(select.value).toBe('1h');
    expect([...select.options].map((o) => o.value)).toEqual(['', '1h', '1d', '7d', '30d']);
    expect(one(document, 'label[for="graph-since"]').textContent).toContain('Since');
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      expect(parseHash(window.location.hash)).toEqual({ view: 'graph', change: null, since: null });
    });
    await waitFor(() => {
      expect(edges()).toEqual([
        ['impl-1', 'reviewer-1', '2'],
        ['test-1', 'impl-1', '2'],
      ]);
    });
  });

  it('keeps an unlisted valid window from the hash selectable, and ignores an invalid one', async () => {
    await openGraph('#/graph?since=3h', model(pairs()));
    const select = field('graph-since') as unknown as HTMLSelectElement;
    expect(select.value).toBe('3h');
    expect([...select.options].map((o) => o.value)).toContain('3h');
    cleanup();
    await openGraph('#/graph?since=3hours', model(pairs()));
    expect(field('graph-since').value).toBe('');
    expect(edges()).toHaveLength(2);
  });
});

describe('animation of a live hand-off', () => {
  it('animates only the edge of a hand-off that arrives from the stream, for 3 seconds', async () => {
    const base = pairs();
    const before = model(base);
    const after = model([
      ...base,
      E.handoff(T2, 'reviewer-1', 'todo', 'live one', { actor: 'impl-1', wall: W + 1000 }),
    ]);
    const { api, clock } = await openGraph('#/graph', before);
    expect(animated()).toEqual([]);
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(edge('impl-1', 'reviewer-1').getAttribute('data-count')).toBe('2');
    });
    await waitFor(() => {
      expect(animated()).toEqual([['impl-1', 'reviewer-1']]);
    });
    await advance(clock, GRAPH_ANIMATION_MS - 1);
    expect(animated()).toEqual([['impl-1', 'reviewer-1']]);
    await advance(clock, 1);
    expect(animated()).toEqual([]);
  });

  it('restarts the 3 seconds when another hand-off on the same edge arrives', async () => {
    const base = pairs();
    const before = model(base);
    const first = E.handoff(T1, 'impl-1', 'todo', 'again', { actor: 'test-1', wall: W + 1000 });
    const second = E.handoff(T2, 'impl-1', 'todo', 'and again', {
      actor: 'test-1',
      wall: W + 2000,
    });
    const middle = model([...base, first]);
    const after = model([...base, first, second]);
    const { api, clock } = await openGraph('#/graph', before);
    const stream = await streamOf(api);
    stream.append(appendOf(middle, before.events.length));
    await waitFor(() => {
      expect(edge('test-1', 'impl-1').getAttribute('data-count')).toBe('3');
    });
    await waitFor(() => {
      expect(animated()).toEqual([['test-1', 'impl-1']]);
    });
    await advance(clock, 2000);
    stream.append(appendOf(after, middle.events.length));
    await waitFor(() => {
      expect(edge('test-1', 'impl-1').getAttribute('data-count')).toBe('4');
    });
    // Let the view take note of the second arrival before time moves on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await advance(clock, 2000);
    expect(animated()).toEqual([['test-1', 'impl-1']]);
    await advance(clock, 1000);
    expect(animated()).toEqual([]);
  });

  it('does not animate for other events arriving', async () => {
    const base = pairs();
    const before = model(base);
    const after = model([...base, E.comment(T1, 'just a comment', { wall: W + 1000 })]);
    const { api } = await openGraph('#/graph', before);
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(animated()).toEqual([]);
  });

  it('cancels its timers when the view is left', async () => {
    const base = pairs();
    const before = model(base);
    const after = model([
      ...base,
      E.handoff(T2, 'reviewer-1', 'todo', 'live one', { actor: 'impl-1', wall: W + 1000 }),
    ]);
    const { api, clock } = await openGraph('#/graph', before);
    const idle = clock.pending();
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(animated()).toHaveLength(1);
    });
    expect(clock.pending()).toBeGreaterThan(idle);
    setHash('#/board');
    await waitFor(() => {
      expect(document.querySelector('svg.handoff-graph')).toBeNull();
    });
    expect(clock.pending()).toBe(idle);
  });
});

describe('text is never markup, and no inline style or external reference', () => {
  const EVIL = '<img src=x onerror=alert(1)>';
  const SCRIPTY = '<script>alert(2)</script>';

  function evil(): BoardModel {
    return model([
      E.create(T1, { title: 'one', task: TASK }, { wall: W }),
      E.handoff(T1, SCRIPTY, 'todo', 'note', { actor: EVIL, wall: W + 10 }),
    ]);
  }

  it('renders actor names holding markup as text, in SVG text, titles and the table', async () => {
    await openGraph('#/graph', evil());
    const labels = all(svg(), 'g.node text').map((t) => t.textContent);
    expect(labels).toEqual([SCRIPTY, EVIL].sort());
    expect(all(svg(), 'g.node title').map((t) => t.textContent)).toContain(
      `${EVIL}: sent 1, received 0`,
    );
    expect(one(document, 'table.edge-table').textContent).toContain(EVIL);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(edge(EVIL, SCRIPTY).getAttribute('data-count')).toBe('1');
  });

  it('puts no style attribute on any element and references nothing outside the page', async () => {
    const base = pairs();
    const before = model(base);
    const after = model([
      ...base,
      E.handoff(T2, 'reviewer-1', 'todo', 'live one', { actor: 'impl-1', wall: W + 1000 }),
    ]);
    const { api } = await openGraph('#/graph', before);
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(animated()).toHaveLength(1);
    });
    expect(styled(document.body)).toEqual([]);
    const refs = all(document.body, '*').flatMap((el) =>
      el
        .getAttributeNames()
        .filter((name) => name === 'href' || name === 'xlink:href' || name === 'src')
        .map((name) => el.getAttribute(name) ?? ''),
    );
    expect(refs.filter((ref) => !ref.startsWith('#'))).toEqual([]);
  });
});
