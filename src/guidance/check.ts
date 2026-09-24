/**
 * `agentboard agents check` (board-agent-guidance: "Checking installed
 * guidance"; add-agent-guidance task 3.3; "Managed MCP entry",
 * add-mcp-command task 1.2).
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
 * `renderSkill`/`renderAgentsBlock`/`OPENSPEC_GUIDANCE` is `modified`. A
 * managed region whose version cannot be read at all is `modified`.
 */

import type { CommandOutput, Env } from '../cli/types.js';
import { GUIDANCE_TARGETS, TARGET_FILES, workingTreeRoot, type GuidanceTarget } from './install.js';
import {
  GUIDANCE_VERSION,
  MCP_SERVER_NAME,
  OPENSPEC_GUIDANCE,
  OPENSPEC_OPERATIONS,
  OPENSPEC_PREFIX,
  renderAgentsBlock,
  renderSkill,
} from './installed-text.js';
import {
  PERMISSION_CODES,
  agentsMarkers,
  errorCode,
  hasSkillMarker,
  isJsonObject,
  isManagedMcpEntry,
  openSpecCommentVersion,
  openSpecItems,
  parseConfig,
  parseMcpJson,
  readBytes,
  readText,
  skillVersion,
  targetPath,
} from './markers.js';

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
 *   State (add-mcp-command; board-agent-guidance: "Managed MCP entry"):
 *   `current` when the entry is a managed entry of either shape
 *   (`isManagedMcpEntry`: the default `npx` entry, or exactly `{command:
 *   <non-empty string>, args: ["mcp"]}`), else `modified` (extra keys such
 *   as `env`, other arguments). Never `stale`.
 *
 * Paths `agents install` would refuse (orchestrator ruling, group 3 round
 * 2), for every target:
 * - outside the tree (see `RefusalReason` `outside-tree`: the path with
 *   symlinks resolved is not inside the working tree root): never read and
 *   not reported, like a file agentboard does not own. A symlink that
 *   stays inside the tree is followed normally.
 * - not a regular file (a directory at the path): not reported, since
 *   nothing agentboard installs can be there.
 * - unreadable (`EACCES` or `EPERM` on read): reported as `modified` with
 *   `installedVersion` null, since whether it holds guidance cannot be
 *   known, so the command exits 1; `checkCommand` adds a warning naming it.
 * Never throws for these (no exit 5).
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
  const root = workingTreeRoot(options.cwd, options.env ?? process.env);
  const v = options.version ?? GUIDANCE_VERSION;
  const entries: GuidanceCheckEntry[] = [];
  const unreadable: Unreadable[] = [];
  for (const target of GUIDANCE_TARGETS) {
    const rel = TARGET_FILES[target];
    const where = targetPath(root, rel);
    if (where.kind !== 'ok') {
      continue;
    }
    let found: Found | null;
    try {
      found = checkTarget(target, where.path, v);
    } catch (error) {
      const code = errorCode(error);
      if (code === null || !PERMISSION_CODES.includes(code)) {
        throw error;
      }
      unreadable.push({ path: rel, code });
      found = { target, state: 'modified', installedVersion: null };
    }
    if (found !== null) {
      entries.push({
        target,
        path: rel,
        state: found.state,
        installedVersion: found.installedVersion,
        currentVersion: v,
      });
    }
  }
  return { entries, unreadable };
}

/** Runs the check of `target` on its resolved file `path`. */
function checkTarget(target: GuidanceTarget, path: string, v: number): Found | null {
  switch (target) {
    case 'claude':
      return checkSkill(path, v);
    case 'agents-md':
      return checkAgentsMd(path, v);
    case 'openspec':
      return checkOpenSpec(path, v);
    case 'mcp-json':
      return checkMcpJson(path);
  }
}

/** A target found by one of the checks below. */
interface Found {
  readonly target: GuidanceTarget;
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

function checkSkill(path: string, v: number): Found | null {
  const text = readBytes(path);
  if (text === null || !hasSkillMarker(text)) {
    return null;
  }
  const installed = skillVersion(text);
  return {
    target: 'claude',
    installedVersion: installed,
    state: versionedState(installed, v, () => text === renderSkill(v)),
  };
}

function checkAgentsMd(path: string, v: number): Found | null {
  const text = readBytes(path);
  if (text === null) {
    return null;
  }
  const markers = agentsMarkers(text);
  switch (markers.kind) {
    case 'none':
      return null;
    case 'malformed':
      return { target: 'agents-md', state: 'modified', installedVersion: markers.version };
    case 'pair':
      return {
        target: 'agents-md',
        installedVersion: markers.version,
        state: versionedState(
          markers.version,
          v,
          () => text.slice(markers.start, markers.end) === renderAgentsBlock(v),
        ),
      };
  }
}

function checkOpenSpec(path: string, v: number): Found | null {
  const text = readText(path);
  if (text === null) {
    return null;
  }
  const parsed = parseConfig(text);
  if (!parsed.ok) {
    return text.includes(OPENSPEC_PREFIX)
      ? { target: 'openspec', state: 'modified', installedVersion: null }
      : null;
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
    target: 'openspec',
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

function checkMcpJson(path: string): Found | null {
  const text = readText(path);
  const config = text === null ? null : parseMcpJson(text);
  const servers = config?.mcpServers;
  if (!isJsonObject(servers) || !Object.hasOwn(servers, MCP_SERVER_NAME)) {
    return null;
  }
  return {
    target: 'mcp-json',
    installedVersion: null,
    state: isManagedMcpEntry(servers[MCP_SERVER_NAME]) ? 'current' : 'modified',
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
 */
export function checkCommand(cwd: string, env: Env): CommandOutput {
  const { entries, unreadable } = inspect({ cwd, env });
  const output: CommandOutput = {
    json: entries,
    text: renderGuidanceCheck(entries, workingTreeRoot(cwd, env)),
  };
  const notCurrent = entries.filter((e) => e.state !== 'current').length;
  if (notCurrent === 0) {
    return output;
  }
  return {
    ...output,
    exitCode: 1,
    warnings: [
      ...unreadable.map((u) => `cannot read ${u.path} (${u.code}); reported as modified`),
      `${String(notCurrent)} of ${String(entries.length)} guidance target(s) are not current; run agentboard agents install to rewrite them`,
    ],
  };
}
