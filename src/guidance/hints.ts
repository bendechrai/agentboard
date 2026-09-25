/**
 * Error hints (board-agent-guidance: "Error hints"; add-agent-guidance task
 * 2.2): every refusal carries one line naming what moves the caller
 * forward, printed by the CLI on stderr as `hint: <hint>` and carried by
 * MCP tool errors as the `hint` field.
 *
 * Decisions recorded here (test author, task group 2):
 * - Every reason token the board can throw has a hint, not only the exit 1
 *   and exit 4 ones the spec names: exit 2, 3 and 5 reasons get one too
 *   (for example `board-not-found` hints `agentboard init`). An error with
 *   no reason (an unexpected failure, exit 5) has no hint.
 * - Hints depend on the surface. On the CLI a suggested command is written
 *   as a shell command line; over MCP a suggested command that is an MCP
 *   tool is written as a tool call, and the actor advice names the `as`
 *   argument and `agentboard mcp --as <actor>` instead of the `--as` flag
 *   and `AGENTBOARD_ACTOR`, which an agent talking to a running server
 *   cannot set.
 * - The error message itself is unchanged by this group: board-cli says a
 *   tool call without an actor "SHALL fail exactly as the CLI does", so the
 *   MCP `missing-actor` message stays the CLI one and the hint carries the
 *   MCP-specific advice.
 * - The holder of a ticket is not a hint parameter: the `already-assigned`
 *   message already names it, and `BoardError` carries no structured
 *   details.
 *
 * Nothing here reads the board, the environment or the clock. All output
 * is plain ASCII on one line.
 */

import { findCommand } from '../cli/registry.js';
import type { CommandSpec } from '../cli/types.js';
import { EXCLUDED_COMMANDS, toolName } from '../mcp/tools.js';
import { BoardError, type ExitCode } from '../store/errors.js';

/** Where a hint is shown: the shell CLI or an MCP tool error. */
export type HintSurface = 'cli' | 'mcp';

/**
 * What a hint is rendered with. Every field but `surface` may be unknown;
 * an unknown value is written as its placeholder (`<id>`, `<actor>`).
 */
export interface HintContext {
  readonly surface: HintSurface;
  /**
   * The registry name of the command that failed (`claim`, `checklist
   * tick`), or null when it is not known (an unknown command, an unknown
   * MCP tool name, or a failure before a command was selected). Over MCP
   * it is the tool's command, not the tool name.
   */
  readonly command: string | null;
  /**
   * The ticket id argument exactly as the caller gave it (a full id or a
   * prefix), when the command has one and it was parsed; else undefined.
   */
  readonly id?: string;
  /**
   * The actor, when known: on the CLI the `--as` value or else
   * `AGENTBOARD_ACTOR`; over MCP the call's `as`, else the server's
   * `--as`, else the server's `AGENTBOARD_ACTOR`. Undefined (or empty)
   * when none is known.
   */
  readonly actor?: string;
}

/**
 * Every reason token that has a hint, sorted. This is exactly the set of
 * reasons the board can put in a `BoardError`: every literal
 * `new BoardError(<code>, '<reason>', ...)` under `src/`, every
 * `RejectionReason` of the fold (`src/events/fold.ts`), and every
 * `ExclusiveGroup.reason` and `ExitCodeSpec.reason` in the registry. A
 * test derives that set from the source and compares.
 */
export const HINT_REASONS: readonly string[] = [
  'already-assigned',
  'ambiguous-id',
  'ambiguous-remote',
  'board-not-a-repository',
  'board-not-found',
  'busy',
  'checklist-index',
  'decision-path-missing',
  'detached-head',
  'duplicate-create',
  'forbidden-host',
  'gh-missing',
  'git-missing',
  'id-too-short',
  'integrity',
  'invalid-transition',
  'malformed-event',
  'malformed-task-ref',
  'malformed-tasks',
  'method-not-allowed',
  'missing-actor',
  'missing-status',
  'needs-task-link',
  'needs-task-or-adhoc',
  'no-cache',
  'no-disposition',
  'no-targets',
  'not-a-tty',
  'not-assignee',
  'not-found',
  'path-outside-tree',
  'port-in-use',
  'schema-mismatch',
  'secret-like',
  'streaming-command',
  'sync-conflict',
  'sync-failed',
  'sync-in-progress',
  'tasks-not-found',
  'too-many-streams',
  'unauthorized',
  'unknown-cursor',
  'unknown-ticket',
  'unpromoted-decision',
  'unsupported-source',
  'usage',
];

/**
 * The exit code class of each reason in `HINT_REASONS` (a reason belongs to
 * exactly one class: for example `usage` and `missing-actor` are 1,
 * and so are the web server's refusals (`unauthorized`, `forbidden-host`,
 * `not-found`, `method-not-allowed`, `too-many-streams`) and
 * `port-in-use`;
 * `board-not-found` 2, `sync-conflict` 3, `already-assigned` 4, `busy` 5).
 */
export const HINT_EXIT_CODES: Readonly<Record<string, Exclude<ExitCode, 0>>> = {
  'already-assigned': 4,
  'ambiguous-id': 1,
  'ambiguous-remote': 1,
  'board-not-a-repository': 2,
  'board-not-found': 2,
  busy: 5,
  'checklist-index': 4,
  'decision-path-missing': 1,
  'detached-head': 3,
  'duplicate-create': 4,
  'forbidden-host': 1,
  'gh-missing': 1,
  'git-missing': 1,
  'id-too-short': 1,
  integrity: 5,
  'invalid-transition': 4,
  'malformed-event': 1,
  'malformed-task-ref': 1,
  'malformed-tasks': 1,
  'method-not-allowed': 1,
  'missing-actor': 1,
  'missing-status': 1,
  'needs-task-link': 4,
  'needs-task-or-adhoc': 1,
  'no-cache': 5,
  'no-disposition': 1,
  'no-targets': 1,
  'not-a-tty': 1,
  'not-assignee': 4,
  'not-found': 1,
  'path-outside-tree': 1,
  'port-in-use': 1,
  'schema-mismatch': 5,
  'secret-like': 1,
  'streaming-command': 1,
  'sync-conflict': 3,
  'sync-failed': 3,
  'sync-in-progress': 3,
  'tasks-not-found': 1,
  'too-many-streams': 1,
  unauthorized: 1,
  'unknown-cursor': 1,
  'unknown-ticket': 4,
  'unpromoted-decision': 1,
  'unsupported-source': 1,
  usage: 1,
};

/**
 * One suggested command inside a hint, rendered for `surface`:
 *
 * - CLI: `'agentboard <command> <args>'`, in single quotes: the command
 *   words, then each argument in order, where a key that is a positional of
 *   the command is written as its value and any other key as `--<key>
 *   <value>` (`--<key>` alone for the value `true`). A value containing a
 *   space is written in double quotes. The result, without the quotes,
 *   parses with `parseArgs` to `command` (placeholders such as `<id>`,
 *   `<path>` and `<source>:<ref>#<item>` are ordinary string values).
 * - MCP, when `command` is an MCP tool (`toolName`, not in
 *   `EXCLUDED_COMMANDS`): `<tool> <json>` without quotes, where `<json>` is
 *   `JSON.stringify` of `args` with its keys in the order given (for
 *   example `board_inbox {"as":"reviewer"}`); `true` stays a JSON
 *   boolean, and the value of an integer argument (a checklist index) is a
 *   JSON number. The JSON is accepted by `toolArguments` for that tool.
 * - MCP, when `command` is not a tool (`init`, `sync`, `rebuild`, `watch`,
 *   `mcp`, `version`, `help`): the CLI form, which the agent runs in a
 *   shell.
 *
 * `args` keys are registry argument names (`id`, `task`,
 * `decision-recorded-in`, `as`). Pure.
 */
export function hintStep(
  surface: HintSurface,
  command: string,
  args: readonly (readonly [string, string | true])[],
): string {
  const spec = findCommand(command);
  const tool = spec === undefined ? undefined : toolOf(spec);
  if (surface === 'mcp' && spec !== undefined && tool !== undefined) {
    const json: Record<string, string | number | true> = {};
    for (const [key, value] of args) {
      const integer = [...spec.positionals, ...spec.flags].some(
        (arg) => arg.name === key && arg.type === 'integer',
      );
      json[key] = integer && value !== true ? Number(value) : value;
    }
    return `${tool} ${JSON.stringify(json)}`;
  }
  const positionals = new Set(spec?.positionals.map((arg) => arg.name));
  const words = ['agentboard', command];
  for (const [key, value] of args) {
    if (positionals.has(key)) {
      words.push(shellWord(value === true ? key : value));
    } else if (value === true) {
      words.push(`--${key}`);
    } else {
      words.push(`--${key}`, shellWord(value));
    }
  }
  return `'${words.join(' ')}'`;
}

/**
 * The hint for `reason` in `context`, or null when `reason` is null or not
 * in `HINT_REASONS`. A hint is one non-empty line of plain ASCII (no
 * newline, no leading or trailing space), not starting with `hint:`, whose
 * suggested commands are written with `hintStep`. In it, `<id>` stands for
 * `context.id` and `<actor>` for `context.actor` whenever those are
 * unknown; a known id or actor always replaces its placeholder.
 *
 * Contract per reason (I is the id or `<id>`, A the actor or `<actor>`; a
 * step `X` below means `hintStep(context.surface, ...)` of it, so on MCP
 * a tool step becomes a tool call). Every hint of an exit 1 or exit 4
 * reason contains at least one step (board-agent-guidance: the hint names
 * a command that moves the caller forward); where an entry below names no
 * step, the hint ends with step `help <command>`, or step `help` when the
 * command is unknown or is `help`. Over MCP, the only steps written in
 * CLI form are those of commands that are not tools.
 *
 * Exit 1:
 * - `usage`: CLI: step `help <command>` when the command is known and is
 *   not `help`, else step `help`. MCP: names the tool (`board_<name>`) and
 *   says to check its input schema in `tools/list`; with no known command,
 *   says to call `tools/list`.
 * - `missing-actor`: CLI: says to pass `--as <actor>` or set
 *   `AGENTBOARD_ACTOR` (both texts appear literally), and does not mention
 *   `agentboard mcp`. MCP: says to pass the `as` argument (the words
 *   `as argument` appear) or to start the server with
 *   `'agentboard mcp --as <actor>'` (that step, in its CLI form), and does
 *   not mention `AGENTBOARD_ACTOR`, which a tool caller cannot set.
 * - `malformed-event`: an agentboard bug; names step `version` to include in
 *   a report.
 * - `id-too-short`, `ambiguous-id`: give a longer unique prefix; step
 *   `list`.
 * - `secret-like`: remove the secret from the text; for a command that has
 *   the flag `--allow-secret-like` (`new`, `comment`, `handoff`), also
 *   pass it for a false positive (the text `--allow-secret-like` appears).
 *   For a known command without that flag (`import-change`, whose text
 *   comes from the tasks file) the flag is never mentioned: the secret
 *   must be removed at its source, the tasks file (the word `tasks`
 *   appears).
 * - `malformed-task-ref`: the form `<source>:<ref>#<item>` and the
 *   OpenSpec shorthand `--change <name> --group <n>`, both literally.
 * - `missing-status`: step `move` with `id` I, `status` `<status>`, `as` A.
 * - `needs-task-or-adhoc`: `--task <source>:<ref>#<item>`,
 *   `--change <name> --group <n>` and `--adhoc <reason>`, literally.
 * - `no-disposition`: steps `close` with I, `decision-recorded-in`
 *   `<path>`, A and `close` with I, `no-decision`, A.
 * - `path-outside-tree`: the path must be inside the working tree; names
 *   `--decision-recorded-in <path>` for close and `--decision <path>` for
 *   link, as fits the command (both when the command is unknown).
 * - `decision-path-missing`: write and commit the spec delta or ADR first,
 *   then step `close` with I, `decision-recorded-in` `<path>`, A.
 * - `unpromoted-decision`: step `show` with I (to read the decisions); then
 *   promote them and step `close` with I, `decision-recorded-in` `<path>`,
 *   A; or retract with a comment beginning `RETRACTED:` (step `comment`
 *   with I, `text` `RETRACTED: <why>`, A).
 * - `unknown-cursor`: step `inbox` with `as` A (and `peek`); when the
 *   command is `serve` (the events API, `/api/events?after=<hash>`), says
 *   that `after` must be the hash of an event listed by `/api/events` and
 *   that leaving it out pages from the first event (the words `after` and
 *   `/api/events` appear), then step `help serve`.
 * - `port-in-use`: another process listens on that port; step `serve`
 *   with `port` `0` (a free port chosen by the system), so `--port`
 *   appears.
 * - The web server's refusals (add-board-web group 3), whose command is
 *   always `serve` and which each end with step `help serve`:
 *   `unauthorized`: open the URL `agentboard serve` printed at start-up
 *   (the token changes at every start) or send `Authorization: Bearer
 *   <token>` (that text appears); `forbidden-host`: use the host
 *   `127.0.0.1` or `localhost` with the port, exactly as printed (both
 *   names appear); `not-found`: names the API routes `/api/session`,
 *   `/api/board`, `/api/tickets/<ticket>`, `/api/events`, `/api/actors` and
 *   `/api/stream`; `method-not-allowed`: the server is read-only and
 *   answers only `GET` (the word `GET` appears); `too-many-streams`: close
 *   other board tabs or clients, at most 64 streams are open at once (the
 *   number `64` appears), then reconnect.
 * - The refusals of the write actions (add-board-web-actions task 1.2),
 *   whose command is `serve` and which each end with step `help serve`:
 *   `read-only`: the server was started without `--as` and is read-only
 *   (the word `read-only` appears); step `serve` with `as` A, so with no
 *   known actor `'agentboard serve --as <actor>'` appears (board-web
 *   scenario "Read-only server refuses actions"); `csrf-failed`: an action
 *   must be posted by the page of this server, or by a script with no
 *   `Origin` header, as `Content-Type: application/json` (the texts
 *   `Content-Type: application/json` and `Origin` appear);
 *   `body-too-large`: an action body is at most 64 KiB (the text `64 KiB`
 *   appears).
 * - `unsupported-source`: only the `openspec` adapter ships; step `new`
 *   with `title` `<title>`, `task` `<source>:<ref>#<item>`, A.
 * - `tasks-not-found`, `malformed-tasks`: fix the tasks file named in the
 *   message (the word `tasks` appears), then step `import-change` with
 *   `name` `<change>`, A. The OpenSpec directory layout itself is never
 *   written here: only `src/board/openspec.ts` may name it (the layering
 *   test in src/board/__tests__/sources.test.ts).
 * - `git-missing`, `gh-missing`: install `git` or `gh` and put it on the
 *   `PATH` (the word `PATH` appears); `gh-missing` also names
 *   `gh auth login`.
 * - `ambiguous-remote`: set an upstream or a remote named `origin` in the
 *   board repository, then step `sync`.
 * - `streaming-command`: run the command from the agentboard executable
 *   (step `<command>` when the command is known).
 * - `no-targets`: `agents install` detected nothing to install; names the
 *   four targets and step `agents install` with `target` `<target>`.
 * - `not-a-tty`: `top` needs an interactive terminal (the word `terminal`
 *   appears); for a snapshot of the board step `list`, and for a line
 *   stream step `watch` with `as` A.
 *
 * Exit 2: `board-not-found`: step `init`, and `AGENTBOARD_DIR`;
 * `board-not-a-repository`: step `help sync`.
 *
 * Exit 3: `sync-in-progress`, `detached-head`, `sync-conflict`,
 * `sync-failed`: what a human does in the board repository, then step
 * `sync`; `sync-conflict` names `git rebase --continue`.
 *
 * Exit 4:
 * - `unknown-ticket`, `duplicate-create`: step `list`.
 * - `invalid-transition`: step `show` with I (for the current status) and
 *   step `help move`.
 * - `already-assigned`: step `show` with I and step `inbox` with `as` A
 *   (board-agent-guidance scenario: the loser of a claim race is told to
 *   run `agentboard inbox --as <itself>`).
 * - `not-assignee`: step `show` with I.
 * - `checklist-index`: step `show` with I.
 * - `needs-task-link`: step `link` with I, `task`
 *   `<source>:<ref>#<item>`, A.
 *
 * Exit 5: `integrity`: a human must inspect the file named in the
 * message; step `rebuild --check`. `busy`: retry the command. `no-cache`,
 * `schema-mismatch`: step `rebuild`.
 *
 * Pure.
 */
export function renderHint(reason: string | null, context: HintContext): string | null {
  const template = reason === null ? undefined : TEMPLATES[reason];
  if (template === undefined) {
    return null;
  }
  const command = context.command === null ? undefined : findCommand(context.command);
  const known = (value: string | undefined, placeholder: string): string =>
    value === undefined || value === '' ? placeholder : value;
  const step = (name: string, args: readonly (readonly [string, string | true])[] = []): string =>
    hintStep(context.surface, name, args);
  return template({
    context,
    id: known(context.id, '<id>'),
    actor: known(context.actor, '<actor>'),
    command,
    step,
    help: () =>
      command === undefined || command.name === 'help'
        ? step('help')
        : step('help', helpTopic(command.name)),
  });
}

/**
 * The hint of a thrown value: `renderHint(error.reason, context)` for a
 * `BoardError`, null for anything else. Pure.
 */
export function hintFor(error: unknown, context: HintContext): string | null {
  return error instanceof BoardError ? renderHint(error.reason, context) : null;
}

/** A shell word: double-quoted when it contains a space. */
function shellWord(value: string): string {
  return value.includes(' ') ? `"${value}"` : value;
}

/** The `help` arguments naming a command of one or two words. */
function helpTopic(name: string): (readonly [string, string])[] {
  const [topic = name, subtopic] = name.split(' ');
  return subtopic === undefined
    ? [['topic', topic]]
    : [
        ['topic', topic],
        ['subtopic', subtopic],
      ];
}

/** The tool name of `command` when it is an MCP tool, else undefined. */
function toolOf(command: CommandSpec | undefined): string | undefined {
  return command === undefined || EXCLUDED_COMMANDS.includes(command.name)
    ? undefined
    : toolName(command.name);
}

/** What one reason's hint is built from. */
interface HintParts {
  readonly context: HintContext;
  /** The id, or `<id>`. */
  readonly id: string;
  /** The actor, or `<actor>`. */
  readonly actor: string;
  /** The context's command when it is a registry command, else undefined. */
  readonly command: CommandSpec | undefined;
  /** `hintStep(context.surface, command, args)`. */
  step(command: string, args?: readonly (readonly [string, string | true])[]): string;
  /** Step `help <command>`, or step `help` when the command is unknown or is `help`. */
  help(): string;
}

/** Renders the hint of one reason. */
type HintTemplate = (parts: HintParts) => string;

/** What a human does in the board repository, then sync again. */
function syncHint(what: string): HintTemplate {
  return (h) => `${what}, then run ${h.step('sync')}`;
}

/** The fix for a tasks file problem, then the import again. */
function tasksHint(what: string): HintTemplate {
  return (h) =>
    `${what}, then run ${h.step('import-change', [
      ['name', '<change>'],
      ['as', h.actor],
    ])} again`;
}

/** Rebuilding the cache from the event log. */
const rebuildHint: HintTemplate = (h) =>
  `rebuild the cache from the events with ${h.step('rebuild')}`;

/** The template of `secret-like`. */
const secretLikeHint: HintTemplate = (h) => {
  const text = 'remove the secret from the text (board events are synced and kept forever)';
  if (h.command === undefined) {
    return `${text}; only for a false positive in new, comment or handoff, pass --allow-secret-like; see ${h.help()}`;
  }
  if (!h.command.flags.some((flag) => flag.name === 'allow-secret-like')) {
    return `remove the secret at its source, the tasks file, then run ${h.step('import-change', [
      ['name', '<change>'],
      ['as', h.actor],
    ])} again`;
  }
  const flag =
    h.context.surface === 'mcp'
      ? 'set the allow-secret-like argument to true'
      : 'pass --allow-secret-like';
  return `${text}; only for a false positive, ${flag}; see ${h.help()}`;
};

/** The template of `path-outside-tree`. */
const pathOutsideTreeHint: HintTemplate = (h) => {
  const name = h.command?.name;
  const flags =
    name === 'close'
      ? '--decision-recorded-in <path>'
      : name === 'link'
        ? '--decision <path>'
        : '--decision-recorded-in <path> (close) or --decision <path> (link)';
  return `the path must name a file inside the current working tree; pass it as ${flags}; see ${h.help()}`;
};

/** The template of `streaming-command`. */
const streamingHint: HintTemplate = (h) => {
  const { command } = h;
  if (command === undefined) {
    return `this command streams its output; run it from the agentboard executable in a shell; see ${h.help()}`;
  }
  const args: (readonly [string, string])[] =
    command.writes || command.tracksCursor === true ? [['as', h.actor]] : [];
  return `run it from the agentboard executable in a shell: ${hintStep('cli', command.name, args)}`;
};

/** Step `help serve`. */
function serveHelp(h: HintParts): string {
  return h.step('help', [['topic', 'serve']]);
}

/** The template of `usage`. */
const usageHint: HintTemplate = (h) => {
  if (h.context.surface === 'cli') {
    return h.command === undefined || h.command.name === 'help'
      ? `see the commands with ${h.help()}`
      : `check the arguments with ${h.help()}`;
  }
  const tool = toolOf(h.command);
  return tool === undefined
    ? `call tools/list for the tool names and their input schemas, or run ${h.help()} in a shell`
    : `check the input schema of ${tool} in tools/list, or run ${h.help()} in a shell`;
};

/** Every reason's template (the contract is on `renderHint`). */
const TEMPLATES: Readonly<Record<string, HintTemplate>> = {
  // Exit 1.
  usage: usageHint,
  'missing-actor': (h) =>
    h.context.surface === 'mcp'
      ? `pass the as argument with your actor name, or start the server with ${h.step('mcp', [['as', '<actor>']])}`
      : `pass --as <actor> or set AGENTBOARD_ACTOR (the actor is never guessed); see ${h.help()}`,
  'malformed-event': (h) =>
    `this is an agentboard bug; report it with the output of ${h.step('version')}`,
  'id-too-short': (h) =>
    `give at least 6 characters of the ticket id; ${h.step('list')} shows the ids`,
  'ambiguous-id': (h) =>
    `give a longer id prefix that matches one ticket; ${h.step('list')} shows the ids`,
  'secret-like': secretLikeHint,
  'malformed-task-ref': (h) =>
    `write the task as <source>:<ref>#<item> (for example openspec:add-login#2), or for OpenSpec --change <name> --group <n>; see ${h.help()}`,
  'missing-status': (h) =>
    `name the status to move to: ${h.step('move', [
      ['id', h.id],
      ['status', '<status>'],
      ['as', h.actor],
    ])} (with no status, move only returns a blocked ticket to where it was)`,
  'needs-task-or-adhoc': (h) =>
    `name the planned task with --task <source>:<ref>#<item> or --change <name> --group <n>, or say why it is unplanned with --adhoc <reason>; see ${h.help()}`,
  'no-disposition': (h) =>
    `close needs a disposition: ${h.step('close', [
      ['id', h.id],
      ['decision-recorded-in', '<path>'],
      ['as', h.actor],
    ])} naming the spec delta or ADR, or ${h.step('close', [
      ['id', h.id],
      ['no-decision', true],
      ['as', h.actor],
    ])} when nothing was decided`,
  'path-outside-tree': pathOutsideTreeHint,
  'decision-path-missing': (h) =>
    `write and commit the spec delta or ADR first, then run ${h.step('close', [
      ['id', h.id],
      ['decision-recorded-in', '<path>'],
      ['as', h.actor],
    ])}`,
  'unpromoted-decision': (h) =>
    `read the DECISION: comments with ${h.step('show', [['id', h.id]])}, promote them to a spec delta or ADR and run ${h.step(
      'close',
      [
        ['id', h.id],
        ['decision-recorded-in', '<path>'],
        ['as', h.actor],
      ],
    )}, or if you wrote one, retract it with ${h.step('comment', [
      ['id', h.id],
      ['text', 'RETRACTED: <why>'],
      ['as', h.actor],
    ])}`,
  'unknown-cursor': (h) =>
    h.command?.name === 'serve'
      ? `after must be the hash of an event listed by /api/events; leave it out to page from the first event; see ${serveHelp(h)}`
      : `${h.context.surface === 'mcp' ? 'the since argument' : '--since'} needs the full hash of an event on this board; ${h.step(
          'inbox',
          [
            ['as', h.actor],
            ['peek', true],
          ],
        )} lists the events without acknowledging them`,
  'unsupported-source': (h) =>
    `only the openspec source can be imported; create a ticket for other planned work with ${h.step(
      'new',
      [
        ['title', '<title>'],
        ['task', '<source>:<ref>#<item>'],
        ['as', h.actor],
      ],
    )}`,
  'tasks-not-found': tasksHint('check the change name and that its tasks file exists'),
  'malformed-tasks': tasksHint('fix the tasks file named in the message'),
  'git-missing': (h) =>
    `install git and put it on the PATH, then run the command again; see ${h.help()}`,
  'gh-missing': (h) =>
    `install the GitHub CLI gh, put it on the PATH and run gh auth login, then run ${h.step(
      'close-merged',
      [['as', h.actor]],
    )} again`,
  'ambiguous-remote': syncHint(
    'in the board repository, set an upstream for the branch or name one remote origin',
  ),
  'streaming-command': streamingHint,
  'port-in-use': (h) =>
    `another process listens on that port; let the system choose a free one with ${h.step('serve', [['port', '0']])}, or pass another --port`,
  unauthorized: (h) =>
    `open the URL that agentboard serve printed at start-up (the token changes at every start), or send Authorization: Bearer <token>; see ${serveHelp(h)}`,
  'forbidden-host': (h) =>
    `use the address exactly as printed at start-up, with the host 127.0.0.1 or localhost and the port; see ${serveHelp(h)}`,
  'not-found': (h) =>
    `the API routes are /api/session, /api/board, /api/tickets/<ticket>, /api/events, /api/actors and /api/stream; see ${serveHelp(h)}`,
  'method-not-allowed': (h) =>
    `the board server is read-only and answers only GET requests; see ${serveHelp(h)}`,
  'too-many-streams': (h) =>
    `at most 64 streams are open at once; close other board tabs or clients, then reconnect; see ${serveHelp(h)}`,
  'not-a-tty': (h) =>
    `top needs an interactive terminal; for a snapshot of the board use ${h.step('list')}, and for a line stream ${h.step('watch', [['as', h.actor]])}`,
  'no-targets': (h) =>
    `choose what to install with ${h.step('agents install', [['target', '<target>']])}, where <target> is claude, agents-md, openspec or mcp-json`,
  // Exit 2.
  'board-not-found': (h) =>
    `create the board with ${h.step('init')} at the root of the main checkout, or set AGENTBOARD_DIR to an existing board`,
  'board-not-a-repository': (h) =>
    `the board directory must be the top level of its own git repository; see ${h.step('help', [['topic', 'sync']])}`,
  // Exit 3.
  'sync-in-progress': syncHint(
    'a human finishes or aborts the rebase, merge or cherry-pick in progress in the board repository',
  ),
  'detached-head': syncHint('a human checks out a branch in the board repository'),
  'sync-conflict': syncHint(
    'a human resolves the conflict in the board repository, runs git add and git rebase --continue (or --abort)',
  ),
  'sync-failed': syncHint(
    'a human fixes what the message names in the board repository (content staged by hand, the remote or the network)',
  ),
  // Exit 4.
  'unknown-ticket': (h) => `no ticket matches that id; find it with ${h.step('list')}`,
  'duplicate-create': (h) => `that ticket already exists; find it with ${h.step('list')}`,
  'invalid-transition': (h) =>
    `check the current status with ${h.step('show', [['id', h.id]])} and the permitted moves with ${h.step('help', [['topic', 'move']])}`,
  'already-assigned': (h) =>
    `another actor holds this ticket, so do not work on it: see who with ${h.step('show', [['id', h.id]])}, or find your own work with ${h.step('inbox', [['as', h.actor]])}`,
  'not-assignee': (h) =>
    `only the assignee can do this; see who holds the ticket with ${h.step('show', [['id', h.id]])}`,
  'checklist-index': (h) =>
    `checklist lines are numbered from 0; see them with ${h.step('show', [['id', h.id]])}`,
  'needs-task-link': (h) =>
    `an ad hoc ticket cannot enter implementing until it names a planned task: ${h.step('link', [
      ['id', h.id],
      ['task', '<source>:<ref>#<item>'],
      ['as', h.actor],
    ])}`,
  // Exit 5.
  integrity: (h) =>
    `a human must inspect the file named in the message; compare the cache with the events using ${h.step('rebuild', [['check', true]])}`,
  busy: () => 'another process held the board cache too long; run the command again',
  'no-cache': rebuildHint,
  'schema-mismatch': rebuildHint,
};
