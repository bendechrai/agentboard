/**
 * Reading `/api/stream` with `fetch` (`stream.ts`; board-web: "Live event
 * stream", "Access token"): the request and its headers, events across chunk
 * boundaries and split UTF-8 characters, reconnection with `Last-Event-ID`
 * after the `retry` delay, stopping on 401, and `close()`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SseEvent } from '../sse.js';
import { STREAM_RETRY_MS, openStream, streamUrl, type StreamHandlers } from '../stream.js';
import { FakeApi, FakeClock, TOKEN, errorDoc, fakeConn, model, sseText } from './client-helpers.js';

/** Two characters of two and three UTF-8 bytes (U+00E9, U+2713). */
const CAFE = `caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2713)}`;

const SINCE = `${'a'.repeat(64)}.${'b'.repeat(64)}`;

interface Recorder extends StreamHandlers {
  readonly calls: string[];
  readonly events: SseEvent[];
}

function recorder(): Recorder {
  const calls: string[] = [];
  const events: SseEvent[] = [];
  return {
    calls,
    events,
    onEvent: (event) => {
      calls.push(`event:${event.type}`);
      events.push(event);
    },
    onOpen: () => calls.push('open'),
    onDisconnect: () => calls.push('disconnect'),
    onUnauthorized: () => calls.push('unauthorized'),
  };
}

function setup(): { api: FakeApi; clock: FakeClock; handlers: Recorder } {
  return { api: new FakeApi(model([])), clock: new FakeClock(0), handlers: recorder() };
}

describe('streamUrl', () => {
  it('puts the position id in since, encoded', () => {
    expect(streamUrl('abc.def')).toBe('/api/stream?since=abc.def');
    expect(streamUrl('a b')).toBe('/api/stream?since=a%20b');
  });
});

describe('openStream', () => {
  it('requests the stream with the Bearer token and reports it open', async () => {
    const { api, clock, handlers } = setup();
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(handlers.calls).toEqual(['open']);
    });
    expect(api.streams).toHaveLength(1);
    const stream = api.latestStream();
    expect(stream.url).toBe(streamUrl(SINCE));
    expect(stream.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(stream.headers.get('accept')).toBe('text/event-stream');
    expect(stream.headers.has('last-event-id')).toBe(false);
  });

  it('delivers events in order, whatever the chunks', async () => {
    const { api, clock, handlers } = setup();
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1);
    });
    const stream = api.latestStream();
    const text = [
      'retry: 2000\n\n',
      sseText('append', { n: 1 }, 'h1.d1'),
      ': keepalive\n\n',
      sseText('problem', { error: { message: 'x' } }),
      sseText('resync', { n: 2 }, 'h2.d2'),
    ].join('');
    for (let i = 0; i < text.length; i += 7) {
      stream.send(text.slice(i, i + 7));
    }
    await vi.waitFor(() => {
      expect(handlers.events).toHaveLength(3);
    });
    expect(handlers.events).toEqual([
      { type: 'append', data: '{"n":1}', lastEventId: 'h1.d1' },
      { type: 'problem', data: '{"error":{"message":"x"}}', lastEventId: 'h1.d1' },
      { type: 'resync', data: '{"n":2}', lastEventId: 'h2.d2' },
    ]);
  });

  it('decodes a UTF-8 character split across chunks', async () => {
    const { api, clock, handlers } = setup();
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1);
    });
    const bytes = new TextEncoder().encode(`data: ${CAFE}\n\n`);
    const stream = api.latestStream();
    for (const byte of bytes) {
      stream.sendBytes(Uint8Array.of(byte));
    }
    await vi.waitFor(() => {
      expect(handlers.events).toEqual([{ type: 'message', data: CAFE, lastEventId: '' }]);
    });
  });

  it('reconnects after the default delay when the body ends, with Last-Event-ID', async () => {
    const { api, clock, handlers } = setup();
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1);
    });
    api.latestStream().send(sseText('append', { n: 1 }, 'h1.d1'));
    await vi.waitFor(() => {
      expect(handlers.events).toHaveLength(1);
    });
    api.latestStream().end();
    await vi.waitFor(() => {
      expect(handlers.calls.at(-1)).toBe('disconnect');
      expect(clock.pending()).toHaveLength(1);
    });
    expect(clock.pending()[0]?.ms).toBe(STREAM_RETRY_MS);
    expect(STREAM_RETRY_MS).toBe(2000);
    expect(api.streams).toHaveLength(1);

    clock.runTimeouts();
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(2);
    });
    const second = api.latestStream();
    expect(second.url).toBe(streamUrl(SINCE));
    expect(second.headers.get('last-event-id')).toBe('h1.d1');
    expect(second.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    await vi.waitFor(() => {
      expect(handlers.calls.at(-1)).toBe('open');
    });
  });

  it('uses the retry delay the server sent, and keeps the last id across reconnections', async () => {
    const { api, clock, handlers } = setup();
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(1);
    });
    api.latestStream().send('retry: 5000\n\n' + sseText('append', {}, 'h1.d1'));
    await vi.waitFor(() => {
      expect(handlers.events).toHaveLength(1);
    });
    api.latestStream().fail();
    await vi.waitFor(() => {
      expect(clock.pending().map((t) => t.ms)).toEqual([5000]);
    });
    clock.runTimeouts();
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(2);
    });
    api.latestStream().send('data: no id here\n\n');
    await vi.waitFor(() => {
      expect(handlers.events).toHaveLength(2);
    });
    expect(handlers.events[1]?.lastEventId).toBe('h1.d1');
    api.latestStream().end();
    await vi.waitFor(() => {
      expect(clock.pending().map((t) => t.ms)).toEqual([5000]);
    });
    clock.runTimeouts();
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(3);
    });
    expect(api.latestStream().headers.get('last-event-id')).toBe('h1.d1');
  });

  it('reconnects after a refusal other than 401 and after a network failure', async () => {
    const { api, clock, handlers } = setup();
    api.failures.set('/api/stream', { status: 503, body: errorDoc('too-many-streams', 'full') });
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(handlers.calls).toEqual(['disconnect']);
      expect(clock.pending()).toHaveLength(1);
    });

    const failing = {
      ...fakeConn(api, clock).deps,
      fetch: (): Promise<Response> => Promise.reject(new TypeError('network down')),
    };
    const offline = recorder();
    openStream({ deps: failing, token: TOKEN }, SINCE, offline);
    await vi.waitFor(() => {
      expect(offline.calls).toEqual(['disconnect']);
    });

    api.failures.delete('/api/stream');
    clock.runTimeouts();
    await vi.waitFor(() => {
      expect(handlers.calls).toEqual(['disconnect', 'open']);
    });
  });

  it('stops for good on 401', async () => {
    const { api, clock, handlers } = setup();
    api.token = 'not-the-token-not-the-token-not-the-token-x';
    openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(handlers.calls).toEqual(['unauthorized']);
    });
    expect(clock.pending()).toEqual([]);
    expect(api.requests).toHaveLength(1);
  });

  it('close aborts the request, cancels a reconnection and silences the handlers', async () => {
    const { api, clock, handlers } = setup();
    const handle = openStream(fakeConn(api, clock), SINCE, handlers);
    await vi.waitFor(() => {
      expect(handlers.calls).toEqual(['open']);
    });
    const stream = api.latestStream();
    handle.close();
    handle.close();
    expect(stream.aborted).toBe(true);
    stream.send(sseText('append', {}, 'x'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handlers.calls).toEqual(['open']);
    expect(clock.pending()).toEqual([]);

    const other = recorder();
    const second = openStream(fakeConn(api, clock), SINCE, other);
    await vi.waitFor(() => {
      expect(api.streams).toHaveLength(2);
    });
    api.latestStream().end();
    await vi.waitFor(() => {
      expect(clock.pending()).toHaveLength(1);
    });
    second.close();
    expect(clock.pending()).toEqual([]);
  });
});
