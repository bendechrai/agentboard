/**
 * The group 3 follow-ups (design.md "Rulings from the group 3 follow-ups",
 * F1-F5; board-agent-guidance "Installing guidance into a host project"
 * and "Installed guidance never clobbers user content"; board-harness-hooks
 * "Hooks installed in Claude settings"):
 * - F1: a `--command` value starting with `+` or `%` is a usage error;
 * - F2: a value equal to a regular built-in of sh, bash or zsh
 *   (`SHELL_BUILTINS`) is a usage error, while bash and zsh reserved words
 *   are quoted;
 * - F3: settings.json and `.mcp.json` nested more than 512 levels deep are
 *   refused like invalid JSON, never with an internal error (`jsonDepth`,
 *   `MAX_JSON_DEPTH`, `readUtf8Json`);
 * - F4: the scanner on escaped quotes and backslashes, and the array-index
 *   boundary at 4294967294;
 * - F5: the `lossy-json` message says what `--force` would discard.
 *
 * Expected strings and documents are written out by hand rather than
 * built with the functions under test.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { expectBoardError } from '../../board/__tests__/helpers.js';
import { checkGuidance } from '../check.js';
import {
  installGuidance,
  renderInstall,
  type GuidanceTarget,
  type InstallOptions,
  type InstallResult,
  type TargetOutcome,
} from '../install.js';
import {
  SHELL_BUILTINS,
  SHELL_RESERVED_WORDS,
  SHELL_SPECIAL_BUILTINS,
  hookExecutable,
} from '../installed-text.js';
import { MAX_JSON_DEPTH, jsonDepth, jsonRewriteIsLossless, readUtf8Json } from '../markers.js';
import { ENV, fileList, plainProject, readRel, snapshot, writeRel } from './guidance-helpers.js';

const SETTINGS = '.claude/settings.json';
const SKILL = '.claude/skills/agentboard/SKILL.md';
const MCP = '.mcp.json';
const NPX = 'npx -y @bendechrai/agentboard';
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

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

function run(
  root: string,
  target: GuidanceTarget,
  extra: Omit<InstallOptions, 'cwd'> = {},
): { out: TargetOutcome; text: string } {
  const result = install(root, { targets: [target], ...extra });
  return { out: outcome(result, target), text: renderInstall(result) };
}

function cmd(event: string, exe = NPX): string {
  return `${exe} hook ${event} # agentboard-hooks: v3`;
}

/** The `hooks` object of a fresh warn-mode install, written out by hand. */
function freshHooks(exe = NPX): Record<string, object[]> {
  return {
    SessionStart: [
      { hooks: [{ type: 'command', command: cmd('session-start', exe), timeout: 5 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: cmd('stop', exe), timeout: 5 }] }],
    PreToolUse: [
      {
        matcher: MATCHER,
        hooks: [{ type: 'command', command: cmd('pre-tool-use', exe), timeout: 5 }],
      },
    ],
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** `n` nested arrays: `[[...]]`, depth `n`. */
function arrays(n: number): string {
  return `${'['.repeat(n)}${']'.repeat(n)}`;
}

/** `n` nested objects: `{"a":{"a":...{}}}`, depth `n`. */
function objects(n: number): string {
  return `${'{"a":'.repeat(n - 1)}{}${'}'.repeat(n - 1)}`;
}

/** A settings file of depth exactly `depth` (>= 2): the top-level object holding nested arrays. */
function settingsOfDepth(depth: number, extra = ''): string {
  return `{${extra}"deep": ${arrays(depth - 1)}}\n`;
}

const DEPTH_TEXT = 'nested at most 512 levels deep';

function refuses(command: string, flag: 'command' | 'mcp-command', why: string): void {
  const root = plainProject();
  const err = expectBoardError(
    () =>
      install(root, {
        targets: ['claude-hooks'],
        command,
        ...(flag === 'mcp-command' ? { commandFlag: 'mcp-command' as const } : {}),
      }),
    1,
    'usage',
  );
  expect(err.message).toBe(`--${flag} ${why}`);
  expect(fileList(root)).toEqual([]);
}

describe('F1: a --command value starting with + or %', () => {
  it.each([
    ['command', '+x', 'must not start with a plus sign'],
    ['command', '+', 'must not start with a plus sign'],
    ['command', '+/usr/bin/agentboard', 'must not start with a plus sign'],
    ['mcp-command', '+o', 'must not start with a plus sign'],
    ['command', '%x', 'must not start with a percent sign'],
    ['command', '%1', 'must not start with a percent sign'],
    ['command', '%', 'must not start with a percent sign'],
    ['command', '%/opt/agentboard', 'must not start with a percent sign'],
    ['mcp-command', '%+', 'must not start with a percent sign'],
  ])('refuses --%s %j as usage naming the flag, writing nothing', (flag, value, why) => {
    refuses(value, flag as 'command' | 'mcp-command', why);
  });

  it('checks the hyphen before the plus and percent signs', () => {
    refuses('-+%', 'command', 'must not start with a hyphen');
  });

  it('refuses a value with a leading + or % whichever targets are selected', () => {
    for (const value of ['+x', '%x']) {
      const root = plainProject();
      expectBoardError(
        () => install(root, { targets: ['claude', 'mcp-json'], command: value }),
        1,
        'usage',
      );
      expect(fileList(root)).toEqual([]);
    }
  });

  it.each([
    ['a plus sign inside', 'agent+board'],
    ['a percent sign inside', 'agent%board'],
    ['both at the end', '/opt/bin/agentboard+%'],
  ])('accepts a value with %s, writing it as given', (_label, value) => {
    const root = plainProject();
    expect(run(root, 'claude-hooks', { command: value }).out.action).toBe('created');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks(value) }));
  });

  it('repeats no part of the refused value', () => {
    for (const f of TOKEN_FIXTURES.slice(0, 3)) {
      for (const lead of ['+', '%']) {
        const root = plainProject();
        const err = expectBoardError(
          () => install(root, { targets: ['claude-hooks'], command: `${lead}${f.value}` }),
          1,
          'usage',
        );
        expectNoLeak(f.name, [err.message], [f]);
      }
    }
  });

  it.each([
    ['+x', "'+x'"],
    ['+', "'+'"],
    ['%x', "'%x'"],
    ['%', "'%'"],
  ])('hookExecutable single-quotes %j', (value, expected) => {
    expect(hookExecutable(value)).toBe(expected);
  });
});

describe('F2: bare names of shell built-ins', () => {
  it('pins the regular built-ins, disjoint from the special built-ins and reserved words', () => {
    expect(SHELL_BUILTINS).toHaveLength(96);
    expect(SHELL_BUILTINS[0]).toBe('[');
    const rest = SHELL_BUILTINS.slice(1);
    expect(rest).toEqual([...rest].sort());
    expect(new Set(SHELL_BUILTINS).size).toBe(SHELL_BUILTINS.length);
    for (const name of SHELL_BUILTINS) {
      expect(SHELL_SPECIAL_BUILTINS, name).not.toContain(name);
      expect(SHELL_RESERVED_WORDS, name).not.toContain(name);
    }
    for (const name of [
      'echo',
      'test',
      '[',
      'true',
      'false',
      'cd',
      'printf',
      'command',
      'type',
      'kill',
      'alias',
      'unalias',
      'local',
      'read',
      'wait',
      'umask',
      'ulimit',
      'getopts',
      'hash',
      'jobs',
      'fg',
      'bg',
      'pwd',
      'source',
      'declare',
      'typeset',
      'let',
      'enable',
      'builtin',
      'noglob',
    ]) {
      expect(SHELL_BUILTINS, name).toContain(name);
    }
    for (const name of ['agentboard', 'npx', 'node', 'sh', 'bash', 'zsh', 'env']) {
      expect(SHELL_BUILTINS, name).not.toContain(name);
    }
  });

  it.each(SHELL_BUILTINS)('refuses the built-in %j, but accepts a path ending in it', (name) => {
    refuses(name, 'command', 'must not be a shell built-in; give the path of the executable');
    const root = plainProject();
    const path = `/usr/local/bin/${name}`;
    expect(run(root, 'claude-hooks', { command: path }).out.action).toBe('created');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks(hookExecutable(path)) }));
  });

  it.each([
    ['command', 'echo'],
    ['mcp-command', 'test'],
    ['mcp-command', '['],
  ])('names --%s in the refusal of %j', (flag, name) => {
    refuses(
      name,
      flag as 'command' | 'mcp-command',
      'must not be a shell built-in; give the path of the executable',
    );
  });

  it('keeps the special built-in message for the special built-ins', () => {
    refuses(
      'exec',
      'command',
      'must not be a shell special built-in; give the path of the executable',
    );
  });

  it('refuses a built-in also for the mcp-json target alone', () => {
    const root = plainProject();
    expectBoardError(() => install(root, { targets: ['mcp-json'], command: 'echo' }), 1, 'usage');
    expect(fileList(root)).toEqual([]);
  });

  it.each(['agentboard', 'npx', 'node', 'agentboard-dev', 'ab', 'Echo', 'echo2', 'tests'])(
    'accepts the ordinary name %j',
    (name) => {
      const root = plainProject();
      expect(run(root, 'claude-hooks', { command: name }).out.action).toBe('created');
      expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks(name) }));
    },
  );

  it.each(['coproc', 'end', 'foreach', 'nocorrect', 'repeat'])(
    'quotes the bash or zsh reserved word %j rather than refusing it',
    (word) => {
      expect(SHELL_RESERVED_WORDS).toContain(word);
      expect(hookExecutable(word)).toBe(`'${word}'`);
      const root = plainProject();
      expect(run(root, 'claude-hooks', { command: word }).out.action).toBe('created');
      expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks(`'${word}'`) }));
    },
  );

  const BASH = existsSync('/bin/bash') ? '/bin/bash' : null;
  const ZSH = ['/usr/bin/zsh', '/bin/zsh'].find((p) => existsSync(p)) ?? null;

  /**
   * The built-in names a shell reports, one per line of `script`'s output,
   * less those starting with `-` (zsh's `-` precommand modifier), which
   * the hyphen check refuses already.
   */
  function shellList(shell: string, script: string): string[] {
    const out = spawnSync(shell, ['-c', script], { encoding: 'utf8', timeout: 10_000 });
    expect(out.status, out.stderr).toBe(0);
    return out.stdout.split('\n').filter((l) => l !== '' && !l.startsWith('-'));
  }

  /** zsh: every key of the builtins parameter, one per line (`print -l` would eat a `-`). */
  const ZSH_BUILTINS = "printf '%s\\n' ${(k)builtins}";

  it.skipIf(BASH === null)('covers every built-in of the host bash', () => {
    for (const name of shellList(BASH ?? '', 'compgen -b')) {
      expect([...SHELL_BUILTINS, ...SHELL_SPECIAL_BUILTINS], name).toContain(name);
    }
  });

  it.skipIf(ZSH === null)('covers every built-in of the host zsh', () => {
    for (const name of shellList(ZSH ?? '', ZSH_BUILTINS)) {
      expect([...SHELL_BUILTINS, ...SHELL_SPECIAL_BUILTINS], name).toContain(name);
    }
  });

  it.skipIf(BASH === null || ZSH === null)(
    'holds only names that the host bash or zsh runs as a built-in',
    () => {
      const bash = new Set(shellList(BASH ?? '', 'compgen -b'));
      const zsh = new Set(shellList(ZSH ?? '', ZSH_BUILTINS));
      for (const name of SHELL_BUILTINS) {
        expect(bash.has(name) || zsh.has(name), name).toBe(true);
      }
    },
  );
});

describe('F3: jsonDepth', () => {
  it('is 512 for MAX_JSON_DEPTH', () => {
    expect(MAX_JSON_DEPTH).toBe(512);
  });

  it.each([
    ['a number', '1', 0],
    ['empty text', '', 0],
    ['a string holding brackets', '"[{[{"', 0],
    ['an empty array', '[]', 1],
    ['an empty object', '{}', 1],
    ['a flat object', '{"a": 1, "b": "x"}', 1],
    ['siblings', '[[], [[]], []]', 3],
    ['mixed nesting', '{"a": {"b": [1, {"c": []}]}}', 5],
    ['brackets inside strings and keys', '{"[[": "]]]{", "b": ["{", "["]}', 2],
    ['an escaped quote before brackets', '{"a\\"[[": "x\\"]]", "b": [[]]}', 3],
    ['an escaped backslash before a quote', '{"a\\\\": [[1]], "b": "\\\\"}', 3],
    ['escaped backslash then escaped quote', '["\\\\\\"[[[", []]', 2],
    ['whitespace and line breaks', '{\r\n  "a" : [\n [ ]\n ]\r\n}', 3],
    ['unclosed brackets', '[[[', 3],
  ])('is right for %s', (_label, text, depth) => {
    expect(jsonDepth(text)).toBe(depth);
  });

  it('never throws, whatever the depth', () => {
    expect(jsonDepth(arrays(1_000_000))).toBe(1_000_000);
    expect(jsonDepth(objects(200_000))).toBe(200_000);
  });

  it('counts depth 512 and 513 exactly', () => {
    expect(jsonDepth(settingsOfDepth(512))).toBe(512);
    expect(jsonDepth(settingsOfDepth(513))).toBe(513);
  });
});

describe('F3: readUtf8Json and depth', () => {
  it('reads a file nested 512 levels deep', () => {
    const root = plainProject();
    const text = settingsOfDepth(512);
    writeRel(root, 'a.json', text);
    expect(readUtf8Json(join(root, 'a.json'))).toEqual({ text, bom: false });
  });

  it('is invalid for a file nested 513 levels deep, and deeper', () => {
    const root = plainProject();
    for (const text of [settingsOfDepth(513), arrays(100_000), objects(100_000)]) {
      writeRel(root, 'a.json', text);
      expect(readUtf8Json(join(root, 'a.json'))).toBe('invalid');
    }
  });

  it('is invalid for a deep file after a byte order mark', () => {
    const root = plainProject();
    writeRel(root, 'a.json', `\uFEFF${arrays(600)}`);
    expect(readUtf8Json(join(root, 'a.json'))).toBe('invalid');
  });

  it('does not count brackets inside a string', () => {
    const root = plainProject();
    const text = `{"s": "${'['.repeat(1000)}"}`;
    writeRel(root, 'a.json', text);
    expect(readUtf8Json(join(root, 'a.json'))).toEqual({ text, bom: false });
  });
});

describe('F3: claude-hooks and deep settings', () => {
  it('installs into a settings file nested 512 levels deep, keeping the deep value', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, settingsOfDepth(512));
    expect(run(root, 'claude-hooks').out.action).toBe('updated');
    const after = JSON.parse(readRel(root, SETTINGS)) as Record<string, unknown>;
    expect(after).toEqual({ deep: JSON.parse(arrays(511)) as unknown, hooks: freshHooks() });
  });

  it.each([
    ['513 levels', settingsOfDepth(513)],
    ['5,000 levels', settingsOfDepth(5_000)],
    ['100,000 levels of arrays', `{"deep": ${arrays(100_000)}}`],
    ['100,000 levels of objects', objects(100_000)],
  ])('refuses settings nested %s deep as malformed-settings, changing nothing', (_label, text) => {
    const root = plainProject();
    writeRel(root, SETTINGS, text);
    const before = snapshot(root);
    const { out } = run(root, 'claude-hooks');
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('malformed-settings');
    expect(out.message).toContain(SETTINGS);
    expect(out.message).toContain(DEPTH_TEXT);
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses deep settings that hold the agentboard hooks already, as for invalid JSON', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, settingsOfDepth(600, `"hooks": ${JSON.stringify(freshHooks())}, `));
    const before = snapshot(root);
    expect(run(root, 'claude-hooks').out.refusal).toBe('malformed-settings');
    expect(snapshot(root)).toEqual(before);
  });

  it('with --force replaces deep settings by a fresh file, keeping a byte order mark', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, `{"deep": ${arrays(100_000)}}`);
    expect(run(root, 'claude-hooks', { force: true }).out.action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: freshHooks() }));
    writeRel(root, SETTINGS, `\uFEFF${settingsOfDepth(513)}`);
    expect(run(root, 'claude-hooks', { force: true }).out.action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(`\uFEFF${json({ hooks: freshHooks() })}`);
  });

  it('still installs and reports the other targets of the run', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, `{"deep": ${arrays(100_000)}}`);
    const result = install(root, { targets: ['claude', 'claude-hooks'] });
    expect(result.targets.map((t) => [t.target, t.action, t.refusal ?? null])).toEqual([
      ['claude', 'created', null],
      ['claude-hooks', 'refused', 'malformed-settings'],
    ]);
    expect(fileList(root)).toContain(SKILL);
  });

  it('repeats no content of a deep refused file', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      writeRel(root, SETTINGS, `{"k": ${JSON.stringify(f.value)}, "deep": ${arrays(600)}}`);
      const { out, text } = run(root, 'claude-hooks');
      expect(out.refusal).toBe('malformed-settings');
      expectNoLeak(f.name, [out, text], [f]);
    }
  });

  it('check reports deep settings holding the marker text modified, and others not at all', () => {
    const root = plainProject();
    writeRel(
      root,
      SETTINGS,
      `{"hooks": ${JSON.stringify(freshHooks())}, "deep": ${arrays(100_000)}}`,
    );
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([
      {
        target: 'claude-hooks',
        path: SETTINGS,
        state: 'modified',
        installedVersion: null,
        currentVersion: 3,
      },
    ]);
    writeRel(root, SETTINGS, `{"deep": ${arrays(100_000)}}`);
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([]);
  });
});

describe('F3: mcp-json and a deep .mcp.json', () => {
  const MANAGED = '"mcpServers": {"agentboard": {"command": "agentboard", "args": ["mcp"]}}';

  it.each([
    ['513 levels', `{"deep": ${arrays(512)}}`],
    ['100,000 levels', `{"deep": ${arrays(100_000)}}`],
  ])('refuses a .mcp.json nested %s deep as malformed-file, also with --force', (_label, text) => {
    const root = plainProject();
    writeRel(root, MCP, text);
    const before = snapshot(root);
    for (const force of [false, true]) {
      const { out } = run(root, 'mcp-json', { force, command: 'agentboard' });
      expect(out.action).toBe('refused');
      expect(out.refusal).toBe('malformed-file');
      expect(out.message).toContain(MCP);
      expect(out.message).toContain(DEPTH_TEXT);
      expect(snapshot(root)).toEqual(before);
    }
  });

  it('installs into a .mcp.json nested 512 levels deep', () => {
    const root = plainProject();
    writeRel(root, MCP, `{"deep": ${arrays(511)}}`);
    expect(run(root, 'mcp-json').out.action).toBe('updated');
    const after = JSON.parse(readRel(root, MCP)) as Record<string, unknown>;
    expect(after.deep).toEqual(JSON.parse(arrays(511)));
  });

  it('check does not report a managed entry in a deep .mcp.json', () => {
    const root = plainProject();
    writeRel(root, MCP, `{${MANAGED}, "deep": ${arrays(100_000)}}`);
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([]);
  });
});

describe('F3: jsonRewriteIsLossless at any depth', () => {
  it('answers for documents nested 100,000 levels deep without throwing', () => {
    expect(jsonRewriteIsLossless(arrays(100_000))).toBe(true);
    expect(jsonRewriteIsLossless(objects(100_000))).toBe(true);
    const n = 100_000;
    expect(jsonRewriteIsLossless(`${'['.repeat(n)}-0${']'.repeat(n)}`)).toBe(false);
    expect(jsonRewriteIsLossless(`${'{"a":'.repeat(n)}{"b":1,"b":2}${'}'.repeat(n)}`)).toBe(false);
    expect(jsonRewriteIsLossless(`[${arrays(n)}, 12345678901234567890]`)).toBe(false);
  });
});

describe('F4: the scanner on escaped quotes and backslashes', () => {
  it.each([
    ['an escaped quote in a value', '{"q": "say \\"hi\\"", "n": 1}'],
    ['an escaped quote in a key', '{"a\\"b": 1, "c": 2}'],
    ['a trailing escaped backslash', '{"path": "C:\\\\dir\\\\", "n": 1}'],
    ['a backslash key', '{"k\\\\": [1], "j": {"x": "\\\\"}}'],
    ['a backslash before an escaped quote', '{"x": "\\\\\\"", "y": 2}'],
    ['an escaped quote before brackets', '{"x": "\\"]}", "y": [{"z": "\\\\"}]}'],
    ['keys that differ only by an escape', '{"a\\"": 1, "a\\\\": 2}'],
  ])('is true for %s', (_label, text) => {
    expect(jsonRewriteIsLossless(text)).toBe(true);
  });

  it.each([
    ['-0 after an escaped quote', '{"a\\"b": 1, "d": -0}'],
    ['-0 after a trailing escaped backslash', '{"c": "x\\\\", "d": -0}'],
    ['a long integer after both', '{"q": "\\"\\\\", "n": 12345678901234567890}'],
    ['a duplicate key holding an escaped quote', '{"a\\"": 1, "a\\"": 2}'],
    ['a duplicate key holding an escaped backslash', '{"a\\\\": 1, "b": 0, "a\\\\": 2}'],
    ['an index key after a backslash key', '{"\\\\": 1, "3": 2}'],
  ])('is false for %s', (_label, text) => {
    expect(jsonRewriteIsLossless(text)).toBe(false);
  });

  it('rewrites a settings file holding escaped quotes and backslashes, keeping them', () => {
    const root = plainProject();
    const text = '{"q": "say \\"hi\\"", "path": "C:\\\\dir\\\\", "k\\\\\\"": {"x": "\\\\\\""}}\n';
    writeRel(root, SETTINGS, text);
    expect(run(root, 'claude-hooks').out.action).toBe('updated');
    expect(JSON.parse(readRel(root, SETTINGS))).toEqual({
      q: 'say "hi"',
      path: 'C:\\dir\\',
      'k\\"': { x: '\\"' },
      hooks: freshHooks(),
    });
  });

  it('refuses a settings file with -0 after escaped quotes and backslashes', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{"q": "\\"", "p": "\\\\", "n": -0}\n');
    const before = snapshot(root);
    expect(run(root, 'claude-hooks').out.refusal).toBe('lossy-json');
    expect(snapshot(root)).toEqual(before);
  });
});

describe('F4: the array-index boundary', () => {
  it('matches the order JavaScript gives the keys', () => {
    const keys = Object.keys(
      JSON.parse('{"b": 1, "4294967295": 2, "4294967294": 3, "4294967293": 4}') as object,
    );
    expect(keys).toEqual(['4294967293', '4294967294', 'b', '4294967295']);
  });

  it.each([
    ['"4294967294" after another key', '{"b": 1, "4294967294": 2}', false],
    ['"4294967294" before a smaller index', '{"4294967294": 1, "4294967293": 2}', false],
    [
      '"4294967293" and "4294967294" first, ascending',
      '{"4294967293": 1, "4294967294": 2, "b": 3}',
      true,
    ],
    ['"4294967295" after another key', '{"b": 1, "4294967295": 2}', true],
    ['"4294967295" before an index', '{"4294967295": 1, "0": 2}', false],
    ['"4294967296" after another key', '{"b": 1, "4294967296": 2}', true],
  ])('is right for %s', (_label, text, lossless) => {
    expect(jsonRewriteIsLossless(text)).toBe(lossless);
  });
});

describe('F5: the lossy-json message', () => {
  const discards = (rel: string): string =>
    `${rel} holds JSON that a rewrite would not give back exactly, so it was left as it is; --force rewrites it, writing each number beyond double precision as the nearest one (null when out of range), dropping the sign of -0, keeping only the last of each duplicate key and moving array-index keys first in ascending order`;

  it('says what --force would discard in settings.json', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{"n": 12345678901234567890}\n');
    const { out } = run(root, 'claude-hooks');
    expect(out.refusal).toBe('lossy-json');
    expect(out.message).toBe(discards(SETTINGS));
  });

  it('says what --force would discard in .mcp.json', () => {
    const root = plainProject();
    writeRel(root, MCP, '{"a": 1, "a": 2}\n');
    const { out } = run(root, 'mcp-json');
    expect(out.refusal).toBe('lossy-json');
    expect(out.message).toBe(discards(MCP));
  });

  it('still repeats none of the file content', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      writeFileSync(join(root, MCP), `{${JSON.stringify(f.value)}: -0}\n`);
      const { out, text } = run(root, 'mcp-json');
      expect(out.refusal).toBe('lossy-json');
      expectNoLeak(f.name, [out, text], [f]);
    }
  });
});
