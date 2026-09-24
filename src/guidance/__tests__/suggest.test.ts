/**
 * "Did you mean" suggestions (board-agent-guidance: "Unknown command
 * suggestions"; add-agent-guidance task 1.2), in process against the real
 * registry and small fixed registries.
 */

import { describe, expect, it } from 'vitest';

import { COMMANDS, GLOBAL_FLAGS, findCommand } from '../../cli/registry.js';
import type { ArgSpec, CommandSpec } from '../../cli/types.js';
import {
  MAX_SUGGESTIONS,
  MAX_SUGGESTION_DISTANCE,
  editDistance,
  suggestCommands,
  suggestFlags,
  unknownCommandMessage,
  unknownCommandToken,
  unknownFlagMessage,
} from '../suggest.js';

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

/** A minimal command for fixed registries. */
function fake(name: string, flags: readonly string[] = []): CommandSpec {
  return {
    name,
    summary: 's',
    description: 'd',
    group: 'lifecycle',
    examples: [{ command: `agentboard ${name}`, summary: 's' }],
    exitCodes: [{ code: 0, meaning: 'Success' }],
    positionals: [],
    flags: flags.map((f) => ({
      name: f,
      type: 'string',
      required: false,
      repeatable: false,
      summary: 's',
    })),
    exclusive: [],
    writes: false,
    operation: null,
    run: () => ({ json: null, text: '' }),
  };
}

function flagsOf(name: string): ArgSpec[] {
  return [...command(name).flags, ...GLOBAL_FLAGS];
}

describe('the suggestion limits', () => {
  it('are at most three suggestions within edit distance 2', () => {
    expect(MAX_SUGGESTIONS).toBe(3);
    expect(MAX_SUGGESTION_DISTANCE).toBe(2);
  });
});

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['claim', 'claim', 0],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['clam', 'claim', 1],
    ['claim', 'clam', 1],
    ['cliam', 'claim', 2],
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['note', 'nte', 1],
    ['list', 'lsit', 2],
    ['abc', 'xyz', 3],
  ])('between %j and %j is %i', (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });

  it('is symmetric', () => {
    const words = ['claim', 'close', 'clam', 'checklist tick', 'handoff', ''];
    for (const a of words) {
      for (const b of words) {
        expect(editDistance(a, b), `${a} ${b}`).toBe(editDistance(b, a));
      }
    }
  });
});

describe('suggestCommands', () => {
  it('scenario: clam suggests claim', () => {
    expect(suggestCommands(['clam', '01J9K3', '--as', 'impl'], COMMANDS)).toContain('claim');
    expect(suggestCommands(['clam'], COMMANDS)[0]).toBe('claim');
  });

  it('suggests nothing for a token with no close match', () => {
    expect(suggestCommands(['frobnicate'], COMMANDS)).toEqual([]);
    expect(suggestCommands(['zzzzzzzz', 'x'], COMMANDS)).toEqual([]);
  });

  it('suggests nothing for an empty argv', () => {
    expect(suggestCommands([], COMMANDS)).toEqual([]);
  });

  it('matches a two-word command against the first two arguments', () => {
    // Both share the first word; the closer full name comes first.
    expect(suggestCommands(['checklist', 'tik', '01J9K3', '0'], COMMANDS)).toEqual([
      'checklist tick',
      'checklist untick',
    ]);
    expect(suggestCommands(['checklist', 'untik'], COMMANDS)[0]).toBe('checklist untick');
  });

  it('suggests every command of a group word given alone or misspelled', () => {
    expect(suggestCommands(['checklist'], COMMANDS)).toEqual([
      'checklist tick',
      'checklist untick',
    ]);
    const misspelled = suggestCommands(['checklst', '01J9K3'], COMMANDS);
    expect([...misspelled].sort()).toEqual(['checklist tick', 'checklist untick']);
  });

  it('suggests hyphenated commands', () => {
    expect(suggestCommands(['import-chnage', 'x'], COMMANDS)).toEqual(['import-change']);
    expect(suggestCommands(['close-merge'], COMMANDS)[0]).toBe('close-merged');
  });

  it('never suggests beyond distance 2', () => {
    const commands = [fake('abcdef')];
    expect(suggestCommands(['abcd'], commands)).toEqual(['abcdef']);
    expect(suggestCommands(['abc'], commands)).toEqual([]);
  });

  it('orders by distance, then registry order, and returns at most three', () => {
    const commands = [fake('bbbx'), fake('bbbb'), fake('bbxx'), fake('bbyy'), fake('xbbb')];
    // distances from "bbbb": bbbx 1, bbbb 0, bbxx 2, bbyy 2, xbbb 1
    expect(suggestCommands(['bbbb'], commands)).toEqual(['bbbb', 'bbbx', 'xbbb']);
    expect(suggestCommands(['bbbb'], commands.slice(2))).toEqual(['xbbb', 'bbxx', 'bbyy']);
  });
});

describe('suggestFlags', () => {
  it('suggests the right flag for a misspelled one', () => {
    expect(suggestFlags('notes', flagsOf('handoff'))).toEqual(['--note']);
    // "not" is within 2 of both --note (1) and --to (2); the closer first.
    expect(suggestFlags('not', flagsOf('handoff'))).toEqual(['--note', '--to']);
    expect(suggestFlags('stauts', flagsOf('list'))[0]).toBe('--status');
    expect(suggestFlags('decision-recorded', flagsOf('close'))).toEqual([]);
    expect(suggestFlags('no-decison', flagsOf('close'))).toEqual(['--no-decision']);
  });

  it('includes the global flags', () => {
    // json is 1 away, as is 2 away; raw (the command's own flag) is 3 away.
    expect(suggestFlags('jsn', flagsOf('show'))).toEqual(['--json', '--as']);
  });

  it('suggests nothing when no flag is close', () => {
    expect(suggestFlags('colour', flagsOf('list'))).toEqual([]);
  });

  it('orders by distance and returns at most three', () => {
    const flags = fake('x', ['aaab', 'aaaa', 'aabb', 'abbb', 'aacc']).flags;
    // distances from "aaaa": aaab 1, aaaa 0, aabb 2, abbb 3, aacc 2
    expect(suggestFlags('aaaa', flags)).toEqual(['--aaaa', '--aaab', '--aabb']);
  });
});

describe('unknownCommandToken', () => {
  it('is the first argument', () => {
    expect(unknownCommandToken(['clam', '01J9K3'], COMMANDS)).toBe('clam');
  });

  it('is the first two arguments after the first word of a multi-word command', () => {
    expect(unknownCommandToken(['checklist', 'tik', '01J9K3'], COMMANDS)).toBe('checklist tik');
    expect(unknownCommandToken(['checklist'], COMMANDS)).toBe('checklist');
  });
});

describe('unknownCommandMessage', () => {
  it('names the token, suggests and points to agentboard help', () => {
    expect(unknownCommandMessage(['clam', '01J9K3', '--as', 'impl'], COMMANDS)).toBe(
      "unknown command clam; did you mean claim? run 'agentboard help' to list the commands",
    );
  });

  it('has no suggestion part when nothing is close', () => {
    expect(unknownCommandMessage(['frobnicate'], COMMANDS)).toBe(
      "unknown command frobnicate; run 'agentboard help' to list the commands",
    );
  });

  it('joins two and three suggestions', () => {
    expect(unknownCommandMessage(['checklist'], COMMANDS)).toBe(
      "unknown command checklist; did you mean checklist tick or checklist untick? run 'agentboard help' to list the commands",
    );
    const three = [fake('bbbx'), fake('bbbb'), fake('xbbb')];
    expect(unknownCommandMessage(['bbbb'], three)).toBe(
      "unknown command bbbb; did you mean bbbb, bbbx or xbbb? run 'agentboard help' to list the commands",
    );
  });

  it('keeps the message ASCII for a non-ASCII token', () => {
    expect(unknownCommandMessage([`cl${String.fromCharCode(0xe4)}im`], COMMANDS)).toMatch(
      /^[\x20-\x7e]+$/,
    );
  });
});

describe('unknownFlagMessage', () => {
  it('names the flag and command, suggests and points to the command help', () => {
    expect(unknownFlagMessage('notes', command('handoff'), flagsOf('handoff'))).toBe(
      "unknown flag --notes for handoff; did you mean --note? run 'agentboard help handoff' to list its flags",
    );
    expect(unknownFlagMessage('not', command('handoff'), flagsOf('handoff'))).toBe(
      "unknown flag --not for handoff; did you mean --note or --to? run 'agentboard help handoff' to list its flags",
    );
  });

  it('has no suggestion part when nothing is close', () => {
    expect(unknownFlagMessage('colour', command('list'), flagsOf('list'))).toBe(
      "unknown flag --colour for list; run 'agentboard help list' to list its flags",
    );
  });

  it('uses the full name of a two-word command', () => {
    expect(unknownFlagMessage('jsno', command('checklist tick'), flagsOf('checklist tick'))).toBe(
      "unknown flag --jsno for checklist tick; did you mean --json? run 'agentboard help checklist tick' to list its flags",
    );
  });
});
