/**
 * Helpers for the child-process MCP tests: an SDK client connected over
 * stdio to `node dist/cli.js mcp` (built by `make check` before the tests;
 * see the harness), a raw JSON-RPC session with the same server (for the
 * wire-level checks the SDK client would hide: it rewrites error messages
 * and validates parameters before sending), and the MCP tool list of the
 * board-cli spec.
 */

import { spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll } from 'vitest';

import { cliEnv, requireBuiltCli, type RunEnv } from '../../__tests__/harness/processes.js';

/** The tool list of the board-cli scenario "Tools are listed from the registry". */
export const SPEC_TOOLS: readonly string[] = [
  'board_new',
  'board_show',
  'board_list',
  'board_claim',
  'board_renew',
  'board_unqueue',
  'board_release',
  'board_move',
  'board_comment',
  'board_handoff',
  'board_link',
  'board_checklist_tick',
  'board_checklist_untick',
  'board_close',
  'board_inbox',
  'board_import_change',
  'board_close_merged',
  'board_health',
];

/**
 * The wire `message` of the error for a `resources/read` of an unknown URI
 * (board-agent-guidance "Guide over MCP", scenario "Unknown URI names the
 * resources"), written out from the spec rather than built from the
 * server's resource list, so that a list that drops or reorders a resource
 * fails.
 */
export const UNKNOWN_RESOURCE_MESSAGE =
  'unknown resource; the resources are agentboard://guide, ' +
  'agentboard://guide/orchestrator, agentboard://guide/test-author, ' +
  'agentboard://guide/implementer, agentboard://guide/reviewer';

/**
 * The message an SDK client raises for that error: its `McpError` adds
 * `MCP error <code>: ` to the wire message once.
 */
export const UNKNOWN_RESOURCE_CLIENT_MESSAGE = `MCP error -32602: ${UNKNOWN_RESOURCE_MESSAGE}`;

/** A connected client of a spawned `agentboard mcp`. */
export interface McpChild {
  client: Client;
  /** Everything the server printed on stderr so far. */
  stderr(): string;
  /** Transport errors seen by the client (a non-protocol line on stdout is one). */
  errors: Error[];
  /** Closes the client (ending the server's stdin). */
  close(): Promise<void>;
}

const open: McpChild[] = [];

afterAll(async () => {
  await Promise.all(open.splice(0).map((child) => child.close()));
});

/**
 * Spawns `node dist/cli.js mcp <extraArgs>` in `cwd` and connects an SDK
 * client to it.
 */
export async function mcpChild(
  cwd: string,
  env: RunEnv = cliEnv(),
  extraArgs: readonly string[] = [],
): Promise<McpChild> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [requireBuiltCli(), 'mcp', ...extraArgs],
    cwd,
    env: childEnv,
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    err += chunk.toString();
  });
  const errors: Error[] = [];
  const client = new Client({ name: 'agentboard-test', version: '0.0.0' });
  client.onerror = (error) => {
    errors.push(error);
  };
  await client.connect(transport);
  let closed = false;
  const child: McpChild = {
    client,
    stderr: () => err,
    errors,
    close: async () => {
      if (!closed) {
        closed = true;
        await client.close();
      }
    },
  };
  open.push(child);
  return child;
}

/** One JSON-RPC response line of the server, parsed, with the line as sent. */
export interface RawResponse {
  /** The parsed response object. */
  readonly json: Record<string, unknown>;
  /** The response line exactly as the server wrote it (without the newline). */
  readonly line: string;
}

/** A raw JSON-RPC session with a spawned `agentboard mcp`, already initialized. */
export interface RawMcpChild {
  /**
   * Sends `{jsonrpc: "2.0", id, method, params}` (no `params` member when
   * `params` is undefined) with a fresh numeric id and resolves with the
   * response carrying that id. Rejects after 15 seconds without one.
   */
  request(method: string, params?: unknown): Promise<RawResponse>;
  /** Everything the server printed on stderr so far. */
  stderr(): string;
  /** Every stdout line the server wrote so far, including the initialize response. */
  lines(): readonly string[];
  /** Ends the server's stdin and resolves with its exit code. */
  close(): Promise<number | null>;
}

const rawOpen: RawMcpChild[] = [];

afterAll(async () => {
  await Promise.all(rawOpen.splice(0).map((child) => child.close()));
});

/**
 * Spawns `node dist/cli.js mcp` in `cwd`, sends `initialize` and
 * `notifications/initialized` as raw JSON-RPC lines, and returns a session
 * that matches responses to requests by id (the server may answer out of
 * order). Ids are numbers from 1, so no client-chosen text is ever an id.
 */
export async function rawMcpChild(cwd: string, env: RunEnv = cliEnv()): Promise<RawMcpChild> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  const child = spawn(process.execPath, [requireBuiltCli(), 'mcp'], {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  let buffered = '';
  const seen: string[] = [];
  const waiting = new Map<number, (response: RawResponse) => void>();
  const received = new Map<number, RawResponse>();
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk;
    let end = buffered.indexOf('\n');
    while (end !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      seen.push(line);
      const json = JSON.parse(line) as Record<string, unknown>;
      if (typeof json.id === 'number') {
        const response = { json, line };
        const resolve = waiting.get(json.id);
        if (resolve === undefined) {
          received.set(json.id, response);
        } else {
          waiting.delete(json.id);
          resolve(response);
        }
      }
      end = buffered.indexOf('\n');
    }
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  let nextId = 0;
  const request = (method: string, params?: unknown): Promise<RawResponse> => {
    nextId += 1;
    const id = nextId;
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      message.params = params;
    }
    const answered = new Promise<RawResponse>((resolve, reject) => {
      const early = received.get(id);
      if (early !== undefined) {
        received.delete(id);
        resolve(early);
        return;
      }
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`no response to ${method} (id ${String(id)}) within 15 seconds`));
      }, 15_000);
      waiting.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return answered;
  };
  let closed: Promise<number | null> | undefined;
  const raw: RawMcpChild = {
    request,
    stderr: () => err,
    lines: () => seen,
    close: () => {
      closed ??= (async () => {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        const code = await exited;
        clearTimeout(timer);
        return code;
      })();
      return closed;
    },
  };
  rawOpen.push(raw);
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agentboard-raw-test', version: '0.0.0' },
  });
  if (!('result' in init.json)) {
    throw new Error(`initialize failed: ${init.line}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return raw;
}
