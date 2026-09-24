/**
 * The live board (board-web: "Board views"; board-view-model: "Board
 * columns and cards"; add-board-web task 4.3): `boardColumns(model.tickets,
 * now, filters)` rendered as columns of cards, with the filters of the
 * route.
 *
 * DOM contract (relied on by the component tests):
 * - one `section` with class `column` and `data-status="<status>"` per
 *   column, in `BOARD_COLUMNS` order, with a heading naming the status;
 * - in it, one `article` with class `card` and `data-ticket="<full id>"`
 *   per card, in the column's order; it also has class `changed` when
 *   `card.changed` and `closed` when `card.closed`. It shows, as text, the
 *   title (inside a link to `#/ticket/<id>`), the short id, the assignee,
 *   the task reference or an ad hoc marker, the labels, the checklist
 *   progress `<done>/<total>`, `from <status>` when blocked, and the
 *   number of open decisions when not 0;
 * - a `select` labelled `Change` (option `all` with value `""`, then one
 *   option per distinct `<source>:<ref>` among the tickets' tasks, sorted),
 *   a `select` labelled `Assignee` (option `all` with value `""`, then one
 *   option per distinct assignee, sorted) and a checkbox labelled
 *   `Show closed`. Changing one calls `navigate` with the board route
 *   carrying the new filter (`""` is null); the URL hash is the only store
 *   of the filters.
 * Every text from the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import { boardColumns, type BoardFilters } from '../../../view/columns.js';
import type { BoardModel } from '../../../view/types.js';
import type { BoardRoute, Route } from '../hash.js';
import { CardView } from './CardView.js';
import { Select, sortedUnique } from './controls.js';

export interface BoardViewProps {
  model: BoardModel;
  /** The time `changed` is computed at (`ClientState.now`). */
  now: number;
  route: BoardRoute;
  /** Shows another route (writes the URL hash). */
  navigate: (route: Route) => void;
}

export function BoardView(props: BoardViewProps): JSX.Element {
  const { model, now, route, navigate } = props;
  const tickets = Object.values(model.tickets);
  const changes = sortedUnique(
    tickets.map((t) => (t.task === null ? null : `${t.task.source}:${t.task.ref}`)),
    route.change,
  );
  const assignees = sortedUnique(
    tickets.map((t) => t.assignee),
    route.assignee,
  );
  const filters: BoardFilters = { includeClosed: route.closed };
  if (route.change !== null) {
    filters.task = route.change;
  }
  if (route.assignee !== null) {
    filters.assignee = route.assignee;
  }
  const columns = boardColumns(model.tickets, now, filters);
  return (
    <div class="board-view">
      <form class="filters" aria-label="Board filters" onSubmit={(e) => e.preventDefault()}>
        <Select
          id="board-change"
          label="Change"
          value={route.change}
          options={changes}
          onChange={(change) => {
            navigate({ ...route, change });
          }}
        />
        <Select
          id="board-assignee"
          label="Assignee"
          value={route.assignee}
          options={assignees}
          onChange={(assignee) => {
            navigate({ ...route, assignee });
          }}
        />
        <label class="toggle" for="board-closed">
          <input
            id="board-closed"
            type="checkbox"
            checked={route.closed}
            onChange={(e) => {
              navigate({ ...route, closed: e.currentTarget.checked });
            }}
          />
          Show closed
        </label>
      </form>
      <div class="columns">
        {columns.map((column) => (
          <section
            key={column.status}
            class="column"
            data-status={column.status}
            aria-labelledby={`column-${column.status}`}
          >
            <h2 id={`column-${column.status}`} class="column-title">
              {column.status}
              <span class="count">{String(column.cards.length)}</span>
            </h2>
            {column.cards.map((card) => (
              <CardView key={card.id} card={card} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
