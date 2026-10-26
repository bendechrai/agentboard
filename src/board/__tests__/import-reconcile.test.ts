/**
 * Re-import on a real board (add-claim-leases tasks 8.2 and 8.3;
 * board-openspec-integration: "Import a change" (modified), "Pair tickets
 * to groups by identity", "Reconcile on re-import"; board-concurrency:
 * "Re-import is idempotent" (modified); board-events: "Renumber and
 * supersede events").
 *
 * Tasks files are small and written out in each test; expected events and
 * tickets are worked out by hand from the spec. The vaultfold fixtures
 * reproduce the two cases that motivated the change: a group inserted
 * before others, and a tasks file regrouped and reworded.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import type { BoardEvent } from '../../events/schema.js';
import type { Board } from '../../store/board.js';
import {
  claimTicket,
  closeTicket,
  commentTicket,
  moveTicket,
  setChecklistItem,
} from '../actions.js';
import {
  ImportRefusedError,
  importChange,
  type ImportOptions,
  type ImportResult,
  type ImportedTicket,
} from '../import.js';
import { readInbox } from '../inbox.js';
import { listTickets, newTicket, showRaw } from '../tickets.js';
import { eventCount, expectBoardError, setup } from './helpers.js';

const CHANGE = 'add-x';
const PATH = `openspec/changes/${CHANGE}/tasks.md`;
const TARGET = { source: 'openspec', ref: CHANGE };
const SLOW = { timeout: 30_000 };

/** One group of a tasks file; a line starting with `x ` is ticked. */
interface Group {
  n: number;
  title: string;
  lines: readonly string[];
}

/** The tasks file text of `groups`. */
function tasks(groups: readonly Group[]): string {
  const out = ['# Tasks', ''];
  for (const g of groups) {
    out.push(`## ${String(g.n)}. ${g.title}`, '');
    for (const line of g.lines) {
      out.push(line.startsWith('x ') ? `- [x] ${line.slice(2)}` : `- [ ] ${line}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function writeTasks(root: string, text: string): void {
  mkdirSync(join(root, 'openspec', 'changes', CHANGE), { recursive: true });
  writeFileSync(join(root, PATH), text);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function run(board: Board, options?: ImportOptions, actor = 'orch'): ImportResult {
  return importChange(board, actor, TARGET, options);
}

/** A board with `groups` written and imported. */
function imported(groups: readonly Group[]): { board: Board; root: string; first: ImportResult } {
  const { board, root } = setup();
  writeTasks(root, tasks(groups));
  return { board, root, first: run(board) };
}

/** The current ticket of the first import's group `n`. */
function idOf(result: ImportResult, n: number): string {
  const entry = result.tickets.find((t) => t.item === String(n));
  if (entry?.id === undefined || entry.id === null) {
    throw new Error(`no ticket for group ${String(n)}`);
  }
  return entry.id;
}

function ticket(board: Board, id: string): Ticket {
  const found = listTickets(board, { closed: true }).find((t) => t.id === id);
  if (found === undefined) {
    throw new Error(`no ticket ${id}`);
  }
  return found;
}

function entry(result: ImportResult, item: string): ImportedTicket {
  const found = result.tickets.find((t) => t.item === item);
  if (found === undefined) {
    throw new Error(`no entry for ${item}`);
  }
  return found;
}

/** The events of `id` written after the first `skip`, in fold order. */
function eventsOf(board: Board, id: string, skip = 0): BoardEvent[] {
  return showRaw(board, id)
    .slice(skip)
    .map((raw) => raw.event as unknown as BoardEvent);
}

/** Every event file name of the board's events directory, temporaries included. */
function files(board: Board): string[] {
  return readdirSync(board.eventsDir).sort();
}

/** The kinds of the events with these hashes, in fold order across tickets. */
function writtenKinds(board: Board, result: ImportResult): string[] {
  const hashes = new Set(result.tickets.flatMap((t) => t.events));
  const all = listTickets(board, { closed: true }).flatMap((t) =>
    showRaw(board, t.id).filter((raw) => hashes.has(raw.hash)),
  );
  return all
    .map((raw) => raw.event as unknown as BoardEvent)
    .sort((a, b) => a.ts.wall - b.ts.wall || a.ts.counter - b.ts.counter)
    .map((e) => (e.kind === 'ticket.renumber' ? `renumber ${e.body.from}->${e.body.to}` : e.kind));
}

function active(t: Ticket): string[] {
  return t.checklist.filter((line) => line.removed !== true).map((line) => line.text);
}

const ABC: Group = { n: 1, title: 'Old title', lines: ['1.1 Add A', '1.2 Add B', '1.3 Add C'] };

describe('Reconcile on re-import', SLOW, () => {
  it('scenario: a revised tasks file reconciles in one event', () => {
    const { board, root, first } = imported([ABC]);
    const id = idOf(first, 1);
    setChecklistItem(board, 'impl', { id, index: 0, done: true });
    const before = eventCount(board);
    const revised = tasks([
      { n: 1, title: 'New title', lines: ['1.1 Add A', '1.2 Add B with retries', '1.4 Add D'] },
    ]);
    writeTasks(root, revised);
    const result = run(board);
    expect(eventCount(board)).toBe(before + 1);
    expect(result.events).toBe(1);
    const e = entry(result, '1');
    expect(e).toMatchObject({
      id,
      action: 'updated',
      title: 'New title',
      pairing: { pass: 'number', score: 0.2 },
      renumber: null,
      blocked: [],
      forced: false,
      supersede: null,
      diff: {
        title: 'New title',
        updated: [{ index: 1, text: '1.2 Add B with retries', done: false }],
        removed: [2],
        added: [{ text: '1.4 Add D', done: false }],
      },
    });
    const [event] = eventsOf(board, id, -1);
    expect(event).toEqual({
      v: 1,
      kind: 'ticket.reconcile',
      ticket: id,
      actor: 'orch',
      ts: event?.ts,
      body: {
        title: 'New title',
        updated: [{ index: 1, text: '1.2 Add B with retries', done: false }],
        removed: [2],
        added: [{ text: '1.4 Add D', done: false }],
        forced: false,
        source: `${PATH}@sha256:${sha256(revised)}`,
      },
    });
    expect(showRaw(board, id).at(-1)?.hash).toBe(e.events[0]);
    const t = ticket(board, id);
    expect(t.title).toBe('New title');
    expect(t.checklist).toEqual([
      { text: '1.1 Add A', done: true },
      { text: '1.2 Add B with retries', done: false },
      { text: '1.3 Add C', done: false, removed: true },
      { text: '1.4 Add D', done: false },
    ]);
    expect(e.ticket).toEqual(t);
  });

  it('scenario: a renumbered line matches by text and keeps its done flag', () => {
    const { board, root, first } = imported([
      { n: 2, title: 'G', lines: ['2.1 Plan', '2.3 Write the ADR'] },
    ]);
    const id = idOf(first, 2);
    setChecklistItem(board, 'impl', { id, index: 1, done: true });
    writeTasks(root, tasks([{ n: 2, title: 'G', lines: ['2.1 Plan', '2.2 Write the ADR'] }]));
    const result = run(board);
    expect(entry(result, '2').diff).toEqual({
      title: null,
      updated: [{ index: 1, text: '2.2 Write the ADR', done: true }],
      removed: [],
      added: [],
    });
    expect(ticket(board, id).checklist).toEqual([
      { text: '2.1 Plan', done: false },
      { text: '2.2 Write the ADR', done: true },
    ]);
  });

  it('scenario: an unchanged tasks file writes nothing the second time', () => {
    const { board } = imported([ABC, { n: 2, title: 'Two', lines: ['x 2.1 Done'] }]);
    const before = files(board);
    const again = run(board);
    expect(again.events).toBe(0);
    expect(again.tickets.map((t) => [t.item, t.action, t.events, t.diff])).toEqual([
      ['1', 'unchanged', [], null],
      ['2', 'unchanged', [], null],
    ]);
    expect(files(board)).toEqual(before);
  });

  it('a second import after a reconcile writes nothing', () => {
    const { board, root } = imported([ABC]);
    writeTasks(root, tasks([{ n: 1, title: 'New', lines: ['1.1 Add A', '1.4 Add D'] }]));
    expect(run(board).events).toBe(1);
    const before = files(board);
    expect(run(board).events).toBe(0);
    expect(files(board)).toEqual(before);
  });

  it('keeps the board done flag for unchanged text, and takes the checkbox for reworded text', () => {
    const { board, root, first } = imported([
      { n: 1, title: 'G', lines: ['x 1.1 Done', '1.2 Open', '1.3 Reword me'] },
    ]);
    const id = idOf(first, 1);
    setChecklistItem(board, 'impl', { id, index: 1, done: true });
    writeTasks(
      root,
      tasks([{ n: 1, title: 'G', lines: ['1.1 Done', '1.2 Open', 'x 1.3 Reworded'] }]),
    );
    const result = run(board);
    expect(entry(result, '1').diff).toEqual({
      title: null,
      updated: [{ index: 2, text: '1.3 Reworded', done: true }],
      removed: [],
      added: [],
    });
    expect(ticket(board, id).checklist.map((l) => l.done)).toEqual([true, true, true]);
  });

  it('never changes status, assignee or labels other than the group label', () => {
    const { board, root, first } = imported([ABC]);
    const id = idOf(first, 1);
    claimTicket(board, 'impl', { id });
    writeTasks(root, tasks([{ n: 1, title: 'Renamed', lines: [...ABC.lines, '1.4 More'] }]));
    run(board);
    const t = ticket(board, id);
    expect({ status: t.status, assignee: t.assignee, labels: t.labels }).toEqual({
      status: 'todo',
      assignee: 'impl',
      labels: [`change:${CHANGE}`, 'group:1'],
    });
  });

  it('does not move a group that became fully ticked since the first import', () => {
    const { board, root, first } = imported([ABC]);
    writeTasks(root, tasks([{ ...ABC, lines: ABC.lines.map((l) => `x ${l}`) }]));
    const result = run(board);
    expect(result.events).toBe(0);
    expect(ticket(board, idOf(first, 1)).status).toBe('todo');
  });
});

describe('the reconcile guard', SLOW, () => {
  const TWO: Group = { n: 2, title: 'Two', lines: ['2.1 Keep'] };

  it('scenario: removing a ticked line is blocked, other tickets are reconciled, exit 4 after every group', () => {
    const { board, root, first } = imported([ABC, TWO]);
    const one = idOf(first, 1);
    const two = idOf(first, 2);
    setChecklistItem(board, 'impl', { id: one, index: 1, done: true });
    const before = eventCount(board);
    writeTasks(
      root,
      tasks([
        { n: 1, title: 'Old title', lines: ['1.1 Add A', '1.3 Add C'] },
        { n: 2, title: 'Two', lines: ['2.1 Keep', '2.2 Added'] },
        { n: 3, title: 'Three', lines: ['3.1 New group'] },
      ]),
    );
    const err = expectBoardError(() => run(board), 4, 'reconcile-blocked');
    expect(err).toBeInstanceOf(ImportRefusedError);
    const lines = err.message.split('\n');
    expect(lines[0]).toBe('reconcile blocked for 1 ticket(s); every other group was imported');
    expect(lines.slice(1)).toEqual([
      `  ${one} group 1 Old title`,
      '    blocked 1 1.2 Add B (done)',
    ]);
    // Group 1: nothing written. Group 2 reconciled and group 3 created, both
    // after the blocked group in file order.
    expect(eventsOf(board, one).map((e) => e.kind)).toEqual(['ticket.create', 'ticket.checklist']);
    expect(eventsOf(board, two).map((e) => e.kind)).toEqual(['ticket.create', 'ticket.reconcile']);
    const result = (err as ImportRefusedError).result;
    expect(result.dryRun).toBe(false);
    expect(entry(result, '1')).toMatchObject({
      action: 'blocked',
      events: [],
      blocked: [{ index: 1, text: '1.2 Add B', change: 'removed', reason: 'done' }],
      forced: false,
    });
    expect(entry(result, '2').action).toBe('updated');
    expect(entry(result, '3').action).toBe('created');
    expect(eventCount(board)).toBe(before + 2);
    expect(ticket(board, one).checklist).toEqual([
      { text: '1.1 Add A', done: false },
      { text: '1.2 Add B', done: true },
      { text: '1.3 Add C', done: false },
    ]);
  });

  it('blocks rewording a ticked line too', () => {
    const { board, root, first } = imported([ABC]);
    setChecklistItem(board, 'impl', { id: idOf(first, 1), index: 0, done: true });
    writeTasks(root, tasks([{ ...ABC, lines: ['1.1 Add A twice', '1.2 Add B', '1.3 Add C'] }]));
    const err = expectBoardError(() => run(board), 4, 'reconcile-blocked');
    expect(err.message).toContain('    blocked 0 1.1 Add A (done)');
  });

  it('scenario: an in-progress ticket is not rewritten under its holder; --force tells the holder', () => {
    const { board, root, first } = imported([ABC]);
    const id = idOf(first, 1);
    claimTicket(board, 'impl', { id });
    moveTicket(board, 'impl', { id, to: 'tests' });
    moveTicket(board, 'impl', { id, to: 'implementing' });
    writeTasks(root, tasks([{ ...ABC, lines: ['1.1 Add A', '1.2 Add B, reworded', '1.3 Add C'] }]));
    const versionBefore = ticket(board, id).version;
    const err = expectBoardError(() => run(board), 4, 'reconcile-blocked');
    expect(err.message).toContain('    blocked 1 1.2 Add B (held by impl in implementing)');
    expect(ticket(board, id).version).toBe(versionBefore);

    readInbox(board, 'impl');
    const forced = run(board, { force: true });
    const e = entry(forced, '1');
    expect(e).toMatchObject({
      action: 'updated',
      forced: true,
      blocked: [{ index: 1, text: '1.2 Add B', change: 'updated', reason: 'held' }],
    });
    const [event] = eventsOf(board, id, -1);
    expect(event).toMatchObject({
      kind: 'ticket.reconcile',
      body: {
        updated: [{ index: 1, text: '1.2 Add B, reworded', done: false }],
        removed: [],
        added: [],
        forced: true,
        holder: 'impl',
      },
    });
    const t = ticket(board, id);
    expect({ status: t.status, assignee: t.assignee }).toEqual({
      status: 'implementing',
      assignee: 'impl',
    });
    const inbox = readInbox(board, 'impl').entries;
    expect(inbox.map((x) => [x.kind, x.affects])).toEqual([['ticket.reconcile', 'impl']]);
  });

  it('records forced false and no holder for a ticket --force did not need to force', () => {
    const { board, root, first } = imported([ABC]);
    const id = idOf(first, 1);
    claimTicket(board, 'impl', { id });
    writeTasks(root, tasks([{ ...ABC, lines: ['1.1 Add A'] }]));
    const result = run(board, { force: true });
    expect(entry(result, '1')).toMatchObject({ action: 'updated', forced: false, blocked: [] });
    const [event] = eventsOf(board, id, -1);
    expect(event?.kind).toBe('ticket.reconcile');
    expect(event?.body).not.toHaveProperty('holder');
    expect(event?.body).toMatchObject({ forced: false });
    expect(readInbox(board, 'orch').entries.at(-1)?.affects).toBeNull();
  });

  it('records forced true without a holder for an unassigned ticket', () => {
    const { board, root, first } = imported([ABC]);
    const id = idOf(first, 1);
    setChecklistItem(board, 'impl', { id, index: 2, done: true });
    writeTasks(root, tasks([{ ...ABC, lines: ['1.1 Add A', '1.2 Add B'] }]));
    run(board, { force: true });
    const [event] = eventsOf(board, id, -1);
    expect(event?.body).toMatchObject({ forced: true, removed: [2] });
    expect(event?.body).not.toHaveProperty('holder');
  });

  it('scenario: a title change and additions are never blocked', () => {
    const { board, root, first } = imported([ABC]);
    const id = idOf(first, 1);
    setChecklistItem(board, 'impl', { id, index: 0, done: true });
    claimTicket(board, 'impl', { id });
    moveTicket(board, 'impl', { id, to: 'tests' });
    moveTicket(board, 'impl', { id, to: 'implementing' });
    writeTasks(root, tasks([{ n: 1, title: 'Renamed group', lines: [...ABC.lines, '1.4 Add D'] }]));
    const result = run(board);
    expect(entry(result, '1')).toMatchObject({ action: 'updated', forced: false, blocked: [] });
    expect(eventsOf(board, id, -1)[0]).toMatchObject({
      kind: 'ticket.reconcile',
      body: {
        title: 'Renamed group',
        updated: [],
        removed: [],
        added: [{ text: '1.4 Add D', done: false }],
        forced: false,
      },
    });
  });
});

describe('--dry-run', SLOW, () => {
  it('scenario: reports the differences and creates no event or temporary file', () => {
    const { board, root, first } = imported([ABC, { n: 2, title: 'Two', lines: ['2.1 x'] }]);
    const one = idOf(first, 1);
    const two = idOf(first, 2);
    setChecklistItem(board, 'impl', { id: one, index: 2, done: true });
    writeTasks(
      root,
      tasks([
        { n: 1, title: 'Inserted', lines: ['1.1 Brand new'] },
        { n: 2, title: 'Old title', lines: ['2.1 Add A', '2.2 Add B again'] },
      ]),
    );
    const before = files(board);
    const result = run(board, { dryRun: true });
    expect(files(board)).toEqual(before);
    expect(result.dryRun).toBe(true);
    expect(result.events).toBe(0);
    expect(result.ambiguous).toEqual([]);
    expect(result.tickets.map((t) => [t.item, t.id, t.action, t.events])).toEqual([
      ['1', null, 'created', []],
      ['2', one, 'blocked', []],
      [null, two, 'superseded', []],
    ]);
    expect(result.tickets[0]).toMatchObject({ title: 'Inserted', ticket: null, pairing: null });
    expect(entry(result, '2')).toMatchObject({
      pairing: { pass: 'title', score: 1 / 4 },
      renumber: { from: '1', to: '2' },
      diff: {
        title: null,
        updated: [{ index: 0, text: '2.1 Add A', done: false }],
        removed: [1, 2],
        added: [{ text: '2.2 Add B again', done: false }],
      },
      blocked: [{ index: 2, text: '1.3 Add C', change: 'removed', reason: 'done' }],
      forced: false,
    });
    expect(result.tickets[2]).toMatchObject({
      title: 'Two',
      supersede: `group removed from ${PATH}`,
    });
    expect(result.tickets[1]?.ticket).toEqual(ticket(board, one));
  });

  it('with --force reports the blocked ticket as forced, still writing nothing', () => {
    const { board, root, first } = imported([ABC]);
    setChecklistItem(board, 'impl', { id: idOf(first, 1), index: 2, done: true });
    writeTasks(root, tasks([{ ...ABC, lines: ['1.1 Add A', '1.2 Add B'] }]));
    const before = files(board);
    const result = run(board, { dryRun: true, force: true });
    expect(entry(result, '1')).toMatchObject({ action: 'updated', forced: true, events: [] });
    expect(files(board)).toEqual(before);
  });

  it('reports an ambiguous pairing without refusing', () => {
    const { board, root } = imported([
      { n: 2, title: 'Store', lines: ['2.1 reads', '2.2 writes', '2.3 locks', '2.4 files'] },
    ]);
    writeTasks(
      root,
      tasks([
        { n: 2, title: 'Store reads', lines: ['2.1 reads', '2.2 writes'] },
        { n: 3, title: 'Store writes', lines: ['3.1 locks', '3.2 files'] },
      ]),
    );
    const before = files(board);
    const result = run(board, { dryRun: true });
    expect(result.ambiguous.map((c) => [c.item, c.score, c.sameTitle])).toEqual([
      ['2', 0.5, false],
      ['3', 0.5, false],
    ]);
    expect(files(board)).toEqual(before);
  });
});

describe('Pair tickets to groups by identity', SLOW, () => {
  const SEVEN: Group[] = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    n,
    title: `Group ${['one', 'two', 'three', 'four', 'five', 'six', 'seven'][n - 1] ?? ''}`,
    lines: [
      `${String(n)}.1 First task of ${String(n)}`,
      `${String(n)}.2 Second task of ${String(n)}`,
    ],
  }));

  /** `SEVEN` with a new group inserted at 5, later groups renumbered; lines keep their numbers when `keepLineNumbers`. */
  function inserted(keepLineNumbers: boolean): Group[] {
    return [
      ...SEVEN.slice(0, 4),
      { n: 5, title: 'Inserted group', lines: ['5.1 The new work'] },
      ...SEVEN.slice(4).map((g) => ({
        n: g.n + 1,
        title: g.title,
        lines: keepLineNumbers
          ? g.lines
          : g.lines.map((l) => l.replace(/^[0-9]+\./, `${String(g.n + 1)}.`)),
      })),
    ];
  }

  /** The seven-group board with impl holding group 5 in implementing, with comments and a tick. */
  function held(): { board: Board; root: string; first: ImportResult; five: string } {
    const { board, root, first } = imported(SEVEN);
    const five = idOf(first, 5);
    claimTicket(board, 'impl', { id: five });
    moveTicket(board, 'impl', { id: five, to: 'tests' });
    moveTicket(board, 'impl', { id: five, to: 'implementing' });
    commentTicket(board, 'impl', { id: five, text: 'halfway' });
    commentTicket(board, 'orch', { id: five, text: 'thanks' });
    setChecklistItem(board, 'impl', { id: five, index: 0, done: true });
    return { board, root, first, five };
  }

  it('scenario (vaultfold): an inserted group moves nothing', () => {
    const { board, root, first, five } = held();
    const before = ticket(board, five);
    writeTasks(root, tasks(inserted(true)));
    const result = run(board);
    expect(result.tickets.map((t) => [t.item, t.action, t.pairing?.pass ?? null])).toEqual([
      ['1', 'unchanged', 'title'],
      ['2', 'unchanged', 'title'],
      ['3', 'unchanged', 'title'],
      ['4', 'unchanged', 'title'],
      ['5', 'created', null],
      ['6', 'updated', 'title'],
      ['7', 'updated', 'title'],
      ['8', 'updated', 'title'],
    ]);
    expect([5, 6, 7].map((n) => entry(result, String(n + 1)).id)).toEqual([
      idOf(first, 5),
      idOf(first, 6),
      idOf(first, 7),
    ]);
    expect(result.tickets.map((t) => t.diff)).toEqual(Array(8).fill(null));
    expect(writtenKinds(board, result)).toEqual([
      'renumber 5->6',
      'renumber 6->7',
      'renumber 7->8',
      'ticket.create',
    ]);
    const after = ticket(board, five);
    expect(after).toMatchObject({
      task: { source: 'openspec', ref: CHANGE, item: '6' },
      labels: [`change:${CHANGE}`, 'group:6'],
      assignee: 'impl',
      status: 'implementing',
      title: before.title,
      checklist: before.checklist,
      comments: before.comments,
    });
    const created = entry(result, '5');
    expect(created.ticket).toMatchObject({
      title: 'Inserted group',
      task: { item: '5' },
      assignee: null,
      comments: [],
      checklist: [{ text: '5.1 The new work', done: false }],
    });
    expect(run(board).events).toBe(0);
  });

  it('vaultfold insertion with renumbered task lines: only the numbers of lines change, never blocked', () => {
    const { board, root, five } = held();
    const before = ticket(board, five);
    writeTasks(root, tasks(inserted(false)));
    const result = run(board);
    const moved = entry(result, '6');
    expect(moved).toMatchObject({
      id: five,
      action: 'updated',
      renumber: { from: '5', to: '6' },
      blocked: [],
      forced: false,
      diff: {
        title: null,
        updated: [
          { index: 0, text: '6.1 First task of 5', done: true },
          { index: 1, text: '6.2 Second task of 5', done: false },
        ],
        removed: [],
        added: [],
      },
    });
    const after = ticket(board, five);
    expect(after.assignee).toBe('impl');
    expect(after.comments).toEqual(before.comments);
    expect(after.checklist.map((l) => l.done)).toEqual([true, false]);
    expect(eventsOf(board, five, before.version).map((e) => e.kind)).toEqual([
      'ticket.renumber',
      'ticket.reconcile',
    ]);
    expect(run(board).events).toBe(0);
  });

  it('scenario: reordered groups are renumbered and nothing else is written', () => {
    const groups: Group[] = [
      { n: 1, title: 'One', lines: ['1.1 a'] },
      { n: 2, title: 'Two', lines: ['2.1 b'] },
      { n: 3, title: 'Three', lines: ['3.1 c'] },
    ];
    const { board, root, first } = imported(groups);
    writeTasks(
      root,
      tasks([
        groups[0] as Group,
        { ...(groups[2] as Group), n: 2 },
        { ...(groups[1] as Group), n: 3 },
      ]),
    );
    const result = run(board);
    expect(writtenKinds(board, result)).toEqual(['renumber 2->3', 'renumber 3->2']);
    expect(result.events).toBe(2);
    expect(ticket(board, idOf(first, 2)).task?.item).toBe('3');
    expect(ticket(board, idOf(first, 3)).task?.item).toBe('2');
    expect(ticket(board, idOf(first, 3)).labels).toEqual([`change:${CHANGE}`, 'group:2']);
  });

  it('scenario: a renamed group keeps its ticket, reconciled, with its assignee and comments', () => {
    const four: Group = {
      n: 4,
      title: 'Old four',
      lines: ['4.1 a', '4.2 b', '4.3 c', '4.4 d', '4.5 e'],
    };
    const { board, root, first } = imported([{ n: 1, title: 'One', lines: ['1.1 z'] }, four]);
    const id = idOf(first, 4);
    claimTicket(board, 'impl', { id });
    commentTicket(board, 'impl', { id, text: 'noted' });
    writeTasks(
      root,
      tasks([
        { n: 1, title: 'One', lines: ['1.1 z'] },
        { n: 4, title: 'New four', lines: ['4.1 a', '4.2 b', '4.3 c', '4.4 d', '4.6 f'] },
      ]),
    );
    const result = run(board);
    expect(entry(result, '4')).toMatchObject({
      id,
      action: 'updated',
      pairing: { pass: 'content', score: 4 / 6 },
      diff: {
        title: 'New four',
        updated: [],
        removed: [4],
        added: [{ text: '4.6 f', done: false }],
      },
    });
    const t = ticket(board, id);
    expect(t.assignee).toBe('impl');
    expect(t.comments.map((c) => c.text)).toEqual(['noted']);
    expect(active(t)).toEqual(['4.1 a', '4.2 b', '4.3 c', '4.4 d', '4.6 f']);
  });

  it('scenario: a group renamed with every line reworded is paired by number and reconciled', () => {
    const { board, root, first } = imported([
      { n: 1, title: 'Kept', lines: ['1.1 k'] },
      { n: 3, title: 'Old three', lines: ['3.1 alpha', '3.2 beta'] },
    ]);
    writeTasks(
      root,
      tasks([
        { n: 1, title: 'Kept', lines: ['1.1 k'] },
        { n: 3, title: 'New three', lines: ['3.1 gamma', '3.2 delta'] },
      ]),
    );
    const result = run(board);
    expect(entry(result, '3')).toMatchObject({
      id: idOf(first, 3),
      action: 'updated',
      pairing: { pass: 'number', score: 0 },
    });
    expect(active(ticket(board, idOf(first, 3)))).toEqual(['3.1 gamma', '3.2 delta']);
    expect(ticket(board, idOf(first, 3)).title).toBe('New three');
  });

  it('scenario: an ambiguous pairing (a split group) writes nothing and refuses', () => {
    const { board, root, first } = imported([
      { n: 2, title: 'Store', lines: ['2.1 reads', '2.2 writes', '2.3 locks', '2.4 files'] },
    ]);
    writeTasks(
      root,
      tasks([
        { n: 2, title: 'Store reads', lines: ['2.1 reads', '2.2 writes'] },
        { n: 3, title: 'Store writes', lines: ['3.1 locks', '3.2 files'] },
      ]),
    );
    const before = files(board);
    const err = expectBoardError(() => run(board), 4, 'reconcile-ambiguous');
    expect(files(board)).toEqual(before);
    const id = idOf(first, 2);
    expect(err.message.split('\n')).toEqual([
      `pairing tickets with the groups of ${PATH} is ambiguous; nothing was written`,
      `  ${id} group 2 score 0.50`,
      `  ${id} group 3 score 0.50`,
    ]);
    const { result } = err as ImportRefusedError;
    expect(result.dryRun).toBe(true);
    expect(result.events).toBe(0);
    expect(result.ambiguous).toEqual([
      { ticket: id, item: '2', score: 0.5, sameTitle: false },
      { ticket: id, item: '3', score: 0.5, sameTitle: false },
    ]);
  });

  it('refuses as ambiguous when two tickets of the change match one group equally', () => {
    const { board, root } = setup();
    writeTasks(root, tasks([{ n: 1, title: 'One', lines: ['1.1 a'] }]));
    const task = { source: 'openspec', ref: CHANGE, item: '1' };
    newTicket(board, 'human', { title: 'a', task, checklist: ['1.1 a'] });
    newTicket(board, 'human', { title: 'b', task, checklist: ['1.1 a'] });
    const before = files(board);
    const err = expectBoardError(() => run(board), 4, 'reconcile-ambiguous');
    expect(err.message).toContain('group 1 score 1.00');
    expect(files(board)).toEqual(before);
  });

  it('scenario: a removed group is superseded and no ticket takes over its content', () => {
    const groups: Group[] = [1, 2, 3, 4, 5].map((n) => ({
      n,
      title: `Title ${String(n)}`,
      lines: [`${String(n)}.1 Work ${String(n)}`],
    }));
    const { board, root, first } = imported(groups);
    const four = idOf(first, 4);
    const five = idOf(first, 5);
    claimTicket(board, 'impl', { id: four });
    commentTicket(board, 'impl', { id: four, text: 'mine' });
    const before = ticket(board, four);
    writeTasks(
      root,
      tasks([...groups.slice(0, 3), { n: 4, title: 'Title 5', lines: ['4.1 Work 5'] }]),
    );
    const result = run(board);
    expect(writtenKinds(board, result)).toEqual([
      'renumber 5->4',
      'ticket.reconcile',
      'ticket.supersede',
    ]);
    expect(entry(result, '4')).toMatchObject({ id: five, renumber: { from: '5', to: '4' } });
    const superseded = result.tickets.at(-1);
    expect(superseded).toMatchObject({
      item: null,
      id: four,
      action: 'superseded',
      title: 'Title 4',
      supersede: `group removed from ${PATH}`,
      pairing: null,
      diff: null,
    });
    const t = ticket(board, four);
    expect(t).toEqual({
      ...before,
      superseded: `group removed from ${PATH}`,
      version: before.version + 1,
      updatedAt: t.updatedAt,
    });
    expect(active(ticket(board, five))).toEqual(['4.1 Work 5']);
    expect(run(board).events).toBe(0);
  });

  it('a superseded ticket takes no further part: a group with its title gets a new ticket', () => {
    const { board, root, first } = imported([
      { n: 1, title: 'One', lines: ['1.1 a'] },
      { n: 2, title: 'Two', lines: ['2.1 b'] },
    ]);
    writeTasks(root, tasks([{ n: 1, title: 'One', lines: ['1.1 a'] }]));
    run(board);
    expect(ticket(board, idOf(first, 2)).superseded).not.toBeNull();
    writeTasks(
      root,
      tasks([
        { n: 1, title: 'One', lines: ['1.1 a'] },
        { n: 2, title: 'Two', lines: ['2.1 b'] },
      ]),
    );
    const again = run(board);
    expect(entry(again, '2').action).toBe('created');
    expect(entry(again, '2').id).not.toBe(idOf(first, 2));
    expect(again.tickets).toHaveLength(2);
  });

  it('closed tickets are paired and renumbered, never reconciled, and their differences are reported', () => {
    const { board, root, first } = imported([
      { n: 1, title: 'Done group', lines: ['x 1.1 a'] },
      { n: 2, title: 'Open', lines: ['2.1 b'] },
    ]);
    const done = idOf(first, 1);
    closeTicket(board, 'orch', { id: done, noDecision: true });
    const version = ticket(board, done).version;
    writeTasks(
      root,
      tasks([
        { n: 1, title: 'Inserted', lines: ['1.1 new'] },
        { n: 2, title: 'Done group', lines: ['x 2.1 a', '2.2 late addition'] },
        { n: 3, title: 'Open', lines: ['3.1 b'] },
      ]),
    );
    const result = run(board);
    expect(entry(result, '2')).toMatchObject({
      id: done,
      action: 'updated',
      renumber: { from: '1', to: '2' },
      diff: {
        title: null,
        updated: [{ index: 0, text: '2.1 a', done: true }],
        removed: [],
        added: [{ text: '2.2 late addition', done: false }],
      },
      blocked: [],
    });
    expect(eventsOf(board, done, version).map((e) => e.kind)).toEqual(['ticket.renumber']);
    expect(ticket(board, done).checklist).toEqual([{ text: '1.1 a', done: true }]);
    // A closed ticket with nothing to renumber is unchanged, its diff reported.
    const again = run(board);
    expect(entry(again, '2')).toMatchObject({ action: 'unchanged', events: [] });
    expect(entry(again, '2').diff).not.toBeNull();
  });

  it('only pairs tickets of this change: another change or source is never touched', () => {
    const { board, root } = setup();
    writeTasks(root, tasks([{ n: 1, title: 'One', lines: ['1.1 a'] }]));
    const other = newTicket(board, 'human', {
      title: 'One',
      task: { source: 'openspec', ref: 'other-change', item: '1' },
      checklist: ['1.1 a'],
    }).ticket;
    const result = run(board);
    expect(entry(result, '1').action).toBe('created');
    expect(result.tickets).toHaveLength(1);
    expect(ticket(board, other.id).superseded).toBeNull();
  });
});

describe('vaultfold: a regrouped and reworded tasks file', SLOW, () => {
  const V1: Group[] = [
    {
      n: 1,
      title: 'Schema',
      lines: ['1.1 Add the vault schema', '1.2 Add migrations', '1.3 Seed data'],
    },
    { n: 2, title: 'API', lines: ['2.1 List vaults', '2.2 Create vault', '2.3 Delete vault'] },
    { n: 3, title: 'UI', lines: ['3.1 Vault list page', '3.2 Vault form'] },
    { n: 4, title: 'Docs', lines: ['4.1 README', '4.2 ADR'] },
  ];
  const V2: Group[] = [
    {
      n: 1,
      title: 'Schema and migrations',
      lines: ['1.1 Add the vault schema', '1.2 Add migrations with rollback', '1.3 Seed data'],
    },
    { n: 2, title: 'Search', lines: ['2.1 Index vaults', '2.2 Search page'] },
    { n: 3, title: 'API', lines: ['3.1 List vaults', '3.2 Create vault', '3.3 Archive vault'] },
    { n: 4, title: 'UI', lines: ['4.1 Vault list page', '4.2 Vault form'] },
  ];

  it('reconciles every ticket to match the new groups exactly', () => {
    const { board, root, first } = imported(V1);
    const ids = [1, 2, 3, 4].map((n) => idOf(first, n));
    const [schema = '', api = '', ui = '', docs = ''] = ids;
    setChecklistItem(board, 'impl', { id: schema, index: 0, done: true });
    setChecklistItem(board, 'impl', { id: api, index: 1, done: true });
    commentTicket(board, 'impl', { id: ui, text: 'ui notes' });
    claimTicket(board, 'ui-dev', { id: ui });
    writeTasks(root, tasks(V2));
    const result = run(board);
    expect(
      result.tickets.map((t) => [
        t.item,
        t.id === null ? null : ids.indexOf(t.id) + 1,
        t.action,
        t.pairing?.pass ?? null,
      ]),
    ).toEqual([
      ['1', 1, 'updated', 'content'],
      ['2', 0, 'created', null],
      ['3', 2, 'updated', 'title'],
      ['4', 3, 'updated', 'title'],
      [null, 4, 'superseded', null],
    ]);
    expect(writtenKinds(board, result)).toEqual([
      'renumber 2->3',
      'renumber 3->4',
      'ticket.reconcile',
      'ticket.create',
      'ticket.reconcile',
      'ticket.reconcile',
      'ticket.supersede',
    ]);
    for (const group of V2) {
      const id = entry(result, String(group.n)).id ?? '';
      const t = ticket(board, id);
      expect(t.title).toBe(group.title);
      expect(t.task?.item).toBe(String(group.n));
      expect(t.labels).toEqual([`change:${CHANGE}`, `group:${String(group.n)}`]);
      expect(active(t)).toEqual(group.lines);
    }
    expect(ticket(board, schema).checklist.map((l) => [l.text, l.done])).toEqual([
      ['1.1 Add the vault schema', true],
      ['1.2 Add migrations with rollback', false],
      ['1.3 Seed data', false],
    ]);
    expect(ticket(board, api).checklist).toEqual([
      { text: '3.1 List vaults', done: false },
      { text: '3.2 Create vault', done: true },
      { text: '2.3 Delete vault', done: false, removed: true },
      { text: '3.3 Archive vault', done: false },
    ]);
    expect(ticket(board, ui)).toMatchObject({
      assignee: 'ui-dev',
      comments: [{ text: 'ui notes' }],
    });
    expect(ticket(board, docs)).toMatchObject({
      superseded: `group removed from ${PATH}`,
      title: 'Docs',
      checklist: [
        { text: '4.1 README', done: false },
        { text: '4.2 ADR', done: false },
      ],
    });
    expect(run(board).events).toBe(0);
  });
});

describe('modified "Import a change"', SLOW, () => {
  it('scenario: one ticket per group with titles, references, checklists and labels', () => {
    const groups: Group[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      n,
      title: `Group ${String(n)}`,
      lines: [`${String(n)}.1 Only task`],
    }));
    const { board, first } = imported(groups);
    expect(listTickets(board)).toHaveLength(9);
    for (const g of groups) {
      const t = entry(first, String(g.n)).ticket;
      expect(t).toMatchObject({
        title: g.title,
        task: { source: 'openspec', ref: CHANGE, item: String(g.n) },
        labels: [`change:${CHANGE}`, `group:${String(g.n)}`],
        checklist: [{ text: `${String(g.n)}.1 Only task`, done: false }],
        superseded: null,
      });
    }
    expect(first.dryRun).toBe(false);
    expect(first.ambiguous).toEqual([]);
  });

  it('scenario: a fully ticked group imports as merged', () => {
    const { first } = imported([{ n: 1, title: 'Done', lines: ['x 1.1 a', 'x 1.2 b'] }]);
    expect(entry(first, '1').ticket?.status).toBe('merged');
  });
});
