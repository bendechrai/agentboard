/**
 * The line scan of Codex's global `config.toml` (design.md decision 5 and
 * "Rulings from task group 4 (test author)": the Codex block, the TOML
 * line scan, `foreign-table` and `toml-shape`). Internal to the guidance
 * module, shared by `agents install --global` (`./install.ts`) and
 * `agents check --global` (`./check.ts`).
 *
 * The file is never parsed into a document and rewritten: every edit is a
 * line edit on the text, so comments, CRLF line ends, a byte order mark
 * and odd formatting survive byte for byte. What the scan does is find
 * table headers and keys outside TOML strings, comments and multi-line
 * arrays and inline tables, so that a definition of the agentboard server
 * outside the markers is found wherever it is, and a header or key inside
 * a string is not mistaken for one. It is one pass over the text, linear
 * in its length, with no regular expression over more than one line.
 */

import { CODEX_MARKERS, blockMarkers, type AgentsMarkers, type MarkerSyntax } from './markers.js';
import {
  CODEX_TABLE,
  MCP_SERVER_NAME,
  renderCodexBlock,
  tomlBasicString,
} from './installed-text.js';

/** What a physical line of a TOML text is, decided where it starts. */
export type TomlLineKind =
  'blank' | 'comment' | 'header' | 'array-header' | 'keyval' | 'continuation' | 'other';

/** One physical line of a scanned TOML text. */
export interface TomlLine {
  /** Offset of its first character. */
  readonly start: number;
  /** Offset of its line feed, or the text's length for the last line. */
  readonly end: number;
  /** The line without its line feed (a trailing `\r` stays). */
  readonly text: string;
  /**
   * `continuation` when the line starts inside a multi-line string, an
   * array or an inline table opened on an earlier line; `header` for
   * `[k]`, `array-header` for `[[k]]`, `keyval` for `k = ...`; `other` for
   * a line that starts a statement the scan cannot read (invalid TOML).
   */
  readonly kind: TomlLineKind;
  /**
   * The decoded dotted key of a header, array header or key/value line
   * (bare parts as they are, quoted parts decoded, whitespace around the
   * dots dropped, case kept); null for the other kinds.
   */
  readonly key: readonly string[] | null;
  /**
   * For a key/value line, the current table (the last header's key, or
   * none at the top) followed by `key`; null for the other kinds.
   */
  readonly fullKey: readonly string[] | null;
}

/** The result of `scanToml`. */
export interface TomlScan {
  readonly lines: readonly TomlLine[];
  /**
   * True when the text ends inside a multi-line string, an array or an
   * inline table, so that text appended to it would land inside.
   */
  readonly unterminated: boolean;
  /**
   * True when some line could not be fully read (review round 1 of task
   * group 4, R4): a statement that is no header and no key/value line
   * (kind `other`), or an escape in a basic string, key or value, other
   * than `\b \t \n \f \r \e \" \\`, a valid `\uXXXX` or `\UXXXXXXXX` and a
   * multi-line string's line-ending backslash.
   */
  readonly unreadable: boolean;
}

/** The state of a string the scan is inside. */
interface OpenString {
  readonly kind: 'basic' | 'literal';
  readonly multi: boolean;
}

/** A dotted key read from `text` at `from`: its parts and where it ended. */
interface ParsedKey {
  readonly parts: string[];
  readonly next: number;
}

/** A bare key, matched in place (sticky) so a long line is never copied per key part. */
const BARE_KEY = /[A-Za-z0-9_-]+/y;
const HEX = /^[0-9A-Fa-f]+$/;

/**
 * The length of the escape sequence starting at the backslash `text[at]`
 * inside a basic string (the backslash included), or 0 when it is not one
 * TOML knows: a short escape, `\uXXXX`, `\UXXXXXXXX`, or, when `multi`, a
 * backslash followed by blanks and a line feed (the line-ending
 * backslash).
 */
function escapeLength(text: string, at: number, multi: boolean): number {
  const e = text[at + 1] ?? '';
  if ('btnfre"\\'.includes(e) && e !== '') {
    return 2;
  }
  const width = e === 'u' ? 4 : e === 'U' ? 8 : 0;
  if (width > 0) {
    const hex = text.slice(at + 2, at + 2 + width);
    if (hex.length !== width || !HEX.test(hex)) {
      return 0;
    }
    const code = Number.parseInt(hex, 16);
    return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0 : 2 + width;
  }
  if (multi) {
    let i = at + 1;
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') {
      i += 1;
    }
    if (text[i] === '\n') {
      return i + 1 - at;
    }
  }
  return 0;
}

/** `from` moved past spaces and tabs. */
function skipBlanks(text: string, from: number): number {
  let i = from;
  while (text[i] === ' ' || text[i] === '\t') {
    i += 1;
  }
  return i;
}

/**
 * Decodes the escapes of a TOML basic string's content (`\b \t \n \f \r
 * \e \" \\ \uXXXX \UXXXXXXXX`); null for an unknown escape or a bad code.
 */
function decodeBasicContent(content: string): string | null {
  let out = '';
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    i += 1;
    const e = content[i] ?? '';
    const simple: Record<string, string> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      e: '\u001b',
      '"': '"',
      '\\': '\\',
    };
    if (Object.hasOwn(simple, e)) {
      out += simple[e];
      continue;
    }
    const width = e === 'u' ? 4 : e === 'U' ? 8 : 0;
    const hex = width === 0 ? '' : content.slice(i + 1, i + 1 + width);
    if (width === 0 || hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) {
      return null;
    }
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return null;
    }
    out += String.fromCodePoint(code);
    i += width;
  }
  return out;
}

/**
 * The one-line string literal starting at `text[from]` (a `"` or `'`):
 * its decoded value and the offset after its closing quote; null when it
 * does not close on the line or holds a bad escape.
 */
function readQuoted(text: string, from: number): { value: string; next: number } | null {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && quote === '"') {
      i += 2;
      continue;
    }
    if (c === quote) {
      const raw = text.slice(from + 1, i);
      const value = quote === '"' ? decodeBasicContent(raw) : raw;
      return value === null ? null : { value, next: i + 1 };
    }
    i += 1;
  }
  return null;
}

/** Reads a dotted key at `from` (blanks around the dots allowed); null when none is there. */
function parseKey(text: string, from: number): ParsedKey | null {
  const parts: string[] = [];
  let i = from;
  for (;;) {
    i = skipBlanks(text, i);
    const c = text[i];
    if (c === '"' || c === "'") {
      const quoted = readQuoted(text, i);
      if (quoted === null) {
        return null;
      }
      parts.push(quoted.value);
      i = quoted.next;
    } else {
      BARE_KEY.lastIndex = i;
      const bareMatch = BARE_KEY.exec(text);
      if (bareMatch === null) {
        return null;
      }
      parts.push(bareMatch[0]);
      i += bareMatch[0].length;
    }
    i = skipBlanks(text, i);
    if (text[i] !== '.') {
      return { parts, next: i };
    }
    i += 1;
  }
}

/**
 * Scans `text` (decoded, without a byte order mark) once, line by line
 * (see `TomlLine` and `TomlScan`). Strings (`"..."`, `'...'`, `"""..."""`,
 * `'''...'''`, escapes in basic strings, up to two extra quotes before a
 * multi-line delimiter), comments, and arrays and inline tables spanning
 * lines are skipped, so a `[` or a `#` inside them is not a header or a
 * comment; a one-line string that does not close ends at the line feed.
 * Pure.
 */
export function scanToml(text: string): TomlScan {
  const lines: TomlLine[] = [];
  let str: OpenString | null = null;
  let depth = 0;
  let unreadable = false;
  let table: readonly string[] = [];
  let at = 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 ? text.length : nl;
    const lineText = text.slice(at, end);
    let kind: TomlLineKind = 'continuation';
    let key: readonly string[] | null = null;
    let fullKey: readonly string[] | null = null;
    let pos = at;
    if (str === null && depth === 0) {
      const bareText = lineText.replace(/\r$/, '');
      const first = skipBlanks(bareText, 0);
      const c = bareText[first];
      if (c === undefined) {
        kind = 'blank';
      } else if (c === '#') {
        kind = 'comment';
      } else if (c === '[') {
        const array = bareText[first + 1] === '[';
        const parsed = parseKey(bareText, first + (array ? 2 : 1));
        const closing = array ? ']]' : ']';
        if (parsed !== null && bareText.startsWith(closing, parsed.next)) {
          kind = array ? 'array-header' : 'header';
          key = parsed.parts;
          table = parsed.parts;
          pos = at + parsed.next + closing.length;
        } else {
          kind = 'other';
        }
      } else {
        const parsed = parseKey(bareText, first);
        if (parsed !== null && bareText[parsed.next] === '=') {
          kind = 'keyval';
          key = parsed.parts;
          fullKey = [...table, ...parsed.parts];
          pos = at + parsed.next + 1;
        } else {
          kind = 'other';
        }
      }
    }
    // The rest of the line, line feed included, for strings, comments and brackets.
    const stop = nl === -1 ? end : nl + 1;
    for (let i = pos; i < stop; i += 1) {
      const c = text[i];
      if (str !== null) {
        if (c === '\\' && str.kind === 'basic') {
          const length = escapeLength(text, i, str.multi);
          if (length === 0) {
            unreadable = true;
          }
          i += Math.max(length, 2) - 1;
        } else if (c === '\n' && !str.multi) {
          str = null;
        } else if (c === (str.kind === 'basic' ? '"' : "'")) {
          if (!str.multi) {
            str = null;
          } else if (text.startsWith(c.repeat(3), i)) {
            let run = 3;
            while (run < 5 && text[i + run] === c) {
              run += 1;
            }
            i += run - 1;
            str = null;
          }
        }
      } else if (c === '#') {
        break;
      } else if (c === '"' || c === "'") {
        const multi = text.startsWith(c.repeat(3), i);
        str = { kind: c === '"' ? 'basic' : 'literal', multi };
        if (multi) {
          i += 2;
        }
      } else if (c === '[' || c === '{') {
        depth += 1;
      } else if ((c === ']' || c === '}') && depth > 0) {
        depth -= 1;
      }
    }
    if (kind === 'other') {
      unreadable = true;
    }
    lines.push({ start: at, end, text: lineText, kind, key, fullKey });
    if (nl === -1) {
      break;
    }
    at = nl + 1;
  }
  return { lines, unterminated: str !== null || depth > 0, unreadable };
}

/**
 * True when some line of `scan` holds the text of a marker of `syntax`
 * without being a comment line by the scan (inside a multi-line string,
 * inside an array or inline table spanning lines, or after a key): such a
 * line is part of the user's data and never one of the block's markers
 * (review round 1 of task group 4, R1). Pure.
 */
export function hasNonCommentMarkerLine(
  scan: TomlScan,
  syntax: MarkerSyntax = CODEX_MARKERS,
): boolean {
  return scan.lines.some(
    (line) =>
      line.kind !== 'comment' &&
      (line.text.includes(syntax.startText) || line.text.includes(syntax.endText)),
  );
}

/** True when `key` is `mcp_servers.agentboard` or a key below it. */
function underServer(key: readonly string[]): boolean {
  return key.length >= 2 && key[0] === 'mcp_servers' && key[1] === MCP_SERVER_NAME;
}

/** True when `key` is exactly `mcp_servers`. */
function isServers(key: readonly string[]): boolean {
  return key.length === 1 && key[0] === 'mcp_servers';
}

/** A range of whole lines of the text: from `start` to `end`, the next line's start or the text's end. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The definitions of the agentboard server that `text` holds outside the
 * marked region(s) (design.md "Rulings from task group 4": `foreign-table`
 * and `toml-shape`). A marked region runs from a line holding the start
 * marker text to the next line holding the end marker text (or the end of
 * the text); the lines inside are agentboard's and are not definitions,
 * but the block's own header sets the current table like any other, so a
 * key/value line after the end marker and before the next header is read
 * by TOML into the block's table.
 */
export interface ServerDefinitions {
  /**
   * `foreign-table`: each `[k]` header outside the markers with `k` at or
   * below `mcp_servers.agentboard`, as the range from its header line
   * through its last key/value or continuation line before the next
   * header, marker-like line or the end of the text (line break
   * included); the comment and blank lines directly above what follows
   * stay (review round 1 of task group 4, R3). In text order.
   */
  readonly foreign: readonly LineRange[];
  /**
   * `toml-shape`: an array of tables `[[mcp_servers]]` or `[[k]]` with `k`
   * at or below the server, or a key/value line outside a foreign table
   * whose full key is `mcp_servers` or at or below the server (a dotted
   * key, an inline table, or a setting below the block's end marker).
   */
  readonly shape: boolean;
}

/** Finds the definitions of the server in `scan` (see `ServerDefinitions`). Pure. */
export function serverDefinitions(
  scan: TomlScan,
  textLength: number,
  syntax: MarkerSyntax = CODEX_MARKERS,
): ServerDefinitions {
  const foreign: LineRange[] = [];
  let shape = false;
  let open: number | null = null;
  let openEnd = 0;
  let inRegion = false;
  let inForeign = false;
  for (const line of scan.lines) {
    const isStart = line.text.includes(syntax.startText);
    const isEnd = line.text.includes(syntax.endText);
    const isHeader = line.kind === 'header' || line.kind === 'array-header';
    const afterLine = line.end < textLength ? line.end + 1 : line.end;
    if (isStart) {
      inRegion = true;
    }
    if (isHeader || isStart || isEnd) {
      if (open !== null) {
        foreign.push({ start: open, end: openEnd });
        open = null;
      }
      inForeign = false;
    }
    if (inForeign && (line.kind === 'keyval' || line.kind === 'continuation')) {
      openEnd = afterLine;
    }
    if (!inRegion && line.key !== null) {
      if (line.kind === 'array-header' && (isServers(line.key) || underServer(line.key))) {
        shape = true;
      } else if (line.kind === 'header' && underServer(line.key)) {
        open = line.start;
        openEnd = afterLine;
        inForeign = true;
      } else if (
        line.kind === 'keyval' &&
        !inForeign &&
        line.fullKey !== null &&
        (isServers(line.fullKey) || underServer(line.fullKey))
      ) {
        shape = true;
      }
    }
    if (isEnd) {
      inRegion = false;
    }
  }
  if (open !== null) {
    foreign.push({ start: open, end: openEnd });
  }
  return { foreign, shape };
}

/** The markers of a Codex `config.toml` text (`blockMarkers` with `CODEX_MARKERS`). */
export function codexMarkers(text: string): AgentsMarkers {
  return blockMarkers(text, CODEX_MARKERS);
}

/**
 * The `--command` executable a managed Codex block records: `undefined`
 * when `region` (its `\r\n` line ends read as `\n`) is exactly
 * `renderCodexBlock(version)`, the non-empty `c` when it is exactly
 * `renderCodexBlock(version, c)`, and null when it is neither (a
 * hand-edited block: an extra line, other args, an empty command). Pure.
 */
export function managedCodexCommand(
  region: string,
  version: number,
): { readonly command: string | undefined } | null {
  const text = region.replaceAll('\r\n', '\n');
  if (text === renderCodexBlock(version)) {
    return { command: undefined };
  }
  const lines = text.split('\n');
  const literal = lines[2]?.startsWith('command = ') === true ? lines[2].slice(10) : null;
  const quoted = literal === null || !literal.startsWith('"') ? null : readQuoted(literal, 0);
  if (quoted === null || quoted.next !== literal?.length || quoted.value === '') {
    return null;
  }
  const command = quoted.value;
  return tomlBasicString(command) === literal && text === renderCodexBlock(version, command)
    ? { command }
    : null;
}

/** The TOML header line of the block's table, for messages. */
export const CODEX_TABLE_HEADER = `[${CODEX_TABLE}]`;
