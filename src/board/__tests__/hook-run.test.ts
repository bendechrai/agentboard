/**
 * `runHook`, the core of `agentboard hook` with the payload already read
 * (add-harness-integration task 1.1; board-harness-hooks "Hook command
 * and protocol", "Hook actor resolution"; board-cli "Exit codes", "Due
 * grants are written during catch-up" scenario "Hook writes no due
 * grant", "Refusals never repeat the refused input").
 *
 * In process, with the clock injected through vitest fake timers (`Date`
 * only) where a grant must be due at an exact time. These tests pin the
 * protocol only (arguments, escape hatch, actor, discovery, fail open,
 * read-only); what each event prints for a resolved actor on a readable
 * board is task group 2's (hooks/events). The built CLI, stdin and the
 * time budget are in src/__tests__/hook-processes.test.ts.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { TicketGrantEvent } from '../../events/schema.js';
import { dumpCache, openCache } from '../../store/cache.js';
import { ev, eventNames, P, putEvent, T1, T2 } from '../../store/__tests__/helpers.js';
import { V020_FIXTURES, cacheHashes, fixtureBoard } from '../../store/__tests__/v020-cache.js';
import {
  AWS_KEY_ID,
  CROCKFORD_26,
  GITHUB_TOKEN,
  HEX_40,
  HEX_64,
  LONG_WORD,
  TOKEN_FIXTURES,
  URL_WITH_CREDENTIALS,
  expectNoLeak,
} from '../../__tests__/harness/secret-fixtures.js';
import { cliEnv, oneJson, project, run } from '../../cli/__tests__/cli-helpers.js';
import { runHook, type HookOutcome, type HookRequest } from '../hook.js';
import { cleanEnv, git, gitRepo, makeBoardDir, tempDir } from './helpers.js';

/** The environment of a hook: clean git, no board override, no actor. */
function hookEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return cleanEnv({
    AGENTBOARD_ACTOR: undefined,
    AGENTBOARD_DIR: undefined,
    AGENTBOARD_HOOKS: undefined,
    ...extra,
  });
}

/**
 * Runs a hook with `argv` (after `hook`) in `cwd`. The pre-tool-use
 * warning state goes to a fresh directory per call (never the real
 * temporary directory), so no run is rate limited by another.
 */
function hook(
  argv: readonly string[],
  cwd: string,
  options: Partial<Omit<HookRequest, 'argv' | 'cwd'>> = {},
): HookOutcome {
  return runHook({
    argv,
    cwd,
    payload: options.payload ?? '',
    env: options.env ?? hookEnv(),
    stateDir: options.stateDir ?? tempDir(),
    ...options,
  });
}

/** A Claude Code PreToolUse payload writing `file` from `cwd`. */
function editPayload(cwd: string, file: string, tool = 'Write'): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { file_path: file, content: 'x' },
  });
}

/** A Claude Code Stop payload. */
function stopPayload(cwd: string, active = false): string {
  return JSON.stringify({
    session_id: 'session-1',
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: active,
  });
}

/** A Claude Code SessionStart payload. */
function startPayload(cwd: string): string {
  return JSON.stringify({
    session_id: 'session-1',
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
}

/**
 * Token-shaped names a hook never accepts as an actor (a secret pattern,
 * or outside the actor form); `TOKEN_FIXTURES` also holds words that have
 * the actor form, which are valid actors and may be named in an answer.
 */
const NOT_ACTORS: readonly string[] = [
  GITHUB_TOKEN,
  AWS_KEY_ID,
  HEX_40,
  HEX_64,
  URL_WITH_CREDENTIALS,
  LONG_WORD,
];

const SILENT: HookOutcome = { exitCode: 0, stdout: '', stderr: '' };

/** Asserts the outcome continues with nothing on stdout and at most one stderr line. */
function expectFailOpen(out: HookOutcome): void {
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toBe('');
  expect(out.stderr === '' || /^[^\n]*\n$/.test(out.stderr), out.stderr).toBe(true);
}

/** Asserts the argument-error answer: exit 0, no stdout, one line naming the three events. */
function expectArgumentLine(out: HookOutcome): void {
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toBe('');
  expect(out.stderr).toMatch(/^[^\n]*\n$/);
  for (const event of ['session-start', 'stop', 'pre-tool-use']) {
    expect(out.stderr).toContain(event);
  }
}

/** The no-actor answer of session-start: one JSON document whose context is one line. */
function noActorContext(out: HookOutcome): string {
  expect(out.exitCode).toBe(0);
  expect(out.stderr).toBe('');
  const doc = oneJson({ code: 0, stdout: out.stdout, stderr: '' }) as {
    hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown };
  };
  expect(Object.keys(doc)).toEqual(['hookSpecificOutput']);
  expect(doc.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  const text = doc.hookSpecificOutput?.additionalContext;
  expect(typeof text).toBe('string');
  const line = String(text).replace(/\n$/, '');
  expect(line).not.toContain('\n');
  expect(line).toContain('AGENTBOARD_ACTOR');
  expect(line).toContain('--as');
  return line;
}

/** Every file under `dir` (recursively) with its bytes, as `path -> base64`. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (sub: string): void => {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      const rel = sub === '' ? name : `${sub}/${name}`;
      if (statSync(join(dir, rel)).isDirectory()) {
        walk(rel);
      } else {
        out[rel] = readFileSync(join(dir, rel)).toString('base64');
      }
    }
  };
  walk('');
  return out;
}

/** A board with T1 claimed by `impl` and never handed off, its cache built. */
function claimedBoard(): { root: string; boardDir: string } {
  const { root, boardDir } = project();
  const created = run(['new', 'Held work', '--adhoc', 'hook test', '--as', 'orch', '--json'], root);
  expect(created.code, created.stderr).toBe(0);
  const id = (oneJson(created) as { ticket: { id: string } }).ticket.id;
  expect(run(['claim', id, '--as', 'impl'], root).code).toBe(0);
  return { root, boardDir };
}

describe('escape hatch: AGENTBOARD_HOOKS=off', () => {
  it('scenario: stop --strict with a claimed, un-handed-off ticket exits 0 and prints nothing', () => {
    const { root } = claimedBoard();
    const out = hook(['stop', '--strict', '--as', 'impl'], root, {
      payload: stopPayload(root),
      env: hookEnv({ AGENTBOARD_HOOKS: 'off' }),
    });
    expect(out).toEqual(SILENT);
  });

  it('every event, with or without --strict, and even a refused argument, is silent', () => {
    const { root } = claimedBoard();
    const env = hookEnv({ AGENTBOARD_HOOKS: 'off', AGENTBOARD_ACTOR: 'someone-else' });
    for (const argv of [
      ['session-start'],
      ['stop'],
      ['stop', '--strict'],
      ['pre-tool-use', '--strict'],
      [GITHUB_TOKEN],
      [],
    ]) {
      expect(
        hook(argv, root, { payload: editPayload(root, join(root, 'a.ts')), env }),
        argv.join(' '),
      ).toEqual(SILENT);
    }
  });

  it('is silent where there is no board and with garbage on stdin', () => {
    const out = hook(['session-start'], tempDir(), {
      payload: 'not json',
      env: hookEnv({ AGENTBOARD_HOOKS: 'off' }),
    });
    expect(out).toEqual(SILENT);
  });

  it('only the exact value off disables the hooks', () => {
    const { root } = project();
    for (const value of ['on', '0', 'false', 'OFF', 'Off', '', ' off']) {
      const out = hook(['session-start'], root, {
        payload: startPayload(root),
        env: hookEnv({ AGENTBOARD_HOOKS: value }),
      });
      noActorContext(out);
    }
  });
});

describe('arguments: an error is answered with exit 0 and one line naming the events', () => {
  it.each([
    ['no event', []],
    ['an unknown event', ['frobnicate']],
    ['a hook name of another harness', ['PreToolUse']],
    ['an extra positional', ['stop', 'extra']],
    ['two events', ['stop', 'session-start']],
    ['an unknown flag', ['stop', '--frobnicate']],
    ['a missing --as value', ['stop', '--as']],
  ])('%s', (_label, argv) => {
    const { root } = claimedBoard();
    expectArgumentLine(hook(argv, root, { payload: stopPayload(root) }));
  });

  it('scenario: an unknown token-shaped event is not repeated, with and without --json', () => {
    const { root } = claimedBoard();
    for (const f of TOKEN_FIXTURES) {
      for (const argv of [
        [f.value],
        [f.value, '--json'],
        ['--json', f.value],
        [f.value, '--strict'],
      ]) {
        const out = hook(argv, root, {
          payload: stopPayload(root),
          env: hookEnv({ AGENTBOARD_ACTOR: 'impl' }),
        });
        expectArgumentLine(out);
        expectNoLeak(`hook ${f.name}`, [out.stdout, out.stderr]);
      }
    }
  });

  it('an unknown token-shaped flag or extra word is not repeated', () => {
    const { root } = claimedBoard();
    for (const f of TOKEN_FIXTURES) {
      for (const argv of [
        ['stop', `--${f.value}`],
        ['pre-tool-use', f.value],
        ['stop', `--strict=${f.value}`],
      ]) {
        const out = hook(argv, root, { payload: stopPayload(root) });
        expectArgumentLine(out);
        expectNoLeak(`hook ${f.name}`, [out.stdout, out.stderr]);
      }
    }
  });

  it('--json is accepted and changes nothing: the answer is the hook protocol', () => {
    const { root } = project();
    const plain = hook(['session-start'], root, { payload: startPayload(root) });
    const json = hook(['session-start', '--json'], root, { payload: startPayload(root) });
    noActorContext(plain);
    expect(json).toEqual(plain);
  });
});

describe('payload: anything that is not a JSON object is {}', () => {
  it.each([
    ['not json', 'not json'],
    ['empty', ''],
    ['an array', '[1,2,3]'],
    ['null', 'null'],
    ['a string', '"Stop"'],
    ['an object with odd fields', '{"cwd": 5, "tool_name": ["Edit"], "stop_hook_active": "yes"}'],
  ])('scenario: garbage payload (%s) to stop exits 0', (_label, payload) => {
    const { root } = claimedBoard();
    for (const argv of [['stop'], ['stop', '--strict'], ['pre-tool-use'], ['session-start']]) {
      const out = hook(argv, root, { payload, env: hookEnv({ AGENTBOARD_ACTOR: 'nobody' }) });
      expect(out.exitCode, argv.join(' ')).toBe(0);
      expect(out.stderr === '' || /^[^\n]*\n$/.test(out.stderr)).toBe(true);
    }
  });

  it('a payload holding a token is never repeated in any answer', () => {
    const { root } = claimedBoard();
    const payload = `{"cwd": ${JSON.stringify(root)}, "tool_name": "${GITHUB_TOKEN}", "prompt": "${GITHUB_TOKEN}"`;
    for (const argv of [['stop'], ['pre-tool-use', '--strict'], ['session-start'], ['nope']]) {
      const out = hook(argv, root, { payload, env: hookEnv({ AGENTBOARD_ACTOR: 'impl' }) });
      expect(out.exitCode).toBe(0);
      expectNoLeak(`hook ${argv.join(' ')}`, [out.stdout, out.stderr]);
    }
  });
});

describe('no board', () => {
  it('scenario: pre-tool-use --strict where there is no board exits 0 and prints nothing to stdout', () => {
    const dir = tempDir();
    for (const actor of [undefined, 'impl']) {
      const out = hook(['pre-tool-use', '--strict'], dir, {
        payload: editPayload(dir, join(dir, 'a.ts')),
        env: hookEnv({ AGENTBOARD_ACTOR: actor }),
      });
      expectFailOpen(out);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('board-cli scenario: stop where discovery finds no board exits 0, not 2, for every event and mode', () => {
    const dir = tempDir();
    for (const argv of [
      ['stop'],
      ['stop', '--strict'],
      ['session-start'],
      ['pre-tool-use', '--strict'],
    ]) {
      const out = hook([...argv, '--as', 'impl'], dir, { payload: stopPayload(dir, false) });
      expectFailOpen(out);
    }
  });

  it('session-start without an actor where there is no board prints nothing', () => {
    const dir = tempDir();
    expect(hook(['session-start'], dir, { payload: startPayload(dir) }).stdout).toBe('');
  });
});

describe('scenario: unresolvable actor at session start', () => {
  it('prints one line naming AGENTBOARD_ACTOR and --as, as SessionStart context', () => {
    const { root } = claimedBoard();
    noActorContext(hook(['session-start'], root, { payload: startPayload(root) }));
  });

  it('needs a board but not a readable cache', () => {
    const root = tempDir();
    const boardDir = makeBoardDir(root);
    putEvent(join(boardDir, 'events'), ev(P.create(T1), 'orch', 1000));
    noActorContext(hook(['session-start'], root, { payload: startPayload(root) }));
    expect(readdirSync(boardDir)).toEqual(['events']);
  });

  it('never takes the actor from the payload or the OS user', () => {
    const { root } = claimedBoard();
    const payload = JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'SessionStart',
      actor: 'impl',
      agent: 'impl',
      agent_id: 'impl',
      user: 'impl',
    });
    const out = hook(['session-start'], root, {
      payload,
      env: hookEnv({ USER: 'impl', LOGNAME: 'impl', USERNAME: 'impl' }),
    });
    expect(noActorContext(out)).not.toMatch(/\bimpl\b/);
  });

  it('treats a token or the reserved actor as no actor, and never repeats it', () => {
    const { root } = claimedBoard();
    for (const token of NOT_ACTORS) {
      const fromFlag = hook(['session-start', '--as', token], root, {
        payload: startPayload(root),
      });
      const fromEnv = hook(['session-start'], root, {
        payload: startPayload(root),
        env: hookEnv({ AGENTBOARD_ACTOR: token }),
      });
      for (const out of [fromFlag, fromEnv]) {
        noActorContext(out);
        expectNoLeak('session-start with a token as the actor', [out.stdout, out.stderr]);
      }
    }
    noActorContext(
      hook(['session-start', '--as', 'agentboard'], root, { payload: startPayload(root) }),
    );
  });
});

describe('scenario: unresolvable actor elsewhere', () => {
  it('pre-tool-use --strict with no actor exits 0 and prints nothing, on a board where it could block', () => {
    const { root } = claimedBoard();
    const out = hook(['pre-tool-use', '--strict'], root, {
      payload: editPayload(root, join(root, 'src', 'a.ts')),
    });
    expect(out).toEqual(SILENT);
  });

  it('stop --strict with no actor exits 0 and prints nothing, while impl holds an un-handed-off ticket', () => {
    const { root } = claimedBoard();
    expect(hook(['stop', '--strict'], root, { payload: stopPayload(root) })).toEqual(SILENT);
    for (const token of NOT_ACTORS) {
      expect(
        hook(['stop', '--strict', '--as', token], root, { payload: stopPayload(root) }),
      ).toEqual(SILENT);
      expect(
        hook(['pre-tool-use', '--strict'], root, {
          payload: editPayload(root, join(root, 'src', 'a.ts')),
          env: hookEnv({ AGENTBOARD_ACTOR: token }),
        }),
      ).toEqual(SILENT);
    }
  });
});

describe('scenario: cache of another schema version', () => {
  it('pre-tool-use --strict exits 0 without blocking, and the cache is byte-identical afterwards', () => {
    const boardDir = fixtureBoard('plain');
    const root = join(boardDir, '..');
    const cache = join(boardDir, 'cache.sqlite');
    const before = cacheHashes(cache);
    const files = tree(boardDir);
    // nobody holds nothing, so a hook that read the events instead (or
    // recreated the cache and caught up) would deny this edit in strict mode.
    for (const argv of [
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      ['stop', '--strict', '--as', 'nobody'],
      ['session-start', '--as', 'nobody'],
    ]) {
      const out = hook(argv, root, { payload: editPayload(root, join(root, 'src', 'a.ts')) });
      expectFailOpen(out);
    }
    expect(cacheHashes(cache)).toEqual(before);
    expect(tree(boardDir)).toEqual(files);
  });

  it('a missing cache counts as unreadable and is not created', () => {
    const root = tempDir();
    const boardDir = makeBoardDir(root);
    putEvent(join(boardDir, 'events'), ev(P.create(T1), 'orch', 1000));
    putEvent(join(boardDir, 'events'), ev(P.claim(T1), 'impl', 2000));
    const files = tree(boardDir);
    for (const argv of [
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      ['stop', '--strict', '--as', 'impl'],
      ['session-start', '--as', 'impl'],
    ]) {
      expectFailOpen(hook(argv, root, { payload: editPayload(root, join(root, 'a.ts')) }));
    }
    expect(tree(boardDir)).toEqual(files);
  });

  it('a cache file that is not a database counts as unreadable and is left unchanged', () => {
    const { root, boardDir } = claimedBoard();
    const cache = join(boardDir, 'cache.sqlite');
    writeFileSync(cache, 'garbage, not SQLite\n');
    const files = tree(boardDir);
    for (const argv of [
      ['pre-tool-use', '--strict', '--as', 'nobody'],
      ['stop', '--strict', '--as', 'impl'],
      ['session-start', '--as', 'impl'],
    ]) {
      expectFailOpen(hook(argv, root, { payload: editPayload(root, join(root, 'a.ts')) }));
    }
    expect(tree(boardDir)).toEqual(files);
  });
});

/**
 * The grant-catchup seed (src/cli/__tests__/grant-catchup-cli.test.ts):
 * merger-1 claimed T1 at 2000, merger-2 joined at 3000 asking for 600000,
 * merger-1 released at 5000; impl claimed T2 at 4000 and never commented.
 * `list` at 5000 builds the cache with everything folded; the grant to
 * merger-2 is due at 5001 and not written.
 */
function dueGrantBoard(): { root: string; boardDir: string; events: string; grant: string } {
  const { root, boardDir } = project();
  const events = join(boardDir, 'events');
  putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
  putEvent(events, ev(P.create(T2, 'Work'), 'orch', 1000, 1));
  putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
  putEvent(
    events,
    ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
  );
  putEvent(events, ev(P.claim(T2), 'impl', 4000));
  const release = putEvent(
    events,
    ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', 5000),
  );
  const g: TicketGrantEvent = {
    v: 1,
    kind: 'ticket.grant',
    ticket: T1,
    actor: 'agentboard',
    ts: { wall: 5001, counter: 0, actor: 'agentboard' },
    body: { to: 'merger-2', ttl: 600_000, window: 120_000, after: { released: release } },
  };
  vi.setSystemTime(5000);
  const listed = run(['list', '--json'], root, cliEnv());
  expect(listed.code, listed.stderr).toBe(0);
  expect(eventNames(events)).not.toContain(`${canonicalHash(g)}.json`);
  return { root, boardDir, events, grant: `${canonicalHash(g)}.json` };
}

/** The derived tables of the cache, read without modifying it. */
function cacheDump(boardDir: string): string {
  const db = openCache(join(boardDir, 'cache.sqlite'), { prepare: false });
  try {
    return dumpCache(db);
  } finally {
    db.close();
  }
}

describe('read-only', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scenario: pre-tool-use and stop leave the event files, cache and cursors byte-identical, with a grant due', () => {
    const { root, boardDir, events, grant } = dueGrantBoard();
    // Give merger-2 and impl stored cursors, so a cursor write would show.
    vi.setSystemTime(5000);
    for (const actor of ['merger-2', 'impl']) {
      expect(run(['inbox', '--as', actor, '--json'], root, cliEnv()).code).toBe(0);
    }
    const files = tree(boardDir);
    const hashes = cacheHashes(join(boardDir, 'cache.sqlite'));
    vi.setSystemTime(60_000);
    for (const actor of ['merger-2', 'merger-1', 'impl', 'nobody']) {
      for (const argv of [
        ['pre-tool-use'],
        ['pre-tool-use', '--strict'],
        ['stop'],
        ['stop', '--strict'],
      ]) {
        const payload =
          argv[0] === 'stop' ? stopPayload(root) : editPayload(root, join(root, 'src', 'a.ts'));
        const out = hook([...argv, '--as', actor], root, { payload });
        expect([0, 2], `${argv.join(' ')} ${actor}`).toContain(out.exitCode);
      }
    }
    expect(tree(boardDir)).toEqual(files);
    expect(cacheHashes(join(boardDir, 'cache.sqlite'))).toEqual(hashes);
    expect(eventNames(events)).not.toContain(grant);
  });

  it('board-cli scenario: hook writes no due grant; the next inbox writes it and returns it', () => {
    const { root, boardDir, events, grant } = dueGrantBoard();
    const names = tree(events);
    const derived = cacheDump(boardDir);
    vi.setSystemTime(5001);
    const out = hook(['session-start', '--as', 'merger-2'], root, { payload: startPayload(root) });
    expect(out.exitCode).toBe(0);
    vi.setSystemTime(6000);
    hook(['session-start', '--as', 'merger-2'], root, { payload: startPayload(root) });
    // The event files are byte-identical; so is everything the cache derives
    // from them (only the inbox cursor may change in session-start).
    expect(tree(events)).toEqual(names);
    expect(eventNames(events)).not.toContain(grant);
    expect(cacheDump(boardDir)).toBe(derived);
    vi.setSystemTime(7000);
    const inbox = run(['inbox', '--as', 'merger-2', '--json'], root, cliEnv());
    expect(inbox.code, inbox.stderr).toBe(0);
    expect(eventNames(events)).toContain(grant);
    const doc = oneJson(inbox) as { entries: { hash: string; kind: string }[] };
    expect(doc.entries.filter((e) => `${e.hash}.json` === grant)).toEqual([
      expect.objectContaining({ kind: 'ticket.grant' }),
    ]);
  });
});

describe('scenario: worktree', () => {
  it("finds the board from the payload's cwd in a linked worktree, and answers as in the main checkout", () => {
    const base = tempDir();
    const main = gitRepo(join(base, 'project'));
    makeBoardDir(main);
    const created = run(['new', 'Work', '--adhoc', 'hook test', '--as', 'orch', '--json'], main);
    expect(created.code, created.stderr).toBe(0);
    const id = (oneJson(created) as { ticket: { id: string } }).ticket.id;
    expect(run(['claim', id, '--as', 'impl'], main).code).toBe(0);
    const wt = join(base, 'project.worktrees', 'feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const elsewhere = tempDir();

    // No actor: session-start speaks only where a board is found, so the
    // line proves discovery through the payload's cwd, from a process
    // directory with no board.
    noActorContext(hook(['session-start'], elsewhere, { payload: startPayload(wt) }));
    expect(hook(['session-start'], elsewhere, { payload: startPayload(elsewhere) }).stdout).toBe(
      '',
    );

    // With an actor, stop and pre-tool-use (strict, which is not rate
    // limited) answer from the worktree exactly as from the main checkout;
    // session-start advances the cursor, so only its exit code is compared.
    const payloadFor = (event: string, cwd: string): string =>
      event === 'stop'
        ? stopPayload(cwd)
        : event === 'session-start'
          ? startPayload(cwd)
          : editPayload(cwd, join(cwd, 'src', 'a.ts'));
    for (const event of ['session-start', 'stop', 'pre-tool-use']) {
      for (const actor of ['impl', 'nobody']) {
        const argv = [event, '--strict', '--as', actor];
        const fromMain = hook(argv, elsewhere, { payload: payloadFor(event, main) });
        const fromWorktree = hook(argv, elsewhere, { payload: payloadFor(event, wt) });
        if (event === 'session-start') {
          expect(fromWorktree.exitCode).toBe(fromMain.exitCode);
        } else {
          expect(fromWorktree, `${event} ${actor}`).toEqual(fromMain);
        }
      }
    }
  });

  it("falls back to the process directory when the payload's cwd is not a directory", () => {
    const { root } = claimedBoard();
    for (const cwd of [5, '', join(root, 'no-such-dir'), null]) {
      const payload = JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', cwd });
      noActorContext(hook(['session-start'], root, { payload }));
    }
  });
});

describe('fail open on internal errors', () => {
  it('never throws, whatever the request', () => {
    const { root } = claimedBoard();
    const odd: HookRequest[] = [
      {
        argv: ['stop'],
        cwd: join(root, 'missing'),
        payload: '{}',
        env: hookEnv({ AGENTBOARD_ACTOR: 'impl' }),
      },
      {
        argv: ['pre-tool-use'],
        cwd: root,
        payload: '{"tool_input": null, "tool_name": "Edit"}',
        env: hookEnv({ AGENTBOARD_ACTOR: 'impl' }),
      },
      {
        argv: ['stop', '--strict'],
        cwd: root,
        payload: '{"stop_hook_active": true}',
        env: hookEnv({ AGENTBOARD_ACTOR: 'impl', AGENTBOARD_DIR: '/dev/null' }),
      },
    ];
    for (const request of odd) {
      expect(runHook(request).exitCode).toBe(0);
    }
  });
});

describe('no stderr line names the payload cwd or the actor', () => {
  /**
   * A project whose root directory is named by a token, so a line that
   * repeated the payload's cwd would repeat the token, in one of the
   * board states that make a hook print a line.
   */
  function tokenProject(state: 'no board' | 'no cache' | 'garbage cache' | 'older cache'): string {
    const root = join(tempDir(), GITHUB_TOKEN);
    mkdirSync(root);
    if (state === 'no board') {
      return root;
    }
    const boardDir = makeBoardDir(root);
    if (state === 'older cache') {
      cpSync(join(V020_FIXTURES, 'plain', 'events'), join(boardDir, 'events'), { recursive: true });
      cpSync(join(V020_FIXTURES, 'plain', 'cache.sqlite'), join(boardDir, 'cache.sqlite'));
      return root;
    }
    putEvent(join(boardDir, 'events'), ev(P.create(T1), 'orch', 1000));
    putEvent(join(boardDir, 'events'), ev(P.claim(T1), CROCKFORD_26, 2000));
    if (state === 'garbage cache') {
      writeFileSync(join(boardDir, 'cache.sqlite'), 'not SQLite\n');
    }
    return root;
  }

  it.each(['no board', 'no cache', 'garbage cache', 'older cache'] as const)(
    '%s: a token-shaped payload and actor appear on no stderr line',
    (state) => {
      const root = tokenProject(state);
      const elsewhere = tempDir();
      const payload = JSON.stringify({
        session_id: HEX_64,
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(root, HEX_64), content: HEX_64 },
        stop_hook_active: false,
      });
      for (const argv of [
        ['pre-tool-use', '--strict', '--as', CROCKFORD_26],
        ['pre-tool-use', '--as', CROCKFORD_26],
        ['stop', '--strict', '--as', CROCKFORD_26],
        ['session-start', '--as', CROCKFORD_26],
      ]) {
        for (const env of [hookEnv(), hookEnv({ AGENTBOARD_ACTOR: CROCKFORD_26 })]) {
          const out = hook(argv, elsewhere, { payload, env });
          expect(out.exitCode, `${state} ${argv.join(' ')}`).toBe(0);
          for (const word of [GITHUB_TOKEN, HEX_64, CROCKFORD_26, root]) {
            expect(out.stderr, `${state} ${argv.join(' ')}`).not.toContain(word);
          }
        }
      }
    },
  );
});
