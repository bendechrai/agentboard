/**
 * The hand-off graph (board-insights: "Hand-off graph"; add-board-insights
 * task 1.2). Pure and browser-safe; see `types.ts`.
 */

import type { Hlc } from '../events/hlc.js';
import type { Status } from '../events/schema.js';
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
  void events;
  void filter;
  throw new Error('not implemented');
}
