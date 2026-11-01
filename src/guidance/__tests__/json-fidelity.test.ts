/**
 * agentboard never silently changes what a user wrote in a JSON file it
 * rewrites (`.claude/settings.json` for `claude-hooks`, `.mcp.json` for
 * `mcp-json`; design.md "Rulings from review round 1 of task group 3", R1
 * and R2; board-agent-guidance "Installed guidance never clobbers user
 * content"):
 * - bytes that are not valid UTF-8 are refused (`malformed-settings`, or
 *   `.mcp.json`'s `malformed-file`), never turned into U+FFFD and written
 *   back;
 * - a rewrite that would not give back every value and key order is
 *   refused as `lossy-json` (`jsonRewriteIsLossless`), and `--force`
 *   rewrites anyway.
 * Refusals repeat none of the file's content.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { checkGuidance } from '../check.js';
import {
  installGuidance,
  renderInstall,
  type GuidanceTarget,
  type InstallOptions,
  type TargetOutcome,
} from '../install.js';
import { jsonRewriteIsLossless, readUtf8Json } from '../markers.js';
import { ENV, plainProject, readRel, snapshot, writeRel } from './guidance-helpers.js';

const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';
const NPX = 'npx -y @bendechrai/agentboard';
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

function run(
  root: string,
  target: GuidanceTarget,
  extra: Omit<InstallOptions, 'cwd'> = {},
): { out: TargetOutcome; text: string } {
  const result = installGuidance({ cwd: root, env: ENV, targets: [target], ...extra });
  const out = result.targets.find((t) => t.target === target);
  if (out === undefined) {
    throw new Error(`no outcome for ${target}`);
  }
  return { out, text: renderInstall(result) };
}

function writeBytes(root: string, rel: string, bytes: Buffer): void {
  writeRel(root, rel, '');
  writeFileSync(join(root, rel), bytes);
}

function bytesOf(root: string, rel: string): Buffer {
  return readFileSync(join(root, rel));
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function cmd(event: string): string {
  return `${NPX} hook ${event} # agentboard-hooks: v3`;
}

/** The `hooks` object of a fresh warn-mode install, written out by hand. */
const FRESH_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start'), timeout: 5 }] }],
  Stop: [{ hooks: [{ type: 'command', command: cmd('stop'), timeout: 5 }] }],
  PreToolUse: [
    {
      matcher: MATCHER,
      hooks: [{ type: 'command', command: cmd('pre-tool-use'), timeout: 5 }],
    },
  ],
};

/** Up-to-date settings text whose other content is `extra` (JSON members, no braces). */
function currentSettingsWith(extra: string): string {
  return `{${extra}, "hooks": ${JSON.stringify(FRESH_HOOKS)}}\n`;
}

const INVALID_UTF8: readonly [string, Buffer][] = [
  ['a Latin-1 byte', Buffer.from('{"env": {"NAME": "caf\xe9"}}\n', 'latin1')],
  ['an overlong sequence', Buffer.from('{"env": {"SLASH": "\xc0\xaf"}}\n', 'latin1')],
  ['an encoded lone surrogate', Buffer.from('{"env": {"S": "\xed\xa0\x80"}}\n', 'latin1')],
  ['a truncated sequence at the end', Buffer.from('{"env": {}}\xe2\x82', 'latin1')],
  [
    'a Latin-1 byte after a byte order mark',
    Buffer.from('\xef\xbb\xbf{"model": "op\xe9s"}\n', 'latin1'),
  ],
];

describe('readUtf8Json', () => {
  it('reads valid UTF-8, removing and reporting a byte order mark', () => {
    const root = plainProject();
    writeRel(root, 'a.json', '{"model": "caf\u00e9 \u{1F600}"}');
    expect(readUtf8Json(join(root, 'a.json'))).toEqual({
      text: '{"model": "caf\u00e9 \u{1F600}"}',
      bom: false,
    });
    writeRel(root, 'b.json', '\uFEFF{}');
    expect(readUtf8Json(join(root, 'b.json'))).toEqual({ text: '{}', bom: true });
  });

  it('is null for a missing file', () => {
    expect(readUtf8Json(join(plainProject(), 'missing.json'))).toBeNull();
  });

  it.each(INVALID_UTF8)('is invalid for %s', (_label, bytes) => {
    const root = plainProject();
    writeFileSync(join(root, 'x.json'), bytes);
    expect(readUtf8Json(join(root, 'x.json'))).toBe('invalid');
  });
});

describe('R1: settings.json bytes that are not UTF-8', () => {
  it.each(INVALID_UTF8)('refuses %s as malformed-settings, changing no byte', (_label, bytes) => {
    const root = plainProject();
    writeBytes(root, SETTINGS, bytes);
    const before = snapshot(root);
    const { out } = run(root, 'claude-hooks');
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('malformed-settings');
    expect(out.message).toContain(SETTINGS);
    expect(snapshot(root)).toEqual(before);
  });

  it('with --force replaces the file as for invalid JSON', () => {
    const root = plainProject();
    writeBytes(root, SETTINGS, Buffer.from('{"env": {"NAME": "caf\xe9"}}\n', 'latin1'));
    expect(run(root, 'claude-hooks', { force: true }).out.action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(json({ hooks: FRESH_HOOKS }));
  });

  it('with --force keeps the byte order mark of a file it replaces', () => {
    const root = plainProject();
    writeBytes(root, SETTINGS, Buffer.from('\xef\xbb\xbf{"x": "\xe9"}\n', 'latin1'));
    run(root, 'claude-hooks', { force: true });
    expect(readRel(root, SETTINGS)).toBe(`\uFEFF${json({ hooks: FRESH_HOOKS })}`);
  });

  it('repeats no content of the refused file', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      writeBytes(
        root,
        SETTINGS,
        Buffer.concat([Buffer.from(`{"k": "${f.value}`), Buffer.from([0xe9]), Buffer.from('"}')]),
      );
      const { out, text } = run(root, 'claude-hooks');
      expect(out.refusal).toBe('malformed-settings');
      expectNoLeak(f.name, [out, text], [f]);
    }
  });

  it('check reports such a file holding the marker text modified, and one without it not at all', () => {
    const root = plainProject();
    writeBytes(
      root,
      SETTINGS,
      Buffer.concat([
        Buffer.from(`{"model": "op\xe9s", "hooks": ${JSON.stringify(FRESH_HOOKS)}}\n`, 'latin1'),
      ]),
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
    writeBytes(root, SETTINGS, Buffer.from('{"model": "op\xe9s"}\n', 'latin1'));
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([]);
  });
});

describe('R1: .mcp.json bytes that are not UTF-8', () => {
  it.each(INVALID_UTF8)('refuses %s as malformed-file, also with --force', (_label, bytes) => {
    const root = plainProject();
    writeBytes(root, MCP, bytes);
    const before = snapshot(root);
    for (const force of [false, true]) {
      const { out } = run(root, 'mcp-json', { force, command: 'agentboard' });
      expect(out.action).toBe('refused');
      expect(out.refusal).toBe('malformed-file');
      expect(snapshot(root)).toEqual(before);
    }
  });

  it('check does not report a managed entry in a file that is not UTF-8', () => {
    const root = plainProject();
    writeBytes(
      root,
      MCP,
      Buffer.from(
        `{"note": "\xe9", "mcpServers": {"agentboard": {"command": "agentboard", "args": ["mcp"]}}}\n`,
        'latin1',
      ),
    );
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([]);
  });
});

describe('jsonRewriteIsLossless', () => {
  it.each([
    ['ordinary values', '{"a": 1, "b": [true, null, "x"], "c": {"d": 2.5}}'],
    ['a number spelt with a fraction of zero', '{"n": 1.0}'],
    ['an exponent', '{"n": 1e2, "m": 2.5E-3, "p": 1E+2}'],
    ['negative numbers', '{"n": -5, "m": -0.5, "p": -1e-7}'],
    ['the largest safe integer', '{"n": 9007199254740991}'],
    ['a short decimal', '{"n": 0.1, "m": 3.14}'],
    ['array-index keys first, ascending', '{"0": 1, "2": 2, "10": 3, "b": 4}'],
    ['keys that are not array indices', '{"b": 1, "01": 2, "-1": 3, "4294967295": 4, "1.5": 5}'],
    ['the same key in different objects', '{"a": {"x": 1}, "b": {"x": 2}}'],
    ['a __proto__ key', '{"__proto__": {"a": 1}, "b": 2}'],
    ['escaped keys that differ', '{"a": 1, "\\u0062": 2}'],
    ['whitespace and line breaks', '{\r\n  "a" : 1 ,\r\n  "b":[ 1 , 2 ]\r\n}'],
  ])('is true for %s', (_label, text) => {
    expect(jsonRewriteIsLossless(text)).toBe(true);
  });

  it.each([
    ['a literal out of range', '{"n": 1e400}'],
    ['a negative literal out of range', '{"n": -1e400}'],
    ['an integer beyond double precision', '{"n": 12345678901234567890}'],
    ['a decimal beyond double precision', '{"n": 0.10000000000000000001}'],
    ['an exact power of two that JS writes in other digits', '{"n": 18446744073709551616}'],
    ['a deep literal out of range', '{"a": [{"b": [1, 2, 1E400]}]}'],
    ['-0', '{"n": -0}'],
    ['-0.0', '{"n": [-0.0]}'],
    ['-0e5', '{"a": {"n": -0e5}}'],
    ['a duplicate top-level key', '{"hooks": {}, "model": "x", "hooks": {}}'],
    ['a duplicate nested key', '{"permissions": {"allow": [], "allow": ["x"]}}'],
    ['a duplicate key inside an array', '{"a": [{"x": 1, "x": 1}]}'],
    ['a duplicate key spelt with an escape', '{"a": 1, "\\u0061": 2}'],
    ['an array-index key after another key', '{"b": 1, "10": 2}'],
    ['array-index keys out of order', '{"10": 1, "2": 2}'],
    ['a nested array-index key after another key', '{"env": {"PATH": "x", "0": "y"}}'],
  ])('is false for %s', (_label, text) => {
    expect(jsonRewriteIsLossless(text)).toBe(false);
  });
});

describe('R2: claude-hooks refuses a lossy rewrite', () => {
  it.each([
    ['a literal out of range', '{"n": 1e400}', { n: null }],
    ['a long integer', '{"n": 12345678901234567890}', { n: Number('12345678901234567890') }],
    ['-0', '{"n": -0}', { n: 0 }],
    ['duplicate keys', '{"model": "a", "model": "b"}', { model: 'b' }],
    ['duplicate hooks keys', '{"hooks": {"Stop": []}, "hooks": {}}', { hooks: {} }],
    ['an array-index key after another key', '{"b": 1, "10": 2}', { 10: 2, b: 1 }],
  ])('refuses settings with %s as lossy-json; --force rewrites them', (_label, text, forced) => {
    const root = plainProject();
    writeRel(root, SETTINGS, `${text}\n`);
    const before = snapshot(root);
    const { out } = run(root, 'claude-hooks');
    expect(out.action).toBe('refused');
    expect(out.refusal).toBe('lossy-json');
    expect(out.message).toContain(SETTINGS);
    expect(out.message).toContain('--force');
    expect(snapshot(root)).toEqual(before);
    expect(run(root, 'claude-hooks', { force: true }).out.action).toBe('updated');
    const after = JSON.parse(readRel(root, SETTINGS)) as Record<string, unknown>;
    expect(after).toEqual({ ...forced, hooks: FRESH_HOOKS });
  });

  it('updates settings with only ordinary values normally', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{"n": 1.0, "m": 1e2, "keys": {"0": "a", "b": "c"}, "x": -5}\n');
    expect(run(root, 'claude-hooks').out.action).toBe('updated');
    expect(readRel(root, SETTINGS)).toBe(
      json({ n: 1, m: 100, keys: { 0: 'a', b: 'c' }, x: -5, hooks: FRESH_HOOKS }),
    );
  });

  it('never refuses a file that needs no write', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, currentSettingsWith('"n": 1e400, "m": -0, "k": {"b": 1, "10": 2}'));
    const before = snapshot(root);
    expect(run(root, 'claude-hooks').out.action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('checks hooks-shape before lossy-json', () => {
    const root = plainProject();
    writeRel(root, SETTINGS, '{"n": 1e400, "hooks": []}\n');
    expect(run(root, 'claude-hooks').out.refusal).toBe('hooks-shape');
  });

  it('repeats no content of the refused file', () => {
    for (const f of TOKEN_FIXTURES) {
      const root = plainProject();
      writeRel(root, SETTINGS, `{${JSON.stringify(f.value)}: 1, ${JSON.stringify(f.value)}: 2}\n`);
      const { out, text } = run(root, 'claude-hooks');
      expect(out.refusal).toBe('lossy-json');
      expectNoLeak(f.name, [out, text], [f]);
    }
  });
});

describe('R2: mcp-json refuses a lossy rewrite', () => {
  it.each([
    ['a long integer', '{"timeoutMs": 12345678901234567890}'],
    ['duplicate keys', '{"mcpServers": {"x": {"command": "a"}, "x": {"command": "b"}}}'],
    [
      'an array-index key after another key',
      '{"mcpServers": {"b": {"command": "b"}, "1": {"command": "c"}}}',
    ],
  ])('refuses .mcp.json with %s as lossy-json; --force rewrites it', (_label, text) => {
    const root = plainProject();
    writeRel(root, MCP, `${text}\n`);
    const before = snapshot(root);
    const { out } = run(root, 'mcp-json');
    expect(out.refusal).toBe('lossy-json');
    expect(out.message).toContain(MCP);
    expect(snapshot(root)).toEqual(before);
    expect(run(root, 'mcp-json', { force: true }).out.action).toBe('updated');
    const after = JSON.parse(readRel(root, MCP)) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers.agentboard).toEqual({
      command: 'npx',
      args: ['-y', '@bendechrai/agentboard', 'mcp'],
    });
  });

  it('never refuses a .mcp.json that needs no write', () => {
    const root = plainProject();
    writeRel(
      root,
      MCP,
      '{"n": 1e400, "mcpServers": {"agentboard": {"command": "npx", "args": ["-y", "@bendechrai/agentboard", "mcp"]}}}\n',
    );
    const before = snapshot(root);
    expect(run(root, 'mcp-json').out.action).toBe('unchanged');
    expect(snapshot(root)).toEqual(before);
  });

  it('updates a .mcp.json with ordinary values normally', () => {
    const root = plainProject();
    writeRel(root, MCP, '{"mcpServers": {"other": {"command": "x", "args": [], "n": 1.0}}}\n');
    expect(run(root, 'mcp-json').out.action).toBe('updated');
    expect(bytesOf(root, MCP).toString('utf8')).toBe(
      json({
        mcpServers: {
          other: { command: 'x', args: [], n: 1 },
          agentboard: { command: 'npx', args: ['-y', '@bendechrai/agentboard', 'mcp'] },
        },
      }),
    );
  });
});
