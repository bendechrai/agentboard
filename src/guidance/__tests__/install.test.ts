/**
 * `agents install` through the library (board-agent-guidance: "Installing
 * guidance into a host project", "Installed guidance never clobbers user
 * content"; add-agent-guidance tasks 3.1 and 3.2): working tree root
 * resolution (outside git, a subdirectory, a linked worktree),
 * auto-detection, each target's fresh install, idempotent reinstall,
 * upgrade with surrounding user content kept byte for byte, every refusal
 * and its `--force` override, and refusals not stopping other targets.
 * The CLI surface (exit codes, stdout and stderr) is in
 * src/cli/__tests__/agents-cli.test.ts.
 *
 * `--mcp-command` (add-mcp-command tasks 1.1 and 1.2; board-agent-guidance:
 * "Managed MCP entry"): the flag selecting `mcp-json` next to explicit or
 * detected targets, usage errors, the local entry written as given, and the
 * reinstall rules for both managed shapes and for unrecognised entries.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { isScalar, isSeq, parse, parseDocument } from 'yaml';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { git } from '../../store/__tests__/helpers.js';
import { checkGuidance } from '../check.js';
import {
  GUIDANCE_TARGETS,
  INIT_SUGGESTION,
  TARGET_FILES,
  detectTargets,
  installGuidance,
  renderInstall,
  workingTreeRoot,
  type GuidanceTarget,
  type InstallOptions,
  type InstallResult,
  type TargetOutcome,
} from '../install.js';
import {
  GUIDANCE_VERSION,
  MCP_ENTRY,
  OPENSPEC_GUIDANCE,
  OPENSPEC_OPERATIONS,
  blockStart,
  manualOpenSpecLines,
  renderAgentsBlock,
  renderSkill,
} from '../installed-text.js';
import {
  ENV,
  IS_ROOT,
  OPENSPEC_FIXTURE,
  chmodForTest,
  commentLines,
  fileList,
  linkedWorktree,
  plainProject,
  prefixSibling,
  readRel,
  repo,
  snapshot,
  symlinkCycle,
  writeRel,
} from './guidance-helpers.js';

const SKILL = '.claude/skills/agentboard/SKILL.md';
const AGENTS = 'AGENTS.md';
const CONFIG = 'openspec/config.yaml';
const MCP = '.mcp.json';
const V = GUIDANCE_VERSION;

function install(cwd: string, extra: Omit<InstallOptions, 'cwd'> = {}): InstallResult {
  return installGuidance({ cwd, env: ENV, ...extra });
}

function only(cwd: string, target: GuidanceTarget, extra: Omit<InstallOptions, 'cwd'> = {}) {
  return outcome(install(cwd, { targets: [target], ...extra }), target);
}

function outcome(result: InstallResult, target: GuidanceTarget): TargetOutcome {
  const found = result.targets.find((t) => t.target === target);
  if (found === undefined) {
    throw new Error(`no outcome for ${target}`);
  }
  return found;
}

/** The `apply` and `archive` guidance lists of a config text. */
function guidanceOf(text: string): { apply: unknown; archive: unknown } {
  const doc = parse(text) as { operations?: Record<string, { guidance?: unknown } | undefined> };
  return {
    apply: doc.operations?.apply?.guidance,
    archive: doc.operations?.archive?.guidance,
  };
}

/** The trailing comments of the agentboard items under `operations.<op>.guidance`. */
function versionComments(text: string, op: string): string[] {
  const seq = parseDocument(text).getIn(['operations', op, 'guidance'], true);
  if (!isSeq(seq)) {
    throw new Error(`operations.${op}.guidance is not a list`);
  }
  return seq.items
    .filter((item) => isScalar(item) && String(item.value).startsWith('agentboard:'))
    .map((item) => (isScalar(item) ? (item.comment ?? '').trim() : ''));
}

function mcpFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe('workingTreeRoot', () => {
  it('is the current directory outside git', () => {
    const dir = plainProject();
    expect(workingTreeRoot(dir, ENV)).toBe(dir);
  });

  it('is the repository root from a subdirectory', () => {
    const root = repo();
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(workingTreeRoot(sub, ENV)).toBe(root);
  });

  it("is a linked worktree's own root, not the main checkout", () => {
    const { main, worktree } = linkedWorktree();
    const sub = join(worktree, 'src');
    mkdirSync(sub, { recursive: true });
    expect(workingTreeRoot(sub, ENV)).toBe(worktree);
    expect(workingTreeRoot(worktree, ENV)).not.toBe(main);
  });
});

describe('detectTargets', () => {
  it('selects nothing in an empty project', () => {
    expect(detectTargets(plainProject())).toEqual([]);
  });

  it('selects claude, agents-md and openspec from what exists, never mcp-json', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    writeRel(root, AGENTS, '# Agents\n');
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    writeRel(root, MCP, mcpFile({ mcpServers: {} }));
    expect(detectTargets(root)).toEqual([
      { target: 'claude', reason: '.claude/ exists' },
      { target: 'agents-md', reason: 'AGENTS.md exists' },
      { target: 'openspec', reason: 'openspec/config.yaml exists' },
    ]);
  });

  it('needs .claude to be a directory and openspec/config.yaml to exist', () => {
    const root = plainProject();
    writeRel(root, '.claude', 'not a directory');
    mkdirSync(join(root, 'openspec'));
    expect(detectTargets(root)).toEqual([]);
  });
});

describe('selection', () => {
  it('scenario: auto-detection installs claude and openspec, reporting each and why', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    const result = install(root);
    expect(result.autoDetected).toBe(true);
    expect(result.root).toBe(root);
    expect(result.version).toBe(V);
    expect(result.refused).toBe(0);
    expect(result.targets.map((t) => [t.target, t.reason, t.action])).toEqual([
      ['claude', '.claude/ exists', 'created'],
      ['openspec', 'openspec/config.yaml exists', 'updated'],
    ]);
    expect(existsSync(join(root, AGENTS))).toBe(false);
    expect(existsSync(join(root, MCP))).toBe(false);
    const text = renderInstall(result);
    expect(text).toContain('selected claude: .claude/ exists\n');
    expect(text).toContain('selected openspec: openspec/config.yaml exists\n');
    expect(text).not.toContain('selected agents-md');
    expect(text).not.toContain('selected mcp-json');
  });

  it('refuses with no-targets, listing every target, when nothing is detected', () => {
    const root = plainProject();
    const err = expectBoardError(() => install(root), 1, 'no-targets');
    for (const target of GUIDANCE_TARGETS) {
      expect(err.message).toContain(target);
    }
    expect(err.message).toContain('--target');
    expect(err.message).toContain(root);
    expect(fileList(root)).toEqual([]);
  });

  it('refuses an unknown target as a usage error before writing anything', () => {
    const root = plainProject();
    const err = expectBoardError(
      () => install(root, { targets: ['claude', 'cursor'] }),
      1,
      'usage',
    );
    expect(err.message).toContain('cursor');
    for (const target of GUIDANCE_TARGETS) {
      expect(err.message).toContain(target);
    }
    expect(fileList(root)).toEqual([]);
  });

  it('processes given targets once each, in canonical order, as requested', () => {
    const root = plainProject();
    const result = install(root, { targets: ['mcp-json', 'claude', 'mcp-json', 'agents-md'] });
    expect(result.autoDetected).toBe(false);
    expect(result.targets.map((t) => [t.target, t.path, t.reason, t.action])).toEqual([
      ['claude', SKILL, 'requested with --target', 'created'],
      ['agents-md', AGENTS, 'requested with --target', 'created'],
      ['mcp-json', MCP, 'requested with --target', 'created'],
    ]);
    expect(TARGET_FILES).toEqual({
      claude: SKILL,
      'agents-md': AGENTS,
      openspec: CONFIG,
      'mcp-json': MCP,
    });
  });

  it('writes nothing but the selected targets and runs no git command that changes state', () => {
    const root = repo();
    mkdirSync(join(root, '.claude'));
    writeRel(root, AGENTS, '# Agents\n');
    git(root, 'add', AGENTS);
    git(root, 'commit', '-q', '-m', 'agents');
    const head = git(root, 'rev-parse', 'HEAD');
    install(root);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    const status = git(root, 'status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((line) => line !== '');
    expect(status.sort()).toEqual([` M ${AGENTS}`, `?? ${SKILL}`].sort());
  });
});

describe('where files are written', () => {
  it('writes into the current directory outside git', () => {
    const dir = plainProject();
    expect(only(dir, 'agents-md').action).toBe('created');
    expect(readRel(dir, AGENTS)).toBe(`${renderAgentsBlock()}\n`);
  });

  it('writes at the repository root when run from a subdirectory', () => {
    const root = repo();
    const sub = join(root, 'pkg', 'x');
    mkdirSync(sub, { recursive: true });
    const result = install(sub, { targets: ['agents-md'] });
    expect(result.root).toBe(root);
    expect(existsSync(join(root, AGENTS))).toBe(true);
    expect(existsSync(join(sub, AGENTS))).toBe(false);
  });

  it("writes into a linked worktree's root, not the main checkout", () => {
    const { main, worktree } = linkedWorktree();
    mkdirSync(join(worktree, '.claude'));
    const sub = join(worktree, 'lib');
    mkdirSync(sub);
    const result = install(sub);
    expect(result.root).toBe(worktree);
    expect(readRel(worktree, SKILL)).toBe(renderSkill());
    expect(existsSync(join(main, SKILL))).toBe(false);
    expect(existsSync(join(main, '.claude'))).toBe(false);
  });
});

describe('target claude', () => {
  it('scenario: installs the skill with its frontmatter, the rules, the pointer and the marker', () => {
    const root = plainProject();
    const out = only(root, 'claude');
    expect(out).toMatchObject({
      target: 'claude',
      path: SKILL,
      action: 'created',
      refusal: null,
      manual: [],
    });
    const skill = readRel(root, SKILL);
    expect(skill).toBe(renderSkill());
    expect(skill.startsWith('---\nname: agentboard\n')).toBe(true);
    expect(skill).toContain('agentboard help agents');
    expect(skill).toContain(`<!-- agentboard-guidance: v${String(V)} -->`);
  });

  it('scenario: reinstall changes no byte and reports up to date', () => {
    const root = plainProject();
    only(root, 'claude');
    const before = snapshot(root);
    const result = install(root, { targets: ['claude'] });
    expect(outcome(result, 'claude').action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
    expect(renderInstall(result)).toContain(`unchanged claude ${SKILL} (up to date)`);
  });

  it('upgrades a skill installed by an older guidance version', () => {
    const root = plainProject();
    only(root, 'claude', { version: 1 });
    expect(only(root, 'claude', { version: 2 }).action).toBe('updated');
    expect(readRel(root, SKILL)).toBe(renderSkill(2));
  });

  it('rewrites a skill it owns that was edited by hand', () => {
    const root = plainProject();
    only(root, 'claude');
    writeRel(root, SKILL, readRel(root, SKILL).replace('Claim a ticket', 'Maybe claim a ticket'));
    expect(only(root, 'claude').action).toBe('updated');
    expect(readRel(root, SKILL)).toBe(renderSkill());
  });

  it('scenario: refuses a foreign SKILL.md, naming it and leaving it unchanged', () => {
    const root = plainProject();
    const foreign = '---\nname: agentboard\ndescription: mine\n---\nMy own skill.\n';
    writeRel(root, SKILL, foreign);
    const result = install(root, { targets: ['claude'] });
    const out = outcome(result, 'claude');
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('foreign-file');
    expect(out.message).toContain(SKILL);
    expect(out.message).toContain('--force');
    expect(result.refused).toBe(1);
    expect(readRel(root, SKILL)).toBe(foreign);
  });

  it('overwrites a foreign SKILL.md with --force', () => {
    const root = plainProject();
    writeRel(root, SKILL, 'mine\n');
    const out = only(root, 'claude', { force: true });
    expect(out).toMatchObject({ action: 'updated', refusal: null });
    expect(readRel(root, SKILL)).toBe(renderSkill());
  });
});

describe('target agents-md', () => {
  it('creates AGENTS.md holding only the block', () => {
    const root = plainProject();
    expect(only(root, 'agents-md').action).toBe('created');
    expect(readRel(root, AGENTS)).toBe(`${renderAgentsBlock()}\n`);
  });

  it.each([
    ['ending with a newline', '# Project\n\nOur rules.\n', '# Project\n\nOur rules.\n\n'],
    ['without a final newline', '# Project\n\nOur rules.', '# Project\n\nOur rules.\n\n'],
    ['empty', '', ''],
  ])('appends the block to an AGENTS.md %s', (_label, existing, kept) => {
    const root = plainProject();
    writeRel(root, AGENTS, existing);
    expect(only(root, 'agents-md').action).toBe('updated');
    expect(readRel(root, AGENTS)).toBe(`${kept}${renderAgentsBlock()}\n`);
  });

  it('scenario: upgrades the managed block and keeps the user text before and after byte for byte', () => {
    const root = plainProject();
    const before = '# Project agents\r\n\r\nUser text before, with trailing spaces.   \n\n';
    const after = '\n\n## Our own section\n\nUser text after.\n<!-- a user comment -->\n';
    writeRel(root, AGENTS, `${before}${renderAgentsBlock(1)}${after}`);
    expect(only(root, 'agents-md', { version: 2 }).action).toBe('updated');
    expect(readRel(root, AGENTS)).toBe(`${before}${renderAgentsBlock(2)}${after}`);
  });

  it('replaces whatever text lies between the markers', () => {
    const root = plainProject();
    const old = `${blockStart(V)}\nold guidance\n<!-- agentboard:end -->`;
    writeRel(root, AGENTS, `A\n${old}\nB\n`);
    expect(only(root, 'agents-md').action).toBe('updated');
    expect(readRel(root, AGENTS)).toBe(`A\n${renderAgentsBlock()}\nB\n`);
  });

  it('accepts markers indented or followed by a carriage return', () => {
    const root = plainProject();
    writeRel(
      root,
      AGENTS,
      `A\n  ${blockStart(V)}\r\nSTALE-GUIDANCE\n\t<!-- agentboard:end -->  \nB\n`,
    );
    expect(only(root, 'agents-md').action).toBe('updated');
    const text = readRel(root, AGENTS);
    expect(text.startsWith('A\n')).toBe(true);
    expect(text.endsWith('\nB\n')).toBe(true);
    expect(text).toContain(renderAgentsBlock());
    expect(text).not.toContain('STALE-GUIDANCE');
  });

  it('scenario: reinstall changes no byte and reports up to date', () => {
    const root = plainProject();
    writeRel(root, AGENTS, 'intro\n');
    only(root, 'agents-md');
    const before = snapshot(root);
    expect(only(root, 'agents-md').action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ['a start without an end', `x\n${blockStart(1)}\nguidance\n`],
    ['an end without a start', 'x\nguidance\n<!-- agentboard:end -->\n'],
    ['an end before the start', `<!-- agentboard:end -->\nx\n${blockStart(1)}\n`],
    [
      'two pairs',
      `${blockStart(1)}\na\n<!-- agentboard:end -->\n${blockStart(1)}\nb\n<!-- agentboard:end -->\n`,
    ],
    ['a start with no version', '<!-- agentboard:start -->\nx\n<!-- agentboard:end -->\n'],
    ['a start with a bad version', '<!-- agentboard:start vX -->\nx\n<!-- agentboard:end -->\n'],
    ['a marker inside a line', `See ${blockStart(1)} here\nx\n<!-- agentboard:end -->\n`],
  ])('refuses %s as a malformed marker pair, leaving the file unchanged', (_label, content) => {
    const root = plainProject();
    writeRel(root, AGENTS, content);
    const result = install(root, { targets: ['agents-md'] });
    const out = outcome(result, 'agents-md');
    expect(out).toMatchObject({ action: 'refused', refusal: 'malformed-marker' });
    expect(out.message).toContain(AGENTS);
    expect(result.refused).toBe(1);
    expect(readRel(root, AGENTS)).toBe(content);
  });

  it('with --force removes only the marker lines and appends a fresh block', () => {
    const root = plainProject();
    writeRel(root, AGENTS, `A\n${blockStart(1)}\nold\n`);
    expect(only(root, 'agents-md', { force: true }).action).toBe('updated');
    expect(readRel(root, AGENTS)).toBe(`A\nold\n\n${renderAgentsBlock()}\n`);
  });
});

describe('target openspec', () => {
  it('scenario: the OpenSpec-generated config keeps every comment line, in order', () => {
    const root = plainProject();
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    expect(only(root, 'openspec').action).toBe('updated');
    const text = readRel(root, CONFIG);
    expect(commentLines(text)).toEqual(commentLines(OPENSPEC_FIXTURE));
    expect(commentLines(OPENSPEC_FIXTURE).length).toBeGreaterThan(20);
    expect(text.split('\n')[0]).toBe('schema: spec-driven');
    expect(guidanceOf(text)).toEqual({
      apply: [...OPENSPEC_GUIDANCE.apply],
      archive: [...OPENSPEC_GUIDANCE.archive],
    });
    expect((parse(text) as { schema: string }).schema).toBe('spec-driven');
    for (const op of OPENSPEC_OPERATIONS) {
      expect(versionComments(text, op)).toEqual(
        OPENSPEC_GUIDANCE[op].map(() => `agentboard-guidance: v${String(V)}`),
      );
    }
  });

  it('writes one entry per line', () => {
    const root = plainProject();
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    only(root, 'openspec');
    const entryLines = readRel(root, CONFIG)
      .split('\n')
      .filter((line) => line.includes('agentboard: '));
    expect(entryLines).toHaveLength(
      OPENSPEC_GUIDANCE.apply.length + OPENSPEC_GUIDANCE.archive.length,
    );
    for (const line of entryLines) {
      expect(line.trimStart().startsWith('- '), line).toBe(true);
      expect(line.endsWith(`# agentboard-guidance: v${String(V)}`), line).toBe(true);
    }
  });

  it('scenario: reinstall is a no-op', () => {
    const root = plainProject();
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    only(root, 'openspec');
    const before = snapshot(root);
    expect(only(root, 'openspec').action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('keeps user guidance entries, their order and comments', () => {
    const root = plainProject();
    const config = [
      'schema: spec-driven',
      '# my operations',
      'operations:',
      '  apply:',
      '    # apply notes',
      '    guidance:',
      '      - Keep test summaries concise # mine',
      '      - Run make check',
      'context: |',
      '  Tech stack: TypeScript',
      '',
    ].join('\n');
    writeRel(root, CONFIG, config);
    expect(only(root, 'openspec').action).toBe('updated');
    const text = readRel(root, CONFIG);
    expect(commentLines(text)).toEqual(['# my operations', '# apply notes']);
    expect(text).toContain('# mine');
    expect(guidanceOf(text)).toEqual({
      apply: ['Keep test summaries concise', 'Run make check', ...OPENSPEC_GUIDANCE.apply],
      archive: [...OPENSPEC_GUIDANCE.archive],
    });
    expect((parse(text) as { context: string }).context).toBe('Tech stack: TypeScript\n');
  });

  it('carries a user comment above an old agentboard entry onto the new first entry', () => {
    const root = plainProject();
    const note = '# a note the user left about the old agentboard line';
    const config = [
      'schema: spec-driven',
      'operations:',
      '  apply:',
      '    guidance:',
      '      - first',
      `      ${note}`,
      '      - "agentboard: an old entry" # agentboard-guidance: v1',
      '      - last',
      '',
    ].join('\n');
    writeRel(root, CONFIG, config);
    expect(only(root, 'openspec', { version: 2 }).action).toBe('updated');
    const text = readRel(root, CONFIG);
    expect(commentLines(text)).toEqual([note]);
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.trim() === note);
    expect(lines[at - 1]?.trim()).toBe('- first');
    expect(lines[at + 1], 'the comment sits right above the new first entry').toContain(
      OPENSPEC_GUIDANCE.apply[0]?.slice(0, 40) ?? '',
    );
    expect(guidanceOf(text).apply).toEqual(['first', ...OPENSPEC_GUIDANCE.apply, 'last']);
  });

  it('replaces old agentboard entries where the first one was', () => {
    const root = plainProject();
    const config = [
      'schema: spec-driven',
      'operations:',
      '  apply:',
      '    guidance:',
      '      - first',
      '      - "agentboard: an old entry" # agentboard-guidance: v1',
      '      - last',
      '      - "agentboard: another old entry" # agentboard-guidance: v1',
      '',
    ].join('\n');
    writeRel(root, CONFIG, config);
    expect(only(root, 'openspec', { version: 2 }).action).toBe('updated');
    const text = readRel(root, CONFIG);
    expect(guidanceOf(text).apply).toEqual(['first', ...OPENSPEC_GUIDANCE.apply, 'last']);
    expect(versionComments(text, 'apply')).toEqual(
      OPENSPEC_GUIDANCE.apply.map(() => 'agentboard-guidance: v2'),
    );
  });

  it('upgrades the version comments of an older install', () => {
    const root = plainProject();
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    only(root, 'openspec', { version: 1 });
    expect(only(root, 'openspec', { version: 2 }).action).toBe('updated');
    const text = readRel(root, CONFIG);
    expect(versionComments(text, 'archive')).toEqual(
      OPENSPEC_GUIDANCE.archive.map(() => 'agentboard-guidance: v2'),
    );
    expect(commentLines(text)).toEqual(commentLines(OPENSPEC_FIXTURE));
  });

  it('treats an empty guidance key as absent', () => {
    const root = plainProject();
    writeRel(root, CONFIG, 'schema: spec-driven\noperations:\n  apply:\n    guidance:\n');
    expect(only(root, 'openspec').action).toBe('updated');
    expect(guidanceOf(readRel(root, CONFIG)).apply).toEqual([...OPENSPEC_GUIDANCE.apply]);
  });

  it.each([
    ['a scalar guidance', 'operations:\n  apply:\n    guidance: Keep it short\n'],
    ['a map guidance', 'operations:\n  archive:\n    guidance:\n      note: x\n'],
    ['a scalar operation', 'operations:\n  apply: be careful\n'],
    ['a list of operations', 'operations:\n  - apply\n'],
  ])('refuses %s with the lines to add by hand, leaving the file unchanged', (_label, config) => {
    const root = plainProject();
    const content = `schema: spec-driven\n${config}`;
    writeRel(root, CONFIG, content);
    const result = install(root, { targets: ['openspec'] });
    const out = outcome(result, 'openspec');
    expect(out).toMatchObject({ action: 'refused', refusal: 'not-a-list' });
    expect(out.manual).toEqual(manualOpenSpecLines());
    expect(out.message).toContain(CONFIG);
    expect(readRel(root, CONFIG)).toBe(content);
    const text = renderInstall(result);
    for (const line of manualOpenSpecLines()) {
      expect(text).toContain(`    ${line}\n`);
    }
  });

  it('with --force replaces a non-list guidance value with the agentboard entries', () => {
    const root = plainProject();
    writeRel(root, CONFIG, 'schema: spec-driven\noperations:\n  apply:\n    guidance: short\n');
    expect(only(root, 'openspec', { force: true }).action).toBe('updated');
    expect(guidanceOf(readRel(root, CONFIG))).toEqual({
      apply: [...OPENSPEC_GUIDANCE.apply],
      archive: [...OPENSPEC_GUIDANCE.archive],
    });
  });

  it.each([
    ['missing', null, 'missing-file'],
    ['unparseable', 'schema: [unclosed\n  - : :\n', 'malformed-file'],
    ['not a map at the top', '- a\n- b\n', 'malformed-file'],
  ])('refuses a %s config even with --force', (_label, content, refusal) => {
    const root = plainProject();
    if (content !== null) {
      writeRel(root, CONFIG, content);
    }
    const out = only(root, 'openspec', { force: true });
    expect(out).toMatchObject({ action: 'refused', refusal });
    expect(out.message).toContain(CONFIG);
    if (content === null) {
      expect(existsSync(join(root, CONFIG))).toBe(false);
      expect(out.message).toContain('openspec init');
    } else {
      expect(readRel(root, CONFIG)).toBe(content);
    }
  });
});

describe('target mcp-json', () => {
  it('creates .mcp.json with the agentboard server', () => {
    const root = plainProject();
    expect(only(root, 'mcp-json').action).toBe('created');
    expect(readRel(root, MCP)).toBe(mcpFile({ mcpServers: { agentboard: MCP_ENTRY } }));
  });

  it('adds the server after the existing ones, keeping every other key and value', () => {
    const root = plainProject();
    const original = {
      mcpServers: { other: { command: 'other-mcp', args: ['--x'], env: { A: '1' } } },
      extra: [1, 2, { b: true }],
    };
    writeRel(root, MCP, mcpFile(original));
    expect(only(root, 'mcp-json').action).toBe('updated');
    expect(readRel(root, MCP)).toBe(
      mcpFile({
        mcpServers: { ...original.mcpServers, agentboard: MCP_ENTRY },
        extra: original.extra,
      }),
    );
  });

  it('adds mcpServers as the last key when it is missing', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpFile({ other: 1 }));
    only(root, 'mcp-json');
    expect(readRel(root, MCP)).toBe(mcpFile({ other: 1, mcpServers: { agentboard: MCP_ENTRY } }));
  });

  it('reinstall is a no-op', () => {
    const root = plainProject();
    only(root, 'mcp-json');
    const before = snapshot(root);
    expect(only(root, 'mcp-json').action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses a differing agentboard entry without --force and replaces it in place with it', () => {
    const root = plainProject();
    const differing = {
      mcpServers: {
        agentboard: { command: 'npx', args: ['-y', '@bendechrai/agentboard', 'mcp', '--as', 'me'] },
        other: { command: 'o' },
      },
    };
    writeRel(root, MCP, mcpFile(differing));
    const refused = only(root, 'mcp-json');
    expect(refused).toMatchObject({ action: 'refused', refusal: 'entry-differs' });
    expect(refused.message).toContain(MCP);
    expect(readRel(root, MCP)).toBe(mcpFile(differing));
    expect(only(root, 'mcp-json', { force: true }).action).toBe('updated');
    expect(readRel(root, MCP)).toBe(
      mcpFile({ mcpServers: { agentboard: MCP_ENTRY, other: { command: 'o' } } }),
    );
  });

  it('treats an entry with an extra key as differing', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpFile({ mcpServers: { agentboard: { ...MCP_ENTRY, env: {} } } }));
    expect(only(root, 'mcp-json').refusal).toBe('entry-differs');
  });

  it.each([
    ['invalid JSON', '{ "mcpServers": '],
    ['a top-level array', '[]\n'],
    ['an mcpServers array', '{"mcpServers": []}\n'],
  ])('refuses %s even with --force', (_label, content) => {
    const root = plainProject();
    writeRel(root, MCP, content);
    const out = only(root, 'mcp-json', { force: true });
    expect(out).toMatchObject({ action: 'refused', refusal: 'malformed-file' });
    expect(out.message).toContain(MCP);
    expect(readRel(root, MCP)).toBe(content);
  });
});

describe('a refusal does not stop the other targets', () => {
  it('installs the others and counts the refusal', () => {
    const root = plainProject();
    writeRel(root, SKILL, 'my own skill\n');
    writeRel(root, AGENTS, '# Agents\n');
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    const result = install(root);
    expect(result.targets.map((t) => [t.target, t.action])).toEqual([
      ['claude', 'refused'],
      ['agents-md', 'updated'],
      ['openspec', 'updated'],
    ]);
    expect(result.refused).toBe(1);
    expect(readRel(root, SKILL)).toBe('my own skill\n');
    expect(readRel(root, AGENTS)).toBe(`# Agents\n\n${renderAgentsBlock()}\n`);
    const text = renderInstall(result);
    expect(text).toContain(`refused claude ${SKILL}: `);
    expect(text).toContain(`updated agents-md ${AGENTS}`);
    expect(text).toContain(
      `agents install: 0 created, 2 updated, 0 unchanged, 1 refused (guidance v${String(V)}) in ${root}\n`,
    );
  });

  it('with --force overrides every refusal that --force covers', () => {
    const root = plainProject();
    writeRel(root, SKILL, 'mine\n');
    writeRel(root, AGENTS, `${blockStart(1)}\n`);
    writeRel(root, CONFIG, 'schema: spec-driven\noperations:\n  apply:\n    guidance: x\n');
    writeRel(root, MCP, mcpFile({ mcpServers: { agentboard: { command: 'x' } } }));
    const result = install(root, { targets: [...GUIDANCE_TARGETS], force: true });
    expect(result.refused).toBe(0);
    expect(result.targets.map((t) => t.action)).toEqual([
      'updated',
      'updated',
      'updated',
      'updated',
    ]);
  });
});

describe('the init suggestion', () => {
  it('suggests agentboard agents install', () => {
    expect(INIT_SUGGESTION).toContain("'agentboard agents install'");
    expect(INIT_SUGGESTION).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('renderInstall', () => {
  it('reports created targets and the summary line', () => {
    const root = plainProject();
    writeFileSync(join(root, 'README'), 'x');
    const text = renderInstall(install(root, { targets: ['claude', 'mcp-json'] }));
    expect(text).toBe(
      [
        `created claude ${SKILL}`,
        `created mcp-json ${MCP}`,
        `agents install: 2 created, 0 updated, 0 unchanged, 0 refused (guidance v${String(V)}) in ${root}`,
        '',
      ].join('\n'),
    );
  });
});

describe('containment: nothing outside the working tree is touched', () => {
  it.each([
    ['claude', SKILL],
    ['agents-md', AGENTS],
    ['openspec', CONFIG],
    ['mcp-json', MCP],
  ] as const)(
    'refuses %s when its file is a symlink to a file outside the tree, even with --force',
    (target, rel) => {
      const root = plainProject();
      const outside = join(plainProject(), 'elsewhere.txt');
      writeFileSync(outside, 'outside content\n');
      mkdirSync(join(root, rel, '..'), { recursive: true });
      symlinkSync(outside, join(root, rel));
      for (const force of [false, true]) {
        const result = install(root, { targets: [target], force });
        const out = outcome(result, target);
        expect(out).toMatchObject({ action: 'refused', refusal: 'outside-tree' });
        expect(out.message).toContain(rel);
        expect(out.message).toContain(outside);
        expect(result.refused).toBe(1);
        expect(readRel(outside, '')).toBe('outside content\n');
        expect(lstatSync(join(root, rel)).isSymbolicLink()).toBe(true);
      }
    },
  );

  it('refuses when a parent directory is a symlink out of the tree, creating nothing there', () => {
    const root = plainProject();
    const outsideDir = plainProject();
    symlinkSync(outsideDir, join(root, '.claude'));
    const out = only(root, 'claude', { force: true });
    expect(out).toMatchObject({ action: 'refused', refusal: 'outside-tree' });
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  it('refuses a symlink whose target does not exist yet but lies outside the tree', () => {
    const root = plainProject();
    const outsideDir = plainProject();
    const dangling = join(outsideDir, 'AGENTS.md');
    symlinkSync(dangling, join(root, AGENTS));
    const out = only(root, 'agents-md');
    expect(out).toMatchObject({ action: 'refused', refusal: 'outside-tree' });
    expect(existsSync(dangling)).toBe(false);
  });

  it('follows a symlink that stays inside the tree and keeps the link', () => {
    const root = plainProject();
    writeRel(root, 'docs/AGENTS.md', '# Shared agents file\n');
    symlinkSync(join(root, 'docs', 'AGENTS.md'), join(root, AGENTS));
    expect(only(root, 'agents-md').action).toBe('updated');
    expect(lstatSync(join(root, AGENTS)).isSymbolicLink()).toBe(true);
    expect(readRel(root, 'docs/AGENTS.md')).toBe(
      `# Shared agents file\n\n${renderAgentsBlock()}\n`,
    );
    expect(only(root, 'agents-md').action).toBe('unchanged');
  });

  it('follows a relative symlinked directory inside the tree', () => {
    const root = plainProject();
    mkdirSync(join(root, 'config', 'claude'), { recursive: true });
    symlinkSync(join('config', 'claude'), join(root, '.claude'));
    expect(only(root, 'claude').action).toBe('created');
    expect(readRel(root, 'config/claude/skills/agentboard/SKILL.md')).toBe(renderSkill());
  });

  it('still processes the other targets after an outside-tree refusal', () => {
    const root = plainProject();
    const outside = join(plainProject(), 'x.json');
    writeFileSync(outside, '{}\n');
    symlinkSync(outside, join(root, MCP));
    const result = install(root, { targets: ['agents-md', 'mcp-json'] });
    expect(result.targets.map((t) => [t.target, t.action, t.refusal])).toEqual([
      ['agents-md', 'created', null],
      ['mcp-json', 'refused', 'outside-tree'],
    ]);
    expect(readRel(outside, '')).toBe('{}\n');
  });
});

describe('filesystem errors are refusals, not crashes', () => {
  it.each([
    ['claude', SKILL],
    ['agents-md', AGENTS],
    ['openspec', CONFIG],
    ['mcp-json', MCP],
  ] as const)(
    'refuses %s as not-a-file when a directory is at its path, even with --force',
    (target, rel) => {
      const root = plainProject();
      mkdirSync(join(root, rel), { recursive: true });
      for (const force of [false, true]) {
        const out = only(root, target, { force });
        expect(out).toMatchObject({ action: 'refused', refusal: 'not-a-file' });
        expect(out.message).toContain(rel);
      }
      expect(lstatSync(join(root, rel)).isDirectory()).toBe(true);
    },
  );

  it('refuses as not-a-file when a parent of the target is a file', () => {
    const root = plainProject();
    writeRel(root, '.claude/skills', 'a file where a directory belongs\n');
    const out = only(root, 'claude');
    expect(out).toMatchObject({ action: 'refused', refusal: 'not-a-file' });
    expect(readRel(root, '.claude/skills')).toBe('a file where a directory belongs\n');
  });

  it.skipIf(IS_ROOT)('refuses a read-only AGENTS.md as unwritable, even with --force', () => {
    const root = plainProject();
    writeRel(root, AGENTS, '# Ours\n');
    chmodForTest(join(root, AGENTS), 0o444);
    for (const force of [false, true]) {
      const out = only(root, 'agents-md', { force });
      expect(out).toMatchObject({ action: 'refused', refusal: 'unwritable' });
      expect(out.message).toContain(AGENTS);
      expect(out.message).toMatch(/EACCES|EPERM/);
    }
    expect(readRel(root, AGENTS)).toBe('# Ours\n');
  });

  it.skipIf(IS_ROOT)('refuses an unreadable file as unwritable', () => {
    const root = plainProject();
    writeRel(root, MCP, '{}\n');
    chmodForTest(join(root, MCP), 0o000);
    expect(only(root, 'mcp-json')).toMatchObject({ action: 'refused', refusal: 'unwritable' });
  });

  it.skipIf(IS_ROOT)('refuses as unwritable when a parent directory cannot be created', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    chmodForTest(join(root, '.claude'), 0o555);
    const out = only(root, 'claude');
    expect(out).toMatchObject({ action: 'refused', refusal: 'unwritable' });
    expect(existsSync(join(root, '.claude', 'skills'))).toBe(false);
  });

  it.skipIf(IS_ROOT)('does not refuse a read-only file that needs no write', () => {
    const root = plainProject();
    only(root, 'agents-md');
    chmodForTest(join(root, AGENTS), 0o444);
    expect(only(root, 'agents-md')).toMatchObject({ action: 'unchanged', refusal: null });
  });

  it.skipIf(IS_ROOT)('still processes the other targets and counts every refusal', () => {
    const root = plainProject();
    mkdirSync(join(root, SKILL), { recursive: true });
    writeRel(root, AGENTS, '# Ours\n');
    chmodForTest(join(root, AGENTS), 0o444);
    const result = install(root, { targets: ['claude', 'agents-md', 'mcp-json'] });
    expect(result.targets.map((t) => [t.target, t.action, t.refusal])).toEqual([
      ['claude', 'refused', 'not-a-file'],
      ['agents-md', 'refused', 'unwritable'],
      ['mcp-json', 'created', null],
    ]);
    expect(result.refused).toBe(2);
  });
});

describe('the containment boundary (round 3)', () => {
  it.each([
    ['claude', SKILL],
    ['agents-md', AGENTS],
    ['openspec', CONFIG],
    ['mcp-json', MCP],
  ] as const)(
    'refuses %s linked into a sibling whose path starts with the root path',
    (target, rel) => {
      const { root, sibling } = prefixSibling();
      const theirs = join(sibling, 'theirs.txt');
      writeFileSync(theirs, 'sibling content\n');
      mkdirSync(join(root, rel, '..'), { recursive: true });
      symlinkSync(theirs, join(root, rel));
      for (const force of [false, true]) {
        const out = only(root, target, { force });
        expect(out).toMatchObject({ action: 'refused', refusal: 'outside-tree' });
        expect(out.message).toContain(theirs);
      }
      expect(readRel(sibling, 'theirs.txt')).toBe('sibling content\n');
      expect(readdirSync(sibling)).toEqual(['theirs.txt']);
    },
  );

  it('refuses a parent directory linked into a prefix sibling, creating nothing there', () => {
    const { root, sibling } = prefixSibling();
    symlinkSync(sibling, join(root, '.claude'));
    expect(only(root, 'claude', { force: true })).toMatchObject({
      action: 'refused',
      refusal: 'outside-tree',
    });
    expect(readdirSync(sibling)).toEqual([]);
  });

  it('refuses a dangling link into a prefix sibling without creating it', () => {
    const { root, sibling } = prefixSibling();
    symlinkSync(join(sibling, 'AGENTS.md'), join(root, AGENTS));
    expect(only(root, 'agents-md')).toMatchObject({ action: 'refused', refusal: 'outside-tree' });
    expect(readdirSync(sibling)).toEqual([]);
  });

  it('refuses a target that resolves to the root itself as not-a-file, writing nothing', () => {
    const root = plainProject();
    symlinkSync('.', join(root, AGENTS));
    const before = fileList(root);
    for (const force of [false, true]) {
      expect(only(root, 'agents-md', { force })).toMatchObject({
        action: 'refused',
        refusal: 'not-a-file',
      });
    }
    expect(fileList(root)).toEqual(before);
    expect(lstatSync(join(root, AGENTS)).isSymbolicLink()).toBe(true);
  });
});

describe('symlink cycles are refused as not-a-file (round 3)', () => {
  it.each(['two-node', 'self-dir'] as const)(
    'refuses a %s cycle at AGENTS.md, naming ELOOP, even with --force',
    (kind) => {
      const root = plainProject();
      symlinkCycle(root, AGENTS, kind);
      for (const force of [false, true]) {
        const out = only(root, 'agents-md', { force });
        expect(out).toMatchObject({ action: 'refused', refusal: 'not-a-file' });
        expect(out.message).toContain(AGENTS);
        expect(out.message).toContain('ELOOP');
      }
      expect(lstatSync(join(root, AGENTS)).isSymbolicLink()).toBe(true);
    },
  );

  it('refuses a cycle above the target path', () => {
    const root = plainProject();
    symlinkSync('.claude-b', join(root, '.claude'));
    symlinkSync('.claude', join(root, '.claude-b'));
    const out = only(root, 'claude');
    expect(out).toMatchObject({ action: 'refused', refusal: 'not-a-file' });
    expect(out.message).toContain('ELOOP');
  });

  it('still processes the other targets and counts the refusal', () => {
    const root = plainProject();
    symlinkCycle(root, AGENTS, 'self-dir');
    symlinkCycle(root, MCP, 'two-node');
    const result = install(root, { targets: ['claude', 'agents-md', 'mcp-json'] });
    expect(result.targets.map((t) => [t.target, t.action, t.refusal])).toEqual([
      ['claude', 'created', null],
      ['agents-md', 'refused', 'not-a-file'],
      ['mcp-json', 'refused', 'not-a-file'],
    ]);
    expect(result.refused).toBe(2);
  });
});

/** The local managed entry `--mcp-command <command>` writes. */
function local(command: string): { command: string; args: string[] } {
  return { command, args: ['mcp'] };
}

/** `.mcp.json` text holding only `mcpServers.agentboard` = `entry`. */
function mcpWith(entry: unknown): string {
  return mcpFile({ mcpServers: { agentboard: entry } });
}

describe('--mcp-command: target selection (add-mcp-command 1.1)', () => {
  it('scenario: writes the local entry in a project with no .mcp.json and names --mcp-command as the reason', () => {
    const root = plainProject();
    const result = install(root, { mcpCommand: 'agentboard' });
    expect(result.autoDetected).toBe(true);
    expect(result.refused).toBe(0);
    expect(result.targets).toEqual([
      {
        target: 'mcp-json',
        path: MCP,
        reason: 'requested with --mcp-command',
        action: 'created',
        refusal: null,
        message: expect.any(String) as unknown,
        manual: [],
      },
    ]);
    expect(readRel(root, MCP)).toBe(mcpWith(local('agentboard')));
    expect(JSON.parse(readRel(root, MCP))).toEqual({
      mcpServers: { agentboard: { command: 'agentboard', args: ['mcp'] } },
    });
    expect(fileList(root)).toEqual([MCP]);
    const text = renderInstall(result);
    expect(text).toContain('selected mcp-json: requested with --mcp-command\n');
    expect(text).toContain(`created mcp-json ${MCP}\n`);
  });

  it('adds mcp-json to the auto-detected targets', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    const result = install(root, { mcpCommand: 'agentboard' });
    expect(result.autoDetected).toBe(true);
    expect(result.targets.map((t) => [t.target, t.reason, t.action])).toEqual([
      ['claude', '.claude/ exists', 'created'],
      ['openspec', 'openspec/config.yaml exists', 'updated'],
      ['mcp-json', 'requested with --mcp-command', 'created'],
    ]);
    expect(existsSync(join(root, AGENTS))).toBe(false);
    expect(readRel(root, MCP)).toBe(mcpWith(local('agentboard')));
    const text = renderInstall(result);
    expect(text).toContain('selected claude: .claude/ exists\n');
    expect(text).toContain('selected openspec: openspec/config.yaml exists\n');
    expect(text).toContain('selected mcp-json: requested with --mcp-command\n');
  });

  it('adds mcp-json to an explicit --target claude, selecting both', () => {
    const root = plainProject();
    const result = install(root, { targets: ['claude'], mcpCommand: 'agentboard' });
    expect(result.autoDetected).toBe(false);
    expect(result.targets.map((t) => [t.target, t.reason, t.action])).toEqual([
      ['claude', 'requested with --target', 'created'],
      ['mcp-json', 'requested with --mcp-command', 'created'],
    ]);
    expect(readRel(root, SKILL)).toBe(renderSkill());
    expect(readRel(root, MCP)).toBe(mcpWith(local('agentboard')));
    const text = renderInstall(result);
    expect(text).toContain('selected mcp-json: requested with --mcp-command\n');
    expect(text).not.toContain('selected claude');
    expect(text).toBe(
      [
        'selected mcp-json: requested with --mcp-command',
        `created claude ${SKILL}`,
        `created mcp-json ${MCP}`,
        `agents install: 2 created, 0 updated, 0 unchanged, 0 refused (guidance v${String(V)}) in ${root}`,
        '',
      ].join('\n'),
    );
  });

  it('processes mcp-json once when --target mcp-json is given too, naming --mcp-command', () => {
    const root = plainProject();
    const result = install(root, {
      targets: ['mcp-json', 'claude', 'mcp-json'],
      mcpCommand: 'agentboard',
    });
    expect(result.targets.map((t) => [t.target, t.reason])).toEqual([
      ['claude', 'requested with --target'],
      ['mcp-json', 'requested with --mcp-command'],
    ]);
    expect(readRel(root, MCP)).toBe(mcpWith(local('agentboard')));
  });

  it('leaves the output of runs without --mcp-command unchanged', () => {
    const root = plainProject();
    const result = install(root, { targets: ['mcp-json'] });
    expect(result.targets.map((t) => t.reason)).toEqual(['requested with --target']);
    expect(renderInstall(result)).not.toContain('selected');
    expect(readRel(root, MCP)).toBe(mcpWith(MCP_ENTRY));
  });

  it.each([
    ['empty', ''],
    ['a line feed inside', 'agent\nboard'],
    ['a trailing line feed', 'agentboard\n'],
    ['only a line feed', '\n'],
    ['a CRLF line break', 'agentboard\r\n'],
  ])('refuses a value that is %s as a usage error, writing nothing', (_label, value) => {
    const root = plainProject();
    const err = expectBoardError(() => install(root, { mcpCommand: value }), 1, 'usage');
    expect(err.message).toContain('--mcp-command');
    expect(fileList(root)).toEqual([]);
  });

  it('refuses a bad value before any target is written, also with targets detected or given', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    writeRel(root, AGENTS, '# Agents\n');
    writeRel(root, MCP, mcpWith(MCP_ENTRY));
    const before = snapshot(root);
    expectBoardError(() => install(root, { mcpCommand: '' }), 1, 'usage');
    expectBoardError(
      () => install(root, { targets: [...GUIDANCE_TARGETS], mcpCommand: 'a\nb', force: true }),
      1,
      'usage',
    );
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ['an absolute path', '/opt/agentboard/bin/agentboard'],
    ['a path with spaces', '/Users/me/My Tools/agent board/bin/agentboard'],
    ['a Windows path with spaces', 'C:\\Program Files\\agentboard\\agentboard.cmd'],
    ['a relative path', './node_modules/.bin/agentboard'],
    ['a value with surrounding spaces', ' agentboard '],
  ])('writes %s exactly as given', (_label, command) => {
    const root = plainProject();
    expect(only(root, 'mcp-json', { mcpCommand: command }).action).toBe('created');
    expect(readRel(root, MCP)).toBe(mcpWith(local(command)));
    const parsed = JSON.parse(readRel(root, MCP)) as {
      mcpServers: { agentboard: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.agentboard.command).toBe(command);
    expect(parsed.mcpServers.agentboard.args).toEqual(['mcp']);
  });

  it('adds the local entry after the existing servers, keeping every other key and value', () => {
    const root = plainProject();
    const original = {
      before: true,
      mcpServers: { other: { command: 'other-mcp', args: ['--x'], env: { A: '1' } } },
      after: [1, { b: null }],
    };
    writeRel(root, MCP, mcpFile(original));
    expect(only(root, 'mcp-json', { mcpCommand: 'agentboard' }).action).toBe('updated');
    expect(readRel(root, MCP)).toBe(
      mcpFile({
        before: true,
        mcpServers: { ...original.mcpServers, agentboard: local('agentboard') },
        after: original.after,
      }),
    );
  });

  it('does not change the other targets: the skill, block and entries are the same text', () => {
    const withFlag = plainProject();
    const without = plainProject();
    for (const root of [withFlag, without]) {
      writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    }
    install(withFlag, { targets: ['claude', 'agents-md', 'openspec'], mcpCommand: 'agentboard' });
    install(without, { targets: ['claude', 'agents-md', 'openspec'] });
    for (const rel of [SKILL, AGENTS, CONFIG]) {
      expect(readRel(withFlag, rel)).toBe(readRel(without, rel));
    }
  });
});

describe('--mcp-command: managed entries on reinstall (add-mcp-command 1.2)', () => {
  it('scenario: reinstall without --mcp-command keeps a local command, and check reports it current', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpWith(local('agentboard')));
    const before = snapshot(root);
    const out = only(root, 'mcp-json');
    expect(out).toMatchObject({ action: 'unchanged', refusal: null });
    expect(snapshot(root)).toEqual(before);
    expect(renderInstall(install(root, { targets: ['mcp-json'] }))).toContain(
      `unchanged mcp-json ${MCP} (up to date)\n`,
    );
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([
      { target: 'mcp-json', path: MCP, state: 'current', installedVersion: null, currentVersion: V },
    ]);
  });

  it('reinstall without --mcp-command keeps a local command whatever its executable', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpWith(local('/opt/My Tools/agentboard')));
    const before = snapshot(root);
    expect(only(root, 'mcp-json', { force: true }).action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('recognises a local entry whatever its key order and keeps its bytes', () => {
    const root = plainProject();
    const text = '{"mcpServers":{"agentboard":{"args":["mcp"],"command":"agentboard"}}}';
    writeRel(root, MCP, text);
    expect(only(root, 'mcp-json').action).toBe('unchanged');
    expect(only(root, 'mcp-json', { mcpCommand: 'agentboard' }).action).toBe('unchanged');
    expect(readRel(root, MCP)).toBe(text);
  });

  it('reinstall without --mcp-command keeps the npx entry', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpWith(MCP_ENTRY));
    const before = snapshot(root);
    expect(only(root, 'mcp-json').action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('leaves the file unchanged when --mcp-command names the executable already present', () => {
    const root = plainProject();
    const content = mcpFile({
      mcpServers: { other: { command: 'o' }, agentboard: local('agentboard') },
      z: 1,
    });
    writeRel(root, MCP, content);
    const before = snapshot(root);
    const result = install(root, { mcpCommand: 'agentboard' });
    expect(result.targets.map((t) => [t.target, t.action, t.refusal])).toEqual([
      ['mcp-json', 'unchanged', null],
    ]);
    expect(snapshot(root)).toEqual(before);
    expect(renderInstall(result)).toContain(`unchanged mcp-json ${MCP} (up to date)\n`);
  });

  it('scenario: switching from the npx entry to a local command updates it without --force', () => {
    const root = plainProject();
    writeRel(
      root,
      MCP,
      mcpFile({ mcpServers: { agentboard: MCP_ENTRY, other: { command: 'o' } }, z: [1] }),
    );
    const out = only(root, 'mcp-json', { mcpCommand: '/opt/agentboard/bin/agentboard' });
    expect(out).toMatchObject({ action: 'updated', refusal: null });
    expect(readRel(root, MCP)).toBe(
      mcpFile({
        mcpServers: {
          agentboard: { command: '/opt/agentboard/bin/agentboard', args: ['mcp'] },
          other: { command: 'o' },
        },
        z: [1],
      }),
    );
  });

  it('switches from one local command to another without --force, in place', () => {
    const root = plainProject();
    writeRel(
      root,
      MCP,
      mcpFile({ mcpServers: { first: { command: 'f' }, agentboard: local('agentboard') } }),
    );
    expect(only(root, 'mcp-json', { mcpCommand: '/usr/local/bin/agentboard' }).action).toBe(
      'updated',
    );
    expect(readRel(root, MCP)).toBe(
      mcpFile({
        mcpServers: { first: { command: 'f' }, agentboard: local('/usr/local/bin/agentboard') },
      }),
    );
  });

  it('replaces the npx entry when --mcp-command npx asks for npx mcp', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpWith(MCP_ENTRY));
    expect(only(root, 'mcp-json', { mcpCommand: 'npx' }).action).toBe('updated');
    expect(readRel(root, MCP)).toBe(mcpWith(local('npx')));
  });

  it('scenario: an entry with an extra key is still refused with --mcp-command, leaving the file unchanged', () => {
    const root = plainProject();
    const content = mcpWith({ command: 'agentboard', args: ['mcp'], env: { X: '1' } });
    writeRel(root, MCP, content);
    const result = install(root, { mcpCommand: 'agentboard' });
    expect(result.refused).toBe(1);
    const out = outcome(result, 'mcp-json');
    expect(out).toMatchObject({ action: 'refused', refusal: 'entry-differs' });
    expect(out.message).toContain(MCP);
    expect(out.message).toContain('--force');
    expect(readRel(root, MCP)).toBe(content);
  });

  it('with --force replaces an unrecognised entry by the requested local entry, in place', () => {
    const root = plainProject();
    writeRel(
      root,
      MCP,
      mcpFile({
        mcpServers: {
          agentboard: { command: 'agentboard', args: ['mcp'], env: { X: '1' } },
          other: { command: 'o' },
        },
      }),
    );
    expect(only(root, 'mcp-json', { mcpCommand: 'agentboard', force: true }).action).toBe(
      'updated',
    );
    expect(readRel(root, MCP)).toBe(
      mcpFile({ mcpServers: { agentboard: local('agentboard'), other: { command: 'o' } } }),
    );
  });

  it('with --force and no --mcp-command replaces an unrecognised entry by the npx entry', () => {
    const root = plainProject();
    writeRel(root, MCP, mcpWith({ command: 'agentboard', args: ['mcp', '--as', 'impl'] }));
    expect(only(root, 'mcp-json', { force: true }).action).toBe('updated');
    expect(readRel(root, MCP)).toBe(mcpWith(MCP_ENTRY));
  });

  it.each([
    ['an extra key', { command: 'agentboard', args: ['mcp'], env: {} }],
    ['other arguments', { command: 'agentboard', args: ['mcp', '--as', 'impl'] }],
    ['arguments before mcp', { command: 'agentboard', args: ['--verbose', 'mcp'] }],
    ['a differently cased argument', { command: 'agentboard', args: ['MCP'] }],
    ['no arguments', { command: 'agentboard', args: [] }],
    ['no args key', { command: 'agentboard' }],
    ['args as a string', { command: 'agentboard', args: 'mcp' }],
    ['an empty command', { command: '', args: ['mcp'] }],
    ['a non-string command', { command: 7, args: ['mcp'] }],
    ['no command key', { args: ['mcp'] }],
    ['the npx entry with --as', { command: 'npx', args: [...MCP_ENTRY.args, '--as', 'me'] }],
    ['the npx entry with an extra key', { ...MCP_ENTRY, cwd: '.' }],
    ['a string', 'agentboard mcp'],
    ['null', null],
    ['an array', ['agentboard', 'mcp']],
  ])('refuses an entry with %s as entry-differs, with or without --mcp-command', (_label, entry) => {
    const root = plainProject();
    const content = mcpWith(entry);
    writeRel(root, MCP, content);
    expect(only(root, 'mcp-json')).toMatchObject({ action: 'refused', refusal: 'entry-differs' });
    expect(only(root, 'mcp-json', { mcpCommand: 'agentboard' })).toMatchObject({
      action: 'refused',
      refusal: 'entry-differs',
    });
    expect(readRel(root, MCP)).toBe(content);
    expect(only(root, 'mcp-json', { mcpCommand: 'agentboard', force: true }).action).toBe(
      'updated',
    );
    expect(readRel(root, MCP)).toBe(mcpWith(local('agentboard')));
  });

  it('a refused entry does not stop the other targets selected with it', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    writeRel(root, MCP, mcpWith({ command: 'agentboard', args: ['mcp'], env: { X: '1' } }));
    const result = install(root, { mcpCommand: 'agentboard' });
    expect(result.targets.map((t) => [t.target, t.action])).toEqual([
      ['claude', 'created'],
      ['mcp-json', 'refused'],
    ]);
    expect(result.refused).toBe(1);
  });

  it('still refuses a malformed .mcp.json with --mcp-command, even with --force', () => {
    const root = plainProject();
    writeRel(root, MCP, '{"mcpServers": []}\n');
    expect(only(root, 'mcp-json', { mcpCommand: 'agentboard', force: true })).toMatchObject({
      action: 'refused',
      refusal: 'malformed-file',
    });
    expect(readRel(root, MCP)).toBe('{"mcpServers": []}\n');
  });
});
