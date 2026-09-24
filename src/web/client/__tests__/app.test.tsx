// @vitest-environment happy-dom
/**
 * The app shell with the client model (board-web: "Board views"; design.md:
 * "Client model"; add-board-web task 4.2): the initial load, an append, a
 * resync reload with late entries marked, the problem banner, the 10
 * second refresh of relative times, restoring the view and its filters
 * from the URL hash, the missing or refused token, and the bootstrap of
 * `mount` and `main.tsx` taking the token from the URL fragment.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { render as preactRender } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.js';
import { ROOT_ID, mount } from '../mount.js';
import {
  E,
  FakeApi,
  FakeClock,
  SESSION,
  T1,
  T2,
  T3,
  TASK,
  TOKEN,
  OTHER,
  all,
  appendOf,
  card,
  cardIds,
  column,
  fakeDeps,
  model,
  renderApp,
  setHash,
  streamOf,
  withDigest,
} from './client-helpers.js';

const WALL = 1_000_000;
const NOW = WALL + 3_600_000;

beforeEach(() => {
  setHash('');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setHash('');
  window.sessionStorage.clear();
});

function inputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(T1, { title: 'Write the parser', task: TASK }, { actor: 'orch', wall: WALL }),
    E.create(T2, { title: 'Review docs', task: OTHER }, { actor: 'orch', wall: WALL + 10 }),
    E.claim(T1, { actor: 'impl-1', wall: WALL + 20 }),
    E.handoff(T2, 'reviewer-1', 'tests', 'please test', { actor: 'orch', wall: WALL + 30 }),
    E.comment(T1, 'started', { actor: 'impl-1', wall: WALL + 40 }),
  ];
}

async function loaded(api: FakeApi, clock = new FakeClock(NOW)): Promise<void> {
  renderApp(api, clock);
  await waitFor(() => {
    expect(document.querySelectorAll('section.column')).toHaveLength(6);
  });
}

describe('initial load', () => {
  it('shows a loading text, then the board with the session', async () => {
    const api = new FakeApi(model(inputs()));
    renderApp(api, new FakeClock(NOW));
    expect(screen.getByText('Loading board...')).toBeTruthy();

    await waitFor(() => {
      expect(card(document, T1)).not.toBeNull();
    });
    expect(screen.queryByText('Loading board...')).toBeNull();
    expect(document.body.textContent).toContain(SESSION.boardDir);
    expect(all(document, 'section.column').map((c) => c.getAttribute('data-status'))).toEqual([
      'todo',
      'tests',
      'implementing',
      'review',
      'blocked',
      'merged',
    ]);
    expect(cardIds(column(document, 'todo'))).toEqual([T1]);
    expect(cardIds(column(document, 'tests'))).toEqual([T2]);
    const links = all(document, 'nav a').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Board', '#/board'],
      ['Feed', '#/feed'],
      ['Lanes', '#/lanes'],
    ]);
  });

  it('shows the failure of the first load as an alert', async () => {
    const api = new FakeApi(model(inputs()));
    api.failures.set('/api/board', {
      status: 500,
      body: {
        error: { exitCode: 3, reason: 'integrity', message: 'cache is corrupt', hint: null },
      },
    });
    renderApp(api, new FakeClock(NOW));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('cache is corrupt');
  });

  it('opens the stream at the snapshot id', async () => {
    const snapshot = withDigest(model(inputs()), '7');
    const api = new FakeApi(snapshot);
    await loaded(api);
    const stream = await streamOf(api);
    expect(stream.url).toBe(`/api/stream?since=${encodeURIComponent(snapshot.id)}`);
    expect(stream.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });
});

describe('live updates', () => {
  it('moves a card on an append, marked changed, without a reload', async () => {
    const base = inputs();
    const before = withDigest(model(base), '1');
    const api = new FakeApi(before);
    const clock = new FakeClock(NOW);
    await loaded(api, clock);
    expect(card(column(document, 'todo'), T1)?.classList.contains('changed')).toBe(false);
    const boards = api.count('/api/board');

    const moveWall = NOW + 1000;
    const after = withDigest(
      model([...base, E.move(T1, 'tests', { actor: 'impl-1', wall: moveWall })]),
      '2',
    );
    clock.now = moveWall + 500;
    (await streamOf(api)).append(appendOf(after, before.events.length));

    await waitFor(() => {
      expect(card(column(document, 'tests'), T1)).not.toBeNull();
    });
    expect(card(column(document, 'todo'), T1)).toBeNull();
    expect(card(document, T1)?.classList.contains('changed')).toBe(true);
    expect(card(document, T2)?.classList.contains('changed')).toBe(false);
    expect(api.count('/api/board')).toBe(boards);
  });

  it('reloads on a resync and marks the late entries in the feed', async () => {
    setHash('#/feed');
    const base = inputs();
    const before = withDigest(model(base), '1');
    const api = new FakeApi(before);
    renderApp(api, new FakeClock(NOW));
    await waitFor(() => {
      expect(document.querySelectorAll('li.entry')).toHaveLength(5);
    });
    expect(document.querySelectorAll('li.entry.late')).toHaveLength(0);

    const late = E.comment(T2, 'arrived by sync', { actor: 'remote', wall: WALL + 15 });
    const after = withDigest(model([...base, late]), '2');
    api.board = after;
    const lateView = after.events.find((e) => e.hash === late.hash);
    if (lateView === undefined) {
      throw new Error('fixture: late event missing');
    }
    (await streamOf(api)).resync({ type: 'resync', id: after.id, late: [lateView], removed: [] });

    await waitFor(() => {
      expect(document.querySelectorAll('li.entry')).toHaveLength(6);
    });
    const marked = all(document, 'li.entry.late');
    expect(marked.map((li) => li.getAttribute('data-hash'))).toEqual([late.hash]);
    expect(marked[0]?.textContent).toContain('commented: arrived by sync');
    expect(api.latestStream().url).toBe(`/api/stream?since=${encodeURIComponent(after.id)}`);
  });

  it('shows a problem banner until the stream recovers', async () => {
    const base = inputs();
    const before = withDigest(model(base), '1');
    const api = new FakeApi(before);
    await loaded(api);
    expect(screen.queryByRole('alert')).toBeNull();

    (await streamOf(api)).problem({
      error: {
        exitCode: 3,
        reason: 'integrity',
        message: 'events/ab.json is not canonical',
        hint: 'restore the file from git',
      },
    });
    const banner = await screen.findByRole('alert');
    expect(banner.classList.contains('problem')).toBe(true);
    expect(banner.textContent).toContain('events/ab.json is not canonical');
    expect(banner.textContent).toContain('restore the file from git');
    expect(card(document, T1)).not.toBeNull();

    const after = withDigest(
      model([...base, E.move(T1, 'tests', { actor: 'impl-1', wall: WALL + 100 })]),
      '2',
    );
    api.board = after;
    api.latestStream().append(appendOf(after, before.events.length));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(card(column(document, 'tests'), T1)).not.toBeNull();
  });

  it('re-renders relative times every 10 seconds', async () => {
    setHash('#/lanes');
    const clock = new FakeClock(WALL + 40 + 5_000);
    renderApp(new FakeApi(model(inputs())), clock);
    const lastSeen = (): string | null | undefined =>
      document.querySelector('section.lane[data-actor="impl-1"] .last-seen')?.textContent;
    await waitFor(() => {
      expect(lastSeen()).toContain('last seen just now');
    });

    const timers = clock.active();
    expect(timers.map((t) => t.ms)).toEqual([10_000]);
    clock.now = WALL + 40 + 65_000;
    act(() => {
      clock.fire();
    });
    await waitFor(() => {
      expect(lastSeen()).toContain('last seen 1m ago');
    });
  });

  it('stops the client when unmounted', async () => {
    const clock = new FakeClock(NOW);
    const api = new FakeApi(model(inputs()));
    const { unmount } = render(<App token={TOKEN} deps={fakeDeps(api, clock)} />);
    const stream = await streamOf(api);
    unmount();
    expect(stream.aborted).toBe(true);
    expect(clock.active()).toEqual([]);
  });
});

describe('access token', () => {
  it('without a token shows how to open the board and requests nothing', async () => {
    const api = new FakeApi(model(inputs()));
    render(<App token={null} deps={fakeDeps(api, new FakeClock(NOW))} />);
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('no-token')).toBe(true);
    expect(alert.textContent).toContain('Open the URL printed by agentboard serve');
    expect(document.querySelector('section.column')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.requests).toEqual([]);
  });

  it('shows the same message when the server refuses the token', async () => {
    const api = new FakeApi(model(inputs()));
    api.token = 'another-token-another-token-another-token-x';
    renderApp(api, new FakeClock(NOW));
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('no-token')).toBe(true);
    expect(alert.textContent).toContain('Open the URL printed by agentboard serve');
    expect(document.querySelector('section.column')).toBeNull();
  });

  it('shows the message when the stream is refused after the load', async () => {
    const api = new FakeApi(model(inputs()));
    const clock = new FakeClock(NOW);
    await loaded(api, clock);
    const stream = await streamOf(api);
    api.token = 'another-token-another-token-another-token-x';
    stream.end();
    await waitFor(() => {
      expect(clock.pending()).toHaveLength(1);
    });
    act(() => {
      clock.runTimeouts();
    });
    const alert = await screen.findByRole('alert');
    expect(alert.classList.contains('no-token')).toBe(true);
    expect(document.querySelector('section.column')).toBeNull();
  });
});

describe('URL hash', () => {
  function feedInputs(): ReturnType<typeof E.create>[] {
    return [
      E.create(T1, { title: 'one', task: TASK }, { actor: 'orch', wall: WALL }),
      E.create(T2, { title: 'two', task: OTHER }, { actor: 'orch', wall: WALL + 10 }),
      E.handoff(T1, 'impl-1', 'tests', 'go', { actor: 'orch', wall: WALL + 20 }),
      E.handoff(T2, 'impl-2', 'tests', 'go', { actor: 'impl-1', wall: WALL + 30 }),
      E.comment(T1, 'note', { actor: 'impl-1', wall: WALL + 40 }),
      E.handoff(T1, 'rev', 'tests', 'done', { actor: 'impl-1', wall: WALL + 50 }),
    ];
  }

  it('restores the feed view and its filters from the hash', async () => {
    const snapshot = model(feedInputs());
    setHash('#/feed?actor=impl-1&kind=ticket.handoff');
    renderApp(new FakeApi(snapshot), new FakeClock(NOW));

    await waitFor(() => {
      expect(document.querySelectorAll('li.entry').length).toBeGreaterThan(0);
    });
    const hashes = all(document, 'li.entry').map((li) => li.getAttribute('data-hash'));
    const expected = snapshot.events
      .filter((e) => e.actor === 'impl-1' && e.kind === 'ticket.handoff')
      .map((e) => e.hash)
      .reverse();
    expect(hashes).toEqual(expected);
    expect((screen.getByLabelText('Actor') as HTMLSelectElement).value).toBe('impl-1');
    expect((screen.getByLabelText('ticket.handoff') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('ticket.comment') as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('section.column')).toBeNull();
  });

  it('restores the board filters from the hash', async () => {
    const base = [
      E.create(T1, { title: 'mine', task: TASK }, { actor: 'orch', wall: WALL }),
      E.create(T2, { title: 'theirs', task: TASK }, { actor: 'orch', wall: WALL + 10 }),
      E.create(T3, { title: 'other change', task: OTHER }, { actor: 'orch', wall: WALL + 20 }),
      E.assign(T1, 'impl-1', { wall: WALL + 30 }),
      E.assign(T2, 'impl-2', { wall: WALL + 40 }),
      E.assign(T3, 'impl-1', { wall: WALL + 50 }),
    ];
    setHash(`#/board?change=${encodeURIComponent('openspec:add-board-web')}&assignee=impl-1`);
    renderApp(new FakeApi(model(base)), new FakeClock(NOW));
    await waitFor(() => {
      expect(document.querySelectorAll('section.column')).toHaveLength(6);
    });
    expect(cardIds(document)).toEqual([T1]);
    expect((screen.getByLabelText('Change') as HTMLSelectElement).value).toBe(
      'openspec:add-board-web',
    );
    expect((screen.getByLabelText('Assignee') as HTMLSelectElement).value).toBe('impl-1');
  });

  it('follows hash changes between views', async () => {
    await loaded(new FakeApi(model(feedInputs())));
    act(() => {
      setHash('#/lanes');
    });
    await waitFor(() => {
      expect(document.querySelectorAll('section.lane').length).toBeGreaterThan(0);
    });
    expect(document.querySelector('section.column')).toBeNull();
    act(() => {
      setHash(`#/ticket/${T1}`);
    });
    await waitFor(() => {
      expect(document.querySelector(`article.ticket[data-ticket="${T1}"]`)).not.toBeNull();
    });
  });
});

describe('bootstrap', () => {
  function root(): HTMLElement {
    const el = document.createElement('div');
    el.id = ROOT_ID;
    document.body.append(el);
    return el;
  }

  it('mount takes the token from the fragment, stores it, clears it and uses it', async () => {
    const api = new FakeApi(model(inputs()));
    vi.stubGlobal('fetch', api.fetch);
    setHash(`#token=${TOKEN}`);
    const el = root();
    try {
      mount(el);
      expect(window.location.hash).toBe('');
      expect(window.sessionStorage.getItem('agentboard-token')).toBe(TOKEN);
      await waitFor(() => {
        expect(el.querySelector(`article.card[data-ticket="${T1}"]`)).not.toBeNull();
      });
      expect(api.count('/api/board')).toBe(1);
      for (const { url, init } of api.requests) {
        expect(url).not.toContain(TOKEN);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      }
      await streamOf(api);
      expect(() => {
        mount(null);
      }).not.toThrow();
    } finally {
      preactRender(null, el);
      el.remove();
    }
  });

  it('mount uses the stored token on a reload and keeps the view route', async () => {
    const api = new FakeApi(model(inputs()));
    vi.stubGlobal('fetch', api.fetch);
    window.sessionStorage.setItem('agentboard-token', TOKEN);
    setHash('#/lanes');
    const el = root();
    try {
      mount(el);
      await waitFor(() => {
        expect(el.querySelectorAll('section.lane').length).toBeGreaterThan(0);
      });
      expect(window.location.hash).toBe('#/lanes');
    } finally {
      preactRender(null, el);
      el.remove();
    }
  });

  it('mount with a malformed token shows the message and requests nothing', async () => {
    const api = new FakeApi(model(inputs()));
    vi.stubGlobal('fetch', api.fetch);
    setHash('#token=nope');
    const el = root();
    try {
      mount(el);
      expect(window.location.hash).toBe('');
      await waitFor(() => {
        expect(el.querySelector('.no-token')?.textContent).toContain(
          'Open the URL printed by agentboard serve',
        );
      });
      expect(api.requests).toEqual([]);
      expect(window.sessionStorage.getItem('agentboard-token')).toBeNull();
    } finally {
      preactRender(null, el);
      el.remove();
    }
  });

  it('main.tsx mounts into the #app element', async () => {
    const api = new FakeApi(model(inputs()));
    vi.stubGlobal('fetch', api.fetch);
    setHash(`#token=${TOKEN}`);
    const el = root();
    try {
      await import('../main.js');
      await waitFor(() => {
        expect(el.querySelector(`article.card[data-ticket="${T1}"]`)).not.toBeNull();
      });
      expect(window.location.hash).toBe('');
    } finally {
      preactRender(null, el);
      el.remove();
    }
  });
});
