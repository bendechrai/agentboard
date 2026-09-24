/**
 * The single command registry (board-cli: "Command surface"; design.md:
 * "Library first, CLI second"). Every command, its positional arguments,
 * flags, mutually exclusive flag sets, whether it writes, its summary and
 * the library operation it calls are defined here once. The parser
 * (`parseArgs`) is driven by it, and task group 9 generates the MCP tools
 * from it.
 *
 * Task group 3 registered the ticket lifecycle commands plus `version` and
 * the `mcp` placeholder; task group 4 adds `rebuild`, task group 5 adds
 * `inbox` and `watch`, task group 6 adds `sync` and task group 7 adds
 * `import-change` and `close-merged`.
 */

import {
  claimTicket,
  closeTicket,
  commentTicket,
  handoffTicket,
  linkTicket,
  moveTicket,
  releaseTicket,
  setChecklistItem,
  type LinkTarget,
} from '../board/actions.js';
import { importChange, parseImportTarget } from '../board/import.js';
import { readInbox } from '../board/inbox.js';
import { initBoard } from '../board/init.js';
import { closeMerged } from '../board/merged.js';
import { syncBoard } from '../board/sync.js';
import { TASK_RULE } from '../board/text.js';
import { parseTaskFilter, taskRefFromArgs, type TaskFilter } from '../board/resolve.js';
import { listTickets, newTicket, showRaw, showTicket } from '../board/tickets.js';
import type { WriteOutcome } from '../board/types.js';
import { watchInbox } from '../board/watch.js';
import { STATUSES, type Status } from '../events/schema.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Board } from '../store/board.js';
import { CACHE_FILE, CACHE_SCHEMA_VERSION } from '../store/cache.js';
import { BoardError } from '../store/errors.js';
import { checkCache, rebuild } from '../store/rebuild.js';
import { helpOutput, type HelpSource } from '../guidance/help.js';
import { VERSION } from '../version.js';
import {
  asciiText,
  renderCheck,
  renderInboxLine,
  renderListLine,
  renderRebuild,
  renderShow,
  type CheckDocument,
} from './render.js';
import type {
  ArgSpec,
  ArgValues,
  CommandOutput,
  CommandSpec,
  ExclusiveGroup,
  ExitCodeSpec,
  RunContext,
} from './types.js';

/** `--json`, accepted by every command. */
export const JSON_FLAG: ArgSpec = {
  name: 'json',
  type: 'boolean',
  required: false,
  repeatable: false,
  summary: 'Print exactly one JSON document on stdout',
};

/**
 * `--as <actor>`, accepted by every command (board-cli: "Every command
 * SHALL accept `--as`"). Writing commands require an actor: `--as` or, as
 * the fallback, `AGENTBOARD_ACTOR` (`resolveActor`). Commands that neither
 * write nor track a per-actor cursor ignore it, so `show T1 --as impl`
 * behaves exactly like `show T1`. Not required by the parser.
 */
export const ACTOR_FLAG: ArgSpec = {
  name: 'as',
  type: 'string',
  required: false,
  repeatable: false,
  summary: 'Actor recorded on the event (falls back to AGENTBOARD_ACTOR)',
};

/** Flags accepted by every command, in addition to its own: `--json` and `--as`. */
export const GLOBAL_FLAGS: readonly ArgSpec[] = [JSON_FLAG, ACTOR_FLAG];

/** `--allow-secret-like`, on the commands that refuse secret-looking text. */
export const ALLOW_SECRET_FLAG: ArgSpec = {
  name: 'allow-secret-like',
  type: 'boolean',
  required: false,
  repeatable: false,
  summary: 'Write text even when it matches a secret pattern',
};

/**
 * The explanation `close` gives when neither `--decision-recorded-in` nor
 * `--no-decision` is given (board-cli: "Close without disposition is
 * refused"). Names both flags and the rule that a decision made in a
 * ticket must be recorded in a spec delta or ADR.
 */
export const CLOSE_RULE =
  'close needs exactly one of --decision-recorded-in <path> or --no-decision: ' +
  'a decision made in a ticket must be recorded in a spec delta or ADR ' +
  '(name it with --decision-recorded-in), or declared absent with --no-decision';

/** Defined in `src/board/text.ts` (layering) and re-exported here unchanged. */
export { TASK_RULE };

function flag(
  name: string,
  type: ArgSpec['type'],
  summary: string,
  extra?: Partial<Pick<ArgSpec, 'required' | 'repeatable'>>,
): ArgSpec {
  return {
    name,
    type,
    required: extra?.required ?? false,
    repeatable: extra?.repeatable ?? false,
    summary,
  };
}

function positional(
  name: string,
  type: 'string' | 'integer',
  summary: string,
  required = true,
): ArgSpec {
  return { name, type, required, repeatable: false, summary };
}

const ID = positional('id', 'string', 'Ticket id or unique prefix of at least 6 characters');

const TASK_FLAGS: readonly ArgSpec[] = [
  flag('task', 'string', 'Task reference <source>:<ref>#<item>'),
  flag('change', 'string', 'OpenSpec change name (with --group)'),
  flag('group', 'string', 'OpenSpec task group number (with --change)'),
];

/** The alternatives of `new`: `--task` | `--change --group` | `--adhoc`. */
const NEW_TASK_GROUP: ExclusiveGroup = {
  alternatives: [['task'], ['change', 'group'], ['adhoc']],
  required: true,
  reason: 'needs-task-or-adhoc',
  message: TASK_RULE,
};

/** The targets of `link`. */
const LINK_GROUP: ExclusiveGroup = {
  alternatives: [['task'], ['change', 'group'], ['pr'], ['decision']],
  required: true,
  reason: 'usage',
  message: 'link needs exactly one of --task, --change with --group, --pr or --decision',
};

/** `list --task` and `list --change` are alternatives; neither is required. */
const LIST_TASK_GROUP: ExclusiveGroup = {
  alternatives: [['task'], ['change']],
  required: false,
  reason: 'usage',
  message: 'list takes at most one of --task and --change',
};

/** The dispositions of `close`. */
const CLOSE_GROUP: ExclusiveGroup = {
  alternatives: [['decision-recorded-in'], ['no-decision']],
  required: true,
  reason: 'no-disposition',
  message: CLOSE_RULE,
};

/** Exit code entries shared by many commands (see `ExitCodeSpec`). */
const EXIT_OK: ExitCodeSpec = { code: 0, meaning: 'Success' };
const EXIT_USAGE: ExitCodeSpec = {
  code: 1,
  reason: 'usage',
  meaning: 'Invalid arguments: unknown command or flag, missing or malformed argument',
};
const EXIT_ACTOR: ExitCodeSpec = {
  code: 1,
  reason: 'missing-actor',
  meaning: 'No actor: pass --as <actor> or set AGENTBOARD_ACTOR',
};
const EXIT_ID_SHORT: ExitCodeSpec = {
  code: 1,
  reason: 'id-too-short',
  meaning: 'The id prefix is shorter than 6 characters',
};
const EXIT_ID_AMBIGUOUS: ExitCodeSpec = {
  code: 1,
  reason: 'ambiguous-id',
  meaning: 'The id prefix matches several tickets (all are listed)',
};
const EXIT_SECRET: ExitCodeSpec = {
  code: 1,
  reason: 'secret-like',
  meaning: 'The text matches a secret pattern (named); nothing is written',
};
const EXIT_TASK_REF: ExitCodeSpec = {
  code: 1,
  reason: 'malformed-task-ref',
  meaning: 'The task reference is not of the form <source>:<ref>#<item>',
};
const EXIT_NO_BOARD: ExitCodeSpec = {
  code: 2,
  reason: 'board-not-found',
  meaning: 'No board found from this directory (see AGENTBOARD_DIR)',
};
const EXIT_UNKNOWN_TICKET: ExitCodeSpec = {
  code: 4,
  reason: 'unknown-ticket',
  meaning: 'No ticket matches the id',
};
const EXIT_TRANSITION: ExitCodeSpec = {
  code: 4,
  reason: 'invalid-transition',
  meaning: 'The status machine does not permit this move from the current status',
};
const EXIT_TASK_LINK: ExitCodeSpec = {
  code: 4,
  reason: 'needs-task-link',
  meaning: 'A ticket without a task reference cannot enter implementing; link one first',
};
const EXIT_INTEGRITY: ExitCodeSpec = {
  code: 5,
  meaning: 'Event log or cache integrity problem, or the cache stayed locked (busy)',
};

/** The exit codes of a command that reads one ticket by id. */
const READ_ID_EXITS: readonly ExitCodeSpec[] = [
  EXIT_ID_SHORT,
  EXIT_ID_AMBIGUOUS,
  EXIT_NO_BOARD,
  EXIT_UNKNOWN_TICKET,
];

/** A string argument, or undefined when absent. */
function str(values: ArgValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

/** A required string argument (the parser guarantees it is present). */
function req(values: ArgValues, name: string): string {
  return str(values, name) ?? '';
}

/** A repeatable string flag; empty when absent. */
function list(values: ArgValues, name: string): readonly string[] {
  const value = values[name];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** A boolean flag. */
function bool(values: ArgValues, name: string): boolean {
  return values[name] === true;
}

/** A status argument; anything but one of `STATUSES` is a usage error. */
function status(text: string): Status {
  const found = STATUSES.find((s) => s === text);
  if (found === undefined) {
    throw new BoardError(
      1,
      'usage',
      `unknown status ${asciiText(text)}; expected one of ${STATUSES.join(', ')}`,
    );
  }
  return found;
}

/**
 * The actor of a writing or cursor-tracking command (resolved by `runCli`;
 * empty only if misused).
 */
function actorOf(ctx: RunContext): string {
  return ctx.actor ?? '';
}

/** The `--json` document and human text of a writing command. */
function written(outcome: WriteOutcome, before = '', after = ''): CommandOutput {
  const line = renderListLine(outcome.ticket);
  return { json: outcome, text: `${before}${line}\n${after}` };
}

/** The target of `link`. */
function linkTarget(values: ArgValues): LinkTarget {
  const pr = str(values, 'pr');
  if (pr !== undefined) {
    const number = Number(pr);
    return { pr: /^[0-9]+$/.test(pr) && Number.isSafeInteger(number) ? number : pr };
  }
  const decision = str(values, 'decision');
  if (decision !== undefined) {
    return { decision };
  }
  const task = taskRefFromArgs({
    task: str(values, 'task'),
    change: str(values, 'change'),
    group: str(values, 'group'),
  });
  if (task === undefined) {
    throw new BoardError(1, 'usage', LINK_GROUP.message);
  }
  return { task };
}

/** The task filter of `list` (`--task`, or `--change` as `openspec:<name>`). */
function listTaskFilter(values: ArgValues): TaskFilter | undefined {
  const task = str(values, 'task');
  if (task !== undefined) {
    return parseTaskFilter(task);
  }
  const change = str(values, 'change');
  if (change === undefined) {
    return undefined;
  }
  if (change === '' || change.includes('#')) {
    throw new BoardError(
      1,
      'malformed-task-ref',
      `malformed change name ${asciiText(change)}: it must be non-empty and contain no #`,
    );
  }
  return { source: 'openspec', ref: change };
}

/** `rebuild`: a full refold on the board opened without catch-up. */
function runRebuild(ctx: RunContext): CommandOutput {
  const report = rebuild(ctx.board({ catchUp: false }));
  return { json: report, text: renderRebuild(report) };
}

/**
 * `rebuild --check`: compares the live cache, opened for inspection only
 * (no catch-up, never created, migrated or written), with a fresh rebuild.
 */
function runCheck(ctx: RunContext): CommandOutput {
  const cachePath = join(ctx.boardDir(), CACHE_FILE);
  if (!existsSync(cachePath)) {
    return noCacheOutput(cachePath);
  }
  let board: Board;
  try {
    board = ctx.board({ catchUp: false, prepare: false });
  } catch (error) {
    if (error instanceof BoardError && error.reason === 'no-cache') {
      return noCacheOutput(cachePath);
    }
    if (error instanceof BoardError && error.reason === 'schema-mismatch') {
      const doc: CheckDocument = {
        ok: false,
        noCache: false,
        schemaMismatch: true,
        differences: [],
        report: null,
      };
      return {
        json: doc,
        text: renderCheck(doc),
        exitCode: 1,
        warnings: [
          `the cache file at ${cachePath} is not a cache of schema version ${String(CACHE_SCHEMA_VERSION)}; run agentboard rebuild to replace it`,
        ],
      };
    }
    throw error;
  }
  const result = checkCache(board);
  const doc: CheckDocument = { ...result, noCache: false, schemaMismatch: false };
  if (result.ok) {
    return { json: doc, text: renderCheck(doc) };
  }
  return {
    json: doc,
    text: renderCheck(doc),
    exitCode: 1,
    warnings: [
      `the cache differs from the event log in ${String(result.differences.length)} row(s); run agentboard rebuild to replace it`,
    ],
  };
}

/** The `rebuild --check` output when there is no cache file at `cachePath`. */
function noCacheOutput(cachePath: string): CommandOutput {
  const doc: CheckDocument = {
    ok: false,
    noCache: true,
    schemaMismatch: false,
    differences: [],
    report: null,
  };
  return {
    json: doc,
    text: renderCheck(doc),
    exitCode: 1,
    warnings: [`there is no cache file at ${cachePath}; run agentboard rebuild to create it`],
  };
}

/** `checklist tick` and `checklist untick`. */
function checklistRun(done: boolean): CommandSpec['run'] {
  return (ctx, values) => {
    const out = setChecklistItem(ctx.board(), actorOf(ctx), {
      id: req(values, 'id'),
      index: Number(values.index),
      done,
    });
    return written(out, '', out.reminder === null ? '' : `${out.reminder.message}\n`);
  };
}

/**
 * Every command of this version, in this order: `init`, `new`, `show`,
 * `list`, `claim`, `release`, `move`, `comment`, `handoff`, `link`,
 * `checklist tick`, `checklist untick`, `close`, `inbox`, `watch`, `rebuild`,
 * `sync`, `import-change`, `close-merged`, `mcp`, `version` (the board-cli
 * order), then `help` (add-agent-guidance).
 *
 * Every entry carries the help data of record (`description`, `group`,
 * `examples`, `exitCodes`; see `CommandSpec`), rendered by
 * `src/guidance/help.ts`.
 *
 * `run` of each command calls the named operation and returns its result
 * as the `--json` document, with this human rendering:
 * - `init`: `InitResult`; text: its `message`.
 * - `new`: `WriteOutcome`; text: `created <full id>` then the `list` line.
 * - `show`: `ShowResult` (`--raw`: `RawEvent[]`); text: `renderShow`
 *   (`--raw`: each raw event's `text` on its own line).
 * - `list`: `Ticket[]`; text: one `renderListLine` per ticket.
 * - other writing commands: `WriteOutcome` (`ChecklistOutcome` for
 *   `checklist tick|untick`); text: the `list` line of the resulting
 *   ticket, preceded by `already claimed by <actor>` for a claim that
 *   wrote nothing, and followed, for a tick, by the reminder `message`.
 * - `inbox`: `InboxResult` (`readInbox` with `--peek` and `--since`); text:
 *   one `renderInboxLine` per entry, nothing when there is none. Tracks a
 *   cursor, so it requires an actor.
 * - `watch`: streams (`stream` calls `watchInbox` with the stop signal and
 *   prints each entry as one line, see `runCliAsync`; each `onWarning` line
 *   goes to `io.stderr` as `agentboard: <line>` and a newline); its `run` throws
 *   `BoardError(1, 'streaming-command')` saying that watch streams and runs
 *   only from the agentboard executable. Tracks a cursor, so it requires an
 *   actor.
 * - `rebuild`: `RebuildReport` from the store's `rebuild` on the board
 *   opened with `ctx.board({ catchUp: false })`, so the open folds nothing
 *   and reaps nothing: every event file, including one no command has
 *   folded yet, is folded, counted and reported by the rebuild itself
 *   (board-cache: "Rebuild"); text: `renderRebuild`. Exit 0.
 * - `rebuild --check`: a `CheckDocument`. First, when
 *   `<ctx.boardDir()>/cache.sqlite` does not exist, the document is the
 *   `noCache` one, the output carries `exitCode: 1` and the warning
 *   `there is no cache file at <path>; run agentboard rebuild to create it`,
 *   and the board is never opened, so no cache file is created. Otherwise
 *   the board is opened with `ctx.board({ catchUp: false, prepare: false })`,
 *   so the cache file is never created, migrated or written, no event file
 *   is folded and no temporary file is reaped before the comparison
 *   (board-cache: "Rebuild", `rebuild --check` SHALL NOT modify the live
 *   cache file). If that open throws `BoardError` reason `no-cache` (the
 *   file vanished after the existence check), the result is the `noCache`
 *   one above. If it throws reason `schema-mismatch`, the document is the
 *   `schemaMismatch` one, the output carries `exitCode: 1` and the warning
 *   `the cache file at <path> is not a cache of schema version <CACHE_SCHEMA_VERSION>; run agentboard rebuild to replace it`,
 *   and the file is left byte for byte unchanged, cursor rows included.
 *   Otherwise the store's `checkCache` runs on that board and the document
 *   is its `CheckResult` with `noCache: false` and `schemaMismatch: false`;
 *   text:
 *   `renderCheck`. With no difference it exits 0. On divergence the output
 *   carries `exitCode: 1` and one warning,
 *   `the cache differs from the event log in <n> row(s); run agentboard rebuild to replace it`,
 *   so stdout still receives the full report (the document with `--json`)
 *   and the process exits 1. `rebuild` writes no event, so it needs no
 *   actor (`--as` is accepted and ignored).
 * - `sync`: `SyncResult` (`syncBoard` with `ctx.env`; writes no event, so
 *   no actor is needed); text: its `message` and a newline; `warnings`:
 *   the result's `warnings`, printed to stderr by `runCli`.
 * - `import-change <name>`: `ImportResult`; `name` goes through
 *   `parseImportTarget` (a plain name is an OpenSpec change,
 *   `<source>:<ref>` names another source). Text: one line per unit,
 *   `<action> ` followed by the `list` line of its ticket (`created`,
 *   `updated` or `unchanged`), then
 *   `imported <source>:<ref>: <c> created, <u> updated, <n> unchanged, <e> events`.
 * - `close-merged`: `CloseMergedResult` (with `cwd` and `env` from the
 *   context and the default `gh` runner). Text: for each closed ticket
 *   `closed ` plus its `list` line plus ` (decision <path>)` or
 *   ` (no decision)`; for each unmerged one `unmerged ` plus its `list`
 *   line plus ` (PR <pr> is <state>)`; for each skipped one `skipped `
 *   plus its `list` line plus ` (<reason>)`; then
 *   `close-merged: <c> closed, <u> unmerged, <s> skipped`.
 * - `version`: `{ version }`; text: the version.
 * - `mcp`: serves MCP over stdio (`serveMcp` in `src/mcp/server.ts`),
 *   which needs the process's stdin and stdout and runs until the client
 *   goes away, so it cannot answer with one `CommandOutput`. The
 *   executable dispatches it before `runCli` (see `src/cli.ts`); its `run`,
 *   reachable only through the in-process `runCli`, always throws
 *   `BoardError(1, 'streaming-command')` with the message
 *   `agentboard mcp serves MCP over stdio and runs only from the agentboard executable`.
 *   `--json` is accepted and ignored (it is implied for every tool);
 *   `--as <actor>` sets the server's default actor, used by a tool call
 *   that has no `as` of its own, before `AGENTBOARD_ACTOR`.
 * - `help [<topic>] [<subtopic>]`: `helpOutput(HELP_SOURCE, <the given
 *   words>)`: the overview, or one command's help, as text or (`--json`)
 *   one JSON document. Needs no board and no actor. `parseArgs` also turns
 *   `agentboard`, `--help`, `-h` and `<command> --help` into `help`.
 *
 * Argument mapping: `--change`/`--group`/`--task` go through
 * `taskRefFromArgs`; `list --change <name>` is `list --task openspec:<name>`
 * (the two are exclusive); `list --task` goes through `parseTaskFilter`; a status
 * argument must be one of `STATUSES` or it is `BoardError(1, 'usage')`
 * listing them; `link --pr` is a number when it is all digits (a positive
 * safe integer), otherwise the string; `close --decision-recorded-in` and
 * `link --decision` pass `ctx.cwd` and `ctx.env` so the path is resolved
 * and recorded by `treePath`.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    summary: 'Create the board for this project',
    description:
      'Creates the board for the project containing the current directory: a .board directory that is a git repository of its own, ignored by the host project. Running it again on an existing board changes nothing. Needs git; needs no actor.',
    group: 'setup',
    examples: [{ command: 'agentboard init', summary: 'Create the board for this project' }],
    exitCodes: [
      { code: 0, meaning: 'The board was created, or already existed' },
      EXIT_USAGE,
      { code: 1, reason: 'git-missing', meaning: 'git could not be run' },
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: 'initBoard',
    run: (ctx) => {
      const result = initBoard({ cwd: ctx.cwd, env: ctx.env });
      return { json: result, text: `${result.message}\n` };
    },
  },
  {
    name: 'new',
    summary: 'Create a ticket',
    description:
      'Creates a ticket in todo, unassigned. Every ticket names the planning task it implements (--task, or --change with --group for an OpenSpec task group) or says why it has none (--adhoc). Checklist lines become the ticket checklist. Text that looks like a secret is refused unless --allow-secret-like is given.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard new "Implement the parser" --change add-parser --group 2 --as orch',
        summary: 'Create a ticket for task group 2 of the OpenSpec change add-parser',
      },
      {
        command: 'agentboard new "Fix flaky test" --adhoc "found in CI" --label ci --as orch',
        summary: 'Create a ticket that implements no planning task',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      {
        code: 1,
        reason: 'needs-task-or-adhoc',
        meaning: 'Neither a task reference nor --adhoc was given',
      },
      EXIT_TASK_REF,
      EXIT_SECRET,
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [positional('title', 'string', 'Ticket title')],
    flags: [
      flag('description', 'string', 'Longer description'),
      flag('label', 'string', 'Label (repeatable)', { repeatable: true }),
      ...TASK_FLAGS,
      flag('adhoc', 'string', 'Reason the ticket has no task reference'),
      flag('checklist', 'string', 'Checklist line (repeatable)', { repeatable: true }),
      ALLOW_SECRET_FLAG,
    ],
    exclusive: [NEW_TASK_GROUP],
    writes: true,
    operation: 'newTicket',
    run: (ctx, values) => {
      const task = taskRefFromArgs({
        task: str(values, 'task'),
        change: str(values, 'change'),
        group: str(values, 'group'),
      });
      const out = newTicket(ctx.board(), actorOf(ctx), {
        title: req(values, 'title'),
        description: str(values, 'description'),
        labels: list(values, 'label'),
        task,
        adhoc: str(values, 'adhoc'),
        checklist: list(values, 'checklist'),
        allowSecretLike: bool(values, 'allow-secret-like'),
      });
      return written(out, `created ${out.ticket.id}\n`);
    },
  },
  {
    name: 'show',
    summary: 'Show one ticket in full',
    description:
      'Prints one ticket in full: status, assignee, task reference, links, checklist, every comment in order and the number of events. The id may be a unique prefix of at least 6 characters. --raw prints the ticket event files instead. Needs no actor.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard show 01J9K3', summary: 'Show the ticket whose id starts with 01J9K3' },
      { command: 'agentboard show 01J9K3 --json', summary: 'The same, as one JSON document' },
    ],
    exitCodes: [EXIT_OK, EXIT_USAGE, ...READ_ID_EXITS, EXIT_INTEGRITY],
    positionals: [ID],
    flags: [flag('raw', 'boolean', "Print the ticket's raw event files")],
    exclusive: [],
    writes: false,
    operation: 'showTicket',
    run: (ctx, values) => {
      const id = req(values, 'id');
      if (bool(values, 'raw')) {
        const raw = showRaw(ctx.board(), id);
        return { json: raw, text: raw.map((r) => `${r.text}\n`).join('') };
      }
      const shown = showTicket(ctx.board(), id);
      return { json: shown, text: renderShow(shown) };
    },
  },
  {
    name: 'list',
    summary: 'List open tickets, optionally filtered',
    description:
      'Lists tickets, one per line: id prefix, status, assignee or -, title. Closed tickets are left out unless --closed is given. Filters combine; --change <name> is the same as --task openspec:<name>. Needs no actor.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard list --status todo', summary: 'List the tickets waiting in todo' },
      {
        command: 'agentboard list --change add-parser --json',
        summary: 'List the tickets of the OpenSpec change add-parser as JSON',
      },
    ],
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_TASK_REF, EXIT_NO_BOARD, EXIT_INTEGRITY],
    positionals: [],
    flags: [
      flag('status', 'string', 'Only tickets in this status'),
      flag('assignee', 'string', 'Only tickets assigned to this actor'),
      flag('task', 'string', 'Only tickets with this task reference <source>:<ref>[#<item>]'),
      flag('change', 'string', 'Only tickets of this OpenSpec change'),
      flag('label', 'string', 'Only tickets with this label (repeatable)', { repeatable: true }),
      flag('closed', 'boolean', 'Include closed tickets'),
    ],
    exclusive: [LIST_TASK_GROUP],
    writes: false,
    operation: 'listTickets',
    run: (ctx, values) => {
      const given = str(values, 'status');
      const task = listTaskFilter(values);
      const tickets = listTickets(ctx.board(), {
        status: given === undefined ? undefined : status(given),
        assignee: str(values, 'assignee'),
        task,
        labels: list(values, 'label'),
        closed: bool(values, 'closed'),
      });
      return { json: tickets, text: tickets.map((t) => `${renderListLine(t)}\n`).join('') };
    },
  },
  {
    name: 'claim',
    summary: 'Assign an unassigned ticket to yourself',
    description:
      'Assigns an unassigned ticket to the actor. Claim a ticket before starting work on it. If another actor holds it the claim is refused (exit 4, already-assigned) naming the holder; a claim by the current holder succeeds without writing anything, so retrying a claim is safe.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard claim 01J9K3 --as impl', summary: 'Claim ticket 01J9K3 as impl' },
    ],
    exitCodes: [
      { code: 0, meaning: 'Claimed, or already held by the actor' },
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      {
        code: 4,
        reason: 'already-assigned',
        meaning: 'Another actor holds the ticket (named in the message)',
      },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'claimTicket',
    run: (ctx, values) => {
      const actor = actorOf(ctx);
      const out = claimTicket(ctx.board(), actor, { id: req(values, 'id') });
      return written(out, out.hash === null ? `already claimed by ${asciiText(actor)}\n` : '');
    },
  },
  {
    name: 'release',
    summary: 'Give up a ticket you hold',
    description:
      'Clears the assignment of a ticket the actor holds, leaving its status unchanged, so another actor can claim it. Only the current assignee can release a ticket.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard release 01J9K3 --as impl', summary: 'Give up ticket 01J9K3' },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      { code: 4, reason: 'not-assignee', meaning: 'The actor does not hold the ticket' },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'releaseTicket',
    run: (ctx, values) =>
      written(releaseTicket(ctx.board(), actorOf(ctx), { id: req(values, 'id') })),
  },
  {
    name: 'move',
    summary: 'Move a ticket to another status (a blocked ticket returns to its origin)',
    description:
      'Moves a ticket to another status: todo, tests, implementing, review, merged or blocked. Permitted moves: todo to tests, tests to implementing, implementing to review, review back to implementing or tests, review to merged, any open status to blocked. A blocked ticket moved with no status returns to the status it was blocked from. merged is terminal.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard move 01J9K3 blocked --as impl', summary: 'Block ticket 01J9K3' },
      {
        command: 'agentboard move 01J9K3 --as impl',
        summary: 'Return a blocked ticket to the status it was blocked from',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      {
        code: 1,
        reason: 'missing-status',
        meaning: 'No target status was given and the ticket is not blocked',
      },
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      EXIT_TRANSITION,
      EXIT_TASK_LINK,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID, positional('status', 'string', 'Target status', false)],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'moveTicket',
    run: (ctx, values) => {
      const to = str(values, 'status');
      return written(
        moveTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          to: to === undefined ? undefined : status(to),
        }),
      );
    },
  },
  {
    name: 'comment',
    summary: 'Add a comment to a ticket',
    description:
      'Adds a comment to a ticket. A comment starting with DECISION: records a decision, which must be promoted to a spec delta or ADR before the ticket is closed. Text that looks like a secret is refused unless --allow-secret-like is given.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard comment 01J9K3 "blocked on the schema question" --as impl',
        summary: 'Add a comment to ticket 01J9K3',
      },
      {
        command: 'agentboard comment 01J9K3 "DECISION: ids are ULIDs" --as impl',
        summary: 'Record a decision that must be promoted before close',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_SECRET,
      EXIT_NO_BOARD,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID, positional('text', 'string', 'Comment text')],
    flags: [ALLOW_SECRET_FLAG],
    exclusive: [],
    writes: true,
    operation: 'commentTicket',
    run: (ctx, values) =>
      written(
        commentTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          text: req(values, 'text'),
          allowSecretLike: bool(values, 'allow-secret-like'),
        }),
      ),
  },
  {
    name: 'handoff',
    summary: 'Reassign, move and comment in one event',
    description:
      'Reassigns a ticket, moves it and adds a note, all in one event: the way to pass work to the next role. --status may be the current status to only reassign. If the move is not permitted nothing is written. Text that looks like a secret is refused unless --allow-secret-like is given.',
    group: 'lifecycle',
    examples: [
      {
        command:
          'agentboard handoff 01J9K3 --to reviewer --status review --note "green, 96% coverage" --as impl',
        summary: 'Hand ticket 01J9K3 to reviewer for review',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_SECRET,
      EXIT_NO_BOARD,
      EXIT_TRANSITION,
      EXIT_TASK_LINK,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      flag('to', 'string', 'New assignee', { required: true }),
      flag('status', 'string', 'Target status (the current one to only reassign)', {
        required: true,
      }),
      flag('note', 'string', 'Hand-off note, recorded as a comment', { required: true }),
      ALLOW_SECRET_FLAG,
    ],
    exclusive: [],
    writes: true,
    operation: 'handoffTicket',
    run: (ctx, values) => {
      const to = status(req(values, 'status'));
      return written(
        handoffTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          to: req(values, 'to'),
          status: to,
          note: req(values, 'note'),
          allowSecretLike: bool(values, 'allow-secret-like'),
        }),
      );
    },
  },
  {
    name: 'link',
    summary: 'Link a ticket to a task, a PR or a decision record',
    description:
      'Links a ticket to the planning task it implements (--task, or --change with --group; replaces any earlier task and clears --adhoc), to a pull request (--pr, a URL or number), or to a decision record (--decision, a path inside the working tree, recorded relative to its root). Give exactly one target.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard link 01J9K3 --pr 42 --as impl',
        summary: 'Link ticket 01J9K3 to pull request 42',
      },
      {
        command: 'agentboard link 01J9K3 --task openspec:add-parser#2 --as orch',
        summary: 'Link ticket 01J9K3 to task group 2 of the OpenSpec change add-parser',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_TASK_REF,
      {
        code: 1,
        reason: 'path-outside-tree',
        meaning: 'The decision path lies outside the working tree',
      },
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      ...TASK_FLAGS,
      flag('pr', 'string', 'Pull request URL or number'),
      flag('decision', 'string', 'Path of a decision record'),
    ],
    exclusive: [LINK_GROUP],
    writes: true,
    operation: 'linkTicket',
    run: (ctx, values) => {
      const target = linkTarget(values);
      return written(
        linkTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          target,
          cwd: ctx.cwd,
          env: ctx.env,
        }),
      );
    },
  },
  {
    name: 'checklist tick',
    summary: 'Mark a checklist line done (0-based index)',
    description:
      'Marks checklist line <index> (counted from 0) of a ticket done. For a ticket linked to a planning task it also reminds you to tick the task in the tasks file: the board is not the record of completion.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard checklist tick 01J9K3 0 --as impl',
        summary: 'Mark the first checklist line of ticket 01J9K3 done',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      { code: 4, reason: 'checklist-index', meaning: 'The ticket has no checklist line <index>' },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID, positional('index', 'integer', 'Checklist line index, from 0')],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'setChecklistItem',
    run: checklistRun(true),
  },
  {
    name: 'checklist untick',
    summary: 'Mark a checklist line not done (0-based index)',
    description: 'Marks checklist line <index> (counted from 0) of a ticket not done.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard checklist untick 01J9K3 0 --as impl',
        summary: 'Mark the first checklist line of ticket 01J9K3 not done',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      { code: 4, reason: 'checklist-index', meaning: 'The ticket has no checklist line <index>' },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID, positional('index', 'integer', 'Checklist line index, from 0')],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'setChecklistItem',
    run: checklistRun(false),
  },
  {
    name: 'close',
    summary: 'Close a merged or blocked ticket with a decision disposition',
    description:
      'Closes a merged or blocked ticket. A decision made in a ticket must be recorded in a spec delta or ADR: name that file with --decision-recorded-in (it must exist inside the working tree), or declare that the ticket made no decision with --no-decision, which is refused while the ticket has an unretracted DECISION: comment.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard close 01J9K3 --decision-recorded-in docs/adr/0007-ids.md --as orch',
        summary: 'Close ticket 01J9K3, naming the ADR that records its decision',
      },
      {
        command: 'agentboard close 01J9K3 --no-decision --as orch',
        summary: 'Close ticket 01J9K3, which made no decision',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      {
        code: 1,
        reason: 'no-disposition',
        meaning: 'Neither --decision-recorded-in nor --no-decision was given',
      },
      {
        code: 1,
        reason: 'path-outside-tree',
        meaning: 'The decision path lies outside the working tree',
      },
      {
        code: 1,
        reason: 'decision-path-missing',
        meaning: 'The decision record does not exist',
      },
      {
        code: 1,
        reason: 'unpromoted-decision',
        meaning: '--no-decision on a ticket with an unretracted DECISION: comment',
      },
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      {
        code: 4,
        reason: 'invalid-transition',
        meaning: 'The ticket is not merged or blocked, or is already closed',
      },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      flag('decision-recorded-in', 'string', 'Spec delta, ADR or tasks file recording decisions'),
      flag('no-decision', 'boolean', 'The ticket made no decision that needs recording'),
    ],
    exclusive: [CLOSE_GROUP],
    writes: true,
    operation: 'closeTicket',
    run: (ctx, values) => {
      const id = req(values, 'id');
      const path = str(values, 'decision-recorded-in');
      return written(
        closeTicket(
          ctx.board(),
          actorOf(ctx),
          path === undefined
            ? { id, noDecision: true }
            : { id, decisionRecordedIn: path, cwd: ctx.cwd, env: ctx.env },
        ),
      );
    },
  },
  {
    name: 'inbox',
    summary: 'List new board events for an actor and acknowledge them',
    description:
      "Lists the board events since the actor last acknowledged its inbox (every ticket, the actor's own events included, in board order) and acknowledges them, advancing the actor's cursor. Run it before starting or dispatching work. --peek lists without acknowledging; --since <hash> lists the events after that event without acknowledging.",
    group: 'awareness',
    examples: [
      {
        command: 'agentboard inbox --as impl',
        summary: 'List and acknowledge what is new for impl',
      },
      {
        command: 'agentboard inbox --as impl --peek --json',
        summary: 'List what is new for impl as JSON without acknowledging it',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      {
        code: 1,
        reason: 'unknown-cursor',
        meaning: 'The --since hash names no event on this board',
      },
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [
      flag('since', 'string', 'List events after this event hash, without acknowledging'),
      flag('peek', 'boolean', 'List without acknowledging (the cursor does not advance)'),
    ],
    exclusive: [],
    writes: false,
    tracksCursor: true,
    operation: 'readInbox',
    run: (ctx, values) => {
      const result = readInbox(ctx.board(), actorOf(ctx), {
        peek: bool(values, 'peek'),
        since: str(values, 'since'),
      });
      return {
        json: result,
        text: result.entries.map((entry) => `${renderInboxLine(entry)}\n`).join(''),
      };
    },
  },
  {
    name: 'watch',
    summary: 'Stream new board events for an actor without acknowledging them',
    description:
      'Streams new board events for the actor, one line per event (one JSON document per line with --json), as they arrive, without acknowledging them. Runs until interrupted (SIGINT or SIGTERM), then exits 0.',
    group: 'awareness',
    examples: [
      { command: 'agentboard watch --as orch', summary: 'Stream new board events for orch' },
    ],
    exitCodes: [
      { code: 0, meaning: 'Stopped by SIGINT or SIGTERM' },
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    tracksCursor: true,
    operation: 'watchInbox',
    run: () => {
      throw new BoardError(
        1,
        'streaming-command',
        'agentboard watch streams its output and runs only from the agentboard executable',
      );
    },
    stream: (ctx, _values, io) =>
      watchInbox(ctx.board(), actorOf(ctx), {
        signal: io.signal,
        onWarning: (line) => {
          io.stderr?.(`agentboard: ${line}\n`);
        },
        onEntries: (entries) => {
          io.stdout(
            entries
              .map((entry) => `${io.json ? JSON.stringify(entry) : renderInboxLine(entry)}\n`)
              .join(''),
          );
        },
      }),
  },
  {
    name: 'rebuild',
    summary: 'Refold the cache from the event log (--check: compare only, exit 1 on divergence)',
    description:
      'Rebuilds the cache from the event log, which is the source of truth; run it when the cache is missing, stale or corrupt. With --check it only compares a fresh rebuild with the cache, changing nothing, and exits 1 when they differ or there is no cache. Needs no actor.',
    group: 'maintenance',
    examples: [
      { command: 'agentboard rebuild', summary: 'Rebuild the cache from the event log' },
      {
        command: 'agentboard rebuild --check',
        summary: 'Check the cache against the event log without changing it',
      },
    ],
    exitCodes: [
      EXIT_OK,
      { code: 1, meaning: 'With --check: the cache differs from the event log, or is missing' },
      EXIT_USAGE,
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [
      flag(
        'check',
        'boolean',
        'Compare a fresh rebuild with the cache without changing it; exit 1 on divergence',
      ),
    ],
    exclusive: [],
    writes: false,
    operation: 'rebuild',
    run: (ctx, values) => (bool(values, 'check') ? runCheck(ctx) : runRebuild(ctx)),
  },
  {
    name: 'sync',
    summary: "Commit new events, pull with rebase from the board's remote and push",
    description:
      'Shares the board with other clones: commits new event files in the board repository, pulls with rebase from its remote and pushes. Event files never conflict with each other; a problem that needs a human (a conflict, a rebase in progress, a detached HEAD, an unreachable remote) exits 3. Needs no actor.',
    group: 'maintenance',
    examples: [{ command: 'agentboard sync', summary: "Commit, pull and push the board's events" }],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      { code: 1, reason: 'git-missing', meaning: 'git could not be run' },
      {
        code: 1,
        reason: 'ambiguous-remote',
        meaning: 'The board repository has several remotes and no upstream or origin',
      },
      EXIT_NO_BOARD,
      {
        code: 2,
        reason: 'board-not-a-repository',
        meaning: 'The board directory is not the top of its own git repository',
      },
      {
        code: 3,
        reason: 'sync-in-progress',
        meaning: 'A rebase is in progress in the board repository',
      },
      { code: 3, reason: 'detached-head', meaning: 'The board repository has a detached HEAD' },
      { code: 3, reason: 'sync-conflict', meaning: 'The pull stopped on a conflict' },
      {
        code: 3,
        reason: 'sync-failed',
        meaning: 'A git step failed, or the remote is unreachable or rejected the push',
      },
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: 'syncBoard',
    run: (ctx) => {
      const result = syncBoard(ctx.board(), { env: ctx.env });
      return { json: result, text: `${result.message}\n`, warnings: result.warnings };
    },
  },
  {
    name: 'import-change',
    summary: 'Create or update one ticket per task group of a planning change',
    description:
      'Creates one ticket per task group of a planning change: a plain name is an OpenSpec change (its tasks.md is read), <source>:<ref> names another source. A group whose tasks are all ticked gets a ticket in merged. Running it again creates tickets for new groups and appends new task lines to existing checklists. Run it after proposing a change.',
    group: 'planning',
    examples: [
      {
        command: 'agentboard import-change add-parser --as orch',
        summary: 'Create a ticket per task group of the OpenSpec change add-parser',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      EXIT_TASK_REF,
      {
        code: 1,
        reason: 'unsupported-source',
        meaning: 'The task source has no adapter in this version',
      },
      { code: 1, reason: 'tasks-not-found', meaning: 'The change has no readable tasks file' },
      {
        code: 1,
        reason: 'malformed-tasks',
        meaning: 'The tasks file cannot be parsed (line named)',
      },
      EXIT_SECRET,
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [
      positional('name', 'string', 'OpenSpec change name, or <source>:<ref> for another source'),
    ],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'importChange',
    run: (ctx, values) => {
      const target = parseImportTarget(req(values, 'name'));
      const result = importChange(ctx.board(), actorOf(ctx), target);
      const count = (action: string): number =>
        result.tickets.filter((t) => t.action === action).length;
      const lines = result.tickets.map((t) => `${t.action} ${renderListLine(t.ticket)}`);
      lines.push(
        `imported ${asciiText(result.source)}:${asciiText(result.ref)}: ` +
          `${String(count('created'))} created, ${String(count('updated'))} updated, ` +
          `${String(count('unchanged'))} unchanged, ${String(result.events)} events`,
      );
      return { json: result, text: `${lines.join('\n')}\n` };
    },
  },
  {
    name: 'close-merged',
    summary: 'Close merged tickets whose pull request is merged',
    description:
      'Closes every merged ticket whose last linked pull request GitHub reports as merged: with its decision link as the decision record, or with no decision. A ticket with an open DECISION: comment and no decision link is skipped and left open, as is one whose pull request is not merged. Needs the GitHub CLI gh when there is anything to check.',
    group: 'planning',
    examples: [
      {
        command: 'agentboard close-merged --as orch',
        summary: 'Close the merged tickets whose pull request has merged',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_ACTOR,
      { code: 1, reason: 'gh-missing', meaning: 'The GitHub CLI gh was not found on PATH' },
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'closeMerged',
    run: (ctx) => {
      const result = closeMerged(ctx.board(), actorOf(ctx), { cwd: ctx.cwd, env: ctx.env });
      const lines = [
        ...result.closed.map(
          (c) =>
            `closed ${renderListLine(c.ticket)} (${
              'decision' in c.disposition
                ? `decision ${asciiText(c.disposition.decision)}`
                : 'no decision'
            })`,
        ),
        ...result.unmerged.map(
          (u) =>
            `unmerged ${renderListLine(u.ticket)} ` +
            `(PR ${asciiText(String(u.pr))} is ${asciiText(u.state)})`,
        ),
        ...result.skipped.map((k) => `skipped ${renderListLine(k.ticket)} (${k.reason})`),
        `close-merged: ${String(result.closed.length)} closed, ` +
          `${String(result.unmerged.length)} unmerged, ${String(result.skipped.length)} skipped`,
      ];
      return { json: result, text: `${lines.join('\n')}\n` };
    },
  },
  {
    name: 'mcp',
    summary: 'Serve the board as MCP tools over stdio',
    description:
      'Serves the board as MCP tools over stdio, one tool per board command (not init, watch, rebuild, sync, mcp, version or help), for agents that prefer tools to the shell. Runs until the client disconnects or the process gets SIGINT or SIGTERM. --as sets the default actor for tool calls that pass no as of their own, before AGENTBOARD_ACTOR. Nothing but protocol messages is written to stdout.',
    group: 'setup',
    examples: [
      { command: 'agentboard mcp', summary: 'Serve the board over MCP on stdio' },
      {
        command: 'agentboard mcp --as impl',
        summary: 'Serve the board with impl as the default actor for tool calls',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'The client disconnected or the server was stopped by a signal' },
      EXIT_USAGE,
      EXIT_NO_BOARD,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: null,
    run: () => {
      throw new BoardError(
        1,
        'streaming-command',
        'agentboard mcp serves MCP over stdio and runs only from the agentboard executable',
      );
    },
  },
  {
    name: 'version',
    summary: 'Print the agentboard version',
    description: 'Prints the version of this agentboard. Needs no board and no actor.',
    group: 'setup',
    examples: [{ command: 'agentboard version', summary: 'Print the version' }],
    exitCodes: [EXIT_OK, EXIT_USAGE],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: null,
    run: () => ({ json: { version: VERSION }, text: `${VERSION}\n` }),
  },
  {
    name: 'help',
    summary: 'Show the overview, or the help of one command',
    description:
      "With no topic, prints the overview of every command; with a command name (one or two words), prints that command's synopsis, arguments, exit codes and examples. agentboard <command> --help and -h are the same. Needs no board and no actor. With --json, prints the same help as JSON.",
    group: 'setup',
    examples: [
      { command: 'agentboard help', summary: 'Print the overview of every command' },
      { command: 'agentboard help claim', summary: 'Print the help of claim' },
      {
        command: 'agentboard help checklist tick --json',
        summary: 'Print the help of checklist tick as one JSON document',
      },
    ],
    exitCodes: [
      EXIT_OK,
      {
        code: 1,
        reason: 'usage',
        meaning: 'The topic is not a command (close matches are suggested)',
      },
    ],
    positionals: [
      positional('topic', 'string', 'Command name, or its first word', false),
      positional('subtopic', 'string', 'Second word of a two-word command name', false),
    ],
    flags: [],
    exclusive: [],
    writes: false,
    operation: null,
    run: (_ctx, values) =>
      helpOutput(
        HELP_SOURCE,
        [str(values, 'topic'), str(values, 'subtopic')].filter(
          (word): word is string => word !== undefined,
        ),
      ),
  },
];

/**
 * What help is rendered from: `COMMANDS`, `GLOBAL_FLAGS` and `VERSION`
 * (read by the `help` command at run time).
 */
export const HELP_SOURCE: HelpSource = {
  commands: COMMANDS,
  globalFlags: GLOBAL_FLAGS,
  version: VERSION,
};

/** The command named exactly `name` (e.g. `checklist tick`), or undefined. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
