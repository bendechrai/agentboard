import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import { setChecklistItem } from '../actions.js';
import { taskReminder } from '../reminder.js';
import { create, setup, tempDir } from './helpers.js';

/** The OpenSpec task file layout, with two groups (line numbers noted). */
const TASKS_MD = [
  '# Tasks', //                                    1
  '', //                                           2
  '## 1. Events', //                               3
  '', //                                           4
  '- [x] 1.1 Implement canonical', //              5
  '- [x] 1.2 Implement ulid', //                   6
  '', //                                           7
  '## 3. CLI core commands', //                    8
  '', //                                           9
  '- [ ] 3.1 Implement the registry', //          10
  '  continuation of 3.1', //                     11
  '- [X] 3.2 Implement init', //                  12
  '- [ ] 3.3 Implement claim', //                 13
  '', //                                          14
  '## 4. Concurrency', //                         15
  '- [ ] 4.1 Harness', //                         16
  '',
].join('\n');

const PATH = 'openspec/changes/add-board-core/tasks.md';

function hostWithTasks(): string {
  const root = tempDir();
  mkdirSync(join(root, 'openspec', 'changes', 'add-board-core'), { recursive: true });
  writeFileSync(join(root, PATH), TASKS_MD);
  return root;
}

function ticket(task: Ticket['task'], adhoc: string | null = null): Ticket {
  return { task, adhoc } as Ticket;
}

const G3 = { source: 'openspec', ref: 'add-board-core', item: '3' };

describe('taskReminder for openspec', () => {
  it.each([
    [0, 10],
    [1, 12],
    [2, 13],
  ])('maps checklist index %i of group 3 to line %i', (index, line) => {
    const r = taskReminder(hostWithTasks(), ticket(G3), index);
    expect(r).toMatchObject({ source: 'openspec', path: PATH, line });
    expect(r.message).toContain(`${PATH}:${String(line)}`);
    expect(r.message).toContain('tasks.md');
    expect(r.message).toMatch(/PR/);
  });

  it('does not run into the next group', () => {
    expect(taskReminder(hostWithTasks(), ticket(G3), 3).line).toBeNull();
    const g1 = { ...G3, item: '1' };
    expect(taskReminder(hostWithTasks(), ticket(g1), 1).line).toBe(6);
  });

  it('gives the path without a line when the file is missing', () => {
    const r = taskReminder(tempDir(), ticket(G3), 0);
    expect(r).toMatchObject({ source: 'openspec', path: PATH, line: null });
    expect(r.message).toContain(PATH);
    expect(r.message).not.toContain(`${PATH}:`);
  });

  it('gives no line for a group that is not in the file', () => {
    const r = taskReminder(hostWithTasks(), ticket({ ...G3, item: '9' }), 0);
    expect(r).toMatchObject({ path: PATH, line: null });
  });
});

describe('taskReminder for other tickets', () => {
  it('states no reminder is available for a source without an adapter', () => {
    const r = taskReminder(
      hostWithTasks(),
      ticket({ source: 'speckit', ref: '001-photo-albums', item: 'phase-2' }),
      0,
    );
    expect(r).toMatchObject({ source: 'speckit', path: null, line: null });
    expect(r.message).toContain('no tasks-file reminder is available for source speckit');
  });

  it('gives no reminder, and does not throw, for an openspec ref that is not one path segment', () => {
    const r = taskReminder(
      hostWithTasks(),
      ticket({ source: 'openspec', ref: 'a/b', item: '1' }),
      0,
    );
    expect(r).toEqual({
      source: 'openspec',
      path: null,
      line: null,
      message:
        'no tasks-file reminder is available: a/b does not name a tasks file of source openspec',
    });
  });

  it('says an ad hoc ticket has no task reference', () => {
    const r = taskReminder(hostWithTasks(), ticket(null, 'hotfix'), 0);
    expect(r).toMatchObject({ source: null, path: null, line: null });
    expect(r.message).toMatch(/no task reference/);
  });
});

describe('checklist tick reminder (scenario: tick reminds about tasks.md)', () => {
  it('ticks a ticket whose openspec ref has several segments, with no reminder', () => {
    const { board } = setup();
    const t = create(board, {
      task: { source: 'openspec', ref: 'a/b', item: '1' },
      checklist: ['x', 'y'],
    });
    const out = setChecklistItem(board, 'impl', { id: t.id, index: 1, done: true });
    expect(out.ticket.checklist.map((c) => c.done)).toEqual([false, true]);
    expect(out.hash).not.toBeNull();
    expect(out.reminder).toMatchObject({ source: 'openspec', path: null, line: null });
    expect(out.reminder?.message).toContain('no tasks-file reminder is available');
  });

  it("uses the board's parent as the host project root", () => {
    const { board, root } = setup();
    mkdirSync(join(root, 'openspec', 'changes', 'add-board-core'), { recursive: true });
    writeFileSync(join(root, PATH), TASKS_MD);
    const t = create(board, { task: G3, checklist: ['3.1', '3.2', '3.3'] });
    const out = setChecklistItem(board, 'impl', { id: t.id, index: 2, done: true });
    expect(out.ticket.checklist[2]?.done).toBe(true);
    expect(out.reminder).toMatchObject({ path: PATH, line: 13 });
  });
});
