/**
 * The activity feed (board-web: "Board views"; board-view-model: "Activity
 * feed entries"; add-board-web task 4.3): `feedEntries(model, filters)`,
 * newest first, with the filters of the route.
 *
 * DOM contract (relied on by the component tests):
 * - one `ol` with class `feed`, holding one `li` with class `entry`,
 *   `data-hash="<hash>"`, `data-kind="<kind>"` and `data-actor="<actor>"`
 *   per entry, in the order `feedEntries` gives; it also has class `late`
 *   when `entry.late`. It shows, as text, the actor, the summary,
 *   `relativeTime(now - ts.wall)`, and the ticket title (inside a link to
 *   `#/ticket/<id>`) when the entry has a ticket;
 * - a `select` labelled `Change` (option `all` with value `""`, then one
 *   option per distinct non-null `change` among the model's entries,
 *   sorted), a `select` labelled `Actor` (option `all` with value `""`,
 *   then one option per distinct actor among the entries, sorted), and a
 *   `fieldset` with the legend `Kinds` holding one checkbox per known kind
 *   (`KNOWN_KINDS`), each labelled with the kind. No checked kind means
 *   every kind (route `kinds` null); otherwise `kinds` lists the checked
 *   ones in `KNOWN_KINDS` order. Changing a filter calls `navigate` with
 *   the feed route carrying it.
 * Every text from the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import { KNOWN_KINDS } from '../../../events/schema.js';
import { feedEntries, type FeedFilters } from '../../../view/feed.js';
import { relativeTime } from '../../../view/time.js';
import type { BoardModel } from '../../../view/types.js';
import { formatHash, type FeedRoute, type Route } from '../hash.js';
import { Select, isoTime, sortedUnique } from './controls.js';

export interface FeedViewProps {
  model: BoardModel;
  now: number;
  route: FeedRoute;
  navigate: (route: Route) => void;
}

export function FeedView(props: FeedViewProps): JSX.Element {
  const { model, now, route, navigate } = props;
  const everything = feedEntries(model);
  const changes = sortedUnique(
    everything.map((e) => e.change),
    route.change,
  );
  const actors = sortedUnique(
    everything.map((e) => e.actor),
    route.actor,
  );
  const filters: FeedFilters = {};
  if (route.change !== null) {
    filters.change = route.change;
  }
  if (route.actor !== null) {
    filters.actor = route.actor;
  }
  if (route.kinds !== null) {
    filters.kinds = route.kinds;
  }
  const entries = feedEntries(model, filters);
  const checked = new Set(route.kinds ?? []);
  const toggle = (kind: string, on: boolean): void => {
    const next = new Set(checked);
    if (on) {
      next.add(kind);
    } else {
      next.delete(kind);
    }
    const kinds = KNOWN_KINDS.filter((k) => next.has(k));
    navigate({ ...route, kinds: kinds.length === 0 ? null : kinds });
  };
  return (
    <div class="feed-view">
      <form class="filters" aria-label="Feed filters" onSubmit={(e) => e.preventDefault()}>
        <Select
          id="feed-change"
          label="Change"
          value={route.change}
          options={changes}
          onChange={(change) => {
            navigate({ ...route, change });
          }}
        />
        <Select
          id="feed-actor"
          label="Actor"
          value={route.actor}
          options={actors}
          onChange={(actor) => {
            navigate({ ...route, actor });
          }}
        />
        <fieldset class="kinds">
          <legend>Kinds</legend>
          {KNOWN_KINDS.map((kind) => (
            <label key={kind} class="toggle" for={`kind-${kind}`}>
              <input
                id={`kind-${kind}`}
                type="checkbox"
                checked={checked.has(kind)}
                onChange={(e) => {
                  toggle(kind, e.currentTarget.checked);
                }}
              />
              {kind}
            </label>
          ))}
        </fieldset>
      </form>
      {entries.length === 0 ? <p class="empty">No activity matches.</p> : null}
      <ol class="feed">
        {entries.map((entry) => (
          <li
            key={entry.hash}
            class={entry.late ? 'entry late' : 'entry'}
            data-hash={entry.hash}
            data-kind={entry.kind}
            data-actor={entry.actor}
          >
            <span class="actor">{entry.actor}</span> <span class="summary">{entry.summary}</span>{' '}
            {entry.ticket !== null ? (
              <a class="ticket-link" href={formatHash({ view: 'ticket', id: entry.ticket })}>
                {entry.title ?? entry.ticket}
              </a>
            ) : null}{' '}
            <time class="age" dateTime={isoTime(entry.ts.wall)}>
              {relativeTime(now - entry.ts.wall)}
            </time>
            {entry.late ? <span class="late-marker"> (arrived late)</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
