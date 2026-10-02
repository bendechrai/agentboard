/**
 * Test doubles for the web client: a fake same-origin API served from a
 * `BoardModel` through a stubbed `fetch`, requiring `Authorization: Bearer
 * <TOKEN>` like the server; fake event streams returned by that `fetch` for
 * `/api/stream`, whose body the test writes SSE text into; a manual clock with
 * captured intervals and timeouts; and message builders. Board fixtures come
 * from the view-model test helpers (events with explicit walls folded by the
 * store's own pure fold).
 */

import { render, type RenderResult } from '@testing-library/preact';
import { vi } from 'vitest';

import type { Ticket } from '../../../events/fold.js';
import type { AppendMessage, BoardModel, ResyncMessage } from '../../../view/types.js';
import type { ClientDeps, Connection, ErrorDocument, Session } from '../api.js';
import { App } from '../App.js';

export {
  E,
  T1,
  T2,
  T3,
  T4,
  T5,
  TASK,
  TASK2,
  OTHER,
  model,
} from '../../../view/__tests__/helpers.js';

/** The access token the fake API accepts: 43 base64url characters. */
export const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

/** The session the fake API reports. */
export const SESSION: Session = {
  version: '0.0.1',
  boardDir: '/projects/demo/.board',
  writable: false,
  actor: null,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** An `ErrorDocument` of exit code 1 with a reason. */
export function errorDoc(
  reason: string,
  message: string,
  hint: string | null = null,
): ErrorDocument {
  return { error: { exitCode: 1, reason, message, hint } };
}

/** One SSE event as the server frames it (`src/web/stream.ts`). */
export function sseText(type: string, data: unknown, id?: string): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `event: ${type}\n${idLine}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * One `/api/stream` response of the fake API: the test writes SSE text
 * into its body. Records the request and whether the client aborted it.
 */
export class FakeStream {
  readonly url: string;
  readonly headers: Headers;
  aborted = false;
  finished = false;
  readonly response: Response;
  private readonly controller: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();

  constructor(url: string, init: RequestInit | undefined) {
    this.url = url;
    this.headers = new Headers(init?.headers);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    if (controller === undefined) {
      throw new Error('ReadableStream did not start');
    }
    this.controller = controller;
    this.response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
    init?.signal?.addEventListener('abort', () => {
      this.aborted = true;
      this.fail();
    });
  }

  /** Writes raw text into the body (UTF-8), unless the stream is finished. */
  send(text: string): void {
    if (!this.finished) {
      this.controller.enqueue(this.encoder.encode(text));
    }
  }

  /** Writes raw bytes into the body, unless the stream is finished. */
  sendBytes(bytes: Uint8Array): void {
    if (!this.finished) {
      this.controller.enqueue(bytes);
    }
  }

  /** An `append` message with its id. */
  append(message: AppendMessage): void {
    this.send(sseText('append', message, message.id));
  }

  /** A `resync` message with its id. */
  resync(message: ResyncMessage): void {
    this.send(sseText('resync', message, message.id));
  }

  /** A `problem` event (no id). */
  problem(doc: ErrorDocument): void {
    this.send(sseText('problem', doc));
  }

  /** Ends the body normally (the server closed the stream). */
  end(): void {
    if (!this.finished) {
      this.finished = true;
      this.controller.close();
    }
  }

  /** Fails the body (the connection broke). */
  fail(): void {
    if (!this.finished) {
      this.finished = true;
      this.controller.error(new Error('connection lost'));
    }
  }
}

/** One request received by the fake API. */
export interface FakeRequest {
  url: string;
  init: RequestInit | undefined;
}

/** The session of a server started with `--as ben`. */
export const WRITABLE: Session = { ...SESSION, writable: true, actor: 'ben' };

/** One `POST /api/actions/<action>` received by the fake API, parsed. */
export interface FakeAction {
  /** The `<action>` of the path. */
  action: string;
  url: string;
  method: string;
  headers: Headers;
  /** The body parsed as JSON (undefined when it is not JSON). */
  body: unknown;
  init: RequestInit | undefined;
}

/** What `FakeApi.onAction` answers: a status and a JSON body, now or later. */
export type FakeActionAnswer =
  { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/**
 * The JSON API and stream of `agentboard serve`, faked from a model,
 * following the contract of `src/web/api.ts`: every `/api/` request must
 * carry `Authorization: Bearer <token>` (else 401 `unauthorized`);
 * `/api/session`, `/api/board` (tickets ascending by id), `/api/events`
 * paged by `after` (at most `pageSize` events per page, fewer when the
 * request's `limit` is smaller), `/api/tickets/<id>` (full id or unique
 * prefix of at least 6) and `/api/stream` (a `FakeStream`, or
 * `streamFailure` when set).
 */
export class FakeApi {
  /** The model `/api/board` and `/api/tickets/<id>` serve. */
  board: BoardModel;
  /** When set, the events `/api/events` serves; otherwise `board`'s. */
  events: BoardModel | null = null;
  pageSize = 1000;
  /** The token accepted. */
  token = TOKEN;
  readonly requests: FakeRequest[] = [];
  readonly streams: FakeStream[] = [];
  /** Responses forced by path (the URL path without the query), `/api/stream` included. */
  readonly failures = new Map<string, { status: number; body: unknown }>();
  /** The session `/api/session` reports. */
  session: Session = SESSION;
  /** Every authenticated `/api/actions/<action>` request, in order. */
  readonly actions: FakeAction[] = [];
  /**
   * Answers an authenticated `/api/actions/<action>` request (after it is
   * recorded in `actions`); without one, such a request is 404 `not-found`.
   */
  onAction: ((request: FakeAction) => FakeActionAnswer) | null = null;

  constructor(board: BoardModel) {
    this.board = board;
  }

  /** A stubbed `fetch` answering from this fake. */
  readonly fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.requests.push({ url, init });
    const path = new URL(url, 'http://localhost').pathname;
    if (
      path.startsWith('/api/actions/') &&
      new Headers(init?.headers).get('authorization') === `Bearer ${this.token}`
    ) {
      return this.action(url, path, init);
    }
    return Promise.resolve(this.answer(url, init));
  };

  /** The action requests made so far for `action`. */
  actionsOf(action: string): FakeAction[] {
    return this.actions.filter((a) => a.action === action);
  }

  private async action(
    url: string,
    path: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    let body: unknown;
    try {
      body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    const request: FakeAction = {
      action: decodeURIComponent(path.slice('/api/actions/'.length)),
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      init,
    };
    this.actions.push(request);
    if (this.onAction === null) {
      return json(404, errorDoc('not-found', `no action ${request.action}`));
    }
    const answer = await this.onAction(request);
    return json(answer.status, answer.body);
  }

  /** The paths (without query) requested so far, in order. */
  paths(): string[] {
    return this.requests.map((r) => new URL(r.url, 'http://localhost').pathname);
  }

  /** How many requests were made for `path`. */
  count(path: string): number {
    return this.paths().filter((p) => p === path).length;
  }

  /** The most recent stream; fails the test when none was requested. */
  latestStream(): FakeStream {
    const last = this.streams.at(-1);
    if (last === undefined) {
      throw new Error('no stream was requested');
    }
    return last;
  }

  private answer(input: string, init: RequestInit | undefined): Response {
    const url = new URL(input, 'http://localhost');
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${this.token}`) {
      return json(401, errorDoc('unauthorized', 'missing or invalid access token'));
    }
    const forced = this.failures.get(url.pathname);
    if (forced !== undefined) {
      return json(forced.status, forced.body);
    }
    switch (url.pathname) {
      case '/api/session':
        return json(200, this.session);
      case '/api/board': {
        const tickets = Object.values(this.board.tickets).sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        return json(200, { tickets, meta: this.board.meta, id: this.board.id });
      }
      case '/api/events':
        return this.eventsPage(url.searchParams);
      case '/api/stream': {
        const stream = new FakeStream(input, init);
        this.streams.push(stream);
        return stream.response;
      }
    }
    if (url.pathname.startsWith('/api/tickets/')) {
      return this.ticket(decodeURIComponent(url.pathname.slice('/api/tickets/'.length)));
    }
    return json(404, errorDoc('not-found', `no route ${url.pathname}`));
  }

  private eventsPage(query: URLSearchParams): Response {
    const all = (this.events ?? this.board).events;
    const after = query.get('after');
    let start = 0;
    if (after !== null) {
      const index = all.findIndex((e) => e.hash === after);
      if (index < 0) {
        return json(400, errorDoc('unknown-cursor', `unknown cursor ${after}`));
      }
      start = index + 1;
    }
    const limit = query.get('limit');
    const size = limit === null ? this.pageSize : Math.min(Number(limit), this.pageSize);
    const events = all.slice(start, start + size);
    const more = start + size < all.length;
    return json(200, { events, next: more ? (events.at(-1)?.hash ?? null) : null });
  }

  private ticket(id: string): Response {
    const tickets = Object.values(this.board.tickets);
    const exact = tickets.find((t) => t.id === id);
    const prefixed = id.length >= 6 ? tickets.filter((t) => t.id.startsWith(id)) : [];
    const ticket: Ticket | undefined = exact ?? (prefixed.length === 1 ? prefixed[0] : undefined);
    if (ticket === undefined) {
      return json(404, errorDoc('unknown-ticket', `no ticket ${id}`, 'agentboard list'));
    }
    const events = this.board.events.filter((e) => e.ticket === ticket.id);
    return json(200, { ticket, events });
  }
}

interface Scheduled {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

/** A manual clock and the intervals and timeouts scheduled through it. */
export class FakeClock {
  now: number;
  readonly intervals: Scheduled[] = [];
  readonly timeouts: (Scheduled & { fired: boolean })[] = [];

  constructor(now: number) {
    this.now = now;
  }

  /** The intervals not cleared. */
  active(): Scheduled[] {
    return this.intervals.filter((i) => !i.cleared);
  }

  /** Runs every active interval callback once. */
  fire(): void {
    for (const interval of this.active()) {
      interval.callback();
    }
  }

  /** The timeouts neither cleared nor fired. */
  pending(): Scheduled[] {
    return this.timeouts.filter((t) => !t.cleared && !t.fired);
  }

  /** Fires every pending timeout once, in the order scheduled. */
  runTimeouts(): void {
    for (const timeout of this.timeouts.filter((t) => !t.cleared && !t.fired)) {
      timeout.fired = true;
      timeout.callback();
    }
  }
}

/** Client dependencies wired to the fakes. */
export function fakeDeps(api: FakeApi, clock: FakeClock): ClientDeps {
  return {
    fetch: api.fetch,
    now: () => clock.now,
    setInterval: (callback, ms) => {
      const entry = { callback, ms, cleared: false };
      clock.intervals.push(entry);
      return entry;
    },
    clearInterval: (handle) => {
      const entry = clock.intervals.find((i) => i === handle);
      if (entry !== undefined) {
        entry.cleared = true;
      }
    },
    setTimeout: (callback, ms) => {
      const entry = { callback, ms, cleared: false, fired: false };
      clock.timeouts.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      const entry = clock.timeouts.find((t) => t === handle);
      if (entry !== undefined) {
        entry.cleared = true;
      }
    },
  };
}

/** A connection with the fakes and `TOKEN`. */
export function fakeConn(api: FakeApi, clock: FakeClock, token = TOKEN): Connection {
  return { deps: fakeDeps(api, clock), token };
}

/** A position id with a head and a digest made of one repeated hex digit. */
export function positionId(head: string | null, digit: string): string {
  return `${head ?? 'none'}.${digit.repeat(64)}`;
}

/**
 * `m` with the position id `<m.head>.<digit x 64>` (`none` for no head):
 * the head part matches the model, as a snapshot's id does, and the digest
 * part tells snapshots with the same head apart.
 */
export function withDigest(m: BoardModel, digit: string): BoardModel {
  return { ...m, id: positionId(m.head, digit) };
}

/**
 * The append a feed would send to a model holding the first `from` events
 * of `after`: the applied events beyond them, the state in `after` of each
 * ticket they name (ascending by id), `after.meta` when one is a
 * `board.meta`, and `after.id`.
 */
export function appendOf(after: BoardModel, from: number): AppendMessage {
  const events = after.events.slice(from).filter((e) => e.outcome === 'applied');
  const ids = [...new Set(events.flatMap((e) => (e.ticket === null ? [] : [e.ticket])))].sort();
  return {
    type: 'append',
    id: after.id,
    events,
    tickets: ids.map((id) => after.tickets[id]).filter((t): t is Ticket => t !== undefined),
    meta: events.some((e) => e.kind === 'board.meta') ? after.meta : null,
  };
}

/** The latest stream of `api`, once the client has requested one. */
export async function streamOf(api: FakeApi): Promise<FakeStream> {
  await vi.waitFor(() => {
    if (api.streams.length === 0) {
      throw new Error('no stream requested yet');
    }
  });
  return api.latestStream();
}

/** Sets the URL hash before a render. */
export function setHash(hash: string): void {
  window.location.hash = hash;
}

/** Renders the app with `TOKEN`, wired to the fakes. */
export function renderApp(api: FakeApi, clock: FakeClock): RenderResult {
  return render(<App token={TOKEN} deps={fakeDeps(api, clock)} />);
}

/** Every element matching `selector` under `root`. */
export function all(root: ParentNode, selector: string): Element[] {
  return [...root.querySelectorAll(selector)];
}

/** The `data-ticket` values of the cards under `root`, in document order. */
export function cardIds(root: ParentNode): string[] {
  return all(root, 'article.card').map((el) => el.getAttribute('data-ticket') ?? '');
}

/** The column section of `status`; fails the test when missing. */
export function column(root: ParentNode, status: string): Element {
  const el = root.querySelector(`section.column[data-status="${status}"]`);
  if (el === null) {
    throw new Error(`no column ${status}`);
  }
  return el;
}

/** The card of ticket `id` under `root`, or null. */
export function card(root: ParentNode, id: string): Element | null {
  return root.querySelector(`article.card[data-ticket="${id}"]`);
}
