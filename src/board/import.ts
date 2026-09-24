/**
 * `import-change`: one ticket per importable unit of a planning source
 * (board-openspec-integration: "Import a change", "Task sources are
 * adapters"; board-concurrency: "Re-import is idempotent"; board-events:
 * "Fold semantics": "A ticket SHALL always be created in `todo`; an import
 * that needs another status writes the permitted moves").
 */

import { dirname } from 'node:path';

import type { Ticket } from '../events/fold.js';
import {
  TASK_SOURCE_PATTERN,
  type Status,
  type TaskRef,
  type TicketCreateBody,
} from '../events/schema.js';
import { newUlid } from '../events/ulid.js';
import type { Board } from '../store/board.js';
import { stmt } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { runCommand, type CommandResult, type ProposedEvent } from '../store/transaction.js';
import { requireActor, ticketOf } from './lookup.js';
import { OPENSPEC_SOURCE } from './openspec.js';
import { refuseSecretLike } from './secrets.js';
import { SOURCE_ADAPTERS, sourceAdapter, type TaskUnit } from './sources.js';
import { asciiText } from './text.js';
import type { WriteOptions } from './types.js';

/** What `import-change` imports: a source and a ref within it. */
export interface ImportTarget {
  /** Task source; must have an adapter (`sourceAdapter`). */
  source: string;
  /** The ref within the source (for OpenSpec, the change directory name). */
  ref: string;
}

/**
 * Parses the `import-change` argument. Pure.
 *
 * - Without `:`, the whole text is an OpenSpec change name:
 *   `{ source: 'openspec', ref: text }`.
 * - With `:`, the text before the first `:` is the source and the rest is
 *   the ref (`speckit:001-photo-albums`), the same `<source>:<ref>` form
 *   `list --task` accepts. The source must match `TASK_SOURCE_PATTERN`,
 *   otherwise `BoardError(1, 'malformed-task-ref')` naming it. A `#` in
 *   the text is `BoardError(1, 'malformed-task-ref')` (an import names a
 *   whole ref, never one item).
 * - An empty text or empty ref is `BoardError(1, 'usage')`.
 *
 * Whether the source has an adapter is not checked here (`importChange`
 * does).
 */
export function parseImportTarget(text: string): ImportTarget {
  if (text === '') {
    throw new BoardError(1, 'usage', 'import-change needs a change name or <source>:<ref>');
  }
  if (text.includes('#')) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      `${asciiText(text)} names an item; import-change takes a whole change or <source>:<ref>`,
    );
  }
  const colon = text.indexOf(':');
  if (colon < 0) {
    return { source: OPENSPEC_SOURCE, ref: text };
  }
  const source = text.slice(0, colon);
  const ref = text.slice(colon + 1);
  if (!TASK_SOURCE_PATTERN.test(source)) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      `the task source ${JSON.stringify(asciiText(source))} must match ` +
        `${String(TASK_SOURCE_PATTERN)}`,
    );
  }
  if (ref === '') {
    throw new BoardError(1, 'usage', `import-change ${asciiText(text)} names no ref`);
  }
  return { source, ref };
}

/** What an import did to one unit's ticket. */
export type ImportAction = 'created' | 'updated' | 'unchanged';

/** One unit of an import and its ticket. */
export interface ImportedTicket {
  /** The unit's `item` (for OpenSpec, the group number). */
  item: string;
  /** Full id of the unit's ticket (existing or created). */
  id: string;
  /**
   * `created`: no ticket had this task reference, so one was created.
   * `updated`: an existing ticket had checklist lines appended.
   * `unchanged`: an existing ticket, nothing written.
   */
  action: ImportAction;
  /** Number of checklist lines appended to an existing ticket (0 unless `updated`). */
  appended: number;
  /** Hashes of the events written for this unit, in the order written; empty when `unchanged`. */
  events: string[];
  /** The ticket after the import, as `readTicket` returns it. */
  ticket: Ticket;
}

/** Result of `importChange`; also the `import-change --json` document. */
export interface ImportResult {
  source: string;
  ref: string;
  /** Root-relative POSIX path of the tasks file read (`SourceAdapter.tasksPath`). */
  tasksFile: string;
  /** One entry per unit, in tasks file order. */
  tickets: ImportedTicket[];
  /** Total number of events written by this import (0 for an unchanged re-import). */
  events: number;
}

/**
 * `import-change`: creates one ticket per unit of `target` that has none,
 * and appends new checklist lines to the tickets that exist.
 *
 * Checks, in order, before anything is read from the board or written:
 * 1. `actor` empty: `BoardError(1, 'missing-actor')`.
 * 2. No adapter for `target.source` (`sourceAdapter`):
 *    `BoardError(1, 'unsupported-source')` whose message names the source
 *    and says only `openspec` can be imported by this version.
 * 3. The units, `adapter.listUnits(dirname(board.dir), target.ref)`:
 *    `usage`, `tasks-not-found` (naming the tasks file path) or
 *    `malformed-tasks` from the adapter propagate unchanged.
 * 4. `refuseSecretLike` over every unit title and every task line text
 *    (exit 1 `secret-like`, pattern name only); there is no bypass flag.
 *    So a refused import writes nothing at all, not even for the units
 *    before the offending one.
 *
 * Ticket identity (board-concurrency: "keyed by their task reference"):
 * the ticket of a unit is the ticket, open or closed, whose task reference
 * equals `{ source, ref, item }`; when several do, the one with the
 * smallest id. A ticket created by hand (`new --change x --group 3`) or
 * linked later (`link --task`) is therefore the unit's ticket, and a
 * closed ticket is never re-created.
 *
 * A unit without a ticket (`created`) gets, in this order:
 * - one `ticket.create` with `title` the unit title, `labels`
 *   `adapter.labels(ref, unit)`, `task` `{ source, ref, item }` and
 *   `checklist` the task line texts (omitted when there are none), no
 *   description; the ticket starts in `todo`, unassigned;
 * - one `ticket.checklist` tick per task line whose box is ticked, in
 *   index order (the done state is copied from the checkbox);
 * - when the unit has at least one task line and all are ticked, the
 *   permitted moves `tests`, `implementing`, `review`, `merged`, one
 *   `ticket.move` each, so the ticket ends in `merged`. A unit with no
 *   task lines stays in `todo`.
 * The existence check and the `ticket.create` run in one command
 * transaction (`runCommand`), so two concurrent imports cannot both create
 * a ticket for the same unit; the loser treats the unit as existing.
 *
 * A unit with a ticket (re-import) is handled conservatively: the board
 * never takes completion truth from a second read of the tasks file, and
 * never moves a ticket another agent may hold.
 * - Task lines at indexes at or beyond the ticket's checklist length are
 *   appended to its checklist, in order, each with its done state copied
 *   (the done flag comes from the checkbox); the unit is `updated`.
 *   The lines are appended with exactly one `ticket.checklist.add` event
 *   per ticket that gained lines, whose `items` are the new lines in order
 *   with their done flags (no separate ticks).
 * - Nothing else changes: not the title, the labels, the status, the text
 *   or done state of an existing checklist line (even when the tasks file
 *   changed them), and no line is removed when the file has fewer lines.
 *   A group that became fully ticked since the first import is not moved.
 * - With nothing to append the unit is `unchanged` and no event is
 *   written, so re-importing an unchanged tasks file writes no events.
 *
 * Units are processed in file order, each event in its own command
 * transaction. A crash part way leaves the tickets written so far, and a
 * re-import finishes the units without a ticket (but, as above, does not
 * repair the ticks or moves of a unit whose create was written).
 *
 * `options` is passed to every `runCommand`.
 */
export function importChange(
  board: Board,
  actor: string,
  target: ImportTarget,
  options?: WriteOptions,
): ImportResult {
  requireActor(actor);
  const adapter = sourceAdapter(target.source);
  if (adapter === undefined) {
    throw new BoardError(
      1,
      'unsupported-source',
      `task source ${asciiText(target.source)} has no adapter in this version; only ` +
        `${SOURCE_ADAPTERS.map((a) => a.source).join(', ')} can be imported`,
    );
  }
  const units = adapter.listUnits(dirname(board.dir), target.ref);
  refuseSecretLike(
    units.flatMap((unit) => [unit.title, ...unit.lines.map((line) => line.text)]),
    false,
  );
  const tickets = units.map((unit) =>
    importUnit(board, actor, target, adapter.labels(target.ref, unit), unit, options),
  );
  return {
    source: target.source,
    ref: target.ref,
    tasksFile: adapter.tasksPath(target.ref),
    tickets,
    events: tickets.reduce((sum, t) => sum + t.events.length, 0),
  };
}

/**
 * Thrown inside a unit's transaction when its ticket exists and has
 * nothing to append, so the transaction is rolled back without writing.
 * Never escapes this module.
 */
class Unchanged extends Error {
  readonly ticket: Ticket;

  constructor(ticket: Ticket) {
    super(`ticket ${ticket.id} is unchanged`);
    this.ticket = ticket;
  }
}

/** The id of the unit's ticket (smallest id with this task reference), or null. */
function ticketIdFor(board: Board, task: TaskRef): string | null {
  const row = stmt(
    board.db,
    'SELECT id FROM tickets WHERE task_source = ? AND task_ref = ? AND task_item = ? ' +
      'ORDER BY id LIMIT 1',
  ).get(task.source, task.ref, task.item);
  return row === undefined ? null : String(row.id);
}

/** Imports one unit: creates its ticket, or appends to the existing one, or does nothing. */
function importUnit(
  board: Board,
  actor: string,
  target: ImportTarget,
  labels: string[],
  unit: TaskUnit,
  options: WriteOptions | undefined,
): ImportedTicket {
  const task: TaskRef = { source: target.source, ref: target.ref, item: unit.item };
  let first: CommandResult;
  try {
    // One transaction decides between create, append and nothing, so two
    // concurrent imports cannot both create a ticket for the unit.
    first = runCommand(
      board,
      actor,
      (ctx) => {
        const id = ticketIdFor(board, task);
        const existing = id === null ? null : ctx.ticket(id);
        return { ok: true, event: firstEvent(existing, task, labels, unit) };
      },
      options,
    );
  } catch (error) {
    if (error instanceof Unchanged) {
      return {
        item: unit.item,
        id: error.ticket.id,
        action: 'unchanged',
        appended: 0,
        events: [],
        ticket: error.ticket,
      };
    }
    throw error;
  }
  const events = [first.hash];
  let ticket = ticketOf(first.ticket);
  if (first.event.kind === 'ticket.checklist.add') {
    return {
      item: unit.item,
      id: ticket.id,
      action: 'updated',
      appended: first.event.body.items.length,
      events,
      ticket,
    };
  }
  const follow: ProposedEvent[] = [];
  unit.lines.forEach((line, index) => {
    if (line.done) {
      follow.push({ kind: 'ticket.checklist', ticket: ticket.id, body: { index, done: true } });
    }
  });
  if (unit.lines.length > 0 && unit.lines.every((line) => line.done)) {
    for (const to of MERGED_PATH) {
      follow.push({ kind: 'ticket.move', ticket: ticket.id, body: { to } });
    }
  }
  for (const event of follow) {
    const result = runCommand(board, actor, () => ({ ok: true, event }), options);
    events.push(result.hash);
    ticket = ticketOf(result.ticket);
  }
  return { item: unit.item, id: ticket.id, action: 'created', appended: 0, events, ticket };
}

/** The permitted moves from `todo` to `merged`, in order. */
const MERGED_PATH: readonly Status[] = ['tests', 'implementing', 'review', 'merged'];

/**
 * The first event of a unit: the create when it has no ticket, the append
 * of its new task lines when it has one, or `Unchanged` thrown.
 */
function firstEvent(
  existing: Ticket | null,
  task: TaskRef,
  labels: string[],
  unit: TaskUnit,
): ProposedEvent {
  if (existing === null) {
    const body: TicketCreateBody = { title: unit.title, task };
    if (labels.length > 0) {
      body.labels = [...labels];
    }
    if (unit.lines.length > 0) {
      body.checklist = unit.lines.map((line) => line.text);
    }
    return { kind: 'ticket.create', ticket: newUlid(), body };
  }
  const added = unit.lines.slice(existing.checklist.length);
  if (added.length === 0) {
    throw new Unchanged(existing);
  }
  return {
    kind: 'ticket.checklist.add',
    ticket: existing.id,
    body: { items: added.map((line) => ({ text: line.text, done: line.done })) },
  };
}
