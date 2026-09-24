/**
 * The banner shown while the stream reports a problem (board-web: "Live
 * event stream": a tick failure is sent as a `problem` event; design.md:
 * "A tick failure does not stop the server"; add-board-web task 4.2).
 *
 * DOM contract (relied on by the component tests):
 * - one element with `role="alert"` and class `problem`, holding the
 *   document's `error.message` and, when not null, its `error.hint`, as
 *   text.
 */

import type { JSX } from 'preact';

import type { ErrorDocument } from '../api.js';

export interface ProblemBannerProps {
  problem: ErrorDocument;
}

export function ProblemBanner(props: ProblemBannerProps): JSX.Element {
  const { message, hint } = props.problem.error;
  return (
    <div role="alert" class="problem">
      <p class="problem-message">{message}</p>
      {hint !== null ? <p class="problem-hint">{hint}</p> : null}
    </div>
  );
}
