/**
 * The single-page app of `agentboard serve` (board-web: "Board views",
 * "Access token"; design.md: "Front end", "Client model"; add-board-web
 * tasks 4.2 to 4.4).
 *
 * With a token (`props.token` not null), on mount it creates one
 * `BoardClient` with the connection `{ deps: { ...defaultDeps(),
 * ...props.deps }, token }` and starts it, subscribes to its state, and
 * stops it on unmount. With no token it makes no request at all. The route
 * is `parseHash(location.hash)`, read on mount and on every `hashchange`;
 * `navigate(route)` sets `location.hash` to `formatHash(route)` (the view
 * then follows the `hashchange`), so the view and its filters survive a
 * reload.
 *
 * DOM contract (relied on by the component tests):
 * - with no token, or once the client's phase is `unauthorized`, only an
 *   element with `role="alert"` and class `no-token` whose text includes
 *   `Open the URL printed by agentboard serve` (and no view). When the
 *   phase becomes `unauthorized` (a 401 from the API or the stream; the
 *   client has already stopped its stream), `props.onUnauthorized` is
 *   called once, which `mount` wires to `discardToken`;
 * - a `nav` with the links `Board` (`#/board`), `Feed` (`#/feed`) and
 *   `Lanes` (`#/lanes`);
 * - the session's `boardDir` as text once loaded;
 * - while loading, the text `Loading board...`; when the first load
 *   failed, an element with `role="alert"` holding the error's message;
 * - while the client's `problem` is set, a `ProblemBanner`;
 * - then the view of the route: `BoardView`, `FeedView`, `TicketView` or
 *   `LanesView`, each given the client's model and `now`.
 * Every text from the board is rendered as text, never as markup; no file
 * under `src/web/client/` may even name Preact's raw HTML property (a
 * source test in `src/web/__tests__/client-source.test.ts` checks it).
 */

import type { JSX } from 'preact';

import type { ClientDeps } from './api.js';

export interface AppProps {
  /** The access token (`takeToken`), or null when there is none. */
  token: string | null;
  /** Called once when the token is refused with 401 (`mount` discards the stored token). */
  onUnauthorized?: () => void;
  /** Replaces some of `defaultDeps()` (tests); every other dependency is the browser's. */
  deps?: Partial<ClientDeps>;
}

export function App(props: AppProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
