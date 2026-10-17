/**
 * Rendering the scope disposition (add-adhoc-ticket-lifecycle task 2.3;
 * board-openspec-integration: "Ad hoc markers in list"; design.md section
 * 8): `[unplanned]` in place of `[adhoc]` in the `list` line, the
 * `unplanned: <reason> (by <actor>)` line of `show`, and the `unplanned`
 * object in `--json`.
 *
 * The goldens are written by hand from the specs and the fold rules, not
 * recorded from the implementation: the fixture board is a fixed set of
 * event files (fixed ids, actors and timestamps) written straight to the
 * events directory, so every output below is fully determined.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import type { Hlc } from '../../events/hlc.js';
import type { ProposedEvent } from '../../store/transaction.js';
import { P, ev, putEvent } from '../../store/__tests__/helpers.js';
import { renderListLine, renderShow } from '../render.js';
import { oneJson, project, run, type Run } from './cli-helpers.js';

/** The five tickets of the fixture, in id (creation) order. */
const ID = {
  /** An undisposed ad hoc ticket, in review. */
  undisposed: '01J0D1SP0000000000000000AA',
  /** An ad hoc ticket merged with `--unplanned`. */
  unplannedMerged: '01J0D1SP0000000000000000AB',
  /** An ad hoc ticket closed from blocked with `--unplanned`. */
  unplannedClosed: '01J0D1SP0000000000000000AC',
  /** An ad hoc ticket linked at merge with `--task`. */
  linkedAtMerge: '01J0D1SP0000000000000000AD',
  /** A planned ticket, in tests. */
  planned: '01J0D1SP0000000000000000AE',
} as const;

const START = 1_700_000_000_000;

/** The timestamp of the n-th event (0-based) of the fixture. */
function at(n: number, actor: string): Hlc {
  return { wall: START + n * 1000, counter: 0, actor };
}

/**
 * The fixture's events, in write order: `[actor, event]`. The n-th entry
 * gets the wall `START + n * 1000`.
 */
const EVENTS: readonly (readonly [string, ProposedEvent])[] = [
  // 0-3: the undisposed ad hoc ticket, todo -> review.
  ['orch', P.create(ID.undisposed, 'Login redirect loops', adhoc('seen in production'))],
  ['impl-1', P.move(ID.undisposed, 'tests')],
  ['impl-1', P.move(ID.undisposed, 'implementing')],
  ['impl-1', P.move(ID.undisposed, 'review')],
  // 4-9: the unplanned merged ticket: todo -> review, then the pair.
  ['orch', P.create(ID.unplannedMerged, 'Fix login redirect', adhoc('hotfix'))],
  ['impl-1', P.move(ID.unplannedMerged, 'tests')],
  ['impl-1', P.move(ID.unplannedMerged, 'implementing')],
  ['impl-1', P.move(ID.unplannedMerged, 'review')],
  ['orch', P.unplanned(ID.unplannedMerged, 'production hotfix, no plan')],
  ['orch', P.move(ID.unplannedMerged, 'merged')],
  // 10-14: the unplanned ticket closed from blocked.
  ['orch', P.create(ID.unplannedClosed, 'Try the new parser', adhoc('spike: try the new parser'))],
  ['impl-2', P.move(ID.unplannedClosed, 'tests')],
  ['impl-2', P.move(ID.unplannedClosed, 'blocked')],
  ['orch', P.unplanned(ID.unplannedClosed, 'abandoned, duplicate of AB')],
  ['orch', P.close(ID.unplannedClosed)],
  // 15-20: the ticket linked at merge.
  ['orch', P.create(ID.linkedAtMerge, 'Rate limit the API', adhoc('linked later'))],
  ['impl-2', P.move(ID.linkedAtMerge, 'tests')],
  ['impl-2', P.move(ID.linkedAtMerge, 'implementing')],
  ['impl-2', P.move(ID.linkedAtMerge, 'review')],
  ['orch', P.task(ID.linkedAtMerge, { source: 'openspec', ref: 'add-login', item: '2' })],
  ['orch', P.move(ID.linkedAtMerge, 'merged')],
  // 21-22: the planned ticket.
  [
    'orch',
    P.create(ID.planned, 'Session cookies', {
      task: { source: 'openspec', ref: 'add-login', item: '3' },
      checklist: undefined,
      labels: undefined,
    }),
  ],
  ['impl-1', P.move(ID.planned, 'tests')],
];

/** A `ticket.create` extra for an ad hoc ticket (no task, no checklist, no labels). */
function adhoc(reason: string): Record<string, unknown> {
  return { task: undefined, checklist: undefined, labels: undefined, adhoc: reason };
}

/** A project whose board holds the fixture events; nothing has folded them yet. */
function fixture(): { root: string } {
  const { root, boardDir } = project();
  const events = join(boardDir, 'events');
  EVENTS.forEach(([actor, event], n) => {
    putEvent(events, ev(stripUndefined(event), actor, START + n * 1000));
  });
  return { root };
}

/** `P.create` spreads `undefined` for omitted fields; the canonical file must not carry them. */
function stripUndefined(event: ProposedEvent): ProposedEvent {
  return JSON.parse(JSON.stringify(event)) as ProposedEvent;
}

function ok(out: Run): Run {
  expect(out.code, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  return out;
}

/** The common shape of a fixture ticket, as `show --json` and `list --json` print it. */
function ticketDoc(fields: Partial<Ticket> & Pick<Ticket, 'id' | 'title'>): Ticket {
  return {
    description: null,
    status: 'todo',
    blockedFrom: null,
    assignee: null,
    lease: null,
    queue: [],
    available: null,
    labels: [],
    task: null,
    adhoc: null,
    unplanned: null,
    checklist: [],
    comments: [],
    links: [],
    closed: false,
    disposition: null,
    createdBy: 'orch',
    createdAt: at(0, 'orch'),
    version: 1,
    updatedAt: at(0, 'orch'),
    ...fields,
  };
}

/** The five tickets after the fold, by hand from the fold rules. */
const FOLDED: readonly Ticket[] = [
  ticketDoc({
    id: ID.undisposed,
    title: 'Login redirect loops',
    status: 'review',
    adhoc: 'seen in production',
    createdAt: at(0, 'orch'),
    version: 4,
    updatedAt: at(3, 'impl-1'),
  }),
  ticketDoc({
    id: ID.unplannedMerged,
    title: 'Fix login redirect',
    status: 'merged',
    adhoc: 'hotfix',
    unplanned: { reason: 'production hotfix, no plan', actor: 'orch', ts: at(8, 'orch') },
    createdAt: at(4, 'orch'),
    version: 6,
    updatedAt: at(9, 'orch'),
  }),
  ticketDoc({
    id: ID.unplannedClosed,
    title: 'Try the new parser',
    status: 'blocked',
    blockedFrom: 'tests',
    adhoc: 'spike: try the new parser',
    unplanned: { reason: 'abandoned, duplicate of AB', actor: 'orch', ts: at(13, 'orch') },
    closed: true,
    disposition: { noDecision: true },
    createdAt: at(10, 'orch'),
    version: 5,
    updatedAt: at(14, 'orch'),
  }),
  ticketDoc({
    id: ID.linkedAtMerge,
    title: 'Rate limit the API',
    status: 'merged',
    task: { source: 'openspec', ref: 'add-login', item: '2' },
    createdAt: at(15, 'orch'),
    version: 6,
    updatedAt: at(20, 'orch'),
  }),
  ticketDoc({
    id: ID.planned,
    title: 'Session cookies',
    status: 'tests',
    task: { source: 'openspec', ref: 'add-login', item: '3' },
    createdAt: at(21, 'orch'),
    version: 2,
    updatedAt: at(22, 'impl-1'),
  }),
];

const LIST_CLOSED =
  `${ID.undisposed}  review  -  [adhoc] Login redirect loops\n` +
  `${ID.unplannedMerged}  merged  -  [unplanned] Fix login redirect\n` +
  `${ID.unplannedClosed}  blocked  -  [unplanned] [closed] Try the new parser\n` +
  `${ID.linkedAtMerge}  merged  -  Rate limit the API\n` +
  `${ID.planned}  tests  -  Session cookies\n`;

const SHOW_UNPLANNED_MERGED =
  `id: ${ID.unplannedMerged}\n` +
  'title: Fix login redirect\n' +
  'status: merged\n' +
  'assignee: -\n' +
  'adhoc: hotfix\n' +
  'unplanned: production hotfix, no plan (by orch)\n' +
  'labels: -\n' +
  'description: -\n' +
  'checklist:\n' +
  'links:\n' +
  'comments:\n' +
  'closed: no\n' +
  'events: 6\n';

const SHOW_UNPLANNED_CLOSED =
  `id: ${ID.unplannedClosed}\n` +
  'title: Try the new parser\n' +
  'status: blocked (from tests)\n' +
  'assignee: -\n' +
  'adhoc: spike: try the new parser\n' +
  'unplanned: abandoned, duplicate of AB (by orch)\n' +
  'labels: -\n' +
  'description: -\n' +
  'checklist:\n' +
  'links:\n' +
  'comments:\n' +
  'closed: yes (no decision)\n' +
  'events: 5\n';

const SHOW_LINKED_AT_MERGE =
  `id: ${ID.linkedAtMerge}\n` +
  'title: Rate limit the API\n' +
  'status: merged\n' +
  'assignee: -\n' +
  'task: openspec:add-login#2\n' +
  'labels: -\n' +
  'description: -\n' +
  'checklist:\n' +
  'links:\n' +
  'comments:\n' +
  'closed: no\n' +
  'events: 6\n';

const SHOW_UNDISPOSED =
  `id: ${ID.undisposed}\n` +
  'title: Login redirect loops\n' +
  'status: review\n' +
  'assignee: -\n' +
  'adhoc: seen in production\n' +
  'labels: -\n' +
  'description: -\n' +
  'checklist:\n' +
  'links:\n' +
  'comments:\n' +
  'closed: no\n' +
  'events: 4\n';

const SHOW_PLANNED =
  `id: ${ID.planned}\n` +
  'title: Session cookies\n' +
  'status: tests\n' +
  'assignee: -\n' +
  'task: openspec:add-login#3\n' +
  'labels: -\n' +
  'description: -\n' +
  'checklist:\n' +
  'links:\n' +
  'comments:\n' +
  'closed: no\n' +
  'events: 2\n';

describe('golden list output on the fixture board', () => {
  it('scenario: list markers ([adhoc], [unplanned] and not [adhoc], neither for a linked ticket)', () => {
    const { root } = fixture();
    expect(ok(run(['list', '--closed'], root)).stdout).toBe(LIST_CLOSED);
  });

  it('list without --closed leaves out the closed ticket only', () => {
    const { root } = fixture();
    expect(ok(run(['list'], root)).stdout).toBe(
      LIST_CLOSED.split('\n')
        .filter((line) => !line.includes('[closed]'))
        .join('\n'),
    );
  });

  it('list --closed --json carries the unplanned object of each ticket', () => {
    const { root } = fixture();
    expect(oneJson(ok(run(['list', '--closed', '--json'], root)))).toEqual(FOLDED);
  });

  it('list --status merged shows the unplanned and the linked ticket, with their markers', () => {
    const { root } = fixture();
    expect(ok(run(['list', '--status', 'merged'], root)).stdout).toBe(
      `${ID.unplannedMerged}  merged  -  [unplanned] Fix login redirect\n` +
        `${ID.linkedAtMerge}  merged  -  Rate limit the API\n`,
    );
  });
});

describe('golden show output on the fixture board', () => {
  it.each([
    ['the unplanned merged ticket', ID.unplannedMerged, SHOW_UNPLANNED_MERGED, 1],
    ['the unplanned ticket closed from blocked', ID.unplannedClosed, SHOW_UNPLANNED_CLOSED, 2],
    ['the ticket linked at merge', ID.linkedAtMerge, SHOW_LINKED_AT_MERGE, 3],
    ['the undisposed ad hoc ticket', ID.undisposed, SHOW_UNDISPOSED, 0],
    ['the planned ticket', ID.planned, SHOW_PLANNED, 4],
  ])('%s: human and --json', (_name, id, text, index) => {
    const { root } = fixture();
    expect(ok(run(['show', id], root)).stdout).toBe(text);
    expect(oneJson(ok(run(['show', id, '--json'], root)))).toEqual({
      ticket: FOLDED[index],
      events: FOLDED[index]?.version,
      unknown: [],
    });
  });

  it('the unplanned line follows the adhoc line, and a linked ticket has neither', () => {
    const { root } = fixture();
    const lines = ok(run(['show', ID.unplannedMerged], root)).stdout.split('\n');
    expect(lines.indexOf('unplanned: production hotfix, no plan (by orch)')).toBe(
      lines.indexOf('adhoc: hotfix') + 1,
    );
    const linked = ok(run(['show', ID.linkedAtMerge], root)).stdout;
    expect(linked).not.toMatch(/^adhoc:/m);
    expect(linked).not.toMatch(/^unplanned:/m);
  });
});

describe('renderListLine and renderShow with an unplanned disposition (pure)', () => {
  const TS = { wall: 1000, counter: 0, actor: 'orch' };
  const base = ticketDoc({
    id: ID.unplannedMerged,
    title: 'Fix thing',
    status: 'merged',
    adhoc: 'hotfix',
    unplanned: { reason: 'production hotfix', actor: 'orch', ts: TS },
  });

  it('shows [unplanned] in place of [adhoc], before [closed]', () => {
    expect(renderListLine(base)).toBe(`${ID.unplannedMerged}  merged  -  [unplanned] Fix thing`);
    expect(
      renderListLine({ ...base, status: 'blocked', closed: true, disposition: { noDecision: true } }),
    ).toBe(`${ID.unplannedMerged}  blocked  -  [unplanned] [closed] Fix thing`);
    expect(renderListLine({ ...base, unplanned: null })).toBe(
      `${ID.unplannedMerged}  merged  -  [adhoc] Fix thing`,
    );
    expect(
      renderListLine({
        ...base,
        adhoc: null,
        unplanned: null,
        task: { source: 'openspec', ref: 'x', item: '1' },
      }),
    ).toBe(`${ID.unplannedMerged}  merged  -  Fix thing`);
  });

  it('writes the unplanned line after the adhoc line, through asciiText', () => {
    const E = String.fromCharCode(0xe9);
    const lines = renderShow({
      ticket: {
        ...base,
        unplanned: { reason: `caf${E} outage`, actor: `r${E}`, ts: TS },
      },
      events: 6,
      unknown: [],
    }).split('\n');
    expect(lines.indexOf('unplanned: caf\\u00E9 outage (by r\\u00E9)')).toBe(
      lines.indexOf('adhoc: hotfix') + 1,
    );
    expect(renderShow({ ticket: { ...base, unplanned: null }, events: 5, unknown: [] })).not.toMatch(
      /^unplanned:/m,
    );
  });

  it('writes the unplanned line after a task: - line for a ticket with neither task nor ad hoc reason', () => {
    const lines = renderShow({ ticket: { ...base, adhoc: null }, events: 6, unknown: [] }).split(
      '\n',
    );
    expect(lines.indexOf('unplanned: production hotfix (by orch)')).toBe(lines.indexOf('task: -') + 1);
  });
});
