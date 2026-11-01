/**
 * Reading the ownership markers and managed regions of installed guidance
 * (add-agent-guidance design.md: "Ownership markers"), shared by `agents
 * install` (`./install.ts`) and `agents check` (`./check.ts`). Internal to
 * the guidance module: not re-exported from the package entry point.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

import {
  BLOCK_END,
  CLAUDE_HOOK_EVENTS,
  CODEX_BLOCK_END,
  type ClaudeHookEvent,
  type ClaudeHookKey,
  HOOK_DEFAULT_EXECUTABLE,
  MCP_ENTRY,
  MCP_LOCAL_ARGS,
  OPENSPEC_OPERATIONS,
  OPENSPEC_PREFIX,
  hookExecutable,
} from './installed-text.js';

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
 *   `MAX_LINKS` links were followed without reaching a real path; never
 *   reported as `ok`).
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
  return locatePath(resolved);
}

/**
 * Where a global file is (design.md "Rulings from task group 4": a global
 * file is outside the tree by design, so a symbolic link there is followed
 * and kept): `path`, absolute, with symlinks resolved and checked as
 * `targetPath` checks a target, except that it is never `outside-tree`.
 * Reads only.
 */
export function globalPath(path: string): TargetPath {
  const resolved = resolvePath(path);
  if (resolved === null) {
    return { kind: 'not-a-file', code: 'ELOOP', what: 'is caught in a symlink cycle' };
  }
  return locatePath(resolved);
}

/** `resolved` (symlinks already resolved) checked for being a file or a place one can be written. */
function locatePath(resolved: string): TargetPath {
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

/**
 * The syntax of a managed block's markers: the texts a marker-like line
 * contains, the well-formed start line (its version captured) and the
 * well-formed end line.
 */
export interface MarkerSyntax {
  readonly startText: string;
  readonly endText: string;
  readonly wellFormedStart: RegExp;
  readonly end: string;
}

/** The `AGENTS.md` (and `.github/copilot-instructions.md`) markers. */
export const AGENTS_MARKERS: MarkerSyntax = {
  startText: '<!-- agentboard:start',
  endText: '<!-- agentboard:end',
  wellFormedStart: /^<!-- agentboard:start v(\d+) -->$/,
  end: BLOCK_END,
};

/** The markers of the block in Codex's `config.toml` (TOML comments). */
export const CODEX_MARKERS: MarkerSyntax = {
  startText: '# agentboard:start',
  endText: '# agentboard:end',
  wellFormedStart: /^# agentboard:start v(\d+)$/,
  end: CODEX_BLOCK_END,
};

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

/**
 * A marker-like line without its trailing `\r` and surrounding spaces and
 * tabs. Trimmed by index, not by a regular expression: `[ \t]+$` tried at
 * every position of a 200 KB line of blanks is quadratic (review round 1
 * of task group 4, R5), and a marker-like line can be any length.
 */
function bare(line: string): string {
  let end = line.endsWith('\r') ? line.length - 1 : line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    end -= 1;
  }
  let start = 0;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) {
    start += 1;
  }
  return line.slice(start, end);
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
  return blockMarkers(text, AGENTS_MARKERS);
}

/**
 * Finds the managed-block markers of `text` for the marker `syntax`
 * (`AGENTS_MARKERS` or `CODEX_MARKERS`): a marker-like line is one
 * containing `syntax.startText` or `syntax.endText`, wherever it is (also
 * inside a TOML multi-line string, so a doubtful file is refused rather
 * than edited); it is well formed when, without a trailing `\r` and
 * surrounding spaces and tabs, it matches `syntax.wellFormedStart` or is
 * exactly `syntax.end`. See `AgentsMarkers` for the result.
 */
export function blockMarkers(text: string, syntax: MarkerSyntax): AgentsMarkers {
  const lines = linesOf(text);
  const markerLines = lines.filter(
    (l) => l.text.includes(syntax.startText) || l.text.includes(syntax.endText),
  );
  if (markerLines.length === 0) {
    return { kind: 'none' };
  }
  const starts = markerLines.filter((l) => syntax.wellFormedStart.test(bare(l.text)));
  const ends = markerLines.filter((l) => bare(l.text) === syntax.end);
  const startLine = starts[0];
  const endLine = ends[0];
  const startDigits =
    startLine === undefined ? undefined : syntax.wellFormedStart.exec(bare(startLine.text))?.[1];
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
      end: endLine.start + endLine.text.indexOf(syntax.end) + syntax.end.length,
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
  if (jsonEqual(value, MCP_ENTRY)) {
    return true;
  }
  if (!isJsonObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof value.command === 'string' &&
    value.command !== '' &&
    jsonEqual(value.args, MCP_LOCAL_ARGS)
  );
}

/**
 * The guidance version of an agentboard hook command: N when `command` is
 * a string whose last characters are exactly `# agentboard-hooks: v<N>`
 * (`hooksMarker(N)`, N written without leading zeros, nothing after it, not
 * even a space or a line break); else null, and the command is not
 * agentboard's (board-agent-guidance "Installed guidance never clobbers
 * user content": a hook entry is owned only when its command ends with the
 * marker). So `#agentboard-hooks: v3`, `# agentboard-hooks: v03`,
 * `# agentboard-hooks: v3 ` and a marker followed by more shell text all
 * give null. Pure.
 */
export function hookMarkerVersion(command: unknown): number | null {
  if (typeof command !== 'string') {
    return null;
  }
  const match = HOOK_MARKER_AT_END.exec(command);
  return match?.[1] === undefined ? null : toVersion(match[1]);
}

/** The marker at the very end of a hook command, capturing its version. */
const HOOK_MARKER_AT_END = /# agentboard-hooks: v(0|[1-9]\d*)$/;

/**
 * A whole hook command as `hookCommand` renders it: the executable (the
 * default command line, one unquoted shell-safe word, or one single-quoted
 * word), ` hook `, the event, an optional ` --strict`, a space and the
 * marker. Groups: executable text, event, `--strict`, version.
 */
const HOOK_COMMAND = new RegExp(
  `^(${HOOK_DEFAULT_EXECUTABLE.replaceAll(/[.+@/-]/g, '\\$&')}|[A-Za-z0-9_./@%+:,][A-Za-z0-9_./@%+:,-]*|'(?:[^']|'\\\\'')*')` +
    ` hook (${CLAUDE_HOOK_EVENTS.map((e) => e.event).join('|')})( --strict)? # agentboard-hooks: v(0|[1-9]\\d*)$`,
);

/** An agentboard hook command taken apart (see `parseHookCommand`). */
export interface ParsedHookCommand {
  /**
   * The `--command` executable the command was rendered for (unquoted), or
   * null when it runs `HOOK_DEFAULT_EXECUTABLE`.
   */
  readonly executable: string | null;
  readonly event: ClaudeHookEvent;
  readonly strict: boolean;
  readonly version: number;
}

/**
 * Takes apart a command that `hookCommand` could have rendered: the
 * result is non-null exactly when `hookCommand(event, { version, strict,
 * command: executable ?? undefined })` is `command` itself, character for
 * character (so a command with `--as`, two spaces, another event, an
 * executable text that `hookExecutable` would not produce, such as
 * `bunx agentboard` or a badly quoted word, gives null). Pure.
 */
export function parseHookCommand(command: string): ParsedHookCommand | null {
  const match = HOOK_COMMAND.exec(command);
  if (match === null) {
    return null;
  }
  const [, text = '', event = '', strict, digits = ''] = match;
  const version = toVersion(digits);
  if (version === null || !isHookEvent(event)) {
    return null;
  }
  let executable: string | null;
  if (text === HOOK_DEFAULT_EXECUTABLE) {
    executable = null;
  } else {
    executable = text.startsWith("'") ? text.slice(1, -1).replaceAll("'\\''", "'") : text;
    if (hookExecutable(executable) !== text) {
      return null;
    }
  }
  return { executable, event, strict: strict !== undefined, version };
}

function isHookEvent(value: string): value is ClaudeHookEvent {
  return CLAUDE_HOOK_EVENTS.some((e) => e.event === value);
}

/**
 * True when the `hooks` of a parsed settings object has the shape
 * agentboard can merge into: absent, or an object whose `SessionStart`,
 * `Stop` and `PreToolUse`, where present, are arrays (`hooks-shape`
 * otherwise; other keys of `hooks` may hold anything).
 */
export function hasHooksShape(settings: Record<string, unknown>): boolean {
  if (!Object.hasOwn(settings, 'hooks')) {
    return true;
  }
  const hooks = settings.hooks;
  return (
    isJsonObject(hooks) &&
    CLAUDE_HOOK_EVENTS.every(({ key }) => !Object.hasOwn(hooks, key) || Array.isArray(hooks[key]))
  );
}

/**
 * The handlers of one element of a `hooks.<key>` array: the elements of
 * its `hooks` array when it is an object holding one, else none (an
 * element of any other shape is user content with no handler).
 */
export function groupHandlers(group: unknown): readonly unknown[] {
  return isJsonObject(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [];
}

/** True when `handler` is an object whose `command` ends with the marker (`hookMarkerVersion`). */
export function isOwnedHandler(handler: unknown): handler is Record<string, unknown> {
  return isJsonObject(handler) && hookMarkerVersion(handler.command) !== null;
}

/**
 * The `hooks.<key>` arrays of a settings object whose hooks have the
 * expected shape (`hasHooksShape`), for the keys present, in
 * `CLAUDE_HOOK_EVENTS` order.
 */
export function hookArrays(
  settings: Record<string, unknown>,
): { key: ClaudeHookKey; event: ClaudeHookEvent; groups: unknown[] }[] {
  const hooks = settings.hooks;
  if (!isJsonObject(hooks)) {
    return [];
  }
  return CLAUDE_HOOK_EVENTS.flatMap(({ key, event }) => {
    const groups = hooks[key];
    return Array.isArray(groups) ? [{ key, event, groups: groups as unknown[] }] : [];
  });
}

/**
 * Reads `path` as strict UTF-8 (`TextDecoder('utf-8', { fatal: true })`)
 * after removing one leading byte order mark (EF BB BF): `null` when the
 * file does not exist, `invalid` when the bytes are not valid UTF-8 (a
 * Latin-1 byte, an overlong sequence, an encoded surrogate, a truncated
 * sequence) or when the text is nested more than `MAX_JSON_DEPTH` levels
 * deep (`jsonDepth`), else the text without the mark and whether it had
 * one. The depth is checked before anything parses or scans the text, so
 * a file deep enough to exhaust the stack is refused like invalid JSON
 * instead of failing the run. Used
 * for `.claude/settings.json` and `.mcp.json`, which agentboard rewrites,
 * so a byte it cannot read is never turned into U+FFFD and written back.
 * Permission errors propagate as from `readFileSync`.
 */
export function readUtf8Json(
  path: string,
): { readonly text: string; readonly bom: boolean } | 'invalid' | null {
  const read = readUtf8Text(path);
  if (read === null || read === 'invalid') {
    return read;
  }
  return jsonDepth(read.text) > MAX_JSON_DEPTH ? 'invalid' : read;
}

/**
 * Reads `path` as strict UTF-8 after removing one leading byte order mark
 * (as `readUtf8Json`, without the depth check): `null` when the file does
 * not exist, `invalid` when the bytes are not valid UTF-8, else the text
 * without the mark and whether it had one. Used for Codex's `config.toml`,
 * whose text is edited by line and written back as UTF-8, so a byte that
 * cannot be read is never turned into U+FFFD. Permission errors propagate.
 */
export function readUtf8Text(
  path: string,
): { readonly text: string; readonly bom: boolean } | 'invalid' | null {
  if (!existsSync(path)) {
    return null;
  }
  const bytes = readFileSync(path);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
    return { text, bom };
  } catch {
    return 'invalid';
  }
}

/**
 * The deepest nesting `.claude/settings.json` and `.mcp.json` may have:
 * a file nested deeper is read as `invalid` (`readUtf8Json`). Well below
 * the depth at which `JSON.stringify` or any recursive walk exhausts the
 * stack (about 5,000), and far above any real settings file.
 */
export const MAX_JSON_DEPTH = 512;

/**
 * The deepest nesting of arrays and objects in `text`: the largest number
 * of `[` and `{` open at once, counting only brackets outside strings (a
 * string runs from a `"` to the next `"` not escaped by a backslash, so
 * `\"` and `\\` inside it are skipped as pairs). `0` for a scalar or
 * empty text, `1` for `[]` or `{"a": 1}`, `3` for `{"a": [[]]}`. Text that
 * is not valid JSON still gets a number (the most brackets open at any
 * point, a closing bracket never taking the count below 0; `[[[` is 3).
 * Iterative: never throws, whatever the depth (a million nested arrays
 * give 1000000). Pure.
 */
export function jsonDepth(text: string): number {
  let open = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      open += 1;
      if (open > deepest) {
        deepest = open;
      }
    } else if ((c === ']' || c === '}') && open > 0) {
      open -= 1;
    }
  }
  return deepest;
}

/**
 * True when `JSON.stringify(JSON.parse(text))` would give back every
 * value and the key order of `text` (valid JSON, without a byte order
 * mark), that is when `text` has none of:
 * - a number literal whose exact decimal value differs from that of the
 *   literal `JSON.stringify` writes for it (`1e400` and `-1e400`, which
 *   become `null`; `12345678901234567890`; `0.10000000000000000001`;
 *   `18446744073709551616`, written `18446744073709552000`); literals that
 *   only spell the same value differently (`1.0`, `1e2`, `2.5E-3`, `-5`)
 *   are fine;
 * - `-0` in any spelling (`-0`, `-0.0`, `-0e5`);
 * - a key that appears twice in one object, at any depth;
 * - an object whose array-index keys (canonical decimal strings `"0"` to
 *   `"4294967294"`) are not all before its other keys in ascending
 *   numeric order, which JavaScript would reorder (`{"b":1,"10":2}`,
 *   `{"10":1,"2":2}`); `"01"`, `"-1"` and `"4294967295"` are ordinary keys.
 * Pure; never throws for valid JSON, at any depth: the scan keeps its own
 * stack rather than recursing, so a document nested a hundred thousand
 * levels deep gets an answer like any other.
 */
export function jsonRewriteIsLossless(text: string): boolean {
  return new LosslessScan(text).value();
}

/** The largest array index: an object key that is a canonical decimal up to it is reordered by JavaScript. */
const MAX_ARRAY_INDEX = 4294967294;
const ARRAY_INDEX_KEY = /^(?:0|[1-9]\d*)$/;
const NUMBER_LITERAL = /^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/;

/**
 * A decimal value in normal form, for comparing a JSON number literal with
 * what `JSON.stringify` writes for it: the significant digits without
 * leading or trailing zeros, and the power of ten of the last digit. Zero
 * has no digits and exponent 0. Null for `null` (a literal out of range)
 * or for text that is not a number literal.
 */
function decimalOf(
  literal: string,
): { negative: boolean; digits: string; exponent: number } | null {
  const match = NUMBER_LITERAL.exec(literal);
  if (match === null) {
    return null;
  }
  const [, whole = '', fraction = '', exp = '0'] = match;
  let digits = `${whole}${fraction}`;
  let exponent = Number(exp) - fraction.length;
  digits = digits.replace(/^0+/, '');
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailing > 0) {
    digits = digits.slice(0, -trailing);
    exponent += trailing;
  }
  if (digits === '') {
    exponent = 0;
  }
  return { negative: literal.startsWith('-'), digits, exponent };
}

/** True when the number literal `literal` is written back by `JSON.stringify` with the same value and sign. */
function numberRoundTrips(literal: string): boolean {
  const value = Number(literal);
  if (Object.is(value, -0)) {
    return false;
  }
  const written = decimalOf(JSON.stringify(value));
  const given = decimalOf(literal);
  return (
    written !== null &&
    given !== null &&
    written.digits === given.digits &&
    written.exponent === given.exponent &&
    (written.digits === '' || written.negative === given.negative)
  );
}

/** An open object during a `LosslessScan`: its keys so far and their order. */
interface ObjectFrame {
  readonly kind: 'object';
  readonly seen: Set<string>;
  /** The last array-index key seen, -1 before any. */
  lastIndex: number;
  /** True once a key that is not an array index was seen. */
  ordinarySeen: boolean;
}

/** A container open during a `LosslessScan`. */
type Frame = ObjectFrame | { readonly kind: 'array' };

/**
 * A scan of valid JSON text (`jsonRewriteIsLossless`): walks the values
 * once, checking every number literal (`numberRoundTrips`) and every
 * object's keys (duplicates; array-index keys first and ascending). The
 * open containers live on an explicit stack, so the scan never recurses
 * and a document of any depth is scanned without touching the call stack.
 */
class LosslessScan {
  private at = 0;

  constructor(private readonly text: string) {}

  /** Scans the whole document; false at the first lossy construct. */
  value(): boolean {
    const stack: Frame[] = [];
    for (;;) {
      // A value is expected here.
      this.space();
      const c = this.text[this.at] ?? '';
      if (c === '{') {
        this.at += 1;
        this.space();
        if (this.text[this.at] === '}') {
          this.at += 1;
        } else {
          const frame: ObjectFrame = {
            kind: 'object',
            seen: new Set(),
            lastIndex: -1,
            ordinarySeen: false,
          };
          stack.push(frame);
          if (!this.scanKey(frame)) {
            return false;
          }
          continue;
        }
      } else if (c === '[') {
        this.at += 1;
        this.space();
        if (this.text[this.at] === ']') {
          this.at += 1;
        } else {
          stack.push({ kind: 'array' });
          continue;
        }
      } else if (!this.scanScalar(c)) {
        return false;
      }
      // A value is complete: close the containers it ends, or move to the next member.
      for (;;) {
        const top = stack.at(-1);
        if (top === undefined) {
          return true;
        }
        this.space();
        const d = this.text[this.at];
        this.at += 1;
        if (d === ',') {
          if (top.kind === 'object') {
            this.space();
            if (!this.scanKey(top)) {
              return false;
            }
          }
          break;
        }
        stack.pop(); // ']' or '}'
      }
    }
  }

  private space(): void {
    while (this.at < this.text.length && ' \t\n\r'.includes(this.text[this.at] ?? '')) {
      this.at += 1;
    }
  }

  /** Consumes a string, number or word starting with `c`; false for a number that does not round-trip. */
  private scanScalar(c: string): boolean {
    if (c === '"') {
      this.scanString();
      return true;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const literal = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.at))?.[0] ?? '';
      this.at += literal.length;
      return numberRoundTrips(literal);
    }
    const word = /^(?:true|false|null)/.exec(this.text.slice(this.at))?.[0] ?? '';
    this.at += word.length;
    return true;
  }

  /** Consumes a string token, returning its decoded value. */
  private scanString(): string {
    const start = this.at;
    this.at += 1;
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      this.at += this.text[this.at] === '\\' ? 2 : 1;
    }
    this.at += 1;
    return JSON.parse(this.text.slice(start, this.at)) as string;
  }

  /**
   * Consumes one member key of `frame` and its `:`; false when the key
   * repeats an earlier one or breaks the array-index order.
   */
  private scanKey(frame: ObjectFrame): boolean {
    const key = this.scanString();
    if (frame.seen.has(key)) {
      return false;
    }
    frame.seen.add(key);
    if (ARRAY_INDEX_KEY.test(key) && Number(key) <= MAX_ARRAY_INDEX) {
      if (frame.ordinarySeen || Number(key) <= frame.lastIndex) {
        return false;
      }
      frame.lastIndex = Number(key);
    } else {
      frame.ordinarySeen = true;
    }
    this.space();
    this.at += 1; // ':'
    return true;
  }
}
