/**
 * Error hints (board-agent-guidance: "Error hints"): every refusal carries one
 * line naming what moves the caller forward, printed by the CLI on stderr as
 * `hint: <hint>` and carried by MCP tool errors as the `hint` field.
 *
 * Design notes:
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
 * - The error message itself is the same on both surfaces: board-cli says a
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

import { ClaimRefusedError } from '../board/actions.js';
import { isoTime } from '../board/leases.js';
import { isIdShaped } from '../board/resolve.js';
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
   * Callers fill it whatever its shape; `renderHint` writes it only when
   * it is id-shaped (`isIdShaped`) and writes `<id>` otherwise.
   */
  readonly id?: string;
  /**
   * The actor, when known: on the CLI the `--as` value or else
   * `AGENTBOARD_ACTOR`; over MCP the call's `as`, else the server's
   * `--as`, else the server's `AGENTBOARD_ACTOR`. Undefined (or empty)
   * when none is known, and undefined when the name has not passed the
   * actor check (`checkActorName`): callers fill it only with a name that
   * passes, so no hint repeats a refused or unchecked name (board-cli
   * "Actor names are checked").
   */
  readonly actor?: string;
  /**
   * True when the hint answers a web action (`runAction`,
   * `src/web/actions.ts`): the browser passes no actor and cannot set
   * `AGENTBOARD_ACTOR`; the server's actor was given as `serve --as`, and
   * the new assignee of a hand-off is the body's `to`. Only the
   * `invalid-actor` hint reads it; every other hint is the CLI hint of
   * its reason. Undefined on the CLI and over MCP.
   */
  readonly web?: true;
  /**
   * The decision disposition `close` was given, when the command is
   * `close` and it was parsed: `--no-decision`, or `--decision-recorded-in`
   * with the path exactly as given. Undefined for every other command and
   * when it is unknown. `cliHintContext` (`src/cli/main.ts`) fills it from
   * the parsed values and `runTool` (`src/mcp/server.ts`) from the tool
   * arguments, so the `needs-scope-disposition` and `already-linked` hints
   * of `close` repeat the decision flag the caller gave.
   */
  readonly closeDecision?:
    | { readonly flag: 'no-decision' }
    | { readonly flag: 'decision-recorded-in'; readonly path: string };
  /**
   * For `already-assigned` on a ticket held under a lease: the time, in
   * milliseconds since the epoch, from which the ticket can be claimed
   * (`expiresAt + LEASE_SKEW_MS`). `hintFor` fills it from a
   * `ClaimRefusedError` (`src/board/actions.ts`) whose `lease` is not
   * null; undefined otherwise.
   */
  readonly claimableAt?: number;
  /**
   * True when the command is `release` and `--force` (the `force`
   * argument over MCP) was given, so the `not-assignee` hint of a forced
   * release on an unassigned ticket says there is nothing to force.
   * `cliHintContext` and `runTool` fill it as they fill `closeDecision`;
   * undefined for every other command and when it is unknown.
   */
  readonly force?: boolean;
}

/**
 * The `closeDecision` of a `HintContext` from the parsed values of `close`
 * (the CLI) or the arguments of `board_close` (MCP): `no-decision` when
 * that is true, `decision-recorded-in` with its path when that is a
 * non-empty string, else undefined. Pure.
 */
export function closeDecisionOf(
  values: Readonly<Record<string, unknown>>,
): HintContext['closeDecision'] | undefined {
  const path = values['decision-recorded-in'];
  if (typeof path === 'string' && path !== '') {
    return { flag: 'decision-recorded-in', path };
  }
  return values['no-decision'] === true ? { flag: 'no-decision' } : undefined;
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
  'already-linked',
  'ambiguous-id',
  'ambiguous-remote',
  'board-in-host',
  'board-link-broken',
  'board-not-a-repository',
  'board-not-found',
  'board-on-branch',
  'body-too-large',
  'busy',
  'checklist-index',
  'csrf-failed',
  'decision-path-missing',
  'detached-head',
  'duplicate-create',
  'forbidden-host',
  'gh-missing',
  'git-missing',
  'git-too-old',
  'holder-changed',
  'id-too-short',
  'integrity',
  'invalid-actor',
  'invalid-queue',
  'invalid-transition',
  'malformed-event',
  'malformed-task-ref',
  'malformed-tasks',
  'method-not-allowed',
  'missing-actor',
  'missing-status',
  'needs-scope-disposition',
  'needs-task-or-adhoc',
  'no-cache',
  'no-disposition',
  'no-host-repository',
  'no-targets',
  'not-a-board',
  'not-a-tty',
  'not-assignee',
  'not-found',
  'path-outside-tree',
  'port-in-use',
  'queued',
  'read-only',
  'reconcile-ambiguous',
  'reconcile-blocked',
  'remote-mismatch',
  'remote-unreachable',
  'schema-mismatch',
  'secret-like',
  'stale-grant',
  'stale-import',
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
  'unsynced',
  'usage',
  'wait-interrupted',
  'wait-timeout',
];

/**
 * The exit code class of each reason in `HINT_REASONS` (a reason belongs to
 * exactly one class: for example `usage` and `missing-actor` are 1,
 * and so are the web server's refusals (`unauthorized`, `forbidden-host`,
 * `not-found`, `method-not-allowed`, `too-many-streams`, `read-only`,
 * `csrf-failed`, `body-too-large`) and
 * `port-in-use`;
 * `board-not-found` 2, `sync-conflict` 3, `already-assigned` 4, `busy` 5).
 */
export const HINT_EXIT_CODES: Readonly<Record<string, Exclude<ExitCode, 0>>> = {
  'already-assigned': 4,
  'already-linked': 4,
  'ambiguous-id': 1,
  'ambiguous-remote': 1,
  'board-in-host': 1,
  'board-link-broken': 2,
  'board-not-a-repository': 2,
  'board-not-found': 2,
  'board-on-branch': 3,
  'body-too-large': 1,
  busy: 5,
  'checklist-index': 4,
  'csrf-failed': 1,
  'decision-path-missing': 1,
  'detached-head': 3,
  'duplicate-create': 4,
  'forbidden-host': 1,
  'gh-missing': 1,
  'git-missing': 1,
  'git-too-old': 1,
  'holder-changed': 4,
  'id-too-short': 1,
  integrity: 5,
  'invalid-queue': 4,
  'invalid-actor': 1,
  'invalid-transition': 4,
  'malformed-event': 1,
  'malformed-task-ref': 1,
  'malformed-tasks': 1,
  'method-not-allowed': 1,
  'missing-actor': 1,
  'missing-status': 1,
  'needs-scope-disposition': 4,
  'needs-task-or-adhoc': 1,
  'no-cache': 5,
  'no-disposition': 1,
  'no-host-repository': 1,
  'no-targets': 1,
  'not-a-board': 1,
  'not-a-tty': 1,
  'not-assignee': 4,
  'not-found': 1,
  'path-outside-tree': 1,
  'port-in-use': 1,
  queued: 4,
  'read-only': 1,
  'remote-mismatch': 1,
  'remote-unreachable': 3,
  'schema-mismatch': 5,
  'secret-like': 1,
  'reconcile-ambiguous': 4,
  'reconcile-blocked': 4,
  'stale-grant': 4,
  'stale-import': 4,
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
  unsynced: 4,
  usage: 1,
  'wait-interrupted': 4,
  'wait-timeout': 4,
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
 * unknown; a known actor always replaces its placeholder, and so does a
 * known id when it is id-shaped (`isIdShaped`, `src/board/resolve.ts`). A
 * `context.id` that is not id-shaped is never written: the hint writes
 * `<id>` for it (board-cli "Ticket ids in refusals").
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
 * - `invalid-actor` (board-cli "Actor names are checked"): says to choose
 *   a name of the actor form (the word `form` and the form itself appear),
 *   one stable name per role, and how to pass it on the surface: CLI:
 *   `--as <actor>`, and `set AGENTBOARD_ACTOR` exactly when the command
 *   uses the variable as its actor (it writes or tracks a cursor; no
 *   other command's hint names the variable), and for `handoff`, after
 *   the actor, `, and the new assignee with --to <actor>`; MCP: the `as
 *   argument` and the step `'agentboard mcp --as <actor>'`, and for
 *   `handoff` `, and the new assignee in the to argument`, never `set
 *   AGENTBOARD_ACTOR`; web (`context.web`): the step `'agentboard serve
 *   --as <actor>'` (the server's actor) and for `handoff` `, and the new
 *   assignee in the to argument`, never `AGENTBOARD_ACTOR`, `--to`,
 *   `agentboard mcp` or `as argument`, none of which a browser can use.
 *   Ends with step `help <command>`. Always the placeholder `<actor>`, never A: the context's
 *   actor is the refused name or has not been checked (actor-secret-check
 *   design.md "No echo of an unchecked actor"), and the hint does not know
 *   which name was refused, so it is the same for every context actor
 *   and id.
 * - `malformed-event`: an agentboard bug; names step `version` to include in
 *   a report.
 * - `id-too-short`, `ambiguous-id`: give a longer unique prefix; step
 *   `list`.
 * - `secret-like`: remove the secret from the text; for a command that has
 *   the flag `--allow-secret-like` (`new`, `comment`, `handoff`, and `move`
 *   and `close` for their `--unplanned` reason), also
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
 * - The web server's refusals, whose command is
 *   always `serve` and which each end with step `help serve`:
 *   `unauthorized`: open the URL `agentboard serve` printed at start-up
 *   (the token changes at every start) or send `Authorization: Bearer
 *   <token>` (that text appears); `forbidden-host`: use the host
 *   `127.0.0.1` or `localhost` with the port, exactly as printed (both
 *   names appear); `not-found`: names the API routes `/api/session`,
 *   `/api/board`, `/api/tickets/<ticket>`, `/api/events`, `/api/actors` and
 *   `/api/stream`, and the actions `POST /api/actions/<action>`;
 *   `method-not-allowed`: the server answers only `GET`, and `POST` on an
 *   action path, which a read-only server refuses (the words `GET` and
 *   `read-only` appear); `too-many-streams`: close
 *   other board tabs or clients, at most 64 streams are open at once (the
 *   number `64` appears), then reconnect.
 * - The refusals of the write actions, whose command is `serve` and which each
 *   end with step `help serve`: `read-only`: the server was started without
 *   `--as` and is read-only (the word `read-only` appears); step `serve` with
 *   `as` A, so with no known actor `'agentboard serve --as <actor>'` appears
 *   (board-web scenario "Read-only server refuses actions"); `csrf-failed`: an
 *   action must be posted by the page of this server, or by a script with no
 *   `Origin` header, as `Content-Type: application/json` (the texts
 *   `Content-Type: application/json` and `Origin` appear); `body-too-large`: an
 *   action body is at most 64 KiB (the text `64 KiB` appears).
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
 * - `ambiguous-remote`: choose the remote with
 *   `git config agentboard.remote <name>` (that text appears) in the
 *   repository that holds the board's history, or name one `origin`, then
 *   step `sync`; when the command is `init` (which refuses before writing
 *   anything), step `init` again, and step `sync` as the command that
 *   uses the same choice.
 * - `git-too-old`: a board in the host repository needs git 2.32 or later
 *   (the text `2.32` and the word `upgrade` appear); upgrade git, then
 *   step `init` with `into-host` when the command is `init`, else step
 *   `sync`.
 * - `not-a-board`: the repository given to `init --remote` has a branch
 *   without an `events/` directory (the word `events` appears); give
 *   `--remote` an empty repository or one that holds a board, then step
 *   `init` with `remote` `<url>`.
 * - `remote-mismatch`: the standalone board already has a remote with
 *   another URL; keep it, or change it with `git -C .board remote set-url
 *   <name> <url>` (the text `remote set-url` appears); step `remote` shows
 *   the remote `sync` would use.
 * - `board-in-host`: the board is already shared through the host
 *   repository at `refs/agentboard/board` (that text appears), which
 *   `--remote` does not apply to; step `remote` shows how it is shared.
 * - `streaming-command`: run the command from the agentboard executable
 *   (step `<command>` when the command is known).
 * - `no-targets`: `agents install` detected nothing to install; names the
 *   four targets and step `agents install` with `target` `<target>`.
 * - `not-a-tty`: `top` needs an interactive terminal (the word `terminal`
 *   appears); for a snapshot of the board step `list`, and for a line
 *   stream step `watch` with `as` A.
 *
 * Exit 2: `board-not-found`: step `init`, and `AGENTBOARD_DIR`;
 * `board-not-a-repository`: step `help sync` (from `init`: move `.board`
 * aside, or step `init` first when it holds event files, then step `init`
 * with `remote` `<url>`); `board-link-broken`: step
 * `init`, which repairs the board's link to the host repository.
 *
 * Exit 3: `sync-in-progress`, `detached-head`, `board-on-branch`,
 * `sync-conflict`, `sync-failed`: what a human does in the board
 * repository, then step `sync`; `sync-conflict` names
 * `git rebase --continue`; `board-on-branch` names
 * `git -C .board switch --detach refs/agentboard/board` (that text
 * appears: a host-model board is synced on a detached HEAD).
 * `remote-unreachable`: create an empty repository at the URL given to
 * `init --remote` (on the git host, or as a local bare repository) and
 * check the access to it (the words `create` and `access` appear; a git
 * host answers the same for a missing repository and one the user cannot
 * read), then step `init` with `remote` `<url>`.
 *
 * Exit 4:
 * - `unknown-ticket`, `duplicate-create`: step `list`.
 * - `invalid-transition`: step `show` with I (for the current status) and
 *   step `help move`.
 * - `already-assigned`: step `show` with I and step `inbox` with `as` A
 *   (board-agent-guidance scenario: the loser of a claim race is told to
 *   run `agentboard inbox --as <itself>`), exactly
 *   `another actor holds this ticket, so do not work on it: see who with <show>, or find your own work with <inbox>`;
 *   when `context.claimableAt` is defined (board-cli: "Lease and queue
 *   hints"), followed by
 *   `; it can be claimed from <isoTime(claimableAt)>, or wait in its queue with <W>`,
 *   where W, the wait step, is step `claim` with `id` I, `ttl`
 *   `<duration>`, `wait`, `timeout` `<duration>`, `as` A on the CLI
 *   (`'agentboard claim I --ttl <duration> --wait --timeout <duration> --as A'`)
 *   and step `claim` with `id` I, `ttl` `<duration>`, `wait`, `as` A over
 *   MCP (`board_claim {"id":"I","ttl":"<duration>","wait":true,"as":"A"}`:
 *   `timeout` is CLI-only).
 * - `not-assignee`: step `show` with I. When the command is `renew`,
 *   exactly
 *   `the lock was lost: you no longer hold this ticket, so stop the work it protects; see who holds it with <show>`.
 *   When the command is `release` and `context.force` is true (a forced
 *   release of an unassigned ticket), exactly
 *   `the ticket is not held, so there is nothing to force; see its holder and queue with <show>`.
 * - `checklist-index`: step `show` with I.
 * - `holder-changed`, `invalid-queue`, `stale-grant`: step `show` with I
 *   (for the current holder, queue and lease, which `show` prints).
 * - `queued`: exactly
 *   `other actors are waiting for this ticket and have priority; wait in its queue with <W>`,
 *   W as for `already-assigned`.
 * - `wait-timeout`: exactly
 *   `the wait timed out and you left the queue; see what happened with <inbox>, then wait again or report ready`,
 *   where `<inbox>` is step `inbox` with `as` A.
 * - `wait-interrupted` (a waiting `claim --wait` stopped by SIGINT or
 *   SIGTERM): exactly
 *   `the wait was interrupted and you left the queue; to wait again run <W>`,
 *   W as for `already-assigned`.
 * - `needs-scope-disposition` (board-agent-guidance: "Error hints",
 *   scenario "Missing disposition hint"; design.md section 9): both forms
 *   of the refused command, each a step, and the text "do not create an
 *   issue or task only to satisfy this" (literally). For the command
 *   `close` (D is the decision flag of `context.closeDecision`:
 *   `no-decision` `true`, or `decision-recorded-in` with its path; when
 *   `closeDecision` is unknown, `no-decision` `true`): step `close` with
 *   I, D, `task` `<source>:<ref>#<item>`, A and step `close` with I, D,
 *   `unplanned` `<reason>`, A. Otherwise (`move`, `handoff`, which takes
 *   no disposition flag, and unknown): step `move` with I, `status`
 *   `merged`, `task` `<source>:<ref>#<item>`, A and step `move` with I,
 *   `status` `merged`, `unplanned` `<reason>`, A. On the CLI the unplanned
 *   step is written with the placeholder in double quotes, exactly
 *   `--unplanned "<reason>"` (the spec's wording; `splitCommandLine` and a
 *   shell both read it as the one word `<reason>`), so for
 *   `move T1 merged --as orch` the hint contains
 *   `'agentboard move T1 merged --task <source>:<ref>#<item> --as orch'`
 *   and `'agentboard move T1 merged --unplanned "<reason>" --as orch'`;
 *   over MCP `board_move {"id":"T1","status":"merged","task":"<source>:<ref>#<item>","as":"orch"}`
 *   and `board_move {"id":"T1","status":"merged","unplanned":"<reason>","as":"orch"}`.
 *   The CLI form also names `--change <name> --group <n>` literally.
 * - `already-linked`: the ticket already names a planned task (the
 *   message names it), so it needs no unplanned reason: step the refused
 *   command without it, that is step `move` with I, `status` `merged`, A
 *   (for `move`, and unknown) or step `close` with I, D, A (for `close`),
 *   and step `show` with I (for the link).
 * - `reconcile-blocked`: step `import-change` with `name` `<change>`,
 *   `dry-run`, `as` A (to see the blocked lines), and step `import-change`
 *   with `name` `<change>`, `force`, `as` A (to reconcile anyway, telling
 *   the holder).
 * - `reconcile-ambiguous`: edit a group title in the tasks file so each
 *   ticket's group is clear (the words `tasks` and `title` appear), after
 *   step `import-change` with `name` `<change>`, `dry-run`, `as` A shows
 *   the candidates.
 * - `stale-import`: step `import-change` with `name` `<change>`,
 *   `dry-run`, `as` A.
 *
 * Exit 5: `integrity`: a human must inspect the file named in the
 * message; step `rebuild --check`. `busy`: retry the command; from `claim`,
 * where a wait whose leave stayed busy leaves the actor queued, also step
 * `unqueue <id> --as <actor>`. `no-cache`,
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
    id: context.id !== undefined && isIdShaped(context.id) ? context.id : '<id>',
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
 * `BoardError`, null for anything else. For a `ClaimRefusedError` whose
 * `lease` is not null, the context's `claimableAt` is that lease's
 * `claimableAt` (so the CLI's stderr hint, the `--json` error document
 * and the MCP tool error all name it). Pure.
 */
export function hintFor(error: unknown, context: HintContext): string | null {
  if (!(error instanceof BoardError)) {
    return null;
  }
  const claimableAt = error instanceof ClaimRefusedError ? error.lease?.claimableAt : undefined;
  return renderHint(
    error.reason,
    claimableAt === undefined ? context : { ...context, claimableAt },
  );
}

/**
 * The wait step of the `already-assigned` and `queued` hints: `claim` with
 * the id, `--ttl <duration>`, `--wait`, on the CLI `--timeout <duration>`
 * (CLI-only, so not over MCP), and the actor.
 */
function waitStep(h: HintParts): string {
  const args: (readonly [string, string | true])[] = [
    ['id', h.id],
    ['ttl', '<duration>'],
    ['wait', true],
  ];
  if (h.context.surface === 'cli') {
    args.push(['timeout', '<duration>']);
  }
  args.push(['as', h.actor]);
  return h.step('claim', args);
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

/**
 * What a human does in the board repository, then sync again. From `init`
 * the same refusal comes from the `sync` that `init --remote` runs, or
 * from `init --into-host` (its step 1 checks on the standalone board, or
 * a conflict in its temporary worktree), so the hint names both commands
 * to run again, `init --into-host` for the move.
 */
function syncHint(what: string, initWhat = what): HintTemplate {
  return (h) =>
    h.command?.name === 'init'
      ? `${initWhat}, then run ${h.step('sync')} (after init --remote) or ${h.step('init', [['into-host', true]])} again (after a move)`
      : `${what}, then run ${h.step('sync')}`;
}

/** The fix for a tasks file problem, then the import again. */
function tasksHint(what: string): HintTemplate {
  return (h) =>
    `${what}, then run ${h.step('import-change', [
      ['name', '<change>'],
      ['as', h.actor],
    ])} again`;
}

/** Step `import-change` with `name` `<change>`, `dry-run` and A. */
function importDryRun(h: HintParts): string {
  return h.step('import-change', [
    ['name', '<change>'],
    ['dry-run', true],
    ['as', h.actor],
  ]);
}

/** Rebuilding the cache from the event log. */
const rebuildHint: HintTemplate = (h) =>
  `rebuild the cache from the events with ${h.step('rebuild')}`;

/** The actor form, as the `invalid-actor` hint states it. */
const ACTOR_FORM_TEXT =
  'the actor form (1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit)';

/**
 * The template of `invalid-actor` (always the placeholder `<actor>`, see
 * `renderHint`). On the CLI, `set AGENTBOARD_ACTOR` is named only for a
 * command that uses the variable as its actor (one that writes or tracks
 * a cursor); for `handoff`, the new assignee follows the actor. For a web
 * action (`context.web`) the actor is the one `serve` was started with,
 * so the hint names that step and, for `handoff`, the `to` argument.
 */
const invalidActorHint: HintTemplate = (h) => {
  const handoff = h.command?.name === 'handoff';
  const choose = `choose a name of ${ACTOR_FORM_TEXT}, one stable name per role, and`;
  if (h.context.web === true) {
    const to = handoff ? ', and the new assignee in the to argument' : '';
    return `${choose} give it as the server's actor with ${h.step('serve', [['as', '<actor>']])}${to}; see ${h.help()}`;
  }
  if (h.context.surface === 'mcp') {
    const to = handoff ? ', and the new assignee in the to argument' : '';
    return `${choose} pass it in the as argument of each call or start the server with ${h.step('mcp', [['as', '<actor>']])}${to}; see ${h.help()}`;
  }
  const usesEnv = h.command !== undefined && (h.command.writes || h.command.tracksCursor === true);
  const env = usesEnv ? ' or set AGENTBOARD_ACTOR' : '';
  const to = handoff ? ', and the new assignee with --to <actor>' : '';
  return `${choose} pass it with --as <actor>${env}${to}; see ${h.help()}`;
};

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

/**
 * The arguments of the refused `move <id> merged` or `close <id> <decision
 * flag>` before its disposition (board-openspec-integration: "Scope
 * disposition at merge and close"): for `close`, the decision flag of
 * `context.closeDecision`, or `--no-decision` when it is unknown; for any
 * other command (`move`, `handoff`, unknown), `move` to `merged`.
 */
function refusedExit(h: HintParts): {
  command: 'move' | 'close';
  args: (readonly [string, string | true])[];
} {
  if (h.command?.name !== 'close') {
    return {
      command: 'move',
      args: [
        ['id', h.id],
        ['status', 'merged'],
      ],
    };
  }
  const decision = h.context.closeDecision;
  return {
    command: 'close',
    args: [
      ['id', h.id],
      decision?.flag === 'decision-recorded-in'
        ? ['decision-recorded-in', decision.path]
        : ['no-decision', true],
    ],
  };
}

/** The template of `needs-scope-disposition`. */
const needsScopeDispositionHint: HintTemplate = (h) => {
  const mcp = h.context.surface === 'mcp';
  const { command, args } = refusedExit(h);
  const task = h.step(command, [...args, ['task', '<source>:<ref>#<item>'], ['as', h.actor]]);
  // On the CLI the placeholder is written in double quotes, as the spec
  // words it; the shell and the parser both read it as the one word
  // <reason>.
  const unplanned = h.step(command, [
    ...args,
    ['unplanned', mcp ? '<reason>' : '"<reason>"'],
    ['as', h.actor],
  ]);
  const shorthand = mcp ? ' (or change and group)' : ' (or --change <name> --group <n>)';
  const exit = command === 'close' ? 'closing' : 'merging';
  return `${exit} needs the scope of the work: run ${task}${shorthand} naming the planned task it delivered, or ${unplanned} saying why it was never planned; do not create an issue or task only to satisfy this`;
};

/** The template of `already-linked`. */
const alreadyLinkedHint: HintTemplate = (h) => {
  const { command, args } = refusedExit(h);
  const again = h.step(command, [...args, ['as', h.actor]]);
  const flag = h.context.surface === 'mcp' ? 'the unplanned argument' : '--unplanned';
  return `the ticket already names a planned task, so it needs no unplanned reason: run ${again} (without ${flag}); see the link with ${h.step('show', [['id', h.id]])}`;
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
  'invalid-actor': invalidActorHint,
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
  'ambiguous-remote': (h) =>
    `in the repository that holds the board history, choose the remote with git config agentboard.remote <name> (or name one of them origin), then run ${
      h.command?.name === 'init'
        ? `${h.step('init')} again (${h.step('sync')} uses the same choice)`
        : h.step('sync')
    }`,
  'git-too-old': (h) =>
    `a board in the host repository needs git 2.32 or later; upgrade git, then run ${
      h.command?.name === 'init' ? h.step('init', [['into-host', true]]) : h.step('sync')
    } again`,
  'not-a-board': (h) =>
    `the repository has a branch without an events/ directory, so it holds no board; give --remote an empty repository or one that holds a board, then run ${h.step('init', [['remote', '<url>']])} again`,
  'remote-mismatch': (h) =>
    `the board already has a remote with another URL; keep it, or change it with git -C .board remote set-url <name> <url>; ${h.step('remote')} shows the remote sync would use`,
  'board-in-host': (h) =>
    `the board is already shared through the host repository at refs/agentboard/board, which --remote does not apply to; ${h.step('remote')} shows how it is shared`,
  'streaming-command': streamingHint,
  'port-in-use': (h) =>
    `another process listens on that port; let the system choose a free one with ${h.step('serve', [['port', '0']])}, or pass another --port`,
  unauthorized: (h) =>
    `open the URL that agentboard serve printed at start-up (the token changes at every start), or send Authorization: Bearer <token>; see ${serveHelp(h)}`,
  'forbidden-host': (h) =>
    `use the address exactly as printed at start-up, with the host 127.0.0.1 or localhost and the port; see ${serveHelp(h)}`,
  'not-found': (h) =>
    `the API routes are /api/session, /api/board, /api/tickets/<ticket>, /api/events, /api/actors and /api/stream, and the actions POST /api/actions/<action> (comment, move, claim, release, handoff, checklist-tick, checklist-untick, link, close); see ${serveHelp(h)}`,
  'method-not-allowed': (h) =>
    `the board server answers only GET requests, and POST to /api/actions/<action> unless it is read-only; see ${serveHelp(h)}`,
  'read-only': (h) =>
    `this board server is read-only because it was started without --as; to act from the page, restart it with ${h.step('serve', [['as', h.actor]])}, or run the command in a shell; see ${serveHelp(h)}`,
  'csrf-failed': (h) =>
    `an action must be posted by the page of this server, or by a script that sends no Origin header, with Content-Type: application/json; see ${serveHelp(h)}`,
  'body-too-large': (h) =>
    `an action body is at most 64 KiB; shorten the text; see ${serveHelp(h)}`,
  'too-many-streams': (h) =>
    `at most 64 streams are open at once; close other board tabs or clients, then reconnect; see ${serveHelp(h)}`,
  'not-a-tty': (h) =>
    `top needs an interactive terminal; for a snapshot of the board use ${h.step('list')}, and for a line stream ${h.step('watch', [['as', h.actor]])}`,
  'no-targets': (h) =>
    `choose what to install with ${h.step('agents install', [['target', '<target>']])}, where <target> is claude, agents-md, openspec or mcp-json`,
  'no-host-repository': (h) =>
    `a move needs a board found through a git repository whose .git directory is inside its working tree (not through AGENTBOARD_DIR, and not a bare, separate-git-dir or submodule host); unset AGENTBOARD_DIR and run ${h.step('init', [['into-host', true]])} at the root of the main checkout`,
  // Exit 2.
  'board-not-found': (h) =>
    `create the board with ${h.step('init')} at the root of the main checkout, or set AGENTBOARD_DIR to an existing board`,
  'board-not-a-repository': (h) =>
    h.command?.name === 'init'
      ? `.board exists but is not a board repository; move it aside (run ${h.step('init')} first instead when it holds event files you want to keep), then run ${h.step('init', [['remote', '<url>']])} again`
      : `the board directory must be the top level of its own git repository; see ${h.step('help', [['topic', 'sync']])}`,
  'board-link-broken': (h) =>
    `the board is a worktree of the host repository whose link is broken; run ${h.step('init')} at the root of the main checkout to repair it`,
  // Exit 3.
  'sync-in-progress': syncHint(
    'a human finishes (git rebase --continue) or aborts (git rebase --abort) the rebase, merge or cherry-pick in progress where the message says (the board repository, or the temporary worktree of a move)',
    'a human finishes (git rebase --continue for a stopped rebase, git cherry-pick --continue or --skip for a stopped cherry-pick) or aborts (git rebase --abort, git cherry-pick --abort) the operation in progress where the message says (the board repository, or the temporary worktree of a move)',
  ),
  'detached-head': syncHint('a human checks out a branch in the board repository'),
  'board-on-branch': syncHint(
    'a human puts the board worktree back on a detached HEAD at the board ref with git -C .board switch --detach refs/agentboard/board',
  ),
  'sync-conflict': syncHint(
    'a human resolves the conflict where the message says (the board repository, or the temporary worktree of a move), runs git add and git rebase --continue (or --abort)',
    'a human resolves the conflict where the message says (the board repository, or the temporary worktree of a move), runs git add and git rebase --continue for a stopped rebase or git cherry-pick --continue for a stopped cherry-pick (or the matching --abort)',
  ),
  'sync-failed': syncHint(
    'a human fixes what the message names in the board repository (content staged by hand, the remote or the network)',
  ),
  'remote-unreachable': (h) =>
    `create an empty repository at that URL (on your git host, or a local bare repository) and check your access to it, then run ${h.step('init', [['remote', '<url>']])} again`,
  // Exit 4.
  unsynced: (h) =>
    `the standalone board has events that are not committed or not pushed, which a move could lose; run ${h.step('sync')} first, then ${h.step('init', [['into-host', true]])} again`,
  'unknown-ticket': (h) => `no ticket matches that id; find it with ${h.step('list')}`,
  'duplicate-create': (h) => `that ticket already exists; find it with ${h.step('list')}`,
  'invalid-transition': (h) =>
    `check the current status with ${h.step('show', [['id', h.id]])} and the permitted moves with ${h.step('help', [['topic', 'move']])}`,
  'already-assigned': (h) => {
    const base = `another actor holds this ticket, so do not work on it: see who with ${h.step('show', [['id', h.id]])}, or find your own work with ${h.step('inbox', [['as', h.actor]])}`;
    const { claimableAt } = h.context;
    return claimableAt === undefined
      ? base
      : `${base}; it can be claimed from ${isoTime(claimableAt)}, or wait in its queue with ${waitStep(h)}`;
  },
  'not-assignee': (h) => {
    const show = h.step('show', [['id', h.id]]);
    if (h.command?.name === 'renew') {
      return `the lock was lost: you no longer hold this ticket, so stop the work it protects; see who holds it with ${show}`;
    }
    if (h.command?.name === 'release' && h.context.force === true) {
      return `the ticket is not held, so there is nothing to force; see its holder and queue with ${show}`;
    }
    return `only the assignee can do this; see who holds the ticket with ${show}`;
  },
  'checklist-index': (h) =>
    `checklist lines are numbered from 0; see them with ${h.step('show', [['id', h.id]])}`,
  'holder-changed': (h) =>
    `the ticket is no longer held by that holder; see who holds it now with ${h.step('show', [['id', h.id]])}`,
  'invalid-queue': (h) =>
    `that queue change does not apply to the ticket as it stands; see its holder and queue with ${h.step('show', [['id', h.id]])}`,
  'stale-grant': (h) =>
    `that grant is no longer the one due; see the ticket's holder, lease and queue with ${h.step('show', [['id', h.id]])}`,
  'reconcile-blocked': (h) =>
    `see the blocked lines with ${importDryRun(h)}, then revise the tasks file or reconcile anyway, telling the holder, with ${h.step(
      'import-change',
      [
        ['name', '<change>'],
        ['force', true],
        ['as', h.actor],
      ],
    )}`,
  'reconcile-ambiguous': (h) =>
    `see the candidates and their scores with ${importDryRun(h)}, then edit a group title in the tasks file so each ticket's group is clear, and import again`,
  'stale-import': (h) =>
    `another import changed the ticket first; see what is left to change with ${importDryRun(h)}`,
  queued: (h) =>
    `other actors are waiting for this ticket and have priority; wait in its queue with ${waitStep(h)}`,
  'wait-interrupted': (h) =>
    `the wait was interrupted and you left the queue; to wait again run ${waitStep(h)}`,
  'wait-timeout': (h) =>
    `the wait timed out and you left the queue; see what happened with ${h.step('inbox', [['as', h.actor]])}, then wait again or report ready`,
  'needs-scope-disposition': needsScopeDispositionHint,
  'already-linked': alreadyLinkedHint,
  // Exit 5.
  integrity: (h) =>
    `a human must inspect the file named in the message; compare the cache with the events using ${h.step('rebuild', [['check', true]])}`,
  busy: (h) =>
    h.command?.name === 'claim'
      ? `another process held the board cache too long; if you were waiting, you are still in the queue: leave it with ${h.step('unqueue', [['id', h.id], ['as', h.actor]])}, or run the command again`
      : 'another process held the board cache too long; run the command again',
  'no-cache': rebuildHint,
  'schema-mismatch': rebuildHint,
};
