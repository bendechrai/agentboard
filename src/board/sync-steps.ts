/**
 * The steps of `agentboard sync` that both board models share
 * (board-concurrency "Sync converges"; ADR 0005): the preconditions that
 * nothing is in progress and that every committed event file is present,
 * the staging and commit of sync's own paths with the fixed identity, the
 * host tracking warning, and small helpers. The standalone path
 * (`src/board/sync.ts`) and the host-model path (`src/board/host-sync.ts`)
 * both run these; neither model changes what they do.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { firstErrorLine, isGitFailure, type GitFailure, type GitRunner } from './git.js';
import { asciiText } from './text.js';

/**
 * Subject of the commit `sync` makes: `agentboard sync: <n> event file(s)`,
 * where `<n>` is the number of `events/*.json` paths added by the commit
 * (`file` when `n` is 1, `files` otherwise, including 0 for a commit that
 * only carries `.gitignore` or `events/.gitkeep`). No body.
 */
export function syncCommitMessage(eventFiles: number): string {
  return `agentboard sync: ${String(eventFiles)} event ${eventFiles === 1 ? 'file' : 'files'}`;
}

/** NUL-separated output as a list, without empty entries. */
export function zList(text: string): string[] {
  return text.split('\0').filter((entry) => entry !== '');
}

/** `<n> <noun>` with an `s` unless `n` is 1. */
export function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** The realpath of `path`, or `path` itself when it cannot be resolved. */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The path of an event file in a git tree: `events/<name>.json`. */
export const EVENT_PATH = /^events\/[^/]+\.json$/;

/** Precondition: no rebase, merge, cherry-pick or revert is stopped in the board's git directory. */
export function checkNothingInProgress(git: GitRunner, dir: string): void {
  const gitDir = git.run('rev-parse', '--absolute-git-dir').trim();
  const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  if (markers.some((name) => existsSync(join(gitDir, name)))) {
    throw new BoardError(
      3,
      'sync-in-progress',
      `a rebase or merge is in progress in the board repository at ${dir}; finish it ` +
        `(resolve, git add, git rebase --continue) or abort it (git rebase --abort) ` +
        `in ${dir}, then run agentboard sync again`,
    );
  }
}

/** Whether HEAD names a commit (false on an unborn branch). */
export function headExists(git: GitRunner): boolean {
  return !isGitFailure(git.attempt('rev-parse', '--quiet', '--verify', 'HEAD^{commit}'));
}

/** Precondition: every event file recorded in HEAD is present in `events/`. */
export function checkCommittedEventsPresent(git: GitRunner, board: Board): void {
  if (!headExists(git)) {
    return;
  }
  const committed = zList(git.run('ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'events'));
  const missing = committed
    .filter((path) => EVENT_PATH.test(path))
    .filter((path) => !existsSync(join(board.dir, path)))
    .sort();
  if (missing.length > 0) {
    const names = missing.map((p) => asciiText(p));
    throw new BoardError(
      5,
      'integrity',
      `${plural(missing.length, 'committed event file')} missing from ${board.dir}: ` +
        `${names.join(', ')}; event files are add-only, so nothing was synced; restore them with ` +
        names.map((p) => `git -C ${board.dir} checkout -- ${p}`).join(' and '),
    );
  }
}

/** Event file names (`<hash>.json`) currently in the events directory. */
export function eventFileNames(board: Board): string[] {
  return readdirSync(board.eventsDir).filter(
    (name) => name.endsWith('.json') && !name.startsWith('.'),
  );
}

/**
 * Stages new event files and `.gitignore`, and commits them when any is
 * staged (ADR 0005): `add --ignore-removal -- events :(exclude)events/.tmp-*
 * [.gitignore]`, then, only when something of those paths is staged,
 * `commit --quiet --no-verify -m <syncCommitMessage(n)> -- <same pathspec>`.
 * Anything else staged stays staged and uncommitted.
 */
export function stageAndCommit(
  git: GitRunner,
  board: Board,
): { commit: string | null; committedEvents: number } {
  const own = ['events', ':(exclude)events/.tmp-*'];
  if (existsSync(join(board.dir, '.gitignore'))) {
    own.push('.gitignore');
  }
  git.run('add', '--ignore-removal', '--', ...own);
  const staged = zList(git.run('diff', '--cached', '--name-only', '-z', '--', ...own));
  if (staged.length === 0) {
    return { commit: null, committedEvents: 0 };
  }
  const added = zList(
    git.run('diff', '--cached', '--name-only', '--diff-filter=A', '-z', '--', ...own),
  );
  const committedEvents = added.filter((path) => EVENT_PATH.test(path)).length;
  // The pathspec limits the commit to sync's own paths: anything else
  // already staged stays staged and uncommitted.
  git.run(
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    syncCommitMessage(committedEvents),
    '--',
    ...own,
  );
  return { commit: git.run('rev-parse', 'HEAD').trim(), committedEvents };
}

/** The unmerged paths of the working tree `git` runs in, sorted. */
export function unmergedPaths(git: GitRunner): string[] {
  return zList(git.run('diff', '--name-only', '--diff-filter=U', '-z')).sort();
}

/** `BoardError(3, 'sync-failed')` for a git step that failed. */
export function syncFailed(what: string, failure: GitFailure): BoardError {
  return new BoardError(3, 'sync-failed', `${what} failed: ${firstErrorLine(failure)}`);
}

/**
 * Paths under the board directory tracked by the host repository (run in
 * the parent of the board directory), or none when there is no host
 * repository or git fails there.
 */
export function hostTrackedPaths(git: GitRunner, dir: string): string[] {
  const real = realpathOrSelf(dir);
  const parent = dirname(real);
  try {
    return zList(git.runIn(parent, 'ls-files', '-z', '--full-name', '--', real)).sort();
  } catch {
    return [];
  }
}

/** The warning of `SyncResult.warnings` when the host repository tracks paths under the board. */
export function hostWarning(dir: string, tracked: readonly string[]): string {
  const first = asciiText(tracked[0] ?? '');
  const name = asciiText(basename(dir));
  const others = tracked.length > 1 ? ` and ${String(tracked.length - 1)} more` : '';
  return (
    `warning: the host repository tracks ${plural(tracked.length, 'path')} under the board ` +
    `(${first}${others}); untrack them with git rm -r --cached ${name} ` +
    `(run in ${asciiText(dirname(dir))}) and keep ${name}/ in the host .gitignore`
  );
}
