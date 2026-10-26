/**
 * Creating and reading tickets: `new`, `show` (with `--raw`) and `list`
 * (board-cli: "Command surface", "Output conventions";
 * board-openspec-integration: "Tickets reference tasks").
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalDecode, type JsonValue } from '../events/canonical.js';
import { compareFoldOrder, dueGrant, type FoldInput, type Ticket } from '../events/fold.js';
import {
  isKnownEvent,
  type BoardEvent,
  type Status,
  type TaskRef,
  type TicketCreateBody,
} from '../events/schema.js';
import { newUlid } from '../events/ulid.js';
import type { Board } from '../store/board.js';
import { readState } from '../store/cache.js';
import { inSnapshot, loadMeta, stmt } from '../store/engine.js';
import { BoardError } from '../store/errors.js';
import { readEventFile, readEventLog } from '../store/eventfile.js';
import { runCommand } from '../store/transaction.js';
import { leaseDocument, type LeaseDocument } from './leases.js';
import { requireActor, resolveTicket, ticketOf } from './lookup.js';
import type { TaskFilter } from './resolve.js';
import { refuseSecretLike } from './secrets.js';
import { TASK_RULE } from './text.js';
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
  requireActor(actor);
  const labels = input.labels ?? [];
  const checklist = input.checklist ?? [];
  if (input.title === '') {
    throw new BoardError(1, 'usage', 'the title must not be empty');
  }
  if (labels.includes('')) {
    throw new BoardError(1, 'usage', 'a label must not be empty');
  }
  if (checklist.includes('')) {
    throw new BoardError(1, 'usage', 'a checklist line must not be empty');
  }
  if (input.adhoc === '') {
    throw new BoardError(1, 'usage', 'the ad hoc reason must not be empty');
  }
  if (input.task === undefined && input.adhoc === undefined) {
    throw new BoardError(1, 'needs-task-or-adhoc', TASK_RULE);
  }
  if (input.task !== undefined && input.adhoc !== undefined) {
    throw new BoardError(1, 'usage', 'give either a task reference or an ad hoc reason, not both');
  }
  refuseSecretLike(
    [input.title, input.description ?? '', ...labels, ...checklist, input.adhoc ?? ''],
    input.allowSecretLike === true,
  );
  const body: TicketCreateBody = { title: input.title };
  if (input.description !== undefined) {
    body.description = input.description;
  }
  if (labels.length > 0) {
    body.labels = [...labels];
  }
  if (input.task !== undefined) {
    body.task = { ...input.task };
  }
  if (input.adhoc !== undefined) {
    body.adhoc = input.adhoc;
  }
  if (checklist.length > 0) {
    body.checklist = [...checklist];
  }
  const result = runCommand(
    board,
    actor,
    () => ({ ok: true, event: { kind: 'ticket.create', ticket: newUlid(), body } }),
    options,
  );
  return {
    hash: result.hash,
    events: result.events.map((written) => written.hash),
    ticket: ticketOf(result.ticket),
  };
}

/**
 * A ticket as `show --json` and `list --json` carry it (board-cli: "Leases
 * on the command line"): the folded `Ticket` exactly, `available` and the
 * queue's `Waiter`s (`actor`, `ttl`, `event`, `joined`) included, except
 * that `lease` is null or its `LeaseDocument` at the command's clock
 * (`leaseDocument`), with `state` and `claimableAt`. The documents of
 * writing commands keep the folded `Ticket` as it is.
 */
export interface TicketDocument extends Omit<Ticket, 'lease'> {
  lease: LeaseDocument | null;
}

/**
 * The grant `show` displays (board-cli: "Leases on the command line"):
 * `to` (the grantee), `at` (the grant's slot time, its wall) and
 * `acceptBy` (the time by which the grantee must renew to accept it,
 * `at + window`).
 */
export interface GrantView {
  to: string;
  at: number;
  acceptBy: number;
}

/**
 * The last applied takeover of a ticket: a `ticket.claim` with
 * `supersedes` that was applied while the ticket was held (one applied on
 * a free ticket ignores its `supersedes` and is not a takeover).
 */
export interface TakeoverView {
  /** The actor that took the ticket over. */
  actor: string;
  /** The takeover's wall time. */
  at: number;
  /** `supersedes.holder`: the previous holder. */
  holder: string;
  /** `supersedes.expiresAt`: when the previous holder's lease expired. */
  expiresAt: number;
  /** The takeover claim's hash. */
  event: string;
}

/** The last applied `ticket.release.force` of a ticket. */
export interface ForcedReleaseView {
  /** The actor that forced the release. */
  actor: string;
  /** Its wall time. */
  at: number;
  /** `body.holder`: the holder released. */
  holder: string;
  /** `body.reason`. */
  reason: string;
  /** Its hash. */
  event: string;
}

/** Result of `showTicket`; also the `show --json` document. */
export interface ShowResult {
  ticket: TicketDocument;
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
  /**
   * The applied grant waiting for acceptance: present exactly when the
   * ticket's current lease was set by an applied `ticket.grant` (its
   * `lease.event` is that grant's hash, so it is not confirmed yet):
   * `{ to: the grant's to, at: its wall, acceptBy: lease.expiresAt }`.
   * Absent otherwise (a renew by the grantee replaces the lease).
   */
  grant?: GrantView;
  /**
   * The grant that is not yet written because its slot time is still to
   * come: present exactly when `dueGrant(ticket, meta)` (the folded meta)
   * is not null, as `{ to: body.to, at: ts.wall, acceptBy: ts.wall +
   * body.window }`. For a ticket held under a lease with waiters, the
   * grant that follows if the lease lapses.
   */
  nextGrant?: GrantView;
  /** The ticket's last applied takeover, when it has one (see `TakeoverView`). */
  takeover?: TakeoverView;
  /** The ticket's last applied forced release, when it has one. */
  forcedRelease?: ForcedReleaseView;
}

/** Options of `showTicket` and `listTickets`. */
export interface ReadOptions {
  /**
   * The clock reading the lease state is computed at, in milliseconds
   * since the epoch. Defaults to `Date.now()`, read once per call.
   */
  now?: number | undefined;
}

/**
 * `show`: resolves `id` (full id or prefix, `resolveTicketId`) and reads
 * the ticket from the cache. Resolution, the ticket read and the folded
 * meta come from one read snapshot of the cache (a single read
 * transaction), so a concurrent writer can never make `version` disagree
 * with the comment list. The ticket is returned as its `TicketDocument` at
 * `options.now`. `grant`, `nextGrant`, `takeover` and `forcedRelease` are
 * filled as `ShowResult` documents them; the takeover and forced release
 * are read from the ticket's applied event files (board-cache: "Cache
 * schema": `show` MAY read them).
 *
 * @throws BoardError as `resolveTicketId` (exit 1 `id-too-short` or
 *   `ambiguous-id`, exit 4 `unknown-ticket`).
 */
export function showTicket(board: Board, id: string, options?: ReadOptions): ShowResult {
  const now = options?.now ?? Date.now();
  const { db } = board;
  const { ticket, meta, unknownHashes, applied } = inSnapshot(db, () => ({
    ticket: resolveTicket(db, id),
    meta: loadMeta(db),
    unknownHashes: stmt(db, "SELECT hash FROM folded WHERE reason = 'unknown-kind'")
      .all()
      .map((row) => String(row.hash)),
    applied: new Set(
      stmt(db, 'SELECT hash FROM folded WHERE folded = 1')
        .all()
        .map((row) => String(row.hash)),
    ),
  }));
  const unknown: FoldInput[] = [];
  for (const hash of unknownHashes) {
    const read = readEventFile(board.eventsDir, `${hash}.json`);
    if (read.status === 'ok' && ticketOfEvent(read.input) === ticket.id) {
      unknown.push(read.input);
    }
  }
  unknown.sort(compareFoldOrder);
  const result: ShowResult = {
    ticket: ticketDocument(ticket, now),
    events: ticket.version,
    unknown: unknown.map((input) => ({ hash: input.hash, kind: input.event.kind })),
  };
  const next = dueGrant(ticket, meta);
  if (next !== null) {
    result.nextGrant = {
      to: next.body.to,
      at: next.ts.wall,
      acceptBy: next.ts.wall + next.body.window,
    };
  }
  // The applied grant, takeover and forced release come from the ticket's
  // applied event files, which only show reads (board-cache: "Cache
  // schema"). A ticket with only its create has none of them.
  if (ticket.version > 1) {
    Object.assign(result, history(board, ticket, applied));
  }
  return result;
}

/**
 * The parts of `ShowResult` read from the ticket's applied event files
 * (`grant`, `takeover`, `forcedRelease`), walking them in fold order.
 */
function history(
  board: Board,
  ticket: Ticket,
  applied: ReadonlySet<string>,
): Pick<ShowResult, 'grant' | 'takeover' | 'forcedRelease'> {
  const events = readEventLog(board.eventsDir)
    .inputs.filter((input) => applied.has(input.hash) && ticketOfEvent(input) === ticket.id)
    .sort(compareFoldOrder);
  const out: Pick<ShowResult, 'grant' | 'takeover' | 'forcedRelease'> = {};
  // The assignee before each event, replayed from the events that set it,
  // so a claim carrying supersedes counts as a takeover only when the
  // ticket was held (one applied on a free ticket ignores its supersedes).
  let assignee: string | null = null;
  for (const { hash, event } of events) {
    if (!isKnownEvent(event)) {
      continue;
    }
    switch (event.kind) {
      case 'ticket.claim':
        if (assignee !== null && event.body.supersedes !== undefined) {
          out.takeover = {
            actor: event.actor,
            at: event.ts.wall,
            holder: event.body.supersedes.holder,
            expiresAt: event.body.supersedes.expiresAt,
            event: hash,
          };
        }
        assignee = event.actor;
        break;
      case 'ticket.release.force':
        out.forcedRelease = {
          actor: event.actor,
          at: event.ts.wall,
          holder: event.body.holder,
          reason: event.body.reason,
          event: hash,
        };
        assignee = null;
        break;
      case 'ticket.grant':
        if (ticket.lease?.event === hash) {
          out.grant = { to: event.body.to, at: event.ts.wall, acceptBy: ticket.lease.expiresAt };
        }
        assignee = event.body.to;
        break;
      default:
        assignee = assigneeAfter(event, assignee);
    }
  }
  return out;
}

/** The assignee after `event` applied (for the kinds `history` does not handle itself). */
function assigneeAfter(event: BoardEvent, before: string | null): string | null {
  switch (event.kind) {
    case 'ticket.assign':
    case 'ticket.handoff':
      return event.body.to;
    case 'ticket.release':
      return null;
    default:
      return before;
  }
}

/**
 * The `TicketDocument` of `ticket` at `now`: a copy of `ticket` whose
 * `lease` is `leaseDocument(ticket.lease, now)`, or null without a lease.
 */
function ticketDocument(ticket: Ticket, now: number): TicketDocument {
  return { ...ticket, lease: ticket.lease === null ? null : leaseDocument(ticket.lease, now) };
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
  const ticket = inSnapshot(board.db, () => resolveTicket(board.db, id));
  const inputs = readEventLog(board.eventsDir)
    .inputs.filter((input) => ticketOfEvent(input) === ticket.id)
    .sort(compareFoldOrder);
  return inputs.map((input) => {
    const bytes = readFileSync(join(board.eventsDir, `${input.hash}.json`));
    return {
      hash: input.hash,
      text: new TextDecoder().decode(bytes),
      event: canonicalDecode(bytes),
    };
  });
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
 * as ids are ULIDs), each as its `TicketDocument` at `options.now`.
 * Closed tickets are excluded unless `filter.closed`. Reads only the
 * cache, in one read snapshot (`readState`).
 */
export function listTickets(
  board: Board,
  filter?: ListFilter,
  options?: ReadOptions,
): TicketDocument[] {
  const now = options?.now ?? Date.now();
  const f = filter ?? {};
  const labels = f.labels ?? [];
  return Object.values(readState(board.db).tickets)
    .filter(
      (t) =>
        (f.closed === true || !t.closed) &&
        (f.status === undefined || t.status === f.status) &&
        (f.assignee === undefined || t.assignee === f.assignee) &&
        (f.task === undefined || matchesTask(t, f.task)) &&
        labels.every((label) => t.labels.includes(label)),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((t) => ticketDocument(t, now));
}

/** The `ticket` field of an event, or undefined for `board.meta` and ticketless unknown kinds. */
function ticketOfEvent(input: FoldInput): string | undefined {
  return 'ticket' in input.event ? input.event.ticket : undefined;
}

function matchesTask(ticket: Ticket, filter: TaskFilter): boolean {
  const task = ticket.task;
  return (
    task !== null &&
    task.source === filter.source &&
    task.ref === filter.ref &&
    (filter.item === undefined || task.item === filter.item)
  );
}
