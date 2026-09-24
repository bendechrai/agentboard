/**
 * Reading the live stream `/api/stream` with `fetch` (board-web: "Live
 * event stream", "Access token"; add-board-web task 4.2). `EventSource`
 * cannot send the `Authorization` header, so the client requests the
 * stream with `fetch`, parses the body with `SseParser` (`sse.ts`) and
 * reconnects by itself the way `EventSource` would.
 *
 * Decisions recorded here (test author, add-board-web group 4):
 * - Every connection requests `streamUrl(since)` with the `since` given to
 *   `openStream`; a reconnection also sends `Last-Event-ID: <id>` once an
 *   id has been received (the server prefers the header to `since`).
 * - A connection ends when the response is not 2xx, when `fetch` rejects,
 *   when the body ends, or when reading it fails. Status 401 stops the
 *   stream for good (`onUnauthorized`); every other end is reported with
 *   `onDisconnect` and followed by a reconnection after the delay of the
 *   last `retry` field received on this stream, or `STREAM_RETRY_MS`
 *   before any.
 */

import type { Connection } from './api.js';
import { SseParser, type SseEvent } from './sse.js';

/** The reconnection delay before the server has sent a `retry` field (as the server's `retry: 2000`). */
export const STREAM_RETRY_MS = 2000;

/** The stream path for a position id: `/api/stream?since=<encodeURIComponent(id)>`. */
export function streamUrl(id: string): string {
  return `/api/stream?since=${encodeURIComponent(id)}`;
}

/** What the stream reports. No handler is called after `close()`. */
export interface StreamHandlers {
  /** Every dispatched SSE event (`append`, `resync`, `problem`, or any other type), in order. */
  onEvent(event: SseEvent): void;
  /** A connection was answered with a 2xx status. */
  onOpen(): void;
  /** A connection ended other than by 401; a reconnection is scheduled. */
  onDisconnect(): void;
  /** A connection was answered 401: the token is not accepted; nothing more is attempted. */
  onUnauthorized(): void;
}

/** An open stream. */
export interface StreamHandle {
  /**
   * Stops the stream: aborts the request in flight (through the
   * `AbortSignal` passed to `fetch`), cancels a scheduled reconnection,
   * and calls no handler afterwards. Idempotent.
   */
  close(): void;
}

/**
 * Opens the stream at position `since`: `conn.deps.fetch(streamUrl(since),
 * { headers, signal })` where the headers are `Accept: text/event-stream`,
 * `Authorization: Bearer <conn.token>` and, on a reconnection after an id
 * was received, `Last-Event-ID: <that id>`. The body is decoded as UTF-8
 * (a character split across chunks is decoded whole) and fed to one
 * `SseParser` per connection, created with the last event id received so
 * far; each event it dispatches goes to `onEvent`. Reconnections are
 * scheduled with `conn.deps.setTimeout` as the module comment describes.
 */
export function openStream(
  conn: Connection,
  since: string,
  handlers: StreamHandlers,
): StreamHandle {
  const { deps } = conn;
  let closed = false;
  /** The last event id received on this stream, '' before any. */
  let lastId = '';
  let retryMs = STREAM_RETRY_MS;
  let controller: AbortController | null = null;
  let timer: { handle: unknown } | null = null;

  const dispatch = (events: readonly SseEvent[]): void => {
    for (const event of events) {
      if (closed) {
        return;
      }
      handlers.onEvent(event);
    }
  };

  const disconnected = (): void => {
    if (closed) {
      return;
    }
    handlers.onDisconnect();
    if (closed) {
      return;
    }
    const entry: { handle: unknown } = { handle: null };
    entry.handle = deps.setTimeout(() => {
      if (timer === entry) {
        timer = null;
      }
      void connect();
    }, retryMs);
    timer = entry;
  };

  const connect = async (): Promise<void> => {
    if (closed) {
      return;
    }
    const abort = new AbortController();
    controller = abort;
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${conn.token}`,
    };
    if (lastId !== '') {
      headers['Last-Event-ID'] = lastId;
    }
    let response: Response;
    try {
      response = await deps.fetch(streamUrl(since), { headers, signal: abort.signal });
    } catch {
      disconnected();
      return;
    }
    if (closed) {
      return;
    }
    const body = response.body;
    if (response.status === 401) {
      closed = true;
      void body?.cancel().catch(() => undefined);
      handlers.onUnauthorized();
      return;
    }
    if (!response.ok || body === null) {
      void body?.cancel().catch(() => undefined);
      disconnected();
      return;
    }
    handlers.onOpen();
    const parser = new SseParser(lastId);
    const decoder = new TextDecoder();
    const reader = body.getReader();
    const take = (text: string): void => {
      const events = parser.push(text);
      lastId = parser.lastEventId;
      retryMs = parser.retry ?? retryMs;
      dispatch(events);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) {
          return;
        }
        if (done) {
          take(decoder.decode());
          break;
        }
        take(decoder.decode(value, { stream: true }));
      }
    } catch {
      // A failed read ends the connection like the end of the body.
    }
    disconnected();
  };

  void connect();

  return {
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      controller?.abort();
      if (timer !== null) {
        deps.clearTimeout(timer.handle);
        timer = null;
      }
    },
  };
}
