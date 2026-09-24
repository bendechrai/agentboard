/**
 * The single-page app of `agentboard serve` (board-web: "Board views";
 * design.md: "Front end", "Client model"; add-board-web tasks 4.2 to 4.4).
 *
 * On mount it creates one `BoardClient` with `{ ...defaultDeps(),
 * ...props.deps }` and starts it, subscribes to its state, and stops it on
 * unmount. The route is `parseHash(location.hash)`, read on mount and on
 * every `hashchange`; `navigate(route)` sets `location.hash` to
 * `formatHash(route)` (the view then follows the `hashchange`), so the
 * view and its filters survive a reload.
 *
 * DOM contract (relied on by the component tests):
 * - a `nav` with the links `Board` (`#/board`), `Feed` (`#/feed`) and
 *   `Lanes` (`#/lanes`);
 * - the session's `boardDir` as text once loaded;
 * - while loading, the text `Loading board...`; when the first load
 *   failed, an element with `role="alert"` holding the error's message;
 * - while the client's `problem` is set, a `ProblemBanner`;
 * - then the view of the route: `BoardView`, `FeedView`, `TicketView` or
 *   `LanesView`, each given the client's model and `now`.
 * Every text from the board is rendered as text, never as markup; the app
 * uses no `dangerouslySetInnerHTML` (a source test checks it).
 */

import type { JSX } from 'preact';

import type { ClientDeps } from './api.js';

export interface AppProps {
  /** Replaces some of `defaultDeps()` (tests); every other dependency is the browser's. */
  deps?: Partial<ClientDeps>;
}

export function App(props: AppProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
