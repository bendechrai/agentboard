/**
 * Reading the ownership markers and managed regions of installed guidance
 * (design.md: "Ownership markers"), shared by `agents install`
 * (`./install.ts`) and `agents check` (`./check.ts`). Internal to the
 * guidance module: not re-exported from the package entry point.
 */

import { existsSync, readFileSync } from 'node:fs';

import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

import { BLOCK_END, OPENSPEC_OPERATIONS, OPENSPEC_PREFIX } from './installed-text.js';

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
