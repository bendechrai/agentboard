/**
 * One-line summaries of events (board-view-model: "Activity feed
 * entries"). Pure and browser-safe; see `types.ts`.
 */

import {
  formatTaskRef,
  isKnownEvent,
  type BoardEvent,
  type TicketLinkBody,
  type TicketCloseBody,
  type TicketReconcileBody,
  type UnknownKindEvent,
} from '../events/schema.js';

/** Replaces every line break (`\r\n`, `\n` or `\r`) with one space. */
function oneLine(text: string): string {
  return text.replace(/\r\n|\n|\r/g, ' ');
}

function describeLink(body: TicketLinkBody): string {
  if ('task' in body) {
    return `linked task ${oneLine(formatTaskRef(body.task))}`;
  }
  if ('pr' in body) {
    return `linked pr ${oneLine(String(body.pr))}`;
  }
  return `linked decision ${oneLine(body.decision)}`;
}

function describeReconcile(body: TicketReconcileBody): string {
  const counts =
    `${String(body.updated.length)} updated, ${String(body.removed.length)} removed, ` +
    `${String(body.added.length)} added`;
  const renamed = body.title === undefined ? '' : ', renamed';
  const forced = body.forced ? ', forced' : '';
  return `reconciled with tasks (${counts}${renamed}${forced})`;
}

function describeClose(body: TicketCloseBody): string {
  return 'decision' in body
    ? `closed (decision ${oneLine(body.decision)})`
    : 'closed (no decision)';
}

/**
 * The one-line summary of an event, used by the activity feed, the system
 * lines of a conversation and the replay view. By kind, where `<...>` is
 * taken from the event body:
 * - `ticket.create`: `created <title>`
 * - `ticket.comment`: `commented: <text>`
 * - `ticket.move`: `moved to <to>`
 * - `ticket.claim`: `claimed`
 * - `ticket.release`: `released`
 * - `ticket.assign`: `assigned to <to>`
 * - `ticket.handoff`: `handed off to <to> (<status>): <note>`
 * - `ticket.link`: `linked task <source>:<ref>#<item>` (the task reference
 *   in text form, as `formatTaskRef`), `linked pr <pr>` (a PR number in
 *   decimal, or the string as given) or `linked decision <path>`
 * - `ticket.close`: `closed (decision <path>)` or `closed (no decision)`
 * - `ticket.unplanned`: `recorded as unplanned: <reason>` (ADR 0013;
 *   board-view-model: "Activity feed entries", scenario "Unplanned
 *   summary"), the reason on one line like every other text
 * - `ticket.checklist`: `checked <n>` when `done` is true, `unchecked <n>`
 *   otherwise, where `<n>` is the 1-based line number (`index + 1`)
 * - `ticket.checklist.add`: `added <k> checklist line(s)`, with `<k>` the
 *   number of items, the words `checklist line(s)` literal whatever `<k>`
 * - `ticket.reconcile`: `reconciled with tasks (<u> updated, <r> removed,
 *   <a> added[, renamed][, forced])`, where `<u>`, `<r>` and `<a>` are the
 *   lengths of `updated`, `removed` and `added` (each written, 0 included),
 *   `, renamed` appears when the body has a `title`, and `, forced` when
 *   `forced` is true, in that order
 * - `ticket.renumber`: `renumbered from group <from> to <to>`
 * - `ticket.supersede`: `superseded: <reason>`
 * - `board.meta`: `set <key>`
 * - a kind this version does not define: `unknown kind <kind>`
 *
 * Text taken from the event (title, comment text, note, actor names,
 * paths, keys) is inserted verbatim, except that every line break (each
 * `\r\n`, `\n` or `\r`) is replaced by one space, so the summary is always
 * one line. Nothing is truncated or escaped; views truncate and render the
 * summary as text. The outcome of the event is not consulted.
 */
export function describeEvent(event: BoardEvent | UnknownKindEvent): string {
  if (!isKnownEvent(event)) {
    return `unknown kind ${oneLine(event.kind)}`;
  }
  switch (event.kind) {
    case 'ticket.create':
      return `created ${oneLine(event.body.title)}`;
    case 'ticket.comment':
      return `commented: ${oneLine(event.body.text)}`;
    case 'ticket.move':
      return `moved to ${event.body.to}`;
    case 'ticket.claim':
      return 'claimed';
    case 'ticket.release':
      return 'released';
    case 'ticket.assign':
      return `assigned to ${oneLine(event.body.to)}`;
    case 'ticket.handoff':
      return `handed off to ${oneLine(event.body.to)} (${event.body.status}): ${oneLine(event.body.note)}`;
    case 'ticket.link':
      return describeLink(event.body);
    case 'ticket.close':
      return describeClose(event.body);
    case 'ticket.checklist':
      return `${event.body.done ? 'checked' : 'unchecked'} ${String(event.body.index + 1)}`;
    case 'ticket.checklist.add':
      return `added ${String(event.body.items.length)} checklist line(s)`;
    case 'board.meta':
      return `set ${oneLine(event.body.key)}`;
    case 'ticket.reconcile':
      return describeReconcile(event.body);
    case 'ticket.renumber':
      return `renumbered from group ${oneLine(event.body.from)} to ${oneLine(event.body.to)}`;
    case 'ticket.supersede':
      return `superseded: ${oneLine(event.body.reason)}`;
    case 'ticket.unplanned':
      return `recorded as unplanned: ${oneLine(event.body.reason)}`;
    case 'ticket.renew':
    case 'ticket.release.force':
    case 'ticket.queue.join':
    case 'ticket.queue.leave':
    case 'ticket.grant':
      // Provisional: the kind itself, until the lease, queue and grant
      // summaries of board-view-model are written (add-claim-leases 6.2).
      // It must not throw: this module is bundled into the web client.
      return event.kind;
  }
}
