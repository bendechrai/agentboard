/**
 * Helpers for the guidance installer tests (add-agent-guidance group 3):
 * reading and writing files relative to a project root, a byte-and-mtime
 * snapshot of a tree for idempotence checks, the OpenSpec config fixture,
 * and a git repository with a linked worktree.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Every file below `root` (outside `.git`), relative path to content and mtime. */
export function snapshot(root: string): Map<string, { content: string; mtimeMs: number }> {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
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
