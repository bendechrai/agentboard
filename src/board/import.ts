/**
 * `import-change`: one ticket per importable unit of a planning source,
 * paired with the existing tickets by identity and reconciled with them
 * (board-openspec-integration: "Import a change", "Task sources are
 * adapters", "Pair tickets to groups by identity", "Reconcile on
 * re-import"; board-concurrency: "Re-import is idempotent"; board-events:
 * "Fold semantics": "A ticket SHALL always be created in `todo`; an import
 * that needs another status writes the permitted moves").
 */

import { dirname } from 'node:path';

import type { Ticket } from '../events/fold.js';
import {
  TASK_SOURCE_PATTERN,
  type Status,
  type TaskRef,
  type TicketChecklistAddItem,
  type TicketCreateBody,
  type TicketReconcileUpdate,
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

/**
 * Jaccard similarity a ticket and a group need, at least, to be paired by
 * content (pass 2 of `pairTickets`).
 */
export const PAIR_THRESHOLD = 0.5;

/**
 * How much lower than a content pair's score every other candidate of
 * either side must score (pass 2), and the score from which another
 * candidate prevents a pairing by number (pass 3).
 */
export const PAIR_MARGIN = 0.2;

/**
 * The normalised form of a title for pairing (board-openspec-integration:
 * "Pair tickets to groups by identity"). Pure. In order:
 * 1. lowercase (`String.prototype.toLowerCase`);
 * 2. remove a leading number: a match of `^\s*[0-9]+(\.[0-9]+)*\.?\s+`
 *    (`5. Docs` and `5 Docs` become `docs`; `5.Docs` keeps its number);
 * 3. replace every run of characters other than `a-z` and `0-9` with one
 *    space;
 * 4. trim spaces at both ends.
 * Examples: `Re-import reconciliation (\`openspec/reconcile-import\`)` is
 * `re import reconciliation openspec reconcile import`; `## 5.` style
 * headings never reach it (the parser strips them), but a hand-written
 * ticket title `3. CLI core` is `cli core`.
 */
export function normaliseTitle(text: string): string {
  void text;
  throw new Error('not implemented');
}

/**
 * The normalised form of a task line for pairing: the line with a leading
 * checkbox (`- [ ] `, `- [x] ` or `- [X] `, if any) removed, then exactly
 * `normaliseTitle` (which removes the leading task number, so
 * `- [x] 1.2 Add B, with retries` and `3.4 add b with retries` are both
 * `add b with retries`). Pure.
 */
export function normaliseTaskLine(text: string): string {
  void text;
  throw new Error('not implemented');
}

/**
 * The task number of a checklist or task line: the leading
 * `<n>.<m>[.<k>...]`, a match of `^([0-9]+(\.[0-9]+)+)\.?(?=\s|$)` (group
 * 1), or null when the line has none (`1.2 Add B` is `1.2`, `1.2. Add B`
 * is `1.2`, `1.2.3 Sub` is `1.2.3`, `12 Add` and `Add 1.2` are null).
 * Pure.
 */
export function taskNumber(text: string): string | null {
  void text;
  throw new Error('not implemented');
}

/**
 * Jaccard similarity of two collections of normalised lines, taken as
 * sets (duplicates count once): `|A and B| / |A or B|`, in 0..1. Two empty
 * sets score 0 (no evidence of identity). Pure.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  void a;
  void b;
  throw new Error('not implemented');
}

/** The part of a ticket that pairing reads. */
export type PairingTicket = Pick<Ticket, 'id' | 'title' | 'task' | 'checklist'>;

/** Which pass of `pairTickets` paired a ticket with a group. */
export type PairPass = 'title' | 'content' | 'number';

/** A ticket paired with a group. */
export interface Pair {
  /** Ticket id. */
  ticket: string;
  /** The group's `item` (its current number). */
  item: string;
  pass: PairPass;
  /**
   * `jaccard` of the ticket's normalised active checklist lines (lines
   * without `removed`, through `normaliseTaskLine`) and the group's
   * normalised task lines, whatever the pass.
   */
  score: number;
}

/** A still-unpaired ticket and group that could be the same (see `PairingReport.ambiguous`). */
export interface AmbiguousCandidate {
  ticket: string;
  item: string;
  /** As `Pair.score`. */
  score: number;
  /** True when their normalised titles are equal. */
  sameTitle: boolean;
}

/** Result of `pairTickets`. */
export interface PairingReport {
  /** One per paired group, in the order of `units`. */
  pairs: Pair[];
  /** The `item` of every group left unpaired (it gets a new ticket), in the order of `units`. */
  newGroups: string[];
  /** The id of every ticket left unpaired (it is superseded), in the order of `tickets`. */
  unpaired: string[];
  /**
   * Empty when the pairing is decided. Otherwise (the import refuses with
   * `reconcile-ambiguous`): every still-unpaired ticket and group with a
   * score of at least `PAIR_MARGIN` or equal normalised titles, ordered
   * by the ticket's position in `tickets`, then the group's in `units`.
   */
  ambiguous: AmbiguousCandidate[];
}

/**
 * Pairs a change's tickets with its current task groups by identity, never
 * by number alone (board-openspec-integration: "Pair tickets to groups by
 * identity"). Pure; reads no board.
 *
 * `tickets` are the change's tickets that are not superseded, open or
 * closed, in any order the caller chooses (the import passes them by
 * ascending id); `units` are the groups in tasks file order. A ticket's
 * lines are its active checklist lines (without `removed`), normalised
 * with `normaliseTaskLine`; a group's lines are its task line texts,
 * normalised the same way; titles are normalised with `normaliseTitle`.
 * Scores are `jaccard` of those line sets. Scores are compared exactly,
 * as the rationals they are (shared over union), never with a rounding
 * error: a best score of 0.7 against another of 0.5 meets the 0.2 margin.
 *
 * Three passes, each over the tickets and groups still unpaired when it
 * starts, each deciding all of its pairs at once:
 * 1. title: a ticket and a group with equal normalised titles, when no
 *    other unpaired ticket and no other unpaired group has that
 *    normalised title;
 * 2. content: a ticket `t` and a group `g` with score `s >= PAIR_THRESHOLD`
 *    such that every other unpaired group scores at most `s - PAIR_MARGIN`
 *    against `t` and every other unpaired ticket scores at most
 *    `s - PAIR_MARGIN` against `g`;
 * 3. number: a ticket whose `task.item` equals a group's `item`, when no
 *    other unpaired ticket has that item, no other unpaired group scores
 *    `PAIR_MARGIN` or more against the ticket, and no other unpaired
 *    ticket scores `PAIR_MARGIN` or more against the group.
 *
 * The pairing is ambiguous when, after the three passes, a still-unpaired
 * ticket and a still-unpaired group score at least `PAIR_THRESHOLD` or
 * have equal normalised titles (a best match whose margin was not met, or
 * a tie); `ambiguous` then lists the candidates as documented on
 * `PairingReport`, and `pairs`, `newGroups` and `unpaired` still describe
 * the passes' outcome.
 */
export function pairTickets(
  tickets: readonly PairingTicket[],
  units: readonly TaskUnit[],
): PairingReport {
  void tickets;
  void units;
  throw new Error('not implemented');
}

/** One `ticket.renumber` the import writes. */
export interface RenumberStep {
  ticket: string;
  from: string;
  to: string;
}

/**
 * Orders two task items: two decimal numbers (`^[0-9]+$`) by numeric
 * value, a decimal number before anything else, and otherwise by string
 * order; -1, 0 or 1. Pure.
 */
export function compareItems(a: string, b: string): -1 | 0 | 1 {
  void a;
  void b;
  throw new Error('not implemented');
}

/**
 * The renumbers of a pairing: one step per pair whose ticket's
 * `task.item` differs from the pair's `item` (`from` the ticket's item,
 * `to` the group's), in ascending order of `from` by `compareItems`, ties
 * by ticket id. Pairs whose ticket is not in `tickets` are ignored. Because
 * the fold does not require items to be unique, a swap (2 to 3 and 3 to 2)
 * needs no temporary number. Pure.
 */
export function renumberPlan(
  tickets: readonly PairingTicket[],
  pairs: readonly Pair[],
): RenumberStep[] {
  void tickets;
  void pairs;
  throw new Error('not implemented');
}

/**
 * The difference between a paired ticket and its group: what one
 * `ticket.reconcile` carries, without `forced`, `holder` and `source`.
 */
export interface ReconcileDiff {
  /** The group's title when it differs from the ticket's (exact comparison), else null. */
  title: string | null;
  /** Changed lines, ascending by index. */
  updated: TicketReconcileUpdate[];
  /** Indices of lines to mark removed, ascending. */
  removed: number[];
  /** Lines to append, in tasks file order. */
  added: TicketChecklistAddItem[];
}

/**
 * The reconcile diff of a ticket against its group's current task lines
 * (board-openspec-integration: "Reconcile on re-import"), or null when
 * nothing differs. Pure.
 *
 * Only the ticket's active lines (without `removed`) take part; removed
 * lines are never matched, updated or removed again. Lines are matched in
 * two passes, each line matched at most once:
 * 1. by task number (`taskNumber`): an active ticket line and a task line
 *    with the same number; when several lines on either side share a
 *    number, the k-th such ticket line (in index order) matches the k-th
 *    such task line (in file order);
 * 2. for lines still unmatched, by text with the task number removed (the
 *    text after the number and the whitespace that follows it; the whole
 *    text when there is no number), compared exactly, the k-th with the
 *    k-th as above.
 * Then:
 * - a matched line whose text is unchanged: nothing (it keeps its done
 *   flag, even when the tasks file's checkbox differs);
 * - a matched line whose text differs only in its task number (its text
 *   without the number is equal): in `updated` with the new text and the
 *   ticket's done flag;
 * - any other matched line whose text differs: in `updated` with the new
 *   text and the done flag of its tasks file checkbox;
 * - an active ticket line left unmatched: in `removed`;
 * - a task line left unmatched: in `added`, with its checkbox as `done`,
 *   in file order.
 * `title` as documented on `ReconcileDiff`. Null when `title` is null and
 * the three lists are empty.
 */
export function reconcileDiff(
  ticket: Pick<Ticket, 'title' | 'checklist'>,
  unit: TaskUnit,
): ReconcileDiff | null {
  void ticket;
  void unit;
  throw new Error('not implemented');
}

/**
 * Why a reconcile is blocked on one line: `done`, the line is done on the
 * ticket; `held`, the ticket is assigned and in `tests`, `implementing` or
 * `review`.
 */
export type BlockReason = 'done' | 'held';

/** A line whose change blocks a reconcile. */
export interface BlockedLine {
  /** The checklist index. */
  index: number;
  /** The line's current text on the ticket. */
  text: string;
  /** What the reconcile would do to it. */
  change: 'updated' | 'removed';
  /** `done` when the line is done, else `held`. */
  reason: BlockReason;
}

/**
 * The lines that block `diff` on `ticket` (board-openspec-integration:
 * "Reconcile on re-import"), ascending by index; empty when the reconcile
 * may be written without `--force`. Pure.
 *
 * Considered: every `removed` line, and every `updated` line whose text
 * changes other than only in its task number (a renumbered line is not a
 * rewording and never blocks). Such a line blocks with reason `done` when
 * it is done on the ticket, else with reason `held` when the ticket's
 * assignee is not null and its status is `tests`, `implementing` or
 * `review`. A title change and added lines never block.
 */
export function reconcileGuard(
  ticket: Pick<Ticket, 'status' | 'assignee' | 'checklist'>,
  diff: ReconcileDiff,
): BlockedLine[] {
  void ticket;
  void diff;
  throw new Error('not implemented');
}

/**
 * The `source` of a `ticket.reconcile`: `<tasksFile>@sha256:<hex>`, where
 * `<hex>` is the lowercase hex SHA-256 of `bytes`, the tasks file exactly
 * as this import read it. Pure.
 */
export function reconcileSource(tasksFile: string, bytes: Uint8Array): string {
  void tasksFile;
  void bytes;
  throw new Error('not implemented');
}

/** Options of `importChange`. */
export interface ImportOptions extends WriteOptions {
  /** `--dry-run`: compute and report everything, write nothing. */
  dryRun?: boolean | undefined;
  /** `--force`: write blocked reconciles too, with `forced` true. */
  force?: boolean | undefined;
}

/**
 * What an import did (or, in a dry run, would do) to one group's ticket or
 * to one unpaired ticket:
 * - `created`: the group had no ticket, so one was created;
 * - `updated`: a paired ticket got a renumber, a reconcile, or both;
 * - `unchanged`: a paired ticket, nothing written (a closed ticket whose
 *   lines differ is `unchanged` too, with its `diff`);
 * - `blocked`: a paired ticket whose reconcile the guard blocked and
 *   `--force` was not given (a renumber may still have been written);
 * - `superseded`: a ticket paired with no group got a `ticket.supersede`.
 */
export type ImportAction = 'created' | 'updated' | 'unchanged' | 'blocked' | 'superseded';

/** One entry of an import: a group and its ticket, or an unpaired ticket. */
export interface ImportedTicket {
  /** The group's `item` (its current number); null for a `superseded` entry. */
  item: string | null;
  /** The group's title; for a `superseded` entry, the ticket's title. */
  title: string;
  /** The ticket's id; null only for a `created` entry of a dry run. */
  id: string | null;
  action: ImportAction;
  /** How the ticket was paired with the group; null for `created` and `superseded`. */
  pairing: { pass: PairPass; score: number } | null;
  /** The renumber written (or due in a dry run), else null. */
  renumber: { from: string; to: string } | null;
  /**
   * `reconcileDiff` of the paired ticket (after its renumber) against the
   * group, null when nothing differs, and null for `created` and
   * `superseded`. Also set for a closed ticket, which is never reconciled.
   */
  diff: ReconcileDiff | null;
  /** `reconcileGuard` of `diff`; empty when not blocked (and for a closed ticket). */
  blocked: BlockedLine[];
  /** True when the reconcile was (or in a dry run would be) written with `forced` true. */
  forced: boolean;
  /** The reason of the supersede written (or due), else null. */
  supersede: string | null;
  /** Hashes of the events written for this entry, in the order written; empty in a dry run. */
  events: string[];
  /**
   * The ticket after the import, as `readTicket` returns it; in a dry run
   * the ticket as it is; null only for a `created` entry of a dry run.
   */
  ticket: Ticket | null;
}

/** Result of `importChange`; also the `import-change --json` document (dry run included). */
export interface ImportResult {
  source: string;
  ref: string;
  /** Root-relative POSIX path of the tasks file read (`SourceAdapter.tasksPath`). */
  tasksFile: string;
  /** True for `--dry-run`. */
  dryRun: boolean;
  /**
   * One entry per group, in tasks file order, then one per `superseded`
   * ticket, by ascending item (`compareItems`) and then id.
   */
  tickets: ImportedTicket[];
  /** `PairingReport.ambiguous`: empty unless the pairing is ambiguous. */
  ambiguous: AmbiguousCandidate[];
  /** Total number of events written by this import (always 0 in a dry run). */
  events: number;
}

/**
 * An import refused after it computed its result: `reconcile-ambiguous`
 * (nothing written) or `reconcile-blocked` (every other group written).
 * Exit 4; `result` is the import's result (for `reconcile-ambiguous`, the
 * dry-run result, with `ambiguous` listing the candidates).
 */
export class ImportRefusedError extends BoardError {
  readonly result: ImportResult;

  constructor(
    reason: 'reconcile-ambiguous' | 'reconcile-blocked',
    message: string,
    result: ImportResult,
  ) {
    super(4, reason, message);
    this.name = 'ImportRefusedError';
    this.result = result;
  }
}

/**
 * `import-change`: makes the change's tickets follow its current tasks file
 * (board-openspec-integration: "Import a change", "Pair tickets to groups
 * by identity", "Reconcile on re-import"; board-concurrency: "Re-import is
 * idempotent"; board-events: "Fold semantics": "A ticket SHALL always be
 * created in `todo`; an import that needs another status writes the
 * permitted moves").
 *
 * Checks, in order, before anything is written:
 * 1. `actor` empty: `BoardError(1, 'missing-actor')`.
 * 2. No adapter for `target.source` (`sourceAdapter`):
 *    `BoardError(1, 'unsupported-source')` whose message names the source
 *    and says only `openspec` can be imported by this version.
 * 3. The units, `adapter.listUnits(dirname(board.dir), target.ref)`:
 *    `usage`, `tasks-not-found` (naming the tasks file path) or
 *    `malformed-tasks` from the adapter propagate unchanged.
 * 4. `refuseSecretLike(texts, false, false)` over every unit title and
 *    every task line text (exit 1 `secret-like`, naming the pattern only).
 *    There is no bypass flag, so the message does not mention
 *    `--allow-secret-like`. A refused import writes nothing at all.
 *
 * The change's tickets are every ticket, open or closed, whose task
 * reference has the `source` and `ref` of `target` (any item) and which is
 * not superseded; superseded tickets take no further part. The import
 * pairs them with the units (`pairTickets`, tickets by ascending id, on
 * the caught-up state) and then writes, in this order:
 * 1. the renumbers of `renumberPlan`, one `ticket.renumber {from, to}`
 *    each, in its order;
 * 2. for each unit in file order:
 *    - an unpaired unit: a new ticket, exactly as a first import creates
 *      one: one `ticket.create` with `title` the unit title, `labels`
 *      `adapter.labels(ref, unit)`, `task` `{ source, ref, item }` and
 *      `checklist` the task line texts (omitted when there are none), no
 *      description; then one `ticket.checklist` tick per ticked line in
 *      index order; then, when the unit has at least one task line and
 *      all are ticked, the moves `tests`, `implementing`, `review`,
 *      `merged`, so the ticket ends in `merged`;
 *    - a paired closed ticket: nothing (its `diff` is still reported);
 *    - a paired open ticket: `reconcileDiff` of the ticket (after its
 *      renumber) against the unit; nothing when it is null; when
 *      `reconcileGuard` returns lines and `force` is not set, nothing
 *      (the entry is `blocked`); otherwise one `ticket.reconcile` whose
 *      `title` (only when not null), `updated`, `removed` and `added` are
 *      the diff's, `forced` is true exactly when the guard returned lines
 *      (so only `force` makes it true), `holder` is the ticket's assignee
 *      when `forced` is true and the ticket is assigned (absent
 *      otherwise), and `source` is `reconcileSource(tasksFile, <the tasks
 *      file bytes this import read>)`;
 * 3. for each unpaired ticket, by ascending item (`compareItems`) then
 *    id, one `ticket.supersede` with reason
 *    `group removed from <tasksFile>`.
 * So a ticket gets at most one renumber, one reconcile and one supersede,
 * and a tasks file that matches the board writes nothing. An import never
 * changes a ticket's status or assignee, and its labels only through a
 * renumber; the moves of a newly created, fully ticked group are the only
 * status changes it writes.
 *
 * Each event is written in its own command transaction (`runCommand`, with
 * `options`), whose operation re-checks the event against the caught-up
 * state, so a concurrent import of the same change never makes this one
 * write a stale or duplicate event: a renumber whose ticket's item no
 * longer equals `from`, a reconcile whose diff recomputed on the caught-up
 * ticket is null (one that is not null is written as recomputed), a
 * supersede of a ticket already superseded, and the create of a unit for
 * which a concurrent import has meanwhile created a ticket (a ticket of
 * the change, not superseded, with the unit's item and the unit's
 * normalised title) are skipped and not reported. A crash part way leaves
 * the events written so far; a re-import finishes the rest.
 *
 * Refusals after pairing (`ImportRefusedError`, exit 4):
 * - `reconcile-ambiguous` when the pairing is ambiguous: nothing at all
 *   is written; the message is the line
 *   `pairing tickets with the groups of <tasksFile> is ambiguous; nothing was written`
 *   followed, for each `AmbiguousCandidate`, by a line
 *   `  <ticket id> group <item> score <score with two decimals>`, with
 *   ` (same title)` appended when `sameTitle`; `result` is the dry-run
 *   result (`dryRun` true, `ambiguous` set).
 * - `reconcile-blocked` after every unit and unpaired ticket has been
 *   processed, when at least one entry is `blocked`; the message is the
 *   line
 *   `reconcile blocked for <n> ticket(s); every other group was imported`
 *   followed, per blocked entry in result order, by
 *   `  <id> group <item> <title>` and, per blocked line,
 *   `    blocked <index> <text> (done)` or
 *   `    blocked <index> <text> (held by <assignee> in <status>)`; `result`
 *   is the import's result.
 *
 * With `dryRun`: the same result is computed against the current state
 * and returned with `dryRun` true, `events` 0, every entry's `events`
 * empty and, for a `created` entry, `id` and `ticket` null; no event file
 * or temporary file is created, and neither refusal above is thrown (the
 * ambiguous candidates are in `ambiguous`, blocked entries are `blocked`
 * unless `force`).
 */
export function importChange(
  board: Board,
  actor: string,
  target: ImportTarget,
  options?: ImportOptions,
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
    false,
  );
  if (options?.dryRun === true || options?.force === true) {
    throw new Error('not implemented');
  }
  const tickets = units.map((unit) =>
    importUnit(board, actor, target, adapter.labels(target.ref, unit), unit, options),
  );
  return {
    source: target.source,
    ref: target.ref,
    tasksFile: adapter.tasksPath(target.ref),
    dryRun: false,
    tickets,
    ambiguous: [],
    events: tickets.reduce((sum, t) => sum + t.events.length, 0),
  };
}

/** An entry with no pairing, renumber, diff, block or supersede. */
function plainEntry(
  unit: TaskUnit,
  action: ImportAction,
  ticket: Ticket,
  events: string[],
  diff: ReconcileDiff | null,
): ImportedTicket {
  return {
    item: unit.item,
    title: unit.title,
    id: ticket.id,
    action,
    pairing: null,
    renumber: null,
    diff,
    blocked: [],
    forced: false,
    supersede: null,
    events,
    ticket,
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
  options: ImportOptions | undefined,
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
      return plainEntry(unit, 'unchanged', error.ticket, [], null);
    }
    throw error;
  }
  const events = [first.hash];
  let ticket = ticketOf(first.ticket);
  if (first.event.kind === 'ticket.checklist.add') {
    const added = first.event.body.items.map((item) => ({ text: item.text, done: item.done }));
    return plainEntry(unit, 'updated', ticket, events, {
      title: null,
      updated: [],
      removed: [],
      added,
    });
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
  return plainEntry(unit, 'created', ticket, events, null);
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
