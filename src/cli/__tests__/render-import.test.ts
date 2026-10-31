/**
 * Human output of re-import (add-claim-leases tasks 8.2 and 8.3): the
 * `superseded` marker in `list` and `show`, removed checklist lines in
 * `show`, and the `import-change` report (`renderImport`) with and without
 * `--dry-run`. Goldens are written out by hand.
 */

import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import type { ImportResult, ImportedTicket } from '../../board/import.js';
import { renderImport, renderListLine, renderShow } from '../render.js';

const ID = '01ARYZ6S41TSV4RRFFQ69G5FAV';
const ID2 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID3 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const TS = { wall: 1000, counter: 0, actor: 'orch' };
const PATH = 'openspec/changes/add-x/tasks.md';

function ticket(extra: Partial<Omit<Ticket, 'lease'>> = {}): Ticket & { lease: null } {
  return {
    id: ID,
    title: 'Build the CLI',
    description: null,
    status: 'todo',
    blockedFrom: null,
    assignee: null,
    lease: null,
    queue: [],
    available: null,
    labels: [],
    task: { source: 'openspec', ref: 'add-x', item: '3' },
    adhoc: null,
    unplanned: null,
    checklist: [],
    comments: [],
    links: [],
    closed: false,
    superseded: null,
    disposition: null,
    createdBy: 'orch',
    createdAt: TS,
    version: 1,
    updatedAt: TS,
    ...extra,
  };
}

function imported(extra: Partial<ImportedTicket> & Pick<ImportedTicket, 'action'>): ImportedTicket {
  return {
    item: '1',
    title: 'Build the CLI',
    id: ID,
    pairing: null,
    renumber: null,
    diff: null,
    blocked: [],
    forced: false,
    supersede: null,
    events: [],
    ticket: ticket(),
    ...extra,
  };
}

function result(tickets: ImportedTicket[], extra: Partial<ImportResult> = {}): ImportResult {
  return {
    source: 'openspec',
    ref: 'add-x',
    tasksFile: PATH,
    dryRun: false,
    tickets,
    ambiguous: [],
    events: tickets.reduce((sum, t) => sum + t.events.length, 0),
    ...extra,
  };
}

describe('the superseded marker', () => {
  it('list: [superseded] after the other markers', () => {
    expect(renderListLine(ticket({ superseded: 'gone' }))).toBe(
      `${ID}  todo  -  [superseded] Build the CLI`,
    );
    expect(
      renderListLine(
        ticket({
          superseded: 'gone',
          closed: true,
          status: 'merged',
          disposition: { noDecision: true },
        }),
      ),
    ).toBe(`${ID}  merged  -  [closed] [superseded] Build the CLI`);
    expect(renderListLine(ticket({ superseded: 'gone', task: null, adhoc: 'x' }))).toBe(
      `${ID}  todo  -  [adhoc] [superseded] Build the CLI`,
    );
    // The scope marker comes first ([unplanned] in place of [adhoc]), then
    // [closed], then [superseded].
    expect(
      renderListLine(
        ticket({
          superseded: 'gone',
          task: null,
          adhoc: 'x',
          unplanned: { reason: 'hotfix', actor: 'merger', ts: TS },
          closed: true,
          status: 'merged',
          disposition: { noDecision: true },
        }),
      ),
    ).toBe(`${ID}  merged  -  [unplanned] [closed] [superseded] Build the CLI`);
  });

  it('show: a superseded line after closed, only when superseded', () => {
    const lines = renderShow({
      ticket: ticket({ superseded: 'group removed from tasks.md' }),
      events: 2,
      unknown: [],
    }).split('\n');
    const at = lines.indexOf('superseded: group removed from tasks.md');
    expect(at).toBe(lines.indexOf('closed: no') + 1);
    expect(lines[at + 1]).toBe('events: 2');
    const plain = renderShow({ ticket: ticket(), events: 1, unknown: [] });
    expect(plain).not.toContain('superseded');
  });

  it('show: a removed line keeps its index and ends with (removed)', () => {
    const lines = renderShow({
      ticket: ticket({
        checklist: [
          { text: '1.1 A', done: true },
          { text: '1.2 B', done: true, removed: true },
          { text: '1.3 C', done: false },
        ],
      }),
      events: 3,
      unknown: [],
    }).split('\n');
    expect(lines).toContain('  [x] 0 1.1 A');
    expect(lines).toContain('  [x] 1 1.2 B (removed)');
    expect(lines).toContain('  [ ] 2 1.3 C');
  });
});

describe('renderImport', () => {
  it('keeps the first import output: one line per group and the summary', () => {
    const text = renderImport(
      result([
        imported({ action: 'created', events: ['a', 'b'] }),
        imported({
          action: 'created',
          item: '2',
          id: ID2,
          events: ['c'],
          ticket: ticket({ id: ID2, title: 'Two', status: 'merged' }),
        }),
      ]),
    );
    expect(text).toBe(
      [
        `created ${ID}  todo  -  Build the CLI`,
        `created ${ID2}  merged  -  Two`,
        'imported openspec:add-x: 2 created, 0 updated, 0 unchanged, 3 events',
        '',
      ].join('\n'),
    );
  });

  it('golden: a re-import with a renumber, a reconcile, a block, a force and a supersede', () => {
    const text = renderImport(
      result([
        imported({
          action: 'updated',
          item: '2',
          events: ['r1', 'r2'],
          renumber: { from: '1', to: '2' },
          pairing: { pass: 'title', score: 0.25 },
          diff: {
            title: 'New title',
            updated: [{ index: 1, text: '2.2 B again', done: true }],
            removed: [2],
            added: [{ text: '2.4 D', done: false }],
          },
          ticket: ticket({
            title: 'New title',
            checklist: [
              { text: '2.1 A', done: false },
              { text: '2.2 B again', done: true },
              { text: '1.3 C', done: false, removed: true },
              { text: '2.4 D', done: false },
            ],
          }),
        }),
        imported({
          action: 'blocked',
          item: '3',
          id: ID2,
          diff: { title: null, updated: [], removed: [0], added: [] },
          blocked: [{ index: 0, text: '3.1 Done line', change: 'removed', reason: 'done' }],
          ticket: ticket({
            id: ID2,
            title: 'Three',
            checklist: [{ text: '3.1 Done line', done: true }],
          }),
        }),
        imported({
          action: 'updated',
          item: '4',
          id: ID3,
          events: ['f1'],
          forced: true,
          diff: {
            title: null,
            updated: [{ index: 0, text: '4.1 Reworded', done: false }],
            removed: [],
            added: [],
          },
          blocked: [{ index: 0, text: '4.1 Worded', change: 'updated', reason: 'held' }],
          ticket: ticket({
            id: ID3,
            title: 'Four',
            status: 'implementing',
            assignee: 'impl',
            checklist: [{ text: '4.1 Reworded', done: false }],
          }),
        }),
        imported({
          action: 'superseded',
          item: null,
          id: '01C0000000ACTAV9WEVGEMMVRZ',
          title: 'Five',
          events: ['s1'],
          supersede: `group removed from ${PATH}`,
          ticket: ticket({
            id: '01C0000000ACTAV9WEVGEMMVRZ',
            title: 'Five',
            superseded: `group removed from ${PATH}`,
          }),
        }),
      ]),
    );
    expect(text).toBe(
      [
        `updated ${ID}  todo  -  New title`,
        '  renumbered from group 1 to 2',
        '  title: New title',
        '  updated [x] 1 2.2 B again',
        '  removed [ ] 2 1.3 C',
        '  added [ ] 2.4 D',
        `blocked ${ID2}  todo  -  Three`,
        '  removed [x] 0 3.1 Done line',
        '  blocked 0 3.1 Done line (done)',
        `updated ${ID3}  implementing  impl  Four`,
        '  updated [ ] 0 4.1 Reworded',
        '  blocked 0 4.1 Worded (held by impl in implementing)',
        '  forced',
        `superseded 01C0000000ACTAV9WEVGEMMVRZ  todo  -  [superseded] Five`,
        `  superseded: group removed from ${PATH}`,
        'imported openspec:add-x: 0 created, 2 updated, 0 unchanged, 1 blocked, 1 superseded, 4 events',
        '',
      ].join('\n'),
    );
  });

  it('golden: a dry run shows the pairing, new groups, closed tickets and writes nothing', () => {
    const text = renderImport(
      result(
        [
          imported({ action: 'created', item: '1', id: null, ticket: null, title: 'Inserted' }),
          imported({
            action: 'updated',
            item: '2',
            pairing: { pass: 'content', score: 2 / 3 },
            renumber: { from: '1', to: '2' },
          }),
          imported({
            action: 'unchanged',
            item: '3',
            id: ID2,
            pairing: { pass: 'number', score: 0 },
            diff: {
              title: null,
              updated: [],
              removed: [],
              added: [{ text: '3.2 Late', done: true }],
            },
            ticket: ticket({
              id: ID2,
              title: 'Closed one',
              status: 'merged',
              closed: true,
              disposition: { noDecision: true },
            }),
          }),
        ],
        { dryRun: true },
      ),
    );
    expect(text).toBe(
      [
        'created group 1: Inserted',
        `updated ${ID}  todo  -  Build the CLI`,
        '  paired by content (score 0.67)',
        '  renumbered from group 1 to 2',
        `unchanged ${ID2}  merged  -  [closed] Closed one`,
        '  paired by number (score 0.00)',
        '  added [x] 3.2 Late',
        '  not reconciled: closed',
        'dry run openspec:add-x: 1 created, 1 updated, 1 unchanged, nothing written',
        '',
      ].join('\n'),
    );
  });

  it('golden: a dry run with ambiguous candidates', () => {
    const text = renderImport(
      result(
        [
          imported({ action: 'created', item: '2', id: null, ticket: null, title: 'Store reads' }),
          imported({ action: 'created', item: '3', id: null, ticket: null, title: 'Store writes' }),
          imported({
            action: 'superseded',
            item: null,
            title: 'Store',
            supersede: `group removed from ${PATH}`,
          }),
        ],
        {
          dryRun: true,
          ambiguous: [
            { ticket: ID, item: '2', score: 0.5, sameTitle: false },
            { ticket: ID, item: '3', score: 0.5, sameTitle: true },
          ],
        },
      ),
    );
    expect(text).toBe(
      [
        'created group 2: Store reads',
        'created group 3: Store writes',
        `superseded ${ID}  todo  -  Build the CLI`,
        `  superseded: group removed from ${PATH}`,
        `ambiguous ${ID} group 2 (score 0.50)`,
        `ambiguous ${ID} group 3 (score 0.50 same title)`,
        'dry run openspec:add-x: 2 created, 0 updated, 0 unchanged, 1 superseded, ambiguous, nothing written',
        '',
      ].join('\n'),
    );
  });

  it('passes user text through asciiText', () => {
    const text = renderImport(
      result(
        [
          imported({
            action: 'created',
            item: '1',
            id: null,
            ticket: null,
            title: `caf${String.fromCharCode(0xe9)}`,
          }),
        ],
        {
          dryRun: true,
        },
      ),
    );
    expect(text.split('\n')[0]).toBe('created group 1: caf\\u00E9');
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });
});
