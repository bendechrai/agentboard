/**
 * The action controls of the ticket detail on a writable server
 * (board-web-actions: "Action controls in the web app"; design.md of
 * add-board-web-actions: "The page"; add-board-web-actions task 2.1).
 * `TicketView` renders them only when the session is `writable`; a
 * read-only server's page renders none of them.
 *
 * Every control posts with `postAction(conn, <action>, <body>)`
 * (`../actions.ts`), whose `id` is always the ticket's full id
 * (`ticket.id`, never the prefix of the route). The page never
 * pre-validates beyond choosing what to display: the server is the
 * authority, so whatever the user entered is posted as entered (an empty
 * comment or path included) and a refusal is shown.
 *
 * Outcomes, for every control:
 * - success (`ok`): `onApplied(result.document)` is called at once (the
 *   ticket view shows the returned ticket without waiting for the stream
 *   or requesting the detail again), any refusal shown by that control is
 *   removed, and the control is reset as its entry below says;
 * - status 401: `onUnauthorized()` is called and nothing else is shown
 *   (the app then shows how to open the board);
 * - any other refusal: the control shows, beside itself (inside the
 *   element carrying its `data-action`), one element with class `refusal`
 *   and `role="alert"`, holding a `p` with class `refusal-message` (the
 *   document's `error.message`) and, when the hint is not null, a `p` with
 *   class `refusal-hint` (`error.hint`), as text. Every input of the
 *   control keeps what the user entered. When the reason is `busy`, the
 *   refusal also holds a `button` (type `button`) with class `retry` and
 *   text `Retry`, which posts the same action with the same body again
 *   (the body as first submitted, whatever the inputs hold now). Only the
 *   control that posted shows the refusal; the next submission of that
 *   control removes it;
 * - while a request of a control is in flight, its submitting buttons are
 *   `disabled`.
 * The controls keep their inputs when the ticket they are given changes
 * (a stream append reloading the detail, or an applied success of another
 * control): their state belongs to the ticket id, not to the ticket
 * version.
 *
 * DOM contract of `ActionControls` (relied on by the component tests): one
 * `section` with class `actions` and `aria-label="Actions"`, holding, in
 * this order:
 * - comment: a `form` with `data-action="comment"`: a `textarea`
 *   `#action-comment-text` labelled `Comment`, and a submit `button` with
 *   text `Comment`. Posts `comment` with `{ id, text }` (the textarea's
 *   value). On success the textarea is emptied;
 * - move: a `form` with `data-action="move"`: a `select`
 *   `#action-move-status` labelled `Move to` whose options (value and text
 *   the status) are exactly `moveTargets(ticket)`, in that order, the
 *   first selected, and a submit `button` with text `Move`, `disabled`
 *   when there is no target. Posts `move` with `{ id, status }`;
 * - claim: a `div` with `data-action="claim"` holding a `button` (type
 *   `button`) with text `Claim`. Posts `claim` with `{ id }`;
 * - release: a `div` with `data-action="release"` holding a `button`
 *   (type `button`) with text `Release`. Posts `release` with `{ id }`;
 * - hand-off: a `form` with `data-action="handoff"`: an `input` (type
 *   `text`) `#action-handoff-to` labelled `To`, a `select`
 *   `#action-handoff-status` labelled `Status` whose options are exactly
 *   `handoffStatuses(ticket)`, the first (the current status) selected, a
 *   `textarea` `#action-handoff-note` labelled `Note`, and a submit
 *   `button` with text `Hand off`. Posts `handoff` with `{ id, to, status,
 *   note }`. On success the recipient and the note are emptied;
 * - link: a `form` with `data-action="link"`: a `select`
 *   `#action-link-kind` labelled `Link to` with the options, in order,
 *   `task` (text `task reference`), `pr` (text `pull request`) and
 *   `decision` (text `decision path`), `task` selected; an `input` (type
 *   `text`) `#action-link-value` labelled `Value`; and a submit `button`
 *   with text `Link`. Posts `link` with `{ id, <kind>: <value> }`, the
 *   one property the selected kind names. On success the value is emptied;
 * - close: a `form` with `data-action="close"`: two radio `input`s named
 *   `disposition`, `#action-close-decision` (value
 *   `decision-recorded-in`, labelled `Decision recorded in`, checked
 *   initially) and `#action-close-none` (value `no-decision`, labelled `No
 *   decision`); an `input` (type `text`) `#action-close-path` labelled
 *   `Decision path`; and a submit `button` with text `Close`. Posts
 *   `close` with exactly one disposition: `{ id, 'decision-recorded-in':
 *   <path> }` when the decision radio is checked, `{ id, 'no-decision':
 *   true }` when the other is (the path, even if typed, is not sent).
 * Every submit is the form's `submit` event (default prevented).
 *
 * DOM contract of `ChecklistControl`: a `div` with
 * `data-action="checklist"` holding a `ul` with class `checklist`: one
 * `li` per line, in order, with class `done` when done, holding a `label`
 * with an `input` (type `checkbox`, `data-index="<index>"`, checked
 * exactly when the line is done, as the ticket given says) and the line's
 * text. Checking a box posts `checklist-tick` with `{ id, index }`;
 * unchecking one posts `checklist-untick` with `{ id, index }`, `index`
 * counted from 0. A box always shows the given ticket's state (after a
 * refusal it shows the line as it was). On a successful tick whose
 * `reminder` is not null, the control shows a `p` with class
 * `action-note` holding `reminder.message` as text, until its next
 * request. Refusals are shown in the `div` as for every control.
 *
 * No element has a `style` attribute (the Content-Security-Policy's
 * `style-src 'self'` forbids inline styles); every text from the board or
 * the server is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import type { Ticket } from '../../../events/fold.js';
import type { Status } from '../../../events/schema.js';
import type { ActionSuccess } from '../actions.js';
import type { Connection } from '../api.js';

/**
 * The statuses a move of `ticket` may name: every status `s` of
 * `STATUSES`, in that order, for which `isTransitionAllowed(ticket.status,
 * s, ticket.blockedFrom)` (the fold's own function) holds. So a blocked
 * ticket offers only its remembered status, and a merged one nothing.
 * Pure.
 */
export function moveTargets(ticket: Ticket): Status[] {
  void ticket;
  throw new Error('not implemented');
}

/**
 * The statuses a hand-off of `ticket` may name: the current status first
 * (a hand-off to the current status is a reassignment, permitted in every
 * status), then `moveTargets(ticket)`. Pure.
 */
export function handoffStatuses(ticket: Ticket): Status[] {
  void ticket;
  throw new Error('not implemented');
}

/** What every control needs. */
export interface ActionControlProps {
  /** The ticket as currently shown (the last applied success or loaded detail). */
  ticket: Ticket;
  /** The connection of the app's client (its token is the bearer header). */
  conn: Connection;
  /** Called with the document of every successful action. */
  onApplied: (document: ActionSuccess) => void;
  /** Called when an action is answered 401. */
  onUnauthorized: () => void;
}

/** The comment, move, claim, release, hand-off, link and close controls (module comment). */
export function ActionControls(props: ActionControlProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}

/** The checklist with a checkbox per line (module comment). */
export function ChecklistControl(props: ActionControlProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
