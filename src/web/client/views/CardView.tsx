/**
 * One ticket card, as the board and the agent lanes show it (board-web:
 * "Board views"; board-view-model: "Board columns and cards"). See
 * `BoardView` for its DOM contract: an `article` with class `card`,
 * `data-ticket`, and the classes `changed` and `closed`.
 *
 * The scope marker in the second `p.card-meta` (ADR 0013; board-view-model
 * "Board columns and cards", scenario "Unplanned card"): with a task
 * reference, `span.task` holding the reference text; otherwise, when
 * `card.unplanned` is not null, `span.task.unplanned` with the text
 * `unplanned` followed by `span.unplanned-reason` holding the reason as
 * text (the card never shows `ad hoc` then, whatever `card.adhoc`);
 * otherwise, when `card.adhoc` is true, `span.task.adhoc` with the text
 * `ad hoc`; otherwise no marker.
 * Every text from the board is rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import type { Card } from '../../../view/columns.js';
import { formatHash } from '../hash.js';

export interface CardViewProps {
  card: Card;
}

export function CardView({ card }: CardViewProps): JSX.Element {
  const classes = ['card'];
  if (card.changed) {
    classes.push('changed');
  }
  if (card.closed) {
    classes.push('closed');
  }
  const { done, total } = card.checklist;
  return (
    <article class={classes.join(' ')} data-ticket={card.id}>
      <h3 class="card-title">
        <a href={formatHash({ view: 'ticket', id: card.id })}>{card.title}</a>
      </h3>
      <p class="card-meta">
        <code class="short-id" title={card.id}>
          {card.shortId}
        </code>
        <span class="assignee">{card.assignee ?? 'unassigned'}</span>
      </p>
      <p class="card-meta">
        {card.task !== null ? (
          <span class="task">{card.task}</span>
        ) : card.unplanned !== null ? (
          <>
            <span class="task unplanned">unplanned</span>
            <span class="unplanned-reason">{card.unplanned.reason}</span>
          </>
        ) : card.adhoc ? (
          <span class="task adhoc">ad hoc</span>
        ) : null}
        {total > 0 ? (
          <span class="progress" title="checklist lines done">
            {`${String(done)}/${String(total)}`}
          </span>
        ) : null}
        {card.blockedFrom !== null ? (
          <span class="blocked-from">{`from ${card.blockedFrom}`}</span>
        ) : null}
        {card.openDecisions > 0 ? (
          <span class="decisions">
            {`${String(card.openDecisions)} open decision${card.openDecisions === 1 ? '' : 's'}`}
          </span>
        ) : null}
        {card.closed ? <span class="closed-marker">closed</span> : null}
      </p>
      {card.labels.length > 0 ? (
        <ul class="labels" aria-label="labels">
          {card.labels.map((label, index) => (
            <li key={`${String(index)}:${label}`} class="label">
              {label}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
