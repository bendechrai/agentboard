/**
 * Single-event commands write byte-identical events to the release before
 * the scope disposition (add-adhoc-ticket-lifecycle task 1.3), and a board
 * that release wrote opens, rebuilds and moves on unchanged (task 1.4;
 * board-openspec-integration: "Existing ad hoc ticket gains the ability to
 * move", "Linked tickets on an older board are unaffected", "Planned
 * ticket is unaffected"). The fixture is described in pre-disposition.ts.
 */

import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeTicket, moveTicket } from '../../board/actions.js';
import { openBoard, type Board } from '../board.js';
import { dumpCache, readState, readTicket } from '../cache.js';
import { checkCache, rebuild } from '../rebuild.js';
import { canon, eventNames, foldDir, tempBoard } from './helpers.js';
import {
  ADHOC,
  LINKED,
  PRE_DISPOSITION_FIXTURE,
  fixtureFiles,
  writePreDispositionBoard,
} from './pre-disposition.js';

const open: Board[] = [];

function openB(dir: string): Board {
  const board = openBoard(dir, { now: 0 });
  open.push(board);
  return board;
}

afterEach(() => {
  for (const b of open.splice(0)) {
    b.close();
  }
});

/** A fresh board holding a copy of the fixture's event files. */
function fixtureCopy(): string {
  const dir = tempBoard();
  cpSync(join(PRE_DISPOSITION_FIXTURE, 'events'), join(dir, 'events'), { recursive: true });
  return dir;
}

describe("golden: today's single-event commands write the previous release's bytes", () => {
  it('replaying the fixture commands writes exactly the fixture files, byte for byte', () => {
    const dir = tempBoard();
    writePreDispositionBoard(dir);
    const eventsDir = join(dir, 'events');
    const expected = fixtureFiles();
    expect(eventNames(eventsDir)).toEqual([...expected.keys()]);
    for (const [name, bytes] of expected) {
      expect(new Uint8Array(readFileSync(join(eventsDir, name))), name).toEqual(bytes);
    }
  });

  it('the replayed board folds and caches exactly as the fixture copy does', () => {
    const replayed = tempBoard();
    writePreDispositionBoard(replayed);
    const copy = openB(fixtureCopy());
    const board = openB(replayed);
    expect(dumpCache(board.db)).toBe(dumpCache(copy.db));
    expect(canon(readState(board.db))).toBe(canon(foldDir(join(replayed, 'events')).state));
  });
});

describe('a board written by the previous release', () => {
  it('opens with a cache equal to a fresh rebuild, and rebuild --check is clean', () => {
    const board = openB(fixtureCopy());
    const incremental = dumpCache(board.db);
    rebuild(board);
    expect(dumpCache(board.db)).toBe(incremental);
    expect(checkCache(board).ok).toBe(true);
    expect(canon(readState(board.db))).toBe(canon(foldDir(board.eventsDir).state));
    for (const ticket of Object.values(readState(board.db).tickets)) {
      expect(ticket.unplanned, ticket.id).toBeNull();
    }
  });

  it('scenario: an ad hoc ticket in todo gains the ability to move, and no other ticket changes', () => {
    const board = openB(fixtureCopy());
    const before = readState(board.db);
    const tests = moveTicket(board, 'agent-a', { id: ADHOC.todo, to: 'tests' });
    expect(tests.ticket.status).toBe('tests');
    const implementing = moveTicket(board, 'agent-a', { id: ADHOC.todo, to: 'implementing' });
    expect(implementing.ticket.status).toBe('implementing');
    expect(implementing.ticket.task).toBeNull();
    expect(implementing.ticket.adhoc).toBe('spike: try the new parser');
    const after = readState(board.db);
    for (const id of Object.keys(before.tickets)) {
      if (id !== ADHOC.todo) {
        expect(after.tickets[id], id).toEqual(before.tickets[id]);
      }
    }
    // The ad hoc ticket in tests moves on too.
    expect(moveTicket(board, 'agent-b', { id: ADHOC.tests, to: 'implementing' }).ticket.status).toBe(
      'implementing',
    );
  });

  it('scenario: the linked tickets fold to the same state and move on and close with no disposition', () => {
    const board = openB(fixtureCopy());
    expect(readTicket(board.db, LINKED.implementing)?.status).toBe('implementing');
    expect(readTicket(board.db, LINKED.review)?.status).toBe('review');
    expect(readTicket(board.db, LINKED.merged)?.status).toBe('merged');
    expect(readTicket(board.db, LINKED.closed)?.closed).toBe(true);

    moveTicket(board, 'impl-1', { id: LINKED.implementing, to: 'review' });
    expect(moveTicket(board, 'impl-1', { id: LINKED.implementing, to: 'merged' }).ticket.status).toBe(
      'merged',
    );
    expect(moveTicket(board, 'reviewer-1', { id: LINKED.review, to: 'merged' }).ticket.status).toBe(
      'merged',
    );
    expect(closeTicket(board, 'orch', { id: LINKED.merged, noDecision: true }).ticket.closed).toBe(
      true,
    );
    expect(checkCache(board).ok).toBe(true);
  });

  it('the undisposed ad hoc ticket closed from blocked stays closed with no disposition', () => {
    const board = openB(fixtureCopy());
    const closed = readTicket(board.db, ADHOC.closed);
    expect(closed).toMatchObject({
      closed: true,
      status: 'blocked',
      disposition: { noDecision: true },
      task: null,
      unplanned: null,
      adhoc: 'idea, abandoned',
    });
  });
});
