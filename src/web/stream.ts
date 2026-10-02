/**
 * The Server-Sent Events framing of `/api/stream` (board-web: "Live event
 * stream", "Reads never block writers"; add-board-web design.md:
 * "Server-Sent Events for the live stream", "One feed per server, fanned out
 * to every client"). The server (`src/web/server.ts`) owns the one feed and
 * the open streams; this module is the wire format and the limits. Pure.
 */

import type { ErrorDocument } from '../cli/main.js';
import type { FeedMessage } from '../view/types.js';

/** The reconnection delay sent first on every stream, in milliseconds. */
export const STREAM_RETRY_MS = 2000;

/** Interval of the keepalive comment line, in milliseconds. */
export const KEEPALIVE_MS = 15_000;

/** Streams open at once; one more is answered 503 `too-many-streams`. */
export const MAX_STREAMS = 64;

/**
 * Bytes of stream data one client may leave unread (the response's
 * buffered, not yet written, data) before it is disconnected: 4 MiB.
 */
export const STREAM_BUFFER_BYTES = 4 * 1024 * 1024;

/** The first bytes of every stream, exactly `retry: 2000\n\n`. */
export function sseRetry(): string {
  return `retry: ${String(STREAM_RETRY_MS)}\n\n`;
}

/**
 * One feed message as an SSE event, exactly
 * `event: <type>\nid: <message.id>\ndata: <JSON.stringify(message)>\n\n`
 * where `<type>` is `append` or `resync` (the data is one line: JSON text
 * has no raw newline). So `EventSource` reports it with the type as its
 * event name and the id as `lastEventId`, and sends that id back as
 * `Last-Event-ID` on reconnect.
 */
export function sseMessage(message: FeedMessage): string {
  return `event: ${message.type}\nid: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`;
}

/**
 * A tick failure as an SSE event, exactly
 * `event: problem\ndata: <JSON.stringify(doc)>\n\n`. It has no `id` line, so the
 * client's last event id stays the last position id it received.
 */
export function sseProblem(doc: ErrorDocument): string {
  return `event: problem\ndata: ${JSON.stringify(doc)}\n\n`;
}

/**
 * The keepalive, exactly `: keepalive\n\n`: one SSE comment line (ignored
 * by `EventSource`) and a blank line, sent every `KEEPALIVE_MS` on every open
 * stream.
 */
export function sseKeepalive(): string {
  return ': keepalive\n\n';
}
