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
import { useEffect, useRef, useState } from 'preact/hooks';

import { handoffGraph, type GraphEdge, type GraphFilter } from '../../../view/graph.js';
import { parseDuration } from '../../../view/health.js';
import type { BoardModel } from '../../../view/types.js';
import type { Connection } from '../api.js';
import type { GraphRoute, Route } from '../hash.js';
import { Select, sortedUnique } from './controls.js';

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

/** The time windows always offered by the `Since` filter. */
const SINCE_OPTIONS: readonly string[] = ['1h', '1d', '7d', '30d'];

/** The radius of a node's circle. */
const NODE_RADIUS = 18;

/** The key of the edge from `from` to `to`. */
function edgeKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

/** The width of an edge: 1 for one hand-off, growing with the logarithm of the count. */
function strokeWidth(count: number): number {
  return Math.round((1 + 1.5 * Math.log2(count)) * 100) / 100;
}

/** A coordinate rounded for an SVG attribute. */
function fixed(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

interface Point {
  x: number;
  y: number;
}

export function GraphView(props: GraphViewProps): JSX.Element {
  const { model, now, route, navigate, conn } = props;

  // Animation: the hashes seen so far and the timer of each animated edge.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(model.events.map((e) => e.hash));
  const timers = useRef(new Map<string, unknown>());
  const [animated, setAnimated] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const known = seen.current ?? new Set<string>();
    seen.current = known;
    const fresh: string[] = [];
    for (const event of model.events) {
      if (known.has(event.hash)) {
        continue;
      }
      known.add(event.hash);
      if (
        event.outcome === 'applied' &&
        event.event.kind === 'ticket.handoff' &&
        'body' in event.event
      ) {
        const body = event.event.body as { to?: unknown };
        if (typeof body.to === 'string') {
          fresh.push(edgeKey(event.actor, body.to));
        }
      }
    }
    if (fresh.length === 0) {
      return;
    }
    for (const key of fresh) {
      const running = timers.current.get(key);
      if (running !== undefined) {
        conn.deps.clearTimeout(running);
      }
      const handle = conn.deps.setTimeout(() => {
        timers.current.delete(key);
        setAnimated((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, GRAPH_ANIMATION_MS);
      timers.current.set(key, handle);
    }
    setAnimated((prev) => new Set([...prev, ...fresh]));
  }, [model.events, conn]);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const handle of running.values()) {
        conn.deps.clearTimeout(handle);
      }
      running.clear();
    };
  }, [conn]);

  const filter: GraphFilter = {};
  if (route.change !== null) {
    filter.change = route.change;
  }
  const span = route.since === null ? null : parseDuration(route.since);
  if (span !== null) {
    filter.since = now - span;
  }
  const graph = handoffGraph(model.events, filter);

  const changes = sortedUnique(
    Object.values(model.tickets).map((t) =>
      t.task === null ? null : `${t.task.source}:${t.task.ref}`,
    ),
    route.change,
  );
  const sinceOptions =
    route.since !== null && !SINCE_OPTIONS.includes(route.since)
      ? [...SINCE_OPTIONS, route.since]
      : SINCE_OPTIONS;

  const filters = (
    <form class="filters" aria-label="Graph filters" onSubmit={(e) => e.preventDefault()}>
      <Select
        id="graph-change"
        label="Change"
        value={route.change}
        options={changes}
        onChange={(change) => {
          navigate({ ...route, change });
        }}
      />
      <Select
        id="graph-since"
        label="Since"
        value={route.since}
        options={sinceOptions}
        onChange={(since) => {
          navigate({ ...route, since });
        }}
      />
    </form>
  );

  if (graph.edges.length === 0) {
    return (
      <div class="graph-view">
        {filters}
        <p class="empty">No hand-offs match.</p>
      </div>
    );
  }

  const count = graph.nodes.length;
  const positions = new Map<string, Point>();
  graph.nodes.forEach((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    positions.set(node.actor, {
      x: GRAPH_CENTER + GRAPH_RADIUS * Math.cos(angle),
      y: GRAPH_CENTER + GRAPH_RADIUS * Math.sin(angle),
    });
  });
  const centre: Point = { x: GRAPH_CENTER, y: GRAPH_CENTER };

  return (
    <div class="graph-view">
      {filters}
      <svg
        class="handoff-graph"
        role="img"
        aria-label="Hand-off graph"
        viewBox={`0 0 ${String(GRAPH_SIZE)} ${String(GRAPH_SIZE)}`}
      >
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path class="arrowhead" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {graph.edges.map((edge) => (
          <EdgeView
            key={edgeKey(edge.from, edge.to)}
            edge={edge}
            from={positions.get(edge.from) ?? centre}
            to={positions.get(edge.to) ?? centre}
            animated={animated.has(edgeKey(edge.from, edge.to))}
          />
        ))}
        {graph.nodes.map((node) => {
          const at = positions.get(node.actor) ?? centre;
          return (
            <g
              key={node.actor}
              class="node"
              data-actor={node.actor}
              data-sent={String(node.sent)}
              data-received={String(node.received)}
            >
              <title>{`${node.actor}: sent ${String(node.sent)}, received ${String(node.received)}`}</title>
              <circle cx={fixed(at.x)} cy={fixed(at.y)} r={String(NODE_RADIUS)} />
              <text
                class="node-label"
                x={fixed(at.x)}
                y={fixed(at.y + (at.y >= GRAPH_CENTER ? NODE_RADIUS + 16 : -NODE_RADIUS - 8))}
                text-anchor="middle"
              >
                {node.actor}
              </text>
            </g>
          );
        })}
      </svg>
      <table class="edge-table">
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Hand-offs</th>
          </tr>
        </thead>
        <tbody>
          {graph.edges.map((edge) => (
            <tr key={edgeKey(edge.from, edge.to)} data-from={edge.from} data-to={edge.to}>
              <td>{edge.from}</td>
              <td>{edge.to}</td>
              <td>{String(edge.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface EdgeViewProps {
  edge: GraphEdge;
  from: Point;
  to: Point;
  animated: boolean;
}

/** One directed edge: an arrow from node to node (a loop for a self hand-off) and its count. */
function EdgeView(props: EdgeViewProps): JSX.Element {
  const { edge, from, to } = props;
  let d: string;
  let label: Point;
  if (edge.from === edge.to) {
    // A loop on the outer side of the node, away from the centre.
    const dx = from.x - GRAPH_CENTER;
    const dy = from.y - GRAPH_CENTER;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy;
    const py = ux;
    const start = {
      x: from.x + NODE_RADIUS * (ux + px) * 0.7,
      y: from.y + NODE_RADIUS * (uy + py) * 0.7,
    };
    const end = {
      x: from.x + NODE_RADIUS * (ux - px) * 0.7,
      y: from.y + NODE_RADIUS * (uy - py) * 0.7,
    };
    const reach = NODE_RADIUS * 3;
    const c1 = { x: from.x + reach * (ux + px), y: from.y + reach * (uy + py) };
    const c2 = { x: from.x + reach * (ux - px), y: from.y + reach * (uy - py) };
    d = `M ${fixed(start.x)} ${fixed(start.y)} C ${fixed(c1.x)} ${fixed(c1.y)} ${fixed(c2.x)} ${fixed(c2.y)} ${fixed(end.x)} ${fixed(end.y)}`;
    label = { x: from.x + ux * reach * 1.05, y: from.y + uy * reach * 1.05 };
  } else {
    // A slight curve, so the edges of a pair in both directions do not overlap.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const start = { x: from.x + ux * NODE_RADIUS, y: from.y + uy * NODE_RADIUS };
    const end = { x: to.x - ux * NODE_RADIUS, y: to.y - uy * NODE_RADIUS };
    const bend = Math.min(40, length / 6);
    const control = {
      x: (start.x + end.x) / 2 - uy * bend,
      y: (start.y + end.y) / 2 + ux * bend,
    };
    d = `M ${fixed(start.x)} ${fixed(start.y)} Q ${fixed(control.x)} ${fixed(control.y)} ${fixed(end.x)} ${fixed(end.y)}`;
    label = {
      x: (start.x + 2 * control.x + end.x) / 4,
      y: (start.y + 2 * control.y + end.y) / 4,
    };
  }
  return (
    <g
      class={props.animated ? 'edge animated' : 'edge'}
      data-from={edge.from}
      data-to={edge.to}
      data-count={String(edge.count)}
    >
      <path d={d} stroke-width={String(strokeWidth(edge.count))} marker-end="url(#graph-arrow)" />
      <text class="edge-count" x={fixed(label.x)} y={fixed(label.y)} text-anchor="middle">
        {String(edge.count)}
      </text>
    </g>
  );
}
