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

function describeClose(body: TicketCloseBody): string {
  return 'decision' in body ? `closed (decision ${oneLine(body.decision)})` : 'closed (no decision)';
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
 * - `ticket.checklist`: `checked <n>` when `done` is true, `unchecked <n>`
 *   otherwise, where `<n>` is the 1-based line number (`index + 1`)
 * - `ticket.checklist.add`: `added <k> checklist line(s)`, with `<k>` the
 *   number of items, the words `checklist line(s)` literal whatever `<k>`
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
  }
}
