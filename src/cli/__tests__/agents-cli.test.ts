/**
 * `agents install`, `agents check` and the `init` suggestion at the CLI
 * (board-agent-guidance: "Installing guidance into a host project",
 * "Installed guidance never clobbers user content", "Checking installed
 * guidance"; add-agent-guidance group 3): exit codes, stdout and stderr,
 * `--json` documents, no board and no actor needed, and the spec scenarios
 * through the built CLI. The per-target behavior is covered through the
 * library in src/guidance/__tests__/install.test.ts and check.test.ts.
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  IS_ROOT,
  OPENSPEC_FIXTURE,
  chmodForTest,
  commentLines,
  linkedWorktree,
  plainProject,
  symlinkCycle,
  readRel,
  repo,
  snapshot,
  writeRel,
} from '../../guidance/__tests__/guidance-helpers.js';
import { INIT_SUGGESTION } from '../../guidance/install.js';
import {
  GUIDANCE_RULES,
  GUIDANCE_VERSION,
  manualOpenSpecLines,
  renderAgentsBlock,
  renderSkill,
  skillMarker,
} from '../../guidance/installed-text.js';
import { cliEnv, oneJson, run, spawnCli, type Run } from './cli-helpers.js';

const SKILL = '.claude/skills/agentboard/SKILL.md';
const AGENTS = 'AGENTS.md';
const CONFIG = 'openspec/config.yaml';
const MCP = '.mcp.json';
const V = GUIDANCE_VERSION;
const TARGETS = ['claude', 'agents-md', 'openspec', 'mcp-json'];

/** The built CLI with no actor and no board override. */
function cli(argv: readonly string[], cwd: string): Run {
  return spawnCli(argv, cwd, cliEnv());
}

function errorOf(out: Run): { exitCode: number; reason: string | null; message: string } {
  return (oneJson(out) as { error: { exitCode: number; reason: string | null; message: string } })
    .error;
}

describe('agents install through the built CLI', () => {
  it('scenario: installs the Claude skill with no board and no actor', () => {
    const root = plainProject();
    const out = cli(['agents', 'install', '--target', 'claude'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain(`created claude ${SKILL}\n`);
    const skill = readRel(root, SKILL);
    expect(skill.split('\n').slice(0, 2)).toEqual(['---', 'name: agentboard']);
    for (const rule of GUIDANCE_RULES) {
      expect(skill).toContain(rule);
    }
    expect(skill).toContain('agentboard help agents');
    expect(skill).toContain(skillMarker(V));
    expect(existsSync(join(root, '.board'))).toBe(false);
  });

  it('scenario: auto-detection installs claude and openspec and says why', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    const out = cli(['agents', 'install'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain('selected claude: .claude/ exists\n');
    expect(out.stdout).toContain('selected openspec: openspec/config.yaml exists\n');
    expect(out.stdout).not.toMatch(/agents-md|mcp-json/);
    expect(existsSync(join(root, SKILL))).toBe(true);
    expect(existsSync(join(root, AGENTS))).toBe(false);
    expect(existsSync(join(root, MCP))).toBe(false);
    expect(commentLines(readRel(root, CONFIG))).toEqual(commentLines(OPENSPEC_FIXTURE));
  });

  it('scenario: reinstall changes no byte and reports each target as up to date', () => {
    const root = plainProject();
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    const argv = ['agents', 'install', ...TARGETS.flatMap((t) => ['--target', t])];
    expect(cli(argv, root).code).toBe(0);
    const before = snapshot(root);
    const out = cli(argv, root);
    expect(out.code, out.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
    for (const target of TARGETS) {
      expect(out.stdout).toMatch(new RegExp(`^unchanged ${target} \\S+ \\(up to date\\)$`, 'm'));
    }
  });

  it('exits 1 listing every target when nothing is selected', () => {
    const root = plainProject();
    const out = cli(['agents', 'install'], root);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    for (const target of TARGETS) {
      expect(out.stderr).toContain(target);
    }
    const json = cli(['agents', 'install', '--json'], root);
    expect(json.code).toBe(1);
    expect(errorOf(json)).toMatchObject({ exitCode: 1, reason: 'no-targets' });
  });

  it('exits 1 on an unknown target', () => {
    const out = cli(['agents', 'install', '--target', 'cursor', '--json'], plainProject());
    expect(out.code).toBe(1);
    expect(errorOf(out)).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(errorOf(out).message).toContain('cursor');
  });

  it('scenario: a foreign SKILL.md is refused and named, and the other targets still install', () => {
    const root = plainProject();
    writeRel(root, SKILL, 'my skill\n');
    writeRel(root, AGENTS, '# Agents\n');
    const out = cli(['agents', 'install'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(SKILL);
    expect(out.stderr).toMatch(/^agentboard: refused claude: /m);
    expect(out.stdout).toContain(`updated agents-md ${AGENTS}`);
    expect(readRel(root, SKILL)).toBe('my skill\n');
    expect(readRel(root, AGENTS)).toBe(`# Agents\n\n${renderAgentsBlock()}\n`);
  });

  it('prints the full result as one JSON document when a target is refused', () => {
    const root = plainProject();
    writeRel(root, SKILL, 'my skill\n');
    const out = cli(
      ['agents', 'install', '--target', 'claude', '--target', 'agents-md', '--json'],
      root,
    );
    expect(out.code).toBe(1);
    expect(oneJson(out)).toMatchObject({
      root,
      version: V,
      autoDetected: false,
      refused: 1,
      targets: [
        { target: 'claude', path: SKILL, action: 'refused', refusal: 'foreign-file' },
        { target: 'agents-md', path: AGENTS, action: 'created', refusal: null },
      ],
    });
  });

  it('prints the lines to add by hand when the OpenSpec guidance key is not a list', () => {
    const root = plainProject();
    const config = 'schema: spec-driven\noperations:\n  apply:\n    guidance: be brief\n';
    writeRel(root, CONFIG, config);
    const out = cli(['agents', 'install', '--target', 'openspec'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(CONFIG);
    for (const line of manualOpenSpecLines()) {
      expect(out.stdout).toContain(`    ${line}\n`);
    }
    expect(readRel(root, CONFIG)).toBe(config);
  });

  it('overrides a refusal with --force', () => {
    const root = plainProject();
    writeRel(root, SKILL, 'my skill\n');
    const out = cli(['agents', 'install', '--target', 'claude', '--force'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(readRel(root, SKILL)).toBe(renderSkill());
  });

  it('refuses a differing mcpServers.agentboard entry without --force', () => {
    const root = plainProject();
    const mcp = `${JSON.stringify({ mcpServers: { agentboard: { command: 'agentboard' } } }, null, 2)}\n`;
    writeRel(root, MCP, mcp);
    const out = cli(['agents', 'install', '--target', 'mcp-json'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(MCP);
    expect(readRel(root, MCP)).toBe(mcp);
    expect(cli(['agents', 'install', '--target', 'mcp-json', '--force'], root).code).toBe(0);
  });

  it('writes at the root of a linked worktree, not the main checkout', () => {
    const { main, worktree } = linkedWorktree();
    const sub = join(worktree, 'src');
    mkdirSync(sub);
    const out = cli(['agents', 'install', '--target', 'agents-md', '--json'], sub);
    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({ root: worktree });
    expect(existsSync(join(worktree, AGENTS))).toBe(true);
    expect(existsSync(join(main, AGENTS))).toBe(false);
  });

  it('writes into the current directory outside git', () => {
    const dir = plainProject();
    const out = cli(['agents', 'install', '--target', 'agents-md'], dir);
    expect(out.code, out.stderr).toBe(0);
    expect(readRel(dir, AGENTS)).toBe(`${renderAgentsBlock()}\n`);
  });

  it('accepts and ignores --as', () => {
    const root = plainProject();
    expect(
      run(['agents', 'install', '--target', 'claude', '--as', 'impl'], root, cliEnv()).code,
    ).toBe(0);
  });
});

describe('agents check through the built CLI', () => {
  function installAll(root: string): void {
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    const out = cli(['agents', 'install', ...TARGETS.flatMap((t) => ['--target', t])], root);
    expect(out.code, out.stderr).toBe(0);
  }

  it('exits 0 and reports every target current', () => {
    const root = plainProject();
    installAll(root);
    const out = cli(['agents', 'check'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    for (const target of TARGETS) {
      expect(out.stdout).toMatch(new RegExp(`^current ${target} `, 'm'));
    }
  });

  it('prints an array of target, path, state and versions with --json', () => {
    const root = plainProject();
    installAll(root);
    const out = cli(['agents', 'check', '--json'], root);
    expect(out.code).toBe(0);
    const doc = oneJson(out) as Record<string, unknown>[];
    expect(doc.map((e) => Object.keys(e).sort())).toEqual(
      TARGETS.map(() => ['currentVersion', 'installedVersion', 'path', 'state', 'target']),
    );
    expect(doc.map((e) => [e.target, e.path, e.state])).toEqual([
      ['claude', SKILL, 'current'],
      ['agents-md', AGENTS, 'current'],
      ['openspec', CONFIG, 'current'],
      ['mcp-json', MCP, 'current'],
    ]);
  });

  it('scenario: a skill from an older guidance version is stale and exits 1', () => {
    const root = plainProject();
    writeRel(root, SKILL, renderSkill(V - 1));
    const out = cli(['agents', 'check', '--json'], root);
    expect(out.code).toBe(1);
    expect(oneJson(out)).toEqual([
      { target: 'claude', path: SKILL, state: 'stale', installedVersion: V - 1, currentVersion: V },
    ]);
    const text = cli(['agents', 'check'], root);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`stale claude ${SKILL}`);
    expect(text.stderr).toContain('agentboard agents install');
  });

  it('reports a hand-edited block as modified and exits 1', () => {
    const root = plainProject();
    installAll(root);
    writeRel(root, AGENTS, readRel(root, AGENTS).replace('Rules you must never break', 'Rules'));
    const out = cli(['agents', 'check'], root);
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/^modified agents-md AGENTS\.md /m);
  });

  it('exits 0 when no guidance is installed', () => {
    const root = plainProject();
    const out = cli(['agents', 'check'], root);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe(`no agentboard guidance found in ${root}\n`);
  });

  it('is fixed by agents install', () => {
    const root = plainProject();
    writeRel(root, SKILL, renderSkill(V - 1));
    expect(cli(['agents', 'install', '--target', 'claude'], root).code).toBe(0);
    expect(cli(['agents', 'check'], root).code).toBe(0);
  });
});

describe('help for the agents commands', () => {
  it.each([
    ['agents', 'install', '--help'],
    ['help', 'agents', 'install'],
    ['agents', 'check', '--help'],
    ['help', 'agents', 'check'],
  ])('%s %s %s prints help with no board and no actor', (...argv) => {
    const out = run(argv, plainProject(), cliEnv());
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/^Usage: agentboard agents (install|check)/);
  });
});

describe('init suggests agents install', () => {
  it('ends its output with the suggestion, also when the board already exists', () => {
    const root = repo();
    for (const pass of [1, 2]) {
      const out = cli(['init'], root);
      expect(out.code, `pass ${String(pass)}: ${out.stderr}`).toBe(0);
      expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`), out.stdout).toBe(true);
    }
  });

  it('keeps init --json one document without the suggestion', () => {
    const out = run(['init', '--json'], repo(), cliEnv());
    expect(out.code).toBe(0);
    expect(oneJson(out)).toMatchObject({ created: true });
    expect(out.stdout).not.toContain('agents install');
  });
});

describe('filesystem problems exit 1 with a refusal, never 5', () => {
  it('a directory at SKILL.md: install refuses it and installs the rest, check skips it', () => {
    const root = plainProject();
    mkdirSync(join(root, SKILL), { recursive: true });
    const out = cli(['agents', 'install', '--target', 'claude', '--target', 'agents-md'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/^agentboard: refused claude: .*SKILL\.md/m);
    expect(existsSync(join(root, AGENTS))).toBe(true);
    const check = cli(['agents', 'check'], root);
    expect(check.code, check.stderr).toBe(0);
  });

  it.skipIf(IS_ROOT)('a read-only AGENTS.md is refused as unwritable', () => {
    const root = plainProject();
    writeRel(root, AGENTS, '# Ours\n');
    chmodForTest(join(root, AGENTS), 0o444);
    const out = cli(['agents', 'install', '--target', 'agents-md', '--json'], root);
    expect(out.code).toBe(1);
    expect(oneJson(out)).toMatchObject({
      refused: 1,
      targets: [{ target: 'agents-md', action: 'refused', refusal: 'unwritable' }],
    });
    expect(readRel(root, AGENTS)).toBe('# Ours\n');
  });

  it('a symlink out of the tree is refused as outside-tree, even with --force', () => {
    const root = plainProject();
    const outside = join(plainProject(), 'AGENTS.md');
    writeFileSync(outside, 'theirs\n');
    symlinkSync(outside, join(root, AGENTS));
    const out = cli(['agents', 'install', '--target', 'agents-md', '--force'], root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('refused agents-md');
    expect(readRel(outside, '')).toBe('theirs\n');
  });
});

describe('symlink cycles through the built CLI (round 3)', () => {
  it('install exits 1 refusing the cycle and installs the rest; check exits 0', () => {
    const root = plainProject();
    symlinkCycle(root, AGENTS, 'two-node');
    const out = cli(['agents', 'install', '--target', 'agents-md', '--target', 'claude'], root);
    expect(out.code, out.stderr).toBe(1);
    expect(out.stderr).toMatch(/^agentboard: refused agents-md: .*ELOOP/m);
    expect(existsSync(join(root, SKILL))).toBe(true);
    const check = cli(['agents', 'check'], root);
    expect(check.code, check.stderr).toBe(0);
  });

  it('install exits 1, not 5, for a self-referential directory cycle', () => {
    const root = plainProject();
    symlinkCycle(root, AGENTS, 'self-dir');
    const out = cli(['agents', 'install', '--target', 'agents-md', '--json'], root);
    expect(out.code, out.stderr).toBe(1);
    expect(oneJson(out)).toMatchObject({
      refused: 1,
      targets: [{ target: 'agents-md', action: 'refused', refusal: 'not-a-file' }],
    });
  });
});
