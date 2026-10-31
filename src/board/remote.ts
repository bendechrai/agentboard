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

import { BoardError } from '../store/errors.js';
import {
  firstErrorLine,
  gitRunner,
  gitVersion,
  isGitFailure,
  meetsGitFloor,
  withoutUserinfo,
  type GitRunner,
  type GitRunnerOptions,
} from './git.js';
import {
  BOARD_REF,
  MODEL_TEXT,
  detectBoardModel,
  type BoardModel,
  type BoardModelInfo,
} from './model.js';
import { asciiText, type Env } from './text.js';

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

/** The text that tells a human how to choose a remote by hand. */
const SET_REMOTE = `git config ${REMOTE_CONFIG_KEY} <name>`;

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
  const git = gitRunner(repoDir, options);
  const remotes = listRemotes(git);
  const configured = configValue(git, REMOTE_CONFIG_KEY);
  const choice = (chosen: ChosenRemote | null, ambiguous = false): RemoteChoice => ({
    chosen,
    remotes,
    ambiguous,
    branch,
    configured,
  });
  const urlOf = (name: string): string | null =>
    remotes.find((remote) => remote.name === name)?.url ?? null;

  if (configured !== null) {
    return choice({ name: configured, url: urlOf(configured), rule: 'agentboard.remote' });
  }
  const upstream = branch === null ? null : upstreamRemote(git, branch);
  if (upstream !== null) {
    return choice({ name: upstream, url: urlOf(upstream), rule: 'upstream' });
  }
  const origin = urlOf('origin');
  if (origin !== null) {
    return choice({ name: 'origin', url: origin, rule: 'origin' });
  }
  const only = remotes.length === 1 ? remotes[0] : undefined;
  if (only !== undefined) {
    return choice({ name: only.name, url: only.url, rule: 'only' });
  }
  return choice(null, remotes.length > 1);
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
  if (info.model === 'standalone') {
    return chooseRemote(info.dir, currentBranch(gitRunner(info.dir, options)), options);
  }
  if (info.model === 'host') {
    return chooseRemote(info.dir, mainWorktreeBranch(gitRunner(info.dir, options)), options);
  }
  return { chosen: null, remotes: [], ambiguous: false, branch: null, configured: null };
}

/**
 * The `ambiguous-remote` refusal of `sync` and `init` for `choice` (which
 * has `ambiguous` true): `BoardError(1, 'ambiguous-remote')` whose message
 * names every remote of `choice.remotes` (through `asciiText`), says that
 * none is `origin` and no upstream chose one, and says to set one with
 * `git config agentboard.remote <name>` (that text appears literally) and
 * run `agentboard <command>` again (`sync` by default; `init` passes
 * `init`, so the text `agentboard init` appears). Pure.
 */
export function ambiguousRemoteError(choice: RemoteChoice, command: 'sync' | 'init' = 'sync'): Error {
  return new BoardError(
    1,
    'ambiguous-remote',
    `the repository that holds the board's history has several remotes (${remoteNames(choice.remotes)}), ` +
      `none of them origin and none the upstream of the branch; choose one with ${SET_REMOTE} ` +
      `in that repository and run agentboard ${command} again`,
  );
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
  const env = options?.env;
  const info = detectBoardModel(dir, { env });
  const empty: RemoteReport = {
    dir: info.dir,
    model: info.model,
    gitDir: info.gitDir,
    ref: null,
    refCommit: null,
    branch: null,
    head: null,
    remote: null,
    remotes: [],
    problems: [],
  };

  const git = gitRunner(info.dir, { env });
  const versionOut = git.attempt('--version');
  if (isGitFailure(versionOut)) {
    return {
      ...empty,
      problems: [
        `git could not be run (${firstErrorLine(versionOut)}); install git and put it on the PATH`,
      ],
    };
  }
  if (info.model === 'broken-host-link') {
    return { ...empty, problems: [`${info.detail ?? ''}; run agentboard init to repair it`] };
  }
  if (info.model === 'not-a-repository') {
    return {
      ...empty,
      problems: [
        `the board directory ${asciiText(info.dir)} is not a git repository or worktree; run agentboard init to make it one`,
      ],
    };
  }

  const choice = boardRemote(info, { env });
  const problems: string[] = [];
  if (choice.ambiguous) {
    problems.push(
      `the remote is ambiguous: the repository has the remotes ${remoteNames(choice.remotes)} ` +
        `and none is origin or the upstream of the branch; choose one with ${SET_REMOTE}`,
    );
  }
  if (choice.chosen !== null && choice.chosen.url === null) {
    const existing =
      choice.remotes.length === 0
        ? 'the repository has no remote'
        : `the remotes are ${remoteNames(choice.remotes)}`;
    problems.push(
      `${REMOTE_CONFIG_KEY} names ${asciiText(withoutUserinfo(choice.chosen.name))}, which is not a remote of the repository ` +
        `(${existing}); set it to one of them with ${SET_REMOTE}`,
    );
  }
  if (info.model === 'host') {
    const version = gitVersion(env, info.dir);
    if (version !== null && !meetsGitFloor(version)) {
      const found = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
      problems.push(
        `git ${found} was found, but a board in the host repository needs git 2.32 or later; ` +
          'upgrade git before running agentboard sync',
      );
    }
  }

  const head = commitOf(git, 'HEAD');
  return {
    ...empty,
    ref: info.model === 'host' ? BOARD_REF : null,
    refCommit: info.model === 'host' ? commitOf(git, BOARD_REF) : null,
    branch: info.model === 'standalone' ? choice.branch : null,
    head,
    // URLs are shown without their user information (board-cli "Remote
    // URLs are shown without credentials"); git keeps them as configured.
    remote:
      choice.chosen === null
        ? null
        : {
            ...choice.chosen,
            // The name too: `agentboard.remote` or the upstream may name
            // the remote by URL.
            name: withoutUserinfo(choice.chosen.name),
            url: choice.chosen.url === null ? null : withoutUserinfo(choice.chosen.url),
          },
    remotes: choice.remotes.map((remote) => ({ ...remote, url: withoutUserinfo(remote.url) })),
    problems,
  };
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
  const lines = [`board: ${report.dir}`, `model: ${MODEL_TEXT[report.model]}`];
  if (report.model === 'host' || report.model === 'standalone') {
    const where = `in ${report.gitDir ?? ''}`;
    if (report.model === 'host') {
      lines.push(
        report.refCommit === null
          ? `history: ${BOARD_REF} missing ${where}`
          : `history: ${BOARD_REF} at ${report.refCommit} ${where}`,
      );
    } else if (report.branch === null) {
      lines.push(`history: detached HEAD at ${report.head ?? ''} ${where}`);
    } else if (report.head === null) {
      lines.push(`history: branch ${report.branch} (no commits yet) ${where}`);
    } else {
      lines.push(`history: branch ${report.branch} at ${report.head} ${where}`);
    }
    lines.push(remoteLine(report));
    if (report.remotes.length === 0) {
      lines.push('remotes: none');
    } else {
      lines.push('remotes:', ...report.remotes.map((r) => `  ${r.name}  ${r.url}`));
    }
  }
  lines.push(...report.problems.map((problem) => `problem: ${problem}`));
  return lines.map((line) => `${asciiText(line)}\n`).join('');
}

/** Line 4 of `renderRemote`. */
function remoteLine(report: RemoteReport): string {
  const remote = report.remote;
  if (remote === null) {
    return report.remotes.length === 0
      ? 'remote: none configured'
      : `remote: ambiguous (${remoteNames(report.remotes)}); set one with ${SET_REMOTE}`;
  }
  if (remote.url === null) {
    return `remote: ${remote.name} (chosen by ${RULE_TEXT[remote.rule]}; no such remote)`;
  }
  return `remote: ${remote.name} ${remote.url} (chosen by ${RULE_TEXT[remote.rule]})`;
}

/** The names of `remotes`, comma-separated, through `asciiText`. */
function remoteNames(remotes: readonly NamedRemote[]): string {
  return remotes.map((remote) => asciiText(remote.name)).join(', ');
}

/** Every remote of the repository, by name, with its fetch URL. */
function listRemotes(git: GitRunner): NamedRemote[] {
  const names = git.attempt('remote');
  if (isGitFailure(names)) {
    return [];
  }
  return names
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .sort()
    .map((name) => {
      const url = git.attempt('remote', 'get-url', name);
      return { name, url: isGitFailure(url) ? '' : url.trim() };
    });
}

/** `git config --get <key>`, trimmed, or null when unset or empty. */
function configValue(git: GitRunner, key: string): string | null {
  const out = git.attempt('config', '--get', key);
  if (isGitFailure(out) || out.trim() === '') {
    return null;
  }
  return out.trim();
}

/**
 * The remote of the upstream of `branch`: `branch.<branch>.remote` when it
 * and `branch.<branch>.merge` are both set and the remote is not `.`.
 */
function upstreamRemote(git: GitRunner, branch: string): string | null {
  const remote = configValue(git, `branch.${branch}.remote`);
  const merge = configValue(git, `branch.${branch}.merge`);
  if (remote === null || merge === null || remote === '.') {
    return null;
  }
  return remote;
}

/** The current branch of the repository `git` runs in, or null when HEAD is detached. */
function currentBranch(git: GitRunner): string | null {
  const ref = git.attempt('symbolic-ref', '--quiet', '--short', 'HEAD');
  return isGitFailure(ref) ? null : ref.trim();
}

/**
 * The branch checked out in the main worktree of the repository `git` runs
 * in: the first entry of `git worktree list --porcelain`, null when it is
 * detached or git cannot say.
 */
function mainWorktreeBranch(git: GitRunner): string | null {
  const out = git.attempt('worktree', 'list', '--porcelain');
  if (isGitFailure(out)) {
    return null;
  }
  const first = out.split('\n\n')[0] ?? '';
  const branch = /^branch (.+)$/m.exec(first)?.[1]?.trim() ?? null;
  if (branch === null) {
    return null;
  }
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

/** The full id of the commit `rev` names, or null when it does not resolve to one. */
function commitOf(git: GitRunner, rev: string): string | null {
  const out = git.attempt('rev-parse', '--quiet', '--verify', `${rev}^{commit}`);
  return isGitFailure(out) ? null : out.trim();
}
