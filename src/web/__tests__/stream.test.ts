/**
 * The live event stream, in process (board-web: "Live event stream", "Reads
 * never block writers"; add-board-web design.md: "One feed per server,
 * fanned out to every client", "A tick failure does not stop the server"):
 * the SSE framing, the first message with and without a start position,
 * `Last-Event-ID` and `since`, appends and resyncs, one shared feed,
 * keepalive comments, `problem` events, the 64-stream cap and the per-client
 * buffer limit.
 *
 * The scenarios with CLI processes (a CLI write reaching the stream,
 * twenty concurrent comments while a client does not read, SIGINT and
 * SIGTERM) are in src/__tests__/serve-processes.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { commentTicket, moveTicket } from '../../board/actions.js';
import type * as Feed from '../../board/feed.js';
import { EMPTY_POSITION_ID, createEventCache, type EventCache } from '../../board/feed.js';
import { newTicket } from '../../board/tickets.js';
import { errorDocument } from '../../cli/main.js';
import { compareFoldOrder, type FoldInput } from '../../events/fold.js';
import type { Board } from '../../store/board.js';
import { readEventFile } from '../../store/eventfile.js';
import { BoardError } from '../../store/errors.js';
import { P, T1, ev, eventNames, foldDir, putEvent } from '../../store/__tests__/helpers.js';
import type { AppendMessage, FeedMessage, ResyncMessage } from '../../view/types.js';
import { API_HINT_CONTEXT } from '../api.js';
import type { RunningServer, ServerOptions } from '../server.js';
import {
  KEEPALIVE_MS,
  MAX_STREAMS,
  STREAM_BUFFER_BYTES,
  STREAM_RETRY_MS,
  sseKeepalive,
  sseMessage,
  sseProblem,
  sseRetry,
} from '../stream.js';
import {
  expectSecurityHeaders,
  frozenTimers,
  get,
  json,
  open,
  openStream,
  pause,
  project,
  request,
  serve,
  until,
  type SseEvent,
  type StreamClient,
} from './web-helpers.js';

// Counts the feeds the server starts (board-web: "One feed SHALL serve every stream").
const feeds = vi.hoisted(() => ({ started: 0 }));

vi.mock('../../board/feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Feed>();
  return {
    ...actual,
    watchBoard: (...args: Parameters<typeof actual.watchBoard>) => {
      feeds.started += 1;
      return actual.watchBoard(...args);
    },
  };
});

const TASK = { source: 'openspec', ref: 'add-board-web', item: '3' };
const FAST: ServerOptions = { feed: { pollMs: 50 } };

/** XOR of the hex hashes. */
function xorHex(hashes: readonly string[]): string {
  const acc = Buffer.alloc(32);
  for (const hash of hashes) {
    const bytes = Buffer.from(hash, 'hex');
    for (let i = 0; i < 32; i += 1) {
      acc[i] = (acc[i] ?? 0) ^ (bytes[i] ?? 0);
    }
  }
  return acc.toString('hex');
}

/** The effective events of `eventsDir` in fold order, by an independent fold. */
function effective(eventsDir: string): FoldInput[] {
  const result = foldDir(eventsDir);
  const out = new Set([
    ...result.rejected.map((r) => r.hash),
    ...result.unknown.map((u) => u.hash),
  ]);
  const inputs: FoldInput[] = [];
  for (const name of eventNames(eventsDir)) {
    const outcome = readEventFile(eventsDir, name);
    if (outcome.status === 'ok' && !out.has(outcome.input.hash)) {
      inputs.push(outcome.input as FoldInput);
    }
  }
  return inputs.sort(compareFoldOrder);
}

/** The position id of the whole effective set of `eventsDir`. */
function positionOf(eventsDir: string): string {
  const all = effective(eventsDir);
  const head = all.at(-1);
  return head === undefined ? EMPTY_POSITION_ID : `${head.hash}.${xorHex(all.map((e) => e.hash))}`;
}

/** The feed message of an SSE event. */
function message(event: SseEvent | undefined): FeedMessage {
  expect(event).toBeDefined();
  const data = JSON.parse(event?.data ?? 'null') as FeedMessage;
  expect(event?.event).toBe(data.type);
  expect(event?.id).toBe(data.id);
  return data;
}

function asAppend(m: FeedMessage): AppendMessage {
  expect(m.type).toBe('append');
  return m as AppendMessage;
}

function asResync(m: FeedMessage): ResyncMessage {
  expect(m.type).toBe('resync');
  return m as ResyncMessage;
}

/** The comment texts of an append. */
function texts(m: AppendMessage): string[] {
  return m.events.flatMap((e) => {
    const body = (e.event as { body?: { text?: unknown } }).body;
    return e.kind === 'ticket.comment' && typeof body?.text === 'string' ? [body.text] : [];
  });
}

/** The feed events (append, resync) received by `client`. */
function feedEvents(client: StreamClient): SseEvent[] {
  return client.events().filter((e) => e.event === 'append' || e.event === 'resync');
}

/** A board with one ticket, a writer handle on it (as another process would be), and a server. */
async function withTicket(options: ServerOptions = FAST): Promise<{
  server: RunningServer;
  board: Board;
  writer: Board;
  eventsDir: string;
  id: string;
}> {
  const dirs = project();
  const writer = open(dirs.boardDir);
  const id = newTicket(writer, 'orch', { title: 'Streamed', task: TASK }).ticket.id;
  const board = open(dirs.boardDir);
  const server = await serve(board, options);
  return { server, board, writer, eventsDir: dirs.eventsDir, id };
}

describe('SSE framing', () => {
  it('has the limits of board-web and the add-board-web design', () => {
    expect(STREAM_RETRY_MS).toBe(2000);
    expect(KEEPALIVE_MS).toBe(15_000);
    expect(MAX_STREAMS).toBe(64);
    expect(STREAM_BUFFER_BYTES).toBe(4 * 1024 * 1024);
  });

  it('frames the retry, a feed message, a problem and the keepalive exactly', () => {
    expect(sseRetry()).toBe('retry: 2000\n\n');
    expect(sseKeepalive()).toBe(': keepalive\n\n');
    const append: AppendMessage = {
      type: 'append',
      id: EMPTY_POSITION_ID,
      events: [],
      tickets: [],
      meta: { note: 'two\nlines' },
    };
    const frame = sseMessage(append);
    expect(frame).toBe(
      `event: append\nid: ${EMPTY_POSITION_ID}\ndata: ${JSON.stringify(append)}\n\n`,
    );
    expect(frame.split('\n')).toHaveLength(5);
    const resync: ResyncMessage = { type: 'resync', id: EMPTY_POSITION_ID, late: [], removed: [] };
    expect(sseMessage(resync)).toBe(
      `event: resync\nid: ${EMPTY_POSITION_ID}\ndata: ${JSON.stringify(resync)}\n\n`,
    );
    const doc = errorDocument(new Error('boom'), API_HINT_CONTEXT);
    expect(sseProblem(doc)).toBe(`event: problem\ndata: ${JSON.stringify(doc)}\n\n`);
  });
});

describe('opening a stream', () => {
  it('answers 200 text/event-stream with no-store and the security headers, retry first', async () => {
    const { server } = await withTicket();
    const client = await openStream(server);
    expect(client.status).toBe(200);
    expect(client.headers['content-type']?.startsWith('text/event-stream')).toBe(true);
    expectSecurityHeaders(client.headers, true);
    await client.until((c) => c.events().length > 0, 3000, 'the first event');
    expect(client.raw().startsWith('retry: 2000\n\n')).toBe(true);
    expect(client.parsed().retries).toEqual(['2000']);
  });

  it('without a position, first sends an append of every effective event with the current id', async () => {
    const dirs = project();
    const writer = open(dirs.boardDir);
    const id = newTicket(writer, 'orch', { title: 'One', task: TASK }).ticket.id;
    commentTicket(writer, 'impl', { id, text: 'first' });
    moveTicket(writer, 'impl', { id, to: 'tests' });
    const server = await serve(open(dirs.boardDir), FAST);
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length > 0, 3000, 'the first event');
    const first = asAppend(message(feedEvents(client)[0]));
    expect(first.events.map((e) => e.hash)).toEqual(effective(dirs.eventsDir).map((e) => e.hash));
    expect(first.events.every((e) => e.outcome === 'applied' && e.reason === null)).toBe(true);
    expect(first.tickets.map((t) => [t.id, t.status])).toEqual([[id, 'tests']]);
    expect(first.id).toBe(positionOf(dirs.eventsDir));
  });

  it('on an empty board, first sends an append with no event and the empty id', async () => {
    const server = await serve(open(project().boardDir), FAST);
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length > 0, 3000, 'the first event');
    expect(message(feedEvents(client)[0])).toEqual({
      type: 'append',
      id: EMPTY_POSITION_ID,
      events: [],
      tickets: [],
      meta: null,
    });
  });
});

describe('live messages', () => {
  it('delivers a write as an append with the event and the ticket state (in process)', async () => {
    const { server, writer, id } = await withTicket();
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
    const written = Date.now();
    moveTicket(writer, 'a', { id, to: 'tests' });
    await client.until((c) => feedEvents(c).length === 2, 3000, 'the move');
    expect(Date.now() - written).toBeLessThan(3000);
    const append = asAppend(message(feedEvents(client)[1]));
    expect(append.events.map((e) => [e.kind, e.actor])).toEqual([['ticket.move', 'a']]);
    expect(append.tickets.map((t) => [t.id, t.status])).toEqual([[id, 'tests']]);
  });

  it('scenario: a late arrival reaches the client as a resync listing it as late', async () => {
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'Early'), 'orch', 1000));
    putEvent(dirs.eventsDir, ev(P.comment(T1, 'head'), 'orch', 2000));
    const server = await serve(open(dirs.boardDir), FAST);
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
    const late = putEvent(dirs.eventsDir, ev(P.comment(T1, 'from sync'), 'remote', 1500));
    await client.until((c) => feedEvents(c).length === 2, 3000, 'the resync');
    const resync = asResync(message(feedEvents(client)[1]));
    expect(resync.late.map((e) => e.hash)).toEqual([late]);
    expect(resync.removed).toEqual([]);
    expect(resync.id).toBe(positionOf(dirs.eventsDir));
  });

  it('sends every message to every open stream, from one feed per server', async () => {
    const before = feeds.started;
    const { server, writer, id } = await withTicket();
    const clients = await Promise.all([1, 2, 3].map(() => openStream(server)));
    for (const client of clients) {
      await client.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
    }
    commentTicket(writer, 'impl', { id, text: 'to everyone' });
    for (const client of clients) {
      await client.until((c) => feedEvents(c).length === 2, 3000, 'the comment');
    }
    const seconds = clients.map((c) => feedEvents(c)[1]);
    expect(new Set(seconds.map((e) => e?.data)).size).toBe(1);
    expect(texts(asAppend(message(seconds[0])))).toEqual(['to everyone']);
    expect(server.streamCount()).toBe(3);
    expect(feeds.started - before).toBe(1);
  });
});

describe('resume', () => {
  /** A client that received the first event, closed; returns its last id. */
  async function lastIdThenClose(server: RunningServer): Promise<string> {
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
    client.close();
    return feedEvents(client)[0]?.id ?? '';
  }

  it('scenario: reconnect with Last-Event-ID resumes with an append of exactly the missed comment', async () => {
    const { server, writer, id } = await withTicket();
    const last = await lastIdThenClose(server);
    commentTicket(writer, 'impl', { id, text: 'while away' });
    await pause(200);
    const client = await openStream(server, { headers: { 'Last-Event-ID': last } });
    await client.until((c) => feedEvents(c).length > 0, 3000, 'the first event after reconnect');
    const first = asAppend(message(feedEvents(client)[0]));
    expect(first.events).toHaveLength(1);
    expect(texts(first)).toEqual(['while away']);
  });

  it('starts from since when there is no Last-Event-ID', async () => {
    const { server, writer, id } = await withTicket();
    const last = await lastIdThenClose(server);
    commentTicket(writer, 'impl', { id, text: 'one' });
    commentTicket(writer, 'impl', { id, text: 'two' });
    const client = await openStream(server, { path: `/api/stream?since=${last}` });
    await client.until(
      (c) => feedEvents(c).flatMap((e) => texts(asAppend(message(e)))).length === 2,
      3000,
      'the two missed comments',
    );
    expect(feedEvents(client).every((e) => e.event === 'append')).toBe(true);
    expect(feedEvents(client).flatMap((e) => texts(asAppend(message(e))))).toEqual(['one', 'two']);
  });

  it('prefers Last-Event-ID to since', async () => {
    const { server, writer, id } = await withTicket();
    const last = await lastIdThenClose(server);
    const client = await openStream(server, {
      path: '/api/stream?since=garbage',
      headers: { 'Last-Event-ID': last },
    });
    await pause(300);
    expect(feedEvents(client)).toEqual([]);
    commentTicket(writer, 'impl', { id, text: 'next' });
    await client.until((c) => feedEvents(c).length > 0, 3000, 'the comment');
    expect(texts(asAppend(message(feedEvents(client)[0])))).toEqual(['next']);
  });

  it('sends nothing first when the client is already current', async () => {
    const { server, writer, id } = await withTicket();
    const last = await lastIdThenClose(server);
    const client = await openStream(server, { headers: { 'Last-Event-ID': last } });
    await pause(300);
    expect(feedEvents(client)).toEqual([]);
    commentTicket(writer, 'impl', { id, text: 'now' });
    await client.until((c) => feedEvents(c).length > 0, 3000, 'the comment');
    const first = asAppend(message(feedEvents(client)[0]));
    expect(texts(first)).toEqual(['now']);
    expect(first.events).toHaveLength(1);
  });

  it('answers an unparsable Last-Event-ID or since with a resync of the current id', async () => {
    const { server, eventsDir } = await withTicket();
    for (const options of [
      { headers: { 'Last-Event-ID': 'garbage' } },
      { path: '/api/stream?since=garbage' },
    ]) {
      const client = await openStream(server, options);
      await client.until((c) => feedEvents(c).length > 0, 3000, 'the first event');
      expect(message(feedEvents(client)[0])).toEqual({
        type: 'resync',
        id: positionOf(eventsDir),
        late: [],
        removed: [],
      });
      client.close();
    }
  });

  it('answers the empty-board id on a board with events with an append of every event', async () => {
    const { server, eventsDir } = await withTicket();
    const client = await openStream(server, { headers: { 'Last-Event-ID': EMPTY_POSITION_ID } });
    await client.until((c) => feedEvents(c).length > 0, 3000, 'the first event');
    const first = asAppend(message(feedEvents(client)[0]));
    expect(first.events.map((e) => e.hash)).toEqual(effective(eventsDir).map((e) => e.hash));
  });
});

describe('scenario: Stream from a fresh snapshot (board-feed: Joining a running feed)', () => {
  /** A server whose feed never ticks on its own (timers fired by hand, no fs.watch). */
  async function frozen(): Promise<
    Awaited<ReturnType<typeof withTicket>> & {
      timers: ReturnType<typeof frozenTimers>;
    }
  > {
    const timers = frozenTimers();
    const served = await withTicket({ feed: { timers, fsWatch: false } });
    return { ...served, timers };
  }

  for (const how of ['since', 'Last-Event-ID'] as const) {
    it(
      `a stream started (${how}) from /api/board taken right after a write gets no resync and no event the snapshot held`,
      { timeout: 30_000 },
      async () => {
        const { server, writer, id, timers } = await frozen();
        const early = await openStream(server);
        await early.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
        const written = commentTicket(writer, 'impl', { id, text: 'fresh' });
        const snapshot = json(await get(server, '/api/board')) as { id: string };
        expect(snapshot.id.split('.')[0]).toBe(written.hash);
        const joiner = await openStream(
          server,
          how === 'since'
            ? { path: `/api/stream?since=${snapshot.id}` }
            : { headers: { 'Last-Event-ID': snapshot.id } },
        );
        expect(joiner.status).toBe(200);
        // The join brought the feed up to date: the stream already open gets the comment.
        await early.until(
          (c) => feedEvents(c).length === 2,
          3000,
          'the comment on the early stream',
        );
        expect(texts(asAppend(message(feedEvents(early)[1])))).toEqual(['fresh']);
        // The next tick finds nothing new.
        timers.fire();
        await pause(300);
        expect(joiner.events().filter((e) => e.event === 'resync')).toEqual([]);
        expect(feedEvents(joiner)).toEqual([]);
        expect(feedEvents(early)).toHaveLength(2);
        // A later write reaches the joiner once, and nothing it carries was in the snapshot.
        commentTicket(writer, 'impl', { id, text: 'after' });
        timers.fire();
        await joiner.until((c) => feedEvents(c).length === 1, 3000, 'the later comment');
        const later = asAppend(message(feedEvents(joiner)[0]));
        expect(texts(later)).toEqual(['after']);
        expect(later.events.map((e) => e.hash)).not.toContain(written.hash);
      },
    );
  }

  it(
    'a stream started from an older snapshot gets an append of exactly the two comments the feed had not examined',
    { timeout: 30_000 },
    async () => {
      const { server, writer, id } = await frozen();
      const before = json(await get(server, '/api/board')) as { id: string };
      commentTicket(writer, 'impl', { id, text: 'one' });
      commentTicket(writer, 'impl', { id, text: 'two' });
      const joiner = await openStream(server, { path: `/api/stream?since=${before.id}` });
      await joiner.until((c) => feedEvents(c).length > 0, 3000, 'the first event');
      const first = asAppend(message(feedEvents(joiner)[0]));
      expect(texts(first)).toEqual(['one', 'two']);
      expect(first.events).toHaveLength(2);
      expect(first.id).toBe((json(await get(server, '/api/board')) as { id: string }).id);
    },
  );
});

describe('stream authentication', () => {
  it('scenario: the stream requires the bearer header; a query token and a cookie are ignored', async () => {
    const { server } = await withTicket();
    for (const options of [
      { auth: false },
      { auth: false, path: `/api/stream?token=${server.token}` },
      { auth: false, headers: { Cookie: `agentboard-${String(server.port)}=${server.token}` } },
    ]) {
      const client = await openStream(server, options);
      expect(client.status).toBe(401);
      expect(client.headers['content-type']).toBe('application/json; charset=utf-8');
      await client.until((c) => c.ended(), 3000, 'the 401 body');
      expect(JSON.parse(client.raw())).toMatchObject({ error: { reason: 'unauthorized' } });
      expect(client.headers['set-cookie']).toBeUndefined();
    }
    expect(server.streamCount()).toBe(0);
  });
});

describe('keepalive', () => {
  it('sends a comment line every keepalive interval', async () => {
    const { server } = await withTicket({ ...FAST, keepaliveMs: 50 });
    const client = await openStream(server);
    await client.until((c) => c.parsed().comments.length >= 2, 3000, 'two keepalive comments');
    expect(client.parsed().comments[0]).toBe(' keepalive');
    expect(client.ended()).toBe(false);
  });
});

/** An event cache that fails with `error()` while it returns an error. */
function failingCache(error: () => Error | null): EventCache {
  const real = createEventCache();
  return {
    get(eventsDir, hash) {
      const e = error();
      if (e !== null) {
        throw e;
      }
      return real.get(eventsDir, hash);
    },
    get size() {
      return real.size;
    },
  };
}

describe('tick failures', () => {
  it('sends a problem event on an injected tick failure, reports it once on stderr, and carries on', async () => {
    let failing = false;
    let stderr = '';
    const { server, writer, id } = await withTicket({
      ...FAST,
      cache: failingCache(() => (failing ? new Error('injected tick failure') : null)),
      stderr: (text) => {
        stderr += text;
      },
    });
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
    failing = true;
    commentTicket(writer, 'impl', { id, text: 'during the failure' });
    await client.until(
      (c) => c.events().some((e) => e.event === 'problem'),
      3000,
      'a problem event',
    );
    // Several failing ticks (polling every 50 ms).
    await pause(400);
    const problem = client.events().find((e) => e.event === 'problem');
    expect(problem?.id).toBeNull();
    expect(JSON.parse(problem?.data ?? 'null')).toEqual({
      error: { exitCode: 5, reason: null, message: 'injected tick failure', hint: null },
    });
    expect(stderr).toBe('agentboard: injected tick failure\n');
    expect(client.ended()).toBe(false);
    failing = false;
    await client.until((c) => feedEvents(c).length === 2, 3000, 'the comment after recovery');
    expect(texts(asAppend(message(feedEvents(client)[1])))).toEqual(['during the failure']);
    expect(server.streamCount()).toBe(1);
  });

  it('sends no problem event for a busy tick', async () => {
    let busy = false;
    const { server, writer, id } = await withTicket({
      ...FAST,
      cache: failingCache(() => (busy ? new BoardError(5, 'busy', 'the cache is busy') : null)),
    });
    const client = await openStream(server);
    await client.until((c) => feedEvents(c).length === 1, 3000, 'the first event');
    busy = true;
    commentTicket(writer, 'impl', { id, text: 'while busy' });
    await pause(400);
    busy = false;
    await client.until((c) => feedEvents(c).length === 2, 3000, 'the comment');
    expect(client.events().some((e) => e.event === 'problem')).toBe(false);
  });
});

describe('the stream cap', () => {
  it(
    'answers the 65th stream with 503 too-many-streams, and frees a slot when a stream closes',
    { timeout: 30_000 },
    async () => {
      const { server } = await withTicket();
      expect(MAX_STREAMS).toBe(64);
      const clients: StreamClient[] = [];
      for (let n = 0; n < 64; n += 1) {
        const client = await openStream(server);
        expect(client.status, String(n)).toBe(200);
        clients.push(client);
      }
      await until(() => server.streamCount() === 64, 3000, '64 open streams');
      const refused = await request(server.port, '/api/stream', {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(refused.status).toBe(503);
      expect(json(refused)).toMatchObject({ error: { exitCode: 1, reason: 'too-many-streams' } });
      expectSecurityHeaders(refused.headers, true);
      expect(server.streamCount()).toBe(64);
      clients[0]?.close();
      await until(() => server.streamCount() === 63, 3000, 'the slot to free');
      const again = await openStream(server);
      expect(again.status).toBe(200);
      await again.until((c) => feedEvents(c).length > 0, 3000, 'the first event');
    },
  );
});

describe('the per-client buffer', () => {
  /** A board whose first append is `count` comments of `size` characters each. */
  function bigBoard(count: number, size: number): string {
    const dirs = project();
    putEvent(dirs.eventsDir, ev(P.create(T1, 'Big'), 'orch', 1000));
    const filler = 'x'.repeat(size);
    for (let n = 0; n < count; n += 1) {
      putEvent(dirs.eventsDir, ev(P.comment(T1, `${String(n)} ${filler}`), 'impl', 2000 + n));
    }
    return dirs.boardDir;
  }

  it(
    'disconnects a client that does not read once its unread data passes the limit',
    { timeout: 60_000 },
    async () => {
      // About 16 MB of comments, sent twice (events and ticket state): far beyond any socket buffer.
      const server = await serve(open(bigBoard(2000, 8000)), {
        ...FAST,
        keepaliveMs: 50,
        streamBufferBytes: 64 * 1024,
      });
      const client = await openStream(server, { paused: true });
      expect(client.status).toBe(200);
      await until(() => server.streamCount() === 0, 20_000, 'the server to drop the client');
      client.resume();
      await client.until((c) => c.ended(), 20_000, 'the connection to end');
      expect(client.events().some((e) => e.event === 'append')).toBe(false);
    },
  );

  it(
    'still delivers one message larger than the limit to a client that reads it',
    { timeout: 60_000 },
    async () => {
      const dir = bigBoard(100, 8000);
      const writer = open(dir);
      const server = await serve(open(dir), {
        ...FAST,
        keepaliveMs: 60_000,
        streamBufferBytes: 64 * 1024,
      });
      const client = await openStream(server);
      await client.until((c) => feedEvents(c).length === 1, 20_000, 'the large first message');
      expect(client.bytes()).toBeGreaterThan(64 * 1024);
      expect(asAppend(message(feedEvents(client)[0])).events).toHaveLength(101);
      commentTicket(writer, 'impl', { id: T1, text: 'after the large message' });
      await client.until((c) => feedEvents(c).length === 2, 3000, 'the next message');
      expect(server.streamCount()).toBe(1);
      expect(client.ended()).toBe(false);
    },
  );
});
