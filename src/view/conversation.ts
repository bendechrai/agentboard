/**
 * The conversation of a ticket (board-view-model: "Conversation view").
 * Pure and browser-safe; see `types.ts`.
 */

import { DECISION_PREFIX, RETRACTED_PREFIX, openDecisions } from '../events/decisions.js';
import type { Hlc } from '../events/hlc.js';
import { isKnownEvent, type Status } from '../events/schema.js';
import { describeEvent } from './describe.js';
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

const NO_FLAGS: DecisionFlags = { decision: false, retracted: false, retraction: false };

/**
 * Sets the decision flags of every comment and hand-off message, in place.
 *
 * The open decisions come from `openDecisions` over the chat messages in
 * order, so the close rule and this view share one definition. It returns
 * copies holding only actor and text, so they are matched back to the
 * messages walking both lists from the end: an actor's open decisions are
 * always the ones after that actor's last retraction, a suffix of the
 * actor's decisions, so the latest message equal to each open decision is
 * the one it came from, even when an actor repeats a decision text.
 */
function flagDecisions(messages: ConversationMessage[]): void {
  const chat = messages.filter((m): m is CommentMessage | HandoffMessage => m.type !== 'system');
  const open = openDecisions(chat.map((m) => ({ actor: m.actor, text: m.text })));
  let next = open.length - 1;
  for (const message of chat.reverse()) {
    message.decision = message.text.startsWith(DECISION_PREFIX);
    message.retraction = message.text.startsWith(RETRACTED_PREFIX);
    const candidate = open[next];
    const isOpen =
      message.decision &&
      candidate !== undefined &&
      candidate.actor === message.actor &&
      candidate.text === message.text;
    if (isOpen) {
      next -= 1;
    }
    message.retracted = message.decision && !isOpen;
  }
}

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
  const messages: ConversationMessage[] = [];
  for (const view of model.events) {
    if (view.ticket !== ticketId || view.outcome !== 'applied') {
      continue;
    }
    const base = { hash: view.hash, actor: view.actor, ts: view.ts };
    const event = view.event;
    if (isKnownEvent(event) && event.kind === 'ticket.comment') {
      messages.push({ type: 'comment', ...base, text: event.body.text, ...NO_FLAGS });
    } else if (isKnownEvent(event) && event.kind === 'ticket.handoff') {
      const { note, to, status } = event.body;
      messages.push({ type: 'handoff', ...base, text: note, to, status, ...NO_FLAGS });
    } else {
      messages.push({ type: 'system', ...base, kind: event.kind, text: describeEvent(event) });
    }
  }
  flagDecisions(messages);
  return messages;
}
