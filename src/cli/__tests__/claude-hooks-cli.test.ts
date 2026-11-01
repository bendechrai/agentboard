/**
 * The `claude-hooks` target, `--hooks-strict`, `--command` and the
 * deprecated `--mcp-command` through the built CLI (board-harness-hooks
 * "Hooks installed in Claude settings"; board-agent-guidance "Installing
 * guidance into a host project", scenarios "Hooks are opt-in" and
 * "Deprecated alias", "Checking installed guidance"; board-cli "Refusals
 * never repeat the refused input"; design.md "Rulings from task group 3
 * (test author)"): exit codes, stdout and stderr, the deprecation line,
 * refusals that repeat no input, and the written hook commands run by a
 * real shell. The per-target behaviour is covered through the library in
 * src/guidance/__tests__/claude-hooks-*.test.ts.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import {
  plainProject,
  readRel,
  snapshot,
  writeRel,
} from '../../guidance/__tests__/guidance-helpers.js';
import { MCP_COMMAND_DEPRECATION } from '../../guidance/install.js';
import { cliEnv, oneJson, spawnCli, type Run } from './cli-helpers.js';

const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';
const NPX = 'npx -y @bendechrai/agentboard';

// Several Node children per test; see agents-cli.test.ts.
const SPAWNS = { timeout: 60_000 };

function cli(argv: readonly string[], cwd: string): Run {
  return spawnCli(argv, cwd, cliEnv());
}

function errorOf(out: Run): { exitCode: number; reason: string | null; message: string } {
  return (oneJson(out) as { error: { exitCode: number; reason: string | null; message: string } })
    .error;
}

/** The handler commands of a settings file, per key. */
function commandsOf(root: string): Record<string, string[]> {
  const settings = JSON.parse(readRel(root, SETTINGS)) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const out: Record<string, string[]> = {};
  for (const [key, groups] of Object.entries(settings.hooks)) {
    out[key] = groups.flatMap((g) => g.hooks.map((h) => h.command));
  }
  return out;
}

/** Every file of `root` with its content, without mtimes. */
function contents(root: string): Map<string, string> {
  return new Map([...snapshot(root)].map(([path, { content }]) => [path, content]));
}

describe('agents install --target claude-hooks through the built CLI', SPAWNS, () => {
  it('installs the hooks with no board and no actor, and check reports them current', () => {
    const root = plainProject();
    const out = cli(['agents', 'install', '--target', 'claude-hooks'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain(`created claude-hooks ${SETTINGS}\n`);
    expect(commandsOf(root)).toEqual({
      SessionStart: [`${NPX} hook session-start # agentboard-hooks: v3`],
      Stop: [`${NPX} hook stop # agentboard-hooks: v3`],
      PreToolUse: [`${NPX} hook pre-tool-use # agentboard-hooks: v3`],
    });
    expect(existsSync(join(root, '.board'))).toBe(false);
    const check = cli(['agents', 'check'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).toBe(`current claude-hooks ${SETTINGS} (installed v3, current v3)\n`);
    const checkJson = cli(['agents', 'check', '--json'], root);
    expect(oneJson(checkJson)).toEqual([
      {
        target: 'claude-hooks',
        path: SETTINGS,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
  });

  it('writes strict commands with --hooks-strict and switches back without it', () => {
    const root = plainProject();
    const strict = cli(['agents', 'install', '--target', 'claude-hooks', '--hooks-strict'], root);
    expect(strict.code, strict.stderr).toBe(0);
    expect(Object.values(commandsOf(root)).flat()).toEqual([
      `${NPX} hook session-start --strict # agentboard-hooks: v3`,
      `${NPX} hook stop --strict # agentboard-hooks: v3`,
      `${NPX} hook pre-tool-use --strict # agentboard-hooks: v3`,
    ]);
    const warn = cli(['agents', 'install', '--target', 'claude-hooks'], root);
    expect(warn.code, warn.stderr).toBe(0);
    expect(warn.stdout).toContain(`updated claude-hooks ${SETTINGS}\n`);
    expect(Object.values(commandsOf(root)).flat().join('\n')).not.toContain('--strict');
  });

  it('scenario: Reinstall is idempotent (claude-hooks next to the other targets)', () => {
    const root = plainProject();
    const argv = ['agents', 'install', '--target', 'claude', '--target', 'claude-hooks'];
    expect(cli(argv, root).code).toBe(0);
    const before = snapshot(root);
    const out = cli(argv, root);
    expect(out.code, out.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(out.stdout).toContain(`unchanged claude-hooks ${SETTINGS} (up to date)\n`);
  });

  it('scenario: Hooks are opt-in', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    const out = cli(['agents', 'install'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).not.toContain('claude-hooks');
    expect(existsSync(join(root, SETTINGS))).toBe(false);
  });

  it('refuses invalid settings, exits 1, names the file and repeats none of its content', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      const text = `{"apiKeyHelper": ${JSON.stringify(f.value)}, ${f.value}}`;
      writeRel(root, SETTINGS, text);
      const out = cli(
        ['agents', 'install', '--target', 'claude', '--target', 'claude-hooks'],
        root,
      );
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/^agentboard: refused claude-hooks: .*\.claude\/settings\.json/m);
      expect(out.stdout).toContain('created claude ');
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
      const asJson = cli(['agents', 'install', '--target', 'claude-hooks', '--json'], root);
      expect(asJson.code).toBe(1);
      expect(oneJson(asJson)).toMatchObject({
        refused: 1,
        targets: [{ target: 'claude-hooks', action: 'refused', refusal: 'malformed-settings' }],
      });
      expectNoLeak(f.name, [asJson.stdout, asJson.stderr], [f]);
      expect(readRel(root, SETTINGS)).toBe(text);
    }
  });

  it('check repeats none of the content of a settings file it reports modified', () => {
    for (const f of TOKEN_FIXTURES.slice(0, 3)) {
      const root = plainProject();
      writeRel(root, SETTINGS, `{"x": ${f.value} # agentboard-hooks: v3`);
      const out = cli(['agents', 'check'], root);
      expect(out.code).toBe(1);
      expect(out.stdout).toBe(
        `modified claude-hooks ${SETTINGS} (installed unknown, current v3)\n`,
      );
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
    }
  });
});

describe('agents install --command and the deprecated --mcp-command', SPAWNS, () => {
  it('sets the executable of the hooks and of the MCP entry, naming --command as the reason', () => {
    const root = plainProject();
    const out = cli(
      ['agents', 'install', '--target', 'claude-hooks', '--command', 'agentboard'],
      root,
    );
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('selected mcp-json: requested with --command\n');
    expect(out.stdout).toContain(`created mcp-json ${MCP}\n`);
    expect(out.stdout).toContain(`created claude-hooks ${SETTINGS}\n`);
    for (const command of Object.values(commandsOf(root)).flat()) {
      expect(command.startsWith('agentboard hook ')).toBe(true);
    }
    expect(JSON.parse(readRel(root, MCP))).toEqual({
      mcpServers: { agentboard: { command: 'agentboard', args: ['mcp'] } },
    });
  });

  it('scenario: Deprecated alias', () => {
    const viaCommand = plainProject();
    const viaAlias = plainProject();
    for (const root of [viaCommand, viaAlias]) {
      mkdirSync(join(root, '.claude'));
    }
    const a = cli(['agents', 'install', '--command', 'agentboard'], viaCommand);
    const b = cli(['agents', 'install', '--mcp-command', 'agentboard'], viaAlias);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(a.stderr).toBe('');
    expect(b.stderr).toBe(`agentboard: ${MCP_COMMAND_DEPRECATION}\n`);
    expect(MCP_COMMAND_DEPRECATION).toContain('--command');
    expect(MCP_COMMAND_DEPRECATION).toContain('--mcp-command');
    expect(MCP_COMMAND_DEPRECATION).toMatch(/deprecated/);
    expect(MCP_COMMAND_DEPRECATION).not.toContain('agentboard ');
    expect(b.stdout.replaceAll(viaAlias, '<root>')).toBe(a.stdout.replaceAll(viaCommand, '<root>'));
    expect(contents(viaAlias)).toEqual(contents(viaCommand));
    expect(b.stdout).toContain('selected mcp-json: requested with --command\n');
  });

  it('prints the deprecation line with --json and gives the same document', () => {
    const viaCommand = plainProject();
    const viaAlias = plainProject();
    const argv = ['agents', 'install', '--target', 'claude-hooks', '--json'];
    const a = cli([...argv, '--command', '/opt/x/agentboard'], viaCommand);
    const b = cli([...argv, '--mcp-command', '/opt/x/agentboard'], viaAlias);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(a.stderr).toBe('');
    expect(b.stderr).toBe(`agentboard: ${MCP_COMMAND_DEPRECATION}\n`);
    expect({ ...(oneJson(b) as object), root: '<root>' }).toEqual({
      ...(oneJson(a) as object),
      root: '<root>',
    });
    expect(contents(viaAlias)).toEqual(contents(viaCommand));
  });

  it('prints the deprecation line first when a target is refused', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{,}');
    const out = cli(
      ['agents', 'install', '--target', 'claude-hooks', '--mcp-command', 'agentboard'],
      root,
    );
    expect(out.code).toBe(1);
    const lines = out.stderr.split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe(`agentboard: ${MCP_COMMAND_DEPRECATION}`);
    expect(lines.slice(1).every((l) => l.startsWith('agentboard: refused claude-hooks: '))).toBe(
      true,
    );
    expect(lines).toHaveLength(2);
  });

  it.each([
    ['--command', ''],
    ['--command', 'agent\nboard'],
    ['--mcp-command', ''],
    ['--mcp-command', 'agent\nboard'],
  ])('refuses %s %j as usage naming that flag, printing no deprecation line', (flag, value) => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    const before = snapshot(root);
    const out = cli(['agents', 'install', '--target', 'claude-hooks', flag, value, '--json'], root);
    expect(out.code).toBe(1);
    expect(errorOf(out)).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(errorOf(out).message).toMatch(new RegExp(`^${flag} must not `));
    expect(out.stderr).not.toContain('deprecated');
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses --command with --mcp-command, repeating neither value and writing nothing', () => {
    for (const f of TOKEN_FIXTURES.slice(0, 3)) {
      const root = plainProject();
      const argv = ['agents', 'install', '--command', f.value, '--mcp-command', f.value, '--json'];
      const out = cli(argv, root);
      expect(out.code).toBe(1);
      expect(errorOf(out)).toMatchObject({
        exitCode: 1,
        reason: 'usage',
        message: 'give only one of --command, --mcp-command',
      });
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
      expect(snapshot(root).size).toBe(0);
    }
  });
});

describe('the written hook commands run in a real shell', SPAWNS, () => {
  /**
   * A fake agentboard at `<dir>/agentboard` that records its arguments,
   * one per line, in `<log>`, so the test sees exactly what the shell
   * passed.
   */
  function fakeExecutable(dir: string, log: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'agentboard');
    writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it.each([
    ['a plain directory', 'bin'],
    ['a directory with a space', 'My Tools'],
    ['a directory with a dollar sign', 'a$HOME b'],
    ['a directory with a single quote', "it's"],
    ['a directory with a hash', 'x#y'],
  ])('runs the executable in %s with exactly hook <event> [--strict]', (_label, dirName) => {
    const root = plainProject();
    const scratch = tempDir();
    const log = join(scratch, 'args.log');
    const exe = fakeExecutable(join(scratch, dirName), log);
    const out = cli(
      ['agents', 'install', '--target', 'claude-hooks', '--hooks-strict', '--command', exe],
      root,
    );
    expect(out.code, out.stderr).toBe(0);
    const expected: Record<string, string> = {
      SessionStart: 'session-start',
      Stop: 'stop',
      PreToolUse: 'pre-tool-use',
    };
    for (const [key, [command]] of Object.entries(commandsOf(root))) {
      expect(command, key).toBeDefined();
      const ran = spawnSync('/bin/sh', ['-c', command ?? ''], {
        cwd: root,
        input: '{}',
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch },
        timeout: 10_000,
      });
      expect(ran.status, `${key}: ${ran.stderr}`).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe(`hook\n${expected[key] ?? ''}\n--strict\n`);
    }
  });
});

describe('values a shell would misread (review round 1, R3)', SPAWNS, () => {
  /** A directory of fake executables, each recording its arguments in `<log>`. */
  function fakeBin(names: readonly string[], log: string): string {
    const dir = join(tempDir(), 'bin');
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`);
      chmodSync(path, 0o755);
    }
    return dir;
  }

  const NAMES = ['FOO=bar', 'if', 'time', 'function', '!', '{', 'case', 'select', '[['];
  const SHELLS = ['/bin/sh', ...(existsSync('/bin/bash') ? ['/bin/bash'] : [])];

  it.each(NAMES)('runs an executable named %s found on the PATH', (name) => {
    const root = plainProject();
    const log = join(tempDir(), 'args.log');
    const bin = fakeBin([name], log);
    const out = cli(['agents', 'install', '--target', 'claude-hooks', '--command', name], root);
    expect(out.code, out.stderr).toBe(0);
    const [command] = commandsOf(root).Stop ?? [];
    for (const shell of SHELLS) {
      writeFileSync(log, '');
      const ran = spawnSync(shell, ['-c', command ?? ''], {
        cwd: root,
        input: '{}',
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
        timeout: 10_000,
      });
      expect(ran.status, `${shell}: ${ran.stderr}`).toBe(0);
      expect(readFileSync(log, 'utf8'), shell).toBe('hook\nstop\n');
    }
  });

  it.each([
    ['-rf', 'must not start with a hyphen'],
    ['exec', 'must not be a shell special built-in; give the path of the executable'],
    ['set', 'must not be a shell special built-in; give the path of the executable'],
  ])('refuses --command %s as usage naming the flag, writing nothing', (value, why) => {
    const root = plainProject();
    const out = cli(
      ['agents', 'install', '--target', 'claude-hooks', `--command=${value}`, '--json'],
      root,
    );
    expect(out.code).toBe(1);
    expect(errorOf(out)).toMatchObject({
      exitCode: 1,
      reason: 'usage',
      message: `--command ${why}`,
    });
    expect(snapshot(root).size).toBe(0);
  });

  it('repeats no part of a refused value with a leading hyphen', () => {
    for (const f of TOKEN_FIXTURES.slice(0, 3)) {
      const root = plainProject();
      const out = cli(['agents', 'install', `--command=-${f.value}`, '--json'], root);
      expect(out.code).toBe(1);
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
    }
  });
});
