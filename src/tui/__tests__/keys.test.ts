/**
 * The key decoder (board-tui: "Keys"; add-board-tui task 1.1): table tests
 * of every key's byte forms, including CSI and SS3 arrows, ignored
 * sequences and sequences split across reads.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SEQUENCE_BYTES, decodeKeys, flushKeys, type Key } from '../keys.js';

/** The bytes of a string of code units below 0x100 (so `\xNN` escapes give raw bytes). */
const bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

const char = (c: string): Key => ({ name: 'char', char: c });
const named = (name: Exclude<Key['name'], 'char'>): Key => ({ name });

/** Decodes `chunks` in order, passing the pending bytes along, then flushes. */
function decodeAll(chunks: readonly string[]): { keys: Key[]; pending: Uint8Array } {
  let pending: Uint8Array = new Uint8Array(0);
  const keys: Key[] = [];
  for (const chunk of chunks) {
    const result = decodeKeys(bytes(chunk), pending);
    keys.push(...result.keys);
    pending = result.pending;
  }
  return { keys, pending };
}

describe('decodeKeys: single keys', () => {
  const table: [string, string, Key[]][] = [
    ['lower-case letter', 'a', [char('a')]],
    ['q', 'q', [char('q')]],
    ['digit', '1', [char('1')]],
    ['question mark', '?', [char('?')]],
    ['space (0x20)', ' ', [char(' ')]],
    ['tilde (0x7E)', '~', [char('~')]],
    ['upper-case letter', 'Z', [char('Z')]],
    ['CR is enter', '\r', [named('enter')]],
    ['LF is enter', '\n', [named('enter')]],
    ['CR LF is two enters', '\r\n', [named('enter'), named('enter')]],
    ['tab (0x09)', '\t', [named('tab')]],
    ['DEL (0x7F) is backspace', '\x7f', [named('backspace')]],
    ['BS (0x08) is backspace', '\x08', [named('backspace')]],
    ['Ctrl-C (0x03)', '\x03', [named('ctrl-c')]],
    ['CSI up', '\x1b[A', [named('up')]],
    ['CSI down', '\x1b[B', [named('down')]],
    ['CSI right', '\x1b[C', [named('right')]],
    ['CSI left', '\x1b[D', [named('left')]],
    ['SS3 up', '\x1bOA', [named('up')]],
    ['SS3 down', '\x1bOB', [named('down')]],
    ['SS3 right', '\x1bOC', [named('right')]],
    ['SS3 left', '\x1bOD', [named('left')]],
    ['CSI page up', '\x1b[5~', [named('pageup')]],
    ['CSI page down', '\x1b[6~', [named('pagedown')]],
  ];
  it.each(table)('%s', (_label, input, expected) => {
    expect(decodeKeys(bytes(input))).toEqual({ keys: expected, pending: new Uint8Array(0) });
  });
});

describe('decodeKeys: ignored input', () => {
  const table: [string, string][] = [
    ['NUL', '\x00'],
    ['Ctrl-A', '\x01'],
    ['Ctrl-Z', '\x1a'],
    ['0x1F', '\x1f'],
    ['a byte from 0x80', '\x80'],
    ['0xFF', '\xff'],
    ['UTF-8 bytes of e-acute', '\xc3\xa9'],
    ['CSI arrow with a modifier', '\x1b[1;5A'],
    ['CSI delete', '\x1b[3~'],
    ['CSI home with a parameter', '\x1b[1~'],
    ['CSI shift-tab', '\x1b[Z'],
    ['CSI page up with a modifier', '\x1b[5;2~'],
    ['CSI with an intermediate byte', '\x1b[ q'],
    ['SS3 F1', '\x1bOP'],
    ['SS3 with a digit', '\x1bO5'],
  ];
  it.each(table)('%s gives no key', (_label, input) => {
    expect(decodeKeys(bytes(input))).toEqual({ keys: [], pending: new Uint8Array(0) });
  });

  it('keeps decoding after an ignored sequence', () => {
    expect(decodeKeys(bytes('a\x1b[1;5Ab\x1b[3~\xc3\xa9c\x1bOPd')).keys).toEqual([
      char('a'),
      char('b'),
      char('c'),
      char('d'),
    ]);
  });
});

describe('decodeKeys: escape', () => {
  it('holds a lone ESC at the end of the input as pending', () => {
    expect(decodeKeys(bytes('\x1b'))).toEqual({ keys: [], pending: bytes('\x1b') });
    expect(decodeKeys(bytes('q\x1b'))).toEqual({ keys: [char('q')], pending: bytes('\x1b') });
  });

  it('decodes ESC followed by another byte as escape, then that byte', () => {
    expect(decodeKeys(bytes('\x1bq')).keys).toEqual([named('escape'), char('q')]);
    expect(decodeKeys(bytes('\x1b\r')).keys).toEqual([named('escape'), named('enter')]);
    expect(decodeKeys(bytes('\x1b\x03')).keys).toEqual([named('escape'), named('ctrl-c')]);
  });

  it('decodes ESC ESC as escape and keeps the second ESC pending', () => {
    expect(decodeKeys(bytes('\x1b\x1b'))).toEqual({
      keys: [named('escape')],
      pending: bytes('\x1b'),
    });
    expect(decodeKeys(bytes('\x1b\x1b[A')).keys).toEqual([named('escape'), named('up')]);
  });

  it('flushKeys turns a lone pending ESC into escape and drops anything else', () => {
    expect(flushKeys(bytes('\x1b'))).toEqual([named('escape')]);
    expect(flushKeys(new Uint8Array(0))).toEqual([]);
    expect(flushKeys(bytes('\x1b['))).toEqual([]);
    expect(flushKeys(bytes('\x1b[5'))).toEqual([]);
    expect(flushKeys(bytes('\x1bO'))).toEqual([]);
  });
});

describe('decodeKeys: sequences split across reads', () => {
  it('returns the incomplete sequence as pending', () => {
    expect(decodeKeys(bytes('\x1b['))).toEqual({ keys: [], pending: bytes('\x1b[') });
    expect(decodeKeys(bytes('j\x1b[5'))).toEqual({ keys: [char('j')], pending: bytes('\x1b[5') });
    expect(decodeKeys(bytes('\x1b[1;5'))).toEqual({ keys: [], pending: bytes('\x1b[1;5') });
    expect(decodeKeys(bytes('\x1bO'))).toEqual({ keys: [], pending: bytes('\x1bO') });
  });

  it('completes a CSI arrow split after ESC', () => {
    const first = decodeKeys(bytes('\x1b'));
    expect(decodeKeys(bytes('[A'), first.pending)).toEqual({
      keys: [named('up')],
      pending: new Uint8Array(0),
    });
  });

  it('completes a page down split inside its parameter', () => {
    const first = decodeKeys(bytes('\x1b[6'));
    expect(first.keys).toEqual([]);
    expect(decodeKeys(bytes('~k'), first.pending).keys).toEqual([named('pagedown'), char('k')]);
  });

  it('completes an SS3 arrow split after O', () => {
    const first = decodeKeys(bytes('\x1bO'));
    expect(decodeKeys(bytes('D'), first.pending).keys).toEqual([named('left')]);
  });

  it('decodes a pending ESC followed by a plain key as escape then that key', () => {
    const first = decodeKeys(bytes('\x1b'));
    expect(decodeKeys(bytes('q'), first.pending).keys).toEqual([named('escape'), char('q')]);
  });

  it('decodes the same keys at every split point, and byte by byte', () => {
    const input = 'a\x1b[Ab\x1bOB\x1b[5~\x1b[6~\x1b[1;5C\x1bq\r\t\x7f\x03z';
    const whole = decodeAll([input]).keys;
    expect(whole).toEqual([
      char('a'),
      named('up'),
      char('b'),
      named('down'),
      named('pageup'),
      named('pagedown'),
      named('escape'),
      char('q'),
      named('enter'),
      named('tab'),
      named('backspace'),
      named('ctrl-c'),
      char('z'),
    ]);
    for (let i = 0; i <= input.length; i += 1) {
      const split = decodeAll([input.slice(0, i), input.slice(i)]);
      expect(split.keys, `split at ${String(i)}`).toEqual(whole);
      expect(split.pending).toEqual(new Uint8Array(0));
    }
    expect(decodeAll([...input]).keys).toEqual(whole);
  });

  it('drops a CSI sequence interrupted by a byte outside 0x20 to 0x7E and resumes at that byte', () => {
    expect(decodeKeys(bytes('\x1b[1\x03'))).toEqual({
      keys: [named('ctrl-c')],
      pending: new Uint8Array(0),
    });
    expect(decodeKeys(bytes('\x1b[\r')).keys).toEqual([named('enter')]);
    expect(decodeKeys(bytes('\x1b[5\x1b[A')).keys).toEqual([named('up')]);
  });

  it('never holds more than MAX_SEQUENCE_BYTES pending bytes', () => {
    expect(MAX_SEQUENCE_BYTES).toBe(16);
    const almost = `\x1b[${'1'.repeat(MAX_SEQUENCE_BYTES - 3)}`;
    expect(decodeKeys(bytes(almost)).pending).toEqual(bytes(almost));
    const full = `\x1b[${'1'.repeat(MAX_SEQUENCE_BYTES - 2)}`;
    expect(decodeKeys(bytes(full))).toEqual({ keys: [], pending: new Uint8Array(0) });
    let pending: Uint8Array = new Uint8Array(0);
    for (const c of `\x1b[${'1;'.repeat(40)}`) {
      pending = decodeKeys(bytes(c), pending).pending;
      expect(pending.length).toBeLessThanOrEqual(MAX_SEQUENCE_BYTES);
    }
  });

  it('does not modify its arguments', () => {
    const input = bytes('[A');
    const pending = bytes('\x1b');
    decodeKeys(input, pending);
    expect(input).toEqual(bytes('[A'));
    expect(pending).toEqual(bytes('\x1b'));
  });
});
