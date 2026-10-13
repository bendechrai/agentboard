/**
 * `agentboard init` (board-events: "Board directory per project", "Board
 * ref in the host repository"; board-cli: "Initialising and joining a
 * shared board"; add-board-sharing design.md: decisions 3 and 7; ADR 0012).
 *
 * `initBoard` decides the board's model and creates, joins or repairs it;
 * the host-model mechanics live in `src/board/host-init.ts`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { openBoard } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { boardExists, locateBoard, type LocateOptions } from '../store/locate.js';
import { gitRunner, gitVersion, isGitFailure, meetsGitFloor, type GitVersion } from './git.js';
import { MIGRATING_DIR, cleanDeadMigratingWorktrees } from './into-host.js';
import {
  AGENTBOARD_GIT_SUBDIR,
  BOARD_GITIGNORE_LINES,
  addBoardWorktree,
  adoptRepairingWorktree,
  boardWorktreeLocked,
  ensureBoardRef,
  newestStaleBoard,
  repairBoardLink,
  withInitLock,
  writeEmptyBoardCommit,
  type BoardRefSource,
  type RepairOutcome,
} from './host-init.js';
import { BOARD_REF, detectBoardModel, type BoardModelInfo } from './model.js';
import { ambiguousRemoteError, boardRemote, chooseRemote } from './remote.js';
import { asciiText, type Env } from './text.js';

export { BOARD_GITIGNORE_LINES };

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
 * when discovery's source is `git`, the git found on the `PATH` of
 * `options.env` is 2.32 or later (`gitVersion` and `meetsGitFloor`), and
 * the host has an in-tree git directory: `hostRoot` (the parent of `dir`)
 * is the top level of a working tree (`git rev-parse --show-toplevel` run
 * in `hostRoot` prints `hostRoot`) whose git common directory is
 * `<hostRoot>/.git`, compared as realpaths. The standalone model otherwise:
 * source `cwd` (not inside a git repository), source `env`
 * (`AGENTBOARD_DIR`), an older git (`warnings` and `message` say the host
 * model needs git 2.32 or later), or a host whose git directory is not in
 * its working tree (a bare repository with linked worktrees, a
 * `--separate-git-dir` repository, a submodule: `warnings` and `message`
 * say the host model needs the repository's `.git` directory inside its
 * working tree and name the git directory found). The decision is taken
 * before anything is written; nothing is created under `refs/agentboard/`
 * and no worktree is registered in such a repository or its superproject.
 *
 * Existing board (`boardExists(dir)` and `detectBoardModel(dir)` is `host`
 * or `standalone`): nothing is created or modified, not even the host
 * `.gitignore`, with one exception: a host-model worktree that is not
 * locked (an `init` killed after `git worktree add`) is locked again with
 * `WORKTREE_LOCK_REASON`, and the message says the lock was restored (the
 * word `lock` appears); `created` false, `hostGitignore` null, `repair`
 * null, `joined` false, `model` the detected model, `remote` the remote
 * `sync` would use (`boardRemote`), `events` the count in the board, and a
 * message that says the board already exists at `dir`, names its model
 * (`host` or `standalone`), where the history lives
 * (`refs/agentboard/board`, or the branch of the board repository) and the
 * remote (or that there is none).
 * For a standalone board found through a git repository (source `git`) with
 * git 2.32 or later the message also suggests `agentboard init --into-host`
 * (that text appears); otherwise it does not. Exit 0. One exception, so
 * that an `init` interrupted after `git worktree add` is completed by
 * running it again: a host-model board whose worktree is not locked is
 * locked (`addBoardWorktree`, which changes nothing on a healthy board).
 * A second exception, for the temporary worktrees of `init --into-host`
 * (`src/board/into-host.ts`; add-board-sharing design.md decision 9,
 * ruling E): on a host-model board, under the init lock,
 * `cleanDeadMigratingWorktrees` removes every dead-pid temporary
 * worktree without rebase state under `<git common dir>/agentboard/migrating/`
 * (one with a rebase stopped in it, or a live pid, is left alone); the
 * board, its ref and its events are untouched, and the message names what
 * was removed. The `migrating` directory, when it is then empty, is
 * removed only when no kept repository (`standalone-*`) exists under
 * `<git common dir>/agentboard/` (round 3 ruling 3): beside one it is the
 * marker of a move whose `sync` has not completed (a move killed after
 * its `worktree move`, or whose `sync` failed; design.md decision 9,
 * "Resuming"), which plain `init` never removes and never finishes: the
 * message then says that an `agentboard init --into-host` was interrupted
 * before its sync completed and names `agentboard init --into-host` to
 * run (both texts `sync` and `agentboard init --into-host` appear), the
 * worktree lock is restored as above, no carry-over and no `sync` run
 * (the ref, the remote and the kept repository are as they were), and the
 * next `agentboard init --into-host` is `resumed`. A healthy host-model
 * board without the marker never says `agentboard init --into-host`.
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
 * completed in place (see "New standalone board").
 *
 * Interrupted repair: when `dir` is missing and
 * `<git common dir>/agentboard/repairing` is a registered, present
 * worktree (a repair killed between keeping the old directory aside and
 * `git worktree move`), `adoptRepairingWorktree` moves it into place and
 * the result is reported as a repair: `created` false, `repair` with
 * `method` `fresh-worktree`, `copied` and `skipped` empty, `source` null
 * and `keptAt` the newest `stale-board-*` directory under
 * `<git common dir>/agentboard/` (null when there is none), and a message
 * naming that kept directory.
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
 *    registered worktree), lock, disable sparse checkout. A fresh worktree
 *    left by an interrupted repair is moved into place instead
 *    (`adoptRepairingWorktree`).
 * 5. Catch up the cache (`openBoard` then close), so the next command sees
 *    every event; `events` counts the event files.
 * A healthy existing board is reported without taking the init lock
 * (nothing changes a healthy board, and nothing is written, not even
 * under the host's `.git`), and an ambiguous remote refuses before the
 * lock too. Otherwise the whole host-model path, from the decision
 * between a board another `init` finished meanwhile, a repair and a new
 * or joined board through steps 3 and 4, runs under `withInitLock`
 * (design.md decision 2), so two `init` processes on one host take turns
 * and leave one ref and one worktree: a `.board` that another `init` is
 * in the middle of adding (the directory exists, `events/` does not)
 * would otherwise look like a stray directory to a second `init`, which
 * would decide to repair a board that is healthy by the time it holds
 * the lock; under the lock it sees the finished board and reports it as
 * existing.
 * The result has `created` true, `model` `host`, `remote` the chosen name
 * or null, and a message naming `dir`, the model, and, by the ref's
 * source: `remote`, how many events were joined from the remote
 * (`joined <n> events from <remote>` style wording, the count and the
 * remote appear); `local`, that the board was restored from the local
 * `refs/agentboard/board` with the number of event files (the words
 * `restored` and `local` and the count appear, never `new empty board`),
 * unless the ref holds nothing but the deterministic empty-board commit
 * (a racing `init` wrote it, or an empty board's directory was deleted),
 * which is reported as `created` is: a board with no history of its own
 * was never restored from anything; `created`, that the board is new and
 * that `agentboard sync` publishes it (to `<remote>`, or once the
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
 * Host `.gitignore` (both models): when discovery's source is `git` and
 * `hostRoot` is the top level of a working tree (the host model, or the
 * old-git fallback in such a host), the host `.gitignore` is
 * `<parent of dir>/.gitignore`. When no line of it,
 * trimmed, equals `.board/`, `.board`, `/.board/` or `/.board`, the line
 * `.board/` is appended (after a newline when the file does not end with
 * one), or the file is created containing `.board/\n`. Existing content is
 * kept byte for byte. When the source is `env` or `cwd`, or `hostRoot` is
 * not a working tree (a bare repository's or a submodule's git directory
 * container), no host file is touched (`hostGitignore` null).
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
  const env: Env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const version = gitVersion(env, cwd);
  if (version === null) {
    throw new BoardError(
      1,
      'git-missing',
      'agentboard init needs git (the board is kept in a git repository), but git could not be run',
    );
  }
  // The host model needs a host whose git directory is inside its working
  // tree; the decision is taken before anything is written.
  const inTree = source === 'git' && hasInTreeGitDir(dirname(dir), env);
  const hostModel = inTree && meetsGitFloor(version);
  const warnings: string[] = [];
  let why = '';
  if (source === 'git' && !inTree) {
    const gitDir = resolve(
      cwd,
      gitRunner(cwd, { env }).run('rev-parse', '--git-common-dir').trim(),
    );
    why = "; the host model needs the repository's .git directory inside its working tree";
    warnings.push(
      `the git directory of this repository is ${asciiText(gitDir)}, outside its working tree, ` +
        "but a board in the host repository needs the repository's .git directory inside its " +
        'working tree; created a standalone board (a repository of its own) instead',
    );
  } else if (source === 'git' && !hostModel) {
    why = '; the host model needs git 2.32 or later';
    warnings.push(
      `git ${formatVersion(version)} was found, but a board in the host repository needs ` +
        'git 2.32 or later; created a standalone board (a repository of its own) instead',
    );
  }

  // A healthy board is reported as it is, with nothing written, not even
  // the init lock: no init changes a healthy board.
  const healthy = healthyBoard(dir, env);
  if (healthy !== null) {
    // A host-model board with temporary worktrees of a move under
    // `<git common dir>/agentboard/migrating` is cleaned under the lock.
    return healthy.model === 'host' && hostModel && existsSync(migratingDirOf(dirname(dir), env))
      ? withInitLock(dirname(dir), () => existingBoard(dir, healthy, hostModel, env, true), {
          env,
        })
      : existingBoard(dir, healthy, hostModel, env, false);
  }
  if (!hostModel) {
    return createStandaloneBoard(dir, inTree, warnings, why, env);
  }
  // An ambiguous remote refuses before anything is written, the lock
  // included. Then the lock comes before the decision between an existing
  // board, a repair and a new or joined board: a board another init is in
  // the middle of adding must be seen finished, not repaired.
  const hostRoot = dirname(dir);
  const remote = hostRemote(hostRoot, env);
  return withInitLock(hostRoot, () => hostModelBoard(dir, remote, env), { env });
}

/** `<git common dir>/agentboard/migrating` of the host at `hostRoot`, the directory of a move's temporary worktrees. */
function migratingDirOf(hostRoot: string, env: Env): string {
  const common = gitRunner(hostRoot, { env }).run('rev-parse', '--git-common-dir').trim();
  return join(resolve(hostRoot, common), AGENTBOARD_GIT_SUBDIR, MIGRATING_DIR);
}

/** The model of the board at `dir` when it exists and is healthy (`host` or `standalone`), else null. */
function healthyBoard(dir: string, env: Env): BoardModelInfo | null {
  if (!boardExists(dir)) {
    return null;
  }
  const info = detectBoardModel(dir, { env });
  return info.model === 'host' || info.model === 'standalone' ? info : null;
}

/**
 * The host-model path of `initBoard` for a `dir` that was not a healthy
 * board before the init lock was taken, run under the lock: a board
 * another init finished meanwhile is reported, a `.board` directory that
 * is not a healthy board is repaired, and a missing one is created or
 * joined.
 */
function hostModelBoard(dir: string, remote: string | null, env: Env): InitResult {
  const healthy = healthyBoard(dir, env);
  if (healthy !== null) {
    return existingBoard(dir, healthy, true, env, true);
  }
  return existsSync(dir) ? repairBoard(dir, remote, env) : createHostBoard(dir, remote, env);
}

/**
 * True when `hostRoot` is the top level of a working tree whose git common
 * directory is `<hostRoot>/.git`, compared as realpaths (`git rev-parse
 * --show-toplevel --git-common-dir` run in `hostRoot`). False for a bare
 * repository's container, a `--separate-git-dir` repository's container,
 * the `.git/modules` directory of a superproject, and anything git cannot
 * run in. Decides whether `init` writes the host `.gitignore` entry.
 */
export function hasInTreeGitDir(hostRoot: string, env: Env): boolean {
  const out = gitRunner(hostRoot, { env }).attempt(
    'rev-parse',
    '--show-toplevel',
    '--git-common-dir',
  );
  if (isGitFailure(out)) {
    return false;
  }
  const [top = '', common = ''] = out.split('\n').map((line) => line.trim());
  return (
    realpathOrSelf(resolve(hostRoot, top)) === realpathOrSelf(hostRoot) &&
    realpathOrSelf(resolve(hostRoot, common)) === realpathOrSelf(join(hostRoot, '.git'))
  );
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The existing-board report (`initBoard`): nothing is created or modified. */
function existingBoard(
  dir: string,
  info: BoardModelInfo,
  hostModel: boolean,
  env: Env,
  locked: boolean,
): InitResult {
  const choice = boardRemote(info, { env });
  const remote = choice.chosen?.name ?? null;
  const remoteText = remote === null ? 'no remote configured' : `remote: ${asciiText(remote)}`;
  const lines: string[] = [];
  if (info.model === 'host') {
    let changed = 'nothing changed';
    if (hostModel && !boardWorktreeLocked(dirname(dir), dir, { env })) {
      // Finishes an init interrupted after `git worktree add`: locks the worktree.
      addBoardWorktree(dirname(dir), dir, { env });
      changed = 'restored the worktree lock that an interrupted init had not set';
    }
    lines.push(
      `board already exists at ${asciiText(dir)} (host model: its history is ${BOARD_REF} ` +
        `in the host repository; ${remoteText}); ${changed}`,
    );
    if (hostModel && locked) {
      // Temporary worktrees of a move that died: removed under the init
      // lock (held by the caller), as `init --into-host` removes them on a
      // board already moved.
      const removed = cleanDeadMigratingWorktrees(dirname(dir), { env });
      if (removed.length > 0) {
        lines.push(
          `removed ${removed.map((p) => asciiText(p)).join(', ')}, left by an interrupted ` +
            'agentboard init --into-host',
        );
      }
    }
  } else {
    const history =
      choice.branch === null
        ? 'a detached HEAD in the board repository'
        : `branch ${asciiText(choice.branch)} of the board repository`;
    lines.push(
      `board already exists at ${asciiText(dir)} (standalone model: its history is ${history}; ` +
        `${remoteText}); nothing changed`,
    );
    if (hostModel) {
      lines.push('run agentboard init --into-host to move the board into the host repository');
    }
  }
  return {
    dir,
    created: false,
    model: info.model === 'host' ? 'host' : 'standalone',
    joined: false,
    remote,
    events: countEvents(dir),
    hostGitignore: null,
    warnings: [],
    repair: null,
    message: lines.join('\n'),
  };
}

/** The remote choice for the host repository at `hostRoot`, refused when ambiguous. */
function hostRemote(hostRoot: string, env: Env): string | null {
  const branch = gitRunner(hostRoot, { env }).attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  const choice = chooseRemote(hostRoot, isGitFailure(branch) ? null : branch.trim(), { env });
  if (choice.ambiguous) {
    throw ambiguousRemoteError(choice, 'init');
  }
  return choice.chosen?.name ?? null;
}

/** A new host-model board at `dir` (`initBoard`, "New host-model board"), with `remote` already chosen; runs under the init lock. */
function createHostBoard(dir: string, remote: string | null, env: Env): InitResult {
  const hostRoot = dirname(dir);
  const hostGitignore = ignoreBoardInHost(hostRoot);
  const ref = ensureBoardRef(hostRoot, remote, { env });
  const adopted = adoptRepairingWorktree(hostRoot, dir, { env });
  addBoardWorktree(hostRoot, dir, { env });
  openBoard(dir).close();
  const events = countEvents(dir);
  const base = {
    dir,
    model: 'host' as const,
    remote,
    events,
    hostGitignore,
    warnings: [...ref.warnings],
  };
  if (adopted) {
    // A repair interrupted between keeping the old directory aside and moving
    // the fresh worktree into place: finished now, reported as that repair.
    const keptAt = newestStaleBoard(hostRoot, { env });
    const kept =
      keptAt === null
        ? 'no kept copy of the old directory was found'
        : `the old directory is kept at ${asciiText(keptAt)}`;
    return {
      ...base,
      created: false,
      joined: false,
      repair: { method: 'fresh-worktree', copied: [], skipped: [], keptAt, source: null },
      message:
        `repaired the board at ${asciiText(dir)}: moved the fresh worktree of an interrupted ` +
        `repair into place; ${kept}`,
    };
  }
  const where = `created the board at ${asciiText(dir)} (host model: a worktree of the host repository at ${BOARD_REF})`;
  // A local ref at the empty-board commit is a new board, not a restored
  // one: a racing init wrote it, or an empty board's directory was deleted.
  const restored =
    ref.source === 'local' && ref.commit !== writeEmptyBoardCommit(hostRoot, { env });
  const how =
    ref.source === 'remote'
      ? `joined ${plural(events, 'event')} from ${asciiText(remote ?? '')}`
      : restored
        ? `restored it from the local ${BOARD_REF} with ${plural(events, 'event file')}`
        : remote === null
          ? 'a new empty board; agentboard sync publishes it once the repository has a remote'
          : `a new empty board; agentboard sync publishes it to ${asciiText(remote)}, ` +
            'where everyone who can fetch the remote can read it';
  return {
    ...base,
    created: true,
    joined: ref.source === 'remote',
    repair: null,
    message: `${where}; ${how}`,
  };
}

/** Repairs the board directory `dir` whose host link is broken or which is not a repository, with `remote` already chosen; runs under the init lock. */
function repairBoard(dir: string, remote: string | null, env: Env): InitResult {
  const hostRoot = dirname(dir);
  const hostGitignore = ignoreBoardInHost(hostRoot);
  const repair = repairBoardLink(hostRoot, dir, remote, { env });
  openBoard(dir).close();
  const events = countEvents(dir);
  const kept = repair.keptAt ?? '';
  const message =
    repair.method === 'worktree-repair'
      ? `repaired the board at ${asciiText(dir)}: relinked the worktree to the host repository ` +
        `at ${asciiText(hostRoot)}; nothing was copied or kept aside`
      : `repaired the board at ${asciiText(dir)}: built a fresh worktree at ${BOARD_REF} ` +
        `(${sourceText(repair.source, remote)}), copied ${plural(repair.copied.length, 'event file')} ` +
        `from the old directory, which is kept at ${asciiText(kept)}`;
  return {
    dir,
    created: false,
    model: 'host',
    joined: repair.source === 'remote',
    remote,
    events,
    hostGitignore,
    warnings: repair.skipped.map(
      (name) =>
        `skipped the event file ${asciiText(name)} (kept at ${asciiText(join(kept, 'events'))}): ` +
        'its content does not match its name',
    ),
    repair,
    message,
  };
}

/** Where a repaired board's history came from, for the repair message. */
function sourceText(source: BoardRefSource | null, remote: string | null): string {
  if (source === 'remote') {
    return `joined from ${asciiText(remote ?? '')}`;
  }
  return source === 'local' ? 'from the local ref' : 'a new empty board';
}

/** A new standalone board at `dir` (`initBoard`, "New standalone board"), completing what is there. */
function createStandaloneBoard(
  dir: string,
  writeHostGitignore: boolean,
  warnings: string[],
  why: string,
  env: Env,
): InitResult {
  writeStandaloneRepository(dir, env);
  const hostGitignore = writeHostGitignore ? ignoreBoardInHost(dirname(dir)) : null;
  return {
    dir,
    created: true,
    model: 'standalone',
    joined: false,
    remote: null,
    events: 0,
    hostGitignore,
    warnings,
    repair: null,
    message: `created the board at ${asciiText(dir)} (standalone model: a git repository of its own${why})`,
  };
}

/**
 * Steps 1 to 3 of "New standalone board" (`initBoard`): `dir`, a git
 * repository in it when `dir/.git` is missing (`git init`, no commit), the
 * board `.gitignore` and `events/.gitkeep`, each created only when missing
 * and never overwritten. `init --remote` makes its new board with this too.
 */
export function writeStandaloneRepository(dir: string, env: Env): void {
  // The events directory is created last: it is what makes the board exist,
  // so an interrupted init is completed by running init again.
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    gitRunner(dir, { env }).run('init', '-q');
  }
  writeIfMissing(join(dir, '.gitignore'), BOARD_GITIGNORE_LINES.map((l) => `${l}\n`).join(''));
  mkdirSync(join(dir, 'events'), { recursive: true });
  writeIfMissing(join(dir, 'events', '.gitkeep'), '');
}

/** `<major>.<minor>.<patch>`. */
function formatVersion(version: GitVersion): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

/** `<n> <noun>` or `<n> <noun>s`. */
function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** The number of event files (`<64 hex>.json`) in `<dir>/events`. */
export function countEvents(dir: string): number {
  return readdirSync(join(dir, 'events')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .length;
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
 * appended to, else null ("Host `.gitignore`" in `initBoard`).
 */
export function ignoreBoardInHost(hostRoot: string): string | null {
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
