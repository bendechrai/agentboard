/**
 * The text `agentboard agents install` writes into a host project
 * (board-agent-guidance: "Installing guidance into a host project";
 * design.md: "Installed text is a pointer, not a copy", "Ownership
 * markers").
 *
 * The installed text is deliberately thin: when to use the board, the five
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
 * installed artifact's marker and compared by `agents check`.
 */
export const GUIDANCE_VERSION = 1;

/** The command every installed artifact points to for the full guide. */
export const GUIDE_COMMAND = 'agentboard help agents';

/**
 * The five rules an agent must never break (board-agent-guidance:
 * "Installing guidance into a host project"), in this order: always pass
 * an actor (including the MCP `as` argument and `mcp --as`); claim before
 * working; hand off or block with a comment before stopping; never mark
 * completion on the board instead of in the tasks file; promote
 * `DECISION:` comments before closing. Each is one line of Markdown.
 */
export const GUIDANCE_RULES: readonly string[] = [
  'Always pass an actor: `--as <you>` on every command, or set `AGENTBOARD_ACTOR`. Over MCP, pass `as` on every tool call, or start the server with `agentboard mcp --as <you>`.',
  'Claim a ticket before working on it: `agentboard claim <id> --as <you>`. If the claim is refused, another agent holds the ticket: do not work on it.',
  'Before you stop, hand the ticket off or block it with a comment: `agentboard handoff <id> --to <next> --status <status> --note "<what is done>" --as <you>`, or `agentboard comment <id> "<why>" --as <you>` and then `agentboard move <id> blocked --as <you>`.',
  'Never mark completion on the board instead of in the tasks file: tick the task in `tasks.md` (or your planning source) in the implementing pull request. The board is not the record of completion.',
  'Promote every `DECISION:` comment to a spec delta or ADR before the ticket is closed, and close it with `--decision-recorded-in <path>`.',
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
 * the rules and the pointer. Ends with one newline. Pure.
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
 * `GUIDANCE_VERSION`): from the first byte of `blockStart(version)` to the
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
 * The managed `mcpServers.agentboard` entry: `npx -y @bendechrai/agentboard
 * mcp`. It carries no `--as`: the entry is shared by every session and
 * every agent of the project, so it cannot know which agent is acting;
 * each tool call passes its own `as` argument (see rule 1), or an agent
 * that owns its own MCP configuration may add `--as <actor>` by hand
 * (which `agents install` then refuses to overwrite without `--force`).
 * It carries no version either (JSON has no comments, and an unknown key
 * could break MCP clients), so `agents check` compares it by value.
 */
export const MCP_ENTRY: McpServerEntry = {
  command: 'npx',
  args: ['-y', '@bendechrai/agentboard', 'mcp'],
};
