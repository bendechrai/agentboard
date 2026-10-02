/**
 * The installed guidance text (board-agent-guidance: "Installing guidance
 * into a host project"; add-agent-guidance design.md: "Installed text is a
 * pointer, not a copy"): the skill frontmatter and marker, the five rules
 * and the pointer to `agentboard help agents` in both the skill and the
 * AGENTS.md block, the OpenSpec entries, the manual lines and the MCP entry.
 * Every `agentboard ...` command the text shows parses against the registry,
 * so the installed text cannot drift from the CLI.
 */

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { parseArgs } from '../../cli/parse.js';
import {
  BLOCK_END,
  GUIDANCE_RULES,
  GUIDANCE_VERSION,
  GUIDE_COMMAND,
  MCP_ENTRY,
  MCP_LOCAL_ARGS,
  MCP_SERVER_NAME,
  OPENSPEC_GUIDANCE,
  OPENSPEC_OPERATIONS,
  OPENSPEC_PREFIX,
  SKILL_DESCRIPTION,
  blockStart,
  manualOpenSpecLines,
  mcpEntry,
  openSpecVersionComment,
  renderAgentsBlock,
  renderSkill,
  skillMarker,
} from '../installed-text.js';
import { splitCommandLine } from './command-line.js';

const ASCII = /^[\n\x20-\x7e]*$/;

/** Every backticked span of Markdown text that starts with `agentboard `. */
function backtickedCommands(text: string): string[] {
  return [...text.matchAll(/`(agentboard [^`]*)`/g)].map((m) => m[1] ?? '');
}

function parses(line: string): void {
  const words = splitCommandLine(line);
  expect(words[0], line).toBe('agentboard');
  expect(() => parseArgs(words.slice(1)), line).not.toThrow();
}

describe('the guidance version', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(GUIDANCE_VERSION)).toBe(true);
    expect(GUIDANCE_VERSION).toBeGreaterThan(0);
  });

  it('marks the skill and the AGENTS.md block as the design fixes', () => {
    expect(skillMarker(3)).toBe('<!-- agentboard-guidance: v3 -->');
    expect(blockStart(3)).toBe('<!-- agentboard:start v3 -->');
    expect(BLOCK_END).toBe('<!-- agentboard:end -->');
    expect(openSpecVersionComment(3)).toBe('agentboard-guidance: v3');
    expect(GUIDE_COMMAND).toBe('agentboard help agents');
  });
});

describe('the five rules', () => {
  it('are five single ASCII lines', () => {
    expect(GUIDANCE_RULES).toHaveLength(5);
    for (const rule of GUIDANCE_RULES) {
      expect(rule).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('state the rules an agent must never break, in order', () => {
    const [actor, claim, stop, completion, decision] = GUIDANCE_RULES;
    expect(actor).toContain('--as <you>');
    expect(actor).toContain('AGENTBOARD_ACTOR');
    expect(claim).toContain('agentboard claim <id> --as <you>');
    expect(stop).toContain('agentboard handoff');
    expect(stop).toContain('blocked');
    expect(stop).toContain('comment');
    expect(completion).toContain('tasks.md');
    expect(completion).toMatch(/not the record of completion/);
    expect(decision).toContain('DECISION:');
    expect(decision).toContain('--decision-recorded-in');
  });

  it('tell MCP users about the as argument and mcp --as', () => {
    expect(GUIDANCE_RULES[0]).toContain('`as`');
    expect(GUIDANCE_RULES[0]).toContain('`agentboard mcp --as <you>`');
  });
});

describe('the Claude Code skill', () => {
  const skill = renderSkill();
  const lines = skill.split('\n');

  it('starts with frontmatter naming the skill agentboard, then the marker', () => {
    expect(lines.slice(0, 5)).toEqual([
      '---',
      'name: agentboard',
      `description: ${SKILL_DESCRIPTION}`,
      '---',
      skillMarker(GUIDANCE_VERSION),
    ]);
    expect(parse(lines.slice(1, 3).join('\n'))).toEqual({
      name: 'agentboard',
      description: SKILL_DESCRIPTION,
    });
  });

  it('has a description that triggers on coordination, claiming, handing off and other agents', () => {
    expect(SKILL_DESCRIPTION).toMatch(/^[\x20-\x7e]+$/);
    expect(SKILL_DESCRIPTION).toMatch(/coordinat/i);
    expect(SKILL_DESCRIPTION).toMatch(/claim/i);
    expect(SKILL_DESCRIPTION).toMatch(/hand(ing)? off/i);
    expect(SKILL_DESCRIPTION).toMatch(/other agents are doing/i);
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
  });

  it('contains the five rules, numbered, and the pointer to agentboard help agents', () => {
    GUIDANCE_RULES.forEach((rule, index) => {
      expect(lines).toContain(`${String(index + 1)}. ${rule}`);
    });
    expect(skill).toContain('`agentboard help agents`');
  });

  it('is short, plain ASCII and ends with exactly one newline', () => {
    expect(skill).toMatch(ASCII);
    expect(skill.endsWith('\n')).toBe(true);
    expect(skill.endsWith('\n\n')).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(40);
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('differs between versions only in the marker', () => {
    expect(renderSkill(GUIDANCE_VERSION)).toBe(skill);
    expect(renderSkill(7)).toBe(
      skill.replace(skillMarker(GUIDANCE_VERSION), '<!-- agentboard-guidance: v7 -->'),
    );
  });
});

describe('the AGENTS.md block', () => {
  const block = renderAgentsBlock();
  const lines = block.split('\n');

  it('runs from the start marker to the end marker with no trailing newline', () => {
    expect(lines[0]).toBe(blockStart(GUIDANCE_VERSION));
    expect(lines.at(-1)).toBe(BLOCK_END);
    expect(block.endsWith('\n')).toBe(false);
    expect(lines.filter((l) => l.includes('agentboard:start'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('agentboard:end'))).toHaveLength(1);
  });

  it('contains the five rules and the pointer to agentboard help agents', () => {
    GUIDANCE_RULES.forEach((rule, index) => {
      expect(lines).toContain(`${String(index + 1)}. ${rule}`);
    });
    expect(block).toContain('`agentboard help agents`');
  });

  it('says when to use the board', () => {
    expect(block).toMatch(/start, hand off, block or finish work/);
    expect(block).toContain('`agentboard inbox --as <you>`');
  });

  it('is short plain ASCII and differs between versions only in the start marker', () => {
    expect(block).toMatch(ASCII);
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(renderAgentsBlock(9)).toBe(
      block.replace(blockStart(GUIDANCE_VERSION), '<!-- agentboard:start v9 -->'),
    );
  });
});

describe('the drift guard for installed text', () => {
  it('every backticked agentboard command in the skill and the block parses', () => {
    const commands = [
      ...backtickedCommands(renderSkill()),
      ...backtickedCommands(renderAgentsBlock()),
    ];
    expect(commands.length).toBeGreaterThanOrEqual(10);
    expect(commands).toContain('agentboard help agents');
    for (const line of commands) {
      parses(line);
    }
  });

  it('every agentboard command named in the OpenSpec entries parses', () => {
    const commands = OPENSPEC_OPERATIONS.flatMap((op) => OPENSPEC_GUIDANCE[op]).flatMap(
      backtickedCommands,
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        'agentboard list --change <change>',
        'agentboard claim <id> --as <you>',
        'agentboard close-merged --as <you>',
        'agentboard help agents',
      ]),
    );
    for (const line of commands) {
      parses(line);
    }
  });
});

describe('the OpenSpec guidance entries', () => {
  it('cover apply and archive, each entry one ASCII line beginning agentboard:', () => {
    expect(OPENSPEC_OPERATIONS).toEqual(['apply', 'archive']);
    for (const op of OPENSPEC_OPERATIONS) {
      expect(OPENSPEC_GUIDANCE[op].length).toBeGreaterThan(0);
      for (const entry of OPENSPEC_GUIDANCE[op]) {
        expect(entry.startsWith(`${OPENSPEC_PREFIX} `), entry).toBe(true);
        expect(entry).toMatch(/^[\x20-\x7e]+$/);
      }
    }
    expect(OPENSPEC_PREFIX).toBe('agentboard:');
  });

  it('apply: claim before implementing, hand off or block when stopping, tick tasks.md in the PR', () => {
    const apply = OPENSPEC_GUIDANCE.apply.join('\n');
    expect(apply).toMatch(/claim/);
    expect(apply).toMatch(/before implementing/i);
    expect(apply).toMatch(/handoff/);
    expect(apply).toMatch(/blocked/);
    expect(apply).toMatch(/tasks\.md in the implementing pull request/);
    expect(apply).toContain('agentboard help agents');
  });

  it('archive: no open tickets may remain for the change, close-merged first', () => {
    const archive = OPENSPEC_GUIDANCE.archive.join('\n');
    expect(archive).toMatch(/close-merged --as <you>` first/);
    expect(archive).toMatch(/no ticket of the change is still open/);
  });
});

describe('the manual OpenSpec lines', () => {
  it('parse as YAML to exactly the agentboard entries of each operation', () => {
    const lines = manualOpenSpecLines();
    expect(lines[0]).toBe('operations:');
    expect(parse(lines.join('\n'))).toEqual({
      operations: {
        apply: { guidance: [...OPENSPEC_GUIDANCE.apply] },
        archive: { guidance: [...OPENSPEC_GUIDANCE.archive] },
      },
    });
  });

  it('carry the version comment on every entry line', () => {
    const entries = manualOpenSpecLines(4).filter((l) => l.trimStart().startsWith('- '));
    expect(entries).toHaveLength(OPENSPEC_GUIDANCE.apply.length + OPENSPEC_GUIDANCE.archive.length);
    for (const line of entries) {
      expect(line.endsWith(' # agentboard-guidance: v4'), line).toBe(true);
      expect(line).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('the MCP server entry', () => {
  it('runs npx -y @bendechrai/agentboard mcp, with no --as', () => {
    expect(MCP_SERVER_NAME).toBe('agentboard');
    expect(MCP_ENTRY).toEqual({ command: 'npx', args: ['-y', '@bendechrai/agentboard', 'mcp'] });
    expect(MCP_ENTRY.args).not.toContain('--as');
  });
});

describe('mcpEntry', () => {
  it('is a copy of the npx entry without a command', () => {
    const entry = mcpEntry();
    expect(entry).toEqual(MCP_ENTRY);
    expect(entry).not.toBe(MCP_ENTRY);
    expect(entry.args).not.toBe(MCP_ENTRY.args);
    expect(Object.keys(entry)).toEqual(['command', 'args']);
  });

  it('is the local entry with a command', () => {
    const entry = mcpEntry('agentboard');
    expect(entry).toEqual({ command: 'agentboard', args: ['mcp'] });
    expect(Object.keys(entry)).toEqual(['command', 'args']);
    expect(entry.args).toEqual(MCP_LOCAL_ARGS);
    expect(entry.args).not.toBe(MCP_LOCAL_ARGS);
    expect(JSON.stringify(entry)).toBe('{"command":"agentboard","args":["mcp"]}');
  });

  it.each([
    '/opt/agentboard/bin/agentboard',
    '/Users/me/My Tools/agent board/agentboard',
    ' agentboard ',
    'C:\\Program Files\\agentboard\\agentboard.cmd',
  ])('keeps the command %j exactly as given', (command) => {
    expect(mcpEntry(command)).toEqual({ command, args: ['mcp'] });
  });

  it('has exactly mcp as the local arguments', () => {
    expect(MCP_LOCAL_ARGS).toEqual(['mcp']);
  });
});
