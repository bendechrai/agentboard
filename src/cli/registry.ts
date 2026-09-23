/**
 * The single command registry (board-cli: "Command surface"; design.md:
 * "Library first, CLI second"). Every command, its positional arguments,
 * flags, mutually exclusive flag sets, whether it writes, its summary and
 * the library operation it calls are defined here once. The parser
 * (`parseArgs`) is driven by it, and task group 9 generates the MCP tools
 * from it.
 *
 * This group registers the ticket lifecycle commands plus `version` and the
 * `mcp` placeholder. `inbox`, `watch`, `rebuild`, `sync`, `import-change`
 * and `close-merged` are added by the task groups that implement them.
 */

import { notImplemented } from '../board/stub.js';
import type { ArgSpec, CommandSpec, ExclusiveGroup } from './types.js';

/** `--json`, accepted by every command. */
export const JSON_FLAG: ArgSpec = {
  name: 'json',
  type: 'boolean',
  required: false,
  repeatable: false,
  summary: 'Print exactly one JSON document on stdout',
};

/** Flags accepted by every command, in addition to its own. */
export const GLOBAL_FLAGS: readonly ArgSpec[] = [JSON_FLAG];

/**
 * `--as <actor>`, listed by every writing command. Not required by the
 * parser: `AGENTBOARD_ACTOR` is the fallback (`resolveActor`).
 */
export const ACTOR_FLAG: ArgSpec = {
  name: 'as',
  type: 'string',
  required: false,
  repeatable: false,
  summary: 'Actor recorded on the event (falls back to AGENTBOARD_ACTOR)',
};

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

/**
 * The explanation `new` gives when no task reference and no ad hoc reason
 * is given (board-openspec-integration: "Ticket without a task is
 * refused").
 */
export const TASK_RULE =
  'tickets must reference a task (--task <source>:<ref>#<item>, or --change <name> ' +
  'with --group <n>) or be marked ad hoc with a reason (--adhoc <reason>)';

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

/** Placeholder `run` of the stubs. */
const stubRun: CommandSpec['run'] = (ctx, values) => {
  throw notImplemented(ctx, values);
};

/**
 * Every command of this version, in this order: `init`, `new`, `show`,
 * `list`, `claim`, `release`, `move`, `comment`, `handoff`, `link`,
 * `checklist tick`, `checklist untick`, `close`, `mcp`, `version`.
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
 * - `version`: `{ version }`; text: the version.
 * - `mcp`: always `BoardError(1, 'not-implemented')`, with a message saying
 *   `agentboard mcp` is not implemented yet (it arrives with task group 9).
 *
 * Argument mapping: `--change`/`--group`/`--task` go through
 * `taskRefFromArgs`; `list --change <name>` is `list --task openspec:<name>`
 * (the two are exclusive); `list --task` goes through `parseTaskFilter`; a status
 * argument must be one of `STATUSES` or it is `BoardError(1, 'usage')`
 * listing them; `link --pr` is a number when it is all digits (a positive
 * safe integer), otherwise the string; `close --decision-recorded-in` is
 * checked relative to `ctx.cwd`.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'init',
    summary: 'Create the board for this project',
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: 'initBoard',
    run: stubRun,
  },
  {
    name: 'new',
    summary: 'Create a ticket',
    positionals: [positional('title', 'string', 'Ticket title')],
    flags: [
      flag('description', 'string', 'Longer description'),
      flag('label', 'string', 'Label (repeatable)', { repeatable: true }),
      ...TASK_FLAGS,
      flag('adhoc', 'string', 'Reason the ticket has no task reference'),
      flag('checklist', 'string', 'Checklist line (repeatable)', { repeatable: true }),
      ACTOR_FLAG,
      ALLOW_SECRET_FLAG,
    ],
    exclusive: [NEW_TASK_GROUP],
    writes: true,
    operation: 'newTicket',
    run: stubRun,
  },
  {
    name: 'show',
    summary: 'Show one ticket in full',
    positionals: [ID],
    flags: [flag('raw', 'boolean', "Print the ticket's raw event files")],
    exclusive: [],
    writes: false,
    operation: 'showTicket',
    run: stubRun,
  },
  {
    name: 'list',
    summary: 'List open tickets, optionally filtered',
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
    run: stubRun,
  },
  {
    name: 'claim',
    summary: 'Assign an unassigned ticket to yourself',
    positionals: [ID],
    flags: [ACTOR_FLAG],
    exclusive: [],
    writes: true,
    operation: 'claimTicket',
    run: stubRun,
  },
  {
    name: 'release',
    summary: 'Give up a ticket you hold',
    positionals: [ID],
    flags: [ACTOR_FLAG],
    exclusive: [],
    writes: true,
    operation: 'releaseTicket',
    run: stubRun,
  },
  {
    name: 'move',
    summary: 'Move a ticket to another status (a blocked ticket returns to its origin)',
    positionals: [ID, positional('status', 'string', 'Target status', false)],
    flags: [ACTOR_FLAG],
    exclusive: [],
    writes: true,
    operation: 'moveTicket',
    run: stubRun,
  },
  {
    name: 'comment',
    summary: 'Add a comment to a ticket',
    positionals: [ID, positional('text', 'string', 'Comment text')],
    flags: [ACTOR_FLAG, ALLOW_SECRET_FLAG],
    exclusive: [],
    writes: true,
    operation: 'commentTicket',
    run: stubRun,
  },
  {
    name: 'handoff',
    summary: 'Reassign, move and comment in one event',
    positionals: [ID],
    flags: [
      flag('to', 'string', 'New assignee', { required: true }),
      flag('status', 'string', 'Target status (the current one to only reassign)', {
        required: true,
      }),
      flag('note', 'string', 'Hand-off note, recorded as a comment', { required: true }),
      ACTOR_FLAG,
      ALLOW_SECRET_FLAG,
    ],
    exclusive: [],
    writes: true,
    operation: 'handoffTicket',
    run: stubRun,
  },
  {
    name: 'link',
    summary: 'Link a ticket to a task, a PR or a decision record',
    positionals: [ID],
    flags: [
      ...TASK_FLAGS,
      flag('pr', 'string', 'Pull request URL or number'),
      flag('decision', 'string', 'Path of a decision record'),
      ACTOR_FLAG,
    ],
    exclusive: [LINK_GROUP],
    writes: true,
    operation: 'linkTicket',
    run: stubRun,
  },
  {
    name: 'checklist tick',
    summary: 'Mark a checklist line done (0-based index)',
    positionals: [ID, positional('index', 'integer', 'Checklist line index, from 0')],
    flags: [ACTOR_FLAG],
    exclusive: [],
    writes: true,
    operation: 'setChecklistItem',
    run: stubRun,
  },
  {
    name: 'checklist untick',
    summary: 'Mark a checklist line not done (0-based index)',
    positionals: [ID, positional('index', 'integer', 'Checklist line index, from 0')],
    flags: [ACTOR_FLAG],
    exclusive: [],
    writes: true,
    operation: 'setChecklistItem',
    run: stubRun,
  },
  {
    name: 'close',
    summary: 'Close a merged or blocked ticket with a decision disposition',
    positionals: [ID],
    flags: [
      flag('decision-recorded-in', 'string', 'Spec delta, ADR or tasks file recording decisions'),
      flag('no-decision', 'boolean', 'The ticket made no decision that needs recording'),
      ACTOR_FLAG,
    ],
    exclusive: [CLOSE_GROUP],
    writes: true,
    operation: 'closeTicket',
    run: stubRun,
  },
  {
    name: 'mcp',
    summary: 'Serve the board as MCP tools over stdio (not implemented yet)',
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: null,
    run: stubRun,
  },
  {
    name: 'version',
    summary: 'Print the agentboard version',
    positionals: [],
    flags: [],
    exclusive: [],
    writes: false,
    operation: null,
    run: stubRun,
  },
];

/** The command named exactly `name` (e.g. `checklist tick`), or undefined. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
