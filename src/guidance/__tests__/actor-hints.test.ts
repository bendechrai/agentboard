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
    '%s: one ASCII line naming --as <actor> and AGENTBOARD_ACTOR, with the word form',
    (command) => {
      const text = hint({ surface: 'cli', command });
      expect(text).toMatch(ASCII_LINE);
      expect(text).not.toMatch(/^hint:/);
      expect(text).toContain('--as <actor>');
      expect(text).toContain('AGENTBOARD_ACTOR');
      expect(text).toContain('form');
      expect(text).not.toContain('agentboard mcp');
    },
  );

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
