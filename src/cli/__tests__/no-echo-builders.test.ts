/**
 * The message builders of no-echo-refusals (task 1.1, 1.2 and 1.4; design.md
 * "Audit" rows 3, 10 and 33): `choicesMessage`, `unexpectedArgumentMessage`
 * (src/cli/parse.ts) and `unknownArgumentMessage` (src/mcp/tools.ts). Each
 * is built from the registry only; the source scan
 * (src/__tests__/no-echo-source-scan.test.ts) allows any call of them in a
 * refusal because of these tests.
 */

import { describe, expect, it } from 'vitest';

import { COMMANDS, findCommand } from '../registry.js';
import { STATUSES } from '../../events/schema.js';
import { toolInputSchema, toolName, unknownArgumentMessage } from '../../mcp/tools.js';
import { choicesMessage, unexpectedArgumentMessage } from '../parse.js';
import type { CommandSpec } from '../types.js';

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

describe('choicesMessage', () => {
  it('names the command and the argument and lists the choices', () => {
    expect(choicesMessage('move', '<status>', STATUSES)).toBe(
      'move takes <status> as one of todo, tests, implementing, review, merged, blocked',
    );
    expect(choicesMessage('handoff', '--status', STATUSES)).toBe(
      'handoff takes --status as one of todo, tests, implementing, review, merged, blocked',
    );
    expect(choicesMessage('config set', '<key>', ['lease.grace', 'queue.window'])).toBe(
      'config set takes <key> as one of lease.grace, queue.window',
    );
  });
});

describe('unexpectedArgumentMessage', () => {
  it('names the position and the positionals of the synopsis', () => {
    expect(unexpectedArgumentMessage(command('comment'), 6)).toBe(
      'unexpected argument at position 6 for comment; it takes <id> <text>, and text with spaces must be quoted',
    );
    expect(unexpectedArgumentMessage(command('move'), 4)).toBe(
      'unexpected argument at position 4 for move; it takes <id> [<status>], and text with spaces must be quoted',
    );
    expect(unexpectedArgumentMessage(command('checklist tick'), 5)).toBe(
      'unexpected argument at position 5 for checklist tick; it takes <id> <index>, and text with spaces must be quoted',
    );
    expect(unexpectedArgumentMessage(command('config set'), 5)).toBe(
      'unexpected argument at position 5 for config set; it takes <lease.grace|queue.window> <value>, and text with spaces must be quoted',
    );
    expect(unexpectedArgumentMessage(command('help'), 4)).toBe(
      'unexpected argument at position 4 for help; it takes [<topic>] [<subtopic>], and text with spaces must be quoted',
    );
  });

  it('says so for a command with no positionals', () => {
    expect(unexpectedArgumentMessage(command('version'), 2)).toBe(
      'unexpected argument at position 2 for version; it takes no positional arguments',
    );
    expect(unexpectedArgumentMessage(command('list'), 3)).toBe(
      'unexpected argument at position 3 for list; it takes no positional arguments',
    );
  });

  it('is plain ASCII on one line for every command', () => {
    for (const spec of COMMANDS) {
      expect(unexpectedArgumentMessage(spec, 9), spec.name).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('unknownArgumentMessage', () => {
  it('names the tool and its arguments in schema order', () => {
    expect(unknownArgumentMessage(command('show'))).toBe(
      'unknown argument for board_show; its arguments are id, raw, as',
    );
    expect(unknownArgumentMessage(command('checklist tick'))).toBe(
      'unknown argument for board_checklist_tick; its arguments are id, index, as',
    );
    for (const spec of COMMANDS) {
      expect(unknownArgumentMessage(spec), spec.name).toBe(
        `unknown argument for ${toolName(spec.name)}; its arguments are ${Object.keys(
          toolInputSchema(spec).properties,
        ).join(', ')}`,
      );
    }
  });
});
