/**
 * Task 7.1: `importChange` against a fixture tasks file shaped like this
 * repository's own `openspec/changes/add-board-core/tasks.md`
 * (board-openspec-integration: "Import a change"; board-concurrency:
 * "Re-import is idempotent"; board-events: tickets are created in `todo`
 * and an import writes the permitted moves).
 *
 * The fixture (`fixtures/add-board-core-tasks.md`) has nine groups: 1 to 3
 * fully ticked, 4 with only 4.1 ticked, 5 with only 5.1 ticked (as `[X]`),
 * 6 with an indented continuation line after 6.1, 7 to 9 unticked.
 * Expected values below are written out by hand from the file, not
 * computed with the parser under test.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import type { Board } from '../../store/board.js';
import { closeTicket } from '../actions.js';
import { importChange, parseImportTarget, type ImportResult } from '../import.js';
import { listTickets, newTicket, showRaw } from '../tickets.js';
import { SAMPLES, eventCount, expectBoardError, setup } from './helpers.js';

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'add-board-core-tasks.md'),
  'utf8',
);
const FIXTURE_LINES = FIXTURE.split('\n');

const CHANGE = 'add-board-core';
const PATH = `openspec/changes/${CHANGE}/tasks.md`;
const TARGET = { source: 'openspec', ref: CHANGE };

const TITLES = [
  'Events, canonical JSON and fold (pure, no IO)',
  'Store: discovery, atomic writes, cache, rebuild',
  'CLI core commands',
  'Concurrency and crash properties',
  'Inbox and watch',
  'Sync',
  'OpenSpec integration',
  'Documentation and consumer setup',
  'MCP server',
];

/** 1-based fixture line numbers of each group's task lines. */
const TASK_LINES: number[][] = [
  [13, 14, 15, 16, 17],
  [21, 22, 23, 24, 25],
  [29, 30, 31, 32, 33, 34],
  [38, 39, 40, 41, 42],
  [46, 47],
  [51, 53],
  [57, 58, 59],
  [63, 64, 65],
  [69, 70, 71],
];

/** Done flags per group, as ticked in the fixture. */
const DONE: boolean[][] = [
  [true, true, true, true, true],
  [true, true, true, true, true],
  [true, true, true, true, true, true],
  [true, false, false, false, false],
  [true, false],
  [false, false],
  [false, false, false],
  [false, false, false],
  [false, false, false],
];

/** Events written per group on a first import: create, one per tick, four moves if fully ticked. */
const EVENTS_PER_GROUP = [10, 10, 11, 2, 2, 1, 1, 1, 1];
const TOTAL_EVENTS = 39;

/** The checklist text of a fixture line: the line after `- [ ] `. */
function taskText(line: number): string {
  return (FIXTURE_LINES[line - 1] ?? '').slice('- [ ] '.length).trimEnd();
}

function writeTasks(root: string, text: string, change = CHANGE): void {
  mkdirSync(join(root, 'openspec', 'changes', change), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', change, 'tasks.md'), text);
}

function imported(): { board: Board; root: string; first: ImportResult } {
  const { board, root } = setup();
  writeTasks(root, FIXTURE);
  const first = importChange(board, 'orch', TARGET);
  return { board, root, first };
}

function byItem(result: ImportResult, item: string): Ticket {
  const found = result.tickets.find((t) => t.item === item);
  if (found === undefined) {
    throw new Error(`no ticket for item ${item}`);
  }
  return found.ticket;
}

describe('parseImportTarget', () => {
  it('reads a plain name as an OpenSpec change', () => {
    expect(parseImportTarget('add-board-core')).toEqual({ source: 'openspec', ref: CHANGE });
  });

  it('reads <source>:<ref> as another source', () => {
    expect(parseImportTarget('speckit:001-photo-albums')).toEqual({
      source: 'speckit',
      ref: '001-photo-albums',
    });
    expect(parseImportTarget('openspec:add-board-core')).toEqual(TARGET);
  });

  it.each(['Open Spec:x', '1abc:x', ':x'])('refuses the malformed source in %j', (text) => {
    expectBoardError(() => parseImportTarget(text), 1, 'malformed-task-ref');
  });

  it('refuses an item, since an import names a whole ref', () => {
    expectBoardError(() => parseImportTarget('openspec:add-board-core#3'), 1, 'malformed-task-ref');
    expectBoardError(() => parseImportTarget('add-board-core#3'), 1, 'malformed-task-ref');
  });

  it.each(['', 'speckit:'])('refuses the empty name or ref %j', (text) => {
    expectBoardError(() => parseImportTarget(text), 1, 'usage');
  });
});

describe('import-change: first import (scenario: one ticket per group)', () => {
  it('creates nine tickets with titles, task references, labels and checklists', () => {
    const { board, first } = imported();
    expect(first).toMatchObject({ source: 'openspec', ref: CHANGE, tasksFile: PATH });
    expect(first.tickets.map((t) => t.item)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(listTickets(board)).toHaveLength(9);
    first.tickets.forEach((entry, i) => {
      const n = String(i + 1);
      const t = entry.ticket;
      expect(entry.action).toBe('created');
      expect(entry.appended).toBe(0);
      expect(entry.id).toBe(t.id);
      expect(t.title).toBe(TITLES[i]);
      expect(t.task).toEqual({ source: 'openspec', ref: CHANGE, item: n });
      expect(t.adhoc).toBeNull();
      expect(t.labels).toEqual([`change:${CHANGE}`, `group:${n}`]);
      expect(t.description).toBeNull();
      expect(t.assignee).toBeNull();
      expect(t.createdBy).toBe('orch');
      expect(t.checklist).toEqual(
        (TASK_LINES[i] ?? []).map((line, j) => ({ text: taskText(line), done: DONE[i]?.[j] })),
      );
    });
  });

  it('keeps the task number in each checklist line and skips continuation lines', () => {
    const { first } = imported();
    expect(byItem(first, '5').checklist.map((c) => c.text)).toEqual([taskText(46), taskText(47)]);
    expect(taskText(46)).toMatch(/^5\.1 Implement cursors/);
    const sync = byItem(first, '6').checklist.map((c) => c.text);
    expect(sync).toHaveLength(2);
    expect(sync[0]).toMatch(/^6\.1 Implement `sync`/);
    expect(sync[1]).toMatch(/^6\.2 Verify/);
    expect(sync.join('\n')).not.toContain('continuation');
  });

  it('imports fully ticked groups as merged and the rest as todo (scenario: fully ticked)', () => {
    const { first } = imported();
    expect(first.tickets.map((t) => t.ticket.status)).toEqual([
      'merged',
      'merged',
      'merged',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
  });

  it('reaches merged through the permitted moves, after creating in todo', () => {
    const { board, first } = imported();
    const raw = showRaw(board, byItem(first, '1').id);
    const kinds = raw.map((r) => (r.event as { kind: string }).kind);
    expect(kinds[0]).toBe('ticket.create');
    expect(kinds.filter((k) => k === 'ticket.checklist')).toHaveLength(5);
    const moves = raw
      .map((r) => r.event as { kind: string; body: { to?: string } })
      .filter((e) => e.kind === 'ticket.move')
      .map((e) => e.body.to);
    expect(moves).toEqual(['tests', 'implementing', 'review', 'merged']);
    expect(raw).toHaveLength(10);
    for (const r of raw) {
      expect((r.event as { actor: string }).actor).toBe('orch');
    }
  });

  it('copies done flags of a partly ticked group with ticks, without moving it', () => {
    const { board, first } = imported();
    const raw = showRaw(board, byItem(first, '4').id).map(
      (r) => r.event as { kind: string; body: Record<string, unknown> },
    );
    expect(raw.map((e) => e.kind)).toEqual(['ticket.create', 'ticket.checklist']);
    expect(raw[1]?.body).toEqual({ index: 0, done: true });
  });

  it('writes one create per group plus its ticks and moves, and reports them', () => {
    const { board, first } = imported();
    expect(first.tickets.map((t) => t.events.length)).toEqual(EVENTS_PER_GROUP);
    expect(first.events).toBe(TOTAL_EVENTS);
    expect(eventCount(board)).toBe(TOTAL_EVENTS);
    for (const entry of first.tickets) {
      expect(new Set(entry.events).size).toBe(entry.events.length);
      expect(entry.ticket.version).toBe(entry.events.length);
    }
  });

  it('creates a group with no task lines in todo with an empty checklist', () => {
    const { board, root } = setup();
    writeTasks(root, '# Tasks\n\n## 1. Nothing yet\n\nprose\n\n## 2. One\n\n- [x] 2.1 done\n');
    const out = importChange(board, 'orch', TARGET);
    expect(out.tickets.map((t) => [t.item, t.ticket.status, t.ticket.checklist.length])).toEqual([
      ['1', 'todo', 0],
      ['2', 'merged', 1],
    ]);
    const create = showRaw(board, out.tickets[0]?.id ?? '')[0]?.event as {
      body: Record<string, unknown>;
    };
    expect(Object.keys(create.body)).not.toContain('checklist');
  });
});

describe('import-change: re-import (scenario: second import adds nothing)', () => {
  it('writes no events and reports every ticket unchanged when the file is unchanged', () => {
    const { board, first } = imported();
    const again = importChange(board, 'orch', TARGET);
    expect(again.events).toBe(0);
    expect(eventCount(board)).toBe(TOTAL_EVENTS);
    expect(listTickets(board)).toHaveLength(9);
    expect(again.tickets.map((t) => t.action)).toEqual(Array(9).fill('unchanged'));
    expect(again.tickets.map((t) => t.id)).toEqual(first.tickets.map((t) => t.id));
    expect(again.tickets.map((t) => t.events)).toEqual(Array(9).fill([]));
    expect(again.tickets.map((t) => t.ticket)).toEqual(first.tickets.map((t) => t.ticket));
  });

  it('is idempotent for any actor', () => {
    const { board } = imported();
    expect(importChange(board, 'someone-else', TARGET).events).toBe(0);
    expect(eventCount(board)).toBe(TOTAL_EVENTS);
  });

  it('does not change existing lines, their done flags or status when the file changes', () => {
    const { board, root, first } = imported();
    const edited = FIXTURE.replace('- [ ] 4.2 ', '- [x] 4.2 ')
      .replace('- [ ] 4.3 Twenty', '- [ ] 4.3 Thirty')
      .replace(/^- \[ \] 4\.5 .*$/m, '')
      .replace('- [ ] 5.2 ', '- [x] 5.2 ')
      .replace('- [x] 1.1 ', '- [ ] 1.1 ');
    writeTasks(root, edited);
    const again = importChange(board, 'orch', TARGET);
    expect(again.events).toBe(0);
    expect(eventCount(board)).toBe(TOTAL_EVENTS);
    expect(again.tickets.map((t) => t.action)).toEqual(Array(9).fill('unchanged'));
    // Group 5 is now fully ticked in the file, but the board does not move it.
    expect(byItem(again, '5').status).toBe('todo');
    expect(byItem(again, '5').checklist.map((c) => c.done)).toEqual([true, false]);
    expect(byItem(again, '4').checklist).toEqual(byItem(first, '4').checklist);
    expect(byItem(again, '1')).toEqual(byItem(first, '1'));
  });

  it('creates a ticket for a group added to the file, leaving the others untouched', () => {
    const { board, root, first } = imported();
    writeTasks(root, `${FIXTURE}\n## 10. Follow-ups\n\n- [ ] 10.1 First follow-up\n`);
    const again = importChange(board, 'orch', TARGET);
    expect(again.tickets.map((t) => t.action)).toEqual([...Array(9).fill('unchanged'), 'created']);
    const added = byItem(again, '10');
    expect(added).toMatchObject({
      title: 'Follow-ups',
      status: 'todo',
      labels: [`change:${CHANGE}`, 'group:10'],
      task: { source: 'openspec', ref: CHANGE, item: '10' },
      checklist: [{ text: '10.1 First follow-up', done: false }],
    });
    expect(again.events).toBe(1);
    expect(eventCount(board)).toBe(TOTAL_EVENTS + 1);
    expect(again.tickets.slice(0, 9).map((t) => t.ticket)).toEqual(
      first.tickets.map((t) => t.ticket),
    );
  });

  it('appends new task lines with one ticket.checklist.add per ticket, copying done flags', () => {
    const { board, root, first } = imported();
    const extended = FIXTURE.replace(
      /^(- \[ \] 7\.3 .*)$/m,
      '$1\n- [ ] 7.4 A new task\n- [x] 7.5 A task done already',
    ).replace(/^(- \[ \] 8\.3 .*)$/m, '$1\n- [ ] 8.4 Another new task');
    writeTasks(root, extended);
    const again = importChange(board, 'orch', TARGET);
    const seven = again.tickets.find((t) => t.item === '7');
    const eight = again.tickets.find((t) => t.item === '8');
    expect(seven).toMatchObject({ action: 'updated', appended: 2 });
    expect(eight).toMatchObject({ action: 'updated', appended: 1 });
    expect(seven?.events).toHaveLength(1);
    expect(eight?.events).toHaveLength(1);
    expect(again.events).toBe(2);
    expect(eventCount(board)).toBe(TOTAL_EVENTS + 2);
    expect(seven?.ticket.checklist).toEqual([
      ...byItem(first, '7').checklist,
      { text: '7.4 A new task', done: false },
      { text: '7.5 A task done already', done: true },
    ]);
    expect(seven?.ticket.status).toBe('todo');
    expect(seven?.ticket.version).toBe(byItem(first, '7').version + 1);
    // The one event of each ticket is a ticket.checklist.add carrying the new lines.
    const lastEvent = (id: string): unknown => showRaw(board, id).at(-1)?.event;
    expect(lastEvent(seven?.id ?? '')).toMatchObject({
      kind: 'ticket.checklist.add',
      actor: 'orch',
      body: {
        items: [
          { text: '7.4 A new task', done: false },
          { text: '7.5 A task done already', done: true },
        ],
      },
    });
    expect(showRaw(board, seven?.id ?? '').at(-1)?.hash).toBe(seven?.events[0]);
    expect(lastEvent(eight?.id ?? '')).toMatchObject({
      kind: 'ticket.checklist.add',
      body: { items: [{ text: '8.4 Another new task', done: false }] },
    });
    const others = again.tickets.filter((t) => t.item !== '7' && t.item !== '8');
    expect(others.map((t) => t.action)).toEqual(Array(7).fill('unchanged'));
    expect(others.map((t) => t.ticket)).toEqual(
      first.tickets.filter((t) => t.item !== '7' && t.item !== '8').map((t) => t.ticket),
    );
    // A third import of the same file writes nothing.
    const third = importChange(board, 'orch', TARGET);
    expect(third.events).toBe(0);
    expect(third.tickets.map((t) => t.action)).toEqual(Array(9).fill('unchanged'));
  });
});

describe('import-change: tickets are keyed by task reference', () => {
  it('adopts a ticket created by hand for a group instead of creating another', () => {
    const { board, root } = setup();
    writeTasks(root, FIXTURE);
    const manual = newTicket(board, 'human', {
      title: 'My own title',
      task: { source: 'openspec', ref: CHANGE, item: '7' },
      checklist: TASK_LINES[6]?.map(taskText),
    }).ticket;
    const out = importChange(board, 'orch', TARGET);
    expect(listTickets(board)).toHaveLength(9);
    const seven = out.tickets.find((t) => t.item === '7');
    expect(seven).toMatchObject({ action: 'unchanged', id: manual.id, events: [] });
    expect(seven?.ticket.title).toBe('My own title');
    expect(out.events).toBe(TOTAL_EVENTS - 1);
  });

  it('uses the ticket with the smallest id when several share the reference', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n');
    const task = { source: 'openspec', ref: CHANGE, item: '1' };
    const a = newTicket(board, 'human', { title: 'a', task, checklist: ['1.1 a'] }).ticket;
    newTicket(board, 'human', { title: 'b', task, checklist: ['1.1 a'] });
    const out = importChange(board, 'orch', TARGET);
    expect(out.tickets.map((t) => [t.id, t.action])).toEqual([[a.id, 'unchanged']]);
  });

  it('never re-creates a closed ticket', () => {
    const { board, first } = imported();
    const one = byItem(first, '1');
    closeTicket(board, 'orch', { id: one.id, noDecision: true });
    const again = importChange(board, 'orch', TARGET);
    expect(again.events).toBe(0);
    expect(again.tickets[0]).toMatchObject({ id: one.id, action: 'unchanged' });
    expect(again.tickets[0]?.ticket.closed).toBe(true);
    expect(listTickets(board, { closed: true })).toHaveLength(9);
  });

  it('does not take a ticket of another change or another source for a group', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n');
    newTicket(board, 'human', {
      title: 'other change',
      task: { source: 'openspec', ref: 'other-change', item: '1' },
    });
    newTicket(board, 'human', {
      title: 'other source',
      task: { source: 'speckit', ref: CHANGE, item: '1' },
    });
    const out = importChange(board, 'orch', TARGET);
    expect(out.tickets[0]?.action).toBe('created');
    expect(listTickets(board)).toHaveLength(3);
  });
});

describe('import-change: refusals write nothing', () => {
  it('names the tasks file path when the change does not exist', () => {
    const { board, root } = setup();
    writeTasks(root, FIXTURE);
    const err = expectBoardError(
      () => importChange(board, 'orch', { source: 'openspec', ref: 'no-such-change' }),
      1,
      'tasks-not-found',
    );
    expect(err.message).toContain('openspec/changes/no-such-change/tasks.md');
    expect(eventCount(board)).toBe(0);
  });

  it('names a source without an adapter as unsupported', () => {
    const { board } = setup();
    const err = expectBoardError(
      () => importChange(board, 'orch', { source: 'speckit', ref: '001-photo-albums' }),
      1,
      'unsupported-source',
    );
    expect(err.message).toContain('speckit');
    expect(eventCount(board)).toBe(0);
  });

  it('refuses a ref that is not a single path segment', () => {
    const { board } = setup();
    expectBoardError(
      () => importChange(board, 'orch', { source: 'openspec', ref: '../escape' }),
      1,
      'usage',
    );
    expect(eventCount(board)).toBe(0);
  });

  it('refuses a malformed tasks file before writing anything', () => {
    const { board, root } = setup();
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n## 2. Two\n- [ ] 2.1 b\n## 2. Again\n');
    expectBoardError(() => importChange(board, 'orch', TARGET), 1, 'malformed-tasks');
    expect(eventCount(board)).toBe(0);
  });

  it('refuses secret-looking text anywhere in the file before writing anything', () => {
    const { board, root } = setup();
    const token = SAMPLES['github-token'];
    writeTasks(root, `## 1. One\n- [ ] 1.1 a\n## 2. Two\n- [ ] 2.1 uses ${token}\n`);
    const err = expectBoardError(() => importChange(board, 'orch', TARGET), 1, 'secret-like');
    // import-change has no --allow-secret-like, so the message must not suggest it.
    expect(err.message).toBe(
      'refused: the text matches the secret pattern(s) github-token; ' +
        'the board is not a secret store',
    );
    expect(err.message).not.toContain('--allow-secret-like');
    expect(err.message).not.toContain(token);
    expect(eventCount(board)).toBe(0);
  });

  it('refuses secret-looking text in a group title', () => {
    const { board, root } = setup();
    writeTasks(root, `## 1. Rotate ${SAMPLES['aws-access-key-id']}\n- [ ] 1.1 a\n`);
    const err = expectBoardError(() => importChange(board, 'orch', TARGET), 1, 'secret-like');
    expect(err.message).toContain('aws-access-key-id');
    expect(err.message).not.toContain('--allow-secret-like');
    expect(err.message).not.toContain(SAMPLES['aws-access-key-id']);
    expect(eventCount(board)).toBe(0);
  });

  it('requires an actor', () => {
    const { board, root } = setup();
    writeTasks(root, FIXTURE);
    expectBoardError(() => importChange(board, '', TARGET), 1, 'missing-actor');
    expect(eventCount(board)).toBe(0);
  });
});

describe('import-change: host root', () => {
  it("reads the tasks file under the board's parent directory", () => {
    const { board, root } = setup();
    expect(dirname(board.dir)).toBe(root);
    writeTasks(root, '## 1. One\n- [ ] 1.1 a\n');
    expect(importChange(board, 'orch', TARGET).tickets).toHaveLength(1);
  });
});
