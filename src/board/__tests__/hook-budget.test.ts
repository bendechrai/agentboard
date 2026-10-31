/**
 * The time budget covers each event's own work, and the payload read is
 * bounded (add-harness-integration review round 1 of task group 2, design.md
 * "Rulings from review round 1 of task group 2" R1 and R8; board-harness-hooks
 * "Hook command and protocol", "Session start hook").
 *
 * In process, through `runHook` with an injected clock (`HookRequest.now`,
 * `startedAt`, `budgetMs`), so the deadline is exact and independent of
 * the machine's load. Event-file reads are observed through a
 * pass-through mock of `node:fs` (`readFileSync` and `openSync` see every
 * path they are given, then do the real thing), which is how the tests
 * tell when the hook opens an event file relative to its clock and to the
 * cache write lock. The built CLI under a write lock held by another
 * process is pinned by src/__tests__/hook-events-processes.test.ts.
 */

import type * as Fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliEnv, oneJson, project, run, type Run } from '../../cli/__tests__/cli-helpers.js';
import { ev, P, putEvent } from '../../store/__tests__/helpers.js';
import {
  HOOK_STDIN_LIMIT,
  readHookStdin,
  runHook,
  type HookInput,
  type HookOutcome,
  type HookRequest,
} from '../hook.js';
import { cleanEnv, tempDir } from './helpers.js';

/** What the `node:fs` mock reports: each path an event file is opened by. */
const watch = vi.hoisted(() => ({ onRead: null as ((path: string) => void) | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const seen = (path: unknown): void => {
    if (typeof path === 'string' && watch.onRead !== null) {
      watch.onRead(path);
    }
  };
  return {
    ...actual,
    readFileSync: (...args: unknown[]): unknown => {
      seen(args[0]);
      return Reflect.apply(actual.readFileSync, actual, args) as unknown;
    },
    openSync: (...args: unknown[]): unknown => {
      seen(args[0]);
      return Reflect.apply(actual.openSync, actual, args) as unknown;
    },
  };
});

/** An event file of a board: `<board>/events/<sha256>.json`. */
const EVENT_FILE = /[\\/]events[\\/][0-9a-f]{64}\.json$/;

/** The stderr line of a run out of time (board-harness-hooks "Hook command and protocol"). */
const OUT_OF_TIME = /^agentboard hook: out of time[^\n]*\n$/;

/** The stderr line of a cache that cannot be read (a locked one included). */
const UNREADABLE = /^agentboard hook: the board cache is [^\n]*locked[^\n]*\n$/;

let stateDir = '';

beforeEach(() => {
  stateDir = tempDir();
  watch.onRead = null;
});

afterEach(() => {
  watch.onRead = null;
});

/** The environment of a hook: clean git, no board override, no actor, hooks on. */
function hookEnv(): Record<string, string | undefined> {
  return cleanEnv({
    AGENTBOARD_ACTOR: undefined,
    AGENTBOARD_DIR: undefined,
    AGENTBOARD_HOOKS: undefined,
  });
}

/** Runs the CLI in process and expects exit 0. */
function cli(argv: readonly string[], root: string): Run {
  const out = run(argv, root, cliEnv());
  expect(out.code, `${argv.join(' ')}: ${out.stderr}`).toBe(0);
  return out;
}

/** A project whose board has one ad hoc ticket claimed by impl, with `comments` notes by orch. */
function claimedBoard(comments = 2): { root: string; boardDir: string; id: string } {
  const { root, boardDir } = project();
  const out = cli(['new', 'Held work', '--adhoc', 'hook test', '--as', 'orch', '--json'], root);
  const { id } = (oneJson(out) as { ticket: { id: string } }).ticket;
  cli(['claim', id, '--as', 'impl'], root);
  cli(['inbox', '--as', 'impl'], root);
  for (let i = 0; i < comments; i += 1) {
    cli(['comment', id, `note ${String(i)} from orch ${'n'.repeat(120)}`, '--as', 'orch'], root);
  }
  return { root, boardDir, id };
}

/** The `inbox` text lines pending for `actor`, without acknowledging them. */
function peekLines(root: string, actor: string): string[] {
  return cli(['inbox', '--as', actor, '--peek'], root)
    .stdout.split('\n')
    .filter((l) => l !== '');
}

/** The lines of the SessionStart context of an answer (exit 0, one document). */
function contextLines(out: HookOutcome): string[] {
  expect(out.exitCode, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  const doc = oneJson({ code: 0, stdout: out.stdout, stderr: '' }) as {
    hookSpecificOutput?: { additionalContext?: unknown };
  };
  return String(doc.hookSpecificOutput?.additionalContext ?? '')
    .replace(/\n$/, '')
    .split('\n');
}

/**
 * A clock for one hook run: it stands at `start` until its `jumpAt`th
 * reading, from which on it reads one millisecond past the deadline
 * (`start + budget`); `advance` moves it on between readings, as a slow
 * read would. `sawPast` records that some reading returned a time past
 * the deadline, `calls` how many readings there were.
 */
interface TestClock {
  readonly now: () => number;
  readonly deadline: number;
  readonly startedAt: number;
  readonly budgetMs: number;
  t: number;
  calls: number;
  sawPast: boolean;
  advance(ms: number): void;
}

function testClock(budgetMs: number, jumpAt = Number.POSITIVE_INFINITY): TestClock {
  const startedAt = Date.now();
  const clock: TestClock = {
    deadline: startedAt + budgetMs,
    startedAt,
    budgetMs,
    t: startedAt,
    calls: 0,
    sawPast: false,
    now: () => {
      clock.calls += 1;
      if (clock.calls >= jumpAt && clock.t <= clock.deadline) {
        clock.t = clock.deadline + 1;
      }
      if (clock.t > clock.deadline) {
        clock.sawPast = true;
      }
      return clock.t;
    },
    advance: (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

/** Runs a hook in `root` on `clock`, the warning state in this test's directory. */
function hookOn(
  clock: TestClock,
  argv: readonly string[],
  root: string,
  payload: string,
  extra: Partial<HookRequest> = {},
): HookOutcome {
  return runHook({
    argv,
    cwd: root,
    payload,
    env: hookEnv(),
    stateDir,
    now: clock.now,
    startedAt: clock.startedAt,
    budgetMs: clock.budgetMs,
    ...extra,
  });
}

/** Asserts the answer of a run out of time: exit 0, stdout empty, stderr empty or the out-of-time line. */
function expectOutOfTime(out: HookOutcome, label: string): void {
  expect(out.exitCode, label).toBe(0);
  expect(out.stdout, label).toBe('');
  expect(out.stderr === '' || OUT_OF_TIME.test(out.stderr), `${label}: ${out.stderr}`).toBe(true);
}

/**
 * Counts the event files opened while `clock` reads past its deadline
 * (`sawPast`): the hook must open none after it has seen the deadline go.
 * With `stepMs`, each event-file read also moves the clock on by that
 * much, as a slow disk would. Returns the counters.
 */
function observeReads(
  clock: TestClock,
  stepMs = 0,
): { reads: number; afterPast: number; afterDeadline: number } {
  const counts = { reads: 0, afterPast: 0, afterDeadline: 0 };
  watch.onRead = (path) => {
    if (!EVENT_FILE.test(path)) {
      return;
    }
    counts.reads += 1;
    if (clock.sawPast) {
      counts.afterPast += 1;
    }
    if (clock.t > clock.deadline) {
      counts.afterDeadline += 1;
    }
    clock.advance(stepMs);
  };
  return counts;
}

function startPayload(cwd: string): string {
  return JSON.stringify({ session_id: 's-1', cwd, hook_event_name: 'SessionStart' });
}

function stopPayload(cwd: string): string {
  return JSON.stringify({
    session_id: 's-1',
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

function editPayload(cwd: string): string {
  return JSON.stringify({
    session_id: 's-1',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: join(cwd, 'src', 'a.ts'), content: 'x' },
  });
}

/** One event and mode, on a board where it has something to say. */
interface Case {
  readonly label: string;
  readonly argv: readonly string[];
  readonly payload: (root: string) => string;
  /** True when the answer on a fresh board writes (so each run gets its own board). */
  readonly writes: boolean;
  /** What the answer is when the budget is not spent (a sanity check on the board). */
  readonly expectAnswer: (out: HookOutcome) => void;
}

const CASES: readonly Case[] = [
  {
    label: 'session-start with pending entries',
    argv: ['session-start', '--as', 'impl'],
    payload: startPayload,
    writes: true,
    expectAnswer: (out) => {
      expect(contextLines(out).length).toBe(3);
    },
  },
  {
    label: 'stop --strict for a holder with no comment',
    argv: ['stop', '--strict', '--as', 'impl'],
    payload: stopPayload,
    writes: false,
    expectAnswer: (out) => {
      expect(out.exitCode).toBe(2);
    },
  },
  {
    label: 'stop for a holder with no comment',
    argv: ['stop', '--as', 'impl'],
    payload: stopPayload,
    writes: false,
    expectAnswer: (out) => {
      expect(out.stdout).toContain('systemMessage');
    },
  },
  {
    label: 'pre-tool-use --strict for an actor holding nothing',
    argv: ['pre-tool-use', '--strict', '--as', 'nobody'],
    payload: editPayload,
    writes: false,
    expectAnswer: (out) => {
      expect(out.exitCode).toBe(2);
    },
  },
  {
    label: 'pre-tool-use for an actor holding nothing',
    argv: ['pre-tool-use', '--as', 'nobody'],
    payload: editPayload,
    writes: true,
    expectAnswer: (out) => {
      expect(out.stdout).toContain('additionalContext');
    },
  },
];

describe('R1: once a reading of the clock is past the deadline, the answer is out of time', () => {
  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s: at every reading of the clock in turn',
    (_label, c) => {
      const base = claimedBoard();
      const clean = testClock(60_000);
      const answer = hookOn(clean, c.argv, base.root, c.payload(base.root));
      c.expectAnswer(answer);
      const readings = clean.calls;
      expect(readings).toBeGreaterThan(0);
      for (let jumpAt = 1; jumpAt <= readings; jumpAt += 1) {
        const board = c.writes ? claimedBoard() : base;
        if (c.writes) {
          stateDir = tempDir();
        }
        const before = peekLines(board.root, 'impl');
        const clock = testClock(60_000, jumpAt);
        const counts = observeReads(clock);
        const out = hookOn(clock, c.argv, board.root, c.payload(board.root));
        watch.onRead = null;
        const label = `${c.label}, past the deadline from reading ${String(jumpAt)} of ${String(readings)}`;
        expect(clock.sawPast, label).toBe(true);
        expectOutOfTime(out, label);
        expect(counts.afterPast, `${label}: event files opened after the deadline`).toBe(0);
        // Nothing delivered, nothing written: the cursor has not moved.
        expect(peekLines(board.root, 'impl'), label).toEqual(before);
      }
    },
    120_000,
  );

  it('the deadline is checked after the cache read: strict pre-tool-use past it does not block', () => {
    const { root } = claimedBoard();
    // A budget already spent when the run starts: every reading is past it.
    const clock = testClock(0);
    clock.advance(1);
    const out = hookOn(
      clock,
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      root,
      editPayload(root),
    );
    expectOutOfTime(out, 'strict pre-tool-use with the budget spent');
  });
});

describe('R1: the deadline is checked between event-file reads', () => {
  /** A board where impl holds 30 tickets with no comment, among 300 comments by orch. */
  function busyBoard(): { root: string } {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const wall = Date.now() - 60_000;
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = `01ARYZ6S41TSV4RRFFQ69G${alphabet[Math.floor(i / 32)] ?? '0'}${alphabet[i % 32] ?? '0'}AV`;
      ids.push(id);
      putEvent(events, ev(P.create(id, `T${String(i)}`), 'orch', wall, i));
      putEvent(events, ev(P.claim(id), 'impl', wall + 1000, i));
    }
    for (let i = 0; i < 300; i += 1) {
      putEvent(
        events,
        ev(P.comment(ids[i % ids.length] ?? '', `orch note ${String(i)}`), 'orch', wall + 2000, i),
      );
    }
    cli(['list'], root);
    return { root };
  }

  it.each([
    ['stop --strict', ['stop', '--strict', '--as', 'impl'], stopPayload],
    ['stop', ['stop', '--as', 'impl'], stopPayload],
    ['session-start for an actor with no cursor', ['session-start', '--as', 'fresh'], startPayload],
  ] as const)(
    '%s: no event file is opened once slow reads have spent the budget',
    (label, argv, payload) => {
      const { root } = busyBoard();
      const before = peekLines(root, 'fresh');
      // Each event-file read takes 10 ms of a 100 ms budget.
      const clock = testClock(100);
      const counts = observeReads(clock, 10);
      const out = hookOn(clock, argv, root, payload(root));
      watch.onRead = null;
      expect(counts.afterDeadline, `${label}: event files opened after the deadline`).toBe(0);
      if (clock.t > clock.deadline) {
        expectOutOfTime(out, label);
      }
      expect(peekLines(root, 'fresh')).toEqual(before);
    },
    120_000,
  );
});

describe('R1: session-start reads only what it can deliver, outside the write lock', () => {
  /** A probe connection that tells whether another connection holds the cache write lock. */
  function lockProbe(boardDir: string): { locked: () => boolean; close: () => void } {
    const db = new DatabaseSync(join(boardDir, 'cache.sqlite'));
    db.exec('PRAGMA busy_timeout = 0');
    return {
      locked: () => {
        try {
          db.exec('BEGIN IMMEDIATE');
          db.exec('ROLLBACK');
          return false;
        } catch {
          return true;
        }
      },
      close: () => {
        db.close();
      },
    };
  }

  it('reads at most one event file more than it delivers, and takes the omitted count from the cache', () => {
    const { root } = claimedBoard(200);
    const expected = peekLines(root, 'fresh');
    expect(expected.length).toBeGreaterThan(200);
    const clock = testClock(60_000);
    const counts = observeReads(clock);
    const got = contextLines(
      hookOn(clock, ['session-start', '--as', 'fresh'], root, startPayload(root)),
    );
    watch.onRead = null;
    const delivered = got.length - 2;
    expect(delivered).toBeGreaterThan(0);
    expect(got.slice(1, -1)).toEqual(expected.slice(0, delivered));
    expect(got.at(-1) ?? '').toMatch(new RegExp(`\\b${String(expected.length - delivered)}\\b`));
    expect(counts.reads).toBeLessThanOrEqual(delivered + 1);
    expect(peekLines(root, 'fresh')).toEqual(expected.slice(delivered));
  });

  it('never holds the cache write lock while it reads an event file', () => {
    const { root, boardDir } = claimedBoard(30);
    const probe = lockProbe(boardDir);
    let lockedReads = 0;
    let reads = 0;
    try {
      watch.onRead = (path) => {
        if (EVENT_FILE.test(path)) {
          reads += 1;
          if (probe.locked()) {
            lockedReads += 1;
          }
        }
      };
      contextLines(
        hookOn(testClock(60_000), ['session-start', '--as', 'impl'], root, startPayload(root)),
      );
    } finally {
      watch.onRead = null;
      probe.close();
    }
    expect(reads).toBeGreaterThan(0);
    expect(lockedReads).toBe(0);
    expect(peekLines(root, 'impl')).toEqual([]);
  });

  it('scenario: entries delivered meanwhile: when another inbox moves the cursor during the reads, it delivers none', () => {
    const { root, boardDir } = claimedBoard(3);
    const probe = lockProbe(boardDir);
    let inbox: Run | null = null;
    let lockedAtRead = false;
    try {
      watch.onRead = (path) => {
        if (!EVENT_FILE.test(path) || inbox !== null || lockedAtRead) {
          return;
        }
        if (probe.locked()) {
          lockedAtRead = true;
          return;
        }
        const reader = watch.onRead;
        watch.onRead = null;
        inbox = run(['inbox', '--as', 'impl'], root, cliEnv());
        watch.onRead = reader;
      };
      const got = contextLines(
        hookOn(testClock(60_000), ['session-start', '--as', 'impl'], root, startPayload(root)),
      );
      watch.onRead = null;
      expect(lockedAtRead, 'the write lock was held during an event-file read').toBe(false);
      expect(inbox).not.toBeNull();
      const done = inbox as unknown as Run;
      expect(done.code, done.stderr).toBe(0);
      expect(done.stdout.split('\n').filter((l) => l !== '')).toHaveLength(3);
      // The hook's context is the held-ticket line alone.
      expect(got).toHaveLength(1);
      expect(got[0]).toContain('impl');
    } finally {
      watch.onRead = null;
      probe.close();
    }
    expect(peekLines(root, 'impl')).toEqual([]);
  });

  it('a write lock held by another connection: one bounded attempt, out of time within the budget, nothing written', () => {
    const { root, boardDir } = claimedBoard(2);
    const before = peekLines(root, 'impl');
    expect(before).toHaveLength(2);
    const holder = new DatabaseSync(join(boardDir, 'cache.sqlite'));
    holder.exec('BEGIN IMMEDIATE');
    let out: HookOutcome;
    let ms: number;
    try {
      const started = performance.now();
      out = runHook({
        argv: ['session-start', '--as', 'impl'],
        cwd: root,
        payload: startPayload(root),
        env: hookEnv(),
        stateDir,
        budgetMs: 500,
      });
      ms = performance.now() - started;
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('');
    expect(
      out.stderr === '' || OUT_OF_TIME.test(out.stderr) || UNREADABLE.test(out.stderr),
      out.stderr,
    ).toBe(true);
    expect(ms).toBeLessThan(500 + 700);
    expect(peekLines(root, 'impl')).toEqual(before);
  });
});

/** An input yielding `chunks`, then ending (or, with `hang`, never ending). */
function chunkedInput(chunks: readonly (string | Uint8Array)[], hang = false): HookInput {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
      if (hang) {
        await new Promise<never>(() => undefined);
      }
    },
  };
}

/** `bytes` bytes of a JSON payload padded with spaces, in chunks of 64 KiB. */
function paddedPayload(bytes: number): Uint8Array[] {
  const head = '{"hook_event_name":"Stop","stop_hook_active":false}';
  const all = new TextEncoder().encode(head + ' '.repeat(bytes - head.length));
  expect(all.length).toBe(bytes);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += 65_536) {
    chunks.push(all.subarray(i, i + 65_536));
  }
  return chunks;
}

describe('R8: the payload read is capped at HOOK_STDIN_LIMIT bytes', () => {
  it('pins the limit: 1 MiB', () => {
    expect(HOOK_STDIN_LIMIT).toBe(1_048_576);
  });

  it('a payload of exactly the limit is read whole', async () => {
    const text = await readHookStdin(chunkedInput(paddedPayload(HOOK_STDIN_LIMIT)), 10_000);
    expect(new TextEncoder().encode(text).length).toBe(HOOK_STDIN_LIMIT);
    expect(JSON.parse(text)).toEqual({ hook_event_name: 'Stop', stop_hook_active: false });
  });

  it('one byte over the limit is an unreadable payload', async () => {
    expect(await readHookStdin(chunkedInput(paddedPayload(HOOK_STDIN_LIMIT + 1)), 10_000)).toBe('');
  });

  it('the limit counts UTF-8 bytes of string chunks too', async () => {
    const half = '\u00e9'.repeat(HOOK_STDIN_LIMIT / 4);
    // Two chunks of HOOK_STDIN_LIMIT / 2 bytes each, then one more byte.
    expect(await readHookStdin(chunkedInput([half, half, ' ']), 10_000)).toBe('');
    expect(await readHookStdin(chunkedInput([half, half]), 10_000)).toBe(half + half);
  });

  it('stops reading once over the limit, without waiting for the end of the input or the timeout', async () => {
    const started = performance.now();
    const text = await readHookStdin(
      chunkedInput(paddedPayload(HOOK_STDIN_LIMIT + 65_536), true),
      3000,
    );
    expect(text).toBe('');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
