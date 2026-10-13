/**
 * `agentboard sync` on a host-model board through the built CLI
 * (`dist/cli.js`; add-board-sharing tasks 3.1 and 3.3): the golden
 * `sync --json` documents of `fixtures/host-sync-golden.json`, whose
 * commit ids are recomputed here with git plumbing alone from the event
 * bytes; the text output; the `board-on-branch`, `git-too-old` and
 * `board-link-broken` refusals with their hints; `help sync` and the
 * README naming the host-model exit reasons. Every remote is a bare
 * repository on local disk.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { git, gitRepo, tempDir } from '../../board/__tests__/helpers.js';
import {
  BOARD_REF,
  EMPTY_BOARD_COMMIT_ID,
  commitHostEvent,
  hostBoard,
  joinHostBoard,
  pushBoardRef,
  refCommit,
  withGitShim,
} from '../../board/__tests__/sharing-helpers.js';
import { bareRemote, revParse, syncEnv, type Env } from '../../board/__tests__/sync-helpers.js';
import { P, T1, ev, putEvent } from '../../store/__tests__/helpers.js';
import { oneJson, spawnCli, type Run } from './cli-helpers.js';

// Every test spawns the CLI and git several times; keep well clear of the 5 s default.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, '..', '..', '..', 'README.md');

/** The golden documents, keyed by scenario, with `<DIR>` for the board directory. */
const GOLDEN = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'host-sync-golden.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

/** One fixed clock for every commit, so commit ids depend on content only. */
const CLOCK = '@1700000000 +0000';

/** The two events of the golden scenario, with their content hashes. */
const GOLDEN_EVENTS = {
  create: {
    event: ev(P.create(T1, 'Golden'), 'orch', 1_000),
    hash: '4b4a7857b3b33487e86aa7b1aef41e7bad1c4e7f110632753ff8e25c076abc70',
  },
  comment: {
    event: ev(P.comment(T1, 'golden comment'), 'orch', 2_000),
    hash: 'd9f99a596f9ed2e36e412ad9d074608d7f82316d50b2cab475d89541fedc883a',
  },
} as const;

/** The commit ids the golden documents pin: the first sync commit and the second. */
const GOLDEN_COMMITS = {
  first: '957c60c78a4a01b211083f25a1978b7b5d3be53a',
  second: '2f66fd3d93c94d6387b8a12ce4b3ea2381e24711',
} as const;

/**
 * A throwaway POSIX shell script that computes the two golden commits with
 * plumbing only, given the paths of the two event files: the empty-board
 * root (`EMPTY_BOARD_SCRIPT`'s commit), then a commit adding the first
 * event, then one adding the second, as `agentboard <agentboard@localhost>`
 * at the golden clock with the ADR 0005 message. Independent of every
 * agentboard module. Prints the two commit ids, one per line.
 */
const GOLDEN_COMMITS_SCRIPT = [
  '#!/bin/sh',
  'set -e',
  'e1="$1"; e2="$2"',
  'h1=$(basename "$e1" .json); h2=$(basename "$e2" .json)',
  "ignore=$(printf 'cache.sqlite\\ncache.sqlite-wal\\ncache.sqlite-shm\\n' | git hash-object -w --stdin)",
  "keep=$(printf '' | git hash-object -w --stdin)",
  'b1=$(git hash-object -w "$e1"); b2=$(git hash-object -w "$e2")',
  'export GIT_AUTHOR_NAME=agentboard GIT_AUTHOR_EMAIL=agentboard@localhost',
  'export GIT_COMMITTER_NAME=agentboard GIT_COMMITTER_EMAIL=agentboard@localhost',
  'ev0=$(printf \'100644 blob %s\\t.gitkeep\\n\' "$keep" | git mktree)',
  'root0=$(printf \'100644 blob %s\\t.gitignore\\n040000 tree %s\\tevents\\n\' "$ignore" "$ev0" | git mktree)',
  "empty=$(GIT_AUTHOR_DATE='@0 +0000' GIT_COMMITTER_DATE='@0 +0000' git commit-tree \"$root0\" -m 'agentboard: empty board')",
  `export GIT_AUTHOR_DATE='${CLOCK}' GIT_COMMITTER_DATE='${CLOCK}'`,
  'ev1=$(printf \'100644 blob %s\\t.gitkeep\\n100644 blob %s\\t%s.json\\n\' "$keep" "$b1" "$h1" | git mktree)',
  'root1=$(printf \'100644 blob %s\\t.gitignore\\n040000 tree %s\\tevents\\n\' "$ignore" "$ev1" | git mktree)',
  'c1=$(git commit-tree "$root1" -p "$empty" -m \'agentboard sync: 1 event file\')',
  'ev2=$(printf \'100644 blob %s\\t.gitkeep\\n100644 blob %s\\t%s.json\\n100644 blob %s\\t%s.json\\n\' "$keep" "$b1" "$h1" "$b2" "$h2" | git mktree)',
  'root2=$(printf \'100644 blob %s\\t.gitignore\\n040000 tree %s\\tevents\\n\' "$ignore" "$ev2" | git mktree)',
  'c2=$(git commit-tree "$root2" -p "$c1" -m \'agentboard sync: 1 event file\')',
  'echo "$empty"; echo "$c1"; echo "$c2"',
  '',
].join('\n');

/** The environment of every sync here: no identity, the golden clock. */
function goldenEnv(): Env {
  return syncEnv({ GIT_AUTHOR_DATE: CLOCK, GIT_COMMITTER_DATE: CLOCK });
}

/** `sync` in `cwd` through the built CLI, no actor given. */
function sync(cwd: string, env: Env, json = false): Run {
  return spawnCli(json ? ['sync', '--json'] : ['sync'], cwd, env);
}

/** The `sync --json` document of `cwd`, with its board directory replaced by `<DIR>` everywhere. */
function syncDocument(cwd: string, env: Env): Record<string, unknown> {
  const out = sync(cwd, env, true);
  expect(out.code, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  const doc = oneJson(out) as Record<string, unknown>;
  const dir = String(doc.dir);
  expect(realpathSync(dir)).toBe(realpathSync(join(cwd, '.board')));
  return JSON.parse(JSON.stringify(doc).split(dir).join('<DIR>')) as Record<string, unknown>;
}

/** A host with a bare `origin` holding its `main`, and a host-model board at the empty-board commit. */
function hostWithOrigin(env: Env): { root: string; dir: string; remote: string } {
  const remote = bareRemote();
  const { root, dir } = hostBoard(env);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, dir, remote };
}

describe('the golden commit ids come from git plumbing alone', () => {
  it('a throwaway script computes the pinned ids from the event bytes', () => {
    const scratch = gitRepo(join(tempDir(), 'scratch'));
    const events = join(tempDir(), 'events');
    mkdirSync(events);
    const e1 = join(events, `${GOLDEN_EVENTS.create.hash}.json`);
    const e2 = join(events, `${GOLDEN_EVENTS.comment.hash}.json`);
    expect(putEvent(events, GOLDEN_EVENTS.create.event)).toBe(GOLDEN_EVENTS.create.hash);
    expect(putEvent(events, GOLDEN_EVENTS.comment.event)).toBe(GOLDEN_EVENTS.comment.hash);
    const script = join(tempDir(), 'golden-commits.sh');
    writeFileSync(script, GOLDEN_COMMITS_SCRIPT);

    const out = execFileSync('sh', [script, e1, e2], {
      cwd: scratch,
      env: { ...goldenEnv() },
      encoding: 'utf8',
    });

    expect(out.trim().split('\n')).toEqual([
      EMPTY_BOARD_COMMIT_ID,
      GOLDEN_COMMITS.first,
      GOLDEN_COMMITS.second,
    ]);
  });

  it('the fixture pins those ids and hashes', () => {
    expect(GOLDEN['no-remote']?.commit).toBe(GOLDEN_COMMITS.first);
    expect(GOLDEN['first-publish']?.refCommit).toBe(GOLDEN_COMMITS.first);
    expect(GOLDEN['second-publish']?.commit).toBe(GOLDEN_COMMITS.second);
    expect(GOLDEN.arrival?.arrived).toEqual([GOLDEN_EVENTS.comment.hash]);
    expect(GOLDEN.arrival?.refCommit).toBe(GOLDEN_COMMITS.second);
    expect(Object.keys(GOLDEN).sort()).toEqual(
      ['arrival', 'first-publish', 'no-remote', 'nothing-new', 'second-publish'].sort(),
    );
  });
});

describe('golden sync --json documents of a host-model board', () => {
  it('no remote: commits and moves the ref', () => {
    const env = goldenEnv();
    const { dir } = hostBoard(env);
    putEvent(join(dir, 'events'), GOLDEN_EVENTS.create.event);

    expect(syncDocument(dirname(dir), env)).toEqual(GOLDEN['no-remote']);
  });

  it('first publish, nothing new, second publish, and the arrival in a second clone', () => {
    const env = goldenEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    putEvent(join(dir, 'events'), GOLDEN_EVENTS.create.event);

    expect(syncDocument(root, env)).toEqual(GOLDEN['first-publish']);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(GOLDEN_COMMITS.first);

    expect(syncDocument(root, env)).toEqual(GOLDEN['nothing-new']);

    const b = joinHostBoard(remote, 'b');
    expect(revParse(b.dir)).toBe(GOLDEN_COMMITS.first);
    putEvent(join(dir, 'events'), GOLDEN_EVENTS.comment.event);
    expect(syncDocument(root, env)).toEqual(GOLDEN['second-publish']);
    expect(git(remote, 'rev-parse', BOARD_REF).trim()).toBe(GOLDEN_COMMITS.second);

    expect(syncDocument(b.root, env)).toEqual(GOLDEN.arrival);
    expect(refCommit(b.root)).toBe(GOLDEN_COMMITS.second);
    expect(revParse(b.dir)).toBe(GOLDEN_COMMITS.second);
    const listed = spawnCli(['list', '--json'], b.root, env);
    expect(listed.code, listed.stderr).toBe(0);
    expect(oneJson(listed)).toMatchObject([{ id: T1, title: 'Golden' }]);
    const check = spawnCli(['rebuild', '--check', '--json'], b.root, env);
    expect(check.code, check.stderr).toBe(0);
  });

  it('prints the message as text, one line per step, and nothing on stderr', () => {
    const env = goldenEnv();
    const { root } = hostWithOrigin(env);
    putEvent(join(root, '.board', 'events'), GOLDEN_EVENTS.create.event);

    const out = sync(root, env);

    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe(`${String(GOLDEN['first-publish']?.message)}\n`);
  });
});

describe('host-model refusals through the CLI', () => {
  it('scenario: Board worktree on a branch: exit 3 board-on-branch, the hint names the detach command', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    git(dir, 'switch', '-q', '-c', 'scratch');
    putEvent(join(dir, 'events'), ev(P.create(T1, 'On a branch'), 'orch', 1_000));

    const out = sync(root, env);

    expect(out.code).toBe(3);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*scratch/m);
    expect(out.stderr).toMatch(/^hint: .*git -C \.board switch --detach refs\/agentboard\/board/m);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(revParse(dir)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');

    const json = sync(root, env, true);
    expect(json.code).toBe(3);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 3, reason: 'board-on-branch' } });
    const { message } = (oneJson(json) as { error: { message: string } }).error;
    expect(message).toContain(`switch --detach ${BOARD_REF}`);
  });

  it('exits 1 git-too-old on a git older than 2.32, with a hint naming 2.32, staging nothing', () => {
    const base = syncEnv();
    const { root, dir, remote } = hostWithOrigin(base);
    putEvent(join(dir, 'events'), ev(P.create(T1, 'Old git'), 'orch', 1_000));
    const env = withGitShim(base, '2.31.8');

    const out = sync(root, env);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: .*2\.31\.8.*2\.32/m);
    expect(out.stderr).toMatch(/^hint: .*2\.32/m);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(revParse(dir)).toBe(EMPTY_BOARD_COMMIT_ID);
    expect(git(remote, 'for-each-ref', 'refs/agentboard/')).toBe('');

    const json = sync(root, env, true);
    expect(json.code).toBe(1);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 1, reason: 'git-too-old' } });
  });

  it('exits 2 board-link-broken on a stale board copied into a fresh clone, with the init hint (group 1)', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    commitHostEvent(dir, ev(P.create(T1, 'Stale'), 'orch', 1_000), env);
    pushBoardRef(root);
    const cRoot = join(tempDir(), 'clone-c');
    git(tempDir(), 'clone', '-q', remote, cRoot);
    cpSync(dir, join(cRoot, '.board'), { recursive: true });

    const out = sync(cRoot, env);

    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^hint: .*'agentboard init'/m);
    const json = sync(cRoot, env, true);
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 2, reason: 'board-link-broken' } });
  });

  it('exits 3 sync-conflict, then sync-in-progress, on a host-model board', () => {
    const env = syncEnv();
    const { root, dir, remote } = hostWithOrigin(env);
    pushBoardRef(root);
    const b = joinHostBoard(remote, 'b');
    writeFileSync(join(dir, '.gitignore'), 'cache.sqlite\nonly-on-a\n');
    writeFileSync(join(b.dir, '.gitignore'), 'cache.sqlite\nonly-on-b\n');
    expect(sync(root, env).code).toBe(0);

    const out = sync(b.root, env, true);

    expect(out.code).toBe(3);
    expect(oneJson(out)).toMatchObject({ error: { exitCode: 3, reason: 'sync-conflict' } });
    expect((oneJson(out) as { error: { message: string } }).error.message).toContain('.gitignore');
    const again = sync(b.root, env, true);
    expect(again.code).toBe(3);
    expect(oneJson(again)).toMatchObject({ error: { exitCode: 3, reason: 'sync-in-progress' } });
    expect(git(b.root, 'status', '--porcelain')).toBe('');
  });
});

describe('help and the README document host-model sync (task 3.3)', () => {
  it('help sync lists board-on-branch (3) and git-too-old (1) and names the board ref', () => {
    const out = spawnCli(['help', 'sync'], tempDir(), syncEnv());

    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/3\b.*board-on-branch|board-on-branch.*\b3\b/);
    expect(out.stdout).toMatch(/1\b.*git-too-old|git-too-old.*\b1\b/);
    expect(out.stdout).toContain(BOARD_REF);
    expect(out.stdout).toContain('agentboard.remote');
  });

  it('help sync --json carries the two reasons in its exit codes', () => {
    const out = spawnCli(['help', 'sync', '--json'], tempDir(), syncEnv());
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { exitCodes: { code: number; reason?: string }[] };
    expect(doc.exitCodes).toContainEqual(
      expect.objectContaining({ code: 3, reason: 'board-on-branch' }),
    );
    expect(doc.exitCodes).toContainEqual(
      expect.objectContaining({ code: 1, reason: 'git-too-old' }),
    );
    expect(doc.exitCodes).toContainEqual(
      expect.objectContaining({ code: 2, reason: 'board-link-broken' }),
    );
  });

  it('the README section "Sync between machines" covers the host-model sync', () => {
    const readme = readFileSync(README, 'utf8');
    const start = readme.indexOf('## Sync between machines');
    expect(start).toBeGreaterThan(0);
    const rest = readme.slice(start + '## Sync between machines'.length);
    const section = rest.slice(0, rest.search(/\n## /));
    for (const text of [
      'refs/agentboard/board',
      'agentboard.remote',
      'board-on-branch',
      'git-too-old',
      'board-link-broken',
      'sync-conflict',
      'ambiguous-remote',
      'push --mirror',
      'init --remote',
      'hook',
      'git -C .board switch --detach refs/agentboard/board',
    ]) {
      expect(section, text).toContain(text);
    }
    // Plain ASCII, as every document of the project.
    expect([...section].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });
});
