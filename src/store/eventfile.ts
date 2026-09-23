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

import type { FoldInput } from '../events/fold.js';
import type { MalformedReason } from '../events/schema.js';

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
   * True when a file with that name already existed before this call, in
   * which case nothing was written (dedupe): no temporary file was created
   * and the existing file was not touched.
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
 * `<hash>.json` already exists return `{ existed: true }` without writing
 * anything and without calling any hook. Otherwise create
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
 */
export function writeEventFile(eventsDir: string, event: unknown, hooks?: WriteHooks): WriteResult {
  void eventsDir;
  void event;
  void hooks;
  throw new Error('not implemented');
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
  void eventsDir;
  throw new Error('not implemented');
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
  void eventsDir;
  void name;
  throw new Error('not implemented');
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
  void eventsDir;
  void skip;
  throw new Error('not implemented');
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
  void eventsDir;
  void options;
  throw new Error('not implemented');
}
