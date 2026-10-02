/**
 * Shared fixtures for the board operation and CLI tests: an open board in
 * a temporary directory, a BoardError assertion, and shortcuts to put a
 * ticket in a given status through the library operations.
 */

import { afterEach, expect } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import type { Status, TaskRef } from '../../events/schema.js';
import { openBoard, type Board } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { eventNames, makeBoardDir, tempDir } from '../../store/__tests__/helpers.js';
import { claimTicket, handoffTicket, moveTicket } from '../actions.js';
import { newTicket, type NewTicketInput } from '../tickets.js';

export {
  cleanEnv,
  git,
  gitRepo,
  makeBoardDir,
  putEvent,
  tempDir,
} from '../../store/__tests__/helpers.js';

export const TASK: TaskRef = { source: 'openspec', ref: 'add-board-core', item: '3' };

const open: Board[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

/** A board opened on `dir`, closed after the current test. */
export function openTracked(dir: string): Board {
  const board = openBoard(dir);
  open.push(board);
  return board;
}

/** A fresh board at `<temp>/.board`; `root` is the host project root. */
export function setup(): { board: Board; root: string } {
  const root = tempDir();
  const board = openTracked(makeBoardDir(root));
  return { board, root };
}

/** Number of event files (temporaries excluded) of a board. */
export function eventCount(board: Board): number {
  return eventNames(board.eventsDir).length;
}

/** Asserts `fn` throws a BoardError with this exit code and reason, and returns it. */
export function expectBoardError(fn: () => unknown, exitCode: number, reason: string): BoardError {
  let thrown: unknown = undefined;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BoardError);
  const err = thrown as BoardError;
  expect({ exitCode: err.exitCode, reason: err.reason }).toEqual({ exitCode, reason });
  return err;
}

/** Creates a ticket with a task reference (unless overridden) and returns it. */
export function create(board: Board, input: Partial<NewTicketInput> = {}, actor = 'orch'): Ticket {
  const withTask: NewTicketInput =
    input.adhoc === undefined && input.task === undefined
      ? { title: 'A ticket', task: TASK, ...input }
      : { title: 'A ticket', ...input };
  return newTicket(board, actor, withTask).ticket;
}

/** The path through the state machine from `todo` to each status. */
const PATH: Record<Exclude<Status, 'blocked'>, readonly Status[]> = {
  todo: [],
  tests: ['tests'],
  implementing: ['tests', 'implementing'],
  review: ['tests', 'implementing', 'review'],
  merged: ['tests', 'implementing', 'review', 'merged'],
};

/**
 * A ticket with a task reference in `status`; `blocked` is reached from
 * `blockedFrom` (default `implementing`). Unassigned.
 */
export function ticketIn(
  board: Board,
  status: Status,
  blockedFrom: Status = 'implementing',
): Ticket {
  const ticket = create(board);
  const target = status === 'blocked' ? blockedFrom : status;
  let current = ticket;
  for (const to of PATH[target as Exclude<Status, 'blocked'>]) {
    current = moveTicket(board, 'orch', { id: ticket.id, to }).ticket;
  }
  if (status === 'blocked') {
    current = moveTicket(board, 'orch', { id: ticket.id, to: 'blocked' }).ticket;
  }
  return current;
}

/** A ticket in `status` held by `holder` (claimed, so assignment is real). */
export function heldTicket(board: Board, status: Status, holder: string): Ticket {
  const ticket = ticketIn(board, status);
  return claimTicket(board, holder, { id: ticket.id }).ticket;
}

/** Hands `id` to `to` in `status` as `actor`. */
export function handoff(
  board: Board,
  actor: string,
  id: string,
  to: string,
  status: Status,
): Ticket {
  return handoffTicket(board, actor, { id, to, status, note: `to ${to}` }).ticket;
}

// Secret-looking samples are assembled at run time so the repository never
// holds a string that looks like a real credential.
export const B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQyNDI0';
/** One sample per secret pattern name. */
export const SAMPLES = {
  'pem-private-key': ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  'aws-access-key-id': ['AKIA', 'Z7EXAMPLEFAKE234'].join(''),
  'github-token': ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
  'generic-secret-assignment': `password=${B64}`,
} as const;
