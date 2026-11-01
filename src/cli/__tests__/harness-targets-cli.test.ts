/**
 * The `codex`, `cursor`, `antigravity` and `copilot` targets and
 * `--global` through the built CLI (board-agent-guidance: "Global harness
 * config is never edited by default" scenarios "Default prints the
 * command", "Global edit is explicit" and "Global needs an explicit
 * target"; "Harness MCP entries"; "Antigravity rules stay within size
 * limits"; board-cli "Refusals never repeat the refused input"; design.md
 * "Rulings from task group 4 (test author)"): stdout and stderr, exit
 * codes, the printed registration commands run by a real shell, refusals
 * and usage errors that repeat no input, and the help. Every run has a
 * scratch HOME and CODEX_HOME. The per-target behaviour is covered through
 * the library in src/guidance/__tests__/harness-*.test.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import {
  fileList,
  plainProject,
  readRel,
  writeRel,
} from '../../guidance/__tests__/guidance-helpers.js';
import {
  AGENTS,
  AGY_ADD,
  BLOCK_030,
  CODEX_ADD,
  CURSOR_MCP,
  RULE,
  codexBlock,
  contents,
  fakeHarnessBin,
  local,
  mcpFile,
  readAbs,
  scratchHome,
  writeAbs,
  type ScratchHome,
} from '../../guidance/__tests__/harness-helpers.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

// Several Node children per test; see agents-cli.test.ts.
const SPAWNS = { timeout: 60_000 };

function cli(argv: readonly string[], cwd: string, scratch: ScratchHome): Run {
  return spawnCli(argv, cwd, {
    ...scratch.env,
    AGENTBOARD_ACTOR: undefined,
    AGENTBOARD_DIR: undefined,
  });
}

function errorOf(out: Run): { exitCode: number; reason: string | null; message: string } {
  return (oneJson(out) as { error: { exitCode: number; reason: string | null; message: string } })
    .error;
}

describe('agents install for the harness targets through the built CLI', SPAWNS, () => {
  it('scenario: Default prints the command (codex and antigravity, no global file)', () => {
    const root = plainProject();
    const scratch = scratchHome();
    const out = cli(
      ['agents', 'install', '--target', 'codex', '--target', 'antigravity'],
      root,
      scratch,
    );
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const lines = out.stdout.split('\n');
    expect(lines).toContain(`    ${CODEX_ADD}`);
    expect(lines).toContain(`    ${AGY_ADD}`);
    expect(out.stdout).toContain(`created codex ${AGENTS}\n`);
    expect(out.stdout).toContain(`unchanged antigravity ${AGENTS} (up to date)\n`);
    expect(existsSync(scratch.codexConfig)).toBe(false);
    expect(existsSync(scratch.agyConfig)).toBe(false);
    expect(fileList(scratch.home)).toEqual([]);
    expect(readRel(root, AGENTS)).toBe(`${BLOCK_030}\n`);
  });

  it('puts the commands in the --json document as registerCommands', () => {
    const root = plainProject();
    const scratch = scratchHome();
    const out = cli(
      ['agents', 'install', '--target', 'codex', '--target', 'antigravity', '--json'],
      root,
      scratch,
    );
    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({
      registerCommands: [
        { target: 'codex', command: CODEX_ADD },
        { target: 'antigravity', command: AGY_ADD },
      ],
    });
  });

  it('prints commands that a shell runs with the --command executable exactly as given', () => {
    const root = plainProject();
    const scratch = scratchHome();
    const exe = "/opt/My Tools/it's/agentboard";
    const out = cli(
      ['agents', 'install', '--target', 'codex', '--target', 'antigravity', '--command', exe],
      root,
      scratch,
    );
    expect(out.code, out.stderr).toBe(0);
    const printed = out.stdout
      .split('\n')
      .filter((l) => /^ {4}(codex|agy) mcp add /.test(l))
      .map((l) => l.slice(4));
    expect(printed).toHaveLength(2);
    const bin = fakeHarnessBin();
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: bin };
    const runs = printed.map(
      (line) => spawnSync('/bin/sh', ['-c', line], { env, encoding: 'utf8' }).stdout,
    );
    expect(runs).toEqual([
      ['mcp', 'add', 'agentboard', '--', exe, 'mcp', ''].join('\n'),
      ['mcp', 'add', 'agentboard', exe, 'mcp', ''].join('\n'),
    ]);
    expect(readRel(root, '.mcp.json')).toBe(mcpFile(local(exe)));
  });

  it('auto-detects .codex/, .cursor/, .agents/ and the Copilot file and says why', () => {
    const root = plainProject();
    const scratch = scratchHome();
    for (const dir of ['.codex', '.cursor', '.agents']) {
      mkdirSync(join(root, dir));
    }
    writeRel(root, '.github/copilot-instructions.md', '# Mine\n');
    const out = cli(['agents', 'install'], root, scratch);
    expect(out.code, out.stderr).toBe(0);
    for (const line of [
      'selected codex: .codex/ exists',
      'selected cursor: .cursor/ exists',
      'selected antigravity: .agents/ exists',
      'selected copilot: .github/copilot-instructions.md exists',
    ]) {
      expect(out.stdout).toContain(`${line}\n`);
    }
    expect(fileList(scratch.home)).toEqual([]);
    const check = cli(['agents', 'check'], root, scratch);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).toBe(
      [
        `current agents-md ${AGENTS} (installed v3, current v3)`,
        `current cursor ${RULE} (installed v3, current v3)`,
        `current cursor ${CURSOR_MCP} (installed unknown, current v3)`,
        'current copilot .github/copilot-instructions.md (installed v3, current v3)',
        '',
      ].join('\n'),
    );
  });

  it('scenario: Global edit is explicit, and agents check --global reports it while plain check does not', () => {
    const root = plainProject();
    const scratch = scratchHome();
    const user = '# mine\n[mcp_servers.other]\ncommand = "other"\n';
    writeAbs(scratch.codexConfig, user);
    const out = cli(['agents', 'install', '--target', 'codex', '--global'], root, scratch);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(`updated codex ${scratch.codexConfig}\n`);
    expect(out.stdout).not.toContain('codex mcp add');
    expect(readAbs(scratch.codexConfig)).toBe(`${user}\n${codexBlock()}\n`);
    const plain = cli(['agents', 'check', '--json'], root, scratch);
    expect((oneJson(plain) as { target: string }[]).map((e) => e.target)).toEqual(['agents-md']);
    const global = cli(['agents', 'check', '--global', '--json'], root, scratch);
    expect(global.code, global.stderr).toBe(0);
    expect(oneJson(global)).toEqual([
      {
        target: 'agents-md',
        path: AGENTS,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
      {
        target: 'codex',
        path: scratch.codexConfig,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
  });

  it('scenario: Global needs an explicit target (exit 1, usage, nothing written)', () => {
    const root = plainProject();
    const scratch = scratchHome();
    mkdirSync(join(root, '.codex'));
    const before = contents(root);
    const out = cli(['agents', 'install', '--global', '--json'], root, scratch);
    expect(out.code).toBe(1);
    expect(errorOf(out)).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(errorOf(out).message).toBe(
      "--global edits a harness's global MCP config and needs --target codex or --target antigravity",
    );
    expect(contents(root)).toEqual(before);
    expect(fileList(scratch.home)).toEqual([]);
    const text = cli(['agents', 'install', '--global', '--target', 'cursor'], root, scratch);
    expect(text.code).toBe(1);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain('--global');
  });

  it('refuses a foreign Codex table with exit 1, naming the file, and still installs the other targets', () => {
    const root = plainProject();
    const scratch = scratchHome();
    const text = '[mcp_servers.agentboard]\ncommand = "mine"\n';
    writeAbs(scratch.codexConfig, text);
    const out = cli(
      ['agents', 'install', '--target', 'codex', '--target', 'copilot', '--global'],
      root,
      scratch,
    );
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(`refused codex ${scratch.codexConfig}: `);
    expect(out.stderr).toContain(`agentboard: refused codex: `);
    expect(out.stdout).toContain('created copilot .github/copilot-instructions.md\n');
    expect(readAbs(scratch.codexConfig)).toBe(text);
  });

  it.each(TOKEN_FIXTURES)('refusals repeat none of the files ($name)', (f) => {
    const root = plainProject();
    const scratch = scratchHome();
    writeAbs(scratch.codexConfig, `[mcp_servers.agentboard]\nenv = { T = "${f.value}" }\n`);
    writeAbs(
      scratch.agyConfig,
      JSON.stringify({ mcpServers: { agentboard: { command: f.value }, x: 1 } }),
    );
    writeRel(
      root,
      CURSOR_MCP,
      JSON.stringify({ mcpServers: { agentboard: { command: 'x', env: { T: f.value } } } }),
    );
    writeRel(root, RULE, `${f.value}\n`);
    for (const json of [[], ['--json']]) {
      const out = cli(
        [
          'agents',
          'install',
          '--target',
          'codex',
          '--target',
          'cursor',
          '--target',
          'antigravity',
          '--global',
          ...json,
        ],
        root,
        scratch,
      );
      expect(out.code).toBe(1);
      expectNoLeak('harness refusals', [out.stdout, out.stderr], [f]);
    }
  });

  it.each(TOKEN_FIXTURES)(
    'an empty or multi-line --command is refused without repeating it ($name)',
    (f) => {
      const root = plainProject();
      const scratch = scratchHome();
      mkdirSync(join(root, '.cursor'));
      const targets = [
        '--target',
        'codex',
        '--target',
        'cursor',
        '--target',
        'antigravity',
        '--target',
        'copilot',
      ];
      const empty = cli(['agents', 'install', ...targets, '--command', ''], root, scratch);
      expect(empty.code).toBe(1);
      expect(empty.stdout).toBe('');
      expect(empty.stderr).toContain('--command must not be empty');
      for (const flag of ['--command', '--mcp-command']) {
        const multi = cli(
          ['agents', 'install', ...targets, flag, `${f.value}\n${f.value}`],
          root,
          scratch,
        );
        expect(multi.code).toBe(1);
        expect(multi.stdout).toBe('');
        expect(multi.stderr).toContain(`${flag} must not contain a newline`);
        expectNoLeak('multi-line --command', [multi.stdout, multi.stderr], [f]);
      }
      expect(fileList(root)).toEqual([]);
      expect(fileList(scratch.home)).toEqual([]);
    },
  );

  it('agents check warns on stderr about an AGENTS.md over 24 KB and exits 0', () => {
    const root = plainProject();
    const scratch = scratchHome();
    writeRel(root, AGENTS, `${BLOCK_030}\n\n${'x'.repeat(30 * 1024 - BLOCK_030.length - 3)}\n`);
    const out = cli(['agents', 'check'], root, scratch);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe(
      'agentboard: AGENTS.md is 30720 bytes; the Antigravity CLI reads at most 24 KB (24576 bytes) of a rules file, so it ignores the rest\n',
    );
    expect(out.stdout).toBe(`current agents-md ${AGENTS} (installed v3, current v3)\n`);
  });

  it('lists --global in the help of agents install and agents check', () => {
    const root = plainProject();
    const scratch = scratchHome();
    const install = cli(['help', 'agents', 'install'], root, scratch);
    expect(install.code, install.stderr).toBe(0);
    expect(install.stdout).toMatch(/^Usage: agentboard agents install .*\[--global\]/m);
    expect(install.stdout).toMatch(/^ {2}--global /m);
    const check = cli(['help', 'agents', 'check'], root, scratch);
    expect(check.stdout).toMatch(/^Usage: agentboard agents check \[--global\] \[--json\]$/m);
    expect(install.stdout).toContain('codex');
    expect(install.stdout).toContain('copilot');
  });
});
