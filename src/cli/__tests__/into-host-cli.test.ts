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

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { COMMANDS, expectCheckClean, expectKilled, canonicalDump } from '../../__tests__/harness/host-sync.js';
import { git, tempDir } from '../../board/__tests__/helpers.js';
import {
  agentboardDir,
  cloneWithStandalone,
  eventFiles,
  expectKept,
  expectMoved,
  expectUntouched,
  keptRepositories,
  migratingEntries,
  project,
  refEvents,
  standaloneProject,
  syncStandalone,
  syncedStandalone,
  untouched,
  writeEvents,
} from '../../board/__tests__/into-host-helpers.js';
import {
  BOARD_REF,
  commitHostEvent,
  hostBoard,
  refCommit,
  withGitShim,
  withKillingGitShim,
  worktreeEntry,
  type KillWhen,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, revParse, syncEnv, type Env } from '../../board/__tests__/sync-helpers.js';
import { MIGRATING_DIR, MIGRATING_REF } from '../../board/into-host.js';
import { detectBoardModel } from '../../board/model.js';
import { P, T1, T2, ev } from '../../store/__tests__/helpers.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { renderHint } from '../../guidance/hints.js';
import { INIT_SUGGESTION } from '../../guidance/install.js';
import { parseArgs } from '../parse.js';
import { findCommand } from '../registry.js';
import { oneJson, spawnCli, written, type Run } from './cli-helpers.js';

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

  it('killed after the fetch into refs/agentboard/migrating (step 2): the board is still standalone; the re-run moves it', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, [`:${MIGRATING_REF}`], 'after');

    expect(refCommit(fx.root, MIGRATING_REF)).toBe(fx.tip);
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(refCommit(fx.root)).toBeNull();
    expect(keptRepositories(fx.root)).toEqual([]);

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'moved' });
    expectFinished(fx, env);
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

  it('killed after the temporary ref is deleted (end of step 4, before the verification): the re-run moves', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['update-ref', '-d', MIGRATING_REF], 'after');

    expect(refCommit(fx.root)).toBe(fx.tip);
    expect(refCommit(fx.root, MIGRATING_REF)).toBeNull();
    expect(detectBoardModel(fx.dir, { env }).model).toBe('standalone');
    expect(keptRepositories(fx.root)).toEqual([]);

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'moved' });
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

  it('killed after the worktree move, before the lock (step 6): the re-run restores the lock and reports the board unchanged', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['worktree', 'move'], 'after');

    expect(detectBoardModel(fx.dir, { env }).model).toBe('host');
    expect(worktreeEntry(fx.root, fx.dir)?.locked).toBeNull();
    expect(keptRepositories(fx.root)).toHaveLength(1);

    const doc = intoHostOk(fx.root, env);
    expect(doc).toMatchObject({ action: 'unchanged', model: 'host' });
    expect(String(doc.message)).toMatch(/lock/);
    expectFinished(fx, env);
  });

  it('killed after the lock, before the sync (step 7): the re-run is unchanged and the next sync publishes', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, ['worktree', 'lock'], 'after');

    expect(worktreeEntry(fx.root, fx.dir)?.locked).toBe('agentboard board');
    expect(git(fx.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentboard/')).toBe('');

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
    expectFinished(fx, env);
  });

  it('killed after the push, before the catch-up (step 7): the board is published; the re-run is unchanged', () => {
    const env = syncEnv();
    const fx = fixture(env);

    killedAt(fx.root, env, [...COMMANDS.push], 'after');

    expect(git(fx.remote, 'rev-parse', BOARD_REF).trim()).toBe(refCommit(fx.root));
    expectMoved(fx.root, env);

    expect(intoHostOk(fx.root, env)).toMatchObject({ action: 'unchanged' });
    expectFinished(fx, env);
    expect(titles(fx.root, env)).toEqual(['Shared ticket']);
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
