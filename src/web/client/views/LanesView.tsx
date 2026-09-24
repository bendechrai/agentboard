/**
 * The agent lanes (board-web: "Board views"; board-view-model: "Agent
 * lanes"; add-board-web task 4.4): `agentLanes(model, now)`, with "last
 * seen" as `relativeTime(lastSeenMs)`, re-rendered whenever `now` changes
 * (every `REFRESH_MS`).
 *
 * DOM contract (relied on by the component tests):
 * - one `section` with class `lane` and `data-actor="<actor>"` per lane,
 *   in the order `agentLanes` gives, with a heading naming the actor;
 * - in it, when the lane has a last event, an element with class
 *   `last-seen` holding exactly `last seen <relativeTime(lastSeenMs)>`
 *   and the last event's kind; when it has none, no `last-seen` element
 *   and the text `no events`;
 * - the lane's cards as `article` elements with class `card` and
 *   `data-ticket="<full id>"`, as on the board.
 * Every text from the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import type { BoardModel } from '../../../view/types.js';

export interface LanesViewProps {
  model: BoardModel;
  now: number;
}

export function LanesView(props: LanesViewProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
