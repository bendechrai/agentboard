/**
 * Frames (board-tui: "Views", "Frame rendering"; add-board-tui task 1.2):
 * plain-text golden files for each view at 80x24 and 140x40, the too-small
 * screen and a detail with a decision, a retracted decision and a
 * retraction; then the layout rules, truncation and the style map.
 *
 * The golden files under `golden/` are the exact frame lines, one per file
 * line, with trailing spaces (see `.editorconfig`). They were produced by a
 * throwaway implementation written from the doc comments of `frame.ts` and
 * checked by hand; never regenerate them from the implementation under
 * test.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import { E, TASK, model } from '../../view/__tests__/helpers.js';
import { feedEntries } from '../../view/feed.js';
import type { BoardModel } from '../../view/types.js';
import {
  FEED_PANE_MIN_COLUMNS,
  FEED_PANE_WIDTH,
  HELP_LINES,
  KEY_LINES,
  MIN_COLUMNS,
  MIN_ROWS,
  detailLines,
  feedLine,
  fitText,
  renderFrame,
} from '../frame.js';
import type { UiState } from '../state.js';
import { DEFAULT, all, expectCanonical, style, styleAt, stylesOf } from './frame-helpers.js';
import { NOW, T1, T2, T3, T4, T5, T6, T7, fixtureModel, START_UI } from './fixtures.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

/** The lines of a golden file (one frame line per file line, final newline dropped). */
function golden(name: string): string[] {
  const text = readFileSync(join(GOLDEN, name), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

const M = fixtureModel();
const START = START_UI;
const SMALL = { columns: 80, rows: 24 };
const LARGE = { columns: 140, rows: 40 };

/** The UI states of the golden frames. */
const VIEWS: Record<string, UiState> = {
  board: { ...START, board: { column: 2, row: 0 } },
  feed: { ...START, view: 'feed', feed: 1 },
  lanes: { ...START, view: 'lanes', lanes: 1 },
  detail: { ...START, detail: { ticket: T1, scroll: 0 } },
};

describe('golden frames', () => {
  for (const [name, ui] of Object.entries(VIEWS)) {
    for (const size of [SMALL, LARGE]) {
      const file = `${name}-${String(size.columns)}x${String(size.rows)}.txt`;
      it(`${name} view at ${String(size.columns)}x${String(size.rows)} matches ${file}`, () => {
        expect(renderFrame(M, ui, size, NOW).lines).toEqual(golden(file));
      });
    }
  }

  it('the too-small screen at 50x10 matches too-small-50x10.txt', () => {
    expect(renderFrame(M, START, { columns: 50, rows: 10 }, NOW).lines).toEqual(
      golden('too-small-50x10.txt'),
    );
  });

  it('every golden file is exactly rows lines of exactly columns characters', () => {
    for (const [file, columns, rows] of [
      ['board-80x24.txt', 80, 24],
      ['board-140x40.txt', 140, 40],
      ['too-small-50x10.txt', 50, 10],
    ] as const) {
      const lines = golden(file);
      expect(lines).toHaveLength(rows);
      for (const line of lines) {
        expect(line).toHaveLength(columns);
      }
    }
  });
});

describe('scenario "Board at 80 columns"', () => {
  it('shows six column headings with counts and each card in its status column', () => {
    const frame = renderFrame(M, START, SMALL, NOW);
    // w = floor((80 - 5) / 6) = 12; column k starts at 13 * k.
    const cell = (line: number, k: number): string =>
      (frame.lines[line] ?? '').slice(13 * k, 13 * k + 12);
    expect([0, 1, 2, 3, 4, 5].map((k) => cell(1, k))).toEqual([
      'todo 2      ',
      'tests 1     ',
      'implement~ 1',
      'review 1    ',
      'blocked 1   ',
      'merged 0    ',
    ]);
    expect(cell(2, 0).startsWith(T4.slice(0, 10))).toBe(true);
    expect(cell(3, 0).startsWith(T3.slice(0, 10))).toBe(true);
    expect(cell(2, 1).startsWith(T2.slice(0, 10))).toBe(true);
    expect(cell(2, 2).startsWith(T1.slice(0, 10))).toBe(true);
    expect(cell(2, 3).startsWith(T5.slice(0, 10))).toBe(true);
    expect(cell(2, 4).startsWith(T6.slice(0, 10))).toBe(true);
    expect(cell(2, 5)).toBe(' '.repeat(12));
    for (let line = 1; line <= 22; line += 1) {
      for (const k of [0, 1, 2, 3, 4]) {
        expect(frame.lines[line]?.[13 * k + 12]).toBe('|');
      }
    }
  });

  it('shows the closed card in merged when closed tickets are toggled on', () => {
    const frame = renderFrame(M, { ...START, showClosed: true }, SMALL, NOW);
    expect(frame.lines[1]?.slice(65, 77)).toBe('merged 1    ');
    expect(frame.lines[2]?.slice(65, 77).startsWith(T7.slice(0, 10))).toBe(true);
    expect(frame.lines[0]).toContain('merged:1');
  });
});

describe('scenario "Decision in the detail"', () => {
  it('marks the retracted decision, the retraction and the open decision', () => {
    const lines = renderFrame(M, VIEWS.detail ?? START, LARGE, NOW).lines.map((l) => l.trimEnd());
    expect(lines).toContain('[DECISION, retracted] impl: DECISION: use readline for keys');
    expect(lines).toContain('[RETRACTED] impl: RETRACTED: readline cannot see raw bytes');
    expect(lines).toContain('[DECISION] impl: DECISION: decode raw bytes with a pending buffer');
  });
});

describe('scenario "Too small"', () => {
  it('shows only the message at 50x10', () => {
    const frame = renderFrame(M, START, { columns: 50, rows: 10 }, NOW);
    expect(frame.lines[0]).toBe('terminal too small: need 60x15, have 50x10'.padEnd(50));
    expect(frame.lines.slice(1)).toEqual(Array.from({ length: 9 }, () => ' '.repeat(50)));
    expect(frame.styles).toEqual(Array.from({ length: 10 }, () => []));
  });

  it('applies below 60 columns or below 15 rows, whatever the UI state', () => {
    expect(MIN_COLUMNS).toBe(60);
    expect(MIN_ROWS).toBe(15);
    expect(renderFrame(M, START, { columns: 59, rows: 40 }, NOW).lines[0]).toBe(
      'terminal too small: need 60x15, have 59x40'.padEnd(59),
    );
    const detail = { ...START, detail: { ticket: T1, scroll: 0 }, help: true };
    expect(renderFrame(M, detail, { columns: 200, rows: 14 }, NOW).lines[0]).toBe(
      'terminal too small: need 60x15, have 200x14'.padEnd(200),
    );
    expect(renderFrame(M, START, { columns: 60, rows: 15 }, NOW).lines[0]).toMatch(
      /^agentboard top {2}/,
    );
  });

  it('truncates the message on a tiny screen and handles zero sizes', () => {
    expect(renderFrame(M, START, { columns: 10, rows: 3 }, NOW).lines).toEqual([
      'terminal ~',
      '          ',
      '          ',
    ]);
    expect(renderFrame(M, START, { columns: 0, rows: 2 }, NOW)).toEqual({
      lines: ['', ''],
      styles: [[], []],
    });
    expect(renderFrame(M, START, { columns: 30, rows: 0 }, NOW)).toEqual({ lines: [], styles: [] });
  });
});

describe('fitText', () => {
  it.each([
    ['abc', 5, 'abc  '],
    ['abcde', 5, 'abcde'],
    ['abcdef', 5, 'abcd~'],
    ['ab', 1, '~'],
    ['a', 1, 'a'],
    ['', 3, '   '],
    ['', 0, ''],
    ['abc', 0, ''],
    ['caf\u00e9', 12, 'caf\\u00E9   '],
    ['caf\u00e9', 6, 'caf\\u~'],
    ['a\\b', 4, 'a\\\\b'],
    ['line\nbreak', 20, 'line\\u000Abreak     '],
    ['tab\there', 13, 'tab\\u0009here'],
  ])('fitText(%j, %i) is %j', (text, width, expected) => {
    expect(fitText(text, width)).toBe(expected);
  });
});

describe('feedLine', () => {
  const entries = feedEntries(M);

  it('is time padded to 8, actor, short ticket id and summary', () => {
    expect(feedLine(entries[0] ?? fail(), NOW)).toBe(
      `just now impl ${T5.slice(0, 10)} handed off to rev (review): please review the goldens`,
    );
    expect(feedLine(entries[2] ?? fail(), NOW)).toBe(
      `19m ago  impl ${T5.slice(0, 10)} moved to implementing`,
    );
  });

  it('marks a late entry after the time', () => {
    expect(feedLine(entries[1] ?? fail(), NOW)).toBe(
      `10m ago  late impl ${T5.slice(0, 10)} commented: frames look right`,
    );
  });

  it('shows - for an entry with no ticket', () => {
    expect(feedLine(entries.at(-1) ?? fail(), NOW)).toBe('1d ago   orch - set project');
  });

  it('does not escape (fitText does it once)', () => {
    const m = model([
      E.create(T1, { title: 'back\\slash', task: TASK }, { actor: 'orch', wall: NOW - 20_000 }),
    ]);
    expect(feedLine(feedEntries(m)[0] ?? fail(), NOW)).toBe(
      `20s ago  orch ${T1.slice(0, 10)} created back\\slash`,
    );
  });
});

function fail(): never {
  throw new Error('fixture entry missing');
}

describe('detailLines', () => {
  it('lists the fields, checklist, links, disposition and conversation of T1', () => {
    expect(detailLines(M, T1, 140)).toEqual([
      `ticket ${T1}`,
      'title: Decode raw key bytes',
      'status: implementing',
      'assignee: impl',
      'task: openspec:add-board-web#1',
      'labels: tui, keys',
      'description: -',
      'checklist: 1/2',
      '  [x] CSI',
      '  [ ] SS3',
      'links:',
      '  pr 42',
      'disposition: open',
      '',
      'conversation:',
      '  orch created Decode raw key bytes',
      '  impl claimed',
      '  impl moved to tests',
      '  impl moved to implementing',
      '[DECISION, retracted] impl: DECISION: use readline for keys',
      '[RETRACTED] impl: RETRACTED: readline cannot see raw bytes',
      '[DECISION] impl: DECISION: decode raw bytes with a pending buffer',
      '  impl checked 1',
      '  impl linked pr 42',
    ]);
    expect(detailLines(M, T1, 80)).toHaveLength(24);
  });

  it('shows a hand-off, an unassigned ad hoc ticket, a blocked ticket and a closed one', () => {
    expect(detailLines(M, T5, 140)).toContain('impl -> rev (review): please review the goldens');
    const t3 = detailLines(M, T3, 140);
    expect(t3).toContain('assignee: -');
    expect(t3).toContain('task: adhoc: docs');
    expect(t3).toContain('labels: -');
    expect(t3).toContain('checklist: -');
    expect(t3).toContain('links: -');
    expect(detailLines(M, T6, 140)).toContain('status: blocked (from implementing)');
    expect(detailLines(M, T7, 140)).toContain('disposition: closed, decision docs/adr/0008-tui.md');
    const noDecision = model([
      E.create(T1, { title: 'x', task: TASK, description: 'why\nnot' }, { wall: 100 }),
      E.move(T1, 'blocked', { wall: 200 }),
      E.link(T1, { decision: 'docs/adr/0001.md' }, { wall: 250 }),
      E.close(T1, { noDecision: true }, { wall: 300 }),
    ]);
    const lines = detailLines(noDecision, T1, 140);
    expect(lines).toContain('disposition: closed, no decision');
    expect(lines).toContain('description: why\\u000Anot');
    expect(lines).toContain('links:');
    expect(lines).toContain('  decision docs/adr/0001.md');
  });

  it('escapes the title of T4 once', () => {
    expect(detailLines(M, T4, 140)).toContain('title: Caf\\u00E9 \\u00FCber keys');
  });

  it('wraps long lines at the width without truncating', () => {
    const text = `DECISION: ${'x'.repeat(100)}`;
    const m = model([
      E.create(T1, { title: 't', task: TASK }, { actor: 'orch', wall: 100 }),
      E.comment(T1, text, { actor: 'impl', wall: 200 }),
    ]);
    const lines = detailLines(m, T1, 60);
    const full = `[DECISION] impl: ${text}`;
    const at = lines.indexOf(full.slice(0, 60));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 3)).toEqual([
      full.slice(0, 60),
      full.slice(60, 120),
      full.slice(120),
    ]);
    expect(lines.at(-1)).toBe(full.slice(120));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it('says when the ticket is not in the model', () => {
    expect(detailLines(M, 'NOPE', 80)).toEqual(['ticket NOPE not found']);
  });
});

describe('header and key line', () => {
  it('shows the counts, the time since the last event and the directory', () => {
    const frame = renderFrame(M, START, LARGE, NOW);
    expect(frame.lines[0]).toBe(
      'agentboard top  todo:2 tests:1 implementing:1 review:1 blocked:1 merged:0  last event just now  /work/agentboard/.board'.padEnd(
        140,
      ),
    );
  });

  it('says no events on an empty board, and escapes the directory', () => {
    const frame = renderFrame(model([]), { ...START, boardDir: '/tmp/caf\u00e9' }, LARGE, NOW);
    expect(frame.lines[0]?.trimEnd()).toBe(
      'agentboard top  todo:0 tests:0 implementing:0 review:0 blocked:0 merged:0  no events  /tmp/caf\\u00E9',
    );
  });

  it('shows the key line of each mode', () => {
    const last = (ui: UiState): string =>
      (renderFrame(M, ui, LARGE, NOW).lines[LARGE.rows - 1] ?? '').trimEnd();
    expect(last(START)).toBe(KEY_LINES.board);
    expect(last({ ...START, view: 'feed' })).toBe(KEY_LINES.feed);
    expect(last({ ...START, view: 'lanes' })).toBe(KEY_LINES.lanes);
    expect(last({ ...START, view: 'lanes', detail: { ticket: T1, scroll: 0 } })).toBe(
      KEY_LINES.detail,
    );
    expect(last({ ...START, detail: { ticket: T1, scroll: 0 }, help: true })).toBe(KEY_LINES.help);
    expect(last({ ...START, notice: 'busy' })).toBe(`busy  ${KEY_LINES.board}`);
  });

  it('styles the header bold and the key line dim, the notice bold yellow', () => {
    const frame = renderFrame(M, START, SMALL, NOW);
    expect(stylesOf(frame, 0, 0, 80)).toEqual(all(80, style({ bold: true })));
    expect(stylesOf(frame, 23, 0, 80)).toEqual(all(80, style({ dim: true })));
    const busy = renderFrame(M, { ...START, notice: 'busy' }, SMALL, NOW);
    expect(stylesOf(busy, 23, 0, 4)).toEqual(all(4, style({ bold: true, color: 'yellow' })));
    expect(stylesOf(busy, 23, 4, 80)).toEqual(all(76, style({ dim: true })));
  });
});

describe('help overlay', () => {
  it('replaces the body with the help lines, over any view or detail', () => {
    for (const ui of [
      { ...START, help: true },
      { ...START, view: 'lanes' as const, help: true, detail: { ticket: T1, scroll: 0 } },
    ]) {
      const frame = renderFrame(M, ui, SMALL, NOW);
      const body = frame.lines.slice(1, 23).map((l) => l.trimEnd());
      expect(body).toEqual([
        ...HELP_LINES,
        ...Array.from({ length: 22 - HELP_LINES.length }, () => ''),
      ]);
      for (let y = 1; y < 23; y += 1) {
        expect(frame.styles[y]).toEqual([]);
      }
    }
  });
});

describe('board view layout', () => {
  it('uses equal columns, with a feed pane of 40 columns from 140 columns', () => {
    expect(FEED_PANE_MIN_COLUMNS).toBe(140);
    expect(FEED_PANE_WIDTH).toBe(40);
    const narrow = renderFrame(M, START, { columns: 139, rows: 40 }, NOW);
    expect(narrow.lines.join('\n')).not.toContain('activity');
    // 139 columns: w = floor(134 / 6) = 22.
    expect(narrow.lines[1]?.slice(0, 23)).toBe('todo 2'.padEnd(22) + '|');
    const wide = renderFrame(M, START, LARGE, NOW);
    // 140 columns: W = 100, w = 15, the pane separator at 100.
    expect(wide.lines[1]?.slice(96, 140)).toBe(`    |${'activity'.padEnd(39)}`);
    expect(wide.lines[2]?.slice(100)).toBe(
      `|${fitText(feedLine(feedEntries(M)[0] ?? fail(), NOW), 39)}`,
    );
    for (let y = 1; y < 39; y += 1) {
      expect(wide.lines[y]?.[100]).toBe('|');
    }
    expect(stylesOf(wide, 1, 101, 109)).toEqual(all(8, style({ bold: true })));
  });

  it('keeps the count in a heading by truncating the status', () => {
    // 60 columns: w = floor(55 / 6) = 9.
    const frame = renderFrame(M, START, { columns: 60, rows: 15 }, NOW);
    expect(frame.lines[1]?.slice(0, 60)).toBe(
      'todo 2   |tests 1  |implem~ 1|review 1 |blocked 1|merged 0  ',
    );
  });

  it('truncates cards with ~ and escapes non-ASCII titles', () => {
    const frame = renderFrame(M, START, { columns: 200, rows: 20 }, NOW);
    // 200 columns: W = 160, w = 25.
    expect(frame.lines[2]?.slice(0, 25)).toBe(
      fitText(`${T4.slice(0, 10)} orch Caf\u00e9 \u00fcber keys`, 25),
    );
    expect(frame.lines[2]?.slice(0, 25)).toBe(`${T4.slice(0, 10)} orch Caf\\u00E~`);
    expect(frame.lines[2]?.slice(26, 51)).toBe(`${T2.slice(0, 10)} test-author R~`);
  });

  it('styles the selected card inverse, a changed card bold and a closed card dim', () => {
    const ui = { ...START, showClosed: true, board: { column: 2, row: 0 } };
    const frame = renderFrame(M, ui, SMALL, NOW);
    // Headings bold.
    expect(stylesOf(frame, 1, 0, 12)).toEqual(all(12, style({ bold: true })));
    expect(styleAt(frame, 1, 12)).toEqual(DEFAULT);
    // Selected: implementing (column 2, cells 26 to 37).
    expect(stylesOf(frame, 2, 26, 38)).toEqual(all(12, style({ inverse: true })));
    expect(styleAt(frame, 2, 25)).toEqual(DEFAULT);
    expect(styleAt(frame, 2, 38)).toEqual(DEFAULT);
    // T5 in review changed 2 seconds before NOW.
    expect(stylesOf(frame, 2, 39, 51)).toEqual(all(12, style({ bold: true })));
    // T7 closed in merged.
    expect(stylesOf(frame, 2, 65, 77)).toEqual(all(12, style({ dim: true })));
    // Unchanged, unselected open card.
    expect(stylesOf(frame, 2, 0, 12)).toEqual(all(12, DEFAULT));
    const both = renderFrame(M, { ...START, board: { column: 3, row: 0 } }, SMALL, NOW);
    expect(stylesOf(both, 2, 39, 51)).toEqual(all(12, style({ bold: true, inverse: true })));
    // Six seconds later T5 is no longer changed.
    const later = renderFrame(M, START, SMALL, NOW + 4000);
    expect(stylesOf(later, 2, 39, 51)).toEqual(all(12, DEFAULT));
  });

  it('highlights nothing when the selected column is empty', () => {
    const frame = renderFrame(M, { ...START, board: { column: 5, row: 0 } }, SMALL, NOW);
    for (let y = 2; y < 23; y += 1) {
      expect(stylesOf(frame, y, 0, 80).some((s) => s.inverse)).toBe(false);
    }
  });

  it('scrolls only the selected column so the selected card stays visible', () => {
    const inputs: FoldInput[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = `01H${String(i).padStart(2, '0')}00000000000000000000`;
      ids.push(id);
      inputs.push(E.create(id, { title: `t${String(i)}`, task: TASK }, { wall: 1000 - i }));
    }
    const m = model(inputs);
    // 80x24: K = 21 card lines; cards are newest first, so ids in order.
    const frame = renderFrame(m, { ...START, board: { column: 0, row: 25 } }, SMALL, NOW);
    expect(frame.lines[2]?.slice(0, 10)).toBe(ids[5]?.slice(0, 10));
    expect(frame.lines[22]?.slice(0, 10)).toBe(ids[25]?.slice(0, 10));
    expect(styleAt(frame, 22, 0).inverse).toBe(true);
    const top = renderFrame(m, { ...START, board: { column: 0, row: 20 } }, SMALL, NOW);
    expect(top.lines[2]?.slice(0, 10)).toBe(ids[0]?.slice(0, 10));
    expect(styleAt(top, 22, 0).inverse).toBe(true);
    // Another column selected: the first column shows from its first card.
    const other = renderFrame(m, { ...START, board: { column: 1, row: 25 } }, SMALL, NOW);
    expect(other.lines[2]?.slice(0, 10)).toBe(ids[0]?.slice(0, 10));
  });
});

describe('feed view layout', () => {
  it('styles the selected entry inverse over the whole line and the late marker yellow', () => {
    const frame = renderFrame(M, VIEWS.feed ?? START, SMALL, NOW);
    // Entry 1 (selected, late) is body line 1, frame line 2.
    expect(stylesOf(frame, 2, 0, 9)).toEqual(all(9, style({ inverse: true })));
    expect(stylesOf(frame, 2, 9, 13)).toEqual(all(4, style({ inverse: true, color: 'yellow' })));
    expect(stylesOf(frame, 2, 13, 80)).toEqual(all(67, style({ inverse: true })));
    expect(stylesOf(frame, 1, 0, 80)).toEqual(all(80, DEFAULT));
    const unselected = renderFrame(M, { ...START, view: 'feed' }, SMALL, NOW);
    expect(stylesOf(unselected, 2, 9, 13)).toEqual(all(4, style({ color: 'yellow' })));
    expect(styleAt(unselected, 2, 8)).toEqual(DEFAULT);
  });

  it('scrolls so the selected entry is on the last body line', () => {
    const entries = feedEntries(M);
    const frame = renderFrame(M, { ...START, view: 'feed', feed: 25 }, SMALL, NOW);
    // H = 22: top = 25 - 22 + 1 = 4.
    expect(frame.lines[1]).toBe(fitText(feedLine(entries[4] ?? fail(), NOW), 80));
    expect(frame.lines[22]).toBe(fitText(feedLine(entries[25] ?? fail(), NOW), 80));
    expect(styleAt(frame, 22, 0).inverse).toBe(true);
  });

  it('says no events on an empty feed', () => {
    const frame = renderFrame(model([]), { ...START, view: 'feed' }, SMALL, NOW);
    expect(frame.lines[1]).toBe('no events'.padEnd(80));
    expect(frame.lines.slice(2, 23)).toEqual(Array.from({ length: 21 }, () => ' '.repeat(80)));
  });
});

describe('lanes view layout', () => {
  it('styles lane headers bold and the selected one inverse too', () => {
    const frame = renderFrame(M, VIEWS.lanes ?? START, SMALL, NOW);
    expect(frame.lines[1]?.trimEnd()).toBe('impl  last seen just now');
    expect(frame.lines[4]?.trimEnd()).toBe('orch  last seen 36m ago');
    expect(stylesOf(frame, 1, 0, 80)).toEqual(all(80, style({ bold: true })));
    expect(stylesOf(frame, 4, 0, 80)).toEqual(all(80, style({ bold: true, inverse: true })));
    expect(stylesOf(frame, 2, 0, 80)).toEqual(all(80, DEFAULT));
  });

  it('shows (no tickets) for a lane holding none and never for an actor with no event', () => {
    const m = model([
      E.create(T1, { title: 'one', task: TASK }, { actor: 'orch', wall: NOW - 120_000 }),
      E.assign(T1, 'ghost', { actor: 'orch', wall: NOW - 60_000 }),
    ]);
    const body = renderFrame(m, { ...START, view: 'lanes' }, SMALL, NOW)
      .lines.slice(1, 6)
      .map((l) => l.trimEnd());
    expect(body).toEqual([
      'orch  last seen 1m ago',
      '  (no tickets)',
      '',
      'ghost  last seen never',
      `  ${T1.slice(0, 10)} todo         one`,
    ]);
  });

  it('starts at the selected lane when its block would end below the body', () => {
    const inputs: FoldInput[] = [];
    for (let i = 0; i < 10; i += 1) {
      inputs.push(
        E.create(
          `01J${String(i)}0000000000000000000000`,
          { title: 'x', task: TASK },
          {
            actor: `actor${String(i)}`,
            wall: NOW - 100_000 + i,
          },
        ),
      );
    }
    const m = model(inputs);
    // Each lane: header, (no tickets), blank = 3 lines; lanes newest first.
    const fits = renderFrame(m, { ...START, view: 'lanes', lanes: 6 }, SMALL, NOW);
    expect(fits.lines[1]?.trimEnd()).toBe('actor9  last seen 1m ago');
    const scrolled = renderFrame(m, { ...START, view: 'lanes', lanes: 7 }, SMALL, NOW);
    expect(scrolled.lines[1]?.trimEnd()).toBe('actor2  last seen 1m ago');
    expect(styleAt(scrolled, 1, 0)).toEqual(style({ bold: true, inverse: true }));
  });

  it('keeps the top when the selected block ends exactly on the last body line', () => {
    const inputs: FoldInput[] = [];
    for (let i = 0; i < 10; i += 1) {
      inputs.push(
        E.create(
          `01J${String(i)}0000000000000000000000`,
          { title: 'x', task: TASK },
          {
            actor: `actor${String(i)}`,
            wall: NOW - 100_000 + i,
          },
        ),
      );
    }
    const m = model(inputs);
    // 80x22: H = 20; lane 6 spans lines 18 and 19, so it still fits.
    const size = { columns: 80, rows: 22 };
    const fits = renderFrame(m, { ...START, view: 'lanes', lanes: 6 }, size, NOW);
    expect(fits.lines[1]?.trimEnd()).toBe('actor9  last seen 1m ago');
    expect(fits.lines[19]?.trimEnd()).toBe('actor3  last seen 1m ago');
    const next = renderFrame(m, { ...START, view: 'lanes', lanes: 7 }, size, NOW);
    expect(next.lines[1]?.trimEnd()).toBe('actor2  last seen 1m ago');
  });

  it('says no agents when there is no lane', () => {
    expect(renderFrame(model([]), { ...START, view: 'lanes' }, SMALL, NOW).lines[1]).toBe(
      'no agents'.padEnd(80),
    );
  });
});

describe('detail layout', () => {
  it('styles the ticket line bold, system lines dim and the markers', () => {
    const frame = renderFrame(M, VIEWS.detail ?? START, LARGE, NOW);
    const row = (text: string): number => frame.lines.findIndex((l) => l.startsWith(text));
    expect(stylesOf(frame, 1, 0, 140)).toEqual(all(140, style({ bold: true })));
    const system = row('  impl claimed');
    expect(stylesOf(frame, system, 0, 140)).toEqual(all(140, style({ dim: true })));
    const retracted = row('[DECISION, retracted]');
    expect(stylesOf(frame, retracted, 0, 21)).toEqual(all(21, style({ dim: true })));
    expect(stylesOf(frame, retracted, 21, 140)).toEqual(all(119, DEFAULT));
    const retraction = row('[RETRACTED]');
    expect(stylesOf(frame, retraction, 0, 11)).toEqual(
      all(11, style({ bold: true, color: 'red' })),
    );
    expect(styleAt(frame, retraction, 11)).toEqual(DEFAULT);
    const decision = row('[DECISION] ');
    expect(stylesOf(frame, decision, 0, 10)).toEqual(
      all(10, style({ bold: true, color: 'green' })),
    );
    expect(styleAt(frame, decision, 10)).toEqual(DEFAULT);
    expect(stylesOf(frame, row('title: '), 0, 140)).toEqual(all(140, DEFAULT));
  });

  it('scrolls, and never past the last page', () => {
    const lines = detailLines(M, T1, 80);
    const at = (scroll: number): string[] =>
      renderFrame(M, { ...START, detail: { ticket: T1, scroll } }, SMALL, NOW).lines.slice(1, 23);
    expect(at(1)).toEqual(lines.slice(1, 23).map((l) => l.padEnd(80)));
    expect(at(2)).toEqual(lines.slice(2, 24).map((l) => l.padEnd(80)));
    expect(at(99)).toEqual(at(2));
  });

  it('pads with blank lines when the detail is shorter than the body', () => {
    const frame = renderFrame(M, { ...START, detail: { ticket: 'NOPE', scroll: 5 } }, SMALL, NOW);
    expect(frame.lines[1]).toBe('ticket NOPE not found'.padEnd(80));
    expect(frame.lines.slice(2, 23)).toEqual(Array.from({ length: 21 }, () => ' '.repeat(80)));
  });

  it('shows over every view', () => {
    const board = renderFrame(M, { ...START, detail: { ticket: T5, scroll: 0 } }, SMALL, NOW);
    const lanes = renderFrame(
      M,
      { ...START, view: 'lanes', detail: { ticket: T5, scroll: 0 } },
      SMALL,
      NOW,
    );
    expect(lanes.lines.slice(0, 23)).toEqual(board.lines.slice(0, 23));
    expect(board.lines[1]?.trimEnd()).toBe(`ticket ${T5}`);
  });
});

describe('style map', () => {
  it('is canonical: sorted, not overlapping, inside the line, maximal and never default', () => {
    const uis: UiState[] = [
      ...Object.values(VIEWS),
      { ...START, showClosed: true, notice: 'busy', board: { column: 3, row: 0 } },
      { ...START, help: true },
    ];
    for (const ui of uis) {
      for (const size of [SMALL, LARGE]) {
        const frame = renderFrame(M, ui, size, NOW);
        expectCanonical(frame, size.columns);
      }
    }
  });
});

describe('determinism', () => {
  it('equal inputs give deep-equal frames and no input is modified', () => {
    const m: BoardModel = fixtureModel();
    const copy = structuredClone(m);
    for (const ui of Object.values(VIEWS)) {
      const uiCopy = structuredClone(ui);
      const first = renderFrame(m, ui, LARGE, NOW);
      expect(renderFrame(copy, uiCopy, LARGE, NOW)).toEqual(first);
      expect(m).toEqual(copy);
      expect(ui).toEqual(uiCopy);
    }
  });
});
