/**
 * Decision record paths (board-cli: "Close requires a decision
 * disposition"): resolved against the current directory, required to lie
 * inside the current working tree, and recorded relative to its root so the
 * recorded path means the same thing in every worktree and clone.
 *
 * Layering: nothing in `src/board` imports from `src/cli`; `Env` and
 * `asciiText` come from `src/board`.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { asciiText } from './text.js';
import type { Env } from './text.js';
import { BoardError } from '../store/errors.js';

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
 *   in `cwd`, in the root and in the target are resolved (`realpath`)
 *   before comparing: a temporary directory behind a symlink does not count
 *   as outside, and a symlink inside the tree that points outside it is
 *   refused. When the target does not exist (`link --decision`), the
 *   nearest existing ancestor is resolved and the missing remainder
 *   appended. `absolute` and `recorded` are both computed from this
 *   resolved form, so a path through an in-tree symlink records the real
 *   in-tree location.
 * - When the result is the root itself or lies outside it,
 *   `BoardError(1, 'path-outside-tree')` naming `text`.
 * - Otherwise returns the absolute path and the root-relative path with
 *   `/` separators. Existence is not checked here.
 *
 * @throws BoardError exit 1 `usage` when `text` is empty.
 */
export function treePath(text: string, options?: TreePathOptions): TreePath {
  if (text === '') {
    throw new BoardError(1, 'usage', 'the path must not be empty');
  }
  const cwd = realpathSync(options?.cwd ?? process.cwd());
  const root = realpathSync(worktreeRoot(cwd, options?.env ?? process.env) ?? cwd);
  const absolute = realTarget(resolve(cwd, text));
  const rel = relative(root, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BoardError(
      1,
      'path-outside-tree',
      `path ${asciiText(text)} is outside the working tree ${asciiText(root)}`,
    );
  }
  return { absolute, recorded: rel.split(sep).join('/') };
}

/**
 * `path` with symbolic links resolved: the realpath of the path itself when
 * it exists, otherwise the realpath of its nearest existing ancestor with
 * the missing remainder appended.
 */
function realTarget(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return path;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * `git rev-parse --show-toplevel` in `cwd` (with `env`), or null when it
 * fails (not in a git repository, or git missing). Also the working tree
 * root of the web actions (`actionRoot`, `src/web/actions.ts`).
 */
export function worktreeRoot(cwd: string, env: Env): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: { ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/, '');
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
