/**
 * `agents check` through the library (board-agent-guidance: "Checking
 * installed guidance"; add-agent-guidance task 3.3): which targets are
 * found, the `current`, `stale` and `modified` states and installed
 * versions of each target, the command output with its exit code, and the
 * text rendering. Through the built CLI in
 * src/cli/__tests__/agents-cli.test.ts.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkCommand,
  checkGuidance,
  renderGuidanceCheck,
  type CheckOptions,
  type GuidanceCheckEntry,
} from '../check.js';
import { GUIDANCE_TARGETS, installGuidance, type GuidanceTarget } from '../install.js';
import {
  GUIDANCE_VERSION,
  MCP_ENTRY,
  renderAgentsBlock,
  renderSkill,
  skillMarker,
} from '../installed-text.js';
import {
  ENV,
  IS_ROOT,
  OPENSPEC_FIXTURE,
  chmodForTest,
  linkedWorktree,
  plainProject,
  prefixSibling,
  readRel,
  symlinkCycle,
  writeRel,
} from './guidance-helpers.js';

const SKILL = '.claude/skills/agentboard/SKILL.md';
const AGENTS = 'AGENTS.md';
const CONFIG = 'openspec/config.yaml';
const MCP = '.mcp.json';
const V = GUIDANCE_VERSION;

function check(cwd: string, extra: Omit<CheckOptions, 'cwd'> = {}): GuidanceCheckEntry[] {
  return checkGuidance({ cwd, env: ENV, ...extra });
}

function entry(entries: readonly GuidanceCheckEntry[], target: GuidanceTarget): GuidanceCheckEntry {
  const found = entries.find((e) => e.target === target);
  if (found === undefined) {
    throw new Error(`no entry for ${target}`);
  }
  return found;
}

/** A project with every target installed at guidance version `version`. */
function installedProject(version = V): string {
  const root = plainProject();
  writeRel(root, CONFIG, OPENSPEC_FIXTURE);
  installGuidance({ cwd: root, env: ENV, targets: [...GUIDANCE_TARGETS], version });
  return root;
}

function edit(root: string, rel: string, from: string, to: string): void {
  const text = readRel(root, rel);
  expect(text, `${rel} contains ${from}`).toContain(from);
  writeRel(root, rel, text.replace(from, to));
}

describe('what is found', () => {
  it('finds nothing in a project without guidance', () => {
    const root = plainProject();
    writeRel(root, AGENTS, '# Agents\n\nNo board here.\n');
    writeRel(root, CONFIG, OPENSPEC_FIXTURE);
    writeRel(root, MCP, `${JSON.stringify({ mcpServers: { other: { command: 'x' } } })}\n`);
    expect(check(root)).toEqual([]);
  });

  it('does not report a foreign SKILL.md', () => {
    const root = plainProject();
    writeRel(root, SKILL, '---\nname: agentboard\n---\nmine\n');
    expect(check(root)).toEqual([]);
  });

  it('reports every installed target as current, in target order, with its versions', () => {
    const root = installedProject();
    expect(check(root)).toEqual([
      { target: 'claude', path: SKILL, state: 'current', installedVersion: V, currentVersion: V },
      {
        target: 'agents-md',
        path: AGENTS,
        state: 'current',
        installedVersion: V,
        currentVersion: V,
      },
      {
        target: 'openspec',
        path: CONFIG,
        state: 'current',
        installedVersion: V,
        currentVersion: V,
      },
      {
        target: 'mcp-json',
        path: MCP,
        state: 'current',
        installedVersion: null,
        currentVersion: V,
      },
    ]);
  });

  it('checks the working tree root from a subdirectory of a linked worktree', () => {
    const { main, worktree } = linkedWorktree();
    installGuidance({ cwd: worktree, env: ENV, targets: ['agents-md'] });
    const sub = join(worktree, 'deep', 'er');
    mkdirSync(sub, { recursive: true });
    expect(check(sub).map((e) => [e.target, e.state])).toEqual([['agents-md', 'current']]);
    expect(check(main)).toEqual([]);
  });
});

describe('stale', () => {
  it('scenario: a skill installed with guidance version 1 is stale for a CLI at version 2', () => {
    const root = plainProject();
    installGuidance({ cwd: root, env: ENV, targets: ['claude'], version: 1 });
    expect(check(root, { version: 2 })).toEqual([
      { target: 'claude', path: SKILL, state: 'stale', installedVersion: 1, currentVersion: 2 },
    ]);
  });

  it('reports every versioned target stale after an upgrade, but not mcp-json', () => {
    const root = installedProject(1);
    expect(check(root, { version: 2 }).map((e) => [e.target, e.state, e.installedVersion])).toEqual(
      [
        ['claude', 'stale', 1],
        ['agents-md', 'stale', 1],
        ['openspec', 'stale', 1],
        ['mcp-json', 'current', null],
      ],
    );
  });

  it('reports guidance installed by a newer version as stale', () => {
    const root = installedProject(3);
    expect(entry(check(root, { version: 2 }), 'claude')).toMatchObject({
      state: 'stale',
      installedVersion: 3,
      currentVersion: 2,
    });
  });

  it('reports an older version stale even when its text was also edited', () => {
    const root = installedProject(1);
    edit(root, AGENTS, 'Rules you must never break', 'Rules');
    expect(entry(check(root, { version: 2 }), 'agents-md').state).toBe('stale');
  });
});

describe('modified', () => {
  it('reports a hand-edited skill as modified', () => {
    const root = installedProject();
    edit(root, SKILL, 'Claim a ticket', 'Perhaps claim a ticket');
    expect(entry(check(root), 'claude')).toMatchObject({ state: 'modified', installedVersion: V });
  });

  it('reports a skill whose marker version is unreadable as modified with no version', () => {
    const root = plainProject();
    writeRel(
      root,
      SKILL,
      renderSkill().replace(skillMarker(V), '<!-- agentboard-guidance: vX -->'),
    );
    expect(entry(check(root), 'claude')).toMatchObject({
      state: 'modified',
      installedVersion: null,
    });
  });

  it('reports an edit inside the AGENTS.md block as modified, but not one outside it', () => {
    const root = plainProject();
    writeRel(root, AGENTS, `# Ours\n\n${renderAgentsBlock()}\n\nMore of ours.\n`);
    expect(entry(check(root), 'agents-md').state).toBe('current');
    edit(root, AGENTS, 'More of ours.', 'Changed text of ours.');
    edit(root, AGENTS, '# Ours', '# Still ours');
    expect(entry(check(root), 'agents-md').state).toBe('current');
    edit(root, AGENTS, 'Rules you must never break', 'Rules we like');
    expect(entry(check(root), 'agents-md')).toMatchObject({
      state: 'modified',
      installedVersion: V,
    });
  });

  it.each([
    ['a start without an end', `${'<!-- agentboard:start v'}${String(V)} -->\nx\n`, V],
    ['an end without a start', 'x\n<!-- agentboard:end -->\n', null],
    ['a start with no version', '<!-- agentboard:start -->\nx\n<!-- agentboard:end -->\n', null],
  ])('reports malformed markers (%s) as modified', (_label, content, version) => {
    const root = plainProject();
    writeRel(root, AGENTS, content);
    expect(check(root)).toEqual([
      {
        target: 'agents-md',
        path: AGENTS,
        state: 'modified',
        installedVersion: version,
        currentVersion: V,
      },
    ]);
  });

  it('reports an edited OpenSpec entry as modified', () => {
    const root = installedProject();
    edit(root, CONFIG, 'claim its ticket', 'maybe claim its ticket');
    expect(entry(check(root), 'openspec')).toMatchObject({
      state: 'modified',
      installedVersion: V,
    });
  });

  it('reports a removed OpenSpec entry as modified', () => {
    const root = plainProject();
    const lines = [
      'schema: spec-driven',
      'operations:',
      '  apply:',
      '    guidance:',
      `      - "agentboard: only one entry" # agentboard-guidance: v${String(V)}`,
      '',
    ];
    writeRel(root, CONFIG, lines.join('\n'));
    expect(entry(check(root), 'openspec')).toMatchObject({
      state: 'modified',
      installedVersion: V,
    });
  });

  it('reports OpenSpec entries without a version comment as modified with no version', () => {
    const root = installedProject();
    edit(root, CONFIG, ` # agentboard-guidance: v${String(V)}`, '');
    expect(entry(check(root), 'openspec')).toMatchObject({
      state: 'modified',
      installedVersion: null,
    });
  });

  it('reports an unparseable config mentioning agentboard: as modified', () => {
    const root = plainProject();
    writeRel(root, CONFIG, 'operations: [\n  "agentboard: x"\n');
    expect(check(root)).toEqual([
      {
        target: 'openspec',
        path: CONFIG,
        state: 'modified',
        installedVersion: null,
        currentVersion: V,
      },
    ]);
  });

  it('reports a differing mcpServers.agentboard entry as modified', () => {
    const root = plainProject();
    writeRel(
      root,
      MCP,
      `${JSON.stringify({ mcpServers: { agentboard: { ...MCP_ENTRY, env: { A: '1' } } } })}\n`,
    );
    expect(check(root)).toEqual([
      {
        target: 'mcp-json',
        path: MCP,
        state: 'modified',
        installedVersion: null,
        currentVersion: V,
      },
    ]);
  });
});

describe('checkCommand', () => {
  it('exits 0 with the entries as its JSON document when every target is current', () => {
    const root = installedProject();
    const out = checkCommand(root, ENV);
    expect(out.exitCode ?? 0).toBe(0);
    expect(out.warnings ?? []).toEqual([]);
    expect(out.json).toEqual(check(root));
    expect(out.text).toBe(renderGuidanceCheck(check(root), root));
  });

  it('exits 0 when nothing is found', () => {
    const root = plainProject();
    const out = checkCommand(root, ENV);
    expect(out.exitCode ?? 0).toBe(0);
    expect(out.json).toEqual([]);
    expect(out.text).toBe(`no agentboard guidance found in ${root}\n`);
  });

  it('exits 1 with one warning when a target is not current, still reporting all', () => {
    const root = installedProject();
    edit(root, SKILL, 'Claim a ticket', 'Claim');
    const out = checkCommand(root, ENV);
    expect(out.exitCode).toBe(1);
    expect(out.json).toHaveLength(4);
    expect(out.warnings).toEqual([
      '1 of 4 guidance target(s) are not current; run agentboard agents install to rewrite them',
    ]);
  });
});

describe('renderGuidanceCheck', () => {
  it('prints one line per entry with its state and versions', () => {
    const entries: GuidanceCheckEntry[] = [
      { target: 'claude', path: SKILL, state: 'stale', installedVersion: 1, currentVersion: 2 },
      {
        target: 'mcp-json',
        path: MCP,
        state: 'current',
        installedVersion: null,
        currentVersion: 2,
      },
    ];
    expect(renderGuidanceCheck(entries, '/p')).toBe(
      [
        `stale claude ${SKILL} (installed v1, current v2)`,
        `current mcp-json ${MCP} (installed unknown, current v2)`,
        '',
      ].join('\n'),
    );
  });

  it('says so when nothing was found', () => {
    expect(renderGuidanceCheck([], '/p')).toBe('no agentboard guidance found in /p\n');
  });
});

describe('paths agents install would refuse', () => {
  it('does not read or report a target that is a symlink out of the tree', () => {
    const root = plainProject();
    const outside = join(plainProject(), 'AGENTS.md');
    writeFileSync(outside, `${renderAgentsBlock()}\n`);
    symlinkSync(outside, join(root, AGENTS));
    expect(check(root)).toEqual([]);
  });

  it('follows a symlink that stays inside the tree', () => {
    const root = plainProject();
    writeRel(root, 'docs/AGENTS.md', `${renderAgentsBlock()}\n`);
    symlinkSync(join(root, 'docs', 'AGENTS.md'), join(root, AGENTS));
    expect(check(root).map((e) => [e.target, e.state])).toEqual([['agents-md', 'current']]);
  });

  it('does not report a directory at a target path, and does not throw', () => {
    const root = plainProject();
    for (const rel of [SKILL, AGENTS, CONFIG, MCP]) {
      mkdirSync(join(root, rel), { recursive: true });
    }
    expect(check(root)).toEqual([]);
    expect(checkCommand(root, ENV).exitCode ?? 0).toBe(0);
  });

  it.skipIf(IS_ROOT)('reports an unreadable target as modified with a warning naming it', () => {
    const root = installedProject();
    chmodForTest(join(root, AGENTS), 0o000);
    expect(entry(check(root), 'agents-md')).toEqual({
      target: 'agents-md',
      path: AGENTS,
      state: 'modified',
      installedVersion: null,
      currentVersion: V,
    });
    const out = checkCommand(root, ENV);
    expect(out.exitCode).toBe(1);
    expect(out.warnings?.[0]).toMatch(
      /^cannot read AGENTS\.md \((EACCES|EPERM)\); reported as modified$/,
    );
    expect(out.warnings?.at(-1)).toBe(
      '1 of 4 guidance target(s) are not current; run agentboard agents install to rewrite them',
    );
  });
});

describe('the containment boundary and symlink cycles (round 3)', () => {
  it('does not read or report a file linked into a sibling whose path starts with the root path', () => {
    const { root, sibling } = prefixSibling();
    writeFileSync(join(sibling, 'AGENTS.md'), `${renderAgentsBlock()}\n`);
    symlinkSync(join(sibling, 'AGENTS.md'), join(root, AGENTS));
    expect(check(root)).toEqual([]);
  });

  it.each(['two-node', 'self-dir'] as const)(
    'reports nothing for a %s cycle and exits 0, never throwing',
    (kind) => {
      const root = plainProject();
      symlinkCycle(root, AGENTS, kind);
      expect(check(root)).toEqual([]);
      const out = checkCommand(root, ENV);
      expect(out.exitCode ?? 0).toBe(0);
      expect(out.json).toEqual([]);
    },
  );
});
