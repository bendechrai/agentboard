/**
 * Helpers for the guidance installer tests:
 * reading and writing files relative to a project root, a byte-and-mtime
 * snapshot of a tree for idempotence checks, the OpenSpec config fixture,
 * and a git repository with a linked worktree.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onTestFinished } from 'vitest';

import { cleanEnv, git, gitRepo, tempDir } from '../../store/__tests__/helpers.js';

/** The environment for installer runs: git discovery stops at the temp directory. */
export const ENV = cleanEnv();

/**
 * A copy of the commented `openspec/config.yaml` that OpenSpec generates
 * (this repository's own, taken verbatim).
 */
export const OPENSPEC_FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openspec-config.yaml'),
  'utf8',
);

/** The full-line comments of a YAML text (lines whose first non-blank character is `#`), trimmed. */
export function commentLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('#'));
}

/** Reads `<root>/<rel>` as UTF-8. */
export function readRel(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/** Writes `<root>/<rel>`, creating parent directories. */
export function writeRel(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Every file below `root` (outside `.git`), relative path to content and
 * mtime; a symlink is recorded by its target text, never followed.
 */
export function snapshot(root: string): Map<string, { content: string; mtimeMs: number }> {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Recorded, not followed: its target may be a directory or a cycle.
        files.set(relative(root, path), {
          content: `symlink to ${readlinkSync(path)}`,
          mtimeMs: lstatSync(path).mtimeMs,
        });
      } else if (entry.isDirectory()) {
        walk(path);
      } else {
        files.set(relative(root, path), {
          content: readFileSync(path, 'latin1'),
          mtimeMs: statSync(path).mtimeMs,
        });
      }
    }
  };
  walk(root);
  return files;
}

/** Relative paths of every file below `root` (outside `.git`), sorted. */
export function fileList(root: string): string[] {
  return [...snapshot(root).keys()].sort();
}

/** A project directory that is not in any git repository. */
export function plainProject(): string {
  return tempDir();
}

/** A git repository with one commit, at `<temp>/main`. */
export function repo(): string {
  return gitRepo(join(tempDir(), 'main'));
}

/**
 * A git repository at `<temp>/main` and a linked worktree of it at
 * `<temp>/wt` on a new branch `feature`.
 */
export function linkedWorktree(): { main: string; worktree: string } {
  const main = repo();
  const worktree = join(dirname(main), 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  return { main, worktree };
}

/**
 * True when the tests run as root, where permission bits do not stop reads
 * or writes (for example in the dev container), so the permission tests
 * are skipped.
 */
export const IS_ROOT = process.getuid?.() === 0;

/**
 * Sets the mode of `path` for the current test and restores its previous
 * mode when the test finishes (if it still exists). Only modes that still
 * let the temporary directory be removed are used (a read-only file, or
 * an empty read-only directory).
 */
export function chmodForTest(path: string, mode: number): void {
  const previous = statSync(path).mode & 0o7777;
  chmodSync(path, mode);
  onTestFinished(() => {
    // The temporary directory may already be gone.
    if (existsSync(path)) {
      chmodSync(path, previous);
    }
  });
}

/**
 * A project root `<temp>/proj` and a sibling `<temp>/proj-evil` whose path
 * starts with the root's path as a string but is not inside it.
 */
export function prefixSibling(): { root: string; sibling: string } {
  const parent = tempDir();
  const root = join(parent, 'proj');
  const sibling = join(parent, 'proj-evil');
  mkdirSync(root);
  mkdirSync(sibling);
  return { root, sibling };
}

/**
 * Symlink cycles at `<root>/<rel>`: `two-node` links `rel` and `rel.b` to
 * each other; `self-dir` links `<root>/loop` to `.` and `rel` to the
 * dangling `loop/loop/loop/loop/<rel>`, which resolves back to itself.
 */
export function symlinkCycle(root: string, rel: string, kind: 'two-node' | 'self-dir'): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (kind === 'two-node') {
    symlinkSync(`${basename(path)}.b`, path);
    symlinkSync(basename(path), `${path}.b`);
  } else {
    symlinkSync('.', join(root, 'loop'));
    symlinkSync(join(relative(dirname(path), root) || '.', 'loop/loop/loop/loop', rel), path);
  }
}
