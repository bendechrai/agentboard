/**
 * The Server-Sent Events parser of the client (`sse.ts`; board-web: "Live event
 * stream"), as the HTML standard interprets an event stream, including chunk
 * boundaries that split lines and line ends, and multi-line data. Pure.
 */

import { describe, expect, it } from 'vitest';

import { SseParser, type SseEvent } from '../sse.js';

/** A byte order mark, U+FEFF. */
const BOM = String.fromCharCode(0xfeff);

/** Feeds `chunks` to one parser and returns every event, in order. */
function parse(chunks: readonly string[], lastEventId = ''): SseEvent[] {
  const parser = new SseParser(lastEventId);
  return chunks.flatMap((chunk) => parser.push(chunk));
}

/** Every way of cutting `text` in two, plus one character at a time. */
function splits(text: string): string[][] {
  const out: string[][] = [[...text]];
  for (let i = 0; i <= text.length; i += 1) {
    out.push([text.slice(0, i), text.slice(i)]);
  }
  return out;
}

const SERVER = [
  'retry: 2000\n\n',
  'event: append\nid: h1.d1\ndata: {"type":"append","id":"h1.d1"}\n\n',
  ': keepalive\n\n',
  'event: problem\ndata: {"error":{"message":"x"}}\n\n',
  'event: resync\nid: h2.d2\ndata: {"type":"resync","id":"h2.d2"}\n\n',
].join('');

const SERVER_EVENTS: SseEvent[] = [
  { type: 'append', data: '{"type":"append","id":"h1.d1"}', lastEventId: 'h1.d1' },
  { type: 'problem', data: '{"error":{"message":"x"}}', lastEventId: 'h1.d1' },
  { type: 'resync', data: '{"type":"resync","id":"h2.d2"}', lastEventId: 'h2.d2' },
];

describe('SseParser', () => {
  it('parses what the server sends: retry, typed events with ids, comments and problems', () => {
    const parser = new SseParser();
    expect(parser.lastEventId).toBe('');
    expect(parser.retry).toBeNull();
    expect(parser.push(SERVER)).toEqual(SERVER_EVENTS);
    expect(parser.retry).toBe(2000);
    expect(parser.lastEventId).toBe('h2.d2');
  });

  it('gives the same events wherever the chunks are cut', () => {
    for (const chunks of splits(SERVER)) {
      expect(parse(chunks)).toEqual(SERVER_EVENTS);
    }
  });

  it('joins multi-line data with line feeds, also across chunks', () => {
    const text = 'data: first\ndata: second\ndata:\ndata: fourth\n\n';
    const expected = [{ type: 'message', data: 'first\nsecond\n\nfourth', lastEventId: '' }];
    for (const chunks of splits(text)) {
      expect(parse(chunks)).toEqual(expected);
    }
  });

  it('accepts CRLF and CR line ends, and a CRLF split between chunks is one line end', () => {
    expect(parse(['event: a\r\ndata: 1\r\n\r\n'])).toEqual([
      { type: 'a', data: '1', lastEventId: '' },
    ]);
    expect(parse(['event: a\rdata: 1\r\r'])).toEqual([{ type: 'a', data: '1', lastEventId: '' }]);
    expect(parse(['data: a\r', '\ndata: b\r', '\n\r', '\n'])).toEqual([
      { type: 'message', data: 'a\nb', lastEventId: '' },
    ]);
    for (const chunks of splits('data: x\r\n\r\ndata: y\r\n\r\n')) {
      expect(parse(chunks)).toEqual([
        { type: 'message', data: 'x', lastEventId: '' },
        { type: 'message', data: 'y', lastEventId: '' },
      ]);
    }
  });

  it('removes one leading space of a value, and only one', () => {
    expect(parse(['data:no-space\n\n', 'data:  two\n\n', 'data: \n\n'])).toEqual([
      { type: 'message', data: 'no-space', lastEventId: '' },
      { type: 'message', data: ' two', lastEventId: '' },
      { type: 'message', data: '', lastEventId: '' },
    ]);
  });

  it('treats a line with no colon as a field with an empty value', () => {
    expect(parse(['data\n\n'])).toEqual([{ type: 'message', data: '', lastEventId: '' }]);
    expect(parse(['event\ndata: x\n\n'])).toEqual([
      { type: 'message', data: 'x', lastEventId: '' },
    ]);
  });

  it('dispatches nothing for an event without data, and resets the type', () => {
    expect(parse(['event: a\n\n', 'data: x\n\n'])).toEqual([
      { type: 'message', data: 'x', lastEventId: '' },
    ]);
    expect(parse([': only a comment\n\n', '\n\n'])).toEqual([]);
  });

  it('keeps the last event id for later events, and accepts an empty id', () => {
    expect(parse(['id: 1\ndata: a\n\n', 'data: b\n\n', 'id\ndata: c\n\n', 'id: 3\n\n'])).toEqual([
      { type: 'message', data: 'a', lastEventId: '1' },
      { type: 'message', data: 'b', lastEventId: '1' },
      { type: 'message', data: 'c', lastEventId: '' },
    ]);
    const parser = new SseParser();
    parser.push('id: 7\n\n');
    expect(parser.lastEventId).toBe('7');
  });

  it('ignores an id holding U+0000', () => {
    expect(parse(['id: 1\ndata: a\n\n', 'id: 2\u00003\ndata: b\n\n'])).toEqual([
      { type: 'message', data: 'a', lastEventId: '1' },
      { type: 'message', data: 'b', lastEventId: '1' },
    ]);
  });

  it('starts from the given last event id', () => {
    expect(parse(['data: a\n\n'], 'h0.d0')).toEqual([
      { type: 'message', data: 'a', lastEventId: 'h0.d0' },
    ]);
    expect(new SseParser('h0.d0').lastEventId).toBe('h0.d0');
  });

  it('sets retry only from ASCII digits', () => {
    const parser = new SseParser();
    parser.push('retry: 1500\n\n');
    expect(parser.retry).toBe(1500);
    parser.push('retry: 2x\n\nretry: -1\n\nretry:\n\nretry: 1.5\n\n');
    expect(parser.retry).toBe(1500);
    parser.push('retry: 0\n\n');
    expect(parser.retry).toBe(0);
  });

  it('ignores unknown fields and comments inside an event', () => {
    expect(parse(['event: a\nfoo: bar\n: note\ndata: x\n\n'])).toEqual([
      { type: 'a', data: 'x', lastEventId: '' },
    ]);
  });

  it('skips a byte order mark at the start of the stream only', () => {
    expect(parse([`${BOM}data: a\n\n`])).toEqual([{ type: 'message', data: 'a', lastEventId: '' }]);
    expect(parse([BOM, 'data: a\n\n'])).toEqual([{ type: 'message', data: 'a', lastEventId: '' }]);
    expect(parse([`data: a\n\n${BOM}data: b\n\n`])).toEqual([
      { type: 'message', data: 'a', lastEventId: '' },
    ]);
  });

  it('does not dispatch an event until its blank line arrives', () => {
    const parser = new SseParser();
    expect(parser.push('event: append\nid: 1\ndata: {}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ type: 'append', data: '{}', lastEventId: '1' }]);
    expect(parser.push('data: unfinished')).toEqual([]);
  });

  it('keeps data that holds colons and JSON intact', () => {
    const data = JSON.stringify({ text: 'DECISION: a: b', url: 'x:y' });
    expect(parse([`event: append\ndata: ${data}\n\n`])).toEqual([
      { type: 'append', data, lastEventId: '' },
    ]);
  });
});
