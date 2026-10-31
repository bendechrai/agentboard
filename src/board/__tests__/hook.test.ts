/**
 * The hook module's building blocks (add-harness-integration task 1.1;
 * board-harness-hooks "Hook command and protocol", "Hook actor
 * resolution"; design.md decisions 3 and 11, "Re-sync with the main
 * specs"): the payload parser, actor resolution, the tickets an actor
 * holds, the read-only view of the board, the executable's routing test
 * and the stdin reader.
 *
 * In process. Board states are built through the library operations with
 * the clock injected through vitest fake timers (`Date` only), so lease
 * states and due grants are exact. The locked-cache budget is in
 * src/__tests__/hook-processes.test.ts.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { BoardState } from '../../events/fold.js';
import type { TicketGrantEvent } from '../../events/schema.js';
import { openBoard } from '../../store/board.js';
import { catchUp, readState } from '../../store/cache.js';
import { ev, eventNames, P, putEvent, T1, T2 } from '../../store/__tests__/helpers.js';
import { cacheHashes, fixtureBoard } from '../../store/__tests__/v020-cache.js';
import {
  AWS_KEY_ID,
  GITHUB_TOKEN,
  HEX_40,
  HEX_64,
  LONG_WORD,
  URL_WITH_CREDENTIALS,
} from '../../__tests__/harness/secret-fixtures.js';
import { claimTicket, closeTicket, releaseTicket } from '../actions.js';
import {
  HOOK_BUDGET_MS,
  HOOK_EVENTS,
  HOOKS_ENV,
  heldTickets,
  isHookInvocation,
  parseHookPayload,
  readHookStdin,
  readHookView,
  resolveHookActor,
  type HookInput,
} from '../hook.js';
import { leaseState } from '../leases.js';
import {
  cleanEnv,
  create,
  git,
  gitRepo,
  handoff,
  heldTicket,
  makeBoardDir,
  setup,
  tempDir,
} from './helpers.js';

/** A non-ASCII letter, built at run time so the source stays ASCII. */
const E_ACUTE = String.fromCharCode(0xe9);

/** The base clock of the lease tests. */
const T = 1_000_000_000;

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

/** The environment of a hook: clean git, no board override, no actor. */
function hookEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return cleanEnv({ AGENTBOARD_ACTOR: undefined, AGENTBOARD_DIR: undefined, ...extra });
}

describe('constants', () => {
  it('names the three events in order, a 2 second budget and the escape hatch variable', () => {
    expect(HOOK_EVENTS).toEqual(['session-start', 'stop', 'pre-tool-use']);
    expect(HOOK_BUDGET_MS).toBe(2000);
    expect(HOOKS_ENV).toBe('AGENTBOARD_HOOKS');
  });
});

describe('parseHookPayload', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '  \n'],
    ['not json', 'not json'],
    ['truncated json', '{"tool_name": "Edit"'],
    ['an array', '[1, 2]'],
    ['null', 'null'],
    ['a string', '"stop"'],
    ['a number', '42'],
    ['a boolean', 'true'],
  ])('treats %s as {}', (_label, text) => {
    expect(parseHookPayload(text)).toEqual({});
  });

  it('returns the object of a JSON object payload, trailing newline included', () => {
    const payload = {
      session_id: 's1',
      cwd: '/tmp/x',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x/a.ts' },
    };
    expect(parseHookPayload(`${JSON.stringify(payload)}\n`)).toEqual(payload);
  });
});

describe('resolveHookActor', () => {
  it('takes --as first, then AGENTBOARD_ACTOR, and null without either', () => {
    expect(resolveHookActor('impl', { AGENTBOARD_ACTOR: 'other' })).toBe('impl');
    expect(resolveHookActor(undefined, { AGENTBOARD_ACTOR: 'impl' })).toBe('impl');
    expect(resolveHookActor('', { AGENTBOARD_ACTOR: 'impl' })).toBe('impl');
    expect(resolveHookActor(undefined, {})).toBeNull();
    expect(resolveHookActor('', { AGENTBOARD_ACTOR: '' })).toBeNull();
  });

  it('never takes the OS user', () => {
    expect(
      resolveHookActor(undefined, { USER: 'ben', LOGNAME: 'ben', USERNAME: 'ben' }),
    ).toBeNull();
  });

  it('accepts the actor styles in use', () => {
    for (const name of [
      'orch',
      'impl-1',
      'reviewer-3-2',
      'merger-2',
      'ben',
      'a.b_c@d',
      'x'.repeat(32),
    ]) {
      expect(resolveHookActor(name, {}), name).toBe(name);
      expect(resolveHookActor(undefined, { AGENTBOARD_ACTOR: name }), name).toBe(name);
    }
  });

  it('treats the reserved actor as no actor', () => {
    expect(resolveHookActor('agentboard', {})).toBeNull();
    expect(resolveHookActor(undefined, { AGENTBOARD_ACTOR: 'agentboard' })).toBeNull();
  });

  it('treats a secret-like or token-shaped name as no actor, from --as and from the environment', () => {
    for (const token of [
      GITHUB_TOKEN,
      AWS_KEY_ID,
      HEX_40,
      HEX_64,
      URL_WITH_CREDENTIALS,
      LONG_WORD,
    ]) {
      expect(resolveHookActor(token, {})).toBeNull();
      expect(resolveHookActor(undefined, { AGENTBOARD_ACTOR: token })).toBeNull();
    }
  });

  it('treats a name outside the actor form as no actor', () => {
    for (const name of [
      'has space',
      'a/b',
      '-lead',
      '.lead',
      'x'.repeat(33),
      `caf${E_ACUTE}`,
      'a\nb',
    ]) {
      expect(resolveHookActor(name, {}), JSON.stringify(name)).toBeNull();
    }
  });
});

describe('heldTickets', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is every open ticket the actor is the assignee of, in id order', () => {
    const { board } = setup();
    const a = heldTicket(board, 'implementing', 'impl');
    const b = heldTicket(board, 'tests', 'other');
    const c = heldTicket(board, 'review', 'impl');
    const state = readState(board.db);
    expect(heldTickets(state, 'impl').map((t) => t.id)).toEqual([a.id, c.id].sort());
    expect(heldTickets(state, 'other').map((t) => t.id)).toEqual([b.id]);
    expect(heldTickets(state, 'nobody')).toEqual([]);
  });

  it('includes a ticket that became the actor by a hand-off', () => {
    const { board } = setup();
    const t = heldTicket(board, 'tests', 'author');
    handoff(board, 'author', t.id, 'impl', 'implementing');
    const state = readState(board.db);
    expect(heldTickets(state, 'impl').map((x) => x.id)).toEqual([t.id]);
    expect(heldTickets(state, 'author')).toEqual([]);
  });

  it('leaves out a closed ticket whose assignee is the actor', () => {
    const { board } = setup();
    const t = heldTicket(board, 'merged', 'impl');
    closeTicket(board, 'orch', { id: t.id, noDecision: true });
    const state = readState(board.db);
    expect(state.tickets[t.id]).toMatchObject({ closed: true, assignee: 'impl' });
    expect(heldTickets(state, 'impl')).toEqual([]);
  });

  it('a lapsed lease is still held, live, expired and claimable alike', () => {
    const { board } = setup();
    const id = create(board, { title: 'Merge lock', adhoc: 'merge lock' }).id;
    claimTicket(board, 'merger-1', { id, ttl: 60_000 });
    const seen: string[] = [];
    // Live, then past the ttl (expired, within the grace), then past the
    // grace (claimable): the default grace is 2 minutes.
    for (const at of [T + 30_000, T + 90_000, T + 600_000]) {
      vi.setSystemTime(at);
      const state = readState(board.db);
      const ticket = state.tickets[id];
      expect(ticket?.lease).not.toBeNull();
      seen.push(leaseState(ticket?.lease ?? never(), at));
      expect(
        heldTickets(state, 'merger-1').map((t) => t.id),
        String(at),
      ).toEqual([id]);
    }
    expect(seen).toEqual(['live', 'expired', 'claimable']);
  });

  it('being queued is not holding', () => {
    const { board } = setup();
    const id = create(board, { title: 'Merge lock', adhoc: 'merge lock' }).id;
    claimTicket(board, 'merger-1', { id, ttl: 1_800_000 });
    vi.setSystemTime(T + 1000);
    expect(claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true })).toMatchObject({
      queued: true,
    });
    const state = readState(board.db);
    expect(state.tickets[id]?.queue.map((w) => w.actor)).toEqual(['merger-2']);
    expect(heldTickets(state, 'merger-2')).toEqual([]);
    expect(heldTickets(state, 'merger-1').map((t) => t.id)).toEqual([id]);
  });

  it('a grant that is due but not written makes no one the holder; once written, the grantee holds', () => {
    const { board } = setup();
    const id = create(board, { title: 'Merge lock', adhoc: 'merge lock' }).id;
    claimTicket(board, 'merger-1', { id });
    vi.setSystemTime(T + 1000);
    claimTicket(board, 'merger-2', { id, ttl: 600_000, wait: true });
    vi.setSystemTime(T + 2000);
    releaseTicket(board, 'merger-1', { id });
    // The grant to merger-2 is due at T + 2001; nothing has caught up.
    vi.setSystemTime(T + 5000);
    const before = readState(board.db);
    expect(heldTickets(before, 'merger-2')).toEqual([]);
    expect(heldTickets(before, 'merger-1')).toEqual([]);
    catchUp(board);
    expect(heldTickets(readState(board.db), 'merger-2').map((t) => t.id)).toEqual([id]);
  });

  it('is pure: the state is not modified', () => {
    const { board } = setup();
    heldTicket(board, 'implementing', 'impl');
    const state = readState(board.db);
    const copy = structuredClone(state) as BoardState;
    heldTickets(state, 'impl');
    expect(state).toEqual(copy);
  });
});

function never(): never {
  throw new Error('unreachable');
}

describe('readHookView', () => {
  const deadline = (): number => Date.now() + 60_000;

  it('returns null where there is no board, creating nothing', () => {
    const dir = tempDir();
    expect(readHookView({ cwd: dir, env: hookEnv(), deadline: deadline() })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns null for a board with no cache, and does not create one', () => {
    const root = tempDir();
    const boardDir = makeBoardDir(root);
    putEvent(join(boardDir, 'events'), ev(P.create(T1), 'orch', 1000));
    const before = tree(boardDir);
    expect(readHookView({ cwd: root, env: hookEnv(), deadline: deadline() })).toBeNull();
    expect(tree(boardDir)).toEqual(before);
  });

  it('returns null for a cache of an earlier schema version, leaving it byte-identical', () => {
    const boardDir = fixtureBoard('plain');
    const cache = join(boardDir, 'cache.sqlite');
    const before = cacheHashes(cache);
    const names = eventNames(join(boardDir, 'events'));
    expect(
      readHookView({ cwd: resolve(boardDir, '..'), env: hookEnv(), deadline: deadline() }),
    ).toBeNull();
    expect(cacheHashes(cache)).toEqual(before);
    expect(eventNames(join(boardDir, 'events'))).toEqual(names);
  });

  it('returns null for a cache file that is not a database, leaving it unchanged', () => {
    const { board, root } = setup();
    create(board);
    board.close();
    const cache = join(root, '.board', 'cache.sqlite');
    writeFileSync(cache, 'not a database at all, just text\n');
    const before = cacheHashes(cache);
    expect(readHookView({ cwd: root, env: hookEnv(), deadline: deadline() })).toBeNull();
    expect(cacheHashes(cache)).toEqual(before);
  });

  it('reads the state the cache holds, without catching up or writing, and leaves no connection open', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // merger-1 claimed T1, merger-2 joined and merger-1 released at 5000,
      // folded into the cache at 5000; the grant is due at 5001.
      const root = tempDir();
      const boardDir = makeBoardDir(root);
      const events = join(boardDir, 'events');
      putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
      putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
      putEvent(
        events,
        ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
      );
      const release = putEvent(
        events,
        ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', 5000),
      );
      putEvent(events, ev(P.create(T2, 'Other'), 'orch', 5000, 1));
      vi.setSystemTime(5000);
      openBoard(boardDir).close();
      const grant: TicketGrantEvent = {
        v: 1,
        kind: 'ticket.grant',
        ticket: T1,
        actor: 'agentboard',
        ts: { wall: 5001, counter: 0, actor: 'agentboard' },
        body: { to: 'merger-2', ttl: 600_000, window: 120_000, after: { released: release } },
      };
      vi.setSystemTime(10_000);
      const before = tree(boardDir);
      const view = readHookView({
        cwd: root,
        env: hookEnv(),
        deadline: Date.now() + 60_000,
      });
      expect(view).not.toBeNull();
      expect(view?.boardDir).toBe(resolve(boardDir));
      expect(Object.keys(view?.state.tickets ?? {}).sort()).toEqual([T1, T2].sort());
      expect(view?.state.tickets[T1]).toMatchObject({ assignee: null });
      expect(heldTickets(view?.state ?? never(), 'merger-2')).toEqual([]);
      expect(tree(boardDir)).toEqual(before);
      expect(eventNames(events)).not.toContain(`${canonicalHash(grant)}.json`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the main checkout board from a linked worktree, and from a subdirectory', () => {
    const base = tempDir();
    const main = gitRepo(join(base, 'project'));
    const boardDir = makeBoardDir(main);
    const opened = openBoard(boardDir);
    create(opened, { title: 'Seen from the worktree' });
    opened.close();
    const wt = join(base, 'project.worktrees', 'feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const env = hookEnv();
    const fromMain = readHookView({ cwd: main, env, deadline: deadline() });
    const fromWorktree = readHookView({ cwd: wt, env, deadline: deadline() });
    expect(fromMain).not.toBeNull();
    expect(fromWorktree?.boardDir).toBe(fromMain?.boardDir);
    expect(fromWorktree?.state).toEqual(fromMain?.state);
    expect(Object.values(fromWorktree?.state.tickets ?? {}).map((t) => t.title)).toEqual([
      'Seen from the worktree',
    ]);
  });

  it('honours AGENTBOARD_DIR, the usual first discovery rule', () => {
    const { board, root } = setup();
    create(board);
    board.close();
    const elsewhere = tempDir();
    const view = readHookView({
      cwd: elsewhere,
      env: hookEnv({ AGENTBOARD_DIR: join(root, '.board') }),
      deadline: deadline(),
    });
    expect(view?.boardDir).toBe(resolve(root, '.board'));
  });
});

describe('isHookInvocation', () => {
  it.each([
    [['hook', 'stop'], true],
    [['hook', 'pre-tool-use', '--strict'], true],
    [['hook'], true],
    [['hook', 'nope'], true],
    [['hook', 'stop', '--', '--help'], true],
    [['hook', '--help'], false],
    [['hook', 'stop', '-h'], false],
    [['hook', 'session-start', '--help'], false],
    [['help', 'hook'], false],
    [['stop'], false],
    [['claim', 'hook'], false],
    [[], false],
  ])('%j is %s', (argv, expected) => {
    expect(isHookInvocation(argv)).toBe(expected);
  });
});

describe('readHookStdin', () => {
  it('reads the whole input as UTF-8, across chunks and split characters', async () => {
    const text = `{"note": "caf${E_ACUTE}"}`;
    const bytes = Buffer.from(text, 'utf8');
    const split = bytes.indexOf(0xc3) + 1;
    const input = Readable.from([bytes.subarray(0, split), bytes.subarray(split)]);
    await expect(readHookStdin(input, 5000)).resolves.toBe(text);
    await expect(readHookStdin(Readable.from(['{"a":', '1}']), 5000)).resolves.toBe('{"a":1}');
  });

  it('resolves empty for an empty input', async () => {
    await expect(readHookStdin(Readable.from([]), 5000)).resolves.toBe('');
  });

  it('resolves empty at once for a terminal, without reading it', async () => {
    let read = false;
    const input: HookInput = {
      isTTY: true,
      [Symbol.asyncIterator]() {
        read = true;
        return { next: () => new Promise<IteratorResult<string>>(() => undefined) };
      },
    };
    await expect(readHookStdin(input, 60_000)).resolves.toBe('');
    expect(read).toBe(false);
  });

  it('resolves empty when the input never ends within the timeout', async () => {
    const input: HookInput = {
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          next: () => {
            if (first) {
              first = false;
              return Promise.resolve({ done: false, value: '{"partial": ' });
            }
            return new Promise<IteratorResult<string>>(() => undefined);
          },
        };
      },
    };
    await expect(readHookStdin(input, 50)).resolves.toBe('');
  });

  it('resolves empty when the input fails', async () => {
    const input: HookInput = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('EIO')) };
      },
    };
    await expect(readHookStdin(input, 5000)).resolves.toBe('');
  });
});
