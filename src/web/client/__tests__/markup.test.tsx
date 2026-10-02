// @vitest-environment happy-dom
/**
 * Board text is never markup (board-web: "Board text is never markup", scenario
 * "Title with markup"): a title, comment, note, label and actor holding HTML
 * are shown literally in every view, and no element is created from them.
 */

import { cleanup, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { E, FakeApi, FakeClock, T1, TASK, model, renderApp, setHash } from './client-helpers.js';

const TITLE = '<img src=x onerror=alert(1)>';
const COMMENT = '<script>alert(2)</script><b>bold</b>';
const NOTE = '<iframe src="x"></iframe>';
const LABEL = '<svg onload=alert(3)>';
const ACTOR = 'impl<i>1</i>';
const WALL = 1_000_000;

beforeEach(() => {
  setHash('');
});

afterEach(() => {
  cleanup();
  setHash('');
});

function inputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(T1, { title: TITLE, task: TASK, labels: [LABEL] }, { actor: 'orch', wall: WALL }),
    E.handoff(T1, ACTOR, 'tests', NOTE, { actor: 'orch', wall: WALL + 10 }),
    E.comment(T1, COMMENT, { actor: ACTOR, wall: WALL + 20 }),
  ];
}

/** No element was made from the markup in the board's text. */
function expectNoInjectedElements(): void {
  for (const tag of ['img', 'script', 'iframe']) {
    expect(document.body.querySelector(tag), tag).toBeNull();
  }
  const handlers = [...document.body.querySelectorAll('*')].filter((el) =>
    el.getAttributeNames().some((name) => name.startsWith('on')),
  );
  expect(handlers).toEqual([]);
  const made = [...document.body.querySelectorAll('b, i')].filter(
    (el) => el.textContent === 'bold' || el.textContent === '1',
  );
  expect(made).toEqual([]);
}

async function open(hash: string, ready: string): Promise<void> {
  setHash(hash);
  renderApp(new FakeApi(model(inputs())), new FakeClock(WALL + 60_000));
  await waitFor(() => {
    expect(document.querySelector(ready)).not.toBeNull();
  });
}

describe('board text is rendered as text', () => {
  it('shows a title with markup literally on the board (scenario "Title with markup")', async () => {
    await open('#/board', 'article.card');
    const text = document.querySelector(`article.card[data-ticket="${T1}"]`)?.textContent ?? '';
    expect(text).toContain(TITLE);
    expect(text).toContain(LABEL);
    expect(text).toContain(ACTOR);
    expectNoInjectedElements();
  });

  it('shows markup literally in the feed', async () => {
    await open('#/feed', 'li.entry');
    const text = document.querySelector('ol.feed')?.textContent ?? '';
    expect(text).toContain(`created ${TITLE}`);
    expect(text).toContain(`commented: ${COMMENT}`);
    expect(text).toContain(NOTE);
    expectNoInjectedElements();
  });

  it('shows markup literally in the ticket detail', async () => {
    await open(`#/ticket/${T1}`, 'ol.conversation li.message');
    const text = document.querySelector('article.ticket')?.textContent ?? '';
    expect(text).toContain(TITLE);
    expect(text).toContain(COMMENT);
    expect(text).toContain(NOTE);
    expect(text).toContain(LABEL);
    expectNoInjectedElements();
  });

  it('shows markup literally in the lanes', async () => {
    await open('#/lanes', 'section.lane');
    expect(document.querySelector(`section.lane[data-actor="${ACTOR}"]`)?.textContent).toContain(
      ACTOR,
    );
    expect(document.body.textContent).toContain(TITLE);
    expectNoInjectedElements();
  });
});
