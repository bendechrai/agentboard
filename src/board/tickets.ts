/**
 * Creating and reading tickets: `new`, `show` (with `--raw`) and `list`
 * (board-cli: "Command surface", "Output conventions";
 * board-openspec-integration: "Tickets reference tasks").
 */

import type { JsonValue } from '../events/canonical.js';
import type { Ticket } from '../events/fold.js';
import type { Status, TaskRef } from '../events/schema.js';
import type { Board } from '../store/board.js';
import type { TaskFilter } from './resolve.js';
import { notImplemented } from './stub.js';
import type { WriteOptions, WriteOutcome } from './types.js';

/** Input of `newTicket`. */
export interface NewTicketInput {
  title: string;
  description?: string | undefined;
  /** Kept in the given order; duplicates kept. */
  labels?: readonly string[] | undefined;
  /** Exactly one of `task` and `adhoc` must be given. */
  task?: TaskRef | undefined;
  /** Non-empty reason the ticket has no task. */
  adhoc?: string | undefined;
  /** Checklist lines, all initially not done. */
  checklist?: readonly string[] | undefined;
  /** Skips the secret-pattern refusal (`--allow-secret-like`). */
  allowSecretLike?: boolean | undefined;
}

/**
 * `new`: writes one `ticket.create` with a fresh ULID (`newUlid`) through
 * `runCommand`. The body carries `title`, and `description`, `labels`,
 * `task`, `adhoc` and `checklist` only when given (empty arrays are
 * omitted). The ticket is created in `todo`, unassigned.
 *
 * Checks, before anything is written:
 * - `title` empty, a label or checklist line empty, or `adhoc` empty:
 *   `BoardError(1, 'usage')`.
 * - neither `task` nor `adhoc`: `BoardError(1, 'needs-task-or-adhoc')`,
 *   explaining that tickets must reference a task (`--task` or `--change`
 *   with `--group`) or be marked ad hoc with `--adhoc <reason>`.
 * - both: `BoardError(1, 'usage')`.
 * - secret-looking text in title, description, labels, checklist lines or
 *   ad hoc reason: `refuseSecretLike` (exit 1, `secret-like`) unless
 *   `allowSecretLike`.
 *
 * @throws BoardError exit 1 `missing-actor` when `actor` is empty.
 */
export function newTicket(
  board: Board,
  actor: string,
  input: NewTicketInput,
  options?: WriteOptions,
): WriteOutcome {
  throw notImplemented(board, actor, input, options);
}

/** Result of `showTicket`; also the `show --json` document. */
export interface ShowResult {
  ticket: Ticket;
  /**
   * The event count: the number of applied events of this ticket (equal to
   * `ticket.version`), shown by the human output as `events: <n>`.
   */
  events: number;
  /**
   * Well-formed events of an unknown kind naming this ticket, in fold
   * order, each with its hash and kind (board-events: "Unknown kinds are
   * preserved": `show` reports them). Found from the `folded` rows whose
   * reason is `unknown-kind`; only those event files are read.
   */
  unknown: { hash: string; kind: string }[];
}

/**
 * `show`: resolves `id` (full id or prefix, `resolveTicketId`) and reads
 * the ticket from the cache. Resolution and the ticket read come from one
 * read snapshot of the cache (a single read transaction), so a concurrent
 * writer can never make `version` disagree with the comment list.
 *
 * @throws BoardError as `resolveTicketId` (exit 1 `id-too-short` or
 *   `ambiguous-id`, exit 4 `unknown-ticket`).
 */
export function showTicket(board: Board, id: string): ShowResult {
  throw notImplemented(board, id);
}

/** One event file of a ticket, as `show --raw` prints it. */
export interface RawEvent {
  /** The file's hash (its name without `.json`). */
  hash: string;
  /** The exact file content (canonical JSON text, no trailing newline). */
  text: string;
  /** The decoded content. */
  event: JsonValue;
}

/**
 * `show --raw`: resolves `id` like `showTicket`, then reads every event
 * file of the board (the only command that prints raw event files) and
 * returns those whose `ticket` field equals the id (applied, rejected and
 * unknown-kind alike; corrupt and malformed files are skipped), in fold
 * order. The human output prints each `text` on its own line; `--json`
 * prints the array.
 */
export function showRaw(board: Board, id: string): RawEvent[] {
  throw notImplemented(board, id);
}

/** Filters of `listTickets`. All given filters must match (AND). */
export interface ListFilter {
  status?: Status | undefined;
  /** Exact assignee. */
  assignee?: string | undefined;
  /** Task reference; without `item` it matches every item of `source:ref`. */
  task?: TaskFilter | undefined;
  /** Every label given must be among the ticket's labels. */
  labels?: readonly string[] | undefined;
  /** When true, closed tickets are included (with the open ones). */
  closed?: boolean | undefined;
}

/**
 * `list`: the tickets matching `filter`, ascending by id (creation order,
 * as ids are ULIDs). Closed tickets are excluded unless `filter.closed`.
 * Reads only the cache, in one read snapshot (`readState`).
 */
export function listTickets(board: Board, filter?: ListFilter): Ticket[] {
  throw notImplemented(board, filter);
}
