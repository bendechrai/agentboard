/**
 * Reading the ownership markers and managed regions of installed guidance
 * (design.md: "Ownership markers"), shared by `agents install`
 * (`./install.ts`) and `agents check` (`./check.ts`). Internal to the
 * guidance module: not re-exported from the package entry point.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

import { BLOCK_END, OPENSPEC_OPERATIONS, OPENSPEC_PREFIX } from './installed-text.js';

/** The `code` of a Node.js system error, or null. */
export function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Error codes of a read or write the caller is not permitted to do. */
export const PERMISSION_CODES: readonly string[] = ['EACCES', 'EPERM'];

/** Symlinks followed before giving up (like the kernel's `ELOOP` limit). */
const MAX_LINKS = 40;

/**
 * `path` with every symlink resolved: `realpathSync` when it exists; for a
 * dangling symlink, the resolution of its target; otherwise the resolution
 * of its nearest existing ancestor with the rest of the path appended. Null
 * when resolution meets a symlink cycle (`ELOOP`, or more than `MAX_LINKS`
 * links followed).
 */
function resolvePath(path: string, links = 0): string | null {
  try {
    return realpathSync(path);
  } catch {
    // Missing, dangling, or not reachable: resolved by hand below.
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const parent = dirname(path);
    const code = errorCode(error);
    if (code === 'ELOOP') {
      return null;
    }
    if ((code === 'ENOENT' || code === 'ENOTDIR') && parent !== path) {
      const resolvedParent = resolvePath(parent, links);
      return resolvedParent === null ? null : join(resolvedParent, basename(path));
    }
    return path;
  }
  if (stat.isSymbolicLink()) {
    return links < MAX_LINKS
      ? resolvePath(resolve(dirname(path), readlinkSync(path)), links + 1)
      : null;
  }
  return path;
}

/**
 * Where a target's file is, checked against the working tree root:
 * - `ok`: `path` is the file with symlinks resolved, inside the tree, and
 *   is a regular file or does not exist yet (its nearest existing ancestor
 *   being a directory);
 * - `outside-tree`: `resolved` is not the root or inside it;
 * - `not-a-file`: something that is not a regular file is at the path
 *   (`EISDIR` for a directory, including a path resolving to the root
 *   itself), an ancestor is not a directory (`ENOTDIR`), or resolution
 *   meets a symlink cycle at the path or an ancestor (`ELOOP`, when
 *   `MAX_LINKS` links were followed without reaching a real path; round 3
 *   ruling: never reported as `ok`).
 *
 * Inside the tree means equal to `root` or starting with `root` plus the
 * path separator, so a sibling whose path only shares the root's leading
 * characters (`<root>-evil`) is `outside-tree`.
 */
export type TargetPath =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'outside-tree'; readonly resolved: string }
  | {
      readonly kind: 'not-a-file';
      readonly code: 'EISDIR' | 'ENOTDIR' | 'ELOOP';
      readonly what: string;
    };

/** Resolves `<root>/<rel>` and checks it (see `TargetPath`). Reads only. */
export function targetPath(root: string, rel: string): TargetPath {
  const resolved = resolvePath(join(root, rel));
  if (resolved === null) {
    return { kind: 'not-a-file', code: 'ELOOP', what: 'is caught in a symlink cycle' };
  }
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return { kind: 'outside-tree', resolved };
  }
  try {
    const stat = statSync(resolved);
    if (stat.isFile()) {
      return { kind: 'ok', path: resolved };
    }
    return {
      kind: 'not-a-file',
      code: 'EISDIR',
      what: stat.isDirectory() ? 'is a directory' : 'is not a regular file',
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTDIR') {
      return { kind: 'not-a-file', code, what: 'has a parent that is not a directory' };
    }
    if (code === 'ELOOP') {
      return { kind: 'not-a-file', code, what: 'is caught in a symlink cycle' };
    }
    if (code !== 'ENOENT') {
      // Not reachable (for example EACCES): the read or write reports it.
      return { kind: 'ok', path: resolved };
    }
  }
  for (let dir = dirname(resolved); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const isDir = statSync(dir).isDirectory();
      return isDir
        ? { kind: 'ok', path: resolved }
        : { kind: 'not-a-file', code: 'ENOTDIR', what: 'has a parent that is not a directory' };
    } catch {
      // Keep looking for the nearest existing ancestor.
    }
  }
  return { kind: 'ok', path: resolved };
}

/** Text a `SKILL.md` line contains when agentboard owns the file. */
export const SKILL_MARKER_TEXT = '<!-- agentboard-guidance:';

const START_TEXT = '<!-- agentboard:start';
const END_TEXT = '<!-- agentboard:end';
const WELL_FORMED_START = /^<!-- agentboard:start v(\d+) -->$/;
const SKILL_MARKER_LINE = /^<!-- agentboard-guidance: v(0|[1-9]\d*) -->$/;
const OPENSPEC_VERSION_COMMENT = /^agentboard-guidance: v(0|[1-9]\d*)$/;

/** Reads `path` byte for byte (latin1), or null when it does not exist. */
export function readBytes(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'latin1') : null;
}

/** Reads `path` as UTF-8, or null when it does not exist. */
export function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** A decimal string as a safe integer, or null. */
function toVersion(digits: string): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/** True when some line of `text` contains the `SKILL.md` ownership marker. */
export function hasSkillMarker(text: string): boolean {
  return text.includes(SKILL_MARKER_TEXT);
}

/**
 * The version of the first line of `text` holding the skill marker, when
 * that line, trimmed, is exactly `skillMarker(N)`; else null.
 */
export function skillVersion(text: string): number | null {
  const line = text.split('\n').find((l) => l.includes(SKILL_MARKER_TEXT));
  const match = line === undefined ? null : SKILL_MARKER_LINE.exec(line.trim());
  return match?.[1] === undefined ? null : toVersion(match[1]);
}

/** One line of a text with its offsets (`end` excludes the line break). */
interface Line {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    lines.push({ start, end, text: text.slice(start, end) });
    if (nl === -1) {
      break;
    }
    start = nl + 1;
  }
  return lines;
}

/** A marker-like line without its trailing `\r` and surrounding spaces and tabs. */
function bare(line: string): string {
  return line.replace(/\r$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * The managed-block markers of an `AGENTS.md` text:
 * - `none`: no marker-like line;
 * - `pair`: exactly one well-formed start line before exactly one
 *   well-formed end line; `start`/`end` delimit the managed region (from
 *   the first byte of the start line to the last byte of the end marker)
 *   and `version` is the start line's version;
 * - `malformed`: any other set of marker-like lines; `version` is the
 *   version of the only well-formed start line when there is exactly one,
 *   else null. `lines` holds the offsets of every marker-like line, line
 *   break included, for `--force` to remove.
 */
export type AgentsMarkers =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'pair';
      readonly start: number;
      readonly end: number;
      readonly version: number;
    }
  | {
      readonly kind: 'malformed';
      readonly version: number | null;
      readonly lines: readonly { readonly start: number; readonly end: number }[];
    };

/** Finds the managed-block markers of an `AGENTS.md` text. */
export function agentsMarkers(text: string): AgentsMarkers {
  const lines = linesOf(text);
  const markerLines = lines.filter((l) => l.text.includes(START_TEXT) || l.text.includes(END_TEXT));
  if (markerLines.length === 0) {
    return { kind: 'none' };
  }
  const starts = markerLines.filter((l) => WELL_FORMED_START.test(bare(l.text)));
  const ends = markerLines.filter((l) => bare(l.text) === BLOCK_END);
  const startLine = starts[0];
  const endLine = ends[0];
  const startDigits =
    startLine === undefined ? undefined : WELL_FORMED_START.exec(bare(startLine.text))?.[1];
  const version = starts.length === 1 && startDigits !== undefined ? toVersion(startDigits) : null;
  if (
    markerLines.length === 2 &&
    startLine !== undefined &&
    endLine !== undefined &&
    starts.length === 1 &&
    ends.length === 1 &&
    startLine.start < endLine.start &&
    version !== null
  ) {
    return {
      kind: 'pair',
      start: startLine.start,
      end: endLine.start + endLine.text.indexOf(BLOCK_END) + BLOCK_END.length,
      version,
    };
  }
  return {
    kind: 'malformed',
    version,
    lines: markerLines.map((l) => ({
      start: l.start,
      end: l.end < text.length ? l.end + 1 : l.end,
    })),
  };
}

/** A parsed `openspec/config.yaml`, or why it cannot be used. */
export type ParsedConfig =
  { readonly ok: true; readonly doc: Document } | { readonly ok: false; readonly why: string };

/**
 * Parses an OpenSpec config with the `yaml` Document API. Fails on parse
 * errors or a top level that is neither a map nor empty.
 */
export function parseConfig(text: string): ParsedConfig {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { ok: false, why: 'it is not valid YAML' };
  }
  const contents = doc.contents;
  if (contents !== null && !isMap(contents) && !(isScalar(contents) && contents.value === null)) {
    return { ok: false, why: 'its top level is not a map' };
  }
  return { ok: true, doc };
}

/** One agentboard item of an OpenSpec guidance list: its text and trailing comment. */
export interface OpenSpecItem {
  readonly value: string;
  readonly comment: string;
}

/** True when `node` is a string scalar that agentboard owns. */
export function isAgentboardItem(node: unknown): boolean {
  return isScalar(node) && typeof node.value === 'string' && node.value.startsWith(OPENSPEC_PREFIX);
}

/**
 * The agentboard items under `operations.<op>.guidance` of a parsed config,
 * per operation; an operation whose path does not lead to a list has none.
 */
export function openSpecItems(
  doc: Document,
): Record<(typeof OPENSPEC_OPERATIONS)[number], OpenSpecItem[]> {
  const result = { apply: [] as OpenSpecItem[], archive: [] as OpenSpecItem[] };
  for (const op of OPENSPEC_OPERATIONS) {
    const seq: unknown = isMap(doc.contents)
      ? doc.getIn(['operations', op, 'guidance'], true)
      : null;
    if (isSeq(seq)) {
      for (const item of seq.items) {
        if (isScalar(item) && isAgentboardItem(item)) {
          result[op].push({ value: String(item.value), comment: (item.comment ?? '').trim() });
        }
      }
    }
  }
  return result;
}

/** The version of an OpenSpec version comment (`agentboard-guidance: v<N>`), or null. */
export function openSpecCommentVersion(comment: string): number | null {
  const match = OPENSPEC_VERSION_COMMENT.exec(comment.trim());
  return match?.[1] === undefined ? null : toVersion(match[1]);
}

/** True when `value` is a JSON object (not null, not an array). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality of two JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    );
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return a === b;
}

/** Parses `.mcp.json` text: the top-level object, or null when unusable. */
export function parseMcpJson(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isJsonObject(value) ? value : null;
}

/**
 * True when `value` (an `mcpServers.agentboard` entry as parsed from
 * `.mcp.json`) is a managed entry (board-agent-guidance: "Managed MCP
 * entry"; add-mcp-command design.md: "Two managed shapes, both
 * recognised"), that is, exactly one of:
 * - the default entry, deep-equal to `MCP_ENTRY` (`jsonEqual`: key order
 *   ignored, no other key);
 * - an object with exactly the two keys `command` and `args` (in any
 *   order), `command` a non-empty string (any string: a name, an absolute
 *   path, a path with spaces; not otherwise checked) and `args` an array
 *   holding exactly the one string `"mcp"` (`MCP_LOCAL_ARGS`).
 * Anything else is unrecognised: an extra key (such as `env`), other or
 * additional arguments (such as `["mcp", "--as", "x"]`), a missing `args`,
 * an empty or non-string `command`, or a value that is not an object.
 * `agents install` refuses an unrecognised entry as `entry-differs` unless
 * `--force`, and `agents check` reports it `modified`. Pure.
 */
export function isManagedMcpEntry(value: unknown): boolean {
  throw new Error(`not implemented: isManagedMcpEntry(${typeof value})`);
}
