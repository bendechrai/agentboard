/**
 * `agentboard agents check` (board-agent-guidance: "Checking installed
 * guidance", "Managed MCP entry").
 *
 * Inspects the guidance installed in the current working tree and reports
 * each target found as `current`, `stale` or `modified`, so a host project
 * can run it in its own checks. Reads only; needs no board and no actor.
 *
 * How `modified` is detected: the markers carry only a version (the spec
 * fixes their format), so a target is compared with the text the running
 * CLI renders for the version recorded in its marker. That text is only
 * known for the running version: a target recorded with another version is
 * `stale` whatever its text (installing rewrites it), and a target recorded
 * with the running version whose managed text differs from
 * `renderSkill`/`renderAgentsBlock`/`renderCursorRule`/`renderCodexBlock`/
 * `OPENSPEC_GUIDANCE` is `modified`. A managed region whose version cannot
 * be read at all is `modified`. The global files of `codex` and
 * `antigravity` are read only with `--global` (board-agent-guidance:
 * "Global harness config is never edited by default").
 */

import { statSync } from 'node:fs';

import type { CommandOutput, Env } from '../cli/types.js';
import {
  GUIDANCE_TARGETS,
  TARGET_FILES,
  globalConfigPath,
  workingTreeRoot,
  type GuidanceTarget,
} from './install.js';
import {
  AGENTS_MD_PATH,
  ANTIGRAVITY_RULES_FILE_LIMIT,
  CURSOR_MCP_PATH,
  GUIDANCE_VERSION,
  HOOKS_MARKER_TEXT,
  MCP_SERVER_NAME,
  OPENSPEC_GUIDANCE,
  OPENSPEC_OPERATIONS,
  OPENSPEC_PREFIX,
  hookGroup,
  renderAgentsBlock,
  renderCursorRule,
  renderSkill,
} from './installed-text.js';
import {
  CODEX_MARKERS,
  PERMISSION_CODES,
  agentsMarkers,
  errorCode,
  globalPath,
  groupHandlers,
  hasHooksShape,
  hasSkillMarker,
  hookArrays,
  hookMarkerVersion,
  isJsonObject,
  isManagedMcpEntry,
  isOwnedHandler,
  jsonEqual,
  openSpecCommentVersion,
  openSpecItems,
  parseConfig,
  parseHookCommand,
  parseMcpJson,
  readBytes,
  readText,
  readUtf8Json,
  readUtf8Text,
  skillVersion,
  targetPath,
  type TargetPath,
} from './markers.js';
import { codexMarkers, managedCodexCommand, scanToml, serverDefinitions } from './toml.js';

/**
 * - `current`: the target is exactly what `agents install` would write now.
 * - `stale`: it was installed by another guidance version (older, or newer
 *   than the running CLI); `agents install` rewrites it.
 * - `modified`: its managed region was edited by hand (the recorded version
 *   is the running one but the text differs, or the version is unreadable,
 *   or the markers are malformed), or, for `mcp-json`, which carries no
 *   version, the entry is not a managed entry (`isManagedMcpEntry`).
 */
export type GuidanceState = 'current' | 'stale' | 'modified';

/** One target found; the `agents check --json` document is an array of these. */
export interface GuidanceCheckEntry {
  readonly target: GuidanceTarget;
  /** `TARGET_FILES[target]`: relative to the working tree root, POSIX separators. */
  readonly path: string;
  readonly state: GuidanceState;
  /**
   * The version recorded in the target's marker or version comments; null
   * when none can be read, and always null for `mcp-json`.
   */
  readonly installedVersion: number | null;
  /** The running guidance version (`GUIDANCE_VERSION`, or `CheckOptions.version`). */
  readonly currentVersion: number;
}

/** Options of `checkGuidance`. */
export interface CheckOptions {
  readonly cwd: string;
  /** Environment for `git rev-parse` (default `process.env`). */
  readonly env?: Env;
  /**
   * The running guidance version; default `GUIDANCE_VERSION`. Only tests
   * pass it, to simulate a newer CLI.
   */
  readonly version?: number;
  /**
   * `agents check --global`: also inspect the global files of `codex` and
   * `antigravity` (`globalConfigPath(target, env)`, which throws its usage
   * error when `HOME` or `CODEX_HOME` is unusable). Without it no global
   * file is read.
   */
  readonly global?: boolean;
}

/**
 * Checks the guidance in `workingTreeRoot(cwd, env)`. Returns one entry per
 * target found, in `GUIDANCE_TARGETS` order (an empty array when none is).
 * `v` below is the running version.
 *
 * - `claude`: found when `SKILL_PATH` exists and has a line containing
 *   `<!-- agentboard-guidance:` (a file without it is user content and is
 *   not reported). `installedVersion` is N when that line, trimmed, is
 *   exactly `skillMarker(N)`, else null. State: null version `modified`;
 *   N != v `stale`; content exactly `renderSkill(v)` `current`; else
 *   `modified`.
 * - `agents-md`: found when `AGENTS.md` has a marker-like line (see
 *   `installGuidance`). Malformed markers: `modified`, with
 *   `installedVersion` N when exactly one well-formed start line exists,
 *   else null. A pair recorded as N: N != v `stale`; the managed region
 *   exactly `renderAgentsBlock(v)` `current`; else `modified`.
 * - `openspec`: found when `OPENSPEC_CONFIG_PATH` parses and a string item
 *   starting with `OPENSPEC_PREFIX` exists in `operations.apply.guidance` or
 *   `operations.archive.guidance`. A file that fails to parse is found
 *   (state `modified`, version null) when its raw text contains
 *   `agentboard:`, else not found. `installedVersion` is N when every
 *   agentboard item carries the trailing comment `openSpecVersionComment(N)`
 *   with the same N, else null. State: null version `modified`; N != v
 *   `stale`; for both ops the agentboard items exactly
 *   `OPENSPEC_GUIDANCE[op]` in order `current`; else `modified`.
 * - `mcp-json`: found when `.mcp.json` parses as an object whose
 *   `mcpServers` object has an `agentboard` key. `installedVersion` null.
 *   State (board-agent-guidance: "Managed MCP entry"):
 *   `current` when the entry is a managed entry of either shape
 *   (`isManagedMcpEntry`: the default `npx` entry, or exactly `{command:
 *   <non-empty string>, args: ["mcp"]}`), else `modified` (extra keys such
 *   as `env`, other arguments). Never `stale`.
 * - `claude-hooks`: found when `.claude/settings.json` parses (a leading
 *   UTF-8 byte order mark skipped) as an object with an owned handler
 *   (see `installGuidance`, `claude-hooks`: a handler under
 *   `hooks.SessionStart`, `hooks.Stop` or `hooks.PreToolUse` whose command
 *   has a marker, `hookMarkerVersion`). A file that is not valid JSON, has
 *   a top level that is not an object, or whose `hooks` has an unexpected
 *   shape (`hooks-shape`) is found (state `modified`, version null) when
 *   its raw text contains `HOOKS_MARKER_TEXT`, else not found. A file with
 *   only user hooks, including ones that look like agentboard's but have
 *   no marker, is not found. `installedVersion` is N when every owned
 *   handler records the same N, else null. State: null version
 *   `modified`; N != v `stale`; `current` when each of the three keys
 *   holds exactly one owned group, every owned command parses
 *   (`parseHookCommand`) with the event of its key, the three name one
 *   executable and one mode, and each group is deep-equal to
 *   `hookGroup(key, { version: v, strict, command: executable })`; else
 *   `modified` (a hand-edited command that keeps its marker, a missing or
 *   duplicated entry, another timeout or matcher, an extra key, mixed
 *   modes or executables, an owned handler sharing a group with a user
 *   handler).
 * - `codex` and `antigravity` are never reported for `AGENTS.md`: the
 *   shared block is reported once, as `agents-md`. With `global` only:
 *   `codex` for `config.toml` (path `globalConfigPath('codex', env)`),
 *   found when it has a marker-like line (`# agentboard:start` or `#
 *   agentboard:end`, also in a file that is not strict UTF-8 or ends
 *   inside a multi-line construct, which is then `modified` with version
 *   null). Malformed markers: `modified` (version as for `agents-md`). A
 *   pair recorded as N: N != v `stale`; `current` when the region is
 *   exactly `renderCodexBlock(v, c)` for no `c` or the non-empty `c` it
 *   records and no `foreign-table` or `toml-shape` definition of the
 *   server exists outside the markers (Codex would then read two
 *   definitions); else `modified`. `antigravity` for `mcp_config.json`,
 *   exactly as `mcp-json` (`installedVersion` null).
 * - `cursor`: up to two entries, in this order: `.cursor/rules/agentboard.mdc`
 *   exactly as `claude` with `renderCursorRule(v)`, and `.cursor/mcp.json`
 *   exactly as `mcp-json` (`installedVersion` null), each reported with
 *   target `cursor` and its own path when found.
 * - `copilot`: `.github/copilot-instructions.md` exactly as `agents-md`
 *   with `renderAgentsBlock(v)`.
 *
 * Paths `agents install` would refuse, for every target:
 * - outside the tree (see `RefusalReason` `outside-tree`: the path with
 *   symlinks resolved is not inside the working tree root): never read and
 *   not reported, like a file agentboard does not own. A symlink that
 *   stays inside the tree is followed normally.
 * - not a regular file (a directory at the path): not reported, since
 *   nothing agentboard installs can be there.
 * - unreadable (`EACCES` or `EPERM` on read): reported as `modified` with
 *   `installedVersion` null, since whether it holds guidance cannot be
 *   known, so the command exits 1; `checkCommand` adds a warning naming it.
 * Never throws for these (no exit 5). A global file follows the same
 * rules except that it is outside the tree by design: a symbolic link
 * there is followed.
 */
export function checkGuidance(options: CheckOptions): GuidanceCheckEntry[] {
  return inspect(options).entries;
}

/** A target that could not be read: its relative path and the error code. */
interface Unreadable {
  readonly path: string;
  readonly code: string;
}

/** `checkGuidance`, plus the targets reported as modified because they could not be read. */
function inspect(options: CheckOptions): {
  entries: GuidanceCheckEntry[];
  unreadable: Unreadable[];
} {
  const env = options.env ?? process.env;
  const globals =
    options.global === true
      ? { codex: globalConfigPath('codex', env), antigravity: globalConfigPath('antigravity', env) }
      : null;
  const root = workingTreeRoot(options.cwd, env);
  const v = options.version ?? GUIDANCE_VERSION;
  const entries: GuidanceCheckEntry[] = [];
  const unreadable: Unreadable[] = [];
  for (const target of GUIDANCE_TARGETS) {
    for (const probe of probesOf(target, root, v, globals)) {
      const { where } = probe;
      if (where.kind !== 'ok') {
        continue;
      }
      let found: Found | null;
      try {
        found = probe.check(where.path);
      } catch (error) {
        const code = errorCode(error);
        if (code === null || !PERMISSION_CODES.includes(code)) {
          throw error;
        }
        unreadable.push({ path: probe.path, code });
        found = { state: 'modified', installedVersion: null };
      }
      if (found !== null) {
        entries.push({
          target,
          path: probe.path,
          state: found.state,
          installedVersion: found.installedVersion,
          currentVersion: v,
        });
      }
    }
  }
  return { entries, unreadable };
}

/** One file of a target to inspect: its reported path, where it is, and its check. */
interface Probe {
  readonly path: string;
  readonly where: TargetPath;
  readonly check: (resolved: string) => Found | null;
}

/** The files of `target` to inspect, in reporting order (see `checkGuidance`). */
function probesOf(
  target: GuidanceTarget,
  root: string,
  v: number,
  globals: { readonly codex: string; readonly antigravity: string } | null,
): Probe[] {
  const rel = TARGET_FILES[target];
  const project = (path: string, check: Probe['check']): Probe => ({
    path,
    where: targetPath(root, path),
    check,
  });
  switch (target) {
    case 'claude':
      return [project(rel, (path) => checkWholeFile(path, v, renderSkill))];
    case 'agents-md':
    case 'copilot':
      return [project(rel, (path) => checkBlock(path, v))];
    case 'openspec':
      return [project(rel, (path) => checkOpenSpec(path, v))];
    case 'mcp-json':
      return [project(rel, checkMcpFile)];
    case 'claude-hooks':
      return [project(rel, (path) => checkClaudeHooks(path, v))];
    case 'codex':
      return globals === null
        ? []
        : [
            {
              path: globals.codex,
              where: globalPath(globals.codex),
              check: (p) => checkCodexToml(p, v),
            },
          ];
    case 'antigravity':
      return globals === null
        ? []
        : [
            {
              path: globals.antigravity,
              where: globalPath(globals.antigravity),
              check: checkMcpFile,
            },
          ];
    case 'cursor':
      return [
        project(rel, (path) => checkWholeFile(path, v, renderCursorRule)),
        project(CURSOR_MCP_PATH, checkMcpFile),
      ];
  }
}

/** A target found by one of the checks below. */
interface Found {
  readonly state: GuidanceState;
  readonly installedVersion: number | null;
}

/**
 * The state of a versioned target recorded as `installed` (null when
 * unreadable) against the running version `v`; `matches` says whether its
 * managed text is exactly what `v` renders.
 */
function versionedState(
  installed: number | null,
  v: number,
  matches: () => boolean,
): GuidanceState {
  if (installed === null) {
    return 'modified';
  }
  if (installed !== v) {
    return 'stale';
  }
  return matches() ? 'current' : 'modified';
}

/** A file owned whole when it carries the skill marker: `SKILL.md` (`renderSkill`) and the Cursor rule (`renderCursorRule`). */
function checkWholeFile(
  path: string,
  v: number,
  render: (version: number) => string,
): Found | null {
  const text = readBytes(path);
  if (text === null || !hasSkillMarker(text)) {
    return null;
  }
  const installed = skillVersion(text);
  return {
    installedVersion: installed,
    state: versionedState(installed, v, () => text === render(v)),
  };
}

/** The managed `AGENTS.md` block in `AGENTS.md` or `.github/copilot-instructions.md`. */
function checkBlock(path: string, v: number): Found | null {
  const text = readBytes(path);
  if (text === null) {
    return null;
  }
  const markers = agentsMarkers(text);
  switch (markers.kind) {
    case 'none':
      return null;
    case 'malformed':
      return { state: 'modified', installedVersion: markers.version };
    case 'pair':
      return {
        installedVersion: markers.version,
        state: versionedState(
          markers.version,
          v,
          () => text.slice(markers.start, markers.end) === renderAgentsBlock(v),
        ),
      };
  }
}

/** The `codex` global `config.toml` (see `checkGuidance`). */
function checkCodexToml(path: string, v: number): Found | null {
  const raw = readBytes(path);
  if (
    raw === null ||
    !raw
      .split('\n')
      .some((l) => l.includes(CODEX_MARKERS.startText) || l.includes(CODEX_MARKERS.endText))
  ) {
    return null;
  }
  const read = readUtf8Text(path);
  if (read === null || read === 'invalid') {
    return { state: 'modified', installedVersion: null };
  }
  const scan = scanToml(read.text);
  if (scan.unterminated) {
    return { state: 'modified', installedVersion: null };
  }
  const markers = codexMarkers(read.text);
  if (markers.kind === 'none') {
    return null;
  }
  if (markers.kind === 'malformed') {
    return { state: 'modified', installedVersion: markers.version };
  }
  return {
    installedVersion: markers.version,
    state: versionedState(markers.version, v, () => {
      const region = read.text.slice(markers.start, markers.end);
      const managed = managedCodexCommand(region, v);
      const { foreign, shape } = serverDefinitions(scan, read.text.length);
      return managed !== null && region.includes('\r') === false && foreign.length === 0 && !shape;
    }),
  };
}

function checkOpenSpec(path: string, v: number): Found | null {
  const text = readText(path);
  if (text === null) {
    return null;
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    return text.includes(OPENSPEC_PREFIX) ? { state: 'modified', installedVersion: null } : null;
  }
  const items = openSpecItems(parsed.doc);
  const all = OPENSPEC_OPERATIONS.flatMap((op) => items[op]);
  if (all.length === 0) {
    return null;
  }
  const versions = new Set(all.map((item) => openSpecCommentVersion(item.comment)));
  const [only] = versions;
  const installed = versions.size === 1 && only !== undefined ? only : null;
  return {
    installedVersion: installed,
    state: versionedState(installed, v, () =>
      OPENSPEC_OPERATIONS.every((op) => {
        const want = OPENSPEC_GUIDANCE[op];
        const have = items[op];
        return have.length === want.length && have.every((item, i) => item.value === want[i]);
      }),
    ),
  };
}

/** The `mcpServers.agentboard` entry of `.mcp.json`, `.cursor/mcp.json` or Antigravity's `mcp_config.json`. */
function checkMcpFile(path: string): Found | null {
  const read = readUtf8Json(path);
  const config = read === null || read === 'invalid' ? null : parseMcpJson(read.text);
  const servers = config?.mcpServers;
  if (!isJsonObject(servers) || !Object.hasOwn(servers, MCP_SERVER_NAME)) {
    return null;
  }
  return {
    installedVersion: null,
    state: isManagedMcpEntry(servers[MCP_SERVER_NAME]) ? 'current' : 'modified',
  };
}

/** The `claude-hooks` check (see `checkGuidance`). */
function checkClaudeHooks(path: string, v: number): Found | null {
  const read = readUtf8Json(path);
  if (read === null) {
    return null;
  }
  const settings = read === 'invalid' ? null : parseMcpJson(read.text);
  if (settings === null || !hasHooksShape(settings)) {
    return (readBytes(path) ?? '').includes(HOOKS_MARKER_TEXT)
      ? { state: 'modified', installedVersion: null }
      : null;
  }
  const arrays = hookArrays(settings);
  const owned = arrays.flatMap(({ event, groups }) =>
    groups.flatMap((group) =>
      groupHandlers(group)
        .filter(isOwnedHandler)
        .map((handler) => ({ event, command: String(handler.command) })),
    ),
  );
  if (owned.length === 0) {
    return null;
  }
  const versions = new Set(owned.map((h) => hookMarkerVersion(h.command)));
  const [only] = versions;
  const installed = versions.size === 1 && only !== undefined ? only : null;
  return {
    installedVersion: installed,
    state: versionedState(installed, v, () => {
      const commands = owned.map((h) => ({ event: h.event, parsed: parseHookCommand(h.command) }));
      const executables = new Set(commands.map((c) => c.parsed?.executable));
      const modes = new Set(commands.map((c) => c.parsed?.strict));
      const [executable] = executables;
      const [strict] = modes;
      if (
        commands.some((c) => c.parsed === null || c.parsed.event !== c.event) ||
        executables.size !== 1 ||
        modes.size !== 1 ||
        strict === undefined
      ) {
        return false;
      }
      const options = {
        version: v,
        strict,
        ...(executable === null || executable === undefined ? {} : { command: executable }),
      };
      return (
        arrays.length === 3 &&
        arrays.every(({ key, groups }) => {
          const ownedGroups = groups.filter((group) => groupHandlers(group).some(isOwnedHandler));
          return ownedGroups.length === 1 && jsonEqual(ownedGroups[0], hookGroup(key, options));
        })
      );
    }),
  };
}

/**
 * The human output of `agents check`, plain ASCII, ending with a newline:
 * one line per entry, `<state> <target> <path> (installed v<N>, current
 * v<M>)`, with `installed unknown` for a null version; or, when `entries`
 * is empty, exactly `no agentboard guidance found in <root>`. Pure.
 */
export function renderGuidanceCheck(entries: readonly GuidanceCheckEntry[], root: string): string {
  if (entries.length === 0) {
    return `no agentboard guidance found in ${root}\n`;
  }
  return entries
    .map((e) => {
      const installed = e.installedVersion === null ? 'unknown' : `v${String(e.installedVersion)}`;
      return `${e.state} ${e.target} ${e.path} (installed ${installed}, current v${String(e.currentVersion)})\n`;
    })
    .join('');
}

/**
 * The `agents check` command (called by the registry): `checkGuidance`
 * with `cwd` and `env`; `json` is the entries array, `text` is
 * `renderGuidanceCheck`. When any entry is not `current`, `exitCode` is 1
 * and `warnings` holds, first, one line per unreadable target, `cannot read
 * <path> (<code>); reported as modified` with `<code>` `EACCES` or `EPERM`,
 * then one line, `<k> of <n> guidance target(s) are not current; run
 * agentboard agents install to rewrite them`. Otherwise exit 0 (also when
 * nothing was found).
 *
 * Whatever the states, when `AGENTS.md` at the working tree root (with
 * symbolic links resolved inside the tree, as for the targets) is larger
 * than `ANTIGRAVITY_RULES_FILE_LIMIT` (24576) bytes, `warnings` ends with
 * one line `AGENTS.md is <n> bytes; the Antigravity CLI reads at most 24
 * KB (24576 bytes) of a rules file, so it ignores the rest` and the exit
 * code is unchanged (board-agent-guidance: "Antigravity rules stay within
 * size limits"). `options.global` is `agents check --global`.
 */
export function checkCommand(
  cwd: string,
  env: Env,
  options: { readonly global?: boolean } = {},
): CommandOutput {
  const { entries, unreadable } = inspect({ cwd, env, global: options.global ?? false });
  const root = workingTreeRoot(cwd, env);
  const output: CommandOutput = {
    json: entries,
    text: renderGuidanceCheck(entries, root),
  };
  const notCurrent = entries.filter((e) => e.state !== 'current').length;
  const warnings =
    notCurrent === 0
      ? []
      : [
          ...unreadable.map((u) => `cannot read ${u.path} (${u.code}); reported as modified`),
          `${String(notCurrent)} of ${String(entries.length)} guidance target(s) are not current; run agentboard agents install to rewrite them`,
        ];
  const size = rulesFileSize(root);
  if (size > ANTIGRAVITY_RULES_FILE_LIMIT) {
    warnings.push(
      `${AGENTS_MD_PATH} is ${String(size)} bytes; the Antigravity CLI reads at most 24 KB (${String(ANTIGRAVITY_RULES_FILE_LIMIT)} bytes) of a rules file, so it ignores the rest`,
    );
  }
  return {
    ...output,
    ...(notCurrent === 0 ? {} : { exitCode: 1 }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * The size in bytes of `AGENTS.md` at the working tree `root` (symbolic
 * links resolved inside the tree, as for the targets), or 0 when there is
 * no such file or it cannot be measured.
 */
function rulesFileSize(root: string): number {
  const where = targetPath(root, AGENTS_MD_PATH);
  if (where.kind !== 'ok') {
    return 0;
  }
  try {
    return statSync(where.path).size;
  } catch {
    return 0;
  }
}
