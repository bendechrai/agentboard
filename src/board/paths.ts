/**
 * Decision record paths (board-cli: "Close requires a decision
 * disposition"): resolved against the current directory, required to lie
 * inside the current working tree, and recorded relative to its root so the
 * recorded path means the same thing in every worktree and clone.
 */

import type { Env } from '../cli/types.js';
import { notImplemented } from './stub.js';

/** Where a path argument is resolved from. */
export interface TreePathOptions {
  /** Directory the command runs in. Defaults to `process.cwd()`. */
  cwd?: string | undefined;
  /** Environment for the `git` child process. Defaults to `process.env`. */
  env?: Env | undefined;
}

/** A path argument resolved inside the working tree. */
export interface TreePath {
  /** Absolute path of the target, for existence checks. */
  absolute: string;
  /**
   * The path relative to the working tree root, with `/` separators and no
   * leading `./`; this is what an event records.
   */
  recorded: string;
}

/**
 * Resolves a decision path argument.
 *
 * - The working tree root is the output of `git rev-parse --show-toplevel`
 *   run in `cwd` (with `env`), or `cwd` itself when that fails (not in a
 *   git repository, or git missing).
 * - `text` (relative or absolute) is resolved against `cwd`. Symbolic links
 *   in `cwd` and in the root are resolved (`realpath`) before comparing, so
 *   a temporary directory behind a symlink does not count as outside.
 * - When the result is the root itself or lies outside it,
 *   `BoardError(1, 'path-outside-tree')` naming `text`.
 * - Otherwise returns the absolute path and the root-relative path with
 *   `/` separators. Existence is not checked here.
 *
 * @throws BoardError exit 1 `usage` when `text` is empty.
 */
export function treePath(text: string, options?: TreePathOptions): TreePath {
  throw notImplemented(text, options);
}
