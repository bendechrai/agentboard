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

import type { BoardModel } from '../../../view/types.js';
import type { Connection } from '../api.js';
import type { HealthRoute, Route } from '../hash.js';

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

export function HealthView(props: HealthViewProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
