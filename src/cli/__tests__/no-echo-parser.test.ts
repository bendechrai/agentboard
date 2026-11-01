/**
 * Parser and guidance refusals repeat no refused input (no-echo-refusals
 * task 1.1; design.md "Audit" rows 1 to 4 and 6 to 8; board-cli "Refusals
 * never repeat the refused input", scenarios "Extra and non-integer
 * arguments" and "Guidance arguments"; board-agent-guidance "Unknown
 * command suggestions", scenarios "Misspelled command", "Unknown flag
 * names its position" and "Token in the command position").
 *
 * Every refusal is run with every token fixture as the refused input, in
 * process (`runCli`) and as a child of the built CLI (`dist/cli.js`, built
 * by `make check` before the tests), plain and with `--json`; each run is
 * checked for the exact message, the unchanged reason, exit code and hint,
 * and for no fixture anywhere in stdout or stderr.
 */

import { readdirSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { tempDir } from '../../board/__tests__/helpers.js';
import { cliEnv, run } from './cli-helpers.js';
import { expectCliRefusal, type ExpectedRefusal, type Runner } from './no-echo-helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HELP_HINT = "see the commands with 'agentboard help'";

function argsHint(command: string): string {
  return `check the arguments with 'agentboard help ${command}'`;
}

/** One refusal class: the command line for a token, and what it must print. */
interface Case {
  readonly name: string;
  argv(token: string): string[];
  readonly expected: ExpectedRefusal;
}

const usage = (message: string, hint: string): ExpectedRefusal => ({
  exitCode: 1,
  reason: 'usage',
  message,
  hint,
});

const CASES: readonly Case[] = [
  {
    name: 'unknown command (row 1)',
    argv: (t) => [t, '--as', 'impl'],
    expected: usage("unknown command; run 'agentboard help' to list the commands", HELP_HINT),
  },
  {
    name: 'unknown command after the first word of a two-word command (row 1)',
    argv: (t) => ['checklist', t, '01J9K3', '0', '--as', 'impl'],
    expected: usage(
      "unknown command; did you mean checklist tick or checklist untick? run 'agentboard help' to list the commands",
      HELP_HINT,
    ),
  },
  {
    name: 'unknown flag (row 2)',
    argv: (t) => ['list', `--${t}`],
    expected: usage(
      "unknown flag at argument 2 for list; run 'agentboard help list' to list its flags",
      argsHint('list'),
    ),
  },
  {
    name: 'unknown flag with an inline value (row 2)',
    argv: (t) => ['list', '--label', 'x', `--stauts=${t}`],
    expected: usage(
      "unknown flag at argument 4 for list; did you mean --status? run 'agentboard help list' to list its flags",
      argsHint('list'),
    ),
  },
  {
    name: 'extra positional (row 3)',
    argv: (t) => ['comment', 'T1', '--as', 'a', 'hello', t],
    expected: usage(
      'unexpected argument at position 6 for comment; it takes <id> <text>, and text with spaces must be quoted',
      argsHint('comment'),
    ),
  },
  {
    name: 'integer positional (row 4)',
    argv: (t) => ['checklist', 'tick', 'T1', t, '--as', 'a'],
    expected: usage('index must be an integer', argsHint('checklist tick')),
  },
  {
    name: 'integer flag (row 4)',
    argv: (t) => ['serve', '--port', t],
    expected: usage('--port must be an integer', argsHint('serve')),
  },
  {
    name: 'integer flag with an inline value (row 4)',
    argv: (t) => ['serve', `--port=${t}`],
    expected: usage('--port must be an integer', argsHint('serve')),
  },
  {
    name: 'help subtopic (row 6)',
    argv: (t) => ['help', 'claim', t],
    expected: usage(
      "claim has no help subtopic of that name; run 'agentboard help claim'",
      HELP_HINT,
    ),
  },
  {
    name: 'help topic (row 1 through help)',
    argv: (t) => ['help', t],
    expected: usage("unknown command; run 'agentboard help' to list the commands", HELP_HINT),
  },
  {
    name: 'unknown role (row 7)',
    argv: (t) => ['help', 'agents', '--role', t],
    expected: usage(
      'unknown role given with --role; the roles are orchestrator, test-author, implementer, reviewer',
      HELP_HINT,
    ),
  },
  {
    name: 'unknown target (row 8)',
    argv: (t) => ['agents', 'install', '--target', t],
    expected: usage(
      'unknown target given with --target; expected one of claude, agents-md, openspec, mcp-json, claude-hooks',
      argsHint('agents install'),
    ),
  },
  {
    name: 'a --command value with a newline (add-harness-integration)',
    argv: (t) => ['agents', 'install', '--target', 'claude-hooks', '--command', `${t}\nx`],
    expected: usage('--command must not contain a newline', argsHint('agents install')),
  },
  {
    name: 'a --mcp-command value with a newline (add-harness-integration)',
    argv: (t) => ['agents', 'install', '--mcp-command', `x\n${t}`],
    expected: usage('--mcp-command must not contain a newline', argsHint('agents install')),
  },
  {
    name: 'a --command value with a leading hyphen (review round 1, R3)',
    argv: (t) => ['agents', 'install', `--command=-${t}`],
    expected: usage('--command must not start with a hyphen', argsHint('agents install')),
  },
  {
    name: 'a --mcp-command value with a leading hyphen (review round 1, R3)',
    argv: (t) => ['agents', 'install', `--mcp-command=-${t}`],
    expected: usage('--mcp-command must not start with a hyphen', argsHint('agents install')),
  },
  {
    name: '--command with --mcp-command (add-harness-integration)',
    argv: (t) => ['agents', 'install', '--command', t, '--mcp-command', t],
    expected: usage('give only one of --command, --mcp-command', argsHint('agents install')),
  },
];

const RUNNERS: readonly Runner[] = ['in-process', 'child'];

describe.each(CASES)('$name', (c) => {
  it.each(TOKEN_FIXTURES.map((f) => ({ fixture: f, label: f.name })))(
    'repeats no $label, in process and in the built CLI, plain and --json',
    ({ fixture }) => {
      // An empty directory: every refusal here comes before any board or
      // file is touched, and the agents install refusal writes nothing.
      const cwd = tempDir();
      for (const runner of RUNNERS) {
        expectCliRefusal(c.argv(fixture.value), cwd, c.expected, [fixture], { runner });
      }
      expect(readdirSync(cwd)).toEqual([]);
    },
    60_000,
  );
});

describe('board-agent-guidance "Unknown command suggestions"', () => {
  it('Misspelled command: suggests claim and never names clam', () => {
    const cwd = tempDir();
    for (const runner of RUNNERS) {
      expectCliRefusal(
        ['clam', '01J9K3', '--as', 'impl'],
        cwd,
        usage(
          "unknown command; did you mean claim? run 'agentboard help' to list the commands",
          HELP_HINT,
        ),
        [],
        { runner },
      );
    }
    const out = run(['clam', '01J9K3', '--as', 'impl'], cwd);
    expect(`${out.stdout}${out.stderr}`).not.toContain('clam');
  });

  it('Unknown flag names its position: list --stauts todo', () => {
    const cwd = tempDir();
    for (const runner of RUNNERS) {
      expectCliRefusal(
        ['list', '--stauts', 'todo'],
        cwd,
        usage(
          "unknown flag at argument 2 for list; did you mean --status? run 'agentboard help list' to list its flags",
          argsHint('list'),
        ),
        [],
        { runner },
      );
    }
    const out = run(['list', '--stauts', 'todo', '--json'], cwd);
    expect(`${out.stdout}${out.stderr}`).not.toContain('stauts');
  });

  it('counts the command words in the position of an unknown flag', () => {
    expectCliRefusal(
      ['checklist', 'tick', '01J9K3', '0', '--jsno', '--as', 'a'],
      tempDir(),
      usage(
        "unknown flag at argument 5 for checklist tick; did you mean --json? run 'agentboard help checklist tick' to list its flags",
        argsHint('checklist tick'),
      ),
      [],
    );
  });

  it('an unknown help topic close to a command still gets its suggestion', () => {
    expectCliRefusal(
      ['help', 'clam'],
      tempDir(),
      usage(
        "unknown command; did you mean claim? run 'agentboard help' to list the commands",
        HELP_HINT,
      ),
      [],
    );
  });
});

describe('extra positionals name the position and the synopsis', () => {
  it('a command with an optional positional writes it in brackets', () => {
    expectCliRefusal(
      ['move', '01J9K3', 'review', 'now', '--as', 'a'],
      tempDir(),
      usage(
        'unexpected argument at position 4 for move; it takes <id> [<status>], and text with spaces must be quoted',
        argsHint('move'),
      ),
      [],
    );
  });

  it('a positional with choices is written with its choices', () => {
    expectCliRefusal(
      ['config', 'set', 'lease.grace', '2m', 'extra', '--as', 'a'],
      tempDir(),
      usage(
        'unexpected argument at position 5 for config set; it takes <lease.grace|queue.window> <value>, and text with spaces must be quoted',
        argsHint('config set'),
      ),
      [],
    );
  });

  it('after a lone --, the position still counts every argument', () => {
    expectCliRefusal(
      ['comment', '--as', 'a', '--', '01J9K3', 'hello', 'world'],
      tempDir(),
      usage(
        'unexpected argument at position 7 for comment; it takes <id> <text>, and text with spaces must be quoted',
        argsHint('comment'),
      ),
      [],
    );
  });

  it('a command with no positionals says so', () => {
    expectCliRefusal(
      ['version', 'extra'],
      tempDir(),
      usage(
        'unexpected argument at position 2 for version; it takes no positional arguments',
        argsHint('version'),
      ),
      [],
    );
  });
});

describe('the refusals left unchanged still name only registry text', () => {
  it('a flag given twice and a boolean flag with a value (row 9)', () => {
    const cwd = tempDir();
    expectCliRefusal(
      ['list', '--closed', '--closed'],
      cwd,
      usage('--closed given more than once', argsHint('list')),
      [],
    );
    const token = TOKEN_FIXTURES[0]?.value ?? '';
    expectCliRefusal(
      ['list', `--closed=${token}`],
      cwd,
      usage('--closed takes no value', argsHint('list')),
      TOKEN_FIXTURES,
    );
  });

  it('the choices refusal of config set (row 5)', () => {
    for (const f of TOKEN_FIXTURES) {
      const out = run(['config', 'set', f.value, '2m', '--as', 'a', '--json'], tempDir(), cliEnv());
      expect(out.code).toBe(1);
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
    }
  });
});
