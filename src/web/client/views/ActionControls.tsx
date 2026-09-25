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
import { useEffect, useRef, useState } from 'preact/hooks';

import { isTransitionAllowed, type Ticket } from '../../../events/fold.js';
import { STATUSES, type Status } from '../../../events/schema.js';
import {
  postAction,
  type ActionBodies,
  type ActionName,
  type ActionResult,
  type ActionSuccess,
} from '../actions.js';
import type { Connection, ErrorDocument } from '../api.js';

/**
 * The statuses a move of `ticket` may name: every status `s` of
 * `STATUSES`, in that order, for which `isTransitionAllowed(ticket.status,
 * s, ticket.blockedFrom)` (the fold's own function) holds. So a blocked
 * ticket offers only its remembered status, and a merged one nothing.
 * Pure.
 */
export function moveTargets(ticket: Ticket): Status[] {
  return STATUSES.filter((to) => isTransitionAllowed(ticket.status, to, ticket.blockedFrom));
}

/**
 * The statuses a hand-off of `ticket` may name: the current status first
 * (a hand-off to the current status is a reassignment, permitted in every
 * status), then `moveTargets(ticket)`. Pure.
 */
export function handoffStatuses(ticket: Ticket): Status[] {
  return [ticket.status, ...moveTargets(ticket).filter((s) => s !== ticket.status)];
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

/** A refusal shown beside a control, with the retry of a `busy` one. */
interface Shown {
  error: ErrorDocument;
  retry: (() => void) | null;
}

/** The request state of one control. */
interface ActionState {
  /** True while a request of the control is in flight. */
  inFlight: boolean;
  /** The refusal shown beside the control, or null. */
  refusal: Shown | null;
  /** The tasks-file reminder of the last successful tick, or null. */
  note: string | null;
  /**
   * Posts `action` with `body`; on success calls `onApplied` and then
   * `onSuccess` (the control's own reset).
   */
  send: <A extends ActionName>(
    action: A,
    body: ActionBodies[A],
    onSuccess?: (document: ActionSuccess) => void,
  ) => void;
}

/** The request state and the sender of one control (module comment, "Outcomes"). */
function useAction(props: ActionControlProps): ActionState {
  const [inFlight, setInFlight] = useState(false);
  const [refusal, setRefusal] = useState<Shown | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = <A extends ActionName>(
    action: A,
    body: ActionBodies[A],
    onSuccess?: (document: ActionSuccess) => void,
  ): void => {
    setInFlight(true);
    setRefusal(null);
    setNote(null);
    void postAction(latest.current.conn, action, body).then((result: ActionResult) => {
      if (!mounted.current) {
        return;
      }
      setInFlight(false);
      if (result.ok) {
        const reminder = result.document.reminder;
        if (reminder !== undefined && reminder !== null) {
          setNote(reminder.message);
        }
        latest.current.onApplied(result.document);
        onSuccess?.(result.document);
        return;
      }
      if (result.status === 401) {
        latest.current.onUnauthorized();
        return;
      }
      const retry =
        result.error.error.reason === 'busy'
          ? () => {
              send(action, body, onSuccess);
            }
          : null;
      setRefusal({ error: result.error, retry });
    });
  };

  return { inFlight, refusal, note, send };
}

/** The refusal beside a control: message, hint and, when busy, a retry. */
function Refusal({ shown }: { shown: Shown | null }): JSX.Element | null {
  if (shown === null) {
    return null;
  }
  const { message, hint } = shown.error.error;
  const retry = shown.retry;
  return (
    <div class="refusal" role="alert">
      <p class="refusal-message">{message}</p>
      {hint !== null ? <p class="refusal-hint">{hint}</p> : null}
      {retry !== null ? (
        <button type="button" class="retry" onClick={retry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** The value of `current` when it is among `options`, else the first option (or ''). */
function chosen(current: string, options: readonly string[]): string {
  return options.includes(current) ? current : (options[0] ?? '');
}

function CommentControl(props: ActionControlProps): JSX.Element {
  const state = useAction(props);
  const [text, setText] = useState('');
  return (
    <form
      class="action"
      data-action="comment"
      onSubmit={(e) => {
        e.preventDefault();
        state.send('comment', { id: props.ticket.id, text }, () => {
          setText('');
        });
      }}
    >
      <label for="action-comment-text">Comment</label>
      <textarea
        id="action-comment-text"
        rows={3}
        value={text}
        onInput={(e) => {
          setText(e.currentTarget.value);
        }}
      />
      <div class="action-row">
        <button type="submit" disabled={state.inFlight}>
          Comment
        </button>
      </div>
      <Refusal shown={state.refusal} />
    </form>
  );
}

function MoveControl(props: ActionControlProps): JSX.Element {
  const state = useAction(props);
  const targets = moveTargets(props.ticket);
  const [picked, setPicked] = useState('');
  const status = chosen(picked, targets);
  return (
    <form
      class="action action-inline"
      data-action="move"
      onSubmit={(e) => {
        e.preventDefault();
        const target = targets.find((t) => t === status);
        if (target !== undefined) {
          state.send('move', { id: props.ticket.id, status: target });
        }
      }}
    >
      <label for="action-move-status">Move to</label>
      <select
        id="action-move-status"
        value={status}
        onChange={(e) => {
          setPicked(e.currentTarget.value);
        }}
      >
        {targets.map((target) => (
          <option key={target} value={target}>
            {target}
          </option>
        ))}
      </select>
      <button type="submit" disabled={state.inFlight || targets.length === 0}>
        Move
      </button>
      <Refusal shown={state.refusal} />
    </form>
  );
}

function ButtonControl(
  props: ActionControlProps & { action: 'claim' | 'release'; text: string },
): JSX.Element {
  const state = useAction(props);
  return (
    <div class="action action-inline" data-action={props.action}>
      <button
        type="button"
        disabled={state.inFlight}
        onClick={() => {
          state.send(props.action, { id: props.ticket.id });
        }}
      >
        {props.text}
      </button>
      <Refusal shown={state.refusal} />
    </div>
  );
}

function HandoffControl(props: ActionControlProps): JSX.Element {
  const state = useAction(props);
  const statuses = handoffStatuses(props.ticket);
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState('');
  const [note, setNote] = useState('');
  const status = chosen(picked, statuses);
  return (
    <form
      class="action"
      data-action="handoff"
      onSubmit={(e) => {
        e.preventDefault();
        const target = statuses.find((s) => s === status) ?? props.ticket.status;
        state.send('handoff', { id: props.ticket.id, to, status: target, note }, () => {
          setTo('');
          setNote('');
        });
      }}
    >
      <div class="action-row">
        <label for="action-handoff-to">To</label>
        <input
          type="text"
          id="action-handoff-to"
          value={to}
          onInput={(e) => {
            setTo(e.currentTarget.value);
          }}
        />
        <label for="action-handoff-status">Status</label>
        <select
          id="action-handoff-status"
          value={status}
          onChange={(e) => {
            setPicked(e.currentTarget.value);
          }}
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <label for="action-handoff-note">Note</label>
      <textarea
        id="action-handoff-note"
        rows={2}
        value={note}
        onInput={(e) => {
          setNote(e.currentTarget.value);
        }}
      />
      <div class="action-row">
        <button type="submit" disabled={state.inFlight}>
          Hand off
        </button>
      </div>
      <Refusal shown={state.refusal} />
    </form>
  );
}

type LinkKind = 'task' | 'pr' | 'decision';

const LINK_KINDS: readonly { kind: LinkKind; text: string }[] = [
  { kind: 'task', text: 'task reference' },
  { kind: 'pr', text: 'pull request' },
  { kind: 'decision', text: 'decision path' },
];

function linkBody(id: string, kind: LinkKind, value: string): ActionBodies['link'] {
  switch (kind) {
    case 'task':
      return { id, task: value };
    case 'pr':
      return { id, pr: value };
    case 'decision':
      return { id, decision: value };
  }
}

function LinkControl(props: ActionControlProps): JSX.Element {
  const state = useAction(props);
  const [kind, setKind] = useState<LinkKind>('task');
  const [value, setValue] = useState('');
  return (
    <form
      class="action action-inline"
      data-action="link"
      onSubmit={(e) => {
        e.preventDefault();
        state.send('link', linkBody(props.ticket.id, kind, value), () => {
          setValue('');
        });
      }}
    >
      <label for="action-link-kind">Link to</label>
      <select
        id="action-link-kind"
        value={kind}
        onChange={(e) => {
          const next = LINK_KINDS.find((k) => k.kind === e.currentTarget.value);
          if (next !== undefined) {
            setKind(next.kind);
          }
        }}
      >
        {LINK_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.text}
          </option>
        ))}
      </select>
      <label for="action-link-value">Value</label>
      <input
        type="text"
        id="action-link-value"
        value={value}
        onInput={(e) => {
          setValue(e.currentTarget.value);
        }}
      />
      <button type="submit" disabled={state.inFlight}>
        Link
      </button>
      <Refusal shown={state.refusal} />
    </form>
  );
}

function CloseControl(props: ActionControlProps): JSX.Element {
  const state = useAction(props);
  const [decision, setDecision] = useState(true);
  const [path, setPath] = useState('');
  return (
    <form
      class="action"
      data-action="close"
      onSubmit={(e) => {
        e.preventDefault();
        const id = props.ticket.id;
        state.send(
          'close',
          decision ? { id, 'decision-recorded-in': path } : { id, 'no-decision': true },
        );
      }}
    >
      <div class="action-row">
        <span class="choice">
          <input
            type="radio"
            name="disposition"
            id="action-close-decision"
            value="decision-recorded-in"
            checked={decision}
            onChange={() => {
              setDecision(true);
            }}
          />
          <label for="action-close-decision">Decision recorded in</label>
        </span>
        <span class="choice">
          <input
            type="radio"
            name="disposition"
            id="action-close-none"
            value="no-decision"
            checked={!decision}
            onChange={() => {
              setDecision(false);
            }}
          />
          <label for="action-close-none">No decision</label>
        </span>
      </div>
      <div class="action-row">
        <label for="action-close-path">Decision path</label>
        <input
          type="text"
          id="action-close-path"
          value={path}
          onInput={(e) => {
            setPath(e.currentTarget.value);
          }}
        />
        <button type="submit" disabled={state.inFlight}>
          Close
        </button>
      </div>
      <Refusal shown={state.refusal} />
    </form>
  );
}

/** The comment, move, claim, release, hand-off, link and close controls (module comment). */
export function ActionControls(props: ActionControlProps): JSX.Element {
  return (
    <section class="actions" aria-label="Actions">
      <CommentControl {...props} />
      <MoveControl {...props} />
      <div class="action-buttons">
        <ButtonControl {...props} action="claim" text="Claim" />
        <ButtonControl {...props} action="release" text="Release" />
      </div>
      <HandoffControl {...props} />
      <LinkControl {...props} />
      <CloseControl {...props} />
    </section>
  );
}

/** The checklist with a checkbox per line (module comment). */
export function ChecklistControl(props: ActionControlProps): JSX.Element {
  const state = useAction(props);
  const id = props.ticket.id;
  return (
    <div class="action checklist-control" data-action="checklist">
      <ul class="checklist">
        {props.ticket.checklist.map((line, index) => (
          <li key={String(index)} class={line.done ? 'done' : undefined}>
            <label>
              <input
                type="checkbox"
                data-index={String(index)}
                checked={line.done}
                onChange={(e) => {
                  // Show the ticket's state until the server answers.
                  e.currentTarget.checked = line.done;
                  state.send(line.done ? 'checklist-untick' : 'checklist-tick', { id, index });
                }}
              />{' '}
              {line.text}
            </label>
          </li>
        ))}
      </ul>
      {state.note !== null ? <p class="action-note">{state.note}</p> : null}
      <Refusal shown={state.refusal} />
    </div>
  );
}
