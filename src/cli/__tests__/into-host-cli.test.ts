/**
 * `agentboard init --into-host` through the built CLI (`dist/cli.js`;
 * add-board-sharing task 5.1; board-cli "Moving a standalone board into
 * the host repository" and "Init has help for sharing"; board-concurrency
 * "Moving a board into the host repository loses no event"): the `--json`
 * document and its fields, the text output naming the kept repository and
 * the old remote, no actor needed, the flag exclusivity with `--remote`,
 * the refusals with their hints on stderr and in the `--json` error
 * document, `help init`, the move with `rebuild --check` afterwards, the
 * re-run, the move killed after each step of design.md decision 9 (a `git`
 * shim on the PATH kills the CLI process at the matching command) each
 * finished by running the command again, and the rollback steps of
 * design.md "Migration Plan" ending with a working standalone board.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { COMMANDS, expectCheckClean, expectKilled, canonicalDump } from '../../__tests__/harness/host-sync.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import {
  agentboardDir,
  bareHost,
  cloneProject,
  cloneWithStandalone,
  conflictingClones,
  eventFiles,
  expectKept,
  expectMoved,
  expectUntouched,
  keptRepositories,
  lateEventFile,
  lockFile,
  migratingEntries,
  project,
  refEvents,
  registeredMigrating,
  resolveIgnoreConflicts,
  standaloneProject,
  syncStandalone,
  syncedStandalone,
  untouched,
  withShellGitShim,
  writeEvents,
} from '../../board/__tests__/into-host-helpers.js';
import {
  BOARD_REF,
  commitHostEvent,
  hostBoard,
  refCommit,
  withGitShim,
  withGitShimBefore,
  withKillingGitShim,
  withRecordingGitShim,
  worktreeEntry,
  type KillWhen,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, rebaseInProgress, revParse, syncEnv, type Env } from '../../board/__tests__/sync-helpers.js';
import {
  MIGRATING_DIR,
  MIGRATING_FETCH_REF,
  MIGRATING_REF,
  STANDALONE_KEPT_PREFIX,
} from '../../board/into-host.js';
import { detectBoardModel } from '../../board/model.js';
import { P, T1, T2, ev } from '../../store/__tests__/helpers.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { renderHint } from '../../guidance/hints.js';
import { INIT_SUGGESTION } from '../../guidance/install.js';
import { parseArgs } from '../parse.js';
import { findCommand } from '../registry.js';
import { BUILT_CLI, oneJson, spawnCli, written, type Run } from './cli-helpers.js';

// Every test spawns the CLI and git many times; keep well clear of the 5 s default.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The keys of the `init --into-host --json` document, sorted. */
const RESULT_KEYS = [
  'action',
  'created',
  'dir',
  'events',
  'hostGitignore',
  'joined',
  'keptAt',
  'message',
  'model',
  'oldRemoteUrl',
  'remote',
  'repair',
  'sync',
  'warnings',
];

/** `init --into-host` in `cwd` through the built CLI, no actor given. */
function intoHost(cwd: string, env: Env, json = true): Run {
  return spawnCli(['init', '--into-host', ...(json ? ['--json'] : [])], cwd, env);
}

/** `init --into-host --json` in `cwd`, which must exit 0; returns its document. */
function intoHostOk(cwd: string, env: Env, label = ''): Record<string, unknown> {
  const out = intoHost(cwd, env);
  expect(out.code, `${label}: ${out.stderr}`).toBe(0);
  return oneJson(out) as Record<string, unknown>;
}

/** `sync --json` in `cwd`, which must exit 0; returns its document. */
function syncOk(cwd: string, env: Env, label = ''): Record<string, unknown> {
  const out = spawnCli(['sync', '--json'], cwd, env);
  expect(out.code, `${label}: ${out.stderr}`).toBe(0);
  return oneJson(out) as Record<string, unknown>;
}

/** The hint line of a failed run's stderr (`hint: <hint>`, the last line). */
function hintOf(out: Run): string {
  expect(out.code).not.toBe(0);
  expect(out.stderr).toMatch(/^agentboard: \S/);
  const last = out.stderr.trimEnd().split('\n').at(-1) ?? '';
  expect(last).toMatch(/^hint: \S/);
  return last.slice('hint: '.length);
}

/** The `--json` error document of a failed run. */
function errorOf(out: Run): {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
} {
  return (
    oneJson(out) as {
      error: { exitCode: number; reason: string | null; message: string; hint: string | null };
    }
  ).error;
}

/** The titles `list --json` prints in `cwd`. */
function titles(cwd: string, env: Env): string[] {
  const out = spawnCli(['list', '--json'], cwd, env);
  expect(out.code, out.stderr).toBe(0);
  return (oneJson(out) as { title: string }[]).map((t) => t.title);
}

describe('agentboard init --into-host (built CLI)', () => {
  it('prints one JSON document with the init keys plus action, keptAt, oldRemoteUrl and sync, and needs no actor', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote } = standaloneProject(env, 3);

    const out = intoHost(root, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(RESULT_KEYS);
    expect(doc).toMatchObject({
      dir,
      action: 'moved',
      created: false,
      model: 'host',
      joined: false,
      remote: 'origin',
      events: 3,
      hostGitignore: null,
      warnings: [],
      repair: null,
      oldRemoteUrl: boardRemote,
    });
    expect(String(doc.keptAt)).toContain(join(agentboardDir(root), 'standalone-'));
    expect(doc.sync).toMatchObject({ model: 'host', remote: 'origin', pushed: true, ref: BOARD_REF });
    expect(typeof doc.message).toBe('string');
    expectMoved(root, env);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(root));
  });

  it('scenario: Move reports what it kept: the text names the kept path, the old remote URL as written, and the command for other clones', () => {
    const env = syncEnv();
    const { root, dir, boardRemote } = standaloneProject(env, 2);
    // The remote is written as an SSH URL that insteadOf rewrites to the local bare repository.
    const url = 'git@example.com:me/board.git';
    git(dir, 'config', `url.${boardRemote}.insteadOf`, url);
    git(dir, 'remote', 'set-url', 'origin', url);

    const out = intoHost(root, env, false);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const [kept] = keptRepositories(root);
    expect(out.stdout).toContain(String(kept));
    expect(out.stdout).toContain(url);
    expect(out.stdout).toContain('agentboard init --into-host');
    expect(out.stdout).toMatch(/retire/);
    expect(out.stdout).toContain(BOARD_REF);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`)).toBe(true);
    const json = spawnCli(['remote', '--json'], root, env);
    expect(json.code, json.stderr).toBe(0);
    expect(oneJson(json)).toMatchObject({ model: 'host', ref: BOARD_REF, refCommit: refCommit(root) });
  });

  it('prints the warnings of the final sync on stderr as agentboard: <line>, also with --json', () => {
    const env = syncEnv();
    const { root } = project();
    // The host tracks a path under .board (committed before the board
    // existed, then removed from the working tree), so the sync warns.
    mkdirSync(join(root, '.board'));
    writeFileSync(join(root, '.board', 'tracked.txt'), 'tracked\n');
    git(root, 'add', '-f', '.board/tracked.txt');
    git(root, 'commit', '-q', '-m', 'track a board path');
    rmSync(join(root, '.board'), { recursive: true });
    const { dir } = syncedStandalone(root, env, 1, bareRemote());
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');

    const out = intoHost(root, env);

    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { warnings: string[] };
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/warning/);
    expect(out.stderr).toBe(`agentboard: ${doc.warnings[0] ?? ''}\n`);
  });
});

describe('scenario: Remote flags are exclusive', () => {
  it('--into-host with --remote, in either order, exits 1 usage naming --into-host and moves nothing', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 1);
    const url = join(tempDir(), 'other.git');
    const before = untouched(root, dir);

    for (const argv of [
      ['init', '--into-host', '--remote', url],
      ['init', '--remote', url, '--into-host'],
    ]) {
      const out = spawnCli(argv, root, env);
      expect(out.code, argv.join(' ')).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('--into-host');
      expect(out.stderr).toContain('--remote');
      const json = spawnCli([...argv, '--json'], root, env);
      expect(json.code).toBe(1);
      expect(errorOf(json)).toMatchObject({ exitCode: 1, reason: 'usage' });
    }
    expectUntouched(root, dir, before);
    expect(existsSync(url)).toBe(false);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
  });

  it('--into-host takes no value: a following word is an unexpected positional', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 1);
    const before = untouched(root, dir);

    const out = spawnCli(['init', '--into-host', 'extra'], root, env);

    expect(out.code).toBe(1);
    expect(errorOf(spawnCli(['init', '--into-host', 'extra', '--json'], root, env))).toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
    expectUntouched(root, dir, before);
  });
});

describe('refusals through the CLI carry a hint', () => {
  it('unsynced: exit 4, the message naming agentboard sync, the hint, and the --json error document', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 2);
    writeEvents(dir, 1, 'late', 100);
    const before = untouched(root, dir);

    const out = intoHost(root, env, false);

    expect(out.code).toBe(4);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('agentboard sync');
    const hint = hintOf(out);
    expect(hint).toBe(renderHint('unsynced', { surface: 'cli', command: 'init' }));
    const json = intoHost(root, env);
    expect(json.code).toBe(4);
    expect(errorOf(json)).toMatchObject({ exitCode: 4, reason: 'unsynced', hint });
    expectUntouched(root, dir, before);
  });

  it('no-host-repository: exit 1 with a hint, outside a git repository and with AGENTBOARD_DIR', () => {
    const env = syncEnv();
    const outside = tempDir();
    const { dir } = standaloneProject(env, 1);
    cpSync(dir, join(outside, '.board'), { recursive: true });

    const out = intoHost(outside, env, false);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    const hint = hintOf(out);
    expect(hint).toBe(renderHint('no-host-repository', { surface: 'cli', command: 'init' }));
    expect(errorOf(intoHost(outside, env))).toMatchObject({
      exitCode: 1,
      reason: 'no-host-repository',
      hint,
    });
    expect(detectBoardModel(join(outside, '.board'), { env }).model).toBe('standalone');

    const { root: host } = standaloneProject(env, 1, 'host');
    const viaEnv = intoHost(host, { ...env, AGENTBOARD_DIR: join(host, '.board') });
    expect(viaEnv.code).toBe(1);
    expect(errorOf(viaEnv)).toMatchObject({ exitCode: 1, reason: 'no-host-repository' });
    expect(errorOf(viaEnv).message).toContain('AGENTBOARD_DIR');
  });

  it('git-too-old: exit 1 with the hint naming agentboard init --into-host, nothing changed', () => {
    const env = syncEnv();
    const { root, dir } = standaloneProject(env, 1);
    const before = untouched(root, dir);
    const old = withGitShim(env, '2.31.8');

    const out = intoHost(root, old, false);

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('2.32');
    expect(hintOf(out)).toContain("'agentboard init --into-host'");
    expect(errorOf(intoHost(root, old))).toMatchObject({ exitCode: 1, reason: 'git-too-old' });
    expectUntouched(root, dir, before);
  });

  it('no board: exit 2 board-not-found', () => {
    const env = syncEnv();
    const root = join(tempDir(), 'proj');
    git(tempDir(), 'init', '-q', root);
    const out = intoHost(root, env);
    expect(out.code).toBe(2);
    expect(errorOf(out)).toMatchObject({ exitCode: 2, reason: 'board-not-found' });
    expect(existsSync(join(root, '.board'))).toBe(false);
  });
});

describe('scenario: Init has help for sharing', () => {
  it('help init prints --remote and --into-host, says they are mutually exclusive, lists the exit codes, and has an example for each flag that parses', () => {
    const out = spawnCli(['help', 'init'], tempDir(), syncEnv());

    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain('--remote');
    expect(out.stdout).toContain('--into-host');
    expect(out.stdout).toMatch(/^Usage: agentboard init .*--into-host/m);
    expect(out.stdout).toMatch(/At most one of: --remote \| --into-host/);
    for (const [code, reason] of [
      [1, 'ambiguous-remote'],
      [1, 'git-too-old'],
      [1, 'no-host-repository'],
      [3, 'remote-unreachable'],
      [3, 'sync-failed'],
      [4, 'unsynced'],
    ] as const) {
      expect(out.stdout, reason).toMatch(new RegExp(`^\\s+${String(code)} ${reason}\\s`, 'm'));
    }
    expect(out.stdout).toMatch(/^\s+5\s+\S/m);
    const spec = findCommand('init');
    const withRemote = spec?.examples.filter((e) => e.command.includes('--remote')) ?? [];
    const withIntoHost = spec?.examples.filter((e) => e.command.includes('--into-host')) ?? [];
    expect(withRemote.length).toBeGreaterThan(0);
    expect(withIntoHost.length).toBeGreaterThan(0);
    for (const example of [...withRemote, ...withIntoHost]) {
      expect(out.stdout).toContain(example.command);
      const parsed = parseArgs(splitCommandLine(example.command).slice(1));
      expect(parsed.command.name).toBe('init');
      if (example.command.includes('--into-host')) {
        expect(parsed.values['into-host']).toBe(true);
        expect(parsed.values.remote).toBeUndefined();
      } else {
        expect(typeof parsed.values.remote).toBe('string');
      }
    }
  });

  it('help init --json carries unsynced, no-host-repository and git-too-old in its exit codes', () => {
    const out = spawnCli(['help', 'init', '--json'], tempDir(), syncEnv());
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { exitCodes: { code: number; reason?: string }[] };
    for (const [code, reason] of [
      [4, 'unsynced'],
      [1, 'no-host-repository'],
      [1, 'git-too-old'],
      [1, 'ambiguous-remote'],
      [3, 'remote-unreachable'],
    ] as const) {
      expect(doc.exitCodes).toContainEqual(expect.objectContaining({ code, reason }));
    }
  });
});

describe('scenario: Migration success and Migration re-run, through the CLI', () => {
  it('moves the board, list shows its tickets, rebuild --check is clean, remote reports the host model, and a re-run changes nothing', () => {
    const env = syncEnv();
    const { root, remote, dir, tip } = standaloneProject(env, 5);
    const files = eventFiles(dir);
    const dumpBefore = canonicalDump(dir);
    const shown = titles(root, env);

    const doc = intoHostOk(root, env);

    expect(doc).toMatchObject({ action: 'moved', model: 'host', events: 5 });
    expectMoved(root, env);
    expect(eventFiles(dir)).toEqual(files);
    expect(canonicalDump(dir)).toBe(dumpBefore);
    expect(titles(root, env)).toEqual(shown);
    expectCheckClean(root, env);
    expect(refEvents(remote)).toEqual(files);
    expectKept(String(doc.keptAt), tip, files);
    const report = spawnCli(['remote', '--json'], root, env);
    expect(oneJson(report)).toMatchObject({ model: 'host', remote: { name: 'origin', url: remote } });

    const again = intoHostOk(root, env);
    expect(again).toMatchObject({ action: 'unchanged', keptAt: null, sync: null, oldRemoteUrl: null });
    expect(String(again.message)).toMatch(/already/);
    expectMoved(root, env);
    expect(keptRepositories(root)).toEqual([String(doc.keptAt)]);
    expectCheckClean(root, env);
  });
});

describe('an interrupted move is finished by running init --into-host again', () => {
  /** The common fixture: a synced standalone board with 3 events in a project with a bare origin. */
  function fixture(env: Env): ReturnType<typeof standaloneProject> & { files: string[] } {
    const fx = standaloneProject(env, 3);
    return { ...fx, files: eventFiles(fx.dir) };
  }

  /** Runs the move with a shim that kills it at `trigger` (`when`), asserting it was killed. */
  function killedAt(root: string, env: Env, trigger: readonly string[], when: KillWhen): void {
    expectKilled(intoHost(root, withKillingGitShim(env, trigger, when)));
  }

  /**
   * The end state every kill point must reach after the re-run (and a
   * `sync`): a complete host-model board with every event, one kept
   * repository holding the old branch, origin listing the ref with every
   * event, and `rebuild --check` clean.
   */
  function expectFinished(
    fx: ReturnType<typeof fixture>,
    env: Env,
    extraFiles: readonly string[] = [],
  ): void {
    syncOk(fx.root, env, 'final sync');
    const files = [...fx.files, ...extraFiles].sort();
    expectMoved(fx.root, env);
    expect(eventFiles(fx.dir)).toEqual(files);
    expect(refEvents(fx.root)).toEqual(files);
    expect(refEvents(fx.remote)).toEqual(files);
    expect(git(fx.remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(fx.root));
    const [kept] = keptRepositories(fx.root);
    expectKept(String(kept), fx.tip, fx.files);
    expect(refCommit(fx.root, MIGRATING_REF)).toBeNull();
    expect(migratingEntries(fx.root)).toEqual([]);
    expectCheckClean(fx.root, env);
  }

  it('killed after the fetch into refs/agentboard/migrating-fetch (step 2): only the scratch ref is written, the board is still standalone; the re-run moves it', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, [`:${MIGRATING_FETCH_REF}`], 'after');

    expect(refCommit(fx.root, MIGRATING_FETCH_REF)).toBe(fx.tip);
    expect(refCommit(fx.root, MIGRATING_REF)).toBeNull();
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(refCommit(fx.root)).toBeNull();
    expect(keptRepositories(fx.root)).toEqual([]);

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'moved' });
    expectFinished(fx, env);
  });

  it('a re-run adopting a temporary, killed after its step 2 fetch and before the replay, a third clone having pushed meanwhile: the next run still replays and ends with that event (round 4 ruling 1)', () => {
    const env = syncEnv();
    const fx = fixture(env);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(fx.root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    // Run 1 integrates the local ref and dies: an adoptable temporary whose
    // integrated tip is the board's tip.
    killedAt(fx.root, env, [...COMMANDS.rebaseLocal], 'after');
    expect(migratingEntries(fx.root)).toHaveLength(1);
    expect(refCommit(fx.root, MIGRATING_REF)).toBe(fx.tip);
    // A third clone syncs an event to the old remote; this clone never pulls it.
    const d = cloneWithStandalone(fx.remote, fx.boardRemote, 'd');
    const [fromD] = writeEvents(d.dir, 1, 'd', 600);
    syncStandalone(d.dir, env);
    const fresh = revParse(d.dir);

    // Run 2 fetches the fresh tip and dies before replaying it.
    killedAt(fx.root, env, [`:${MIGRATING_FETCH_REF}`], 'after');

    expect(refCommit(fx.root, MIGRATING_FETCH_REF)).toBe(fresh);
    expect(refCommit(fx.root, MIGRATING_REF)).toBe(fx.tip);
    expect(migratingEntries(fx.root)).toHaveLength(1);
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'moved', events: 5 });
    expectFinished(fx, env, [`${fromOther}.json`, `${String(fromD)}.json`]);
  });

  /**
   * An adoptable temporary (run 1 killed after the rebase onto a local
   * ref) and two commits synced to the old remote by a third clone since,
   * so the re-run's replay is a two-commit cherry-pick.
   */
  function adoptableWithTwoFreshCommits(env: Env): {
    fx: ReturnType<typeof fixture>;
    extra: string[];
  } {
    const fx = fixture(env);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(fx.root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    killedAt(fx.root, env, [...COMMANDS.rebaseLocal], 'after');
    expect(migratingEntries(fx.root)).toHaveLength(1);
    const d = cloneWithStandalone(fx.remote, fx.boardRemote, 'd');
    const [e0] = writeEvents(d.dir, 1, 'd', 600);
    syncStandalone(d.dir, env);
    const [e1] = writeEvents(d.dir, 1, 'd', 601);
    syncStandalone(d.dir, env);
    return { fx, extra: [`${fromOther}.json`, `${String(e0)}.json`, `${String(e1)}.json`] };
  }

  /**
   * `env` with a `git` shim that, on the cherry-pick of the replay, points
   * `core.hooksPath` at a hooks directory whose `post-commit` hook kills
   * the CLI process and git itself right after the first pick's commit, so
   * a multi-commit replay is interrupted in the middle, exactly as a kill
   * there leaves it (git's sequencer directory, and the marker of the pick
   * being committed).
   */
  function killingAfterFirstPick(env: Env): Env {
    const hooks = join(tempDir(), 'kill-hooks');
    mkdirSync(hooks);
    const flag = join(hooks, 'fired');
    const nodePid = join(hooks, 'nodepid');
    writeFileSync(
      join(hooks, 'post-commit'),
      [
        '#!/bin/sh',
        `if [ ! -e '${flag}' ]; then : > '${flag}'; kill -KILL "$(cat '${nodePid}')"; kill -KILL "$PPID"; fi`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(hooks, 'post-commit'), 0o755);
    return withShellGitShim(
      env,
      [
        'case " $* " in',
        `  *" cherry-pick "*) echo "$PPID" > '${nodePid}'; n=$#; for a in "$@"; do case "$a" in core.hooksPath=*) a="core.hooksPath=${hooks}";; esac; set -- "$@" "$a"; done; shift "$n"; exec "$GIT" "$@" ;;`,
        'esac',
      ].join('\n'),
    );
  }

  /** The git directory of the one registered temporary worktree of `root`. */
  function temporaryGitDir(root: string): { temporary: string; gitDir: string } {
    const [temporary] = registeredMigrating(root);
    expect(registeredMigrating(root)).toHaveLength(1);
    return { temporary: String(temporary), gitDir: git(String(temporary), 'rev-parse', '--absolute-git-dir').trim() };
  }

  it('a two-commit replay killed while its first pick is committed (sequencer and CHERRY_PICK_HEAD left, nothing unmerged): the re-run quits it, replays again and completes with every event once (round 5 rulings 1 and 2)', () => {
    const env = syncEnv();
    const { fx, extra } = adoptableWithTwoFreshCommits(env);

    expectKilled(intoHost(fx.root, killingAfterFirstPick(env)));

    const { temporary, gitDir } = temporaryGitDir(fx.root);
    expect(existsSync(join(gitDir, 'sequencer'))).toBe(true);
    expect(git(temporary, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(eventFiles(temporary)).toContain(extra[1]);
    expect(eventFiles(temporary)).not.toContain(extra[2]);
    expect(refCommit(fx.root, MIGRATING_REF)).toBe(fx.tip);
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');

    const doc = intoHostOk(fx.root, env);

    expect(doc).toMatchObject({ action: 'moved', events: 6 });
    expectFinished(fx, env, extra);
    const subjects = git(fx.root, 'log', '--format=%s', BOARD_REF).split('\n');
    expect(subjects.filter((s) => s.includes('1 event file')).length).toBeGreaterThanOrEqual(2);
    expect(git(fx.root, 'log', '--format=%H', '--diff-filter=A', '--', `events/${extra[1]}`).trim().split('\n')).toHaveLength(1);
  });

  it('a two-commit replay killed between its two picks (only the sequencer left): the re-run recognises the cherry-pick in progress, quits it and completes with every event once (round 5 rulings 1 and 2)', () => {
    const env = syncEnv();
    const { fx, extra } = adoptableWithTwoFreshCommits(env);

    expectKilled(intoHost(fx.root, killingAfterFirstPick(env)));

    const { temporary, gitDir } = temporaryGitDir(fx.root);
    // The state a kill between two picks leaves: git's sequencer with the
    // second pick still to do, no CHERRY_PICK_HEAD, nothing unmerged.
    rmSync(join(gitDir, 'CHERRY_PICK_HEAD'), { force: true });
    expect(existsSync(join(gitDir, 'sequencer'))).toBe(true);
    expect(existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))).toBe(false);
    expect(git(temporary, 'status', '--porcelain')).toBe('');
    expect(eventFiles(temporary)).toContain(extra[1]);

    const doc = intoHostOk(fx.root, env);

    expect(doc).toMatchObject({ action: 'moved', events: 6 });
    expectFinished(fx, env, extra);
    expect(git(fx.root, 'log', '--format=%H', '--diff-filter=A', '--', `events/${extra[1]}`).trim().split('\n')).toHaveLength(1);
    expect(git(fx.root, 'log', '--format=%H', '--diff-filter=A', '--', `events/${extra[2]}`).trim().split('\n')).toHaveLength(1);
  });

  it('killed between the step 5 carry-over and the rename (an event copied into the temporary untracked), the standalone board then syncing it: the re-run replays over the untracked copy and completes with every event (round 5 ruling 3)', () => {
    const env = syncEnv();
    const fx = fixture(env);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(fx.root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    const late = lateEventFile('before the swap');
    const landed = join(tempDir(), 'landed');
    // A writer lands an event just before the compare-and-swap (step 5 then
    // copies it into the temporary, untracked), and the move is killed at
    // the rename re-check, before anything is kept aside.
    const killing = withShellGitShim(
      env,
      [
        'case " $* " in',
        `  *" update-ref ${BOARD_REF} "*) [ -e '${landed}' ] || { : > '${landed}'; cp '${late.source}' '${join(fx.dir, 'events', late.name)}'; } ;;`,
        `  *" merge-base --is-ancestor ${fx.tip} HEAD "*) kill -KILL "$PPID"; sleep 5; exit 1 ;;`,
        'esac',
      ].join('\n'),
    );

    expectKilled(intoHost(fx.root, killing));

    const { temporary } = temporaryGitDir(fx.root);
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(keptRepositories(fx.root)).toEqual([]);
    expect(eventFiles(fx.dir)).toContain(late.name);
    expect(eventFiles(temporary)).toContain(late.name);
    expect(git(temporary, 'status', '--porcelain', '--', 'events')).toContain(late.name);
    expect(refCommit(fx.root)).toBe(revParse(temporary));
    // The standalone board commits the event (and one more) to the old remote.
    const [x] = writeEvents(fx.dir, 1, 'late', 950);
    syncStandalone(fx.dir, env);
    const newTip = revParse(fx.dir);

    const doc = intoHostOk(fx.root, env);

    expect(doc).toMatchObject({ action: 'moved', events: 6 });
    syncOk(fx.root, env, 'final sync');
    const files = [...fx.files, `${fromOther}.json`, late.name, `${String(x)}.json`].sort();
    expectMoved(fx.root, env);
    expect(eventFiles(fx.dir)).toEqual(files);
    expect(refEvents(fx.root)).toEqual(files);
    expect(refEvents(fx.remote)).toEqual(files);
    expect(git(fx.root, 'log', '--format=%H', '--diff-filter=A', '--', `events/${late.name}`).trim().split('\n')).toHaveLength(1);
    const [kept] = keptRepositories(fx.root);
    expectKept(String(kept), newTip, [...fx.files, late.name, `${String(x)}.json`]);
    expect(refCommit(fx.root, MIGRATING_REF)).toBeNull();
    expectCheckClean(fx.root, env);
  });

  it('a re-run adopting a temporary, killed after its step 2 fetch and before the replay, a third clone having pushed meanwhile: the next run still replays and ends with that event (round 4 ruling 1, repeated as the two-commit fixture)', () => {
    const env = syncEnv();
    const { fx, extra } = adoptableWithTwoFreshCommits(env);

    killedAt(fx.root, env, [`:${MIGRATING_FETCH_REF}`], 'after');

    expect(refCommit(fx.root, MIGRATING_REF)).toBe(fx.tip);
    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'moved', events: 6 });
    expectFinished(fx, env, extra);
  });

  it('killed after the temporary worktree is added (step 3): the re-run removes the dead leftover, names it, and moves', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['worktree', 'add', '--detach'], 'after');

    expect(migratingEntries(fx.root)).toHaveLength(1);
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(refCommit(fx.root)).toBeNull();

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'moved' });
    expect(String(doc.message)).toContain(MIGRATING_DIR);
    expectFinished(fx, env);
  });

  it('killed after the rebase onto the host remote ref (step 3, another clone moved first): the re-run moves and joins', () => {
    const env = syncEnv();
    const a = standaloneProject(env, 2, 'a');
    expect(intoHostOk(a.root, env)).toMatchObject({ action: 'moved' });
    const fromA = commitHostEvent(a.dir, ev(P.comment(T1, 'a after'), 'a', 20_001), env);
    syncOk(a.root, env);
    const b = cloneWithStandalone(a.remote, a.boardRemote, 'b');
    const fromB = writeEvents(b.dir, 1, 'b', 200);
    syncStandalone(b.dir, env);
    const fx = { root: b.root, remote: a.remote, dir: b.dir, boardRemote: a.boardRemote, tip: revParse(b.dir), files: eventFiles(b.dir) };
    expect(fx.files).toContain(`${String(fromB[0])}.json`);

    killedAt(b.root, env, [...COMMANDS.rebaseFetched], 'after');

    expect(detectBoardModel(b.dir, { env }).model).toBe('standalone');
    expect(refCommit(b.root)).toBeNull();

    expect(intoHostOk(b.root, env)).toMatchObject({ action: 'moved', joined: true });
    expectFinished(fx, env, [`${fromA}.json`]);
    syncOk(a.root, env);
    expect(eventFiles(a.dir)).toEqual(eventFiles(b.dir));
    expectCheckClean(a.root, env);
  });

  it('killed after the rebase onto a local refs/agentboard/board (step 3): the re-run moves', () => {
    const env = syncEnv();
    const fx = fixture(env);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(fx.root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    const local = String(refCommit(fx.root));

    killedAt(fx.root, env, [...COMMANDS.rebaseLocal], 'after');

    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(refCommit(fx.root)).toBe(local);

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'moved' });
    expectFinished(fx, env, [`${fromOther}.json`]);
    expect(git(fx.root, 'merge-base', '--is-ancestor', local, BOARD_REF)).toBe('');
  });

  it('killed after update-ref refs/agentboard/board (step 4, the temporary ref still there): the re-run moves', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, [...COMMANDS.updateRef], 'after');

    expect(refCommit(fx.root)).toBe(fx.tip);
    expect(refCommit(fx.root, MIGRATING_REF)).toBe(fx.tip);
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(keptRepositories(fx.root)).toEqual([]);

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'moved' });
    expectFinished(fx, env);
  });

  it('killed after the temporary ref is deleted (step 6, the worktree in place and locked, before the carry-over): .board is the host-model board; the re-run is resumed and publishes (round 3 ruling 2)', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['update-ref', '-d', MIGRATING_REF], 'after');

    // The temporary ref outlives the compare-and-swap: it goes only once
    // the worktree is in place, so no re-run adopting a temporary is ever
    // without the source tip it was made from.
    expect(detectBoardModel(fx.dir, { env }).model).toBe('host');
    expect(worktreeEntry(fx.root, fx.dir)?.locked).toBe('agentboard board');
    expect(refCommit(fx.root)).toBe(fx.tip);
    expect(refCommit(fx.root, MIGRATING_REF)).toBeNull();
    expect(keptRepositories(fx.root)).toHaveLength(1);
    expect(migratingEntries(fx.root)).toEqual([]);
    expect(git(fx.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'resumed', oldRemoteUrl: fx.boardRemote });
    expect(doc.sync).toMatchObject({ model: 'host', pushed: true });
    expectFinished(fx, env);
    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
  });

  it('a re-run adopting the human-resolved worktree, killed at the end of step 4 (after the compare-and-swap): the next run completes without replaying anything, no conflict, the resolution kept (round 3 ruling 2)', () => {
    const env = syncEnv();
    const { remote, bRoot, bDir, shared, fromA, fromB } = conflictingClones(env);
    const first = intoHost(bRoot, env);
    expect(first.code).toBe(3);
    expect(errorOf(first).reason).toBe('sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));
    const sourceBefore = refCommit(bRoot, MIGRATING_REF);

    killedAt(bRoot, env, [...COMMANDS.updateRef], 'after');

    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(refCommit(bRoot)).toBe(resolvedHead);
    expect(refCommit(bRoot, MIGRATING_REF)).toBe(sourceBefore);
    expect(keptRepositories(bRoot)).toEqual([]);
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    const { env: recording, calls } = withRecordingGitShim(env);

    const out = intoHost(bRoot, recording);

    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({ action: 'moved', joined: true, events: 3 });
    expect(
      calls().filter((c) => c.includes('cherry-pick') || c.includes('--onto') || c.includes('--root')),
    ).toEqual([]);
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(git(bRoot, 'merge-base', '--is-ancestor', resolvedHead, BOARD_REF)).toBe('');
    expect(git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n').filter((s) => s === 'ignore bar')).toHaveLength(1);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expect(intoHostOk(bRoot, env)).toMatchObject({ action: 'unchanged' });
    expectCheckClean(bRoot, env);
  });

  it('a re-run adopting the human-resolved worktree, killed after the temporary ref is deleted: the next run resumes without a --root replay and without a new conflict, the resolution kept (round 3 ruling 2)', () => {
    const env = syncEnv();
    const { remote, bRoot, bDir, shared, fromA, fromB } = conflictingClones(env);
    const first = intoHost(bRoot, env);
    expect(first.code).toBe(3);
    expect(errorOf(first).reason).toBe('sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    const resolved = resolveIgnoreConflicts(String(temporary));
    const resolvedHead = revParse(String(temporary));

    killedAt(bRoot, env, ['update-ref', '-d', MIGRATING_REF], 'after');

    expect(detectBoardModel(bDir, { env }).model).toBe('host');
    expect(refCommit(bRoot)).toBe(resolvedHead);
    expect(refCommit(bRoot, MIGRATING_REF)).toBeNull();
    expect(keptRepositories(bRoot)).toHaveLength(1);
    const { env: recording, calls } = withRecordingGitShim(env);

    const out = intoHost(bRoot, recording);

    expect(out.code, out.stderr).toBe(0);
    expect(oneJson(out)).toMatchObject({ action: 'resumed', events: 3 });
    expect(
      calls().filter((c) => c.includes('cherry-pick') || c.includes('--onto') || c.includes('--root')),
    ).toEqual([]);
    expectMoved(bRoot, env);
    const all = [...shared, `${fromA}.json`, ...fromB.map((h) => `${h}.json`)].sort();
    expect(eventFiles(bDir)).toEqual(all);
    expect(refEvents(bRoot)).toEqual(all);
    expect(refEvents(remote)).toEqual(all);
    expect(git(bRoot, 'merge-base', '--is-ancestor', resolvedHead, BOARD_REF)).toBe('');
    expect(git(bRoot, 'log', '--format=%s', BOARD_REF).split('\n').filter((s) => s === 'ignore bar')).toHaveLength(1);
    expect(readFileSync(join(bDir, '.gitignore'), 'utf8')).toBe(resolved);
    expect(intoHostOk(bRoot, env)).toMatchObject({ action: 'unchanged' });
    expectCheckClean(bRoot, env);
  });

  it('plain init after a kill past the worktree move leaves the migrating marker and names the pending move; init --into-host then resumes with the rename-window event (round 3 ruling 3)', () => {
    const env = syncEnv();
    const fx = fixture(env);
    const late = lateEventFile('in the rename window');
    const marker = join(agentboardDir(fx.root), MIGRATING_DIR);
    // The old repository is already kept aside when `worktree move` runs:
    // an event dropped into it then is one that landed in the rename
    // window; the move is killed right after the worktree is in place.
    const killing = withShellGitShim(
      env,
      [
        'case " $* " in',
        `  *" worktree move "*) for d in '${agentboardDir(fx.root)}'/${STANDALONE_KEPT_PREFIX}*/events; do cp '${late.source}' "$d/${late.name}"; done; "$GIT" "$@"; kill -KILL "$PPID"; sleep 5; exit 1 ;;`,
        'esac',
      ].join('\n'),
    );

    expectKilled(intoHost(fx.root, killing));

    expect(detectBoardModel(fx.dir, { env }).model).toBe('host');
    const [kept] = keptRepositories(fx.root);
    expect(keptRepositories(fx.root)).toHaveLength(1);
    expect(eventFiles(String(kept))).toContain(late.name);
    expect(eventFiles(fx.dir)).not.toContain(late.name);
    expect(existsSync(marker)).toBe(true);
    expect(migratingEntries(fx.root)).toEqual([]);
    expect(git(fx.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');

    const plain = spawnCli(['init', '--json'], fx.root, env);

    expect(plain.code, plain.stderr).toBe(0);
    const doc = oneJson(plain) as Record<string, unknown>;
    expect(doc).toMatchObject({ created: false, model: 'host', repair: null });
    expect(String(doc.message)).toContain('agentboard init --into-host');
    expect(existsSync(marker)).toBe(true);
    expect(worktreeEntry(fx.root, fx.dir)?.locked).toBe('agentboard board');
    expect(eventFiles(fx.dir)).not.toContain(late.name);
    expect(git(fx.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');

    const resumed = intoHostOk(fx.root, env);

    expect(resumed).toMatchObject({ action: 'resumed', keptAt: kept, oldRemoteUrl: fx.boardRemote, events: 4 });
    expect(resumed.sync).toMatchObject({ model: 'host', pushed: true });
    expect(existsSync(marker)).toBe(false);
    const files = [...fx.files, late.name].sort();
    expectMoved(fx.root, env);
    expect(eventFiles(fx.dir)).toEqual(files);
    expect(refEvents(fx.root)).toEqual(files);
    expect(refEvents(fx.remote)).toEqual(files);
    expect(git(fx.remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(fx.root));
    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
    expectCheckClean(fx.root, env);
  });

  it('the init lock broken while the move stalls before worktree add, another move finishing meanwhile: a typed exit 3 sync-failed naming agentboard init --into-host, the moved board intact, the re-run unchanged (round 3 ruling 5)', () => {
    const env = syncEnv();
    const fx = fixture(env);
    const ran = join(tempDir(), 'second-move');
    // At the first move's `worktree add` (its lock held, the source tip
    // fetched into the temporary ref), the lock is made stale and a second
    // move runs to completion, as one does after a 60 second stall: it
    // breaks the lock, moves the board and deletes the temporary ref.
    const stalled = withShellGitShim(
      env,
      [
        'case " $* " in',
        `  *" worktree add --detach "*) if [ ! -e '${ran}.started' ]; then : > '${ran}.started'; touch -t 202001010000 '${lockFile(fx.root)}'; '${process.execPath}' '${BUILT_CLI}' init --into-host --json > '${ran}.out' 2> '${ran}.err'; echo $? > '${ran}.code'; fi ;;`,
        'esac',
      ].join('\n'),
    );

    const out = intoHost(fx.root, stalled);

    expect(readFileSync(`${ran}.code`, 'utf8').trim(), readFileSync(`${ran}.err`, 'utf8')).toBe('0');
    expect(JSON.parse(readFileSync(`${ran}.out`, 'utf8'))).toMatchObject({ action: 'moved' });
    expect(out.code, out.stderr).toBe(3);
    const error = errorOf(out);
    expect(error.reason).toBe('sync-failed');
    expect(error.message).toContain('agentboard init --into-host');
    expect(error.message).toMatch(/lock/);
    expect(error.hint).not.toBeNull();
    // The other move's board is intact and complete; nothing of this run is left.
    expectMoved(fx.root, env);
    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
    expectFinished(fx, env);
  });

  it('scenario: Interrupted migration resumes: killed between the rename and the worktree move (step 6), the re-run completes it with exactly one kept repository', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['worktree', 'move'], 'before');

    expect(existsSync(fx.dir)).toBe(false);
    const [kept] = keptRepositories(fx.root);
    expect(keptRepositories(fx.root)).toHaveLength(1);
    expect(migratingEntries(fx.root)).toHaveLength(1);
    expect(refCommit(fx.root)).toBe(fx.tip);

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'resumed', keptAt: kept, oldRemoteUrl: fx.boardRemote });
    expect(String(doc.message)).toContain(String(kept));
    expect(doc.sync).toMatchObject({ model: 'host', pushed: true });
    expectFinished(fx, env);
  });

  it('killed after the worktree move, before the lock (step 6): the re-run restores the lock, syncs and reports resumed with the kept repository (ruling E)', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['worktree', 'move'], 'after');

    expect(detectBoardModel(fx.dir, { env }).model).toBe('host');
    expect(worktreeEntry(fx.root, fx.dir)?.locked).toBeNull();
    const [kept] = keptRepositories(fx.root);
    expect(keptRepositories(fx.root)).toHaveLength(1);
    expect(git(fx.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'resumed', model: 'host', keptAt: kept, oldRemoteUrl: fx.boardRemote });
    expect(doc.sync).toMatchObject({ model: 'host', pushed: true });
    expect(String(doc.message)).toContain(String(kept));
    expect(git(fx.remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(fx.root));
    expectFinished(fx, env);
    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
  });

  it('killed after the lock, before the sync (step 7): the re-run is resumed and publishes', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['worktree', 'lock'], 'after');

    expect(worktreeEntry(fx.root, fx.dir)?.locked).toBe('agentboard board');
    expect(git(fx.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'resumed', oldRemoteUrl: fx.boardRemote });
    expect(doc.sync).toMatchObject({ model: 'host', pushed: true });
    expect(git(fx.remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(fx.root));
    expectFinished(fx, env);
    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
  });

  it('killed after the push, before the catch-up (step 7): the board is published; the re-run is resumed (its sync had not completed), then unchanged', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, [...COMMANDS.push], 'after');

    expect(git(fx.remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(fx.root));
    expectMoved(fx.root, env);

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'resumed' });
    expect(doc.sync).toMatchObject({ model: 'host', pushed: true, commit: null });
    expectFinished(fx, env);
    expect(titles(fx.root, env)).toEqual(['Shared ticket']);
    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
  });

  it('killed after the rebase onto a local refs/agentboard/board, then one more standalone event synced: the re-run adopts the temporary and integrates it in one run (ruling A)', () => {
    const env = syncEnv();
    const fx = fixture(env);
    const other = hostBoard(env);
    const fromOther = commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(fx.root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);

    killedAt(fx.root, env, [...COMMANDS.rebaseLocal], 'after');

    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(migratingEntries(fx.root)).toHaveLength(1);
    const [late] = writeEvents(fx.dir, 1, 'late', 900);
    syncStandalone(fx.dir, env);
    const after = { ...fx, tip: revParse(fx.dir), files: eventFiles(fx.dir) };
    expect(after.files).toContain(`${String(late)}.json`);

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'moved', events: 5 });
    expectFinished(after, env, [`${fromOther}.json`]);
  });
});

describe('rollback of a move (design.md "Migration Plan") ends with a working standalone board', () => {
  it('unlock and remove the worktree, move the kept repository back, copy the events written since, delete the ref locally and on the remote', () => {
    const env = syncEnv();
    const { root, remote, dir, boardRemote, tip } = standaloneProject(env, 3);
    const files = eventFiles(dir);
    const doc = intoHostOk(root, env);
    const kept = String(doc.keptAt);
    // An event written after the move, in the host-model board, not yet synced.
    const created = spawnCli(['new', 'After the move', '--task', 'openspec:add-board-sharing#5', '--as', 'orch', '--json'], root, env);
    expect(created.code, created.stderr).toBe(0);
    const since = `${String(written(created).hash)}.json`;
    expect(eventFiles(dir)).toContain(since);

    // The rollback steps, in the design's order, with the new event copied in.
    const stash = join(tempDir(), 'since');
    mkdirSync(stash);
    for (const name of eventFiles(dir).filter((f) => !files.includes(f))) {
      cpSync(join(dir, 'events', name), join(stash, name));
    }
    git(root, 'worktree', 'unlock', dir);
    git(root, 'worktree', 'remove', '--force', dir);
    expect(existsSync(dir)).toBe(false);
    renameSync(kept, dir);
    for (const name of readdirSync(stash)) {
      cpSync(join(stash, name), join(dir, 'events', name));
    }
    git(root, 'update-ref', '-d', BOARD_REF);
    git(root, 'push', '-q', 'origin', '--delete', BOARD_REF);
    rmSync(join(dir, 'cache.sqlite'), { force: true });

    // A working standalone board again: remote, sync, list and rebuild --check agree.
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    expect(revParse(dir)).toBe(tip);
    const report = spawnCli(['remote', '--json'], root, env);
    expect(report.code, report.stderr).toBe(0);
    expect(oneJson(report)).toMatchObject({
      model: 'standalone',
      branch: 'main',
      remote: { name: 'origin', url: boardRemote },
      problems: [],
    });
    const synced = syncOk(root, env, 'rollback sync');
    expect(synced).toMatchObject({ model: 'standalone', remote: 'origin', pushed: true, committedEvents: 1 });
    expect(eventFiles(dir)).toEqual([...files, since].sort());
    expect(refEvents(boardRemote, 'main')).toEqual([...files, since].sort());
    expect(titles(root, env).sort()).toEqual(['After the move', 'Shared ticket']);
    expectCheckClean(root, env);
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');
    expect(git(root, 'ls-remote', remote, BOARD_REF).trim()).toBe('');
    expect(worktreeEntry(root, dir)).toBeNull();
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});

/**
 * guard-stale-temporary task 1.3 (design.md "Reporting"): a temporary
 * worktree that is not this board's is named the same way whether the
 * board was replaced or its history rewritten. Without rebase or
 * cherry-pick state it is removed and the move's output says so; with
 * such state it is the `sync-in-progress` refusal, whose reason and hint
 * are those of the refusal for a temporary of this board. Inode reuse is
 * simulated by rewriting the temporary's `agentboard-source` to the
 * replacement's identity, never left to the file system.
 */
describe('guard-stale-temporary: a temporary of another board is named as design.md "Reporting" says', () => {
  /** The record `name` in the git directory of the temporary worktree at `temporary`. */
  function recordPath(temporary: string, name: string): string {
    return join(git(temporary, 'rev-parse', '--absolute-git-dir').trim(), name);
  }

  /** Makes the temporary record the identity (`<realpath>:<dev>:<ino>` of the git directory) of the board at `dir` now. */
  function simulateInodeReuse(temporary: string, dir: string): void {
    const path = realpathSync(git(dir, 'rev-parse', '--absolute-git-dir').trim());
    const stats = statSync(path);
    writeFileSync(recordPath(temporary, 'agentboard-source'), `${path}:${String(stats.dev)}:${String(stats.ino)}`);
  }

  /** Replaces the board at `<root>/.board` by an unrelated standalone board with its own history and remote. */
  function replaceBoard(root: string, dir: string, env: Env): void {
    rmSync(dir, { recursive: true, force: true });
    syncedStandalone(root, env, 2, bareRemote(), 'other');
  }

  it('sync-in-progress for a stopped temporary of a replaced board whose git directory reuses the inode: the parenthesis in the text and in the --json error message, the reason and the hint those of the existing refusal', () => {
    const env = syncEnv();
    const { bRoot, bDir } = conflictingClones(env);
    const first = intoHost(bRoot, env);
    expect(first.code).toBe(3);
    expect(errorOf(first).reason).toBe('sync-conflict');
    const [temporary] = registeredMigrating(bRoot);
    // The existing refusal, for the stopped temporary of this board.
    const ownText = intoHost(bRoot, env, false);
    expect(ownText.code).toBe(3);
    const ownHint = hintOf(ownText);
    const own = errorOf(intoHost(bRoot, env));
    expect(own).toMatchObject({ exitCode: 3, reason: 'sync-in-progress' });
    expect(own.message).not.toContain('another board');
    expect(own.message).toContain(`${String(temporary)}; resolve the conflict`);
    replaceBoard(bRoot, bDir, env);
    simulateInodeReuse(String(temporary), bDir);
    const parenthesis =
      ` (that worktree was left by a move of another board, not the one at ${bDir} now or one ` +
      'whose history no longer holds where that move began, so finishing it moves nothing of this board)';
    const expected = own.message.replace(
      `${String(temporary)}; resolve the conflict`,
      `${String(temporary)}${parenthesis}; resolve the conflict`,
    );

    const text = intoHost(bRoot, env, false);

    expect(text.code).toBe(3);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain(`agentboard: ${expected}\n`);
    expect(hintOf(text)).toBe(ownHint);

    const json = intoHost(bRoot, env);

    expect(json.code).toBe(3);
    const error = errorOf(json);
    expect(error).toEqual({ exitCode: 3, reason: 'sync-in-progress', message: expected, hint: own.hint });
    expect(rebaseInProgress(String(temporary))).toBe(true);
    expect(registeredMigrating(bRoot)).toEqual([temporary]);
    expect(detectBoardModel(bDir, { env }).model).toBe('standalone');
    expect(refCommit(bRoot)).toBeNull();
  });

  it.each([
    ['the text output', false],
    ['the --json document message', true],
  ])(
    'a removed temporary of a replaced board whose git directory reuses the inode is named in %s as left by a move of another board',
    (_label, json) => {
      const env = syncEnv();
      const { root, dir } = standaloneProject(env, 3);
      const other = hostBoard(env);
      commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
      git(root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
      const c1 = String(refCommit(root));
      commitHostEvent(other.dir, ev(P.comment(T2, 'second'), 'x', 2100), env);
      git(root, 'fetch', '-q', other.root, `${BOARD_REF}:refs/test/c2`);
      const c2 = git(root, 'rev-parse', 'refs/test/c2').trim();
      // The first move integrates c1 and loses the compare-and-swap to c2:
      // a temporary of this board that integrated something, kept.
      const racing = withGitShimBefore(
        env,
        ['update-ref', BOARD_REF],
        `"$GIT" -C '${root}' update-ref ${BOARD_REF} ${c2} ${c1}`,
      );
      const lost = intoHost(root, racing);
      expect(lost.code, lost.stderr).toBe(3);
      expect(errorOf(lost).reason).toBe('sync-failed');
      const [temporary] = registeredMigrating(root);
      expect(registeredMigrating(root)).toHaveLength(1);
      replaceBoard(root, dir, env);
      simulateInodeReuse(String(temporary), dir);

      const out = intoHost(root, env, json);

      expect(out.code, out.stderr).toBe(0);
      const message = json ? String((oneJson(out) as Record<string, unknown>).message) : out.stdout;
      expect(message).toContain(
        `removed ${String(temporary)}, left by a move of another board (not the one at ${dir}, or one ` +
          'whose history no longer holds where that move began), so nothing of it was adopted\n',
      );
      expect(message).not.toContain('left by an interrupted move');
      if (json) {
        expect(oneJson(out)).toMatchObject({ action: 'moved', events: 4 });
      }
      expectMoved(root, env);
    },
  );
});

describe('into-host-replaced-after-step-4: a move killed after it updated the host ref, re-run with another board or the same', () => {
  const BEFORE_RECORD = 'agentboard-board-before';
  /** The zero object name of SHA-1, the hash algorithm of every repository these tests make. */
  const ZERO = '0'.repeat(40);

  /** The record `name` in the git directory of the temporary worktree at `temporary`. */
  function recordPath(temporary: string, name: string): string {
    return join(git(temporary, 'rev-parse', '--absolute-git-dir').trim(), name);
  }

  /** The content of the record `name` of `temporary`, or null when it has none. */
  function readRecordFile(temporary: string, name: string): string | null {
    const path = recordPath(temporary, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  /** design.md: the output line of a reset to a recorded commit. */
  function setBackLine(temporary: string): string {
    return (
      `set ${BOARD_REF} in the host repository back to its value before the interrupted move at ` +
      `${temporary}, which had updated it for another board and not published it`
    );
  }

  /** design.md "Test author rulings": the output line of a reset to the zero object name. */
  function deletedLine(temporary: string): string {
    return (
      `deleted ${BOARD_REF} in the host repository, as before the interrupted move at ` +
      `${temporary}, which had created it for another board and not published it`
    );
  }

  /** The existing line naming one removed temporary of another board. */
  function removedAsAnotherBoard(temporary: string, dir: string): string {
    return (
      `removed ${temporary}, left by a move of another board (not the one at ${dir}, or one ` +
      'whose history no longer holds where that move began), so nothing of it was adopted'
    );
  }

  /** design.md "Test author rulings": the refusal when the ref cannot be set back. */
  function cannotSetBack(temporary: string, dir: string, why: string): string {
    return (
      `the interrupted move at ${temporary} put commits of another board (not the one at ${dir}, ` +
      `or one whose history no longer holds where that move began) into ${BOARD_REF} in the host ` +
      `repository without publishing them, and ${why}, so the move cannot set the ref back by ` +
      `itself; nothing was changed; set it back by hand with git update-ref -d ${BOARD_REF} when ` +
      "the host's remote holds the board or the ref did not exist before that move, else with " +
      `git update-ref ${BOARD_REF} <its earlier commit>, then run agentboard init --into-host again`
    );
  }

  /** design.md "Test author rulings": the refusal of a lost compare-and-swap of the reset. */
  function lostReset(temporary: string, dir: string): string {
    return (
      `setting ${BOARD_REF} in the host repository back to its value before the interrupted move ` +
      `at ${temporary} failed because something else moved it meanwhile; nothing was removed, the ` +
      `board at ${dir} is untouched and the temporary worktree is kept; run agentboard init ` +
      '--into-host again'
    );
  }

  /** Asserts no commit of `ref` in `repo` ever added any of `files` (`<hash>.json`) under `events/`. */
  function expectNeverIn(repo: string, files: readonly string[]): void {
    for (const file of files) {
      expect(git(repo, 'log', '--format=%H', BOARD_REF, '--', `events/${file}`).trim(), `${repo} ${file}`).toBe('');
    }
  }

  /** Publishes, from another clone of the project at `remote`, a host-model board with one event; returns its file name. */
  function otherClonePublished(remote: string, env: Env): string {
    const other = hostBoard(env, cloneProject(remote, 'other-clone'));
    const hash = commitHostEvent(other.dir, ev(P.create(T2, 'From the other clone'), 'x', 2000), env);
    git(other.root, 'push', '-q', 'origin', `${BOARD_REF}:${BOARD_REF}`);
    return `${hash}.json`;
  }

  /** What `killedAfterUpdate` leaves. */
  interface Killed {
    readonly root: string;
    readonly remote: string;
    readonly dir: string;
    readonly tip: string;
    readonly files: string[];
    readonly otherFiles: string[];
    readonly temporary: string;
    /** The value the killed move gave the local ref. */
    readonly updated: string;
  }

  /**
   * A move of standalone board A (two events, its own remote), in a
   * project whose `origin` holds no board ref or (`joined`) another
   * clone's, killed right after (`after`) or right before (`before`) the
   * step 4 `update-ref refs/agentboard/board`.
   */
  function killedAtUpdate(env: Env, joined: boolean, when: KillWhen = 'after'): Killed {
    const { root, remote, dir, tip } = standaloneProject(env, 2);
    const files = eventFiles(dir);
    const otherFiles = joined ? [otherClonePublished(remote, env)] : [];

    expectKilled(intoHost(root, withKillingGitShim(env, COMMANDS.updateRef, when)));

    const [temporary] = registeredMigrating(root);
    expect(registeredMigrating(root)).toHaveLength(1);
    expect(detectBoardModel(dir, { env }).model).toBe('standalone');
    if (when === 'after') {
      expect(refCommit(root)).toBe(revParse(String(temporary)));
    } else {
      expect(refCommit(root)).toBeNull();
    }
    return { root, remote, dir, tip, files, otherFiles, temporary: String(temporary), updated: String(refCommit(root)) };
  }

  /** Moves `.board` aside and builds an unrelated standalone board B (one event by `bee`, its own remote) at its path; returns B's tip and files. */
  function replaceBoard(fx: Killed, env: Env): { tip: string; files: string[] } {
    renameSync(fx.dir, join(tempDir(), 'a-aside'));
    const { tip } = syncedStandalone(fx.root, env, 1, bareRemote(), 'bee');
    return { tip, files: eventFiles(fx.dir) };
  }

  it('1.1: a move killed right after the update leaves the record equal to the ref value before it (the zero object name; a hand-fetched commit, which a re-run with another board sets the ref back to)', () => {
    const env = syncEnv();
    const fx = killedAtUpdate(env, false);
    expect(readRecordFile(fx.temporary, BEFORE_RECORD)).toBe(`${ZERO}\n`);

    const { root } = standaloneProject(env, 2);
    const other = hostBoard(env);
    commitHostEvent(other.dir, ev(P.create(T2, 'From the host ref'), 'x', 2000), env);
    git(root, 'fetch', '-q', other.root, `${BOARD_REF}:${BOARD_REF}`);
    const local = String(refCommit(root));

    expectKilled(intoHost(root, withKillingGitShim(env, COMMANDS.updateRef, 'after')));

    const [temporary] = registeredMigrating(root);
    expect(refCommit(root)).toBe(revParse(String(temporary)));
    expect(readRecordFile(String(temporary), BEFORE_RECORD)).toBe(`${local}\n`);

    // Re-run with another board: the ref is set back to the hand-fetched commit, said in the text output.
    const dir = join(root, '.board');
    const aFiles = eventFiles(dir);
    renameSync(dir, join(tempDir(), 'a-aside'));
    syncedStandalone(root, env, 1, bareRemote(), 'bee');

    const out = intoHost(root, env, false);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout.split('\n')).toContain(setBackLine(String(temporary)));
    expect(out.stdout.split('\n')).toContain(removedAsAnotherBoard(String(temporary), dir));
    expect(git(root, 'merge-base', '--is-ancestor', local, BOARD_REF)).toBe('');
    expectNeverIn(root, aFiles);
  });

  it('scenario: Board replaced after the move updated the host ref (no board ref on the host remote): B moved with exit 0, the text output says the ref was deleted and names the temporary as another board, nothing of A anywhere', () => {
    const env = syncEnv();
    const fx = killedAtUpdate(env, false);
    const b = replaceBoard(fx, env);

    const out = intoHost(fx.root, env, false);

    expect(out.code, out.stderr).toBe(0);
    const lines = out.stdout.split('\n');
    expect(lines).toContain(deletedLine(fx.temporary));
    expect(lines).toContain(removedAsAnotherBoard(fx.temporary, fx.dir));
    expect(out.stdout).not.toContain('left by an interrupted move');
    syncOk(fx.root, env);
    expectMoved(fx.root, env);
    expect(eventFiles(fx.dir)).toEqual(b.files);
    expect(refEvents(fx.root)).toEqual(b.files);
    expect(refEvents(fx.remote)).toEqual(b.files);
    expectNeverIn(fx.root, fx.files);
    expectNeverIn(fx.remote, fx.files);
    expectCheckClean(fx.root, env);
  });

  it("scenario: Board replaced after a move that joined the host remote updated the host ref: B moved with exit 0, the --json message says the ref was deleted, the other clone's event and B's everywhere, nothing of A", () => {
    const env = syncEnv();
    const fx = killedAtUpdate(env, true);
    expect(readRecordFile(fx.temporary, BEFORE_RECORD)).toBe(`${ZERO}\n`);
    const b = replaceBoard(fx, env);

    const doc = intoHostOk(fx.root, env);

    expect(doc).toMatchObject({ action: 'moved', joined: true });
    const lines = String(doc.message).split('\n');
    expect(lines).toContain(deletedLine(fx.temporary));
    expect(lines).toContain(removedAsAnotherBoard(fx.temporary, fx.dir));
    syncOk(fx.root, env);
    expectMoved(fx.root, env);
    const all = [...b.files, ...fx.otherFiles].sort();
    expect(eventFiles(fx.dir)).toEqual(all);
    expect(refEvents(fx.root)).toEqual(all);
    expect(refEvents(fx.remote)).toEqual(all);
    expectNeverIn(fx.root, fx.files);
    expectNeverIn(fx.remote, fx.files);
    expectCheckClean(fx.root, env);
  });

  it.each([
    ['the host remote holding no board ref', false],
    ["the host remote holding another clone's board ref", true],
  ])(
    'scenario: Move killed after it updated the host ref resumes with the same board (%s): exit 0, every event everywhere, the killed value an ancestor of the ref, nothing set back',
    (_label, joined) => {
      const env = syncEnv();
      const fx = killedAtUpdate(env, joined);
      expect(readRecordFile(fx.temporary, BEFORE_RECORD)).toBe(`${ZERO}\n`);

      const doc = intoHostOk(fx.root, env);

      expect(doc).toMatchObject({ action: 'moved', joined });
      const message = String(doc.message);
      expect(message).not.toContain('back to its value before the interrupted move');
      expect(message).not.toContain(`deleted ${BOARD_REF}`);
      expect(message).not.toContain('another board');
      syncOk(fx.root, env);
      expectMoved(fx.root, env);
      const all = [...fx.files, ...fx.otherFiles].sort();
      expect(eventFiles(fx.dir)).toEqual(all);
      expect(refEvents(fx.root)).toEqual(all);
      expect(refEvents(fx.remote)).toEqual(all);
      expect(git(fx.root, 'merge-base', '--is-ancestor', fx.updated, BOARD_REF)).toBe('');
      const [kept] = keptRepositories(fx.root);
      expectKept(String(kept), fx.tip, fx.files);
      expectCheckClean(fx.root, env);
    },
  );

  it('scenario: Killed before the host ref was updated: the record is there and the ref is not; B moved with exit 0, nothing set back, the temporary removed as today, nothing of A in the ref', () => {
    const env = syncEnv();
    const fx = killedAtUpdate(env, false, 'before');
    expect(readRecordFile(fx.temporary, BEFORE_RECORD)).toBe(`${ZERO}\n`);
    const b = replaceBoard(fx, env);

    const doc = intoHostOk(fx.root, env);

    expect(doc).toMatchObject({ action: 'moved' });
    const message = String(doc.message);
    expect(message).not.toContain('back to its value before the interrupted move');
    expect(message).not.toContain(`deleted ${BOARD_REF}`);
    expect(message.split('\n')).toContain(`removed ${fx.temporary}, left by an interrupted move`);
    syncOk(fx.root, env);
    expectMoved(fx.root, env);
    expect(eventFiles(fx.dir)).toEqual(b.files);
    expect(refEvents(fx.root)).toEqual(b.files);
    expect(refEvents(fx.remote)).toEqual(b.files);
    expectNeverIn(fx.root, fx.files);
  });

  it.each([
    ['no record (a temporary of 0.3.0)', 'no-record'],
    ['the ref moved past the temporary HEAD', 'moved-past'],
    ['the reset losing its compare-and-swap', 'race'],
  ] as const)(
    'the refusal for %s: exit 3 sync-failed with the existing hint, the exact text on stderr and in the --json error document, nothing changed',
    (_label, variant) => {
      const env = syncEnv();
      const fx = killedAtUpdate(env, false);
      replaceBoard(fx, env);
      let run = env;
      let expected: string;
      if (variant === 'no-record') {
        rmSync(recordPath(fx.temporary, BEFORE_RECORD));
        expected = cannotSetBack(fx.temporary, fx.dir, "that move left no record of the ref's value before it");
      } else if (variant === 'moved-past') {
        const tree = git(fx.root, 'rev-parse', `${fx.updated}^{tree}`).trim();
        const past = git(fx.root, '-c', 'user.name=h', '-c', 'user.email=h@localhost', 'commit-tree', tree, '-p', fx.updated, '-m', 'on top').trim();
        git(fx.root, 'update-ref', BOARD_REF, past);
        expected = cannotSetBack(fx.temporary, fx.dir, 'the ref has moved on past what that move put into it');
      } else {
        // The reset deletes the ref: `update-ref refs/agentboard/board <zero> <HEAD>` (design.md).
        // Each racing write is a commit on top of the ref's value at that moment.
        run = withGitShimBefore(
          env,
          ['update-ref', BOARD_REF, ZERO],
          [
            `p=$("$GIT" -C '${fx.root}' rev-parse ${BOARD_REF})`,
            `t=$("$GIT" -C '${fx.root}' rev-parse "$p^{tree}")`,
            `c=$("$GIT" -C '${fx.root}' -c user.name=h -c user.email=h@localhost commit-tree "$t" -p "$p" -m race)`,
            `"$GIT" -C '${fx.root}' update-ref ${BOARD_REF} "$c" "$p"`,
          ].join('; '),
          2,
        );
        expected = lostReset(fx.temporary, fx.dir);
      }
      const before = untouched(fx.root, fx.dir);
      const remoteRefs = git(fx.remote, 'for-each-ref');

      const text = intoHost(fx.root, run, false);

      expect(text.code, text.stderr).toBe(3);
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain(`agentboard: ${expected}\n`);
      const hint = hintOf(text);
      expect(hint).toBe(renderHint('sync-failed', { surface: 'cli', command: 'init' }));
      if (variant === 'race') {
        // The other writer's commit stays; put the ref back by hand so the --json run races the same way.
        expect(git(fx.root, 'rev-parse', `${BOARD_REF}^`).trim()).toBe(fx.updated);
        git(fx.root, 'update-ref', BOARD_REF, fx.updated);
      }
      expect(untouched(fx.root, fx.dir)).toEqual(before);

      const json = intoHost(fx.root, run);

      expect(json.code).toBe(3);
      expect(errorOf(json)).toEqual({ exitCode: 3, reason: 'sync-failed', message: expected, hint });
      if (variant === 'race') {
        expect(git(fx.root, 'rev-parse', `${BOARD_REF}^`).trim()).toBe(fx.updated);
        git(fx.root, 'update-ref', BOARD_REF, fx.updated);
      }
      expect(untouched(fx.root, fx.dir)).toEqual(before);
      expect(registeredMigrating(fx.root)).toEqual([fx.temporary]);
      expect(revParse(fx.temporary)).toBe(fx.updated);
      expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
      expect(keptRepositories(fx.root)).toEqual([]);
      expect(git(fx.remote, 'for-each-ref')).toBe(remoteRefs);
    },
  );

  describe('review round 1 (reviewer-ih4-2): a same-board move interrupted twice, evidence kept, live temporaries, naming', () => {
    /** The start of the line of a reset that deleted the ref, whichever temporary it names. */
    const DELETED_PREFIX = `deleted ${BOARD_REF} in the host repository, as before the interrupted move at `;

    /** The suffix of the existing line naming removed temporaries of another board. */
    function anotherBoardSuffix(dir: string): string {
      return (
        `, left by a move of another board (not the one at ${dir}, or one whose history no longer ` +
        'holds where that move began), so nothing of it was adopted'
      );
    }

    /** design.md "Test author rulings" 6: the refusal for a live temporary of another board whose HEAD is in the ref. */
    function liveRefusal(temporary: string, dir: string): string {
      return (
        `the temporary worktree at ${temporary} was made by a move that may still be running (its ` +
        'process is alive) and put commits of another board (not the one at ' +
        `${dir}, or one whose history no longer holds where that move began) into ${BOARD_REF} in ` +
        'the host repository without publishing them; nothing was changed; run agentboard init ' +
        '--into-host again once that move has finished'
      );
    }

    /** A standalone board A (two events, its own remote) in a project whose `origin` holds no board ref or (`joined`) another clone's. */
    function boardA(env: Env, joined: boolean): { root: string; remote: string; dir: string; files: string[]; otherFiles: string[] } {
      const { root, remote, dir } = standaloneProject(env, 2);
      const files = eventFiles(dir);
      const otherFiles = joined ? [otherClonePublished(remote, env)] : [];
      return { root, remote, dir, files, otherFiles };
    }

    /** Runs `init --into-host` in `root` with a shim killing it at `trigger` (`when`, the `nth` match), asserting it was killed. */
    function killed(root: string, env: Env, trigger: readonly string[], when: KillWhen, nth = 1): void {
      expectKilled(intoHost(root, withKillingGitShim(env, trigger, when, nth)));
    }

    /**
     * `env` with a `git` shim that runs the first `update-ref
     * refs/agentboard/board` for real, then moves `.board` (`dir`) aside and
     * an unrelated standalone board (one event by `bee`, built outside the
     * host) into its place: the move then refuses at step 6. Returns the
     * env and the replacement's event files.
     */
    function replacingAfterStep4(env: Env, dir: string): { env: Env; files: string[] } {
      const staged = syncedStandalone(bareHost('staging-bee'), env, 1, bareRemote(), 'bee');
      const files = eventFiles(staged.dir);
      const scratch = tempDir();
      const fired = join(scratch, 'fired');
      return {
        files,
        env: withShellGitShim(
          env,
          [
            'case " $* " in',
            `  *" update-ref ${BOARD_REF} "*)`,
            `    if [ ! -e '${fired}' ]; then`,
            `      : > '${fired}'`,
            '      "$GIT" "$@"; status=$?',
            `      mv '${dir}' '${join(scratch, 'replaced')}' && mv '${staged.dir}' '${dir}'`,
            '      exit $status',
            '    fi',
            '    ;;',
            'esac',
          ].join('\n'),
        ),
      };
    }

    /** Moves `<root>/.board` aside and builds B (one event by `bee`, its own remote) at its path; returns B's files. */
    function replaceWithB(root: string, env: Env): string[] {
      const dir = join(root, '.board');
      if (existsSync(dir)) {
        renameSync(dir, join(tempDir(), 'a-aside'));
      }
      syncedStandalone(root, env, 1, bareRemote(), 'bee');
      return eventFiles(dir);
    }

    /**
     * The run with B at `.board` after A's interrupted moves: exit 0, a real
     * reset (the ref deleted, A's update having created it), never a
     * "set back" line, the temporary named as another board's; after a
     * sync, `.board/events`, the local and the remote ref hold B's events
     * (and the other clone's) and no commit of either ref ever added one of
     * A's.
     */
    function expectBMovedWithoutA(
      fx: { root: string; remote: string; dir: string; files: string[]; otherFiles: string[] },
      bFiles: readonly string[],
      env: Env,
    ): void {
      const temporaries = registeredMigrating(fx.root);
      const doc = intoHostOk(fx.root, env, 'the run with B');
      const lines = String(doc.message).split('\n');
      expect(lines.filter((l) => l.startsWith(DELETED_PREFIX)), String(doc.message)).toHaveLength(1);
      expect(String(doc.message)).not.toContain('back to its value before the interrupted move');
      // Review round 2 (ruling 13): every temporary of A whose HEAD was in the
      // ref when the run began is named as left by a move of another board,
      // also the second of two (D1, D5) whose update the one reset undid.
      const suffix = anotherBoardSuffix(fx.dir);
      const named = lines.find((l) => l.startsWith('removed ') && l.endsWith(suffix));
      expect(named, String(doc.message)).toBeDefined();
      const paths = String(named).slice('removed '.length, -suffix.length).split(', ');
      for (const temporary of temporaries) {
        expect(paths, String(doc.message)).toContain(temporary);
      }
      for (const line of lines.filter((l) => l.endsWith('left by an interrupted move'))) {
        for (const temporary of temporaries) {
          expect(line, String(doc.message)).not.toContain(temporary);
        }
      }
      syncOk(fx.root, env);
      expectMoved(fx.root, env);
      const all = [...bFiles, ...fx.otherFiles].sort();
      expect(eventFiles(fx.dir)).toEqual(all);
      expect(refEvents(fx.root)).toEqual(all);
      expect(refEvents(fx.remote)).toEqual(all);
      expectNeverIn(fx.root, fx.files);
      expectNeverIn(fx.remote, fx.files);
      expectCheckClean(fx.root, env);
    }

    it.each([
      ['D1: the re-run of A (fresh temporary) killed after its step 4 update', 'D1'],
      ["D2: joined, the re-run of A (adopted temporary) killed after its step 4 update", 'D2'],
      ['D2b: joined, the re-run of A (adopted temporary) killed between the record and the swap', 'D2b'],
      ['D3: the re-run of A refused at step 6, .board swapped for B right after its update', 'D3'],
      ['D5: the re-run of A (fresh temporary) killed between the record and the swap', 'D5'],
    ] as const)(
      'blocker: A killed after step 4, then %s, then B: a real reset, nothing of A anywhere',
      (_label, sequence) => {
        const env = syncEnv();
        const fx = boardA(env, sequence === 'D2' || sequence === 'D2b');
        killed(fx.root, env, COMMANDS.updateRef, 'after');
        const first = String(registeredMigrating(fx.root)[0]);
        expect(readRecordFile(first, BEFORE_RECORD)).toBe(`${ZERO}\n`);
        const ha = String(refCommit(fx.root));
        let bFiles: string[];
        if (sequence === 'D3') {
          const replacing = replacingAfterStep4(env, fx.dir);
          const refused = intoHost(fx.root, replacing.env);
          expect(refused.code, refused.stderr).toBe(3);
          expect(errorOf(refused).message).toContain('replaced meanwhile');
          bFiles = replacing.files;
        } else {
          killed(fx.root, env, COMMANDS.updateRef, sequence === 'D2b' || sequence === 'D5' ? 'before' : 'after');
          bFiles = replaceWithB(fx.root, env);
        }
        // The ref still holds A's unpublished update; no record names it as the value to set back to.
        expect(refCommit(fx.root)).toBe(ha);
        for (const temporary of registeredMigrating(fx.root)) {
          expect(readRecordFile(temporary, BEFORE_RECORD), temporary).not.toBe(`${ha}\n`);
        }

        expectBMovedWithoutA(fx, bFiles, env);
      },
    );

    it.each([
      ['killed before the fetch of step 2, after the leftover pass', 'kill'],
      ['refused when the fetch of the host remote ref fails after ls-remote listed it (another clone published meanwhile)', 'fetch'],
    ] as const)(
      'high (D4): A killed after step 4, the re-run of A %s: the evidence survives, and the run with B resets, nothing of A anywhere',
      (_label, how) => {
        const env = syncEnv();
        const fx = boardA(env, false);
        killed(fx.root, env, COMMANDS.updateRef, 'after');
        const ha = String(refCommit(fx.root));
        if (how === 'kill') {
          killed(fx.root, env, [`:${MIGRATING_FETCH_REF}`], 'before');
        } else {
          fx.otherFiles.push(otherClonePublished(fx.remote, env));
          const away = `${fx.remote}.away`;
          const breaking = withGitShimBefore(env, ['fetch', '--no-tags', 'origin', BOARD_REF], `mv '${fx.remote}' '${away}'`);
          const out = intoHost(fx.root, breaking);
          expect(out.code, out.stderr).toBe(3);
          expect(errorOf(out).reason).toBe('sync-failed');
          renameSync(away, fx.remote);
        }
        expect(refCommit(fx.root)).toBe(ha);
        // The leftover of A's first move, whose HEAD is the ref, is still there with its record.
        const kept = registeredMigrating(fx.root).filter((t) => revParse(t) === ha);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.some((t) => readRecordFile(t, BEFORE_RECORD) === `${ZERO}\n`)).toBe(true);
        const bFiles = replaceWithB(fx.root, env);

        expectBMovedWithoutA(fx, bFiles, env);
      },
    );

    /** A process that stays alive until `stopPid`, not a child of this process (so it is reaped as soon as it dies). */
    function livePid(): number {
      return Number(execFileSync('sh', ['-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
    }

    /** Kills the process `pid` and waits until it no longer exists. */
    function stopPid(pid: number): void {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        return;
      }
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        expect(Date.now()).toBeLessThan(deadline);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }

    it('medium: a temporary of another board named by a live pid (pid reuse) whose HEAD is the ref: exit 3 sync-in-progress naming it, text and --json, nothing changed; once the pid is gone, B moves with a reset (the chain knock-on cannot form)', () => {
      const env = syncEnv();
      const fx = boardA(env, false);
      killed(fx.root, env, COMMANDS.updateRef, 'after');
      const ha = String(refCommit(fx.root));
      const pid = livePid();
      try {
        const live = join(agentboardDir(fx.root), MIGRATING_DIR, String(pid));
        git(fx.root, 'worktree', 'move', String(registeredMigrating(fx.root)[0]), live);
        const bFiles = replaceWithB(fx.root, env);
        const before = untouched(fx.root, fx.dir);
        const remoteRefs = git(fx.remote, 'for-each-ref');
        const expected = liveRefusal(live, fx.dir);

        const text = intoHost(fx.root, env, false);

        expect(text.code, text.stderr).toBe(3);
        expect(text.stdout).toBe('');
        expect(text.stderr).toContain(`agentboard: ${expected}\n`);
        const hint = hintOf(text);
        expect(hint).toBe(renderHint('sync-in-progress', { surface: 'cli', command: 'init' }));
        const json = intoHost(fx.root, env);
        expect(json.code).toBe(3);
        expect(errorOf(json)).toEqual({ exitCode: 3, reason: 'sync-in-progress', message: expected, hint });
        expect(untouched(fx.root, fx.dir)).toEqual(before);
        expect(git(fx.remote, 'for-each-ref')).toBe(remoteRefs);
        expect(refCommit(fx.root)).toBe(ha);
        expect(registeredMigrating(fx.root)).toEqual([live]);
        expect(readRecordFile(live, BEFORE_RECORD)).toBe(`${ZERO}\n`);

        // The knock-on: had B's move integrated the ref, a later run would
        // have refused B's own temporary ("moved on past") and the remedy
        // would have published A. With the refusal, once the pid is gone
        // the next run with B undoes A's update.
        stopPid(pid);
        expectBMovedWithoutA(fx, bFiles, env);
      } finally {
        stopPid(pid);
      }
    });

    it('low: a run with B killed right after its reset of the ref: the next run names the temporary as left by a move of another board, not as an interrupted move', () => {
      const env = syncEnv();
      const fx = boardA(env, false);
      killed(fx.root, env, COMMANDS.updateRef, 'after');
      const temporary = String(registeredMigrating(fx.root)[0]);
      const bFiles = replaceWithB(fx.root, env);
      // The reset of design.md: `update-ref refs/agentboard/board <zero> <HEAD>`.
      killed(fx.root, env, ['update-ref', BOARD_REF, ZERO], 'after');
      expect(refCommit(fx.root)).toBeNull();
      expect(registeredMigrating(fx.root)).toEqual([temporary]);

      const doc = intoHostOk(fx.root, env);

      const message = String(doc.message);
      expect(message.split('\n')).toContain(removedAsAnotherBoard(temporary, fx.dir));
      expect(message).not.toContain('left by an interrupted move');
      syncOk(fx.root, env);
      expectMoved(fx.root, env);
      expect(eventFiles(fx.dir)).toEqual(bFiles);
      expect(refEvents(fx.remote)).toEqual(bFiles);
      expectNeverIn(fx.root, fx.files);
      expectNeverIn(fx.remote, fx.files);
    });

    describe('review round 2: a third writer on top of the evidence, a live temporary of this board, a kill between the marker and the reset', () => {
      it("R1 (N6): A killed after step 4, a third writer's commit on top of A's update, A's resume killed after its update, then B: refused (no record), nothing changed, nothing of A anywhere", () => {
        const env = syncEnv();
        const fx = boardA(env, false);
        killed(fx.root, env, COMMANDS.updateRef, 'after');
        const first = String(registeredMigrating(fx.root)[0]);
        const ha = String(refCommit(fx.root));
        const tree = git(fx.root, 'rev-parse', `${ha}^{tree}`).trim();
        const x = git(fx.root, '-c', 'user.name=h', '-c', 'user.email=h@localhost', 'commit-tree', tree, '-p', ha, '-m', 'third writer').trim();
        git(fx.root, 'update-ref', BOARD_REF, x, ha);
        killed(fx.root, env, COMMANDS.updateRef, 'after');
        expect(refCommit(fx.root)).toBe(x);
        const resumed = registeredMigrating(fx.root).filter((t) => t !== first);
        expect(resumed).toHaveLength(1);
        const second = String(resumed[0]);
        expect(revParse(second)).toBe(x);
        // A's first leftover (HEAD an ancestor of the ref) was the evidence:
        // its HEAD is not the ref, so it carried no record, and the resume wrote none.
        expect(readRecordFile(second, BEFORE_RECORD)).toBeNull();
        replaceWithB(fx.root, env);
        const before = untouched(fx.root, fx.dir);
        const remoteRefs = git(fx.remote, 'for-each-ref');

        const out = intoHost(fx.root, env);

        expect(out.code, out.stderr).toBe(3);
        expect(errorOf(out)).toMatchObject({
          reason: 'sync-failed',
          message: cannotSetBack(second, fx.dir, "that move left no record of the ref's value before it"),
        });
        expect(untouched(fx.root, fx.dir)).toEqual(before);
        expect(git(fx.remote, 'for-each-ref')).toBe(remoteRefs);
        expect(refCommit(fx.remote)).toBeNull();
        expect(refCommit(fx.root)).toBe(x);
        for (const file of fx.files) {
          expect(eventFiles(fx.dir)).not.toContain(file);
        }
      });

      it('A: a live temporary of this board whose HEAD is the ref is left alone: the same board moves with exit 0, the temporary untouched and not named', () => {
        const env = syncEnv();
        const fx = boardA(env, false);
        killed(fx.root, env, COMMANDS.updateRef, 'after');
        const pid = livePid();
        try {
          const live = join(agentboardDir(fx.root), MIGRATING_DIR, String(pid));
          git(fx.root, 'worktree', 'move', String(registeredMigrating(fx.root)[0]), live);
          const head = revParse(live);
          const record = readRecordFile(live, BEFORE_RECORD);

          const doc = intoHostOk(fx.root, env);

          expect(doc).toMatchObject({ action: 'moved' });
          expect(String(doc.message)).not.toContain(live);
          expect(registeredMigrating(fx.root)).toEqual([live]);
          expect(revParse(live)).toBe(head);
          expect(readRecordFile(live, BEFORE_RECORD)).toBe(record);
          expect(eventFiles(fx.dir)).toEqual(fx.files);
          expect(refEvents(fx.remote)).toEqual(fx.files);
        } finally {
          stopPid(pid);
        }
      });

      it('B: a run with B killed between marking the temporary and the reset command: the next run, the HEAD still the ref, resets and names it as another board, nothing of A anywhere', () => {
        const env = syncEnv();
        const fx = boardA(env, false);
        killed(fx.root, env, COMMANDS.updateRef, 'after');
        const ha = String(refCommit(fx.root));
        const bFiles = replaceWithB(fx.root, env);
        killed(fx.root, env, ['update-ref', BOARD_REF, ZERO], 'before');
        expect(refCommit(fx.root)).toBe(ha);
        expect(registeredMigrating(fx.root)).toHaveLength(1);

        expectBMovedWithoutA(fx, bFiles, env);
      });
    });
  });
});
