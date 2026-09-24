/**
 * A Server-Sent Events parser (board-web: "Live event stream";
 * `src/web/stream.ts` holds the server's framing; add-board-web task 4.2).
 * The client reads `/api/stream` with `fetch`, because `EventSource`
 * cannot send the `Authorization` header, and parses the body with this.
 * Pure: text in, events out.
 *
 * It follows the event stream interpretation of the HTML standard
 * ("Server-sent events", "Interpreting an event stream"):
 * - Lines end with `\r\n`, `\n` or `\r`. Text arrives in chunks that may
 *   split a line anywhere, including between the `\r` and `\n` of one
 *   `\r\n` (which is still one line end). A byte order mark (U+FEFF) at the
 *   very start of the stream is skipped.
 * - A line starting with `:` is a comment and is ignored.
 * - Otherwise the line is `<field>:<value>`, with one leading space of the
 *   value removed if present; a line with no `:` is a field with an empty
 *   value. Fields: `event` sets the event type; `data` appends the value
 *   and a line feed to the data buffer; `id` sets the last event id unless
 *   the value contains U+0000; `retry` sets the reconnection delay when the
 *   value is one or more ASCII digits; any other field is ignored.
 * - A blank line dispatches: when the data buffer is empty, nothing is
 *   dispatched; otherwise an event with the type (`message` when no `event`
 *   field was given, or it was empty), the data without its final line
 *   feed, and the last event id. Then the type and data buffer are reset;
 *   the last event id is kept for later events.
 * - A final event not ended by a blank line is never dispatched.
 */

/** One dispatched event. */
export interface SseEvent {
  /** The `event` field, or `message`. */
  type: string;
  /** The `data` lines joined with `\n`. */
  data: string;
  /** The last event id at dispatch (the latest valid `id` field so far, or the initial one). */
  lastEventId: string;
}

/** An incremental parser of one event stream. */
export class SseParser {
  /**
   * `lastEventId` starts as given (a reconnecting reader passes the id it
   * last saw); `retry` starts null.
   */
  constructor(lastEventId = '') {
    void lastEventId;
  }

  /** The latest valid `id` field so far, or the initial id. */
  get lastEventId(): string {
    throw new Error('not implemented');
  }

  /** The latest valid `retry` field in milliseconds, or null when none was received. */
  get retry(): number | null {
    throw new Error('not implemented');
  }

  /** Parses the next chunk of text and returns the events it completes, in order. */
  push(chunk: string): SseEvent[] {
    void chunk;
    throw new Error('not implemented');
  }
}
