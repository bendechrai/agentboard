/**
 * Helpers for the group 4 harness target tests (codex, cursor, antigravity
 * and copilot): a scratch home for every run, so no test can reach the
 * real `~/.codex`, `~/.gemini` or `~/.cursor`, the frozen 0.3.0 texts, and
 * the expected files written out by hand.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir } from '../../store/__tests__/helpers.js';
import {
  installGuidance,
  type GuidanceTarget,
  type InstallOptions,
  type InstallResult,
  type TargetOutcome,
} from '../install.js';
import type { Env } from '../../cli/types.js';
import { ENV, snapshot } from './guidance-helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** `.claude/skills/agentboard/SKILL.md` exactly as agentboard 0.3.0 renders it (guidance version 3). */
export const SKILL_030 = readFileSync(join(FIXTURES, 'skill-0.3.0.md'), 'utf8');

/** The `AGENTS.md` block exactly as agentboard 0.3.0 renders it, without a trailing newline. */
export const BLOCK_030 = readFileSync(join(FIXTURES, 'agents-block-0.3.0.md'), 'utf8');

export const AGENTS = 'AGENTS.md';
export const SKILL = '.claude/skills/agentboard/SKILL.md';
export const MCP = '.mcp.json';
export const RULE = '.cursor/rules/agentboard.mdc';
export const CURSOR_MCP = '.cursor/mcp.json';
export const COPILOT = '.github/copilot-instructions.md';
export const NPX_ENTRY = { command: 'npx', args: ['-y', '@bendechrai/agentboard', 'mcp'] };
export const CODEX_ADD = 'codex mcp add agentboard -- npx -y @bendechrai/agentboard mcp';
export const AGY_ADD = 'agy mcp add agentboard npx -y @bendechrai/agentboard mcp';

/** The local managed MCP entry for `command`. */
export function local(command: string): { command: string; args: string[] } {
  return { command, args: ['mcp'] };
}

/** JSON text as the installer serializes it. */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A `.mcp.json`-shaped file holding only the agentboard entry. */
export function mcpFile(entry: unknown = NPX_ENTRY): string {
  return json({ mcpServers: { agentboard: entry } });
}

/** The Cursor rule description, written out by hand. */
export const RULE_DESCRIPTION =
  "Coordinates this project's coding agents on the agentboard ticket board; always applied";

/**
 * The Cursor rule for version `version`, written out by hand from the
 * frozen 0.3.0 block: frontmatter, the ownership marker, then the lines
 * of the block between its markers.
 */
export function expectedRule(version = 3): string {
  const inner = BLOCK_030.split('\n').slice(1, -1);
  return `${[
    '---',
    `description: ${RULE_DESCRIPTION}`,
    'alwaysApply: true',
    '---',
    `<!-- agentboard-guidance: v${String(version)} -->`,
    ...inner,
  ].join('\n')}\n`;
}

/** The 0.3.0 block with its start marker set to `version`. */
export function blockAt(version: number): string {
  return BLOCK_030.replace(
    '<!-- agentboard:start v3 -->',
    `<!-- agentboard:start v${String(version)} -->`,
  );
}

/** The Codex block, written out by hand. */
export function codexBlock(opts: { version?: number; command?: string } = {}): string {
  const v = String(opts.version ?? 3);
  const command = opts.command ?? null;
  return [
    `# agentboard:start v${v}`,
    '[mcp_servers.agentboard]',
    command === null ? 'command = "npx"' : `command = ${command}`,
    command === null ? 'args = ["-y", "@bendechrai/agentboard", "mcp"]' : 'args = ["mcp"]',
    '# agentboard:end',
  ].join('\n');
}

/** A scratch home: `HOME`, a separate `CODEX_HOME`, and the environment naming both. */
export interface ScratchHome {
  readonly home: string;
  readonly codexHome: string;
  readonly env: Env;
  /** `<codexHome>/config.toml`. */
  readonly codexConfig: string;
  /** `<home>/.gemini/config/mcp_config.json`. */
  readonly agyConfig: string;
}

/**
 * A fresh scratch `HOME` with `CODEX_HOME` at `<home>/codex-home` (not
 * created), and `XDG_CONFIG_HOME` inside it. `codexHome: 'unset'` leaves
 * `CODEX_HOME` out of the environment, so Codex's config is
 * `<home>/.codex/config.toml`.
 */
export function scratchHome(opts: { codexHome?: 'unset' | 'empty' } = {}): ScratchHome {
  const home = tempDir();
  const codexHome = join(home, 'codex-home');
  const env: Record<string, string | undefined> = {
    ...ENV,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  delete env.CODEX_HOME;
  if (opts.codexHome === undefined) {
    env.CODEX_HOME = codexHome;
  } else if (opts.codexHome === 'empty') {
    env.CODEX_HOME = '';
  }
  const codexConfig =
    opts.codexHome === undefined
      ? join(codexHome, 'config.toml')
      : join(home, '.codex', 'config.toml');
  return {
    home,
    codexHome,
    env,
    codexConfig,
    agyConfig: join(home, '.gemini', 'config', 'mcp_config.json'),
  };
}

/** Installs in `cwd` with the scratch home's environment. */
export function installIn(
  cwd: string,
  scratch: ScratchHome,
  extra: Omit<InstallOptions, 'cwd' | 'env'> = {},
): InstallResult {
  return installGuidance({ cwd, env: scratch.env, ...extra });
}

/** Every outcome of `target`, in order. */
export function outcomesOf(result: InstallResult, target: GuidanceTarget): TargetOutcome[] {
  return result.targets.filter((t) => t.target === target);
}

/** The one outcome of `target` for `path`. */
export function outcomeAt(
  result: InstallResult,
  target: GuidanceTarget,
  path: string,
): TargetOutcome {
  const found = result.targets.find((t) => t.target === target && t.path === path);
  if (found === undefined) {
    throw new Error(`no outcome for ${target} at ${path}`);
  }
  return found;
}

/** `[target, path, action, refusal]` of every outcome. */
export function summary(result: InstallResult): (string | null)[][] {
  return result.targets.map((t) => [t.target, t.path, t.action, t.refusal]);
}

/** Every file below `dir` with its content (bytes as latin1), without mtimes. */
export function contents(dir: string): Map<string, string> {
  return new Map([...snapshot(dir)].map(([path, { content }]) => [path, content]));
}

/** Writes an absolute `path` (bytes from a latin1 string or a Buffer), creating parents. */
export function writeAbs(
  path: string,
  content: string | Buffer,
  encoding: BufferEncoding = 'utf8',
): void {
  mkdirSync(dirname(path), { recursive: true });
  if (typeof content === 'string') {
    writeFileSync(path, content, encoding);
  } else {
    writeFileSync(path, content);
  }
}

/** Reads an absolute `path` as UTF-8. */
export function readAbs(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Reads an absolute `path` as bytes. */
export function bytesOf(path: string): Buffer {
  return readFileSync(path);
}

/**
 * A directory of fake `codex` and `agy` executables that print each
 * argument they get on its own line, for running a printed command in a
 * real shell.
 */
export function fakeHarnessBin(): string {
  const bin = tempDir();
  for (const name of ['codex', 'agy']) {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
    chmodSync(path, 0o755);
  }
  return bin;
}
