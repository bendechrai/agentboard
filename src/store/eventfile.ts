/**
 * Event files on disk (board-events: "Event files are immutable and
 * content-addressed"; design.md: "Atomic event write").
 *
 * An event file is `<events dir>/<sha256-hex>.json` whose bytes are the
 * canonical encoding of one event (see `canonicalEncode`) and whose name is
 * the lowercase hex SHA-256 of those bytes (see `sha256Hex`). Files are only
 * ever created, never modified or deleted, by this module; the only deletion
 * it performs is of stale temporary files.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CanonicalError,
  canonicalDecode,
  canonicalEncode,
  sha256Hex,
} from '../events/canonical.js';
import type { FoldInput } from '../events/fold.js';
import { validateEvent, type MalformedReason } from '../events/schema.js';

/**
 * Prefix of temporary files in the events directory. Readers ignore them
 * (as they ignore every dot-named entry; see `listEventFiles`), and only
 * names with this prefix are ever reaped.
 */
export const TEMP_PREFIX = '.tmp-';

/** A temporary file older than this (by mtime) is stale: one minute. */
export const STALE_TEMP_MS = 60_000;

/** Result of `writeEventFile`. */
export interface WriteResult {
  /** Lowercase hex SHA-256 of the canonical bytes. */
  hash: string;
  /** Absolute path of `<eventsDir>/<hash>.json`. */
  path: string;
  /**
   * True when a file with that name already existed before this call and
   * its bytes hash to that name (so it holds exactly this event), in which
   * case nothing was written (dedupe): no temporary file was created and the
   * existing file was not touched. An existing file whose bytes do not hash
   * to its name is never reported as `existed`; see `writeEventFile`.
   */
  existed: boolean;
}

/**
 * Test hooks called at the two points where a crash matters. Used by the
 * transaction to implement the `AGENTBOARD_TEST_PAUSE` crash injection (see
 * `transaction.ts`) and by tests. An exception thrown by a hook propagates
 * out of `writeEventFile` unchanged; files already on disk at that point are
 * left exactly as they are (a thrown hook simulates the process dying there).
 */
export interface WriteHooks {
  /**
   * Called after the temporary file has been fully written, fsynced and
   * closed, and before the rename. `tempPath` is its absolute path; it lies
   * in the events directory and its base name starts with `TEMP_PREFIX`.
   * The hash-named file does not exist at this point.
   */
  afterTempWrite?: (tempPath: string) => void;
  /**
   * Called after the rename to the hash name (and the directory fsync on
   * POSIX). `finalPath` equals `WriteResult.path`.
   */
  afterRename?: (finalPath: string) => void;
}

/**
 * Atomically writes `event` as an event file.
 *
 * Steps: encode with `canonicalEncode`; hash with `sha256Hex`; if
 * `<hash>.json` already exists, read it: when `sha256Hex` of its bytes is
 * `<hash>`, return `{ existed: true }` without writing anything and without
 * calling any hook; otherwise throw `BoardError(5, 'integrity', ...)` naming
 * its path, again without writing anything, calling any hook or touching
 * the existing file (board-cli exit 5: an existing event file whose content
 * does not match its name). Otherwise create
 * `<eventsDir>/.tmp-<random>` (random part: at least 16 hex characters from a
 * cryptographic source), write the bytes, fsync, close, call
 * `hooks.afterTempWrite`, rename to `<hash>.json`, fsync the directory (on
 * POSIX; skipped on Windows), call `hooks.afterRename`, and return
 * `{ existed: false }`. On any error before the rename the temporary file is
 * removed on a best-effort basis, except when the error came from a hook.
 *
 * The event is not validated here: any value `canonicalEncode` accepts is
 * written, so tests can write malformed events.
 *
 * @throws CanonicalError when `event` cannot be canonically encoded (nothing
 *   is written).
 * @throws BoardError exit 5, reason `integrity`, when `<hash>.json` exists
 *   but its bytes do not hash to `<hash>`.
 */
export function writeEventFile(eventsDir: string, event: unknown, hooks?: WriteHooks): WriteResult {
  const bytes = canonicalEncode(event);
  const hash = sha256Hex(bytes);
  const path = join(eventsDir, `${hash}.json`);
  if (existsSync(path)) {
    return { hash, path, existed: true };
  }
  const tempPath = join(eventsDir, `${TEMP_PREFIX}${randomBytes(16).toString('hex')}`);
  try {
    writeDurably(tempPath, bytes);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  hooks?.afterTempWrite?.(tempPath);
  try {
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  fsyncDirectory(eventsDir);
  hooks?.afterRename?.(path);
  return { hash, path, existed: false };
}

/** Creates `path` (failing if it exists), writes all of `bytes`, fsyncs and closes. */
function writeDurably(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx', 0o644);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Fsyncs a directory so a rename inside it is durable. POSIX only: Windows
 * cannot open a directory for fsync, and its rename is journaled by NTFS.
 */
function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Names of the event candidates in `eventsDir`: every regular file whose
 * name does not start with `.`, sorted ascending by UTF-16 code unit order.
 * Dot-named entries (temporary files such as `.tmp-<random>` and
 * placeholders such as `.gitkeep`) are ignored entirely: never listed, read
 * or reported. Subdirectories and other non-regular entries are skipped.
 * The remaining names are not checked here (a name that is not
 * `<sha256>.json`, such as `notes.txt`, is reported as corrupt by
 * `readEventFile`).
 */
export function listEventFiles(eventsDir: string): string[] {
  return readdirSync(eventsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/** A file whose name is not the SHA-256 of its bytes. Never folded. */
export interface CorruptFile {
  /** Absolute path. */
  path: string;
  /** Base name of the file. */
  name: string;
  /** Human-readable ASCII explanation. */
  message: string;
}

/**
 * A correctly named file whose content is not a well-formed event: not
 * canonical JSON (the `CanonicalError` code is in the single reason's
 * message, field `''`), or rejected by `validateEvent` (its reasons). Never
 * folded.
 */
export interface MalformedFile {
  /** Absolute path. */
  path: string;
  /** The file's hash (its name without `.json`). */
  hash: string;
  reasons: MalformedReason[];
}

/** Outcome of reading one event candidate. */
export type ReadOutcome =
  | { status: 'ok'; input: FoldInput }
  | { status: 'corrupt'; file: CorruptFile }
  | { status: 'malformed'; file: MalformedFile };

/**
 * Reads and classifies one file of `eventsDir` by base name.
 *
 * - `corrupt` when the name is not exactly 64 lowercase hex characters
 *   followed by `.json`, or those 64 characters are not `sha256Hex` of the
 *   file's bytes.
 * - otherwise `malformed` when `canonicalDecode` throws or `validateEvent`
 *   returns `ok: false`.
 * - otherwise `ok`, with `input.hash` the name's hash and `input.event` the
 *   validated event (known or unknown kind).
 *
 * @throws the underlying IO error when the file cannot be read.
 */
export function readEventFile(eventsDir: string, name: string): ReadOutcome {
  const path = join(eventsDir, name);
  const match = EVENT_NAME.exec(name);
  const hash = match?.[1];
  if (hash === undefined) {
    return corrupt(path, name, 'name is not <sha256-hex>.json');
  }
  const bytes = readFileSync(path);
  if (sha256Hex(bytes) !== hash) {
    return corrupt(path, name, 'name is not the SHA-256 of the file content');
  }
  let decoded: unknown;
  try {
    decoded = canonicalDecode(bytes);
  } catch (error) {
    if (!(error instanceof CanonicalError)) {
      throw error;
    }
    const reason = { field: '', message: `not canonical JSON (${error.code}): ${error.message}` };
    return { status: 'malformed', file: { path, hash, reasons: [reason] } };
  }
  const result = validateEvent(decoded);
  if (!result.ok) {
    return { status: 'malformed', file: { path, hash, reasons: result.reasons } };
  }
  return { status: 'ok', input: { hash, event: result.event } };
}

/** An event file name: 64 lowercase hex characters then `.json`. */
const EVENT_NAME = /^([0-9a-f]{64})\.json$/;

function corrupt(path: string, name: string, why: string): ReadOutcome {
  return { status: 'corrupt', file: { path, name, message: `corrupt event file ${path}: ${why}` } };
}

/** Result of `readEventLog`. Each array is sorted by file name. */
export interface EventLog {
  inputs: FoldInput[];
  corrupt: CorruptFile[];
  malformed: MalformedFile[];
}

/**
 * Reads every candidate from `listEventFiles` with `readEventFile`, skipping
 * names whose hash part (name without `.json`) is in `skip`, and partitions
 * the outcomes. A corrupt or malformed file never stops the others from
 * being read.
 */
export function readEventLog(eventsDir: string, skip?: ReadonlySet<string>): EventLog {
  const log: EventLog = { inputs: [], corrupt: [], malformed: [] };
  for (const name of listEventFiles(eventsDir)) {
    if (skip?.has(name.replace(/\.json$/, '')) === true) {
      continue;
    }
    const outcome = readEventFile(eventsDir, name);
    if (outcome.status === 'ok') {
      log.inputs.push(outcome.input);
    } else if (outcome.status === 'corrupt') {
      log.corrupt.push(outcome.file);
    } else {
      log.malformed.push(outcome.file);
    }
  }
  return log;
}

/** Options for `reapStaleTemps`. */
export interface ReapOptions {
  /** Current time in ms since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /** Age threshold in ms. Defaults to `STALE_TEMP_MS`. */
  maxAgeMs?: number;
}

/**
 * Removes stale temporary files: every regular file in `eventsDir` whose
 * name starts with `TEMP_PREFIX` and whose mtime is strictly older than
 * `now - maxAgeMs`. Younger temporary files (possibly being written by a
 * live process) are left alone. Other dot-named entries, such as
 * `.gitkeep`, are never removed however old. A file that disappears
 * concurrently is ignored. Returns the absolute paths removed, sorted.
 */
export function reapStaleTemps(eventsDir: string, options?: ReapOptions): string[] {
  const cutoff = (options?.now ?? Date.now()) - (options?.maxAgeMs ?? STALE_TEMP_MS);
  const removed: string[] = [];
  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(TEMP_PREFIX)) {
      continue;
    }
    const path = join(eventsDir, entry.name);
    // A file that vanished since the listing (its writer renamed it, or
    // another command reaped it) has no stats and is skipped.
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats !== undefined && stats.mtimeMs < cutoff) {
      rmSync(path, { force: true });
      removed.push(path);
    }
  }
  return removed.sort();
}
