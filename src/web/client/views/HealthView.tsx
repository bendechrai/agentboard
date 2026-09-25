/**
 * The health view (board-insights: "Health report", "Durations", "Health
 * in the web app"; design.md: "Health checks and their definitions",
 * "Server additions"; add-board-insights task 3.2): `healthReport`
 * computed in the browser from the client's model, re-evaluated on every
 * model change and whenever `now` changes (the client refreshes it every
 * `REFRESH_MS`, 10 seconds), with what only the server knows (the observed
 * late arrivals and the last cache check) from `GET /api/health`.
 *
 * Behavior:
 * - On mount, and again whenever `model.id` changes, it requests
 *   `loadHealth(conn)` (`GET /api/health`). It never requests
 *   `/api/health/check` on its own: only pressing the check button does
 *   (`runHealthCheck(conn)`).
 * - The report is `healthReport({ model, now, thresholds, late, check })`
 *   where `thresholds` are `parseDuration` of `route.stale` and
 *   `route.blocked` (`DEFAULT_THRESHOLDS` for null), `late` is the loaded
 *   list (null until loaded) and `check` the latest of the loaded check
 *   and the result of the button (null when neither).
 *
 * DOM contract (relied on by the component tests):
 * - a form labelled `Health thresholds` with a text input `#health-stale`
 *   labelled `Stale after` and a text input `#health-blocked` labelled
 *   `Blocked after`, whose initial values are `route.stale ?? '2h'` and
 *   `route.blocked ?? '24h'`, and an element with class `duration-help`
 *   naming the accepted forms `<n>m`, `<n>h` and `<n>d`. On every `input`
 *   event: when `parseDuration` accepts the input's text, the input has no
 *   `aria-invalid="true"` and `navigate` is called with the health route
 *   carrying that text (`stale` or `blocked`); otherwise the input gets
 *   `aria-invalid="true"` and class `invalid`, `navigate` is not called,
 *   and the report is unchanged (it keeps the route's thresholds);
 * - one `section` with class `health-section` per section, in this order,
 *   with `data-section` set to `stale-claims`, `stuck-blocked`,
 *   `unpromoted-decisions`, `close-merged-ready`, `close-merged-held`,
 *   `close-merged-missing-pr`, `late` and `check`. Every section but
 *   `check` has a heading holding a `span` with class `count` whose text
 *   is the number of its entries (`late`: 0 until loaded);
 * - in each ticket section, one `li` with class `finding` and
 *   `data-ticket="<full id>"` per finding in report order, holding the
 *   ticket's title (as text, inside a link to `#/ticket/<id>`) and short
 *   id, and:
 *   - `stale-claims`: the assignee and `last active <relativeTime(idleMs)>`;
 *   - `stuck-blocked`: `from <blockedFrom>` and, when there is one, the
 *     latest comment's actor and text;
 *   - `unpromoted-decisions` and `close-merged-held`: the text of every
 *     open decision;
 *   - `close-merged-ready` and `close-merged-held`: `PR <value>` for each
 *     `pr` link value;
 *   - `close-merged-missing-pr`: `no PR link`;
 *   a ticket section with no finding holds a `p` with class `empty`;
 * - before the three close-merged sections, a `p` with class
 *   `close-merged-note` whose text includes `Whether a pull request is
 *   merged is known only to close-merged`;
 * - in the `late` section, one `li` with class `late-item` (and also
 *   `removed` for a removed entry) and `data-hash="<hash>"` per loaded
 *   entry, in the order loaded (newest first), holding the kind, the word
 *   `late` or `removed`, the ticket id when not null, and a `time` element
 *   whose `datetime` is `isoTime(observedAt)`. When `loadHealth` fails,
 *   the section holds an element with `role="alert"` with the error's
 *   message (the rest of the report is still shown);
 * - in the `check` section, a `button` (type `button`) with text `Run
 *   cache check`, and an element with class `check-note` saying that the
 *   check briefly pauses writers (its text includes `pauses writers`).
 *   While a check request is in flight the button is disabled and its
 *   text is `Checking...`. The current check (see above), when not null,
 *   is shown as an element with class `check-result` and
 *   `data-matches="true"` or `"false"`, whose text is `The cache matches
 *   the event log` when it matches, else `<n> differing rows` (`1
 *   differing row` for one), and a `time` element whose `datetime` is
 *   `isoTime(ranAt)`; when it is null, the text `No cache check has run`.
 *   When the check request fails, the section holds an element with
 *   `role="alert"` with the error's message, and the previous result, if
 *   any, stays.
 * No element has a `style` attribute (the Content-Security-Policy's
 * `style-src 'self'` forbids inline styles); every text from the board or
 * the server is rendered as text, never as markup.
 */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import {
  DEFAULT_THRESHOLDS,
  healthReport,
  parseDuration,
  type CloseMergedCandidate,
  type HealthCheck,
  type LateArrival,
} from '../../../view/health.js';
import type { Card } from '../../../view/columns.js';
import { relativeTime } from '../../../view/time.js';
import type { BoardModel } from '../../../view/types.js';
import { loadHealth, runHealthCheck, type Connection } from '../api.js';
import { formatHash, type HealthRoute, type Route } from '../hash.js';
import { isoTime } from './controls.js';

export interface HealthViewProps {
  model: BoardModel;
  /** The time the report is computed at (`ClientState.now`). */
  now: number;
  route: HealthRoute;
  /** Shows another route (writes the URL hash). */
  navigate: (route: Route) => void;
  /** The API connection (`loadHealth`, `runHealthCheck`). */
  conn: Connection;
}

/** The default texts of the threshold inputs. */
const DEFAULT_STALE = '2h';
const DEFAULT_BLOCKED = '24h';

/** The message of a rejected request. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The later of two checks by `ranAt` (the second on a tie), or whichever is not null. */
function latestCheck(a: HealthCheck | null, b: HealthCheck | null): HealthCheck | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return b.ranAt >= a.ranAt ? b : a;
}

export function HealthView(props: HealthViewProps): JSX.Element {
  const { model, now, route, navigate, conn } = props;
  const [late, setLate] = useState<LateArrival[] | null>(null);
  const [lateError, setLateError] = useState<string | null>(null);
  const [loadedCheck, setLoadedCheck] = useState<HealthCheck | null>(null);
  const [pressedCheck, setPressedCheck] = useState<HealthCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadHealth(conn).then(
      (body) => {
        if (live) {
          setLate(body.late);
          setLoadedCheck(body.check);
          setLateError(null);
        }
      },
      (error: unknown) => {
        if (live) {
          setLateError(messageOf(error));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [conn, model.id]);

  // Whether the component is still mounted, for the check button's request.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runCheck = (): void => {
    setChecking(true);
    setCheckError(null);
    runHealthCheck(conn).then(
      (result) => {
        if (mounted.current) {
          setPressedCheck(result);
          setChecking(false);
        }
      },
      (error: unknown) => {
        if (mounted.current) {
          setCheckError(messageOf(error));
          setChecking(false);
        }
      },
    );
  };

  const check = latestCheck(loadedCheck, pressedCheck);
  const thresholds = {
    staleAfter:
      (route.stale === null ? null : parseDuration(route.stale)) ?? DEFAULT_THRESHOLDS.staleAfter,
    blockedAfter:
      (route.blocked === null ? null : parseDuration(route.blocked)) ??
      DEFAULT_THRESHOLDS.blockedAfter,
  };
  const report = healthReport({ model, now, thresholds, late, check });
  const { closeMerged } = report;

  return (
    <div class="health-view">
      <form class="filters" aria-label="Health thresholds" onSubmit={(e) => e.preventDefault()}>
        <DurationInput
          id="health-stale"
          label="Stale after"
          initial={route.stale ?? DEFAULT_STALE}
          onValid={(stale) => {
            navigate({ ...route, stale });
          }}
        />
        <DurationInput
          id="health-blocked"
          label="Blocked after"
          initial={route.blocked ?? DEFAULT_BLOCKED}
          onValid={(blocked) => {
            navigate({ ...route, blocked });
          }}
        />
        <p id="health-duration-help" class="duration-help">
          Durations are written as &lt;n&gt;m, &lt;n&gt;h or &lt;n&gt;d (minutes, hours or days),
          with n from 1 to 99999.
        </p>
      </form>

      <TicketSection
        name="stale-claims"
        title="Stale claims"
        items={report.staleClaims.map((s) => ({
          card: s.ticket,
          detail: (
            <p class="finding-detail">
              <span class="assignee">{s.assignee}</span>
              {` last active ${relativeTime(s.idleMs)}`}
            </p>
          ),
        }))}
      />
      <TicketSection
        name="stuck-blocked"
        title="Stuck in blocked"
        items={report.stuckBlocked.map((s) => ({
          card: s.ticket,
          detail: (
            <>
              <p class="finding-detail">{`from ${s.blockedFrom}, blocked ${relativeTime(s.blockedMs)}`}</p>
              {s.latestComment !== null ? (
                <p class="latest-comment">
                  <span class="actor">{s.latestComment.actor}</span>
                  {': '}
                  <span class="comment-text">{s.latestComment.text}</span>
                </p>
              ) : null}
            </>
          ),
        }))}
      />
      <TicketSection
        name="unpromoted-decisions"
        title="Unpromoted decisions"
        items={report.unpromotedDecisions.map((u) => ({
          card: u.ticket,
          detail: <Decisions decisions={u.decisions} />,
        }))}
      />
      <p class="close-merged-note">
        Tickets in merged, as close-merged would see them. Whether a pull request is merged is known
        only to close-merged, which asks gh; this page never claims it.
      </p>
      <TicketSection
        name="close-merged-ready"
        title="close-merged: ready"
        items={closeMerged.ready.map((c) => ({ card: c.ticket, detail: <Prs candidate={c} /> }))}
      />
      <TicketSection
        name="close-merged-held"
        title="close-merged: held by a decision"
        items={closeMerged.heldByDecision.map((c) => ({
          card: c.ticket,
          detail: (
            <>
              <Prs candidate={c} />
              <Decisions decisions={c.decisions} />
            </>
          ),
        }))}
      />
      <TicketSection
        name="close-merged-missing-pr"
        title="close-merged: missing a PR link"
        items={closeMerged.missingPr.map((c) => ({
          card: c.ticket,
          detail: <p class="finding-detail">no PR link</p>,
        }))}
      />

      <section class="health-section" data-section="late" aria-labelledby="health-late">
        <h2 id="health-late">
          Late arrivals
          <span class="count">{String(late?.length ?? 0)}</span>
        </h2>
        {lateError !== null ? (
          <p role="alert" class="error">
            {lateError}
          </p>
        ) : null}
        {late !== null && late.length === 0 ? (
          <p class="empty">No late or removed event since the server started.</p>
        ) : null}
        {late !== null && late.length > 0 ? (
          <ul class="late-list">
            {late.map((entry, index) => (
              <li
                key={`${String(index)}:${entry.hash}`}
                class={entry.type === 'removed' ? 'late-item removed' : 'late-item'}
                data-hash={entry.hash}
              >
                <span class="kind">{entry.kind}</span> <span class="late-type">{entry.type}</span>
                {entry.ticket !== null ? (
                  <>
                    {' '}
                    <code class="ticket-id">{entry.ticket}</code>
                  </>
                ) : null}{' '}
                <time dateTime={isoTime(entry.observedAt)}>
                  {`observed ${relativeTime(Math.max(0, now - entry.observedAt))}`}
                </time>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section class="health-section" data-section="check" aria-labelledby="health-check">
        <h2 id="health-check">Cache check</h2>
        <p class="check-note">
          Compares the cache with a full refold of the event log, as rebuild --check does. It
          briefly pauses writers while it runs, so it runs only when you press the button.
        </p>
        <button type="button" disabled={checking} onClick={runCheck}>
          {checking ? 'Checking...' : 'Run cache check'}
        </button>
        {checkError !== null ? (
          <p role="alert" class="error">
            {checkError}
          </p>
        ) : null}
        {check === null ? (
          <p class="check-none">No cache check has run</p>
        ) : (
          <p class="check-result" data-matches={check.matches ? 'true' : 'false'}>
            {check.matches
              ? 'The cache matches the event log'
              : `${String(check.differingRows)} differing row${check.differingRows === 1 ? '' : 's'}`}{' '}
            <time dateTime={isoTime(check.ranAt)}>
              {`checked ${relativeTime(Math.max(0, now - check.ranAt))}`}
            </time>
          </p>
        )}
      </section>
    </div>
  );
}

interface DurationInputProps {
  id: string;
  label: string;
  /** The text shown at first (the route's value or the default). */
  initial: string;
  /** Called with the text whenever it is a valid duration. */
  onValid: (text: string) => void;
}

/** A threshold input: invalid text is flagged and never reported. */
function DurationInput(props: DurationInputProps): JSX.Element {
  const [text, setText] = useState(props.initial);
  const [valid, setValid] = useState(true);
  // Follow a route changed elsewhere (a hash edited by hand, the back button).
  useEffect(() => {
    setText(props.initial);
    setValid(true);
  }, [props.initial]);
  return (
    <span class="field">
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="text"
        value={text}
        class={valid ? undefined : 'invalid'}
        aria-invalid={valid ? undefined : 'true'}
        aria-describedby="health-duration-help"
        onInput={(e) => {
          const next = e.currentTarget.value;
          setText(next);
          const ok = parseDuration(next) !== null;
          setValid(ok);
          if (ok) {
            props.onValid(next);
          }
        }}
      />
    </span>
  );
}

interface TicketItem {
  card: Card;
  detail: JSX.Element;
}

interface TicketSectionProps {
  name: string;
  title: string;
  items: TicketItem[];
}

/** One ticket section of the report. */
function TicketSection(props: TicketSectionProps): JSX.Element {
  const headingId = `health-${props.name}`;
  return (
    <section class="health-section" data-section={props.name} aria-labelledby={headingId}>
      <h2 id={headingId}>
        {props.title}
        <span class="count">{String(props.items.length)}</span>
      </h2>
      {props.items.length === 0 ? (
        <p class="empty">Nothing here.</p>
      ) : (
        <ul class="findings">
          {props.items.map((item) => (
            <li key={item.card.id} class="finding" data-ticket={item.card.id}>
              <a href={formatHash({ view: 'ticket', id: item.card.id })}>{item.card.title}</a>{' '}
              <code class="short-id" title={item.card.id}>
                {item.card.shortId}
              </code>
              {item.detail}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The open decisions of a finding. */
function Decisions(props: { decisions: { actor: string; text: string }[] }): JSX.Element {
  return (
    <ul class="open-decisions">
      {props.decisions.map((d, index) => (
        <li key={String(index)} class="decision">
          <span class="actor">{d.actor}</span>
          {': '}
          <span class="decision-text">{d.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The PR links of a close-merged candidate. */
function Prs(props: { candidate: CloseMergedCandidate }): JSX.Element {
  return (
    <p class="finding-detail prs">
      {props.candidate.prs.map((pr, index) => (
        <span key={String(index)} class="pr">
          {`PR ${String(pr)}`}
        </span>
      ))}
    </p>
  );
}
