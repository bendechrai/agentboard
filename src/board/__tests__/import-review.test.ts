/**
 * Re-import follow-ups from the group 8 review (add-claim-leases task 8.4;
 * board-cli: "Removed checklist lines are inactive", scenario "Reminder
 * after a removal"; board-openspec-integration: "Reconcile on re-import",
 * scenario "Concurrent import leaves nothing stale", the forced and
 * closed-ticket rules).
 *
 * The stale tests plan an import on a board whose cache is behind its
 * events directory: another board (a copy of the events) imports the same
 * revision, and its new event files are copied in after this board was
 * opened, as a concurrent import or a sync leaves them. Every planned event
 * is then stale, and the import must write nothing.
 */

import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openBoard, type Board } from '../../store/board.js';
import { foldDir } from '../../store/__tests__/helpers.js';
import { closeTicket, setChecklistItem } from '../actions.js';
import { importChange, type ImportResult } from '../import.js';
import { eventCount, makeBoardDir, setup, tempDir } from './helpers.js';

const CHANGE = 'add-x';
const PATH = `openspec/changes/${CHANGE}/tasks.md`;
const TARGET = { source: 'openspec', ref: CHANGE };
const SLOW = { timeout: 30_000 };

function writeTasks(root: string, text: string): void {
  mkdirSync(join(root, 'openspec', 'changes', CHANGE), { recursive: true });
  writeFileSync(join(root, PATH), text);
}

function run(board: Board, options?: { dryRun?: boolean; force?: boolean }): ImportResult {
  return importChange(board, 'orch', TARGET, options);
}

function idOf(result: ImportResult, item: string): string {
  return result.tickets.find((t) => t.item === item)?.id ?? '';
}

describe('the tick reminder after a removal', SLOW, () => {
  it('scenario: names the line of 1.2 Beta, not of 1.3 Gamma', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. G\n- [ ] 1.1 Alpha\n- [ ] 1.2 Beta\n- [ ] 1.3 Gamma\n');
    const id = idOf(run(board), '1');
    writeTasks(root, '## 1. G\n- [ ] 1.2 Beta\n- [ ] 1.3 Gamma\n');
    run(board);
    const outcome = setChecklistItem(board, 'impl', { id, index: 1, done: true });
    expect(outcome.ticket.checklist[1]).toEqual({ text: '1.2 Beta', done: true });
    expect(outcome.reminder).toMatchObject({ path: PATH, line: 2 });
    expect(outcome.reminder?.message).toContain(`${PATH}:2 `);
  });

  it('counts only active lines for a line appended after a removal', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. G\n- [ ] 1.1 Alpha\n- [ ] 1.2 Beta\n');
    const id = idOf(run(board), '1');
    writeTasks(root, '## 1. G\n- [ ] 1.2 Beta\n- [ ] 1.3 Gamma\n');
    run(board);
    // Checklist: Alpha (removed), Beta, Gamma (appended at index 2).
    const outcome = setChecklistItem(board, 'impl', { id, index: 2, done: true });
    expect(outcome.ticket.checklist[2]?.text).toBe('1.3 Gamma');
    expect(outcome.reminder?.line).toBe(3);
  });

  it('is unchanged for a ticket with no removed line', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. G\n- [ ] 1.1 Alpha\n- [ ] 1.2 Beta\n');
    const id = idOf(run(board), '1');
    expect(setChecklistItem(board, 'impl', { id, index: 1, done: true }).reminder?.line).toBe(3);
  });
});

/** The tasks files of each stale scenario: before, and the revision both imports apply. */
const STALE: [string, string, string][] = [
  [
    'renumber (groups swapped)',
    '## 1. One\n- [ ] a\n## 2. Two\n- [ ] b\n',
    '## 1. Two\n- [ ] b\n## 2. One\n- [ ] a\n',
  ],
  ['supersede (group deleted)', '## 1. One\n- [ ] a\n## 2. Two\n- [ ] b\n', '## 1. One\n- [ ] a\n'],
  ['create (group added)', '## 1. One\n- [ ] a\n', '## 1. One\n- [ ] a\n## 2. Two\n- [ ] b\n'],
  ['reconcile (line added)', '## 1. One\n- [ ] a\n', '## 1. One\n- [ ] a\n- [ ] c\n'],
];

/**
 * A board with `before` imported and opened, whose events directory then
 * receives the events another board wrote importing `after` (its cache
 * does not know them yet), with `after` as its tasks file.
 */
function stale(before: string, after: string): { board: Board; copied: number } {
  const { board, root } = setup();
  writeTasks(root, before);
  run(board);
  const other = tempDir();
  const otherBoard = makeBoardDir(other);
  cpSync(board.eventsDir, join(otherBoard, 'events'), { recursive: true });
  writeTasks(other, after);
  const known = new Set(readdirSync(board.eventsDir));
  const second = openBoard(otherBoard);
  try {
    expect(importChange(second, 'orch', TARGET).events).toBeGreaterThan(0);
  } finally {
    second.close();
  }
  const fresh = readdirSync(join(otherBoard, 'events')).filter(
    (name) => !known.has(name) && name.endsWith('.json'),
  );
  for (const name of fresh) {
    cpSync(join(otherBoard, 'events', name), join(board.eventsDir, name));
  }
  writeTasks(root, after);
  return { board, copied: fresh.length };
}

describe('scenario: a concurrent import leaves nothing stale', SLOW, () => {
  it.each(STALE)('skips a stale %s: no event written, none rejected', (_name, before, after) => {
    const { board } = stale(before, after);
    const files = readdirSync(board.eventsDir).sort();
    const result = run(board);
    expect(result.events).toBe(0);
    expect(result.tickets.flatMap((t) => t.events)).toEqual([]);
    expect(readdirSync(board.eventsDir).sort()).toEqual(files);
    expect(foldDir(board.eventsDir).rejected).toEqual([]);
    expect(run(board).events).toBe(0);
  });

  it.each(STALE)(
    'commits the catch-up of a stale %s skip (refused stale-import, not rolled back)',
    (_name, before, after) => {
      const { board } = stale(before, after);
      run(board);
      const folded = board.db.prepare('SELECT COUNT(*) AS n FROM folded').get() as { n: number };
      expect(folded.n).toBe(eventCount(board));
    },
  );
});

describe('forced and blocked boundaries', SLOW, () => {
  it('--dry-run --force on an unblocked ticket reports forced false', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n- [ ] 1.2 b\n');
    run(board);
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n');
    const result = run(board, { dryRun: true, force: true });
    expect(result.tickets[0]).toMatchObject({ action: 'updated', forced: false, blocked: [] });
  });

  it('a closed ticket never reports blocked, even with a done line removed', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. One\n- [x] 1.1 a\n- [x] 1.2 b\n');
    const id = idOf(run(board), '1');
    closeTicket(board, 'orch', { id, noDecision: true });
    const before = eventCount(board);
    writeTasks(root, '## 1. One\n- [x] 1.1 a\n');
    for (const options of [{}, { dryRun: true }, { force: true }]) {
      const result = run(board, options);
      expect(result.tickets[0]).toMatchObject({
        action: 'unchanged',
        blocked: [],
        forced: false,
        diff: { removed: [1] },
      });
    }
    expect(eventCount(board)).toBe(before);
  });
});
