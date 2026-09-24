/**
 * The agent guide (board-agent-guidance: "Agent guide"; design.md: "The
 * guide is code, tested against the registry"; add-agent-guidance task
 * 2.1): a self-contained text, printed by `agentboard help agents`, that
 * takes an agent with no prior knowledge to correct use of the board, and
 * a checklist per role, printed after the guide by
 * `agentboard help agents --role <role>`.
 *
 * The guide is a template in this file, stamped with the running version.
 * Every line of its output whose text, ignoring leading spaces, begins with
 * `agentboard ` is a complete command line (nothing after the command, no
 * comment) that parses with the real parser (`parseArgs`) against the
 * registry: the drift guard in `src/guidance/__tests__/guide.test.ts`
 * fails the build when a command or flag it names is renamed. Placeholders
 * are written as `<id>`, `<actor>`, `<change>`, `<path>` and so on, which
 * parse as ordinary string values; an integer argument (a checklist index)
 * is written as a number. Every command line of a command that writes or
 * tracks a cursor passes `--as` (the actor rule, taught by example). Every
 * MCP tool name it mentions (`board_...`) is one the server lists and
 * README.md lists. The guide shows at least 12 command lines in all, and
 * among them `inbox`, `list`, `show`, `claim`, `handoff`, `move`,
 * `comment` and `close`.
 *
 * Decisions recorded here (test author, task group 2):
 * - `--role` is a flag of the `help` command (string, optional), valid only
 *   with the topic `agents`: `agentboard help agents --role implementer`.
 *   With any other topic, or none, it is `BoardError(1, 'usage')` saying
 *   that `--role` applies only to `agentboard help agents`. `help` stays
 *   excluded from MCP.
 * - The topic is exactly the one word `agents`: `help agents` is the guide
 *   even when registry commands start with `agents` (`agents install`,
 *   `agents check`, task group 3), whose help stays reachable as
 *   `help agents install` (see `helpOutput`).
 * - The 150-line cap applies to every output: `help agents` and
 *   `help agents --role <role>` for each role (guide plus checklist), so
 *   the guide itself must leave room for the longest checklist.
 * - `help agents --json` prints `AgentsHelpDocument`.
 *
 * All output is plain ASCII (printable characters and newlines only, no
 * tabs), with no trailing spaces, and ends with one newline. The OpenSpec
 * directory layout is not spelled out (say `tasks.md`): only
 * `src/board/openspec.ts` may name it (src/board/__tests__/sources.test.ts).
 */

import type { CommandOutput } from '../cli/types.js';

/** The roles that have a checklist, in the order they are listed. */
export const ROLES = ['orchestrator', 'test-author', 'implementer', 'reviewer'] as const;

/** One of `ROLES`. */
export type Role = (typeof ROLES)[number];

/** The most lines any guide output may have (`help agents`, with or without `--role`). */
export const GUIDE_MAX_LINES = 150;

/**
 * The section headings of the guide, in order. Each appears in the guide
 * as a line of its own, exactly as written here, preceded by an empty line
 * (board-agent-guidance "Agent guide" names the required content):
 *
 * "Command line" below means a line of its own obeying the rule above; the
 * content tests look for these by parsing them.
 *
 * 1. `What the board is and is not`: a local, offline ticket board shared
 *    by the agents of one project; the event log is the source of truth.
 *    It is not a secret store (text that looks like a secret is refused;
 *    `--allow-secret-like` only for false positives), not the record of
 *    completion (`tasks.md` checkboxes, ticked in the implementing PR,
 *    are), not where decisions live, and not a source of scope.
 * 2. `The actor rule`: every writing command, and `inbox` and `watch`,
 *    needs an actor, `--as <actor>` or else `AGENTBOARD_ACTOR`; the actor
 *    is never inferred from the OS user (those two words appear); every
 *    command accepts `--as`, so pass it always; one stable name per role
 *    instance.
 * 3. `Finding work`: command lines for `inbox` (run before starting or
 *    dispatching work; it acknowledges, `--peek` does not), `list` (its
 *    filters `--status`, `--assignee`, `--change`) and `show`; never rely
 *    on a remembered picture of the board.
 * 4. `Claiming before you start`: a `claim` command line; claim the
 *    ticket before any work;
 *    `already-assigned` (exit 4) means someone else holds it, so do not
 *    work on it; a retried claim is safe; `release` to give it up.
 * 5. `Handing off and blocking`: finish with `handoff` (reassign, move and
 *    note in one event), or move to `blocked` plus a `comment` saying why;
 *    `move <id>` with no status returns a blocked ticket to where it was
 *    (command lines for `handoff`, `move <id> blocked`, `comment` and
 *    `move <id>` with no status); the statuses (every one of `STATUSES`)
 *    and the permitted moves.
 * 6. `Decisions and closing`: a comment beginning `DECISION:` records a
 *    decision, which must be promoted to a spec delta or ADR before the
 *    ticket closes; `close` needs `--decision-recorded-in <path>` or
 *    `--no-decision`, and `--no-decision` is refused while an unretracted
 *    `DECISION:` comment exists (retract with a comment beginning
 *    `RETRACTED:`); only `merged` or `blocked` tickets close. Command lines:
 *    a `comment` whose text begins `DECISION:`, a `close` with
 *    `--decision-recorded-in` and a `close` with `--no-decision`. The words
 *    `spec delta` and `ADR` appear.
 * 7. `Tickets and planning tasks`: every ticket names its task
 *    (`--task <source>:<ref>#<item>`, or `--change <name> --group <n>` for
 *    OpenSpec, or `--adhoc <reason>`); an ad hoc ticket cannot enter
 *    `implementing` until linked (`needs-task-link`); the OpenSpec flow:
 *    `import-change` after proposing a change (and again when its
 *    `tasks.md` grows), claim the group's ticket before applying, tick
 *    `tasks.md` in the implementing PR (`checklist tick` only reminds),
 *    `close-merged` after merge. Command lines: `new` with `--change` and
 *    `--group`, `link` with `--task`, `import-change` and `claim`.
 * 8. `Using the MCP tools`: when the board's MCP server is connected, use
 *    its tools instead of the shell: one tool per command named `board_`
 *    plus the command with spaces and hyphens as underscores (for example
 *    `board_claim`, `board_checklist_tick`), the same arguments without
 *    `--` (the actor is the `as` argument, words `as` and `argument` on one
 *    line), defaulting to the server's actor (a command line
 *    `agentboard mcp --as <actor>`), then its `AGENTBOARD_ACTOR`; errors
 *    carry `exitCode`, `reason`, `message` and `hint`; `init`, `watch`,
 *    `rebuild`, `sync`, `mcp`, `version` and `help` are not tools. It names
 *    at least `board_claim`, `board_inbox`, `board_handoff` and
 *    `board_checklist_tick`.
 * 9. `Exit codes and hints`: one line per exit code 0 to 5, each written
 *    `  <code>  <meaning>` (two spaces, the digit, at least two spaces),
 *    agreeing with board-cli "Exit codes" and README.md: 0 success; 1 usage
 *    error, missing actor or refused text or close disposition; 2 board not
 *    found; 3 sync problem that needs a human; 4 rejected by board state,
 *    listing every exit 4 reason the registry declares
 *    (`invalid-transition`, `already-assigned`, `not-assignee`,
 *    `unknown-ticket`, `needs-task-link`, `checklist-index`); 5 integrity
 *    problem or cache busy. Then: every refusal prints a `hint: ` line on
 *    stderr (the `hint` field over MCP) naming what to run next, and a
 *    command line `agentboard help <command>` shows any command's
 *    arguments.
 */
export const GUIDE_SECTIONS: readonly string[] = [
  'What the board is and is not',
  'The actor rule',
  'Finding work',
  'Claiming before you start',
  'Handing off and blocking',
  'Decisions and closing',
  'Tickets and planning tasks',
  'Using the MCP tools',
  'Exit codes and hints',
];

/** The `--json` form of `help agents` (with or without `--role`). */
export interface AgentsHelpDocument {
  readonly topic: 'agents';
  /** The running version, as stamped on the guide. */
  readonly version: string;
  /** The `--role` given, or null. */
  readonly role: Role | null;
  /** Exactly the text output of the same invocation. */
  readonly text: string;
}

/** True when `text` is one of `ROLES`. Pure. */
export function isRole(text: string): text is Role {
  void text;
  throw new Error('not implemented');
}

/**
 * The guide, as printed by `agentboard help agents`. Its first line is
 * exactly `Agent guide for agentboard <version>` (the version stamp; it
 * must not begin with `agentboard `, which would make it a command line);
 * then, in order, each of `GUIDE_SECTIONS` as described there. At most
 * `GUIDE_MAX_LINES` lines. Plain ASCII, no trailing spaces, ends with one
 * newline. Pure.
 */
export function renderGuide(version: string): string {
  void version;
  throw new Error('not implemented');
}

/**
 * The checklist of `role`, printed after the guide: an empty line, the
 * heading `Checklist: <role>` on a line of its own, then numbered steps
 * (`1. ...`), with the commands of each step on lines of their own that
 * obey the command line rule of this module. Each checklist has at least
 * three command lines, and:
 *
 * - `orchestrator`: its first command line is `inbox` (before
 *   dispatching anything), acting on every entry; `agentboard import-change` for a new or grown
 *   change; dispatching one agent per ticket and role; `agentboard show`
 *   or `list` for state, never memory; `agentboard close-merged` and
 *   `agentboard close` with a decision disposition after merge, promoting
 *   `DECISION:` comments first (the text `DECISION:` appears).
 * - `test-author`: claim, move to `tests`, write failing tests and stubs,
 *   hand off to the implementer with `--status implementing`.
 * - `implementer`: claim (or accept the handoff), make the tests pass
 *   without editing them, tick the task lines in `tasks.md` in the
 *   implementing PR, record decisions as `DECISION:` comments, hand off
 *   with `--status review`; block (a `move <id> blocked` command line) with
 *   a comment when stuck.
 * - `reviewer`: claim, review against the spec, send back with
 *   `--status implementing` (or `tests`) and a note, or approve and link
 *   the pull request (`agentboard link <id> --pr <pr> --as <actor>`).
 *
 * Plain ASCII, no trailing spaces, ends with one newline. Pure.
 */
export function renderRoleChecklist(role: Role): string {
  void role;
  throw new Error('not implemented');
}

/**
 * The output of `agentboard help agents [--role <role>]`:
 * - no role: text `renderGuide(version)`, json `AgentsHelpDocument` with
 *   `role` null.
 * - a role in `ROLES`: text `renderGuide(version) + renderRoleChecklist(role)`
 *   (the guide unchanged, then the checklist), json with that `role`.
 * - any other role (including an empty string): throws
 *   `BoardError(1, 'usage')` whose message names the role given (through
 *   `asciiText`) and lists the four valid roles, for example
 *   `unknown role tester; the roles are orchestrator, test-author, implementer, reviewer`.
 *
 * Needs no board and no actor. Pure.
 */
export function agentsHelpOutput(version: string, role: string | undefined): CommandOutput {
  void version;
  void role;
  throw new Error('not implemented');
}
