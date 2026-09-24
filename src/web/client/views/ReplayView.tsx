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
 *   `16 events/s`), `1` selected at first; its `change` event sets the
 *   speed;
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
import { useEffect, useState } from 'preact/hooks';

import { boardColumns } from '../../../view/columns.js';
import { describeEvent } from '../../../view/describe.js';
import { replayCheckpoints, replayState, type ReplayCheckpoint } from '../../../view/replay.js';
import type { BoardModel, EventView } from '../../../view/types.js';
import type { Connection } from '../api.js';
import type { Route } from '../hash.js';
import { CardView } from './CardView.js';

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

/** The play speeds, in events per second. */
const SPEEDS: readonly number[] = [1, 4, 16];

/** The events frozen when the view opened, and their checkpoints. */
interface Frozen {
  events: EventView[];
  checkpoints: ReplayCheckpoint[];
}

export function ReplayView(props: ReplayViewProps): JSX.Element {
  const { now, navigate, conn } = props;
  const [frozen] = useState<Frozen>(() => {
    const events = props.model.events.slice();
    return { events, checkpoints: replayCheckpoints(events) };
  });
  const last = frozen.events.length - 1;
  const [position, setPosition] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Play: one step every 1000 / speed ms, restarted when the speed changes.
  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const handle = conn.deps.setInterval(() => {
      setPosition((p) => Math.min(p + 1, last));
    }, 1000 / speed);
    return () => {
      conn.deps.clearInterval(handle);
    };
  }, [playing, speed, conn, last]);

  // Play stops by itself at the last position.
  useEffect(() => {
    if (playing && position >= last) {
      setPlaying(false);
    }
  }, [playing, position, last]);

  const back = (
    <button
      type="button"
      class="back-to-live"
      onClick={() => {
        navigate({ view: 'board', change: null, assignee: null, closed: false });
      }}
    >
      Back to live
    </button>
  );
  const note = (
    <p class="replay-note">
      Replay follows the log&apos;s fold order, so an event synced late appears at its fold
      position, not when it arrived.
    </p>
  );

  if (last < 0) {
    return (
      <div class="replay-view">
        {note}
        <p class="empty">No events to replay.</p>
        {back}
      </div>
    );
  }

  const replay = replayState(frozen.events, position, frozen.checkpoints);
  const view = frozen.events[position];
  const columns = boardColumns(replay.state.tickets, now, { includeClosed: false });

  return (
    <div class="replay-view">
      {note}
      <form
        class="replay-controls"
        aria-label="Replay controls"
        onSubmit={(e) => e.preventDefault()}
      >
        <span class="field replay-slider">
          <label for="replay-position">Position</label>
          <input
            id="replay-position"
            type="range"
            min={0}
            max={last}
            step={1}
            value={position}
            onInput={(e) => {
              const next = Number(e.currentTarget.value);
              if (Number.isInteger(next) && next >= 0 && next <= last) {
                setPosition(next);
              }
            }}
          />
        </span>
        <p class="replay-counter">{`Event ${String(position + 1)} of ${String(last + 1)}`}</p>
        <span class="replay-buttons">
          <button
            type="button"
            disabled={position <= 0}
            onClick={() => {
              setPosition((p) => Math.max(0, p - 1));
            }}
          >
            Step back
          </button>
          <button
            type="button"
            disabled={position >= last}
            onClick={() => {
              setPosition((p) => Math.min(last, p + 1));
            }}
          >
            Step forward
          </button>
          <button
            type="button"
            disabled={!playing && position >= last}
            onClick={() => {
              setPlaying(!playing);
            }}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          {back}
        </span>
        <span class="field">
          <label for="replay-speed">Speed</label>
          <select
            id="replay-speed"
            value={String(speed)}
            onChange={(e) => {
              const next = Number(e.currentTarget.value);
              if (SPEEDS.includes(next)) {
                setSpeed(next);
              }
            }}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={String(s)}>
                {`${String(s)} event${s === 1 ? '' : 's'}/s`}
              </option>
            ))}
          </select>
        </span>
      </form>
      {view !== undefined ? (
        <p
          class={`replay-event ${replay.outcome}`}
          data-hash={view.hash}
          data-outcome={replay.outcome}
        >
          <span class="actor">{view.actor}</span>{' '}
          <span class="description">{describeEvent(view.event)}</span>
          {replay.outcome === 'rejected' ? (
            <span class="reason">{` rejected: ${replay.reason ?? 'unknown'}`}</span>
          ) : null}
        </p>
      ) : null}
      <div class="columns">
        {columns.map((column) => (
          <section
            key={column.status}
            class="column"
            data-status={column.status}
            aria-labelledby={`replay-column-${column.status}`}
          >
            <h2 id={`replay-column-${column.status}`} class="column-title">
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
