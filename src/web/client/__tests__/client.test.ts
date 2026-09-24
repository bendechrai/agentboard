/**
 * The client model (design.md: "Client model"; board-web: "Board views",
 * "Access token"; add-board-web task 4.2): loading the snapshot through
 * every page of the events API with the Bearer token, following the stream
 * read with `fetch`, appends, resync reloads with late entries, problems,
 * 401s, the 10 second refresh. No DOM is needed: these run in the Node
 * environment.
 */

import { describe, expect, it, vi } from 'vitest';

import type { BoardModel } from '../../../view/types.js';
import { ApiError, apiHeaders, getJson, loadModel, loadSession, loadTicketDetail } from '../api.js';
import { BoardClient, REFRESH_MS, type ClientState } from '../client.js';
import {
  E,
  FakeApi,
  FakeClock,
  SESSION,
  T1,
  T2,
  TASK,
  TOKEN,
  appendOf,
  errorDoc,
  fakeConn,
  fakeDeps,
  model,
  positionId,
  withDigest,
} from './client-helpers.js';

const NOW = 5_000_000;

/** A small board: T1 created and claimed, T2 created, one comment. */
function baseInputs(): ReturnType<typeof E.create>[] {
  return [
    E.create(T1, { title: 'first', task: TASK }, { actor: 'orch', wall: 1_000_000 }),
    E.create(T2, { title: 'second' }, { actor: 'orch', wall: 1_000_010 }),
    E.claim(T1, { actor: 'impl-1', wall: 1_000_020 }),
    E.comment(T1, 'hello', { actor: 'impl-1', wall: 1_000_030 }),
  ];
}

async function started(api: FakeApi, clock = new FakeClock(NOW)): Promise<BoardClient> {
  const client = new BoardClient(fakeConn(api, clock));
  await client.start();
  return client;
}

/** Starts a client and waits for its stream request. */
async function streaming(api: FakeApi, clock = new FakeClock(NOW)): Promise<BoardClient> {
  const client = await started(api, clock);
  await vi.waitFor(() => {
    expect(api.streams.length).toBeGreaterThan(0);
  });
  return client;
}

function ready(client: BoardClient): ClientState & { model: BoardModel } {
  const state = client.getState();
  expect(state.phase).toBe('ready');
  if (state.model === null) {
    throw new Error('no model');
  }
  return { ...state, model: state.model };
}

describe('initial load', () => {
  it('starts loading, with nothing requested before start', () => {
    const api = new FakeApi(model(baseInputs()));
    const client = new BoardClient(fakeConn(api, new FakeClock(NOW)));
    expect(client.getState()).toEqual({
      phase: 'loading',
      session: null,
      model: null,
      now: NOW,
      problem: null,
      error: null,
      connected: false,
    });
    expect(api.requests).toEqual([]);
  });

  it('loads the session, the board and the events into the model, then opens the stream', async () => {
    const snapshot = withDigest(model(baseInputs()), '1');
    const api = new FakeApi(snapshot);
    const client = await streaming(api);

    const state = ready(client);
    expect(state.session).toEqual(SESSION);
    expect(state.model).toEqual({ ...snapshot, late: [] });
    expect(state.now).toBe(NOW);
    expect(state.problem).toBeNull();
    expect(state.error).toBeNull();

    expect(api.paths()).toContain('/api/session');
    const board = api.paths().indexOf('/api/board');
    const events = api.paths().indexOf('/api/events');
    expect(board).toBeGreaterThanOrEqual(0);
    expect(events).toBeGreaterThan(board);

    expect(api.streams).toHaveLength(1);
    const stream = api.latestStream();
    expect(stream.url).toBe(`/api/stream?since=${encodeURIComponent(snapshot.id)}`);
    expect(stream.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(stream.headers.get('accept')).toBe('text/event-stream');
    expect(stream.headers.has('last-event-id')).toBe(false);
  });

  it('requests every page of /api/events, following next', async () => {
    const inputs = [
      ...baseInputs(),
      E.comment(T2, 'a', { wall: 1_000_040 }),
      E.comment(T2, 'b', { wall: 1_000_050 }),
    ];
    const snapshot = model(inputs);
    const api = new FakeApi(snapshot);
    api.pageSize = 2;
    const client = await started(api);

    const afters = api.requests
      .map((r) => new URL(r.url, 'http://localhost'))
      .filter((u) => u.pathname === '/api/events')
      .map((u) => u.searchParams.get('after'));
    const hashes = snapshot.events.map((e) => e.hash);
    expect(afters).toEqual([null, hashes[1], hashes[3]]);
    expect(ready(client).model.events).toEqual(snapshot.events);
  });

  it('keeps no event beyond the head of the board snapshot', async () => {
    const inputs = baseInputs();
    const board = model(inputs);
    const later = model([
      ...inputs,
      E.comment(T2, 'written between the requests', { wall: 1_000_090 }),
    ]);
    const api = new FakeApi(board);
    api.events = later;
    const client = await started(api);

    const state = ready(client);
    expect(state.model.events).toEqual(board.events);
    expect(state.model.head).toBe(board.head);
  });

  it('keeps no applied event on an empty board snapshot', async () => {
    const board = withDigest(model([]), '0');
    const api = new FakeApi(board);
    api.events = model([E.create(T1, { title: 'raced' }, { wall: 1_000_000 })]);
    const client = await started(api);

    const state = ready(client);
    expect(state.model.events).toEqual([]);
    expect(state.model.head).toBeNull();
    expect(state.model.tickets).toEqual({});
  });

  it('schedules the refresh of now every 10 seconds', async () => {
    const clock = new FakeClock(NOW);
    const client = await started(new FakeApi(model(baseInputs())), clock);
    expect(REFRESH_MS).toBe(10_000);
    expect(clock.active().map((i) => i.ms)).toEqual([10_000]);

    const seen: number[] = [];
    client.subscribe((s) => seen.push(s.now));
    clock.now = NOW + 10_000;
    clock.fire();
    expect(client.getState().now).toBe(NOW + 10_000);
    expect(seen.at(-1)).toBe(NOW + 10_000);
  });

  it('fails without a stream or timer when a request fails', async () => {
    const api = new FakeApi(model(baseInputs()));
    const doc = {
      error: { exitCode: 3, reason: 'integrity', message: 'corrupt cache', hint: null },
    };
    api.failures.set('/api/board', { status: 500, body: doc });
    const clock = new FakeClock(NOW);
    const client = await started(api, clock);

    const state = client.getState();
    expect(state.phase).toBe('failed');
    expect(state.model).toBeNull();
    expect(state.error).toBeInstanceOf(ApiError);
    expect(state.error?.status).toBe(500);
    expect(state.error?.document).toEqual(doc);
    expect(state.error?.message).toBe('corrupt cache');
    expect(api.streams).toEqual([]);
    expect(clock.active()).toEqual([]);
  });

  it('is unauthorized, with no stream or timer, when the token is refused', async () => {
    const api = new FakeApi(model(baseInputs()));
    api.token = 'another-token-another-token-another-token-x';
    const clock = new FakeClock(NOW);
    const client = await started(api, clock);

    expect(client.getState().phase).toBe('unauthorized');
    expect(client.getState().model).toBeNull();
    expect(api.streams).toEqual([]);
    expect(clock.active()).toEqual([]);
  });

  it('sends the token only as a Bearer header, never in a URL, and no cookie', async () => {
    const api = new FakeApi(model(baseInputs()));
    api.pageSize = 1;
    await streaming(api);
    expect(api.requests.length).toBeGreaterThan(3);
    for (const { url, init } of api.requests) {
      expect(url.startsWith('/api/')).toBe(true);
      expect(url).not.toContain(TOKEN);
      expect(url).not.toMatch(/token/i);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.has('cookie')).toBe(false);
      expect(init?.credentials).not.toBe('include');
    }
  });
});

describe('stream', () => {
  it('applies an append without any request', async () => {
    const inputs = baseInputs();
    const before = withDigest(model(inputs), '1');
    const extra = [
      E.move(T1, 'tests', { actor: 'impl-1', wall: 1_000_100 }),
      E.meta('wip', 3, { actor: 'orch', wall: 1_000_110 }),
    ];
    const after = withDigest(model([...inputs, ...extra]), '2');
    const api = new FakeApi(before);
    const clock = new FakeClock(NOW);
    const client = await streaming(api, clock);
    const requests = api.requests.length;
    const changes: ClientState[] = [];
    client.subscribe((s) => changes.push(s));

    clock.now = NOW + 1234;
    api.latestStream().append(appendOf(after, before.events.length));

    await vi.waitFor(() => {
      expect(ready(client).model.id).toBe(after.id);
    });
    const state = ready(client);
    expect(state.model).toEqual({ ...after, late: [] });
    expect(state.now).toBe(NOW + 1234);
    expect(api.requests.length).toBe(requests);
    expect(api.streams).toHaveLength(1);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('reloads on a resync, marks the late events and reopens the stream at the new id', async () => {
    const inputs = baseInputs();
    const before = withDigest(model(inputs), '1');
    const late = E.comment(T2, 'late from sync', { actor: 'other', wall: 1_000_015 });
    const after = withDigest(model([...inputs, late]), '3');
    const api = new FakeApi(before);
    const client = await streaming(api);
    const first = api.latestStream();
    const boards = api.count('/api/board');

    api.board = after;
    const lateView = after.events.find((e) => e.hash === late.hash);
    if (lateView === undefined) {
      throw new Error('fixture: late event missing');
    }
    first.resync({ type: 'resync', id: after.id, late: [lateView], removed: [] });

    await vi.waitFor(() => {
      expect(ready(client).model.id).toBe(after.id);
      expect(api.streams).toHaveLength(2);
    });
    expect(first.aborted).toBe(true);
    expect(api.count('/api/board')).toBe(boards + 1);
    expect(ready(client).model).toEqual({ ...after, late: [late.hash] });
    const second = api.latestStream();
    expect(second.url).toBe(`/api/stream?since=${encodeURIComponent(after.id)}`);
    expect(second.headers.has('last-event-id')).toBe(false);
    expect(second.aborted).toBe(false);
  });

  it('shows a problem, keeps the stream, and reloads on the next message', async () => {
    const inputs = baseInputs();
    const before = withDigest(model(inputs), '1');
    const api = new FakeApi(before);
    const client = await streaming(api);
    const stream = api.latestStream();
    const doc = {
      error: {
        exitCode: 3,
        reason: 'integrity',
        message: 'bad file',
        hint: 'agentboard rebuild',
      },
    };

    stream.problem(doc);
    await vi.waitFor(() => {
      expect(client.getState().problem).toEqual(doc);
    });
    expect(ready(client).model).toEqual({ ...before, late: [] });
    expect(stream.aborted).toBe(false);

    const after = withDigest(
      model([...inputs, E.move(T1, 'tests', { actor: 'impl-1', wall: 1_000_100 })]),
      '2',
    );
    api.board = after;
    const boards = api.count('/api/board');
    stream.append(appendOf(after, before.events.length));

    await vi.waitFor(() => {
      expect(client.getState().problem).toBeNull();
      expect(api.streams).toHaveLength(2);
    });
    expect(api.count('/api/board')).toBe(boards + 1);
    expect(ready(client).model).toEqual({ ...after, late: [] });
    expect(stream.aborted).toBe(true);
    expect(api.latestStream().url).toBe(`/api/stream?since=${encodeURIComponent(after.id)}`);
  });

  it('keeps the model and shows the failure when a reload fails', async () => {
    const before = withDigest(model(baseInputs()), '1');
    const api = new FakeApi(before);
    const client = await streaming(api);
    api.failures.set('/api/board', { status: 500, body: errorDoc('busy', 'board is busy') });

    api.latestStream().resync({ type: 'resync', id: positionId('a', '9'), late: [], removed: [] });

    await vi.waitFor(() => {
      expect(client.getState().problem?.error.message).toBe('board is busy');
      expect(api.streams).toHaveLength(2);
    });
    expect(ready(client).model).toEqual({ ...before, late: [] });
    expect(api.latestStream().aborted).toBe(false);
    expect(api.latestStream().url).toBe(`/api/stream?since=${encodeURIComponent(before.id)}`);
  });

  it('tracks the connection, reconnects with Last-Event-ID, and ignores data that is not JSON', async () => {
    const inputs = baseInputs();
    const before = withDigest(model(inputs), '1');
    const api = new FakeApi(before);
    const clock = new FakeClock(NOW);
    const client = await streaming(api, clock);
    await vi.waitFor(() => {
      expect(client.getState().connected).toBe(true);
    });

    const stream = api.latestStream();
    stream.send('event: append\nid: x.1\ndata: {not json\n\n');
    const after = withDigest(model([...inputs, E.move(T1, 'tests', { wall: 1_000_100 })]), '2');
    stream.append(appendOf(after, before.events.length));
    await vi.waitFor(() => {
      expect(ready(client).model.id).toBe(after.id);
    });

    stream.end();
    await vi.waitFor(() => {
      expect(client.getState().connected).toBe(false);
      expect(clock.pending()).toHaveLength(1);
    });
    clock.runTimeouts();
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(2);
    });
    expect(api.latestStream().headers.get('last-event-id')).toBe(after.id);
    await vi.waitFor(() => {
      expect(client.getState().connected).toBe(true);
    });
  });

  it('stops with phase unauthorized when the stream is refused', async () => {
    const api = new FakeApi(model(baseInputs()));
    const clock = new FakeClock(NOW);
    const client = await streaming(api, clock);
    api.failures.set('/api/stream', {
      status: 401,
      body: errorDoc('unauthorized', 'missing or invalid access token'),
    });
    api.latestStream().end();
    await vi.waitFor(() => {
      expect(clock.pending()).toHaveLength(1);
    });
    clock.runTimeouts();
    await vi.waitFor(() => {
      expect(client.getState().phase).toBe('unauthorized');
    });
    expect(clock.active()).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });

  it('stops: closes the stream, cancels the timer and reports nothing more', async () => {
    const inputs = baseInputs();
    const before = model(inputs);
    const clock = new FakeClock(NOW);
    const api = new FakeApi(before);
    const client = await streaming(api, clock);
    const stream = api.latestStream();
    const seen: ClientState[] = [];
    client.subscribe((s) => seen.push(s));

    client.stop();
    client.stop();
    expect(stream.aborted).toBe(true);
    expect(clock.active()).toEqual([]);
    expect(clock.pending()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([]);
  });

  it('unsubscribes a listener', async () => {
    const inputs = baseInputs();
    const before = model(inputs);
    const api = new FakeApi(before);
    const client = await streaming(api);
    const seen: ClientState[] = [];
    const off = client.subscribe((s) => seen.push(s));
    off();
    const after = model([...inputs, E.move(T1, 'tests', { wall: 1_000_100 })]);
    api.latestStream().append(appendOf(after, before.events.length));
    await vi.waitFor(() => {
      expect(ready(client).model.events).toHaveLength(after.events.length);
    });
    expect(seen).toEqual([]);
  });
});

describe('api helpers', () => {
  const api = (): FakeApi => new FakeApi(model(baseInputs()));

  it('apiHeaders asks for JSON with the Bearer token', () => {
    expect(apiHeaders(TOKEN)).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('getJson sends the headers and returns the body', async () => {
    const fake = api();
    const body = await getJson(fakeConn(fake, new FakeClock(NOW)), '/api/session');
    expect(body).toEqual(SESSION);
    const headers = new Headers(fake.requests[0]?.init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('getJson rejects with the status and error document', async () => {
    const fake = api();
    const error: unknown = await getJson(fakeConn(fake, new FakeClock(NOW)), '/api/nope').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, document: { error: { reason: 'not-found' } } });
    await expect(
      getJson(fakeConn(fake, new FakeClock(NOW), 'wrong'), '/api/board'),
    ).rejects.toMatchObject({ status: 401, document: { error: { reason: 'unauthorized' } } });
  });

  it('getJson rejects with status 0 when fetch fails, and null document for a non-document body', async () => {
    const deps = {
      ...fakeDeps(api(), new FakeClock(NOW)),
      fetch: () => Promise.reject(new TypeError('offline')),
    };
    await expect(getJson({ deps, token: TOKEN }, '/api/board')).rejects.toMatchObject({
      status: 0,
      document: null,
    });
    const plain = {
      ...deps,
      fetch: () => Promise.resolve(new Response('oops', { status: 502 })),
    };
    await expect(getJson({ deps: plain, token: TOKEN }, '/api/board')).rejects.toMatchObject({
      status: 502,
      document: null,
    });
  });

  it('loadSession, loadModel and loadTicketDetail read their routes', async () => {
    const fake = api();
    const conn = fakeConn(fake, new FakeClock(NOW));
    expect(await loadSession(conn)).toEqual(SESSION);
    expect(await loadModel(conn, ['x'])).toEqual({ ...fake.board, late: ['x'] });
    const detail = await loadTicketDetail(conn, T1.slice(0, 8));
    expect(detail.ticket.id).toBe(T1);
    expect(detail.events.map((e) => e.hash)).toEqual(
      fake.board.events.filter((e) => e.ticket === T1).map((e) => e.hash),
    );
    expect(fake.requests.at(-1)?.url).toBe(`/api/tickets/${T1.slice(0, 8)}`);
  });

  it('loadTicketDetail encodes the id and rejects an unknown ticket', async () => {
    const fake = api();
    const conn = fakeConn(fake, new FakeClock(NOW));
    await expect(loadTicketDetail(conn, 'a/b')).rejects.toMatchObject({
      status: 404,
      document: { error: { reason: 'unknown-ticket' } },
    });
    expect(fake.requests.at(-1)?.url).toBe('/api/tickets/a%2Fb');
  });
});
