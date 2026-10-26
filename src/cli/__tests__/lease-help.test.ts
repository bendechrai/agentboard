/**
 * Help, parsing and registry data of the lease commands (add-claim-leases
 * task 3.1; board-cli: "Command surface", scenarios "Claim has help for
 * leases and waiting" and "Renew, unqueue and config have help"; "Lease
 * and queue tools over MCP" for the registry flags): synopses, exit
 * codes, examples that parse to their command, `help config` for the two
 * config commands, the `choices` of the setting key, and the CLI-only
 * `--timeout`.
 */

import { describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { synopsis } from '../../guidance/help.js';
import { splitCommandLine } from '../../guidance/__tests__/command-line.js';
import { tempDir } from '../../store/__tests__/helpers.js';
import { parseArgs } from '../parse.js';
import { COMMANDS, findCommand } from '../registry.js';
import type { CommandSpec } from '../types.js';
import { cliEnv, oneJson, run, type Run } from './cli-helpers.js';

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

/** `help <words>` in an empty directory with no actor. */
function help(...words: string[]): Run {
  const out = run(['help', ...words], tempDir(), cliEnv());
  expect(out.code, out.stderr).toBe(0);
  expect(out.stderr).toBe('');
  return out;
}

/** The examples of a help text, parsed with the real parser. */
function parsedExamples(text: string): { command: string; values: Record<string, unknown> }[] {
  const lines = text.split('\n');
  const start = lines.indexOf('Examples:');
  return lines
    .slice(start + 1)
    .filter((line) => line.startsWith('  agentboard '))
    .map((line) => {
      const parsed = parseArgs(splitCommandLine(line.trim()).slice(1));
      return { command: parsed.command.name, values: { ...parsed.values } };
    });
}

describe('scenario: claim has help for leases and waiting', () => {
  it('prints the synopsis with --ttl, --wait and --timeout, the exit codes and an example with --ttl', () => {
    const text = help('claim').stdout;
    const first = text.split('\n')[0];
    expect(first).toBe(
      'Usage: agentboard claim <id> [--ttl <ttl>] [--wait --timeout <timeout>] --as <actor> [--json]',
    );
    for (const reason of ['already-assigned', 'queued', 'wait-timeout']) {
      expect(text).toMatch(new RegExp(`^ {2}4 ${reason} {2,}\\S`, 'm'));
    }
    const examples = parsedExamples(text);
    expect(examples.some((e) => e.command === 'claim' && typeof e.values.ttl === 'string')).toBe(
      true,
    );
    expect(examples.every((e) => e.command === 'claim')).toBe(true);
    expect(text).toMatch(/^Given together: --wait with --timeout$/m);
  });

  it('the registry: --ttl string, --wait boolean, --timeout string and CLI-only', () => {
    const flags = command('claim').flags.map((f) => [
      f.name,
      f.type,
      f.required,
      f.cliOnly === true,
    ]);
    expect(flags).toEqual([
      ['ttl', 'string', false, false],
      ['wait', 'boolean', false, false],
      ['timeout', 'string', false, true],
    ]);
    expect(command('claim').exclusive.map((g) => [g.alternatives, g.required])).toEqual([
      [[['wait', 'timeout']], false],
    ]);
  });
});

describe('scenario: renew, unqueue and config have help', () => {
  it.each([
    ['renew', 'agentboard renew <id> [--ttl <ttl>] --as <actor> [--json]'],
    ['unqueue', 'agentboard unqueue <id> --as <actor> [--json]'],
  ])('help %s prints its synopsis and an example that parses to it', (name, usage) => {
    const text = help(name).stdout;
    expect(text.split('\n')[0]).toBe(`Usage: ${usage}`);
    const examples = parsedExamples(text);
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => e.command === name)).toBe(true);
  });

  it('help config prints the help of config set then config get, naming lease.grace and queue.window in the synopses', () => {
    const text = help('config').stdout;
    const usages = text.split('\n').filter((line) => line.startsWith('Usage: '));
    expect(usages).toEqual([
      'Usage: agentboard config set <lease.grace|queue.window> <value> --as <actor> [--json]',
      'Usage: agentboard config get [<lease.grace|queue.window>] [--json]',
    ]);
    const examples = parsedExamples(text);
    expect(examples.map((e) => e.command)).toContain('config set');
    expect(examples.map((e) => e.command)).toContain('config get');
    expect(text).toBe(`${help('config', 'set').stdout}\n${help('config', 'get').stdout}`);
  });

  it('help config --json is the array of the two help documents', () => {
    const out = run(['help', 'config', '--json'], tempDir(), cliEnv());
    expect(out.code).toBe(0);
    const docs = oneJson(out) as { name: string; synopsis: string }[];
    expect(docs.map((d) => d.name)).toEqual(['config set', 'config get']);
    expect(docs[0]?.synopsis).toContain('<lease.grace|queue.window>');
  });

  it('help checklist prints tick and untick in turn (a group word)', () => {
    const usages = help('checklist')
      .stdout.split('\n')
      .filter((line) => line.startsWith('Usage: '));
    expect(usages).toEqual([
      'Usage: agentboard checklist tick <id> <index> --as <actor> [--json]',
      'Usage: agentboard checklist untick <id> <index> --as <actor> [--json]',
    ]);
  });

  it('help agents is still the guide, not the agents commands', () => {
    expect(help('agents').stdout).toMatch(/^Agent guide for agentboard /);
  });

  it('the release synopsis has --force with --reason and --allow-secret-like', () => {
    const text = help('release').stdout;
    expect(text.split('\n')[0]).toBe(
      'Usage: agentboard release <id> [--allow-secret-like] [--force --reason <reason>] --as <actor> [--json]',
    );
    expect(text).toMatch(/^Given together: --force with --reason$/m);
    const examples = parsedExamples(text);
    expect(
      examples.some((e) => e.values.force === true && typeof e.values.reason === 'string'),
    ).toBe(true);
  });

  it('the argument lines of config write the key with its choices', () => {
    expect(help('config', 'set').stdout).toMatch(
      /^ {2}<lease\.grace\|queue\.window> {2,}string, required {2,}Setting key/m,
    );
    expect(synopsis(command('config get'))).toBe(
      'agentboard config get [<lease.grace|queue.window>] [--json]',
    );
  });
});

describe('the registry entries', () => {
  it('orders renew and unqueue after claim, config set and get after close-merged', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names.slice(names.indexOf('claim'), names.indexOf('claim') + 4)).toEqual([
      'claim',
      'renew',
      'unqueue',
      'release',
    ]);
    expect(names.slice(names.indexOf('close-merged'), names.indexOf('close-merged') + 4)).toEqual([
      'close-merged',
      'config set',
      'config get',
      'mcp',
    ]);
  });

  it('names the operations renewTicket, unqueueTicket, setConfig and getConfig', () => {
    expect(command('renew').operation).toBe('renewTicket');
    expect(command('unqueue').operation).toBe('unqueueTicket');
    expect(command('config set').operation).toBe('setConfig');
    expect(command('config get').operation).toBe('getConfig');
  });

  it('config set writes (needs an actor); config get does not', () => {
    expect(command('config set').writes).toBe(true);
    expect(command('config get').writes).toBe(false);
    expect(command('config get').tracksCursor).not.toBe(true);
  });

  it('only claim --timeout is CLI-only', () => {
    const cliOnly = COMMANDS.flatMap((c) =>
      c.flags.filter((f) => f.cliOnly === true).map((f) => `${c.name} --${f.name}`),
    );
    expect(cliOnly).toEqual(['claim --timeout']);
  });
});

describe('parsing the lease commands', () => {
  it('claim with --ttl, --wait and --timeout', () => {
    expect(
      parseArgs(['claim', '01J9K3', '--ttl', '30m', '--wait', '--timeout', '10m', '--as', 'a'])
        .values,
    ).toEqual({ id: '01J9K3', ttl: '30m', wait: true, timeout: '10m', as: 'a' });
  });

  it('--wait without --timeout and --timeout without --wait are usage errors at parse time', () => {
    const wait = expectBoardError(
      () => parseArgs(['claim', '01J9K3', '--ttl', '30m', '--wait', '--as', 'a']),
      1,
      'usage',
    );
    expect(wait.message).toContain('--timeout');
    expectBoardError(
      () => parseArgs(['claim', '01J9K3', '--ttl', '30m', '--timeout', '1m', '--as', 'a']),
      1,
      'usage',
    );
  });

  it('release --force without --reason is a usage error at parse time', () => {
    expectBoardError(() => parseArgs(['release', '01J9K3', '--force', '--as', 'a']), 1, 'usage');
    expectBoardError(
      () => parseArgs(['release', '01J9K3', '--reason', 'x', '--as', 'a']),
      1,
      'usage',
    );
  });

  it('a config key not among the choices is refused, naming it and listing both keys', () => {
    const err = expectBoardError(
      () => parseArgs(['config', 'set', 'columns', 'x', '--as', 'orch']),
      1,
      'usage',
    );
    expect(err.message).toContain('columns');
    expect(err.message).toContain('lease.grace');
    expect(err.message).toContain('queue.window');
    expectBoardError(() => parseArgs(['config', 'get', 'lease']), 1, 'usage');
    expect(parseArgs(['config', 'get', 'queue.window']).values).toEqual({ key: 'queue.window' });
    expect(parseArgs(['config', 'get']).values).toEqual({});
    expect(parseArgs(['config', 'set', 'lease.grace', '90s']).values).toEqual({
      key: 'lease.grace',
      value: '90s',
    });
  });
});
