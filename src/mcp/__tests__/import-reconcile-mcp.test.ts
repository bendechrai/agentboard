/**
 * `board_import_change` with `dry-run` and `force` (add-claim-leases task
 * 8.3; board-openspec-integration: "Reconcile on re-import": the MCP tool
 * gains the optional arguments from the registry), through an in-process
 * server.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cliEnv, project } from '../../cli/__tests__/cli-helpers.js';
import { createMcpServer, type BoardMcpServer, type ToolCallResult } from '../server.js';
import { findTool } from '../tools.js';

const CHANGE = 'add-x';
const PATH = `openspec/changes/${CHANGE}/tasks.md`;
const servers: BoardMcpServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function writeTasks(root: string, text: string): void {
  mkdirSync(join(root, 'openspec', 'changes', CHANGE), { recursive: true });
  writeFileSync(join(root, PATH), text);
}

function serve(): { root: string; boardDir: string; server: BoardMcpServer } {
  const { root, boardDir } = project();
  const server = createMcpServer({
    cwd: root,
    env: cliEnv(),
    actor: 'orch',
    stderr: () => undefined,
  });
  servers.push(server);
  return { root, boardDir, server };
}

function files(boardDir: string): string[] {
  return readdirSync(join(boardDir, 'events')).sort();
}

function ok(result: ToolCallResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBeUndefined();
  return result.structuredContent;
}

const V1 = '## 1. One\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n';

describe('board_import_change', () => {
  it('lists dry-run and force as optional boolean arguments', () => {
    const tool = findTool('board_import_change');
    expect(tool?.inputSchema.properties['dry-run']).toMatchObject({ type: 'boolean' });
    expect(tool?.inputSchema.properties.force).toMatchObject({ type: 'boolean' });
    expect(tool?.inputSchema.required).toEqual(['name']);
  });

  it('with dry-run returns the report and writes nothing', () => {
    const { root, boardDir, server } = serve();
    writeTasks(root, V1);
    ok(server.callTool('board_import_change', { name: CHANGE }));
    writeTasks(root, '## 1. One renamed\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n');
    const before = files(boardDir);
    const doc = ok(server.callTool('board_import_change', { name: CHANGE, 'dry-run': true }));
    expect(doc).toMatchObject({ dryRun: true, events: 0 });
    expect((doc.tickets as { action: string }[]).map((t) => t.action)).toEqual(['updated']);
    expect(files(boardDir)).toEqual(before);
  });

  it('refuses a blocked reconcile with reconcile-blocked, and force writes it', () => {
    const { root, boardDir, server } = serve();
    writeTasks(root, V1);
    const first = ok(server.callTool('board_import_change', { name: CHANGE }));
    const id = (first.tickets as { id: string }[])[0]?.id ?? '';
    ok(server.callTool('board_checklist_tick', { id, index: 1 }));
    writeTasks(root, '## 1. One\n\n- [ ] 1.1 a\n');
    const before = files(boardDir).length;
    const refused = server.callTool('board_import_change', { name: CHANGE });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ exitCode: 4, reason: 'reconcile-blocked' });
    expect(String(refused.structuredContent.hint)).toContain(
      'board_import_change {"name":"<change>","dry-run":true,"as":"orch"}',
    );
    expect(files(boardDir)).toHaveLength(before);
    const forced = ok(server.callTool('board_import_change', { name: CHANGE, force: true }));
    expect((forced.tickets as { forced: boolean }[])[0]?.forced).toBe(true);
    expect(files(boardDir)).toHaveLength(before + 1);
  });
});
