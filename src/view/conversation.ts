/**
 * The conversation of a ticket (board-view-model: "Conversation view").
 * Pure and browser-safe; see `types.ts`.
 */

import type { Hlc } from '../events/hlc.js';
import type { Status } from '../events/schema.js';
import type { BoardModel } from './types.js';

/** Fields every conversation message carries, from its event. */
interface MessageBase {
  /** Hash of the event the message comes from. */
  hash: string;
  /** The event's actor (the author of a comment or hand-off). */
  actor: string;
  ts: Hlc;
}

/**
 * Decision flags of a comment or hand-off message, from its text.
 * - `decision`: the text starts with `DECISION_PREFIX` (`DECISION:`,
 *   case-sensitive, at the very start).
 * - `retracted`: `decision` is true and the message is not among the
 *   ticket's open decisions as `openDecisions` defines them over the
 *   ticket's comment and hand-off texts in fold order; that is, a later
 *   comment or hand-off note by the same actor starts with `RETRACTED:`.
 *   Always false when `decision` is false.
 * - `retraction`: the text starts with `RETRACTED_PREFIX` (`RETRACTED:`).
 */
export interface DecisionFlags {
  decision: boolean;
  retracted: boolean;
  retraction: boolean;
}

/** A `ticket.comment` as a chat message by its actor. */
export interface CommentMessage extends MessageBase, DecisionFlags {
  type: 'comment';
  /** The comment text. */
  text: string;
}

/** A `ticket.handoff` as a chat message by its actor. */
export interface HandoffMessage extends MessageBase, DecisionFlags {
  type: 'handoff';
  /** The hand-off note. */
  text: string;
  /** The recipient (`body.to`). */
  to: string;
  /** The status given with the hand-off (`body.status`). */
  status: Status;
}

/** Any other applied event of the ticket, as a system line. */
export interface SystemMessage extends MessageBase {
  type: 'system';
  kind: string;
  /** `describeEvent(event)`. */
  text: string;
}

export type ConversationMessage = CommentMessage | HandoffMessage | SystemMessage;

/**
 * The conversation of ticket `ticketId` (a full id): one message per event
 * of `model.events` whose `ticket` is `ticketId` and whose outcome is
 * `applied`, in the model's fold order. `ticket.comment` gives a
 * `CommentMessage`, `ticket.handoff` a `HandoffMessage`, every other kind
 * (create included) a `SystemMessage`. Rejected and unknown-kind events
 * give no message. A ticket with no such event (including an id not in
 * the model) gives an empty list. The ticket state in `model.tickets` is
 * not needed; decision flags are computed from the messages themselves.
 */
export function conversation(
  model: Pick<BoardModel, 'events'>,
  ticketId: string,
): ConversationMessage[] {
  throw new Error(`not implemented: conversation(${String(model.events.length)}, ${ticketId})`);
}
