/**
 * `agents install --global` and `agents check --global` for the global MCP
 * config of `codex` (`$CODEX_HOME/config.toml`) and `antigravity`
 * (`~/.gemini/config/mcp_config.json`) (board-agent-guidance: "Global
 * harness config is never edited by default", "Harness MCP entries",
 * "Installed guidance never clobbers user content", "Checking installed
 * guidance"; design.md decision 5 and "Rulings from task group 4 (test
 * author)"): the usage errors, the scratch `CODEX_HOME` and `HOME`, every
 * other byte of the user's file untouched, the TOML line scan (comments,
 * multi-line strings, arrays, inline tables, quoted keys, arrays of
 * tables, CRLF, a byte order mark, invalid UTF-8), the `foreign-table`,
 * `toml-shape`, `malformed-marker`, `entry-differs` and `malformed-file`
 * refusals, mode and links, and the check states.
 *
 * Every HOME and CODEX_HOME here is a temporary directory; no test can
 * reach the real `~/.codex` or `~/.gemini`. Expected files are written out
 * by hand.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { expectBoardError } from '../../board/__tests__/helpers.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import type { Env } from '../../cli/types.js';
import { checkCommand, checkGuidance } from '../check.js';
import { globalConfigPath, renderInstall, type InstallResult } from '../install.js';
import {
  ENV,
  IS_ROOT,
  chmodForTest,
  fileList,
  plainProject,
  readRel,
  snapshot,
} from './guidance-helpers.js';
import {
  AGENTS,
  BLOCK_030,
  COPILOT,
  CURSOR_MCP,
  NPX_ENTRY,
  RULE,
  bytesOf,
  codexBlock,
  contents,
  installIn,
  json,
  local,
  mcpFile,
  outcomeAt,
  readAbs,
  scratchHome,
  summary,
  writeAbs,
  type ScratchHome,
} from './harness-helpers.js';

const GLOBAL_TARGET_USAGE =
  "--global edits a harness's global MCP config and needs --target codex or --target antigravity";
const CODEX_HOME_USAGE = '--global needs CODEX_HOME or HOME set to an absolute path';
const HOME_USAGE = '--global needs HOME set to an absolute path';
const BLOCK = codexBlock();

function setup(opts: { codexHome?: 'unset' | 'empty' } = {}): {
  root: string;
  scratch: ScratchHome;
} {
  return { root: plainProject(), scratch: scratchHome(opts) };
}

/** Installs `codex --global` and returns the result and the config.toml outcome. */
function codexGlobal(
  root: string,
  scratch: ScratchHome,
  extra: { force?: boolean; command?: string; version?: number } = {},
): { result: InstallResult; action: string; refusal: string | null; message: string } {
  const result = installIn(root, scratch, { targets: ['codex'], global: true, ...extra });
  const out = outcomeAt(result, 'codex', scratch.codexConfig);
  return { result, action: out.action, refusal: out.refusal, message: out.message };
}

/** Writes the scratch config.toml (latin1 for raw bytes). */
function writeToml(scratch: ScratchHome, text: string, encoding: BufferEncoding = 'utf8'): void {
  writeAbs(scratch.codexConfig, text, encoding);
}

function toml(scratch: ScratchHome): string {
  return readAbs(scratch.codexConfig);
}

describe('--global usage errors', () => {
  it('scenario: Global needs an explicit target (no --target)', () => {
    const { root, scratch } = setup();
    mkdirSync(join(root, '.codex'));
    mkdirSync(join(root, '.agents'));
    const before = contents(root);
    const error = expectBoardError(() => installIn(root, scratch, { global: true }), 1, 'usage');
    expect(error.message).toBe(GLOBAL_TARGET_USAGE);
    expect(contents(root)).toEqual(before);
    expect(fileList(scratch.home)).toEqual([]);
  });

  it('refuses --global without codex or antigravity among the given targets', () => {
    const { root, scratch } = setup();
    const error = expectBoardError(
      () => installIn(root, scratch, { targets: ['cursor', 'agents-md'], global: true }),
      1,
      'usage',
    );
    expect(error.message).toBe(GLOBAL_TARGET_USAGE);
    expect(fileList(root)).toEqual([]);
  });

  it('refuses --global when codex comes only from --command selecting mcp-json', () => {
    const { root, scratch } = setup();
    expectBoardError(
      () => installIn(root, scratch, { command: 'agentboard', global: true }),
      1,
      'usage',
    );
    expect(fileList(root)).toEqual([]);
  });

  it('lets other given targets come with codex, unaffected by --global', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['codex', 'cursor'], global: true });
    expect(summary(result)).toEqual([
      ['codex', AGENTS, 'created', null],
      ['codex', scratch.codexConfig, 'created', null],
      ['cursor', RULE, 'created', null],
      ['cursor', CURSOR_MCP, 'created', null],
    ]);
    expect(result.registerCommands).toEqual([]);
  });

  it('refuses codex --global with neither CODEX_HOME nor HOME', () => {
    const root = plainProject();
    const env: Record<string, string | undefined> = { ...ENV };
    delete env.HOME;
    delete env.CODEX_HOME;
    const error = expectBoardError(
      () => installIn(root, { ...scratchHome(), env }, { targets: ['codex'], global: true }),
      1,
      'usage',
    );
    expect(error.message).toBe(CODEX_HOME_USAGE);
    expect(fileList(root)).toEqual([]);
  });

  it.each(TOKEN_FIXTURES)('refuses a relative HOME ($name) without repeating it', (f) => {
    const root = plainProject();
    const scratch = scratchHome({ codexHome: 'unset' });
    const env: Env = { ...scratch.env, HOME: `rel/${f.value}` };
    const codex = expectBoardError(
      () => installIn(root, { ...scratch, env }, { targets: ['codex'], global: true }),
      1,
      'usage',
    );
    expect(codex.message).toBe(CODEX_HOME_USAGE);
    const agy = expectBoardError(
      () => installIn(root, { ...scratch, env }, { targets: ['antigravity'], global: true }),
      1,
      'usage',
    );
    expect(agy.message).toBe(HOME_USAGE);
    expectNoLeak('relative HOME', [codex.message, agy.message], [f]);
    expect(fileList(root)).toEqual([]);
  });

  it('refuses a relative CODEX_HOME even with a usable HOME', () => {
    const { root, scratch } = setup();
    const env: Env = { ...scratch.env, CODEX_HOME: 'codex' };
    const error = expectBoardError(
      () => installIn(root, { ...scratch, env }, { targets: ['codex'], global: true }),
      1,
      'usage',
    );
    expect(error.message).toBe(CODEX_HOME_USAGE);
  });

  it('refuses antigravity --global with an empty HOME, before writing AGENTS.md', () => {
    const { root, scratch } = setup();
    const env: Env = { ...scratch.env, HOME: '' };
    const error = expectBoardError(
      () => installIn(root, { ...scratch, env }, { targets: ['antigravity'], global: true }),
      1,
      'usage',
    );
    expect(error.message).toBe(HOME_USAGE);
    expect(fileList(root)).toEqual([]);
  });
});

describe('globalConfigPath', () => {
  it('uses CODEX_HOME, else HOME/.codex, for codex, and HOME/.gemini/config for antigravity', () => {
    expect(globalConfigPath('codex', { HOME: '/h', CODEX_HOME: '/c' })).toBe('/c/config.toml');
    expect(globalConfigPath('codex', { HOME: '/h' })).toBe('/h/.codex/config.toml');
    expect(globalConfigPath('codex', { HOME: '/h', CODEX_HOME: '' })).toBe('/h/.codex/config.toml');
    expect(globalConfigPath('antigravity', { HOME: '/h', CODEX_HOME: '/c' })).toBe(
      '/h/.gemini/config/mcp_config.json',
    );
  });

  it('throws usage for an unusable HOME or CODEX_HOME', () => {
    expect(expectBoardError(() => globalConfigPath('codex', {}), 1, 'usage').message).toBe(
      CODEX_HOME_USAGE,
    );
    expect(
      expectBoardError(() => globalConfigPath('codex', { HOME: '/h', CODEX_HOME: 'x' }), 1, 'usage')
        .message,
    ).toBe(CODEX_HOME_USAGE);
    expect(
      expectBoardError(() => globalConfigPath('antigravity', { HOME: 'h' }), 1, 'usage').message,
    ).toBe(HOME_USAGE);
  });
});

describe('codex --global: writing config.toml', () => {
  it('creates CODEX_HOME/config.toml holding the block, beside the AGENTS.md outcome', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, { targets: ['codex'], global: true });
    expect(summary(result)).toEqual([
      ['codex', AGENTS, 'created', null],
      ['codex', scratch.codexConfig, 'created', null],
    ]);
    expect(result.targets.map((t) => t.reason)).toEqual([
      'requested with --target',
      'requested with --target',
    ]);
    expect(toml(scratch)).toBe(`${BLOCK}\n`);
    expect(readRel(root, AGENTS)).toBe(`${BLOCK_030}\n`);
    expect(result.registerCommands).toEqual([]);
    expect(existsSync(join(scratch.home, '.codex'))).toBe(false);
    expect(renderInstall(result)).toContain(`created codex ${scratch.codexConfig}\n`);
    expect(renderInstall(result)).not.toContain('codex mcp add');
  });

  it('uses HOME/.codex/config.toml when CODEX_HOME is unset or empty', () => {
    for (const codexHome of ['unset', 'empty'] as const) {
      const { root, scratch } = setup({ codexHome });
      expect(scratch.codexConfig).toBe(join(scratch.home, '.codex', 'config.toml'));
      codexGlobal(root, scratch);
      expect(toml(scratch)).toBe(`${BLOCK}\n`);
      expect(existsSync(scratch.codexHome)).toBe(false);
    }
  });

  it('writes the --command executable as a TOML string with args ["mcp"]', () => {
    const { root, scratch } = setup();
    codexGlobal(root, scratch, { command: 'C:\\tools\\"agent"board' });
    expect(toml(scratch)).toBe(`${codexBlock({ command: '"C:\\\\tools\\\\\\"agent\\"board"' })}\n`);
  });

  const USER_CONFIG = [
    '# My Codex config',
    'model = "o3"',
    'approval_policy = "on-request"',
    '"quoted key" = \'literal\'',
    'inline = { a = 1, b = { c = "}" } }',
    'multi = """',
    '[mcp_servers.agentboard]',
    '"""',
    '',
    '[mcp_servers.other]',
    'command = "other-mcp"',
    'args = [',
    '  "--flag", # a comment with ] in it',
    '  "]",',
    ']',
    'env = { TOKEN_NAME = "x" }',
    '',
    '[mcp_servers.other.env2]',
    'A = "1"',
    '',
    '[[profiles_list]]',
    'name = "a"',
    '',
    '[[profiles_list]]',
    'name = "b"',
    '',
  ].join('\n');

  it('scenario: Global edit is explicit (only the block is added, every other byte unchanged)', () => {
    const { root, scratch } = setup();
    writeToml(scratch, USER_CONFIG);
    const { action } = codexGlobal(root, scratch);
    expect(action).toBe('updated');
    expect(toml(scratch)).toBe(`${USER_CONFIG}\n${BLOCK}\n`);
  });

  it('keeps CRLF lines and appends the block with line feeds', () => {
    const { root, scratch } = setup();
    const crlf = USER_CONFIG.replaceAll('\n', '\r\n');
    writeToml(scratch, crlf);
    codexGlobal(root, scratch);
    expect(toml(scratch)).toBe(`${crlf}\n${BLOCK}\n`);
  });

  it('keeps a byte order mark', () => {
    const { root, scratch } = setup();
    writeToml(scratch, '\uFEFFmodel = "o3"\n');
    codexGlobal(root, scratch);
    expect(bytesOf(scratch.codexConfig).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(toml(scratch)).toBe(`\uFEFFmodel = "o3"\n\n${BLOCK}\n`);
  });

  it('adds a line feed to a last line without one, and writes only the block into an empty file', () => {
    const { root, scratch } = setup();
    writeToml(scratch, 'model = "o3" # last');
    codexGlobal(root, scratch);
    expect(toml(scratch)).toBe(`model = "o3" # last\n\n${BLOCK}\n`);
    writeToml(scratch, '');
    codexGlobal(root, scratch);
    expect(toml(scratch)).toBe(`${BLOCK}\n`);
  });

  it('keeps non-ASCII text byte for byte', () => {
    const { root, scratch } = setup();
    writeToml(scratch, 'name = "caf\u00e9 \u{1f600}"\n');
    codexGlobal(root, scratch);
    expect(toml(scratch)).toBe(`name = "caf\u00e9 \u{1f600}"\n\n${BLOCK}\n`);
  });

  it('scenario: Reinstall is idempotent (config.toml unchanged, not even its mtime)', () => {
    const { root, scratch } = setup();
    writeToml(scratch, USER_CONFIG);
    codexGlobal(root, scratch);
    const before = snapshot(scratch.home);
    const { action } = codexGlobal(root, scratch);
    expect(action).toBe('unchanged');
    expect(snapshot(scratch.home)).toEqual(before);
  });

  it('upgrades a block of another version in place, keeping everything around it', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `model = "o3"\n\n${codexBlock({ version: 2 })}\n\n[profiles.a]\nk = 1\n`);
    const { action } = codexGlobal(root, scratch);
    expect(action).toBe('updated');
    expect(toml(scratch)).toBe(`model = "o3"\n\n${BLOCK}\n\n[profiles.a]\nk = 1\n`);
  });

  it('keeps a local command without --command, and --command switches it without --force', () => {
    const { root, scratch } = setup();
    const localBlock = codexBlock({ command: '"/opt/agentboard"' });
    writeToml(scratch, `${localBlock}\n`);
    expect(codexGlobal(root, scratch).action).toBe('unchanged');
    expect(codexGlobal(root, scratch, { command: '/opt/agentboard' }).action).toBe('unchanged');
    expect(codexGlobal(root, scratch, { command: 'agentboard' }).action).toBe('updated');
    expect(toml(scratch)).toBe(`${codexBlock({ command: '"agentboard"' })}\n`);
    expect(codexGlobal(root, scratch, { command: 'npx' }).action).toBe('updated');
    expect(toml(scratch)).toBe(`${codexBlock({ command: '"npx"' })}\n`);
  });

  it('keeps the local command when upgrading an older block', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `${codexBlock({ version: 2, command: '"/opt/agentboard"' })}\n`);
    codexGlobal(root, scratch);
    expect(toml(scratch)).toBe(`${codexBlock({ command: '"/opt/agentboard"' })}\n`);
  });

  it('rewrites a block whose lines were converted to CRLF, with line feeds, without --force', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `a = 1\r\n${BLOCK.replaceAll('\n', '\r\n')}\r\n[b]\r\nk = 2\r\n`);
    const { action } = codexGlobal(root, scratch);
    expect(action).toBe('updated');
    expect(toml(scratch)).toBe(`a = 1\r\n${BLOCK}\r\n[b]\r\nk = 2\r\n`);
  });

  it('keeps the mode of config.toml and leaves no temporary file', () => {
    const { root, scratch } = setup();
    writeToml(scratch, 'model = "o3"\n');
    chmodSync(scratch.codexConfig, 0o600);
    codexGlobal(root, scratch);
    expect(statSync(scratch.codexConfig).mode & 0o777).toBe(0o600);
    expect(readdirSync(scratch.codexHome)).toEqual(['config.toml']);
  });

  it('follows a symbolic link to a dotfiles directory outside HOME and keeps the link', () => {
    const { root, scratch } = setup();
    const dotfiles = tempDir();
    writeAbs(join(dotfiles, 'codex.toml'), 'model = "o3"\n');
    mkdirSync(scratch.codexHome);
    symlinkSync(join(dotfiles, 'codex.toml'), scratch.codexConfig);
    const { action } = codexGlobal(root, scratch);
    expect(action).toBe('updated');
    expect(lstatSync(scratch.codexConfig).isSymbolicLink()).toBe(true);
    expect(readlinkSync(scratch.codexConfig)).toBe(join(dotfiles, 'codex.toml'));
    expect(readAbs(join(dotfiles, 'codex.toml'))).toBe(`model = "o3"\n\n${BLOCK}\n`);
  });

  it('refuses a directory at the path as not-a-file', () => {
    const { root, scratch } = setup();
    mkdirSync(scratch.codexConfig, { recursive: true });
    expect(codexGlobal(root, scratch).refusal).toBe('not-a-file');
  });

  it('refuses a read-only config.toml as unwritable', () => {
    if (IS_ROOT) {
      return;
    }
    const { root, scratch } = setup();
    writeToml(scratch, 'model = "o3"\n');
    chmodForTest(scratch.codexConfig, 0o444);
    expect(codexGlobal(root, scratch).refusal).toBe('unwritable');
    expect(toml(scratch)).toBe('model = "o3"\n');
  });
});

describe('codex --global: the foreign-table refusal', () => {
  const FOREIGN_HEADERS = [
    '[mcp_servers.agentboard]',
    '[mcp_servers."agentboard"]',
    '["mcp_servers".\'agentboard\']',
    '[ mcp_servers . agentboard ]',
    '  [mcp_servers.agentboard]  # mine',
    '[mcp_servers."agent\\u0062oard"]',
    '[mcp_servers.agentboard.env]',
  ];

  it.each(FOREIGN_HEADERS)(
    'scenario: Foreign Codex table is refused (%s), the file unchanged, other targets processed',
    (header) => {
      const { root, scratch } = setup();
      const text = `model = "o3"\n\n${header}\ncommand = "mine"\n`;
      writeToml(scratch, text);
      const result = installIn(root, scratch, { targets: ['codex', 'copilot'], global: true });
      expect(summary(result)).toEqual([
        ['codex', AGENTS, 'created', null],
        ['codex', scratch.codexConfig, 'refused', 'foreign-table'],
        ['copilot', COPILOT, 'created', null],
      ]);
      const out = outcomeAt(result, 'codex', scratch.codexConfig);
      expect(out.message).toContain(scratch.codexConfig);
      expect(out.message).toContain('--force');
      expect(result.refused).toBe(1);
      expect(toml(scratch)).toBe(text);
    },
  );

  it.each([
    '[mcp_servers.agentboard-dev]',
    '[mcp_servers.Agentboard]',
    '[mcp_servers."agentboard.x"]',
    '[other.mcp_servers.agentboard]',
    'x = "[mcp_servers.agentboard]"',
    'multi = """\n[mcp_servers.agentboard]\n"""',
    "lit = '''\n[mcp_servers.agentboard]\n'''",
    '[mcp_servers]\nother = { command = "y" }',
    '[foo]\nmcp_servers.agentboard = 1',
    'mcp_servers.other.command = "y"',
  ])('does not count %j as a definition of the server', (text) => {
    const { root, scratch } = setup();
    writeToml(scratch, `${text}\n`);
    expect(codexGlobal(root, scratch).action).toBe('updated');
    expect(toml(scratch)).toBe(`${text}\n\n${BLOCK}\n`);
  });

  it.each([
    ['a literal string holding three quotes', `lit = '"""'`],
    ['a basic string of escaped quotes', 'pat = "\\"\\"\\""'],
    ['a comment holding three quotes', '# """ not a string'],
    ['a one-line multi-line basic string', 'ml = """ends here"""'],
    ['a one-line multi-line literal string', "ml = '''x'''"],
    ['a multi-line basic string with an escaped quote run', 'ml = """a\\"""b"""'],
    ['a multi-line basic string ending in a quote', 'ml = """x""""'],
    ['an array across lines with ] in a string and a comment', 'args = [\n  "]", # ]\n  "x",\n]'],
    ['an inline table with } in a string', 'env = { A = "}" }'],
  ])('still finds the foreign table after %s', (_name, before) => {
    const { root, scratch } = setup();
    const text = `${before}\n[mcp_servers.agentboard]\ncommand = "mine"\n`;
    writeToml(scratch, text);
    expect(codexGlobal(root, scratch).refusal).toBe('foreign-table');
    expect(toml(scratch)).toBe(text);
  });

  it('finds the foreign table on the first line after a byte order mark', () => {
    const { root, scratch } = setup();
    writeToml(scratch, '\uFEFF[mcp_servers.agentboard]\ncommand = "mine"\n');
    expect(codexGlobal(root, scratch).refusal).toBe('foreign-table');
  });

  it('with --force puts the block where the foreign table was, keeping the tables after it', () => {
    const { root, scratch } = setup();
    writeToml(
      scratch,
      'model = "o3"\n\n[mcp_servers.agentboard]\ncommand = "mine"\n\n[profiles.a]\nk = 1\n',
    );
    const { action } = codexGlobal(root, scratch, { force: true });
    expect(action).toBe('updated');
    expect(toml(scratch)).toBe(`model = "o3"\n\n${BLOCK}\n[profiles.a]\nk = 1\n`);
  });

  it('with --force removes the foreign sub-tables too', () => {
    const { root, scratch } = setup();
    writeToml(
      scratch,
      '[mcp_servers.agentboard]\ncommand = "mine"\n[mcp_servers.agentboard.env]\nX = "1"\n[profiles.a]\nk = 1\n',
    );
    codexGlobal(root, scratch, { force: true });
    expect(toml(scratch)).toBe(`${BLOCK}\n[profiles.a]\nk = 1\n`);
  });

  it('with --force replaces a foreign table at the end of a file without a final line feed', () => {
    const { root, scratch } = setup();
    writeToml(scratch, 'model = "o3"\n[mcp_servers.agentboard]\ncommand = "mine"');
    codexGlobal(root, scratch, { force: true });
    expect(toml(scratch)).toBe(`model = "o3"\n${BLOCK}\n`);
  });

  it('refuses a foreign table beside a marked block, and --force removes it and keeps the block', () => {
    const { root, scratch } = setup();
    const text = `${BLOCK}\n\n[mcp_servers.agentboard]\ncommand = "mine"\n`;
    writeToml(scratch, text);
    expect(codexGlobal(root, scratch).refusal).toBe('foreign-table');
    expect(toml(scratch)).toBe(text);
    expect(codexGlobal(root, scratch, { force: true }).action).toBe('updated');
    expect(toml(scratch)).toBe(`${BLOCK}\n\n`);
  });

  it.each(TOKEN_FIXTURES)('the refusal repeats none of the table ($name)', (f) => {
    const { root, scratch } = setup();
    writeToml(
      scratch,
      `[mcp_servers.agentboard]\ncommand = "mine"\nenv = { TOKEN = "${f.value}" }\n`,
    );
    const { result } = codexGlobal(root, scratch);
    expect(result.refused).toBe(1);
    expectNoLeak('foreign table', [result, renderInstall(result)], [f]);
  });
});

describe('codex --global: definitions a line edit cannot replace (toml-shape)', () => {
  it.each([
    '[[mcp_servers]]\nname = "x"',
    '[[mcp_servers.agentboard]]\ncommand = "x"',
    'mcp_servers.agentboard.command = "x"',
    '"mcp_servers"."agentboard" = { command = "x" }',
    '[mcp_servers]\nagentboard = { command = "x" }',
    '[mcp_servers]\n"agentboard" = { command = "x" }',
    '[mcp_servers]\nagentboard.command = "x"',
    'mcp_servers = { other = { command = "y" } }',
    `${BLOCK}\nmodel = "o3"`,
    `${BLOCK}\n\n# my settings\nmodel = "o3"\n[profiles.a]\nk = 1`,
  ])('refuses %j as toml-shape, even with --force', (text) => {
    const { root, scratch } = setup();
    writeToml(scratch, `${text}\n`);
    for (const force of [false, true]) {
      const { refusal, message } = codexGlobal(root, scratch, { force });
      expect(refusal).toBe('toml-shape');
      expect(message).toContain(scratch.codexConfig);
      expect(toml(scratch)).toBe(`${text}\n`);
    }
  });
});

describe('codex --global: files that cannot be edited (malformed-file)', () => {
  it.each([
    ['bytes that are not UTF-8', 'model = "caf\xe9"\n'],
    ['an unterminated multi-line basic string', 'x = """\nstill open\n'],
    ['an unterminated multi-line literal string', "x = '''\nstill open\n"],
    ['an unclosed array', 'args = [\n  "a",\n'],
    ['an unclosed inline table', 'x = { a = 1\n'],
  ])('refuses %s, even with --force, leaving every byte', (_name, text) => {
    const { root, scratch } = setup();
    writeToml(scratch, text, 'latin1');
    for (const force of [false, true]) {
      const { refusal, message } = codexGlobal(root, scratch, { force });
      expect(refusal).toBe('malformed-file');
      expect(message).toContain(scratch.codexConfig);
      expect(bytesOf(scratch.codexConfig)).toEqual(Buffer.from(text, 'latin1'));
    }
  });
});

describe('codex --global: markers', () => {
  it.each([
    ['a start without an end', 'model = "o3"\n# agentboard:start v3\n'],
    ['an end before a start', '# agentboard:end\n# agentboard:start v3\n'],
    ['two blocks', `${BLOCK}\n${BLOCK}\n`],
    ['a start with no version', '# agentboard:start\n# agentboard:end\n'],
    ['a marker inside a multi-line string', 's = """\n# agentboard:end\n"""\n'],
  ])('refuses %s as malformed-marker', (_name, text) => {
    const { root, scratch } = setup();
    writeToml(scratch, text);
    const { refusal, message } = codexGlobal(root, scratch);
    expect(refusal).toBe('malformed-marker');
    expect(message).toContain(scratch.codexConfig);
    expect(toml(scratch)).toBe(text);
  });

  it('with --force removes every marker-like line, and nothing else, then appends the block', () => {
    const { root, scratch } = setup();
    writeToml(scratch, 'model = "o3"\n# agentboard:start v3\n');
    expect(codexGlobal(root, scratch, { force: true }).action).toBe('updated');
    expect(toml(scratch)).toBe(`model = "o3"\n\n${BLOCK}\n`);
  });

  it('refuses a hand-edited block as entry-differs, repeating none of it, and --force replaces it', () => {
    const { root, scratch } = setup();
    const token = TOKEN_FIXTURES[0]?.value ?? '';
    const edited = BLOCK.replace(
      '# agentboard:end',
      `env = { TOKEN = "${token}" }\n# agentboard:end`,
    );
    writeToml(scratch, `model = "o3"\n\n${edited}\n`);
    const { refusal, message, result } = codexGlobal(root, scratch);
    expect(refusal).toBe('entry-differs');
    expect(message).toContain(scratch.codexConfig);
    expect(message).toContain('--force');
    expectNoLeak('hand-edited block', [result, renderInstall(result)], TOKEN_FIXTURES.slice(0, 1));
    expect(toml(scratch)).toBe(`model = "o3"\n\n${edited}\n`);
    expect(codexGlobal(root, scratch, { force: true }).action).toBe('updated');
    expect(toml(scratch)).toBe(`model = "o3"\n\n${BLOCK}\n`);
  });

  it('refuses a block with other args as entry-differs, and --force with --command writes the local block', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `${BLOCK.replace('"mcp"]', '"mcp", "--as", "x"]')}\n`);
    expect(codexGlobal(root, scratch, { command: 'agentboard' }).refusal).toBe('entry-differs');
    codexGlobal(root, scratch, { command: 'agentboard', force: true });
    expect(toml(scratch)).toBe(`${codexBlock({ command: '"agentboard"' })}\n`);
  });
});

describe('antigravity --global: mcp_config.json', () => {
  function agyGlobal(
    root: string,
    scratch: ScratchHome,
    extra: { force?: boolean; command?: string } = {},
  ): { result: InstallResult; action: string; refusal: string | null } {
    const result = installIn(root, scratch, { targets: ['antigravity'], global: true, ...extra });
    const out = outcomeAt(result, 'antigravity', scratch.agyConfig);
    return { result, action: out.action, refusal: out.refusal };
  }

  it('creates HOME/.gemini/config/mcp_config.json holding the entry, beside the AGENTS.md outcome', () => {
    const { root, scratch } = setup();
    const { result } = agyGlobal(root, scratch);
    expect(summary(result)).toEqual([
      ['antigravity', AGENTS, 'created', null],
      ['antigravity', scratch.agyConfig, 'created', null],
    ]);
    expect(readAbs(scratch.agyConfig)).toBe(mcpFile());
    expect(result.registerCommands).toEqual([]);
    expect(existsSync(scratch.codexHome)).toBe(false);
  });

  it('adds the entry after the other servers and keys, every other key and value kept', () => {
    const { root, scratch } = setup();
    writeAbs(
      scratch.agyConfig,
      '{"theme": "dark", "mcpServers": {"fs": {"command": "fs-mcp", "args": ["/"], "env": {"A": "1"}}}, "z": null}',
    );
    expect(agyGlobal(root, scratch).action).toBe('updated');
    expect(readAbs(scratch.agyConfig)).toBe(
      json({
        theme: 'dark',
        mcpServers: {
          fs: { command: 'fs-mcp', args: ['/'], env: { A: '1' } },
          agentboard: NPX_ENTRY,
        },
        z: null,
      }),
    );
  });

  it('adds mcpServers as the last key when it is missing', () => {
    const { root, scratch } = setup();
    writeAbs(scratch.agyConfig, '{"theme": "dark"}\n');
    agyGlobal(root, scratch);
    expect(readAbs(scratch.agyConfig)).toBe(
      json({ theme: 'dark', mcpServers: { agentboard: NPX_ENTRY } }),
    );
  });

  it('scenario: Antigravity global entry (an unmanaged agentboard entry is refused as entry-differs)', () => {
    const { root, scratch } = setup();
    const text = json({
      mcpServers: { agentboard: { command: 'agentboard', args: ['mcp', '--as', 'me'] } },
    });
    writeAbs(scratch.agyConfig, text);
    expect(agyGlobal(root, scratch).refusal).toBe('entry-differs');
    expect(readAbs(scratch.agyConfig)).toBe(text);
    expect(agyGlobal(root, scratch, { force: true }).action).toBe('updated');
    expect(readAbs(scratch.agyConfig)).toBe(mcpFile());
  });

  it('keeps a local managed entry without --command, and --command switches it without --force', () => {
    const { root, scratch } = setup();
    writeAbs(scratch.agyConfig, mcpFile(local('/opt/agentboard')));
    expect(agyGlobal(root, scratch).action).toBe('unchanged');
    expect(agyGlobal(root, scratch, { command: 'agentboard' }).action).toBe('updated');
    expect(readAbs(scratch.agyConfig)).toBe(mcpFile(local('agentboard')));
  });

  it('refuses invalid JSON and bytes that are not UTF-8 as malformed-file, even with --force', () => {
    const { root, scratch } = setup();
    for (const text of ['{"mcpServers": ', '{"mcpServers": {"x": "caf\xe9"}}']) {
      writeAbs(scratch.agyConfig, text, 'latin1');
      expect(agyGlobal(root, scratch, { force: true }).refusal).toBe('malformed-file');
      expect(bytesOf(scratch.agyConfig)).toEqual(Buffer.from(text, 'latin1'));
    }
  });

  it('refuses a lossy rewrite as lossy-json', () => {
    const { root, scratch } = setup();
    const text = '{"mcpServers": {}, "n": 1e400}\n';
    writeAbs(scratch.agyConfig, text);
    expect(agyGlobal(root, scratch).refusal).toBe('lossy-json');
    expect(readAbs(scratch.agyConfig)).toBe(text);
  });

  it('keeps the mode, follows a link and leaves no temporary file', () => {
    const { root, scratch } = setup();
    const dotfiles = tempDir();
    writeAbs(join(dotfiles, 'agy.json'), '{"mcpServers": {}}\n');
    chmodSync(join(dotfiles, 'agy.json'), 0o600);
    mkdirSync(join(scratch.home, '.gemini', 'config'), { recursive: true });
    symlinkSync(join(dotfiles, 'agy.json'), scratch.agyConfig);
    agyGlobal(root, scratch);
    expect(lstatSync(scratch.agyConfig).isSymbolicLink()).toBe(true);
    expect(readAbs(join(dotfiles, 'agy.json'))).toBe(mcpFile());
    expect(statSync(join(dotfiles, 'agy.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dotfiles)).toEqual(['agy.json']);
  });

  it('puts --command into both global entries', () => {
    const { root, scratch } = setup();
    const result = installIn(root, scratch, {
      targets: ['codex', 'antigravity'],
      global: true,
      command: 'agentboard',
    });
    expect(result.refused).toBe(0);
    expect(toml(scratch)).toBe(`${codexBlock({ command: '"agentboard"' })}\n`);
    expect(readAbs(scratch.agyConfig)).toBe(mcpFile(local('agentboard')));
    expect(result.registerCommands).toEqual([]);
  });
});

describe('agents check --global', () => {
  function check(root: string, scratch: ScratchHome, global = true): (string | number | null)[][] {
    return checkGuidance({ cwd: root, env: scratch.env, global }).map((e) => [
      e.target,
      e.path,
      e.state,
      e.installedVersion,
    ]);
  }

  it('reports both global files current after installing them, after the project targets', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['codex', 'antigravity', 'copilot'], global: true });
    expect(check(root, scratch)).toEqual([
      ['agents-md', AGENTS, 'current', 3],
      ['codex', scratch.codexConfig, 'current', 3],
      ['antigravity', scratch.agyConfig, 'current', null],
      ['copilot', COPILOT, 'current', 3],
    ]);
    expect(checkCommand(root, scratch.env, { global: true }).exitCode ?? 0).toBe(0);
  });

  it('plain agents check reads neither global file', () => {
    const { root, scratch } = setup();
    installIn(root, scratch, { targets: ['codex', 'antigravity'], global: true });
    expect(check(root, scratch, false)).toEqual([['agents-md', AGENTS, 'current', 3]]);
    if (!IS_ROOT) {
      chmodForTest(scratch.codexConfig, 0o000);
      chmodForTest(scratch.agyConfig, 0o000);
      expect(check(root, scratch, false)).toEqual([['agents-md', AGENTS, 'current', 3]]);
    }
  });

  it('reports a local command block current, an older block stale and a hand-edited one modified', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `${codexBlock({ command: '"/opt/agentboard"' })}\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'current', 3]]);
    writeToml(scratch, `x = 1\n${codexBlock({ version: 2 })}\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'stale', 2]]);
    writeToml(scratch, `${BLOCK.replace('"mcp"]', '"mcp", "--as", "x"]')}\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', 3]]);
    writeToml(scratch, `${BLOCK.replaceAll('\n', '\r\n')}\r\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', 3]]);
  });

  it('reports the block modified when the server is also defined outside the markers', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `${BLOCK}\n[mcp_servers.agentboard.env]\nX = "1"\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', 3]]);
    writeToml(scratch, `mcp_servers.agentboard.env.X = "1"\n${BLOCK}\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', 3]]);
    writeToml(scratch, `${BLOCK}\nmodel = "o3"\n`);
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', 3]]);
  });

  it('reports malformed markers modified, and a file with only a foreign table not at all', () => {
    const { root, scratch } = setup();
    writeToml(scratch, '# agentboard:start v3\n[mcp_servers.agentboard]\n');
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', 3]]);
    writeToml(scratch, '[mcp_servers.agentboard]\ncommand = "mine"\n');
    expect(check(root, scratch)).toEqual([]);
  });

  it('reports a config.toml that is not UTF-8 modified only when it holds a marker', () => {
    const { root, scratch } = setup();
    writeToml(scratch, `x = "\xe9"\n# agentboard:start v3\n`, 'latin1');
    expect(check(root, scratch)).toEqual([['codex', scratch.codexConfig, 'modified', null]]);
    writeToml(scratch, 'x = "\xe9"\n', 'latin1');
    expect(check(root, scratch)).toEqual([]);
  });

  it('reports the Antigravity entry like the .mcp.json entry', () => {
    const { root, scratch } = setup();
    writeAbs(scratch.agyConfig, mcpFile(local('agentboard')));
    expect(check(root, scratch)).toEqual([['antigravity', scratch.agyConfig, 'current', null]]);
    writeAbs(scratch.agyConfig, mcpFile({ ...NPX_ENTRY, env: { A: '1' } }));
    expect(check(root, scratch)).toEqual([['antigravity', scratch.agyConfig, 'modified', null]]);
    writeAbs(scratch.agyConfig, '{"mcpServers": {"other": {"command": "x"}}}');
    expect(check(root, scratch)).toEqual([]);
  });

  it('refuses --global with no usable HOME as usage', () => {
    const root = plainProject();
    const env: Record<string, string | undefined> = { ...ENV };
    delete env.HOME;
    delete env.CODEX_HOME;
    expectBoardError(() => checkGuidance({ cwd: root, env, global: true }), 1, 'usage');
  });
});
