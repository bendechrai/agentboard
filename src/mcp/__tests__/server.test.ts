/**
 * Task 9.2, in process (board-cli: "MCP server"): the server built by
 * `createMcpServer`, driven by the SDK client over an in-memory transport
 * and through `callTool` directly, and `serveMcp` over in-memory streams.
 * The child-process versions of the same scenarios are in spawn.test.ts;
 * these give the coverage a spawned server cannot.
 *
 * `board_inbox` tests need task group 5 and are red until it is in the
 * branch.
 */

import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { cliEnv, oneJson, project, run, written } from '../../cli/__tests__/cli-helpers.js';
import { eventNames, tempDir } from '../../store/__tests__/helpers.js';
import { VERSION } from '../../version.js';
import {
  SERVER_NAME,
  createMcpServer,
  serveMcp,
  type BoardMcpServer,
  type ToolCallResult,
} from '../server.js';
import { toolDefinitions } from '../tools.js';

const TASK = 'openspec:add-board-core#9';

const servers: BoardMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

interface Harness {
  root: string;
  boardDir: string;
  server: BoardMcpServer;
  stderr: () => string;
}

/**
 * A server on a fresh board; `env` extends `cliEnv()` (no actor by
 * default); `actor` is the server's `--as`.
 */
function serve(env: Record<string, string | undefined> = {}, actor?: string): Harness {
  const { root, boardDir } = project();
  let err = '';
  const server = createMcpServer({
    cwd: root,
    env: cliEnv(env),
    ...(actor === undefined ? {} : { actor }),
    stderr: (text) => {
      err += text;
    },
  });
  servers.push(server);
  return { root, boardDir, server, stderr: () => err };
}

/** An SDK client connected to `server` over an in-memory pair. */
async function connect(server: BoardMcpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agentboard-test', version: '0.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

function count(boardDir: string): number {
  return eventNames(join(boardDir, 'events')).length;
}

/** The structured content of a successful call. */
function ok(result: ToolCallResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  expect(result.content).toHaveLength(1);
  return result.structuredContent;
}

/**
 * The structured content of a failed call. Its text content is the
 * message, then `hint: <hint>` on a second line when there is a hint
 * (add-agent-guidance task 2.2).
 */
function failed(result: ToolCallResult): {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
} {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const content = result.structuredContent as { message: string; hint: string | null };
  expect(result.content).toEqual([
    {
      type: 'text',
      text: content.hint === null ? content.message : `${content.message}\nhint: ${content.hint}`,
    },
  ]);
  expect(Object.keys(result.structuredContent).sort()).toEqual([
    'exitCode',
    'hint',
    'message',
    'reason',
  ]);
  return result.structuredContent as {
    exitCode: number;
    reason: string | null;
    message: string;
    hint: string | null;
  };
}

function newId(h: Harness, actor = 'orch'): string {
  const doc = ok(h.server.callTool('board_new', { title: 'A ticket', task: TASK, as: actor }));
  return (doc.ticket as { id: string }).id;
}

describe('start-up', () => {
  it('refuses to start without a board, naming the path, exit 2', () => {
    const root = tempDir();
    const err = expectBoardError(
      () => createMcpServer({ cwd: root, env: cliEnv(), stderr: () => undefined }),
      2,
      'board-not-found',
    );
    expect(err.message).toContain(join(root, '.board'));
  });

  it('locates the board once, with AGENTBOARD_DIR honoured', () => {
    const { root, boardDir } = project();
    const server = createMcpServer({
      cwd: tempDir(),
      env: cliEnv({ AGENTBOARD_DIR: boardDir }),
      stderr: () => undefined,
    });
    servers.push(server);
    expect(server.boardDir).toBe(boardDir);
    expect(root).not.toBe('');
  });
});

describe('over the protocol', () => {
  it('announces the server name and version and lists the generated tools', async () => {
    const h = serve();
    const client = await connect(h.server);
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: VERSION });
    expect(client.getServerCapabilities()).toHaveProperty('tools');
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(toolDefinitions().map((t) => t.name));
    for (const t of toolDefinitions()) {
      const published = listed.tools.find((l) => l.name === t.name);
      expect(published?.description, t.name).toBe(t.description);
      expect(published?.inputSchema, t.name).toEqual(t.inputSchema);
      expect(published?.annotations, t.name).toMatchObject(t.annotations);
    }
  });

  it('scenario: round trip new, claim, handoff, show equals show --json', async () => {
    const h = serve();
    const client = await connect(h.server);
    const created = await client.callTool({
      name: 'board_new',
      arguments: { title: 'Round trip', task: TASK, label: ['mcp'], as: 'orch' },
    });
    expect(created.isError).toBeFalsy();
    const id = (created.structuredContent as { ticket: { id: string } }).ticket.id;
    const claimed = await client.callTool({ name: 'board_claim', arguments: { id, as: 'impl' } });
    expect(claimed.structuredContent).toMatchObject({ ticket: { id, assignee: 'impl' } });
    const handed = await client.callTool({
      name: 'board_handoff',
      arguments: { id, to: 'test-author', status: 'tests', note: 'green, 96%', as: 'impl' },
    });
    expect(handed.isError).toBeFalsy();
    const shown = await client.callTool({ name: 'board_show', arguments: { id } });
    const cli = oneJson(run(['show', id, '--json'], h.root));
    expect(shown.structuredContent).toEqual(cli);
    expect(shown.content).toEqual([{ type: 'text', text: JSON.stringify(cli) }]);
    expect(cli).toMatchObject({
      ticket: {
        assignee: 'test-author',
        status: 'tests',
        comments: [{ actor: 'impl', text: 'green, 96%' }],
      },
    });
    expect(count(h.boardDir)).toBe(3);
  });

  it('scenario: an already-assigned claim is a tool error naming the holder, writing nothing', async () => {
    const h = serve();
    const client = await connect(h.server);
    const id = newId(h);
    await client.callTool({ name: 'board_claim', arguments: { id, as: 'impl' } });
    const before = count(h.boardDir);
    const refused = await client.callTool({
      name: 'board_claim',
      arguments: { id, as: 'reviewer' },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
    expect((refused.structuredContent as { message: string }).message).toContain('impl');
    expect(count(h.boardDir)).toBe(before);
  });

  it('reports failures as tool errors, never as protocol errors', async () => {
    const h = serve();
    const client = await connect(h.server);
    const usage = await client.callTool({ name: 'board_new', arguments: { title: 'x', as: 'a' } });
    expect(usage.isError).toBe(true);
    expect(usage.structuredContent).toMatchObject({ exitCode: 1, reason: 'needs-task-or-adhoc' });
    const unknown = await client.callTool({ name: 'board_nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect((unknown.structuredContent as { message: string }).message).toContain('board_nope');
  });
});

describe('callTool', () => {
  it('scenario: a missing actor fails as the CLI does, before writing', () => {
    const h = serve();
    const id = newId(h);
    const before = count(h.boardDir);
    const err = failed(h.server.callTool('board_comment', { id, text: 'hi' }));
    expect(err).toMatchObject({ exitCode: 1, reason: 'missing-actor' });
    expect(err.message).toContain('--as');
    expect(err.message).toContain('AGENTBOARD_ACTOR');
    // Exactly the CLI's exit code, reason and message; the hint is written
    // for a tool caller (add-agent-guidance task 2.2), so it differs.
    const cli = (
      oneJson(run(['comment', id, 'hi', '--json'], h.root)) as {
        error: { exitCode: number; reason: string; message: string; hint: string };
      }
    ).error;
    expect({ exitCode: err.exitCode, reason: err.reason, message: err.message }).toEqual({
      exitCode: cli.exitCode,
      reason: cli.reason,
      message: cli.message,
    });
    expect(err.hint).not.toBe(cli.hint);
    expect(count(h.boardDir)).toBe(before);
  });

  it("falls back to the server's AGENTBOARD_ACTOR, and as wins over it", () => {
    const h = serve({ AGENTBOARD_ACTOR: 'env-agent' });
    const doc = ok(h.server.callTool('board_new', { title: 'T', task: TASK }));
    expect(doc).toMatchObject({ ticket: { createdBy: 'env-agent' } });
    const id = (doc.ticket as { id: string }).id;
    expect(ok(h.server.callTool('board_claim', { id, as: 'given' }))).toMatchObject({
      ticket: { assignee: 'given' },
    });
  });

  it("uses the server's --as when the call has no as", () => {
    const h = serve({}, 'server-agent');
    const doc = ok(h.server.callTool('board_new', { title: 'T', task: TASK }));
    expect(doc).toMatchObject({ ticket: { createdBy: 'server-agent' } });
    const id = (doc.ticket as { id: string }).id;
    expect(ok(h.server.callTool('board_claim', { id }))).toMatchObject({
      ticket: { assignee: 'server-agent' },
    });
  });

  it("lets the call's as override the server's --as", () => {
    const h = serve({}, 'server-agent');
    const id = newId(h, 'call-agent');
    expect(ok(h.server.callTool('board_show', { id }))).toMatchObject({
      ticket: { createdBy: 'call-agent' },
    });
    expect(ok(h.server.callTool('board_claim', { id, as: 'call-agent' }))).toMatchObject({
      ticket: { assignee: 'call-agent' },
    });
  });

  it("puts the server's --as before AGENTBOARD_ACTOR, and an empty one is absent", () => {
    const h = serve({ AGENTBOARD_ACTOR: 'env-agent' }, 'server-agent');
    expect(ok(h.server.callTool('board_new', { title: 'T', task: TASK }))).toMatchObject({
      ticket: { createdBy: 'server-agent' },
    });
    const empty = serve({ AGENTBOARD_ACTOR: 'env-agent' }, '');
    expect(ok(empty.server.callTool('board_new', { title: 'T', task: TASK }))).toMatchObject({
      ticket: { createdBy: 'env-agent' },
    });
    const none = serve({}, '');
    expect(failed(none.server.callTool('board_new', { title: 'T', task: TASK }))).toMatchObject({
      exitCode: 1,
      reason: 'missing-actor',
    });
  });

  it('needs no actor for a read-only tool and ignores a given one', () => {
    const h = serve();
    const id = newId(h);
    expect(ok(h.server.callTool('board_show', { id }))).toMatchObject({ ticket: { id } });
    expect(ok(h.server.callTool('board_show', { id, as: 'x' }))).toMatchObject({
      ticket: { id },
    });
  });

  it('returns the --json document of a writing command, text included', () => {
    const h = serve();
    const id = newId(h);
    const result = h.server.callTool('board_comment', { id, text: 'hello', as: 'orch' });
    const doc = ok(result);
    expect(typeof doc.hash).toBe('string');
    expect(doc).toMatchObject({ ticket: { id, comments: [{ text: 'hello' }] } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(doc) }]);
  });

  it('wraps an array document as { items } and keeps the array as the text', () => {
    const h = serve();
    const id = newId(h);
    const result = h.server.callTool('board_list', {});
    const cli = oneJson(run(['list', '--json'], h.root));
    expect(ok(result)).toEqual({ items: cli });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(cli) }]);
    const raw = h.server.callTool('board_show', { id, raw: true });
    expect(ok(raw)).toEqual({ items: oneJson(run(['show', id, '--raw', '--json'], h.root)) });
  });

  it('sees events other processes wrote after start-up', () => {
    const h = serve();
    const id = written(
      run(['new', 'From the CLI', '--task', TASK, '--as', 'cli', '--json'], h.root),
    ).id;
    expect(ok(h.server.callTool('board_show', { id }))).toMatchObject({
      ticket: { id, createdBy: 'cli' },
    });
    run(['comment', id, 'later', '--as', 'cli'], h.root);
    expect(ok(h.server.callTool('board_show', { id }))).toMatchObject({ events: 2 });
  });

  it('maps an unknown ticket to exit 4 and argument errors to exit 1', () => {
    const h = serve();
    expect(
      failed(h.server.callTool('board_comment', { id: '01NOPE00', text: 'x', as: 'a' })),
    ).toMatchObject({ exitCode: 4, reason: 'unknown-ticket' });
    expect(failed(h.server.callTool('board_claim', { id: 1, as: 'a' }))).toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
    expect(
      failed(h.server.callTool('board_move', { id: '01NOPE00', status: 'nope', as: 'a' })),
    ).toMatchObject({ exitCode: 1, reason: 'usage' });
  });

  it('refuses the excluded commands as unknown tools', () => {
    const h = serve();
    for (const name of ['board_init', 'board_watch', 'board_rebuild', 'board_sync', 'board_mcp']) {
      expect(failed(h.server.callTool(name, {})), name).toMatchObject({
        exitCode: 1,
        reason: 'usage',
      });
    }
  });

  it('reports a board removed after start-up as exit 2', () => {
    const h = serve();
    rmSync(h.boardDir, { recursive: true, force: true });
    expect(failed(h.server.callTool('board_list', {}))).toMatchObject({
      exitCode: 2,
      reason: 'board-not-found',
    });
  });

  it('prints open diagnostics to stderr, not into the result', () => {
    const h = serve();
    newId(h);
    // A stale temporary file is reaped by the next open and reported.
    const tmp = join(h.boardDir, 'events', '.tmp-stale');
    writeFileSync(tmp, '{}');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(tmp, old, old);
    const result = h.server.callTool('board_list', {});
    expect(result.isError).toBeUndefined();
    expect(h.stderr()).toContain(`agentboard: removed stale temporary file ${tmp}`);
  });

  it('board_inbox needs an actor and returns the inbox document (needs task group 5)', () => {
    const h = serve();
    newId(h);
    expect(failed(h.server.callTool('board_inbox', {}))).toMatchObject({
      exitCode: 1,
      reason: 'missing-actor',
    });
    expect(ok(h.server.callTool('board_inbox', { as: 'watcher', peek: true }))).toMatchObject({
      actor: 'watcher',
    });
  });
});

describe('serveMcp', () => {
  /** Collects written text. */
  function sink(): { stream: PassThrough; text: () => string } {
    const stream = new PassThrough();
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
    });
    return { stream, text: () => text };
  }

  async function until(check: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error('timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' },
    },
  };

  it('exits 2 without a board, printing only to stderr', async () => {
    const root = tempDir();
    const out = sink();
    let err = '';
    const code = await serveMcp({
      cwd: root,
      env: cliEnv(),
      stdin: new PassThrough(),
      stdout: out.stream,
      stderr: (text) => {
        err += text;
      },
    });
    expect(code).toBe(2);
    expect(out.text()).toBe('');
    expect(err).toMatch(/^agentboard: no board found at /);
    expect(err).toContain(join(root, '.board'));
  });

  it('answers on stdout with protocol messages only and exits 0 when stdin ends', async () => {
    const { root } = project();
    const stdin = new PassThrough();
    const out = sink();
    const serving = serveMcp({
      cwd: root,
      env: cliEnv(),
      stdin,
      stdout: out.stream,
      stderr: () => undefined,
    });
    stdin.write(`${JSON.stringify(INIT)}\n`);
    await until(() => out.text().includes('"id":1'));
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await until(() => out.text().includes('"id":2'));
    stdin.end();
    expect(await serving).toBe(0);
    const lines = out.text().trimEnd().split('\n');
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    const listed = lines.map(
      (l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[] } },
    );
    expect(listed.find((m) => m.id === 2)?.result?.tools).toHaveLength(toolDefinitions().length);
  });

  /**
   * Starts `serveMcp` on in-memory streams and completes an initialize
   * exchange, so the stdio transport is listening on `stdin`.
   */
  async function initialized(): Promise<{
    stdin: PassThrough;
    out: { stream: PassThrough; text: () => string };
    err: () => string;
    serving: Promise<number>;
  }> {
    const { root } = project();
    const stdin = new PassThrough();
    const out = sink();
    let err = '';
    const serving = serveMcp({
      cwd: root,
      env: cliEnv(),
      stdin,
      stdout: out.stream,
      stderr: (text) => {
        err += text;
      },
    });
    stdin.write(`${JSON.stringify(INIT)}\n`);
    await until(() => out.text().includes('"id":1'));
    return { stdin, out, err: () => err, serving };
  }

  /** Resolves with `promise`, or rejects when it takes longer than `ms`. */
  function within<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`still serving after ${String(ms)} ms`));
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  it('shuts down with exit 0 and one stderr line when stdin emits an error', async () => {
    const { stdin, out, err, serving } = await initialized();
    stdin.emit('error', new Error('boom'));
    expect(await within(serving, 3000)).toBe(0);
    expect(err()).toMatch(/^agentboard: [^\n]*stdin[^\n]*boom\n$/);
    // The transport is detached from stdin: the server is closed.
    expect(stdin.listenerCount('data')).toBe(0);
    for (const line of out.text().trimEnd().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  it('prints the diagnostic once when stdin is destroyed with an error', async () => {
    const { stdin, out, err, serving } = await initialized();
    stdin.destroy(new Error('boom'));
    expect(await within(serving, 3000)).toBe(0);
    expect(err()).toMatch(/^agentboard: [^\n]*stdin[^\n]*boom\n$/);
    expect(stdin.listenerCount('data')).toBe(0);
    for (const line of out.text().trimEnd().split('\n')) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  it('stops and exits 0 when the signal aborts', async () => {
    const { root } = project();
    const controller = new AbortController();
    const serving = serveMcp({
      cwd: root,
      env: cliEnv(),
      stdin: new PassThrough(),
      stdout: sink().stream,
      stderr: () => undefined,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await serving).toBe(0);
  });
});

describe('help words in tool arguments (add-agent-guidance group 1 ruling)', () => {
  it('writes a comment whose text is --help or -h, not a help request', () => {
    const h = serve();
    const id = newId(h);
    for (const text of ['--help', '-h']) {
      const doc = ok(h.server.callTool('board_comment', { id, text, as: 'orch' }));
      expect(typeof doc.hash, text).toBe('string');
    }
    const shown = ok(h.server.callTool('board_show', { id })) as {
      ticket: { comments: { text: string }[] };
    };
    expect(shown.ticket.comments.map((c) => c.text)).toEqual(['--help', '-h']);
  });

  it('takes --help and -h as flag values', () => {
    const h = serve();
    const created = ok(
      h.server.callTool('board_new', {
        title: '-h',
        description: '--help',
        task: TASK,
        as: 'orch',
      }),
    ) as { ticket: { id: string; title: string; description: string } };
    expect(created.ticket).toMatchObject({ title: '-h', description: '--help' });
    const id = created.ticket.id;
    const handed = ok(
      h.server.callTool('board_handoff', {
        id,
        to: '-h',
        status: 'todo',
        note: '--help',
        as: 'orch',
      }),
    ) as { ticket: { assignee: string; comments: { text: string }[] } };
    expect(handed.ticket.assignee).toBe('-h');
    expect(handed.ticket.comments.at(-1)?.text).toBe('--help');
  });
});
