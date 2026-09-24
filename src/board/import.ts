/**
 * `import-change`: one ticket per importable unit of a planning source
 * (board-openspec-integration: "Import a change", "Task sources are
 * adapters"; board-concurrency: "Re-import is idempotent"; board-events:
 * "Fold semantics": "A ticket SHALL always be created in `todo`; an import
 * that needs another status writes the permitted moves").
 */

import type { Ticket } from '../events/fold.js';
import type { Board } from '../store/board.js';
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
  void text;
  throw new Error('not implemented');
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
  void board;
  void actor;
  void target;
  void options;
  throw new Error('not implemented');
}
