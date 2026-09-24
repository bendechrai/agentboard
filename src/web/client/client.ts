/**
 * The client model of the web app (design.md: "Client model"; board-web:
 * "Board views"; add-board-web task 4.2): loads a snapshot, follows the
 * live stream, and tells its subscribers whenever what they show changed.
 * Framework free; the Preact `App` subscribes to it.
 *
 * Decisions recorded here (test author, add-board-web group 4):
 * - A reload (after a `resync`, or on the first feed message after a
 *   `problem`) closes the current stream first and opens a new one with
 *   `since` the reloaded model's id, so no append written on the old
 *   stream can be applied on top of a newer snapshot.
 * - The `problem` banner stays until a reload succeeds: the first feed
 *   message (`append` or `resync`) after a `problem` reloads the snapshot
 *   instead of being applied, and a successful reload clears it.
 * - A reload that fails keeps the previous model, sets `problem` to the
 *   failure's `ErrorDocument` (or, without one, a document with exit code
 *   1, reason null and the error's message), and opens a stream with
 *   `since` the kept model's id, so the next feed message retries.
 * - Stream data that is not valid JSON is ignored.
 */

import type { BoardModel } from '../../view/types.js';
import type { ApiError, ClientDeps, ErrorDocument, Session } from './api.js';

/** How often the client refreshes `now`, re-rendering relative times: 10 seconds. */
export const REFRESH_MS = 10_000;

/** What the client shows. Replaced (never mutated) on every change. */
export interface ClientState {
  /**
   * `loading` until the first snapshot is loaded, then `ready`; `failed`
   * when the first load failed (nothing is retried; `error` says why).
   */
  phase: 'loading' | 'ready' | 'failed';
  /** `/api/session`, once loaded. */
  session: Session | null;
  /** The board model, once loaded; kept current by the stream. */
  model: BoardModel | null;
  /**
   * The time the views compute with (`deps.now()`), refreshed every
   * `REFRESH_MS`, on every applied append and on every reload.
   */
  now: number;
  /** The latest stream `problem` (or failed reload) not yet recovered from; null when none. */
  problem: ErrorDocument | null;
  /** Why the first load failed (`phase` `failed`); null otherwise. */
  error: ApiError | null;
  /** True between the stream's `open` and its next `error`. */
  connected: boolean;
}

/** The client model: one per page. */
export class BoardClient {
  /** Nothing is requested until `start`. */
  constructor(deps: ClientDeps) {
    void deps;
  }

  /** The current state; the initial state is `loading` with `now` = `deps.now()`. */
  getState(): ClientState {
    throw new Error('not implemented');
  }

  /**
   * Calls `listener` with the new state after every change, until the
   * returned function is called or the client is stopped.
   */
  subscribe(listener: (state: ClientState) => void): () => void {
    void listener;
    throw new Error('not implemented');
  }

  /**
   * Loads `/api/session` and the snapshot (`loadModel` with no late
   * hashes), then, when both succeed: state `ready` with the session, the
   * model and `now`; opens `deps.EventSource(streamUrl(model.id))`; and
   * schedules `deps.setInterval(refresh, REFRESH_MS)`, where refresh sets
   * `now` to `deps.now()`. When a request fails: state `failed` with
   * `error`, and no stream or timer. Resolves once this is done; never
   * rejects. Calling it again does nothing.
   *
   * Stream events, each `data` parsed as JSON:
   * - `append` (an `AppendMessage`): when `problem` is null, the model
   *   becomes `applyFeedMessage(model, message).model` and `now` is
   *   refreshed, with no request made; otherwise a reload.
   * - `resync` (a `ResyncMessage`): a reload whose model marks the
   *   message's late hashes (`applyFeedMessage(...).late`) as `late`.
   * - `problem` (an `ErrorDocument`): `problem` is set; the stream stays
   *   open and the model is kept.
   * - `open` and `error`: `connected` true and false (the browser's
   *   `EventSource` reconnects by itself, resuming with `Last-Event-ID`).
   * A reload closes the stream, loads `loadModel(deps, late)` (late empty
   * after a problem), sets the model, clears `problem`, refreshes `now`
   * and opens a new stream with `since` the new model's id; see the module
   * comment for a failed reload. Messages arriving on a closed stream are
   * ignored.
   */
  start(): Promise<void> {
    throw new Error('not implemented');
  }

  /**
   * Closes the stream, cancels the timer and drops every listener; no
   * state change is reported afterwards, and a load in flight is ignored
   * when it completes. Idempotent.
   */
  stop(): void {
    throw new Error('not implemented');
  }
}
