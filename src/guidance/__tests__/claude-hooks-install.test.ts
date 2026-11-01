/**
 * `agents install --target claude-hooks` through the library
 * (board-harness-hooks "Hooks installed in Claude settings";
 * board-agent-guidance "Installing guidance into a host project",
 * "Installed guidance never clobbers user content"; design.md decisions
 * 4, 6 and 7 and "Rulings from task group 3 (test author)"): the fresh
 * install, idempotence, the strict switch, the `--command` executable,
 * the merge into a user's `.claude/settings.json` (keys, user hooks and
 * their order kept, no duplicates), every refusal and its `--force`, the
 * file handling (symbolic links, mode, atomic replacement, byte order
 * mark, line breaks, size) and that auto-detection never selects the
 * target. `agents check` for the target is in claude-hooks-check.test.ts
 * and the CLI surface in src/cli/__tests__/claude-hooks-cli.test.ts.
 *
 * Every expected settings object is written out by hand here, not built
 * with the rendering functions under test.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  detectTargets,
  installGuidance,
  renderInstall,
  type GuidanceTarget,
  type InstallOptions,
  type InstallResult,
  type TargetOutcome,
} from '../install.js';
import { renderSkill } from '../installed-text.js';
import {
  ENV,
  IS_ROOT,
  chmodForTest,
  fileList,
  plainProject,
  readRel,
  snapshot,
  writeRel,
} from './guidance-helpers.js';

const SETTINGS = '.claude/settings.json';
const LOCAL_SETTINGS = '.claude/settings.local.json';
const SKILL = '.claude/skills/agentboard/SKILL.md';
const MCP = '.mcp.json';
const NPX = 'npx -y @bendechrai/agentboard';
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const MARKER_AT_END = /# agentboard-hooks: v(0|[1-9]\d*)$/;

function install(cwd: string, extra: Omit<InstallOptions, 'cwd'> = {}): InstallResult {
  return installGuidance({ cwd, env: ENV, ...extra });
}

function outcome(result: InstallResult, target: GuidanceTarget): TargetOutcome {
  const found = result.targets.find((t) => t.target === target);
  if (found === undefined) {
    throw new Error(`no outcome for ${target}`);
  }
  return found;
}

/** The `claude-hooks` outcome of installing only that target. */
function hooks(cwd: string, extra: Omit<InstallOptions, 'cwd'> = {}): TargetOutcome {
  return outcome(install(cwd, { targets: ['claude-hooks'], ...extra }), 'claude-hooks');
}

interface Expect {
  readonly exe?: string;
  readonly strict?: boolean;
  readonly version?: number;
}

/** An agentboard hook command, written out by hand. */
function cmd(event: string, opts: Expect = {}): string {
  const strict = opts.strict === true ? ' --strict' : '';
  return `${opts.exe ?? NPX} hook ${event}${strict} # agentboard-hooks: v${String(opts.version ?? 3)}`;
}

/** The agentboard group under one key, written out by hand. */
function group(key: 'SessionStart' | 'Stop' | 'PreToolUse', opts: Expect = {}): object {
  const event = { SessionStart: 'session-start', Stop: 'stop', PreToolUse: 'pre-tool-use' }[key];
  const handler = { type: 'command', command: cmd(event, opts), timeout: 5 };
  return key === 'PreToolUse' ? { matcher: MATCHER, hooks: [handler] } : { hooks: [handler] };
}

/** The `hooks` object of a fresh install. */
function freshHooks(opts: Expect = {}): Record<string, object[]> {
  return {
    SessionStart: [group('SessionStart', opts)],
    Stop: [group('Stop', opts)],
    PreToolUse: [group('PreToolUse', opts)],
  };
}

/** JSON text as the installer serializes it. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function settingsOf(root: string): Record<string, unknown> {
  return JSON.parse(readRel(root, SETTINGS).replace(/^\uFEFF/, '')) as Record<string, unknown>;
}

/** Every handler command under every key of `hooks` that ends with a marker. */
function markedCommands(settings: Record<string, unknown>): string[] {
  const found: string[] = [];
  const hooksValue = settings.hooks;
  if (typeof hooksValue !== 'object' || hooksValue === null) {
    return found;
  }
  for (const groups of Object.values(hooksValue as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const g of groups as unknown[]) {
      const handlers = (g as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers)) {
        continue;
      }
      for (const h of handlers as unknown[]) {
        const command = (h as { command?: unknown } | null)?.command;
        if (typeof command === 'string' && MARKER_AT_END.test(command)) {
          found.push(command);
        }
      }
    }
  }
  return found;
}

/** The settings of a user who already has permissions, an env, a model and two hooks. */
const USER_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: { allow: ['Bash(npm run test:*)'], deny: ['Read(./.env)'] },
  env: { FOO: 'bar' },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-pre', timeout: 30 }] },
    ],
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }],
  },
  model: 'opus',
};

describe('claude-hooks: fresh install', () => {
  it('scenario: Fresh install is warn-only', () => {
    const root = plainProject();
    const out = hooks(root);
    expect(out).toMatchObject({
      target: 'claude-hooks',
      path: SETTINGS,
      reason: 'requested with --target',
      action: 'created',
      refusal: null,
      manual: [],
    });
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
    const commands = markedCommands(settingsOf(root));
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command).not.toContain('--strict');
      expect(command).toMatch(/ # agentboard-hooks: v3$/);
    }
    const all = settingsOf(root).hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    for (const groups of Object.values(all)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.timeout).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it('writes only .claude/settings.json, creating .claude, and no .mcp.json or local settings', () => {
    const root = plainProject();
    hooks(root);
    expect(fileList(root)).toEqual([SETTINGS]);
    expect(existsSync(join(root, MCP))).toBe(false);
    expect(existsSync(join(root, LOCAL_SETTINGS))).toBe(false);
  });

  it('reports the created target and the summary line', () => {
    const root = plainProject();
    const result = install(root, { targets: ['claude-hooks'] });
    expect(renderInstall(result)).toBe(
      [
        `created claude-hooks ${SETTINGS}`,
        `agents install: 1 created, 0 updated, 0 unchanged, 0 refused (guidance v3) in ${root}`,
        '',
      ].join('\n'),
    );
  });

  it('adds the hooks to an empty settings object', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{}\n');
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
  });

  it('records the guidance version installed in every marker', () => {
    const root = plainProject();
    hooks(root, { version: 2 });
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ version: 2 }) }));
  });
});

describe('claude-hooks: idempotent reinstall and the strict switch', () => {
  it('scenario: Idempotent', () => {
    const root = plainProject();
    hooks(root);
    const before = snapshot(root);
    const second = install(root, { targets: ['claude-hooks'] });
    expect(outcome(second, 'claude-hooks').action).toBe('unchanged');
    expect(renderInstall(second)).toContain(`unchanged claude-hooks ${SETTINGS} (up to date)\n`);
    expect(snapshot(root)).toEqual(before);
    expect(markedCommands(settingsOf(root))).toHaveLength(3);
  });

  it('scenario: Strict is opt-in', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json(USER_SETTINGS));
    hooks(root);
    const warn = readRel(root, SETTINGS);
    expect(hooks(root, { hooksStrict: true }).action).toBe('updated');
    const expected = warn
      .replace(' hook session-start #', ' hook session-start --strict #')
      .replace(' hook stop #', ' hook stop --strict #')
      .replace(' hook pre-tool-use #', ' hook pre-tool-use --strict #');
    expect(expected).not.toBe(warn);
    expect(readRel(root, SETTINGS)).toBe(expected);
    expect(markedCommands(settingsOf(root)).every((c) => c.includes(' --strict #'))).toBe(true);
  });

  it('switches a strict install back to warn mode without --force', () => {
    const root = plainProject();
    hooks(root, { hooksStrict: true });
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ strict: true }) }));
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
  });

  it('leaves a strict install unchanged when reinstalled strict', () => {
    const root = plainProject();
    hooks(root, { hooksStrict: true });
    const before = snapshot(root);
    expect(hooks(root, { hooksStrict: true }).action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('updates entries of another guidance version in place, without --force', () => {
    const root = plainProject();
    const user = { hooks: [{ type: 'command', command: 'echo mine' }] };
    writeRel(
      root,
      SETTINGS,
      json({
        hooks: {
          Stop: [user, group('Stop', { version: 2 }), user],
          SessionStart: [group('SessionStart', { version: 9 })],
          PreToolUse: [group('PreToolUse', { version: 2, strict: true })],
        },
      }),
    );
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(
      json({
        hooks: {
          Stop: [user, group('Stop'), user],
          SessionStart: [group('SessionStart')],
          PreToolUse: [group('PreToolUse')],
        },
      }),
    );
  });

  it('has no effect without claude-hooks: --hooks-strict changes no other target', () => {
    const plain = plainProject();
    const strict = plainProject();
    const a = install(plain, { targets: ['claude', 'mcp-json'] });
    const b = install(strict, { targets: ['claude', 'mcp-json'], hooksStrict: true });
    expect(b.targets.map((t) => [t.target, t.action, t.reason])).toEqual(
      a.targets.map((t) => [t.target, t.action, t.reason]),
    );
    expect(renderInstall(b).replace(strict, '<root>')).toBe(
      renderInstall(a).replace(plain, '<root>'),
    );
    expect(existsSync(join(strict, SETTINGS))).toBe(false);
    expect(readRel(strict, SKILL)).toBe(renderSkill());
  });
});

describe('claude-hooks: the --command executable', () => {
  it('scenario: Local executable', () => {
    const root = plainProject();
    const result = install(root, { targets: ['claude-hooks'], command: 'agentboard' });
    expect(outcome(result, 'claude-hooks').action).toBe('created');
    const commands = markedCommands(settingsOf(root));
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command.startsWith('agentboard hook ')).toBe(true);
    }
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ exe: 'agentboard' }) }));
  });

  it('selects mcp-json as well, with --command as the reason, and writes the local MCP entry', () => {
    const root = plainProject();
    const result = install(root, { targets: ['claude-hooks'], command: 'agentboard' });
    expect(COMMAND_REASON).toBe('requested with --command');
    expect(result.targets.map((t) => [t.target, t.reason, t.action])).toEqual([
      ['mcp-json', 'requested with --command', 'created'],
      ['claude-hooks', 'requested with --target', 'created'],
    ]);
    expect(renderInstall(result)).toContain('selected mcp-json: requested with --command\n');
    expect(JSON.parse(readRel(root, MCP))).toEqual({
      mcpServers: { agentboard: { command: 'agentboard', args: ['mcp'] } },
    });
  });

  it('writes a path with spaces as one quoted shell word, with no expansion', () => {
    const root = plainProject();
    hooks(root, { command: '/opt/My Tools/$HOME/agentboard' });
    expect(readRel(root, SETTINGS)).toBe(
      json({ hooks: freshHooks({ exe: "'/opt/My Tools/$HOME/agentboard'" }) }),
    );
  });

  it('keeps an installed local executable on a reinstall without --command', () => {
    const root = plainProject();
    hooks(root, { command: '/usr/local/bin/agentboard', hooksStrict: true });
    const before = snapshot(root);
    expect(hooks(root, { hooksStrict: true }).action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(
      json({ hooks: freshHooks({ exe: '/usr/local/bin/agentboard' }) }),
    );
  });

  it('keeps the executable of an older install when upgrading it', () => {
    const root = plainProject();
    hooks(root, { command: "/opt/it's/agentboard", version: 2 });
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(
      json({ hooks: freshHooks({ exe: "'/opt/it'\\''s/agentboard'" }) }),
    );
  });

  it('replaces the executable when --command names another, without --force', () => {
    const root = plainProject();
    hooks(root);
    expect(hooks(root, { command: 'agentboard' }).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ exe: 'agentboard' }) }));
    expect(hooks(root, { command: NPX }).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ exe: `'${NPX}'` }) }));
  });

  it('falls back to npx when the installed entries name different executables', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json({
        hooks: {
          SessionStart: [group('SessionStart', { exe: 'agentboard' })],
          Stop: [group('Stop', { exe: '/usr/bin/agentboard' })],
          PreToolUse: [group('PreToolUse', { exe: 'agentboard' })],
        },
      }),
    );
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
  });

  it('falls back to npx when an installed command was edited by hand', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json({
        hooks: {
          SessionStart: [group('SessionStart', { exe: 'agentboard' })],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'agentboard hook stop --as impl # agentboard-hooks: v3',
                  timeout: 5,
                },
              ],
            },
          ],
          PreToolUse: [group('PreToolUse', { exe: 'agentboard' })],
        },
      }),
    );
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
  });
});

describe('claude-hooks: user settings and hooks survive', () => {
  it('scenario: Existing settings and hooks survive', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json(USER_SETTINGS));
    expect(hooks(root).action).toBe('updated');
    const after = settingsOf(root);
    expect(Object.keys(after)).toEqual(['$schema', 'permissions', 'env', 'hooks', 'model']);
    expect(after).toEqual({
      ...USER_SETTINGS,
      hooks: {
        PreToolUse: [USER_SETTINGS.hooks.PreToolUse[0], group('PreToolUse')],
        PostToolUse: USER_SETTINGS.hooks.PostToolUse,
        SessionStart: [group('SessionStart')],
        Stop: [group('Stop')],
      },
    });
    expect(Object.keys(after.hooks as object)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'SessionStart',
      'Stop',
    ]);
    expect(markedCommands(after)).toHaveLength(3);
  });

  it('changes a file in the serializer format only by the added entries', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json(USER_SETTINGS));
    hooks(root);
    expect(readRel(root, SETTINGS)).toBe(
      json({
        ...USER_SETTINGS,
        hooks: {
          PreToolUse: [USER_SETTINGS.hooks.PreToolUse[0], group('PreToolUse')],
          PostToolUse: USER_SETTINGS.hooks.PostToolUse,
          SessionStart: [group('SessionStart')],
          Stop: [group('Stop')],
        },
      }),
    );
  });

  it('adds a missing hooks key as the last top-level key', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus', permissions: { allow: [] } }));
    hooks(root);
    const after = settingsOf(root);
    expect(Object.keys(after)).toEqual(['model', 'permissions', 'hooks']);
    expect(after.hooks).toEqual(freshHooks());
  });

  it('never inspects or changes other hook keys, whatever they hold', () => {
    const root = plainProject();
    const other = {
      PostToolUse: 'not a list',
      Notification: 42,
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
      SubagentStop: null,
    };
    writeRel(root, SETTINGS, json({ hooks: other }));
    expect(hooks(root).action).toBe('updated');
    expect(settingsOf(root)).toEqual({ hooks: { ...other, ...freshHooks() } });
    expect(hooks(root).action).toBe('unchanged');
  });

  it('keeps a user hook that looks like agentboard but has no marker, and adds its own entry', () => {
    const root = plainProject();
    const lookalikes = [
      { matcher: MATCHER, hooks: [{ type: 'command', command: `${NPX} hook pre-tool-use` }] },
      {
        matcher: MATCHER,
        hooks: [{ type: 'command', command: `${NPX} hook pre-tool-use #agentboard-hooks: v3` }],
      },
      {
        matcher: MATCHER,
        hooks: [{ type: 'command', command: `${NPX} hook pre-tool-use # agentboard-hooks: v3 ` }],
      },
      {
        matcher: MATCHER,
        hooks: [
          { type: 'command', command: `${NPX} hook pre-tool-use # agentboard-hooks: v3 && true` },
        ],
      },
    ];
    writeRel(root, SETTINGS, json({ hooks: { PreToolUse: lookalikes } }));
    hooks(root);
    expect(settingsOf(root)).toEqual({
      hooks: {
        PreToolUse: [...lookalikes, group('PreToolUse')],
        SessionStart: [group('SessionStart')],
        Stop: [group('Stop')],
      },
    });
    expect(hooks(root).action).toBe('unchanged');
  });

  it('keeps user groups and elements of any shape in the three arrays, in order', () => {
    const root = plainProject();
    const odd = [
      'a string',
      7,
      null,
      { hooks: 'not a list' },
      { matcher: 'Bash' },
      { hooks: [null, 'x', { type: 'command', command: 12 }] },
    ];
    writeRel(root, SETTINGS, json({ hooks: { Stop: odd } }));
    expect(hooks(root).action).toBe('updated');
    expect(settingsOf(root)).toEqual({
      hooks: {
        Stop: [...odd, group('Stop')],
        SessionStart: [group('SessionStart')],
        PreToolUse: [group('PreToolUse')],
      },
    });
  });

  it('adds no duplicate: extra agentboard entries go, the first position is kept', () => {
    const root = plainProject();
    const a = { hooks: [{ type: 'command', command: 'echo a' }] };
    const b = { hooks: [{ type: 'command', command: 'echo b' }] };
    writeRel(
      root,
      SETTINGS,
      json({
        hooks: {
          SessionStart: [a, group('SessionStart'), b, group('SessionStart')],
          Stop: [group('Stop', { version: 2 }), a, group('Stop'), b],
          PreToolUse: [group('PreToolUse'), group('PreToolUse')],
        },
      }),
    );
    expect(hooks(root).action).toBe('updated');
    expect(settingsOf(root)).toEqual({
      hooks: {
        SessionStart: [a, group('SessionStart'), b],
        Stop: [group('Stop'), a, b],
        PreToolUse: [group('PreToolUse')],
      },
    });
    expect(markedCommands(settingsOf(root))).toHaveLength(3);
  });

  it('keeps the user handlers of a group it shares with an agentboard handler', () => {
    const root = plainProject();
    const mine = { type: 'command', command: 'echo mine', timeout: 3 };
    const shared = {
      matcher: MATCHER,
      hooks: [mine, { type: 'command', command: cmd('pre-tool-use'), timeout: 5 }],
    };
    const before = { hooks: [{ type: 'command', command: 'echo first' }] };
    writeRel(root, SETTINGS, json({ hooks: { PreToolUse: [before, shared] } }));
    expect(hooks(root).action).toBe('updated');
    expect((settingsOf(root).hooks as Record<string, unknown>).PreToolUse).toEqual([
      before,
      { matcher: MATCHER, hooks: [mine] },
      group('PreToolUse'),
    ]);
    expect(hooks(root).action).toBe('unchanged');
  });

  it('keeps an odd key name such as __proto__ as an ordinary key', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      '{\n  "__proto__": {\n    "polluted": true\n  },\n  "model": "opus"\n}\n',
    );
    hooks(root);
    const text = readRel(root, SETTINGS);
    const after = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(['__proto__', 'model', 'hooks']);
    expect(Object.hasOwn(after, '__proto__')).toBe(true);
    expect(text).toContain('"__proto__": {\n    "polluted": true\n  }');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps non-ASCII values', () => {
    const root = plainProject();
    const user = { model: 'caf\u00e9', note: '\u{1F600} \u4e2d\u6587' };
    writeRel(root, SETTINGS, json(user));
    hooks(root);
    expect(settingsOf(root)).toEqual({ ...user, hooks: freshHooks() });
  });

  it('merges into a settings file of several megabytes, keeping every entry', () => {
    const root = plainProject();
    const allow = Array.from({ length: 120_000 }, (_, i) => `Bash(tool-${String(i)}:*)`);
    const user = { permissions: { allow }, model: 'opus' };
    writeRel(root, SETTINGS, json(user));
    expect(statSync(join(root, SETTINGS)).size).toBeGreaterThan(3_000_000);
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ ...user, hooks: freshHooks() }));
  }, 30_000);

  it('accepts a leading byte order mark and keeps it', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, `\uFEFF${json({ model: 'opus' })}`);
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(`\uFEFF${json({ model: 'opus', hooks: freshHooks() })}`);
    const before = snapshot(root);
    expect(hooks(root).action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('reads CRLF line breaks, writes LF when it rewrites, and leaves an up-to-date file alone', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus' }).replace(/\n/g, '\r\n'));
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ model: 'opus', hooks: freshHooks() }));
    const current = json({ model: 'opus', hooks: freshHooks() }).replace(/\n/g, '\r\n');
    writeRel(root, SETTINGS, current);
    const before = snapshot(root);
    expect(hooks(root).action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('leaves an up-to-date file in another formatting untouched', () => {
    const root = plainProject();
    const compact = `${JSON.stringify({ hooks: freshHooks(), model: 'opus' })}\n`;
    writeRel(root, SETTINGS, compact);
    const before = snapshot(root);
    expect(hooks(root).action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('never reads or writes .claude/settings.local.json', () => {
    const root = plainProject();
    writeRel(root, LOCAL_SETTINGS, '{ not json, and not ours');
    const local = snapshot(root).get(LOCAL_SETTINGS);
    expect(hooks(root).action).toBe('created');
    expect(snapshot(root).get(LOCAL_SETTINGS)).toEqual(local);
  });
});

describe('claude-hooks: refusals', () => {
  it.each([
    ['a trailing comma', '{\n  "model": "opus",\n}\n'],
    ['a comment', '{\n  // my settings\n  "model": "opus"\n}\n'],
    ['single quotes', "{'model': 'opus'}\n"],
    ['a truncated file', '{\n  "hooks": {\n    "Stop": [\n'],
    ['an empty file', ''],
    ['only whitespace', '  \n\n'],
    ['a top-level array', '[]\n'],
    ['a top-level null', 'null\n'],
    ['a top-level string', '"settings"\n'],
    ['a top-level number', '42\n'],
    ['a top-level boolean', 'true\n'],
  ])('refuses a settings file with %s as malformed-settings, leaving it unchanged', (_l, text) => {
    const root = plainProject();
    writeRel(root, SETTINGS, text);
    const before = snapshot(root);
    const result = install(root, { targets: ['claude', 'claude-hooks'] });
    const out = outcome(result, 'claude-hooks');
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('malformed-settings');
    expect(out.message).toContain(SETTINGS);
    expect(out.message).toContain('--force');
    expect(result.refused).toBe(1);
    expect(outcome(result, 'claude').action).toBe('created');
    expect(snapshot(root).get(SETTINGS)).toEqual(before.get(SETTINGS));
    expect(renderInstall(result)).toContain(`refused claude-hooks ${SETTINGS}: `);
  });

  it('with --force replaces an unparseable file by a fresh one', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{ "model": "opus", }');
    const out = hooks(root, { force: true });
    expect(out.action).toBe('updated');
    expect(out.refusal).toBeNull();
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
  });

  it.each([
    ['hooks is a list', { hooks: [] }],
    ['hooks is null', { hooks: null }],
    ['hooks is a string', { hooks: 'on' }],
    ['hooks is a number', { hooks: 1 }],
    ['Stop is an object', { hooks: { Stop: {} } }],
    ['PreToolUse is a string', { hooks: { PreToolUse: 'x' } }],
    ['SessionStart is null', { hooks: { SessionStart: null } }],
  ])('refuses settings where %s as hooks-shape, leaving them unchanged', (_label, value) => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus', ...value }));
    const before = snapshot(root);
    const out = hooks(root);
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('hooks-shape');
    expect(out.message).toContain(SETTINGS);
    expect(out.message).toContain('--force');
    expect(snapshot(root)).toEqual(before);
  });

  it('with --force replaces a hooks value of the wrong kind in place, keeping the other keys', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ permissions: { allow: [] }, hooks: 'on', model: 'opus' }));
    expect(hooks(root, { force: true }).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(
      json({ permissions: { allow: [] }, hooks: freshHooks(), model: 'opus' }),
    );
  });

  it('with --force replaces only the event values of the wrong kind', () => {
    const root = plainProject();
    const post = [{ hooks: [{ type: 'command', command: 'npm run lint' }] }];
    writeRel(root, SETTINGS, json({ hooks: { Stop: 'x', PostToolUse: post } }));
    expect(hooks(root, { force: true }).action).toBe('updated');
    const after = settingsOf(root);
    expect(after).toEqual({
      hooks: {
        Stop: [group('Stop')],
        PostToolUse: post,
        SessionStart: [group('SessionStart')],
        PreToolUse: [group('PreToolUse')],
      },
    });
    expect(Object.keys(after.hooks as object)).toEqual([
      'Stop',
      'PostToolUse',
      'SessionStart',
      'PreToolUse',
    ]);
  });

  it('repeats no file content in a refusal', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      writeRel(root, SETTINGS, `{"apiKeyHelper": ${JSON.stringify(f.value)}, "x": ${f.value}}`);
      const invalid = install(root, { targets: ['claude-hooks'] });
      expect(outcome(invalid, 'claude-hooks').refusal).toBe('malformed-settings');
      expectNoLeak(`malformed ${f.name}`, [invalid, renderInstall(invalid)], [f]);
      writeRel(root, SETTINGS, json({ hooks: f.value }));
      const shape = install(root, { targets: ['claude-hooks'] });
      expect(outcome(shape, 'claude-hooks').refusal).toBe('hooks-shape');
      expectNoLeak(`hooks-shape ${f.name}`, [shape, renderInstall(shape)], [f]);
    }
  });

  it('refuses a .claude directory that links outside the working tree, touching nothing there', () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'settings.json'), '{"model": "opus"}\n');
    const root = plainProject();
    symlinkSync(outside, join(root, '.claude'));
    const before = snapshot(outside);
    const out = hooks(root);
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('outside-tree');
    expect(snapshot(outside)).toEqual(before);
    expect(readdirSync(outside)).toEqual(['settings.json']);
  });

  it('refuses a settings file that links outside the working tree', () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'claude.json'), '{}\n');
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    symlinkSync(join(outside, 'claude.json'), join(root, SETTINGS));
    expect(hooks(root).refusal).toBe('outside-tree');
    expect(readFileSync(join(outside, 'claude.json'), 'utf8')).toBe('{}\n');
  });

  it('follows a settings file that links inside the tree and keeps the link', () => {
    const root = plainProject();
    writeRel(root, 'config/claude-settings.json', json({ model: 'opus' }));
    mkdirSync(join(root, '.claude'));
    symlinkSync('../config/claude-settings.json', join(root, SETTINGS));
    expect(hooks(root).action).toBe('updated');
    expect(lstatSync(join(root, SETTINGS)).isSymbolicLink()).toBe(true);
    expect(readRel(root, 'config/claude-settings.json')).toBe(
      json({ model: 'opus', hooks: freshHooks() }),
    );
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.json']);
    expect(readdirSync(join(root, 'config'))).toEqual(['claude-settings.json']);
  });

  it('refuses a directory at the settings path and a .claude that is a file', () => {
    const dir = plainProject();
    mkdirSync(join(dir, SETTINGS), { recursive: true });
    expect(hooks(dir).refusal).toBe('not-a-file');
    const file = plainProject();
    writeRel(file, '.claude', 'not a directory');
    expect(hooks(file).refusal).toBe('not-a-file');
    expect(readRel(file, '.claude')).toBe('not a directory');
  });

  it.skipIf(IS_ROOT)('refuses a read-only settings file it must change as unwritable', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus' }));
    chmodForTest(join(root, SETTINGS), 0o444);
    const before = snapshot(root);
    const out = hooks(root);
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('unwritable');
    expect(out.message).toContain(SETTINGS);
    expect(snapshot(root)).toEqual(before);
    expect(statSync(join(root, SETTINGS)).mode & 0o777).toBe(0o444);
  });

  it.skipIf(IS_ROOT)('leaves a read-only settings file that is up to date unchanged', () => {
    const root = plainProject();
    hooks(root);
    chmodForTest(join(root, SETTINGS), 0o444);
    expect(hooks(root).action).toBe('unchanged');
  });

  it.skipIf(IS_ROOT)(
    'refuses as unwritable when the replacement cannot be created beside the file',
    () => {
      const root = plainProject();
      writeRel(root, SETTINGS, json({ model: 'opus' }));
      // Not chmodForTest: the temporary directory is removed before its
      // restore runs, and a read-only directory that is not empty cannot be.
      chmodSync(join(root, '.claude'), 0o555);
      try {
        const before = snapshot(root);
        expect(hooks(root).refusal).toBe('unwritable');
        expect(snapshot(root)).toEqual(before);
      } finally {
        chmodSync(join(root, '.claude'), 0o755);
      }
    },
  );
});

describe('claude-hooks: the file is replaced atomically', () => {
  it('keeps the mode of the file it replaces', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus' }));
    chmodForTest(join(root, SETTINGS), 0o600);
    expect(hooks(root).action).toBe('updated');
    expect(statSync(join(root, SETTINGS)).mode & 0o777).toBe(0o600);
  });

  it('renames a new file into place and leaves no temporary file behind', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus' }));
    writeRel(root, '.claude/other.json', '{}\n');
    const inode = statSync(join(root, SETTINGS)).ino;
    expect(hooks(root).action).toBe('updated');
    expect(statSync(join(root, SETTINGS)).ino).not.toBe(inode);
    expect(readdirSync(join(root, '.claude')).sort()).toEqual(['other.json', 'settings.json']);
  });

  it('leaves no temporary file behind on a fresh install', () => {
    const root = plainProject();
    hooks(root);
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.json']);
  });
});

describe('claude-hooks is never auto-selected', () => {
  it('scenario: Hooks are opt-in', () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    const result = install(root);
    expect(result.targets.map((t) => t.target)).toEqual(['claude']);
    expect(existsSync(join(root, SETTINGS))).toBe(false);
    expect(renderInstall(result)).not.toContain('claude-hooks');
  });

  it('leaves an existing settings file untouched when auto-detecting', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json(USER_SETTINGS));
    const before = snapshot(root).get(SETTINGS);
    expect(install(root).targets.map((t) => t.target)).toEqual(['claude']);
    expect(snapshot(root).get(SETTINGS)).toEqual(before);
  });

  it('does not select an existing install of an older version either', () => {
    const root = plainProject();
    hooks(root, { version: 2 });
    const before = snapshot(root).get(SETTINGS);
    expect(install(root).targets.map((t) => t.target)).toEqual(['claude']);
    expect(snapshot(root).get(SETTINGS)).toEqual(before);
    expect(detectTargets(root).map((s) => s.target)).toEqual(['claude']);
  });

  it('selects only mcp-json for --command in a bare project', () => {
    const root = plainProject();
    const result = install(root, { command: 'agentboard' });
    expect(result.targets.map((t) => t.target)).toEqual(['mcp-json']);
    expect(existsSync(join(root, SETTINGS))).toBe(false);
  });

  it('lists claude-hooks among the targets when nothing is selected', () => {
    const err = expectBoardError(() => install(plainProject()), 1, 'no-targets');
    expect(err.message).toContain('claude-hooks');
  });
});

describe('--command usage errors name the flag given', () => {
  it.each([
    ['empty', ''],
    ['a line feed', 'agent\nboard'],
  ])('names --command for a value that is %s, never --mcp-command', (_label, value) => {
    const root = plainProject();
    const err = expectBoardError(
      () => install(root, { targets: ['claude-hooks'], command: value }),
      1,
      'usage',
    );
    expect(err.message).toContain('--command');
    expect(err.message).not.toContain('--mcp-command');
    expect(fileList(root)).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['a line feed', 'agent\nboard'],
  ])('names --mcp-command when the value came from it and is %s', (_label, value) => {
    const root = plainProject();
    const err = expectBoardError(
      () =>
        install(root, { targets: ['claude-hooks'], command: value, commandFlag: 'mcp-command' }),
      1,
      'usage',
    );
    expect(err.message).toContain('--mcp-command');
    expect(fileList(root)).toEqual([]);
  });

  it('repeats no part of a refused value', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      const err = expectBoardError(
        () => install(root, { targets: ['claude-hooks'], command: `${f.value}\n` }),
        1,
        'usage',
      );
      expectNoLeak(f.name, [err.message], [f]);
    }
  });
});

describe('every target installs at the current version', () => {
  it('scenario: New targets install at the current version (claude-hooks)', () => {
    const root = plainProject();
    hooks(root);
    for (const command of markedCommands(settingsOf(root))) {
      expect(command.endsWith('# agentboard-hooks: v3')).toBe(true);
    }
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([
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

describe('review round 1 of group 3 (R3, R4)', () => {
  it('keeps a mode the umask would change (0666) on the replaced file', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, json({ model: 'opus' }));
    chmodSync(join(root, SETTINGS), 0o666);
    expect(hooks(root).action).toBe('updated');
    expect(statSync(join(root, SETTINGS)).mode & 0o777).toBe(0o666);
  });

  it('keeps no executable when an installed command sits under the wrong key', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      json({
        hooks: {
          SessionStart: [group('SessionStart', { exe: 'agentboard' })],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: cmd('session-start', { exe: 'agentboard' }),
                  timeout: 5,
                },
              ],
            },
          ],
          PreToolUse: [group('PreToolUse', { exe: 'agentboard' })],
        },
      }),
    );
    expect(hooks(root).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
  });

  it('with --force keeps the byte order mark of an unparseable file it replaces', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '\uFEFF{ "model": "opus", }');
    expect(hooks(root, { force: true }).action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(`\uFEFF${json({ hooks: freshHooks() })}`);
  });

  it('keeps user hooks with the documented non-markers and adds its own entry', () => {
    const root = plainProject();
    const users = [
      `${NPX} hook stop #agentboard-hooks: v3`,
      `${NPX} hook stop # agentboard-hooks: 3`,
      `${NPX} hook stop #  agentboard-hooks: v3`,
    ].map((command) => ({ hooks: [{ type: 'command', command, timeout: 5 }] }));
    writeRel(root, SETTINGS, json({ hooks: { Stop: users } }));
    hooks(root);
    expect(settingsOf(root)).toEqual({
      hooks: {
        Stop: [...users, group('Stop')],
        SessionStart: [group('SessionStart')],
        PreToolUse: [group('PreToolUse')],
      },
    });
    expect(checkGuidance({ cwd: root, env: ENV }).map((e) => e.state)).toEqual(['current']);
  });

  it.each([
    ['command', '-rf', 'must not start with a hyphen'],
    ['command', '--strict', 'must not start with a hyphen'],
    ['mcp-command', '-x', 'must not start with a hyphen'],
    ['command', 'exec', 'must not be a shell special built-in; give the path of the executable'],
    ['command', 'eval', 'must not be a shell special built-in; give the path of the executable'],
    ['mcp-command', ':', 'must not be a shell special built-in; give the path of the executable'],
  ])('refuses --%s %j as usage naming the flag', (flag, value, why) => {
    const root = plainProject();
    const err = expectBoardError(
      () =>
        install(root, {
          targets: ['claude-hooks'],
          command: value,
          ...(flag === 'mcp-command' ? { commandFlag: 'mcp-command' as const } : {}),
        }),
      1,
      'usage',
    );
    expect(err.message).toBe(`--${flag} ${why}`);
    expect(fileList(root)).toEqual([]);
  });

  it.each([
    'break',
    ':',
    'continue',
    '.',
    'eval',
    'exec',
    'exit',
    'export',
    'readonly',
    'return',
    'set',
    'shift',
    'times',
    'trap',
    'unset',
  ])('refuses the special built-in %s, but accepts a path ending in it', (word) => {
    const root = plainProject();
    expectBoardError(() => install(root, { targets: ['claude-hooks'], command: word }), 1, 'usage');
    expect(fileList(root)).toEqual([]);
    expect(hooks(root, { command: `/usr/local/bin/${word}` }).action).toBe('created');
  });

  it('accepts values with = and reserved words, quoting them', () => {
    const root = plainProject();
    hooks(root, { command: 'FOO=bar' });
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ exe: "'FOO=bar'" }) }));
    hooks(root, { command: 'if' });
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks({ exe: "'if'" }) }));
  });
});
