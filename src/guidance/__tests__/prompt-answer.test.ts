/**
 * The bare-project prompt in the library (board-agent-guidance
 * "Installing guidance into a host project"; add-harness-integration
 * design.md "Rulings from task group 5 (test author)"): the targets it
 * lists, its text, the parsing of an answer (numbers and names, spaces,
 * repeats, empty items, out-of-range numbers, unlisted targets, never
 * repeating the answer) and `installGuidance` with the chosen targets,
 * reported with the prompt as their reason. The terminal side is in
 * src/cli/__tests__/prompt-cli.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { expectBoardError } from '../../board/__tests__/helpers.js';
import {
  COMMAND_REASON,
  GUIDANCE_TARGETS,
  PROMPT_REASON,
  PROMPT_TARGETS,
  detectTargets,
  installGuidance,
  parsePromptAnswer,
  renderInstall,
  renderTargetPrompt,
  type GuidanceTarget,
} from '../install.js';
import { ENV, fileList, plainProject } from './guidance-helpers.js';

const LISTED = ['claude', 'agents-md', 'codex', 'cursor', 'antigravity', 'copilot'];

/** The numbered lines of a prompt text: `[number, target]`. */
function listing(text: string): [number, string][] {
  return [...text.matchAll(/^ {2}(\d+)\. ([a-z-]+)(?: .*)?$/gm)].map((m) => [
    Number(m[1]),
    m[2] ?? '',
  ]);
}

describe('PROMPT_TARGETS', () => {
  it('lists the detectable targets except openspec, in processing order', () => {
    expect(PROMPT_TARGETS).toEqual(LISTED);
    const order = PROMPT_TARGETS.map((t) => GUIDANCE_TARGETS.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('never offers mcp-json, claude-hooks or openspec', () => {
    for (const target of ['mcp-json', 'claude-hooks', 'openspec'] as const) {
      expect(PROMPT_TARGETS).not.toContain(target);
    }
  });
});

describe('renderTargetPrompt', () => {
  it('numbers every listed target from 1, in order, and names the root', () => {
    const root = plainProject();
    const text = renderTargetPrompt(root);
    expect(listing(text)).toEqual(PROMPT_TARGETS.map((t, i) => [i + 1, t]));
    expect(text).toContain(root);
  });

  it('asks for numbers or names, says empty installs nothing, and waits on the same line', () => {
    const text = renderTargetPrompt(plainProject());
    expect(text).toMatch(/comma/i);
    expect(text).toMatch(/empty|enter|nothing|none/i);
    expect(text.endsWith(' ')).toBe(true);
    expect(text.endsWith('\n ')).toBe(false);
    expect([...text].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
  });
});

describe('parsePromptAnswer', () => {
  it.each<[string, GuidanceTarget[]]>([
    ['1,3', ['claude', 'codex']],
    ['3,1', ['claude', 'codex']],
    ['1', ['claude']],
    ['6', ['copilot']],
    ['1,2,3,4,5,6', [...LISTED] as GuidanceTarget[]],
    ['claude', ['claude']],
    ['copilot,agents-md', ['agents-md', 'copilot']],
    ['2,cursor', ['agents-md', 'cursor']],
    [' 1 , 3 ', ['claude', 'codex']],
    ['\t1,\t3\t', ['claude', 'codex']],
    ['1,1,1', ['claude']],
    ['1,claude', ['claude']],
    ['1,3,', ['claude', 'codex']],
    [',1,,3,,', ['claude', 'codex']],
    ['1, ,3', ['claude', 'codex']],
  ])('%j chooses %j', (answer, expected) => {
    expect(parsePromptAnswer(answer)).toEqual(expected);
  });

  it.each(['', ' ', '\t', ',', ' , , ', ',,,'])('%j chooses nothing (no-targets)', (answer) => {
    const error = expectBoardError(() => parsePromptAnswer(answer), 1, 'no-targets');
    for (const target of PROMPT_TARGETS) {
      expect(error.message).toContain(target);
    }
  });

  it.each([
    '0',
    '7',
    '-1',
    '+1',
    '01',
    '1.0',
    '1e0',
    '99999999999999999999',
    '1 3',
    '1;3',
    '1-3',
    'Claude',
    'CLAUDE',
    'openspec',
    'mcp-json',
    'claude-hooks',
    'all',
    '*',
    '1,bogus',
    'claude,7',
    String.fromCharCode(0xff11),
  ])('refuses %j as usage', (answer) => {
    const error = expectBoardError(() => parsePromptAnswer(answer), 1, 'usage');
    for (const target of PROMPT_TARGETS) {
      expect(error.message).toContain(target);
    }
  });

  it('never repeats a token-shaped answer, alone or beside a valid item', () => {
    for (const f of TOKEN_FIXTURES) {
      for (const answer of [f.value, `1,${f.value}`, ` ${f.value} ,3`]) {
        const error = expectBoardError(() => parsePromptAnswer(answer), 1, 'usage');
        expectNoLeak(error.message, [f]);
      }
    }
  });

  it('refuses a very long answer without repeating any of it', () => {
    const answer = `1,${'q7Zx'.repeat(25_000)}`;
    const error = expectBoardError(() => parsePromptAnswer(answer), 1, 'usage');
    expect(error.message).not.toContain('q7Zx');
    expect(error.message.length).toBeLessThan(1000);
  });
});

describe('installGuidance with targets chosen at the prompt', () => {
  it('installs exactly the chosen targets, with the prompt as their reason', () => {
    const root = plainProject();
    expect(detectTargets(root)).toEqual([]);
    const result = installGuidance({ cwd: root, env: ENV, chosen: ['claude', 'codex'] });
    expect(result.autoDetected).toBe(false);
    expect(result.refused).toBe(0);
    expect(result.targets.map((t) => [t.target, t.reason, t.action])).toEqual([
      ['claude', PROMPT_REASON, 'created'],
      ['codex', PROMPT_REASON, 'created'],
    ]);
    expect(fileList(root)).toEqual(['.claude/skills/agentboard/SKILL.md', 'AGENTS.md']);
    const text = renderInstall(result);
    expect(text).toContain(`selected claude: ${PROMPT_REASON}\n`);
    expect(text).toContain(`selected codex: ${PROMPT_REASON}\n`);
  });

  it('names the prompt as the reason in exactly these words', () => {
    expect(PROMPT_REASON).toBe('chosen at the prompt');
  });

  it('ignores chosen targets when --target is given', () => {
    const root = plainProject();
    const result = installGuidance({
      cwd: root,
      env: ENV,
      targets: ['agents-md'],
      chosen: ['claude'],
    });
    expect(result.targets.map((t) => t.target)).toEqual(['agents-md']);
    expect(fileList(root)).toEqual(['AGENTS.md']);
  });

  it('still adds mcp-json for --command beside the chosen targets', () => {
    const root = plainProject();
    const result = installGuidance({
      cwd: root,
      env: ENV,
      chosen: ['claude'],
      command: '/usr/local/bin/agentboard',
    });
    expect(result.targets.map((t) => [t.target, t.reason])).toEqual([
      ['claude', PROMPT_REASON],
      ['mcp-json', COMMAND_REASON],
    ]);
  });

  it('does not count a chosen codex or antigravity for --global', () => {
    const root = plainProject();
    for (const chosen of [['codex'], ['antigravity'], ['codex', 'antigravity']] as const) {
      expectBoardError(
        () => installGuidance({ cwd: root, env: ENV, chosen, global: true }),
        1,
        'usage',
      );
    }
    expect(fileList(root)).toEqual([]);
  });

  it('prints the registration command for a chosen codex, as for a detected one', () => {
    const result = installGuidance({ cwd: plainProject(), env: ENV, chosen: ['codex'] });
    expect(result.registerCommands.map((r) => r.target)).toEqual(['codex']);
  });
});
