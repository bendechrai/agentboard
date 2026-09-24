/**
 * The test-only terminal interpreter (`screen.ts`) against hand-written
 * byte strings, so that the restricted output set of board-tui "Frame
 * rendering" is itself tested: every permitted sequence is understood and
 * everything else is reported.
 */

import { describe, expect, it } from 'vitest';

import { ESC, FakeTerminal, ScreenInterpreter, styleName } from './screen.js';

const at = (row: number, col: number): string => `${ESC}[${String(row)};${String(col)}H`;

function screen(columns = 10, rows = 3): ScreenInterpreter {
  const s = new ScreenInterpreter({ columns, rows });
  s.feed(`${ESC}[?1049h${ESC}[?25l`);
  return s;
}

describe('ScreenInterpreter', () => {
  it('enters and leaves the alternate screen and hides and shows the cursor', () => {
    const s = new ScreenInterpreter({ columns: 4, rows: 2 });
    expect(s.alt).toBe(false);
    expect(s.cursorVisible).toBe(true);
    s.feed(`${ESC}[?1049h${ESC}[?25l`);
    expect(s.alt).toBe(true);
    expect(s.cursorVisible).toBe(false);
    s.feed(`${ESC}[?25h${ESC}[?1049l`);
    expect(s.alt).toBe(false);
    expect(s.cursorVisible).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it('positions the cursor and writes text; unwritten cells are unknown', () => {
    const s = screen(5, 2);
    s.feed(`${at(2, 2)}abc`);
    expect(s.lines()).toEqual(['\0\0\0\0\0', '\0abc\0']);
    expect([...s.rowsWritten]).toEqual([1]);
    expect(s.errors).toEqual([]);
  });

  it('applies SGR 0, 1, 2, 7 and 30 to 37, alone or joined with ;', () => {
    const s = screen(8, 1);
    s.feed(`${at(1, 1)}${ESC}[1ma${ESC}[2;7mb${ESC}[0m${ESC}[33mc${ESC}[0;1;31md${ESC}[0me`);
    expect(s.cells[0]?.slice(0, 5).map((c) => styleName(c.style))).toEqual([
      'bold',
      'bold+dim+inverse',
      'yellow',
      'bold+red',
      '-',
    ]);
    expect(s.usedColor).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it('understands a sequence split across two writes', () => {
    const s = screen(4, 1);
    s.feed(`${ESC}[1;`);
    expect(s.incomplete).toBe(true);
    s.feed(`1Hxy${ESC}`);
    s.feed('[0m');
    expect(s.incomplete).toBe(false);
    expect(s.lines()[0]).toBe('xy\0\0');
    expect(s.errors).toEqual([]);
  });

  it.each([
    ['erase display', `${ESC}[2J`],
    ['erase line', `${ESC}[K`],
    ['256 colors', `${ESC}[38;5;1m`],
    ['bright color', `${ESC}[91m`],
    ['background color', `${ESC}[41m`],
    ['underline', `${ESC}[4m`],
    ['empty SGR', `${ESC}[m`],
    ['cursor home without parameters', `${ESC}[H`],
    ['cursor up', `${ESC}[A`],
    ['mouse tracking', `${ESC}[?1000h`],
    ['line wrap off', `${ESC}[?7l`],
    ['scroll region', `${ESC}[1;5r`],
    ['OSC title', `${ESC}]0;title\x07`],
    ['reset terminal', `${ESC}c`],
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['bell', '\x07'],
    ['non-ASCII', 'é'],
  ])('reports %s as a protocol error', (_, bytes) => {
    const s = screen();
    s.feed(at(1, 1));
    s.feed(bytes);
    expect(s.errors.length).toBeGreaterThan(0);
  });

  it('reports text outside the alternate screen, past the last column, and a cursor off screen', () => {
    const main = new ScreenInterpreter({ columns: 3, rows: 1 });
    main.feed('x');
    expect(main.errors).toHaveLength(1);
    const s = screen(3, 1);
    s.feed(`${at(1, 1)}abcd`);
    expect(s.errors).toHaveLength(1);
    const t = screen(3, 1);
    t.feed(at(2, 1));
    t.feed(at(1, 4));
    expect(t.errors).toHaveLength(2);
  });

  it('forgets the screen on resize', () => {
    const s = screen(3, 1);
    s.feed(`${at(1, 1)}abc`);
    s.resize({ columns: 2, rows: 2 });
    expect(s.lines()).toEqual(['\0\0', '\0\0']);
  });
});

describe('FakeTerminal', () => {
  it('records the first change with the exit listeners registered by then', () => {
    const term = new FakeTerminal({ columns: 4, rows: 1 });
    const remove = term.onExit(() => undefined);
    term.setRawMode(true);
    expect(term.exitListenersAtFirstChange).toBe(1);
    remove();
    remove();
    expect(term.listeners).toBe(0);
    expect(term.journal.filter((e) => e.kind === 'unlisten')).toHaveLength(1);
  });

  it('delivers input, resizes, the end of input and the exit to its listeners', () => {
    const term = new FakeTerminal({ columns: 4, rows: 1 });
    const seen: string[] = [];
    term.onData((chunk) => seen.push(`data ${Array.from(chunk).join(',')}`));
    term.onResize(() => seen.push(`resize ${JSON.stringify(term.size())}`));
    term.onEnd(() => seen.push('end'));
    term.onExit(() => seen.push('exit'));
    term.type('q\x03');
    term.resize({ columns: 5, rows: 2 });
    term.end();
    term.exit();
    expect(seen).toEqual(['data 113,3', 'resize {"columns":5,"rows":2}', 'end', 'exit']);
  });
});
