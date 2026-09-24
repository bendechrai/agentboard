/**
 * `agentboard agents check` (board-agent-guidance: "Checking installed
 * guidance"; add-agent-guidance task 3.3).
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
import type { GuidanceTarget } from './install.js';

/**
 * - `current`: the target is exactly what `agents install` would write now.
 * - `stale`: it was installed by another guidance version (older, or newer
 *   than the running CLI); `agents install` rewrites it.
 * - `modified`: its managed region was edited by hand (the recorded version
 *   is the running one but the text differs, or the version is unreadable,
 *   or the markers are malformed), or, for `mcp-json`, which carries no
 *   version, the entry differs from `MCP_ENTRY`.
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
 *   State: deep-equal to `MCP_ENTRY` `current`, else `modified`.
 */
export function checkGuidance(options: CheckOptions): GuidanceCheckEntry[] {
  void options;
  throw new Error('not implemented');
}

/**
 * The human output of `agents check`, plain ASCII, ending with a newline:
 * one line per entry, `<state> <target> <path> (installed v<N>, current
 * v<M>)`, with `installed unknown` for a null version; or, when `entries`
 * is empty, exactly `no agentboard guidance found in <root>`. Pure.
 */
export function renderGuidanceCheck(entries: readonly GuidanceCheckEntry[], root: string): string {
  void entries;
  void root;
  throw new Error('not implemented');
}

/**
 * The `agents check` command (called by the registry): `checkGuidance`
 * with `cwd` and `env`; `json` is the entries array, `text` is
 * `renderGuidanceCheck`. When any entry is not `current`, `exitCode` is 1
 * and `warnings` holds one line, `<k> of <n> guidance target(s) are not
 * current; run agentboard agents install to rewrite them`. Otherwise exit 0
 * (also when nothing was found).
 */
export function checkCommand(cwd: string, env: Env): CommandOutput {
  void cwd;
  void env;
  throw new Error('not implemented');
}
