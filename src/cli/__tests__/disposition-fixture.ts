/**
 * The fixture board of add-adhoc-ticket-lifecycle task 2.3, shared by the
 * disposition goldens (`disposition-golden.test.ts`) and the health
 * goldens of task 3.2 (`health-unplanned-cli.test.ts`): a fixed set of
 * event files (fixed ids, actors and timestamps) written straight to the
 * events directory, so every output on it is fully determined, and the
 * five folded tickets by hand from the fold rules.
 */

import { join } from 'node:path';

import type { Ticket } from '../../events/fold.js';
import type { Hlc } from '../../events/hlc.js';
import type { ProposedEvent } from '../../store/transaction.js';
import { P, ev, putEvent } from '../../store/__tests__/helpers.js';
import { project } from './cli-helpers.js';

/** The five tickets of the fixture, in id (creation) order. */
export const ID = {
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

/** The wall of the fixture's first event. */
export const START = 1_700_000_000_000;

/** The timestamp of the n-th event (0-based) of the fixture. */
export function at(n: number, actor: string): Hlc {
  return { wall: START + n * 1000, counter: 0, actor };
}

/**
 * The fixture's events, in write order: `[actor, event]`. The n-th entry
 * gets the wall `START + n * 1000`.
 */
export const EVENTS: readonly (readonly [string, ProposedEvent])[] = [
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

/** The index in `EVENTS` of the `ticket.unplanned` of the merged ticket. */
export const UNPLANNED_MERGED_EVENT = 8;
/** The index in `EVENTS` of the `ticket.unplanned` of the closed ticket. */
export const UNPLANNED_CLOSED_EVENT = 13;

/** A `ticket.create` extra for an ad hoc ticket (no task, no checklist, no labels). */
function adhoc(reason: string): Record<string, unknown> {
  return { task: undefined, checklist: undefined, labels: undefined, adhoc: reason };
}

/**
 * A project whose board holds the fixture events; nothing has folded them
 * yet. `hashes` are the content hashes of the files written, in `EVENTS`
 * order (the store's canonical hash of each file; the event names).
 */
export function fixture(): { root: string; hashes: string[] } {
  const { root, boardDir } = project();
  const events = join(boardDir, 'events');
  const hashes = EVENTS.map(([actor, event], n) =>
    putEvent(events, ev(stripUndefined(event), actor, START + n * 1000)),
  );
  return { root, hashes };
}

/** `P.create` spreads `undefined` for omitted fields; the canonical file must not carry them. */
function stripUndefined(event: ProposedEvent): ProposedEvent {
  return JSON.parse(JSON.stringify(event)) as ProposedEvent;
}

/** The common shape of a fixture ticket, as `show --json` and `list --json` print it. */
export function ticketDoc(fields: Partial<Ticket> & Pick<Ticket, 'id' | 'title'>): Ticket {
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

/** The five tickets after the fold, by hand from the fold rules, in id order. */
export const FOLDED: readonly Ticket[] = [
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
