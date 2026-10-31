/**
 * `agentboard hook <event> [--strict]`: the harness hook command
 * (add-harness-integration; board-harness-hooks "Hook command and
 * protocol", "Hook actor resolution"; board-cli "Exit codes", "Due grants
 * are written during catch-up"; design.md decisions 1, 3 and 11).
 *
 * A coding harness (Claude Code) runs the command on an event, with a
 * JSON payload on stdin, and reads the answer from the exit code, stdout
 * and stderr: exit 0 continues (stdout, when not empty, is one JSON
 * document for the harness), exit 2 blocks (stderr is the reason, fed
 * back to the agent). The command is a guest in the agent's loop, so it
 * fails open: whatever goes wrong (no board, an unreadable, missing,
 * locked or older cache, no actor, a payload of any shape, an argument
 * error, an internal error, the 2 second budget running out) ends in exit
 * 0, never blocking, with at most one line on stderr that repeats no
 * input. Only `--strict` can block, and only for the reasons the event
 * requirements name.
 *
 * Read-only. The command writes no event, never runs `sync` and never
 * touches the network. It reads the cache as it is: it never catches up
 * (folds no event file, writes no due grant, reaps no temporary file) and
 * never creates, recreates, migrates or rebuilds the cache, so a missing
 * cache or one of another schema version counts as unreadable (opening it
 * the ordinary way would recreate it). The only state it may write is the
 * inbox cursor of the actor in `session-start` (board-harness-hooks
 * "Session start hook"). It never claims, renews, releases, queues or
 * unqueues.
 *
 * The event behaviour itself (what each event prints) is specified by
 * board-harness-hooks "Session start hook", "Stop hook" and "Pre-tool-use
 * claim check"; this module owns the protocol around it: arguments,
 * payload, actor, board discovery, the read-only view of the board, the
 * budget and the escape hatch.
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { BoardState, Ticket } from '../events/fold.js';
import { CACHE_FILE, openCache, readState } from '../store/cache.js';
import { boardExists, locateBoard } from '../store/locate.js';
import { secretPatternsIn } from './secrets.js';
import type { Env } from './text.js';

/** The events, in the order help and the argument-error line name them. */
export const HOOK_EVENTS = ['session-start', 'stop', 'pre-tool-use'] as const;

/** One hook event. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The internal time budget of one hook run, in milliseconds (design.md
 * decision 3; the settings `timeout` the `claude-hooks` target writes is 5
 * seconds). For the executable it runs from the start of the process
 * (`performance.timeOrigin`), not from the start of `runHookProcess`, so
 * Node's own start-up and module loading count against it and a loaded
 * machine still gets its answer within about the budget.
 */
export const HOOK_BUDGET_MS = 2000;

/**
 * The escape hatch: when this environment variable is exactly `off`,
 * every hook run exits 0 at once with no output on stdout or stderr,
 * before reading stdin, parsing its arguments or looking for a board.
 * Any other value (`on`, `0`, `OFF`, empty) leaves the hooks on.
 */
export const HOOKS_ENV = 'AGENTBOARD_HOOKS';

/** A parsed hook payload: always a plain object. */
export type HookPayload = Readonly<Record<string, unknown>>;

/**
 * Parses the harness payload. An empty text, text that is not JSON, and
 * JSON whose top level is not an object (an array, `null`, a string, a
 * number, a boolean) all give `{}`. Never throws. Pure.
 */
export function parseHookPayload(text: string): HookPayload {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as HookPayload;
    }
  } catch {
    // Not JSON: the payload is treated as empty.
  }
  return {};
}

/** The reserved system actor (board-events "Reserved system actor"). */
const RESERVED_ACTOR = 'agentboard';

/**
 * The actor form of the change `actor-secret-check`: a letter or digit,
 * then up to 31 of letters, digits, `.`, `_`, `@` and `-`.
 */
const ACTOR_FORM = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$/;

/**
 * The actor of a hook run (board-harness-hooks "Hook actor resolution"):
 * `given` (the `--as` value) when it is a non-empty string, else
 * `AGENTBOARD_ACTOR` from `env` when non-empty, else null. Never the OS
 * user (`USER`, `LOGNAME`, `USERNAME`) and never anything from the
 * payload.
 *
 * A resolved name that could not be used by a writing command is treated
 * as no actor (null) rather than refused, since a hook never fails:
 * the reserved actor `agentboard` (board-events "Reserved system actor"),
 * a name in which `secretPatternsIn` finds a secret pattern, and a name
 * outside the actor form `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$` (the form
 * the pending change `actor-secret-check` makes the rule for every
 * command). Such a name is therefore never repeated in hook output. Pure.
 */
export function resolveHookActor(given: string | undefined, env: Env): string | null {
  const fromEnv = env.AGENTBOARD_ACTOR;
  const name = given !== undefined && given !== '' ? given : fromEnv;
  if (name === undefined || name === '') {
    return null;
  }
  if (name === RESERVED_ACTOR || !ACTOR_FORM.test(name) || secretPatternsIn(name).length > 0) {
    return null;
  }
  return name;
}

/** What a hook reads of the board: a snapshot, with no connection left open. */
export interface HookView {
  /** Absolute path of the board directory found by discovery. */
  readonly boardDir: string;
  /** The folded state exactly as the cache holds it (`readState`), not caught up. */
  readonly state: BoardState;
}

/** Options of `readHookView`. */
export interface HookViewOptions {
  /**
   * Directory discovery starts from: the payload's `cwd` when it is a
   * non-empty string naming an existing directory (resolved against the
   * process directory when relative), else the process directory. The
   * usual discovery rules apply (`locateBoard`: `AGENTBOARD_DIR`, then the
   * git common directory, so a linked worktree finds the main checkout's
   * board, then `./.board`).
   */
  readonly cwd: string;
  /** Environment for discovery (`AGENTBOARD_DIR`) and its git child. */
  readonly env: Env;
  /**
   * The time, on the `now` clock, by which the read must be over; a read
   * that would wait past it (a locked cache) gives up and returns null.
   */
  readonly deadline: number;
  /** The clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Discovery for a hook: the board directory `locateBoard` resolves from
 * `cwd`, when a board exists there (`boardExists`), else null. Creates
 * nothing and never throws.
 */
function discoverBoard(cwd: string, env: Env): string | null {
  try {
    const { dir } = locateBoard({ cwd, env });
    return boardExists(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * The cache of `boardDir` read as it is: opened for inspection only
 * (`openCache` with `prepare: false`, which never creates the file, never
 * switches the journal mode, never creates, migrates or drops a table and
 * writes no row, and refuses a missing file, a file that is not SQLite
 * and a cache of another schema version), with the time left until
 * `deadline` as its busy timeout, so a cache another process holds locked
 * makes it give up by the deadline rather than after the usual busy
 * timeout; then `readState` in one snapshot and the connection closed.
 * Null when the cache cannot be read; never throws.
 */
function readCacheState(boardDir: string, deadline: number, now: () => number): BoardState | null {
  const left = Math.max(0, deadline - now());
  let db: ReturnType<typeof openCache> | null = null;
  try {
    db = openCache(join(boardDir, CACHE_FILE), { prepare: false, busyTimeoutMs: left });
    return readState(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Reads the board for a hook, read-only: discovery from `options.cwd`,
 * then the cache opened for inspection only (as `rebuild --check` opens
 * it: never created, migrated or written, no catch-up, no reaping, no
 * grant), the state read in one snapshot, the connection closed.
 *
 * Returns null, writing nothing and creating no file in the board
 * directory, when there is no board, when the cache file is missing,
 * is not a cache of the current schema version (an earlier or later
 * agentboard's) or cannot be read, and when the cache stays locked
 * until `options.deadline`. Never throws.
 */
export function readHookView(options: HookViewOptions): HookView | null {
  const boardDir = discoverBoard(options.cwd, options.env);
  if (boardDir === null) {
    return null;
  }
  const state = readCacheState(boardDir, options.deadline, options.now ?? Date.now);
  return state === null ? null : { boardDir, state };
}

/**
 * The tickets `actor` holds (board-harness-hooks "Hook actor resolution";
 * design.md decision 11): every ticket of `state` that is not closed and
 * whose `assignee` is `actor`, whatever the state of its lease (live,
 * expired or claimable: a lapsed lease is held until another actor takes
 * it over), in ticket id order. Being queued for a ticket (a waiter in
 * its `queue`) is not holding it, and a grant that is due but not yet
 * written (so not in `state`) makes no one the holder. Pure.
 */
export function heldTickets(state: BoardState, actor: string): Ticket[] {
  return Object.values(state.tickets)
    .filter((ticket) => !ticket.closed && ticket.assignee === actor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One hook run, with the payload already read. */
export interface HookRequest {
  /** The arguments after `hook`: `<event> [--strict] [--as <actor>] [--json]`. */
  readonly argv: readonly string[];
  /** The raw payload text from stdin (`parseHookPayload` reads it). */
  readonly payload: string;
  /** The process directory (discovery uses the payload's `cwd` first). */
  readonly cwd: string;
  readonly env: Env;
  /** The clock for the budget and for lease states; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * When the run started, on the `now` clock; defaults to `now()` at the
   * call. The deadline is `startedAt + budgetMs`.
   */
  readonly startedAt?: number;
  /** The budget of this run in milliseconds; defaults to `HOOK_BUDGET_MS`. */
  readonly budgetMs?: number;
}

/** The answer of one hook run. */
export interface HookOutcome {
  /** 0 continues; 2 blocks, only ever with `--strict`. */
  readonly exitCode: 0 | 2;
  /** Empty, or exactly one JSON document followed by a newline. */
  readonly stdout: string;
  /** Empty, or exactly one line ending with a newline. */
  readonly stderr: string;
}

/** Exit 0 with nothing on either stream: the answer of most failures. */
const SILENT: HookOutcome = { exitCode: 0, stdout: '', stderr: '' };

/** Exit 0 with nothing on stdout and `line` on stderr. */
function continueWith(line: string): HookOutcome {
  return { exitCode: 0, stdout: '', stderr: `${line}\n` };
}

/** The stderr lines of the protocol; none repeats any input. */
const LINES = {
  arguments: `agentboard hook: expected one event, ${HOOK_EVENTS.join(', ')}, with --strict, --as <actor> and --json as its only flags; continuing without checking the board`,
  unreadable:
    'agentboard hook: the board cache is missing, locked, unreadable or of another version; continuing without checking the board',
  budget: 'agentboard hook: out of time; continuing without checking the board',
  internal: 'agentboard hook: internal error; continuing without checking the board',
  noActor:
    'agentboard: no actor is set, so the board hooks do nothing; set AGENTBOARD_ACTOR or add --as <actor> to the hook commands',
} as const;

/** The arguments of one hook run, parsed. */
interface HookArgs {
  readonly event: HookEvent;
  readonly strict: boolean;
  /** The `--as` value when given. */
  readonly as: string | undefined;
}

function isHookEvent(text: string): text is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(text);
}

/**
 * Parses `argv`: exactly one event, then any of `--strict`, `--as
 * <actor>` and `--json`, in any order. Null for anything else (no event,
 * an unknown event, a second positional, an unknown flag, a `--as` with
 * no value).
 */
function parseHookArgs(argv: readonly string[]): HookArgs | null {
  let event: HookEvent | undefined;
  let strict = false;
  let as: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--json') {
      // Accepted and ignored: the answer is always the hook protocol.
    } else if (arg === '--as') {
      i += 1;
      const value = argv[i];
      if (value === undefined) {
        return null;
      }
      as = value;
    } else if (arg.startsWith('--') || event !== undefined || !isHookEvent(arg)) {
      return null;
    } else {
      event = arg;
    }
  }
  return event === undefined ? null : { event, strict, as };
}

/**
 * The directory discovery starts from: the payload's `cwd` when it is a
 * non-empty string naming an existing directory (relative to `cwd`),
 * else `cwd` itself.
 */
function discoveryCwd(payload: HookPayload, cwd: string): string {
  const given = payload.cwd;
  if (typeof given !== 'string' || given === '') {
    return cwd;
  }
  try {
    const dir = resolve(cwd, given);
    return statSync(dir).isDirectory() ? dir : cwd;
  } catch {
    return cwd;
  }
}

/** One JSON document on stdout, as the hook protocol wants it. */
function document(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** The `SessionStart` context document carrying `text`. */
function sessionStartContext(text: string): HookOutcome {
  return {
    exitCode: 0,
    stdout: document({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }),
    stderr: '',
  };
}

/**
 * The answer of `event` for `actor` on a readable board. The events do
 * not answer yet: every event continues silently once the board is
 * readable. What each prints (board-harness-hooks "Session start hook",
 * "Stop hook", "Pre-tool-use claim check") is task group 2 of
 * add-harness-integration (`hooks/events`), which replaces this body.
 */
function answerEvent(
  event: HookEvent,
  strict: boolean,
  actor: string,
  payload: HookPayload,
  view: HookView,
  now: () => number,
): HookOutcome {
  void event;
  void strict;
  void actor;
  void payload;
  void view;
  void now;
  return SILENT;
}

/**
 * Runs one hook (the core of `agentboard hook`, with the payload already
 * read). Never throws and never writes events.
 *
 * 1. When `HOOKS_ENV` is `off`: exit 0, stdout and stderr empty.
 * 2. Arguments: exactly one event of `HOOK_EVENTS`, then any of
 *    `--strict`, `--as <actor>` and `--json` (accepted and ignored: the
 *    answer is always the hook protocol). Anything else (no event, an
 *    unknown event, an unknown flag, a missing `--as` value, an extra
 *    positional) is exit 0, stdout empty, and one stderr line naming
 *    `session-start`, `stop` and `pre-tool-use` that repeats no part of
 *    the arguments or the payload (board-cli "Refusals never repeat the
 *    refused input").
 * 3. The payload is parsed with `parseHookPayload`.
 * 4. The actor is `resolveHookActor(--as, env)`. With no actor, `stop`
 *    and `pre-tool-use` answer exit 0 with stdout and stderr empty, and
 *    `session-start` answers exit 0 with stderr empty and, when discovery
 *    (as in step 5) finds a board (`boardExists`; its cache is not
 *    needed), stdout exactly one JSON document,
 *    `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}`
 *    and a newline, whose text is one line naming `AGENTBOARD_ACTOR` and
 *    `--as` (and no actor value); where there is no board, stdout is
 *    empty. The cache is not read.
 * 5. The board is read with `readHookView` (discovery from the payload's
 *    `cwd`, see `HookViewOptions.cwd`), with the deadline
 *    `startedAt + budgetMs`. A null view is exit 0 with stdout empty and
 *    at most one stderr line.
 * 6. The event answers as its requirement says (board-harness-hooks
 *    "Session start hook", "Stop hook", "Pre-tool-use claim check"),
 *    holding computed with `heldTickets`.
 *
 * Any error thrown inside, and running past the deadline, is exit 0
 * with stdout empty and at most one stderr line. The answer is given by
 * the deadline plus the time of one bounded step, so well within 3
 * seconds of `startedAt` for the default budget.
 */
export function runHook(request: HookRequest): HookOutcome {
  try {
    if (request.env[HOOKS_ENV] === 'off') {
      return SILENT;
    }
    const args = parseHookArgs(request.argv);
    if (args === null) {
      return continueWith(LINES.arguments);
    }
    const now = request.now ?? Date.now;
    const deadline = (request.startedAt ?? now()) + (request.budgetMs ?? HOOK_BUDGET_MS);
    const payload = parseHookPayload(request.payload);
    const cwd = discoveryCwd(payload, request.cwd);
    const actor = resolveHookActor(args.as, request.env);
    const boardDir = discoverBoard(cwd, request.env);
    if (boardDir === null) {
      // No board: silent, whether or not there is an actor.
      return SILENT;
    }
    if (actor === null) {
      return args.event === 'session-start' ? sessionStartContext(LINES.noActor) : SILENT;
    }
    const state = readCacheState(boardDir, deadline, now);
    if (state === null) {
      return continueWith(LINES.unreadable);
    }
    if (now() > deadline) {
      return continueWith(LINES.budget);
    }
    return answerEvent(args.event, args.strict, actor, payload, { boardDir, state }, now);
  } catch {
    return continueWith(LINES.internal);
  }
}

/** Where the payload is read from: `process.stdin` for the executable. */
export type HookInput = AsyncIterable<string | Uint8Array> & { readonly isTTY?: boolean };

/**
 * Reads the whole payload from `input` as UTF-8, resolving at end of
 * input. Resolves `''` at once when `input.isTTY` is true (a person ran
 * the command in a terminal), and resolves `''` when the input has not
 * ended within `timeoutMs`, or fails. Never rejects, and never keeps the
 * process alive after it has resolved.
 */
export function readHookStdin(input: HookInput, timeoutMs: number): Promise<string> {
  if (input.isTTY === true) {
    return Promise.resolve('');
  }
  return new Promise((resolvePayload) => {
    let settled = false;
    let text = '';
    const decoder = new TextDecoder('utf-8');
    const iterator = input[Symbol.asyncIterator]();
    const settle = (value: string): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePayload(value);
      }
    };
    // At the deadline the payload is given up and the input let go, so an
    // input that never ends does not keep the process alive: a stream is
    // destroyed (its iterator's `return` would only be queued behind the
    // pending `next`), any other input is asked to return.
    const timer = setTimeout(() => {
      settle('');
      try {
        if ('destroy' in input && typeof input.destroy === 'function') {
          input.destroy();
        } else {
          iterator.return?.()?.catch(() => undefined);
        }
      } catch {
        // The input refused to be released; nothing more can be done.
      }
    }, Math.max(0, timeoutMs));
    void (async (): Promise<void> => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (settled) {
            return;
          }
          if (next.done === true) {
            settle(text + decoder.decode());
            return;
          }
          const chunk = next.value;
          text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        }
      } catch {
        settle('');
      }
    })();
  });
}

/**
 * True when the executable should hand `argv` (the arguments after the
 * program name) to `runHookProcess` rather than to the ordinary CLI:
 * `argv[0]` is `hook` and no `--help` or `-h` appears before a lone `--`
 * (`agentboard hook --help` prints the command's help like every other
 * command). Pure.
 */
export function isHookInvocation(argv: readonly string[]): boolean {
  if (argv[0] !== 'hook') {
    return false;
  }
  for (const arg of argv.slice(1)) {
    if (arg === '--') {
      return true;
    }
    if (arg === '--help' || arg === '-h') {
      return false;
    }
  }
  return true;
}

/** The process surroundings of `runHookProcess`. */
export interface HookProcessIo {
  /** The arguments after `hook`. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Env;
  readonly stdin: HookInput;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * `agentboard hook` for the executable (`src/cli.ts` calls it, instead of
 * the ordinary CLI, when `isHookInvocation` holds): when `HOOKS_ENV` is
 * `off`, resolves 0 at once without reading stdin; otherwise reads the
 * payload with `readHookStdin` until the deadline, the process start
 * (`performance.timeOrigin`) plus `HOOK_BUDGET_MS`, runs `runHook` with
 * `startedAt` the process start, writes its stdout and stderr, stops
 * reading stdin (so an input that never ends does not keep the process
 * alive), and resolves its exit code. The process therefore exits within
 * about `HOOK_BUDGET_MS` of its start, Node's start-up included. Never rejects; never resolves any code but 0 or
 * 2 (board-cli "Exit codes": the codes 1, 3, 4 and 5 and the board-error
 * 2 are never reported).
 */
export async function runHookProcess(io: HookProcessIo): Promise<0 | 2> {
  try {
    if (io.env[HOOKS_ENV] === 'off') {
      return 0;
    }
    const startedAt = performance.timeOrigin;
    const deadline = startedAt + HOOK_BUDGET_MS;
    const payload = await readHookStdin(io.stdin, deadline - Date.now());
    const outcome = runHook({ argv: io.argv, payload, cwd: io.cwd, env: io.env, startedAt });
    if (outcome.stdout !== '') {
      io.stdout(outcome.stdout);
    }
    if (outcome.stderr !== '') {
      io.stderr(outcome.stderr);
    }
    return outcome.exitCode;
  } catch {
    return 0;
  }
}
