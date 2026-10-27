/**
 * `claim --wait --timeout` on the command line (add-claim-leases task 4.1;
 * board-cli: "Waiting on the command line", "Command surface", "Lease and
 * queue hints", "Lease and queue tools over MCP"): the registry's
 * `streams` predicate, the help text, the synchronous `runCli` refusing to
 * block, and `runCliAsync` blocking until a grant, a timeout or an
 * interrupt, with its human and `--json` output.
 *
 * In process, on the real clock and the real `fs.watch`. No assertion
 * depends on how long anything takes: the tests wait for a condition (the
 * queued line on stdout) before acting, and a timeout of 1 second is the
 * only time that passes on purpose. The fake-clock tests of the wait loop
 * itself are in src/board/__tests__/claim-wait.test.ts.
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Ticket } from '../../events/fold.js';
import { openBoard } from '../../store/board.js';
import { readTicket } from '../../store/cache.js';
import { eventNames, tempDir } from '../../store/__tests__/helpers.js';
import { createMcpServer, type BoardMcpServer } from '../../mcp/server.js';
import { isoTime } from '../../board/leases.js';
import { runCliAsync, type AsyncCliIo } from '../main.js';
import { findCommand } from '../registry.js';
import { renderListLine } from '../render.js';
import type { CommandSpec } from '../types.js';
import { cliEnv, oneJson, project, run, type Run } from './cli-helpers.js';

const SLOW = { timeout: 30_000 };

const servers: BoardMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function claimSpec(): CommandSpec {
  const found = findCommand('claim');
  if (found === undefined) {
    throw new Error('no claim command');
  }
  return found;
}

/** A project with one ad hoc ticket, held by `merger-1` unless `free`. */
function board(free = false): { root: string; boardDir: string; id: string } {
  const { root, boardDir } = project();
  const created = run(
    ['new', 'Merge lock', '--adhoc', 'merge lock', '--as', 'orch', '--json'],
    root,
  );
  expect(created.code, created.stderr).toBe(0);
  const id = (oneJson(created) as { ticket: { id: string } }).ticket.id;
  if (!free) {
    const claimed = run(['claim', id, '--as', 'merger-1'], root);
    expect(claimed.code, claimed.stderr).toBe(0);
  }
  return { root, boardDir, id };
}

/** The ticket as a fresh handle reads it after catching up. */
function ticketOf(boardDir: string, id: string): Ticket {
  const handle = openBoard(boardDir);
  try {
    const ticket = readTicket(handle.db, id);
    if (ticket === null) {
      throw new Error(`no ticket ${id}`);
    }
    return ticket;
  } finally {
    handle.close();
  }
}

/** A running `runCliAsync`, its output so far, and the number of stop signals it asked for. */
interface Running {
  readonly out: { stdout: string; stderr: string; stops: number };
  readonly done: Promise<Run & { stops: number }>;
}

/** Starts `runCliAsync` in process; `signal` is what `stopSignal` returns. */
function startAsync(argv: readonly string[], cwd: string, signal: AbortSignal): Running {
  const out = { stdout: '', stderr: '', stops: 0 };
  const io: AsyncCliIo = {
    argv,
    cwd,
    env: cliEnv(),
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    stopSignal: () => {
      out.stops += 1;
      return signal;
    },
  };
  const done = runCliAsync(io).then((code) => ({
    code,
    stdout: out.stdout,
    stderr: out.stderr,
    stops: out.stops,
  }));
  return { out, done };
}

/** Resolves once `condition` holds, polling; fails after 20 seconds. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function lines(text: string): string[] {
  const all = text.split('\n');
  expect(all.pop()).toBe('');
  return all;
}

const WAIT = (id: string, timeout = '10m'): string[] => [
  'claim',
  id,
  '--as',
  'merger-2',
  '--ttl',
  '30m',
  '--wait',
  '--timeout',
  timeout,
];

describe('the registry', () => {
  it('claim streams exactly when --wait is given', () => {
    const claim = claimSpec();
    expect(claim.stream).toBeTypeOf('function');
    expect(claim.streams?.({ id: 'x', wait: true, timeout: '1m', ttl: '30m' })).toBe(true);
    expect(claim.streams?.({ id: 'x' })).toBe(false);
    expect(claim.streams?.({ id: 'x', ttl: '30m' })).toBe(false);
  });

  it('help claim names the blocking wait and its exit codes', () => {
    const out = run(['help', 'claim'], tempDir(), cliEnv());
    expect(out.code, out.stderr).toBe(0);
    for (const reason of ['wait-timeout', 'wait-interrupted', 'invalid-queue']) {
      expect(out.stdout).toMatch(new RegExp(`^ {2}4 ${reason} {2,}\\S`, 'm'));
    }
    const text = out.stdout.replace(/\s+/g, ' ');
    expect(text).toContain('blocks in the foreground');
    expect(text).toContain('agentboard renew');
    expect(text).toContain('never 0');
    expect(text).toContain('board_claim with wait never blocks');
  });
});

describe('the synchronous runCli never blocks', () => {
  it.each([
    ['held', false],
    ['free', true],
  ])(
    'claim --wait --timeout on a %s ticket: exit 1 streaming-command, nothing written',
    (_name, free) => {
      const { root, boardDir, id } = board(free);
      const before = eventNames(join(boardDir, 'events'));
      const out = run([...WAIT(id), '--json'], root);
      expect(out.code).toBe(1);
      expect(oneJson(out)).toMatchObject({ error: { exitCode: 1, reason: 'streaming-command' } });
      expect(eventNames(join(boardDir, 'events'))).toEqual(before);
    },
  );

  it('validation comes first: a malformed --timeout is still exit 1 usage', () => {
    const { root } = board();
    const out = run([...WAIT('01J9K3', '10min'), '--json'], root);
    expect(out.code).toBe(1);
    expect(oneJson(out)).toMatchObject({ error: { reason: 'usage' } });
  });
});

describe('runCliAsync', () => {
  it('a claim without --wait never asks for a stop signal and prints what runCli prints', async () => {
    const a = board(true);
    const b = board(true);
    const sync = run(['claim', b.id, '--as', 'merger-2', '--ttl', '30m', '--json'], b.root);
    const running = startAsync(
      ['claim', a.id, '--as', 'merger-2', '--ttl', '30m', '--json'],
      a.root,
      new AbortController().signal,
    );
    const out = await running.done;
    expect(out.stops).toBe(0);
    expect(out.code).toBe(sync.code);
    expect(Object.keys(oneJson(out) as object)).toEqual(Object.keys(oneJson(sync) as object));
  });

  it('claims at once on a free ticket: exit 0, the claim --ttl lines', SLOW, async () => {
    const { root, boardDir, id } = board(true);
    const running = startAsync(WAIT(id), root, new AbortController().signal);
    const out = await running.done;
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
    const ticket = ticketOf(boardDir, id);
    expect(ticket.assignee).toBe('merger-2');
    expect(lines(out.stdout)).toEqual([
      renderListLine(ticket),
      `confirm the lease with 'agentboard renew ${id} --as merger-2' before ${isoTime(ticket.lease?.expiresAt ?? 0)}`,
    ]);
  });

  it('claims at once with --json: one document, queued false', SLOW, async () => {
    const { root, id } = board(true);
    const out = await startAsync([...WAIT(id), '--json'], root, new AbortController().signal).done;
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as { hash: string | null; queued: boolean; ticket: Ticket };
    expect(doc.queued).toBe(false);
    expect(doc.hash).not.toBeNull();
    expect(doc.ticket.assignee).toBe('merger-2');
  });

  it(
    'scenario: wait times out: the queued line, exit 4 wait-timeout with the inbox hint, the actor left the queue',
    SLOW,
    async () => {
      const { root, boardDir, id } = board();
      const out = await startAsync(WAIT(id, '1s'), root, new AbortController().signal).done;
      expect(out.code).toBe(4);
      expect(out.stops).toBe(1);
      expect(out.stdout).toBe(`queued for ${id} at position 1, held by merger-1\n`);
      expect(out.stderr).toContain('agentboard: ');
      expect(out.stderr).toContain(
        "hint: the wait timed out and you left the queue; see what happened with 'agentboard inbox --as merger-2', then wait again or report ready\n",
      );
      const ticket = ticketOf(boardDir, id);
      expect(ticket.queue).toEqual([]);
      expect(ticket.assignee).toBe('merger-1');
    },
  );

  it(
    'wait-timeout with --json: the queued document, then the error document, one per line',
    SLOW,
    async () => {
      const { root, id } = board();
      const out = await startAsync(
        [...WAIT(id, '1s'), '--json'],
        root,
        new AbortController().signal,
      ).done;
      expect(out.code).toBe(4);
      const docs = lines(out.stdout).map((line) => JSON.parse(line) as unknown);
      expect(docs).toHaveLength(2);
      expect(docs[0]).toEqual({ queued: true, position: 1, holder: 'merger-1', ticket: id });
      expect(docs[1]).toMatchObject({ error: { exitCode: 4, reason: 'wait-timeout' } });
    },
  );

  it(
    'interrupted: leaves the queue and exits 4 wait-interrupted with the wait-again hint',
    SLOW,
    async () => {
      const { root, boardDir, id } = board();
      const controller = new AbortController();
      const running = startAsync(WAIT(id), root, controller.signal);
      await until(() => running.out.stdout.includes('queued for'), 'the queued line');
      expect(running.out.stops).toBe(1);
      expect(ticketOf(boardDir, id).queue.map((w) => w.actor)).toEqual(['merger-2']);
      controller.abort();
      const out = await running.done;
      expect(out.code).toBe(4);
      expect(out.stderr).toContain(
        `hint: the wait was interrupted and you left the queue; to wait again run 'agentboard claim ${id} --ttl <duration> --wait --timeout <duration> --as merger-2'\n`,
      );
      expect(ticketOf(boardDir, id).queue).toEqual([]);
    },
  );

  it('interrupted with --json: the error document has reason wait-interrupted', SLOW, async () => {
    const { root, id } = board();
    const controller = new AbortController();
    const running = startAsync([...WAIT(id), '--json'], root, controller.signal);
    await until(() => running.out.stdout.includes('"queued":true'), 'the queued document');
    controller.abort();
    const out = await running.done;
    expect(out.code).toBe(4);
    const docs = lines(out.stdout).map((line) => JSON.parse(line) as unknown);
    expect(docs[1]).toMatchObject({ error: { exitCode: 4, reason: 'wait-interrupted' } });
  });

  it(
    'granted on release: exit 0, the list line and the renew line with the acceptance deadline',
    SLOW,
    async () => {
      const { root, boardDir, id } = board();
      const running = startAsync(WAIT(id, '1m'), root, new AbortController().signal);
      await until(() => running.out.stdout.includes('queued for'), 'the queued line');
      const released = run(['release', id, '--as', 'merger-1'], root);
      expect(released.code, released.stderr).toBe(0);
      const out = await running.done;
      expect(out.code, out.stderr).toBe(0);
      expect(out.stderr).toBe('');
      const ticket = ticketOf(boardDir, id);
      expect(ticket.assignee).toBe('merger-2');
      const lease = ticket.lease;
      expect(lease?.confirmed).toBe(false);
      expect(lines(out.stdout)).toEqual([
        `queued for ${id} at position 1, held by merger-1`,
        renderListLine(ticket),
        `accept the grant with 'agentboard renew ${id} --as merger-2' before ${isoTime(lease?.expiresAt ?? 0)}`,
      ]);
    },
  );

  it(
    'granted with --json: the queued document, then {queued: false, grant, acceptBy, ticket}',
    SLOW,
    async () => {
      const { root, boardDir, id } = board();
      const running = startAsync([...WAIT(id, '1m'), '--json'], root, new AbortController().signal);
      await until(() => running.out.stdout.includes('"queued":true'), 'the queued document');
      expect(run(['release', id, '--as', 'merger-1'], root).code).toBe(0);
      const out = await running.done;
      expect(out.code, out.stderr).toBe(0);
      const docs = lines(out.stdout).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(docs).toHaveLength(2);
      expect(docs[0]).toEqual({ queued: true, position: 1, holder: 'merger-1', ticket: id });
      const ticket = ticketOf(boardDir, id);
      const final = docs[1] ?? {};
      expect(Object.keys(final)).toEqual(['queued', 'grant', 'acceptBy', 'ticket']);
      expect(final.queued).toBe(false);
      expect(final.grant).toBe(ticket.lease?.event);
      expect(final.acceptBy).toBe(ticket.lease?.expiresAt);
      expect(final.ticket).toMatchObject({ id, assignee: 'merger-2', queue: [] });
    },
  );
});

describe('a waiter handed the ticket', () => {
  it('exits 0 as a retried claim: already claimed by, then the list line', SLOW, async () => {
    const { root, boardDir, id } = board();
    const running = startAsync(WAIT(id, '1m'), root, new AbortController().signal);
    await until(() => running.out.stdout.includes('queued for'), 'the queued line');
    const handed = run(
      [
        'handoff',
        id,
        '--as',
        'merger-1',
        '--to',
        'merger-2',
        '--status',
        'todo',
        '--note',
        'yours',
      ],
      root,
    );
    expect(handed.code, handed.stderr).toBe(0);
    const out = await running.done;
    expect(out.code, out.stderr).toBe(0);
    const ticket = ticketOf(boardDir, id);
    expect(ticket.assignee).toBe('merger-2');
    expect(lines(out.stdout)).toEqual([
      `queued for ${id} at position 1, held by merger-1`,
      'already claimed by merger-2',
      renderListLine(ticket),
    ]);
  });
});

describe('board_claim with wait stays non-blocking over MCP', () => {
  it('returns the queued document synchronously from the tool call', () => {
    const { root, id } = board();
    const server = createMcpServer({ cwd: root, env: cliEnv(), stderr: () => undefined });
    servers.push(server);
    const result = server.callTool('board_claim', {
      id,
      ttl: '30m',
      wait: true,
      as: 'merger-2',
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      queued: true,
      position: 1,
      holder: 'merger-1',
      ticket: id,
    });
  });
});
