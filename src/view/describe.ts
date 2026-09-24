/**
 * One-line summaries of events (board-view-model: "Activity feed
 * entries"). Pure and browser-safe; see `types.ts`.
 */

import type { BoardEvent, UnknownKindEvent } from '../events/schema.js';

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
  throw new Error(`not implemented: describeEvent(${event.kind})`);
}
