/**
 * MCP refusals repeat no refused input (no-echo-refusals tasks 1.4 and
 * 1.5; design.md "Audit" rows 32 to 36; board-cli scenarios "Unknown
 * status over MCP", "Unknown tool and unknown tool argument", "Ticket id
 * that is not an id" and "Hint for an id that is not an id").
 *
 * Every call goes over a real stdio client to the built server
 * (`node dist/cli.js mcp`, built by `make check` before the tests). Each
 * refusal is checked for its exit code, reason and exact message, and the
 * whole tool result (text and structured content) and the server's
 * stderr are checked for every token fixture passed in the call.
 */

import { realpathSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { boardProject, oneDocument, runCliAsync } from '../../__tests__/harness/processes.js';
import {
  HEX_64,
  TOKEN_FIXTURES,
  expectNoLeak,
  type SecretFixture,
} from '../../__tests__/harness/secret-fixtures.js';
import { findCommand } from '../../cli/registry.js';
import { eventNames } from '../../store/__tests__/helpers.js';
import { toolInputSchema } from '../tools.js';
import { mcpChild, type McpChild } from './mcp-helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const STATUS_LIST = 'todo, tests, implementing, review, merged, blocked';

const NOT_AN_ID =
  'no ticket matches the id given, which is not a ticket id: an id is 26 characters of ' +
  'Crockford base32 (digits and letters other than I, L, O and U), or a unique prefix of ' +
  'at least 6 of them';

interface ToolError {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
}

interface CallResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/** A served board with one ticket. */
interface Served {
  root: string;
  eventsDir: string;
  id: string;
  child: McpChild;
}

async function served(): Promise<Served> {
  const project = boardProject();
  const root = realpathSync(project.root);
  const out = await runCliAsync(
    ['new', 'No echo', '--task', 'openspec:no-echo#1', '--as', 'orch', '--json'],
    root,
  );
  expect(out.code, out.stderr).toBe(0);
  const id = (oneDocument(out) as { ticket: { id: string } }).ticket.id;
  const child = await mcpChild(root);
  return { root, eventsDir: project.eventsDir, id, child };
}

/**
 * Calls `name` with `args`, expects a tool error, checks that no fixture
 * leaked into the result or the server's stderr and that no event was
 * written, and returns the structured error.
 */
async function refused(
  s: Served,
  name: string,
  args: Record<string, unknown>,
  fixtures: readonly SecretFixture[],
): Promise<ToolError> {
  const before = eventNames(s.eventsDir);
  const result = (await s.child.client.callTool({ name, arguments: args })) as CallResult;
  expectNoLeak(`${name} result`, [result], fixtures);
  expectNoLeak(`${name} server stderr`, [s.child.stderr()], fixtures);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  const error = result.structuredContent as unknown as ToolError;
  expect(result.content).toEqual([
    {
      type: 'text',
      text: error.hint === null ? error.message : `${error.message}\nhint: ${error.hint}`,
    },
  ]);
  expect(eventNames(s.eventsDir)).toEqual(before);
  return error;
}

/** `refused`, then the exit code, reason and exact message. */
async function expectToolRefusal(
  s: Served,
  name: string,
  args: Record<string, unknown>,
  fixtures: readonly SecretFixture[],
  expected: { exitCode: number; reason: string; message: string },
): Promise<ToolError> {
  const error = await refused(s, name, args, fixtures);
  expect({ exitCode: error.exitCode, reason: error.reason, message: error.message }, name).toEqual(
    expected,
  );
  return error;
}

const usage = (message: string): { exitCode: number; reason: string; message: string } => ({
  exitCode: 1,
  reason: 'usage',
  message,
});

describe('Unknown tool and unknown tool argument (rows 32 and 33)', () => {
  it('an unknown tool name is not repeated', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      for (const name of [f.value, `board_${f.value}`]) {
        const error = await expectToolRefusal(
          s,
          name,
          {},
          [f],
          usage('unknown tool; call tools/list for the tool names'),
        );
        expect(error.hint).toContain('tools/list');
      }
    }
  }, 120_000);

  it('an unknown argument name is not repeated; the tool and its arguments are named', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      const error = await expectToolRefusal(
        s,
        'board_show',
        { id: s.id, [f.value]: true },
        [f],
        usage('unknown argument for board_show; its arguments are id, raw, as'),
      );
      expect(error.hint).toContain('board_show');
    }
  }, 120_000);

  it('the argument list follows the schema order of each tool', async () => {
    const s = await served();
    for (const [tool, command] of [
      ['board_move', 'move'],
      ['board_close', 'close'],
      ['board_inbox', 'inbox'],
    ] as const) {
      const spec = findCommand(command);
      if (spec === undefined) {
        throw new Error(`no command ${command}`);
      }
      const names = Object.keys(toolInputSchema(spec).properties).join(', ');
      await expectToolRefusal(
        s,
        tool,
        { bogus_argument: 1 },
        [],
        usage(`unknown argument for ${tool}; its arguments are ${names}`),
      );
    }
  }, 120_000);
});

describe('value refusals over MCP (row 35)', () => {
  it('Unknown status over MCP: board_move and board_handoff list the statuses', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      await expectToolRefusal(
        s,
        'board_move',
        { id: s.id, status: f.value, as: 'orch' },
        [f],
        usage(`move takes <status> as one of ${STATUS_LIST}`),
      );
      await expectToolRefusal(
        s,
        'board_handoff',
        { id: s.id, to: 'b', status: f.value, note: 'n', as: 'orch' },
        [f],
        usage(`handoff takes --status as one of ${STATUS_LIST}`),
      );
      await expectToolRefusal(
        s,
        'board_list',
        { status: f.value },
        [f],
        usage(`list takes --status as one of ${STATUS_LIST}`),
      );
    }
  }, 120_000);

  it('task references, change names, groups and filters', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      const t = f.value;
      const malformed = (
        message: string,
      ): { exitCode: number; reason: string; message: string } => ({
        exitCode: 1,
        reason: 'malformed-task-ref',
        message,
      });
      await expectToolRefusal(
        s,
        'board_new',
        { title: 'x', task: t, as: 'a' },
        [f],
        malformed(
          'malformed task reference: --task expects <source>:<ref>#<item>, for example openspec:add-board-core#3',
        ),
      );
      await expectToolRefusal(
        s,
        'board_link',
        { id: s.id, change: `${t}#1`, group: '1', as: 'a' },
        [f],
        malformed('malformed change name: --change must be non-empty and contain no #'),
      );
      await expectToolRefusal(
        s,
        'board_link',
        { id: s.id, change: 'c', group: t, as: 'a' },
        [f],
        malformed('malformed group: --group must be a positive decimal number such as 3'),
      );
      await expectToolRefusal(
        s,
        'board_list',
        { task: t },
        [f],
        malformed('malformed task filter: --task expects <source>:<ref>[#<item>]'),
      );
      await expectToolRefusal(
        s,
        'board_list',
        { change: `${t}#1` },
        [f],
        malformed('malformed change name: --change must be non-empty and contain no #'),
      );
    }
  }, 120_000);

  it('health durations, inbox --since, decision paths and the integer index', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      const t = f.value;
      await expectToolRefusal(
        s,
        'board_health',
        { 'stale-after': t },
        [f],
        usage(
          'invalid --stale-after: a duration is <n>m, <n>h or <n>d with <n> a positive integer of at most 5 digits (for example 30m, 2h or 1d)',
        ),
      );
      await expectToolRefusal(
        s,
        'board_close',
        { id: s.id, 'decision-recorded-in': `docs/${t}.md`, as: 'orch' },
        [f],
        {
          exitCode: 1,
          reason: 'decision-path-missing',
          message: 'the decision record given with --decision-recorded-in does not exist',
        },
      );
      await expectToolRefusal(s, 'board_link', { id: s.id, decision: `../${t}`, as: 'a' }, [f], {
        exitCode: 1,
        reason: 'path-outside-tree',
        message: `the path given is outside the working tree ${s.root}`,
      });
      await expectToolRefusal(
        s,
        'board_checklist_tick',
        { id: s.id, index: t, as: 'a' },
        [f],
        usage('index must be an integer'),
      );
    }
    await expectToolRefusal(s, 'board_inbox', { since: HEX_64, as: 'a' }, TOKEN_FIXTURES, {
      exitCode: 1,
      reason: 'unknown-cursor',
      message: 'no event matches --since on this board',
    });
  }, 120_000);

  it('import-change targets', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      const t = f.value;
      await expectToolRefusal(s, 'board_import_change', { name: `${t}#1`, as: 'orch' }, [f], {
        exitCode: 1,
        reason: 'malformed-task-ref',
        message:
          'the change given to import-change names an item (it contains #); import-change takes a whole change or <source>:<ref>',
      });
      await expectToolRefusal(s, 'board_import_change', { name: `Bad_${t}:x`, as: 'orch' }, [f], {
        exitCode: 1,
        reason: 'malformed-task-ref',
        message: 'the task source given to import-change must match /^[a-z][a-z0-9-]*$/',
      });
      await expectToolRefusal(
        s,
        'board_import_change',
        { name: `../${t}`, as: 'orch' },
        [f],
        usage('the OpenSpec change name given is not a single directory name'),
      );
      await expectToolRefusal(s, 'board_import_change', { name: t, as: 'orch' }, [f], {
        exitCode: 1,
        reason: 'tasks-not-found',
        message:
          'cannot read the tasks file of the change given: import-change reads openspec/changes/<name>/tasks.md; is the name an OpenSpec change?',
      });
    }
  }, 120_000);
});

describe('ticket ids over MCP (rows 17 and 36)', () => {
  it('Ticket id that is not an id: board_move and board_show, exitCode 4 unknown-ticket', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      for (const [tool, args] of [
        ['board_move', { id: f.value, status: 'review', as: 'orch' }],
        ['board_show', { id: f.value }],
        ['board_comment', { id: f.value, text: 'hello', as: 'a' }],
      ] as const) {
        const error = await expectToolRefusal(s, tool, args, [f], {
          exitCode: 4,
          reason: 'unknown-ticket',
          message: NOT_AN_ID,
        });
        expect(error.hint).not.toBeNull();
      }
    }
  }, 120_000);

  it('an id-shaped unknown id is named', async () => {
    const s = await served();
    await expectToolRefusal(s, 'board_show', { id: '01J9K3ZZZZ' }, [], {
      exitCode: 4,
      reason: 'unknown-ticket',
      message: 'no ticket matches 01J9K3ZZZZ',
    });
  }, 120_000);

  it('Hint for an id that is not an id: board_close without a decision writes <id>', async () => {
    const s = await served();
    for (const f of TOKEN_FIXTURES) {
      const error = await refused(s, 'board_close', { id: f.value, as: 'orch' }, [f]);
      expect(error).toMatchObject({ exitCode: 1, reason: 'no-disposition' });
      expect(error.hint).toContain(
        'board_close {"id":"<id>","decision-recorded-in":"<path>","as":"orch"}',
      );
      expect(error.hint).toContain('board_close {"id":"<id>","no-decision":true,"as":"orch"}');
    }
    const shaped = await refused(s, 'board_close', { id: s.id, as: 'orch' }, []);
    expect(shaped.hint).toContain(
      `board_close {"id":"${s.id}","decision-recorded-in":"<path>","as":"orch"}`,
    );
  }, 120_000);
});
