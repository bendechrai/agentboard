/**
 * The pre-disposition fixture board (add-adhoc-ticket-lifecycle task 1.2):
 * `src/events/__tests__/fixtures/pre-disposition-board/` holds the event
 * files of a board written by the release before the scope disposition
 * existed (the library built from commit 079707c, driven exactly as
 * `writePreDispositionBoard` drives today's library) and `fold.json`, the
 * canonical bytes of its fold recorded by that release. The ad hoc
 * tickets are in `todo` (claimed, with a comment), `tests`, `blocked` and
 * closed from `blocked`; the linked tickets are in `implementing` (ad hoc
 * then linked), `review` (by hand-off), `merged` (with a pr link) and
 * closed from `merged` with a decision. Two files were written outside
 * agentboard: a losing claim, rejected `already-assigned`, and an event of
 * an unknown kind.
 *
 * `writePreDispositionBoard` runs the same commands through the current
 * library with the same clock, so the files it writes are byte for byte
 * the fixture's as long as single-event commands write what they wrote
 * before (board-cache: "One command, one transaction").
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalDecode, canonicalEncode, sha256Hex } from '../../events/canonical.js';
import type { BoardEvent, TicketCreateBody } from '../../events/schema.js';
import {
  claimTicket,
  commentTicket,
  handoffTicket,
  linkTicket,
  moveTicket,
  setChecklistItem,
} from '../../board/actions.js';
import { openBoard } from '../board.js';
import { runCommand, type ProposedEvent } from '../transaction.js';
import { putEvent } from './helpers.js';

/** The fixture directory (holds `events/` and `fold.json`). */
export const PRE_DISPOSITION_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'events',
  '__tests__',
  'fixtures',
  'pre-disposition-board',
);

/** Ad hoc tickets: in todo, tests, blocked, and closed from blocked. */
export const ADHOC = {
  todo: '01J0ADH0C000000000000000A1',
  tests: '01J0ADH0C000000000000000A2',
  blocked: '01J0ADH0C000000000000000A3',
  closed: '01J0ADH0C000000000000000A4',
} as const;

/** Linked tickets: in implementing, review, merged, and closed from merged. */
export const LINKED = {
  implementing: '01J0P1AN0000000000000000B1',
  review: '01J0P1AN0000000000000000B2',
  merged: '01J0P1AN0000000000000000B3',
  closed: '01J0P1AN0000000000000000B4',
} as const;

/** Wall of the first command; every later command is 1000 ms later. */
export const PRE_DISPOSITION_START = 1_700_000_000_000;

/**
 * Writes the fixture board's events into `dir` (an existing board
 * directory with an empty `events/`) through the current library. The
 * cache it builds is left in place.
 */
export function writePreDispositionBoard(dir: string): void {
  let t = PRE_DISPOSITION_START - 1000;
  const now = (): number => {
    t += 1000;
    return t;
  };
  const board = openBoard(dir, { now: 0 });
  const opts = { now, env: {} };
  const propose = (actor: string, event: ProposedEvent): void => {
    runCommand(board, actor, () => ({ ok: true, event }), opts);
  };
  const create = (ticket: string, body: TicketCreateBody): void => {
    propose('orch', { kind: 'ticket.create', ticket, body });
  };
  try {
    create(ADHOC.todo, { title: 'Try the new parser', adhoc: 'spike: try the new parser' });
    create(ADHOC.tests, { title: 'Login redirect loops', adhoc: 'bug seen in production' });
    create(ADHOC.blocked, { title: 'Flaky upload test', adhoc: 'flaky test in CI' });
    create(ADHOC.closed, { title: 'Rewrite the TUI in Rust', adhoc: 'idea, abandoned' });
    create(LINKED.implementing, { title: 'Rate limit the API', adhoc: 'linked later' });
    create(LINKED.review, {
      title: 'Login form',
      description: 'The form and its tests.',
      labels: ['change:add-login', 'group:2'],
      task: { source: 'openspec', ref: 'add-login', item: '2' },
      checklist: ['2.1 Form', '2.2 Tests'],
    });
    create(LINKED.merged, {
      title: 'Session cookies',
      task: { source: 'openspec', ref: 'add-login', item: '3' },
    });
    create(LINKED.closed, {
      title: 'Album pages',
      task: { source: 'speckit', ref: '001-albums', item: 'phase-2' },
    });

    claimTicket(board, 'agent-a', { id: ADHOC.todo }, opts);
    commentTicket(board, 'agent-a', { id: ADHOC.todo, text: 'looking into it' }, opts);
    moveTicket(board, 'agent-b', { id: ADHOC.tests, to: 'tests' }, opts);
    moveTicket(board, 'agent-c', { id: ADHOC.blocked, to: 'tests' }, opts);
    moveTicket(board, 'agent-c', { id: ADHOC.blocked, to: 'blocked' }, opts);
    moveTicket(board, 'orch', { id: ADHOC.closed, to: 'blocked' }, opts);
    // The release this fixture simulates closed an undisposed ad hoc ticket
    // freely; today's closeTicket refuses it, so the raw event is proposed.
    propose('orch', { kind: 'ticket.close', ticket: ADHOC.closed, body: { noDecision: true } });

    linkTicket(
      board,
      'orch',
      {
        id: LINKED.implementing,
        target: { task: { source: 'openspec', ref: 'add-login', item: '5' } },
      },
      opts,
    );
    moveTicket(board, 'impl-1', { id: LINKED.implementing, to: 'tests' }, opts);
    moveTicket(board, 'impl-1', { id: LINKED.implementing, to: 'implementing' }, opts);
    claimTicket(board, 'impl-1', { id: LINKED.implementing }, opts);

    claimTicket(board, 'impl-2', { id: LINKED.review }, opts);
    moveTicket(board, 'impl-2', { id: LINKED.review, to: 'tests' }, opts);
    moveTicket(board, 'impl-2', { id: LINKED.review, to: 'implementing' }, opts);
    setChecklistItem(board, 'impl-2', { id: LINKED.review, index: 0, done: true }, opts);
    propose('orch', {
      kind: 'ticket.checklist.add',
      ticket: LINKED.review,
      body: { items: [{ text: '2.3 Docs', done: false }] },
    });
    handoffTicket(
      board,
      'impl-2',
      { id: LINKED.review, to: 'reviewer-1', status: 'review', note: 'tests green, 96%' },
      opts,
    );

    for (const to of ['tests', 'implementing', 'review', 'merged'] as const) {
      moveTicket(board, 'orch', { id: LINKED.merged, to }, opts);
    }
    linkTicket(board, 'orch', { id: LINKED.merged, target: { pr: 42 } }, opts);

    for (const to of ['tests', 'implementing', 'review', 'merged'] as const) {
      moveTicket(board, 'orch', { id: LINKED.closed, to }, opts);
    }
    propose('orch', {
      kind: 'ticket.link',
      ticket: LINKED.closed,
      body: { decision: 'adr/0001-albums.md' },
    });
    propose('orch', {
      kind: 'ticket.close',
      ticket: LINKED.closed,
      body: { decision: 'adr/0001-albums.md' },
    });
    propose('orch', { kind: 'board.meta', body: { key: 'columns', value: ['todo', 'doing'] } });
  } finally {
    board.close();
  }

  const eventsDir = join(dir, 'events');
  putEvent(eventsDir, {
    v: 1,
    kind: 'ticket.claim',
    ticket: ADHOC.todo,
    actor: 'agent-b',
    ts: { wall: PRE_DISPOSITION_START + 100_000, counter: 0, actor: 'agent-b' },
    body: {},
  });
  putEvent(eventsDir, {
    v: 1,
    kind: 'ticket.estimate',
    ticket: ADHOC.tests,
    actor: 'agent-b',
    ts: { wall: PRE_DISPOSITION_START + 101_000, counter: 0, actor: 'agent-b' },
    body: { points: 3 },
  });
}

/** The fixture's event files: name to bytes, in name order. */
export function fixtureFiles(): Map<string, Uint8Array> {
  const eventsDir = join(PRE_DISPOSITION_FIXTURE, 'events');
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(eventsDir).sort()) {
    files.set(name, new Uint8Array(readFileSync(join(eventsDir, name))));
  }
  return files;
}

/** The fixture's events, decoded, by hash. */
export function fixtureEvents(): Map<string, BoardEvent> {
  const events = new Map<string, BoardEvent>();
  for (const [name, bytes] of fixtureFiles()) {
    if (sha256Hex(bytes) !== name.slice(0, -'.json'.length)) {
      throw new Error(`fixture file ${name} is not named by its hash`);
    }
    events.set(name.slice(0, -'.json'.length), canonicalDecode(bytes) as unknown as BoardEvent);
  }
  return events;
}

/** The recorded canonical fold (`fold.json`), as text. */
export function recordedFold(): string {
  return readFileSync(join(PRE_DISPOSITION_FIXTURE, 'fold.json'), 'utf8');
}

/** Canonical text of a value. */
export function canonText(value: unknown): string {
  return new TextDecoder().decode(canonicalEncode(value));
}
