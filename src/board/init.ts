/**
 * `agentboard init` (board-events: "Board directory per project", "Board
 * ref in the host repository"; board-cli: "Initialising and joining a
 * shared board"; add-board-sharing design.md: decisions 3 and 7; ADR 0012).
 *
 * `initBoard` decides the board's model and creates, joins or repairs it;
 * the host-model mechanics live in `src/board/host-init.ts`.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BoardError } from '../store/errors.js';
import { boardExists, locateBoard, type LocateOptions } from '../store/locate.js';
import type { RepairOutcome } from './host-init.js';

/**
 * Lines of the `.gitignore` that `init` writes inside the board directory,
 * in this order, each followed by a newline: the cache file and its SQLite
 * WAL and shared-memory companions, so `sync` never commits them.
 */
export const BOARD_GITIGNORE_LINES = [
  'cache.sqlite',
  'cache.sqlite-wal',
  'cache.sqlite-shm',
] as const;

/** The entry `init` adds to the host project's `.gitignore`. */
export const HOST_GITIGNORE_ENTRY = '.board/';

/** The model of a board `init` created, joined, repaired or found. */
export type InitModel = 'host' | 'standalone';

/** Result of `initBoard`; also the `init --json` document. */
export interface InitResult {
  /** Absolute path of the board directory (from `locateBoard`). */
  dir: string;
  /**
   * True when `init` made the board: a new board, a board joined from the
   * remote, or a board directory re-created from the local ref after it
   * was deleted. False when a board already existed there and nothing was
   * touched, and after a repair.
   */
  created: boolean;
  /**
   * The model of the board when `init` returns: `host` (a linked worktree
   * of the host repository at `refs/agentboard/board`) or `standalone` (a
   * repository of its own). Never a broken link or a non-repository: `init`
   * repairs those (see `initBoard`).
   */
  model: InitModel;
  /**
   * True when the board's history came from the remote's
   * `refs/agentboard/board` (`ensureBoardRef` source `remote`), on a create
   * or a repair; false otherwise, including when the local ref was used.
   */
  joined: boolean;
  /**
   * The name of the remote chosen in the repository that holds the board's
   * history (board-concurrency "Sync converges": `agentboard.remote`, the
   * upstream of the main checkout's branch, `origin`, the only remote), or
   * null when there is none. For an existing board, the remote `sync`
   * would use.
   */
  remote: string | null;
  /**
   * The number of event files (`events/<hash>.json`, temporaries excluded)
   * in the board when `init` returns: what a join brought, what a repair
   * carried over, 0 for a new board.
   */
  events: number;
  /**
   * Absolute path of the host `.gitignore` that `init` created or
   * appended to, or null when it did not touch one (already listed the
   * entry, the board already existed, discovery came from
   * `AGENTBOARD_DIR`, or the directory is not inside a git repository).
   */
  hostGitignore: string | null;
  /**
   * Plain ASCII lines, without the `agentboard: ` prefix, printed to
   * stderr by the CLI as `agentboard: <line>` (also with `--json`). In this
   * order where they apply: the standalone fallback because git is older
   * than 2.32 (names the version found and says the host model needs git
   * 2.32 or later; the text `2.32` appears); the remote could not be
   * reached (names the remote and says the next `agentboard sync` joins
   * any board there); one line per event file a repair skipped (names the
   * file and says its content does not match its name). Empty otherwise.
   */
  warnings: string[];
  /** What a repair did (`repairBoardLink`), or null when nothing was repaired. */
  repair: RepairOutcome | null;
  /**
   * One or more human-readable ASCII lines (newline-separated, no trailing
   * newline) describing what happened, see `initBoard`.
   */
  message: string;
}

/**
 * Creates, joins or repairs the board where discovery says it belongs
 * (`locateBoard` with `options`; a missing board is not an error here).
 * Needs no actor. Never pushes: the first `sync` publishes a new board.
 *
 * Which model (board-events "Board directory per project"): the host model
 * when discovery's source is `git` and the git found on the `PATH` of
 * `options.env` is 2.32 or later (`gitVersion` and `meetsGitFloor`); the
 * standalone model otherwise: source `cwd` (not inside a git repository),
 * source `env` (`AGENTBOARD_DIR`), or an older git, in which case
 * `warnings` and `message` say the host model needs git 2.32 or later.
 *
 * Existing board (`boardExists(dir)` and `detectBoardModel(dir)` is `host`
 * or `standalone`): nothing is created or modified, not even the host
 * `.gitignore`; `created` false, `hostGitignore` null, `repair` null,
 * `joined` false, `model` the detected model, `remote` the remote `sync`
 * would use (`boardRemote`), `events` the count in the board, and a message
 * that says the board already exists at `dir`, names its model (`host` or
 * `standalone`), where the history lives (`refs/agentboard/board`, or the
 * branch of the board repository) and the remote (or that there is none).
 * For a standalone board found through a git repository (source `git`) with
 * git 2.32 or later the message also suggests `agentboard init --into-host`
 * (that text appears); otherwise it does not. Exit 0.
 *
 * Broken host link or a `.board` directory that is not a repository
 * (`detectBoardModel` is `broken-host-link` or `not-a-repository` and the
 * directory exists), found through a git repository with git 2.32 or
 * later: `repairBoardLink(hostRoot, dir, remote)` after the remote choice
 * and the host `.gitignore` entry, where `hostRoot` is the parent of `dir`;
 * `repair` holds its outcome, `created` false, `model` `host`, `joined`
 * true when the fresh worktree's history came from the remote, `events`
 * the count after the repair, `warnings` one line per skipped file, and a
 * message naming what was done (`repaired`), the kept directory when there
 * is one and the number of copied files. A `.board` directory that holds
 * no `events/` and is not a repository (an empty or stray directory) is
 * treated the same way: its content is kept aside and the board is built
 * fresh. Outside the host model (standalone fallback) such a directory is
 * completed in place as before.
 *
 * New host-model board, in this order (design.md decision 7), so that
 * every step is idempotent and an interrupted `init` is completed by
 * running `init` again:
 * 1. Remote: `chooseRemote(hostRoot, <the main checkout's branch>)`, with
 *    the branch read in `hostRoot` (null when detached), so the choice is
 *    the same from every linked worktree. Several remotes and none chosen:
 *    `ambiguousRemoteError(choice, 'init')`, exit 1 `ambiguous-remote`,
 *    before anything is written (no `.gitignore` entry, no ref, no
 *    directory).
 * 2. Host `.gitignore` entry as described below.
 * 3. `ensureBoardRef(hostRoot, remote)`: the local ref, else the remote's
 *    (`joined` true), else a new empty board (`joined` false; a warning
 *    when the remote could not be reached).
 * 4. `addBoardWorktree(hostRoot, dir)`: add (or re-add a deleted but
 *    registered worktree), lock, disable sparse checkout.
 * 5. Catch up the cache (`openBoard` then close), so the next command sees
 *    every event; `events` counts the event files.
 * The result has `created` true, `model` `host`, `remote` the chosen name
 * or null, and a message naming `dir`, the model, and either how many
 * events were joined from the remote (`joined <n> events from <remote>`
 * style wording, the count and the remote appear), or that the board is
 * new and that `agentboard sync` publishes it (to `<remote>`, or once the
 * repository has a remote: the words `sync` and `remote` appear).
 *
 * New standalone board, creating only what is missing and never
 * overwriting an existing file:
 * 1. `dir` and `dir/events`, with an empty `dir/events/.gitkeep`, so the
 *    directory survives a git clone. `events/` holds nothing else.
 * 2. `dir/.gitignore` containing `BOARD_GITIGNORE_LINES`, one per line.
 * 3. A git repository in `dir` (`git init` run in `dir`, when `dir/.git`
 *    does not exist). No commit is made.
 * 4. The host `.gitignore` entry as described below.
 * The result has `created` true, `model` `standalone`, `joined` false,
 * `remote` null, `events` 0 and a message naming `dir`.
 *
 * Host `.gitignore` (both models): when discovery's source is `git`, the
 * host `.gitignore` is `<parent of dir>/.gitignore`. When no line of it,
 * trimmed, equals `.board/`, `.board`, `/.board/` or `/.board`, the line
 * `.board/` is appended (after a newline when the file does not end with
 * one), or the file is created containing `.board/\n`. Existing content is
 * kept byte for byte. When the source is `env` or `cwd` no host file is
 * touched (`hostGitignore` null).
 *
 * Apart from that entry, `init` never modifies a branch, a tag, the index
 * or the working tree of the host repository: `git status --porcelain` in
 * a host whose `.gitignore` already lists `.board/` is empty afterwards.
 *
 * @throws BoardError exit 1, reason `git-missing`, naming `git`, when the
 *   `git` executable cannot be run; in that case nothing is created.
 * @throws BoardError exit 1, reason `ambiguous-remote`, as described above.
 */
export function initBoard(options?: LocateOptions): InitResult {
  const { dir, source } = locateBoard(options);
  if (boardExists(dir)) {
    return {
      dir,
      created: false,
      model: 'standalone',
      joined: false,
      remote: null,
      events: 0,
      hostGitignore: null,
      warnings: [],
      repair: null,
      message: `board already exists at ${dir}; nothing changed`,
    };
  }
  const env = { ...(options?.env ?? process.env) };
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  try {
    git(options?.cwd ?? process.cwd(), '--version');
  } catch {
    throw new BoardError(
      1,
      'git-missing',
      'agentboard init needs git (the board is a git repository of its own), but git could not be run',
    );
  }
  // The events directory is created last: it is what makes the board exist,
  // so an interrupted init is completed by running init again.
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    git(dir, 'init', '-q');
  }
  writeIfMissing(join(dir, '.gitignore'), BOARD_GITIGNORE_LINES.map((l) => `${l}\n`).join(''));
  mkdirSync(join(dir, 'events'), { recursive: true });
  writeIfMissing(join(dir, 'events', '.gitkeep'), '');
  const hostGitignore = source === 'env' ? null : ignoreBoardInHost(dirname(dir));
  return {
    dir,
    created: true,
    model: 'standalone',
    joined: false,
    remote: null,
    events: 0,
    hostGitignore,
    warnings: [],
    repair: null,
    message: `created the board at ${dir}`,
  };
}

/** Writes `content` to `path` unless a file is already there. */
function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content);
  }
}

/** Lines of a host `.gitignore` that already ignore the board directory. */
const HOST_ENTRIES = new Set(['.board/', '.board', '/.board/', '/.board']);

/**
 * Adds `HOST_GITIGNORE_ENTRY` to `<hostRoot>/.gitignore` unless a line
 * already ignores the board; returns the file's path when it was created or
 * appended to, else null.
 */
function ignoreBoardInHost(hostRoot: string): string | null {
  const path = join(hostRoot, '.gitignore');
  if (!existsSync(path)) {
    writeFileSync(path, `${HOST_GITIGNORE_ENTRY}\n`);
    return path;
  }
  const content = readFileSync(path, 'utf8');
  if (content.split('\n').some((line) => HOST_ENTRIES.has(line.trim()))) {
    return null;
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${HOST_GITIGNORE_ENTRY}\n`);
  return path;
}
