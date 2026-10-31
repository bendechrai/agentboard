/**
 * The hint and the help of `invalid-actor` (actor-secret-check tasks 1.1,
 * 1.3 and 1.4; board-agent-guidance "Guide states the actor form",
 * scenarios "Hint for a refused actor" and "Help lists the reason").
 *
 * The hint is rendered in process for every command on both surfaces. Its
 * text is the implementer's (design.md "Messages"); these tests pin what it
 * must say: the placeholder `<actor>` (never a known actor, since the
 * context actor of an `invalid-actor` refusal is the refused name or
 * unchecked), the word `form`, and how to pass an actor on that surface.
 */

import { describe, expect, it } from 'vitest';

import { GITHUB_TOKEN } from '../../__tests__/harness/secret-fixtures.js';
import { oneJson, run } from '../../cli/__tests__/cli-helpers.js';
import { tempDir } from '../../board/__tests__/helpers.js';
import { COMMANDS } from '../../cli/registry.js';
import { HINT_EXIT_CODES, HINT_REASONS, renderHint, type HintContext } from '../hints.js';

const ASCII_LINE = /^[\x20-\x7e]+$/;

/** Every registry command and the unknown command. */
const COMMAND_NAMES: readonly (string | null)[] = [...COMMANDS.map((c) => c.name), null];

function hint(context: HintContext): string {
  const text = renderHint('invalid-actor', context);
  expect(text, JSON.stringify(context)).not.toBeNull();
  return text ?? '';
}

describe('invalid-actor is a reason with a hint', () => {
  it('is in HINT_REASONS with exit code 1', () => {
    expect(HINT_REASONS).toContain('invalid-actor');
    expect(HINT_EXIT_CODES['invalid-actor']).toBe(1);
  });
});

describe('the invalid-actor hint on the CLI', () => {
  it.each(COMMAND_NAMES.map((c) => [c]))(
    '%s: one ASCII line naming --as <actor>, with the word form',
    (command) => {
      const text = hint({ surface: 'cli', command });
      expect(text).toMatch(ASCII_LINE);
      expect(text).not.toMatch(/^hint:/);
      expect(text).toContain('--as <actor>');
      expect(text).toContain('form');
      expect(text).not.toContain('agentboard mcp');
    },
  );

  it.each(COMMANDS.map((c) => [c.name, c] as const))(
    '%s: says set AGENTBOARD_ACTOR exactly when the command uses it as the actor (review round 1 F5)',
    (name, command) => {
      const text = hint({ surface: 'cli', command: name });
      if (command.writes || command.tracksCursor === true) {
        expect(text).toContain('set AGENTBOARD_ACTOR');
      } else {
        expect(text).not.toContain('AGENTBOARD_ACTOR');
      }
    },
  );

  it('for handoff it names the actor and then, unambiguously, the new assignee (review round 1 F5)', () => {
    const text = hint({ surface: 'cli', command: 'handoff' });
    expect(text).toContain('--as <actor>');
    expect(text).toContain('set AGENTBOARD_ACTOR');
    expect(text).toContain(', and the new assignee with --to <actor>');
    expect(text).not.toContain('AGENTBOARD_ACTOR and the new assignee');
  });

  it('for handoff it also names --to <actor>, the other actor name the command takes', () => {
    expect(hint({ surface: 'cli', command: 'handoff' })).toContain('--to <actor>');
  });

  it('never writes the context actor or id: it is the same with and without them', () => {
    for (const command of COMMAND_NAMES) {
      const bare = hint({ surface: 'cli', command });
      for (const actor of ['impl-1', GITHUB_TOKEN]) {
        expect(hint({ surface: 'cli', command, actor, id: GITHUB_TOKEN })).toBe(bare);
      }
    }
  });
});

describe('the invalid-actor hint over MCP', () => {
  it.each(COMMAND_NAMES.map((c) => [c]))(
    '%s: names the as argument and agentboard mcp --as <actor>, not AGENTBOARD_ACTOR as advice',
    (command) => {
      const text = hint({ surface: 'mcp', command });
      expect(text).toMatch(ASCII_LINE);
      expect(text).toContain('as argument');
      expect(text).toContain('agentboard mcp --as <actor>');
      expect(text).toContain('form');
      expect(text).not.toContain('set AGENTBOARD_ACTOR');
    },
  );

  it('for handoff it also names the to argument', () => {
    expect(hint({ surface: 'mcp', command: 'handoff' })).toContain('to argument');
  });

  it('never writes the context actor', () => {
    for (const command of COMMAND_NAMES) {
      const bare = hint({ surface: 'mcp', command });
      expect(hint({ surface: 'mcp', command, actor: 'impl-1' })).toBe(bare);
      expect(hint({ surface: 'mcp', command, actor: GITHUB_TOKEN })).toBe(bare);
    }
  });
});

describe('scenario: Help lists the reason', () => {
  it('every registry command lists exit code 1 invalid-actor (every command checks a given --as)', () => {
    for (const command of COMMANDS) {
      expect(
        command.exitCodes.some((e) => e.code === 1 && e.reason === 'invalid-actor'),
        command.name,
      ).toBe(true);
    }
  });

  it.each(['comment', 'handoff', 'inbox'])(
    'help %s lists 1 invalid-actor, and its --as summary states the form',
    (name) => {
      const out = run(['help', name], tempDir());
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).toMatch(/^ {2}1 invalid-actor +\S/m);
      const doc = oneJson(run(['help', name, '--json'], tempDir())) as HelpDocument;
      const as = doc.globalFlags.find((f) => f.name === 'as')?.summary ?? '';
      expect(as).toContain('1 to 32');
      expect(as).toContain('ASCII');
    },
  );

  it('help handoff states the form on --to', () => {
    const doc = oneJson(run(['help', 'handoff', '--json'], tempDir())) as HelpDocument;
    const to = doc.flags.find((f) => f.name === 'to')?.summary ?? '';
    expect(to).toContain('1 to 32');
    expect(to).toContain('ASCII');
  });
});

/** The part of `help <command> --json` read here. */
interface HelpDocument {
  flags: { name: string; summary: string }[];
  globalFlags: { name: string; summary: string }[];
}

/**
 * How the help of `--as` and `--to` states the form (board-agent-guidance
 * "Guide states the actor form", review round 1 F1): the same words as the
 * `--as` summary of a command that needs an actor.
 */
const HELP_FORM = '1 to 32 ASCII letters, digits, . _ - or @, the first a letter or digit';

/** The `--as <actor>` line of the text help of `name`. */
function asLine(name: string): string {
  const out = run(['help', ...name.split(' ')], tempDir());
  expect(out.code, out.stderr).toBe(0);
  const lines = out.stdout.split('\n').filter((line) => /^ {2}--as <actor> /.test(line));
  expect(lines, name).toHaveLength(1);
  return lines[0] ?? '';
}

describe('the human help of --as on every command (review round 1 F1)', () => {
  it.each(COMMANDS.map((c) => [c.name]))(
    'help %s: the --as line says a given name is checked, gives the form, and never says ignored',
    (name) => {
      const line = asLine(name);
      expect(line).toContain(HELP_FORM);
      expect(line).toContain('checked');
      expect(line).not.toContain('Accepted and ignored');
      expect(line).not.toContain('ignored by this command');
    },
  );

  it('help serve and help mcp keep their own text and add the check and the form', () => {
    expect(asLine('serve')).toContain('write actions');
    expect(asLine('mcp')).toContain(HELP_FORM);
  });

  it.each(COMMANDS.map((c) => [c.name]))(
    'help %s --json: the --as summary gives the form',
    (name) => {
      const doc = oneJson(run(['help', ...name.split(' '), '--json'], tempDir())) as HelpDocument;
      const as = doc.globalFlags.find((f) => f.name === 'as')?.summary ?? '';
      expect(as).toContain(HELP_FORM);
    },
  );

  it('help handoff: the text --to line gives the form', () => {
    const out = run(['help', 'handoff'], tempDir());
    const line = out.stdout.split('\n').find((l) => /^ {2}--to <to> /.test(l)) ?? '';
    expect(line).toContain(HELP_FORM);
  });
});
