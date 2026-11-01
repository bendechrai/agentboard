/**
 * The single command registry (board-cli: "Command surface"; add-board-core design.md:
 * "Library first, CLI second"). Every command, its positional arguments,
 * flags, mutually exclusive flag sets, whether it writes, its summary and
 * the library operation it calls are defined here once. The parser
 * (`parseArgs`) is driven by it, and the MCP tools (`src/mcp/tools.ts`)
 * are generated from it.
 */

import {
  claimTicket,
  closeTicket,
  commentTicket,
  handoffTicket,
  linkTicket,
  moveTicket,
  releaseTicket,
  renewTicket,
  scopeDispositionFromArgs,
  setChecklistItem,
  unqueueTicket,
  type ClaimedOutcome,
  type DispositionArgs,
  type LinkTarget,
  type QueuedOutcome,
} from '../board/actions.js';
import { SETTING_KEYS, getConfig, setConfig } from '../board/config.js';
import { formatDuration, isoTime, parseSetting, parseTimeout, parseTtl } from '../board/leases.js';
import { importChange, parseImportTarget } from '../board/import.js';
import { HOOK_EVENTS } from '../board/hook.js';
import { readInbox } from '../board/inbox.js';
import { refuseSecretLike } from '../board/secrets.js';
import { checkActorName } from './parse.js';
import { initBoard } from '../board/init.js';
import { initBoardWithRemote } from '../board/init-remote.js';
import { moveBoardIntoHost } from '../board/into-host.js';
import { boardHealth } from '../board/health.js';
import { closeMerged } from '../board/merged.js';
import { remoteReport, renderRemote } from '../board/remote.js';
import { syncBoard } from '../board/sync.js';
import { TASK_RULE, choicesMessage } from '../board/text.js';
import { parseTaskFilter, taskRefFromArgs, type TaskFilter } from '../board/resolve.js';
import { listTickets, newTicket, showRaw, showTicket } from '../board/tickets.js';
import type { WriteOutcome } from '../board/types.js';
import { waitForGrant } from '../board/wait.js';
import { watchInbox } from '../board/watch.js';
import { STATUSES, type Status } from '../events/schema.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Board } from '../store/board.js';
import { CACHE_FILE, CACHE_SCHEMA_VERSION } from '../store/cache.js';
import { BoardError } from '../store/errors.js';
import { checkCache, rebuild } from '../store/rebuild.js';
import { parseDuration, type HealthThresholds } from '../view/health.js';
import { helpOutput, type HelpSource } from '../guidance/help.js';
import { checkCommand } from '../guidance/check.js';
import { INIT_SUGGESTION, installCommand } from '../guidance/install.js';
import { VERSION } from '../version.js';
import {
  asciiText,
  renderCheck,
  renderHealth,
  renderImport,
  renderInboxLine,
  renderListLine,
  renderConfig,
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
 * write nor track a per-actor cursor otherwise ignore it, so `show T1 --as
 * impl` behaves exactly like `show T1`, but every command checks a given
 * `--as` (`checkActorName`, board-cli "Actor names are checked") and refuses
 * the reserved actor. Not required by the parser.
 */
export const ACTOR_FLAG: ArgSpec = {
  name: 'as',
  type: 'string',
  required: false,
  repeatable: false,
  summary:
    'Actor recorded on the event (falls back to AGENTBOARD_ACTOR); checked: 1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit',
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
  extra?: Partial<Pick<ArgSpec, 'required' | 'repeatable'>> & { cliOnly?: true },
): ArgSpec {
  return {
    name,
    type,
    required: extra?.required ?? false,
    repeatable: extra?.repeatable ?? false,
    summary,
    ...(extra?.cliOnly === true ? { cliOnly: true } : {}),
  };
}

function positional(
  name: string,
  type: 'string' | 'integer',
  summary: string,
  required = true,
  choices?: readonly string[],
): ArgSpec {
  return {
    name,
    type,
    required,
    repeatable: false,
    summary,
    ...(choices === undefined ? {} : { choices }),
  };
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

/** `agents install` takes `--command` or its deprecated alias `--mcp-command`, not both. */
const INSTALL_COMMAND_GROUP: ExclusiveGroup = {
  alternatives: [['command'], ['mcp-command']],
  required: false,
  reason: 'usage',
  message: 'agents install takes at most one of --command and --mcp-command',
};

/** `serve` opens the browser, never opens it, or decides by itself. */
const SERVE_OPEN_GROUP: ExclusiveGroup = {
  alternatives: [['open'], ['no-open']],
  required: false,
  reason: 'usage',
  message: 'serve takes at most one of --open and --no-open',
};

/**
 * `claim --wait --timeout <duration>`: on the command line the two are
 * given together (board-cli: "Waiting on the command line"). `--timeout`
 * is CLI-only, so over MCP this group does not apply and `wait` stands
 * alone (see `ArgSpec.cliOnly`).
 */
const WAIT_GROUP: ExclusiveGroup = {
  alternatives: [['wait', 'timeout']],
  required: false,
  reason: 'usage',
  message: 'claim takes --wait and --timeout together',
};

/** `release --force --reason <text>`: the two are given together. */
const FORCE_GROUP: ExclusiveGroup = {
  alternatives: [['force', 'reason']],
  required: false,
  reason: 'usage',
  message: 'release takes --force and --reason together',
};

/** `--ttl <duration>` of `claim` and `renew`. */
const TTL_FLAG: ArgSpec = flag(
  'ttl',
  'string',
  'Lease to ask for: <n>s, <n>m, <n>h or <n>d, from 30s to 7d',
);

/** The setting keys of `config set` and `config get`. */
const KEY_SUMMARY = 'Setting key: lease.grace or queue.window';

/** The decision dispositions of `close`. */
const CLOSE_GROUP: ExclusiveGroup = {
  alternatives: [['decision-recorded-in'], ['no-decision']],
  required: true,
  reason: 'no-disposition',
  message: CLOSE_RULE,
};

/**
 * `--unplanned <reason>`, the unplanned scope disposition of `move` and
 * `close` (board-cli: "Scope disposition on the command line").
 */
export const UNPLANNED_FLAG: ArgSpec = flag(
  'unplanned',
  'string',
  'Record the work as unplanned scope, with the reason it was never planned',
);

/**
 * The disposition flags of `move` and `close`, in this order: `--task`,
 * `--change`, `--group` (`TASK_FLAGS`), `--unplanned` and
 * `--allow-secret-like` (which only affects `--unplanned`). The MCP
 * properties `task`, `change`, `group`, `unplanned` and
 * `allow-secret-like` of `board_move` and `board_close` come from here.
 */
export const DISPOSITION_FLAGS: readonly ArgSpec[] = [
  ...TASK_FLAGS,
  UNPLANNED_FLAG,
  ALLOW_SECRET_FLAG,
];

/**
 * The scope dispositions of `move` and `close`: at most one of `--task`,
 * `--change` with `--group`, or `--unplanned` (board-cli: "Scope
 * disposition on the command line", scenario "Both dispositions are a usage
 * error"). Not required: a ticket that has a task reference or an
 * unplanned disposition already needs none.
 */
export const DISPOSITION_GROUP: ExclusiveGroup = {
  alternatives: [['task'], ['change', 'group'], ['unplanned']],
  required: false,
  reason: 'usage',
  message: 'give at most one of --task, --change with --group, or --unplanned',
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
/**
 * An actor name that fails the actor check (board-cli "Actor names are
 * checked"): a given `--as` on every command, `AGENTBOARD_ACTOR` when it
 * is the actor of a command that needs one, and the `--to` of `handoff`.
 */
const EXIT_INVALID_ACTOR: ExitCodeSpec = {
  code: 1,
  reason: 'invalid-actor',
  meaning:
    'The actor name (--as, AGENTBOARD_ACTOR or --to) matches a secret pattern or is not of the actor form; nothing is written',
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
/**
 * A ticket with neither a task reference nor an unplanned disposition
 * entering `merged` (`move`, `handoff`) or being closed (`close`) without
 * `--task` or `--unplanned` (board-openspec-integration: "Scope
 * disposition at merge and close").
 */
const EXIT_SCOPE_DISPOSITION: ExitCodeSpec = {
  code: 4,
  reason: 'needs-scope-disposition',
  meaning:
    'The ticket has no task reference and no unplanned disposition: give --task or --unplanned',
};
/** `--unplanned` on a ticket that has a task reference (`move`, `close`). */
const EXIT_ALREADY_LINKED: ExitCodeSpec = {
  code: 4,
  reason: 'already-linked',
  meaning: 'The ticket already has a task reference, so --unplanned does not apply',
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

/**
 * A status argument; anything but one of `STATUSES` is a usage error that
 * names the argument and lists the statuses but never repeats the value:
 * exactly `choicesMessage(command, argument, STATUSES)`, that is `move
 * takes <status> as one of todo, tests, implementing, review, merged,
 * blocked` for `move <status>`, and `handoff takes --status as one of
 * ...` and `list takes --status as one of ...` for those commands'
 * `--status`.
 */
function status(text: string, command: string, argument: string): Status {
  const found = STATUSES.find((s) => s === text);
  if (found === undefined) {
    throw new BoardError(1, 'usage', choicesMessage(command, argument, STATUSES));
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

/** The human line of a `claim --wait` that joined or found itself queued. */
function queuedLine(out: QueuedOutcome): string {
  return `queued for ${out.ticket} at position ${String(out.position)}, held by ${out.holder === null ? '-' : asciiText(out.holder)}\n`;
}

/**
 * The output of a claim that holds the ticket: a retried claim says so, a
 * claim with a lease names the `renew` that confirms it and by when.
 */
function claimedOutput(out: ClaimedOutcome, actor: string): CommandOutput {
  const { lease } = out.ticket;
  if (out.hash === null) {
    const expiry = lease === null ? '' : ` (lease expires ${isoTime(lease.expiresAt)})`;
    return written(out, `already claimed by ${asciiText(actor)}${expiry}\n`);
  }
  const confirm =
    lease === null
      ? ''
      : `confirm the lease with 'agentboard renew ${out.ticket.id} --as ${asciiText(actor)}' before ${isoTime(lease.expiresAt)}\n`;
  return written(out, '', confirm);
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

/**
 * The scope disposition flags of `move` and `close` (`DISPOSITION_FLAGS`),
 * as `scopeDispositionFromArgs` takes them.
 */
function dispositionArgs(values: ArgValues): DispositionArgs {
  return {
    task: str(values, 'task'),
    change: str(values, 'change'),
    group: str(values, 'group'),
    unplanned: str(values, 'unplanned'),
    allowSecretLike: bool(values, 'allow-secret-like'),
  };
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
      'malformed change name: --change must be non-empty and contain no #',
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

/**
 * `health [--stale-after <duration>] [--blocked-after <duration>]
 * [--unplanned-within <duration>] [--check]` (board-insights: "Health
 * command", "Durations").
 *
 * First, before the board is located or opened, each of `--stale-after`,
 * `--blocked-after` and `--unplanned-within` that is given is parsed, in
 * that order, with `parseDuration` (`src/view/health.ts`); a value it
 * refuses is `BoardError(1, 'usage')` whose message names the flag and the
 * accepted forms but not the value given, exactly:
 * `invalid --stale-after: a duration is <n>m, <n>h or <n>d with <n> a positive integer of at most 5 digits (for example 30m, 2h or 1d)`.
 * When several are invalid, the first in that order is reported. So a
 * malformed duration exits 1 even where there is no board.
 *
 * Then `boardHealth(ctx.board(), { thresholds, check })`, with only the
 * given thresholds (the others default; `--unplanned-within` is
 * `thresholds.unplannedWithin`), `check` from `--check`, `now` and the
 * event cache left to their defaults. The board is opened as any read
 * command opens it (with catch-up). The output is
 * `{ json: report, text: renderHealth(report) }`, with no `exitCode` and no
 * warnings, whatever the report contains (a cache that differs and
 * unplanned scope included): findings are data. Needs no actor (`--as` is
 * accepted and ignored).
 */
function runHealth(ctx: RunContext, values: ArgValues): CommandOutput {
  const thresholds: Partial<HealthThresholds> = {};
  const staleAfter = durationFlag(values, 'stale-after');
  if (staleAfter !== undefined) {
    thresholds.staleAfter = staleAfter;
  }
  const blockedAfter = durationFlag(values, 'blocked-after');
  if (blockedAfter !== undefined) {
    thresholds.blockedAfter = blockedAfter;
  }
  const unplannedWithin = durationFlag(values, 'unplanned-within');
  if (unplannedWithin !== undefined) {
    thresholds.unplannedWithin = unplannedWithin;
  }
  const report = boardHealth(ctx.board(), { thresholds, check: bool(values, 'check') });
  return { json: report, text: renderHealth(report) };
}

/**
 * The duration flag `name` in milliseconds (`parseDuration`), or undefined
 * when absent; a value it refuses is `BoardError(1, 'usage')`.
 */
function durationFlag(values: ArgValues, name: string): number | undefined {
  const text = str(values, name);
  if (text === undefined) {
    return undefined;
  }
  const ms = parseDuration(text);
  if (ms === null) {
    throw new BoardError(
      1,
      'usage',
      `invalid --${name}: a duration is <n>m, <n>h or <n>d with <n> a positive integer of at most 5 digits (for example 30m, 2h or 1d)`,
    );
  }
  return ms;
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
 * `list`, `claim`, `renew`, `unqueue`, `release`, `move`, `comment`,
 * `handoff`, `link`, `checklist tick`, `checklist untick`, `close`,
 * `inbox`, `watch`, `serve`, `top`, `health`, `rebuild`, `sync`,
 * `remote`, `import-change`, `close-merged`, `config set`, `config get`,
 * `mcp` (the board-cli order), then `agents install` and `agents check`,
 * `version` and `help`.
 *
 * Every command refuses the reserved actor `agentboard` (`--as agentboard`,
 * and for a command that needs an actor `AGENTBOARD_ACTOR=agentboard`)
 * with `BoardError(1, 'usage')` before the board is opened
 * (`refuseReservedActor`, `src/cli/parse.ts`).
 *
 * Every entry carries the help data of record (`description`, `group`,
 * `examples`, `exitCodes`; see `CommandSpec`), rendered by
 * `src/guidance/help.ts`.
 *
 * `run` of each command calls the named operation and returns its result
 * as the `--json` document, with this human rendering:
 * - `init`: `InitResult`; text: its `message`; `warnings`: the result's
 *   `warnings`, printed to stderr by `runCli`. With `--remote <url>`:
 *   `initBoardWithRemote(url, ...)` and its `InitRemoteResult` (the same
 *   ten keys plus `action`, `remoteUrl` and `sync`), rendered the same
 *   way; an empty `--remote` value is a usage error. With `--into-host`:
 *   `moveBoardIntoHost(...)` and its `IntoHostResult` (the same ten keys
 *   plus `action`, `keptAt`, `oldRemoteUrl` and `sync`), rendered the same
 *   way; `--remote` with `--into-host` is a usage error (the exclusive
 *   group).
 * - `new`: `WriteOutcome`; text: `created <full id>` then the `list` line.
 * - `show`: `ShowResult` (`showTicket` with `now` = `Date.now()`, read
 *   once; `--raw`: `RawEvent[]`); text: `renderShow` (`--raw`: each raw
 *   event's `text` on its own line).
 * - `list`: `TicketDocument[]` (`listTickets` with `now` = `Date.now()`,
 *   read once); text: one `renderListLine(ticket, now)` per ticket, with
 *   the same `now`, so the assignee token and the `--json` lease states
 *   agree.
 * - `claim [--ttl <duration>] [--wait --timeout <duration>]`: `--ttl` is
 *   parsed with `parseTtl` and `--timeout` with `parseTimeout`
 *   (`src/board/leases.ts`), and `--wait` without `--ttl` is
 *   `BoardError(1, 'usage')` naming `--ttl`, all before `ctx.board()`, so
 *   a malformed value exits 1 even where there is no board and writes
 *   nothing; then `claimTicket(board, actor, { id, ttl, wait })`. A
 *   `ClaimedOutcome` is the `--json` document; its text is the `list` line
 *   of the ticket, preceded, when nothing was written, by the line
 *   `already claimed by <actor>` (with ` (lease expires <iso>)` before the
 *   newline when the ticket has a lease), and followed, when a claim with
 *   a lease was written (a takeover included), by the line
 *   `confirm the lease with 'agentboard renew <full id> --as <actor>' before <iso expiresAt>`.
 *   A `QueuedOutcome` is the `--json` document as it is (exactly `{queued,
 *   position, holder, ticket}`); its text is the line
 *   `queued for <full id> at position <n>, held by <holder or ->`.
 *   Times are `isoTime`, actors through `asciiText`. Over MCP, `timeout`
 *   is not an argument (`ArgSpec.cliOnly`), so `board_claim` with `wait`
 *   joins and returns at once. `run` with `--timeout` given (only the
 *   command line can give it), after the validation above, throws
 *   `BoardError(1, 'streaming-command')` saying that claim --wait blocks
 *   until the ticket is granted and runs only from the agentboard
 *   executable, writing nothing: the synchronous `runCli` never blocks.
 *   `streams` is true exactly when `--wait` is given, so `runCliAsync`
 *   runs `stream` for `claim --wait` (the parser has already required
 *   `--timeout` with it) and `run` otherwise. `stream` validates exactly
 *   as `run` does, before `ctx.board()` (so its refusals are the same exit
 *   1 errors, and none writes anything), then runs `waitForGrant(board,
 *   actor, { id, ttl, timeout }, { signal: io.signal, onQueued, onWarning
 *   })` (`src/board/wait.ts`). Human output: `onQueued` prints the queued
 *   line above; a `ClaimedOutcome` result prints exactly the text `run`
 *   prints for it (the `list` line, with `already claimed by <actor>`
 *   before it when nothing was written, or the confirm line after it); a
 *   `GrantedOutcome` prints the `list` line of its ticket
 *   (`renderListLine(ticket)`) and then
 *   `accept the grant with 'agentboard renew <full id> --as <actor>' before <isoTime(acceptBy)>`.
 *   With `--json`, `onQueued` prints the `QueuedOutcome` as one JSON line
 *   and the result is printed as one more JSON line (the `ClaimedOutcome`
 *   or the `GrantedOutcome` as it is), like `watch --json`; a refusal is
 *   the error document `runCliAsync` prints after them. `onWarning` lines
 *   go to stderr as `agentboard: <line>`. A claim that holds the ticket
 *   at once prints exactly what `run` prints for it, nothing more.
 * - `renew [--ttl <duration>]`: `--ttl` parsed with `parseTtl` before
 *   `ctx.board()`; `renewTicket`; `WriteOutcome` and the `list` line.
 * - `unqueue`: `unqueueTicket`; `WriteOutcome` and the `list` line.
 * - `release [--force --reason <text>] [--allow-secret-like]`: the reason
 *   goes through `refuseSecretLike` before `ctx.board()`, then
 *   `releaseTicket` with `force`, `reason` and `allowSecretLike`;
 *   `WriteOutcome` and the `list` line.
 * - `config set <key> <value>`: `<key>` is one of `SETTING_KEYS` (the
 *   parser refuses any other, `ArgSpec.choices`), `<value>` is parsed with
 *   `parseSetting` before `ctx.board()`; then `setConfig`. `--json`:
 *   `ConfigSetResult`; text: `set <key> <formatDuration(value)>` and a
 *   newline. Writes, so it needs an actor. Not an MCP tool.
 * - `config get [<key>]`: `getConfig`; `--json`: `ConfigResult`; text:
 *   `renderConfig(result, <key given>)`. Needs no actor. Not an MCP tool.
 * - other writing commands: `WriteOutcome` (`ChecklistOutcome` for
 *   `checklist tick|untick`); text: the `list` line of the resulting
 *   ticket, followed, for a tick, by the reminder `message`.
 * - `inbox`: `InboxResult` (`readInbox` with `--peek` and `--since`); text:
 *   one `renderInboxLine(entry, actor)` per entry, nothing when there is
 *   none. Tracks a cursor, so it requires an actor.
 * - `watch`: streams (`stream` calls `watchInbox` with the stop signal and
 *   prints each entry as one line, `renderInboxLine(entry, actor)` or its
 *   JSON, see `runCliAsync`; each `onWarning` line
 *   goes to `io.stderr` as `agentboard: <line>` and a newline); its `run` throws
 *   `BoardError(1, 'streaming-command')` saying that watch streams and runs
 *   only from the agentboard executable. Tracks a cursor, so it requires an
 *   actor.
 * - `serve`: streams (`stream` imports `src/web/serve.ts` dynamically, so
 *   no other command loads `node:http`, and runs `serveCommand`); its `run`
 *   throws `BoardError(1, 'streaming-command')` saying that serve runs a
 *   web server and runs only from the agentboard executable. Writes no
 *   event and tracks no cursor, so it needs no actor. Calls no library
 *   operation of `src/index.ts` (`operation` null).
 * - `top`: streams (`stream` imports `src/tui/terminal.ts` dynamically, so
 *   no other command loads the terminal driver, and runs `topCommand`);
 *   `terminal` true, so it is the one command given `StreamIo.terminal`.
 *   Its `run` throws `BoardError(1, 'streaming-command')` saying that top
 *   drives the terminal and runs only from the agentboard executable.
 *   Writes no event and tracks no cursor, so it needs no actor; no flags
 *   of its own; `operation` null.
 * - `health`: `HealthReport` (`boardHealth`); text: `renderHealth`. See
 *   `runHealth` for the duration flags, the check and the exit code (0
 *   whatever the report contains). Needs no actor.
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
 * - `import-change <name> [--dry-run] [--force]`: `ImportResult`
 *   (`importChange` with `dryRun` and `force` from the flags); `name` goes
 *   through `parseImportTarget` (a plain name is an OpenSpec change,
 *   `<source>:<ref>` names another source). Text: `renderImport(result)`.
 *   A dry run exits 0 whatever it finds. `reconcile-blocked` and
 *   `reconcile-ambiguous` are thrown by `importChange` (exit 4) and printed
 *   like any refusal, with their message and hint.
 * - `close-merged`: `CloseMergedResult` (with `cwd` and `env` from the
 *   context and the default `gh` runner). Text: for each closed ticket
 *   `closed ` plus its `list` line plus ` (decision <path>)` or
 *   ` (no decision)`; for each unmerged one `unmerged ` plus its `list`
 *   line plus ` (PR <pr> is <state>)`; for each skipped one `skipped `
 *   plus its `list` line plus ` (<reason>)`; then
 *   `close-merged: <c> closed, <u> unmerged, <s> skipped`.
 * - `init` text ends with the line `INIT_SUGGESTION`
 *   (`src/guidance/install.ts`), after its `message` line, whether or not
 *   the board already existed; its `--json` document is unchanged.
 * - `agents install [--target <t>]... [--mcp-command <executable>]
 *   [--force]`: `installCommand` (see
 *   `src/guidance/install.ts`). Needs no board and no actor (`--as` is
 *   accepted and ignored); exits 1 with the full result when a target was
 *   refused.
 * - `agents check`: `checkCommand` (see `src/guidance/check.ts`). Needs no
 *   board and no actor; exits 1 with the full report when a target found
 *   is not current.
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
 * - `help [<topic>] [<subtopic>] [--role <role>]`: `helpOutput(HELP_SOURCE,
 *   <the given words>, <the --role value>)`: the overview, one command's
 *   help, or (topic `agents`) the agent guide with an optional role
 *   checklist, as text or (`--json`) one JSON document. Needs no board and
 *   no actor. `parseArgs` also turns `agentboard`, `--help`, `-h` and
 *   `<command> --help` into `help`.
 *
 * Argument mapping: `--change`/`--group`/`--task` go through
 * `taskRefFromArgs`; `list --change <name>` is `list --task openspec:<name>`
 * (the two are exclusive); `list --task` goes through `parseTaskFilter`; a status
 * argument must be one of `STATUSES` or it is `BoardError(1, 'usage')`
 * listing them; `link --pr` is a number when it is all digits (a positive
 * safe integer), otherwise the string; `close --decision-recorded-in` and
 * `link --decision` pass `ctx.cwd` and `ctx.env` so the path is resolved
 * and recorded by `treePath`.
 *
 * The scope disposition of `move` and `close` (`DISPOSITION_FLAGS`,
 * `DISPOSITION_GROUP`; board-cli: "Scope disposition on the command
 * line"): `run` builds it with `scopeDispositionFromArgs` from `--task`,
 * `--change`, `--group`, `--unplanned` and `--allow-secret-like`, and for
 * `move` refuses a disposition whose target is not `merged` (`BoardError(1,
 * 'usage')` saying a disposition applies only to a move to `merged`, the
 * omitted target included), both BEFORE calling `ctx.board()`: so a usage
 * error, a malformed task reference, an empty or secret-like reason exit 1
 * before the board is opened and even where there is no board. Then
 * `moveTicket` or `closeTicket` is called with `disposition` and
 * `allowSecretLike`; `close-merged` passes no disposition (a merged ticket
 * without one is skipped and listed, see `closeMerged`).
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    summary: 'Create the board for this project',
    description:
      'Creates the board for the project containing the current directory: a .board directory that is a git repository of its own, ignored by the host project. Running it again on an existing board changes nothing. With --remote <url> the board is a standalone board shared through the repository at <url>, kept out of the host repository (for a public project, or a git host that refuses custom refs): an existing board there is cloned, an empty repository receives the new board on the first sync, a missing local path is created as a bare repository first, and a standalone board without a remote gets <url> as origin and is synced. With --into-host an existing standalone board is moved into the host repository (its history becomes refs/agentboard/board and .board a worktree of the host), keeping every commit; it refuses while the board has events that are not committed or not pushed, keeps the old repository under the host .git directory, runs sync, and can be run again after an interruption. --remote and --into-host are mutually exclusive. Needs git; needs no actor.',
    group: 'setup',
    examples: [
      { command: 'agentboard init', summary: 'Create the board for this project' },
      {
        command: 'agentboard init --remote git@example.com:me/board.git',
        summary: 'Keep the board in a repository of its own, shared through that URL',
      },
      {
        command: 'agentboard init --remote ../boards/project.git',
        summary: 'Share the board through a local bare repository, created when it is missing',
      },
      {
        command: 'agentboard init --into-host',
        summary: 'Move an existing standalone board into the host repository, keeping its history',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'The board was created, already existed, or was moved into the host repository' },
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      { code: 1, reason: 'git-missing', meaning: 'git could not be run' },
      {
        code: 1,
        reason: 'git-too-old',
        meaning:
          'With --into-host: a board in the host repository needs git 2.32 or later; nothing changed',
      },
      {
        code: 1,
        reason: 'no-host-repository',
        meaning:
          'With --into-host: the board was not found through a git repository (outside one, or with AGENTBOARD_DIR set); nothing changed',
      },
      {
        code: 1,
        reason: 'ambiguous-remote',
        meaning:
          'The host repository has several remotes and none is origin or the upstream of its branch; nothing was created',
      },
      {
        code: 1,
        reason: 'not-a-board',
        meaning:
          'The repository at --remote <url> has a branch without an events/ directory; nothing was created',
      },
      {
        code: 1,
        reason: 'remote-mismatch',
        meaning: 'The existing standalone board already has a remote with another URL; nothing changed',
      },
      {
        code: 1,
        reason: 'board-in-host',
        meaning:
          'The existing board is in the host repository (refs/agentboard/board), so --remote does not apply; nothing changed',
      },
      {
        code: 2,
        reason: 'board-not-a-repository',
        meaning:
          'With --remote: .board exists but is not a board (a directory with other content, a file, a dangling link); move it aside; nothing was created',
      },
      {
        code: 3,
        reason: 'remote-unreachable',
        meaning:
          'The repository at --remote <url> cannot be read: create an empty repository there and check your access; nothing was created',
      },
      {
        code: 3,
        reason: 'sync-failed',
        meaning:
          'The sync that --remote or --into-host runs failed (the remote rejected the push, or is unreachable); the board and its remote are kept, and a move stays done. With --into-host also: the standalone remote cannot be reached, or the ref update in the host repository lost a race; nothing was moved',
      },
      {
        code: 3,
        reason: 'sync-conflict',
        meaning:
          'The sync that --remote or --into-host runs stopped on a conflict, left in the board repository for a human; with --into-host also a conflict while integrating the host board ref, left in the temporary worktree the message names (resolve, git add, git rebase --continue there, then init --into-host again), the old board untouched',
      },
      {
        code: 3,
        reason: 'sync-in-progress',
        meaning:
          'With --into-host: a rebase or merge is in progress in the standalone board repository, or the rebase of an earlier move is still stopped in its temporary worktree (finish it there, then run init --into-host again); nothing changed',
      },
      {
        code: 3,
        reason: 'detached-head',
        meaning:
          'With --into-host: the standalone board repository has a detached HEAD; nothing changed',
      },
      {
        code: 4,
        reason: 'unsynced',
        meaning:
          'With --into-host: the standalone board has an event file that is not committed, or its branch has commits its remote does not; run agentboard sync first; nothing changed',
      },
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [
      flag(
        'remote',
        'string',
        'URL or local path of the repository that holds the board (keeps the board out of the host repository)',
      ),
      flag(
        'into-host',
        'boolean',
        'Move the existing standalone board into the host repository, keeping its history',
      ),
    ],
    exclusive: [
      {
        alternatives: [['remote'], ['into-host']],
        required: false,
        reason: 'usage',
        message: 'init takes --remote <url> or --into-host, not both',
      },
    ],
    writes: false,
    operation: 'initBoard',
    run: (ctx, values) => {
      const url = str(values, 'remote');
      const result = bool(values, 'into-host')
        ? moveBoardIntoHost({ cwd: ctx.cwd, env: ctx.env })
        : url === undefined
          ? initBoard({ cwd: ctx.cwd, env: ctx.env })
          : initBoardWithRemote(url, { cwd: ctx.cwd, env: ctx.env });
      return {
        json: result,
        text: `${result.message}\n${INIT_SUGGESTION}\n`,
        warnings: result.warnings,
      };
    },
  },
  {
    name: 'new',
    summary: 'Create a ticket',
    description:
      'Creates a ticket in todo, unassigned. Every ticket names the planning task it implements (--task, or --change with --group for an OpenSpec task group) or says why it has none (--adhoc). An ad hoc ticket is worked normally; its task link or unplanned disposition (--task or --unplanned on move or close) is given when it is merged or closed. Checklist lines become the ticket checklist. Text that looks like a secret is refused unless --allow-secret-like is given.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard new "Implement the parser" --change add-parser --group 2 --as orch',
        summary: 'Create a ticket for task group 2 of the OpenSpec change add-parser',
      },
      {
        command: 'agentboard new "Fix flaky test" --adhoc "found in CI" --label ci --as orch',
        summary: 'Create an ad hoc ticket, worked like any other until it is merged or closed',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
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
      flag(
        'adhoc',
        'string',
        'Reason the ticket has no task reference; it is worked like any other ticket',
      ),
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
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_INVALID_ACTOR, ...READ_ID_EXITS, EXIT_INTEGRITY],
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
      const shown = showTicket(ctx.board(), id, { now: Date.now() });
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
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_INVALID_ACTOR, EXIT_TASK_REF, EXIT_NO_BOARD, EXIT_INTEGRITY],
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
      const now = Date.now();
      const tickets = listTickets(
        ctx.board(),
        {
          status: given === undefined ? undefined : status(given, 'list', '--status'),
          assignee: str(values, 'assignee'),
          task,
          labels: list(values, 'label'),
          closed: bool(values, 'closed'),
        },
        { now },
      );
      return { json: tickets, text: tickets.map((t) => `${renderListLine(t, now)}\n`).join('') };
    },
  },
  {
    name: 'claim',
    summary: 'Assign an unassigned ticket to yourself',
    description:
      'Assigns an unassigned ticket to the actor. Claim a ticket before starting work on it. If another actor holds it the claim is refused (exit 4, already-assigned) naming the holder and, when it holds a lease, when the lease expires and from when the ticket can be claimed; a claim by the current holder succeeds without writing anything, so retrying a claim is safe. With --ttl the claim holds a lease: it starts as a grace lease (the board setting lease.grace, 2 minutes by default) and must be confirmed with agentboard renew <id> before the grace ends, or it lapses; a lease that lapsed more than 60 seconds ago can be taken over by a claim with --ttl. With --wait (and --ttl, and on the command line --timeout) a ticket that is held, or has waiters, is not refused: the actor joins its queue and the ticket is granted to the waiters in the order they joined (exit 4, queued, for a claim without --wait while others wait). On the command line the claim then blocks in the foreground: it prints its position in the queue and waits until the ticket is granted to it, then exits 0 and prints the agentboard renew command that accepts the grant and the time by which to run it. When --timeout passes first it leaves the queue and exits 4 (wait-timeout); interrupted (SIGINT or SIGTERM) it leaves the queue and exits 4 (wait-interrupted), never 0, so exit 0 always means the actor holds the ticket. Over MCP board_claim with wait never blocks: it joins and returns, and the grant arrives in the inbox.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard claim 01J9K3 --as impl', summary: 'Claim ticket 01J9K3 as impl' },
      {
        command: 'agentboard claim 01J9K3 --ttl 30m --as merger-1',
        summary: 'Claim ticket 01J9K3 with a 30 minute lease, to confirm with renew',
      },
      {
        command: 'agentboard claim 01J9K3 --ttl 30m --wait --timeout 10m --as merger-2',
        summary: 'Wait up to 10 minutes in the queue for ticket 01J9K3',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Claimed, already held by the actor, or granted after waiting' },
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      {
        code: 4,
        reason: 'already-assigned',
        meaning: 'Another actor holds the ticket (named in the message, with its lease)',
      },
      {
        code: 4,
        reason: 'queued',
        meaning: 'Other actors are waiting for the ticket and have priority: use --wait',
      },
      {
        code: 4,
        reason: 'wait-timeout',
        meaning: 'The --timeout passed before the ticket was granted; the actor left the queue',
      },
      {
        code: 4,
        reason: 'wait-interrupted',
        meaning: 'The wait was interrupted (SIGINT or SIGTERM); the actor left the queue',
      },
      {
        code: 4,
        reason: 'invalid-queue',
        meaning: 'While waiting, the actor left the queue elsewhere or its grant passed on',
      },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      TTL_FLAG,
      flag('wait', 'boolean', 'Join the queue when the ticket cannot be claimed at once'),
      flag(
        'timeout',
        'string',
        'With --wait: give up after <n>s, <n>m, <n>h or <n>d, at most 1d (command line only)',
        { cliOnly: true },
      ),
    ],
    exclusive: [WAIT_GROUP],
    writes: true,
    operation: 'claimTicket',
    run: (ctx, values) => {
      const ttlText = str(values, 'ttl');
      const ttl = ttlText === undefined ? undefined : parseTtl(ttlText);
      const timeout = str(values, 'timeout');
      if (timeout !== undefined) {
        parseTimeout(timeout);
      }
      const wait = bool(values, 'wait');
      if (wait && ttl === undefined) {
        throw new BoardError(
          1,
          'usage',
          'claim --wait needs --ttl <duration>, the lease to ask for once the ticket is granted',
        );
      }
      if (timeout !== undefined) {
        // Only `runCliAsync` (the executable) can block; see `stream`.
        throw new BoardError(
          1,
          'streaming-command',
          'agentboard claim --wait --timeout blocks in the foreground and runs only from the agentboard executable',
        );
      }
      const actor = actorOf(ctx);
      const out = claimTicket(ctx.board(), actor, { id: req(values, 'id'), ttl, wait });
      if (out.queued === true) {
        return { json: out, text: queuedLine(out) };
      }
      return claimedOutput(out, actor);
    },
    streams: (values) => bool(values, 'wait'),
    stream: async (ctx, values, io) => {
      // The same checks in the same order as `run`: --ttl, --timeout, then
      // --wait without --ttl, so both entry points give the same first error.
      const ttlText = str(values, 'ttl');
      const ttl = ttlText === undefined ? undefined : parseTtl(ttlText);
      const timeoutText = str(values, 'timeout');
      const timeout = timeoutText === undefined ? undefined : parseTimeout(timeoutText);
      if (ttl === undefined) {
        throw new BoardError(
          1,
          'usage',
          'claim --wait needs --ttl <duration>, the lease to ask for once the ticket is granted',
        );
      }
      if (timeout === undefined) {
        throw new BoardError(
          1,
          'usage',
          'claim --wait needs --timeout <duration> on the command line, how long to wait at most',
        );
      }
      const actor = actorOf(ctx);
      const print = (output: CommandOutput): void => {
        io.stdout(io.json ? `${JSON.stringify(output.json)}\n` : output.text);
      };
      const out = await waitForGrant(
        ctx.board(),
        actor,
        { id: req(values, 'id'), ttl, timeout },
        {
          signal: io.signal,
          onQueued: (queued) => {
            print({ json: queued, text: queuedLine(queued) });
          },
          onWarning: (line) => {
            io.stderr?.(`agentboard: ${line}\n`);
          },
        },
      );
      if ('grant' in out) {
        print({
          json: out,
          text: `${renderListLine(out.ticket)}\naccept the grant with 'agentboard renew ${out.ticket.id} --as ${asciiText(actor)}' before ${isoTime(out.acceptBy)}\n`,
        });
        return;
      }
      print(claimedOutput(out, actor));
    },
  },
  {
    name: 'renew',
    summary: 'Renew the lease of a ticket you hold',
    description:
      'Sets the lease of a ticket the actor holds to --ttl from now, or to the ttl it asked for when --ttl is not given, and confirms it. Run it as the first action of real work after a claim with --ttl (an unconfirmed claim lapses after the grace period), to accept a ticket granted from the queue, and again at about half the ttl. Exit 4 not-assignee means the lock was lost: stop the critical work.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard renew 01J9K3 --as merger-1',
        summary: 'Confirm or renew the lease on ticket 01J9K3 with the ttl it asked for',
      },
      {
        command: 'agentboard renew 01J9K3 --ttl 1h --as merger-1',
        summary: 'Renew the lease on ticket 01J9K3 for one hour from now',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      {
        code: 4,
        reason: 'not-assignee',
        meaning: 'The actor does not hold the ticket: the lock was lost',
      },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [TTL_FLAG],
    exclusive: [],
    writes: true,
    operation: 'renewTicket',
    run: (ctx, values) => {
      const ttlText = str(values, 'ttl');
      const ttl = ttlText === undefined ? undefined : parseTtl(ttlText);
      return written(renewTicket(ctx.board(), actorOf(ctx), { id: req(values, 'id'), ttl }));
    },
  },
  {
    name: 'unqueue',
    summary: 'Leave the queue of a ticket you are waiting for',
    description:
      'Removes the actor from the queue of a ticket it joined with claim --wait, so it is no longer granted the ticket.',
    group: 'lifecycle',
    examples: [
      {
        command: 'agentboard unqueue 01J9K3 --as merger-3',
        summary: 'Stop waiting for ticket 01J9K3',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_NO_BOARD,
      {
        code: 4,
        reason: 'invalid-queue',
        meaning: 'The actor is not in the queue of the ticket',
      },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'unqueueTicket',
    run: (ctx, values) =>
      written(unqueueTicket(ctx.board(), actorOf(ctx), { id: req(values, 'id') })),
  },
  {
    name: 'release',
    summary: 'Give up a ticket you hold',
    description:
      'Clears the assignment of a ticket the actor holds, leaving its status unchanged, so another actor (or the next waiter) can have it. Only the current assignee can release a ticket, except with --force and a --reason, which breaks another actor\'s hold and records who did it and why; reserve it for the orchestrator or a human, after checking the holder is gone.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard release 01J9K3 --as impl', summary: 'Give up ticket 01J9K3' },
      {
        command:
          'agentboard release 01J9K3 --force --reason "merger-1 crashed" --as orchestrator',
        summary: 'Break the hold of a crashed holder on ticket 01J9K3',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_SECRET,
      EXIT_NO_BOARD,
      { code: 4, reason: 'not-assignee', meaning: 'The actor does not hold the ticket' },
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      flag('force', 'boolean', "Release another actor's hold (with --reason)"),
      flag('reason', 'string', 'Why the hold is broken (with --force)'),
      ALLOW_SECRET_FLAG,
    ],
    exclusive: [FORCE_GROUP],
    writes: true,
    operation: 'releaseTicket',
    run: (ctx, values) => {
      const reason = str(values, 'reason');
      const allowSecretLike = bool(values, 'allow-secret-like');
      // Checked before the board is opened, like comment text, so a
      // token-shaped reason is refused even where there is no board.
      if (reason !== undefined) {
        refuseSecretLike([reason], allowSecretLike);
      }
      return written(
        releaseTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          force: bool(values, 'force'),
          reason,
          allowSecretLike,
        }),
      );
    },
  },
  {
    name: 'move',
    summary: 'Move a ticket to another status (a blocked ticket returns to its origin)',
    description:
      'Moves a ticket to another status: todo, tests, implementing, review, merged or blocked. Permitted moves: todo to tests, tests to implementing, implementing to review, review back to implementing or tests, review to merged, any open status to blocked. A blocked ticket moved with no status returns to the status it was blocked from. merged is terminal. An ad hoc ticket moves like any other, but a move to merged needs its scope disposition on the same command when it has none yet: --task (or --change with --group) links the task it delivered, --unplanned records that the work was never planned; without one the move exits 4 with needs-scope-disposition. Never create an issue, task file or task reference only to satisfy it.',
    group: 'lifecycle',
    examples: [
      { command: 'agentboard move 01J9K3 blocked --as impl', summary: 'Block ticket 01J9K3' },
      {
        command: 'agentboard move 01J9K3 --as impl',
        summary: 'Return a blocked ticket to the status it was blocked from',
      },
      {
        command: 'agentboard move 01J9K3 merged --unplanned "production hotfix" --as orch',
        summary: 'Merge an ad hoc ticket, recording that its work was never planned',
      },
      {
        command: 'agentboard move 01J9K3 merged --task openspec:add-parser#2 --as orch',
        summary: 'Merge an ad hoc ticket, linking the planned task it turned out to deliver',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      EXIT_ACTOR,
      {
        code: 1,
        reason: 'missing-status',
        meaning: 'No target status was given and the ticket is not blocked',
      },
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_SECRET,
      EXIT_TASK_REF,
      EXIT_NO_BOARD,
      EXIT_TRANSITION,
      EXIT_SCOPE_DISPOSITION,
      EXIT_ALREADY_LINKED,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID, positional('status', 'string', 'Target status', false)],
    flags: [...DISPOSITION_FLAGS],
    exclusive: [DISPOSITION_GROUP],
    writes: true,
    operation: 'moveTicket',
    run: (ctx, values) => {
      const given = str(values, 'status');
      const to = given === undefined ? undefined : status(given, 'move', '<status>');
      // The disposition and its target are checked before the board is
      // opened, so a usage error exits 1 even where there is no board.
      const disposition = scopeDispositionFromArgs(dispositionArgs(values));
      if (disposition !== undefined && to !== 'merged') {
        throw new BoardError(
          1,
          'usage',
          'a scope disposition (--task, --change with --group, or --unplanned) applies only to a move to merged',
        );
      }
      return written(
        moveTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          to,
          disposition,
          allowSecretLike: bool(values, 'allow-secret-like'),
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
      EXIT_INVALID_ACTOR,
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
      EXIT_INVALID_ACTOR,
      EXIT_ACTOR,
      EXIT_ID_SHORT,
      EXIT_ID_AMBIGUOUS,
      EXIT_SECRET,
      EXIT_NO_BOARD,
      EXIT_TRANSITION,
      EXIT_SCOPE_DISPOSITION,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      flag(
        'to',
        'string',
        'New assignee, of the actor form: 1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit',
        { required: true },
      ),
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
      // The new assignee is checked before anything else is read and
      // before the board is opened (board-cli "Actor names are checked").
      const assignee = req(values, 'to');
      checkActorName(assignee, ctx.surface === 'mcp' ? 'the argument to' : '--to');
      const to = status(req(values, 'status'), 'handoff', '--status');
      return written(
        handoffTicket(ctx.board(), actorOf(ctx), {
          id: req(values, 'id'),
          to: assignee,
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
      EXIT_INVALID_ACTOR,
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
      EXIT_INVALID_ACTOR,
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
      EXIT_INVALID_ACTOR,
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
      'Closes a merged or blocked ticket. A decision made in a ticket must be recorded in a spec delta or ADR: name that file with --decision-recorded-in (it must exist inside the working tree), or declare that the ticket made no decision with --no-decision, which is refused while the ticket has an unretracted DECISION: comment. An ad hoc ticket that has no task link also needs its scope disposition on the same command: --task (or --change with --group) links the task it delivered, --unplanned records that the work was never planned; without one the close exits 4 with needs-scope-disposition. Never create an issue, task file or task reference only to satisfy it.',
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
      {
        command: 'agentboard close 01J9K3 --no-decision --unplanned "abandoned: superseded" --as orch',
        summary: 'Close a blocked ad hoc ticket, recording why its work was never planned',
      },
      {
        command: 'agentboard close 01J9K3 --no-decision --task openspec:add-parser#2 --as orch',
        summary: 'Close a blocked ad hoc ticket, linking the planned task it belongs to',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
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
      EXIT_SECRET,
      EXIT_TASK_REF,
      EXIT_NO_BOARD,
      {
        code: 4,
        reason: 'invalid-transition',
        meaning: 'The ticket is not merged or blocked, or is already closed',
      },
      EXIT_SCOPE_DISPOSITION,
      EXIT_ALREADY_LINKED,
      EXIT_UNKNOWN_TICKET,
      EXIT_INTEGRITY,
    ],
    positionals: [ID],
    flags: [
      flag('decision-recorded-in', 'string', 'Spec delta, ADR or tasks file recording decisions'),
      flag('no-decision', 'boolean', 'The ticket made no decision that needs recording'),
      ...DISPOSITION_FLAGS,
    ],
    exclusive: [CLOSE_GROUP, DISPOSITION_GROUP],
    writes: true,
    operation: 'closeTicket',
    run: (ctx, values) => {
      const id = req(values, 'id');
      const path = str(values, 'decision-recorded-in');
      // Checked before the board is opened (see the note above COMMANDS).
      const scope = {
        disposition: scopeDispositionFromArgs(dispositionArgs(values)),
        allowSecretLike: bool(values, 'allow-secret-like'),
      };
      return written(
        closeTicket(
          ctx.board(),
          actorOf(ctx),
          path === undefined
            ? { id, noDecision: true, ...scope }
            : { id, decisionRecordedIn: path, cwd: ctx.cwd, env: ctx.env, ...scope },
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
      EXIT_INVALID_ACTOR,
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
        text: result.entries
          .map((entry) => `${renderInboxLine(entry, actorOf(ctx))}\n`)
          .join(''),
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
      EXIT_INVALID_ACTOR,
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
              .map(
                (entry) =>
                  `${io.json ? JSON.stringify(entry) : renderInboxLine(entry, actorOf(ctx))}\n`,
              )
              .join(''),
          );
        },
      }),
  },
  {
    name: 'serve',
    summary: 'Serve a live view of the whole board in a local web browser',
    description:
      'Starts a web server for the board on 127.0.0.1 only and prints the line serving <board dir> read-only at <url>, or serving <board dir> as <actor> at <url> when started with --as, where the URL carries a new access token each run (with --json, one JSON line with url, port, token, writable and actor instead). Open that URL in a browser to watch every ticket, the activity feed, ticket conversations and agent lanes change live; scripts can send the token as Authorization: Bearer <token> to the JSON API under /api/. Without --as the server is read-only and writes no event. With --as <actor> the page can also comment, move, claim, release, hand off, tick checklist lines, link and close tickets, each written as that actor through the same checks as the CLI (POST /api/actions/<action> with a JSON body); AGENTBOARD_ACTOR never enables writes. Anyone holding the URL can do what the page can, so keep it to yourself. Without --port the operating system picks a free port. After printing the line it opens the URL in the default browser when run from an interactive terminal: stdout is a terminal, no --json, CI unset, not an SSH session, and (other than on macOS and Windows) DISPLAY or WAYLAND_DISPLAY set. --open always tries to open the browser and --no-open never does (use --no-open on a shared machine, where the opener puts the URL and its token on a command line other users can read); failing to open it is only a warning. Runs until interrupted (SIGINT or SIGTERM), then exits 0.',
    group: 'awareness',
    examples: [
      {
        command: 'agentboard serve',
        summary: 'Serve the board on a free local port and open it from an interactive terminal',
      },
      {
        command: 'agentboard serve --no-open',
        summary: 'Serve the board without opening a browser',
      },
      {
        command: 'agentboard serve --port 4477 --open',
        summary: 'Serve the board on port 4477 and open it in the default browser',
      },
      {
        command: 'agentboard serve --json',
        summary: 'Print the URL, port and token as one JSON line for a script',
      },
      {
        command: 'agentboard serve --as ben',
        summary: 'Serve the board and let the page act on tickets as ben',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Stopped by SIGINT or SIGTERM' },
      {
        code: 1,
        reason: 'usage',
        meaning:
          'Invalid arguments: unknown flag, a --port that is not an integer from 0 to 65535, an empty --as, or --open with --no-open',
      },
      EXIT_INVALID_ACTOR,
      {
        code: 1,
        reason: 'port-in-use',
        meaning: 'The port given with --port is in use on 127.0.0.1; choose another or omit --port',
      },
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    actorHelp:
      'The actor of the write actions of the page; only this enables writes (AGENTBOARD_ACTOR is ignored); checked: 1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit',
    positionals: [],
    flags: [
      flag('port', 'integer', 'Port to listen on, 0 to 65535 (default 0: a free port)'),
      flag('open', 'boolean', 'Always open the URL in the default browser'),
      flag('no-open', 'boolean', 'Never open the URL in a browser'),
    ],
    exclusive: [SERVE_OPEN_GROUP],
    writes: false,
    operation: null,
    run: () => {
      throw new BoardError(
        1,
        'streaming-command',
        'agentboard serve runs a web server and runs only from the agentboard executable',
      );
    },
    stream: async (ctx, values, io) => {
      const { serveCommand } = await import('../web/serve.js');
      return serveCommand(ctx, values, io);
    },
  },
  {
    name: 'top',
    summary: 'Show a live, read-only view of the whole board in this terminal',
    description:
      'Runs a full-screen, read-only view of the board in the current terminal: the board columns, the activity feed, the agent lanes and any ticket with its conversation, updated live as events arrive from any process. Keys: 1, 2 and 3 switch between the board, feed and lanes views (Tab cycles), the arrow keys or h, j, k and l move, Enter opens a ticket and Escape closes it, c shows closed tickets, ? shows the keys, and q or Ctrl-C quits. It needs an interactive terminal (standard input and output must be a terminal and TERM must not be dumb); otherwise it exits 1 with not-a-tty, and agentboard list or agentboard watch --as <actor> are the commands to use instead. With NO_COLOR set it uses no color. Writes no event and needs no actor (--as is ignored). Runs until quit or interrupted (SIGINT or SIGTERM), then restores the terminal and exits 0.',
    group: 'awareness',
    examples: [
      { command: 'agentboard top', summary: 'Watch the whole board live in this terminal' },
      {
        command: 'agentboard top --json',
        summary: 'Same screen; a failure is reported as a JSON error document on stdout',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Quit with q or Ctrl-C, or stopped by SIGINT or SIGTERM' },
      { code: 1, reason: 'usage', meaning: 'Invalid arguments: unknown flag or extra argument' },
      EXIT_INVALID_ACTOR,
      {
        code: 1,
        reason: 'not-a-tty',
        meaning:
          'Standard input or output is not a terminal, or TERM is dumb; use agentboard list or agentboard watch instead',
      },
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    terminal: true,
    operation: null,
    run: () => {
      throw new BoardError(
        1,
        'streaming-command',
        'agentboard top drives the terminal and runs only from the agentboard executable',
      );
    },
    stream: async (ctx, values, io) => {
      const { topCommand } = await import('../tui/terminal.js');
      return topCommand(ctx, values, io);
    },
  },
  {
    name: 'health',
    summary:
      'Report stale claims, long-blocked tickets, unpromoted decisions, close-merged candidates and unplanned scope',
    description:
      "Prints the board's health report, section by section with counts: claims whose assignee has been idle for at least --stale-after (default 2h), tickets blocked for at least --blocked-after (default 24h) with the status they were blocked from and their latest comment, open tickets with a DECISION: comment and no decision link, the tickets in merged as close-merged would see them (ready, held by an open decision, or missing a pr link; whether a pull request is merged is known only to close-merged), and the unplanned scope: tickets merged or closed as unplanned (and ad hoc tickets closed with no disposition) with their reasons, those disposed of within --unplanned-within (default 7d) listed and all of them counted. Unplanned scope is information, not a finding to fix. Durations are <n>m, <n>h or <n>d. --check also compares the cache with the event log as rebuild --check does, which briefly pauses writers. Writes nothing and needs no actor. It exits 0 whatever it finds, so read the report (or --json) rather than the exit code. Run it before archiving a change and when choosing what to dispatch.",
    group: 'awareness',
    examples: [
      {
        command: 'agentboard health',
        summary: 'Print the health report with the default thresholds',
      },
      {
        command: 'agentboard health --stale-after 30m --blocked-after 2d',
        summary: 'Flag claims idle for 30 minutes and tickets blocked for 2 days',
      },
      {
        command: 'agentboard health --unplanned-within 30d',
        summary: 'List the unplanned scope of the last 30 days',
      },
      {
        command: 'agentboard health --check --json',
        summary: 'Include the cache check and print the report as one JSON document',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'The report was printed, whatever it contains' },
      {
        code: 1,
        reason: 'usage',
        meaning:
          'Invalid arguments: unknown flag, or a duration that is not <n>m, <n>h or <n>d with <n> from 1 to 99999',
      },
      EXIT_INVALID_ACTOR,
      EXIT_NO_BOARD,
      EXIT_INTEGRITY,
    ],
    positionals: [],
    flags: [
      flag(
        'stale-after',
        'string',
        'A claim is stale when its assignee is idle this long: <n>m, <n>h or <n>d (default 2h)',
      ),
      flag(
        'blocked-after',
        'string',
        'A ticket is stuck when blocked this long: <n>m, <n>h or <n>d (default 24h)',
      ),
      flag(
        'unplanned-within',
        'string',
        'List the unplanned scope disposed of within this long: <n>m, <n>h or <n>d (default 7d); the total counts all of it',
      ),
      flag(
        'check',
        'boolean',
        'Also compare the cache with the event log, as rebuild --check (briefly pauses writers)',
      ),
    ],
    exclusive: [],
    writes: false,
    operation: 'boardHealth',
    run: (ctx, values) => runHealth(ctx, values),
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
      EXIT_INVALID_ACTOR,
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
    summary: "Commit new events, integrate the board's history from its remote and push",
    description:
      "Shares the board with other clones: commits new event files (only its own paths, as the fixed identity agentboard <agentboard@localhost>), integrates the board's history from its remote with a rebase and pushes, retrying once when the remote moved in between, then folds the events that arrived. For a board in the host repository (host model) the history is the ref refs/agentboard/board: sync makes it equal to the worktree's HEAD, fetches it from the host's remote into the worktree's own FETCH_HEAD, rebases onto it, pushes HEAD:refs/agentboard/board without force and never creates or moves a branch; the host's git hooks do not run. For a standalone board (.board as a repository of its own) it pulls with rebase and pushes its branch. The remote is chosen in the repository that holds the history: the one named by git config agentboard.remote, else the upstream of the branch (the host's main checkout's branch for the host model), else origin, else the only remote. Event files never conflict with each other; a problem that needs a human (a conflict, a rebase in progress, a standalone board on a detached HEAD, a host-model board worktree on a branch, an unreachable remote) exits 3; a host-model board on a git older than 2.32 exits 1. Needs no actor.",
    group: 'maintenance',
    examples: [
      { command: 'agentboard sync', summary: "Commit, integrate and push the board's events" },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      { code: 1, reason: 'git-missing', meaning: 'git could not be run' },
      {
        code: 1,
        reason: 'git-too-old',
        meaning: 'The board is in the host repository, which needs git 2.32 or later',
      },
      {
        code: 1,
        reason: 'ambiguous-remote',
        meaning:
          'The repository has several remotes and none is agentboard.remote, the upstream or origin',
      },
      EXIT_NO_BOARD,
      {
        code: 2,
        reason: 'board-not-a-repository',
        meaning: 'The board directory is not the top of its own git repository or worktree',
      },
      {
        code: 2,
        reason: 'board-link-broken',
        meaning: 'The board is a worktree whose link to the host repository is broken',
      },
      {
        code: 3,
        reason: 'sync-in-progress',
        meaning: 'A rebase is in progress in the board repository or worktree',
      },
      {
        code: 3,
        reason: 'detached-head',
        meaning: 'The standalone board repository has a detached HEAD',
      },
      {
        code: 3,
        reason: 'board-on-branch',
        meaning:
          'The host-model board worktree has a branch checked out instead of a detached HEAD',
      },
      { code: 3, reason: 'sync-conflict', meaning: 'The rebase stopped on a conflict' },
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
    name: 'remote',
    summary:
      'Show how the board is shared: its model, where its history lives and the remote sync uses',
    description:
      'Prints how the board is shared: the board directory; its model (host, when the board is a worktree of the host repository with its history under refs/agentboard/board; standalone, when .board is a repository of its own; broken host link; or not a repository); where the history lives; the remote sync would use with its URL and the rule that chose it (agentboard.remote, the upstream of the branch, origin, or the only remote), or that there is none or the choice is ambiguous; and every remote with its URL. A broken link or an ambiguous choice comes with how to fix it (agentboard init, or git config agentboard.remote <name>). It is read-only, never contacts the network and never changes anything, so it is safe to run when something is wrong: it exits 0 whenever a board exists and puts problems in its output. Needs no actor.',
    group: 'setup',
    examples: [
      {
        command: 'agentboard remote',
        summary: 'Show the model, the history and the remote sync would use',
      },
      {
        command: 'agentboard remote --json',
        summary:
          'The same, as one JSON document with dir, model, gitDir, ref, branch, head, remote, remotes and problems',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'The board exists; problems, if any, are in the output' },
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
      EXIT_NO_BOARD,
    ],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: 'remoteReport',
    run: (ctx) => {
      const report = remoteReport(ctx.boardDir(), { env: ctx.env });
      return { json: report, text: renderRemote(report) };
    },
  },
  {
    name: 'import-change',
    summary: 'Create or update one ticket per task group of a planning change',
    description:
      "Creates one ticket per task group of a planning change: a plain name is an OpenSpec change (its tasks.md is read), <source>:<ref> names another source. A group whose tasks are all ticked gets a ticket in merged. Running it again pairs the existing tickets with the groups by title and task lines, never by number alone: a moved group's ticket is renumbered, a paired ticket is reconciled with its group's title and lines (removed lines are marked removed, never deleted), a new group gets a new ticket and a removed group's ticket is marked superseded. A reconcile that would remove or reword a done line, or reword the lines of a ticket held in progress, is blocked (exit 4) unless --force; an ambiguous pairing writes nothing (exit 4). --dry-run shows all of it and writes nothing. Run it after proposing or revising a change.",
    group: 'planning',
    examples: [
      {
        command: 'agentboard import-change add-parser --as orch',
        summary: 'Create a ticket per task group of the OpenSpec change add-parser',
      },
      {
        command: 'agentboard import-change add-parser --dry-run --as orch',
        summary: 'Show how a revised tasks file would change the tickets, writing nothing',
      },
    ],
    exitCodes: [
      EXIT_OK,
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
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
      {
        code: 4,
        reason: 'reconcile-blocked',
        meaning:
          'A reconcile would remove or reword a done line, or reword a held ticket in progress (lines named); every other group was imported',
      },
      {
        code: 4,
        reason: 'reconcile-ambiguous',
        meaning: 'Tickets cannot be paired with groups unambiguously; nothing was written',
      },
      EXIT_INTEGRITY,
    ],
    positionals: [
      positional('name', 'string', 'OpenSpec change name, or <source>:<ref> for another source'),
    ],
    flags: [
      flag('dry-run', 'boolean', 'Show the pairing and the changes, writing nothing'),
      flag('force', 'boolean', 'Also reconcile tickets the guard blocks (recorded as forced)'),
    ],
    exclusive: [],
    writes: true,
    operation: 'importChange',
    run: (ctx, values) => {
      const target = parseImportTarget(req(values, 'name'));
      const result = importChange(ctx.board(), actorOf(ctx), target, {
        dryRun: values['dry-run'] === true,
        force: values.force === true,
      });
      return { json: result, text: renderImport(result) };
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
      EXIT_INVALID_ACTOR,
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
    name: 'config set',
    summary: 'Set a board setting: lease.grace or queue.window',
    description:
      'Sets a board setting for every actor, as an event: lease.grace, the grace a claim with --ttl gets to be confirmed by renew, and queue.window, the time a waiter granted a ticket has to accept it by renewing. Values are <n>s or <n>m, from 30s to 10m; both default to 2m.',
    group: 'setup',
    examples: [
      {
        command: 'agentboard config set queue.window 5m --as orchestrator',
        summary: 'Give granted waiters 5 minutes to accept',
      },
    ],
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_INVALID_ACTOR, EXIT_ACTOR, EXIT_NO_BOARD, EXIT_INTEGRITY],
    positionals: [
      positional('key', 'string', KEY_SUMMARY, true, SETTING_KEYS),
      positional('value', 'string', 'Duration: <n>s or <n>m, from 30s to 10m'),
    ],
    flags: [],
    exclusive: [],
    writes: true,
    operation: 'setConfig',
    run: (ctx, values) => {
      const value = parseSetting(req(values, 'value'));
      const out = setConfig(ctx.board(), actorOf(ctx), { key: req(values, 'key'), value });
      return { json: out, text: `set ${out.key} ${formatDuration(out.value)}\n` };
    },
  },
  {
    name: 'config get',
    summary: 'Print the board settings lease.grace and queue.window',
    description:
      'Prints the effective value of one board setting, or of both, marking the ones at their default. Needs no actor.',
    group: 'setup',
    examples: [
      { command: 'agentboard config get', summary: 'Print both settings' },
      {
        command: 'agentboard config get queue.window --json',
        summary: 'Print the acceptance window as JSON',
      },
    ],
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_INVALID_ACTOR, EXIT_NO_BOARD, EXIT_INTEGRITY],
    positionals: [positional('key', 'string', KEY_SUMMARY, false, SETTING_KEYS)],
    flags: [],
    exclusive: [],
    writes: false,
    operation: 'getConfig',
    run: (ctx, values) => {
      const key = str(values, 'key');
      const result = getConfig(ctx.board(), key);
      return { json: result, text: renderConfig(result, key !== undefined) };
    },
  },
  {
    name: 'mcp',
    summary: 'Serve the board as MCP tools over stdio',
    description:
      'Serves the board as MCP tools over stdio, one tool per board command (not init, watch, serve, top, rebuild, sync, remote, config, hook, mcp, version, help or the agents commands), for agents that prefer tools to the shell. Runs until the client disconnects or the process gets SIGINT or SIGTERM. --as sets the default actor for tool calls that pass no as of their own, before AGENTBOARD_ACTOR. Nothing but protocol messages is written to stdout. It exits 2 when no board is found from this directory.',
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
      EXIT_INVALID_ACTOR,
      EXIT_NO_BOARD,
    ],
    actorHelp:
      "Default actor for tool calls: a call's own as comes first, then this, then AGENTBOARD_ACTOR; checked: 1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit",
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
    name: 'hook',
    summary: 'Answer a coding harness hook event (Claude Code) from the board, read-only',
    description:
      "Run by a coding harness on one of three events, never by hand: session-start, stop or pre-tool-use. Reads the harness's JSON payload from stdin and answers in Claude Code's hook protocol: exit 0, with at most one JSON document on stdout, continues; exit 2, only with --strict, blocks with the reason on stderr. Warn-only unless --strict. It fails open: no board, an unreadable, locked or older cache, no actor, a malformed payload, an unknown event or a run past its 2 second budget all exit 0 without blocking. It is read-only: it writes no event, never syncs or catches up (so it writes no due grant) and never creates or rebuilds the cache; session-start may only advance the actor's inbox cursor. The actor is --as or AGENTBOARD_ACTOR, never the OS user or the payload. --json is accepted and changes nothing: the answer is always the hook protocol. Set AGENTBOARD_HOOKS=off to make every event exit 0 at once. It never reports the other exit codes, and it is not an MCP tool.",
    group: 'setup',
    examples: [
      {
        command: 'agentboard hook session-start',
        summary: 'Answer the SessionStart event with the held tickets and the inbox as context',
      },
      {
        command: 'agentboard hook pre-tool-use --strict',
        summary: 'Deny an edit of a project file while the actor holds no ticket',
      },
      {
        command: 'agentboard hook stop --as impl',
        summary: 'Remind impl to hand off or block a held ticket before stopping',
      },
    ],
    exitCodes: [
      {
        code: 0,
        meaning:
          'Continue: the answer, if any, is the JSON document on stdout; also every failure (fail open)',
      },
      {
        code: 1,
        reason: 'invalid-actor',
        meaning:
          'Only through the in-process registry, where every command checks a given --as; the executable treats such a name as no actor and exits 0',
      },
      {
        code: 2,
        meaning: 'Block, with --strict only: the reason is on stderr and is fed back to the agent',
      },
    ],
    positionals: [
      positional(
        'event',
        'string',
        'The harness event: session-start, stop or pre-tool-use',
        true,
        HOOK_EVENTS,
      ),
    ],
    actorHelp:
      'The actor whose tickets and inbox the hook checks, before AGENTBOARD_ACTOR; with neither, stop and pre-tool-use do nothing and session-start asks for one; checked: 1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit (a name that fails counts as no actor)',
    flags: [flag('strict', 'boolean', 'Block (exit 2) instead of warning')],
    exclusive: [],
    writes: false,
    operation: 'runHook',
    run: () => {
      throw new BoardError(
        1,
        'streaming-command',
        'agentboard hook reads its payload from stdin and runs only from the agentboard executable',
      );
    },
  },
  {
    name: 'agents install',
    summary: "Install guidance that points this project's coding agents at the board",
    description:
      "Writes short agent guidance into the root of the current working tree (git rev-parse --show-toplevel, or the current directory outside git): claude writes the Claude Code skill .claude/skills/agentboard/SKILL.md, agents-md a managed block in AGENTS.md, openspec agentboard: guidance entries for apply and archive in openspec/config.yaml, mcp-json an agentboard server in .mcp.json that runs npx -y @bendechrai/agentboard mcp, and claude-hooks the three agentboard hook entries (SessionStart, Stop and PreToolUse running agentboard hook) in .claude/settings.json, merged beside the user's own settings and hooks. With --command <executable>, the MCP server and the hooks run that executable instead of npx (for a linked or local install; the value goes into .mcp.json as given and is quoted where needed in the hooks); --mcp-command is its deprecated alias. The hooks warn by default; --hooks-strict writes them in strict mode, where stop and pre-tool-use block (see agentboard help hook). With no --target it selects claude, agents-md and openspec when .claude/, AGENTS.md or openspec/config.yaml exist, and says why; mcp-json is installed only when asked for with --target mcp-json or --command, which selects it in addition to the other targets, and claude-hooks only with --target claude-hooks. An existing agentboard server or hook executable is kept on reinstall, and --command replaces it with the given executable. Only agentboard's own region of each file is changed. A file or entry agentboard does not own is refused unless --force is given, and the other targets are still installed. The installed text points agents to agentboard help agents. Needs no board and no actor; commit the files it writes.",
    group: 'setup',
    examples: [
      {
        command: 'agentboard agents install',
        summary: 'Install guidance for the agent tools this project already uses',
      },
      {
        command: 'agentboard agents install --target claude --target agents-md',
        summary: 'Install the Claude Code skill and the AGENTS.md block',
      },
      {
        command: 'agentboard agents install --target mcp-json',
        summary: 'Register the agentboard MCP server in .mcp.json',
      },
      {
        command: 'agentboard agents install --command agentboard',
        summary:
          'Install the detected targets and register an MCP server that runs a linked agentboard',
      },
      {
        command: 'agentboard agents install --target claude-hooks',
        summary: 'Install the Claude Code hooks in warn mode into .claude/settings.json',
      },
      {
        command:
          'agentboard agents install --target claude-hooks --hooks-strict --command agentboard',
        summary: 'Install the hooks in strict mode, running a linked agentboard',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Every selected target was installed or was already up to date' },
      {
        code: 1,
        meaning:
          'A target was refused (its file is named; see --force); the other targets were still processed',
      },
      {
        code: 1,
        reason: 'usage',
        meaning:
          'Invalid arguments: unknown command, flag or --target, a missing or malformed argument, a --command (or --mcp-command) that is empty, contains a newline, starts with a hyphen, a plus sign or a percent sign, or is a shell special built-in or another shell built-in, or both --command and --mcp-command (nothing is written)',
      },
      EXIT_INVALID_ACTOR,
      {
        code: 1,
        reason: 'no-targets',
        meaning: 'No --target was given and no target was detected (the targets are listed)',
      },
    ],
    positionals: [],
    flags: [
      flag(
        'target',
        'string',
        'Target to install: claude, agents-md, openspec, mcp-json or claude-hooks (repeatable)',
        { repeatable: true },
      ),
      flag(
        'command',
        'string',
        'Executable the .mcp.json server (with the argument mcp) and the claude-hooks commands run, instead of npx (selects mcp-json)',
      ),
      flag(
        'mcp-command',
        'string',
        'Deprecated alias of --command, which does the same; prints a notice on stderr',
      ),
      flag(
        'hooks-strict',
        'boolean',
        'Write the claude-hooks entries in strict mode, where stop and pre-tool-use block (no effect without --target claude-hooks)',
      ),
      flag(
        'global',
        'boolean',
        "Also edit the global MCP config of codex ($CODEX_HOME/config.toml) and antigravity (~/.gemini/config/mcp_config.json); needs --target codex or --target antigravity",
      ),
      flag('force', 'boolean', 'Overwrite a file or entry that agentboard does not own'),
    ],
    exclusive: [INSTALL_COMMAND_GROUP],
    writes: false,
    operation: 'installGuidance',
    run: (ctx, values) => {
      const command = str(values, 'command');
      const mcpCommand = str(values, 'mcp-command');
      return installCommand(ctx.cwd, ctx.env, {
        targets: list(values, 'target'),
        force: bool(values, 'force'),
        hooksStrict: bool(values, 'hooks-strict'),
        global: bool(values, 'global'),
        ...(command === undefined ? {} : { command }),
        ...(mcpCommand === undefined ? {} : { mcpCommand }),
      });
    },
  },
  {
    name: 'agents check',
    summary: 'Report whether the installed agent guidance is current',
    description:
      "Inspects the agent guidance installed in the root of the current working tree (the Claude Code skill, the AGENTS.md block, the openspec/config.yaml entries, the .mcp.json server and the agentboard hooks in .claude/settings.json) and reports each target found as current, stale (installed by another guidance version) or modified (its managed text was edited by hand). Exits 1 unless every target found is current, so it can run in a project's own checks; agentboard agents install brings them up to date. Needs no board and no actor.",
    group: 'setup',
    examples: [
      { command: 'agentboard agents check', summary: 'Check the installed agent guidance' },
      {
        command: 'agentboard agents check --json',
        summary: 'The same, as a JSON array of target, path, state and versions',
      },
    ],
    exitCodes: [
      { code: 0, meaning: 'Every target found is current, or none was found' },
      { code: 1, meaning: 'A target found is stale or modified (all are still reported)' },
      EXIT_USAGE,
      EXIT_INVALID_ACTOR,
    ],
    positionals: [],
    flags: [
      flag(
        'global',
        'boolean',
        "Also check the global MCP config of codex and antigravity, which is read only with this flag",
      ),
    ],
    exclusive: [],
    writes: false,
    operation: 'checkGuidance',
    run: (ctx, values) => checkCommand(ctx.cwd, ctx.env, { global: bool(values, 'global') }),
  },
  {
    name: 'version',
    summary: 'Print the agentboard version',
    description: 'Prints the version of this agentboard. Needs no board and no actor.',
    group: 'setup',
    examples: [{ command: 'agentboard version', summary: 'Print the version' }],
    exitCodes: [EXIT_OK, EXIT_USAGE, EXIT_INVALID_ACTOR],
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: null,
    run: () => ({ json: { version: VERSION }, text: `${VERSION}\n` }),
  },
  {
    name: 'help',
    summary: 'Show the overview, the help of one command, or the agent guide',
    description:
      "With no topic, prints the overview of every command; with a command name (one or two words), prints that command's synopsis, arguments, exit codes and examples. agentboard <command> --help and -h are the same. The topic agents prints the agent guide, and --role adds the checklist of one role (orchestrator, test-author, implementer or reviewer). Needs no board and no actor. With --json, prints the same help as JSON.",
    group: 'setup',
    examples: [
      { command: 'agentboard help', summary: 'Print the overview of every command' },
      { command: 'agentboard help claim', summary: 'Print the help of claim' },
      {
        command: 'agentboard help checklist tick --json',
        summary: 'Print the help of checklist tick as one JSON document',
      },
      { command: 'agentboard help agents', summary: 'Print the agent guide' },
      {
        command: 'agentboard help agents --role implementer',
        summary: 'Print the agent guide and the implementer checklist',
      },
    ],
    exitCodes: [
      EXIT_OK,
      {
        code: 1,
        reason: 'usage',
        meaning:
          'The topic is not a command (close matches are suggested), or the role is not one of the four',
      },
      EXIT_INVALID_ACTOR,
    ],
    positionals: [
      positional('topic', 'string', 'Command name, its first word, or agents', false),
      positional('subtopic', 'string', 'Second word of a two-word command name', false),
    ],
    flags: [
      flag(
        'role',
        'string',
        'With the topic agents: orchestrator, test-author, implementer or reviewer',
      ),
    ],
    exclusive: [],
    writes: false,
    operation: null,
    run: (_ctx, values) =>
      helpOutput(
        HELP_SOURCE,
        [str(values, 'topic'), str(values, 'subtopic')].filter(
          (word): word is string => word !== undefined,
        ),
        str(values, 'role'),
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
