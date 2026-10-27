/**
 * The git layer shared by every command that runs git on the board
 * (`init`, `sync` and `remote`; add-board-sharing design.md: decisions 3
 * and 4; board-events: "Board ref in the host repository"): one runner with
 * the sanitised environment, the fixed identity and `commit.gpgsign=false`
 * of ADR 0005, an option that keeps the target repository's hooks from
 * running, `attempt` returning failures instead of throwing, and the git
 * version with the floor the host model needs.
 *
 * Nothing here reads or writes event files or the cache.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { asciiText, type Env } from './text.js';

/**
 * The fixed identity every git command run by agentboard is given (as
 * `-c user.name=<name> -c user.email=<email>` and as the `GIT_AUTHOR_*`
 * and `GIT_COMMITTER_*` variables), so that commits and rebases work on a
 * machine with no git identity configured, and so board commits are
 * recognisably machine-made. The user's own identity, if any, is never
 * consulted. `SYNC_IDENTITY` in `src/board/sync.ts` is this value.
 */
export const GIT_IDENTITY = { name: 'agentboard', email: 'agentboard@localhost' } as const;

/**
 * Variables that would point git at a repository other than the one it is
 * run in; the runner removes every one of them from the environment it
 * gives git, so a command run from inside a host git hook still acts on the
 * repository it is told to.
 */
export const GIT_REPOSITORY_VARIABLES: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/** A parsed `git --version`. */
export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * The oldest git the host model supports (add-board-sharing design.md,
 * decision 3; board-events "Board directory per project"): 2.32, the oldest
 * version on which `git worktree repair` fixes a host moved together with
 * its `.board`. Any patch level of 2.32 meets it.
 */
export const HOST_MODEL_GIT_FLOOR: Readonly<Pick<GitVersion, 'major' | 'minor'>> = {
  major: 2,
  minor: 32,
};

/**
 * `git version <major>.<minor>[.<patch>]`, then either the end of the text
 * or something that is not a digit (a fourth component, a suffix).
 */
const VERSION_LINE = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:\D[\s\S]*)?$/;

/**
 * Parses the output of `git --version`: `git version <major>.<minor>.<patch>`
 * followed by anything (a trailing newline, a fourth component such as
 * `.windows.1`, a suffix such as ` (Apple Git-154)`), for example:
 * - `git version 2.52.0` is `{ major: 2, minor: 52, patch: 0 }`;
 * - `git version 2.39.5 (Apple Git-154)` is `{ major: 2, minor: 39, patch: 5 }`;
 * - `git version 2.32.0.windows.1` is `{ major: 2, minor: 32, patch: 0 }`;
 * - `git version 2.31.8` is `{ major: 2, minor: 31, patch: 8 }`.
 * A missing patch component (`git version 2.40`) is patch 0. Leading and
 * trailing whitespace is ignored. Anything else (an empty string, a
 * message such as `git: command not found`, a version without `git version`
 * in front of it) is null. Pure.
 */
export function parseGitVersion(text: string): GitVersion | null {
  const match = VERSION_LINE.exec(text.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

/**
 * True when `version` is at least `HOST_MODEL_GIT_FLOOR`: a greater major,
 * or the same major and a minor at least the floor's, whatever the patch
 * (2.32.0 and 2.32.7 meet it, 2.31.8 and 1.9.5 do not, 3.0.0 does). Pure.
 */
export function meetsGitFloor(version: GitVersion): boolean {
  if (version.major !== HOST_MODEL_GIT_FLOOR.major) {
    return version.major > HOST_MODEL_GIT_FLOOR.major;
  }
  return version.minor >= HOST_MODEL_GIT_FLOOR.minor;
}

/**
 * The version of the `git` found on the `PATH` of `env` (default
 * `process.env`), from `git --version` run in `cwd` (default the current
 * working directory) with the runner's sanitised environment, parsed by
 * `parseGitVersion`; null when git cannot be run or its output does not
 * parse. A `git` shim earlier on the `PATH` that prints another version is
 * believed (the tests simulate an older git that way). Never throws.
 */
export function gitVersion(env?: Env, cwd?: string): GitVersion | null {
  // `--version` reads no configuration, so no `-c` prefix: the first
  // argument git sees is `--version`, as a shim on the PATH expects.
  try {
    return parseGitVersion(
      execFileSync('git', ['--version'], {
        cwd: cwd ?? process.cwd(),
        env: sanitisedEnv(env ?? process.env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    return null;
  }
}

/** A git command that failed: its exit status and its captured output. */
export interface GitFailure {
  /** The exit status, or null when git was killed by a signal or could not be run. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** True when `result` (of `attempt` or `attemptIn`) is a failure. Pure. */
export function isGitFailure(result: string | GitFailure): result is GitFailure {
  return typeof result !== 'string';
}

/**
 * The first `fatal:` or `error:` line of a failure's stderr (then stdout),
 * else its first non-empty line, else `git failed`; through `asciiText`,
 * trimmed, one line. Pure.
 */
export function firstErrorLine(failure: GitFailure): string {
  const all = `${failure.stderr}\n${failure.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const line = all.find((l) => /^(fatal|error):/.test(l)) ?? all[0] ?? 'git failed';
  return asciiText(line);
}

/**
 * Every URL configured for the remotes of the git repository at `dir`
 * (no-echo-refusals: "Git lines quoted from remote commands"): for each
 * remote `git remote` lists, every raw `remote.<name>.url` and
 * `remote.<name>.pushurl` value (`git config --get-all`), and every URL
 * git resolves for it after `url.<base>.insteadOf` and `pushInsteadOf`
 * rewrites (`git remote get-url --all <name>` and `git remote get-url
 * --push --all <name>`). Deduplicated, longest first, empty values
 * dropped. A repository with no remotes, or one git cannot read, gives
 * `[]`; never throws. Runs git with the sanitised environment of
 * `GitRunnerOptions.env` (`env` defaults to `process.env`); contacts no
 * remote.
 */
export function configuredRemoteUrls(dir: string, env?: Env): string[] {
  void dir;
  void env;
  throw new Error('not implemented');
}

/**
 * `line`, a git line quoted from a failing git command that talks to a
 * remote (`ls-remote`, `fetch`, `pull`, `push`, and the `remote:` lines a
 * refusing remote prints), with every URL in `urls` treated as
 * `sanitizeGitLine` (`src/board/init-remote.ts`) treats the value given:
 * each URL, and each URL without its user information, replaced by
 * `<url>` (longest first over all of them); the user information of each
 * URL, as configured and percent-decoded, replaced by `<redacted>`
 * wherever it appears; then the user information of every other
 * `<scheme>://<userinfo>@` in the line replaced by `<scheme>://<redacted>@`.
 * With `urls` empty only the last step applies. Pure; never throws.
 *
 * `urls` is what `configuredRemoteUrls` gives for the repository the
 * command ran in (the board repository for a standalone board, the host
 * repository for a host-model board), plus the URL a command was given
 * when it has one. `sanitizeGitLine(line, given, passed)` gives the same
 * result as `sanitizeRemoteLine(line, [given, passed])`, so the two may
 * share one implementation (`sanitizeGitLine` may move here and be
 * re-exported from `init-remote.ts`).
 */
export function sanitizeRemoteLine(line: string, urls: readonly string[]): string {
  void line;
  void urls;
  throw new Error('not implemented');
}

/** Options of `gitRunner`. */
export interface GitRunnerOptions {
  /**
   * Environment for the git child processes. Defaults to `process.env`.
   * Whatever is given, the runner removes `GIT_REPOSITORY_VARIABLES`, sets
   * `GIT_TERMINAL_PROMPT=0` so a remote needing credentials fails instead
   * of waiting for input, and sets the `GIT_AUTHOR_*` and `GIT_COMMITTER_*`
   * name and email variables to `GIT_IDENTITY` (an identity in the given
   * environment never wins).
   */
  readonly env?: Env | undefined;
  /**
   * When true, every command runs with `-c core.hooksPath=<directory>`
   * where `<directory>` is an empty directory the runner creates (under
   * the repository's git directory when it can, else a temporary
   * directory), so no hook of the target repository (pre-commit, pre-push,
   * post-checkout, pre-rebase, ...) runs for the command: host-model
   * boards run inside other people's repositories, whose hooks are written
   * for the host's branches (board-events: "Board ref in the host
   * repository", add-board-sharing design.md decision 4). The repository's
   * own configuration is never written: `git config core.hooksPath` in the
   * repository is unchanged afterwards. Default false: hooks run as git
   * normally runs them (standalone boards behave as before).
   */
  readonly disableHooks?: boolean | undefined;
}

/**
 * Runs git with the sanitised environment of `GitRunnerOptions.env` and the
 * fixed configuration prefix
 * `-c user.name=<GIT_IDENTITY.name> -c user.email=<GIT_IDENTITY.email> -c commit.gpgsign=false`
 * (plus `-c core.hooksPath=<empty directory>` when hooks are disabled),
 * with `execFileSync`, never a shell, stdin ignored (except for `runInput`),
 * stdout and stderr captured as UTF-8 (a 256 MiB buffer).
 */
export interface GitRunner {
  /** The directory `run` and `attempt` run in. */
  readonly dir: string;
  /** Runs git with `args` in `dir` and returns stdout; throws the child process error on failure. */
  run(...args: string[]): string;
  /** Like `run`, but in `cwd`. */
  runIn(cwd: string, ...args: string[]): string;
  /**
   * Like `run`, but with `input` on git's stdin (for plumbing that reads
   * it: `hash-object --stdin`, `mktree`).
   */
  runInput(input: string, ...args: string[]): string;
  /** Runs git in `dir` and returns stdout, or the failure instead of throwing. */
  attempt(...args: string[]): string | GitFailure;
  /** Like `attempt`, but in `cwd`. */
  attemptIn(cwd: string, ...args: string[]): string | GitFailure;
}

/** The name of the empty hooks directory the runner creates under a git directory. */
const NO_HOOKS_DIR = 'agentboard-no-hooks';

/**
 * A `GitRunner` for the repository (or worktree) at `dir`. Pure apart from
 * creating the empty hooks directory when `options.disableHooks` is true.
 */
export function gitRunner(dir: string, options?: GitRunnerOptions): GitRunner {
  const env = sanitisedEnv(options?.env ?? process.env);
  const prefix = [
    '-c',
    `user.name=${GIT_IDENTITY.name}`,
    '-c',
    `user.email=${GIT_IDENTITY.email}`,
    '-c',
    'commit.gpgsign=false',
  ];
  const runWith = (
    config: readonly string[],
    cwd: string,
    args: readonly string[],
    input?: string,
  ): string =>
    execFileSync('git', [...config, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      input,
      maxBuffer: 256 * 1024 * 1024,
    });
  if (options?.disableHooks === true) {
    const hooks = emptyHooksDir(dir, (args) => runWith(prefix, dir, args));
    prefix.push('-c', `core.hooksPath=${hooks}`);
  }
  const runIn = (cwd: string, ...args: string[]): string => runWith(prefix, cwd, args);
  const attemptIn = (cwd: string, ...args: string[]): string | GitFailure => {
    try {
      return runIn(cwd, ...args);
    } catch (error) {
      return asFailure(error);
    }
  };
  return {
    dir,
    run: (...args) => runIn(dir, ...args),
    runIn,
    runInput: (input, ...args) => runWith(prefix, dir, args, input),
    attempt: (...args) => attemptIn(dir, ...args),
    attemptIn,
  };
}

/**
 * `given` without `GIT_REPOSITORY_VARIABLES` and undefined values, with the
 * terminal prompt off and the fixed identity in the `GIT_AUTHOR_*` and
 * `GIT_COMMITTER_*` variables.
 */
function sanitisedEnv(given: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined && !GIT_REPOSITORY_VARIABLES.includes(key)) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_AUTHOR_NAME = GIT_IDENTITY.name;
  env.GIT_AUTHOR_EMAIL = GIT_IDENTITY.email;
  env.GIT_COMMITTER_NAME = GIT_IDENTITY.name;
  env.GIT_COMMITTER_EMAIL = GIT_IDENTITY.email;
  return env;
}

/**
 * An existing empty directory for `core.hooksPath`: `agentboard-no-hooks`
 * under the git directory of the repository at `dir` (asked of git with
 * `run`), or a fresh temporary directory when git cannot say.
 */
function emptyHooksDir(dir: string, run: (args: readonly string[]) => string): string {
  try {
    const gitDir = resolve(dir, run(['rev-parse', '--absolute-git-dir']).trim());
    const hooks = join(gitDir, NO_HOOKS_DIR);
    mkdirSync(hooks, { recursive: true });
    return hooks;
  } catch {
    return mkdtempSync(join(tmpdir(), `${NO_HOOKS_DIR}-`));
  }
}

/** The failure a thrown child process error describes. */
function asFailure(error: unknown): GitFailure {
  const e = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
  return {
    status: typeof e.status === 'number' ? e.status : null,
    stdout: typeof e.stdout === 'string' ? e.stdout : '',
    stderr: typeof e.stderr === 'string' ? e.stderr : error instanceof Error ? error.message : '',
  };
}
