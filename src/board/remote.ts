/**
 * Remote choice for both board models and the `agentboard remote` command
 * (board-concurrency: "Sync converges", the remote rules; board-cli:
 * "Showing how a board is shared"; add-board-sharing design.md: decisions 5
 * and 10).
 *
 * The remote is chosen in the repository that holds the board's history
 * (the board repository for a standalone board, the host repository for a
 * host-model board), in this order: the remote named by the git
 * configuration value `agentboard.remote` in that repository, when set; the
 * remote of the upstream of the current branch (for a host-model board, the
 * branch checked out in the host's main worktree, not the branch of
 * whichever linked worktree the command runs in), ignoring an upstream
 * remote of `.`; `origin` when it exists; the only remote. With several
 * remotes and none chosen by these rules the choice is ambiguous.
 *
 * `remote` is read-only and never contacts the network: every git command
 * it runs is local (`rev-parse`, `config`, `remote`, `symbolic-ref`,
 * `worktree list`, `for-each-ref`), never `ls-remote`, `fetch`, `pull` or
 * `push`.
 */

import type { GitRunnerOptions } from './git.js';
import type { BoardModel, BoardModelInfo } from './model.js';
import type { Env } from './text.js';

/** The configuration key that names the remote `sync` uses, overriding every other rule. */
export const REMOTE_CONFIG_KEY = 'agentboard.remote';

/**
 * The rule that chose a remote (board-concurrency "Sync converges"), as
 * the `rule` of `agentboard remote --json`:
 * - `agentboard.remote`: `git config agentboard.remote <name>` in the repository;
 * - `upstream`: the remote of the upstream of the branch (the board
 *   repository's branch, or the host's main worktree's branch);
 * - `origin`: a remote named `origin` exists;
 * - `only`: the repository has exactly one remote.
 */
export type RemoteRule = 'agentboard.remote' | 'upstream' | 'origin' | 'only';

/** How each rule is named for a human (`agentboard remote`). */
export const RULE_TEXT: Readonly<Record<RemoteRule, string>> = {
  'agentboard.remote': 'agentboard.remote',
  upstream: 'upstream',
  origin: 'origin',
  only: 'only remote',
};

/** One remote of a repository. */
export interface NamedRemote {
  readonly name: string;
  /** The fetch URL (`git remote get-url <name>`), as git prints it. */
  readonly url: string;
}

/** The remote a sync would use and why. */
export interface ChosenRemote {
  readonly name: string;
  /**
   * The fetch URL, or null when `agentboard.remote` names a remote the
   * repository does not have (a sync then fails to reach it, exit 3
   * `sync-failed`; `remote` lists the problem).
   */
  readonly url: string | null;
  readonly rule: RemoteRule;
}

/** Result of `chooseRemote` and `boardRemote`. */
export interface RemoteChoice {
  /**
   * The remote `sync` would use, or null when the repository has no remote
   * or the choice is ambiguous.
   */
  readonly chosen: ChosenRemote | null;
  /** Every remote of the repository, by name ascending, with its fetch URL. */
  readonly remotes: readonly NamedRemote[];
  /**
   * True when the repository has several remotes and no rule chose one:
   * `sync` then exits 1 with reason `ambiguous-remote` (after committing),
   * `init` refuses before writing anything, and `remote` says how to set
   * `agentboard.remote`.
   */
  readonly ambiguous: boolean;
  /**
   * The branch whose upstream the rule consulted (`main`, for example), or
   * null when HEAD is detached. Unborn branches count as branches.
   */
  readonly branch: string | null;
  /** The value of `agentboard.remote` in the repository, or null when unset. */
  readonly configured: string | null;
}

/**
 * Chooses the remote of the repository at `repoDir` (a board repository or
 * a worktree of the host) for the branch `branch` (null for a detached
 * HEAD), by the rules in the module comment, running git with
 * `gitRunner(repoDir, options)`:
 *
 * 1. `git config --get agentboard.remote`: when it prints a non-empty
 *    value, that name is chosen with rule `agentboard.remote`, with its URL when a
 *    remote of that name exists and null otherwise.
 * 2. Else, when `branch` is not null and both `branch.<branch>.remote` and
 *    `branch.<branch>.merge` are set, and the remote is not `.`: that
 *    remote with rule `upstream`.
 * 3. Else `origin` with rule `origin` when a remote of that name exists.
 * 4. Else the only remote with rule `only` when there is exactly one.
 * 5. Else `chosen` null: `ambiguous` true when there are two or more
 *    remotes, false when there is none.
 *
 * `remotes` always lists every remote (`git remote`) with its fetch URL;
 * `configured` is the raw value of step 1 or null. Never contacts the
 * network.
 */
export function chooseRemote(
  repoDir: string,
  branch: string | null,
  options?: GitRunnerOptions,
): RemoteChoice {
  void repoDir;
  void branch;
  void options;
  throw new Error('not implemented');
}

/**
 * The remote choice of a board: `chooseRemote` in the board directory with
 * the branch the model prescribes. For `standalone`, the board repository's
 * current branch (`git symbolic-ref --short HEAD`, null when detached). For
 * `host`, the branch checked out in the host's main worktree (the first
 * entry of `git worktree list --porcelain`, null when it is detached), so
 * every agent on the board picks the same remote whatever worktree it runs
 * in; the configuration and remotes are the host repository's (a linked
 * worktree shares them). For `broken-host-link` and `not-a-repository`
 * nothing can be inspected: `chosen` null, `remotes` empty, `ambiguous`
 * false, `branch` null, `configured` null. Never contacts the network.
 */
export function boardRemote(info: BoardModelInfo, options?: GitRunnerOptions): RemoteChoice {
  void info;
  void options;
  throw new Error('not implemented');
}

/**
 * The `ambiguous-remote` refusal of `sync` and `init` for `choice` (which
 * has `ambiguous` true): `BoardError(1, 'ambiguous-remote')` whose message
 * names every remote of `choice.remotes` (through `asciiText`), says that
 * none is `origin` and no upstream chose one, and says to set one with
 * `git config agentboard.remote <name>` (that text appears literally). Pure.
 */
export function ambiguousRemoteError(choice: RemoteChoice): Error {
  void choice;
  throw new Error('not implemented');
}

/** The `agentboard remote --json` document (board-cli: "Showing how a board is shared"). */
export interface RemoteReport {
  /** Absolute path of the board directory. */
  readonly dir: string;
  readonly model: BoardModel;
  /** `BoardModelInfo.gitDir`: the host repository's git directory (host), the board repository (standalone), else null. */
  readonly gitDir: string | null;
  /** `BOARD_REF` for the host model, else null. */
  readonly ref: string | null;
  /**
   * Host model: the full hex id of the commit `refs/agentboard/board`
   * points to in the host repository, or null when the ref does not exist.
   * Null for every other model.
   */
  readonly refCommit: string | null;
  /** Standalone model: the board repository's current branch (null when detached). Null for every other model. */
  readonly branch: string | null;
  /**
   * The full hex id of the board worktree's HEAD commit (host and standalone
   * models), or null when HEAD is unborn or the model has no worktree to ask.
   */
  readonly head: string | null;
  /** The remote `sync` would use with its URL and the rule that chose it, or null. */
  readonly remote: ChosenRemote | null;
  /** Every remote of the repository that holds the history, by name ascending. */
  readonly remotes: readonly NamedRemote[];
  /**
   * Plain ASCII lines, one per problem, each saying how to fix it, in this
   * order where they apply:
   * - a broken host link: the `BoardModelInfo.detail`, and that
   *   `agentboard init` repairs it (the text `agentboard init` appears);
   * - not a repository: that `agentboard init` makes it one;
   * - an ambiguous remote: the remote names and how to choose one with
   *   `git config agentboard.remote <name>` (that text appears);
   * - `agentboard.remote` naming a remote that does not exist: the name,
   *   and the names that exist;
   * - a host-model board with git older than `HOST_MODEL_GIT_FLOOR`: the
   *   version found and that the host model needs git 2.32 or later (the
   *   text `2.32` appears); a standalone board never reports its git
   *   version;
   * - git not runnable: that git could not be run (the word `git` appears).
   * Empty when nothing is wrong.
   */
  readonly problems: readonly string[];
}

/** Options of `remoteReport`. */
export interface RemoteReportOptions {
  /** Environment for the git child processes. Defaults to `process.env`. */
  readonly env?: Env | undefined;
}

/**
 * `agentboard remote`: how the board at `dir` (an existing board directory,
 * found by discovery; the caller checks it exists) is shared. Runs
 * `detectBoardModel`, `boardRemote` and local ref lookups only
 * (`rev-parse`, `symbolic-ref`, `for-each-ref`); never `ls-remote`,
 * `fetch`, `pull` or `push`, so it never contacts the network, and writes
 * nothing (not the cache either: it never opens the board). Never throws
 * for a board whose git state is odd: everything wrong goes into
 * `problems`, so the CLI exits 0 whenever the board directory exists. When
 * git cannot be run at all, `model` is `not-a-repository`, every git-derived
 * field is null or empty, and `problems` names git.
 */
export function remoteReport(dir: string, options?: RemoteReportOptions): RemoteReport {
  void dir;
  void options;
  throw new Error('not implemented');
}

/**
 * The human text of `agentboard remote`, plain ASCII, ending with one
 * newline, one fact per line in this order:
 * 1. `board: <dir>`;
 * 2. `model: <MODEL_TEXT[model]>` (so `model: host`, `model: standalone`,
 *    `model: broken host link` or `model: not a repository`);
 * 3. (host and standalone models only) where the history lives: for the
 *    host model `history: refs/agentboard/board at <refCommit> in <gitDir>`
 *    (or `history: refs/agentboard/board missing in <gitDir>` when the ref
 *    does not exist); for the standalone model
 *    `history: branch <branch> at <head> in <gitDir>`, with
 *    `branch <branch> (no commits yet)` for a null head and
 *    `detached HEAD at <head>` for a null branch;
 * 4. (host and standalone models only) the remote:
 *    `remote: <name> <url> (chosen by <RULE_TEXT[rule]>)`, or
 *    `remote: <name> (chosen by agentboard.remote; no such remote)` when
 *    its URL is null, or, when `remote` is null, `remote: none configured`
 *    when `remotes` is empty and otherwise
 *    `remote: ambiguous (<names in remotes order>); set one with git config agentboard.remote <name>`;
 * 5. (host and standalone models only) `remotes:` followed by one line
 *    `  <name>  <url>` per remote, or `remotes: none`;
 * 6. one line `problem: <text>` per problem.
 * So a broken link or a non-repository prints the board, the model and its
 * problems only. Every line goes through `asciiText`. Pure.
 */
export function renderRemote(report: RemoteReport): string {
  void report;
  throw new Error('not implemented');
}
