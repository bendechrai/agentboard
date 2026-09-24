/**
 * Tasks 9.2 and 9.3 against the built executable (board-cli: "MCP server";
 * board-concurrency): `node dist/cli.js mcp` spawned as a child with the
 * SDK client over stdio, compared with the CLI's own `--json` output, and
 * raced against a CLI process.
 *
 * The tool-list test includes `board_inbox`, so it is red until task group
 * 5 is in the branch.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  boardProject,
  cliEnv,
  oneDocument,
  requireBuiltCli,
  runCliAsync,
  scratchDir,
  startGated,
} from '../../__tests__/harness/processes.js';
import { eventNames } from '../../store/__tests__/helpers.js';
import { SPEC_TOOLS, mcpChild } from './mcp-helpers.js';

const TASK = ['--task', 'openspec:add-board-core#9'];

interface Structured {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function newTicket(root: string): Promise<string> {
  const out = await runCliAsync(['new', 'Contested', ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

async function cliShow(root: string, id: string): Promise<unknown> {
  const out = await runCliAsync(['show', id, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return oneDocument(out);
}

describe('agentboard mcp start-up', () => {
  it('scenario: exits 2 naming the path when there is no board, before serving', async () => {
    const root = scratchDir();
    const out = await runCliAsync(['mcp'], root);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^agentboard: no board found at /);
    expect(out.stderr).toContain(join(root, '.board'));
  });

  it('answers initialize with protocol messages only and exits 0 when stdin ends', async () => {
    const { root } = boardProject();
    const child = spawn(process.execPath, [requireBuiltCli(), 'mcp'], {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(cliEnv()).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        resolve(code);
      });
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      })}\n`,
    );
    const deadline = Date.now() + 15_000;
    while (!stdout.includes('\n') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.stdin.end();
    const code = await exited;
    clearTimeout(timer);
    expect(code, stderr).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'agentboard' }, capabilities: { tools: {} } },
    });
  }, 30_000);
});

describe('agentboard mcp over stdio', () => {
  it('scenario: lists exactly the spec tools (needs task group 5 for inbox)', async () => {
    const { root } = boardProject();
    const mcp = await mcpChild(root);
    const listed = await mcp.client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([...SPEC_TOOLS].sort());
    expect(mcp.errors).toEqual([]);
  }, 30_000);

  it('scenario: round trip new, claim, handoff, show equals agentboard show --json', async () => {
    const { root, eventsDir } = boardProject();
    const mcp = await mcpChild(root);
    const created = (await mcp.client.callTool({
      name: 'board_new',
      arguments: { title: 'Round trip', task: 'openspec:add-board-core#9', as: 'orch' },
    })) as Structured;
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const id = (created.structuredContent as { ticket: { id: string } }).ticket.id;
    const claimed = (await mcp.client.callTool({
      name: 'board_claim',
      arguments: { id, as: 'impl' },
    })) as Structured;
    expect(claimed.structuredContent).toMatchObject({ ticket: { assignee: 'impl' } });
    const handed = (await mcp.client.callTool({
      name: 'board_handoff',
      arguments: { id, to: 'test-author', status: 'tests', note: 'over to you', as: 'impl' },
    })) as Structured;
    expect(handed.isError, JSON.stringify(handed)).toBeFalsy();
    const shown = (await mcp.client.callTool({
      name: 'board_show',
      arguments: { id },
    })) as Structured;
    expect(shown.structuredContent).toEqual(await cliShow(root, id));
    expect(shown.structuredContent).toMatchObject({
      ticket: { assignee: 'test-author', status: 'tests' },
      events: 3,
    });
    expect(eventNames(eventsDir)).toHaveLength(3);
    expect(mcp.errors).toEqual([]);
  }, 30_000);

  it('scenario: already-assigned claim is a tool error naming the holder, writing no event', async () => {
    const { root, eventsDir } = boardProject();
    const id = await newTicket(root);
    expect((await runCliAsync(['claim', id, '--as', 'impl'], root)).code).toBe(0);
    const before = eventNames(eventsDir);
    const mcp = await mcpChild(root);
    const refused = (await mcp.client.callTool({
      name: 'board_claim',
      arguments: { id, as: 'reviewer' },
    })) as Structured;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
    expect((refused.structuredContent as { message: string }).message).toContain('impl');
    expect(eventNames(eventsDir)).toEqual(before);
  }, 30_000);

  it('scenario: missing actor fails as the CLI does; AGENTBOARD_ACTOR is the fallback', async () => {
    const { root, eventsDir } = boardProject();
    const id = await newTicket(root);
    const bare = await mcpChild(root);
    const refused = (await bare.client.callTool({
      name: 'board_comment',
      arguments: { id, text: 'hi' },
    })) as Structured;
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ exitCode: 1, reason: 'missing-actor' });
    const message = (refused.structuredContent as { message: string }).message;
    expect(message).toContain('--as');
    expect(message).toContain('AGENTBOARD_ACTOR');
    expect(eventNames(eventsDir)).toHaveLength(1);

    const withEnv = await mcpChild(root, cliEnv({ AGENTBOARD_ACTOR: 'env-agent' }));
    const accepted = (await withEnv.client.callTool({
      name: 'board_comment',
      arguments: { id, text: 'hi' },
    })) as Structured;
    expect(accepted.isError, JSON.stringify(accepted)).toBeFalsy();
    expect(accepted.structuredContent).toMatchObject({
      ticket: { comments: [{ actor: 'env-agent', text: 'hi' }] },
    });
  }, 30_000);
});

describe('agentboard mcp --as', () => {
  it("records a claim without as for the server's --as, before AGENTBOARD_ACTOR", async () => {
    const { root, eventsDir } = boardProject();
    const id = await newTicket(root);
    const mcp = await mcpChild(root, cliEnv({ AGENTBOARD_ACTOR: 'env-agent' }), ['--as', 'impl']);
    const claimed = (await mcp.client.callTool({
      name: 'board_claim',
      arguments: { id },
    })) as Structured;
    expect(claimed.isError, JSON.stringify(claimed)).toBeFalsy();
    expect(claimed.structuredContent).toMatchObject({ ticket: { assignee: 'impl' } });
    expect(await cliShow(root, id)).toMatchObject({ ticket: { assignee: 'impl' }, events: 2 });
    expect(eventNames(eventsDir)).toHaveLength(2);
    const other = (await mcp.client.callTool({
      name: 'board_comment',
      arguments: { id, text: 'mine', as: 'reviewer' },
    })) as Structured;
    expect(other.structuredContent).toMatchObject({
      ticket: { comments: [{ actor: 'reviewer', text: 'mine' }] },
    });
  }, 30_000);
});

describe('scenario: claim race between one MCP client and one CLI process', () => {
  it('has exactly one winner every round and rebuild --check reports no divergence', async () => {
    const { root, eventsDir } = boardProject();
    const mcp = await mcpChild(root);
    const winners: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const id = await newTicket(root);
      const before = eventNames(eventsDir).length;
      const gated = await startGated(
        [{ argv: ['claim', id, '--as', 'cli-agent', '--json'] }],
        root,
      );
      gated.open();
      const [tool, cli] = await Promise.all([
        mcp.client.callTool({
          name: 'board_claim',
          arguments: { id, as: 'mcp-agent' },
        }) as Promise<Structured>,
        (gated.procs[0] ?? { exited: Promise.reject(new Error('no child')) }).exited,
      ]);
      const mcpWon = tool.isError !== true;
      const cliWon = cli.code === 0;
      expect([mcpWon, cliWon].filter(Boolean), `round ${String(round)}`).toHaveLength(1);
      const winner = mcpWon ? 'mcp-agent' : 'cli-agent';
      winners.push(winner);
      if (mcpWon) {
        expect(cli.code).toBe(4);
        expect(oneDocument(cli)).toMatchObject({
          error: { exitCode: 4, reason: 'already-assigned' },
        });
        expect(cli.stderr).toContain('mcp-agent');
        expect(tool.structuredContent).toMatchObject({ ticket: { assignee: 'mcp-agent' } });
      } else {
        expect(tool.structuredContent).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
        expect((tool.structuredContent as { message: string }).message).toContain('cli-agent');
      }
      expect(await cliShow(root, id)).toMatchObject({ ticket: { assignee: winner }, events: 2 });
      expect(eventNames(eventsDir)).toHaveLength(before + 1);
    }
    expect(winners).toHaveLength(5);
    const check = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(oneDocument(check)).toMatchObject({ ok: true, differences: [] });
    expect(mcp.errors).toEqual([]);
  }, 120_000);
});
