// @vitest-environment happy-dom
/**
 * The replay view (board-insights: "Replay", scenario "A rejected claim replays
 * as rejected"), driven through the real app on a fake API and a fake clock:
 * the frozen event list, the slider, stepping (across a rejected claim), play
 * and pause at 1, 4 and 16 events per second, the current event's description,
 * the replayed columns, back to live, events arriving while replaying, a late
 * event at its fold position, text never rendered as markup and no inline
 * style.
 */

import { cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FoldInput } from '../../../events/fold.js';
import { describeEvent } from '../../../view/describe.js';
import type { BoardModel, EventView } from '../../../view/types.js';
import {
  E,
  FakeApi,
  T1,
  T2,
  TASK,
  all,
  appendOf,
  card,
  cardIds,
  column,
  model,
  setHash,
  streamOf,
} from './client-helpers.js';
import { TimedClock, advance, button, field, one, renderTimed, styled } from './insight-helpers.js';

const W = 5_000_000;
const NOW = W + 3_600_000;
const COMMENTS = 30;

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

/**
 * 0 create T1, 1 create T2, 2 claim T1 by impl-1, 3 claim T1 by impl-2
 * (rejected), 4 move T1 to tests, then 30 comments on T2: 35 events.
 */
function inputs(): FoldInput[] {
  return [
    E.create(T1, { title: 'Parser', task: TASK }, { actor: 'orch', wall: W }),
    E.create(T2, { title: 'Docs', task: TASK }, { actor: 'orch', wall: W + 10 }),
    E.claim(T1, { actor: 'impl-1', wall: W + 20 }),
    E.claim(T1, { actor: 'impl-2', wall: W + 30 }),
    E.move(T1, 'tests', { actor: 'impl-1', wall: W + 40 }),
    ...Array.from({ length: COMMENTS }, (_, i) =>
      E.comment(T2, `note ${String(i)}`, { actor: 'writer', wall: W + 100 + i * 10 }),
    ),
  ];
}

const TOTAL = 5 + COMMENTS;

function counter(): string {
  return one(document, 'p.replay-counter').textContent?.trim() ?? '';
}

function current(): Element {
  return one(document, '.replay-event');
}

function slider(): HTMLInputElement {
  return field('replay-position');
}

async function seek(index: number): Promise<void> {
  fireEvent.input(slider(), { target: { value: String(index) } });
  await waitFor(() => {
    expect(counter()).toMatch(new RegExp(`^Event ${String(index + 1)} of `));
  });
}

async function setSpeed(speed: string): Promise<void> {
  fireEvent.change(field('replay-speed'), { target: { value: speed } });
  await waitFor(() => {
    expect(field('replay-speed').value).toBe(speed);
  });
}

/** The assignee text of T1's card in the replayed columns. */
function assigneeOf(id: string): string {
  const el = card(document, id);
  return el?.querySelector('.assignee')?.textContent?.trim() ?? '';
}

async function openReplay(
  m: BoardModel = model(inputs()),
  clock = new TimedClock(NOW),
): Promise<{ api: FakeApi; clock: TimedClock; m: BoardModel }> {
  setHash('#/replay');
  const api = new FakeApi(m);
  renderTimed(api, clock);
  await waitFor(() => {
    expect(document.querySelector('p.replay-counter, p.empty')).not.toBeNull();
  });
  return { api, clock, m };
}

describe('opening', () => {
  it('starts at the present, with the slider, the controls and the fold order note', async () => {
    const { m } = await openReplay();
    expect(m.events).toHaveLength(TOTAL);
    expect(counter()).toBe(`Event ${String(TOTAL)} of ${String(TOTAL)}`);
    expect(slider().type).toBe('range');
    expect(slider().getAttribute('min')).toBe('0');
    expect(slider().getAttribute('max')).toBe(String(TOTAL - 1));
    expect(slider().value).toBe(String(TOTAL - 1));
    expect(one(document, 'label[for="replay-position"]').textContent).toContain('Position');
    expect(current().getAttribute('data-hash')).toBe(m.events.at(-1)?.hash);
    expect(button('Step forward').disabled).toBe(true);
    expect(button('Play').disabled).toBe(true);
    expect(button('Step back').disabled).toBe(false);
    expect(button('Back to live').getAttribute('type')).toBe('button');
    const note = one(document, 'p.replay-note').textContent ?? '';
    expect(note).toContain('fold order');
    expect(note).toContain('late');
    const speed = field('replay-speed') as unknown as HTMLSelectElement;
    expect(speed.value).toBe('1');
    expect([...speed.options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['1', '1 event/s'],
      ['4', '4 events/s'],
      ['16', '16 events/s'],
    ]);
    expect(one(document, 'label[for="replay-speed"]').textContent).toContain('Speed');
    expect(cardIds(column(document, 'tests'))).toEqual([T1]);
    expect(assigneeOf(T1)).toBe('impl-1');
  });

  it('shows the board of any position chosen with the slider, and the event there', async () => {
    const { m } = await openReplay();
    await seek(0);
    expect(counter()).toBe(`Event 1 of ${String(TOTAL)}`);
    const first = m.events[0] as EventView;
    expect(current().getAttribute('data-hash')).toBe(first.hash);
    expect(current().getAttribute('data-outcome')).toBe('applied');
    expect(current().textContent).toContain('orch');
    expect(current().textContent).toContain(describeEvent(first.event));
    expect(all(document, 'section.column').map((c) => c.getAttribute('data-status'))).toEqual([
      'todo',
      'tests',
      'implementing',
      'review',
      'blocked',
      'merged',
    ]);
    expect(cardIds(column(document, 'todo'))).toEqual([T1]);
    expect(card(document, T2)).toBeNull();
    expect(button('Step back').disabled).toBe(true);
    expect(button('Step forward').disabled).toBe(false);
    expect(button('Play').disabled).toBe(false);
  });

  it('shows an empty board as nothing to replay, with the way back to live', async () => {
    await openReplay(model([]));
    expect(one(document, 'p.empty').textContent).toContain('No events to replay.');
    expect(document.querySelector('#replay-position')).toBeNull();
    fireEvent.click(button('Back to live'));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/board');
    });
  });
});

describe('scenario: A rejected claim replays as rejected', () => {
  it('steps across the second claim: rejected, and the ticket still held by the first claimant', async () => {
    await openReplay();
    await seek(2);
    expect(current().getAttribute('data-outcome')).toBe('applied');
    expect(assigneeOf(T1)).toBe('impl-1');
    fireEvent.click(button('Step forward'));
    await waitFor(() => {
      expect(counter()).toBe(`Event 4 of ${String(TOTAL)}`);
    });
    expect(current().getAttribute('data-outcome')).toBe('rejected');
    expect(current().textContent).toContain('impl-2');
    expect(current().textContent).toContain('claimed');
    expect(current().textContent).toContain('rejected: already-assigned');
    expect(assigneeOf(T1)).toBe('impl-1');
    fireEvent.click(button('Step back'));
    await waitFor(() => {
      expect(counter()).toBe(`Event 3 of ${String(TOTAL)}`);
    });
    expect(current().getAttribute('data-outcome')).toBe('applied');
    fireEvent.click(button('Step forward'));
    fireEvent.click(button('Step forward'));
    await waitFor(() => {
      expect(counter()).toBe(`Event 5 of ${String(TOTAL)}`);
    });
    expect(cardIds(column(document, 'tests'))).toEqual([T1]);
  });

  it('recomputes the outcome instead of trusting the one in the model', async () => {
    const m = model(inputs());
    const events = m.events.map((e, i) =>
      i === 3 ? { ...e, outcome: 'applied' as const, reason: null } : e,
    );
    await openReplay({ ...m, events });
    await seek(3);
    expect(current().getAttribute('data-outcome')).toBe('rejected');
    expect(assigneeOf(T1)).toBe('impl-1');
  });
});

describe('play and pause', () => {
  it('plays at 1 event per second, pauses, then plays at 4 and switches to 16', async () => {
    const { clock } = await openReplay();
    await seek(0);
    fireEvent.click(button('Play'));
    await waitFor(() => {
      expect(button('Pause')).toBeDefined();
    });
    await advance(clock, 999);
    expect(counter()).toBe(`Event 1 of ${String(TOTAL)}`);
    await advance(clock, 1);
    expect(counter()).toBe(`Event 2 of ${String(TOTAL)}`);
    await advance(clock, 2000);
    expect(counter()).toBe(`Event 4 of ${String(TOTAL)}`);
    fireEvent.click(button('Pause'));
    await waitFor(() => {
      expect(button('Play')).toBeDefined();
    });
    await advance(clock, 5000);
    expect(counter()).toBe(`Event 4 of ${String(TOTAL)}`);

    await setSpeed('4');
    fireEvent.click(button('Play'));
    await waitFor(() => {
      expect(button('Pause')).toBeDefined();
    });
    await advance(clock, 1000);
    expect(counter()).toBe(`Event 8 of ${String(TOTAL)}`);
    await setSpeed('16');
    await advance(clock, 1000);
    expect(counter()).toBe(`Event 24 of ${String(TOTAL)}`);
    fireEvent.click(button('Pause'));
    await advance(clock, 1000);
    expect(counter()).toBe(`Event 24 of ${String(TOTAL)}`);
  });

  it('plays at 16 events per second', async () => {
    const { clock } = await openReplay();
    await seek(0);
    await setSpeed('16');
    fireEvent.click(button('Play'));
    await waitFor(() => {
      expect(button('Pause')).toBeDefined();
    });
    await advance(clock, 500);
    expect(counter()).toBe(`Event 9 of ${String(TOTAL)}`);
    await advance(clock, 500);
    expect(counter()).toBe(`Event 17 of ${String(TOTAL)}`);
  });

  it('describes each event as play reaches it', async () => {
    const { clock, m } = await openReplay();
    await seek(1);
    fireEvent.click(button('Play'));
    await advance(clock, 1000);
    const third = m.events[2] as EventView;
    expect(current().getAttribute('data-hash')).toBe(third.hash);
    expect(current().textContent).toContain(describeEvent(third.event));
  });

  it('stops by itself at the last position', async () => {
    const { clock } = await openReplay();
    await seek(TOTAL - 4);
    fireEvent.click(button('Play'));
    await advance(clock, 10_000);
    expect(counter()).toBe(`Event ${String(TOTAL)} of ${String(TOTAL)}`);
    expect(button('Play').disabled).toBe(true);
  });

  it('cancels its timer when the view is left', async () => {
    const { clock } = await openReplay();
    await seek(0);
    const idle = clock.pending();
    fireEvent.click(button('Play'));
    await waitFor(() => {
      expect(clock.pending()).toBe(idle + 1);
    });
    fireEvent.click(button('Back to live'));
    await waitFor(() => {
      expect(document.querySelector('p.replay-counter')).toBeNull();
    });
    expect(clock.pending()).toBe(idle);
  });
});

describe('back to live and the frozen list', () => {
  it('goes back to the live board', async () => {
    await openReplay();
    await seek(0);
    fireEvent.click(button('Back to live'));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/board');
    });
    await waitFor(() => {
      expect(document.querySelector('p.replay-counter')).toBeNull();
    });
    expect(cardIds(column(document, 'tests'))).toEqual([T1]);
    expect(card(document, T2)).not.toBeNull();
  });

  it('keeps the frozen list when events arrive while replaying; reopening takes a new copy', async () => {
    const base = inputs();
    const before = model(base);
    const after = model([
      ...base,
      E.comment(T1, 'arrived live', { actor: 'impl-1', wall: W + 5000 }),
    ]);
    const { api } = await openReplay(before);
    const stream = await streamOf(api);
    stream.append(appendOf(after, before.events.length));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counter()).toBe(`Event ${String(TOTAL)} of ${String(TOTAL)}`);
    expect(slider().getAttribute('max')).toBe(String(TOTAL - 1));
    fireEvent.click(button('Back to live'));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/board');
    });
    setHash('#/replay');
    await waitFor(() => {
      expect(counter()).toBe(`Event ${String(TOTAL + 1)} of ${String(TOTAL + 1)}`);
    });
    expect(current().textContent).toContain('arrived live');
  });

  it('shows a late event at its fold position once the view is reopened after the resync', async () => {
    const base = inputs();
    const lateInput = E.comment(T1, 'synced late', { actor: 'remote', wall: W + 25 });
    const before = model(base);
    const after = model([...base, lateInput], [lateInput.hash]);
    const { api } = await openReplay(before);
    const stream = await streamOf(api);
    api.board = after;
    const lateView = after.events.find((e) => e.hash === lateInput.hash) as EventView;
    stream.resync({ type: 'resync', id: after.id, late: [lateView], removed: [] });
    await waitFor(() => {
      expect(api.count('/api/board')).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counter()).toBe(`Event ${String(TOTAL)} of ${String(TOTAL)}`);
    fireEvent.click(button('Back to live'));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/board');
    });
    setHash('#/replay');
    await waitFor(() => {
      expect(counter()).toBe(`Event ${String(TOTAL + 1)} of ${String(TOTAL + 1)}`);
    });
    // Fold order: create, create, claim (W+20), the late comment (W+25), the rejected claim (W+30).
    await seek(3);
    expect(current().getAttribute('data-hash')).toBe(lateInput.hash);
    expect(current().textContent).toContain('commented: synced late');
    await seek(4);
    expect(current().getAttribute('data-outcome')).toBe('rejected');
    await seek(TOTAL);
    expect(current().getAttribute('data-hash')).not.toBe(lateInput.hash);
  });
});

describe('text is never markup, and no inline style', () => {
  it('shows actors and titles holding markup as text, in the event and the cards', async () => {
    const TITLE = '<img src=x onerror=alert(1)>';
    const ACTOR = 'impl<i>1</i>';
    await openReplay(
      model([
        E.create(T1, { title: TITLE, task: TASK }, { actor: 'orch', wall: W }),
        E.claim(T1, { actor: ACTOR, wall: W + 10 }),
        E.comment(T1, '<script>alert(2)</script>', { actor: ACTOR, wall: W + 20 }),
      ]),
    );
    expect(current().textContent).toContain(ACTOR);
    expect(current().textContent).toContain('<script>alert(2)</script>');
    expect(card(document, T1)?.textContent).toContain(TITLE);
    expect(assigneeOf(T1)).toBe(ACTOR);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(all(document, 'i').filter((el) => el.textContent === '1')).toEqual([]);
  });

  it('puts no style attribute on any element, playing or not', async () => {
    const { clock } = await openReplay();
    await seek(0);
    expect(styled(document.body)).toEqual([]);
    fireEvent.click(button('Play'));
    await advance(clock, 3000);
    expect(styled(document.body)).toEqual([]);
  });
});
