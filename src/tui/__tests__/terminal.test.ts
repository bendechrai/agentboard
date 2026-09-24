/**
 * The `top` driver (`runTop`) on a fake terminal, with the snapshot loader
 * and the board feed replaced by test doubles serving the fixture board
 * (board-tui: "Top command", "Keys", "Live updates", "Frame rendering",
 * "Terminal restoration"; add-board-tui task 2.1). A real board, the real
 * feed and a writer in another process are in `top-live.test.ts`; the
 * command and the CLI in `top-command.test.ts`.
 *
 * Every screen is compared, cell by cell and style by style, with
 * `renderFrame` of the model and UI state the test computes itself with
 * the group 1 functions (`initialUi`, `reconcileUi`, `reduceKey`,
 * `applyFeedMessage`), through the test-only interpreter of the permitted
 * escape sequences (`screen.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { WatchBoardOptions } from '../../board/feed.js';
import type { Ticket } from '../../events/fold.js';
import type { BoardSnapshot } from '../../board/snapshot.js';
import { openBoard, type Board } from '../../store/board.js';
import { BoardError } from '../../store/errors.js';
import { tempBoard } from '../../store/__tests__/helpers.js';
import { applyFeedMessage } from '../../view/apply.js';
import type { AppendMessage, BoardModel, EventView, FeedMessage } from '../../view/types.js';
import { model as foldModel } from '../../view/__tests__/helpers.js';
import { renderFrame, type Frame, type Size } from '../frame.js';
import type { Key } from '../keys.js';
import { initialUi, reconcileUi, reduceKey, type UiState } from '../state.js';
import { ESCAPE_FLUSH_MS, REDRAW_MS, runTop, type TopOptions } from '../terminal.js';
import { BOARD_DIR, NOW, T1, T5, fixtureInputs } from './fixtures.js';
import {
  FakeTerminal,
  changedRows,
  expectRestoredOnce,
  expectScreen,
  pause,
  screenShows,
  until,
} from './screen.js';

const SIZE: Size = { columns: 80, rows: 24 };

// ---------------------------------------------------------------------------
// Fixtures

/** A snapshot of `inputs` (the fold helper's model without `late`), with a distinct id. */
function snapshotOf(inputs: ReturnType<typeof fixtureInputs>, id: string): BoardSnapshot {
  const m = foldModel(inputs);
  return { tickets: m.tickets, meta: m.meta, events: m.events, head: m.head, id };
}

const INPUTS = fixtureInputs();
/** The fixture board without its last event (T5's hand-off). */
const BEFORE = snapshotOf(INPUTS.slice(0, -1), `${'a'.repeat(64)}.${'1'.repeat(64)}`);
/** The whole fixture board. */
const AFTER = snapshotOf(INPUTS, `${'b'.repeat(64)}.${'2'.repeat(64)}`);

const asModel = (snapshot: BoardSnapshot, late: string[] = []): BoardModel => ({
  ...snapshot,
  late,
});

/** The event view of `hash` in the whole fixture. */
function viewOf(hash: string): EventView {
  const view = AFTER.events.find((e) => e.hash === hash);
  if (view === undefined) {
    throw new Error(`no event ${hash}`);
  }
  return view;
}

/** The ticket `id` of the whole fixture. */
function ticketAfter(id: string): Ticket {
  const ticket = AFTER.tickets[id];
  if (ticket === undefined) {
    throw new Error(`no ticket ${id}`);
  }
  return ticket;
}

/** The append that turns BEFORE into AFTER. */
const APPEND: AppendMessage = {
  type: 'append',
  id: AFTER.id,
  events: [viewOf(INPUTS.at(-1)?.hash ?? '')],
  tickets: [ticketAfter(T5)],
  meta: null,
};

/** T5's comment, the fixture's late arrival. */
const LATE = INPUTS.find(
  (i) => i.event.kind === 'ticket.comment' && 'ticket' in i.event && i.event.ticket === T5,
);

const char = (c: string): Key => ({ name: 'char', char: c });
const ENTER: Key = { name: 'enter' };
const ESCAPE: Key = { name: 'escape' };

// ---------------------------------------------------------------------------
// Test doubles

/** A board feed double: records each start and lets the test deliver messages. */
class FakeFeed {
  readonly starts: WatchBoardOptions[] = [];
  private readonly rejects: ((error: unknown) => void)[] = [];

  readonly watch = (board: Board, options: WatchBoardOptions): Promise<void> => {
    void board;
    this.starts.push(options);
    return new Promise<void>((resolve, reject) => {
      this.rejects.push(reject);
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
  };

  /** The options of the feed running now (the last started). */
  get current(): WatchBoardOptions {
    const options = this.starts.at(-1);
    if (options === undefined) {
      throw new Error('no feed started');
    }
    return options;
  }

  /** Fails the current feed as a tick would: `onProblem` when given, else the promise rejects. */
  fail(error: unknown): void {
    const options = this.current;
    if (options.onProblem !== undefined) {
      options.onProblem(error);
    } else {
      this.rejects.at(-1)?.(error);
    }
  }

  /** Delivers `message` as a tick would; an exception of the consumer is a tick failure. */
  deliver(message: FeedMessage): void {
    try {
      this.current.onMessage(message);
    } catch (error) {
      this.fail(error);
    }
  }

  /** A tick that found the cache busy. */
  busy(): void {
    this.current.onWarning?.('the board cache is busy; retrying at the next tick');
  }
}

interface Running {
  readonly term: FakeTerminal;
  readonly feed: FakeFeed;
  readonly controller: AbortController;
  /** How many snapshots were loaded. */
  loads(): number;
  /** 'running', 'resolved' or 'rejected'. */
  state(): 'running' | 'resolved' | 'rejected';
  /** The rejection, when rejected. */
  error(): unknown;
  /** Whether the terminal was restored at the moment the promise settled. */
  restoredAtSettle(): boolean | null;
  readonly done: Promise<void>;
  clock: { now: number };
}

const boards: Board[] = [];
afterEach(() => {
  for (const board of boards.splice(0)) {
    board.close();
  }
});

interface StartOptions {
  size?: Size;
  env?: Record<string, string | undefined>;
  snapshots?: (BoardSnapshot | Error)[];
  redrawMs?: number;
  render?: TopOptions['render'];
  signal?: AbortSignal;
}

function start(options: StartOptions = {}): Running {
  const board = openBoard(tempBoard());
  boards.push(board);
  const term = new FakeTerminal(options.size ?? SIZE);
  const feed = new FakeFeed();
  const controller = new AbortController();
  const snapshots = [...(options.snapshots ?? [BEFORE])];
  let loads = 0;
  let state: 'running' | 'resolved' | 'rejected' = 'running';
  let error: unknown = null;
  let restoredAtSettle: boolean | null = null;
  const clock = { now: NOW };
  const done = runTop({
    board,
    terminal: term,
    signal: options.signal ?? controller.signal,
    env: options.env ?? {},
    boardDir: BOARD_DIR,
    now: () => clock.now,
    redrawMs: options.redrawMs ?? 3_600_000,
    loadSnapshot: () => {
      loads += 1;
      const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
      if (next instanceof Error) {
        throw next;
      }
      if (next === undefined) {
        throw new Error('no snapshot');
      }
      return next;
    },
    watch: feed.watch,
    ...(options.render === undefined ? {} : { render: options.render }),
  });
  done.then(
    () => {
      state = 'resolved';
      restoredAtSettle = term.restored;
    },
    (e: unknown) => {
      state = 'rejected';
      error = e;
      restoredAtSettle = term.restored;
    },
  );
  return {
    term,
    feed,
    controller,
    loads: () => loads,
    state: () => state,
    error: () => error,
    restoredAtSettle: () => restoredAtSettle,
    done: done.catch(() => undefined),
    clock,
  };
}

/** The UI a fresh `top` shows for `model`, after `keys`. */
function uiAfter(model: BoardModel, keys: readonly Key[] = [], size: Size = SIZE): UiState {
  let ui = reconcileUi(initialUi(BOARD_DIR), model);
  for (const key of keys) {
    ui = reduceKey(ui, key, model, size);
  }
  return ui;
}

function frame(model: BoardModel, ui: UiState, size: Size = SIZE, now = NOW): Frame {
  return renderFrame(model, ui, size, now);
}

/** Waits until the screen shows `expected`, then asserts it exactly. */
async function shows(run: Running, expected: Frame, color = true, ms = 2000): Promise<void> {
  await until(() => screenShows(run.term.screen, expected, color), ms, 'the expected frame').catch(
    () => undefined,
  );
  expectScreen(run.term.screen, expected, color);
}

async function settled(run: Running, ms = 2000): Promise<void> {
  await until(() => run.state() !== 'running', ms, 'top to stop');
}

// ---------------------------------------------------------------------------

describe('start', () => {
  it('enters the alternate screen, hides the cursor, turns raw mode on and draws the whole first frame', async () => {
    const run = start();
    const expected = frame(asModel(BEFORE), uiAfter(asModel(BEFORE)));
    await shows(run, expected);
    const { screen } = run.term;
    expect(screen.alt).toBe(true);
    expect(screen.cursorVisible).toBe(false);
    expect(run.term.raw).toBe(true);
    // The cursor is hidden before any text is drawn.
    const hide = screen.tokens.findIndex((t) => t.kind === 'hide-cursor');
    const firstText = screen.tokens.findIndex((t) => t.kind === 'text');
    expect(hide).toBeGreaterThanOrEqual(0);
    expect(hide).toBeLessThan(firstText);
    expect(run.state()).toBe('running');
    run.controller.abort();
    await run.done;
  });

  it('registers the restore with onExit before any terminal change', async () => {
    const run = start();
    await until(() => run.term.raw, 2000, 'raw mode');
    expect(run.term.exitListenersAtFirstChange).toBeGreaterThanOrEqual(1);
    run.controller.abort();
    await run.done;
  });

  it('starts the feed from the id of the snapshot it loaded, with a busy warning handler', async () => {
    const run = start();
    await until(() => run.feed.starts.length === 1, 2000, 'the feed');
    expect(run.feed.current.since).toBe(BEFORE.id);
    expect(typeof run.feed.current.onWarning).toBe('function');
    expect(run.feed.current.signal.aborted).toBe(false);
    run.controller.abort();
    await run.done;
    // Stopping stops the feed.
    expect(run.feed.current.signal.aborted).toBe(true);
  });

  it('a failing first load rejects without touching the terminal', async () => {
    const failure = new BoardError(5, 'integrity', 'event file x is not well-formed');
    const run = start({ snapshots: [failure] });
    await settled(run);
    expect(run.state()).toBe('rejected');
    expect(run.error()).toBe(failure);
    expect(run.term.journal.filter((e) => e.kind === 'write' || e.kind === 'raw')).toEqual([]);
    expect(run.term.listeners).toBe(0);
    expect(run.feed.starts).toHaveLength(0);
  });

  it('an already aborted signal resolves without loading or touching the terminal', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = start({ signal: controller.signal });
    await settled(run);
    expect(run.state()).toBe('resolved');
    expect(run.loads()).toBe(0);
    expect(run.term.journal).toEqual([]);
  });
});

describe('keys', () => {
  it('scenario: Open and close a detail (l, l, j, Enter, then a lone Escape)', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    run.term.type('l');
    run.term.type('l');
    run.term.type('j');
    run.term.type('\r');
    const opened = uiAfter(m, [char('l'), char('l'), char('j'), ENTER]);
    expect(opened.detail).not.toBeNull();
    await shows(run, frame(m, opened));
    // A lone ESC is held back until no byte follows it, then closes the detail.
    run.term.type('\x1b');
    const closed = uiAfter(m, [char('l'), char('l'), char('j'), ENTER, ESCAPE]);
    expect(closed.detail).toBeNull();
    await pause(ESCAPE_FLUSH_MS + 100);
    expectScreen(run.term.screen, frame(m, closed));
    run.controller.abort();
    await run.done;
  });

  it('decodes keys given in one chunk exactly as one by one', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    run.term.type('llj\r');
    await shows(run, frame(m, uiAfter(m, [char('l'), char('l'), char('j'), ENTER])));
    run.controller.abort();
    await run.done;
  });

  it('decodes an arrow split across two chunks', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    run.term.type('l');
    run.term.type('\x1b[');
    run.term.type('B');
    await pause(ESCAPE_FLUSH_MS + 100);
    expectScreen(run.term.screen, frame(m, uiAfter(m, [char('l'), { name: 'down' }])));
    run.controller.abort();
    await run.done;
  });

  it('scenario: Unknown key writes nothing at all', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    run.term.screen.mark();
    run.term.type('z');
    await pause(100);
    expect(run.term.screen.bytesSinceMark).toBe(0);
    run.controller.abort();
    await run.done;
  });

  it('rewrites exactly the rows that changed', async () => {
    const run = start();
    const m = asModel(BEFORE);
    const first = frame(m, uiAfter(m));
    await shows(run, first);
    for (const keys of [[char('l')], [char('l'), char('l')], [char('l'), char('l'), char('2')]]) {
      run.term.screen.mark();
      const previous = frame(m, uiAfter(m, keys.slice(0, -1)));
      const next = frame(m, uiAfter(m, keys));
      const last = keys.at(-1);
      run.term.type(last?.name === 'char' ? last.char : '');
      await shows(run, next);
      const changed = changedRows(previous, next);
      expect(changed.length).toBeGreaterThan(0);
      expect([...run.term.screen.rowsWritten].sort((a, b) => a - b)).toEqual(changed);
    }
    run.controller.abort();
    await run.done;
  });

  it('q quits: resolves after restoring the terminal once', async () => {
    const run = start();
    await until(() => run.term.raw, 2000, 'raw mode');
    run.term.type('q');
    await settled(run);
    expect(run.state()).toBe('resolved');
    expect(run.restoredAtSettle()).toBe(true);
    expectRestoredOnce(run.term);
  });
});

describe('scenario: Too small, and resizing', () => {
  it('redraws every row at the new size, shows the too-small message and keeps running', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    const small = { columns: 50, rows: 10 };
    run.term.resize(small);
    const tooSmall = frame(m, uiAfter(m), small);
    expect(tooSmall.lines[0]).toContain('terminal too small: need 60x15, have 50x10');
    await shows(run, tooSmall);
    await pause(100);
    expect(run.state()).toBe('running');
    const wide = { columns: 140, rows: 40 };
    run.term.resize(wide);
    await shows(run, frame(m, uiAfter(m), wide));
    run.term.type('q');
    await settled(run);
    expect(run.state()).toBe('resolved');
    expectRestoredOnce(run.term);
  });

  it('applies keys at the current size', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    const size = { columns: 60, rows: 15 };
    run.term.resize(size);
    await shows(run, frame(m, uiAfter(m), size));
    run.term.type('2');
    run.term.type('\x1b[6~');
    await shows(run, frame(m, uiAfter(m, [char('2'), { name: 'pagedown' }], size), size));
    run.controller.abort();
    await run.done;
  });
});

describe('scenario: No color', () => {
  /** A session with colored cells: the busy notice (yellow) and T1's decisions (green, red). */
  async function coloredSession(env: Record<string, string>): Promise<Running> {
    const run = start({ env });
    const m = asModel(BEFORE);
    await until(() => run.feed.starts.length === 1, 2000, 'the feed');
    run.feed.busy();
    // T1 is the first card of the implementing column (the third).
    run.term.type('ll\r');
    const ui = { ...uiAfter(m, [char('l'), char('l'), ENTER]), notice: 'busy' };
    expect(ui.detail?.ticket).toBe(T1);
    const expected = frame(m, ui);
    expect(expected.styles.flat().some((r) => r.style.color !== null)).toBe(true);
    await shows(run, expected, env.NO_COLOR === undefined || env.NO_COLOR === '');
    return run;
  }

  it('with NO_COLOR=1 writes no SGR 30 to 37, and keeps bold, dim and inverse', async () => {
    const run = await coloredSession({ NO_COLOR: '1' });
    expect(run.term.screen.usedColor).toBe(false);
    const styles = run.term.screen.cells.flat().map((c) => c.style);
    expect(styles.some((s) => s.bold)).toBe(true);
    expect(styles.some((s) => s.dim)).toBe(true);
    run.term.type('\x1b');
    await pause(ESCAPE_FLUSH_MS + 100);
    expect(run.term.screen.cells.flat().some((c) => c.style.inverse)).toBe(true);
    run.controller.abort();
    await run.done;
    expect(run.term.screen.usedColor).toBe(false);
  });

  it('with NO_COLOR empty (or unset) uses the colors of the frame', async () => {
    for (const env of [{ NO_COLOR: '' }, {}]) {
      const run = await coloredSession(env);
      expect(run.term.screen.usedColor).toBe(true);
      run.controller.abort();
      await run.done;
    }
  });
});

describe('live updates', () => {
  it('applies an append and redraws', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await until(() => run.feed.starts.length === 1, 2000, 'the feed');
    run.term.type('2');
    await shows(run, frame(m, uiAfter(m, [char('2')])));
    run.feed.deliver(APPEND);
    const next = applyFeedMessage(m, APPEND).model;
    await shows(run, frame(next, reconcileUi(uiAfter(m, [char('2')]), next)));
    expect(run.loads()).toBe(1);
    run.controller.abort();
    await run.done;
  });

  it('scenario: Late arrival: a resync reloads the snapshot, marks the late events and restarts the feed from the reloaded id', async () => {
    const run = start({ snapshots: [BEFORE, AFTER] });
    const m = asModel(BEFORE);
    await until(() => run.feed.starts.length === 1, 2000, 'the feed');
    run.term.type('2');
    await shows(run, frame(m, uiAfter(m, [char('2')])));
    const first = run.feed.current;
    const late = viewOf(LATE?.hash ?? '');
    run.feed.deliver({ type: 'resync', id: AFTER.id, late: [late], removed: [] });
    await until(() => run.loads() === 2, 2000, 'the reload');
    const reloaded = asModel(AFTER, [late.hash]);
    await shows(run, frame(reloaded, reconcileUi(uiAfter(m, [char('2')]), reloaded)));
    expect(run.term.screen.lines().some((line) => line.includes(' late '))).toBe(true);
    await until(() => run.feed.starts.length === 2, 2000, 'the restarted feed');
    expect(first.signal.aborted).toBe(true);
    expect(run.feed.current.since).toBe(AFTER.id);
    expect(run.feed.current.signal.aborted).toBe(false);
    run.controller.abort();
    await run.done;
  });

  it('shows busy on the last line until the next message', async () => {
    const run = start();
    const m = asModel(BEFORE);
    await until(() => run.feed.starts.length === 1, 2000, 'the feed');
    run.feed.busy();
    const busy = { ...uiAfter(m), notice: 'busy' };
    await shows(run, frame(m, busy));
    expect(run.term.screen.lines().at(-1)?.startsWith('busy  ')).toBe(true);
    expect(run.state()).toBe('running');
    run.feed.deliver(APPEND);
    const next = applyFeedMessage(m, APPEND).model;
    await shows(run, frame(next, reconcileUi(uiAfter(m), next)));
    expect(run.term.screen.lines().at(-1)?.startsWith('busy')).toBe(false);
    run.controller.abort();
    await run.done;
  });

  it('redraws every redrawMs with the current time, and writes nothing when no row changed', async () => {
    const run = start({ redrawMs: 40 });
    const m = asModel(BEFORE);
    await shows(run, frame(m, uiAfter(m)));
    run.term.screen.mark();
    await pause(150);
    expect(run.term.screen.bytesSinceMark).toBe(0);
    run.clock.now = NOW + 3 * 3_600_000;
    await shows(run, frame(m, uiAfter(m), SIZE, run.clock.now));
    run.controller.abort();
    await run.done;
  });

  it('redraws at least every 10 seconds by default', () => {
    expect(REDRAW_MS).toBe(10_000);
  });
});

describe('scenario: Terminal restoration on every exit path', () => {
  const paths: [string, (run: Running) => void, 'resolved' | 'rejected'][] = [
    ['q', (run) => run.term.type('q'), 'resolved'],
    ['Ctrl-C', (run) => run.term.type('\x03'), 'resolved'],
    ['keys after q in the same chunk are ignored', (run) => run.term.type('qj'), 'resolved'],
    ['the signal (SIGINT or SIGTERM)', (run) => run.controller.abort(), 'resolved'],
    ['the end of input', (run) => run.term.end(), 'resolved'],
    [
      'a failed feed tick',
      (run) => run.feed.fail(new BoardError(5, 'integrity', 'corrupt')),
      'rejected',
    ],
    [
      'a failed reload',
      (run) =>
        run.feed.deliver({ type: 'resync', id: AFTER.id, late: [], removed: [] }),
      'rejected',
    ],
  ];

  it.each(paths)('%s', async (_, trigger, outcome) => {
    const run = start({
      snapshots: [BEFORE, new BoardError(5, 'integrity', 'reload failed')],
    });
    await until(() => run.feed.starts.length === 1 && run.term.raw, 2000, 'the feed');
    trigger(run);
    await settled(run);
    expect(run.state()).toBe(outcome);
    if (outcome === 'rejected') {
      expect(run.error()).toBeInstanceOf(BoardError);
      expect(run.error()).toMatchObject({ exitCode: 5, reason: 'integrity' });
    }
    // Restored before the promise settled, so the CLI prints any error after it.
    expect(run.restoredAtSettle()).toBe(true);
    expectRestoredOnce(run.term);
    expect(run.feed.current.signal.aborted).toBe(true);
    // Later exit paths (another key, the process exiting) change nothing.
    const written = run.term.journal.length;
    run.term.type('q');
    run.term.exit();
    run.controller.abort();
    await pause(50);
    expect(run.term.journal.length).toBe(written);
  });

  it('a busy tick is not an exit path', async () => {
    const run = start();
    await until(() => run.feed.starts.length === 1, 2000, 'the feed');
    run.feed.busy();
    await pause(100);
    expect(run.state()).toBe('running');
    expect(run.term.restored).toBe(false);
    run.controller.abort();
    await run.done;
    expectRestoredOnce(run.term);
  });

  it('a render that throws (on a key) rejects with its error after restoring', async () => {
    const failure = new Error('render failed');
    let calls = 0;
    const run = start({
      render: (model, ui, size, now) => {
        calls += 1;
        if (ui.view === 'feed') {
          throw failure;
        }
        return renderFrame(model, ui, size, now);
      },
    });
    await until(() => calls > 0 && run.term.raw, 2000, 'the first frame');
    run.term.type('2');
    await settled(run);
    expect(run.state()).toBe('rejected');
    expect(run.error()).toBe(failure);
    expect(run.restoredAtSettle()).toBe(true);
    expectRestoredOnce(run.term);
  });

  it('a render that throws while applying a feed message rejects after restoring', async () => {
    const failure = new Error('render failed');
    const run = start({
      render: (model, ui, size, now) => {
        if (model.events.length === AFTER.events.length) {
          throw failure;
        }
        return renderFrame(model, ui, size, now);
      },
    });
    await until(() => run.feed.starts.length === 1 && run.term.raw, 2000, 'the feed');
    run.feed.deliver(APPEND);
    await settled(run);
    expect(run.state()).toBe('rejected');
    expect(run.error()).toBe(failure);
    expectRestoredOnce(run.term);
  });

  it('the process exiting (an uncaught exception) restores synchronously, once', async () => {
    const run = start();
    await until(() => run.term.raw, 2000, 'raw mode');
    run.term.exit();
    // Synchronously: the exit listener must not wait for anything.
    expect(run.term.restored).toBe(true);
    expect(run.term.screen.count('leave-alt')).toBe(1);
    expect(run.term.rawCalls).toEqual([true, false]);
    // Whatever follows (here the signal) restores nothing twice.
    run.controller.abort();
    await settled(run);
    expectRestoredOnce(run.term);
  });

  it('nothing is written after stopping, even when a redraw was due', async () => {
    const run = start({ redrawMs: 20 });
    await until(() => run.term.raw, 2000, 'raw mode');
    run.term.type('q');
    await settled(run);
    const written = run.term.journal.length;
    run.clock.now += 3_600_000;
    await pause(100);
    expect(run.term.journal.length).toBe(written);
  });
});
