/**
 * The hand-off graph (board-insights: "Hand-off graph"; add-board-insights
 * task 1.2). Pure and browser-safe; see `types.ts`.
 */

import type { Hlc } from '../events/hlc.js';
import { isKnownEvent, type Status, type TaskRef } from '../events/schema.js';
import { compareStrings } from './order.js';
import type { EventView } from './types.js';

/** Filters for `handoffGraph`; every filter given must match (AND). */
export interface GraphFilter {
  /**
   * A change as `<source>:<ref>` (no item): counts only hand-offs on
   * tickets whose task reference has exactly that source and ref, whatever
   * its item. A ticket's task reference is its current one, derived from
   * the applied events of the list: the task of its `ticket.create`,
   * replaced by each later applied `ticket.link` with a task. A ticket with
   * no task never matches.
   */
  change?: string;
  /** A minimum wall (inclusive): counts only hand-offs with `ts.wall >= since`. */
  since?: number;
}

/** One counted hand-off. */
export interface HandoffRef {
  hash: string;
  ticket: string;
  ts: Hlc;
  /** `body.status` of the hand-off. */
  status: Status;
  /** `body.note` of the hand-off. */
  note: string;
}

/** One directed edge: every counted hand-off from `from` to `to`. */
export interface GraphEdge {
  /** The hand-off event's actor. */
  from: string;
  /** The hand-off's `body.to`; equal to `from` for a self-loop. */
  to: string;
  /** The number of counted hand-offs from `from` to `to` (at least 1). */
  count: number;
  /** The last of those hand-offs in fold order. */
  latest: HandoffRef;
}

/** One actor on at least one edge. */
export interface GraphNode {
  actor: string;
  /** The sum of the counts of the edges from this actor (a self-loop included). */
  sent: number;
  /** The sum of the counts of the edges to this actor (a self-loop included). */
  received: number;
}

/** Result of `handoffGraph`. */
export interface HandoffGraph {
  /** One node per actor on any edge, ascending by actor name (string order). */
  nodes: GraphNode[];
  /** One edge per (from, to) pair, ascending by `from`, then by `to` (string order). */
  edges: GraphEdge[];
}

/**
 * The hand-off graph of `events` (in fold order, as `BoardModel.events`):
 * every event with outcome `applied` and kind `ticket.handoff` that passes
 * `filter` counts once on the edge from its actor to its `body.to`. No
 * other kind counts: claims, releases and `ticket.assign` are not
 * hand-offs, and rejected hand-offs do not count. A hand-off to oneself is
 * a self-loop edge. With no counted hand-off the graph is empty. Pure:
 * `events` is not modified.
 */
export function handoffGraph(events: readonly EventView[], filter: GraphFilter = {}): HandoffGraph {
  const matchesChange = changeMatcher(events, filter.change);
  const edges = new Map<string, GraphEdge>();
  for (const view of events) {
    const { event } = view;
    if (
      view.outcome !== 'applied' ||
      !isKnownEvent(event) ||
      event.kind !== 'ticket.handoff' ||
      (filter.since !== undefined && event.ts.wall < filter.since) ||
      !matchesChange(event.ticket)
    ) {
      continue;
    }
    const from = event.actor;
    const to = event.body.to;
    const latest: HandoffRef = {
      hash: view.hash,
      ticket: event.ticket,
      ts: { ...event.ts },
      status: event.body.status,
      note: event.body.note,
    };
    // JSON of the pair: unambiguous whatever characters the actors contain.
    const key = JSON.stringify([from, to]);
    const edge = edges.get(key);
    if (edge === undefined) {
      edges.set(key, { from, to, count: 1, latest });
    } else {
      edge.count += 1;
      edge.latest = latest;
    }
  }

  const nodes = new Map<string, GraphNode>();
  const node = (actor: string): GraphNode => {
    let found = nodes.get(actor);
    if (found === undefined) {
      found = { actor, sent: 0, received: 0 };
      nodes.set(actor, found);
    }
    return found;
  };
  for (const edge of edges.values()) {
    node(edge.from).sent += edge.count;
    node(edge.to).received += edge.count;
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.actor, b.actor)),
    edges: [...edges.values()].sort(
      (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to),
    ),
  };
}

/**
 * The predicate on ticket ids for `GraphFilter.change` (every ticket passes
 * when it is absent): the text is split at its first `:` into source and
 * ref, and a ticket matches when its current task, derived from the applied
 * events of `events`, has that source and ref. Text with no `:` matches no
 * ticket.
 */
function changeMatcher(
  events: readonly EventView[],
  change: string | undefined,
): (ticket: string) => boolean {
  if (change === undefined) {
    return () => true;
  }
  const colon = change.indexOf(':');
  if (colon < 0) {
    return () => false;
  }
  const source = change.slice(0, colon);
  const ref = change.slice(colon + 1);
  const tasks = new Map<string, TaskRef | null>();
  for (const view of events) {
    const { event } = view;
    if (view.outcome !== 'applied' || !isKnownEvent(event)) {
      continue;
    }
    if (event.kind === 'ticket.create') {
      tasks.set(event.ticket, event.body.task ?? null);
    } else if (event.kind === 'ticket.link' && 'task' in event.body) {
      tasks.set(event.ticket, event.body.task);
    }
  }
  return (ticket) => {
    const task = tasks.get(ticket) ?? null;
    return task !== null && task.source === source && task.ref === ref;
  };
}
