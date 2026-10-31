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
 * the ordinary way would recreate it). The only board state it may write
 * is the inbox cursor of the actor in `session-start` (board-harness-hooks
 * "Session start hook"); outside the board, `pre-tool-use` in warn mode
 * writes its rate-limit file in the OS temporary directory
 * (`warnStatePath`). It never claims, renews, releases, queues or
 * unqueues.
 *
 * The event behaviour itself (what each event prints) is specified by
 * board-harness-hooks "Session start hook", "Stop hook" and "Pre-tool-use
 * claim check"; this module owns the protocol around it: arguments,
 * payload, actor, board discovery, the read-only view of the board, the
 * budget and the escape hatch.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { compareFoldOrder, type BoardState, type Ticket } from '../events/fold.js';
import { isKnownEvent, SYSTEM_ACTOR } from '../events/schema.js';
import { CACHE_FILE, openCache, readState } from '../store/cache.js';
import {
  advanceCursor,
  comparePositions,
  readCursor,
  writeCursor,
  type CursorPosition,
} from '../store/cursors.js';
import { inImmediate, inSnapshot } from '../store/engine.js';
import { readEventFile, readEventLog } from '../store/eventfile.js';
import { recordedPositions } from '../store/folded.js';
import { boardExists, locateBoard } from '../store/locate.js';
import { assigneeToken } from './leases.js';
import { renderInboxLine } from './inbox.js';
import { pendingPositions, toEntries } from './pending.js';
import { isActorName } from './secrets.js';
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

/**
 * The most characters the `session-start` context (the
 * `additionalContext` text) may hold (board-harness-hooks "Session start
 * hook"). A longer answer is cut at an inbox entry boundary: the entries
 * that fit are kept from the start, in fold order, and a last line says
 * how many entries were left out and names `agentboard inbox --as
 * <actor>`; the inbox cursor advances over the delivered entries only, so
 * the next `inbox` lists exactly the ones left out. The held-ticket line
 * is cut at a ticket boundary to at most `HELD_LINE_LIMIT` characters,
 * ending with `and <n> more`.
 */
export const SESSION_CONTEXT_LIMIT = 4000;

/** The most characters of the `session-start` held-ticket line (see `SESSION_CONTEXT_LIMIT`). */
export const HELD_LINE_LIMIT = 2000;

/**
 * The most characters of the `stop` text (board-harness-hooks "Stop
 * hook"), the `systemMessage` in warn mode and the stderr text (without
 * its final newline) in strict mode. The tickets to name are written in
 * id order, each with its commands (`release` first for a ticket with a
 * lease), as many as fit, cut at a ticket boundary; when any are left out
 * the text ends with a line `and <n> more`, `<n>` the number left out,
 * and the text including that line is still at most this long. A ticket
 * left out is named nowhere in the text.
 */
export const STOP_TEXT_LIMIT = 2000;

/**
 * The most bytes of payload the hook reads from stdin (board-harness-hooks
 * "Hook command and protocol"). A payload of exactly this many bytes is
 * read and parsed; a longer one is not read past the limit (the input is
 * let go at once, without waiting for its end) and is treated as an
 * unreadable payload, `{}`: `pre-tool-use` then passes silently and strict
 * `stop` answers as warn mode.
 */
export const HOOK_STDIN_LIMIT = 1_048_576;

/**
 * The tools whose calls `pre-tool-use` checks (board-harness-hooks
 * "Pre-tool-use claim check"), matched exactly, case included. The target
 * is `tool_input.file_path`, or for `NotebookEdit` `tool_input.notebook_path`
 * (then `file_path`); a relative target is resolved against the directory
 * discovery started from. Any other tool, and a target that is missing,
 * empty or not a string, is passed silently.
 */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * The warn-mode rate limit of `pre-tool-use`: a session is warned at most
 * once per this many milliseconds (board-harness-hooks "Pre-tool-use claim
 * check"). Strict mode is not rate limited: it denies every unclaimed edit.
 */
export const WARN_INTERVAL_MS = 600_000;

/**
 * The file that records when the session `sessionId` was last warned by
 * `pre-tool-use` in warn mode: `<stateDir>/agentboard-hook-<h>`, where
 * `<h>` is the lowercase hex SHA-256 of `sessionId` (UTF-8), so the file
 * name never repeats the session id and any id is a safe name. Pure.
 *
 * The file holds the time of the last warning printed, in milliseconds
 * on the hook's clock, as decimal digits. A warning is suppressed when the
 * recorded time `t` satisfies `t <= now < t + WARN_INTERVAL_MS`; a missing
 * or unreadable file, any other content, or a time later than `now` (a
 * clock set back) counts as no warning. The file is read without
 * following a symbolic link and without blocking (opened `O_RDONLY |
 * O_NOFOLLOW | O_NONBLOCK`), only when `fstat` says it is a regular file,
 * and at most its first 64 bytes: a symbolic link (to anything, a FIFO or
 * a file holding a recent time included), a FIFO, a directory or any other
 * kind of file at the name counts as no warning. The file is written only when a
 * warning is printed in warn mode, replaced atomically (a temporary file
 * in `stateDir`, then a rename, so a symbolic link at the name is replaced
 * and never followed), and a failure to read or write it never stops the
 * warning. A payload with no `session_id` (missing, empty or not a string)
 * is warned every time and writes no file. Strict mode neither reads nor
 * writes it.
 */
export function warnStatePath(stateDir: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return join(stateDir, `agentboard-hook-${digest}`);
}

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

/**
 * The actor of a hook run (board-harness-hooks "Hook actor resolution"):
 * `given` (the `--as` value) when it is a non-empty string, else
 * `AGENTBOARD_ACTOR` from `env` when non-empty, else null. Never the OS
 * user (`USER`, `LOGNAME`, `USERNAME`) and never anything from the
 * payload.
 *
 * A resolved name that could not be used by a writing command is treated
 * as no actor (null) rather than refused, since a hook never fails: the
 * reserved actor `agentboard` (`SYSTEM_ACTOR`, board-events "Reserved
 * system actor") and a name that fails the actor check of every command
 * (`isActorName`: a secret pattern, or outside the actor form
 * `^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`; board-cli "Actor names are
 * checked"). Such a name is therefore never repeated in hook output. Pure.
 *
 * `session-start` tells the two cases apart (board-harness-hooks "Hook
 * actor resolution"): with no actor set (neither a non-empty `--as` nor a
 * non-empty `AGENTBOARD_ACTOR`) its line says no actor is set; with an
 * actor set that this function refuses, its line says the actor is not a
 * valid actor name. Both lines name `AGENTBOARD_ACTOR` and `--as`, differ
 * from each other, and repeat no part of the refused name.
 */
export function resolveHookActor(given: string | undefined, env: Env): string | null {
  const fromEnv = env.AGENTBOARD_ACTOR;
  const name = given !== undefined && given !== '' ? given : fromEnv;
  if (name === undefined || name === '' || name === SYSTEM_ACTOR || !isActorName(name)) {
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
 * `cwd`, when a board exists there (`boardExists`), else null. The `git`
 * child of discovery is bounded by the time left until `deadline`; one
 * that has not answered by then counts as git failing, so discovery
 * falls back to `./.board` (board-harness-hooks "Hook command and
 * protocol"). Creates nothing and never throws.
 */
function discoverBoard(cwd: string, env: Env, deadline: number, now: () => number): string | null {
  try {
    const { dir } = locateBoard({ cwd, env, timeoutMs: Math.max(1, deadline - now()) });
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
  const db = openHookCache(boardDir, deadline, now);
  if (db === null) {
    return null;
  }
  try {
    return readState(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * The cache of `boardDir` opened as `readCacheState` opens it, for a
 * caller that reads more than the state (and, in `session-start`, writes
 * the cursor) and closes it. Null when it cannot be opened; never throws.
 */
function openHookCache(boardDir: string, deadline: number, now: () => number): DatabaseSync | null {
  const left = Math.max(0, deadline - now());
  try {
    return openCache(join(boardDir, CACHE_FILE), { prepare: false, busyTimeoutMs: left });
  } catch {
    return null;
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
  const now = options.now ?? Date.now;
  const boardDir = discoverBoard(options.cwd, options.env, options.deadline, now);
  if (boardDir === null) {
    return null;
  }
  const state = readCacheState(boardDir, options.deadline, now);
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
  /**
   * The directory of the `pre-tool-use` warning state (`warnStatePath`);
   * defaults to `os.tmpdir()`, the OS temporary directory (which honours
   * `TMPDIR` on POSIX). Never inside the board.
   */
  readonly stateDir?: string;
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
 * else `cwd` itself. An empty `cwd` is a process whose directory no
 * longer exists (`HookProcessIo.cwd`): then only an absolute payload
 * `cwd` can name a directory, and null means there is nowhere to look.
 */
function discoveryCwd(payload: HookPayload, cwd: string): string | null {
  const given = payload.cwd;
  const fallback = cwd === '' ? null : cwd;
  if (typeof given !== 'string' || given === '') {
    return fallback;
  }
  try {
    const dir = cwd === '' ? given : resolve(cwd, given);
    return isAbsolute(dir) && statSync(dir).isDirectory() ? dir : fallback;
  } catch {
    return fallback;
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

/** Exit 2 with nothing on stdout and `text` (which may span lines) on stderr. */
function block(text: string): HookOutcome {
  return { exitCode: 2, stdout: '', stderr: `${text}\n` };
}

/** What the events read and, in `session-start`, write. */
interface EventContext {
  readonly actor: string;
  readonly payload: HookPayload;
  readonly view: HookView;
  /** The open cache connection (`openHookCache`); the caller closes it. */
  readonly db: DatabaseSync;
  /** The directory discovery started from (`discoveryCwd`). */
  readonly cwd: string;
  readonly now: () => number;
  /** `HookRequest.stateDir`, resolved. */
  readonly stateDir: string;
}

/**
 * The held-ticket line of `session-start`: the actor and, in id order,
 * each held ticket as `<id> <token>` (`assigneeToken` at `now`), or that
 * the actor holds none; cut at a ticket boundary to `HELD_LINE_LIMIT`
 * characters, ending with `and <n> more`. Pure.
 */
function heldLine(actor: string, held: readonly Ticket[], now: number): string {
  if (held.length === 0) {
    return `agentboard: actor ${actor} holds no ticket.`;
  }
  const prefix = `agentboard: actor ${actor} holds `;
  const parts = held.map((ticket) => `${ticket.id} ${assigneeToken(ticket, now)}`);
  const full = `${prefix}${parts.join(', ')}`;
  if (full.length <= HELD_LINE_LIMIT) {
    return full;
  }
  let line = `${prefix}and ${String(parts.length)} more`;
  for (let k = 1; k < parts.length; k += 1) {
    const cut = `${prefix}${parts.slice(0, k).join(', ')}, and ${String(parts.length - k)} more`;
    if (cut.length > HELD_LINE_LIMIT) {
      break;
    }
    line = cut;
  }
  return line;
}

/** The last line of a truncated `session-start` context: `omitted` entries were left out. */
function omittedLine(omitted: number, actor: string): string {
  const entries = omitted === 1 ? 'entry' : 'entries';
  return `${String(omitted)} more inbox ${entries} not shown; read them with: agentboard inbox --as ${actor}`;
}

/**
 * The `session-start` context from the held line and the inbox lines:
 * every line when the whole fits in `SESSION_CONTEXT_LIMIT`, else the
 * most entries, from the start, that fit together with `omittedLine`;
 * `delivered` counts the entries included. Lines are joined with a
 * newline and nothing follows the last. Pure.
 */
function sessionText(
  held: string,
  entries: readonly string[],
  actor: string,
): { text: string; delivered: number } {
  const full = [held, ...entries].join('\n');
  if (full.length <= SESSION_CONTEXT_LIMIT) {
    return { text: full, delivered: entries.length };
  }
  let best = { text: [held, omittedLine(entries.length, actor)].join('\n'), delivered: 0 };
  for (let k = 1; k < entries.length; k += 1) {
    const text = [held, ...entries.slice(0, k), omittedLine(entries.length - k, actor)].join('\n');
    if (text.length > SESSION_CONTEXT_LIMIT) {
      break;
    }
    best = { text, delivered: k };
  }
  return best;
}

/**
 * `session-start` (board-harness-hooks "Session start hook"; `runHook`
 * step 6). The pending entries are listed in one snapshot first; only
 * when there is at least one does a write transaction list them again
 * (so two concurrent runs never deliver one entry twice) and advance the
 * cursor over the delivered ones. Nothing else of the board is written.
 */
function sessionStart(ctx: EventContext): HookOutcome {
  const { actor, db, now } = ctx;
  const held = heldLine(actor, heldTickets(ctx.view.state, actor), now());
  const board = { eventsDir: join(ctx.view.boardDir, 'events') };
  const pending = inSnapshot(db, () => pendingPositions(db, readCursor(db, actor)));
  if (pending.length === 0) {
    return sessionStartContext(held);
  }
  return inImmediate(db, () => {
    const cursor = readCursor(db, actor);
    const entries = toEntries(board, pendingPositions(db, cursor), readEventFile);
    const { text, delivered } = sessionText(
      held,
      entries.map((entry) => renderInboxLine(entry, actor)),
      actor,
    );
    if (delivered > 0) {
      const positions: CursorPosition[] = entries
        .slice(0, delivered)
        .map((entry) => ({ hash: entry.hash, ts: entry.ts }));
      writeCursor(db, advanceCursor(cursor, positions));
    }
    return sessionStartContext(text);
  });
}

/**
 * For each ticket of `tickets`, the position of the applied event that
 * last made `actor` its assignee (a `ticket.claim` by the actor, a
 * takeover included; a `ticket.grant`, `ticket.handoff` or
 * `ticket.assign` to the actor), read from the board's event files; a
 * ticket with no such event is absent. Applied means recorded as
 * effective in the cache (`folded.folded = 1`).
 */
function assignedAt(
  db: DatabaseSync,
  eventsDir: string,
  actor: string,
  tickets: readonly Ticket[],
): Map<string, CursorPosition> {
  const wanted = new Set(tickets.map((ticket) => ticket.id));
  const applied = new Set(
    recordedPositions(db, { effectiveOnly: true }).map((position) => position.hash),
  );
  const inputs = readEventLog(eventsDir).inputs.filter((input) => applied.has(input.hash));
  const last = new Map<string, CursorPosition>();
  for (const input of inputs.sort(compareFoldOrder)) {
    const { event } = input;
    if (!isKnownEvent(event) || event.kind === 'board.meta' || !wanted.has(event.ticket)) {
      continue;
    }
    const assignee =
      event.kind === 'ticket.claim'
        ? event.actor
        : event.kind === 'ticket.grant' ||
            event.kind === 'ticket.handoff' ||
            event.kind === 'ticket.assign'
          ? event.body.to
          : null;
    if (assignee === actor) {
      last.set(event.ticket, { hash: input.hash, ts: event.ts });
    }
  }
  return last;
}

/** The `stop` text naming `tickets` (in id order), for `actor`. */
function stopText(actor: string, tickets: readonly Ticket[]): string {
  const ids = tickets.map((ticket) => ticket.id).join(', ');
  const lines = [
    `agentboard: ${actor} still holds ${ids} with no comment or hand-off since taking it. Before stopping, record where it stands:`,
  ];
  for (const ticket of tickets) {
    const { id } = ticket;
    if (ticket.lease !== null) {
      lines.push(
        `  agentboard release ${id} --as ${actor}   (it is held under a lease: release it when the work it locks is done)`,
      );
    }
    lines.push(
      `  agentboard handoff ${id} --to <actor> --status <status> --note "<what is done, what is next>" --as ${actor}`,
      `  agentboard comment ${id} "<progress so far>" --as ${actor}`,
      `  agentboard move ${id} blocked --as ${actor}   (when stuck)`,
    );
  }
  return lines.join('\n');
}

/** `stop` (board-harness-hooks "Stop hook"; `runHook` step 6). Reads only. */
function stop(strict: boolean, ctx: EventContext): HookOutcome {
  const { actor, view } = ctx;
  const candidates = heldTickets(view.state, actor).filter((ticket) => ticket.status !== 'blocked');
  if (candidates.length === 0) {
    return SILENT;
  }
  const eventsDir = join(view.boardDir, 'events');
  const since = inSnapshot(ctx.db, () => assignedAt(ctx.db, eventsDir, actor, candidates));
  const silent = candidates.filter((ticket) => {
    const start = since.get(ticket.id);
    return ticket.comments.some(
      (comment) =>
        comment.actor === actor &&
        (start === undefined ||
          comparePositions({ hash: comment.hash, ts: comment.ts }, start) > 0),
    );
  });
  const named = candidates.filter((ticket) => !silent.includes(ticket));
  if (named.length === 0) {
    return SILENT;
  }
  const text = stopText(actor, named);
  if (strict && ctx.payload.stop_hook_active !== true) {
    return block(text);
  }
  return { exitCode: 0, stdout: document({ systemMessage: text }), stderr: '' };
}

/** The target of an edit tool call (see `EDIT_TOOLS`), or null when there is none. */
function editTarget(payload: HookPayload): string | null {
  const input = payload.tool_input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  const fields = input as Record<string, unknown>;
  const candidates =
    payload.tool_name === 'NotebookEdit'
      ? [fields.notebook_path, fields.file_path]
      : [fields.file_path];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return null;
}

/** True when `path` is `root` or below it, component by component (both absolute). */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** The nearest directory at or above `dir` holding a `.git` entry, or null. */
function gitRoot(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    if (dirname(current) === current) {
      return null;
    }
  }
}

/**
 * True when `target` (absolute) is a project file `pre-tool-use` checks:
 * inside the parent of `boardDir` or inside the checkout or linked
 * worktree `cwd` is in (`gitRoot`), and not exempt (in the board
 * directory, or with a `.board` component below the project directory).
 */
function isProjectFile(target: string, boardDir: string, cwd: string): boolean {
  if (within(target, boardDir)) {
    return false;
  }
  const roots = [dirname(boardDir), gitRoot(cwd)];
  for (const root of roots) {
    if (root !== null && within(target, root)) {
      return !relative(root, target).split(sep).includes('.board');
    }
  }
  return false;
}

/**
 * True when the state file `file` records a warning at `t` with
 * `t <= now < t + WARN_INTERVAL_MS` (see `warnStatePath`). Never throws.
 */
function recentlyWarned(file: string, now: number): boolean {
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(text)) {
      return false;
    }
    const at = Number(text);
    return at <= now && now < at + WARN_INTERVAL_MS;
  } catch {
    return false;
  }
}

/** Records a warning at `now` in `file`, atomically (see `warnStatePath`). Never throws. */
function recordWarning(file: string, now: number): void {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${String(now)}\n`);
    renameSync(temp, file);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file was never written.
    }
  }
}

/** The `pre-tool-use` text for `actor`. */
function claimText(actor: string): string {
  return (
    `agentboard: ${actor} holds no ticket on the board. Claim the ticket this edit belongs to before changing project files: ` +
    `agentboard inbox --as ${actor} shows what is new, and agentboard claim <id> --as ${actor} takes a ticket. ` +
    'If this work is not ticketed, carry on.'
  );
}

/** `pre-tool-use` (board-harness-hooks "Pre-tool-use claim check"; `runHook` step 6). */
function preToolUse(strict: boolean, ctx: EventContext): HookOutcome {
  const { actor, payload, view } = ctx;
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || !(EDIT_TOOLS as readonly string[]).includes(tool)) {
    return SILENT;
  }
  const target = editTarget(payload);
  if (target === null || !isProjectFile(resolve(ctx.cwd, target), view.boardDir, ctx.cwd)) {
    return SILENT;
  }
  if (heldTickets(view.state, actor).length > 0) {
    return SILENT;
  }
  const text = claimText(actor);
  if (strict) {
    return block(text);
  }
  const session = payload.session_id;
  const file =
    typeof session === 'string' && session !== '' ? warnStatePath(ctx.stateDir, session) : null;
  const now = ctx.now();
  if (file !== null) {
    if (recentlyWarned(file, now)) {
      return SILENT;
    }
    recordWarning(file, now);
  }
  return {
    exitCode: 0,
    stdout: document({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
    }),
    stderr: '',
  };
}

/** The answer of `event` for `actor` on a readable board (see `runHook` step 6). */
function answerEvent(event: HookEvent, strict: boolean, ctx: EventContext): HookOutcome {
  switch (event) {
    case 'session-start':
      return sessionStart(ctx);
    case 'stop':
      return stop(strict, ctx);
    case 'pre-tool-use':
      return preToolUse(strict, ctx);
  }
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
 *    empty. The cache is not read. When an actor was set (`--as` or
 *    `AGENTBOARD_ACTOR` non-empty) but refused, the line is the
 *    invalid-actor line instead (see `resolveHookActor`).
 * 5. The board is read with `readHookView` (discovery from the payload's
 *    `cwd`, see `HookViewOptions.cwd`), with the deadline
 *    `startedAt + budgetMs`. A null view is exit 0 with stdout empty and
 *    at most one stderr line.
 * 6. The event answers as its requirement says (board-harness-hooks
 *    "Session start hook", "Stop hook", "Pre-tool-use claim check"),
 *    holding computed with `heldTickets` and lease states at `now()`:
 *    - `session-start`: exit 0, stderr empty, stdout one
 *      `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}`
 *      document, always (an empty inbox still gets the first line). The
 *      first line of `<text>` names the actor and, for each held ticket in
 *      id order, `<id> <token>` (the full id, one space, `assigneeToken`
 *      at `now()`, as `list` shows it), or says the actor holds none; each
 *      further line is one inbox entry exactly as `agentboard inbox --as
 *      <actor>` prints it (`renderInboxLine(entry, actor)`), in fold order,
 *      for the entries pending for the actor's cursor in the cache as it
 *      is (no catch-up: an event file not yet folded is neither delivered
 *      nor skipped). The cursor then advances over the delivered entries
 *      (only those, when truncated: see `SESSION_CONTEXT_LIMIT`); with no
 *      entry delivered nothing is written. This is the only write any
 *      event makes to the board. The event files read are those of the
 *      entries delivered and at most one more (to know there are more):
 *      the omitted count comes from the cache, not from reading the
 *      omitted entries' files. No event file is read while the cache
 *      write lock is held: the lock is taken only to write the cursor, in
 *      one attempt bounded by the time left (no retry past the deadline);
 *      when it is not had in time, the run ends as out of time (exit 0,
 *      stdout empty, at most the out-of-time line), delivering nothing and
 *      writing nothing. Under the lock the cursor is read again; when it
 *      differs from the cursor the entries were chosen against (another
 *      `inbox` or hook delivered meanwhile), nothing is delivered or
 *      written and the context is the held-ticket line alone.
 *    - `stop`: the tickets to name are the held tickets whose status is
 *      not `blocked` and that have no comment (`ticket.comment` or
 *      hand-off note) by the actor at or after the event that last made
 *      the actor their assignee (its claim, a takeover, a grant from the
 *      queue, a hand-off or an assignment to it; only applied events
 *      count, a rejected one is ignored), in id order. "At or after": a
 *      hand-off to the actor itself, with its note, is both the event
 *      that made it assignee and a comment, so it counts. None: exit
 *      0, nothing printed. Otherwise the text names each such ticket with
 *      `agentboard handoff`, `agentboard comment` and `agentboard move
 *      <id> blocked`, preceded, for a ticket with a lease (`lease` not
 *      null, whatever its state), by `agentboard release <id> --as
 *      <actor>`; a ticket without a lease gets no `release`. The text is
 *      bounded by `STOP_TEXT_LIMIT`. Strict mode when the payload's
 *      `stop_hook_active` is exactly JSON `false`: exit 2, stdout empty,
 *      stderr `<text>` and a newline (the text may span lines). Warn mode,
 *      and strict mode otherwise (`true`, missing, any other value, an
 *      empty, malformed or oversized payload): exit 0, stdout
 *      `{"systemMessage":<text>}` (that key only, never `decision`). So
 *      one stop blocks at most once, and never on a payload the hook
 *      cannot read.
 *    - `pre-tool-use`: acts only for a tool of `EDIT_TOOLS` whose target is
 *      inside the project and not exempt; everything else is exit 0 with
 *      nothing printed. The project is the parent of the board directory
 *      and, when there is one, the nearest directory at or above the
 *      discovery directory holding a `.git` entry (the checkout or linked
 *      worktree the session works in); inside means the target, after
 *      `path.resolve`, is one of them or below it, component by component
 *      (a sibling sharing a name prefix is outside). Containment and the
 *      exemptions are decided on real paths: the target (or, when it does
 *      not exist, its nearest existing ancestor with the rest of the path
 *      appended), the board directory and the project roots are resolved
 *      through symbolic links (`realpath`) first. Exempt: a target in
 *      the board directory, or with a path component `.board` below the
 *      project directory. An actor holding a ticket passes silently.
 *      Otherwise, in warn mode, the text names `agentboard claim` and
 *      `agentboard inbox` and says to carry on if the work is not
 *      ticketed; in strict mode the text says the edit is refused because
 *      the actor holds no ticket, names `agentboard claim` and
 *      `agentboard inbox`, and says that if the work is not ticketed the
 *      agent should stop and ask the user rather than retry the edit (it
 *      never says to carry on). Warn mode: exit 0, stdout
 *      `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":<text>}}`
 *      (never a `permissionDecision`: `allow` would skip the user's
 *      permission prompt), rate limited per session (`warnStatePath`).
 *      Strict mode: exit 2, stdout empty, stderr `<text>` and a newline,
 *      every time.
 *    No text of any event names `renew`, a queue, `--wait`, `--ttl`,
 *    `watch`, or waiting, polling, sleeping or retrying in a loop
 *    (board-agent-guidance "Mutex ticket recipe"); every `agentboard
 *    <command>` it names is a command of the registry.
 *
 * Any error thrown inside, and running past the deadline, is exit 0
 * with stdout empty and at most one stderr line. The deadline is checked
 * during each event's work as well as before it: after the cache read,
 * between event-file reads and before the cursor write. Once any reading
 * of `now` is past the deadline, the answer is exit 0, stdout empty and
 * stderr empty or the out-of-time line, never an exit 2 and never a
 * cursor write; and no event file is opened after such a reading. The
 * answer is given by the deadline plus the time of one bounded step, so
 * well within 3 seconds of `startedAt` for the default budget.
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
    const boardDir = cwd === null ? null : discoverBoard(cwd, request.env, deadline, now);
    if (cwd === null || boardDir === null) {
      // No board (or nowhere to look): silent, whether or not there is an actor.
      return SILENT;
    }
    if (actor === null) {
      return args.event === 'session-start' ? sessionStartContext(LINES.noActor) : SILENT;
    }
    const db = openHookCache(boardDir, deadline, now);
    if (db === null) {
      return continueWith(LINES.unreadable);
    }
    try {
      let state: BoardState;
      try {
        state = readState(db);
      } catch {
        return continueWith(LINES.unreadable);
      }
      if (now() > deadline) {
        return continueWith(LINES.budget);
      }
      return answerEvent(args.event, args.strict, {
        actor,
        payload,
        view: { boardDir, state },
        db,
        cwd,
        now,
        stateDir: request.stateDir ?? tmpdir(),
      });
    } finally {
      db.close();
    }
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
 * ended within `timeoutMs`, or fails. Resolves `''` as soon as more than
 * `HOOK_STDIN_LIMIT` bytes have arrived, without waiting for the end of
 * the input or for `timeoutMs`, and lets the input go as at the deadline;
 * exactly `HOOK_STDIN_LIMIT` bytes are a payload like any other. Never
 * rejects, and never keeps the process alive after it has resolved.
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
    const timer = setTimeout(
      () => {
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
      },
      Math.max(0, timeoutMs),
    );
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
  /**
   * The process directory, or `''` when the process has none any more
   * (`process.cwd()` fails after the directory was removed under it):
   * discovery then starts from the payload's `cwd` alone.
   */
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
