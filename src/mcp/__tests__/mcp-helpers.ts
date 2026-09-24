/**
 * Helpers for the child-process MCP tests: an SDK client connected over
 * stdio to `node dist/cli.js mcp` (built by `make check` before the tests;
 * see the harness), and the MCP tool list of the board-cli spec.
 */

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
];

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
