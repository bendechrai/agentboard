/**
 * MCP tool definitions (board-cli: "MCP server", "Tools are listed from
 * the registry"; "Command surface": one registry drives the parser and the
 * MCP tools): tool names, exclusions, generated input schemas and argument validation,
 * in process.
 */

import { describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { parseArgs } from '../../cli/parse.js';
import { ACTOR_FLAG, CLOSE_RULE, COMMANDS, TASK_RULE, findCommand } from '../../cli/registry.js';
import type { CommandSpec } from '../../cli/types.js';
import {
  EXCLUDED_COMMANDS,
  TOOL_PREFIX,
  findTool,
  toolArguments,
  toolDefinition,
  toolDefinitions,
  toolDescription,
  toolInputSchema,
  toolName,
  type ToolDefinition,
} from '../tools.js';
import { SPEC_TOOLS } from './mcp-helpers.js';

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

function tool(name: string): ToolDefinition {
  const found = findTool(name);
  if (found === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return found;
}

/** Required argument names of a command, computed from the registry. */
function registryRequired(c: CommandSpec): string[] {
  return [...c.positionals, ...c.flags].filter((a) => a.required).map((a) => a.name);
}

describe('tool names', () => {
  it('maps command names to board_ with spaces and hyphens as underscores', () => {
    expect(toolName('claim')).toBe('board_claim');
    expect(toolName('checklist tick')).toBe('board_checklist_tick');
    expect(toolName('import-change')).toBe('board_import_change');
    expect(toolName('close-merged')).toBe('board_close_merged');
    expect(TOOL_PREFIX).toBe('board_');
  });

  it('excludes exactly init, watch, serve, top, rebuild, sync, mcp, version, help and the agents commands', () => {
    // agents install and agents check write or read host project files in
    // the caller's working tree and are run in a shell, like the other
    // setup commands.
    expect([...EXCLUDED_COMMANDS].sort()).toEqual(
      [
        'agents check',
        'agents install',
        'help',
        'init',
        'mcp',
        'rebuild',
        'sync',
        'serve',
        'top',
        'version',
        'watch',
      ].sort(),
    );
  });

  it('scenario: the listed tools are exactly the spec set', () => {
    expect(
      toolDefinitions()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...SPEC_TOOLS].sort());
  });

  it('has one tool per registry command not excluded, in registry order', () => {
    const expected = COMMANDS.filter((c) => !EXCLUDED_COMMANDS.includes(c.name)).map((c) =>
      toolName(c.name),
    );
    expect(toolDefinitions().map((t) => t.name)).toEqual(expected);
    for (const t of toolDefinitions()) {
      expect(t.command).toBe(COMMANDS.find((c) => toolName(c.name) === t.name));
    }
  });

  it('never lists a tool for an excluded command', () => {
    for (const name of ['init', 'watch', 'serve', 'top', 'rebuild', 'sync', 'mcp', 'version']) {
      expect(findTool(`board_${name}`)).toBeUndefined();
    }
    expect(findTool('board_nope')).toBeUndefined();
    expect(findTool('claim')).toBeUndefined();
  });

  it('generates tools from the commands it is given', () => {
    const fake: CommandSpec = {
      ...command('claim'),
      name: 'frob nicate-it',
      summary: 'Frob',
    };
    const tools = toolDefinitions([fake, command('version')]);
    expect(tools.map((t) => t.name)).toEqual(['board_frob_nicate_it']);
    expect(findTool('board_frob_nicate_it', [fake])?.command).toBe(fake);
  });
});

describe('input schemas', () => {
  it("each schema's required fields match the registry", () => {
    for (const t of toolDefinitions()) {
      expect(t.inputSchema.required, t.name).toEqual(registryRequired(t.command));
    }
  });

  it('pins required fields of a few tools literally', () => {
    expect(tool('board_handoff').inputSchema.required).toEqual(['id', 'to', 'status', 'note']);
    expect(tool('board_new').inputSchema.required).toEqual(['title']);
    expect(tool('board_claim').inputSchema.required).toEqual(['id']);
    expect(tool('board_move').inputSchema.required).toEqual(['id']);
    expect(tool('board_comment').inputSchema.required).toEqual(['id', 'text']);
    expect(tool('board_checklist_tick').inputSchema.required).toEqual(['id', 'index']);
    expect(tool('board_close').inputSchema.required).toEqual(['id']);
    expect(tool('board_import_change').inputSchema.required).toEqual(['name']);
    expect(tool('board_list').inputSchema.required).toEqual([]);
    expect(tool('board_close_merged').inputSchema.required).toEqual([]);
  });

  it('has one property per positional and flag, then as, and never json', () => {
    for (const t of toolDefinitions()) {
      const c = t.command;
      expect(Object.keys(t.inputSchema.properties), t.name).toEqual([
        ...c.positionals.map((a) => a.name),
        ...c.flags.map((a) => a.name),
        'as',
      ]);
      expect(t.inputSchema.properties, t.name).not.toHaveProperty('json');
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.required).not.toContain('as');
    }
  });

  it('maps argument types, with repeatable flags as string arrays', () => {
    for (const t of toolDefinitions()) {
      for (const arg of [...t.command.positionals, ...t.command.flags]) {
        const prop = t.inputSchema.properties[arg.name];
        const expected = arg.repeatable
          ? { type: 'array', items: { type: 'string' }, description: arg.summary }
          : { type: arg.type, description: arg.summary };
        expect(prop, `${t.name}.${arg.name}`).toEqual(expected);
      }
      expect(t.inputSchema.properties.as).toEqual({
        type: 'string',
        description: ACTOR_FLAG.summary,
      });
    }
    const props = tool('board_new').inputSchema.properties;
    expect(props.label).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: 'Label (repeatable)',
    });
    expect(props.title).toMatchObject({ type: 'string' });
    expect(tool('board_checklist_tick').inputSchema.properties.index).toMatchObject({
      type: 'integer',
    });
    expect(tool('board_close').inputSchema.properties['no-decision']).toMatchObject({
      type: 'boolean',
    });
  });

  it('uses no combinators: exclusive groups are described, not encoded', () => {
    for (const t of toolDefinitions()) {
      const schema = t.inputSchema as unknown as Record<string, unknown>;
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) {
        expect(schema, `${t.name}.${key}`).not.toHaveProperty(key);
      }
    }
  });

  it('is what toolInputSchema returns for the command', () => {
    for (const t of toolDefinitions()) {
      expect(t.inputSchema).toEqual(toolInputSchema(t.command));
      expect(toolDefinition(t.command)).toEqual(t);
    }
  });
});

describe('descriptions and annotations', () => {
  it('is the summary followed by one sentence per exclusive group', () => {
    expect(tool('board_new').description).toBe(
      'Create a ticket. Give exactly one of: task | change with group | adhoc.',
    );
    expect(tool('board_link').description).toBe(
      'Link a ticket to a task, a PR or a decision record. ' +
        'Give exactly one of: task | change with group | pr | decision.',
    );
    expect(tool('board_close').description).toBe(
      'Close a merged or blocked ticket with a decision disposition. ' +
        'Give exactly one of: decision-recorded-in | no-decision.',
    );
    expect(tool('board_list').description).toBe(
      'List open tickets, optionally filtered. Give at most one of: task | change.',
    );
    expect(tool('board_claim').description).toBe('Assign an unassigned ticket to yourself');
    for (const t of toolDefinitions()) {
      expect(t.description.startsWith(t.command.summary), t.name).toBe(true);
      expect(toolDescription(t.command)).toBe(t.description);
      expect(/^[\x20-\x7e]*$/.test(t.description), t.name).toBe(true);
    }
  });

  it('marks exactly the commands that neither write nor track a cursor as read-only', () => {
    expect(tool('board_show').annotations).toEqual({ readOnlyHint: true });
    expect(tool('board_list').annotations).toEqual({ readOnlyHint: true });
    for (const name of ['board_new', 'board_claim', 'board_handoff', 'board_close_merged']) {
      expect(tool(name).annotations, name).toEqual({ readOnlyHint: false });
    }
  });

  it('does not mark board_inbox read-only: it advances a cursor', () => {
    expect(tool('board_inbox').annotations).toEqual({ readOnlyHint: false });
  });
});

describe('toolArguments', () => {
  /** `parseArgs(argv).values` for the command line. */
  function cli(argv: readonly string[]): unknown {
    return parseArgs(argv).values;
  }

  it('produces the same values as parseArgs for the equivalent command line', () => {
    expect(
      toolArguments(command('handoff'), {
        id: '01ABCDEF',
        to: 'reviewer',
        status: 'review',
        note: 'green',
        as: 'impl',
      }),
    ).toEqual(
      cli([
        'handoff',
        '01ABCDEF',
        '--to',
        'reviewer',
        '--status',
        'review',
        '--note',
        'green',
        '--as',
        'impl',
      ]),
    );
    expect(
      toolArguments(command('new'), {
        title: 'T',
        label: ['a', 'b'],
        change: 'add-board-core',
        group: '9',
        checklist: ['one'],
      }),
    ).toEqual(
      cli([
        'new',
        'T',
        '--label',
        'a',
        '--label',
        'b',
        '--change',
        'add-board-core',
        '--group',
        '9',
        '--checklist',
        'one',
      ]),
    );
    expect(toolArguments(command('checklist tick'), { id: '01ABCDEF', index: 2 })).toEqual(
      cli(['checklist', 'tick', '01ABCDEF', '2']),
    );
    expect(toolArguments(command('close'), { id: '01ABCDEF', 'no-decision': true })).toEqual(
      cli(['close', '01ABCDEF', '--no-decision']),
    );
  });

  it('keeps as in the values without resolving it', () => {
    expect(toolArguments(command('claim'), { id: '01ABCDEF', as: 'impl' })).toEqual({
      id: '01ABCDEF',
      as: 'impl',
    });
    expect(toolArguments(command('claim'), { id: '01ABCDEF' })).toEqual({ id: '01ABCDEF' });
    expect(toolArguments(command('show'), { id: '01ABCDEF', as: 'impl' })).toMatchObject({
      id: '01ABCDEF',
    });
  });

  it('takes values starting with dashes verbatim, never as flags', () => {
    expect(toolArguments(command('comment'), { id: '01ABCDEF', text: '--no-decision -x' })).toEqual(
      { id: '01ABCDEF', text: '--no-decision -x' },
    );
    expect(toolArguments(command('new'), { title: '--as', adhoc: '-' })).toEqual({
      title: '--as',
      adhoc: '-',
    });
  });

  it('treats false booleans and empty arrays as absent, and missing arguments as {}', () => {
    expect(toolArguments(command('show'), { id: '01ABCDEF', raw: false })).toEqual({
      id: '01ABCDEF',
    });
    expect(toolArguments(command('list'), { label: [], closed: false })).toEqual({});
    expect(toolArguments(command('list'), undefined)).toEqual({});
    expect(toolArguments(command('list'), null)).toEqual({});
  });

  it('refuses a non-object, an unknown property and json', () => {
    for (const bad of [[], 'id', 3, true]) {
      expectBoardError(() => toolArguments(command('list'), bad), 1, 'usage');
    }
    const unknown = expectBoardError(
      () => toolArguments(command('claim'), { id: '01ABCDEF', bogus: 'x' }),
      1,
      'usage',
    );
    expect(unknown.message).toContain('bogus');
    expectBoardError(() => toolArguments(command('list'), { json: true }), 1, 'usage');
  });

  it('refuses values of the wrong type, naming the property', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['claim', { id: 7 }, 'id'],
      ['checklist tick', { id: '01ABCDEF', index: '2' }, 'index'],
      ['checklist tick', { id: '01ABCDEF', index: 1.5 }, 'index'],
      ['checklist tick', { id: '01ABCDEF', index: 2 ** 60 }, 'index'],
      ['show', { id: '01ABCDEF', raw: 'yes' }, 'raw'],
      ['new', { title: 'T', adhoc: 'r', label: 'solo' }, 'label'],
      ['new', { title: 'T', adhoc: 'r', label: ['ok', 3] }, 'label'],
      ['claim', { id: '01ABCDEF', as: 5 }, 'as'],
    ];
    for (const [name, args, prop] of cases) {
      const err = expectBoardError(() => toolArguments(command(name), args), 1, 'usage');
      expect(err.message, `${name} ${prop}`).toContain(prop);
    }
  });

  it('refuses a missing required argument, naming it', () => {
    const note = expectBoardError(
      () => toolArguments(command('handoff'), { id: '01ABCDEF', to: 'r', status: 'review' }),
      1,
      'usage',
    );
    expect(note.message).toContain('note');
    const id = expectBoardError(() => toolArguments(command('claim'), {}), 1, 'usage');
    expect(id.message).toContain('id');
  });

  it('applies the exclusive groups with the CLI reasons and messages', () => {
    const none = expectBoardError(
      () => toolArguments(command('new'), { title: 'T' }),
      1,
      'needs-task-or-adhoc',
    );
    expect(none.message).toBe(TASK_RULE);
    expectBoardError(
      () => toolArguments(command('new'), { title: 'T', task: 'openspec:c#1', adhoc: 'r' }),
      1,
      'usage',
    );
    const partial = expectBoardError(
      () => toolArguments(command('new'), { title: 'T', change: 'c' }),
      1,
      'usage',
    );
    expect(partial.message).toContain('group');
    const close = expectBoardError(
      () => toolArguments(command('close'), { id: '01ABCDEF' }),
      1,
      'no-disposition',
    );
    expect(close.message).toBe(CLOSE_RULE);
    expectBoardError(
      () => toolArguments(command('list'), { task: 'openspec:c', change: 'c' }),
      1,
      'usage',
    );
  });
});

describe('toolArguments: help words are values', () => {
  it('keeps --help and -h as positional and flag values, never a help request', () => {
    expect(toolArguments(command('comment'), { id: '01ABCDEF', text: '--help' })).toEqual({
      id: '01ABCDEF',
      text: '--help',
    });
    expect(toolArguments(command('comment'), { id: '01ABCDEF', text: '-h' })).toEqual({
      id: '01ABCDEF',
      text: '-h',
    });
    expect(
      toolArguments(command('handoff'), {
        id: '01ABCDEF',
        to: '--help',
        status: 'review',
        note: '-h',
      }),
    ).toEqual({ id: '01ABCDEF', to: '--help', status: 'review', note: '-h' });
    expect(
      toolArguments(command('new'), { title: '-h', description: '--help', adhoc: 'x' }),
    ).toEqual({ title: '-h', description: '--help', adhoc: 'x' });
  });
});
