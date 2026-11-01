/**
 * The text `agentboard agents install` writes into a host project
 * (board-agent-guidance: "Installing guidance into a host project";
 * add-agent-guidance design.md: "Installed text is a pointer, not a copy",
 * "Ownership markers").
 *
 * The installed text is deliberately thin: when to use the board, the six
 * rules an agent must never break, and a pointer to `agentboard help
 * agents`, which the running CLI prints and which therefore never goes
 * stale. Every artifact carries `GUIDANCE_VERSION`, which `agents check`
 * compares.
 *
 * This module is data: the exact text of every installed artifact, as pure
 * functions of the guidance version. It is plain ASCII throughout.
 */

/**
 * The guidance format version: an integer bumped only when any text in
 * this module changes (not on every package release). Written into every
 * installed artifact's marker and compared by `agents check`. Version 2
 * adds the ad hoc rule (add-adhoc-ticket-lifecycle), so `agents check`
 * reports a version 1 installation `stale`. Version 3 adds the mutex
 * recipe (add-claim-leases, board-agent-guidance: "Mutex ticket recipe"),
 * so a version 2 installation is `stale`: this constant is 3.
 */
export const GUIDANCE_VERSION = 3;

/** The command every installed artifact points to for the full guide. */
export const GUIDE_COMMAND = 'agentboard help agents';

/**
 * The six rules an agent must never break (board-agent-guidance:
 * "Installing guidance into a host project"), in this order: always pass
 * an actor (including the MCP `as` argument and `mcp --as`); claim before
 * working; hand off or block with a comment before stopping; never mark
 * completion on the board instead of in the tasks file; promote
 * `DECISION:` comments before closing; never create an issue, task file or
 * task reference only to move a ticket, but work an ad hoc ticket normally
 * and give its task link or unplanned disposition when merging or closing
 * it (ADR 0013). Each is one line of Markdown.
 *
 * The sixth rule names both flags (`--task` and `--unplanned`), says the
 * words `ad hoc`, and shows the command in backticks, so the drift guard
 * parses it: `agentboard move <id> merged --unplanned "<reason>" --as
 * <you>`. It never says an ad hoc ticket cannot enter `implementing` and
 * never names the task-link refusal ADR 0013 removed (the guide tests
 * search `src/` for that reason name).
 */
export const GUIDANCE_RULES: readonly string[] = [
  'Always pass an actor: `--as <you>` on every command, or set `AGENTBOARD_ACTOR`. Over MCP, pass `as` on every tool call, or start the server with `agentboard mcp --as <you>`.',
  'Claim a ticket before working on it: `agentboard claim <id> --as <you>`. If the claim is refused, another agent holds the ticket: do not work on it.',
  'Before you stop, hand the ticket off or block it with a comment: `agentboard handoff <id> --to <next> --status <status> --note "<what is done>" --as <you>`, or `agentboard comment <id> "<why>" --as <you>` and then `agentboard move <id> blocked --as <you>`.',
  'Never mark completion on the board instead of in the tasks file: tick the task in `tasks.md` (or your planning source) in the implementing pull request. The board is not the record of completion.',
  'Promote every `DECISION:` comment to a spec delta or ADR before the ticket is closed, and close it with `--decision-recorded-in <path>`.',
  'Never create an issue, task file or task reference only to move a ticket. Work an ad hoc ticket normally and give its scope when you merge or close it: `agentboard move <id> merged --unplanned "<reason>" --as <you>` records that its work was never planned, or `agentboard move <id> merged --task <source>:<ref>#<item> --as <you>` links the task it delivered; `close` takes the same flags.',
];

/** Paragraph shared by the skill and the AGENTS.md block: what the board is and when to use it. */
const INTRO: readonly string[] = [
  'This project coordinates its coding agents on agentboard, a local ticket',
  'board. A ticket says which agent is working on which task and where the',
  'work stands. Use it whenever you start, hand off, block or finish work on a',
  'task, and run `agentboard inbox --as <you>` to see what other agents have',
  'done before you start or dispatch work.',
];

/** Paragraph shared by the skill and the AGENTS.md block: the pointer to the full guide. */
const POINTER: readonly string[] = [
  'Run `agentboard help agents` for everything else: finding work, roles,',
  'the OpenSpec flow and the MCP tools. The installed agentboard prints it,',
  'so it always matches the commands you can run. `agentboard help <command>`',
  'shows any command with its arguments, exit codes and examples.',
];

/**
 * Paragraph shared by the skill and the AGENTS.md block: the short mutex
 * recipe (board-agent-guidance: "Mutex ticket recipe"). Every command is in
 * backticks with `--as <you>`, so the drift guard parses it; the only tools
 * it names are `board_claim`, `board_inbox` and `board_renew`.
 */
const MUTEX_RECIPE: readonly string[] = [
  'A mutex (a merge lock, say) is one standing ad hoc ticket, never closed',
  'while in use. Claim it with a lease, `agentboard claim <id> --ttl 30m --as <you>`,',
  'then run `agentboard renew <id> --as <you>` as the first action of real work',
  '(an unconfirmed claim lapses) and again at about half the ttl; when `renew`',
  'is refused the lock is lost: stop. Release when done, including on failure:',
  '`agentboard release <id> --as <you>`. Never wait on a mutex in a loop and',
  'never claim one from a background process: wait in the foreground with',
  '`agentboard claim <id> --ttl 30m --wait --timeout 10m --as <you>` and renew',
  'on return, or report ready to the orchestrator and stop. Over MCP,',
  '`board_claim` with `wait` only joins the queue; the grant arrives in',
  '`board_inbox` and is accepted with `board_renew` within the accept window.',
];

/** The rules as a numbered Markdown list, one line per rule. */
function numberedRules(): string[] {
  return GUIDANCE_RULES.map((rule, index) => `${String(index + 1)}. ${rule}`);
}

/** Relative path (POSIX separators) of the Claude Code skill in the working tree. */
export const SKILL_PATH = '.claude/skills/agentboard/SKILL.md';

/**
 * The skill's frontmatter `description`, on one line: it makes Claude Code
 * load the skill when coordinating work between agents, claiming or
 * handing off tasks, and checking what other agents are doing.
 */
export const SKILL_DESCRIPTION =
  "Coordinates work between coding agents through this project's agentboard ticket board. Use when claiming, starting or handing off a task, when stopping or blocked, when checking what other agents are doing or what is new for you, when recording a decision, or when applying or archiving an OpenSpec change.";

/** The ownership marker of `SKILL.md` for guidance version `version`. */
export function skillMarker(version: number): string {
  return `<!-- agentboard-guidance: v${String(version)} -->`;
}

/**
 * The whole of `.claude/skills/agentboard/SKILL.md` for guidance version
 * `version` (default `GUIDANCE_VERSION`): YAML frontmatter (`name:
 * agentboard` and `SKILL_DESCRIPTION`), which Claude Code requires at the
 * very top, then the marker line `skillMarker(version)`, then the intro,
 * the rules, a section headed `## Mutex tickets` with the short mutex
 * recipe (board-agent-guidance: "Mutex ticket recipe": the worker rules and
 * the backticked claim with `--ttl`, renew, claim with `--ttl --wait
 * --timeout` and release commands, each with `--as <you>`), and the
 * pointer. At most 45 lines. Ends with one newline. Pure.
 */
export function renderSkill(version: number = GUIDANCE_VERSION): string {
  return `${[
    '---',
    'name: agentboard',
    `description: ${SKILL_DESCRIPTION}`,
    '---',
    skillMarker(version),
    '',
    '# agentboard',
    '',
    ...INTRO,
    '',
    '## Rules you must never break',
    '',
    ...numberedRules(),
    '',
    '## Mutex tickets',
    '',
    ...MUTEX_RECIPE,
    '',
    '## Everything else',
    '',
    ...POINTER,
  ].join('\n')}\n`;
}

/** Relative path of the AGENTS.md file in the working tree. */
export const AGENTS_MD_PATH = 'AGENTS.md';

/** The start marker of the managed AGENTS.md block for guidance version `version`. */
export function blockStart(version: number): string {
  return `<!-- agentboard:start v${String(version)} -->`;
}

/** The end marker of the managed AGENTS.md block. */
export const BLOCK_END = '<!-- agentboard:end -->';

/**
 * The managed AGENTS.md block for guidance version `version` (default
 * `GUIDANCE_VERSION`), with the intro, the rules, a paragraph introduced
 * by the line `Mutex tickets:` holding the same short mutex recipe as the
 * skill, and the pointer, at most 40 lines: from the first byte of
 * `blockStart(version)` to the
 * last byte of `BLOCK_END`, lines joined by `\n`, with NO trailing newline
 * (the installer owns the markers and what lies between them, not the line
 * break after the end marker). Pure.
 */
export function renderAgentsBlock(version: number = GUIDANCE_VERSION): string {
  return [
    blockStart(version),
    '## agentboard',
    '',
    ...INTRO,
    '',
    'Rules you must never break:',
    '',
    ...numberedRules(),
    '',
    'Mutex tickets:',
    ...MUTEX_RECIPE,
    '',
    ...POINTER,
    BLOCK_END,
  ].join('\n');
}

/** Relative path of the OpenSpec project config in the working tree. */
export const OPENSPEC_CONFIG_PATH = 'openspec/config.yaml';

/** The prefix every agentboard-owned OpenSpec guidance entry starts with. */
export const OPENSPEC_PREFIX = 'agentboard:';

/** The OpenSpec operations agentboard adds guidance to, in this order. */
export const OPENSPEC_OPERATIONS = ['apply', 'archive'] as const;

/** One of `OPENSPEC_OPERATIONS`. */
export type OpenSpecOperation = (typeof OPENSPEC_OPERATIONS)[number];

/**
 * The guidance entries under `operations.<op>.guidance`, each beginning
 * with `agentboard: ` (board-agent-guidance: apply: claim the task group's
 * ticket before implementing, hand off or block when stopping, tick
 * `tasks.md` in the implementing PR; archive: no open tickets may remain
 * for the change, run `close-merged` first). Every command an entry shows
 * is in backticks, like the Markdown text, so the drift guard can parse it.
 */
export const OPENSPEC_GUIDANCE: Readonly<Record<OpenSpecOperation, readonly string[]>> = {
  apply: [
    'agentboard: Before implementing a task group, claim its ticket: find it with `agentboard list --change <change>` and run `agentboard claim <id> --as <you>`. If the change has no tickets yet, run `agentboard import-change <change> --as <you>` first.',
    'agentboard: Before you stop, hand the ticket off with `agentboard handoff <id> --to <next> --status <status> --note "<what is done>" --as <you>`, or say why with `agentboard comment <id> "<why>" --as <you>` and block it with `agentboard move <id> blocked --as <you>`.',
    'agentboard: Tick finished tasks in tasks.md in the implementing pull request; the board is not the record of completion. Run `agentboard help agents` for the full guide.',
  ],
  archive: [
    'agentboard: Run `agentboard close-merged --as <you>` first, then check with `agentboard list --change <change>` that no ticket of the change is still open; do not archive while one is.',
    'agentboard: Promote every DECISION: comment on the change tickets to a spec delta or ADR before archiving.',
  ],
};

/**
 * The trailing YAML comment text (without `#` and the space after it) that
 * carries the guidance version on every agentboard entry, e.g.
 * `agentboard-guidance: v1`. Written as `- "<entry>" # agentboard-guidance: v1`.
 */
export function openSpecVersionComment(version: number): string {
  return `agentboard-guidance: v${String(version)}`;
}

/**
 * The lines to add to `openspec/config.yaml` by hand, printed when the
 * `openspec` target is refused because a `guidance` key path holds a
 * non-list value: exactly
 *
 * ```
 * operations:
 *   apply:
 *     guidance:
 *       - "<entry>" # agentboard-guidance: v<N>
 *   archive:
 *     guidance:
 *       - "<entry>" # agentboard-guidance: v<N>
 * ```
 *
 * with each entry of `OPENSPEC_GUIDANCE` written as a JSON string (a valid
 * YAML double-quoted scalar for ASCII text). Parsed as YAML, the lines give
 * exactly those entries. Pure.
 */
export function manualOpenSpecLines(version: number = GUIDANCE_VERSION): string[] {
  const lines = ['operations:'];
  for (const op of OPENSPEC_OPERATIONS) {
    lines.push(`  ${op}:`, '    guidance:');
    for (const entry of OPENSPEC_GUIDANCE[op]) {
      lines.push(`      - ${JSON.stringify(entry)} # ${openSpecVersionComment(version)}`);
    }
  }
  return lines;
}

/** Relative path of the project MCP config in the working tree. */
export const MCP_JSON_PATH = '.mcp.json';

/** The key agentboard owns under `mcpServers` in `.mcp.json`. */
export const MCP_SERVER_NAME = 'agentboard';

/** The shape of the managed `.mcp.json` server entry. */
export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The default managed `mcpServers.agentboard` entry: `npx -y
 * @bendechrai/agentboard mcp`, written when `--mcp-command` is not given
 * (see `mcpEntry` for the local shape). It carries no `--as`: the entry is
 * shared by every session and every agent of the project, so it cannot know
 * which agent is acting; each tool call passes its own `as` argument (see
 * rule 1), or an agent that owns its own MCP configuration may add `--as
 * <actor>` by hand (which makes the entry unrecognised, see
 * `isManagedMcpEntry` in `./markers.ts`, so `agents install` then refuses
 * to overwrite it without `--force`). It carries no version either (JSON
 * has no comments, and an unknown key could break MCP clients), so `agents
 * check` classifies it by value.
 */
export const MCP_ENTRY: McpServerEntry = {
  command: 'npx',
  args: ['-y', '@bendechrai/agentboard', 'mcp'],
};

/**
 * The arguments of a local managed entry, written by `agents install
 * --mcp-command <executable>` (board-agent-guidance: "Managed MCP entry"):
 * exactly `["mcp"]`, whatever the executable.
 */
export const MCP_LOCAL_ARGS: readonly string[] = ['mcp'];

/**
 * The `mcpServers.agentboard` entry `agents install` writes
 * (add-mcp-command design.md: "The flag names an executable, not a command
 * line"):
 * - `command` undefined (no `--mcp-command`): a copy of `MCP_ENTRY` (`npx
 *   -y @bendechrai/agentboard mcp`), deep-equal to it;
 * - otherwise `{ command, args: ["mcp"] }` (`MCP_LOCAL_ARGS`), `command`
 *   exactly as given: never trimmed, resolved against the PATH, made
 *   absolute or checked for existence, because `.mcp.json` is read on other
 *   machines too. A path containing spaces stays one string.
 *
 * Always a new object with a new `args` array (never `MCP_ENTRY` or
 * `MCP_LOCAL_ARGS` themselves), with exactly the keys `command` then
 * `args`, in that order. Pure. It does not validate `command`: an empty
 * value or one containing a newline is refused by `installGuidance` before
 * anything is written.
 */
export function mcpEntry(command?: string): McpServerEntry {
  return command === undefined
    ? { command: MCP_ENTRY.command, args: [...MCP_ENTRY.args] }
    : { command, args: [...MCP_LOCAL_ARGS] };
}

/** Relative path of the Claude Code project settings in the working tree. */
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';

/**
 * The text that starts the ownership comment of an agentboard hook command
 * (board-harness-hooks "Hooks installed in Claude settings"; design.md
 * decision 4): the whole comment is `hooksMarker(N)`.
 */
export const HOOKS_MARKER_TEXT = '# agentboard-hooks:';

/**
 * The ownership comment at the end of every agentboard hook command for
 * guidance version `version`: exactly `# agentboard-hooks: v<version>`.
 * Pure.
 */
export function hooksMarker(version: number): string {
  return `${HOOKS_MARKER_TEXT} v${String(version)}`;
}

/** The executable a hook command runs when `--command` is not given. */
export const HOOK_DEFAULT_EXECUTABLE = 'npx -y @bendechrai/agentboard';

/** The `timeout` of every agentboard hook handler, in seconds (at most 5 by the spec). */
export const HOOK_TIMEOUT_SECONDS = 5;

/** The `matcher` of the agentboard `PreToolUse` entry: the file-writing tools. */
export const PRE_TOOL_USE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/** A Claude Code settings event key agentboard writes an entry under. */
export type ClaudeHookKey = 'SessionStart' | 'Stop' | 'PreToolUse';

/** A `hook` event, as `agentboard hook <event>` names it. */
export type ClaudeHookEvent = 'session-start' | 'stop' | 'pre-tool-use';

/**
 * The three settings keys and the `hook` event each runs, in the order the
 * keys are added to a `hooks` object that lacks them.
 */
export const CLAUDE_HOOK_EVENTS: readonly {
  readonly key: ClaudeHookKey;
  readonly event: ClaudeHookEvent;
}[] = [
  { key: 'SessionStart', event: 'session-start' },
  { key: 'Stop', event: 'stop' },
  { key: 'PreToolUse', event: 'pre-tool-use' },
];

/** The `hook` event of each settings key (`CLAUDE_HOOK_EVENTS` as a lookup). */
const EVENT_OF_KEY: Readonly<Record<ClaudeHookKey, ClaudeHookEvent>> = {
  SessionStart: 'session-start',
  Stop: 'stop',
  PreToolUse: 'pre-tool-use',
};

/** What the hook entries are rendered for. */
export interface ClaudeHookOptions {
  /** Guidance version recorded in the marker; default `GUIDANCE_VERSION`. */
  readonly version?: number;
  /** `--hooks-strict`: each command gains ` --strict`. Default false. */
  readonly strict?: boolean;
  /**
   * The `--command` executable, exactly as given; undefined for
   * `HOOK_DEFAULT_EXECUTABLE`.
   */
  readonly command?: string;
}

/** One Claude Code hook handler as agentboard writes it. */
export interface ClaudeHookHandler {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
}

/** One Claude Code matcher group (an element of `hooks.<key>`) as agentboard writes it. */
export interface ClaudeHookGroup {
  readonly matcher?: string;
  readonly hooks: readonly ClaudeHookHandler[];
}

/**
 * The executable text at the start of a hook command:
 * - `command` undefined: `HOOK_DEFAULT_EXECUTABLE`;
 * - `command` made only of the characters `A-Z a-z 0-9 _ . / @ % + : , -`
 *   (non-empty), not starting with `-`, `+` or `%` and not one of
 *   `SHELL_RESERVED_WORDS`: written as given;
 * - a value with `=` (which the shell would read as an assignment), a
 *   leading `-`, `+` or `%` (shell options and a job reference, which
 *   `installGuidance` refuses anyway) or equal to a reserved word:
 *   single-quoted like the next case;
 * - anything else (a space, `$`, `~`, `#`, a quote, a backslash, a
 *   carriage return, ...): one POSIX shell word in single quotes, each `'`
 *   written as `'\''`, so the shell runs exactly that path, with no
 *   variable or `~` expansion (the value is an executable, like the
 *   `.mcp.json` `command`, not a command line).
 * Never trimmed, resolved or checked for existence. Pure.
 */
export function hookExecutable(command?: string): string {
  if (command === undefined) {
    return HOOK_DEFAULT_EXECUTABLE;
  }
  if (SHELL_SAFE_WORD.test(command) && !SHELL_RESERVED_WORDS.includes(command)) {
    return command;
  }
  return `'${command.replaceAll("'", "'\\''")}'`;
}

/**
 * Words a POSIX shell, bash or zsh may read as reserved at the start of a
 * command; a `--command` value equal to one is single-quoted so it names
 * an executable, since a quoted word is never reserved (POSIX reserved
 * words; `[[`, `]]`, `function`, `select` and `time`, reserved in bash and
 * other shells; `coproc`, reserved in bash and zsh; and `end`, `foreach`,
 * `nocorrect` and `repeat`, reserved in zsh).
 */
export const SHELL_RESERVED_WORDS: readonly string[] = [
  '!',
  '{',
  '}',
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'if',
  'in',
  'then',
  'until',
  'while',
  '[[',
  ']]',
  'function',
  'select',
  'time',
  'coproc',
  'end',
  'foreach',
  'nocorrect',
  'repeat',
];

/**
 * The POSIX special built-ins. A shell finds these before any file on the
 * PATH, quoted or not, so a `--command` value equal to one (with no `/`)
 * is refused as a usage error: no rendering could run an executable of
 * that name.
 */
export const SHELL_SPECIAL_BUILTINS: readonly string[] = [
  'break',
  ':',
  'continue',
  '.',
  'eval',
  'exec',
  'exit',
  'export',
  'readonly',
  'return',
  'set',
  'shift',
  'times',
  'trap',
  'unset',
];

/**
 * The regular built-ins of the shells a hook command may run in: every
 * built-in of dash 0.5.12 (`/bin/sh` on Debian and Ubuntu; `type <name>`),
 * bash 5.3 (`compgen -b`) and zsh 5.9 (`${(k)builtins}`, under `zsh -c`
 * and `zsh -f -c` alike), less `SHELL_SPECIAL_BUILTINS`. The shell finds a
 * built-in before any file on the PATH, quoted or not, so a `--command`
 * value equal to one (a bare name, with no `/`) is refused as a usage
 * error, like a special built-in: give the path of the executable. Plain
 * names that are not built-ins of these shells (`agentboard`, `npx`,
 * `node`) are not affected. `[` first, then in ASCII order.
 */
export const SHELL_BUILTINS: readonly string[] = [
  '[',
  'alias',
  'autoload',
  'bg',
  'bind',
  'bindkey',
  'builtin',
  'bye',
  'caller',
  'cd',
  'chdir',
  'command',
  'compadd',
  'comparguments',
  'compcall',
  'compctl',
  'compdescribe',
  'compfiles',
  'compgen',
  'compgroups',
  'complete',
  'compopt',
  'compquote',
  'compset',
  'comptags',
  'comptry',
  'compvalues',
  'declare',
  'dirs',
  'disable',
  'disown',
  'echo',
  'echotc',
  'echoti',
  'emulate',
  'enable',
  'false',
  'fc',
  'fg',
  'float',
  'functions',
  'getln',
  'getopts',
  'hash',
  'help',
  'history',
  'integer',
  'jobs',
  'kill',
  'let',
  'limit',
  'local',
  'log',
  'logout',
  'mapfile',
  'noglob',
  'popd',
  'print',
  'printf',
  'private',
  'pushd',
  'pushln',
  'pwd',
  'r',
  'read',
  'readarray',
  'rehash',
  'sched',
  'setopt',
  'shopt',
  'source',
  'suspend',
  'test',
  'true',
  'ttyctl',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unfunction',
  'unhash',
  'unlimit',
  'unsetopt',
  'vared',
  'wait',
  'whence',
  'where',
  'which',
  'zcompile',
  'zformat',
  'zle',
  'zmodload',
  'zparseopts',
  'zregexparse',
  'zstyle',
];

/**
 * A non-empty executable text that needs no quoting in a POSIX shell: the
 * safe characters, not starting with `-` or `+` (shell options) or `%` (a
 * job reference) and without `=` (an assignment). Reserved words are
 * checked apart.
 */
const SHELL_SAFE_WORD = /^[A-Za-z0-9_./@:,][A-Za-z0-9_./@%+:,-]*$/;

/**
 * The command string of one agentboard hook: `hookExecutable(command)`,
 * then ` hook <event>`, then ` --strict` when `strict`, then a space and
 * `hooksMarker(version)`. For example
 * `npx -y @bendechrai/agentboard hook stop # agentboard-hooks: v3`. Pure.
 */
export function hookCommand(event: ClaudeHookEvent, options: ClaudeHookOptions = {}): string {
  const strict = options.strict === true ? ' --strict' : '';
  return `${hookExecutable(options.command)} hook ${event}${strict} ${hooksMarker(options.version ?? GUIDANCE_VERSION)}`;
}

/**
 * The matcher group agentboard owns under `hooks.<key>`: for
 * `PreToolUse`, `{"matcher": PRE_TOOL_USE_MATCHER, "hooks": [handler]}`;
 * for `SessionStart` and `Stop`, `{"hooks": [handler]}` with no matcher;
 * the handler is exactly `{"type": "command", "command":
 * hookCommand(<event of key>, options), "timeout": HOOK_TIMEOUT_SECONDS}`.
 * Keys in exactly that order (`matcher`, `hooks`; `type`, `command`,
 * `timeout`), no other key. A new object every call. Pure.
 */
export function hookGroup(key: ClaudeHookKey, options: ClaudeHookOptions = {}): ClaudeHookGroup {
  const handler: ClaudeHookHandler = {
    type: 'command',
    command: hookCommand(EVENT_OF_KEY[key], options),
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  return key === 'PreToolUse'
    ? { matcher: PRE_TOOL_USE_MATCHER, hooks: [handler] }
    : { hooks: [handler] };
}

/**
 * Relative path (POSIX separators) of the Cursor rule the `cursor` target
 * writes in the working tree (board-agent-guidance: "Installing guidance
 * into a host project").
 */
export const CURSOR_RULE_PATH = '.cursor/rules/agentboard.mdc';

/** Relative path of the Cursor project MCP config, holding `mcpServers.agentboard`. */
export const CURSOR_MCP_PATH = '.cursor/mcp.json';

/** Relative path of the Copilot instructions file holding the managed block. */
export const COPILOT_PATH = '.github/copilot-instructions.md';

/**
 * Path of Codex's global config file relative to `$CODEX_HOME` (default
 * `$HOME/.codex`), written only with `--global`.
 */
export const CODEX_CONFIG_FILE = 'config.toml';

/**
 * Path of the Antigravity CLI's global MCP config relative to `$HOME`,
 * written only with `--global`.
 */
export const ANTIGRAVITY_CONFIG_PATH = '.gemini/config/mcp_config.json';

/**
 * The most bytes the `AGENTS.md` block may have (board-agent-guidance:
 * "Antigravity rules stay within size limits"): the Antigravity CLI reads
 * at most 24 KB per rules file and 20000 tokens in aggregate.
 */
export const AGENTS_BLOCK_BYTE_LIMIT = 4096;

/**
 * The size above which `agents check` warns about an `AGENTS.md` at the
 * working tree root: 24 KB, that is 24576 bytes, the most the Antigravity
 * CLI reads of one rules file. A file of exactly this size does not warn.
 */
export const ANTIGRAVITY_RULES_FILE_LIMIT = 24 * 1024;

/**
 * The `description` of the Cursor rule's frontmatter: one line of plain
 * ASCII that is a YAML plain scalar (no `: `, no ` #`, no leading
 * indicator), so the frontmatter parses as YAML to exactly this string.
 */
export const CURSOR_RULE_DESCRIPTION =
  "Coordinates this project's coding agents on the agentboard ticket board; always applied";

/**
 * The whole of `.cursor/rules/agentboard.mdc` for guidance version
 * `version` (default `GUIDANCE_VERSION`), an always-applied Cursor rule:
 *
 * ```
 * ---
 * description: <CURSOR_RULE_DESCRIPTION>
 * alwaysApply: true
 * ---
 * <skillMarker(version)>
 * <the lines of renderAgentsBlock(version) between its start and end markers>
 * ```
 *
 * lines joined by `\n`, ending with one `\n`. So the body after the
 * frontmatter is the ownership marker (the one `SKILL.md` carries) and
 * the `AGENTS.md` block's text: the intro, the six rules, the `Mutex
 * tickets:` paragraph and the pointer to `agentboard help agents`
 * (board-agent-guidance: "Mutex ticket recipe"). At most 45 lines,
 * frontmatter included. Plain ASCII. Pure.
 */
export function renderCursorRule(version: number = GUIDANCE_VERSION): string {
  void version;
  throw new Error('not implemented: renderCursorRule (task 4.2)');
}

/** The start marker of the Codex `config.toml` block: exactly `# agentboard:start v<version>`. */
export function codexBlockStart(version: number): string {
  void version;
  throw new Error('not implemented: codexBlockStart (task 4.2)');
}

/** The end marker of the Codex `config.toml` block. */
export const CODEX_BLOCK_END = '# agentboard:end';

/**
 * `value` as a TOML basic string (TOML 1.0): `"`, then each character,
 * then `"`. `"` is written `\"` and `\` is written `\\`; U+0008 `\b`, tab
 * `\t`, line feed `\n`, U+000C `\f` and carriage return `\r`; every other
 * character in U+0000 to U+001F, and U+007F, as `\u00XX` with upper-case
 * hex digits; every other character as it is (non-ASCII text included,
 * written as UTF-8 by the caller). A TOML parser reads it back as exactly
 * `value`. Pure.
 */
export function tomlBasicString(value: string): string {
  void value;
  throw new Error('not implemented: tomlBasicString (task 4.2)');
}

/**
 * The marked block agentboard owns in Codex's global `config.toml` for
 * guidance version `version` (design.md decision 5), from the first byte
 * of the start marker to the last byte of the end marker, lines joined by
 * `\n`, with NO trailing newline:
 *
 * ```
 * # agentboard:start v<version>
 * [mcp_servers.agentboard]
 * command = <tomlBasicString(command)>
 * args = <args>
 * # agentboard:end
 * ```
 *
 * The command and args are those of `mcpEntry(command)`: without
 * `command`, `command = "npx"` and `args = ["-y", "@bendechrai/agentboard",
 * "mcp"]`; with it, `command = <tomlBasicString(command)>` and `args =
 * ["mcp"]`. Each array element is a TOML basic string, elements separated
 * by `, `. Pure.
 */
export function renderCodexBlock(version: number = GUIDANCE_VERSION, command?: string): string {
  void version;
  void command;
  throw new Error('not implemented: renderCodexBlock (task 4.2)');
}

/**
 * The command `agents install` prints for the `codex` target without
 * `--global` (board-agent-guidance: "Global harness config is never
 * edited by default"): exactly `codex mcp add agentboard -- npx -y
 * @bendechrai/agentboard mcp` without `command`, else `codex mcp add
 * agentboard -- <hookExecutable(command)> mcp`, so the executable is one
 * shell word (single-quoted where needed, `'` as `'\''`) and a POSIX shell
 * passes it to `codex` exactly as given, with no expansion. Pure.
 */
export function codexMcpAddCommand(command?: string): string {
  void command;
  throw new Error('not implemented: codexMcpAddCommand (task 4.2)');
}

/**
 * The command `agents install` prints for the `antigravity` target
 * without `--global`: exactly `agy mcp add agentboard npx -y
 * @bendechrai/agentboard mcp` without `command`, else `agy mcp add
 * agentboard <hookExecutable(command)> mcp`, quoted as for
 * `codexMcpAddCommand`. Pure.
 */
export function agyMcpAddCommand(command?: string): string {
  void command;
  throw new Error('not implemented: agyMcpAddCommand (task 4.2)');
}
