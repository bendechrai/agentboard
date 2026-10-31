/**
 * What each hook event answers for a resolved actor on a readable board
 * (add-harness-integration task 2.1; board-harness-hooks "Session start
 * hook", "Stop hook", "Pre-tool-use claim check"; design.md decision 11
 * and "Rulings from task group 2"; board-agent-guidance "Mutex ticket
 * recipe").
 *
 * In process, through `runHook`, with `Date` faked so lease tokens and
 * the rate limit are exact, and with the warning state in a fresh
 * directory per test (`HookRequest.stateDir`), never the real temporary
 * directory. The protocol around the events (arguments, escape hatch,
 * actor, fail open) is pinned by hook-run.test.ts; the built CLI by
 * src/__tests__/hook-events-processes.test.ts.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalHash } from '../../events/canonical.js';
import type { TicketGrantEvent } from '../../events/schema.js';
import { COMMANDS } from '../../cli/registry.js';
import { dumpCache, openCache } from '../../store/cache.js';
import { ev, eventNames, P, putEvent, T1, T2 } from '../../store/__tests__/helpers.js';
import { cacheHashes } from '../../store/__tests__/v020-cache.js';
import { GITHUB_TOKEN, HEX_64, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { cliEnv, oneJson, project, run, type Run } from '../../cli/__tests__/cli-helpers.js';
import {
  EDIT_TOOLS,
  HELD_LINE_LIMIT,
  SESSION_CONTEXT_LIMIT,
  STOP_TEXT_LIMIT,
  WARN_INTERVAL_MS,
  runHook,
  warnStatePath,
  type HookOutcome,
  type HookRequest,
} from '../hook.js';
import { cleanEnv, git, gitRepo, makeBoardDir, tempDir } from './helpers.js';

/** The faked clock's start for tests that build boards through the CLI. */
const BASE = 1_800_000_000_000;

const SILENT: HookOutcome = { exitCode: 0, stdout: '', stderr: '' };

/** The warning state directory of the current test. */
let stateDir = '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
  stateDir = tempDir();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the faked clock forward by `ms`. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** The environment of a hook: clean git, no board override, no actor, hooks on. */
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

/** Runs a hook with `argv` (after `hook`) in `cwd`, the warning state in this test's directory. */
function hook(
  argv: readonly string[],
  cwd: string,
  payload: string,
  options: Partial<Omit<HookRequest, 'argv' | 'cwd' | 'payload'>> = {},
): HookOutcome {
  return runHook({ argv, cwd, payload, env: hookEnv(), stateDir, ...options });
}

/** A Claude Code SessionStart payload. */
function startPayload(cwd: string): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
}

/** A Claude Code Stop payload; `active` is the `stop_hook_active` value, omitted when undefined. */
function stopPayload(cwd: string, active?: unknown): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    hook_event_name: 'Stop',
    ...(active === undefined ? {} : { stop_hook_active: active }),
  });
}

/** Passed as `session` to `editPayload`: the payload has no `session_id` key. */
const NO_SESSION = Symbol('no session_id');

/**
 * A Claude Code PreToolUse payload of `tool` on `target` from `cwd`
 * (`notebook_path` for NotebookEdit, `file_path` otherwise); `session`
 * `NO_SESSION` leaves the `session_id` key out (an `undefined` argument
 * would take the default, `session-1`).
 */
function editPayload(
  cwd: string,
  target: unknown,
  tool = 'Write',
  session: unknown = 'session-1',
): string {
  const input =
    tool === 'NotebookEdit'
      ? { notebook_path: target, new_source: 'x' }
      : { file_path: target, content: 'x', old_string: 'a', new_string: 'b' };
  return JSON.stringify({
    ...(session === NO_SESSION ? {} : { session_id: session }),
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: input,
  });
}

/** Runs the CLI in process and expects exit 0. */
function cli(argv: readonly string[], root: string): Run {
  const out = run(argv, root, cliEnv());
  expect(out.code, `${argv.join(' ')}: ${out.stderr}`).toBe(0);
  return out;
}

/** Creates an ad hoc ticket as orch and returns its id. */
function newTicket(root: string, title = 'Work'): string {
  const out = cli(['new', title, '--adhoc', 'hook test', '--as', 'orch', '--json'], root);
  return (oneJson(out) as { ticket: { id: string } }).ticket.id;
}

/** A project with a board and one ticket claimed by `holder` (no lease, no comment). */
function claimed(holder = 'impl'): { root: string; boardDir: string; id: string } {
  const { root, boardDir } = project();
  const id = newTicket(root, 'Held work');
  cli(['claim', id, '--as', holder], root);
  return { root, boardDir, id };
}

/** The assignee token `list` shows for `id` now. */
function listToken(root: string, id: string): string {
  const line = cli(['list'], root)
    .stdout.split('\n')
    .find((l) => l.startsWith(`${id}  `));
  expect(line, `list has no line for ${id}`).toBeDefined();
  const token = String(line).split('  ')[2];
  expect(token).toBeDefined();
  return String(token);
}

/** The `inbox` text lines pending for `actor`, without acknowledging them. */
function peekLines(root: string, actor: string): string[] {
  return cli(['inbox', '--as', actor, '--peek'], root)
    .stdout.split('\n')
    .filter((l) => l !== '');
}

/** The SessionStart context of an answer: exit 0, stderr empty, one document. */
function sessionContext(out: HookOutcome): string {
  expect(out.exitCode, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  const doc = oneJson({ code: 0, stdout: out.stdout, stderr: '' }) as {
    hookSpecificOutput?: Record<string, unknown>;
  };
  expect(Object.keys(doc)).toEqual(['hookSpecificOutput']);
  const inner = doc.hookSpecificOutput ?? {};
  expect(Object.keys(inner).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(inner.hookEventName).toBe('SessionStart');
  expect(typeof inner.additionalContext).toBe('string');
  return String(inner.additionalContext);
}

/** The lines of a context text (a final newline is not a line). */
function lines(text: string): string[] {
  return text.replace(/\n$/, '').split('\n');
}

/** The held-ticket line of a session-start answer. */
function heldLine(out: HookOutcome): string {
  return lines(sessionContext(out))[0] ?? '';
}

/** The `systemMessage` of a stop warning: exit 0, stderr empty, that key only. */
function stopMessage(out: HookOutcome): string {
  expect(out.exitCode, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  const doc = oneJson({ code: 0, stdout: out.stdout, stderr: '' }) as Record<string, unknown>;
  expect(Object.keys(doc)).toEqual(['systemMessage']);
  expect(typeof doc.systemMessage).toBe('string');
  expect(String(doc.systemMessage)).not.toBe('');
  return String(doc.systemMessage);
}

/** The PreToolUse context of a warning: exit 0, no permission decision. */
function editContext(out: HookOutcome): string {
  expect(out.exitCode, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  const doc = oneJson({ code: 0, stdout: out.stdout, stderr: '' }) as {
    hookSpecificOutput?: Record<string, unknown>;
  };
  expect(Object.keys(doc)).toEqual(['hookSpecificOutput']);
  const inner = doc.hookSpecificOutput ?? {};
  expect(Object.keys(inner).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(inner.hookEventName).toBe('PreToolUse');
  expect(typeof inner.additionalContext).toBe('string');
  expect(String(inner.additionalContext)).not.toBe('');
  return String(inner.additionalContext);
}

/** The reason of a strict block: exit 2, stdout empty, the text and a newline on stderr. */
function blockReason(out: HookOutcome): string {
  expect(out.exitCode, out.stdout).toBe(2);
  expect(out.stdout).toBe('');
  expect(out.stderr.endsWith('\n')).toBe(true);
  const text = out.stderr.slice(0, -1);
  expect(text).not.toBe('');
  return text;
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

/** The derived tables of the cache, read without modifying it. */
function cacheDump(boardDir: string): string {
  const db = openCache(join(boardDir, 'cache.sqlite'), { prepare: false });
  try {
    return dumpCache(db);
  } finally {
    db.close();
  }
}

/**
 * A mutex granted from the queue (the grant-catchup seed of
 * hook-run.test.ts, on small walls): merger-1 claimed T1 at 2000,
 * merger-2 joined at 3000 asking for 600000, merger-1 released at 5000;
 * impl claimed T2 at 4000. `list` at 6000 catches up and writes the grant
 * to merger-2 (due at 5001), so merger-2 holds T1 under an unconfirmed
 * lease. The clock is left at 6000.
 */
function grantedBoard(): { root: string; boardDir: string; grant: string } {
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
  vi.setSystemTime(6000);
  cli(['list'], root);
  const grant = `${canonicalHash(g)}.json`;
  expect(eventNames(events)).toContain(grant);
  return { root, boardDir, grant };
}

/** Words a hook text must never use (board-agent-guidance "Mutex ticket recipe"). */
const LOOP_WORDS =
  /\brenew|\bunqueue|\bqueue|--wait|--ttl|\bwatch|\bwait|\bpoll|\bsleep|\bretry|\bloop/i;

/** The first word of every registry command. */
const COMMAND_WORDS = new Set(COMMANDS.map((c) => c.name.split(' ')[0]));

/** Asserts a hook text claims, renews, queues and loops on nothing, and names only real commands. */
function expectMutexSafe(label: string, text: string): void {
  expect(text, label).not.toMatch(LOOP_WORDS);
  for (const match of text.matchAll(/\bagentboard ([a-z][a-z-]*)/g)) {
    expect(COMMAND_WORDS.has(match[1] ?? ''), `${label}: agentboard ${String(match[1])}`).toBe(
      true,
    );
  }
}

describe('constants', () => {
  it('pins the limits and the tools of the spec', () => {
    expect(SESSION_CONTEXT_LIMIT).toBe(4000);
    expect(HELD_LINE_LIMIT).toBe(2000);
    expect(STOP_TEXT_LIMIT).toBe(2000);
    expect(WARN_INTERVAL_MS).toBe(600_000);
    expect([...EDIT_TOOLS]).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  });
});

describe('session-start', () => {
  it('scenario: inbox is delivered: both entries and the held-ticket line, and a second run prints no entries', () => {
    const { root, id } = claimed();
    cli(['inbox', '--as', 'impl'], root);
    cli(['comment', id, 'first note from orch', '--as', 'orch'], root);
    cli(['comment', id, 'second note from orch', '--as', 'orch'], root);
    const expected = peekLines(root, 'impl');
    expect(expected).toHaveLength(2);

    const first = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    expect(first[0]).toContain('impl');
    expect(first[0]).toContain(`${id} impl`);
    expect(first.slice(1)).toEqual(expected);

    // The cursor advanced like inbox: nothing is pending any more.
    expect(peekLines(root, 'impl')).toEqual([]);
    const second = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    expect(second).toEqual([first[0]]);
  });

  it('delivers the whole inbox of an actor with no stored cursor, in fold order, as inbox prints it', () => {
    const { root } = claimed();
    const expected = peekLines(root, 'impl');
    expect(expected.length).toBeGreaterThanOrEqual(2);
    const got = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    expect(got.slice(1)).toEqual(expected);
    expect(cli(['inbox', '--as', 'impl', '--json'], root).stdout).toContain('"entries":[]');
  });

  it('the held-ticket line names the actor and only the tickets it holds, each as <id> <token>', () => {
    const { root, id } = claimed();
    const other = newTicket(root, 'Someone else');
    cli(['claim', other, '--as', 'impl-2'], root);
    const free = newTicket(root, 'Unassigned');
    const closedId = newTicket(root, 'Closed');
    cli(['claim', closedId, '--as', 'impl'], root);
    cli(['move', closedId, 'blocked', '--as', 'impl'], root);
    cli(['close', closedId, '--no-decision', '--unplanned', 'hook test', '--as', 'orch'], root);
    const line = heldLine(hook(['session-start', '--as', 'impl'], root, startPayload(root)));
    expect(line).toContain('impl');
    expect(line).toContain(`${id} ${listToken(root, id)}`);
    for (const absent of [other, free, closedId]) {
      expect(line).not.toContain(absent);
    }
  });

  it('lists several held tickets in id order', () => {
    const { root } = project();
    const ids = [newTicket(root, 'A'), newTicket(root, 'B'), newTicket(root, 'C')];
    for (const id of [...ids].reverse()) {
      cli(['claim', id, '--as', 'impl'], root);
    }
    const line = heldLine(hook(['session-start', '--as', 'impl'], root, startPayload(root)));
    const sorted = [...ids].sort();
    const positions = sorted.map((id) => line.indexOf(`${id} impl`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('names the actor and no ticket when it holds none', () => {
    const { root, id } = claimed();
    const line = heldLine(hook(['session-start', '--as', 'reviewer'], root, startPayload(root)));
    expect(line).toContain('reviewer');
    expect(line).not.toContain(id);
  });

  it('scenario: held lease is shown with its state, including * for an unconfirmed lease', () => {
    const { root } = project();
    const m1 = newTicket(root, 'Merge lock');
    cli(['claim', m1, '--ttl', '10m', '--as', 'merger-1'], root);
    const token = listToken(root, m1);
    expect(token).toContain('*');
    expect(token.startsWith('merger-1*+')).toBe(true);
    const line = heldLine(hook(['session-start', '--as', 'merger-1'], root, startPayload(root)));
    expect(line).toContain(`${m1} ${token}`);
  });

  it('a confirmed lease is shown with its remaining time and no *', () => {
    const { root } = project();
    const m1 = newTicket(root, 'Merge lock');
    cli(['claim', m1, '--ttl', '10m', '--as', 'merger-1'], root);
    cli(['renew', m1, '--as', 'merger-1'], root);
    advance(60_000);
    const token = listToken(root, m1);
    expect(token).toMatch(/^merger-1\+/);
    const line = heldLine(hook(['session-start', '--as', 'merger-1'], root, startPayload(root)));
    expect(line).toContain(`${m1} ${token}`);
  });

  it('a lapsed lease is still held and shown with its state', () => {
    const { root } = project();
    const m1 = newTicket(root, 'Merge lock');
    cli(['claim', m1, '--ttl', '10m', '--as', 'merger-1'], root);
    advance(10 * 60_000);
    const token = listToken(root, m1);
    expect(token).toBe('merger-1*!claimable');
    const line = heldLine(hook(['session-start', '--as', 'merger-1'], root, startPayload(root)));
    expect(line).toContain(`${m1} merger-1*!claimable`);
  });

  it('a ticket handed off to the actor is held and named', () => {
    const { root, id } = claimed();
    cli(
      ['handoff', id, '--to', 'reviewer', '--status', 'tests', '--note', 'ready', '--as', 'impl'],
      root,
    );
    expect(
      heldLine(hook(['session-start', '--as', 'reviewer'], root, startPayload(root))),
    ).toContain(`${id} reviewer`);
    expect(
      heldLine(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    ).not.toContain(id);
  });

  it('a ticket granted from the queue is held and named with its lease token; the grant is in the inbox', () => {
    const { root } = grantedBoard();
    const token = listToken(root, T1);
    expect(token.startsWith('merger-2*')).toBe(true);
    const got = lines(
      sessionContext(hook(['session-start', '--as', 'merger-2'], root, startPayload(root))),
    );
    expect(got[0]).toContain(`${T1} ${token}`);
    expect(got.slice(1).some((l) => l.startsWith(`GRANTED: ${T1}  ticket.grant`))).toBe(true);
    expect(
      heldLine(hook(['session-start', '--as', 'merger-1'], root, startPayload(root))),
    ).not.toContain(T1);
  });

  it('being queued for a ticket is not holding it', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
    putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
    putEvent(
      events,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
    );
    vi.setSystemTime(3500);
    const token = listToken(root, T1);
    expect(token).toContain('^1');
    expect(
      heldLine(hook(['session-start', '--as', 'merger-2'], root, startPayload(root))),
    ).not.toContain(T1);
    expect(
      heldLine(hook(['session-start', '--as', 'merger-1'], root, startPayload(root))),
    ).toContain(`${T1} ${token}`);
  });

  it('scenario: large inbox: truncated at an entry boundary with the omitted count and the inbox command', () => {
    const { root, id } = claimed();
    cli(['inbox', '--as', 'impl'], root);
    for (let i = 0; i < 40; i += 1) {
      cli(
        ['comment', id, `note ${String(i).padStart(2, '0')} ${'x'.repeat(150)}`, '--as', 'orch'],
        root,
      );
    }
    const expected = peekLines(root, 'impl');
    expect(expected).toHaveLength(40);
    expect(expected.join('\n').length).toBeGreaterThan(SESSION_CONTEXT_LIMIT);

    const text = sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root)));
    expect(text.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
    const got = lines(text);
    expect(got[0]).toContain(`${id} impl`);
    const shown = got.slice(1, -1);
    const last = got[got.length - 1] ?? '';
    expect(shown.length).toBeGreaterThan(0);
    // Whole entries, from the start, in order: no entry is cut.
    expect(shown).toEqual(expected.slice(0, shown.length));
    const omitted = expected.length - shown.length;
    expect(omitted).toBeGreaterThan(0);
    expect(last).toMatch(new RegExp(`\\b${String(omitted)}\\b`));
    expect(last).toContain('agentboard inbox --as impl');
    // As many entries as fit: one more would pass the limit.
    const next = expected[shown.length] ?? '';
    expect(text.length + next.length + 1).toBeGreaterThan(SESSION_CONTEXT_LIMIT - 5);
  });

  it('scenario: omitted entries stay in the inbox: the next inbox lists exactly them', () => {
    const { root, id } = claimed();
    cli(['inbox', '--as', 'impl'], root);
    for (let i = 0; i < 40; i += 1) {
      cli(
        ['comment', id, `note ${String(i).padStart(2, '0')} ${'y'.repeat(150)}`, '--as', 'orch'],
        root,
      );
    }
    const expected = peekLines(root, 'impl');
    const got = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    const shown = got.slice(1, -1);
    expect(shown.length).toBeLessThan(expected.length);
    expect(peekLines(root, 'impl')).toEqual(expected.slice(shown.length));
  });

  it('cuts a long held-ticket line at a ticket boundary, ending with and <n> more, within the limits', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ids: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const id = `01ARYZ6S41TSV4RRFFQ69G${alphabet[Math.floor(i / 32) % 32] ?? '0'}${alphabet[i % 32] ?? '0'}AV`;
      ids.push(id);
      putEvent(events, ev(P.create(id, `Ticket ${String(i)}`), 'orch', 1000, i));
      putEvent(events, ev(P.claim(id), 'impl', 2000, i));
    }
    vi.setSystemTime(3000);
    cli(['list'], root);
    const text = sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root)));
    expect(text.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
    const line = lines(text)[0] ?? '';
    expect(line.length).toBeLessThanOrEqual(HELD_LINE_LIMIT);
    const sorted = [...ids].sort();
    const named = sorted.filter((id) => line.includes(`${id} impl`));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(ids.length);
    // The first tickets in id order, whole.
    expect(named).toEqual(sorted.slice(0, named.length));
    expect(line).toMatch(new RegExp(`and ${String(ids.length - named.length)} more`));
  });

  it('with nothing new it prints only the held-ticket line and writes nothing', () => {
    const { root, boardDir, id } = claimed();
    cli(['inbox', '--as', 'impl'], root);
    const files = tree(boardDir);
    const hashes = cacheHashes(join(boardDir, 'cache.sqlite'));
    const got = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(`${id} impl`);
    expect(tree(boardDir)).toEqual(files);
    expect(cacheHashes(join(boardDir, 'cache.sqlite'))).toEqual(hashes);
  });

  it('changes nothing but the cursor: event files and the derived cache tables are identical', () => {
    const { root, boardDir, id } = claimed();
    cli(['comment', id, 'a note', '--as', 'orch'], root);
    const events = tree(join(boardDir, 'events'));
    const derived = cacheDump(boardDir);
    sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root)));
    expect(tree(join(boardDir, 'events'))).toEqual(events);
    expect(cacheDump(boardDir)).toBe(derived);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('does not catch up: an event file not yet folded is neither delivered nor skipped', () => {
    const { root, boardDir, id } = claimed();
    cli(['inbox', '--as', 'impl'], root);
    cli(['comment', id, 'folded note', '--as', 'orch'], root);
    const folded = peekLines(root, 'impl');
    expect(folded).toHaveLength(1);
    advance(1000);
    const late = putEvent(
      join(boardDir, 'events'),
      ev(P.comment(id, 'not folded yet'), 'orch', Date.now()),
    );
    const got = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    expect(got.slice(1)).toEqual(folded);
    expect(got.join('\n')).not.toContain('not folded yet');
    const inbox = oneJson(cli(['inbox', '--as', 'impl', '--json'], root)) as {
      entries: { hash: string }[];
    };
    expect(inbox.entries.map((e) => e.hash)).toEqual([late]);
  });

  it('the held-ticket line and the truncation line never claim, renew, queue or loop', () => {
    const { root } = grantedBoard();
    for (let i = 0; i < 40; i += 1) {
      cli(['comment', T2, `note ${String(i)} ${'z'.repeat(150)}`, '--as', 'orch'], root);
    }
    for (const actor of ['merger-2', 'impl', 'nobody']) {
      const got = lines(
        sessionContext(hook(['session-start', '--as', actor], root, startPayload(root))),
      );
      expectMutexSafe(`session-start ${actor} held line`, got[0] ?? '');
      const last = got[got.length - 1] ?? '';
      if (!last.includes('  ')) {
        expectMutexSafe(`session-start ${actor} truncation line`, last);
      }
    }
  });
});

describe('stop', () => {
  it('scenario: forgot to hand off, warn mode: exit 0 with a message naming T1 and agentboard handoff', () => {
    const { root, id } = claimed();
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    expect(text).toContain(id);
    expect(text).toContain('agentboard handoff');
    expect(text).toContain('agentboard comment');
    expect(text).toMatch(/agentboard move \S+ blocked/);
    expect(text).not.toContain('agentboard release');
    expectMutexSafe('stop, plain claim', text);
  });

  it('warn mode never blocks, whatever stop_hook_active says', () => {
    const { root } = claimed();
    for (const active of [undefined, false, true, 'yes']) {
      const out = hook(['stop', '--as', 'impl'], root, stopPayload(root, active));
      stopMessage(out);
    }
  });

  it('scenario: forgot to hand off, strict mode: exit 2 and stderr names T1, the warn text', () => {
    const { root, id } = claimed();
    const warn = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    const reason = blockReason(
      hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false)),
    );
    expect(reason).toContain(id);
    expect(reason).toBe(warn);
  });

  it('scenario: strict mode does not loop: stop_hook_active true exits 0, answering as warn mode', () => {
    const { root } = claimed();
    const warn = hook(['stop', '--as', 'impl'], root, stopPayload(root, false));
    const again = hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, true));
    expect(again.exitCode).toBe(0);
    expect(again).toEqual(warn);
  });

  it('R2: strict blocks only when stop_hook_active is exactly false; any other value answers as warn mode', () => {
    const { root } = claimed();
    const warn = hook(['stop', '--as', 'impl'], root, stopPayload(root, false));
    stopMessage(warn);
    for (const active of [undefined, true, 'false', 'true', 0, 1, 'yes', null, [], {}]) {
      const out = hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, active));
      expect(out, `stop_hook_active ${JSON.stringify(active) ?? 'missing'}`).toEqual(warn);
    }
  });

  it.each([
    ['empty stdin', ''],
    ['garbage', 'not json'],
    ['an array', '[false]'],
    ['an object without the field', '{"hook_event_name":"Stop"}'],
    ['the string "false"', '{"stop_hook_active":"false"}'],
  ])(
    'R2 scenario: strict mode cannot see stop_hook_active (%s): exit 0 with the warn-mode systemMessage',
    (_label, payload) => {
      const { root, id } = claimed();
      const warn = hook(['stop', '--as', 'impl'], root, stopPayload(root, false));
      const out = hook(['stop', '--strict', '--as', 'impl'], root, payload);
      expect(out).toEqual(warn);
      expect(stopMessage(out)).toContain(id);
    },
  );

  it('scenario: held mutex names release: a grant from the queue with no comment since names agentboard release first', () => {
    const { root } = grantedBoard();
    const text = stopMessage(hook(['stop', '--as', 'merger-2'], root, stopPayload(root, false)));
    expect(text).toContain(T1);
    expect(text).toContain(`agentboard release ${T1}`);
    expect(text).toContain('agentboard handoff');
    expect(text.indexOf('agentboard release')).toBeLessThan(text.indexOf('agentboard handoff'));
    expectMutexSafe('stop, granted mutex', text);
    const reason = blockReason(
      hook(['stop', '--strict', '--as', 'merger-2'], root, stopPayload(root, false)),
    );
    expect(reason).toBe(text);
  });

  it('names release first for a ticket claimed with a lease, live or lapsed', () => {
    const { root } = project();
    const m1 = newTicket(root, 'Merge lock');
    cli(['claim', m1, '--ttl', '10m', '--as', 'merger-1'], root);
    for (const wait of [0, 10 * 60_000]) {
      advance(wait);
      const text = stopMessage(hook(['stop', '--as', 'merger-1'], root, stopPayload(root, false)));
      expect(text).toContain(`agentboard release ${m1}`);
      expect(text.indexOf('agentboard release')).toBeLessThan(text.indexOf('agentboard handoff'));
      expectMutexSafe('stop, leased claim', text);
    }
  });

  it('in the granted seed, impl (no lease) is named without release, and merger-1 holds nothing', () => {
    const { root } = grantedBoard();
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    expect(text).toContain(T2);
    expect(text).not.toContain(T1);
    expect(text).not.toContain('agentboard release');
    expect(hook(['stop', '--strict', '--as', 'merger-1'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
  });

  it('scenario: blocked ticket is fine, with or without a comment', () => {
    const { root, id } = claimed();
    cli(['move', id, 'blocked', '--as', 'impl'], root);
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
    cli(['comment', id, 'blocked on the schema question', '--as', 'impl'], root);
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
    expect(hook(['stop', '--as', 'impl'], root, stopPayload(root, false))).toEqual(SILENT);
  });

  it('scenario: no claimed tickets: strict exits 0 with no output', () => {
    const { root } = claimed();
    expect(hook(['stop', '--strict', '--as', 'reviewer'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
    expect(hook(['stop', '--as', 'reviewer'], root, stopPayload(root, false))).toEqual(SILENT);
  });

  it('a comment by the actor since the claim is enough', () => {
    const { root, id } = claimed();
    cli(['comment', id, 'halfway: parser done', '--as', 'impl'], root);
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
  });

  it("another actor's comment since the claim is not the actor's", () => {
    const { root, id } = claimed();
    cli(['comment', id, 'how is it going?', '--as', 'orch'], root);
    expect(
      blockReason(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))),
    ).toContain(id);
  });

  it('scenario: handed back without a new comment: an earlier comment does not count', () => {
    const { root, id } = claimed();
    cli(['comment', id, 'first pass done', '--as', 'impl'], root);
    cli(
      ['handoff', id, '--to', 'reviewer', '--status', 'tests', '--note', 'ready', '--as', 'impl'],
      root,
    );
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
    cli(
      [
        'handoff',
        id,
        '--to',
        'impl',
        '--status',
        'implementing',
        '--note',
        'fix the nits',
        '--as',
        'reviewer',
      ],
      root,
    );
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    expect(text).toContain(id);
    // The reviewer, who handed it back with a note, holds nothing now.
    expect(hook(['stop', '--strict', '--as', 'reviewer'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
    cli(['comment', id, 'nits fixed', '--as', 'impl'], root);
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
  });

  it("a ticket handed to the actor with no comment since names it; the hand-off note is not the receiver's", () => {
    const { root, id } = claimed();
    cli(
      ['handoff', id, '--to', 'reviewer', '--status', 'tests', '--note', 'ready', '--as', 'impl'],
      root,
    );
    const text = stopMessage(hook(['stop', '--as', 'reviewer'], root, stopPayload(root, false)));
    expect(text).toContain(id);
  });

  it('names every un-handed-off ticket in id order, and none that has a comment', () => {
    const { root } = project();
    const ids = [newTicket(root, 'A'), newTicket(root, 'B'), newTicket(root, 'C')];
    for (const id of ids) {
      cli(['claim', id, '--as', 'impl'], root);
    }
    const sorted = [...ids].sort();
    const [first, second, third] = sorted as [string, string, string];
    cli(['comment', second, 'progress', '--as', 'impl'], root);
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    expect(text).toContain(first);
    expect(text).toContain(third);
    expect(text).not.toContain(second);
    expect(text.indexOf(first)).toBeLessThan(text.indexOf(third));
  });

  it('a comment written before the claim does not count', () => {
    const { root } = project();
    const id = newTicket(root, 'Work');
    cli(['comment', id, 'looking at this next', '--as', 'impl'], root);
    advance(1000);
    cli(['claim', id, '--as', 'impl'], root);
    expect(stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)))).toContain(
      id,
    );
  });

  it('writes nothing: board and warning state untouched', () => {
    const { root, boardDir } = claimed();
    const files = tree(boardDir);
    const hashes = cacheHashes(join(boardDir, 'cache.sqlite'));
    for (const argv of [['stop'], ['stop', '--strict']]) {
      hook([...argv, '--as', 'impl'], root, stopPayload(root, false));
      hook([...argv, '--as', 'impl'], root, stopPayload(root, true));
    }
    expect(tree(boardDir)).toEqual(files);
    expect(cacheHashes(join(boardDir, 'cache.sqlite'))).toEqual(hashes);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

describe('pre-tool-use', () => {
  it('scenario: edit with a claim: exit 0 and nothing printed, for every edit tool and both modes', () => {
    const { root } = claimed();
    for (const tool of EDIT_TOOLS) {
      for (const argv of [['pre-tool-use'], ['pre-tool-use', '--strict']]) {
        const out = hook(
          [...argv, '--as', 'impl'],
          root,
          editPayload(root, join(root, 'src', 'a.ts'), tool),
        );
        expect(out, `${tool} ${argv.join(' ')}`).toEqual(SILENT);
      }
    }
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('a held blocked ticket still counts as holding one', () => {
    const { root, id } = claimed();
    cli(['move', id, 'blocked', '--as', 'impl'], root);
    expect(
      hook(
        ['pre-tool-use', '--strict', '--as', 'impl'],
        root,
        editPayload(root, join(root, 'a.ts')),
      ),
    ).toEqual(SILENT);
  });

  it('scenario: edit without a claim, warn mode: exit 0 with context naming agentboard claim, and no permission decision', () => {
    const { root } = claimed();
    const text = editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'src', 'a.ts'))),
    );
    expect(text).toContain('agentboard claim');
    expect(text).toContain('agentboard inbox');
    expect(text).toMatch(/carry on/i);
    expectMutexSafe('pre-tool-use warning', text);
  });

  it('scenario: edit without a claim, strict mode: exit 2 with the reason on stderr', () => {
    const { root } = claimed();
    const warn = editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'src', 'a.ts'))),
    );
    const reason = blockReason(
      hook(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        root,
        editPayload(root, join(root, 'src', 'a.ts')),
      ),
    );
    expect(reason).toContain('agentboard claim');
    expect(reason).toContain('agentboard inbox');
    expect(warn).toMatch(/carry on/i);
  });

  it('R3 scenario: strict denial does not invite a retry: refused, claim or ask the user, never carry on', () => {
    const { root } = claimed();
    const reason = blockReason(
      hook(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        root,
        editPayload(root, join(root, 'src', 'a.ts')),
      ),
    );
    expect(reason).toMatch(/\brefused\b/i);
    expect(reason).toContain('holds no ticket');
    expect(reason).toContain('agentboard claim <id> --as nobody');
    expect(reason).toContain('agentboard inbox --as nobody');
    expect(reason).toMatch(/\bask the user\b/i);
    expect(reason).not.toMatch(/carry on|carrying on|continue|try again|again later/i);
    expectMutexSafe('strict pre-tool-use denial', reason);
    // The warn text is unchanged: it still says carrying on is fine.
    const warn = editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'src', 'a.ts'))),
    );
    expect(warn).toMatch(/carry on/i);
    expect(warn).not.toMatch(/\brefused\b/i);
  });

  it('acts on each edit tool, NotebookEdit through notebook_path', () => {
    const { root } = claimed();
    for (const tool of EDIT_TOOLS) {
      const target = join(root, tool === 'NotebookEdit' ? 'nb.ipynb' : 'src/a.ts');
      blockReason(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, editPayload(root, target, tool)),
      );
      const out = hook(
        ['pre-tool-use', '--as', 'nobody'],
        root,
        editPayload(root, target, tool, `s-${tool}`),
      );
      editContext(out);
    }
  });

  it('NotebookEdit falls back to file_path', () => {
    const { root } = claimed();
    const payload = JSON.stringify({
      session_id: 's',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { file_path: join(root, 'nb.ipynb') },
    });
    blockReason(hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, payload));
  });

  it.each(['Read', 'Bash', 'Glob', 'Grep', 'NotebookRead', 'edit', 'write', 'EDIT', 'Edit ', ''])(
    'scenario: other tools (%j) exit 0 with no output in both modes',
    (tool) => {
      const { root } = claimed();
      for (const argv of [['pre-tool-use'], ['pre-tool-use', '--strict']]) {
        const out = hook(
          [...argv, '--as', 'nobody'],
          root,
          editPayload(root, join(root, 'src', 'a.ts'), tool),
        );
        expect(out, argv.join(' ')).toEqual(SILENT);
      }
    },
  );

  it('scenario: paths outside the project root or under .board/ exit 0 with no output in both modes', () => {
    const { root, boardDir } = claimed();
    const elsewhere = tempDir();
    for (const target of [
      join(elsewhere, 'a.ts'),
      `${root}-other/a.ts`,
      `${root}x/a.ts`,
      join(root, '..', 'a.ts'),
      '../elsewhere/a.ts',
      join(boardDir, 'events', 'x.json'),
      join(boardDir, 'cache.sqlite'),
      join(root, '.board', 'notes.md'),
      join(root, 'sub', '.board', 'x'),
      '.board/cache.sqlite',
    ]) {
      for (const argv of [['pre-tool-use'], ['pre-tool-use', '--strict']]) {
        const out = hook([...argv, '--as', 'nobody'], root, editPayload(root, target));
        expect(out, `${argv.join(' ')} ${target}`).toEqual(SILENT);
      }
    }
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('a missing, empty or non-string target is passed silently', () => {
    const { root } = claimed();
    for (const target of [undefined, '', 5, null, ['a.ts'], { path: 'a.ts' }]) {
      const out = hook(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        root,
        editPayload(root, target),
      );
      expect(out, JSON.stringify(target)).toEqual(SILENT);
    }
    const noInput = JSON.stringify({ session_id: 's', cwd: root, tool_name: 'Write' });
    expect(hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, noInput)).toEqual(SILENT);
  });

  it('a relative target inside the project is resolved against the payload cwd and checked', () => {
    const { root } = claimed();
    mkdirSync(join(root, 'src'));
    for (const target of ['src/a.ts', 'a.ts', './README.md']) {
      blockReason(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, editPayload(root, target)),
      );
    }
  });

  it('scenario: edit in a linked worktree is checked as a project file, from its root or a subdirectory', () => {
    const base = tempDir();
    const main = gitRepo(join(base, 'project'));
    makeBoardDir(main);
    const id = newTicket(main, 'Work');
    cli(['claim', id, '--as', 'impl'], main);
    const wt = join(base, 'project.worktrees', 'feature');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    mkdirSync(join(wt, 'src'), { recursive: true });
    const other = join(base, 'project.worktrees', 'other');
    mkdirSync(other, { recursive: true });
    const elsewhere = tempDir();

    for (const [cwd, target] of [
      [wt, join(wt, 'src', 'a.ts')],
      [join(wt, 'src'), join(wt, 'README.md')],
      [wt, join(main, 'README.md')],
    ] as const) {
      blockReason(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], elsewhere, editPayload(cwd, target)),
      );
      expect(
        hook(['pre-tool-use', '--strict', '--as', 'impl'], elsewhere, editPayload(cwd, target)),
      ).toEqual(SILENT);
    }
    // Another directory beside the worktree is neither the main checkout nor this worktree.
    expect(
      hook(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        elsewhere,
        editPayload(wt, join(other, 'a.ts')),
      ),
    ).toEqual(SILENT);
  });

  it('writes nothing to the board', () => {
    const { root, boardDir } = claimed();
    const files = tree(boardDir);
    const hashes = cacheHashes(join(boardDir, 'cache.sqlite'));
    for (let i = 0; i < 3; i += 1) {
      for (const argv of [['pre-tool-use'], ['pre-tool-use', '--strict']]) {
        for (const actor of ['impl', 'nobody']) {
          hook(
            [...argv, '--as', actor],
            root,
            editPayload(root, join(root, 'a.ts'), 'Edit', `s-${String(i)}`),
          );
        }
      }
    }
    expect(tree(boardDir)).toEqual(files);
    expect(cacheHashes(join(boardDir, 'cache.sqlite'))).toEqual(hashes);
  });
});

describe('pre-tool-use warning rate limit', () => {
  const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

  it('warnStatePath is <stateDir>/agentboard-hook-<sha256 of the session id>', () => {
    for (const session of ['session-1', '', GITHUB_TOKEN, '../../etc/passwd', 'a/b']) {
      expect(warnStatePath('/some/dir', session)).toBe(
        join('/some/dir', `agentboard-hook-${sha(session)}`),
      );
    }
  });

  it('scenario: warnings are rate limited: of five consecutive edits only the first warns', () => {
    const { root } = claimed();
    const outs = [0, 1, 2, 3, 4].map((i) => {
      advance(i === 0 ? 0 : 30_000);
      return hook(
        ['pre-tool-use', '--as', 'nobody'],
        root,
        editPayload(root, join(root, `f${String(i)}.ts`)),
      );
    });
    editContext(outs[0] ?? SILENT);
    for (const out of outs.slice(1)) {
      expect(out).toEqual(SILENT);
    }
  });

  it('records the time of the warning in the state file of the session', () => {
    const { root } = claimed();
    const at = Date.now();
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
    const file = warnStatePath(stateDir, 'session-1');
    expect(readdirSync(stateDir)).toEqual([`agentboard-hook-${sha('session-1')}`]);
    expect(readFileSync(file, 'utf8').trim()).toBe(String(at));
  });

  it('scenario: the warning comes back after 10 minutes, not a millisecond before', () => {
    const { root } = claimed();
    const payload = editPayload(root, join(root, 'a.ts'));
    editContext(hook(['pre-tool-use', '--as', 'nobody'], root, payload));
    advance(WARN_INTERVAL_MS - 1);
    expect(hook(['pre-tool-use', '--as', 'nobody'], root, payload)).toEqual(SILENT);
    advance(1);
    editContext(hook(['pre-tool-use', '--as', 'nobody'], root, payload));
    advance(1);
    expect(hook(['pre-tool-use', '--as', 'nobody'], root, payload)).toEqual(SILENT);
  });

  it('is kept per session: another session is warned', () => {
    const { root } = claimed();
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
    editContext(
      hook(
        ['pre-tool-use', '--as', 'nobody'],
        root,
        editPayload(root, join(root, 'a.ts'), 'Edit', 'session-2'),
      ),
    );
    expect(readdirSync(stateDir).sort()).toEqual(
      [`agentboard-hook-${sha('session-1')}`, `agentboard-hook-${sha('session-2')}`].sort(),
    );
  });

  it('strict mode is not rate limited, neither reads nor writes the state', () => {
    const { root } = claimed();
    writeFileSync(warnStatePath(stateDir, 'session-1'), String(Date.now()));
    for (let i = 0; i < 5; i += 1) {
      blockReason(
        hook(
          ['pre-tool-use', '--strict', '--as', 'nobody'],
          root,
          editPayload(root, join(root, 'a.ts')),
        ),
      );
    }
    const fresh = tempDir();
    for (let i = 0; i < 3; i += 1) {
      blockReason(
        hook(
          ['pre-tool-use', '--strict', '--as', 'nobody'],
          root,
          editPayload(root, join(root, 'a.ts')),
          {
            stateDir: fresh,
          },
        ),
      );
    }
    expect(readdirSync(fresh)).toEqual([]);
  });

  it('a recent record silences; garbage, an empty file or a time in the future counts as none', () => {
    const { root } = claimed();
    const file = warnStatePath(stateDir, 'session-1');
    const payload = editPayload(root, join(root, 'a.ts'));
    writeFileSync(file, String(Date.now() - 1000));
    expect(hook(['pre-tool-use', '--as', 'nobody'], root, payload)).toEqual(SILENT);
    for (const content of ['garbage', '', '12abc', String(Date.now() + 60_000), '-5']) {
      writeFileSync(file, content);
      editContext(hook(['pre-tool-use', '--as', 'nobody'], root, payload));
      expect(readFileSync(file, 'utf8').trim()).toBe(String(Date.now()));
    }
  });

  it('a payload with no session id is warned every time and writes no state', () => {
    const { root } = claimed();
    for (const session of [NO_SESSION, '', 5, null]) {
      for (let i = 0; i < 2; i += 1) {
        editContext(
          hook(
            ['pre-tool-use', '--as', 'nobody'],
            root,
            editPayload(root, join(root, 'a.ts'), 'Write', session),
          ),
        );
      }
    }
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('a state directory that cannot be written never stops the warning', () => {
    const { root } = claimed();
    const missing = join(tempDir(), 'no', 'such', 'dir');
    for (let i = 0; i < 2; i += 1) {
      editContext(
        hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts')), {
          stateDir: missing,
        }),
      );
    }
    expect(existsSync(missing)).toBe(false);
    const notDir = join(tempDir(), 'file');
    writeFileSync(notDir, 'x');
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts')), {
        stateDir: notDir,
      }),
    );
  });

  it('replaces a symbolic link at the state name instead of writing through it', () => {
    const { root } = claimed();
    const victim = join(tempDir(), 'victim.txt');
    writeFileSync(victim, 'precious\n');
    const file = warnStatePath(stateDir, 'session-1');
    symlinkSync(victim, file);
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, 'utf8').trim()).toBe(String(Date.now()));
  });

  it('never repeats a token-shaped session id in a file name or an answer', () => {
    const { root } = claimed();
    for (const session of [GITHUB_TOKEN, HEX_64]) {
      const out = hook(
        ['pre-tool-use', '--as', 'nobody'],
        root,
        editPayload(root, join(root, 'a.ts'), 'Write', session),
      );
      editContext(out);
      expectNoLeak(`pre-tool-use session ${session.slice(0, 3)}`, [out.stdout, out.stderr]);
    }
    for (const name of readdirSync(stateDir)) {
      expect(name).toMatch(/^agentboard-hook-[0-9a-f]{64}$/);
      expect(name).not.toContain(GITHUB_TOKEN);
    }
  });

  it('an actor holding a ticket writes no state and is not warned, even with no record', () => {
    const { root } = claimed();
    expect(
      hook(['pre-tool-use', '--as', 'impl'], root, editPayload(root, join(root, 'a.ts'))),
    ).toEqual(SILENT);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

/** The `i`th of a run of distinct ticket ids, in increasing id order for `i` < 1024. */
function bulkId(i: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `01ARYZ6S41TSV4RRFFQ69G${alphabet[Math.floor(i / 32) % 32] ?? '0'}${alphabet[i % 32] ?? '0'}AV`;
}

/**
 * A board where `actor` holds `count` tickets (created by orch, claimed
 * by `actor`, no comment), written as event files and folded by `list`;
 * the first `waited` tickets in id order also have one waiter, so their
 * `list` token gains `^1`. The clock is left at 3000.
 */
function heldBoard(
  actor: string,
  count: number,
  waited = 0,
): { root: string; boardDir: string; ids: string[] } {
  const { root, boardDir } = project();
  const events = join(boardDir, 'events');
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = bulkId(i);
    ids.push(id);
    putEvent(events, ev(P.create(id, `Ticket ${String(i)}`), 'orch', 1000, i));
    putEvent(events, ev(P.claim(id), actor, 2000, i));
    if (i < waited) {
      putEvent(
        events,
        ev({ kind: 'ticket.queue.join', ticket: id, body: { ttl: 600_000 } }, 'waiter', 2500, i),
      );
    }
  }
  vi.setSystemTime(3000);
  cli(['list'], root);
  return { root, boardDir, ids };
}

describe('review round 1: stop', () => {
  it('R4 scenario: many held tickets: at most STOP_TEXT_LIMIT characters, the first tickets in id order, ending and <n> more', () => {
    const { root, ids } = heldBoard('impl', 200);
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    expect(text.length).toBeLessThanOrEqual(STOP_TEXT_LIMIT);
    const sorted = [...ids].sort();
    const named = sorted.filter((id) => text.includes(id));
    expect(named.length).toBeGreaterThanOrEqual(2);
    expect(named.length).toBeLessThan(ids.length);
    // Whole tickets, from the start in id order: each named one has its commands.
    expect(named).toEqual(sorted.slice(0, named.length));
    for (const id of named) {
      expect(text).toContain(`agentboard handoff ${id}`);
      expect(text).toContain(`agentboard comment ${id}`);
      expect(text).toContain(`agentboard move ${id} blocked`);
    }
    const last = lines(text).at(-1) ?? '';
    expect(last).toMatch(new RegExp(`\\band ${String(ids.length - named.length)} more\\b`));
    expectMutexSafe('stop, many tickets', text);
    // Strict blocks with the same bounded text.
    const reason = blockReason(
      hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false)),
    );
    expect(reason).toBe(text);
  });

  it('R4: release stays first for each leased ticket among those shown in a cut text', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    const count = 60;
    for (let i = 0; i < count; i += 1) {
      putEvent(events, ev(P.create(bulkId(i), `Ticket ${String(i)}`), 'orch', 1000, i));
      if (i !== 0 && i !== 2) {
        putEvent(events, ev(P.claim(bulkId(i)), 'impl', 2000, i));
      }
    }
    vi.setSystemTime(3000);
    cli(['list'], root);
    for (const id of [bulkId(0), bulkId(2)]) {
      cli(['claim', id, '--ttl', '10m', '--as', 'impl'], root);
    }
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    expect(text.length).toBeLessThanOrEqual(STOP_TEXT_LIMIT);
    expect(lines(text).at(-1) ?? '').toMatch(/\band \d+ more\b/);
    for (const id of [bulkId(0), bulkId(2)]) {
      expect(text).toContain(`agentboard release ${id}`);
      expect(text.indexOf(`agentboard release ${id}`)).toBeLessThan(
        text.indexOf(`agentboard handoff ${id}`),
      );
    }
    expect(text).not.toContain(`agentboard release ${bulkId(1)}`);
  });

  it('R4: a text that fits names every ticket and has no and <n> more line', () => {
    const { root, ids } = heldBoard('impl', 3);
    const text = stopMessage(hook(['stop', '--as', 'impl'], root, stopPayload(root, false)));
    for (const id of ids) {
      expect(text).toContain(id);
    }
    expect(text).not.toMatch(/\band \d+ more\b/);
  });

  it('R5 scenario: hand-off to oneself: the note counts as a comment, so stop says nothing', () => {
    const { root, id } = claimed();
    cli(
      [
        'handoff',
        id,
        '--to',
        'impl',
        '--status',
        'todo',
        '--note',
        'done the parser, tests next',
        '--as',
        'impl',
      ],
      root,
    );
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
    expect(hook(['stop', '--as', 'impl'], root, stopPayload(root, false))).toEqual(SILENT);
  });

  it('R5: a hand-off to the actor by someone else still needs a comment by the actor', () => {
    const { root, id } = claimed('reviewer');
    cli(
      ['handoff', id, '--to', 'impl', '--status', 'todo', '--note', 'yours', '--as', 'reviewer'],
      root,
    );
    expect(
      blockReason(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))),
    ).toContain(id);
  });

  it('R10: a comment from an earlier hold does not count once the queue grants the ticket back', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    putEvent(events, ev(P.create(T1, 'Merge lock'), 'orch', 1000));
    putEvent(events, ev(P.claim(T1), 'merger-2', 1500));
    putEvent(events, ev(P.comment(T1, 'merged the first batch'), 'merger-2', 1600));
    putEvent(events, ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-2', 1700));
    putEvent(events, ev(P.claim(T1), 'merger-1', 2000));
    putEvent(
      events,
      ev({ kind: 'ticket.queue.join', ticket: T1, body: { ttl: 600_000 } }, 'merger-2', 3000),
    );
    putEvent(events, ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'merger-1', 5000));
    vi.setSystemTime(6000);
    cli(['list'], root);
    expect(listToken(root, T1).startsWith('merger-2*')).toBe(true);
    const reason = blockReason(
      hook(['stop', '--strict', '--as', 'merger-2'], root, stopPayload(root, false)),
    );
    expect(reason).toContain(T1);
    expect(reason).toContain(`agentboard release ${T1}`);
  });

  it('R10: a comment from an earlier hold does not count once the ticket is assigned back', () => {
    const { root, boardDir } = project();
    const events = join(boardDir, 'events');
    putEvent(events, ev(P.create(T1, 'Work'), 'orch', 1000));
    putEvent(events, ev(P.claim(T1), 'impl', 2000));
    putEvent(events, ev(P.comment(T1, 'first pass done'), 'impl', 2500));
    putEvent(events, ev({ kind: 'ticket.release', ticket: T1, body: {} }, 'impl', 2600));
    putEvent(events, ev({ kind: 'ticket.assign', ticket: T1, body: { to: 'impl' } }, 'orch', 4000));
    vi.setSystemTime(5000);
    cli(['list'], root);
    expect(listToken(root, T1)).toBe('impl');
    expect(
      blockReason(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))),
    ).toContain(T1);
    putEvent(events, ev(P.comment(T1, 'picked it up again'), 'impl', 5500));
    vi.setSystemTime(6000);
    cli(['list'], root);
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
  });

  it('R10: a rejected assigning event after the actor comment is ignored', () => {
    const { root, boardDir, id } = claimed();
    cli(['comment', id, 'halfway: parser done', '--as', 'impl'], root);
    advance(1000);
    // todo -> merged is not a permitted move, so this hand-off is rejected.
    putEvent(
      join(boardDir, 'events'),
      ev(P.handoff(id, 'impl', 'merged', 'rejected note'), 'reviewer', Date.now()),
    );
    advance(1000);
    const shown = oneJson(cli(['show', id, '--json'], root)) as {
      ticket: { comments: { text: string }[] };
    };
    expect(shown.ticket.comments.map((c) => c.text)).not.toContain('rejected note');
    expect(hook(['stop', '--strict', '--as', 'impl'], root, stopPayload(root, false))).toEqual(
      SILENT,
    );
  });
});

describe('review round 1: pre-tool-use', () => {
  it('R6 scenario: symbolic link to the project: a cwd through a link and a target by its real path, and the other way round', () => {
    const { root } = claimed();
    mkdirSync(join(root, 'src'));
    const link = join(tempDir(), 'link');
    symlinkSync(root, link);
    for (const [cwd, target] of [
      [link, join(root, 'src', 'a.ts')],
      [root, join(link, 'src', 'a.ts')],
      [link, join(link, 'src', 'a.ts')],
      [root, join(link, 'new', 'deep', 'b.ts')],
      [link, join(root, 'new', 'deep', 'b.ts')],
      [link, 'src/a.ts'],
    ] as const) {
      const label = `cwd ${cwd === link ? 'link' : 'real'}, target ${target}`;
      blockReason(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, editPayload(cwd, target)),
      );
      expect(
        hook(['pre-tool-use', '--strict', '--as', 'impl'], root, editPayload(cwd, target)),
        label,
      ).toEqual(SILENT);
    }
  });

  it('R6: the board directory stays exempt through a link, by either path', () => {
    const { root, boardDir } = claimed();
    const link = join(tempDir(), 'link');
    symlinkSync(root, link);
    for (const [cwd, target] of [
      [link, join(boardDir, 'notes.md')],
      [root, join(link, '.board', 'events', 'x.json')],
      [link, join(link, '.board', 'cache.sqlite')],
    ] as const) {
      expect(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, editPayload(cwd, target)),
        target,
      ).toEqual(SILENT);
    }
  });

  it('R6: a link inside the project that leads outside it is outside', () => {
    const { root } = claimed();
    const outside = tempDir();
    symlinkSync(outside, join(root, 'vendor'));
    for (const target of [join(root, 'vendor', 'a.ts'), join(root, 'vendor', 'new', 'b.ts')]) {
      expect(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, editPayload(root, target)),
        target,
      ).toEqual(SILENT);
    }
  });

  it('R10: a board directory not named .board (AGENTBOARD_DIR) is exempt, and the project around it is checked', () => {
    const { root, boardDir } = claimed();
    const tracker = join(root, 'tracker');
    renameSync(boardDir, tracker);
    const env = hookEnv({ AGENTBOARD_DIR: tracker });
    for (const target of [
      join(tracker, 'events', 'x.json'),
      join(tracker, 'cache.sqlite'),
      join(tracker, 'notes.md'),
    ]) {
      expect(
        hook(['pre-tool-use', '--strict', '--as', 'nobody'], root, editPayload(root, target), {
          env,
        }),
        target,
      ).toEqual(SILENT);
    }
    blockReason(
      hook(
        ['pre-tool-use', '--strict', '--as', 'nobody'],
        root,
        editPayload(root, join(root, 'src', 'a.ts')),
        { env },
      ),
    );
  });
});

describe('review round 1: the rate-limit file is never followed and never blocks (R7)', () => {
  it('a symbolic link at the state name to a file holding a recent time counts as no warning', () => {
    const { root } = claimed();
    const elsewhere = join(tempDir(), 'recent');
    writeFileSync(elsewhere, `${String(Date.now() - 1000)}\n`);
    symlinkSync(elsewhere, warnStatePath(stateDir, 'session-1'));
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
    // The target of the link is never written either.
    expect(readFileSync(elsewhere, 'utf8')).toBe(`${String(Date.now() - 1000)}\n`);
  });

  it('a symbolic link at the state name to a large file counts as no warning', () => {
    const { root } = claimed();
    const big = join(tempDir(), 'big');
    writeFileSync(big, `${String(Date.now() - 1000)}\n`);
    truncateSync(big, 64 * 1024 * 1024);
    symlinkSync(big, warnStatePath(stateDir, 'session-1'));
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
  });

  it('a directory at the state name counts as no warning and never stops the warning', () => {
    const { root } = claimed();
    mkdirSync(warnStatePath(stateDir, 'session-1'));
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
  });

  it('only the first 64 bytes are read: a recent time followed by more than 64 bytes is not a record', () => {
    const { root } = claimed();
    const file = warnStatePath(stateDir, 'session-1');
    writeFileSync(file, `${String(Date.now() - 1000)}${' '.repeat(100)}7\n`);
    editContext(
      hook(['pre-tool-use', '--as', 'nobody'], root, editPayload(root, join(root, 'a.ts'))),
    );
  });
});

describe('review round 1: the character limits at the boundary (R10)', () => {
  /**
   * The held-ticket line of `actor` holding `n` tickets, `q` of them with a
   * waiter, read from the hook (session-start; its inbox lines follow).
   */
  function heldFor(actor: string, n: number, q: number): string {
    const { root } = heldBoard(actor, n, q);
    return heldLine(hook(['session-start', '--as', actor], root, startPayload(root)));
  }

  /**
   * A ticket count `n` and waiter count `q` (`q` <= `n`) whose full
   * held-ticket line is exactly `target` characters, from the measured
   * length of the line for one ticket (`one`), the growth per ticket
   * (`step`) and the 2 characters a `^1` adds.
   */
  function sizeFor(target: number, one: number, step: number): { n: number; q: number } {
    for (let n = 1; n < 400; n += 1) {
      const rest = target - one - (n - 1) * step;
      if (rest >= 0 && rest % 2 === 0 && rest / 2 <= n) {
        return { n, q: rest / 2 };
      }
    }
    throw new Error(`no size gives ${String(target)}`);
  }

  it.each([
    [HELD_LINE_LIMIT, false],
    [HELD_LINE_LIMIT + 1, true],
  ])(
    'a held-ticket line of %i characters is cut: %s',
    (target, cut) => {
      for (const actor of ['impl-x', 'impl5']) {
        const one = heldFor(actor, 1, 0).length;
        const step = heldFor(actor, 2, 0).length - one;
        expect(heldFor(actor, 2, 1).length).toBe(one + step + 2);
        let size: { n: number; q: number };
        try {
          size = sizeFor(target, one, step);
        } catch {
          continue;
        }
        const line = heldFor(actor, size.n, size.q);
        if (cut) {
          expect(line.length).toBeLessThanOrEqual(HELD_LINE_LIMIT);
          expect(line).toMatch(/\band \d+ more$/);
        } else {
          expect(line.length).toBe(HELD_LINE_LIMIT);
          expect(line).not.toMatch(/\bmore$/);
          expect(line).toContain(bulkId(size.n - 1));
        }
        return;
      }
      throw new Error(`no actor gives a ${String(target)} character line`);
    },
    60_000,
  );

  it.each([
    [SESSION_CONTEXT_LIMIT, false],
    [SESSION_CONTEXT_LIMIT + 1, true],
  ])('a session-start context of %i characters is cut: %s', (target, cut) => {
    const { root, id } = claimed();
    cli(['inbox', '--as', 'impl'], root);
    const held = lines(
      sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root))),
    );
    expect(held).toHaveLength(1);
    const heldLength = (held[0] ?? '').length;
    // Measure the line of one orch comment entry: a fixed part and the text.
    cli(['comment', id, 'x'.repeat(200), '--as', 'orch'], root);
    const first = peekLines(root, 'impl');
    expect(first).toHaveLength(1);
    const fixed = (first[0] ?? '').length - 200;
    // Fill to `target`: whole lines of 300 characters of text, then the last one.
    let total = heldLength + 1 + (first[0] ?? '').length;
    let count = 1;
    while (target - total > 2 * (fixed + 300 + 1)) {
      cli(['comment', id, 'y'.repeat(300), '--as', 'orch'], root);
      total += 1 + fixed + 300;
      count += 1;
    }
    const lastText = target - total - 1 - fixed;
    expect(lastText).toBeGreaterThan(0);
    cli(['comment', id, 'z'.repeat(lastText), '--as', 'orch'], root);
    count += 1;
    const expected = peekLines(root, 'impl');
    expect(expected).toHaveLength(count);
    expect([held[0], ...expected].join('\n').length).toBe(target);

    const text = sessionContext(hook(['session-start', '--as', 'impl'], root, startPayload(root)));
    const got = lines(text);
    if (cut) {
      expect(text.length).toBeLessThanOrEqual(SESSION_CONTEXT_LIMIT);
      // The held line, the entries that fit (fewer than all), the omitted line.
      expect(got.slice(1, -1)).toEqual(expected.slice(0, got.length - 2));
      expect(got.length - 2).toBeLessThan(count);
      expect(got.at(-1) ?? '').toContain('agentboard inbox --as impl');
    } else {
      expect(text).toBe([held[0], ...expected].join('\n'));
      expect(peekLines(root, 'impl')).toEqual([]);
    }
  });
});
