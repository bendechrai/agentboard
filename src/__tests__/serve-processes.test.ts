/**
 * `agentboard serve` against real processes (board-web: "Serve command"
 * scenario "Start and stop", "Live event stream" scenario "CLI write
 * reaches the browser", "Reads never block writers" scenario "Slow client
 * does not block writers"). Runs the built CLI through the multi-process harness; run `npm run build` first
 * when running vitest directly.
 *
 * Every server listens on 127.0.0.1 with port 0. Every child's stdout is
 * a pipe, so none of them opens a browser by default (checked with fake
 * openers on PATH below).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openBoard } from '../store/board.js';
import type { AppendMessage } from '../view/types.js';
import {
  open,
  openStream,
  get,
  scratch,
  serve,
  until,
  type StreamClient,
} from '../web/__tests__/web-helpers.js';
import {
  boardProject,
  cliEnv,
  oneDocument,
  runCliAsync,
  startCli,
  startGated,
  type CliProcess,
} from './harness/processes.js';

const TASK = ['--task', 'openspec:add-board-web#3'];

/** Creates a ticket through the CLI and returns its id. */
async function newTicket(root: string): Promise<string> {
  const out = await runCliAsync(['new', 'Served', ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

/** The parsed `--json` start-up line of a `serve` child. */
interface Startup {
  url: string;
  port: number;
  token: string;
  writable: boolean;
  actor: string | null;
}

async function startup(proc: CliProcess): Promise<Startup> {
  await until(
    () => proc.stdout().includes('\n'),
    15_000,
    `the start-up line (stderr: ${proc.stderr()})`,
  );
  return JSON.parse(proc.stdout().split('\n')[0] ?? '') as Startup;
}

/** The appends received by `client`. */
function appends(client: StreamClient): AppendMessage[] {
  return client
    .events()
    .filter((e) => e.event === 'append')
    .map((e) => JSON.parse(e.data) as AppendMessage);
}

describe('scenario: Start and stop', () => {
  it(
    'prints one JSON line, serves, and exits 0 on SIGINT with nothing else on stdout',
    { timeout: 30_000 },
    async () => {
      const { root } = boardProject();
      await newTicket(root);
      const proc = startCli({ argv: ['serve', '--port', '0', '--json'] }, root);
      const line = await startup(proc);
      expect(Object.keys(line)).toEqual(['url', 'port', 'token', 'writable', 'actor']);
      expect(typeof line.port).toBe('number');
      expect(line.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(line.writable).toBe(false);
      expect(line.actor).toBeNull();
      expect(line.url).toBe(`http://127.0.0.1:${String(line.port)}/#token=${line.token}`);
      const board = await get(line, '/api/board');
      expect(board.status).toBe(200);
      expect((await get({ port: line.port, token: 'x'.repeat(43) }, '/api/board')).status).toBe(
        401,
      );
      process.kill(proc.pid, 'SIGINT');
      const result = await proc.exited;
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stdout.split('\n')).toEqual([JSON.stringify(line), '']);
      expect(result.stderr).toBe('');
      expect(result.stderr).not.toContain(line.token);
    },
  );

  it('exits 0 on SIGTERM, closing an open stream', { timeout: 30_000 }, async () => {
    const { root } = boardProject();
    await newTicket(root);
    const proc = startCli({ argv: ['serve', '--json'] }, root);
    const line = await startup(proc);
    const client = await openStream(line);
    await client.until((c) => appends(c).length > 0, 5000, 'the first event');
    process.kill(proc.pid, 'SIGTERM');
    const result = await proc.exited;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    await client.until((c) => c.ended(), 5000, 'the stream to end');
  });

  it(
    'warns when --open cannot find a system opener, and keeps serving',
    { timeout: 30_000 },
    async () => {
      const { root } = boardProject();
      // An empty PATH: the opener (looked up by name) cannot be found.
      const proc = startCli(
        { argv: ['serve', '--open', '--json'], env: cliEnv({ PATH: scratch() }) },
        root,
      );
      const line = await startup(proc);
      await proc.waitForStderr(/^agentboard: could not open a browser: /m, 10_000);
      expect(proc.stderr()).not.toContain(line.token);
      expect((await get(line, '/api/session')).status).toBe(200);
      process.kill(proc.pid, 'SIGINT');
      expect((await proc.exited).code).toBe(0);
    },
  );
});

/**
 * A directory holding fake `open` and `xdg-open` scripts, which append
 * their arguments as one line to the file named by `FAKE_OPENER_LOG`.
 */
function fakeOpeners(): string {
  const bin = scratch();
  for (const name of ['open', 'xdg-open']) {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_OPENER_LOG"\n');
    chmodSync(path, 0o755);
  }
  return bin;
}

// board-web: "Serve command" scenario "No browser for a script": every other test in this repository spawns serve
// with a piped stdout, so none of them may ever run a system opener.
describe('scenario: No browser for a script (built CLI, stdout a pipe)', () => {
  it.skipIf(process.platform === 'win32')(
    'never runs the system opener without flags, while --open on the same PATH does',
    { timeout: 60_000 },
    async () => {
      const { root } = boardProject();
      const bin = fakeOpeners();
      const logs = scratch();
      const plainLog = join(logs, 'plain.log');
      const openLog = join(logs, 'open.log');
      // Every other condition of the auto check holds (no CI, no SSH, a
      // display for linux): only the piped stdout keeps the browser shut.
      const env = (log: string) =>
        cliEnv({
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          FAKE_OPENER_LOG: log,
          CI: undefined,
          SSH_CONNECTION: undefined,
          SSH_CLIENT: undefined,
          SSH_TTY: undefined,
          DISPLAY: ':0',
          WAYLAND_DISPLAY: undefined,
        });
      const plain = startCli({ argv: ['serve'], env: env(plainLog) }, root);
      await until(
        () => plain.stdout().includes('\n'),
        15_000,
        `the start-up line (stderr: ${plain.stderr()})`,
      );
      const line = plain.stdout().split('\n')[0] ?? '';
      const match = /^serving .+ read-only at (http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+))$/.exec(
        line,
      );
      expect(match, line).not.toBeNull();
      const endpoint = { port: Number(match?.[2]), token: match?.[3] ?? '' };
      // The control: a second server started after the first has printed
      // its start-up line, with --open and the same fake openers. Once its
      // opener has run, the first server has long passed its own decision.
      const forced = startCli({ argv: ['serve', '--open', '--json'], env: env(openLog) }, root);
      const forcedLine = await startup(forced);
      await until(
        () => existsSync(openLog) && readFileSync(openLog, 'utf8').includes(forcedLine.url),
        15_000,
        `the fake opener of the --open server (stderr: ${forced.stderr()})`,
      );
      expect(existsSync(plainLog)).toBe(false);
      expect((await get(endpoint, '/api/session')).status).toBe(200);
      process.kill(plain.pid, 'SIGINT');
      process.kill(forced.pid, 'SIGINT');
      const [plainResult, forcedResult] = await Promise.all([plain.exited, forced.exited]);
      expect(plainResult).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(plainResult.stdout).toBe(`${line}\n`);
      expect(forcedResult).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(existsSync(plainLog)).toBe(false);
    },
  );
});

describe('scenario: CLI write reaches the browser', () => {
  it(
    'delivers a move by another process as an append with the ticket in tests within 3 seconds',
    { timeout: 30_000 },
    async () => {
      const { root, boardDir } = boardProject();
      const id = await newTicket(root);
      // Default feed timing: fs.watch with the settle delay, and 2 second polling.
      const server = await serve(open(boardDir));
      const client = await openStream(server);
      await client.until((c) => appends(c).length === 1, 5000, 'the first event');
      const out = await runCliAsync(['move', id, 'tests', '--as', 'a', '--json'], root);
      expect(out.code, out.stderr).toBe(0);
      const written = Date.now();
      await client.until((c) => appends(c).length === 2, 3000, 'the move');
      expect(Date.now() - written).toBeLessThan(3000);
      const append = appends(client)[1];
      expect(append?.events.map((e) => [e.kind, e.actor])).toEqual([['ticket.move', 'a']]);
      expect(append?.tickets.map((t) => [t.id, t.status])).toEqual([[id, 'tests']]);
    },
  );
});

describe('scenario: Slow client does not block writers', () => {
  it(
    'twenty concurrent comment processes exit 0 while a stream client does not read, and rebuild --check agrees',
    { timeout: 120_000 },
    async () => {
      const { root, boardDir } = boardProject();
      const id = await newTicket(root);
      const serveProc = startCli({ argv: ['serve', '--json'] }, root);
      const line = await startup(serveProc);
      const reader = await openStream(line);
      await reader.until((c) => appends(c).length === 1, 5000, 'the first event');
      reader.pause();
      const stalled = await openStream(line, { paused: true });
      expect(stalled.status).toBe(200);
      const texts = Array.from({ length: 20 }, (_, n) => `c${String(n)}`);
      const gated = await startGated(
        texts.map((text, n) => ({
          argv: ['comment', id, '--as', `agent-${String(n)}`, text, '--json'],
        })),
        root,
      );
      gated.open();
      const results = await Promise.all(gated.procs.map((p) => p.exited));
      for (const result of results) {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: '' });
      }
      const check = await runCliAsync(['rebuild', '--check', '--json'], root);
      expect(check.code, check.stdout).toBe(0);
      // The server kept serving: the reading client gets every comment once it reads again.
      reader.resume();
      await reader.until(
        (c) =>
          appends(c)
            .flatMap((m) => m.events)
            .filter((e) => e.kind === 'ticket.comment').length === 20,
        10_000,
        'the twenty comments',
      );
      const board = openBoard(boardDir);
      try {
        expect(board.db.prepare('SELECT count(*) AS n FROM comments').get()?.n).toBe(20);
      } finally {
        board.close();
      }
      process.kill(serveProc.pid, 'SIGINT');
      expect((await serveProc.exited).code).toBe(0);
    },
  );
});
