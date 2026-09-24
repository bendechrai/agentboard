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

import { asciiText } from '../board/text.js';
import type { CommandOutput } from '../cli/types.js';
import { BoardError } from '../store/errors.js';

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
  return (ROLES as readonly string[]).includes(text);
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
  return text([`Agent guide for agentboard ${version}`, ...GUIDE_BODY]);
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
  return text(['', `Checklist: ${role}`, ...CHECKLISTS[role]]);
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
  if (role === undefined) {
    const guide = renderGuide(version);
    const json: AgentsHelpDocument = { topic: 'agents', version, role: null, text: guide };
    return { text: guide, json };
  }
  if (!isRole(role)) {
    throw new BoardError(
      1,
      'usage',
      `unknown role ${asciiText(role)}; the roles are ${ROLES.join(', ')}`,
    );
  }
  const out = renderGuide(version) + renderRoleChecklist(role);
  const json: AgentsHelpDocument = { topic: 'agents', version, role, text: out };
  return { text: out, json };
}

/**
 * The URI of the MCP resource that serves the guide (board-agent-guidance:
 * "Guide over MCP"). Its text is exactly `renderGuide(VERSION)`, the stdout
 * of `agentboard help agents`. The resource of each role's checklist is
 * this URI, a slash and the role (`agentboard://guide/implementer`), and
 * its text is exactly the stdout of `agentboard help agents --role <role>`
 * (see `createMcpServer` in `src/mcp/server.ts`).
 */
export const GUIDE_RESOURCE_URI = 'agentboard://guide';

/** The most characters the guide summary (the MCP server `instructions`) may have. */
export const GUIDE_SUMMARY_MAX_CHARS = 2000;

/**
 * The summary of the guide that the MCP server sends as its
 * `instructions` at initialization (board-agent-guidance: "Guide over
 * MCP"; add-agent-guidance task 4.1). Many clients put the instructions
 * in the model's context unasked, while the full guide is only read on
 * demand, so the summary carries the rules an agent must never break and
 * points to the full guide for the rest.
 *
 * Decisions recorded here (test author, task group 4):
 * - The summary is its own template in this module, beside the guide, not
 *   cut out of the guide's text: the guide is written for a shell and
 *   would not fit in 2000 characters. It is kept consistent with the guide
 *   by the tests instead: every command line it shows is also a command
 *   line of the guide, and every tool it names is served.
 * - It is written for an MCP client: tools (`board_...`) rather than
 *   command lines, and the `as` argument rather than `--as`.
 *
 * Format:
 * - First line exactly `Agent guide summary for agentboard <version>` (the
 *   version stamp, which must not begin with `agentboard `).
 * - At most `GUIDE_SUMMARY_MAX_CHARS` characters in all, the final newline
 *   included. Plain ASCII (printable characters and newlines only, no
 *   tabs), no trailing spaces, ends with one newline (not an empty line).
 * - The command line rule of this module holds: a line whose text,
 *   ignoring leading spaces, begins with `agentboard ` is a complete
 *   command line that parses against the registry, passes `--as` when its
 *   command writes or tracks a cursor, and is also a command line of the
 *   guide; prose lines never begin with the word agentboard. Every tool
 *   name it mentions (`board_...`) is one the server lists.
 * - It ends by naming the full guide: its last line ends with
 *   `agentboard://guide.` (`GUIDE_RESOURCE_URI` and a period), and that
 *   last sentence calls it the `full guide` (or `full agent guide`).
 *
 * Content (the rules the installed guidance also states):
 * - What the tools are: `board_` plus the command, the same arguments
 *   without the leading `--`.
 * - The actor rule: pass the `as` argument (the words `as argument`
 *   appear) on every call; without it the server's own actor, from the
 *   command line `agentboard mcp --as <actor>` (on a line of its own), and
 *   then `AGENTBOARD_ACTOR`, is used; the actor is never guessed.
 * - Finding work: `board_inbox` before starting work, and the board
 *   (`board_list`, `board_show`) rather than memory for its state.
 * - Claim before work: `board_claim` before any work on a ticket;
 *   `already-assigned` means another actor holds it, so do not work on it.
 * - Never stop silently: `board_handoff` with a note when done, or
 *   `board_move` to `blocked` plus a `board_comment` saying why when stuck.
 * - Decisions: a comment beginning `DECISION:` records a decision, which is
 *   promoted to a `spec delta` or an `ADR` before `board_close`.
 * - Completion: the board is not the record of completion (the word
 *   `completion` appears); the task lines in `tasks.md` are ticked in the
 *   implementing pull request.
 * - Secrets: the board is not a secret store (the word `secret` appears);
 *   text that looks like one is refused.
 * - Errors: a failed call returns `exitCode`, `reason`, `message` and
 *   `hint`, and the hint names what to do next.
 * - Role checklists: the text `agentboard://guide/<role>` names the
 *   checklist resources, with the four roles.
 *
 * Pure.
 */
export function renderGuideSummary(version: string): string {
  throw new Error(`not implemented: renderGuideSummary(${version})`);
}

/** `lines` joined into text that ends with one newline. */
function text(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/**
 * The guide after its version line. Command lines are indented by two
 * spaces and must parse (see the module comment); prose lines must never
 * begin with the word agentboard.
 */
const GUIDE_BODY: readonly string[] = [
  '',
  'Read this before your first board command. In the commands below, <id>,',
  '<actor>, <path> and the like stand for your own values. A ticket id may be',
  'shortened to any unique prefix of at least 6 characters. Every command',
  'accepts --json and then prints one JSON document on stdout. For the',
  'checklist of your role, add --role with orchestrator, test-author,',
  'implementer or reviewer.',
  '',
  'What the board is and is not',
  'A local, offline ticket board shared by the agents (and humans) working on',
  'one project, in every worktree of it. Each change is written as its own',
  'append-only event file under .board/, and that event log is the source of',
  'truth, so agents writing at the same time never overwrite each other. It is:',
  '- not a secret store: text that looks like a secret is refused (exit 1),',
  '  and events are synced and kept forever; pass --allow-secret-like only for',
  '  a false positive;',
  '- not the record of completion: the checkboxes in tasks.md, ticked in the',
  '  pull request that does the work, are;',
  '- not where decisions live: they belong in a spec delta or an ADR;',
  '- not a source of scope: every ticket names the planned task it delivers.',
  '',
  'The actor rule',
  'Every command that writes, and inbox and watch (which keep a cursor per',
  'actor), needs an actor: --as <actor>, or else the AGENTBOARD_ACTOR',
  'environment variable. With neither, the command exits 1. The actor is',
  'never inferred from the OS user. Every command accepts --as, so pass it',
  'on every call. Use one stable name per role instance, such as impl-1.',
  '',
  'Finding work',
  'Ask the board every time; never rely on a remembered picture of it.',
  '  agentboard inbox --as <actor>',
  '  agentboard list --status todo',
  '  agentboard list --assignee <actor>',
  '  agentboard list --change <change>',
  '  agentboard show <id>',
  'inbox prints every event since your last inbox (your own included) and',
  'acknowledges them, so the next call prints only newer ones: run it before',
  'starting or dispatching work. --peek lists without acknowledging. list',
  'prints open tickets, one per line; show prints one ticket in full, with',
  'its checklist, links and comments.',
  '',
  'Claiming before you start',
  'Claim a ticket before doing any work on it:',
  '  agentboard claim <id> --as <actor>',
  'Exit 4 with already-assigned means another actor holds it: do not work on',
  'it. Claiming a ticket you already hold succeeds and writes nothing, so a',
  'retried claim is safe, and when agents race for a ticket exactly one wins.',
  'To give a ticket up, release it:',
  '  agentboard release <id> --as <actor>',
  '',
  'Handing off and blocking',
  'Never stop silently. When your part is done, hand off: reassign, move and',
  'leave a note, all in one event:',
  '  agentboard handoff <id> --to <next-actor> --status review --note "<what and where>" --as <actor>',
  'When you are stuck, block the ticket and say why in a comment:',
  '  agentboard move <id> blocked --as <actor>',
  '  agentboard comment <id> "<why, and what would unblock it>" --as <actor>',
  'When the blocker is gone, this returns the ticket to where it was:',
  '  agentboard move <id> --as <actor>',
  'Statuses: todo, tests (tests being written), implementing, review, merged',
  '(the work has landed; terminal) and blocked. Permitted moves: todo to',
  'tests, tests to implementing, implementing to review, review back to',
  'implementing or tests or on to merged, and any status but merged to',
  'blocked. Any other move exits 4 with invalid-transition. Comment text that',
  'starts with -- goes after a lone --.',
  '',
  'Decisions and closing',
  'When a discussion settles something, record it in a comment that begins',
  'with DECISION:',
  '  agentboard comment <id> "DECISION: <what was decided>" --as <actor>',
  'Before the ticket closes, promote each decision to a spec delta or an ADR',
  'in the repository. Only merged or blocked tickets close, and close needs',
  'exactly one disposition, the file that records the decision or none:',
  '  agentboard close <id> --decision-recorded-in <path> --as <actor>',
  '  agentboard close <id> --no-decision --as <actor>',
  'The path must name an existing file inside the working tree.',
  '--no-decision is refused (exit 1) while the ticket has a DECISION: comment',
  'that its author has not retracted with a later comment beginning',
  'RETRACTED:.',
  '',
  'Tickets and planning tasks',
  'Every ticket names the planned task it delivers as --task',
  '<source>:<ref>#<item>; for OpenSpec, --change <name> --group <n> is short',
  'for openspec:<name>#<n>. Work that is not planned says why with --adhoc:',
  '  agentboard new "<title>" --change <change> --group <n> --as <actor>',
  '  agentboard new "<title>" --adhoc "<reason>" --as <actor>',
  'An ad hoc ticket cannot enter implementing (exit 4, needs-task-link) until',
  'it is linked to a task:',
  '  agentboard link <id> --task <source>:<ref>#<item> --as <actor>',
  'The OpenSpec flow: after a change is proposed, import it, which creates one',
  'ticket per task group; run it again whenever its tasks.md gains lines (no',
  'duplicates are created):',
  '  agentboard import-change <change> --as <actor>',
  "Claim the group's ticket before applying the change:",
  '  agentboard claim <id> --as <actor>',
  'Tick the task lines in tasks.md in the implementing pull request;',
  'checklist tick on the board only marks the ticket and reminds you to. Link',
  'the pull request to the ticket (link <id> --pr <pr>). Once it has merged',
  'and the ticket has moved to merged, close-merged closes it, with its',
  'decision link (link <id> --decision <path>) as the disposition if it has',
  'one; it asks GitHub through gh:',
  '  agentboard close-merged --as <actor>',
  '',
  'Using the MCP tools',
  "When the board's MCP server is connected, use its tools instead of the",
  'shell. Each command is a tool named board_ plus the command, with spaces',
  'and hyphens as underscores: board_claim, board_inbox, board_handoff,',
  'board_checklist_tick. Tools take the same arguments without the leading',
  '--, and the actor is the as argument; without it, a call uses the',
  "server's own actor, set when it was started as",
  '  agentboard mcp --as <actor>',
  "and then the server's AGENTBOARD_ACTOR. A failed call returns exitCode,",
  'reason, message and hint. init, watch, rebuild, sync, mcp, version and',
  'help are not tools; run those in a shell.',
  '',
  'Exit codes and hints',
  '  0  success',
  '  1  usage error, missing actor, refused text or close disposition, or rebuild --check found a difference',
  '  2  board not found or unreadable',
  '  3  sync problem that needs a human',
  '  4  rejected by board state: invalid-transition, already-assigned, not-assignee, unknown-ticket, needs-task-link, checklist-index',
  '  5  event log or cache integrity problem, or the cache is busy',
  'Every refusal also prints a line starting with hint: on stderr (the hint',
  'field over MCP) naming what to run next. For the arguments of a command:',
  '  agentboard help <command>',
];

/** The steps of each role's checklist (after its heading). */
const CHECKLISTS: Readonly<Record<Role, readonly string[]>> = {
  orchestrator: [
    '1. Before dispatching anything, read and act on every entry of:',
    '  agentboard inbox --as <actor>',
    '2. When a change is proposed, or its tasks.md gains lines, import it:',
    '  agentboard import-change <change> --as <actor>',
    '3. Dispatch one agent per ticket and role (test author, implementer,',
    '   reviewer), each with its own actor name; give it the ticket id and',
    '   have it read the guide for its role:',
    '  agentboard help agents --role <role>',
    '4. Check state on the board, never from memory:',
    '  agentboard list --change <change>',
    '  agentboard show <id>',
    '5. After a pull request merges, move its ticket to merged. Promote every',
    '   DECISION: comment to a spec delta or ADR first, then close the ticket,',
    '   with close-merged (for tickets with a pr link) or by hand:',
    '  agentboard move <id> merged --as <actor>',
    '  agentboard close-merged --as <actor>',
    '  agentboard close <id> --decision-recorded-in <path> --as <actor>',
  ],
  'test-author': [
    '1. Claim the ticket and move it to tests:',
    '  agentboard claim <id> --as <actor>',
    '  agentboard move <id> tests --as <actor>',
    '2. Write failing tests from the spec, plus stubs for the API they use.',
    '   Do not implement the behavior.',
    '3. Hand off to the implementer, saying where the tests are:',
    '  agentboard handoff <id> --to <implementer> --status implementing --note "<tests and stubs>" --as <actor>',
  ],
  implementer: [
    '1. Claim the ticket, or accept the handoff you were given:',
    '  agentboard claim <id> --as <actor>',
    '2. Make the tests pass without editing them. Tick the task lines in',
    '   tasks.md in the implementing pull request.',
    '3. Record each decision you take as a comment:',
    '  agentboard comment <id> "DECISION: <what was decided>" --as <actor>',
    '4. When stuck, block the ticket with a comment saying why:',
    '  agentboard move <id> blocked --as <actor>',
    '  agentboard comment <id> "<why>" --as <actor>',
    '5. When done, hand off to the reviewer:',
    '  agentboard handoff <id> --to <reviewer> --status review --note "<what changed>" --as <actor>',
  ],
  reviewer: [
    '1. Claim the ticket:',
    '  agentboard claim <id> --as <actor>',
    '2. Review the work against the spec and its scenarios.',
    '3. To send it back, hand off with a note (use --status tests when the',
    '   tests need changing):',
    '  agentboard handoff <id> --to <implementer> --status implementing --note "<findings>" --as <actor>',
    '4. To approve, link the pull request:',
    '  agentboard link <id> --pr <pr> --as <actor>',
  ],
};
