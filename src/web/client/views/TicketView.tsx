/**
 * The ticket detail (board-web: "Board views"; board-view-model:
 * "Conversation view"; add-board-web task 4.4). The ticket and its events
 * come from `loadTicketDetail(conn, id)` (the feed carries only effective
 * events, so rejected ones are read from the API), requested when the view
 * opens and again whenever `model.id` changes. The conversation is
 * `conversation({ events: detail.events }, detail.ticket.id)`.
 *
 * DOM contract (relied on by the component tests):
 * - while the first detail is loading, the text `Loading ticket...`; when
 *   the request fails, an element with `role="alert"` holding the
 *   `ApiError` message (for example the `unknown-ticket` message);
 * - an `article` with class `ticket` and `data-ticket="<full id>"`, with a
 *   heading holding the title, and a `dl` with class `fields` of `dt` and
 *   `dd` pairs, as text: `Id`, `Status`, `Assignee` (`none` when null),
 *   `Blocked from` (only while blocked), `Task` (`<source>:<ref>#<item>`,
 *   or `ad hoc: <reason>`), `Labels` (comma separated), `Created by`,
 *   `Description` (only when not null);
 * - a `ul` with class `checklist`: one `li` per line, in order, holding
 *   its text, with class `done` when done;
 * - a `ul` with class `links`: one `li` per link, in order, with the text
 *   `pr <pr>` or `decision <path>`;
 * - when closed, an element with class `disposition` holding
 *   `closed (decision <path>)` or `closed (no decision)`;
 * - an `ol` with class `conversation`: one `li` per message, in order,
 *   with class `message`, the message type (`comment`, `handoff` or
 *   `system`) as a class, and the classes `decision`, `retracted` and
 *   `retraction` for the flags that are set, and `data-hash`. A comment
 *   shows its actor and text; a hand-off its actor, `to <recipient>`, the
 *   status and the note; a system line its text;
 * - an `ol` with class `events`: one `li` per event of the detail, in
 *   order, with class `event`, `data-hash` and `data-outcome` (`applied`,
 *   `rejected` or `unknown`); it shows the kind, the actor, the outcome
 *   and, for a rejected event, its reason, as text.
 * Every text from the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import type { BoardModel } from '../../../view/types.js';
import type { Connection } from '../api.js';

export interface TicketViewProps {
  /** The id or prefix from the route. */
  id: string;
  /** The current model; a change of `model.id` reloads the detail. */
  model: BoardModel;
  /** The connection the app's client uses. */
  conn: Connection;
  now: number;
}

export function TicketView(props: TicketViewProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
