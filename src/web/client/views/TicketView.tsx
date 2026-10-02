/**
 * The ticket detail (board-web: "Board views"; board-view-model: "Conversation
 * view"). The ticket and its events come from `loadTicketDetail(conn, id)` (the
 * feed carries only effective events, so rejected ones are read from the API),
 * requested when the view opens and again whenever `model.id` changes. The
 * conversation is `conversation({ events: detail.events }, detail.ticket.id)`.
 *
 * DOM contract (relied on by the component tests):
 * - while the first detail is loading, the text `Loading ticket...`; when
 *   the request fails, an element with `role="alert"` holding the
 *   `ApiError` message (for example the `unknown-ticket` message);
 * - an `article` with class `ticket` and `data-ticket="<full id>"`, with a
 *   heading holding the title, and a `dl` with class `fields` of `dt` and
 *   `dd` pairs, as text: `Id`, `Status`, `Assignee` (`none` when null),
 *   `Blocked from` (only while blocked), `Task` (`<source>:<ref>#<item>`,
 *   or `ad hoc: <reason>`), `Labels` (comma separated), `Created by`,
 *   `Description` (only when not null);
 * - a `ul` with class `checklist`: one `li` per line, in order, holding
 *   its text, with class `done` when done;
 * - a `ul` with class `links`: one `li` per link, in order, with the text
 *   `pr <pr>` or `decision <path>`;
 * - when closed, an element with class `disposition` holding
 *   `closed (decision <path>)` or `closed (no decision)`;
 * - an `ol` with class `conversation`: one `li` per message, in order,
 *   with class `message`, the message type (`comment`, `handoff` or
 *   `system`) as a class, and the classes `decision`, `retracted` and
 *   `retraction` for the flags that are set, and `data-hash`. A comment
 *   shows its actor and text; a hand-off its actor, `to <recipient>`, the
 *   status and the note; a system line its text;
 * - an `ol` with class `events`: one `li` per event of the detail, in
 *   order, with class `event`, `data-hash` and `data-outcome` (`applied`,
 *   `rejected` or `unknown`); it shows the kind, the actor, the outcome
 *   and, for a rejected event, its reason, as text.
 * Every text from the board is rendered as text, never as markup.
 *
 * Write mode (board-web-actions: "Action controls in the web app"):
 * - when `session.writable` is false, the view is exactly as above: no
 *   `form`, `input`, `textarea`, `select` or `button` anywhere in it, and
 *   no request other than `GET`s is ever made;
 * - when `session.writable` is true, the `ActionControls` of the shown
 *   ticket are rendered inside the `article`, after the fields (and the
 *   disposition), and the checklist is the `ChecklistControl` (the same
 *   `ul.checklist` of one `li` per line, each with its checkbox) in place
 *   of the plain list. Both get the shown ticket, `conn`,
 *   `props.onUnauthorized`, and an `onApplied` that replaces the shown
 *   ticket with the document's `ticket` at once (fields, checklist, links
 *   and disposition), without requesting the detail again; the
 *   conversation and the events keep those of the last loaded detail
 *   until the next reload (on the next `model.id`, when the stream
 *   confirms the write);
 * - a reload of the detail (a new `model.id`) replaces the shown ticket
 *   with the loaded one and keeps what the user entered in the controls.
 */

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Ticket } from '../../../events/fold.js';
import { formatTaskRef } from '../../../events/schema.js';
import { conversation, type ConversationMessage } from '../../../view/conversation.js';
import { relativeTime } from '../../../view/time.js';
import type { BoardModel, EventView } from '../../../view/types.js';
import {
  ApiError,
  loadTicketDetail,
  type Connection,
  type Session,
  type TicketDetail,
} from '../api.js';
import type { ActionSuccess } from '../actions.js';
import { ActionControls, ChecklistControl } from './ActionControls.js';
import { isoTime } from './controls.js';

export interface TicketViewProps {
  /** The id or prefix from the route. */
  id: string;
  /** The current model; a change of `model.id` reloads the detail. */
  model: BoardModel;
  /** The connection the app's client uses. */
  conn: Connection;
  now: number;
  /** The session of the app's client: the controls are shown only when `writable`. */
  session: Session;
  /** Called when an action is answered 401 (the app discards the token). */
  onUnauthorized: () => void;
}

/** The latest answer for one id: the detail, or why it failed. */
type Loaded = { id: string; detail: TicketDetail } | { id: string; error: string };

export function TicketView(props: TicketViewProps): JSX.Element {
  const { id, conn, now } = props;
  const modelId = props.model.id;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** The ticket of the last applied success, until the next load of the detail. */
  const [applied, setApplied] = useState<Ticket | null>(null);

  useEffect(() => {
    let live = true;
    loadTicketDetail(conn, id).then(
      (detail) => {
        if (live) {
          setLoaded({ id, detail });
          setApplied(null);
        }
      },
      (error: unknown) => {
        if (live) {
          const message =
            error instanceof ApiError || error instanceof Error ? error.message : String(error);
          setLoaded({ id, error: message });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [conn, id, modelId]);

  if (loaded === null || loaded.id !== id) {
    return <p class="loading">Loading ticket...</p>;
  }
  if ('error' in loaded) {
    return (
      <div role="alert" class="error">
        {loaded.error}
      </div>
    );
  }
  const { events } = loaded.detail;
  const ticket =
    applied !== null && applied.id === loaded.detail.ticket.id ? applied : loaded.detail.ticket;
  const writable = props.session.writable;
  const controlProps = {
    ticket,
    conn,
    onApplied: (document: ActionSuccess): void => {
      setApplied(document.ticket);
    },
    onUnauthorized: props.onUnauthorized,
  };
  return (
    <article class="ticket" data-ticket={ticket.id}>
      <h2 class="ticket-title">{ticket.title}</h2>
      <Fields ticket={ticket} />
      {ticket.closed ? <Disposition ticket={ticket} /> : null}
      {writable ? <ActionControls key={ticket.id} {...controlProps} /> : null}
      <h3>Checklist</h3>
      {writable ? (
        <ChecklistControl key={ticket.id} {...controlProps} />
      ) : (
        <ul class="checklist">
          {ticket.checklist.map((line, index) => (
            <li key={String(index)} class={line.done ? 'done' : undefined}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
      <h3>Links</h3>
      <ul class="links">
        {ticket.links.map((link) => (
          <li key={link.hash}>
            {link.type === 'pr' ? `pr ${String(link.pr)}` : `decision ${link.path}`}
          </li>
        ))}
      </ul>
      <h3>Conversation</h3>
      <ol class="conversation">
        {conversation({ events }, ticket.id).map((message) => (
          <Message key={message.hash} message={message} now={now} />
        ))}
      </ol>
      <h3>Events</h3>
      <ol class="events">
        {events.map((event) => (
          <EventRow key={event.hash} event={event} now={now} />
        ))}
      </ol>
    </article>
  );
}

function taskText(ticket: Ticket): string {
  if (ticket.task !== null) {
    return formatTaskRef(ticket.task);
  }
  return ticket.adhoc !== null ? `ad hoc: ${ticket.adhoc}` : 'none';
}

function Fields({ ticket }: { ticket: Ticket }): JSX.Element {
  const rows: [string, string][] = [
    ['Id', ticket.id],
    ['Status', ticket.status],
    ['Assignee', ticket.assignee ?? 'none'],
  ];
  if (ticket.blockedFrom !== null) {
    rows.push(['Blocked from', ticket.blockedFrom]);
  }
  rows.push(
    ['Task', taskText(ticket)],
    ['Labels', ticket.labels.join(', ')],
    ['Created by', ticket.createdBy],
  );
  if (ticket.description !== null) {
    rows.push(['Description', ticket.description]);
  }
  return (
    <dl class="fields">
      {rows.map(([name, value]) => [
        <dt key={`dt-${name}`}>{name}</dt>,
        <dd key={`dd-${name}`}>{value}</dd>,
      ])}
    </dl>
  );
}

function Disposition({ ticket }: { ticket: Ticket }): JSX.Element {
  const disposition = ticket.disposition;
  const text =
    disposition !== null && 'decision' in disposition
      ? `closed (decision ${disposition.decision})`
      : 'closed (no decision)';
  return <p class="disposition">{text}</p>;
}

function Age({ wall, now }: { wall: number; now: number }): JSX.Element {
  return (
    <time class="age" dateTime={isoTime(wall)}>
      {relativeTime(now - wall)}
    </time>
  );
}

function Message({ message, now }: { message: ConversationMessage; now: number }): JSX.Element {
  const classes = ['message', message.type];
  if (message.type !== 'system') {
    if (message.decision) {
      classes.push('decision');
    }
    if (message.retracted) {
      classes.push('retracted');
    }
    if (message.retraction) {
      classes.push('retraction');
    }
  }
  return (
    <li class={classes.join(' ')} data-hash={message.hash}>
      <p class="message-head">
        <span class="actor">{message.actor}</span>
        {message.type === 'handoff' ? (
          <span class="handoff-to">{` handed off to ${message.to} (${message.status})`}</span>
        ) : null}{' '}
        <Age wall={message.ts.wall} now={now} />
        {message.type !== 'system' && message.retracted ? (
          <span class="flag"> retracted</span>
        ) : null}
      </p>
      <p class="message-text">{message.text}</p>
    </li>
  );
}

function EventRow({ event, now }: { event: EventView; now: number }): JSX.Element {
  return (
    <li class={`event ${event.outcome}`} data-hash={event.hash} data-outcome={event.outcome}>
      <code class="kind">{event.kind}</code> <span class="actor">{event.actor}</span>{' '}
      <span class="outcome">{event.outcome}</span>
      {event.reason !== null ? <span class="reason">{`: ${event.reason}`}</span> : null}{' '}
      <Age wall={event.ts.wall} now={now} />
    </li>
  );
}
