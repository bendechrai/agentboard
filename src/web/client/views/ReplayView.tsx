/**
 * The replay view (board-insights: "Replay"; design.md: "Replay in the
 * browser with the store's own fold"; add-board-insights task 3.3).
 *
 * Behavior:
 * - When the view mounts it takes a copy of `model.events` (every
 *   well-formed event, in fold order) and its checkpoints
 *   (`replayCheckpoints`). Later changes of `model` (appends and reloads
 *   from the stream) do not change that frozen list; reopening the view
 *   takes a new copy.
 * - Position `i` shows `replayState(frozen, i, checkpoints)`. The initial
 *   position is the last index (the present).
 * - Play steps forward one position every `1000 / speed` milliseconds
 *   (`speed` 1, 4 or 16 events per second), scheduled with
 *   `conn.deps.setInterval` and cancelled with `conn.deps.clearInterval`;
 *   the first step comes `1000 / speed` milliseconds after Play is
 *   pressed, so after `1000 * k` milliseconds of play exactly `speed * k`
 *   steps have been made (fewer when the last position is reached). On
 *   reaching the last position play stops by itself. Changing the speed
 *   while playing takes effect at once (the next step comes `1000 /
 *   newSpeed` milliseconds after the change). Pause stops stepping.
 *   Unmounting cancels any timer.
 *
 * DOM contract (relied on by the component tests):
 * - a `p` with class `replay-note` stating that replay follows the log's
 *   fold order, so an event synced late appears at its fold position (its
 *   text includes `fold order` and `late`);
 * - with no event: a `p` with class `empty` with the text `No events to
 *   replay.` and the `Back to live` button, and nothing else below;
 * - an `input` of type `range` with id `replay-position`, labelled
 *   `Position`, with `min` 0, `max` the last index, `step` 1 and `value`
 *   the position; its `input` event moves to the chosen position;
 * - a `p` with class `replay-counter` whose text is exactly
 *   `Event <position + 1> of <frozen length>`;
 * - `button`s (type `button`) with the texts `Step back` (disabled at
 *   position 0), `Step forward` (disabled at the last position), one
 *   toggle whose text is `Play` when not playing (disabled at the last
 *   position) and `Pause` while playing, and `Back to live`, which calls
 *   `navigate` with the board route with no filter
 *   (`{ view: 'board', change: null, assignee: null, closed: false }`);
 * - a `select` with id `replay-speed`, labelled `Speed`, with the options
 *   `1`, `4` and `16` (values; texts `1 event/s`, `4 events/s`,
 *   `16 events/s`), `1` selected at first;
 * - an element with class `replay-event`, `data-hash="<hash>"` and
 *   `data-outcome="<outcome>"` of the event at the position (the outcome
 *   the replay recomputed: `applied`, `rejected` or `unknown`), holding
 *   its actor and `describeEvent(event)`, and, when rejected,
 *   `rejected: <reason>`;
 * - the board columns of the replayed state, with the same DOM as the
 *   live board's columns (`BoardView`): one `section` with class `column`
 *   and `data-status` per status of `BOARD_COLUMNS`, holding one `article`
 *   with class `card` and `data-ticket` per card of
 *   `boardColumns(state.tickets, now, { includeClosed: false })`,
 *   rendered by `CardView`.
 * No element has a `style` attribute; every text from the board is
 * rendered as text, never as markup.
 */

import type { JSX } from 'preact';

import type { BoardModel } from '../../../view/types.js';
import type { Connection } from '../api.js';
import type { Route } from '../hash.js';

export interface ReplayViewProps {
  /** The live model; only its events at mount are replayed. */
  model: BoardModel;
  /** The time cards are computed at (`ClientState.now`). */
  now: number;
  /** Shows another route (writes the URL hash). */
  navigate: (route: Route) => void;
  /** Its `deps` provide the play timer. */
  conn: Connection;
}

export function ReplayView(props: ReplayViewProps): JSX.Element {
  void props;
  throw new Error('not implemented');
}
