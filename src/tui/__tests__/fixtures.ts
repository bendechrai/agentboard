/**
 * Fixture boards for the terminal UI tests. Built with the view-model test
 * helpers (events with explicit walls, folded with the store's own pure fold),
 * so they are exactly what a snapshot gives.
 */

import type { FoldInput } from '../../events/fold.js';
import type { BoardModel } from '../../view/types.js';
import type { UiState } from '../state.js';
import {
  E,
  OTHER,
  T1,
  T2,
  T3,
  T4,
  T5,
  T6,
  T7,
  TASK,
  TASK2,
  model,
} from '../../view/__tests__/helpers.js';

export { T1, T2, T3, T4, T5, T6, T7 };

/** The fixed `now` of every frame test: 2023-11-14T22:13:20Z. */
export const NOW = 1_700_000_000_000;

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Wall `ms` milliseconds before `NOW`. */
const ago = (ms: number): { wall: number } => ({ wall: NOW - ms });

/**
 * The main fixture board:
 * - todo: T3 (ad hoc, unassigned), T4 (non-ASCII title, assigned to orch)
 * - tests: T2 (long title, claimed by test-author)
 * - implementing: T1 (checklist, labels, a PR link, a retracted decision,
 *   a retraction and an open decision, claimed by impl)
 * - review: T5 (handed off to rev 2 seconds before NOW, so it is changed)
 * - blocked: T6 (from implementing)
 * - merged: T7 (closed with a decision; hidden unless closed are shown)
 * plus a `board.meta`, a rejected claim, and T5's comment marked late.
 */
export function fixtureInputs(): FoldInput[] {
  return [
    E.meta('project', 'agentboard', { actor: 'orch', ...ago(30 * HOUR) }),
    E.create(
      T1,
      {
        title: 'Decode raw key bytes',
        task: TASK,
        labels: ['tui', 'keys'],
        checklist: ['CSI', 'SS3'],
      },
      { actor: 'orch', ...ago(26 * HOUR) },
    ),
    E.create(
      T2,
      { title: 'Render the board frame with six equal columns and a feed pane', task: TASK2 },
      { actor: 'orch', ...ago(26 * HOUR - 1000) },
    ),
    E.create(
      T3,
      { title: 'Write the README section', adhoc: 'docs' },
      { actor: 'orch', ...ago(25 * HOUR) },
    ),
    E.create(
      T4,
      { title: 'Caf\u00e9 \u00fcber keys', task: OTHER },
      { actor: 'orch', ...ago(25 * HOUR - 1000) },
    ),
    E.create(T5, { title: 'Review the frames', task: TASK }, { actor: 'orch', ...ago(24 * HOUR) }),
    E.create(
      T6,
      { title: 'Wait for the feed', task: TASK2 },
      { actor: 'orch', ...ago(24 * HOUR - 1000) },
    ),
    E.create(
      T7,
      { title: 'Pick the TUI approach', task: OTHER },
      { actor: 'orch', ...ago(23 * HOUR) },
    ),
    E.assign(T4, 'orch', { actor: 'orch', ...ago(22 * HOUR) }),
    E.claim(T1, { actor: 'impl', ...ago(5 * HOUR) }),
    E.claim(T1, { actor: 'intruder', ...ago(5 * HOUR - 1000) }),
    E.move(T1, 'tests', { actor: 'impl', ...ago(5 * HOUR - 2000) }),
    E.move(T1, 'implementing', { actor: 'impl', ...ago(4 * HOUR) }),
    E.comment(T1, 'DECISION: use readline for keys', { actor: 'impl', ...ago(3 * HOUR) }),
    E.comment(T1, 'RETRACTED: readline cannot see raw bytes', { actor: 'impl', ...ago(2 * HOUR) }),
    E.comment(T1, 'DECISION: decode raw bytes with a pending buffer', {
      actor: 'impl',
      ...ago(90 * MIN),
    }),
    E.check(T1, 0, true, { actor: 'impl', ...ago(80 * MIN) }),
    E.link(T1, { pr: 42 }, { actor: 'impl', ...ago(70 * MIN) }),
    E.claim(T2, { actor: 'test-author', ...ago(60 * MIN) }),
    E.move(T2, 'tests', { actor: 'test-author', ...ago(59 * MIN) }),
    E.move(T6, 'tests', { actor: 'orch', ...ago(50 * MIN) }),
    E.move(T6, 'implementing', { actor: 'orch', ...ago(49 * MIN) }),
    E.move(T6, 'blocked', { actor: 'orch', ...ago(48 * MIN) }),
    E.move(T7, 'tests', { actor: 'orch', ...ago(40 * MIN) }),
    E.move(T7, 'implementing', { actor: 'orch', ...ago(39 * MIN) }),
    E.move(T7, 'review', { actor: 'orch', ...ago(38 * MIN) }),
    E.move(T7, 'merged', { actor: 'orch', ...ago(37 * MIN) }),
    E.close(T7, { decision: 'docs/adr/0008-tui.md' }, { actor: 'orch', ...ago(36 * MIN) }),
    E.move(T5, 'tests', { actor: 'impl', ...ago(20 * MIN) }),
    E.move(T5, 'implementing', { actor: 'impl', ...ago(19 * MIN) }),
    E.comment(T5, 'frames look right', { actor: 'impl', ...ago(10 * MIN) }),
    E.handoff(T5, 'rev', 'review', 'please review the goldens', { actor: 'impl', ...ago(2000) }),
  ];
}

/** The main fixture model, with T5's comment (`frames look right`) marked late. */
export function fixtureModel(): BoardModel {
  const inputs = fixtureInputs();
  const late = inputs.find(
    (i) => i.event.kind === 'ticket.comment' && 'ticket' in i.event && i.event.ticket === T5,
  );
  return model(inputs, late === undefined ? [] : [late.hash]);
}

/** The board directory shown in the fixture frames. */
export const BOARD_DIR = '/work/agentboard/.board';

/**
 * `initialUi(BOARD_DIR)` as a literal, so that test files can build UI
 * states without calling the function under test at load time (state.test.ts
 * checks that `initialUi` returns exactly this).
 */
export const START_UI: UiState = {
  boardDir: BOARD_DIR,
  view: 'board',
  board: { column: 0, row: 0, ticket: null },
  feed: { index: 0, hash: null },
  lanes: { index: 0, actor: null },
  detail: null,
  showClosed: false,
  help: false,
  notice: null,
  quit: false,
};
