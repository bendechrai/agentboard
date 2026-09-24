/**
 * The activity feed (board-web: "Board views"; board-view-model: "Activity
 * feed entries"; add-board-web task 4.3): `feedEntries(model, filters)`,
 * newest first, with the filters of the route.
 *
 * DOM contract (relied on by the component tests):
 * - one `ol` with class `feed`, holding one `li` with class `entry`,
 *   `data-hash="<hash>"`, `data-kind="<kind>"` and `data-actor="<actor>"`
 *   per entry, in the order `feedEntries` gives; it also has class `late`
 *   when `entry.late`. It shows, as text, the actor, the summary,
 *   `relativeTime(now - ts.wall)`, and the ticket title (inside a link to
 *   `#/ticket/<id>`) when the entry has a ticket;
 * - a `select` labelled `Change` (option `all` with value `""`, then one
 *   option per distinct non-null `change` among the model's entries,
 *   sorted), a `select` labelled `Actor` (option `all` with value `""`,
 *   then one option per distinct actor among the entries, sorted), and a
 *   `fieldset` with the legend `Kinds` holding one checkbox per known kind
 *   (`KNOWN_KINDS`), each labelled with the kind. No checked kind means
 *   every kind (route `kinds` null); otherwise `kinds` lists the checked
 *   ones in `KNOWN_KINDS` order. Changing a filter calls `navigate` with
 *   the feed route carrying it.
 * Every text from the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import type { BoardModel } from '../../../view/types.js';
import type { FeedRoute, Route } from '../hash.js';

export interface FeedViewProps {
  model: BoardModel;
  now: number;
  route: FeedRoute;
  navigate: (route: Route) => void;
}

export function FeedView(props: FeedViewProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
