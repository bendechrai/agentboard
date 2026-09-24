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
 *   printed by `agentboard serve`, discarding the stored token
 *   (board-web: "Access token").
 * - Stream data that is not valid JSON is ignored, as are event types
 *   other than `append`, `resync` and `problem`.
 */

import { applyFeedMessage } from '../../view/apply.js';
import type { AppendMessage, BoardModel, ResyncMessage } from '../../view/types.js';
import {
  ApiError,
  errorDocumentOf,
  isErrorDocument,
  loadModel,
  loadSession,
  type Connection,
  type ErrorDocument,
  type Session,
} from './api.js';
import type { SseEvent } from './sse.js';
import { openStream, type StreamHandle } from './stream.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppend(value: unknown): value is AppendMessage {
  return (
    isRecord(value) &&
    value['type'] === 'append' &&
    typeof value['id'] === 'string' &&
    Array.isArray(value['events']) &&
    Array.isArray(value['tickets'])
  );
}

function isResync(value: unknown): value is ResyncMessage {
  return (
    isRecord(value) &&
    value['type'] === 'resync' &&
    typeof value['id'] === 'string' &&
    Array.isArray(value['late']) &&
    Array.isArray(value['removed'])
  );
}

/** The parsed JSON of `data`, or undefined when it is not JSON. */
function parseData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

/** True for a failure answered 401 (the token is not accepted). */
function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** The client model: one per page. */
export class BoardClient {
  readonly #conn: Connection;
  #state: ClientState;
  readonly #listeners = new Set<(state: ClientState) => void>();
  #started = false;
  /** True once stopped (by `stop` or a 401): nothing more is requested or reported. */
  #halted = false;
  #stream: StreamHandle | null = null;
  #timer: { handle: unknown } | null = null;

  /** Nothing is requested until `start`. */
  constructor(conn: Connection) {
    this.#conn = conn;
    this.#state = {
      phase: 'loading',
      session: null,
      model: null,
      now: conn.deps.now(),
      problem: null,
      error: null,
      connected: false,
    };
  }

  /** The current state; the initial state is `loading` with `now` = `deps.now()`. */
  getState(): ClientState {
    return this.#state;
  }

  /**
   * Calls `listener` with the new state after every change, until the
   * returned function is called or the client is stopped.
   */
  subscribe(listener: (state: ClientState) => void): () => void {
    const entry = (state: ClientState): void => {
      listener(state);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
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
  async start(): Promise<void> {
    if (this.#started || this.#halted) {
      return;
    }
    this.#started = true;
    let session: Session;
    let model: BoardModel;
    try {
      [session, model] = await Promise.all([loadSession(this.#conn), loadModel(this.#conn, [])]);
    } catch (error) {
      if (this.#halted) {
        return;
      }
      if (isUnauthorized(error)) {
        this.#unauthorized();
        return;
      }
      const failure =
        error instanceof ApiError
          ? error
          : new ApiError(errorDocumentOf(error).error.message, 0, null);
      this.#set({ phase: 'failed', error: failure });
      return;
    }
    if (this.#halted) {
      return;
    }
    this.#set({ phase: 'ready', session, model, now: this.#conn.deps.now() });
    this.#open(model.id);
    const deps = this.#conn.deps;
    this.#timer = {
      handle: deps.setInterval(() => {
        this.#set({ now: deps.now() });
      }, REFRESH_MS),
    };
  }

  /**
   * Closes the stream, cancels the timer and drops every listener; no
   * state change is reported afterwards, and a load in flight is ignored
   * when it completes. Idempotent.
   */
  stop(): void {
    this.#halt();
    this.#listeners.clear();
  }

  /** Closes the stream and cancels the timer; nothing more happens afterwards. */
  #halt(): void {
    this.#halted = true;
    this.#closeStream();
    if (this.#timer !== null) {
      this.#conn.deps.clearInterval(this.#timer.handle);
      this.#timer = null;
    }
  }

  #unauthorized(): void {
    this.#halt();
    this.#set({ phase: 'unauthorized', connected: false }, true);
  }

  /** Replaces the state and reports it (also after a halt when `force`). */
  #set(change: Partial<ClientState>, force = false): void {
    if (this.#halted && !force) {
      return;
    }
    this.#state = { ...this.#state, ...change };
    for (const listener of [...this.#listeners]) {
      listener(this.#state);
    }
  }

  #closeStream(): void {
    this.#stream?.close();
    this.#stream = null;
  }

  #open(since: string): void {
    if (this.#halted) {
      return;
    }
    this.#stream = openStream(this.#conn, since, {
      onEvent: (event) => {
        this.#onEvent(event);
      },
      onOpen: () => {
        this.#set({ connected: true });
      },
      onDisconnect: () => {
        this.#set({ connected: false });
      },
      onUnauthorized: () => {
        this.#stream = null;
        this.#unauthorized();
      },
    });
  }

  #onEvent(event: SseEvent): void {
    const data = parseData(event.data);
    const model = this.#state.model;
    if (data === undefined || model === null) {
      return;
    }
    switch (event.type) {
      case 'append':
        if (!isAppend(data)) {
          return;
        }
        if (this.#state.problem !== null) {
          void this.#reload([], model.id);
          return;
        }
        this.#set({
          model: applyFeedMessage(model, data).model,
          now: this.#conn.deps.now(),
        });
        return;
      case 'resync':
        if (isResync(data)) {
          void this.#reload(applyFeedMessage(model, data).late, model.id);
        }
        return;
      case 'problem':
        if (isErrorDocument(data)) {
          this.#set({ problem: data });
        }
        return;
    }
  }

  /** Reloads the snapshot; on failure keeps the model and resumes its stream at `keptId`. */
  async #reload(late: string[], keptId: string): Promise<void> {
    this.#closeStream();
    this.#set({ connected: false });
    let model: BoardModel;
    try {
      model = await loadModel(this.#conn, late);
    } catch (error) {
      if (this.#halted) {
        return;
      }
      if (isUnauthorized(error)) {
        this.#unauthorized();
        return;
      }
      this.#set({ problem: errorDocumentOf(error) });
      this.#open(keptId);
      return;
    }
    if (this.#halted) {
      return;
    }
    this.#set({ model, problem: null, now: this.#conn.deps.now() });
    this.#open(model.id);
  }
}
