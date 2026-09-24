/**
 * The client model of the web app (design.md: "Client model"; board-web:
 * "Board views"; add-board-web task 4.2): loads a snapshot, follows the
 * live stream, and tells its subscribers whenever what they show changed.
 * Framework free; the Preact `App` subscribes to it.
 *
 * Decisions recorded here (test author, add-board-web group 4):
 * - A reload (after a `resync`, or on the first feed message after a
 *   `problem`) closes the current stream first and opens a new one with
 *   `since` the reloaded model's id, so no append read on the old stream
 *   can be applied on top of a newer snapshot.
 * - The `problem` banner stays until a reload succeeds: the first feed
 *   message (`append` or `resync`) after a `problem` reloads the snapshot
 *   instead of being applied, and a successful reload clears it.
 * - A reload that fails keeps the previous model, sets `problem` to the
 *   failure's `ErrorDocument` (or, without one, a document with exit code
 *   1, reason null and the error's message), and opens a stream with
 *   `since` the kept model's id, so the next feed message retries.
 * - A 401 from any request or from the stream means the token is not
 *   accepted (for example the server was restarted and drew a new one):
 *   the client stops (stream closed, timer cancelled) and its phase is
 *   `unauthorized`, which the app shows as the message to open the URL
 *   printed by `agentboard serve`.
 * - Stream data that is not valid JSON is ignored, as are event types
 *   other than `append`, `resync` and `problem`.
 */

import type { BoardModel } from '../../view/types.js';
import type { ApiError, Connection, ErrorDocument, Session } from './api.js';

/** How often the client refreshes `now`, re-rendering relative times: 10 seconds. */
export const REFRESH_MS = 10_000;

/** What the client shows. Replaced (never mutated) on every change. */
export interface ClientState {
  /**
   * `loading` until the first snapshot is loaded, then `ready`; `failed`
   * when the first load failed other than by 401 (nothing is retried;
   * `error` says why); `unauthorized` after a 401 from any request or the
   * stream.
   */
  phase: 'loading' | 'ready' | 'failed' | 'unauthorized';
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
  /** True while a stream connection is open (between `onOpen` and `onDisconnect`). */
  connected: boolean;
}

/** The client model: one per page. */
export class BoardClient {
  /** Nothing is requested until `start`. */
  constructor(conn: Connection) {
    void conn;
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
   * model and `now`; opens the stream (`openStream(conn, model.id, ...)`);
   * and schedules `deps.setInterval(refresh, REFRESH_MS)`, where refresh
   * sets `now` to `deps.now()`. When a request fails: state `unauthorized`
   * for a 401, else `failed` with `error`; no stream or timer. Resolves
   * once this is done; never rejects. Calling it again does nothing.
   *
   * Stream events, each `data` parsed as JSON:
   * - `append` (an `AppendMessage`): when `problem` is null, the model
   *   becomes `applyFeedMessage(model, message).model` and `now` is
   *   refreshed, with no request made; otherwise a reload.
   * - `resync` (a `ResyncMessage`): a reload whose model marks the
   *   message's late hashes (`applyFeedMessage(...).late`) as `late`.
   * - `problem` (an `ErrorDocument`): `problem` is set; the stream stays
   *   open and the model is kept.
   * `onOpen` and `onDisconnect` set `connected`; `onUnauthorized` stops
   * the client with phase `unauthorized`.
   * A reload closes the stream, loads `loadModel(conn, late)` (late empty
   * after a problem), sets the model, clears `problem`, refreshes `now`
   * and opens a new stream at the new model's id; see the module comment
   * for a failed reload and for a 401.
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
