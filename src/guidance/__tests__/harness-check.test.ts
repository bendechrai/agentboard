/**
 * `agents check` for the `cursor` and `copilot` targets and the shared
 * `AGENTS.md` block, the 24 KB warning, and 0.3.0 installs staying
 * `current` (board-agent-guidance: "Checking installed guidance",
 * "Antigravity rules stay within size limits", "Installing guidance into
 * a host project" scenario "Existing installs stay current"; design.md
 * decision 12 and "Rulings from task group 4 (test author)"). The global
 * files are checked in harness-global.test.ts.
 */

import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../../store/__tests__/helpers.js';
import { checkCommand, checkGuidance, type GuidanceCheckEntry } from '../check.js';
import { plainProject, repo, writeRel } from './guidance-helpers.js';
import {
  AGENTS,
  BLOCK_030,
  COPILOT,
  CURSOR_MCP,
  NPX_ENTRY,
  RULE,
  SKILL,
  SKILL_030,
  blockAt,
  expectedRule,
  installIn,
  local,
  mcpFile,
  scratchHome,
  type ScratchHome,
} from './harness-helpers.js';

const SIZE_WARNING = (n: number): string =>
  `AGENTS.md is ${String(n)} bytes; the Antigravity CLI reads at most 24 KB (24576 bytes) of a rules file, so it ignores the rest`;

function setup(): { root: string; scratch: ScratchHome } {
  return { root: plainProject(), scratch: scratchHome() };
}

function check(root: string, scratch: ScratchHome): GuidanceCheckEntry[] {
  return checkGuidance({ cwd: root, env: scratch.env });
}

function rows(root: string, scratch: ScratchHome): (string | number | null)[][] {
  return check(root, scratch).map((e) => [e.target, e.path, e.state, e.installedVersion]);
}

describe('existing installs stay current', () => {
  it('scenario: Existing installs stay current (0.3.0 skill and AGENTS.md block)', () => {
    const { root, scratch } = setup();
    writeRel(root, SKILL, SKILL_030);
    writeRel(root, AGENTS, `# Project\n\n${BLOCK_030}\n\nMore user text.\n`);
    expect(check(root, scratch)).toEqual([
      { target: 'claude', path: SKILL, state: 'current', installedVersion: 3, currentVersion: 3 },
      {
        target: 'agents-md',
        path: AGENTS,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
    const out = checkCommand(root, scratch.env);
    expect(out.exitCode ?? 0).toBe(0);
    expect(out.warnings ?? []).toEqual([]);
  });

  it('keeps a 0.3.0 install current after the new targets are added beside it', () => {
    const { root, scratch } = setup();
    writeRel(root, SKILL, SKILL_030);
    writeRel(root, AGENTS, `${BLOCK_030}\n`);
    installIn(root, scratch, { targets: ['codex', 'cursor', 'antigravity', 'copilot'] });
    expect(rows(root, scratch)).toEqual([
      ['claude', SKILL, 'current', 3],
      ['agents-md', AGENTS, 'current', 3],
      ['cursor', RULE, 'current', 3],
      ['cursor', CURSOR_MCP, 'current', null],
      ['copilot', COPILOT, 'current', 3],
    ]);
  });
});

describe('the shared AGENTS.md block', () => {
  it('is reported once, as agents-md, whichever target wrote it', () => {
    for (const target of ['codex', 'antigravity'] as const) {
      const { root, scratch } = setup();
      installIn(root, scratch, { targets: [target] });
      expect(rows(root, scratch)).toEqual([['agents-md', AGENTS, 'current', 3]]);
    }
  });
});

describe('cursor', () => {
  it('reports the rule and the MCP entry current, each with its own path', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['cursor'] });
    expect(check(root, scratch)).toEqual([
      { target: 'cursor', path: RULE, state: 'current', installedVersion: 3, currentVersion: 3 },
      {
        target: 'cursor',
        path: CURSOR_MCP,
        state: 'current',
        installedVersion: null,
        currentVersion: 3,
      },
    ]);
  });

  it('reports a rule of another version stale and a hand-edited rule modified', () => {
    const { root, scratch } = setup();
    writeRel(root, RULE, expectedRule(2));
    expect(rows(root, scratch)).toEqual([['cursor', RULE, 'stale', 2]]);
    writeRel(root, RULE, expectedRule(3).replace('Mutex tickets:', 'Locks:'));
    expect(rows(root, scratch)).toEqual([['cursor', RULE, 'modified', 3]]);
    const out = checkCommand(root, scratch.env);
    expect(out.exitCode).toBe(1);
  });

  it('reports a rule whose marker version cannot be read as modified, and a markerless rule not at all', () => {
    const { root, scratch } = setup();
    writeRel(
      root,
      RULE,
      expectedRule(3).replace(
        '<!-- agentboard-guidance: v3 -->',
        '<!-- agentboard-guidance: vX -->',
      ),
    );
    expect(rows(root, scratch)).toEqual([['cursor', RULE, 'modified', null]]);
    writeRel(root, RULE, '---\nalwaysApply: true\n---\nMy own rule.\n');
    expect(rows(root, scratch)).toEqual([]);
  });

  it('reports a managed MCP entry of either shape current, an unmanaged one modified, and no entry not at all', () => {
    const { root, scratch } = setup();
    writeRel(root, CURSOR_MCP, mcpFile(local('/opt/agentboard')));
    expect(rows(root, scratch)).toEqual([['cursor', CURSOR_MCP, 'current', null]]);
    writeRel(root, CURSOR_MCP, mcpFile(NPX_ENTRY));
    expect(rows(root, scratch)).toEqual([['cursor', CURSOR_MCP, 'current', null]]);
    writeRel(root, CURSOR_MCP, mcpFile({ ...NPX_ENTRY, env: { A: '1' } }));
    expect(rows(root, scratch)).toEqual([['cursor', CURSOR_MCP, 'modified', null]]);
    writeRel(root, CURSOR_MCP, '{"mcpServers": {"other": {"command": "x"}}}');
    expect(rows(root, scratch)).toEqual([]);
    writeRel(root, CURSOR_MCP, '{"mcpServers": {"agentboard": ');
    expect(rows(root, scratch)).toEqual([]);
  });

  it('never reads a .cursor linked outside the working tree', () => {
    const { root, scratch } = setup();
    const outside = tempDir();
    writeRel(outside, 'rules/agentboard.mdc', expectedRule(3));
    writeRel(outside, 'mcp.json', mcpFile());
    symlinkSync(outside, join(root, '.cursor'));
    expect(rows(root, scratch)).toEqual([]);
  });
});

describe('copilot', () => {
  it('reports the block current, stale, or modified like the AGENTS.md block', () => {
    const { root, scratch } = setup();
    writeRel(root, COPILOT, `# Mine\n\n${BLOCK_030}\n`);
    expect(rows(root, scratch)).toEqual([['copilot', COPILOT, 'current', 3]]);
    writeRel(root, COPILOT, `${blockAt(2)}\n`);
    expect(rows(root, scratch)).toEqual([['copilot', COPILOT, 'stale', 2]]);
    writeRel(root, COPILOT, `${BLOCK_030.replace('Mutex tickets:', 'Locks:')}\n`);
    expect(rows(root, scratch)).toEqual([['copilot', COPILOT, 'modified', 3]]);
    writeRel(root, COPILOT, `${BLOCK_030}\n<!-- agentboard:end -->\n`);
    expect(rows(root, scratch)).toEqual([['copilot', COPILOT, 'modified', 3]]);
    writeRel(root, COPILOT, '# Only mine\n');
    expect(rows(root, scratch)).toEqual([]);
  });
});

describe('the 24 KB warning', () => {
  /** An AGENTS.md of exactly `size` bytes holding the current block. */
  function agentsOfSize(root: string, size: number): void {
    const head = `${BLOCK_030}\n\n`;
    const filler = 'x'.repeat(size - head.length - 1);
    writeRel(root, AGENTS, `${head}${filler}\n`);
  }

  it('scenario: Oversized rules file warns (30 KB, current block, exit 0)', () => {
    const { root, scratch } = setup();
    agentsOfSize(root, 30 * 1024);
    const out = checkCommand(root, scratch.env);
    expect(out.exitCode ?? 0).toBe(0);
    expect(out.warnings).toEqual([SIZE_WARNING(30720)]);
    expect(out.json).toEqual([
      {
        target: 'agents-md',
        path: AGENTS,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
  });

  it('does not warn at exactly 24576 bytes, and warns at 24577', () => {
    const { root, scratch } = setup();
    agentsOfSize(root, 24576);
    expect(checkCommand(root, scratch.env).warnings ?? []).toEqual([]);
    agentsOfSize(root, 24577);
    expect(checkCommand(root, scratch.env).warnings).toEqual([SIZE_WARNING(24577)]);
  });

  it('comes last after the not-current warnings, and leaves the exit code at 1', () => {
    const { root, scratch } = setup();
    writeRel(root, AGENTS, `${blockAt(2)}\n${'y'.repeat(25_000)}\n`);
    const out = checkCommand(root, scratch.env);
    expect(out.exitCode).toBe(1);
    expect(out.warnings?.at(-1)).toMatch(
      /^AGENTS\.md is \d+ bytes; the Antigravity CLI reads at most 24 KB/,
    );
    expect(out.warnings).toHaveLength(2);
  });

  it('warns for a large AGENTS.md without an agentboard block too', () => {
    const { root, scratch } = setup();
    writeRel(root, AGENTS, `${'z'.repeat(30_000)}\n`);
    const out = checkCommand(root, scratch.env);
    expect(out.exitCode ?? 0).toBe(0);
    expect(out.warnings).toEqual([SIZE_WARNING(30001)]);
  });

  it('measures bytes, not characters', () => {
    const { root, scratch } = setup();
    writeRel(root, AGENTS, `${'é'.repeat(12_289)}\n`);
    expect(checkCommand(root, scratch.env).warnings).toEqual([SIZE_WARNING(24579)]);
  });

  it('does not warn for an AGENTS.md below the root, or one linked outside the tree', () => {
    const { root, scratch } = setup();
    writeRel(root, 'docs/AGENTS.md', 'x'.repeat(30_000));
    expect(checkCommand(root, scratch.env).warnings ?? []).toEqual([]);
    const outside = tempDir();
    writeRel(outside, 'AGENTS.md', 'x'.repeat(30_000));
    symlinkSync(join(outside, 'AGENTS.md'), join(root, AGENTS));
    expect(checkCommand(root, scratch.env).warnings ?? []).toEqual([]);
  });

  it('checks the working tree root from a subdirectory', () => {
    const root = repo();
    const scratch = scratchHome();
    agentsOfSize(root, 25_000);
    const sub = join(root, 'deep');
    mkdirSync(sub);
    expect(checkCommand(sub, scratch.env).warnings).toEqual([SIZE_WARNING(25_000)]);
  });
});
