/**
 * `agents install` for the `codex`, `cursor`, `antigravity` and `copilot`
 * targets in the project, without `--global` (board-agent-guidance:
 * "Installing guidance into a host project", "Installed guidance never
 * clobbers user content", "Harness MCP entries", "Global harness config is
 * never edited by default"; design.md "Rulings from task group 4 (test
 * author)"): auto-detection, the files written, the registration commands,
 * the shared `AGENTS.md` block, every refusal and its `--force`, the file
 * handling, `--command` reaching each MCP entry, and adding a target
 * leaving the others' files and state unchanged. The global files are in
 * harness-global.test.ts, `agents check` in harness-check.test.ts, and the
 * built CLI in src/cli/__tests__/harness-targets-cli.test.ts.
 *
 * Every run uses a scratch HOME and CODEX_HOME, and the tests assert that
 * nothing under it is created, read or written without `--global`.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { expectBoardError } from '../../board/__tests__/helpers.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { checkGuidance } from '../check.js';
import {
  COMMAND_REASON,
  GUIDANCE_TARGETS,
  detectTargets,
  renderInstall,
  type InstallResult,
} from '../install.js';
import {
  IS_ROOT,
  chmodForTest,
  fileList,
  plainProject,
  readRel,
  snapshot,
  writeRel,
} from './guidance-helpers.js';
import {
  AGENTS,
  AGY_ADD,
  BLOCK_030,
  CODEX_ADD,
  COPILOT,
  CURSOR_MCP,
  MCP,
  NPX_ENTRY,
  RULE,
  SKILL,
  SKILL_030,
  blockAt,
  contents,
  expectedRule,
  installIn,
  json,
  local,
  mcpFile,
  outcomeAt,
  outcomesOf,
  scratchHome,
  summary,
  type ScratchHome,
} from './harness-helpers.js';

/** A fresh project and scratch home. */
function setup(): { root: string; scratch: ScratchHome } {
  return { root: plainProject(), scratch: scratchHome() };
}

/** The scratch home is still empty: nothing global was created. */
function expectHomeUntouched(scratch: ScratchHome): void {
  expect(fileList(scratch.home)).toEqual([]);
  expect(existsSync(scratch.codexHome)).toBe(false);
}

describe('auto-detection', () => {
  it('selects codex for a .codex/ directory, with its reason', () => {
    const root = plainProject();
    mkdirSync(join(root, '.codex'));
    expect(detectTargets(root)).toEqual([{ target: 'codex', reason: '.codex/ exists' }]);
  });

  it('selects cursor for a .cursor/ directory, antigravity for .agents/, copilot for the instructions file', () => {
    const root = plainProject();
    mkdirSync(join(root, '.cursor'));
    mkdirSync(join(root, '.agents'));
    writeRel(root, COPILOT, '# Copilot\n');
    expect(detectTargets(root)).toEqual([
      { target: 'cursor', reason: '.cursor/ exists' },
      { target: 'antigravity', reason: '.agents/ exists' },
      { target: 'copilot', reason: '.github/copilot-instructions.md exists' },
    ]);
  });

  it('needs directories for .codex, .cursor and .agents, and the file itself for copilot', () => {
    const root = plainProject();
    writeFileSync(join(root, '.codex'), '');
    writeFileSync(join(root, '.cursor'), '');
    writeFileSync(join(root, '.agents'), '');
    mkdirSync(join(root, '.github'));
    expect(detectTargets(root)).toEqual([]);
  });

  it('lists every detected target in GUIDANCE_TARGETS order, and never mcp-json or claude-hooks', () => {
    const root = plainProject();
    for (const dir of ['.claude', '.codex', '.cursor', '.agents']) {
      mkdirSync(join(root, dir));
    }
    writeRel(root, AGENTS, '# Agents\n');
    writeRel(root, 'openspec/config.yaml', 'schema: spec-driven\n');
    writeRel(root, COPILOT, '');
    writeRel(root, '.claude/settings.json', '{}\n');
    writeRel(root, MCP, '{}\n');
    expect(detectTargets(root).map((s) => s.target)).toEqual([
      'claude',
      'agents-md',
      'openspec',
      'codex',
      'cursor',
      'antigravity',
      'copilot',
    ]);
  });

  it('installs the detected codex and antigravity targets with their commands and no global file', () => {
    const { root, scratch } = setup();
    mkdirSync(join(root, '.codex'));
    mkdirSync(join(root, '.agents'));
    const result = installIn(root, scratch);
    expect(result.autoDetected).toBe(true);
    expect(summary(result)).toEqual([
      ['codex', AGENTS, 'created', null],
      ['antigravity', AGENTS, 'unchanged', null],
    ]);
    expect(result.targets.map((t) => t.reason)).toEqual(['.codex/ exists', '.agents/ exists']);
    expect(result.registerCommands).toEqual([
      { target: 'codex', command: CODEX_ADD },
      { target: 'antigravity', command: AGY_ADD },
    ]);
    expectHomeUntouched(scratch);
  });

  it('reads nothing in HOME or CODEX_HOME without --global, even when they cannot be read', () => {
    if (IS_ROOT) {
      return;
    }
    const { root, scratch } = setup();
    mkdirSync(join(root, '.codex'));
    mkdirSync(join(root, '.agents'));
    // Only files are made unreadable: a file of mode 0 is still removed with
    // its temporary directory, which runs before onTestFinished restores modes.
    mkdirSync(join(scratch.home, '.gemini', 'config'), { recursive: true });
    mkdirSync(scratch.codexHome);
    writeFileSync(scratch.codexConfig, '# agentboard:start v3\n');
    writeFileSync(scratch.agyConfig, '{"mcpServers": {"agentboard": {"command": "x"}}}\n');
    chmodForTest(scratch.codexConfig, 0o000);
    chmodForTest(scratch.agyConfig, 0o000);
    const result = installIn(root, scratch);
    expect(result.refused).toBe(0);
    expect(result.targets.map((t) => t.path)).toEqual([AGENTS, AGENTS]);
  });

  it('names every target in the no-targets error of a bare project', () => {
    const { root, scratch } = setup();
    const error = expectBoardError(() => installIn(root, scratch), 1, 'no-targets');
    for (const target of GUIDANCE_TARGETS) {
      expect(error.message).toContain(target);
    }
  });

  it('refuses an unknown target with the nine target names, never repeating it', () => {
    const { root, scratch } = setup();
    const error = expectBoardError(
      () => installIn(root, scratch, { targets: ['windsurf'] }),
      1,
      'usage',
    );
    expect(error.message).toBe(
      'unknown target given with --target; expected one of claude, agents-md, openspec, mcp-json, claude-hooks, codex, cursor, antigravity, copilot',
    );
    expect(fileList(root)).toEqual([]);
  });
});

describe('codex and antigravity in the project', () => {
  it('codex writes the AGENTS.md block and returns the codex mcp add command', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['codex'] });
    expect(result.targets).toEqual([
      {
        target: 'codex',
        path: AGENTS,
        reason: 'requested with --target',
        action: 'created',
        refusal: null,
        message: expect.any(String) as unknown,
        manual: [],
      },
    ]);
    expect(readRel(root, AGENTS)).toBe(`${BLOCK_030}\n`);
    expect(result.registerCommands).toEqual([{ target: 'codex', command: CODEX_ADD }]);
    expect(fileList(root)).toEqual([AGENTS]);
    expectHomeUntouched(scratch);
  });

  it('antigravity writes the same block and returns the agy mcp add command', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['antigravity'] });
    expect(summary(result)).toEqual([['antigravity', AGENTS, 'created', null]]);
    expect(readRel(root, AGENTS)).toBe(`${BLOCK_030}\n`);
    expect(result.registerCommands).toEqual([{ target: 'antigravity', command: AGY_ADD }]);
    expectHomeUntouched(scratch);
  });

  it('writes the shared block once when agents-md, codex and antigravity are all selected', () => {
    const { root, scratch } = setup();
    writeRel(root, AGENTS, '# Project\n\nUser text.\n');
    const result = installIn(root, scratch, {
      targets: ['antigravity', 'codex', 'agents-md'],
    });
    expect(summary(result)).toEqual([
      ['agents-md', AGENTS, 'updated', null],
      ['codex', AGENTS, 'unchanged', null],
      ['antigravity', AGENTS, 'unchanged', null],
    ]);
    expect(readRel(root, AGENTS)).toBe(`# Project\n\nUser text.\n\n${BLOCK_030}\n`);
    expect(result.registerCommands.map((r) => r.target)).toEqual(['codex', 'antigravity']);
  });

  it('upgrades an older block in place, keeping the user text around it', () => {
    const { root, scratch } = setup();
    writeRel(root, AGENTS, `before\r\n${blockAt(2)}\r\nafter\n`);
    const result = installIn(root, scratch, { targets: ['codex'] });
    expect(summary(result)).toEqual([['codex', AGENTS, 'updated', null]]);
    expect(readRel(root, AGENTS)).toBe(`before\r\n${BLOCK_030}\r\nafter\n`);
  });

  it('refuses malformed AGENTS.md markers, and still returns the command', () => {
    const { root, scratch } = setup();
    const text = `${blockAt(3)}\n<!-- agentboard:end -->\n`;
    writeRel(root, AGENTS, text);
    const result = installIn(root, scratch, { targets: ['codex', 'antigravity'] });
    expect(summary(result)).toEqual([
      ['codex', AGENTS, 'refused', 'malformed-marker'],
      ['antigravity', AGENTS, 'refused', 'malformed-marker'],
    ]);
    expect(result.refused).toBe(2);
    expect(readRel(root, AGENTS)).toBe(text);
    expect(result.registerCommands).toEqual([
      { target: 'codex', command: CODEX_ADD },
      { target: 'antigravity', command: AGY_ADD },
    ]);
  });

  it('with --force removes the malformed markers once and the second target finds it up to date', () => {
    const { root, scratch } = setup();
    writeRel(root, AGENTS, 'keep\n<!-- agentboard:end -->\n');
    const result = installIn(root, scratch, { targets: ['codex', 'antigravity'], force: true });
    expect(summary(result)).toEqual([
      ['codex', AGENTS, 'updated', null],
      ['antigravity', AGENTS, 'unchanged', null],
    ]);
    expect(readRel(root, AGENTS)).toBe(`keep\n\n${BLOCK_030}\n`);
  });

  it('puts the --command executable in both commands, quoted for the shell, and selects mcp-json', () => {
    const { root, scratch } = setup();
    const exe = '/opt/My Tools/agentboard';
    const result = installIn(root, scratch, { targets: ['codex', 'antigravity'], command: exe });
    expect(result.registerCommands).toEqual([
      { target: 'codex', command: "codex mcp add agentboard -- '/opt/My Tools/agentboard' mcp" },
      { target: 'antigravity', command: "agy mcp add agentboard '/opt/My Tools/agentboard' mcp" },
    ]);
    expect(outcomeAt(result, 'mcp-json', MCP).reason).toBe(COMMAND_REASON);
    expect(readRel(root, MCP)).toBe(mcpFile(local(exe)));
  });

  it('returns no command for targets other than codex and antigravity', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, {
      targets: ['claude', 'agents-md', 'cursor', 'copilot'],
    });
    expect(result.registerCommands).toEqual([]);
  });
});

describe('renderInstall with registration commands', () => {
  it('prints each command on its own line, indented by four spaces, after the outcomes and before the summary', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['codex', 'antigravity'] });
    const text = renderInstall(result);
    const lines = text.replace(/\n$/, '').split('\n');
    const codex = lines.indexOf(`    ${CODEX_ADD}`);
    const agy = lines.indexOf(`    ${AGY_ADD}`);
    expect(codex).toBeGreaterThan(lines.indexOf(`unchanged antigravity ${AGENTS} (up to date)`));
    expect(agy).toBe(codex + 1);
    expect(lines[codex - 1]).toMatch(/^\S.*register.*MCP server/i);
    expect(lines[codex - 1]).toContain('--global');
    expect(lines.at(-1)).toMatch(
      /^agents install: 1 created, 0 updated, 1 unchanged, 0 refused \(guidance v3\) in /,
    );
  });

  it('prints no command section without codex or antigravity', () => {
    const { root, scratch } = setup();
    const text = renderInstall(installIn(root, scratch, { targets: ['copilot'] }));
    expect(text).not.toMatch(/mcp add/);
    expect(text.split('\n').filter((l) => l.startsWith('    '))).toEqual([]);
  });
});

describe('cursor', () => {
  it('writes the rule and the .cursor/mcp.json entry, two outcomes in that order', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(result.targets).toEqual([
      {
        target: 'cursor',
        path: RULE,
        reason: 'requested with --target',
        action: 'created',
        refusal: null,
        message: expect.any(String) as unknown,
        manual: [],
      },
      {
        target: 'cursor',
        path: CURSOR_MCP,
        reason: 'requested with --target',
        action: 'created',
        refusal: null,
        message: expect.any(String) as unknown,
        manual: [],
      },
    ]);
    expect(readRel(root, RULE)).toBe(expectedRule());
    expect(readRel(root, CURSOR_MCP)).toBe(mcpFile());
    expect(fileList(root)).toEqual([CURSOR_MCP, RULE]);
    expect(result.registerCommands).toEqual([]);
    expectHomeUntouched(scratch);
  });

  it('scenario: Reinstall is idempotent (both cursor files)', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['cursor'] });
    const before = snapshot(root);
    const again = installIn(root, scratch, { targets: ['cursor'] });
    expect(summary(again)).toEqual([
      ['cursor', RULE, 'unchanged', null],
      ['cursor', CURSOR_MCP, 'unchanged', null],
    ]);
    expect(snapshot(root)).toEqual(before);
    expect(renderInstall(again)).toContain(`unchanged cursor ${RULE} (up to date)\n`);
    expect(renderInstall(again)).toContain(`unchanged cursor ${CURSOR_MCP} (up to date)\n`);
  });

  it('scenario: Foreign Cursor rule is refused, and the MCP entry is still written', () => {
    const { root, scratch } = setup();
    const foreign = '---\ndescription: mine\nalwaysApply: true\n---\nMy own rule.\n';
    writeRel(root, RULE, foreign);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(summary(result)).toEqual([
      ['cursor', RULE, 'refused', 'foreign-file'],
      ['cursor', CURSOR_MCP, 'created', null],
    ]);
    const refused = outcomeAt(result, 'cursor', RULE);
    expect(refused.message).toContain(RULE);
    expect(refused.message).toContain('--force');
    expect(readRel(root, RULE)).toBe(foreign);
    expect(result.refused).toBe(1);
    const forced = installIn(root, scratch, { targets: ['cursor'], force: true });
    expect(summary(forced)[0]).toEqual(['cursor', RULE, 'updated', null]);
    expect(readRel(root, RULE)).toBe(expectedRule());
  });

  it('rewrites an owned rule of another version or with a hand edit, without --force', () => {
    const { root, scratch } = setup();
    writeRel(root, RULE, expectedRule(2));
    expect(summary(installIn(root, scratch, { targets: ['cursor'] }))[0]).toEqual([
      'cursor',
      RULE,
      'updated',
      null,
    ]);
    expect(readRel(root, RULE)).toBe(expectedRule());
    writeRel(root, RULE, `${expectedRule()}A line of my own.\n`);
    expect(summary(installIn(root, scratch, { targets: ['cursor'] }))[0]).toEqual([
      'cursor',
      RULE,
      'updated',
      null,
    ]);
    expect(readRel(root, RULE)).toBe(expectedRule());
  });

  it('adds the entry after the other servers and keys of an existing .cursor/mcp.json', () => {
    const { root, scratch } = setup();
    writeRel(
      root,
      CURSOR_MCP,
      '{"mcpServers": {"other": {"url": "https://example.test/mcp"}}, "zeta": [1, 2]}',
    );
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).action).toBe('updated');
    expect(readRel(root, CURSOR_MCP)).toBe(
      json({
        mcpServers: { other: { url: 'https://example.test/mcp' }, agentboard: NPX_ENTRY },
        zeta: [1, 2],
      }),
    );
  });

  it('scenario: Unmanaged Cursor entry is refused (an extra env key), and --force replaces it in place', () => {
    const { root, scratch } = setup();
    const text = json({
      mcpServers: {
        agentboard: { ...NPX_ENTRY, env: { X: '1' } },
        other: { command: 'x' },
      },
    });
    writeRel(root, CURSOR_MCP, text);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(summary(result)).toEqual([
      ['cursor', RULE, 'created', null],
      ['cursor', CURSOR_MCP, 'refused', 'entry-differs'],
    ]);
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).message).toContain(CURSOR_MCP);
    expect(readRel(root, CURSOR_MCP)).toBe(text);
    installIn(root, scratch, { targets: ['cursor'], force: true });
    expect(readRel(root, CURSOR_MCP)).toBe(
      json({ mcpServers: { agentboard: NPX_ENTRY, other: { command: 'x' } } }),
    );
  });

  it('keeps a local managed entry without --command, and --command replaces a managed entry without --force', () => {
    const { root, scratch } = setup();
    writeRel(root, CURSOR_MCP, mcpFile(local('/opt/agentboard')));
    const kept = installIn(root, scratch, { targets: ['cursor'] });
    expect(outcomeAt(kept, 'cursor', CURSOR_MCP).action).toBe('unchanged');
    const same = installIn(root, scratch, { targets: ['cursor'], command: '/opt/agentboard' });
    expect(outcomeAt(same, 'cursor', CURSOR_MCP).action).toBe('unchanged');
    const switched = installIn(root, scratch, { targets: ['cursor'], command: 'agentboard' });
    expect(outcomeAt(switched, 'cursor', CURSOR_MCP).action).toBe('updated');
    expect(readRel(root, CURSOR_MCP)).toBe(mcpFile(local('agentboard')));
  });

  it('refuses a .cursor/mcp.json that is not a JSON object as malformed-file, even with --force', () => {
    const { root, scratch } = setup();
    for (const text of ['{"mcpServers": {', '[]', '{"mcpServers": []}', '']) {
      writeRel(root, CURSOR_MCP, text);
      for (const force of [false, true]) {
        const result = installIn(root, scratch, { targets: ['cursor'], force });
        expect(outcomeAt(result, 'cursor', CURSOR_MCP).refusal, text).toBe('malformed-file');
        expect(readRel(root, CURSOR_MCP)).toBe(text);
      }
    }
  });

  it('refuses bytes that are not UTF-8 as malformed-file, leaving them as they are', () => {
    const { root, scratch } = setup();
    const bytes = Buffer.from('{"mcpServers": {"other": {"command": "caf\xe9"}}}\n', 'latin1');
    mkdirSync(join(root, '.cursor'));
    writeFileSync(join(root, CURSOR_MCP), bytes);
    const result = installIn(root, scratch, { targets: ['cursor'], force: true });
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).refusal).toBe('malformed-file');
    expect(statSync(join(root, CURSOR_MCP)).size).toBe(bytes.length);
    expect(snapshot(root).get(CURSOR_MCP)?.content).toBe(bytes.toString('latin1'));
  });

  it('refuses a file nested 100,000 levels deep without an internal error, and still writes the rule', () => {
    const { root, scratch } = setup();
    const deep = `{"mcpServers": {"x": ${'['.repeat(100_000)}${']'.repeat(100_000)}}}`;
    writeRel(root, CURSOR_MCP, deep);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(summary(result)).toEqual([
      ['cursor', RULE, 'created', null],
      ['cursor', CURSOR_MCP, 'refused', 'malformed-file'],
    ]);
  });

  it('refuses a rewrite that would change a value as lossy-json, and --force rewrites it', () => {
    const { root, scratch } = setup();
    const text = '{"mcpServers": {"other": {"command": "x", "timeout": 12345678901234567890}}}\n';
    writeRel(root, CURSOR_MCP, text);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).refusal).toBe('lossy-json');
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).message).toContain('--force');
    expect(readRel(root, CURSOR_MCP)).toBe(text);
    const forced = installIn(root, scratch, { targets: ['cursor'], force: true });
    expect(outcomeAt(forced, 'cursor', CURSOR_MCP).action).toBe('updated');
  });

  it('never refuses a file that needs no write, whatever it holds', () => {
    const { root, scratch } = setup();
    const text = `{"big": 12345678901234567890, "mcpServers": {"agentboard": ${JSON.stringify(NPX_ENTRY)}}}`;
    writeRel(root, CURSOR_MCP, text);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).action).toBe('unchanged');
    expect(readRel(root, CURSOR_MCP)).toBe(text);
  });

  it('keeps the mode of .cursor/mcp.json and leaves no temporary file', () => {
    const { root, scratch } = setup();
    writeRel(root, CURSOR_MCP, '{"mcpServers": {}}\n');
    chmodSync(join(root, CURSOR_MCP), 0o600);
    installIn(root, scratch, { targets: ['cursor'] });
    expect(statSync(join(root, CURSOR_MCP)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, '.cursor')).sort()).toEqual(['mcp.json', 'rules']);
    expect(readRel(root, CURSOR_MCP)).toBe(mcpFile());
  });

  it('follows a symbolic link inside the tree and keeps the link', () => {
    const { root, scratch } = setup();
    writeRel(root, 'config/cursor-mcp.json', '{"mcpServers": {}}\n');
    mkdirSync(join(root, '.cursor'));
    symlinkSync('../config/cursor-mcp.json', join(root, CURSOR_MCP));
    installIn(root, scratch, { targets: ['cursor'] });
    expect(lstatSync(join(root, CURSOR_MCP)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, CURSOR_MCP))).toBe('../config/cursor-mcp.json');
    expect(readRel(root, 'config/cursor-mcp.json')).toBe(mcpFile());
  });

  it('refuses both files as outside-tree when .cursor links outside the working tree', () => {
    const { root, scratch } = setup();
    const outside = tempDir();
    symlinkSync(outside, join(root, '.cursor'));
    const result = installIn(root, scratch, { targets: ['cursor'], force: true });
    expect(summary(result)).toEqual([
      ['cursor', RULE, 'refused', 'outside-tree'],
      ['cursor', CURSOR_MCP, 'refused', 'outside-tree'],
    ]);
    expect(fileList(outside)).toEqual([]);
  });

  it('refuses a directory at the rule path as not-a-file', () => {
    const { root, scratch } = setup();
    mkdirSync(join(root, RULE), { recursive: true });
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(outcomeAt(result, 'cursor', RULE).refusal).toBe('not-a-file');
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).action).toBe('created');
  });

  it('refuses a read-only .cursor/mcp.json that needs a write as unwritable', () => {
    if (IS_ROOT) {
      return;
    }
    const { root, scratch } = setup();
    writeRel(root, CURSOR_MCP, '{"mcpServers": {}}\n');
    chmodForTest(join(root, CURSOR_MCP), 0o444);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(outcomeAt(result, 'cursor', CURSOR_MCP).refusal).toBe('unwritable');
    expect(readRel(root, CURSOR_MCP)).toBe('{"mcpServers": {}}\n');
  });

  it.each(TOKEN_FIXTURES)(
    'a refusal repeats none of the file ($name in an unmanaged entry)',
    (f) => {
      const { root, scratch } = setup();
      writeRel(
        root,
        CURSOR_MCP,
        json({ mcpServers: { agentboard: { ...NPX_ENTRY, env: { TOKEN: f.value } } } }),
      );
      writeRel(root, RULE, `my rule ${f.value}\n`);
      const result = installIn(root, scratch, { targets: ['cursor'] });
      expect(result.refused).toBe(2);
      expectNoLeak('cursor refusals', [result, renderInstall(result)], [f]);
    },
  );
});

describe('copilot', () => {
  it('creates .github/copilot-instructions.md holding the block', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['copilot'] });
    expect(summary(result)).toEqual([['copilot', COPILOT, 'created', null]]);
    expect(readRel(root, COPILOT)).toBe(`${BLOCK_030}\n`);
    expect(fileList(root)).toEqual([COPILOT]);
  });

  it('appends the block to user instructions, keeping them byte for byte', () => {
    const { root, scratch } = setup();
    writeRel(root, COPILOT, '# Copilot\r\n\r\nUse tabs.');
    installIn(root, scratch, { targets: ['copilot'] });
    expect(readRel(root, COPILOT)).toBe(`# Copilot\r\n\r\nUse tabs.\n\n${BLOCK_030}\n`);
  });

  it('replaces only an older block between user text, and is then idempotent', () => {
    const { root, scratch } = setup();
    writeRel(root, COPILOT, `top\n\n${blockAt(1)}\n\nbottom\n`);
    expect(summary(installIn(root, scratch, { targets: ['copilot'] }))).toEqual([
      ['copilot', COPILOT, 'updated', null],
    ]);
    expect(readRel(root, COPILOT)).toBe(`top\n\n${BLOCK_030}\n\nbottom\n`);
    const before = snapshot(root);
    expect(summary(installIn(root, scratch, { targets: ['copilot'] }))).toEqual([
      ['copilot', COPILOT, 'unchanged', null],
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses malformed markers, and --force removes them and appends a fresh block', () => {
    const { root, scratch } = setup();
    const text = 'mine\n<!-- agentboard:start v3 -->\nhalf a block\n';
    writeRel(root, COPILOT, text);
    const result = installIn(root, scratch, { targets: ['copilot'] });
    expect(summary(result)).toEqual([['copilot', COPILOT, 'refused', 'malformed-marker']]);
    expect(result.targets[0]?.message).toContain(COPILOT);
    expect(readRel(root, COPILOT)).toBe(text);
    installIn(root, scratch, { targets: ['copilot'], force: true });
    expect(readRel(root, COPILOT)).toBe(`mine\nhalf a block\n\n${BLOCK_030}\n`);
  });

  it('refuses a .github linked outside the working tree', () => {
    const { root, scratch } = setup();
    const outside = tempDir();
    symlinkSync(outside, join(root, '.github'));
    const result = installIn(root, scratch, { targets: ['copilot'] });
    expect(summary(result)).toEqual([['copilot', COPILOT, 'refused', 'outside-tree']]);
    expect(fileList(outside)).toEqual([]);
  });

  it('scenario: Cursor and Copilot carry the recipe (the installed files)', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['cursor', 'copilot'] });
    const rule = readRel(root, RULE);
    expect(rule.replace(/\n$/, '').split('\n').length).toBeLessThanOrEqual(45);
    const copilot = readRel(root, COPILOT);
    const block = copilot.slice(
      copilot.indexOf('<!-- agentboard:start'),
      copilot.indexOf('<!-- agentboard:end -->') + '<!-- agentboard:end -->'.length,
    );
    expect(block.split('\n').length).toBeLessThanOrEqual(40);
    for (const text of [rule, block]) {
      expect(text.split('\n')).toContain('Mutex tickets:');
      expect(text).toContain('`agentboard claim <id> --ttl 30m --as <you>`');
      expect(text).toContain('`agentboard renew <id> --as <you>`');
      expect(text).toContain('`agentboard claim <id> --ttl 30m --wait --timeout 10m --as <you>`');
      expect(text).toContain('`agentboard release <id> --as <you>`');
    }
  });
});

describe('--command reaches every MCP entry', () => {
  it('scenario: Local command reaches every harness (cursor entry and both printed commands)', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, {
      targets: ['cursor', 'codex', 'antigravity'],
      command: 'agentboard',
    });
    expect(result.refused).toBe(0);
    expect(JSON.parse(readRel(root, CURSOR_MCP))).toEqual({
      mcpServers: { agentboard: { command: 'agentboard', args: ['mcp'] } },
    });
    expect(JSON.parse(readRel(root, MCP))).toEqual({
      mcpServers: { agentboard: { command: 'agentboard', args: ['mcp'] } },
    });
    expect(result.registerCommands).toEqual([
      { target: 'codex', command: 'codex mcp add agentboard -- agentboard mcp' },
      { target: 'antigravity', command: 'agy mcp add agentboard agentboard mcp' },
    ]);
  });

  it('writes the executable exactly as given into the JSON entries', () => {
    const { root, scratch } = setup();
    const exe = "/opt/it's here/$X/agentboard";
    installIn(root, scratch, { targets: ['cursor'], command: exe });
    expect(readRel(root, CURSOR_MCP)).toBe(mcpFile(local(exe)));
  });

  it.each([
    ['', 'must not be empty'],
    ['agent\nboard', 'must not contain a newline'],
    ['-x', 'must not start with a hyphen'],
    ['echo', 'must not be a shell built-in'],
  ])('refuses --command %j as usage before writing anything for any target', (value, why) => {
    const { root, scratch } = setup();
    mkdirSync(join(root, '.cursor'));
    const before = contents(root);
    const error = expectBoardError(
      () =>
        installIn(root, scratch, {
          targets: ['cursor', 'codex', 'antigravity', 'copilot'],
          command: value,
        }),
      1,
      'usage',
    );
    expect(error.message).toBe(
      `--command ${why}${why.includes('built-in') ? '; give the path of the executable' : ''}`,
    );
    expect(contents(root)).toEqual(before);
    expectHomeUntouched(scratch);
  });

  it.each(TOKEN_FIXTURES)(
    'a multi-line --command holding $name is refused without repeating it',
    (f) => {
      const { root, scratch } = setup();
      let thrown: unknown = null;
      try {
        installIn(root, scratch, {
          targets: ['codex', 'cursor'],
          command: `${f.value}\n${f.value}`,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expectNoLeak('multi-line --command', [String(thrown), (thrown as Error).message], [f]);
      expect(fileList(root)).toEqual([]);
    },
  );
});

describe('new targets install at version 3 and leave the others alone', () => {
  it('scenario: New targets install at the current version', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['cursor', 'copilot', 'claude-hooks'] });
    expect(result.refused).toBe(0);
    expect(readRel(root, RULE)).toContain('\n<!-- agentboard-guidance: v3 -->\n');
    expect(readRel(root, COPILOT).startsWith('<!-- agentboard:start v3 -->\n')).toBe(true);
    const settings = JSON.parse(readRel(root, '.claude/settings.json')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const commands = Object.values(settings.hooks).flatMap((g) =>
      g.flatMap((x) => x.hooks.map((h) => h.command)),
    );
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command).toMatch(/ # agentboard-hooks: v3$/);
    }
    expect(checkGuidance({ cwd: root, env: scratch.env })).toEqual([
      {
        target: 'claude-hooks',
        path: '.claude/settings.json',
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
      { target: 'cursor', path: RULE, state: 'current', installedVersion: 3, currentVersion: 3 },
      {
        target: 'cursor',
        path: CURSOR_MCP,
        state: 'current',
        installedVersion: null,
        currentVersion: 3,
      },
      {
        target: 'copilot',
        path: COPILOT,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
  });

  it('records an older version when installed by an older CLI (version option)', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['cursor', 'copilot'], version: 2 });
    expect(readRel(root, RULE)).toBe(expectedRule(2));
    expect(readRel(root, COPILOT).startsWith('<!-- agentboard:start v2 -->\n')).toBe(true);
  });

  it('scenario: Adding a target leaves the others current (their files untouched)', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['claude', 'agents-md'] });
    const states = (): (string | null)[][] =>
      checkGuidance({ cwd: root, env: scratch.env }).map((e) => [e.target, e.path, e.state]);
    expect(states()).toEqual([
      ['claude', SKILL, 'current'],
      ['agents-md', AGENTS, 'current'],
    ]);
    const before = snapshot(root);
    const result = installIn(root, scratch, { targets: ['cursor'] });
    expect(result.refused).toBe(0);
    const after = snapshot(root);
    expect(after.get(SKILL)).toEqual(before.get(SKILL));
    expect(after.get(AGENTS)).toEqual(before.get(AGENTS));
    expect(states()).toEqual([
      ['claude', SKILL, 'current'],
      ['agents-md', AGENTS, 'current'],
      ['cursor', RULE, 'current'],
      ['cursor', CURSOR_MCP, 'current'],
    ]);
  });

  it('adding codex, antigravity and copilot to a 0.3.0 install changes none of its files', () => {
    const { root, scratch } = setup();
    writeRel(root, SKILL, SKILL_030);
    writeRel(root, AGENTS, `# Mine\n\n${BLOCK_030}\n`);
    const before = snapshot(root);
    const result: InstallResult = installIn(root, scratch, {
      targets: ['codex', 'antigravity', 'copilot'],
    });
    expect(summary(result)).toEqual([
      ['codex', AGENTS, 'unchanged', null],
      ['antigravity', AGENTS, 'unchanged', null],
      ['copilot', COPILOT, 'created', null],
    ]);
    const after = snapshot(root);
    expect(after.get(SKILL)).toEqual(before.get(SKILL));
    expect(after.get(AGENTS)).toEqual(before.get(AGENTS));
    expect(outcomesOf(result, 'codex')).toHaveLength(1);
  });
});
