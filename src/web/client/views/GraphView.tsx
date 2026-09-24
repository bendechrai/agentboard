/**
 * The hand-off graph (board-insights: "Hand-off graph"; design.md:
 * "Hand-off graph"; add-board-insights task 3.3): `handoffGraph` of the
 * client's model drawn as inline SVG made by Preact, with no graph
 * library and no external resource.
 *
 * Behavior:
 * - The graph is `handoffGraph(model.events, filter)` where
 *   `filter.change` is `route.change` (when not null) and `filter.since`
 *   is `now - parseDuration(route.since)` (when `route.since` is not
 *   null).
 * - Layout: the nodes, in the order `handoffGraph` gives (actor name
 *   order), on the circle of centre (`GRAPH_CENTER`, `GRAPH_CENTER`) and
 *   radius `GRAPH_RADIUS` in a `GRAPH_SIZE` square: node `i` of `n` at the
 *   angle `-PI / 2 + 2 * PI * i / n` (the first at the top, then
 *   clockwise in screen coordinates), that is `cx = GRAPH_CENTER +
 *   GRAPH_RADIUS * cos(angle)` and `cy = GRAPH_CENTER + GRAPH_RADIUS *
 *   sin(angle)`.
 * - Animation: the view remembers the hashes of the events of the model
 *   it was mounted with. Whenever the model changes, every applied
 *   `ticket.handoff` event whose hash it has not seen before marks the
 *   edge from its actor to its `body.to` as animated for
 *   `GRAPH_ANIMATION_MS` (3 seconds), timed with `conn.deps.setTimeout`
 *   (cleared with `conn.deps.clearTimeout`); a later new hand-off on the
 *   same edge restarts the 3 seconds. Hand-offs present at mount are
 *   never animated. Unmounting cancels every timer.
 *
 * DOM contract (relied on by the component tests):
 * - a form labelled `Graph filters` with a `select` `#graph-change`
 *   labelled `Change` (option `all` with value `""`, then one option per
 *   distinct `<source>:<ref>` among the tickets' tasks, sorted) and a
 *   `select` `#graph-since` labelled `Since` (option `all` with value
 *   `""`, then `1h`, `1d`, `7d` and `30d`, plus `route.since` when it is
 *   another value). Changing one calls `navigate` with the graph route
 *   carrying the new filter (`""` is null);
 * - with no edge: a `p` with class `empty` with the text `No hand-offs
 *   match.` and no `svg`;
 * - otherwise one `svg` with class `handoff-graph`, `role="img"`,
 *   `aria-label="Hand-off graph"` and `viewBox="0 0 600 600"`, holding:
 *   - a `defs` with an arrowhead `marker` whose id is `graph-arrow`;
 *   - one `g` with class `edge` per edge, in `handoffGraph` order, with
 *     `data-from`, `data-to` and `data-count`, holding a `path` whose
 *     `stroke-width` attribute is a number, 1 for a count of 1 and
 *     strictly increasing with the count (growing with its logarithm),
 *     and whose `marker-end` is `url(#graph-arrow)` (a self-loop is drawn
 *     as a loop beside its node), and a `text` with class `edge-count`
 *     whose text is the count. While animated, the `g` also has class
 *     `animated`;
 *   - one `g` with class `node` per node, with `data-actor`, `data-sent`
 *     and `data-received`, holding a `circle` whose `cx` and `cy`
 *     attributes are the layout position (as numbers), a `text` whose
 *     text is exactly the actor name, and a `title` whose text is
 *     `<actor>: sent <sent>, received <received>`;
 * - a `table` with class `edge-table` with one body row (`tr` with
 *   `data-from` and `data-to`) per edge, in the same order, whose cells
 *   are the from actor, the to actor and the count.
 * Colours and animation live in `app.css`; no element has a `style`
 * attribute (the Content-Security-Policy's `style-src 'self'` forbids
 * inline styles). Actor names are rendered as text (SVG `text` and
 * `title` content included), never as markup.
 */

import type { JSX } from 'preact';

import type { BoardModel } from '../../../view/types.js';
import type { Connection } from '../api.js';
import type { GraphRoute, Route } from '../hash.js';

/** The side of the square drawing area, in SVG user units. */
export const GRAPH_SIZE = 600;

/** The centre of the node circle, on both axes. */
export const GRAPH_CENTER = 300;

/** The radius of the node circle. */
export const GRAPH_RADIUS = 220;

/** How long an edge is animated after a new hand-off on it arrives: 3 seconds. */
export const GRAPH_ANIMATION_MS = 3000;

export interface GraphViewProps {
  model: BoardModel;
  /** The time the `since` filter is measured back from (`ClientState.now`). */
  now: number;
  route: GraphRoute;
  /** Shows another route (writes the URL hash). */
  navigate: (route: Route) => void;
  /** Its `deps` provide the animation timers. */
  conn: Connection;
}

export function GraphView(props: GraphViewProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
