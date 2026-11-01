/**
 * The init and bare-project prompts through `runCliAsync` with a scripted
 * fake terminal (board-cli "Init offers to install agent guidance";
 * board-agent-guidance "Installing guidance into a host project", the
 * bare-project scenarios; add-harness-integration task 5.1, design.md
 * decision 8 and "Rulings from task group 5 (test author)").
 *
 * The terminal plays the user: it answers each question when the command
 * starts listening for it and records whether standard input was ever
 * listened to, so "no prompt" is proved by no listener at all, not by
 * the absence of a question in the output. Its writes and the command's
 * stdout go to one log, in order, as they would on a real terminal. The
 * built CLI with real standard input is in
 * src/__tests__/prompt-processes.test.ts.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { syncEnv } from '../../board/__tests__/sync-helpers.js';
import { fileList, plainProject, repo } from '../../guidance/__tests__/guidance-helpers.js';
import {
  INIT_SUGGESTION,
  PROMPT_REASON,
  PROMPT_TARGETS,
  renderTargetPrompt,
} from '../../guidance/install.js';
import { runCliAsync } from '../main.js';
import { INIT_QUESTION, PROMPT_LINE_LIMIT } from '../prompt.js';
import { oneJson, type Run } from './cli-helpers.js';
import {
  EOF,
  ScriptedTerminal,
  partialThenEof,
  typed,
  until,
  type Scripted,
} from './prompt-helpers.js';

// init runs git several times per test.
vi.setConfig({ testTimeout: 60_000 });

const SKILL = '.claude/skills/agentboard/SKILL.md';
const AGENTS = 'AGENTS.md';

interface Session extends Run {
  readonly term: ScriptedTerminal;
}

interface Options {
  /** Whether stdin and stdout are terminals (default both). */
  readonly stdin?: boolean;
  readonly stdout?: boolean;
  /** Run without `promptTerminal` at all. */
  readonly noTerminal?: boolean;
}

interface Started {
  readonly term: ScriptedTerminal;
  readonly done: Promise<Session>;
  out(): string;
  err(): string;
}

/** Starts the CLI in process with a scripted terminal. */
function start(
  argv: readonly string[],
  cwd: string,
  script: readonly Scripted[] = [],
  options: Options = {},
): Started {
  const log: string[] = [];
  const errs: string[] = [];
  const term = new ScriptedTerminal(script, {
    stdin: options.stdin ?? true,
    stdout: options.stdout ?? true,
    log,
  });
  let terminals = 0;
  const done = runCliAsync({
    argv,
    cwd,
    env: syncEnv(),
    stdout: (text) => {
      log.push(text);
    },
    stderr: (text) => {
      errs.push(text);
    },
    stopSignal: () => new AbortController().signal,
    ...(options.noTerminal === true
      ? {}
      : {
          promptTerminal: () => {
            terminals += 1;
            expect(terminals).toBe(1);
            return term;
          },
        }),
  }).then((code) => ({ code, stdout: log.join(''), stderr: errs.join(''), term }));
  return { term, done, out: () => log.join(''), err: () => errs.join('') };
}

function session(
  argv: readonly string[],
  cwd: string,
  script: readonly Scripted[] = [],
  options: Options = {},
): Promise<Session> {
  return start(argv, cwd, script, options).done;
}

/** A project with `.claude/`, so `claude` is auto-detected. */
function claudeProject(): string {
  const root = repo();
  mkdirSync(join(root, '.claude'));
  return root;
}

/** Files below `root`, outside `.git` and the board. */
function projectFiles(root: string): string[] {
  return fileList(root).filter((p) => !p.startsWith('.board/') && p !== '.gitignore');
}

/** The numbered target lines of the output: `[number, target]`. */
function listing(text: string): [number, string][] {
  return [...text.matchAll(/^ {2}(\d+)\. ([a-z-]+)(?: .*)?$/gm)].map((m) => [
    Number(m[1]),
    m[2] ?? '',
  ]);
}

/** The bare-project prompt was shown and one answer read. */
function expectTargetPrompt(out: Session): void {
  expect(listing(out.stdout)).toEqual(PROMPT_TARGETS.map((t, i) => [i + 1, t]));
  expect(out.term.dataListens).toBe(1);
  expect(out.term.active).toBe(0);
}

/** The init question was asked and one answer read. */
function expectInitQuestion(out: Session): void {
  expect(out.stdout).toContain(INIT_QUESTION);
  expect(out.term.writes).toContain(INIT_QUESTION);
  expect(out.term.dataListens).toBeGreaterThanOrEqual(1);
  expect(out.term.active).toBe(0);
}

function expectNoPrompt(out: Session): void {
  expect(out.term.read, 'stdin was listened to').toBe(false);
  expect(out.stdout).not.toContain(INIT_QUESTION.trim());
  expect(listing(out.stdout)).toEqual([]);
}

function expectBoard(root: string): void {
  expect(existsSync(join(root, '.board', 'events'))).toBe(true);
}

// ---------------------------------------------------------------------------
// agents install: the bare-project prompt

describe('agents install in a bare project on a terminal', () => {
  it('scenario: Bare project on a terminal: 1,3 installs exactly the first and third listed targets', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed('1,3')]);
    expect(out.code, out.stderr).toBe(0);
    const listed = listing(out.stdout);
    expect(listed).toEqual(PROMPT_TARGETS.map((t, i) => [i + 1, t]));
    const first = listed[0]?.[1];
    const third = listed[2]?.[1];
    expect([first, third]).toEqual(['claude', 'codex']);
    expect(out.stdout).toContain(`selected claude: ${PROMPT_REASON}\n`);
    expect(out.stdout).toContain(`selected codex: ${PROMPT_REASON}\n`);
    expect(out.stdout).toMatch(/^created claude \.claude\/skills\/agentboard\/SKILL\.md$/m);
    expect(out.stdout).toMatch(/^created codex AGENTS\.md$/m);
    expect(projectFiles(root)).toEqual([SKILL, AGENTS]);
    expect(out.term.dataListens).toBe(1);
    expect(out.term.active).toBe(0);
  });

  it('writes the listing (renderTargetPrompt) before reading, and nothing of the answer', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed('2')]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.term.writes.join('')).toBe(renderTargetPrompt(root));
    expect(out.stdout.startsWith(renderTargetPrompt(root))).toBe(true);
    expect(projectFiles(root)).toEqual([AGENTS]);
  });

  it('takes an answer typed in several chunks and ended with CRLF', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [{ chunks: ['6', ',', '1\r\n'] }]);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL, '.github/copilot-instructions.md']);
  });

  it('ignores spaces, repeats and empty items', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed(' 3 , 1,1 ,claude, ,')]);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL, AGENTS]);
    expect(out.stdout.match(/^created /gm)).toHaveLength(2);
  });

  it('scenario: Bare project, empty answer: nothing is written and it exits 1 listing the targets', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed('')]);
    expect(out.code).toBe(1);
    expectTargetPrompt(out);
    expect(projectFiles(root)).toEqual([]);
    for (const target of PROMPT_TARGETS) {
      expect(out.stderr).toContain(target);
    }
  });

  it.each<[string, Scripted]>([
    ['the end of the input', EOF],
    ['text then the end of the input', partialThenEof('1,3')],
  ])('treats %s as an empty answer', async (_name, script) => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [script]);
    expect(out.code).toBe(1);
    expectTargetPrompt(out);
    expect(projectFiles(root)).toEqual([]);
    for (const target of PROMPT_TARGETS) {
      expect(out.stderr).toContain(target);
    }
  });

  it('scenario: Unknown answer is not repeated: every token-shaped answer exits 1, writes nothing, appears nowhere', async () => {
    for (const f of TOKEN_FIXTURES) {
      for (const answer of [f.value, `1,${f.value}`]) {
        const root = plainProject();
        const out = await session(['agents', 'install'], root, [typed(answer)]);
        expect(out.code, f.name).toBe(1);
        expectTargetPrompt(out);
        expect(projectFiles(root), f.name).toEqual([]);
        expectNoLeak(`${out.stdout}\n${out.stderr}`, [f]);
        for (const target of PROMPT_TARGETS) {
          expect(out.stderr).toContain(target);
        }
      }
    }
  });

  it.each(['0', '7', '-1', '99999999999999999999', '1.5', 'Claude', 'openspec', 'mcp-json', '1 3'])(
    'refuses %j: exit 1, nothing written',
    async (answer) => {
      const root = plainProject();
      const out = await session(['agents', 'install'], root, [typed(answer)]);
      expect(out.code).toBe(1);
      expectTargetPrompt(out);
      expect(projectFiles(root)).toEqual([]);
      // Target names and short numbers may appear in the listing itself.
      if (answer === '99999999999999999999') {
        expect(out.stdout + out.stderr).not.toContain(answer);
      }
    },
  );

  it('refuses an answer longer than the limit without waiting for its end and without repeating it', async () => {
    const root = plainProject();
    const word = 'Kq9Zt3Lw';
    // Never ended: only the limit can end the answer.
    const out = await session(['agents', 'install'], root, [
      { chunks: [`1,${word.repeat(PROMPT_LINE_LIMIT / word.length + 1)}`] },
    ]);
    expect(out.code).toBe(1);
    expectTargetPrompt(out);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout + out.stderr).not.toContain(word);
  });

  it('writes nothing while the answer is pending', async () => {
    const root = plainProject();
    const run = start(['agents', 'install'], root, ['hang']);
    await until(() => run.term.dataListens === 1, 10_000, 'the question');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(projectFiles(root)).toEqual([]);
    run.term.finish(typed('1'));
    const out = await run.done;
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('never turns the answer into anything else on stdout or stderr', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed('1')]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
  });
});

describe('agents install asks nothing when it should not', () => {
  it('--json on a terminal: no prompt, exit 1 no-targets as one JSON document', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install', '--json'], root, [typed('1,3')]);
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expect(oneJson(out)).toMatchObject({ error: { exitCode: 1, reason: 'no-targets' } });
    expect(projectFiles(root)).toEqual([]);
  });

  it.each<[string, boolean, boolean]>([
    ['stdin a terminal, stdout not', true, false],
    ['stdout a terminal, stdin not', false, true],
    ['neither a terminal', false, false],
  ])('%s: no prompt, stdin not read, exit 1 listing the targets', async (_name, stdin, stdout) => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed('1,3')], { stdin, stdout });
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stderr).toContain('claude');
  });

  it('without a prompt terminal (the in-process runCli path): no prompt', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install'], root, [typed('1,3')], { noTerminal: true });
    expect(out.code).toBe(1);
    expect(out.term.read).toBe(false);
    expect(projectFiles(root)).toEqual([]);
  });

  it('a detected target: installs it without a prompt', async () => {
    const root = claudeProject();
    const out = await session(['agents', 'install'], root, [typed('2')]);
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('--target given: no prompt', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install', '--target', 'copilot'], root, [typed('1')]);
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual(['.github/copilot-instructions.md']);
  });

  it('--command given: mcp-json is selected, no prompt', async () => {
    const root = plainProject();
    const out = await session(
      ['agents', 'install', '--command', '/usr/local/bin/agentboard'],
      root,
      [typed('1')],
    );
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual(['.mcp.json']);
  });

  it('--global without --target: the usage error comes before any prompt', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install', '--global'], root, [typed('3')]);
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('--global');
    expect(projectFiles(root)).toEqual([]);
  });

  it('an unknown --target: the usage error comes before any prompt', async () => {
    const root = plainProject();
    const out = await session(['agents', 'install', '--target', 'windsurf'], root, [typed('1')]);
    expectNoPrompt(out);
    expect(out.code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// init: "Init offers to install agent guidance"

describe('init on a terminal asks to install agent guidance', () => {
  it('scenario: Prompt on a terminal: y creates the board, then installs the detected targets', async () => {
    const root = claudeProject();
    const out = await session(['init'], root, [typed('y')]);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([SKILL]);
    expect(out.stdout).toContain('selected claude: .claude/ exists\n');
    expect(out.stdout).toContain(INIT_QUESTION);
    expect(out.stdout).not.toContain(INIT_SUGGESTION);
    expect(out.term.dataListens).toBe(1);
  });

  it('reports the board before asking', async () => {
    const root = claudeProject();
    const out = await session(['init'], root, [typed('n')]);
    const asked = out.stdout.indexOf(INIT_QUESTION);
    expect(asked).toBeGreaterThan(0);
    const before = out.stdout.slice(0, asked);
    expect(before).toContain(join(root, '.board'));
    expect(before.endsWith('\n')).toBe(true);
    expect(out.term.writes).toContain(INIT_QUESTION);
  });

  it('scenario: Enter installs', async () => {
    const root = claudeProject();
    const out = await session(['init'], root, [typed('')]);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it.each(['Y', 'yes', 'YES', 'Yes', ' y ', '\tyes'])('%j installs', async (answer) => {
    const root = claudeProject();
    const out = await session(['init'], root, [typed(answer)]);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('y with CRLF installs', async () => {
    const root = claudeProject();
    const out = await session(['init'], root, [{ chunks: ['y\r\n'] }]);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it.each(['n', 'N', 'no', 'NO', ' No '])(
    'scenario: Declined (%j): board created, nothing written, output ends with the hint',
    async (answer) => {
      const root = claudeProject();
      const out = await session(['init'], root, [typed(answer)]);
      expect(out.code, out.stderr).toBe(0);
      expectInitQuestion(out);
      expectBoard(root);
      expect(projectFiles(root)).toEqual([]);
      expect(out.stdout.endsWith(`${INIT_SUGGESTION}\n`), out.stdout).toBe(true);
    },
  );

  it('asks again when the board already exists', async () => {
    const root = claudeProject();
    expect((await session(['init'], root, [typed('n')])).code).toBe(0);
    const second = await session(['init'], root, [typed('y')]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.term.dataListens).toBe(1);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('works in a project outside git (a standalone board)', async () => {
    const root = plainProject();
    mkdirSync(join(root, '.claude'));
    const out = await session(['init'], root, [typed('y')]);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('writes no guidance while the answer is pending, the board already created', async () => {
    const root = claudeProject();
    const run = start(['init'], root, ['hang']);
    await until(() => run.term.dataListens === 1, 30_000, 'the question');
    expectBoard(root);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(projectFiles(root)).toEqual([]);
    run.term.finish(typed('n'));
    const out = await run.done;
    expect(out.code).toBe(0);
    expect(projectFiles(root)).toEqual([]);
  });
});

describe('init: answers that are not yes or no', () => {
  it('a token-shaped answer: nothing installed, exit 1, the hint last, the answer nowhere', async () => {
    for (const f of TOKEN_FIXTURES) {
      const root = claudeProject();
      const out = await session(['init'], root, [typed(f.value)]);
      expect(out.code, f.name).toBe(1);
      expectInitQuestion(out);
      expectBoard(root);
      expect(projectFiles(root), f.name).toEqual([]);
      expect(out.stdout.endsWith(`${INIT_SUGGESTION}\n`), out.stdout).toBe(true);
      expectNoLeak(`${out.stdout}\n${out.stderr}`, [f]);
    }
  });

  it.each(['nope', 'yess', 'y n', '1', 'ok', '\u0003', '\u001b[A'])(
    '%j: nothing installed, exit 1, says which answers it takes',
    async (answer) => {
      const root = claudeProject();
      const out = await session(['init'], root, [typed(answer)]);
      expect(out.code).toBe(1);
      expectInitQuestion(out);
      expect(projectFiles(root)).toEqual([]);
      expect(out.stdout.endsWith(`${INIT_SUGGESTION}\n`)).toBe(true);
      expect(out.stderr).toMatch(/\by\b.*\bn\b/);
      if (['nope', 'yess', '\u001b[A'].includes(answer)) {
        expect(out.stdout + out.stderr).not.toContain(answer);
      }
    },
  );

  it.each<[string, Scripted]>([
    ['the end of the input (Ctrl-D)', EOF],
    ['y then the end of the input without Enter', partialThenEof('y')],
  ])('%s: nothing installed, exit 1, the hint last', async (_name, script) => {
    const root = claudeProject();
    const out = await session(['init'], root, [script]);
    expect(out.code).toBe(1);
    expectInitQuestion(out);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout.endsWith(`${INIT_SUGGESTION}\n`)).toBe(true);
  });

  it('a line over the limit: nothing installed, exit 1, not repeated, without waiting for its end', async () => {
    const root = claudeProject();
    const word = 'Yq8Wv2Rn';
    const out = await session(['init'], root, [
      { chunks: [`y${word.repeat(PROMPT_LINE_LIMIT / word.length + 1)}`] },
    ]);
    expect(out.code).toBe(1);
    expectInitQuestion(out);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout + out.stderr).not.toContain(word);
    expect(out.stdout.endsWith(`${INIT_SUGGESTION}\n`)).toBe(true);
  });
});

describe('init then the bare-project prompt', () => {
  it('y in a bare project asks for targets next; 1,3 installs the first and third', async () => {
    const root = repo();
    const out = await session(['init'], root, [typed('y'), typed('1,3')]);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(out.term.dataListens).toBe(2);
    expect(listing(out.stdout)).toEqual(PROMPT_TARGETS.map((t, i) => [i + 1, t]));
    expect(out.stdout.indexOf(INIT_QUESTION)).toBeLessThan(out.stdout.indexOf('  1. claude'));
    expect(projectFiles(root)).toEqual([SKILL, AGENTS]);
    expect(out.stdout).toContain(`selected codex: ${PROMPT_REASON}\n`);
    expect(out.stdout).not.toContain(INIT_SUGGESTION);
  });

  it('y then an empty answer: the board is kept, nothing installed, exit 1 listing the targets', async () => {
    const root = repo();
    const out = await session(['init'], root, [typed('y'), typed('')]);
    expect(out.code).toBe(1);
    expectInitQuestion(out);
    expect(out.term.dataListens).toBe(2);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
    for (const target of PROMPT_TARGETS) {
      expect(out.stderr).toContain(target);
    }
  });

  it('y then an unknown token: the board is kept, nothing installed, exit 1, not repeated', async () => {
    for (const f of TOKEN_FIXTURES.slice(0, 3)) {
      const root = repo();
      const out = await session(['init'], root, [typed('y'), typed(f.value)]);
      expect(out.code, f.name).toBe(1);
      expect(out.term.dataListens).toBe(2);
      expectBoard(root);
      expect(projectFiles(root)).toEqual([]);
      expectNoLeak(`${out.stdout}\n${out.stderr}`, [f]);
    }
  });

  it('y then the end of the input: the board is kept, nothing installed, exit 1', async () => {
    const root = repo();
    const out = await session(['init'], root, [typed('y'), EOF]);
    expect(out.code).toBe(1);
    expect(out.term.dataListens).toBe(2);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
  });

  it('input typed ahead with the yes is not taken as the targets', async () => {
    const root = repo();
    const out = await session(['init'], root, [{ chunks: ['y\n1,3\n'] }, typed('2')]);
    expect(out.code, out.stderr).toBe(0);
    expect(projectFiles(root)).toEqual([AGENTS]);
  });

  it('a refused target keeps the board and exits 1 with the install output', async () => {
    const root = claudeProject();
    mkdirSync(join(root, '.claude', 'skills', 'agentboard'), { recursive: true });
    writeFileSync(join(root, SKILL), 'my own skill\n');
    const out = await session(['init'], root, [typed('y')]);
    expect(out.code).toBe(1);
    expectBoard(root);
    expect(out.stdout).toMatch(/^refused claude /m);
    expect(out.stderr).toContain('refused claude');
  });
});

describe('init flags on a terminal', () => {
  it('scenario: Explicit flags: --agents installs the claude target without a prompt', async () => {
    const root = claudeProject();
    const out = await session(['init', '--agents'], root, [typed('n')]);
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([SKILL]);
    expect(out.stdout).not.toContain(INIT_SUGGESTION);
  });

  it('--agents in a bare project goes straight to the bare-project prompt', async () => {
    const root = repo();
    const out = await session(['init', '--agents'], root, [typed('2')]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).not.toContain(INIT_QUESTION.trim());
    expect(out.term.dataListens).toBe(1);
    expect(listing(out.stdout)).toEqual(PROMPT_TARGETS.map((t, i) => [i + 1, t]));
    expect(projectFiles(root)).toEqual([AGENTS]);
  });

  it('--no-agents skips without asking; the output still ends with the hint', async () => {
    const root = claudeProject();
    const out = await session(['init', '--no-agents'], root, [typed('y')]);
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`), out.stdout).toBe(true);
    expect(out.stderr).toBe('');
  });

  it('scenario: Flags conflict: --agents --no-agents exits 1 usage and creates no board', async () => {
    const root = claudeProject();
    const out = await session(['init', '--agents', '--no-agents', '--json'], root, [typed('y')]);
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expect(oneJson(out)).toMatchObject({ error: { exitCode: 1, reason: 'usage' } });
    expect(existsSync(join(root, '.board'))).toBe(false);
    expect(projectFiles(root)).toEqual([]);
    const text = await session(['init', '--no-agents', '--agents'], root, [typed('y')]);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain('--agents');
    expect(text.stderr).toContain('--no-agents');
    expect(existsSync(join(root, '.board'))).toBe(false);
  });

  it('--json: no prompt, one document without an agents key, nothing installed', async () => {
    const root = claudeProject();
    const out = await session(['init', '--json'], root, [typed('y')]);
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as Record<string, unknown>;
    expect(doc).toMatchObject({ created: true });
    expect('agents' in doc).toBe(false);
    expect(projectFiles(root)).toEqual([]);
  });

  it('--json --agents: one document whose agents key is the install result', async () => {
    const root = claudeProject();
    const out = await session(['init', '--json', '--agents'], root, [typed('n')]);
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    const doc = oneJson(out) as {
      created: boolean;
      agents: { targets: { target: string; action: string }[] };
    };
    expect(doc.created).toBe(true);
    expect(doc.agents.targets.map((t) => [t.target, t.action])).toEqual([['claude', 'created']]);
    expect(projectFiles(root)).toEqual([SKILL]);
  });

  it('--json --agents in a bare project: no prompt, the board kept, the refusal under agents, exit 1', async () => {
    const root = repo();
    const out = await session(['init', '--json', '--agents'], root, [typed('1')]);
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expectBoard(root);
    const doc = oneJson(out) as {
      created: boolean;
      agents: { error: { exitCode: number; reason: string; message: string } };
    };
    expect(doc.created).toBe(true);
    expect(doc.agents.error).toMatchObject({ exitCode: 1, reason: 'no-targets' });
    expect(projectFiles(root)).toEqual([]);
  });

  it.each<[string, boolean, boolean]>([
    ['stdin a terminal, stdout not', true, false],
    ['stdout a terminal, stdin not', false, true],
    ['neither a terminal', false, false],
  ])('%s: no prompt, stdin not read, the hint last, exit 0', async (_name, stdin, stdout) => {
    const root = claudeProject();
    const out = await session(['init'], root, [typed('y')], { stdin, stdout });
    expectNoPrompt(out);
    expect(out.code, out.stderr).toBe(0);
    expectBoard(root);
    expect(projectFiles(root)).toEqual([]);
    expect(out.stdout.endsWith(`\n${INIT_SUGGESTION}\n`), out.stdout).toBe(true);
  });

  it('--agents with stdout not a terminal in a bare project: no prompt, the board kept, exit 1', async () => {
    const root = repo();
    const out = await session(['init', '--agents'], root, [typed('1')], { stdout: false });
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expectBoard(root);
    expect(out.stderr).toMatch(/nothing to install/);
    expect(projectFiles(root)).toEqual([]);
  });
});

describe('an init that fails neither asks nor installs', () => {
  it('--into-host outside a git repository: exit 1, no question, no guidance', async () => {
    for (const extra of [[], ['--agents']]) {
      const root = plainProject();
      mkdirSync(join(root, '.claude'));
      const out = await session(['init', '--into-host', ...extra], root, [typed('y')]);
      expectNoPrompt(out);
      expect(out.code).toBe(1);
      expect(projectFiles(root)).toEqual([]);
      expect(out.stdout).not.toContain(INIT_SUGGESTION);
    }
  });

  it('--into-host with no board: exit 2, no question, no guidance', async () => {
    for (const extra of [[], ['--agents']]) {
      const root = claudeProject();
      const out = await session(['init', '--into-host', ...extra], root, [typed('y')]);
      expectNoPrompt(out);
      expect(out.code).toBe(2);
      expect(projectFiles(root)).toEqual([]);
    }
  });

  it('an unknown flag: exit 1, no question, no board', async () => {
    const root = claudeProject();
    const out = await session(['init', '--agent'], root, [typed('y')]);
    expectNoPrompt(out);
    expect(out.code).toBe(1);
    expect(existsSync(join(root, '.board'))).toBe(false);
  });
});

describe('scenario: Init has help for the agents flags', () => {
  it('help init prints --agents and --no-agents and says they are mutually exclusive', async () => {
    const out = await session(['help', 'init'], plainProject());
    expect(out.term.read).toBe(false);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain('--agents');
    expect(out.stdout).toContain('--no-agents');
    expect(out.stdout.replace(/\s+/g, ' ')).toContain(
      '--agents and --no-agents are mutually exclusive',
    );
  });
});
