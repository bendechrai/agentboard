/**
 * `agents check` for the `claude-hooks` target (board-agent-guidance
 * "Checking installed guidance", scenarios "Hand-edited hook is
 * modified", "Missing hook is modified", "New targets install at the
 * current version", "Adding a target leaves the others current";
 * design.md decision 4 and "Rulings from task group 3 (test author)"):
 * what is found, `current` for every install `agents install` can write,
 * `stale`, and each way the owned entries can be `modified`.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCommand, checkGuidance, type GuidanceCheckEntry } from '../check.js';
import { installGuidance, type InstallOptions } from '../install.js';
import { ENV, IS_ROOT, chmodForTest, plainProject, readRel, writeRel } from './guidance-helpers.js';

const SETTINGS = '.claude/settings.json';
const NPX = 'npx -y @bendechrai/agentboard';
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

function check(cwd: string, version?: number): GuidanceCheckEntry[] {
  return checkGuidance({ cwd, env: ENV, ...(version === undefined ? {} : { version }) });
}

/** The `claude-hooks` entries of a check (none, or one). */
function hooksEntries(cwd: string, version?: number): GuidanceCheckEntry[] {
  return check(cwd, version).filter((e) => e.target === 'claude-hooks');
}

function stateOf(cwd: string): [string, number | null][] {
  return hooksEntries(cwd).map((e) => [e.state, e.installedVersion]);
}

function installHooks(cwd: string, extra: Omit<InstallOptions, 'cwd'> = {}): void {
  installGuidance({ cwd, env: ENV, targets: ['claude-hooks'], ...extra });
}

function cmd(event: string, exe = NPX, strict = false, version = 3): string {
  return `${exe} hook ${event}${strict ? ' --strict' : ''} # agentboard-hooks: v${String(version)}`;
}

function handler(command: string, timeout = 5): object {
  return { type: 'command', command, timeout };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Settings with the three groups given as their commands (null leaves the key out). */
function settingsWith(
  session: string | null,
  stop: string | null,
  pre: string | null,
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  if (session !== null) {
    hooks.SessionStart = [{ hooks: [handler(session)] }];
  }
  if (stop !== null) {
    hooks.Stop = [{ hooks: [handler(stop)] }];
  }
  if (pre !== null) {
    hooks.PreToolUse = [{ matcher: MATCHER, hooks: [handler(pre)] }];
  }
  return { hooks };
}

function edit(root: string, from: string, to: string): void {
  const text = readRel(root, SETTINGS);
  expect(text, `${SETTINGS} contains ${from}`).toContain(from);
  writeRel(root, SETTINGS, text.replace(from, to));
}

describe('what is found', () => {
  it('finds nothing without a settings file', () => {
    expect(hooksEntries(plainProject())).toEqual([]);
  });

  it('finds nothing in settings with only user hooks, including look-alikes without a marker', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json({
        permissions: { allow: [] },
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [handler('echo hi')] },
            { matcher: MATCHER, hooks: [handler(`${NPX} hook pre-tool-use`)] },
            {
              matcher: MATCHER,
              hooks: [handler(`${NPX} hook pre-tool-use # agentboard-hooks: v3 `)],
            },
          ],
        },
      }),
    );
    expect(hooksEntries(root)).toEqual([]);
    expect(checkCommand(root, ENV).exitCode).toBeUndefined();
  });

  it('finds nothing for a marked command under another key only', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ hooks: { PostToolUse: [{ hooks: [handler(cmd('stop'))] }] } }));
    expect(hooksEntries(root)).toEqual([]);
  });

  it('finds nothing in an unparseable file without the marker text', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{ "model": "opus", }');
    expect(hooksEntries(root)).toEqual([]);
  });

  it('reports an unparseable file holding the marker text as modified, version unknown', () => {
    const root = plainProject();
    installHooks(root);
    edit(root, '"hooks": {', '"hooks": {,');
    expect(hooksEntries(root)).toEqual([
      {
        target: 'claude-hooks',
        path: SETTINGS,
        state: 'modified',
        installedVersion: null,
        currentVersion: 3,
      },
    ]);
  });

  it('reports hooks of an unexpected shape holding the marker text as modified', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ hooks: { Stop: { hooks: [handler(cmd('stop'))] } } }));
    expect(stateOf(root)).toEqual([['modified', null]]);
  });
});

describe('current', () => {
  it.each([
    ['warn mode', {}],
    ['strict mode', { hooksStrict: true }],
    ['a local executable', { command: 'agentboard' }],
    [
      'a quoted executable, strict',
      { command: "/opt/My Tools/it's/agentboard", hooksStrict: true },
    ],
    ['the npx line given as one executable', { command: NPX }],
  ])('reports an install in %s current', (_label, extra: Omit<InstallOptions, 'cwd'>) => {
    const root = plainProject();
    installHooks(root, extra);
    expect(hooksEntries(root)).toEqual([
      {
        target: 'claude-hooks',
        path: SETTINGS,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
    expect(checkCommand(root, ENV).exitCode).toBeUndefined();
  });

  it('reports an install merged among user hooks and keys current', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json({
        model: 'opus',
        hooks: {
          Stop: [{ hooks: [handler('echo bye')] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [handler('echo pre')] }],
        },
      }),
    );
    installHooks(root);
    expect(stateOf(root)).toEqual([['current', 3]]);
  });

  it('reports a hand-written install in another formatting, key order and with a BOM current', () => {
    const root = plainProject();
    const reordered = {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ timeout: 5, command: cmd('pre-tool-use'), type: 'command' }],
            matcher: MATCHER,
          },
        ],
        Stop: [{ hooks: [handler(cmd('stop'))] }],
        SessionStart: [{ hooks: [handler(cmd('session-start'))] }],
      },
    };
    writeRel(root, SETTINGS, `\uFEFF${JSON.stringify(reordered)}`);
    expect(stateOf(root)).toEqual([['current', 3]]);
  });

  it('scenario: Adding a target leaves the others current (claude-hooks)', () => {
    const root = plainProject();
    installGuidance({ cwd: root, env: ENV, targets: ['claude', 'agents-md'] });
    const before = check(root);
    expect(before.map((e) => [e.target, e.state])).toEqual([
      ['claude', 'current'],
      ['agents-md', 'current'],
    ]);
    installHooks(root);
    expect(check(root)).toEqual([
      ...before,
      {
        target: 'claude-hooks',
        path: SETTINGS,
        state: 'current',
        installedVersion: 3,
        currentVersion: 3,
      },
    ]);
  });
});

describe('stale', () => {
  it('reports an install of guidance version 2 stale', () => {
    const root = plainProject();
    installHooks(root, { version: 2 });
    expect(hooksEntries(root)).toEqual([
      {
        target: 'claude-hooks',
        path: SETTINGS,
        state: 'stale',
        installedVersion: 2,
        currentVersion: 3,
      },
    ]);
    const out = checkCommand(root, ENV);
    expect(out.exitCode).toBe(1);
  });

  it('reports a current install stale for a newer CLI, whatever its mode and executable', () => {
    const root = plainProject();
    installHooks(root, { command: 'agentboard', hooksStrict: true });
    expect(
      hooksEntries(root, 4).map((e) => [e.state, e.installedVersion, e.currentVersion]),
    ).toEqual([['stale', 3, 4]]);
  });

  it('reports a hand-edited install of another version stale, not modified', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json(
        settingsWith(
          cmd('session-start', NPX, false, 1),
          null,
          cmd('pre-tool-use', 'x y', false, 1),
        ),
      ),
    );
    expect(stateOf(root)).toEqual([['stale', 1]]);
  });
});

describe('modified', () => {
  it('scenario: Hand-edited hook is modified', () => {
    const root = plainProject();
    installHooks(root);
    edit(root, ' hook stop #', ' hook stop --as impl #');
    expect(stateOf(root)).toEqual([['modified', 3]]);
    const out = checkCommand(root, ENV);
    expect(out.exitCode).toBe(1);
    expect(out.text).toBe(`modified claude-hooks ${SETTINGS} (installed v3, current v3)\n`);
  });

  it('scenario: Missing hook is modified', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json(settingsWith(cmd('session-start'), null, cmd('pre-tool-use'))));
    expect(stateOf(root)).toEqual([['modified', 3]]);
  });

  it('reports a missing entry modified when the key holds only user hooks', () => {
    const root = plainProject();
    installHooks(root);
    const settings = JSON.parse(readRel(root, SETTINGS)) as { hooks: Record<string, unknown> };
    settings.hooks.Stop = [{ hooks: [handler('echo mine')] }];
    writeRel(root, SETTINGS, json(settings));
    expect(stateOf(root)).toEqual([['modified', 3]]);
  });

  it.each([
    [
      'one executable edited',
      settingsWith(cmd('session-start'), cmd('stop', 'agentboard'), cmd('pre-tool-use')),
    ],
    [
      'mixed modes',
      settingsWith(cmd('session-start'), cmd('stop', NPX, true), cmd('pre-tool-use')),
    ],
    ['the events swapped', settingsWith(cmd('stop'), cmd('session-start'), cmd('pre-tool-use'))],
    [
      'an executable install could not write',
      settingsWith(
        cmd('session-start', 'bunx agentboard'),
        cmd('stop', 'bunx agentboard'),
        cmd('pre-tool-use', 'bunx agentboard'),
      ),
    ],
  ])('reports %s modified', (_label, settings) => {
    const root = plainProject();
    writeRel(root, SETTINGS, json(settings));
    expect(stateOf(root)).toEqual([['modified', 3]]);
  });

  it('reports mixed versions modified with the version unknown', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json(settingsWith(cmd('session-start'), cmd('stop', NPX, false, 2), cmd('pre-tool-use'))),
    );
    expect(stateOf(root)).toEqual([['modified', null]]);
  });

  it.each([
    [
      'a duplicated entry',
      (s: Hooks) => {
        const first = s.Stop[0];
        if (first !== undefined) {
          s.Stop.push(structuredClone(first));
        }
      },
    ],
    ['another timeout', (s: Hooks) => setHandler(s.Stop, 'timeout', 30)],
    ['a shorter timeout', (s: Hooks) => setHandler(s.SessionStart, 'timeout', 4)],
    ['another matcher', (s: Hooks) => setGroup(s.PreToolUse, 'matcher', 'Edit|Write')],
    ['a matcher on Stop', (s: Hooks) => setGroup(s.Stop, 'matcher', '*')],
    ['an extra handler key', (s: Hooks) => setHandler(s.PreToolUse, 'async', true)],
    ['an extra group key', (s: Hooks) => setGroup(s.SessionStart, 'note', 'x')],
    ['another handler type', (s: Hooks) => setHandler(s.Stop, 'type', 'prompt')],
    [
      'a user handler in an agentboard group',
      (s: Hooks) => {
        const first = s.PreToolUse[0];
        if (first !== undefined) {
          first.hooks.unshift({ type: 'command', command: 'echo mine' });
        }
      },
    ],
    [
      'a second agentboard handler in one group',
      (s: Hooks) => {
        const first = s.Stop[0];
        if (first !== undefined) {
          first.hooks.push({ type: 'command', command: cmd('stop'), timeout: 5 });
        }
      },
    ],
  ])('reports %s modified', (_label, change: (s: Hooks) => void) => {
    const root = plainProject();
    installHooks(root);
    const settings = JSON.parse(readRel(root, SETTINGS)) as { hooks: Hooks };
    change(settings.hooks);
    writeRel(root, SETTINGS, json(settings));
    expect(stateOf(root)).toEqual([['modified', 3]]);
  });

  it.skipIf(IS_ROOT)('reports an unreadable settings file modified with a warning', () => {
    const root = plainProject();
    installHooks(root);
    chmodForTest(join(root, SETTINGS), 0o000);
    expect(stateOf(root)).toEqual([['modified', null]]);
    const out = checkCommand(root, ENV);
    expect(out.exitCode).toBe(1);
    expect(out.warnings?.[0]).toBe(`cannot read ${SETTINGS} (EACCES); reported as modified`);
  });
});

interface Group {
  matcher?: string;
  hooks: Record<string, unknown>[];
  [key: string]: unknown;
}

type Hooks = Record<'SessionStart' | 'Stop' | 'PreToolUse', Group[]>;

function setHandler(groups: Group[], key: string, value: unknown): void {
  const h = groups[0]?.hooks[0];
  if (h !== undefined) {
    h[key] = value;
  }
}

function setGroup(groups: Group[], key: string, value: unknown): void {
  const g = groups[0];
  if (g !== undefined) {
    g[key] = value;
  }
}
