/**
 * The text of the group 4 targets (board-agent-guidance: "Installing
 * guidance into a host project", "Mutex ticket recipe", "Antigravity rules
 * stay within size limits", "Global harness config is never edited by
 * default"; design.md "Rulings from task group 4 (test author)"): the
 * Cursor rule, the Codex block and its TOML strings, the printed `codex
 * mcp add` and `agy mcp add` commands run by a real shell, the mutex short
 * form with its line limits, the 4096 byte block, and the 0.3.0 texts
 * that must stay byte-identical (guidance version 3).
 *
 * Expected texts are written out by hand or taken from the frozen 0.3.0
 * fixtures, never built with the functions under test.
 */

import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseArgs } from '../../cli/parse.js';
import {
  AGENTS_BLOCK_BYTE_LIMIT,
  ANTIGRAVITY_CONFIG_PATH,
  ANTIGRAVITY_RULES_FILE_LIMIT,
  CODEX_BLOCK_END,
  CODEX_CONFIG_FILE,
  COPILOT_PATH,
  CURSOR_MCP_PATH,
  CURSOR_RULE_DESCRIPTION,
  CURSOR_RULE_PATH,
  GUIDANCE_RULES,
  GUIDANCE_VERSION,
  agyMcpAddCommand,
  codexBlockStart,
  codexMcpAddCommand,
  renderAgentsBlock,
  renderCodexBlock,
  renderCursorRule,
  renderSkill,
  tomlBasicString,
} from '../installed-text.js';
import { splitCommandLine } from './command-line.js';
import {
  AGY_ADD,
  BLOCK_030,
  CODEX_ADD,
  RULE_DESCRIPTION,
  SKILL_030,
  codexBlock,
  expectedRule,
  fakeHarnessBin,
} from './harness-helpers.js';

/** `text` with every run of whitespace as one space, lower-cased. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

/** Every backticked span that starts with `agentboard `. */
function backtickedCommands(text: string): string[] {
  return [...text.matchAll(/`(agentboard [^`]*)`/g)].map((m) => m[1] ?? '');
}

describe('0.3.0 texts stay byte-identical (guidance version 3)', () => {
  it('keeps GUIDANCE_VERSION at 3', () => {
    expect(GUIDANCE_VERSION).toBe(3);
  });

  it('renders SKILL.md exactly as agentboard 0.3.0 did', () => {
    expect(renderSkill()).toBe(SKILL_030);
    expect(renderSkill(3)).toBe(SKILL_030);
  });

  it('renders the AGENTS.md block exactly as agentboard 0.3.0 did', () => {
    expect(renderAgentsBlock()).toBe(BLOCK_030);
    expect(renderAgentsBlock(3)).toBe(BLOCK_030);
  });
});

describe('paths and limits', () => {
  it('names the project and global files', () => {
    expect(CURSOR_RULE_PATH).toBe('.cursor/rules/agentboard.mdc');
    expect(CURSOR_MCP_PATH).toBe('.cursor/mcp.json');
    expect(COPILOT_PATH).toBe('.github/copilot-instructions.md');
    expect(CODEX_CONFIG_FILE).toBe('config.toml');
    expect(ANTIGRAVITY_CONFIG_PATH).toBe('.gemini/config/mcp_config.json');
  });

  it('caps the block at 4096 bytes and the rules file at 24 KB', () => {
    expect(AGENTS_BLOCK_BYTE_LIMIT).toBe(4096);
    expect(ANTIGRAVITY_RULES_FILE_LIMIT).toBe(24576);
  });

  it('scenario: Block size (the AGENTS.md block is at most 4096 bytes)', () => {
    expect(Buffer.byteLength(renderAgentsBlock(), 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(BLOCK_030, 'utf8')).toBe(2867);
  });
});

describe('renderCursorRule', () => {
  it('is the frontmatter, the marker and the AGENTS.md block text, ending with one newline', () => {
    expect(renderCursorRule()).toBe(expectedRule(3));
    expect(renderCursorRule(3)).toBe(expectedRule(3));
    expect(renderCursorRule().endsWith('-->\n')).toBe(false);
    expect(renderCursorRule().endsWith('examples.\n')).toBe(true);
  });

  it('records the version it is rendered for', () => {
    expect(renderCursorRule(2)).toBe(expectedRule(2));
    expect(renderCursorRule(12)).toContain('\n<!-- agentboard-guidance: v12 -->\n');
  });

  it('has YAML frontmatter with exactly the description and alwaysApply: true', () => {
    expect(CURSOR_RULE_DESCRIPTION).toBe(RULE_DESCRIPTION);
    const lines = renderCursorRule().split('\n');
    expect(lines[0]).toBe('---');
    const close = lines.indexOf('---', 1);
    expect(close).toBe(3);
    const front = parseYaml(lines.slice(1, close).join('\n')) as unknown;
    expect(front).toEqual({ description: CURSOR_RULE_DESCRIPTION, alwaysApply: true });
    expect(lines[close + 1]).toBe('<!-- agentboard-guidance: v3 -->');
  });

  it('is plain ASCII with no trailing spaces, and at most 45 lines including the frontmatter', () => {
    const rule = renderCursorRule();
    expect(rule).toMatch(/^[\n\x20-\x7e]*$/);
    const lines = rule.replace(/\n$/, '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(45);
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('states the six rules and points to agentboard help agents', () => {
    const rule = renderCursorRule();
    GUIDANCE_RULES.forEach((text, i) => {
      expect(rule).toContain(`\n${String(i + 1)}. ${text}\n`);
    });
    expect(rule).toContain('`agentboard help agents`');
  });
});

/** The installed texts that carry the mutex short form (board-agent-guidance: "Mutex ticket recipe"). */
const SHORT_FORMS: readonly [string, () => string, number][] = [
  ['the Cursor rule', () => renderCursorRule(), 45],
  ['the Copilot block (the AGENTS.md block)', () => renderAgentsBlock(), 40],
];

describe.each(SHORT_FORMS)('the mutex short form in %s', (_name, text, maxLines) => {
  it('has the Mutex tickets: paragraph after the rules and before the pointer', () => {
    const lines = text().split('\n');
    const lastRule = lines.indexOf(
      `${String(GUIDANCE_RULES.length)}. ${GUIDANCE_RULES.at(-1) ?? ''}`,
    );
    const mutex = lines.indexOf('Mutex tickets:');
    const pointer = lines.findIndex((l) => l.startsWith('Run `agentboard help agents`'));
    expect(lastRule).toBeGreaterThan(0);
    expect(mutex).toBeGreaterThan(lastRule);
    expect(pointer).toBeGreaterThan(mutex);
  });

  it(`stays within ${String(maxLines)} lines`, () => {
    expect(text().replace(/\n$/, '').split('\n').length).toBeLessThanOrEqual(maxLines);
  });

  it('contains the pinned phrases', () => {
    const t = flat(text());
    for (const phrase of [
      'never wait on a mutex in a loop',
      'background process',
      'report ready',
      'first action of real work',
      'only joins the queue',
      'board_inbox',
      'board_renew',
    ]) {
      expect(t, phrase).toContain(phrase);
    }
  });

  it('shows claim --ttl, renew, claim --ttl --wait --timeout and release, each with --as, and every command parses', () => {
    const parsed = backtickedCommands(text()).map((line) => {
      const p = parseArgs(splitCommandLine(line).slice(1));
      return { command: p.command.name, values: { ...p.values } };
    });
    expect(parsed.length).toBeGreaterThan(0);
    const has = (pred: (c: { command: string; values: Record<string, unknown> }) => boolean) =>
      parsed.some(pred);
    expect(
      has((c) => c.command === 'claim' && c.values.ttl !== undefined && c.values.wait !== true),
    ).toBe(true);
    expect(has((c) => c.command === 'renew')).toBe(true);
    expect(
      has(
        (c) =>
          c.command === 'claim' &&
          c.values.ttl !== undefined &&
          c.values.wait === true &&
          c.values.timeout !== undefined,
      ),
    ).toBe(true);
    expect(has((c) => c.command === 'release')).toBe(true);
    for (const c of parsed.filter((p) => ['claim', 'renew', 'release'].includes(p.command))) {
      expect(c.values.as, c.command).toBe('<you>');
    }
  });
});

describe('tomlBasicString', () => {
  it('quotes plain text as it is', () => {
    expect(tomlBasicString('agentboard')).toBe('"agentboard"');
    expect(tomlBasicString('/opt/My Tools/agentboard')).toBe('"/opt/My Tools/agentboard"');
    expect(tomlBasicString('')).toBe('""');
  });

  it('escapes the quotation mark and the backslash', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('C:\\tools\\agentboard')).toBe('"C:\\\\tools\\\\agentboard"');
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('uses the short escapes for backspace, tab, line feed, form feed and carriage return', () => {
    expect(tomlBasicString('a\bb\tc\nd\fe\rf')).toBe('"a\\bb\\tc\\nd\\fe\\rf"');
  });

  it('writes every other control character and DEL as \\u00XX with upper-case hex', () => {
    expect(tomlBasicString('\u0000')).toBe('"\\u0000"');
    expect(tomlBasicString('\u001b[0m')).toBe('"\\u001B[0m"');
    expect(tomlBasicString('\u001f')).toBe('"\\u001F"');
    expect(tomlBasicString('\u007f')).toBe('"\\u007F"');
    expect(tomlBasicString('\u000b')).toBe('"\\u000B"');
  });

  it('keeps non-ASCII text, quote-like characters and TOML punctuation as they are', () => {
    expect(tomlBasicString('/opt/caf\u00e9/agentboard')).toBe('"/opt/caf\u00e9/agentboard"');
    expect(tomlBasicString("it's #1 = [x]")).toBe('"it\'s #1 = [x]"');
    expect(tomlBasicString('\u2028\u{1f600}')).toBe('"\u2028\u{1f600}"');
    expect(tomlBasicString('$HOME/~/`id`')).toBe('"$HOME/~/`id`"');
  });
});

describe('renderCodexBlock', () => {
  it('renders the default npx entry between the markers, with no trailing newline', () => {
    expect(renderCodexBlock()).toBe(codexBlock());
    expect(renderCodexBlock(3)).toBe(
      '# agentboard:start v3\n[mcp_servers.agentboard]\ncommand = "npx"\nargs = ["-y", "@bendechrai/agentboard", "mcp"]\n# agentboard:end',
    );
  });

  it('renders a local executable with args ["mcp"], as a TOML basic string', () => {
    expect(renderCodexBlock(3, 'agentboard')).toBe(codexBlock({ command: '"agentboard"' }));
    expect(renderCodexBlock(3, '/opt/My Tools/agentboard')).toBe(
      codexBlock({ command: '"/opt/My Tools/agentboard"' }),
    );
    expect(renderCodexBlock(3, 'C:\\x\\"y"\t\u007f')).toBe(
      codexBlock({ command: '"C:\\\\x\\\\\\"y\\"\\t\\u007F"' }),
    );
  });

  it('asks for npx mcp, not the default entry, when the executable is npx', () => {
    expect(renderCodexBlock(3, 'npx')).toBe(codexBlock({ command: '"npx"' }));
  });

  it('records the version in the start marker', () => {
    expect(codexBlockStart(3)).toBe('# agentboard:start v3');
    expect(codexBlockStart(10)).toBe('# agentboard:start v10');
    expect(CODEX_BLOCK_END).toBe('# agentboard:end');
    expect(renderCodexBlock(2)).toBe(codexBlock({ version: 2 }));
  });
});

describe('the printed registration commands', () => {
  it('prints the default npx commands', () => {
    expect(codexMcpAddCommand()).toBe(CODEX_ADD);
    expect(agyMcpAddCommand()).toBe(AGY_ADD);
  });

  it('prints a plain executable as it is', () => {
    expect(codexMcpAddCommand('agentboard')).toBe('codex mcp add agentboard -- agentboard mcp');
    expect(agyMcpAddCommand('agentboard')).toBe('agy mcp add agentboard agentboard mcp');
    expect(codexMcpAddCommand('/usr/local/bin/agentboard')).toBe(
      'codex mcp add agentboard -- /usr/local/bin/agentboard mcp',
    );
  });

  it('single-quotes an executable the shell would split or expand', () => {
    expect(codexMcpAddCommand('/opt/My Tools/agentboard')).toBe(
      "codex mcp add agentboard -- '/opt/My Tools/agentboard' mcp",
    );
    expect(agyMcpAddCommand("/opt/it's/agentboard")).toBe(
      "agy mcp add agentboard '/opt/it'\\''s/agentboard' mcp",
    );
    expect(codexMcpAddCommand('$HOME/bin/agentboard')).toBe(
      "codex mcp add agentboard -- '$HOME/bin/agentboard' mcp",
    );
  });

  const values = [
    'agentboard',
    '/opt/My Tools/agentboard',
    "/opt/it's/agentboard",
    '$HOME/bin/agentboard',
    '~/bin/agentboard',
    '/x/`id`/agentboard',
    '/x/$(id)/agentboard',
    '/x/"q"/agentboard',
    '/x/#/agentboard',
    '/tmp/*',
    'a=b',
    'C:\\tools\\agentboard',
    '/x/a;b|c&d/agentboard',
    'if',
    '/x/\r/agentboard',
  ];

  it.each(values)('a POSIX shell passes %j to codex and agy exactly as given', (value) => {
    const bin = fakeHarnessBin();
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin };
    const codex = spawnSync('/bin/sh', ['-c', codexMcpAddCommand(value)], {
      env,
      encoding: 'utf8',
    });
    expect(codex.status, codex.stderr).toBe(0);
    expect(codex.stdout).toBe(['mcp', 'add', 'agentboard', '--', value, 'mcp', ''].join('\n'));
    const agy = spawnSync('/bin/sh', ['-c', agyMcpAddCommand(value)], { env, encoding: 'utf8' });
    expect(agy.status, agy.stderr).toBe(0);
    expect(agy.stdout).toBe(['mcp', 'add', 'agentboard', value, 'mcp', ''].join('\n'));
  });

  it('a POSIX shell passes the default npx words', () => {
    const bin = fakeHarnessBin();
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin };
    const codex = spawnSync('/bin/sh', ['-c', codexMcpAddCommand()], { env, encoding: 'utf8' });
    expect(codex.stdout).toBe(
      ['mcp', 'add', 'agentboard', '--', 'npx', '-y', '@bendechrai/agentboard', 'mcp', ''].join(
        '\n',
      ),
    );
  });

  it('the commands split into the documented words (spec: codex mcp add agentboard -- <command> mcp)', () => {
    expect(splitCommandLine(codexMcpAddCommand('/opt/My Tools/agentboard'))).toEqual([
      'codex',
      'mcp',
      'add',
      'agentboard',
      '--',
      '/opt/My Tools/agentboard',
      'mcp',
    ]);
    expect(splitCommandLine(agyMcpAddCommand('/opt/My Tools/agentboard'))).toEqual([
      'agy',
      'mcp',
      'add',
      'agentboard',
      '/opt/My Tools/agentboard',
      'mcp',
    ]);
  });
});
