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

import { Buffer } from 'node:buffer';
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
  return asciiText(rawErrorLine(failure));
}

/**
 * `firstErrorLine` before `asciiText`: the line as git wrote it, for a
 * caller that sanitises it against URLs first (a URL holding a non-ASCII
 * character or a backslash is only found in the raw line) and escapes it
 * afterwards. Pure.
 */
export function rawErrorLine(failure: GitFailure): string {
  const all = `${failure.stderr}\n${failure.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return all.find((l) => /^(fatal|error):/.test(l)) ?? all[0] ?? 'git failed';
}

/** The environment variables curl reads a proxy from (lower case, and the upper-case forms git documents). */
const PROXY_VARIABLES: readonly string[] = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
];

/**
 * Every URL configured for the remotes of the git repository at `dir`
 * (no-echo-refusals: "Git lines quoted from remote commands"): for each
 * remote `git remote` lists, every raw `remote.<name>.url` and
 * `remote.<name>.pushurl` value (`git config --get-all`), and every URL
 * git resolves for it after `url.<base>.insteadOf` and `pushInsteadOf`
 * rewrites (`git remote get-url --all <name>` and `git remote get-url
 * --push --all <name>`); every `branch.<b>.remote` and `agentboard.remote`
 * value that names no remote `git remote` lists and contains `:` or `/`
 * (a remote named by URL); and every proxy git may use: the values of
 * `http.proxy`, every `http.<url>.proxy`, `https.proxy` and every
 * `remote.<name>.proxy`, and of the `http_proxy`, `https_proxy`,
 * `all_proxy`, `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` variables of
 * `env`, a value without `://` also as `http://<value>` (review round 1,
 * design.md "Review round 1"). Deduplicated, longest first, empty values
 * dropped. A repository with no remotes, or one git cannot read, gives
 * `[]` apart from the proxies of `env` (which git would still use from
 * that directory); never throws. Runs git with the sanitised environment
 * of `GitRunnerOptions.env` (`env` defaults to `process.env`); contacts no
 * remote.
 */
export function configuredRemoteUrls(dir: string, env?: Env): string[] {
  const urls = new Set<string>();
  const add = (value: string): void => {
    const url = value.trim();
    if (url !== '') {
      urls.add(url);
    }
  };
  // A proxy without a scheme is read by curl as `http://<value>`, which is
  // how git prints it; both forms are listed so its user information is
  // known.
  const addProxy = (value: string): void => {
    const proxy = value.trim();
    add(proxy);
    if (proxy !== '' && !proxy.includes('://')) {
      add(`http://${proxy}`);
    }
  };
  try {
    const git = gitRunner(dir, { env });
    const lines = (out: string | GitFailure): string[] =>
      isGitFailure(out)
        ? []
        : out
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
    // `config -z --get-regexp`: `<key>\n<value>` entries, NUL-terminated.
    const values = (out: string | GitFailure): string[] =>
      isGitFailure(out)
        ? []
        : out
            .split('\0')
            .filter((entry) => entry !== '')
            .map((entry) => entry.slice(entry.indexOf('\n') + 1));
    const names = lines(git.attempt('remote'));
    for (const name of names) {
      for (const out of [
        git.attempt('config', '--get-all', `remote.${name}.url`),
        git.attempt('config', '--get-all', `remote.${name}.pushurl`),
        git.attempt('remote', 'get-url', '--all', name),
        git.attempt('remote', 'get-url', '--push', '--all', name),
      ]) {
        lines(out).forEach(add);
      }
      lines(git.attempt('config', '--get-all', `remote.${name}.proxy`)).forEach(addProxy);
    }
    // A remote named by URL: git accepts a URL where a remote name goes,
    // and `sync` passes it to git as it is.
    const namedByUrl = (value: string): void => {
      const name = value.trim();
      if (!names.includes(name) && /[:/]/.test(name)) {
        add(name);
      }
    };
    values(git.attempt('config', '-z', '--get-regexp', '^branch\\..*\\.remote$')).forEach(namedByUrl);
    lines(git.attempt('config', '--get-all', 'agentboard.remote')).forEach(namedByUrl);
    lines(git.attempt('config', '--get-all', 'http.proxy')).forEach(addProxy);
    lines(git.attempt('config', '--get-all', 'https.proxy')).forEach(addProxy);
    values(git.attempt('config', '-z', '--get-regexp', '^http\\..*\\.proxy$')).forEach(addProxy);
  } catch {
    // git could not be run at all: only the environment's proxies are known.
  }
  const given = env ?? process.env;
  for (const name of PROXY_VARIABLES) {
    const value = given[name];
    if (value !== undefined) {
      addProxy(value);
    }
  }
  return longestFirst(urls);
}

/** `values` as an array, longest first, equal lengths in insertion order. */
function longestFirst(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * The scheme and user information of a URL that has both:
 * `<scheme>://<userinfo>@`, where `<scheme>` is a letter followed by
 * letters, digits, `+`, `-` or `.` in any case, and `<userinfo>` runs to
 * the last `@` before a `/`, `?`, `#`, white space or quote (a password may
 * hold an unencoded `@`). Group 1 is `<scheme>://`, group 2 the user
 * information.
 */
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s'"/?#]*)@/g;

/** The parts of a URL with a scheme and user information, or null when it has no user information. */
function splitUserinfo(url: string): { scheme: string; userinfo: string; rest: string } | null {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(url);
  if (scheme === null) {
    return null;
  }
  const after = url.slice(scheme[0].length);
  const end = after.search(/[/?#]/);
  const authority = end === -1 ? after : after.slice(0, end);
  const at = authority.lastIndexOf('@');
  if (at === -1) {
    return null;
  }
  return { scheme: scheme[0], userinfo: authority.slice(0, at), rest: after.slice(at + 1) };
}

/**
 * The pieces of the user information of `url` that a client may print on
 * their own, which `splitUserinfo` does not give: with more than one raw
 * `@` before the first `/`, the text between the first and the last `@`
 * (as given and as git encodes a host: every byte other than an ASCII
 * letter, digit, `-` or `.` as upper-case `%XX`); with a raw `#` or `?`
 * before the last `@`, the text before it. Empty for any other URL.
 */
function splitPieces(url: string): string[] {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(url);
  if (scheme === null) {
    return [];
  }
  const after = url.slice(scheme[0].length);
  const slash = after.indexOf('/');
  const authority = slash === -1 ? after : after.slice(0, slash);
  const last = authority.lastIndexOf('@');
  if (last === -1) {
    return [];
  }
  const userinfo = authority.slice(0, last);
  const pieces: string[] = [];
  const first = userinfo.indexOf('@');
  if (first !== -1) {
    const between = userinfo.slice(first + 1);
    pieces.push(between, hostEncoded(between));
  }
  const mark = userinfo.search(/[#?]/);
  if (mark !== -1) {
    pieces.push(userinfo.slice(0, mark));
  }
  return pieces;
}

/** `text` as git writes a host it re-encodes: every UTF-8 byte other than an ASCII letter, digit, `-` or `.` as upper-case `%XX`. */
function hostEncoded(text: string): string {
  return [...Buffer.from(text, 'utf8')]
    .map((byte) =>
      /[A-Za-z0-9.-]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
}

/** `text` percent-decoded when that succeeds and gives another text, else null. */
function percentDecoded(text: string): string | null {
  try {
    const decoded = decodeURIComponent(text);
    return decoded === text ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * `line`, a git line quoted from a failing git command that talks to a
 * remote (`ls-remote`, `fetch`, `pull`, `push`, and the `remote:` lines a
 * refusing remote prints), with every URL in `urls` treated as
 * `sanitizeGitLine` (`src/board/init-remote.ts`) treats the value given:
 * each URL, and each URL without its user information, replaced by
 * `<url>` (longest first over all of them); then the user information of
 * every other `<scheme>://<userinfo>@` in the line replaced by
 * `<scheme>://<redacted>@`; then the user information of each URL, as
 * configured and percent-decoded, and the pieces of it git and curl print
 * on their own (`splitPieces`, those `usablePiece` accepts), replaced by
 * `<redacted>` wherever they appear. With `urls` empty only the generic
 * step applies. Pure; never throws.
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
  // Step 1: every form of every URL becomes `<url>`, longest first, so a
  // form that contains another is replaced whole.
  const forms = new Set<string>();
  const userinfos = new Set<string>();
  for (const url of urls) {
    if (url === '') {
      continue;
    }
    forms.add(url);
    const redact = (text: string): void => {
      if (text !== '') {
        userinfos.add(text);
        const decoded = percentDecoded(text);
        if (decoded !== null && decoded !== '') {
          userinfos.add(decoded);
        }
      }
    };
    const split = splitUserinfo(url);
    if (split !== null) {
      forms.add(`${split.scheme}${split.rest}`);
      redact(split.userinfo);
    }
    // The user information as git and curl split a proxy URL (design.md
    // "Review round 2" and "Review round 3"): git splits at the first `@`
    // and prints what follows, up to the last `@`, encoded as a host; curl
    // on git 2.32 ends the authority at a raw `#` or `?` and prints the
    // text before it as the proxy host. A piece too short, without a
    // letter or digit, or a scheme name is not used: it is redacted
    // wherever it appears and would mangle ordinary words.
    for (const piece of splitPieces(url)) {
      if (usablePiece(piece)) {
        redact(piece);
      }
    }
  }
  let out = line;
  for (const form of longestFirst(forms)) {
    out = out.replaceAll(form, '<url>');
  }
  // Step 2: the user information of every other URL in the line, before
  // any piece redaction can touch a `<scheme>://` marker it relies on.
  out = out.replace(USERINFO, '$1<redacted>@');
  // Step 3: the user information of the listed URLs and its pieces,
  // wherever git prints them (with a scheme or without one).
  for (const userinfo of longestFirst(userinfos)) {
    out = out.replaceAll(userinfo, '<redacted>');
  }
  return out;
}

/** The shortest split piece that is redacted on its own (design.md "Review round 3"). */
const MIN_PIECE_LENGTH = 6;

/** URL scheme names a split piece is never taken for (any case). */
const SCHEME_NAMES: readonly string[] = [
  'http',
  'https',
  'ftp',
  'ftps',
  'git',
  'ssh',
  'file',
  'git+ssh',
  'ssh+git',
  'socks4',
  'socks4a',
  'socks5',
  'socks5h',
];

/** Whether a split piece is long enough, holds a letter or digit, and is no scheme name. */
function usablePiece(piece: string): boolean {
  return (
    piece.length >= MIN_PIECE_LENGTH &&
    /[A-Za-z0-9]/.test(piece) &&
    !SCHEME_NAMES.includes(piece.toLowerCase())
  );
}

/**
 * `url` as agentboard shows a configured or given remote URL anywhere it
 * names one (no-echo-refusals review round 1 addendum; board-cli "Remote
 * URLs are shown without credentials"): with its user information
 * removed, `<scheme>://<userinfo>@<rest>` becoming `<scheme>://<rest>`,
 * where the user information is what `sanitizeRemoteLine` takes it to be
 * (up to the last `@` before the first `/`, `?` or `#` after the scheme).
 * A URL without user information, a path and the scp-like
 * `user@host:path` are returned unchanged. Pure; never throws.
 */
export function withoutUserinfo(url: string): string {
  const split = splitUserinfo(url);
  return split === null ? url : `${split.scheme}${split.rest}`;
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
  /**
   * `configuredRemoteUrls(dir)` with the runner's environment: the URLs a
   * git line quoted from a remote command run in `dir` is sanitised against
   * (`sanitizeRemoteLine`). Read when a command has failed, never before.
   */
  remoteUrls(): string[];
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
    remoteUrls: () => configuredRemoteUrls(dir, env),
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
