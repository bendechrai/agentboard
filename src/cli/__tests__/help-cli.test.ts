/**
 * Help and suggestions at the CLI (board-agent-guidance: "Generated help",
 * "Unknown command suggestions"; add-agent-guidance tasks 1.1 and 1.2):
 * how `parseArgs` turns help requests into the `help` command, every
 * command's `--help` and `-h` in process with no board and no actor, and
 * the spec scenarios through the built CLI for exit codes and the
 * separation of stdout and stderr.
 */

import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import {
  AGENTS_LINE,
  commandHelpDocument,
  renderCommandHelp,
  renderOverview,
} from '../../guidance/help.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { parseArgs } from '../parse.js';
import { COMMANDS, HELP_SOURCE, findCommand } from '../registry.js';
import type { CommandSpec } from '../types.js';
import { cliEnv, oneJson, run, spawnCli, type Run } from './cli-helpers.js';

const NAMES = COMMANDS.map((c) => c.name);

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

/** A directory with no board anywhere below it (and nothing in it). */
function empty(): string {
  return tempDir();
}

function lastLine(out: Run): string | undefined {
  return out.stdout.trimEnd().split('\n').at(-1);
}

describe('parseArgs: help requests are the help command', () => {
  it.each([
    ['no arguments', [], {}, false],
    ['--help', ['--help'], {}, false],
    ['-h', ['-h'], {}, false],
    ['help', ['help'], {}, false],
    ['help --json', ['help', '--json'], {}, true],
    ['-h claim', ['-h', 'claim'], { topic: 'claim' }, false],
    [
      '--help checklist tick',
      ['--help', 'checklist', 'tick'],
      { topic: 'checklist', subtopic: 'tick' },
      false,
    ],
    ['claim --help', ['claim', '--help'], { topic: 'claim' }, false],
    ['claim <id> -h', ['claim', '01J9K3', '-h'], { topic: 'claim' }, false],
    ['claim --json --help', ['claim', '--json', '--help'], { topic: 'claim' }, true],
    [
      'checklist tick <id> --help --json',
      ['checklist', 'tick', '01J9K3', '--help', '--json'],
      { topic: 'checklist', subtopic: 'tick' },
      true,
    ],
    [
      'handoff with invalid arguments and --help',
      ['handoff', '01J9K3', '--bogus', 'x', 'y', '--help'],
      { topic: 'handoff' },
      false,
    ],
    ['close --help (no disposition)', ['close', '--help'], { topic: 'close' }, false],
    ['new --help (no task)', ['new', '--help'], { topic: 'new' }, false],
    [
      '--help in a flag value position',
      ['new', 'x', '--description', '--help'],
      { topic: 'new' },
      false,
    ],
    ['help --help', ['help', '--help'], { topic: 'help' }, false],
    ['help claim', ['help', 'claim'], { topic: 'claim' }, false],
    [
      'help checklist tick',
      ['help', 'checklist', 'tick'],
      { topic: 'checklist', subtopic: 'tick' },
      false,
    ],
  ])('%s', (_label, argv, values, json) => {
    const parsed = parseArgs(argv);
    expect(parsed.command.name).toBe('help');
    expect(parsed.values).toEqual(values);
    expect(parsed.json).toBe(json);
  });

  it('treats --help and -h after a lone -- as ordinary positionals', () => {
    expect(parseArgs(['comment', '01J9K3', '--', '-h'])).toMatchObject({
      command: { name: 'comment' },
      values: { id: '01J9K3', text: '-h' },
    });
    expect(parseArgs(['comment', '01J9K3', '--', '--help']).values).toEqual({
      id: '01J9K3',
      text: '--help',
    });
  });

  it('still refuses an unknown command followed by --help, with a suggestion', () => {
    const err = expectBoardError(() => parseArgs(['clam', '--help']), 1, 'usage');
    expect(err.message).toContain('did you mean claim?');
  });

  it('refuses a third help word as an unexpected argument', () => {
    expectBoardError(() => parseArgs(['help', 'checklist', 'tick', 'x']), 1, 'usage');
  });
});

describe('parseArgs: unknown commands and flags', () => {
  it('scenario: clam names clam, suggests claim and points to agentboard help', () => {
    const err = expectBoardError(() => parseArgs(['clam', '01J9K3', '--as', 'impl']), 1, 'usage');
    expect(err.message).toBe(
      "unknown command clam; did you mean claim? run 'agentboard help' to list the commands",
    );
  });

  it('suggests nothing for a token with no close match but points to agentboard help', () => {
    const err = expectBoardError(() => parseArgs(['frobnicate', 'x']), 1, 'usage');
    expect(err.message).toBe(
      "unknown command frobnicate; run 'agentboard help' to list the commands",
    );
  });

  it('suggests the right flag for a misspelled one', () => {
    const err = expectBoardError(
      () => parseArgs(['handoff', '01J9K3', '--notes', 'x', '--as', 'impl']),
      1,
      'usage',
    );
    expect(err.message).toBe(
      "unknown flag --notes for handoff; did you mean --note? run 'agentboard help handoff' to list its flags",
    );
  });

  it('suggests a global flag', () => {
    const err = expectBoardError(() => parseArgs(['list', '--jsno']), 1, 'usage');
    expect(err.message).toContain('did you mean --json?');
  });

  it('suggests nothing for a flag with no close match', () => {
    const err = expectBoardError(() => parseArgs(['list', '--colour', 'red']), 1, 'usage');
    expect(err.message).toBe(
      "unknown flag --colour for list; run 'agentboard help list' to list its flags",
    );
  });
});

describe('--help, -h and help in process', () => {
  it.each(NAMES)('%s --help prints its help with no board and no actor', (name) => {
    const dir = empty();
    const words = name.split(' ');
    const expected = renderCommandHelp(HELP_SOURCE, command(name));
    for (const argv of [
      [...words, '--help'],
      [...words, '-h'],
      ['help', ...words],
    ]) {
      const out = run(argv, dir, cliEnv());
      expect(out, argv.join(' ')).toEqual({ code: 0, stdout: expected, stderr: '' });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(NAMES)('%s --help --json prints its help document', (name) => {
    const words = name.split(' ');
    const out = run([...words, '--help', '--json'], empty(), cliEnv());
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(oneJson(out)).toEqual(
      JSON.parse(JSON.stringify(commandHelpDocument(HELP_SOURCE, command(name)))),
    );
    expect(run(['help', ...words, '--json'], empty(), cliEnv()).stdout).toBe(out.stdout);
  });

  it('agentboard, --help, -h and help all print the overview', () => {
    const expected = renderOverview(HELP_SOURCE);
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const out = run(argv, empty(), cliEnv());
      expect(out, argv.join(' ')).toEqual({ code: 0, stdout: expected, stderr: '' });
    }
  });

  it('help --json prints the overview as one array', () => {
    const out = run(['help', '--json'], empty(), cliEnv());
    expect(out.code).toBe(0);
    const doc = oneJson(out) as { name: string }[];
    expect(doc.map((d) => d.name)).toEqual(NAMES);
  });

  it('help with an unknown topic exits 1 with a suggestion on stderr', () => {
    const out = run(['help', 'clam'], empty(), cliEnv());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('did you mean claim?');
    const json = run(['help', 'clam', '--json'], empty(), cliEnv());
    expect(oneJson(json)).toMatchObject({ error: { exitCode: 1, reason: 'usage' } });
  });

  it('an unknown command with --json prints the usage error document', () => {
    const out = run(['clam', '01J9K3', '--json'], empty(), cliEnv());
    expect(out.code).toBe(1);
    const doc = oneJson(out) as { error: { exitCode: number; reason: string; message: string } };
    expect(doc.error).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(doc.error.message).toContain('claim');
  });
});

describe('the built CLI', () => {
  it('agentboard, --help, -h and help exit 0 with the overview on stdout', () => {
    const outs = [[], ['--help'], ['-h'], ['help']].map((argv) =>
      spawnCli(argv, empty(), cliEnv()),
    );
    for (const out of outs) {
      expect(out.code).toBe(0);
      expect(out.stderr).toBe('');
      expect(out.stdout).toBe(outs[0]?.stdout);
      expect(lastLine(out)).toBe(AGENTS_LINE);
      expect(out.stdout).toMatch(/^Ticket lifecycle:$/m);
    }
  });

  it('scenario: claim --help with no board and no AGENTBOARD_ACTOR', () => {
    const dir = empty();
    const out = spawnCli(['claim', '--help'], dir, cliEnv({ AGENTBOARD_ACTOR: undefined }));
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toMatch(/^Usage: agentboard claim <id> --as <actor>/);
    expect(out.stdout).toMatch(/^ {2}--as <actor> /m);
    expect(out.stdout).toMatch(/^Exit codes:$/m);
    expect(out.stdout).toMatch(/^ {2}4 already-assigned {2,}\S/m);
    expect(out.stdout).toMatch(/^Examples:$/m);
    expect(out.stdout).toMatch(/^ {2}agentboard claim \S+/m);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('scenario: help handoff --json is one object with to, status and note required', () => {
    const out = spawnCli(['help', 'handoff', '--json'], empty(), cliEnv());
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    const doc = oneJson(out) as { name: string; flags: { name: string; required: boolean }[] };
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.name).toBe('handoff');
    for (const name of ['to', 'status', 'note']) {
      expect(
        doc.flags.find((f) => f.name === name),
        name,
      ).toMatchObject({ required: true });
    }
  });

  it('scenario: clam exits 1, names clam and suggests claim', () => {
    const out = spawnCli(['clam', '01J9K3', '--as', 'impl'], empty(), cliEnv());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('clam');
    expect(out.stderr).toContain('did you mean claim?');
    expect(out.stderr).toContain('agentboard help');
  });

  it('a misspelled flag exits 1 and suggests the right flag', () => {
    const out = spawnCli(
      ['handoff', '01J9K3', '--to', 'r', '--status', 'review', '--notes', 'x', '--as', 'impl'],
      empty(),
      cliEnv(),
    );
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('--notes');
    expect(out.stderr).toContain('did you mean --note?');
    expect(out.stderr).toContain('agentboard help handoff');
  });

  it('a token with no close match suggests nothing but points to agentboard help', () => {
    const out = spawnCli(['frobnicate'], empty(), cliEnv());
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('frobnicate');
    expect(out.stderr).not.toContain('did you mean');
    expect(out.stderr).toContain("'agentboard help'");
  });
});
