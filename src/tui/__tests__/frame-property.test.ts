/**
 * Scenario "Frame dimensions" (board-tui: "Frame rendering"): for seeded
 * random boards, UI states and sizes from 60x15 to 200x60 (and below the
 * minimum), every frame has exactly the terminal's rows, each line of
 * exactly its columns, all printable ASCII, with a canonical style map;
 * and rendering is deterministic.
 */

import { describe, expect, it } from 'vitest';

import type { FoldInput } from '../../events/fold.js';
import type { Status } from '../../events/schema.js';
import { E, OTHER, TASK, model } from '../../view/__tests__/helpers.js';
import type { BoardModel } from '../../view/types.js';
import { renderFrame, type Size } from '../frame.js';
import { VIEWS, type UiState } from '../state.js';
import { START_UI } from './fixtures.js';
import { expectCanonical } from './frame-helpers.js';

/** Mulberry32: a small seeded PRNG, so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1_700_000_000_000;
const STATUSES: Status[] = ['todo', 'tests', 'implementing', 'review', 'merged', 'blocked'];
const ACTORS = ['a', 'impl', 'test-author-with-a-long-name', 'r\u00e9viseur', 'x\\y'];
const WORDS = [
  'frame',
  'caf\u00e9',
  '\u65e5\u672c',
  '\ud83d\ude00',
  'tab\there',
  'line\nbreak',
  'back\\slash',
  'DECISION:',
  'RETRACTED:',
  '~',
  '',
  'a'.repeat(90),
  '\u0000\u001b[31m',
];

function randomModel(seed: number): BoardModel {
  const rand = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const text = (): string => {
    const n = 1 + Math.floor(rand() * 5);
    return Array.from({ length: n }, () => pick(WORDS)).join(' ');
  };
  const count = Math.floor(rand() * 40);
  const ids: string[] = [];
  const inputs: FoldInput[] = [];
  let wall = NOW - Math.floor(rand() * 5 * 86_400_000);
  const next = (): { actor: string; wall: number } => {
    wall += Math.floor(rand() * 3_600_000);
    return { actor: pick(ACTORS), wall: Math.min(wall, NOW + 10_000) };
  };
  for (let i = 0; i < count; i += 1) {
    const id = `01K${String(i).padStart(3, '0')}${'0'.repeat(20)}`;
    ids.push(id);
    inputs.push(
      E.create(
        id,
        {
          title: text() || 't',
          task: rand() < 0.5 ? TASK : OTHER,
          labels: rand() < 0.3 ? [pick(WORDS) || 'l'] : [],
          checklist: rand() < 0.3 ? [text() || 'c', text() || 'd'] : [],
        },
        next(),
      ),
    );
  }
  const events = ids.length === 0 ? 0 : Math.floor(rand() * 120);
  for (let i = 0; i < events; i += 1) {
    const id = pick(ids);
    const roll = rand();
    if (roll < 0.25) {
      inputs.push(E.move(id, pick(STATUSES), next()));
    } else if (roll < 0.4) {
      inputs.push(E.claim(id, next()));
    } else if (roll < 0.55) {
      inputs.push(E.comment(id, `${pick(['DECISION: ', 'RETRACTED: ', ''])}${text()}`, next()));
    } else if (roll < 0.65) {
      inputs.push(E.handoff(id, pick(ACTORS), pick(STATUSES), text(), next()));
    } else if (roll < 0.72) {
      inputs.push(E.close(id, rand() < 0.5 ? { noDecision: true } : { decision: text() }, next()));
    } else if (roll < 0.8) {
      inputs.push(
        E.link(id, rand() < 0.5 ? { pr: Math.floor(rand() * 999) } : { decision: text() }, next()),
      );
    } else if (roll < 0.86) {
      inputs.push(E.check(id, Math.floor(rand() * 3), rand() < 0.5, next()));
    } else if (roll < 0.92) {
      inputs.push(E.assign(id, pick(ACTORS), next()));
    } else if (roll < 0.96) {
      inputs.push(E.meta(text() || 'k', 1, next()));
    } else {
      inputs.push(E.unknown(id, next()));
    }
  }
  const m = model(inputs);
  const late = m.events.filter(() => rand() < 0.1).map((e) => e.hash);
  return { ...m, late };
}

function randomUi(rand: () => number, m: BoardModel): UiState {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const tickets = Object.keys(m.tickets);
  const detail =
    rand() < 0.3
      ? {
          ticket: tickets.length > 0 && rand() < 0.9 ? pick(tickets) : 'MISSING',
          scroll: Math.floor(rand() * 60),
        }
      : null;
  return {
    ...START_UI,
    boardDir: pick(['/b', '/work/a very long directory name/'.repeat(8), '/tmp/caf\u00e9']),
    view: pick(VIEWS),
    board: { column: Math.floor(rand() * 6), row: Math.floor(rand() * 50) },
    feed: Math.floor(rand() * 200),
    lanes: Math.floor(rand() * 8),
    detail,
    showClosed: rand() < 0.5,
    help: rand() < 0.1,
    notice: rand() < 0.2 ? pick(['busy', 'b\u00fcsy', 'x'.repeat(300)]) : null,
  };
}

function expectDimensions(frame: { lines: string[] }, size: Size): void {
  expect(frame.lines).toHaveLength(size.rows);
  for (const line of frame.lines) {
    expect(line).toHaveLength(size.columns);
    expect(line).toMatch(/^[\x20-\x7e]*$/);
  }
}

describe('scenario "Frame dimensions"', () => {
  it('every frame is exactly rows lines of exactly columns printable ASCII characters (60x15 to 200x60)', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const m = randomModel(seed);
      const rand = prng(seed * 7919);
      for (let i = 0; i < 8; i += 1) {
        const size = {
          columns: 60 + Math.floor(rand() * 141),
          rows: 15 + Math.floor(rand() * 46),
        };
        const ui = randomUi(rand, m);
        const frame = renderFrame(m, ui, size, NOW + Math.floor(rand() * 100_000));
        expectDimensions(frame, size);
        expectCanonical(frame, size.columns);
      }
    }
  });

  it('holds at the exact bounds and around the feed pane threshold', () => {
    const m = randomModel(4242);
    const rand = prng(99);
    for (const size of [
      { columns: 60, rows: 15 },
      { columns: 200, rows: 60 },
      { columns: 139, rows: 15 },
      { columns: 140, rows: 15 },
      { columns: 141, rows: 60 },
    ]) {
      for (let i = 0; i < 20; i += 1) {
        const frame = renderFrame(m, randomUi(rand, m), size, NOW);
        expectDimensions(frame, size);
        expectCanonical(frame, size.columns);
      }
    }
  });

  it('holds below the minimum size too', () => {
    const m = randomModel(7);
    const rand = prng(3);
    for (let i = 0; i < 100; i += 1) {
      const size = { columns: Math.floor(rand() * 70), rows: Math.floor(rand() * 20) };
      if (size.columns >= 60 && size.rows >= 15) {
        continue;
      }
      const frame = renderFrame(m, randomUi(rand, m), size, NOW);
      expectDimensions(frame, size);
      expect(frame.styles.every((runs) => runs.length === 0)).toBe(true);
    }
  });

  it('is deterministic and leaves its inputs unchanged', () => {
    for (let seed = 100; seed < 110; seed += 1) {
      const m = randomModel(seed);
      const rand = prng(seed);
      const ui = randomUi(rand, m);
      const size = { columns: 60 + Math.floor(rand() * 141), rows: 15 + Math.floor(rand() * 46) };
      const mCopy = structuredClone(m);
      const uiCopy = structuredClone(ui);
      const first = renderFrame(m, ui, size, NOW);
      expect(renderFrame(mCopy, uiCopy, { ...size }, NOW)).toEqual(first);
      expect(m).toEqual(mCopy);
      expect(ui).toEqual(uiCopy);
    }
  });
});
