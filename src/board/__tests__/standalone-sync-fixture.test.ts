/**
 * The standalone `sync` pinned byte for byte (add-board-sharing task 3.1:
 * "the standalone sync output and commits byte-identical to a fixture
 * recorded before this group"; board-concurrency "Sync converges": "for a
 * standalone board it SHALL pull with rebase ... and push its branch, as
 * before"). The fixture `fixtures/standalone-sync.json` was recorded by
 * this file, run with `AGENTBOARD_RECORD_FIXTURES=1`, from the code as it
 * was before host-model sync existed (commit 3babbc5, the merge of task
 * group 2). Every run replays the same scenario with fixed clocks and
 * compares, against the fixture: the `SyncResult` of each step (board
 * directories replaced by placeholders), the text and the JSON document
 * the built CLI prints, and the whole commit history of every repository
 * involved (ids, trees, parents, identities, dates, messages and the
 * paths each commit touches).
 *
 * A `SyncResult` may gain keys after the recording (the sharing fields of
 * group 3); only the recorded keys are compared, so a new key never breaks
 * the fixture while a changed value, a changed message or a changed commit
 * does. Re-recording the fixture is a deliberate act that a review must
 * see, never something a test run does on its own.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { P, T1, T2, ev, putEvent } from '../../store/__tests__/helpers.js';
import { syncBoard, type SyncResult } from '../sync.js';
import { oneJson, spawnCli } from '../../cli/__tests__/cli-helpers.js';
import { git, openTracked } from './helpers.js';
import { bareRemote, cloneMachine, initMachine, syncEnv, type Env } from './sync-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'standalone-sync.json');

/** Set to `1` to write the fixture from the current code instead of comparing with it. */
const RECORD = process.env.AGENTBOARD_RECORD_FIXTURES === '1';

/** One fixed clock for every commit, so commit ids depend on content only. */
const CLOCK = '@1700000000 +0000';

/** The environment of every sync here: no identity, the fixed clock. */
function fixedEnv(): Env {
  return syncEnv({ GIT_AUTHOR_DATE: CLOCK, GIT_COMMITTER_DATE: CLOCK });
}

/**
 * `value` with every occurrence of each path in `places` replaced by its
 * placeholder, in every string, however deeply nested. Longer paths are
 * replaced first so a path never eats a longer one that contains it.
 */
function anonymise(value: unknown, places: ReadonlyMap<string, string>): unknown {
  const ordered = [...places.entries()].sort((a, b) => b[0].length - a[0].length);
  const text = (s: string): string =>
    ordered.reduce((acc, [path, token]) => acc.split(path).join(token), s);
  if (typeof value === 'string') {
    return text(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => anonymise(item, places));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, anonymise(item, places)]),
    );
  }
  return value;
}

/** The full history of `ref` in the repository at `repo`, as git describes it, with the paths of each commit. */
function history(repo: string, ref: string): string {
  return git(
    repo,
    'log',
    '--date=iso-strict',
    '--format=commit %H%ntree %T%nparents %P%nauthor %an <%ae> %ad%ncommitter %cn <%ce> %cd%nsubject %s%nbody %b%nend',
    '--name-status',
    '--no-decorate',
    ref,
  );
}

interface Recorded {
  readonly results: Record<string, unknown>;
  readonly histories: Record<string, string>;
  readonly cli: Record<string, { code: number; stdout: string; stderr: string }>;
  readonly cliJson: Record<string, unknown>;
}

/**
 * Replays the scenario and returns what it produced, anonymised:
 *
 * - `a-first`: machine A (one event, `origin` set) syncs; the remote has
 *   no `main` yet, so nothing is pulled, the push sets the upstream.
 * - `a-second`: A adds a comment and syncs (a pull that brings nothing).
 * - `b-first`: machine B (a clone of the remote, one event of its own)
 *   syncs: pull with rebase brings A's comment, B's commit is replayed.
 * - `a-third`: A syncs: B's event arrives.
 * - `a-fourth`: A syncs with nothing new.
 * - `no-remote`: machine C has no remote; sync commits and stops.
 * - CLI runs on machines D (no remote) and E (an empty remote, then
 *   nothing new): the exact text, the exact JSON document.
 */
function replay(): Recorded {
  const env = fixedEnv();
  const places = new Map<string, string>();
  const results: Record<string, unknown> = {};
  const histories: Record<string, string> = {};
  const cli: Recorded['cli'] = {};
  const cliJson: Record<string, unknown> = {};
  const record = (key: string, result: SyncResult): void => {
    results[key] = anonymise(result, places);
  };

  const remote = bareRemote();
  places.set(remote, '<REMOTE>');
  const a = initMachine(env, remote);
  places.set(a.dir, '<A>');
  const boardA = openTracked(a.dir);
  putEvent(boardA.eventsDir, ev(P.create(T1, 'From A'), 'alice', 1_000));
  record('a-first', syncBoard(boardA, { env }));

  const b = cloneMachine(remote);
  places.set(b.dir, '<B>');
  const boardB = openTracked(b.dir);
  putEvent(boardB.eventsDir, ev(P.create(T2, 'From B'), 'bob', 2_000));
  putEvent(boardA.eventsDir, ev(P.comment(T1, 'again from A'), 'alice', 3_000));
  record('a-second', syncBoard(boardA, { env }));
  record('b-first', syncBoard(boardB, { env }));
  record('a-third', syncBoard(boardA, { env }));
  record('a-fourth', syncBoard(boardA, { env }));

  const c = initMachine(env);
  places.set(c.dir, '<C>');
  const boardC = openTracked(c.dir);
  putEvent(boardC.eventsDir, ev(P.create(T1, 'Alone'), 'carol', 4_000));
  record('no-remote', syncBoard(boardC, { env }));

  histories.a = String(anonymise(history(a.dir, 'main'), places));
  histories.b = String(anonymise(history(b.dir, 'main'), places));
  histories.remote = String(anonymise(history(remote, 'main'), places));
  histories.c = String(anonymise(history(c.dir, 'main'), places));

  const d = initMachine(env);
  places.set(d.dir, '<D>');
  putEvent(join(d.dir, 'events'), ev(P.create(T1, 'Alone'), 'carol', 4_000));
  const dText = spawnCli(['sync'], d.root, env);
  cli['d-no-remote'] = anonymise(dText, places) as Recorded['cli'][string];
  putEvent(join(d.dir, 'events'), ev(P.comment(T1, 'and again'), 'carol', 5_000));
  cliJson['d-no-remote'] = anonymise(oneJson(spawnCli(['sync', '--json'], d.root, env)), places);

  const remote2 = bareRemote();
  places.set(remote2, '<REMOTE2>');
  const e = initMachine(env, remote2);
  places.set(e.dir, '<E>');
  putEvent(join(e.dir, 'events'), ev(P.create(T2, 'Published'), 'erin', 6_000));
  cli['e-first'] = anonymise(spawnCli(['sync'], e.root, env), places) as Recorded['cli'][string];
  cli['e-nothing-new'] = anonymise(
    spawnCli(['sync'], e.root, env),
    places,
  ) as Recorded['cli'][string];
  putEvent(join(e.dir, 'events'), ev(P.comment(T2, 'more'), 'erin', 7_000));
  cliJson['e-second'] = anonymise(oneJson(spawnCli(['sync', '--json'], e.root, env)), places);
  histories.e = String(anonymise(history(e.dir, 'main'), places));

  return { results, histories, cli, cliJson };
}

/** `actual` restricted to the keys of `recorded` (a result may gain keys after the recording). */
function recordedKeys(actual: unknown, recorded: unknown): unknown {
  if (recorded !== null && typeof recorded === 'object' && !Array.isArray(recorded)) {
    const subject = actual as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(recorded).map((key) => [
        key,
        recordedKeys(subject[key], (recorded as Record<string, unknown>)[key]),
      ]),
    );
  }
  return actual;
}

describe('standalone sync against the fixture recorded before host-model sync', () => {
  let produced: Recorded;
  let fixture: Recorded;

  beforeAll(() => {
    produced = replay();
    if (RECORD) {
      writeFileSync(FIXTURE, `${JSON.stringify(produced, null, 2)}\n`);
    }
    fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recorded;
  });

  it('the fixture exists (recorded with AGENTBOARD_RECORD_FIXTURES=1 before this group)', () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  it('every SyncResult is what was recorded (recorded keys)', () => {
    expect(Object.keys(produced.results).sort()).toEqual(Object.keys(fixture.results).sort());
    for (const [key, recorded] of Object.entries(fixture.results)) {
      expect(recordedKeys(produced.results[key], recorded), key).toEqual(recorded);
    }
  });

  it('the commit history of every repository is byte-identical to the recording', () => {
    expect(produced.histories).toEqual(fixture.histories);
  });

  it('the text the CLI prints is byte-identical to the recording', () => {
    expect(produced.cli).toEqual(fixture.cli);
  });

  it('the JSON document the CLI prints has the recorded values (recorded keys)', () => {
    expect(Object.keys(produced.cliJson).sort()).toEqual(Object.keys(fixture.cliJson).sort());
    for (const [key, recorded] of Object.entries(fixture.cliJson)) {
      expect(recordedKeys(produced.cliJson[key], recorded), key).toEqual(recorded);
    }
  });

  it('the recording holds real commits, not placeholders left unfilled', () => {
    expect(fixture.histories.a).toMatch(/^commit [0-9a-f]{40}\n/);
    expect(fixture.histories.remote).toBe(fixture.histories.b);
    expect(fixture.cli['e-first']?.stdout).toContain(
      'pushed main to origin and set it as the upstream',
    );
    expect(fixture.cli['d-no-remote']?.stdout).toContain('no remote configured');
    for (const run of Object.values(fixture.cli)) {
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout).not.toMatch(/\/(private|tmp|var)\//);
    }
  });
});
