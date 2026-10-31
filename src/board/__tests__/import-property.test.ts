/**
 * Property: group edits never move work (add-claim-leases task 8.2;
 * board-concurrency: "Re-import is idempotent", scenario "Property: group
 * edits never move work"; board-openspec-integration: "Pair tickets to
 * groups by identity").
 *
 * A model change of three to five groups, each with a true identity, is
 * imported onto a real board; random tickets get a claim, a comment and a
 * tick of their first line. Then random steps insert, delete, reorder,
 * rename and partly reword groups (one change per step, so every group
 * keeps either its title or its lines, as the pairing rules require to
 * recognise it), or split a group into two halves, and the change is
 * re-imported after each step. After every step:
 * - each paired ticket stands for the group with its own true identity,
 *   and each superseded ticket's group is truly gone;
 * - every live group has exactly one ticket;
 * - claims, comments and ticks stay on their ticket;
 * - an ambiguous step (a split into equal halves) writes no event;
 * - a second re-import of the same file writes nothing.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { openBoard, type Board } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { claimTicket, commentTicket, setChecklistItem } from '../actions.js';
import { ImportRefusedError, importChange, type ImportResult } from '../import.js';
import { listTickets } from '../tickets.js';
import { eventCount, makeBoardDir, tempDir } from './helpers.js';

const CHANGE = 'prop-change';
const TARGET = { source: 'openspec', ref: CHANGE };
const PROPERTY_TIMEOUT_MS = 300_000;

/** A group of the model: its true identity, title and lines (texts without numbers). */
interface ModelGroup {
  identity: number;
  title: string;
  lines: string[];
}

type Step =
  | { op: 'insert'; at: number }
  | { op: 'delete'; at: number }
  | { op: 'move'; from: number; to: number }
  | { op: 'rename'; at: number }
  | { op: 'reword'; at: number; line: number }
  | { op: 'split'; at: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ op: fc.constant('insert' as const), at: fc.nat(10) }),
  fc.record({ op: fc.constant('delete' as const), at: fc.nat(10) }),
  fc.record({ op: fc.constant('move' as const), from: fc.nat(10), to: fc.nat(10) }),
  fc.record({ op: fc.constant('rename' as const), at: fc.nat(10) }),
  fc.record({ op: fc.constant('reword' as const), at: fc.nat(10), line: fc.nat(10) }),
  fc.record({ op: fc.constant('split' as const), at: fc.nat(10) }),
);

const scenarioArb = fc.record({
  sizes: fc.array(fc.integer({ min: 3, max: 4 }), { minLength: 3, maxLength: 5 }),
  worked: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
  steps: fc.array(stepArb, { minLength: 1, maxLength: 4 }),
});

/** Fresh words, so no two lines or titles ever coincide by accident. */
class Fresh {
  private n = 0;

  next(prefix: string): string {
    this.n += 1;
    return `${prefix} ${String(this.n)}x`;
  }
}

/** The tasks file of `groups`, numbered by position; lines numbered `<n>.<k>`. */
function tasksText(groups: readonly ModelGroup[]): string {
  const out = ['# Tasks', ''];
  groups.forEach((g, i) => {
    const n = i + 1;
    out.push(`## ${String(n)}. ${g.title}`, '');
    g.lines.forEach((line, k) => {
      out.push(`- [ ] ${String(n)}.${String(k + 1)} ${line}`);
    });
    out.push('');
  });
  return out.join('\n');
}

function writeTasks(root: string, groups: readonly ModelGroup[]): void {
  mkdirSync(join(root, 'openspec', 'changes', CHANGE), { recursive: true });
  writeFileSync(join(root, 'openspec', 'changes', CHANGE, 'tasks.md'), tasksText(groups));
}

/** Applies `step` to a copy of `groups`; returns null when it does not apply. */
function apply(
  groups: readonly ModelGroup[],
  step: Step,
  fresh: Fresh,
  identities: { next: number },
): ModelGroup[] | null {
  const out = groups.map((g) => ({ ...g, lines: [...g.lines] }));
  const pick = (at: number): number => at % out.length;
  switch (step.op) {
    case 'insert': {
      const identity = identities.next;
      identities.next += 1;
      out.splice(step.at % (out.length + 1), 0, {
        identity,
        title: fresh.next('Inserted'),
        lines: [fresh.next('new a'), fresh.next('new b'), fresh.next('new c')],
      });
      return out;
    }
    case 'delete':
      if (out.length <= 1) {
        return null;
      }
      out.splice(pick(step.at), 1);
      return out;
    case 'move': {
      const [moved] = out.splice(pick(step.from), 1);
      if (moved === undefined) {
        return null;
      }
      out.splice(step.to % (out.length + 1), 0, moved);
      return out;
    }
    case 'rename': {
      const g = out[pick(step.at)];
      if (g === undefined) {
        return null;
      }
      g.title = fresh.next('Renamed');
      return out;
    }
    case 'reword': {
      // Any line but the first (the ticked one), so the guard never blocks
      // and the group keeps most of its lines.
      const g = out[pick(step.at)];
      if (g === undefined || g.lines.length < 2) {
        return null;
      }
      g.lines[1 + (step.line % (g.lines.length - 1))] = fresh.next('reworded');
      return out;
    }
    case 'split': {
      const at = pick(step.at);
      const g = out[at];
      if (g === undefined || g.lines.length !== 4) {
        return null;
      }
      const halves = [g.lines.slice(0, 2), g.lines.slice(2)].map((lines) => {
        const identity = identities.next;
        identities.next += 1;
        return { identity, title: fresh.next('Half'), lines };
      });
      out.splice(at, 1, ...halves);
      return out;
    }
  }
}

/** What was attached to a worked ticket. */
interface Work {
  assignee: string;
  comment: string;
}

function check(
  board: Board,
  result: ImportResult,
  groups: readonly ModelGroup[],
  identityOf: Map<string, number>,
  work: Map<string, Work>,
): void {
  const live = new Set(groups.map((g) => g.identity));
  // Each group has exactly one entry, in file order, with a ticket.
  expect(result.tickets.filter((t) => t.item !== null).map((t) => t.item)).toEqual(
    groups.map((_, i) => String(i + 1)),
  );
  for (const entry of result.tickets) {
    const id = entry.id;
    expect(id).not.toBeNull();
    if (id === null) {
      continue;
    }
    if (entry.action === 'created') {
      const group = groups[Number(entry.item) - 1];
      identityOf.set(id, group?.identity ?? -1);
      continue;
    }
    const identity = identityOf.get(id);
    if (entry.action === 'superseded') {
      expect(live.has(identity ?? -1), `superseded ${id} but its group is live`).toBe(false);
    } else {
      const group = groups[Number(entry.item) - 1];
      expect(identity, `ticket ${id} paired with group ${String(entry.item)}`).toBe(
        group?.identity,
      );
    }
  }
  // Work stays with its ticket.
  const tickets = listTickets(board, { closed: true });
  for (const [id, w] of work) {
    const t = tickets.find((x) => x.id === id);
    expect(t?.assignee).toBe(w.assignee);
    expect(t?.comments.map((c) => c.text)).toEqual([w.comment]);
    expect(t?.checklist[0]?.done).toBe(true);
  }
  // Every live group has exactly one ticket that is not superseded.
  const open = tickets.filter((t) => t.superseded === null && t.task?.ref === CHANGE);
  expect(open.map((t) => identityOf.get(t.id)).sort()).toEqual([...live].sort());
}

describe('property: group edits never move work', () => {
  it(
    'keeps every ticket with its true group through random edits, and a second import writes nothing',
    { timeout: PROPERTY_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(scenarioArb, ({ sizes, worked, steps }) => {
          const root = tempDir();
          const board = openBoard(makeBoardDir(root));
          try {
            const fresh = new Fresh();
            const identities = { next: sizes.length };
            let groups: ModelGroup[] = sizes.map((size, identity) => ({
              identity,
              title: fresh.next('Group'),
              lines: Array.from({ length: size }, () => fresh.next('task')),
            }));
            writeTasks(root, groups);
            const first = importChange(board, 'orch', TARGET);
            const identityOf = new Map<string, number>();
            const work = new Map<string, Work>();
            first.tickets.forEach((entry, i) => {
              if (entry.id !== null) {
                identityOf.set(entry.id, i);
                if (worked[i] === true) {
                  const w = { assignee: `agent-${String(i)}`, comment: `work on ${String(i)}` };
                  claimTicket(board, w.assignee, { id: entry.id });
                  commentTicket(board, w.assignee, { id: entry.id, text: w.comment });
                  setChecklistItem(board, w.assignee, { id: entry.id, index: 0, done: true });
                  work.set(entry.id, w);
                }
              }
            });
            for (const step of steps) {
              const next = apply(groups, step, fresh, identities);
              if (next === null) {
                continue;
              }
              writeTasks(root, next);
              const before = eventCount(board);
              let result: ImportResult;
              try {
                result = importChange(board, 'orch', TARGET);
              } catch (error) {
                if (error instanceof BoardError && error.reason === 'reconcile-ambiguous') {
                  expect(error).toBeInstanceOf(ImportRefusedError);
                  expect(step.op).toBe('split');
                  expect(eventCount(board)).toBe(before);
                  // The step is abandoned: the tasks file goes back.
                  writeTasks(root, groups);
                  continue;
                }
                throw error;
              }
              groups = next;
              check(board, result, groups, identityOf, work);
              const again = importChange(board, 'orch', TARGET);
              expect(again.events).toBe(0);
              expect(eventCount(board)).toBe(before + result.events);
            }
          } finally {
            board.close();
            rmSync(root, { recursive: true, force: true });
          }
        }),
        { numRuns: 25 },
      );
    },
  );
});
