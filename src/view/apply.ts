/**
 * Applying board feed messages to a client model (board-view-model:
 * "Applying feed messages"; add-board-web task 2.3). Pure and
 * browser-safe; see `types.ts`.
 */

import type { BoardModel, FeedMessage } from './types.js';

/** Result of `applyFeedMessage`. */
export interface FeedApplyResult {
  /** The model after the message. */
  model: BoardModel;
  /**
   * True for a `resync`: the consumer must reload its snapshot (and mark
   * `late` in the reloaded model's `late` list). False for an `append`.
   */
  reload: boolean;
  /**
   * For a `resync`, the hashes of its `late` events in the order given;
   * for an `append`, empty.
   */
  late: string[];
}

/**
 * Applies one feed message to `model`, without modifying `model` or
 * `message`.
 *
 * For an `append`, returns `reload` false, `late` empty and a new model
 * that equals the model a snapshot taken right after the appended events
 * would give (scenario "Append equals reload"):
 * - `tickets`: the model's tickets with each ticket of `message.tickets`
 *   set (added or replaced) under its id;
 * - `meta`: `message.meta` when it is not null, otherwise the model's;
 * - `events`: the model's events followed by `message.events` in the order
 *   given (they all sort after the model's head, so fold order holds);
 * - `head`: the hash of the last of `message.events`, or the model's head
 *   when there is none;
 * - `id`: `message.id`;
 * - `late`: the model's `late`, unchanged.
 *
 * For a `resync`, returns the same `model` object unchanged, `reload`
 * true, and `late` the hashes of `message.late` in order.
 */
export function applyFeedMessage(model: BoardModel, message: FeedMessage): FeedApplyResult {
  if (message.type === 'resync') {
    return { model, reload: true, late: message.late.map((e) => e.hash) };
  }
  const tickets = { ...model.tickets };
  for (const ticket of message.tickets) {
    tickets[ticket.id] = ticket;
  }
  const next: BoardModel = {
    tickets,
    meta: message.meta ?? model.meta,
    events: [...model.events, ...message.events],
    head: message.events.at(-1)?.hash ?? model.head,
    id: message.id,
    late: model.late,
  };
  return { model: next, reload: false, late: [] };
}
