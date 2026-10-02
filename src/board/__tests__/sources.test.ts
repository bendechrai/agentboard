/**
 * A ticket whose source has no adapter is fully usable
 * (board-openspec-integration: "Task sources are adapters", scenario
 * "Ticket from a source with no adapter"), and only `import-change` needs
 * an adapter.
 *
 * Already pinned elsewhere and not repeated here:
 * - "Ticket without a task is refused": tickets.test.ts
 *   (`needs-task-or-adhoc`) and cli/__tests__/parse.test.ts.
 * - "Ad hoc ticket cannot reach implementing": actions.test.ts and
 *   store/__tests__/transaction.test.ts (`needs-task-link`), and the fold
 *   rule in events/__tests__/fold.test.ts.
 * - The tick reminder text for a source without an adapter:
 *   reminder.test.ts and actions.test.ts.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  claimTicket,
  closeTicket,
  commentTicket,
  handoffTicket,
  moveTicket,
  setChecklistItem,
} from '../actions.js';
import { importChange } from '../import.js';
import { listTickets, newTicket, showTicket } from '../tickets.js';
import { eventCount, expectBoardError, setup } from './helpers.js';

const SPECKIT = { source: 'speckit', ref: '001-photo-albums', item: 'phase-2' };

describe('a ticket from a source with no adapter', () => {
  it('is created, listed, claimed, moved through every status, ticked and closed', () => {
    const { board, root } = setup();
    // A Spec Kit-looking tasks file must not matter: there is no adapter.
    mkdirSync(join(root, 'specs', '001-photo-albums'), { recursive: true });
    writeFileSync(join(root, 'specs', '001-photo-albums', 'tasks.md'), '- [ ] T001 x\n');
    const t = newTicket(board, 'orch', {
      title: 'Albums phase 2',
      task: SPECKIT,
      checklist: ['T001 x', 'T002 y'],
    }).ticket;
    expect(t.task).toEqual(SPECKIT);
    expect(listTickets(board, { task: { source: 'speckit', ref: '001-photo-albums' } })).toEqual([
      t,
    ]);
    claimTicket(board, 'tester', { id: t.id });
    moveTicket(board, 'tester', { id: t.id, to: 'tests' });
    handoffTicket(board, 'tester', {
      id: t.id,
      to: 'impl',
      status: 'implementing',
      note: 'tests written',
    });
    const ticked = setChecklistItem(board, 'impl', { id: t.id, index: 1, done: true });
    expect(ticked.ticket.checklist.map((c) => c.done)).toEqual([false, true]);
    expect(ticked.reminder).toEqual({
      source: 'speckit',
      path: null,
      line: null,
      message: 'no tasks-file reminder is available for source speckit',
    });
    moveTicket(board, 'impl', { id: t.id, to: 'review' });
    moveTicket(board, 'reviewer', { id: t.id, to: 'merged' });
    commentTicket(board, 'reviewer', { id: t.id, text: 'approved' });
    const closed = closeTicket(board, 'orch', { id: t.id, noDecision: true }).ticket;
    expect(closed).toMatchObject({ status: 'merged', closed: true, assignee: 'impl' });
    expect(showTicket(board, t.id).ticket.version).toBe(9);
  });

  it('cannot be imported: import-change names the unsupported source', () => {
    const { board } = setup();
    const err = expectBoardError(
      () => importChange(board, 'orch', { source: 'speckit', ref: '001-photo-albums' }),
      1,
      'unsupported-source',
    );
    expect(err.message).toContain('speckit');
    expect(eventCount(board)).toBe(0);
  });
});

describe('the board depends on OpenSpec only through its adapter', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  /** Every non-test TypeScript source under src, relative to src. */
  function sources(dir = SRC, prefix = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') {
          found.push(...sources(join(dir, entry.name), rel));
        }
      } else if (entry.name.endsWith('.ts')) {
        found.push(rel);
      }
    }
    return found;
  }

  it('names the OpenSpec tasks file layout in src/board/openspec.ts only', () => {
    const offenders = sources().filter(
      (rel) =>
        rel !== 'board/openspec.ts' &&
        /openspec\/changes|'changes'/.test(
          readFileSync(join(SRC, rel), 'utf8').replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
