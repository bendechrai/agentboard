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

import { agentLanes } from '../../../view/lanes.js';
import { relativeTime } from '../../../view/time.js';
import type { BoardModel } from '../../../view/types.js';
import { CardView } from './CardView.js';

export interface LanesViewProps {
  model: BoardModel;
  now: number;
}

export function LanesView(props: LanesViewProps): JSX.Element {
  const lanes = agentLanes(props.model, props.now);
  if (lanes.length === 0) {
    return <p class="empty">No agent has written an event or holds a ticket yet.</p>;
  }
  return (
    <div class="lanes">
      {lanes.map((lane, index) => (
        <section
          key={lane.actor}
          class="lane"
          data-actor={lane.actor}
          aria-labelledby={`lane-${String(index)}`}
        >
          <h2 id={`lane-${String(index)}`} class="lane-title">
            {lane.actor}
          </h2>
          {lane.lastEvent !== null && lane.lastSeenMs !== null ? (
            <p class="last-seen">
              {`last seen ${relativeTime(lane.lastSeenMs)}`}
              <span class="last-kind">{` (${lane.lastEvent.kind})`}</span>
            </p>
          ) : (
            <p class="no-events">no events</p>
          )}
          {lane.tickets.length === 0 ? <p class="empty">No open tickets.</p> : null}
          {lane.tickets.map((card) => (
            <CardView key={card.id} card={card} />
          ))}
        </section>
      ))}
    </div>
  );
}
