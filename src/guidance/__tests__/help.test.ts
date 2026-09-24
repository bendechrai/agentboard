/**
 * Help rendered from the command registry (board-agent-guidance: "Generated
 * help"; add-agent-guidance task 1.1), in process, for breadth: the help
 * data of record in every registry entry, every command's rendered help and
 * JSON form, the overview, and the drift guard that every example parses
 * with the real parser to its own command. Exit codes and stdout/stderr
 * separation through the built CLI are in src/cli/__tests__/help-cli.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { expectBoardError } from '../../board/__tests__/helpers.js';
import { parseArgs } from '../../cli/parse.js';
import {
  ACTOR_FLAG,
  COMMANDS,
  GLOBAL_FLAGS,
  HELP_SOURCE,
  JSON_FLAG,
  findCommand,
} from '../../cli/registry.js';
import { COMMAND_GROUPS, type ArgSpec, type CommandSpec } from '../../cli/types.js';
import { VERSION } from '../../version.js';
import {
  AGENTS_LINE,
  GROUP_TITLES,
  commandHelpDocument,
  helpOutput,
  overviewDocument,
  renderCommandHelp,
  renderOverview,
  synopsis,
  type HelpSource,
} from '../help.js';
import { splitCommandLine } from './command-line.js';

const ASCII_LINE = /^[\x20-\x7e]*$/;
const NAMES = COMMANDS.map((c) => c.name);

function command(name: string): CommandSpec {
  const found = findCommand(name);
  if (found === undefined) {
    throw new Error(`no command ${name}`);
  }
  return found;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function needsActor(c: CommandSpec): boolean {
  return c.writes || c.tracksCursor === true;
}

function help(c: CommandSpec): string {
  return renderCommandHelp(HELP_SOURCE, c);
}

function lines(text: string): string[] {
  return text.split('\n');
}

/** The form of an argument in help: `<id>`, `--closed`, `--to <to>`, `--as <actor>`. */
function form(arg: ArgSpec, positional: boolean): string {
  if (positional) {
    return `<${arg.name}>`;
  }
  if (arg.type === 'boolean') {
    return `--${arg.name}`;
  }
  return arg.name === 'as' ? '--as <actor>' : `--${arg.name} <${arg.name}>`;
}

/** The regex of the help line of an argument. */
function argLine(arg: ArgSpec, positional: boolean): RegExp {
  const req = arg.required ? 'required' : 'optional';
  const rep = arg.repeatable ? ', repeatable' : '';
  return new RegExp(
    `^  ${escapeRe(form(arg, positional))} {2,}${arg.type}, ${req}${rep} {2,}${escapeRe(arg.summary)}$`,
    'm',
  );
}

/** Commands that never open a board. */
const BOARDLESS = new Set(['init', 'version', 'help']);

/**
 * Commands that locate a board but cannot exit 5: `mcp` locates the board
 * once at start-up (exit 2 without one) and then reports every failure as
 * a tool error, never as its own exit code (src/mcp/server.ts, `serveMcp`).
 */
const NO_INTEGRITY_EXIT = new Set(['mcp']);

/** Commands that take a ticket id. */
const ID_COMMANDS = COMMANDS.filter((c) => c.positionals.some((p) => p.name === 'id'));

describe('the help data of record in the registry', () => {
  it('registers help, after version, needing no actor and calling no operation', () => {
    expect(NAMES.at(-1)).toBe('help');
    expect(NAMES.at(-2)).toBe('version');
    const h = command('help');
    expect(h.writes).toBe(false);
    expect(h.tracksCursor ?? false).toBe(false);
    expect(h.operation).toBeNull();
    // --role (add-agent-guidance task group 2): the role checklist of help agents.
    expect(h.flags.map((f) => [f.name, f.type, f.required, f.repeatable])).toEqual([
      ['role', 'string', false, false],
    ]);
    expect(h.positionals.map((p) => [p.name, p.type, p.required])).toEqual([
      ['topic', 'string', false],
      ['subtopic', 'string', false],
    ]);
  });

  it('puts every command in its overview group', () => {
    const groups = Object.fromEntries(
      COMMAND_GROUPS.map((g) => [g, COMMANDS.filter((c) => c.group === g).map((c) => c.name)]),
    );
    expect(groups).toEqual({
      lifecycle: [
        'new',
        'show',
        'list',
        'claim',
        'release',
        'move',
        'comment',
        'handoff',
        'link',
        'checklist tick',
        'checklist untick',
        'close',
      ],
      awareness: ['inbox', 'watch'],
      planning: ['import-change', 'close-merged'],
      maintenance: ['rebuild', 'sync'],
      setup: ['init', 'mcp', 'version', 'help'],
    });
    expect(COMMAND_GROUPS).toEqual(['lifecycle', 'awareness', 'planning', 'maintenance', 'setup']);
    expect(GROUP_TITLES).toEqual({
      lifecycle: 'Ticket lifecycle',
      awareness: 'Change awareness',
      planning: 'Planning integration',
      maintenance: 'Maintenance',
      setup: 'Setup',
    });
  });

  it.each(NAMES)('%s has a one-paragraph ASCII description', (name) => {
    const c = command(name);
    expect(c.description.length).toBeGreaterThan(20);
    expect(c.description).toMatch(/^[\x20-\x7e]+$/);
    expect(c.description).not.toBe(c.summary);
  });

  it.each(NAMES)('%s has at least one ASCII example of itself', (name) => {
    const c = command(name);
    expect(c.examples.length).toBeGreaterThan(0);
    for (const example of c.examples) {
      expect(example.command).toMatch(/^[\x20-\x7e]+$/);
      expect(example.command.startsWith(`agentboard ${name}`), example.command).toBe(true);
      expect(example.summary).toMatch(/^[\x20-\x7e]+$/);
      expect(example.summary.length).toBeGreaterThan(0);
    }
  });

  it.each(NAMES)('%s lists its exit codes in order, starting with 0', (name) => {
    const c = command(name);
    const codes = c.exitCodes.map((e) => e.code);
    expect(codes.length).toBeGreaterThan(1);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    for (const e of c.exitCodes) {
      expect([0, 1, 2, 3, 4, 5]).toContain(e.code);
      expect(e.meaning).toMatch(/^[\x20-\x7e]+$/);
      if (e.reason !== undefined) {
        expect(e.reason).toMatch(/^[a-z][a-z-]*$/);
      }
    }
    const pairs = c.exitCodes.map((e) => `${String(e.code)} ${e.reason ?? ''}`);
    expect(new Set(pairs).size, 'no duplicate code and reason').toBe(pairs.length);
    // Every command succeeds with 0.
    expect(c.exitCodes[0]).toMatchObject({ code: 0 });
    expect(c.exitCodes[0]?.reason).toBeUndefined();
    expect(c.exitCodes).toContainEqual(expect.objectContaining({ code: 1, reason: 'usage' }));
  });

  it('lists missing-actor for exactly the commands that need an actor', () => {
    for (const c of COMMANDS) {
      const listed = c.exitCodes.some((e) => e.code === 1 && e.reason === 'missing-actor');
      expect(listed, c.name).toBe(needsActor(c));
    }
  });

  it('lists board-not-found for every command that locates a board, and exit 5 where possible', () => {
    for (const c of COMMANDS) {
      const noBoard = c.exitCodes.some((e) => e.code === 2 && e.reason === 'board-not-found');
      expect(noBoard, c.name).toBe(!BOARDLESS.has(c.name));
      const five = c.exitCodes.some((e) => e.code === 5);
      if (NO_INTEGRITY_EXIT.has(c.name)) {
        expect(five, c.name).toBe(false);
      } else if (!BOARDLESS.has(c.name)) {
        expect(five, c.name).toBe(true);
      }
    }
    expect(command('mcp').exitCodes.map((e) => [e.code, e.reason ?? null])).toEqual([
      [0, null],
      [1, 'usage'],
      [2, 'board-not-found'],
    ]);
  });

  it('gives actorHelp to mcp only, which neither writes nor tracks a cursor', () => {
    expect(COMMANDS.filter((c) => c.actorHelp !== undefined).map((c) => c.name)).toEqual(['mcp']);
    const mcp = command('mcp');
    expect(needsActor(mcp)).toBe(false);
    expect(mcp.actorHelp).toBe(
      "Default actor for tool calls: a call's own as comes first, then this, then AGENTBOARD_ACTOR",
    );
  });

  it('lists unknown-ticket and the id errors for every command taking an id', () => {
    expect(ID_COMMANDS.length).toBeGreaterThan(8);
    for (const c of ID_COMMANDS) {
      for (const [code, reason] of [
        [4, 'unknown-ticket'],
        [1, 'id-too-short'],
        [1, 'ambiguous-id'],
      ] as const) {
        expect(c.exitCodes, `${c.name} ${reason}`).toContainEqual(
          expect.objectContaining({ code, reason }),
        );
      }
    }
  });

  it('lists the reasons the specs name for particular commands', () => {
    const has = (name: string, code: number, reason: string): void => {
      expect(command(name).exitCodes, `${name} ${reason}`).toContainEqual(
        expect.objectContaining({ code, reason }),
      );
    };
    has('claim', 4, 'already-assigned');
    has('release', 4, 'not-assignee');
    has('move', 4, 'invalid-transition');
    has('move', 4, 'needs-task-link');
    has('handoff', 4, 'invalid-transition');
    has('close', 1, 'no-disposition');
    has('close', 1, 'unpromoted-decision');
    has('close', 1, 'decision-path-missing');
    has('new', 1, 'needs-task-or-adhoc');
    has('new', 1, 'secret-like');
    has('comment', 1, 'secret-like');
    has('handoff', 1, 'secret-like');
    has('checklist tick', 4, 'checklist-index');
    has('sync', 3, 'sync-conflict');
    has('inbox', 1, 'unknown-cursor');
    has('close-merged', 1, 'gh-missing');
    has('import-change', 1, 'tasks-not-found');
    expect(command('help').exitCodes.map((e) => e.code)).toEqual([0, 1]);
    expect(command('version').exitCodes.map((e) => e.code)).toEqual([0, 1]);
  });
});

describe('the drift guard: every example parses to its own command', () => {
  const examples = COMMANDS.flatMap((c) =>
    c.examples.map((e) => [c.name, e.command] as [string, string]),
  );

  it.each(examples)('%s: %s', (name, line) => {
    const words = splitCommandLine(line);
    expect(words[0]).toBe('agentboard');
    const parsed = parseArgs(words.slice(1));
    expect(parsed.command.name).toBe(name);
  });

  it('the splitter handles the quoting the examples use', () => {
    expect(splitCommandLine('agentboard comment 01J9K3 "a b" --as x')).toEqual([
      'agentboard',
      'comment',
      '01J9K3',
      'a b',
      '--as',
      'x',
    ]);
    expect(splitCommandLine('agentboard new \'x y\'z  --adhoc ""')).toEqual([
      'agentboard',
      'new',
      'x yz',
      '--adhoc',
      '',
    ]);
    expect(() => splitCommandLine('agentboard "x')).toThrow(/unterminated/);
  });
});

describe('synopsis', () => {
  it.each([
    [
      'handoff',
      'agentboard handoff <id> --to <to> --status <status> --note <note> [--allow-secret-like] --as <actor> [--json]',
    ],
    [
      'new',
      'agentboard new <title> [--description <description>] [--label <label>]... [--checklist <checklist>]... [--allow-secret-like] (--task <task> | --change <change> --group <group> | --adhoc <adhoc>) --as <actor> [--json]',
    ],
    [
      'list',
      'agentboard list [--status <status>] [--assignee <assignee>] [--label <label>]... [--closed] [--task <task> | --change <change>] [--json]',
    ],
    [
      'close',
      'agentboard close <id> (--decision-recorded-in <decision-recorded-in> | --no-decision) --as <actor> [--json]',
    ],
    ['move', 'agentboard move <id> [<status>] --as <actor> [--json]'],
    ['claim', 'agentboard claim <id> --as <actor> [--json]'],
    ['checklist tick', 'agentboard checklist tick <id> <index> --as <actor> [--json]'],
    ['inbox', 'agentboard inbox [--since <since>] [--peek] --as <actor> [--json]'],
    ['show', 'agentboard show <id> [--raw] [--json]'],
    ['help', 'agentboard help [<topic>] [<subtopic>] [--role <role>] [--json]'],
    ['version', 'agentboard version [--json]'],
  ])('of %s', (name, expected) => {
    expect(synopsis(command(name))).toBe(expected);
  });

  it.each(NAMES)('of %s names the command and every required argument', (name) => {
    const c = command(name);
    const text = synopsis(c);
    expect(text.startsWith(`agentboard ${name}`)).toBe(true);
    expect(text.endsWith(' [--json]')).toBe(true);
    for (const p of c.positionals) {
      expect(text).toContain(p.required ? ` <${p.name}>` : ` [<${p.name}>]`);
    }
    for (const f of c.flags.filter((x) => x.required)) {
      expect(text).toContain(`--${f.name} <${f.name}>`);
    }
    expect(text.includes('--as <actor>'), name).toBe(needsActor(c));
  });
});

describe('renderCommandHelp', () => {
  it.each(NAMES)('of %s has the synopsis, summary and every section', (name) => {
    const c = command(name);
    const text = help(c);
    const ls = lines(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(ls[0]).toBe(`Usage: ${synopsis(c)}`);
    expect(ls).toContain(c.summary);
    for (const line of ls) {
      expect(line, line).toMatch(ASCII_LINE);
      expect(line.endsWith(' '), `trailing space: ${line}`).toBe(false);
    }
    const at = (heading: string): number => ls.indexOf(heading);
    const order = [
      at(c.summary),
      ...(c.positionals.length > 0 ? [at('Arguments:')] : []),
      ...(c.flags.length > 0 ? [at('Flags:')] : []),
      at('Global flags:'),
      at('Exit codes:'),
      at('Examples:'),
    ];
    for (const index of order) {
      expect(index).toBeGreaterThan(0);
    }
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ls.includes('Arguments:')).toBe(c.positionals.length > 0);
    expect(ls.includes('Flags:')).toBe(c.flags.length > 0);
  });

  it.each(NAMES)('of %s wraps the description at 78 columns', (name) => {
    const c = command(name);
    const ls = lines(help(c));
    const start = ls.indexOf(c.summary) + 2;
    const end = ls.indexOf('', start);
    const block = ls.slice(start, end);
    expect(block.join(' ')).toBe(c.description);
    for (const line of block) {
      expect(line.length <= 78 || !line.includes(' '), line).toBe(true);
    }
  });

  it.each(NAMES)('of %s lists every argument with its type and whether it is required', (name) => {
    const c = command(name);
    const text = help(c);
    for (const p of c.positionals) {
      expect(text, p.name).toMatch(argLine(p, true));
    }
    for (const f of c.flags) {
      expect(text, f.name).toMatch(argLine(f, false));
    }
    expect(text).toMatch(argLine(JSON_FLAG, false));
    if (needsActor(c)) {
      expect(text).toMatch(
        new RegExp(
          `^  --as <actor> {2,}string, required \\(or set AGENTBOARD_ACTOR\\) {2,}${escapeRe(ACTOR_FLAG.summary)}$`,
          'm',
        ),
      );
    } else {
      const summary = c.actorHelp ?? 'Accepted and ignored by this command';
      expect(text).toMatch(
        new RegExp(`^  --as <actor> {2,}string, optional {2,}${escapeRe(summary)}$`, 'm'),
      );
    }
  });

  it.each(NAMES)('of %s lists every exit code with its reason and meaning', (name) => {
    const c = command(name);
    const text = help(c);
    const exitSection = text.slice(text.indexOf('\nExit codes:\n'), text.indexOf('\nExamples:\n'));
    for (const e of c.exitCodes) {
      const head = e.reason === undefined ? String(e.code) : `${String(e.code)} ${e.reason}`;
      expect(exitSection, head).toMatch(
        new RegExp(`^  ${escapeRe(head)} {2,}${escapeRe(e.meaning)}$`, 'm'),
      );
    }
    const entryLines = lines(exitSection).filter((l) => /^ {2}[0-5]/.test(l));
    expect(entryLines).toHaveLength(c.exitCodes.length);
  });

  it.each(NAMES)('of %s shows every example with its summary', (name) => {
    const c = command(name);
    const ls = lines(help(c));
    for (const e of c.examples) {
      const index = ls.indexOf(`  ${e.command}`);
      expect(index, e.command).toBeGreaterThan(ls.indexOf('Examples:'));
      expect(ls[index + 1]).toBe(`    ${e.summary}`);
    }
  });

  it('shows the exclusive groups', () => {
    expect(help(command('new'))).toMatch(
      /^Exactly one of: --task \| --change with --group \| --adhoc$/m,
    );
    expect(help(command('close'))).toMatch(
      /^Exactly one of: --decision-recorded-in \| --no-decision$/m,
    );
    expect(help(command('link'))).toMatch(
      /^Exactly one of: --task \| --change with --group \| --pr \| --decision$/m,
    );
    expect(help(command('list'))).toMatch(/^At most one of: --task \| --change$/m);
    expect(help(command('claim'))).not.toMatch(/one of:/);
  });

  it("scenario: claim's help has --as, exit 4 already-assigned and an example", () => {
    const text = help(command('claim'));
    expect(text).toMatch(/^Usage: agentboard claim <id> --as <actor>/);
    expect(text).toMatch(/^ {2}--as <actor> /m);
    expect(text).toMatch(/^ {2}4 already-assigned {2,}\S/m);
    expect(text).toMatch(/^ {2}agentboard claim \S+ --as \S+$/m);
  });

  it('renders a flag added to a registry entry, so no flag can be missing from help', () => {
    const claim = command('claim');
    const extra: ArgSpec = {
      name: 'frobnicate',
      type: 'integer',
      required: true,
      repeatable: false,
      summary: 'A flag that only this test defines',
    };
    const changed: CommandSpec = { ...claim, flags: [...claim.flags, extra] };
    const source: HelpSource = { ...HELP_SOURCE, commands: [changed] };
    const text = renderCommandHelp(source, changed);
    expect(text).toMatch(argLine(extra, false));
    expect(text.split('\n')[0]).toContain('--frobnicate <frobnicate>');
    expect(commandHelpDocument(source, changed).flags).toContainEqual(extra);
  });

  it('uses the global flags of the source', () => {
    const extra: ArgSpec = {
      name: 'quiet',
      type: 'boolean',
      required: false,
      repeatable: false,
      summary: 'A global flag that only this test defines',
    };
    const source: HelpSource = { ...HELP_SOURCE, globalFlags: [...GLOBAL_FLAGS, extra] };
    expect(renderCommandHelp(source, command('show'))).toMatch(argLine(extra, false));
  });
});

describe('commandHelpDocument', () => {
  it.each(NAMES)('of %s is the registry data plus synopsis and actor need', (name) => {
    const c = command(name);
    const doc = commandHelpDocument(HELP_SOURCE, c);
    expect(JSON.parse(JSON.stringify(doc))).toEqual({
      name: c.name,
      group: c.group,
      summary: c.summary,
      description: c.description,
      synopsis: synopsis(c),
      positionals: c.positionals,
      flags: c.flags,
      globalFlags: GLOBAL_FLAGS,
      exclusive: c.exclusive,
      writes: c.writes,
      tracksCursor: c.tracksCursor === true,
      needsActor: needsActor(c),
      actorHelp: c.actorHelp ?? null,
      operation: c.operation,
      examples: c.examples,
      exitCodes: c.exitCodes,
    });
  });

  it('scenario: handoff marks to, status and note required', () => {
    const doc = JSON.parse(
      JSON.stringify(commandHelpDocument(HELP_SOURCE, command('handoff'))),
    ) as { flags: { name: string; required: boolean }[] };
    for (const name of ['to', 'status', 'note']) {
      expect(
        doc.flags.find((f) => f.name === name),
        name,
      ).toMatchObject({ required: true });
    }
  });
});

describe('renderOverview', () => {
  // Rendered in beforeAll, not at collection, so a failing renderer fails
  // these tests rather than the whole file.
  let text = '';
  let ls: string[] = [];
  beforeAll(() => {
    text = renderOverview(HELP_SOURCE);
    ls = lines(text);
  });

  it('is ASCII with no trailing spaces and ends with one newline', () => {
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const line of ls) {
      expect(line, line).toMatch(ASCII_LINE);
      expect(line.endsWith(' '), line).toBe(false);
    }
  });

  it('starts with the version and the usage line', () => {
    expect(ls[0]).toBe(
      `agentboard ${VERSION}: a local, offline ticket board for coding agents working on one project`,
    );
    expect(ls[1]).toBe('');
    expect(ls[2]).toBe('Usage: agentboard <command> [arguments] [--as <actor>] [--json]');
  });

  it('ends with the agents line, after the per-command help pointer', () => {
    const body = ls.slice(0, -1);
    expect(body.at(-1)).toBe(AGENTS_LINE);
    expect(AGENTS_LINE).toBe("Agents: run 'agentboard help agents' before first use.");
    expect(body.at(-2)).toBe(
      "Run 'agentboard help <command>' or 'agentboard <command> --help' for its arguments, exit codes and examples.",
    );
  });

  it('groups every command, once, under its heading in overview order', () => {
    const headings = COMMAND_GROUPS.map((g) => `${GROUP_TITLES[g]}:`);
    const positions = headings.map((h) => ls.indexOf(h));
    for (const p of positions) {
      expect(p).toBeGreaterThan(2);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const seen: string[] = [];
    COMMAND_GROUPS.forEach((group, i) => {
      const start = (positions[i] ?? 0) + 1;
      const end = ls.indexOf('', start);
      const entries = ls.slice(start, end).map((line) => {
        const match = /^ {2}(\S+(?: \S+)?) {2,}(\S.*)$/.exec(line);
        expect(match, line).not.toBeNull();
        return [match?.[1] ?? '', match?.[2] ?? ''];
      });
      const expected = COMMANDS.filter((c) => c.group === group);
      expect(entries).toEqual(expected.map((c) => [c.name, c.summary]));
      seen.push(...entries.map(([name]) => name ?? ''));
    });
    expect([...seen].sort()).toEqual([...NAMES].sort());
  });

  it('aligns the summaries of all commands in one column', () => {
    const columns = new Set(
      ls.filter((l) => /^ {2}\S/.test(l)).map((l) => /^ {2}\S+(?: \S+)? {2,}/.exec(l)?.[0].length),
    );
    expect(columns.size).toBe(1);
  });

  it('leaves out a group with no command', () => {
    const source: HelpSource = {
      ...HELP_SOURCE,
      commands: COMMANDS.filter((c) => c.group !== 'maintenance'),
    };
    const out = renderOverview(source);
    expect(out).not.toMatch(/^Maintenance:$/m);
    expect(out).toMatch(/^Setup:$/m);
    expect(out.trimEnd().split('\n').at(-1)).toBe(AGENTS_LINE);
  });
});

describe('overviewDocument', () => {
  it('is every command document in registry order', () => {
    const doc = overviewDocument(HELP_SOURCE);
    expect(doc.map((d) => d.name)).toEqual(NAMES);
    expect(doc).toEqual(COMMANDS.map((c) => commandHelpDocument(HELP_SOURCE, c)));
  });
});

describe('helpOutput', () => {
  it('with no topic is the overview', () => {
    const out = helpOutput(HELP_SOURCE, []);
    expect(out.text).toBe(renderOverview(HELP_SOURCE));
    expect(out.json).toEqual(overviewDocument(HELP_SOURCE));
  });

  it.each(NAMES)('with the words of %s is its help', (name) => {
    const c = command(name);
    const out = helpOutput(HELP_SOURCE, name.split(' '));
    expect(out.text).toBe(help(c));
    expect(out.json).toEqual(commandHelpDocument(HELP_SOURCE, c));
    expect(out.exitCode).toBeUndefined();
  });

  it('refuses an unknown topic with a suggestion and a pointer to agentboard help', () => {
    const err = expectBoardError(() => helpOutput(HELP_SOURCE, ['clam']), 1, 'usage');
    expect(err.message).toContain('clam');
    expect(err.message).toContain('did you mean claim?');
    expect(err.message).toContain("'agentboard help'");
  });

  it('refuses a topic with no close match without a suggestion', () => {
    const err = expectBoardError(() => helpOutput(HELP_SOURCE, ['frobnicate']), 1, 'usage');
    expect(err.message).not.toContain('did you mean');
    expect(err.message).toContain("'agentboard help'");
  });

  it('refuses a group word alone, suggesting its commands', () => {
    const err = expectBoardError(() => helpOutput(HELP_SOURCE, ['checklist']), 1, 'usage');
    expect(err.message).toContain('checklist tick or checklist untick');
  });

  it('refuses a subtopic after a one-word command, pointing to its help', () => {
    const err = expectBoardError(() => helpOutput(HELP_SOURCE, ['claim', 'extra']), 1, 'usage');
    expect(err.message).toBe("claim has no help subtopic extra; run 'agentboard help claim'");
    const odd = expectBoardError(
      () => helpOutput(HELP_SOURCE, ['version', `x${String.fromCharCode(0xe4)}`]),
      1,
      'usage',
    );
    expect(odd.message).toMatch(
      /^version has no help subtopic \S+; run 'agentboard help version'$/,
    );
    expect(odd.message).toMatch(/^[\x20-\x7e]+$/);
  });

  it('keeps the suggestion message for an unknown two-word topic', () => {
    const err = expectBoardError(() => helpOutput(HELP_SOURCE, ['checklist', 'tik']), 1, 'usage');
    expect(err.message).toBe(
      "unknown command checklist tik; did you mean checklist tick or checklist untick? run 'agentboard help' to list the commands",
    );
  });

  it("describes mcp's --as as the default actor for tool calls", () => {
    const text = help(command('mcp'));
    expect(text).toMatch(
      /^ {2}--as <actor> {2,}string, optional {2,}Default actor for tool calls: a call's own as comes first, then this, then AGENTBOARD_ACTOR$/m,
    );
    expect(text).not.toContain('Accepted and ignored');
  });
});
