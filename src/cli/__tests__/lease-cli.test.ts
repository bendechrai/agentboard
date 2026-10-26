/**
 * Leases, the queue, forced release and settings on the command line
 * (add-claim-leases task 3.1; board-cli: "Claim, release and handoff",
 * "Leases on the command line", "Waiting on the command line" (argument
 * checks only: the foreground wait is task 4.1), "Forced release on the
 * command line", "Board settings command", "Lease and queue hints").
 *
 * The CLI runs in process with the clock injected through vitest fake
 * timers (`Date` only). Joins are written through the library (a non-
 * blocking `claimTicket` with `wait`), never through `claim --wait` on the
 * command line, which blocks once task 4.1 lands. Every refusal is checked
 * to leave the events directory unchanged, temporary files included.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimTicket } from '../../board/actions.js';
import { SAMPLES } from '../../board/__tests__/helpers.js';
import { canonicalDecode } from '../../events/canonical.js';
import { validateEvent, type BoardEvent } from '../../events/schema.js';
import { openBoard } from '../../store/board.js';
import { allNames, eventNames } from '../../store/__tests__/helpers.js';
import { cliEnv, oneJson, project, run, type Run } from './cli-helpers.js';

const T = Date.UTC(2026, 9, 26, 9, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T);
});

afterEach(() => {
  vi.useRealTimers();
});

function at(ms: number): void {
  vi.setSystemTime(T + ms);
}

interface Board {
  root: string;
  events: string;
  id: string;
}

/** A project with one ad hoc mutex ticket created at T. */
function board(): Board {
  const { root, boardDir } = project();
  const out = run(
    ['new', 'Merge lock', '--adhoc', 'merge lock', '--as', 'orchestrator', '--json'],
    root,
  );
  expect(out.code, out.stderr).toBe(0);
  const id = (oneJson(out) as { ticket: { id: string } }).ticket.id;
  return { root, events: join(boardDir, 'events'), id };
}

function ok(out: Run): Run {
  expect(out.code, out.stderr).toBe(0);
  return out;
}

/** Runs the CLI expecting exit `code` with `reason` in the --json error document and no file change. */
function refused(
  b: Board,
  argv: readonly string[],
  code: number,
  reason: string,
  env = cliEnv(),
): Run {
  const before = allNames(b.events);
  const out = run(argv, b.root, env);
  expect(out.code, out.stderr).toBe(code);
  expect(allNames(b.events)).toEqual(before);
  const doc = run([...argv, '--json'], b.root, env);
  expect(doc.code).toBe(code);
  expect((oneJson(doc) as { error: { reason: string } }).error.reason).toBe(reason);
  expect(allNames(b.events)).toEqual(before);
  return out;
}

function eventOf(b: Board, hash: string): BoardEvent {
  const bytes = readFileSync(join(b.events, `${hash}.json`));
  const result = validateEvent(canonicalDecode(new Uint8Array(bytes)));
  if (!result.ok || !result.known) {
    throw new Error(`not a well-formed known event: ${hash}`);
  }
  return result.event;
}

function hashOf(out: Run): string {
  return String((oneJson(out) as { hash: string }).hash);
}

/** The `list` line of the ticket. */
function listLine(b: Board): string {
  const line = ok(run(['list'], b.root))
    .stdout.split('\n')
    .find((l) => l.startsWith(b.id));
  return line ?? '';
}

/** The assignee column of the ticket's `list` line. */
function token(b: Board): string {
  return listLine(b).split('  ')[2] ?? '';
}

/** Joins the queue of the ticket through the library (non-blocking). */
function join_(b: Board, actor: string, ttl = 1_800_000): void {
  const handle = openBoard(join(b.root, '.board'));
  try {
    expect(claimTicket(handle, actor, { id: b.id, ttl, wait: true })).toMatchObject({
      queued: true,
    });
  } finally {
    handle.close();
  }
}

describe('scenario: claim with a lease starts in grace', () => {
  it('exits 0, records the grace lease, list shows merger-1*+2m and the output names agentboard renew', () => {
    const b = board();
    at(10_000);
    const out = ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    expect(out.stdout).toContain(`agentboard renew ${b.id}`);
    expect(out.stdout).toContain(iso(T + 10_000 + 120_000));
    const hashes = eventNames(b.events).map((name) => name.slice(0, -5));
    const claim = hashes.map((h) => eventOf(b, h)).find((e) => e.kind === 'ticket.claim');
    expect(claim?.body).toEqual({
      lease: { ttl: 1_800_000, grace: 120_000, expiresAt: T + 130_000 },
    });
    expect(token(b)).toBe('merger-1*+2m');
  });

  it('the human output is the list line, then the confirmation line', () => {
    const b = board();
    const out = ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    expect(out.stdout).toBe(
      `${b.id}  todo  merger-1  [adhoc] Merge lock\n` +
        `confirm the lease with 'agentboard renew ${b.id} --as merger-1' before ${iso(T + 120_000)}\n`,
    );
  });

  it('--json is the WriteOutcome with the folded lease', () => {
    const b = board();
    const doc = oneJson(
      ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m', '--json'], b.root)),
    ) as {
      hash: string;
      ticket: { lease: unknown };
    };
    expect(doc.ticket.lease).toEqual({
      ttl: 1_800_000,
      expiresAt: T + 120_000,
      event: doc.hash,
      confirmed: false,
    });
  });
});

describe('scenario: renew confirms with the requested ttl', () => {
  it('exits 0, the renew ttl is 1800000 and list shows merger-1+30m', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    at(30_000);
    const out = ok(run(['renew', b.id, '--as', 'merger-1', '--json'], b.root));
    expect(eventOf(b, hashOf(out))).toMatchObject({
      kind: 'ticket.renew',
      body: { ttl: 1_800_000, expiresAt: T + 30_000 + 1_800_000 },
    });
    expect(token(b)).toBe('merger-1+30m');
  });

  it('renew --ttl 1h sets the lease to one hour', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    const out = ok(run(['renew', b.id, '--as', 'merger-1', '--ttl', '1h', '--json'], b.root));
    expect(eventOf(b, hashOf(out)).body).toEqual({ ttl: 3_600_000, expiresAt: T + 3_600_000 });
    expect(token(b)).toBe('merger-1+1h');
  });
});

describe('scenario: takeover of a claimable lease', () => {
  it('181 s after an unrenewed claim, claim --ttl takes over, naming the old lease', () => {
    const b = board();
    const first = ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m', '--json'], b.root));
    at(181_000);
    const out = ok(run(['claim', b.id, '--as', 'merger-2', '--ttl', '30m', '--json'], b.root));
    expect(eventOf(b, hashOf(out)).body).toEqual({
      lease: { ttl: 1_800_000, grace: 120_000, expiresAt: T + 181_000 + 120_000 },
      supersedes: { holder: 'merger-1', expiresAt: T + 120_000, event: hashOf(first) },
    });
    expect(token(b)).toBe('merger-2*+2m');
  });

  it('scenario: takeover needs a ttl', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    at(181_000);
    const out = refused(b, ['claim', b.id, '--as', 'merger-2'], 1, 'usage');
    expect(out.stderr).toContain('--ttl');
    expect(token(b)).toBe('merger-1*!claimable');
  });
});

describe('scenario: expired but not yet claimable', () => {
  it('20 s after expiry another claim exits 4 already-assigned, writes nothing, and list shows !expired', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    at(140_000);
    refused(b, ['claim', b.id, '--as', 'merger-2', '--ttl', '30m'], 4, 'already-assigned');
    expect(token(b)).toBe('merger-1*!expired');
  });
});

describe('scenario: refusal names the lease', () => {
  it('names merger-1, the lease expiry and the claimable time; the hint names it and --wait', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    at(60_000);
    ok(run(['renew', b.id, '--as', 'merger-1'], b.root));
    const expires = T + 60_000 + 1_800_000;
    const out = refused(b, ['claim', b.id, '--as', 'merger-2'], 4, 'already-assigned');
    const [message, hint] = out.stderr.split('\n');
    expect(message).toBe(
      `agentboard: ticket ${b.id} is already assigned to merger-1 (lease expires ${iso(expires)}, claimable from ${iso(expires + 60_000)})`,
    );
    expect(hint).toMatch(/^hint: /);
    expect(hint).toContain(iso(expires + 60_000));
    expect(hint).toContain(
      `'agentboard claim ${b.id} --ttl <duration> --wait --timeout <duration> --as merger-2'`,
    );
  });

  it('scenario: hint for a live lease (the --json error document carries the same hint)', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    const out = run(['claim', b.id, '--as', 'merger-2', '--json'], b.root);
    expect(out.code).toBe(4);
    const doc = oneJson(out) as { error: { hint: string; message: string } };
    expect(doc.error.hint).toContain(`it can be claimed from ${iso(T + 180_000)}`);
    expect(doc.error.hint).toContain('--wait');
    expect(out.stderr).toContain(`hint: ${doc.error.hint}`);
  });

  it('a hold without a lease keeps the plain message and hint', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'impl'], b.root));
    const out = refused(b, ['claim', b.id, '--as', 'merger-2'], 4, 'already-assigned');
    expect(out.stderr.split('\n')[0]).toBe(
      `agentboard: ticket ${b.id} is already assigned to impl`,
    );
    expect(out.stderr).not.toContain('can be claimed from');
  });
});

describe('a retried claim by the holder', () => {
  it('exits 0, writes nothing and reports the current lease', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    at(5000);
    const before = allNames(b.events);
    const out = ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '10m'], b.root));
    expect(out.stdout.split('\n')[0]).toBe(
      `already claimed by merger-1 (lease expires ${iso(T + 120_000)})`,
    );
    expect(allNames(b.events)).toEqual(before);
    expect(oneJson(ok(run(['claim', b.id, '--as', 'merger-1', '--json'], b.root)))).toMatchObject({
      hash: null,
      events: [],
    });
  });
});

describe('the queued refusal', () => {
  it('a claim while others wait exits 4 queued and the hint names the --wait form', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    join_(b, 'merger-2');
    const out = refused(b, ['claim', b.id, '--as', 'merger-3', '--ttl', '30m'], 4, 'queued');
    expect(out.stderr).toContain(
      `hint: other actors are waiting for this ticket and have priority; wait in its queue with 'agentboard claim ${b.id} --ttl <duration> --wait --timeout <duration> --as merger-3'`,
    );
  });
});

describe('scenario: renew by someone else', () => {
  it('exits 4 not-assignee, writes nothing, and the hint says the lock was lost and names show', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    const out = refused(b, ['renew', b.id, '--as', 'merger-2'], 4, 'not-assignee');
    expect(out.stderr).toContain(
      `hint: the lock was lost: you no longer hold this ticket, so stop the work it protects; see who holds it with 'agentboard show ${b.id}'`,
    );
  });

  it('renew without --ttl on a hold without a lease is exit 1 usage', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'impl'], b.root));
    refused(b, ['renew', b.id, '--as', 'impl'], 1, 'usage');
  });
});

describe('scenario: malformed ttl', () => {
  it.each(['10min', '5s', '29s', '8d', '0m', 'm', '-1m'])(
    'claim --ttl %s exits 1 usage naming the duration form and the 30s to 7d range',
    (ttl) => {
      const b = board();
      const out = refused(b, ['claim', b.id, '--as', 'a', '--ttl', ttl], 1, 'usage');
      expect(out.stderr).toContain(
        'invalid --ttl: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 30s to 7d',
      );
    },
  );

  it('is refused before the board is looked up (exit 1 where there is no board)', () => {
    const { root } = project();
    const empty = join(root, 'nowhere');
    const out = run(
      ['claim', '01J9K3', '--as', 'a', '--ttl', '10min'],
      root,
      cliEnv({ AGENTBOARD_DIR: empty }),
    );
    expect(out.code).toBe(1);
    expect(
      run(['renew', '01J9K3', '--as', 'a', '--ttl', '5s'], root, cliEnv({ AGENTBOARD_DIR: empty }))
        .code,
    ).toBe(1);
  });

  it('renew --ttl 10min is exit 1 usage too', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'a', '--ttl', '30m'], b.root));
    refused(b, ['renew', b.id, '--as', 'a', '--ttl', '10min'], 1, 'usage');
  });
});

describe('the --wait arguments on the command line', () => {
  it('scenario: wait needs a timeout on the CLI (exit 1 usage, nothing written)', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    refused(b, ['claim', b.id, '--as', 'a', '--ttl', '30m', '--wait'], 1, 'usage');
  });

  it('--timeout without --wait is exit 1 usage', () => {
    const b = board();
    refused(b, ['claim', b.id, '--as', 'a', '--ttl', '30m', '--timeout', '10m'], 1, 'usage');
  });

  it('--wait without --ttl is exit 1 usage naming --ttl', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    const out = refused(b, ['claim', b.id, '--as', 'a', '--wait', '--timeout', '10m'], 1, 'usage');
    expect(out.stderr).toContain('--ttl');
  });

  it.each(['0s', '2d', '25h', '10min'])(
    '--timeout %s is exit 1 usage naming the 1s to 1d range',
    (timeout) => {
      const b = board();
      ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
      const out = refused(
        b,
        ['claim', b.id, '--as', 'a', '--ttl', '30m', '--wait', '--timeout', timeout],
        1,
        'usage',
      );
      expect(out.stderr).toContain(
        'invalid --timeout: a timeout is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d',
      );
    },
  );
});

describe('scenario: leave the queue', () => {
  it('unqueue exits 0 and show no longer lists merger-3', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    ok(run(['renew', b.id, '--as', 'merger-1'], b.root));
    join_(b, 'merger-2');
    join_(b, 'merger-3', 600_000);
    const before = ok(run(['show', b.id], b.root)).stdout;
    expect(before).toContain(`\n  2 merger-3 (joined ${iso(T)}, ttl 10m)\n`);
    at(1000);
    ok(run(['unqueue', b.id, '--as', 'merger-3'], b.root));
    const after = ok(run(['show', b.id], b.root)).stdout;
    expect(after).not.toContain('merger-3');
    expect(after).toContain(`\n  1 merger-2 (joined ${iso(T)}, ttl 30m)\n`);
    expect(token(b)).toBe('merger-1+29m^1');
  });

  it('unqueue by an actor that is not queued exits 4 invalid-queue, and the show it hints prints the queue and lease', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    join_(b, 'merger-2');
    const out = refused(b, ['unqueue', b.id, '--as', 'merger-3'], 4, 'invalid-queue');
    expect(out.stderr).toContain(`'agentboard show ${b.id}'`);
    const shown = ok(run(['show', b.id], b.root)).stdout;
    expect(shown).toContain(
      `lease: live (grace), ttl 30m, expires ${iso(T + 120_000)}, claimable from ${iso(T + 180_000)}\n`,
    );
    expect(shown).toContain(`queue:\n  1 merger-2 (joined ${iso(T)}, ttl 30m)\n`);
  });
});

describe('scenario: orchestrator breaks a stale lock', () => {
  it('exits 0, clears the assignee, writes ticket.release.force and show names actor, holder and reason', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1'], b.root));
    at(7000);
    const out = ok(
      run(
        [
          'release',
          b.id,
          '--as',
          'orchestrator',
          '--force',
          '--reason',
          'merger-1 crashed',
          '--json',
        ],
        b.root,
      ),
    );
    expect(eventOf(b, hashOf(out))).toMatchObject({
      kind: 'ticket.release.force',
      actor: 'orchestrator',
      body: { holder: 'merger-1', reason: 'merger-1 crashed' },
    });
    expect(token(b)).toBe('-');
    const shown = ok(run(['show', b.id], b.root)).stdout;
    expect(shown).toContain(
      `\nforced release: orchestrator at ${iso(T + 7000)} from merger-1: merger-1 crashed\n`,
    );
  });

  it('scenario: force without a reason exits 1 usage and writes nothing', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1'], b.root));
    refused(b, ['release', b.id, '--as', 'orchestrator', '--force'], 1, 'usage');
    refused(b, ['release', b.id, '--as', 'orchestrator', '--force', '--reason', ''], 1, 'usage');
  });

  it('--reason without --force exits 1 usage', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1'], b.root));
    refused(b, ['release', b.id, '--as', 'merger-1', '--reason', 'done'], 1, 'usage');
  });

  it('scenario: force by the holder exits 1 usage naming plain release', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1'], b.root));
    const out = refused(
      b,
      ['release', b.id, '--as', 'merger-1', '--force', '--reason', 'x'],
      1,
      'usage',
    );
    expect(out.stderr).toContain('without --force');
  });

  it('force on an unassigned ticket exits 4 not-assignee, hinting that there is nothing to force', () => {
    const b = board();
    const out = refused(
      b,
      ['release', b.id, '--as', 'orchestrator', '--force', '--reason', 'x'],
      4,
      'not-assignee',
    );
    expect(out.stderr).toContain(
      `hint: the ticket is not held, so there is nothing to force; see its holder and queue with 'agentboard show ${b.id}'\n`,
    );
  });

  it('a plain release by a non-holder keeps the assignee-only hint', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1'], b.root));
    const out = refused(b, ['release', b.id, '--as', 'merger-2'], 4, 'not-assignee');
    expect(out.stderr).toContain(
      `hint: only the assignee can do this; see who holds the ticket with 'agentboard show ${b.id}'\n`,
    );
  });
});

describe('scenario: set the acceptance window', () => {
  it('config set queue.window 5m writes board.meta 300000, and config get queue.window prints 5m', () => {
    const b = board();
    const out = ok(run(['config', 'set', 'queue.window', '5m', '--as', 'orchestrator'], b.root));
    expect(out.stdout).toBe('set queue.window 5m\n');
    const meta = eventNames(b.events)
      .map((name) => eventOf(b, name.slice(0, -5)))
      .filter((e) => e.kind === 'board.meta');
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({
      actor: 'orchestrator',
      body: { key: 'queue.window', value: 300_000 },
    });
    expect(ok(run(['config', 'get', 'queue.window'], b.root)).stdout).toBe('5m\n');
    expect(ok(run(['config', 'get'], b.root)).stdout).toBe(
      'lease.grace 2m (default)\nqueue.window 5m\n',
    );
    expect(oneJson(ok(run(['config', 'get', '--json'], b.root)))).toEqual({
      settings: [
        { key: 'lease.grace', value: 120_000, default: true },
        { key: 'queue.window', value: 300_000, default: false },
      ],
    });
  });

  it('config set --json is {hash, key, value}', () => {
    const b = board();
    const out = ok(run(['config', 'set', 'lease.grace', '90s', '--as', 'orch', '--json'], b.root));
    const doc = oneJson(out) as { hash: string };
    expect(doc).toEqual({ hash: doc.hash, key: 'lease.grace', value: 90_000 });
    expect(ok(run(['config', 'get', 'lease.grace'], b.root)).stdout).toBe('90s\n');
  });

  it('config get prints the default marked, needs no actor', () => {
    const b = board();
    expect(ok(run(['config', 'get', 'lease.grace'], b.root)).stdout).toBe('2m (default)\n');
  });

  it('config set needs an actor', () => {
    const b = board();
    refused(b, ['config', 'set', 'queue.window', '5m'], 1, 'missing-actor');
  });
});

describe('scenario: unknown key', () => {
  it('config set columns x exits 1 usage listing the two keys and writes nothing', () => {
    const b = board();
    const out = refused(b, ['config', 'set', 'columns', 'x', '--as', 'orchestrator'], 1, 'usage');
    expect(out.stderr).toContain('lease.grace');
    expect(out.stderr).toContain('queue.window');
  });

  it.each(['1h', '29s', '11m', '5min', 'x'])(
    'config set queue.window %s exits 1 usage',
    (value) => {
      const b = board();
      refused(b, ['config', 'set', 'queue.window', value, '--as', 'orchestrator'], 1, 'usage');
    },
  );

  it('config get of an unknown key exits 1 usage', () => {
    const b = board();
    const out = run(['config', 'get', 'columns'], b.root);
    expect(out.code).toBe(1);
  });
});

describe('scenario: reserved actor', () => {
  it('comment --as agentboard exits 1 usage and writes nothing', () => {
    const b = board();
    const out = refused(b, ['comment', b.id, '--as', 'agentboard', 'x'], 1, 'usage');
    expect(out.stderr).toContain('agentboard');
  });

  it.each([
    ['claim', ['--ttl', '30m']],
    ['release', []],
    ['renew', ['--ttl', '30m']],
    ['unqueue', []],
    ['show', []],
  ])('%s --as agentboard exits 1 usage', (command, extra) => {
    const b = board();
    refused(b, [command, b.id, ...extra, '--as', 'agentboard'], 1, 'usage');
  });

  it('inbox and config set refuse it too, and AGENTBOARD_ACTOR=agentboard is refused for a writing command', () => {
    const b = board();
    refused(b, ['inbox', '--as', 'agentboard'], 1, 'usage');
    refused(b, ['config', 'set', 'queue.window', '5m', '--as', 'agentboard'], 1, 'usage');
    refused(b, ['claim', b.id], 1, 'usage', cliEnv({ AGENTBOARD_ACTOR: 'agentboard' }));
  });
});

describe('review round 2: renew by a former holder', () => {
  it('after a forced release with an empty queue: exit 4 not-assignee, the lock-lost hint, nothing written', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    ok(
      run(['release', b.id, '--as', 'orchestrator', '--force', '--reason', 'looked gone'], b.root),
    );
    const out = refused(b, ['renew', b.id, '--as', 'merger-1'], 4, 'not-assignee');
    expect(out.stderr).toContain('hint: the lock was lost');
    refused(b, ['renew', b.id, '--as', 'merger-1', '--ttl', '30m'], 4, 'not-assignee');
  });

  it('after a hand-off by another actor: exit 4 not-assignee with or without --ttl', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    ok(
      run(
        [
          'handoff',
          b.id,
          '--to',
          'impl-9',
          '--status',
          'todo',
          '--note',
          'reassigned',
          '--as',
          'orchestrator',
        ],
        b.root,
      ),
    );
    refused(b, ['renew', b.id, '--as', 'merger-1'], 4, 'not-assignee');
    refused(b, ['renew', b.id, '--as', 'merger-1', '--ttl', '30m'], 4, 'not-assignee');
  });
});

describe('review round 2: secret-looking text', () => {
  it('release --force with a token-shaped reason is refused secret-like before the board is opened', () => {
    const { root } = project();
    const out = run(
      [
        'release',
        '01J9K3',
        '--force',
        '--reason',
        `gone ${SAMPLES['github-token']}`,
        '--as',
        'orchestrator',
      ],
      root,
      cliEnv({ AGENTBOARD_DIR: join(root, 'nowhere') }),
    );
    expect(out.code, out.stderr).toBe(1);
    expect(out.stderr).toContain('secret');
    expect(out.stderr).not.toContain(SAMPLES['github-token']);
  });

  it('config set with a token-shaped value is refused and never repeats the value', () => {
    const b = board();
    const token = SAMPLES['github-token'];
    const out = refused(
      b,
      ['config', 'set', 'queue.window', token, '--as', 'orchestrator'],
      1,
      'usage',
    );
    expect(out.stderr).not.toContain(token);
    const doc = run(
      ['config', 'set', 'queue.window', token, '--as', 'orchestrator', '--json'],
      b.root,
    );
    expect(doc.code).toBe(1);
    expect(doc.stdout).not.toContain(token);
    expect(doc.stderr).not.toContain(token);
    expect(out.stderr).toContain('a setting is <n>s or <n>m');
  });
});

describe('review round 3: refusals never repeat the refused input', () => {
  // A token pasted as a key, a ttl or a timeout must not land in a
  // terminal or a log, in human or --json output.
  const token = SAMPLES['github-token'];

  function neverRepeated(b: Board, args: readonly string[], message: string): void {
    const out = refused(b, [...args], 1, 'usage');
    expect(out.stderr).toContain(message);
    expect(out.stdout).not.toContain(token);
    expect(out.stderr).not.toContain(token);
    const doc = run([...args, '--json'], b.root);
    expect(doc.code, doc.stderr).toBe(1);
    expect(doc.stdout).not.toContain(token);
    expect(doc.stderr).not.toContain(token);
  }

  it('config set with a token-shaped key names only the choices', () => {
    const b = board();
    neverRepeated(
      b,
      ['config', 'set', token, '5m', '--as', 'orchestrator'],
      'config set takes <key> as one of lease.grace, queue.window',
    );
  });

  it('claim and renew with a token-shaped --ttl name only the form', () => {
    const b = board();
    const message =
      'invalid --ttl: a ttl is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 30s to 7d';
    neverRepeated(b, ['claim', b.id, '--as', 'a', '--ttl', token], message);
    ok(run(['claim', b.id, '--as', 'a', '--ttl', '30m'], b.root));
    neverRepeated(b, ['renew', b.id, '--as', 'a', '--ttl', token], message);
  });

  it('claim --wait with a token-shaped --timeout names only the form', () => {
    const b = board();
    ok(run(['claim', b.id, '--as', 'merger-1', '--ttl', '30m'], b.root));
    neverRepeated(
      b,
      ['claim', b.id, '--as', 'a', '--ttl', '30m', '--wait', '--timeout', token],
      'invalid --timeout: a timeout is <n>s, <n>m, <n>h or <n>d with <n> of 1 to 5 digits, from 1s to 1d',
    );
  });
});
