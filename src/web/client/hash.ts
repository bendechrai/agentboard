/**
 * The URL hash of the web client: which view is shown and its filters
 * (board-web: "Board views": "The current view and its filters SHALL be kept in
 * the URL hash, so reloading the page restores them"; add-board-web design.md of
 * add-board-web: "Front end", "Client model"). There is no router library: the
 * client parses `location.hash` with `parseHash`, writes it with `formatHash`,
 * and re-renders on `hashchange`. Pure.
 *
 * Design notes:
 * - Hash forms, each starting `#/`:
 *   - `#/board` with the optional query parameters `change` (the board's
 *     task filter, `BoardFilters.task`: `<source>:<ref>` or
 *     `<source>:<ref>#<item>`), `assignee` (an actor) and `closed=1`
 *     (include closed tickets);
 *   - `#/feed` with the optional query parameters `change`
 *     (`FeedFilters.change`), `actor` (`FeedFilters.actor`) and `kind`,
 *     repeated once per selected kind (`FeedFilters.kinds`, in the order
 *     given);
 *   - `#/ticket/<id>` (a ticket id or prefix, percent-encoded as
 *     `encodeURIComponent` encodes it);
 *   - `#/lanes`;
 *   - `#/health` with the optional query parameters `stale` and `blocked`
 *     (the health thresholds as duration texts, board-insights:
 *     "Durations");
 *   - `#/replay` (no parameter: the replay position is not kept, since the
 *     frozen event list is taken anew whenever the view opens);
 *   - `#/graph` with the optional query parameters `change` (the graph's
 *     change filter, `<source>:<ref>`) and `since` (a duration text: only
 *     hand-offs at most that long before `now` count).
 *   The query follows the path after `?` and is read and written as
 *   `URLSearchParams` does (so `#` inside a value is `%23` and a space is
 *   `+`).
 * - An empty hash, `#`, `#/`, or any hash that is not one of the forms
 *   above (an unknown view, a `#/ticket/` with no id) is the board with no
 *   filter. Unknown query parameters are ignored; for a parameter given
 *   more than once, other than `kind`, the first counts; an empty value
 *   counts as absent; `closed` is true only for the value `1`.
 * - A duration parameter (`stale`, `blocked`, `since`) counts only when
 *   `parseDuration` (`src/view/health.ts`) accepts it; any other value
 *   counts as absent (null), so a hand-edited hash never shows an invalid
 *   threshold.
 */

import { parseDuration } from '../../view/health.js';

/** The views of the client. */
export type ViewName = 'board' | 'feed' | 'ticket' | 'lanes' | 'health' | 'replay' | 'graph';

/** The live board and its filters (as `boardColumns` takes them). */
export interface BoardRoute {
  view: 'board';
  /** `BoardFilters.task`, or null for no change filter. */
  change: string | null;
  /** `BoardFilters.assignee`, or null for no assignee filter. */
  assignee: string | null;
  /** `BoardFilters.includeClosed`. */
  closed: boolean;
}

/** The activity feed and its filters (as `feedEntries` takes them). */
export interface FeedRoute {
  view: 'feed';
  /** `FeedFilters.change`, or null. */
  change: string | null;
  /** `FeedFilters.actor`, or null. */
  actor: string | null;
  /**
   * `FeedFilters.kinds` in the order given, or null for every kind (no
   * `kind` parameter). Never an empty list: no `kind` parameter is null.
   */
  kinds: string[] | null;
}

/** The detail of one ticket. */
export interface TicketRoute {
  view: 'ticket';
  /** The ticket id or prefix as given in the hash, percent-decoded. */
  id: string;
}

/** The agent lanes. */
export interface LanesRoute {
  view: 'lanes';
}

/** The health view and its thresholds. */
export interface HealthRoute {
  view: 'health';
  /** The `staleAfter` threshold as a valid duration text, or null for the default (`2h`). */
  stale: string | null;
  /** The `blockedAfter` threshold as a valid duration text, or null for the default (`24h`). */
  blocked: string | null;
}

/** The replay view. */
export interface ReplayRoute {
  view: 'replay';
}

/** The hand-off graph and its filters. */
export interface GraphRoute {
  view: 'graph';
  /** `GraphFilter.change` (`<source>:<ref>`), or null for every change. */
  change: string | null;
  /**
   * A valid duration text: the graph counts hand-offs with a wall at or
   * after `now - parseDuration(since)`; null for all time.
   */
  since: string | null;
}

/** A view and its filters, as kept in the URL hash. */
export type Route =
  BoardRoute | FeedRoute | TicketRoute | LanesRoute | HealthRoute | ReplayRoute | GraphRoute;

/** The route of an empty or unrecognized hash: the board with no filter. */
export const DEFAULT_ROUTE: BoardRoute = {
  view: 'board',
  change: null,
  assignee: null,
  closed: false,
};

/**
 * The route named by `hash` (a `location.hash` value, with or without its
 * leading `#`), as described in the module comment. Never throws: anything
 * unrecognized is `DEFAULT_ROUTE` (a new object equal to it). Pure.
 */
export function parseHash(hash: string): Route {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text.startsWith('/')) {
    return { ...DEFAULT_ROUTE };
  }
  const mark = text.indexOf('?');
  const path = mark < 0 ? text.slice(1) : text.slice(1, mark);
  const query = new URLSearchParams(mark < 0 ? '' : text.slice(mark + 1));
  const one = (name: string): string | null => {
    const value = query.get(name);
    return value === null || value === '' ? null : value;
  };
  if (path === 'board') {
    return {
      view: 'board',
      change: one('change'),
      assignee: one('assignee'),
      closed: query.get('closed') === '1',
    };
  }
  if (path === 'feed') {
    const kinds = query.getAll('kind').filter((kind) => kind !== '');
    return {
      view: 'feed',
      change: one('change'),
      actor: one('actor'),
      kinds: kinds.length === 0 ? null : kinds,
    };
  }
  if (path === 'lanes') {
    return { view: 'lanes' };
  }
  const duration = (name: string): string | null => {
    const value = one(name);
    return value !== null && parseDuration(value) !== null ? value : null;
  };
  if (path === 'health') {
    return { view: 'health', stale: duration('stale'), blocked: duration('blocked') };
  }
  if (path === 'replay') {
    return { view: 'replay' };
  }
  if (path === 'graph') {
    return { view: 'graph', change: one('change'), since: duration('since') };
  }
  if (path.startsWith('ticket/') && path.length > 'ticket/'.length) {
    const id = decodeSafely(path.slice('ticket/'.length));
    if (id !== null && id !== '') {
      return { view: 'ticket', id };
    }
  }
  return { ...DEFAULT_ROUTE };
}

/** `decodeURIComponent`, or null for a malformed escape. */
function decodeSafely(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * The hash of `route`, with its leading `#`, such that
 * `parseHash(formatHash(route))` deep-equals `route` for every route whose
 * values are non-empty (an empty `kinds` list comes back as null).
 * Parameters are written in this order and only when set: board `change`,
 * `assignee`, `closed=1`; feed `change`, `actor`, then one `kind` per
 * kind; health `stale`, `blocked`; graph `change`, `since`. A route with
 * no parameter has no `?`: `#/board`, `#/feed`, `#/lanes`, `#/health`,
 * `#/replay`, `#/graph`, `#/ticket/<encodeURIComponent(id)>`. Pure.
 */
export function formatHash(route: Route): string {
  const query = new URLSearchParams();
  switch (route.view) {
    case 'board':
      if (route.change !== null) {
        query.append('change', route.change);
      }
      if (route.assignee !== null) {
        query.append('assignee', route.assignee);
      }
      if (route.closed) {
        query.append('closed', '1');
      }
      break;
    case 'feed':
      if (route.change !== null) {
        query.append('change', route.change);
      }
      if (route.actor !== null) {
        query.append('actor', route.actor);
      }
      for (const kind of route.kinds ?? []) {
        query.append('kind', kind);
      }
      break;
    case 'ticket':
      return `#/ticket/${encodeURIComponent(route.id)}`;
    case 'lanes':
      return '#/lanes';
    case 'health':
      if (route.stale !== null) {
        query.append('stale', route.stale);
      }
      if (route.blocked !== null) {
        query.append('blocked', route.blocked);
      }
      break;
    case 'replay':
      return '#/replay';
    case 'graph':
      if (route.change !== null) {
        query.append('change', route.change);
      }
      if (route.since !== null) {
        query.append('since', route.since);
      }
      break;
  }
  const text = query.toString();
  return text === '' ? `#/${route.view}` : `#/${route.view}?${text}`;
}
