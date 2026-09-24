import { describe, expect, it } from 'vitest';

import * as lib from '../../index.js';
import { expectBoardError } from '../../board/__tests__/helpers.js';
import { ACTOR_ENV, parseArgs, resolveActor } from '../parse.js';
import {
  ACTOR_FLAG,
  ALLOW_SECRET_FLAG,
  CLOSE_RULE,
  COMMANDS,
  GLOBAL_FLAGS,
  JSON_FLAG,
  TASK_RULE,
  findCommand,
} from '../registry.js';
import type { CommandSpec } from '../types.js';

const ASCII = /^[\x20-\x7e]+$/;

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

describe('the command registry', () => {
  it('defines the commands of this group, once each, in order', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      'init',
      'new',
      'show',
      'list',
      'claim',
      'release',
      'move',
      'comment',
      'handoff',
      'link',
      'checklist tick',
      'checklist untick',
      'close',
      'inbox',
      'watch',
      'mcp',
      'version',
    ]);
  });

  it('marks exactly inbox and watch as tracking a cursor, and only watch as streaming', () => {
    expect(COMMANDS.filter((c) => c.tracksCursor === true).map((c) => c.name)).toEqual([
      'inbox',
      'watch',
    ]);
    expect(COMMANDS.filter((c) => c.stream !== undefined).map((c) => c.name)).toEqual(['watch']);
    expect(command('inbox').operation).toBe('readInbox');
    expect(command('watch').operation).toBe('watchInbox');
  });

  it('marks exactly the event-writing commands as writing', () => {
    expect(COMMANDS.filter((c) => c.writes).map((c) => c.name)).toEqual([
      'new',
      'claim',
      'release',
      'move',
      'comment',
      'handoff',
      'link',
      'checklist tick',
      'checklist untick',
      'close',
    ]);
  });

  it('accepts --as on every command as a global flag, listed by no command', () => {
    for (const c of COMMANDS) {
      expect(c.flags.includes(ACTOR_FLAG), c.name).toBe(false);
      expect(
        c.flags.some((f) => f.name === 'as'),
        c.name,
      ).toBe(false);
    }
    expect(ACTOR_FLAG).toMatchObject({ name: 'as', type: 'string', required: false });
  });

  it('gives --allow-secret-like to new, comment and handoff only', () => {
    expect(COMMANDS.filter((c) => c.flags.includes(ALLOW_SECRET_FLAG)).map((c) => c.name)).toEqual([
      'new',
      'comment',
      'handoff',
    ]);
    expect(ALLOW_SECRET_FLAG).toMatchObject({ name: 'allow-secret-like', type: 'boolean' });
  });

  it('accepts --json and --as everywhere through the global flags', () => {
    expect(GLOBAL_FLAGS).toEqual([JSON_FLAG, ACTOR_FLAG]);
    expect(JSON_FLAG).toMatchObject({ name: 'json', type: 'boolean', required: false });
  });

  it('is well-formed: unique argument names, ASCII summaries, sane positionals', () => {
    for (const c of COMMANDS) {
      expect(c.summary, c.name).toMatch(ASCII);
      const names = [...c.positionals, ...c.flags].map((a) => a.name);
      expect(new Set([...names, 'json', 'as']).size, c.name).toBe(names.length + 2);
      for (const a of [...c.positionals, ...c.flags]) {
        expect(a.summary, `${c.name} ${a.name}`).toMatch(ASCII);
        expect(a.name).toMatch(/^[a-z][a-z-]*$/);
      }
      for (const p of c.positionals) {
        expect(p.type).not.toBe('boolean');
        expect(p.repeatable).toBe(false);
      }
      // A required positional never follows an optional one.
      const firstOptional = c.positionals.findIndex((p) => !p.required);
      if (firstOptional >= 0) {
        expect(
          c.positionals.slice(firstOptional).every((p) => !p.required),
          c.name,
        ).toBe(true);
      }
      for (const group of c.exclusive) {
        for (const flagName of group.alternatives.flat()) {
          expect(
            c.flags.some((f) => f.name === flagName),
            `${c.name} ${flagName}`,
          ).toBe(true);
        }
      }
    }
  });

  it('names an exported library operation for every command but mcp and version', () => {
    const exported = lib as unknown as Record<string, unknown>;
    for (const c of COMMANDS) {
      if (c.name === 'mcp' || c.name === 'version') {
        expect(c.operation).toBeNull();
      } else {
        expect(typeof exported[String(c.operation)], c.name).toBe('function');
      }
    }
    expect(command('claim').operation).toBe('claimTicket');
    expect(command('checklist tick').operation).toBe('setChecklistItem');
  });

  it('describes the arguments of each command as in board-cli', () => {
    const shape = (name: string): unknown => {
      const c = command(name);
      return {
        positionals: c.positionals.map((p) => [p.name, p.type, p.required]),
        flags: c.flags.map((f) => [f.name, f.type, f.required, f.repeatable]),
        exclusive: c.exclusive.map((g) => [g.alternatives, g.required]),
      };
    };
    expect(shape('new')).toEqual({
      positionals: [['title', 'string', true]],
      flags: [
        ['description', 'string', false, false],
        ['label', 'string', false, true],
        ['task', 'string', false, false],
        ['change', 'string', false, false],
        ['group', 'string', false, false],
        ['adhoc', 'string', false, false],
        ['checklist', 'string', false, true],
        ['allow-secret-like', 'boolean', false, false],
      ],
      exclusive: [[[['task'], ['change', 'group'], ['adhoc']], true]],
    });
    expect(shape('list')).toEqual({
      positionals: [],
      flags: [
        ['status', 'string', false, false],
        ['assignee', 'string', false, false],
        ['task', 'string', false, false],
        ['change', 'string', false, false],
        ['label', 'string', false, true],
        ['closed', 'boolean', false, false],
      ],
      exclusive: [[[['task'], ['change']], false]],
    });
    expect(shape('move')).toMatchObject({
      positionals: [
        ['id', 'string', true],
        ['status', 'string', false],
      ],
    });
    expect(shape('comment')).toMatchObject({
      positionals: [
        ['id', 'string', true],
        ['text', 'string', true],
      ],
    });
    expect(shape('handoff')).toMatchObject({
      flags: expect.arrayContaining([
        ['to', 'string', true, false],
        ['status', 'string', true, false],
        ['note', 'string', true, false],
      ]) as unknown,
    });
    expect(shape('link')).toMatchObject({
      exclusive: [[[['task'], ['change', 'group'], ['pr'], ['decision']], true]],
    });
    expect(shape('checklist tick')).toMatchObject({
      positionals: [
        ['id', 'string', true],
        ['index', 'integer', true],
      ],
    });
    expect(shape('close')).toMatchObject({
      flags: [
        ['decision-recorded-in', 'string', false, false],
        ['no-decision', 'boolean', false, false],
      ],
      exclusive: [[[['decision-recorded-in'], ['no-decision']], true]],
    });
    expect(shape('show')).toEqual({
      positionals: [['id', 'string', true]],
      flags: [['raw', 'boolean', false, false]],
      exclusive: [],
    });
    expect(shape('inbox')).toEqual({
      positionals: [],
      flags: [
        ['since', 'string', false, false],
        ['peek', 'boolean', false, false],
      ],
      exclusive: [],
    });
    expect(shape('watch')).toEqual({ positionals: [], flags: [], exclusive: [] });
  });

  it('findCommand finds by full name only', () => {
    expect(findCommand('checklist tick')?.name).toBe('checklist tick');
    expect(findCommand('checklist')).toBeUndefined();
  });
});

describe('parseArgs: command selection', () => {
  it('matches multi-word commands', () => {
    const parsed = parseArgs(['checklist', 'tick', '01J9K3', '2', '--as', 'impl']);
    expect(parsed.command.name).toBe('checklist tick');
    expect(parsed.values).toEqual({ id: '01J9K3', index: 2, as: 'impl' });
    expect(parsed.json).toBe(false);
  });

  it.each([[[]], [['nope']], [['checklist']], [['checklist', 'toggle', 'x', '1']], [['--json']]])(
    'refuses %j with a usage error listing the commands',
    (argv) => {
      const err = expectBoardError(() => parseArgs(argv), 1, 'usage');
      expect(err.message).toContain('checklist tick');
      expect(err.message).toContain('version');
    },
  );
});

describe('parseArgs: flags and positionals', () => {
  it('accepts --name value, --name=value, and flags anywhere', () => {
    const a = parseArgs(['comment', '--as', 'a', 'T1ABCD', 'hello there']);
    const b = parseArgs(['comment', 'T1ABCD', '--as=a', 'hello there', '--json']);
    expect(a.values).toEqual({ id: 'T1ABCD', text: 'hello there', as: 'a' });
    expect(b.values).toEqual(a.values);
    expect(b.json).toBe(true);
  });

  it('takes a flag value verbatim even when it starts with a dash', () => {
    const parsed = parseArgs([
      'handoff',
      'T1ABCD',
      '--to',
      'r',
      '--status',
      'review',
      '--note',
      '--not-a-flag',
    ]);
    expect(parsed.values.note).toBe('--not-a-flag');
  });

  it('treats everything after -- as positional', () => {
    const parsed = parseArgs(['comment', 'T1ABCD', '--as', 'a', '--', '--json']);
    expect(parsed.values.text).toBe('--json');
    expect(parsed.json).toBe(false);
  });

  it('treats single-dash arguments as positional', () => {
    expect(parseArgs(['checklist', 'untick', 'T1ABCD', '-1']).values.index).toBe(-1);
    expect(parseArgs(['comment', 'T1ABCD', '-']).values.text).toBe('-');
  });

  it('collects repeatable flags in order and parses booleans', () => {
    const parsed = parseArgs([
      'new',
      'Title',
      '--label',
      'b',
      '--label=a',
      '--checklist',
      'one',
      '--adhoc',
      'why',
      '--allow-secret-like',
    ]);
    expect(parsed.values).toEqual({
      title: 'Title',
      label: ['b', 'a'],
      checklist: ['one'],
      adhoc: 'why',
      'allow-secret-like': true,
    });
  });

  it('accepts --as on every command, including those that ignore it', () => {
    expect(parseArgs(['list', '--as', 'a']).values).toEqual({ as: 'a' });
    expect(parseArgs(['show', 'T1ABCD', '--as=impl', '--json'])).toMatchObject({
      values: { id: 'T1ABCD', as: 'impl' },
      json: true,
    });
    expect(parseArgs(['version', '--as', 'x']).values).toEqual({ as: 'x' });
    const err = expectBoardError(() => parseArgs(['list', '--as', 'a', '--as', 'b']), 1, 'usage');
    expect(err.message).toContain('--as');
  });

  it('leaves absent arguments out of the values', () => {
    expect(parseArgs(['list']).values).toEqual({});
    expect(parseArgs(['move', 'T1ABCD']).values).toEqual({ id: 'T1ABCD' });
  });

  it.each([
    ['an unknown flag', ['list', '--colour', 'red'], '--colour'],
    ['a value on a boolean flag', ['list', '--closed=yes'], '--closed'],
    ['a missing flag value', ['list', '--status'], '--status'],
    ['a repeated single flag', ['list', '--status', 'todo', '--status', 'tests'], '--status'],
    ['too many positionals', ['comment', 'T1ABCD', 'hello', 'world'], 'world'],
    ['a missing positional', ['comment', 'T1ABCD'], 'text'],
    ['a missing required flag', ['handoff', 'T1ABCD', '--to', 'r', '--status', 'review'], '--note'],
    ['a non-integer index', ['checklist', 'tick', 'T1ABCD', 'two'], 'index'],
    ['a fractional index', ['checklist', 'tick', 'T1ABCD', '1.5'], 'index'],
  ])('refuses %s with exit 1 usage naming it', (_label, argv, named) => {
    const err = expectBoardError(() => parseArgs(argv), 1, 'usage');
    expect(err.message).toContain(named);
  });
});

describe('parseArgs: exclusive flag groups', () => {
  it('new without a task or ad hoc reason is needs-task-or-adhoc with the rule', () => {
    const err = expectBoardError(
      () => parseArgs(['new', 'Fix thing', '--as', 'a']),
      1,
      'needs-task-or-adhoc',
    );
    expect(err.message).toBe(TASK_RULE);
  });

  it.each([
    [['new', 'x', '--task', 'openspec:a#1', '--adhoc', 'why']],
    [['new', 'x', '--task', 'openspec:a#1', '--change', 'a', '--group', '1']],
    [['link', 'T1ABCD', '--pr', '1', '--decision', 'd.md']],
    [['close', 'T1ABCD', '--no-decision', '--decision-recorded-in', 'd.md']],
    [['list', '--task', 'openspec:a', '--change', 'a']],
  ])('refuses two alternatives %j', (argv) => {
    expectBoardError(() => parseArgs(argv), 1, 'usage');
  });

  it('refuses a partial alternative, naming the missing flag', () => {
    const err = expectBoardError(() => parseArgs(['new', 'x', '--change', 'a']), 1, 'usage');
    expect(err.message).toContain('--group');
    expectBoardError(() => parseArgs(['link', 'T1ABCD', '--group', '2']), 1, 'usage');
  });

  it('close without a disposition is no-disposition with the decision rule', () => {
    const err = expectBoardError(
      () => parseArgs(['close', 'T1ABCD', '--as', 'orch']),
      1,
      'no-disposition',
    );
    expect(err.message).toBe(CLOSE_RULE);
    expect(CLOSE_RULE).toContain('--decision-recorded-in');
    expect(CLOSE_RULE).toContain('--no-decision');
    expect(CLOSE_RULE).toMatch(/spec/);
    expect(CLOSE_RULE).toMatch(/ADR/);
  });

  it('link without a target is a usage error', () => {
    expectBoardError(() => parseArgs(['link', 'T1ABCD', '--as', 'a']), 1, 'usage');
  });

  it('accepts one complete alternative', () => {
    expect(parseArgs(['new', 'x', '--change', 'a', '--group', '3']).values).toEqual({
      title: 'x',
      change: 'a',
      group: '3',
    });
    expect(parseArgs(['close', 'T1ABCD', '--no-decision']).values).toEqual({
      id: 'T1ABCD',
      'no-decision': true,
    });
    expect(parseArgs(['list', '--change', 'a']).values).toEqual({ change: 'a' });
  });
});

describe('resolveActor', () => {
  it('uses --as first, then AGENTBOARD_ACTOR', () => {
    expect(ACTOR_ENV).toBe('AGENTBOARD_ACTOR');
    expect(resolveActor('impl', { AGENTBOARD_ACTOR: 'env' })).toBe('impl');
    expect(resolveActor(undefined, { AGENTBOARD_ACTOR: 'env' })).toBe('env');
    expect(resolveActor('', { AGENTBOARD_ACTOR: 'env' })).toBe('env');
  });

  it('never falls back to the OS user, and names both ways to supply an actor', () => {
    const env = { USER: 'ben', LOGNAME: 'ben', USERNAME: 'ben', AGENTBOARD_ACTOR: '' };
    const err = expectBoardError(() => resolveActor(undefined, env), 1, 'missing-actor');
    expect(err.message).toContain('--as');
    expect(err.message).toContain('AGENTBOARD_ACTOR');
    expectBoardError(() => resolveActor('', {}), 1, 'missing-actor');
  });
});
