/**
 * The guide summary sent as the MCP server `instructions`
 * (board-agent-guidance: "Guide over MCP"; add-agent-guidance task 4.1):
 * the format (version stamp, ASCII, at most 2000 characters, ends by
 * naming `agentboard://guide`), the rules it must carry, and the drift
 * guard shared with the guide (every command line parses, is one of the
 * guide's, and passes `--as` when it must; every tool it names is served).
 */

import { describe, expect, it } from 'vitest';

import { VERSION } from '../../version.js';
import {
  GUIDE_RESOURCE_URI,
  GUIDE_SUMMARY_MAX_CHARS,
  ROLES,
  renderGuide,
  renderGuideSummary,
} from '../guide.js';
import {
  ASCII_LINE,
  commandLines,
  linesMissingActor,
  parseLine,
  parsedLines,
  toolNames,
  unservedTools,
} from './guide-lines.js';

function summary(): string {
  return renderGuideSummary(VERSION);
}

function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

describe('the constants', () => {
  it('names the resource agentboard://guide and caps the summary at 2000 characters', () => {
    expect(GUIDE_RESOURCE_URI).toBe('agentboard://guide');
    expect(GUIDE_SUMMARY_MAX_CHARS).toBe(2000);
  });
});

describe('the format', () => {
  it('is stamped with the version given on its first line', () => {
    expect(linesOf(summary())[0]).toBe(`Agent guide summary for agentboard ${VERSION}`);
    expect(linesOf(renderGuideSummary('9.8.7'))[0]).toBe('Agent guide summary for agentboard 9.8.7');
  });

  it('is pure', () => {
    expect(renderGuideSummary(VERSION)).toBe(renderGuideSummary(VERSION));
  });

  it('has at most 2000 characters, the final newline included', () => {
    expect(summary().length).toBeLessThanOrEqual(GUIDE_SUMMARY_MAX_CHARS);
  });

  it('is short of the cap even with a long version stamp', () => {
    const long = renderGuideSummary('10.20.300-rc.4000+build.56789');
    expect(long.length).toBeLessThanOrEqual(GUIDE_SUMMARY_MAX_CHARS);
  });

  it('is printable ASCII with no tabs and no trailing spaces, ending with one newline', () => {
    const text = summary();
    for (const line of linesOf(text)) {
      expect(line, JSON.stringify(line)).toMatch(ASCII_LINE);
    }
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('ends by naming the full guide resource', () => {
    const lines = linesOf(summary());
    const last = lines.at(-1) ?? '';
    expect(last.endsWith(`${GUIDE_RESOURCE_URI}.`)).toBe(true);
    // The last sentence calls the resource the full guide.
    expect(summary()).toMatch(/\bfull (?:agent )?guide\b[^.]*agentboard:\/\/guide\.\n$/);
  });

  it('is much shorter than the guide it summarizes', () => {
    expect(summary().length).toBeLessThan(renderGuide(VERSION).length / 2);
  });
});

describe('the drift guard', () => {
  it('every agentboard line parses against the registry', () => {
    const lines = commandLines(summary());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(() => parseLine(line), line).not.toThrow();
    }
  });

  it('every agentboard line is also a command line of the guide', () => {
    const guide = new Set(commandLines(renderGuide(VERSION)));
    for (const line of commandLines(summary())) {
      expect(guide.has(line), line).toBe(true);
    }
  });

  it('every command line that writes or tracks a cursor passes --as', () => {
    expect(linesMissingActor(summary())).toEqual([]);
  });

  it('every MCP tool it names is served', () => {
    expect(toolNames(summary()).length).toBeGreaterThan(0);
    expect(unservedTools(summary())).toEqual([]);
  });
});

describe('the rules it carries', () => {
  it('says what the tools are', () => {
    const text = summary();
    expect(text).toContain('board_');
    expect(text).toMatch(/leading\s+--/);
  });

  it('states the actor rule: the as argument, then the server --as, then AGENTBOARD_ACTOR', () => {
    const text = summary();
    expect(text).toMatch(/\bas\s+argument\b/);
    expect(text).toContain('AGENTBOARD_ACTOR');
    expect(
      parsedLines(text).some((p) => p.command === 'mcp' && typeof p.values.as === 'string'),
    ).toBe(true);
    const asArg = text.search(/\bas\s+argument\b/);
    const serverAs = text.indexOf('agentboard mcp --as');
    const env = text.indexOf('AGENTBOARD_ACTOR');
    expect(asArg).toBeLessThan(serverAs);
    expect(serverAs).toBeLessThan(env);
  });

  it('sends the agent to the board for work and state', () => {
    const names = new Set(toolNames(summary()));
    for (const tool of ['board_inbox', 'board_list', 'board_show']) {
      expect(names.has(tool), tool).toBe(true);
    }
  });

  it('says to claim before working, and what already-assigned means', () => {
    const text = summary();
    expect(text).toContain('board_claim');
    expect(text).toContain('already-assigned');
  });

  it('says to hand off, or block with a comment, before stopping', () => {
    const text = summary();
    for (const fragment of ['board_handoff', 'board_move', 'blocked', 'board_comment']) {
      expect(text, fragment).toContain(fragment);
    }
  });

  it('says DECISION: comments are promoted to a spec delta or ADR before closing', () => {
    const text = summary();
    for (const fragment of ['DECISION:', 'spec delta', 'ADR', 'board_close']) {
      expect(text, fragment).toContain(fragment);
    }
    expect(text.indexOf('DECISION:')).toBeLessThan(text.lastIndexOf('board_close'));
  });

  it('says tasks.md, not the board, is the record of completion', () => {
    const text = summary();
    expect(text).toContain('tasks.md');
    expect(text).toMatch(/\bcompletion\b/);
  });

  it('says the board is not a secret store', () => {
    expect(summary()).toMatch(/\bsecret\b/);
  });

  it('names the error fields, including the hint', () => {
    const text = summary();
    for (const field of ['exitCode', 'reason', 'message', 'hint']) {
      expect(text, field).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('names the role checklist resources and the four roles', () => {
    const text = summary();
    expect(text).toContain(`${GUIDE_RESOURCE_URI}/<role>`);
    for (const role of ROLES) {
      expect(text, role).toMatch(new RegExp(`\\b${role}\\b`));
    }
  });
});
