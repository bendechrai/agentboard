/**
 * The agent guide (board-agent-guidance: "Agent guide"; add-agent-guidance
 * add-agent-guidance design.md: "The guide is code, tested against the registry"): the drift
 * guard (every `agentboard ` line of every guide output parses with the real
 * parser), the format (ASCII, at most 150 lines, version stamp, every
 * required section in order), the content each section and each role
 * checklist must carry, agreement with README.md, and `help agents [--role
 * <role>]` through the CLI, in process and built.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { cliEnv, oneJson, run, spawnCli } from '../../cli/__tests__/cli-helpers.js';
import { COMMANDS, HELP_SOURCE, findCommand } from '../../cli/registry.js';
import type { CommandSpec } from '../../cli/types.js';
import { STATUSES } from '../../events/schema.js';
import { EXCLUDED_COMMANDS, toolDefinitions } from '../../mcp/tools.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { helpOutput, renderCommandHelp, type HelpSource } from '../help.js';
import { VERSION } from '../../version.js';
import {
  GUIDE_MAX_LINES,
  GUIDE_SECTIONS,
  ROLES,
  agentsHelpOutput,
  isRole,
  renderGuide,
  renderRoleChecklist,
  type AgentsHelpDocument,
  type Role,
} from '../guide.js';
import { ASCII_LINE, commandLines, parseLine, parsedLines, type Parsed } from './guide-lines.js';

const README = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'README.md');

function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

/** The names of every guide output: the guide alone, then with each role. */
const OUTPUTS: readonly string[] = ['help agents', ...ROLES.map((r) => `help agents --role ${r}`)];

/** The text of the guide output named `name` (one of `OUTPUTS`). */
function output(name: string): string {
  const role = ROLES.find((r) => name === `help agents --role ${r}`);
  return renderGuide(VERSION) + (role === undefined ? '' : renderRoleChecklist(role));
}

/** Every guide output, as `[name, text]`. */
function outputs(): [string, string][] {
  return OUTPUTS.map((name) => [name, output(name)]);
}

/** The body of each guide section, keyed by heading (heading line excluded). */
function sections(guide: string): Map<string, string> {
  const lines = linesOf(guide);
  const starts = GUIDE_SECTIONS.map((heading) => lines.indexOf(heading));
  const out = new Map<string, string>();
  GUIDE_SECTIONS.forEach((heading, i) => {
    const start = starts[i] ?? -1;
    const end = i + 1 < starts.length ? (starts[i + 1] ?? lines.length) : lines.length;
    out.set(heading, lines.slice(start + 1, end).join('\n'));
  });
  return out;
}

function section(heading: string): string {
  const body = sections(renderGuide(VERSION)).get(heading);
  if (body === undefined) {
    throw new Error(`no section ${heading}`);
  }
  return body;
}

/** The README section under `## <title>`, up to the next `## `. */
function readmeSection(title: string): string {
  const text = readFileSync(README, 'utf8');
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, title).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The guide's exit code lines: code -> meaning. */
function guideExitCodes(): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of section('Exit codes and hints').split('\n')) {
    const match = /^ {2}([0-5]) {2,}(\S.*)$/.exec(line);
    if (match !== null) {
      expect(out.has(Number(match[1])), line).toBe(false);
      out.set(Number(match[1]), match[2] ?? '');
    }
  }
  return out;
}

/** README's exit code table: code -> meaning. */
function readmeExitCodes(): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of readmeSection('Exit codes').split('\n')) {
    const match = /^\| ([0-5]) \| (.+) \|$/.exec(line);
    if (match !== null) {
      out.set(Number(match[1]), match[2] ?? '');
    }
  }
  return out;
}

/** The exit 4 reasons the registry declares. */
function registryExit4Reasons(): string[] {
  const reasons = new Set<string>();
  for (const command of COMMANDS) {
    for (const exit of command.exitCodes) {
      if (exit.code === 4 && exit.reason !== undefined) {
        reasons.add(exit.reason);
      }
    }
  }
  return [...reasons].sort();
}

describe('the drift guard', () => {
  it.each(OUTPUTS)('scenario: every agentboard line of %s parses against the registry', (name) => {
    const lines = commandLines(output(name));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => parseLine(line), line).not.toThrow();
    }
  });

  it('the guide shows at least 12 command lines, covering the core commands', () => {
    const parsed = parsedLines(renderGuide(VERSION));
    expect(parsed.length).toBeGreaterThanOrEqual(12);
    const used = new Set(parsed.map((p) => p.command));
    for (const name of ['inbox', 'list', 'show', 'claim', 'handoff', 'move', 'comment', 'close']) {
      expect(used.has(name), name).toBe(true);
    }
  });

  it('every command line that writes or tracks a cursor passes --as', () => {
    for (const [name, text] of outputs()) {
      for (const p of parsedLines(text)) {
        const command = COMMANDS.find((c) => c.name === p.command);
        if (command !== undefined && (command.writes || command.tracksCursor === true)) {
          expect(typeof p.values.as, `${name}: ${p.line}`).toBe('string');
        }
      }
    }
  });

  it('every MCP tool it names is served', () => {
    const tools = new Set(toolDefinitions().map((t) => t.name));
    for (const [name, text] of outputs()) {
      for (const match of text.matchAll(/\bboard_[a-z_]+/g)) {
        expect(tools.has(match[0]), `${name}: ${match[0]}`).toBe(true);
      }
    }
  });
});

describe('the format', () => {
  it.each(OUTPUTS)('%s is ASCII, at most 150 lines, and ends with one newline', (name) => {
    const text = output(name);
    const lines = linesOf(text);
    expect(lines.length).toBeLessThanOrEqual(GUIDE_MAX_LINES);
    expect(GUIDE_MAX_LINES).toBe(150);
    for (const line of lines) {
      expect(line, JSON.stringify(line)).toMatch(ASCII_LINE);
    }
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('is stamped with the running version on its first line', () => {
    expect(linesOf(renderGuide(VERSION))[0]).toBe(`Agent guide for agentboard ${VERSION}`);
    expect(linesOf(renderGuide('9.8.7'))[0]).toBe('Agent guide for agentboard 9.8.7');
    expect(renderGuide('9.8.7').split('\n').slice(1)).toEqual(
      renderGuide(VERSION).split('\n').slice(1),
    );
  });

  it('contains each required section, in order, each heading after an empty line', () => {
    expect(GUIDE_SECTIONS).toEqual([
      'What the board is and is not',
      'The actor rule',
      'Finding work',
      'Claiming before you start',
      'Handing off and blocking',
      'Decisions and closing',
      'Tickets and planning tasks',
      'Using the MCP tools',
      'Exit codes and hints',
    ]);
    const lines = linesOf(renderGuide(VERSION));
    let previous = 0;
    for (const heading of GUIDE_SECTIONS) {
      const at = lines.indexOf(heading);
      expect(at, heading).toBeGreaterThan(previous);
      expect(lines[at - 1], heading).toBe('');
      expect(lines.filter((l) => l === heading)).toHaveLength(1);
      previous = at;
    }
  });

  it('a role output is the guide unchanged followed by the checklist', () => {
    for (const role of ROLES) {
      const checklist = renderRoleChecklist(role);
      expect(checklist.startsWith(`\nChecklist: ${role}\n`), role).toBe(true);
      expect(checklist).toMatch(/^1\. \S/m);
      expect(agentsHelpOutput(VERSION, role).text).toBe(renderGuide(VERSION) + checklist);
    }
  });
});

describe('the sections', () => {
  it('what the board is and is not', () => {
    const text = section('What the board is and is not');
    expect(text).toMatch(/not a secret store/i);
    expect(text).toMatch(/not the record of completion/i);
    expect(text).toContain('tasks.md');
    expect(text).toContain('--allow-secret-like');
  });

  it('the actor rule', () => {
    const text = section('The actor rule');
    expect(text).toContain('--as <actor>');
    expect(text).toContain('AGENTBOARD_ACTOR');
    expect(text).toMatch(/OS user/);
    expect(text).toContain('inbox');
  });

  it('finding work', () => {
    const text = section('Finding work');
    const used = parsedLines(text).map((p) => p.command);
    expect(used).toEqual(expect.arrayContaining(['inbox', 'list', 'show']));
    expect(text).toContain('--peek');
  });

  it('claiming before you start', () => {
    const text = section('Claiming before you start');
    expect(parsedLines(text).map((p) => p.command)).toContain('claim');
    expect(text).toContain('already-assigned');
    expect(text).toContain('release');
  });

  it('handing off and blocking', () => {
    const text = section('Handing off and blocking');
    const parsed = parsedLines(text);
    expect(parsed.map((p) => p.command)).toEqual(expect.arrayContaining(['handoff', 'comment']));
    expect(parsed.some((p) => p.command === 'move' && p.values.status === 'blocked')).toBe(true);
    expect(parsed.some((p) => p.command === 'move' && p.values.status === undefined)).toBe(true);
    for (const status of STATUSES) {
      expect(text, status).toContain(status);
    }
  });

  it('decisions and closing', () => {
    const text = section('Decisions and closing');
    for (const fragment of ['DECISION:', 'RETRACTED:', 'spec delta', 'ADR', 'merged', 'blocked']) {
      expect(text, fragment).toContain(fragment);
    }
    const closes = parsedLines(text).filter((p) => p.command === 'close');
    expect(closes.some((p) => typeof p.values['decision-recorded-in'] === 'string')).toBe(true);
    expect(closes.some((p) => p.values['no-decision'] === true)).toBe(true);
    expect(
      parsedLines(text).some(
        (p) => p.command === 'comment' && String(p.values.text).startsWith('DECISION:'),
      ),
    ).toBe(true);
  });

  it('tickets and planning tasks, with the OpenSpec flow', () => {
    const text = section('Tickets and planning tasks');
    for (const fragment of [
      '<source>:<ref>#<item>',
      '--adhoc',
      'needs-task-link',
      'tasks.md',
      'close-merged',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
    const used = parsedLines(text);
    expect(used.map((p) => p.command)).toEqual(expect.arrayContaining(['import-change', 'claim']));
    expect(used.some((p) => p.command === 'link' && typeof p.values.task === 'string')).toBe(true);
    expect(used.some((p) => p.command === 'new' && typeof p.values.change === 'string')).toBe(true);
  });

  it('using the MCP tools: tool names, the as argument, the server default, what is not a tool', () => {
    const text = section('Using the MCP tools');
    for (const tool of ['board_claim', 'board_inbox', 'board_handoff', 'board_checklist_tick']) {
      expect(text, tool).toContain(tool);
    }
    expect(text).toMatch(/\bas\b[^\n]*argument|argument[^\n]*\bas\b/);
    expect(
      parsedLines(text).some((p) => p.command === 'mcp' && typeof p.values.as === 'string'),
    ).toBe(true);
    expect(text).toContain('hint');
    for (const name of EXCLUDED_COMMANDS) {
      expect(text, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('exit codes: one line per code 0 to 5, with every exit 4 reason, and hints', () => {
    const codes = guideExitCodes();
    expect([...codes.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const reason of registryExit4Reasons()) {
      expect(codes.get(4), reason).toContain(reason);
    }
    const text = section('Exit codes and hints');
    expect(text).toContain('hint: ');
    expect(commandLines(text).some((l) => l.startsWith('agentboard help'))).toBe(true);
  });
});

describe('agreement with README.md', () => {
  it('the exit codes agree', () => {
    const guide = guideExitCodes();
    const readme = readmeExitCodes();
    expect([...readme.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const keywords: Record<number, RegExp[]> = {
      0: [/success/i],
      1: [/usage/i, /actor/i],
      2: [/board not found/i],
      3: [/sync/i],
      4: [/rejected by board state/i],
      5: [/integrity/i],
    };
    for (const [code, patterns] of Object.entries(keywords)) {
      for (const pattern of patterns) {
        expect(guide.get(Number(code)), `guide ${code}`).toMatch(pattern);
        expect(readme.get(Number(code)), `README ${code}`).toMatch(pattern);
      }
    }
    for (const match of (readme.get(4) ?? '').matchAll(/`([a-z-]+)`/g)) {
      expect(guide.get(4), match[1]).toContain(match[1]);
    }
  });

  it('the actor rule agrees', () => {
    const readme = readmeSection('The actor rule');
    const guide = section('The actor rule');
    for (const fragment of ['--as <actor>', 'AGENTBOARD_ACTOR', 'OS user', 'inbox', 'watch']) {
      expect(readme, fragment).toContain(fragment);
      expect(guide, fragment).toContain(fragment);
    }
  });

  it('the DECISION: rule agrees', () => {
    const readme = readmeSection('Decisions and closing tickets');
    const guide = section('Decisions and closing');
    for (const fragment of [
      'DECISION:',
      'RETRACTED:',
      '--decision-recorded-in',
      '--no-decision',
      'spec delta',
      'ADR',
    ]) {
      expect(readme, fragment).toContain(fragment);
      expect(guide, fragment).toContain(fragment);
    }
  });

  it('every MCP tool the guide names is in the README tool list', () => {
    const readme = readmeSection('MCP server');
    for (const match of renderGuide(VERSION).matchAll(/\bboard_[a-z_]+/g)) {
      expect(readme, match[0]).toContain(`\`${match[0]}\``);
    }
  });

  it('the permitted statuses agree', () => {
    const readme = readmeSection('Statuses and the state machine');
    for (const status of STATUSES) {
      expect(readme, status).toContain(`\`${status}\``);
    }
  });
});

describe('the role checklists', () => {
  function roleLines(role: Role): Parsed[] {
    return parsedLines(renderRoleChecklist(role));
  }

  it.each(ROLES)('%s has at least three command lines', (role) => {
    expect(roleLines(role).length).toBeGreaterThanOrEqual(3);
  });

  it('orchestrator: inbox first, import-change, and closing after merge', () => {
    const lines = roleLines('orchestrator');
    expect(lines[0]?.command).toBe('inbox');
    const used = lines.map((p) => p.command);
    expect(used).toContain('import-change');
    expect(used.some((c) => c === 'close-merged' || c === 'close')).toBe(true);
    expect(renderRoleChecklist('orchestrator')).toContain('DECISION:');
  });

  it('orchestrator: health when choosing what to dispatch and before archiving', () => {
    const text = renderRoleChecklist('orchestrator');
    const lines = roleLines('orchestrator');
    const health = lines.filter((p) => p.command === 'health');
    expect(health).toHaveLength(1);
    // The line parses to health (the drift guard) and needs no actor.
    expect(health[0]?.line).toMatch(/^agentboard health(\s|$)/);
    // It is taught for both occasions the task names.
    expect(text).toMatch(/dispatch/);
    expect(text).toMatch(/archiv/);
    const at = lines.findIndex((p) => p.command === 'health');
    // After the first inbox, and before closing after merge.
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(lines.findIndex((p) => p.command === 'close-merged'));
    // The whole orchestrator output stays within the cap.
    const out = renderGuide(VERSION) + text;
    expect(out.slice(0, -1).split('\n').length).toBeLessThanOrEqual(GUIDE_MAX_LINES);
  });

  it('test-author: claim, move to tests, hand off to implementing', () => {
    const lines = roleLines('test-author');
    expect(lines.map((p) => p.command)).toContain('claim');
    expect(lines.some((p) => p.command === 'move' && p.values.status === 'tests')).toBe(true);
    expect(lines.some((p) => p.command === 'handoff' && p.values.status === 'implementing')).toBe(
      true,
    );
  });

  it('implementer: hand off to review, tick tasks.md in the PR, record decisions', () => {
    const text = renderRoleChecklist('implementer');
    const lines = roleLines('implementer');
    expect(lines.some((p) => p.command === 'handoff' && p.values.status === 'review')).toBe(true);
    expect(text).toContain('tasks.md');
    expect(text).toContain('DECISION:');
    expect(lines.some((p) => p.command === 'move' && p.values.status === 'blocked')).toBe(true);
  });

  it('reviewer: send back to implementing, or link the pull request', () => {
    const lines = roleLines('reviewer');
    expect(lines.some((p) => p.command === 'handoff' && p.values.status === 'implementing')).toBe(
      true,
    );
    expect(lines.some((p) => p.command === 'link' && typeof p.values.pr === 'string')).toBe(true);
  });
});

describe('agentsHelpOutput and isRole', () => {
  it('isRole accepts exactly the four roles', () => {
    expect(ROLES).toEqual(['orchestrator', 'test-author', 'implementer', 'reviewer']);
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
    for (const text of ['', 'tester', 'Implementer', 'reviewer ', 'test_author']) {
      expect(isRole(text), text).toBe(false);
    }
  });

  it('without a role: the guide, and the JSON document with role null', () => {
    const out = agentsHelpOutput(VERSION, undefined);
    expect(out.text).toBe(renderGuide(VERSION));
    const doc: AgentsHelpDocument = {
      topic: 'agents',
      version: VERSION,
      role: null,
      text: out.text,
    };
    expect(out.json).toEqual(doc);
  });

  it('with a role: the guide and checklist, and the JSON document with that role', () => {
    const out = agentsHelpOutput('1.2.3', 'reviewer');
    expect(out.json).toEqual({
      topic: 'agents',
      version: '1.2.3',
      role: 'reviewer',
      text: out.text,
    });
    expect(out.text).toBe(renderGuide('1.2.3') + renderRoleChecklist('reviewer'));
  });

  it('scenario: an unknown role is a usage error listing the four roles', () => {
    for (const role of ['tester', '']) {
      const err = expectBoardError(() => agentsHelpOutput(VERSION, role), 1, 'usage');
      for (const valid of ROLES) {
        expect(err.message, valid).toContain(valid);
      }
    }
    expect(
      expectBoardError(() => agentsHelpOutput(VERSION, 'tester'), 1, 'usage').message,
    ).toContain('tester');
  });
});

describe('help agents beside commands whose first word is agents', () => {
  /** Fake `agents install` and `agents check` commands, standing in for the real ones. */
  function withAgentsCommands(): { source: HelpSource; fakes: CommandSpec[] } {
    const base = findCommand('version');
    if (base === undefined) {
      throw new Error('no version command');
    }
    const fakes = ['agents install', 'agents check'].map((name): CommandSpec => ({
      ...base,
      name,
      summary: `${name} (fake, for this test)`,
      examples: [{ command: 'agentboard version', summary: 'placeholder' }],
    }));
    // The fakes replace the real commands of the same names.
    const others = COMMANDS.filter((c) => !c.name.startsWith('agents '));
    return { source: { ...HELP_SOURCE, commands: [...others, ...fakes] }, fakes };
  }

  it('help agents is still the guide, with or without --role', () => {
    const { source } = withAgentsCommands();
    expect(helpOutput(source, ['agents']).text).toBe(renderGuide(VERSION));
    expect(helpOutput(source, ['agents'], 'implementer').text).toBe(
      renderGuide(VERSION) + renderRoleChecklist('implementer'),
    );
    expect(helpOutput(source, ['agents'], 'implementer').json).toMatchObject({
      topic: 'agents',
      role: 'implementer',
    });
    expectBoardError(() => helpOutput(source, ['agents'], 'tester'), 1, 'usage');
  });

  it("help agents install and help agents check are those commands' help, and refuse --role", () => {
    const { source, fakes } = withAgentsCommands();
    for (const fake of fakes) {
      const words = fake.name.split(' ');
      expect(helpOutput(source, words).text, fake.name).toBe(renderCommandHelp(source, fake));
      expectBoardError(() => helpOutput(source, words, 'implementer'), 1, 'usage');
    }
  });
});

describe('help agents through the CLI', () => {
  it('prints the guide with no board and no actor, creating nothing', () => {
    const dir = tempDir();
    const out = run(['help', 'agents'], dir, cliEnv());
    expect(out).toEqual({ code: 0, stdout: renderGuide(VERSION), stderr: '' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(ROLES)('help agents --role %s prints the guide and the checklist', (role) => {
    const out = run(['help', 'agents', '--role', role], tempDir(), cliEnv());
    expect(out).toEqual({
      code: 0,
      stdout: renderGuide(VERSION) + renderRoleChecklist(role),
      stderr: '',
    });
  });

  it('--json prints the AgentsHelpDocument', () => {
    const out = run(['help', 'agents', '--role', 'implementer', '--json'], tempDir(), cliEnv());
    expect(out.code).toBe(0);
    expect(oneJson(out)).toEqual({
      topic: 'agents',
      version: VERSION,
      role: 'implementer',
      text: renderGuide(VERSION) + renderRoleChecklist('implementer'),
    });
  });

  it('scenario: help agents --role tester exits 1 listing the four roles', () => {
    const out = run(['help', 'agents', '--role', 'tester'], tempDir(), cliEnv());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    const first = out.stderr.split('\n')[0] ?? '';
    expect(first).toMatch(/^agentboard: /);
    expect(first).toContain('tester');
    for (const role of ROLES) {
      expect(first, role).toContain(role);
    }
  });

  it.each([
    ['help claim --role implementer', ['help', 'claim', '--role', 'implementer']],
    ['help --role implementer', ['help', '--role', 'implementer']],
    ['help checklist tick --role reviewer', ['help', 'checklist', 'tick', '--role', 'reviewer']],
  ])('%s: --role outside help agents is a usage error', (_name, argv) => {
    const out = run(argv, tempDir(), cliEnv());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    const first = out.stderr.split('\n')[0] ?? '';
    expect(first).toContain('--role');
    expect(first).toContain('agentboard help agents');
  });

  it('help agents --role with no value and help agents with a subtopic exit 1', () => {
    expect(run(['help', 'agents', '--role'], tempDir(), cliEnv()).code).toBe(1);
    expect(run(['help', 'agents', 'extra'], tempDir(), cliEnv()).code).toBe(1);
  });

  it('the overview still ends with the agents line, which names a working topic', () => {
    const out = run(['help'], tempDir(), cliEnv());
    expect(out.stdout.trimEnd().split('\n').at(-1)).toBe(
      "Agents: run 'agentboard help agents' before first use.",
    );
    expect(run(['help', 'agents'], tempDir(), cliEnv()).code).toBe(0);
  });
});

describe('help agents through the built CLI', () => {
  it('scenario: agentboard help agents --role tester exits 1 and lists the four roles', () => {
    const out = spawnCli(['help', 'agents', '--role', 'tester'], tempDir(), cliEnv());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    for (const role of ROLES) {
      expect(out.stderr, role).toContain(role);
    }
  });

  it('agentboard help agents prints the guide on stdout and exits 0', () => {
    const out = spawnCli(['help', 'agents'], tempDir(), cliEnv());
    expect(out).toEqual({ code: 0, stdout: renderGuide(VERSION), stderr: '' });
  });
});
