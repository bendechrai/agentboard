/**
 * The pure parts of re-import (add-claim-leases tasks 8.2 and 8.3;
 * board-openspec-integration: "Pair tickets to groups by identity",
 * "Reconcile on re-import"): normalisation, task numbers, scores, the three
 * pairing passes with their threshold and margin, the renumber plan, the
 * reconcile diff and its guard. Expected values are worked out by hand.
 */

import { describe, expect, it } from 'vitest';

import type { ChecklistItem, Ticket } from '../../events/fold.js';
import type { Status } from '../../events/schema.js';
import {
  PAIR_MARGIN,
  PAIR_THRESHOLD,
  compareItems,
  jaccard,
  normaliseTaskLine,
  normaliseTitle,
  pairTickets,
  reconcileDiff,
  reconcileGuard,
  reconcileSource,
  renumberPlan,
  taskNumber,
  type PairingTicket,
  type ReconcileDiff,
} from '../import.js';
import type { TaskUnit } from '../sources.js';

let nextId = 0;

/** A ticket of change `add-x` with item `item`, title and active lines. */
function ticket(
  item: string,
  title: string,
  lines: readonly (string | ChecklistItem)[],
  id?: string,
): PairingTicket {
  nextId += 1;
  return {
    id: id ?? `T${String(nextId).padStart(3, '0')}`,
    title,
    task: { source: 'openspec', ref: 'add-x', item },
    checklist: lines.map((l) => (typeof l === 'string' ? { text: l, done: false } : l)),
  };
}

/** A task group; lines are `[x] text` when they start with `x `. */
function unit(item: string, title: string, lines: readonly string[]): TaskUnit {
  return {
    item,
    title,
    line: 1,
    lines: lines.map((text, i) =>
      text.startsWith('x ')
        ? { text: text.slice(2), done: true, line: i + 2 }
        : { text, done: false, line: i + 2 },
    ),
  };
}

/** Lines `<n>.1 <w>` ... for each word, as a group or ticket would hold them. */
function numbered(n: number, words: readonly string[]): string[] {
  return words.map((w, i) => `${String(n)}.${String(i + 1)} ${w}`);
}

describe('constants', () => {
  it('pins the threshold and margin of the spec', () => {
    expect(PAIR_THRESHOLD).toBe(0.5);
    expect(PAIR_MARGIN).toBe(0.2);
  });
});

describe('normaliseTitle', () => {
  it.each([
    ['CLI core commands', 'cli core commands'],
    [
      'Re-import reconciliation (`openspec/reconcile-import`)',
      're import reconciliation openspec reconcile import',
    ],
    ['3. CLI core', 'cli core'],
    ['5 Docs', 'docs'],
    ['5.Docs', '5 docs'],
    ['1.2.3 Sub task', 'sub task'],
    ['  Lease,  queue & grants!  ', 'lease queue grants'],
    ['Events, canonical JSON and fold (pure, no IO)', 'events canonical json and fold pure no io'],
    [`${String.fromCharCode(0xdc)}ber caf${String.fromCharCode(0xe9)}`, 'ber caf'],
    ['2026', '2026'],
    ['', ''],
  ])('%j is %j', (text, expected) => {
    expect(normaliseTitle(text)).toBe(expected);
  });
});

describe('normaliseTaskLine', () => {
  it.each([
    ['- [x] 1.2 Add B, with retries', 'add b with retries'],
    ['3.4 add b with retries', 'add b with retries'],
    ['- [ ] Write docs', 'write docs'],
    ['- [X] 10.11 Foo-bar', 'foo bar'],
    ['1.1 Implement `canonical.ts` (sorted keys)', 'implement canonical ts sorted keys'],
  ])('%j is %j', (text, expected) => {
    expect(normaliseTaskLine(text)).toBe(expected);
  });
});

describe('taskNumber', () => {
  it.each([
    ['1.2 Add B', '1.2'],
    ['1.2. Add B', '1.2'],
    ['1.2.3 Sub', '1.2.3'],
    ['10.11 Foo', '10.11'],
    ['1.2', '1.2'],
    ['12 Add', null],
    ['Add 1.2', null],
    ['1.2a Add', null],
    ['v1.2 Add', null],
  ])('%j is %j', (text, expected) => {
    expect(taskNumber(text)).toBe(expected);
  });
});

describe('jaccard', () => {
  it.each([
    [['a', 'b'], ['b', 'c'], 1 / 3],
    [['a', 'b'], ['a', 'b'], 1],
    [['a', 'a', 'b'], ['b', 'a'], 1],
    [['a'], ['b'], 0],
    [[], ['b'], 0],
    [[], [], 0],
    [['a', 'b', 'c', 'd'], ['a', 'b'], 0.5],
  ])('%j and %j score %d', (a, b, score) => {
    expect(jaccard(a, b)).toBeCloseTo(score, 12);
    expect(jaccard(b, a)).toBeCloseTo(score, 12);
  });
});

describe('compareItems', () => {
  it.each([
    ['2', '10', -1],
    ['10', '9', 1],
    ['3', '3', 0],
    ['9', 'a', -1],
    ['b', '9', 1],
    ['a', 'b', -1],
  ] as const)('%s against %s is %d', (a, b, expected) => {
    expect(compareItems(a, b)).toBe(expected);
  });
});

describe('pairTickets: the title pass', () => {
  it('scenario: reordered groups are paired by title', () => {
    const beta = ticket('2', 'Beta', numbered(2, ['one', 'two']));
    const gamma = ticket('3', 'Gamma', numbered(3, ['three', 'four']));
    const report = pairTickets(
      [beta, gamma],
      [
        unit('2', 'Gamma', numbered(2, ['three', 'four'])),
        unit('3', 'Beta', numbered(3, ['one', 'two'])),
      ],
    );
    expect(report).toEqual({
      pairs: [
        { ticket: gamma.id, item: '2', pass: 'title', score: 1 },
        { ticket: beta.id, item: '3', pass: 'title', score: 1 },
      ],
      newGroups: [],
      unpaired: [],
      ambiguous: [],
    });
  });

  it('compares normalised titles, and scores lines even when paired by title', () => {
    const t = ticket('1', 'CLI: core commands!', ['1.1 a', '1.2 b']);
    const report = pairTickets([t], [unit('1', 'cli core   commands', ['1.1 a', '1.2 c'])]);
    expect(report.pairs).toEqual([{ ticket: t.id, item: '1', pass: 'title', score: 1 / 3 }]);
  });

  it('skips a title shared by two tickets, leaving the content pass to decide', () => {
    const docsA = ticket('7', 'Docs', numbered(7, ['readme', 'adr']));
    const docsB = ticket('8', 'Docs', numbered(8, ['site', 'blog']));
    const report = pairTickets([docsA, docsB], [unit('5', 'Docs', numbered(5, ['readme', 'adr']))]);
    expect(report.pairs).toEqual([{ ticket: docsA.id, item: '5', pass: 'content', score: 1 }]);
    expect(report.unpaired).toEqual([docsB.id]);
    expect(report.ambiguous).toEqual([]);
  });

  it('skips a title shared by two groups', () => {
    const t = ticket('1', 'Docs', ['1.1 a', '1.2 b']);
    const report = pairTickets(
      [t],
      [unit('1', 'Docs', ['1.1 a', '1.2 b']), unit('2', 'Docs', ['2.1 x'])],
    );
    expect(report.pairs).toEqual([{ ticket: t.id, item: '1', pass: 'content', score: 1 }]);
    expect(report.newGroups).toEqual(['2']);
  });

  it('is ambiguous when tickets tie on a title nothing else decides', () => {
    const a = ticket('7', 'Docs', ['7.1 x']);
    const b = ticket('8', 'Docs', ['8.1 y']);
    const report = pairTickets([a, b], [unit('5', 'Docs', ['5.1 z'])]);
    expect(report.pairs).toEqual([]);
    expect(report.ambiguous).toEqual([
      { ticket: a.id, item: '5', score: 0, sameTitle: true },
      { ticket: b.id, item: '5', score: 0, sameTitle: true },
    ]);
  });
});

describe('pairTickets: the content pass', () => {
  it('scenario: a renamed group keeping four of its five lines is paired by content', () => {
    const t = ticket('4', 'Old name', numbered(4, ['a', 'b', 'c', 'd', 'e']));
    const other = ticket('1', 'Unrelated', numbered(1, ['p', 'q']));
    const report = pairTickets(
      [other, t],
      [
        unit('1', 'Unrelated', numbered(1, ['p', 'q'])),
        unit('4', 'New name', numbered(4, ['a', 'b', 'c', 'd', 'f'])),
      ],
    );
    expect(report.pairs).toEqual([
      { ticket: other.id, item: '1', pass: 'title', score: 1 },
      { ticket: t.id, item: '4', pass: 'content', score: 4 / 6 },
    ]);
  });

  it('ignores task numbers, checkboxes and case in lines, and removed lines', () => {
    const t = ticket('9', 'Old', [
      '9.1 Add A',
      { text: '9.2 Gone line', done: true, removed: true },
      '9.3 add b',
    ]);
    const report = pairTickets([t], [unit('2', 'New', ['2.1 add a', 'x 2.2 Add B'])]);
    expect(report.pairs).toEqual([{ ticket: t.id, item: '2', pass: 'content', score: 1 }]);
  });

  it('pairs at exactly the threshold', () => {
    const t = ticket('1', 'Old', ['a', 'b', 'c', 'd']);
    // {a,b,c,d} against {a,b}: 2 shared of 4.
    const report = pairTickets([t], [unit('6', 'New', ['a', 'b'])]);
    expect(report.pairs).toEqual([{ ticket: t.id, item: '6', pass: 'content', score: 0.5 }]);
  });

  it('does not pair by content below the threshold', () => {
    const t = ticket('1', 'Old', ['a', 'b', 'c']);
    // {a,b,c} against {a,x,y}: 1 shared of 5 = 0.2; not by content, and the
    // number pass sees no other candidate, so it pairs by number.
    const report = pairTickets([t], [unit('1', 'New', ['a', 'x', 'y'])]);
    expect(report.pairs).toEqual([{ ticket: t.id, item: '1', pass: 'number', score: 0.2 }]);
  });

  it('meets the margin at exactly 0.2 (0.7 against 0.5, compared exactly)', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const t = ticket('3', 'Old', words);
    const report = pairTickets(
      [t],
      [unit('3', 'First half', words.slice(0, 7)), unit('4', 'Second half', words.slice(0, 5))],
    );
    expect(report.pairs).toEqual([{ ticket: t.id, item: '3', pass: 'content', score: 0.7 }]);
    expect(report.newGroups).toEqual(['4']);
    expect(report.ambiguous).toEqual([]);
  });

  it('is ambiguous when the margin is not met from the ticket side (0.7 against 0.6)', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const t = ticket('3', 'Old', words);
    const report = pairTickets(
      [t],
      [unit('3', 'One', words.slice(0, 7)), unit('4', 'Two', words.slice(0, 6))],
    );
    expect(report.pairs).toEqual([]);
    expect(report.ambiguous).toEqual([
      { ticket: t.id, item: '3', score: 0.7, sameTitle: false },
      { ticket: t.id, item: '4', score: 0.6, sameTitle: false },
    ]);
  });

  it('is ambiguous when the margin is not met from the group side', () => {
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const t1 = ticket('3', 'One', words.slice(0, 7));
    const t2 = ticket('4', 'Two', words.slice(0, 6));
    const report = pairTickets([t1, t2], [unit('3', 'All', words)]);
    expect(report.pairs).toEqual([]);
    expect(report.ambiguous).toEqual([
      { ticket: t1.id, item: '3', score: 0.7, sameTitle: false },
      { ticket: t2.id, item: '3', score: 0.6, sameTitle: false },
    ]);
  });

  it('scenario: a group split into two halves is ambiguous', () => {
    const t = ticket('2', 'Store', numbered(2, ['reads', 'writes', 'locks', 'files']));
    const report = pairTickets(
      [t],
      [
        unit('2', 'Store reads', numbered(2, ['reads', 'writes'])),
        unit('3', 'Store writes', numbered(3, ['locks', 'files'])),
      ],
    );
    expect(report.ambiguous).toEqual([
      { ticket: t.id, item: '2', score: 0.5, sameTitle: false },
      { ticket: t.id, item: '3', score: 0.5, sameTitle: false },
    ]);
    expect(report.pairs).toEqual([]);
  });

  it('lists every candidate scoring at least the margin when ambiguous', () => {
    const t = ticket('2', 'Store', ['a', 'b', 'c', 'd']);
    const u = ticket('5', 'Unrelated', ['z']);
    const report = pairTickets(
      [t, u],
      [unit('2', 'X', ['a', 'b']), unit('3', 'Y', ['c', 'd']), unit('4', 'Z', ['a', 'q', 'r'])],
    );
    // t against 4: {a} of {a,b,c,d,q,r} = 1/6, below the margin: not listed.
    expect(report.ambiguous).toEqual([
      { ticket: t.id, item: '2', score: 0.5, sameTitle: false },
      { ticket: t.id, item: '3', score: 0.5, sameTitle: false },
    ]);
  });
});

describe('pairTickets: the number pass', () => {
  it('scenario: a group renamed with every line reworded is paired by number', () => {
    const t = ticket('3', 'Old title', numbered(3, ['alpha', 'beta']));
    const other = ticket('1', 'Kept', numbered(1, ['k']));
    const report = pairTickets(
      [other, t],
      [
        unit('1', 'Kept', numbered(1, ['k'])),
        unit('3', 'New title', numbered(3, ['gamma', 'delta'])),
      ],
    );
    expect(report.pairs).toEqual([
      { ticket: other.id, item: '1', pass: 'title', score: 1 },
      { ticket: t.id, item: '3', pass: 'number', score: 0 },
    ]);
  });

  it('does not pair by number when another group scores 0.2 or more against the ticket', () => {
    const t = ticket('3', 'Old', ['a', 'b', 'c', 'd', 'e']);
    // t against 4: {a,b} of {a,b,c,d,e,x} = 1/3.
    const report = pairTickets(
      [t],
      [unit('3', 'New', ['p', 'q']), unit('4', 'Other', ['a', 'b', 'x'])],
    );
    expect(report).toEqual({ pairs: [], newGroups: ['3', '4'], unpaired: [t.id], ambiguous: [] });
  });

  it('does not pair by number when another ticket scores 0.2 or more against the group', () => {
    const t = ticket('3', 'Old', ['p']);
    const u = ticket('9', 'Elsewhere', ['a', 'b', 'x']);
    const report = pairTickets([t, u], [unit('3', 'New', ['a', 'b', 'c', 'd', 'e'])]);
    expect(report.pairs).toEqual([]);
    expect(report.unpaired).toEqual([t.id, u.id]);
  });

  it('does not pair by number when two tickets have the item', () => {
    const a = ticket('3', 'One', ['p']);
    const b = ticket('3', 'Two', ['q']);
    const report = pairTickets([a, b], [unit('3', 'Three', ['r'])]);
    expect(report).toEqual({ pairs: [], newGroups: ['3'], unpaired: [a.id, b.id], ambiguous: [] });
  });

  it('never pairs a ticket by number alone when its number now names another group', () => {
    // Group 3 was deleted and group 4 moved up to 3: the old ticket 3 must
    // not take group 4's work.
    const three = ticket('3', 'Removed group', numbered(3, ['x', 'y']));
    const four = ticket('4', 'Moved group', numbered(4, ['m', 'n']));
    const report = pairTickets([three, four], [unit('3', 'Moved group', numbered(3, ['m', 'n']))]);
    expect(report.pairs).toEqual([{ ticket: four.id, item: '3', pass: 'title', score: 1 }]);
    expect(report.unpaired).toEqual([three.id]);
  });
});

describe('pairTickets: new groups and unpaired tickets', () => {
  it('scenario: an inserted group (5 to 7 become 6 to 8) moves nothing', () => {
    const titles = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
    const tickets = titles.map((title, i) =>
      ticket(String(i + 1), title, numbered(i + 1, [`${title} a`, `${title} b`])),
    );
    const units = [
      ...titles
        .slice(0, 4)
        .map((title, i) =>
          unit(String(i + 1), title, numbered(i + 1, [`${title} a`, `${title} b`])),
        ),
      unit('5', 'Inserted', numbered(5, ['new a', 'new b'])),
      ...titles
        .slice(4)
        .map((title, i) =>
          unit(String(i + 6), title, numbered(i + 6, [`${title} a`, `${title} b`])),
        ),
    ];
    const report = pairTickets(tickets, units);
    expect(report.pairs.map((p) => [p.ticket, p.item, p.pass])).toEqual([
      [tickets[0]?.id, '1', 'title'],
      [tickets[1]?.id, '2', 'title'],
      [tickets[2]?.id, '3', 'title'],
      [tickets[3]?.id, '4', 'title'],
      [tickets[4]?.id, '6', 'title'],
      [tickets[5]?.id, '7', 'title'],
      [tickets[6]?.id, '8', 'title'],
    ]);
    expect(report.newGroups).toEqual(['5']);
    expect(report.unpaired).toEqual([]);
    expect(renumberPlan(tickets, report.pairs)).toEqual([
      { ticket: tickets[4]?.id, from: '5', to: '6' },
      { ticket: tickets[5]?.id, from: '6', to: '7' },
      { ticket: tickets[6]?.id, from: '7', to: '8' },
    ]);
  });

  it('lists unpaired tickets in input order and new groups in file order', () => {
    const a = ticket('1', 'A', ['1.1 a']);
    const b = ticket('2', 'B', ['2.1 b']);
    const report = pairTickets(
      [b, a],
      [unit('1', 'C', ['1.1 c']), unit('2', 'D', ['2.1 d']), unit('3', 'E', ['3.1 e'])],
    );
    // Every pair would be by number: 1 with 1 and 2 with 2 (no candidate scores).
    expect(report.pairs.map((p) => [p.ticket, p.item, p.pass])).toEqual([
      [a.id, '1', 'number'],
      [b.id, '2', 'number'],
    ]);
    expect(report.newGroups).toEqual(['3']);
    const none = pairTickets([b, a], []);
    expect(none.unpaired).toEqual([b.id, a.id]);
  });

  it('pairs nothing for no tickets', () => {
    expect(pairTickets([], [unit('1', 'A', [])])).toEqual({
      pairs: [],
      newGroups: ['1'],
      unpaired: [],
      ambiguous: [],
    });
  });
});

describe('renumberPlan', () => {
  it('orders renumbers by ascending old number, numerically', () => {
    const nine = ticket('9', 'Nine', []);
    const ten = ticket('10', 'Ten', []);
    const two = ticket('2', 'Two', []);
    const plan = renumberPlan(
      [ten, nine, two],
      [
        { ticket: ten.id, item: '11', pass: 'title', score: 0 },
        { ticket: two.id, item: '2', pass: 'title', score: 0 },
        { ticket: nine.id, item: '10', pass: 'title', score: 0 },
      ],
    );
    expect(plan).toEqual([
      { ticket: nine.id, from: '9', to: '10' },
      { ticket: ten.id, from: '10', to: '11' },
    ]);
  });

  it('swaps without a temporary number', () => {
    const two = ticket('2', 'Two', []);
    const three = ticket('3', 'Three', []);
    expect(
      renumberPlan(
        [three, two],
        [
          { ticket: three.id, item: '2', pass: 'title', score: 1 },
          { ticket: two.id, item: '3', pass: 'title', score: 1 },
        ],
      ),
    ).toEqual([
      { ticket: two.id, from: '2', to: '3' },
      { ticket: three.id, from: '3', to: '2' },
    ]);
  });
});

/** A ticket for the diff and the guard. */
function full(
  lines: readonly ChecklistItem[],
  extra: { title?: string; status?: Status; assignee?: string | null } = {},
): Pick<Ticket, 'title' | 'checklist' | 'status' | 'assignee'> {
  return {
    title: extra.title ?? 'Group title',
    checklist: lines.map((l) => ({ ...l })),
    status: extra.status ?? 'todo',
    assignee: extra.assignee ?? null,
  };
}

const L = (text: string, done = false): ChecklistItem => ({ text, done });
const removed = (text: string, done = false): ChecklistItem => ({ text, done, removed: true });

describe('reconcileDiff', () => {
  it('scenario: a revised tasks file reconciles', () => {
    const t = full([L('1.1 Add A', true), L('1.2 Add B'), L('1.3 Add C')], { title: 'Old' });
    expect(
      reconcileDiff(
        t,
        unit('1', 'New title', ['1.1 Add A', '1.2 Add B with retries', '1.4 Add D']),
      ),
    ).toEqual({
      title: 'New title',
      updated: [{ index: 1, text: '1.2 Add B with retries', done: false }],
      removed: [2],
      added: [{ text: '1.4 Add D', done: false }],
    });
  });

  it('scenario: a renumbered line matches by text and keeps its done flag', () => {
    const t = full([L('2.1 Plan'), L('2.3 Write the ADR', true)]);
    expect(reconcileDiff(t, unit('2', 'Group title', ['2.1 Plan', '2.2 Write the ADR']))).toEqual({
      title: null,
      updated: [{ index: 1, text: '2.2 Write the ADR', done: true }],
      removed: [],
      added: [],
    });
  });

  it('scenario: an unchanged group gives null', () => {
    const t = full([L('1.1 A', true), L('1.2 B')]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['x 1.1 A', '1.2 B']))).toBeNull();
  });

  it("keeps the board's done flag for unchanged text, whatever the checkbox says", () => {
    const t = full([L('1.1 A', true), L('1.2 B', false)]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.1 A', 'x 1.2 B']))).toBeNull();
  });

  it('takes the checkbox for a reworded line', () => {
    const t = full([L('1.1 A', true), L('1.2 B', false)]);
    expect(
      reconcileDiff(t, unit('1', 'Group title', ['1.1 A reworded', 'x 1.2 B reworded'])),
    ).toEqual({
      title: null,
      updated: [
        { index: 0, text: '1.1 A reworded', done: false },
        { index: 1, text: '1.2 B reworded', done: true },
      ],
      removed: [],
      added: [],
    });
  });

  it('keeps the checklist order for a reordered tasks file', () => {
    const t = full([L('1.1 A'), L('1.2 B')]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.2 B', '1.1 A']))).toBeNull();
  });

  it('appends added lines in file order and lists removals ascending', () => {
    const t = full([L('1.1 A'), L('1.2 B'), L('1.3 C')]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.9 Z', '1.2 B', '1.8 Y']))).toEqual({
      title: null,
      updated: [],
      removed: [0, 2],
      added: [
        { text: '1.9 Z', done: false },
        { text: '1.8 Y', done: false },
      ],
    });
  });

  it('never matches, updates or removes a removed line again', () => {
    const t = full([L('1.1 A'), removed('1.2 B', true)]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.1 A']))).toBeNull();
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.1 A', '1.2 B']))).toEqual({
      title: null,
      updated: [],
      removed: [],
      added: [{ text: '1.2 B', done: false }],
    });
  });

  it('matches lines without a number by their whole text', () => {
    const t = full([L('Write docs', true), L('Ship it')]);
    expect(
      reconcileDiff(t, unit('1', 'Group title', ['Ship it', 'Write docs', 'Celebrate'])),
    ).toEqual({
      title: null,
      updated: [],
      removed: [],
      added: [{ text: 'Celebrate', done: false }],
    });
  });

  it('matches repeated numbers in order, k-th with k-th', () => {
    const t = full([L('1.1 A'), L('1.1 B')]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.1 A', '1.1 C']))).toEqual({
      title: null,
      updated: [{ index: 1, text: '1.1 C', done: false }],
      removed: [],
      added: [],
    });
  });

  it('compares the text pass exactly (case matters)', () => {
    const t = full([L('1.1 add a', true)]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.5 Add A']))).toEqual({
      title: null,
      updated: [],
      removed: [0],
      added: [{ text: '1.5 Add A', done: false }],
    });
  });

  it('matches by number before text, so a reworded line keeps its index', () => {
    const t = full([L('3.1 Old wording'), L('3.2 Other')]);
    expect(reconcileDiff(t, unit('3', 'Group title', ['3.1 New wording', '3.2 Other']))).toEqual({
      title: null,
      updated: [{ index: 0, text: '3.1 New wording', done: false }],
      removed: [],
      added: [],
    });
  });

  it('gives only the title when only the title changed', () => {
    const t = full([L('1.1 A')], { title: 'Old' });
    expect(reconcileDiff(t, unit('1', 'New', ['1.1 A']))).toEqual({
      title: 'New',
      updated: [],
      removed: [],
      added: [],
    });
  });
});

describe('reconcileGuard', () => {
  const diff = (over: Partial<ReconcileDiff>): ReconcileDiff => ({
    title: null,
    updated: [],
    removed: [],
    added: [],
    ...over,
  });

  it('scenario: removing a done line is blocked', () => {
    const t = full([L('1.1 A', true), L('1.2 B')]);
    expect(reconcileGuard(t, diff({ removed: [0] }))).toEqual([
      { index: 0, text: '1.1 A', change: 'removed', reason: 'done' },
    ]);
  });

  it('rewording a done line is blocked', () => {
    const t = full([L('1.1 A', true)]);
    expect(
      reconcileGuard(t, diff({ updated: [{ index: 0, text: '1.1 A again', done: false }] })),
    ).toEqual([{ index: 0, text: '1.1 A', change: 'updated', reason: 'done' }]);
  });

  it('renumbering a done line is not blocked', () => {
    const t = full([L('2.3 Write the ADR', true)], { status: 'implementing', assignee: 'impl' });
    expect(
      reconcileGuard(t, diff({ updated: [{ index: 0, text: '2.2 Write the ADR', done: true }] })),
    ).toEqual([]);
  });

  it.each(['tests', 'implementing', 'review'] as const)(
    'scenario: rewording a line of a ticket held in %s is blocked',
    (status) => {
      const t = full([L('1.1 A'), L('1.2 B')], { status, assignee: 'impl' });
      expect(
        reconcileGuard(
          t,
          diff({ updated: [{ index: 1, text: '1.2 B reworded', done: false }], removed: [0] }),
        ),
      ).toEqual([
        { index: 0, text: '1.1 A', change: 'removed', reason: 'held' },
        { index: 1, text: '1.2 B', change: 'updated', reason: 'held' },
      ]);
    },
  );

  it.each<[string, Status, string | null]>([
    ['assigned in todo', 'todo', 'impl'],
    ['assigned in merged', 'merged', 'impl'],
    ['assigned in blocked', 'blocked', 'impl'],
    ['unassigned in implementing', 'implementing', null],
  ])('does not block an undone line of a ticket %s', (_name, status, assignee) => {
    const t = full([L('1.1 A')], { status, assignee });
    expect(reconcileGuard(t, diff({ removed: [0] }))).toEqual([]);
  });

  it('scenario: a title change and additions are never blocked', () => {
    const t = full([L('1.1 A', true)], { status: 'implementing', assignee: 'impl' });
    expect(
      reconcileGuard(t, diff({ title: 'Renamed', added: [{ text: '1.2 B', done: false }] })),
    ).toEqual([]);
  });

  it('gives reason done for a done line of a held ticket', () => {
    const t = full([L('1.1 A', true)], { status: 'review', assignee: 'rev' });
    expect(reconcileGuard(t, diff({ removed: [0] }))).toEqual([
      { index: 0, text: '1.1 A', change: 'removed', reason: 'done' },
    ]);
  });
});

describe('reconcileSource', () => {
  it('names the tasks file and the SHA-256 of its bytes', () => {
    expect(reconcileSource('openspec/changes/x/tasks.md', new TextEncoder().encode('abc'))).toBe(
      'openspec/changes/x/tasks.md@sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('pairing and diff boundaries (review follow-up)', () => {
  /** `n` distinct words with a prefix. */
  const words = (prefix: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

  it('does not pair by content at 4/9 (below the threshold) when the number pass cannot', () => {
    const shared = words('s', 4);
    const t = ticket('1', 'Old', [...shared, ...words('t', 2)]);
    // {4 shared + 2} against {4 shared + 3}: 4 of 9.
    const report = pairTickets([t], [unit('2', 'New', [...shared, ...words('u', 3)])]);
    expect(report).toEqual({ pairs: [], newGroups: ['2'], unpaired: [t.id], ambiguous: [] });
  });

  it('does not pair by content at 24/49 (just below 0.5)', () => {
    const shared = words('s', 24);
    const t = ticket('1', 'Old', [...shared, ...words('t', 12)]);
    // 36 lines against 37: 24 shared of 49.
    const report = pairTickets([t], [unit('2', 'New', [...shared, ...words('u', 13)])]);
    expect(report.pairs).toEqual([]);
    expect(report.ambiguous).toEqual([]);
  });

  it('is ambiguous at a margin of 9/13 against 6/12 (0.19 apart)', () => {
    const tw = words('w', 10);
    const t = ticket('5', 'Old', tw);
    const report = pairTickets(
      [t],
      [
        unit('5', 'One', [...tw.slice(0, 9), ...words('x', 3)]),
        unit('6', 'Two', [...tw.slice(0, 6), ...words('y', 2)]),
      ],
    );
    expect(report.pairs).toEqual([]);
    expect(report.ambiguous).toEqual([
      { ticket: t.id, item: '5', score: 9 / 13, sameTitle: false },
      { ticket: t.id, item: '6', score: 0.5, sameTitle: false },
    ]);
  });

  it('pairs a case-only title change by normalised title, and the diff renames it', () => {
    const t = ticket('1', 'Docs', ['1.1 a']);
    expect(pairTickets([t], [unit('1', 'docs', ['1.1 a'])]).pairs).toEqual([
      { ticket: t.id, item: '1', pass: 'title', score: 1 },
    ]);
    expect(
      reconcileDiff(full([L('1.1 a')], { title: 'Docs' }), unit('1', 'docs', ['1.1 a'])),
    ).toEqual({ title: 'docs', updated: [], removed: [], added: [] });
  });

  it('matches by number before text: swapped texts are two rewordings, not a reorder', () => {
    const t = full([L('1.1 A', true), L('1.2 B')]);
    expect(reconcileDiff(t, unit('1', 'Group title', ['1.1 B', '1.2 A']))).toEqual({
      title: null,
      updated: [
        { index: 0, text: '1.1 B', done: false },
        { index: 1, text: '1.2 A', done: false },
      ],
      removed: [],
      added: [],
    });
  });
});
