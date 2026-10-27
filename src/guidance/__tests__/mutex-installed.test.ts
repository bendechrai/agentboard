/**
 * The short mutex recipe in the installed guidance and the guidance
 * version that carries it (add-claim-leases task 6.1; board-agent-guidance:
 * "Mutex ticket recipe", scenarios "Installed skill carries the recipe" and
 * "Version 2 installs are stale").
 *
 * In `SKILL.md` the recipe is the section headed `## Mutex tickets`, after
 * the rules and before `## Everything else`; in the AGENTS.md block it is
 * the paragraph introduced by the line `Mutex tickets:`, after the rules
 * and before the pointer to the full guide. Phrases are searched with line
 * breaks read as spaces and case ignored, as the spec delta pins them.
 */

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../cli/parse.js';
import { cliEnv, run } from '../../cli/__tests__/cli-helpers.js';
import { checkCommand, checkGuidance } from '../check.js';
import { installGuidance } from '../install.js';
import {
  GUIDANCE_RULES,
  GUIDANCE_VERSION,
  renderAgentsBlock,
  renderSkill,
  skillMarker,
} from '../installed-text.js';
import { ENV, plainProject, readRel } from './guidance-helpers.js';
import { unservedTools } from './guide-lines.js';
import { splitCommandLine } from './command-line.js';

const SKILL = '.claude/skills/agentboard/SKILL.md';

/** `text` with every run of whitespace as one space, lower-cased. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

/** Every backticked span that starts with `agentboard `. */
function backtickedCommands(text: string): string[] {
  return [...text.matchAll(/`(agentboard [^`]*)`/g)].map((m) => m[1] ?? '');
}

/** The lines of `text` from the line `from` (excluded) to the first line `to` (excluded). */
function between(text: string, from: string, to: (line: string) => boolean): string {
  const lines = text.split('\n');
  const start = lines.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(to);
  expect(end, `the line after ${from}`).toBeGreaterThan(0);
  return rest.slice(0, end).join('\n');
}

/** The skill's mutex section: from `## Mutex tickets` to the next `## ` heading. */
function skillRecipe(): string {
  return between(renderSkill(), '## Mutex tickets', (l) => l.startsWith('## '));
}

/** The block's mutex paragraph: from `Mutex tickets:` to the pointer. */
function blockRecipe(): string {
  return between(renderAgentsBlock(), 'Mutex tickets:', (l) =>
    l.startsWith('Run `agentboard help agents`'),
  );
}

const RECIPES: readonly [string, () => string][] = [
  ['the skill', skillRecipe],
  ['the AGENTS.md block', blockRecipe],
];

interface Cmd {
  line: string;
  command: string;
  values: Record<string, unknown>;
}

function parsed(text: string): Cmd[] {
  return backtickedCommands(text).map((line) => {
    const words = splitCommandLine(line);
    const p = parseArgs(words.slice(1));
    return { line, command: p.command.name, values: { ...p.values } };
  });
}

describe('where the recipe sits', () => {
  it('the skill has ## Mutex tickets after the rules and before ## Everything else', () => {
    const lines = renderSkill().split('\n');
    const rules = lines.indexOf('## Rules you must never break');
    const mutex = lines.indexOf('## Mutex tickets');
    const rest = lines.indexOf('## Everything else');
    expect(rules).toBeGreaterThan(0);
    expect(mutex).toBeGreaterThan(
      lines.indexOf(`${String(GUIDANCE_RULES.length)}. ${GUIDANCE_RULES.at(-1) ?? ''}`),
    );
    expect(mutex).toBeGreaterThan(rules);
    expect(rest).toBeGreaterThan(mutex);
    expect(lines[mutex - 1]).toBe('');
    expect(lines[mutex + 1]).toBe('');
  });

  it('the block has the Mutex tickets: paragraph after the rules and before the pointer', () => {
    const lines = renderAgentsBlock().split('\n');
    const lastRule = lines.indexOf(
      `${String(GUIDANCE_RULES.length)}. ${GUIDANCE_RULES.at(-1) ?? ''}`,
    );
    const mutex = lines.indexOf('Mutex tickets:');
    const pointer = lines.findIndex((l) => l.startsWith('Run `agentboard help agents`'));
    expect(lastRule).toBeGreaterThan(0);
    expect(mutex).toBeGreaterThan(lastRule);
    expect(pointer).toBeGreaterThan(mutex);
    expect(lines[mutex - 1]).toBe('');
  });

  it('keeps both short and ASCII', () => {
    expect(renderSkill().split('\n').length).toBeLessThanOrEqual(45);
    expect(renderAgentsBlock().split('\n').length).toBeLessThanOrEqual(40);
    expect(renderSkill()).toMatch(/^[\n\x20-\x7e]*$/);
    expect(renderAgentsBlock()).toMatch(/^[\n\x20-\x7e]*$/);
    for (const line of [...renderSkill().split('\n'), ...renderAgentsBlock().split('\n')]) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe.each(RECIPES)('the short recipe in %s', (_name, recipe) => {
  it('states the worker rules', () => {
    const text = flat(recipe());
    for (const phrase of [
      'never wait on a mutex in a loop',
      'background process',
      'report ready',
      'first action of real work',
      'only joins the queue',
      'board_inbox',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(unservedTools(recipe())).toEqual([]);
  });

  it('shows the claim, renew, wait and release commands, each parsing with --as', () => {
    const commands = parsed(recipe());
    expect(
      commands.some(
        (c) => c.command === 'claim' && typeof c.values.ttl === 'string' && c.values.wait !== true,
      ),
      'claim --ttl',
    ).toBe(true);
    expect(
      commands.some((c) => c.command === 'renew'),
      'renew',
    ).toBe(true);
    expect(
      commands.some(
        (c) =>
          c.command === 'claim' &&
          typeof c.values.ttl === 'string' &&
          c.values.wait === true &&
          typeof c.values.timeout === 'string',
      ),
      'claim --ttl --wait --timeout',
    ).toBe(true);
    expect(
      commands.some((c) => c.command === 'release' && c.values.force !== true),
      'release',
    ).toBe(true);
    for (const c of commands) {
      expect(typeof c.values.as, c.line).toBe('string');
    }
  });
});

describe('the pointer to the full guide stays', () => {
  it.each([
    ['the skill', renderSkill],
    ['the AGENTS.md block', renderAgentsBlock],
  ])('%s still points to agentboard help agents', (_name, render) => {
    expect(render()).toContain('`agentboard help agents`');
  });
});

describe('scenario: installed skill carries the recipe', () => {
  it('agents install --target claude writes the Mutex tickets section and the v3 marker', () => {
    const root = plainProject();
    const out = run(['agents', 'install', '--target', 'claude'], root, cliEnv());
    expect(out.code, out.stderr).toBe(0);
    const skill = readRel(root, SKILL);
    expect(skill).toContain(skillMarker(3));
    expect(skill.split('\n')).toContain('## Mutex tickets');
    const text = flat(skill);
    expect(text).toContain('never wait on a mutex in a loop');
    expect(text).toContain('background process');
    const commands = parsed(skill).map((c) => c.command);
    expect(commands).toContain('renew');
    expect(commands).toContain('release');
    expect(skill).toMatch(/`agentboard claim <id> --ttl [^`]*--wait --timeout [^`]*`/);
  });
});

describe('scenario: version 2 installs are stale', () => {
  it('the running guidance version is 3', () => {
    expect(GUIDANCE_VERSION).toBe(3);
  });

  it('agents check reports a claude skill installed at version 2 stale and exits 1', () => {
    const root = plainProject();
    installGuidance({ cwd: root, env: ENV, targets: ['claude'], version: 2 });
    expect(checkGuidance({ cwd: root, env: ENV })).toEqual([
      { target: 'claude', path: SKILL, state: 'stale', installedVersion: 2, currentVersion: 3 },
    ]);
    const out = checkCommand(root, ENV);
    expect(out.exitCode).toBe(1);
    expect(out.text).toContain(`stale claude ${SKILL} (installed v2, current v3)`);
    const cli = run(['agents', 'check'], root, cliEnv());
    expect(cli.code).toBe(1);
    expect(cli.stdout).toContain(`stale claude ${SKILL}`);
  });

  it('agents install then makes it current', () => {
    const root = plainProject();
    installGuidance({ cwd: root, env: ENV, targets: ['claude'], version: 2 });
    installGuidance({ cwd: root, env: ENV, targets: ['claude'] });
    expect(checkGuidance({ cwd: root, env: ENV }).map((e) => [e.target, e.state])).toEqual([
      ['claude', 'current'],
    ]);
    expect(readRel(root, SKILL)).toContain(skillMarker(3));
  });
});
