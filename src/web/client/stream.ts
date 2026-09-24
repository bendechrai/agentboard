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
import type { SseEvent } from './sse.js';

/** The reconnection delay before the server has sent a `retry` field (as the server's `retry: 2000`). */
export const STREAM_RETRY_MS = 2000;

/** The stream path for a position id: `/api/stream?since=<encodeURIComponent(id)>`. */
export function streamUrl(id: string): string {
  void id;
  throw new Error('not implemented');
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
  void conn;
  void since;
  void handlers;
  throw new Error('not implemented');
}
