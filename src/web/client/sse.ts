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
  #lastEventId: string;
  #retry: number | null = null;
  /** Text received after the last complete line. */
  #pending = '';
  /** True when the previous chunk ended with `\r`, so a leading `\n` belongs to it. */
  #afterCr = false;
  /** True until the first character of the stream has been seen (for the BOM). */
  #atStart = true;
  #type = '';
  #data = '';

  /**
   * `lastEventId` starts as given (a reconnecting reader passes the id it
   * last saw); `retry` starts null.
   */
  constructor(lastEventId = '') {
    this.#lastEventId = lastEventId;
  }

  /** The latest valid `id` field so far, or the initial id. */
  get lastEventId(): string {
    return this.#lastEventId;
  }

  /** The latest valid `retry` field in milliseconds, or null when none was received. */
  get retry(): number | null {
    return this.#retry;
  }

  /** Parses the next chunk of text and returns the events it completes, in order. */
  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.#atStart && text !== '') {
      this.#atStart = false;
      if (text.startsWith('\uFEFF')) {
        text = text.slice(1);
      }
    }
    if (this.#afterCr && text !== '') {
      this.#afterCr = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
      }
    }
    if (text !== '') {
      this.#afterCr = text.endsWith('\r');
    }
    const events: SseEvent[] = [];
    let buffer = this.#pending + text;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (match === null) {
        break;
      }
      // A `\r` at the very end may be the first half of a `\r\n`: it still
      // ends the line, and `#afterCr` drops the `\n` of the next chunk.
      this.#line(buffer.slice(0, match.index), events);
      buffer = buffer.slice(match.index + match[0].length);
    }
    this.#pending = buffer;
    return events;
  }

  /** Interprets one line, dispatching into `events` on a blank line. */
  #line(line: string, events: SseEvent[]): void {
    if (line === '') {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.#type = value;
        break;
      case 'data':
        this.#data += `${value}\n`;
        break;
      case 'id':
        if (!value.includes('\u0000')) {
          this.#lastEventId = value;
        }
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) {
          this.#retry = Number(value);
        }
        break;
      default:
        break;
    }
  }

  #dispatch(events: SseEvent[]): void {
    const type = this.#type === '' ? 'message' : this.#type;
    const data = this.#data;
    this.#type = '';
    this.#data = '';
    if (data === '') {
      return;
    }
    events.push({ type, data: data.slice(0, -1), lastEventId: this.#lastEventId });
  }
}
