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
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { defaultDeps, type ClientDeps, type Connection } from './api.js';
import { BoardClient, type ClientState } from './client.js';
import { formatHash, parseHash, type Route } from './hash.js';
import { BoardView } from './views/BoardView.js';
import { FeedView } from './views/FeedView.js';
import { LanesView } from './views/LanesView.js';
import { ProblemBanner } from './views/ProblemBanner.js';
import { TicketView } from './views/TicketView.js';

export interface AppProps {
  /** The access token (`takeToken`), or null when there is none. */
  token: string | null;
  /** Called once when the token is refused with 401 (`mount` discards the stored token). */
  onUnauthorized?: () => void;
  /** Replaces some of `defaultDeps()` (tests); every other dependency is the browser's. */
  deps?: Partial<ClientDeps>;
}

const NAV: readonly { label: string; route: Route }[] = [
  { label: 'Board', route: { view: 'board', change: null, assignee: null, closed: false } },
  { label: 'Feed', route: { view: 'feed', change: null, actor: null, kinds: null } },
  { label: 'Lanes', route: { view: 'lanes' } },
];

function NoToken(): JSX.Element {
  return (
    <main class="app">
      <div role="alert" class="no-token">
        <h1>agentboard</h1>
        <p>
          This page needs the access token of the running server. Open the URL printed by agentboard
          serve (it ends with <code>#token=...</code>) in this tab.
        </p>
      </div>
    </main>
  );
}

export function App(props: AppProps): JSX.Element {
  const { token } = props;
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [state, setState] = useState<ClientState | null>(null);
  const reported = useRef(false);
  const onUnauthorized = useRef(props.onUnauthorized);
  onUnauthorized.current = props.onUnauthorized;
  const deps = useRef(props.deps);

  const conn = useMemo<Connection | null>(
    () => (token === null ? null : { deps: { ...defaultDeps(), ...deps.current }, token }),
    [token],
  );

  useEffect(() => {
    const follow = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('hashchange', follow);
    };
  }, []);

  useEffect(() => {
    if (conn === null) {
      return undefined;
    }
    const client = new BoardClient(conn);
    setState(client.getState());
    const off = client.subscribe(setState);
    void client.start();
    return () => {
      off();
      client.stop();
    };
  }, [conn]);

  const phase = state?.phase ?? 'loading';
  useEffect(() => {
    if (phase === 'unauthorized' && !reported.current) {
      reported.current = true;
      onUnauthorized.current?.();
    }
  }, [phase]);

  if (conn === null || phase === 'unauthorized') {
    return <NoToken />;
  }

  const navigate = (next: Route): void => {
    const hash = formatHash(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(parseHash(hash));
  };

  return (
    <div class="app">
      <header class="top">
        <h1 class="brand">agentboard</h1>
        {state?.session ? <p class="board-dir">{state.session.boardDir}</p> : null}
        {phase === 'ready' ? (
          <p class={state?.connected === true ? 'live on' : 'live off'} role="status">
            {state?.connected === true ? 'live' : 'reconnecting...'}
          </p>
        ) : null}
        <nav aria-label="Views">
          <ul>
            {NAV.map((item) => (
              <li key={item.label}>
                <a
                  href={formatHash(item.route)}
                  aria-current={item.route.view === route.view ? 'page' : undefined}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {state?.problem ? <ProblemBanner problem={state.problem} /> : null}
      <main class="content">{body(state, route, conn, navigate)}</main>
    </div>
  );
}

function body(
  state: ClientState | null,
  route: Route,
  conn: Connection,
  navigate: (route: Route) => void,
): JSX.Element {
  if (state?.phase === 'failed') {
    return (
      <div role="alert" class="error">
        {state.error?.message ?? 'The board could not be loaded.'}
      </div>
    );
  }
  if (state?.phase !== 'ready' || state.model === null) {
    return <p class="loading">Loading board...</p>;
  }
  const { model, now } = state;
  switch (route.view) {
    case 'board':
      return <BoardView model={model} now={now} route={route} navigate={navigate} />;
    case 'feed':
      return <FeedView model={model} now={now} route={route} navigate={navigate} />;
    case 'ticket':
      return <TicketView id={route.id} model={model} conn={conn} now={now} />;
    case 'lanes':
      return <LanesView model={model} now={now} />;
  }
}
