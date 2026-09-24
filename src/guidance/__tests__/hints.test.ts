/**
 * Error hints, in process (board-agent-guidance: "Error hints";
 * add-agent-guidance task 2.2): the set of reasons derived from the source
 * and pinned, a hint for every reason on both surfaces, the contract of
 * each hint, the rendering of suggested commands (`hintStep`), and the
 * drift guard that every command a hint suggests parses with the real
 * parser (CLI) or the tool argument validator (MCP). The CLI and MCP
 * scenarios are in src/cli/__tests__/hints-cli.test.ts and
 * src/mcp/__tests__/hints-mcp.test.ts.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../cli/parse.js';
import { COMMANDS } from '../../cli/registry.js';
import { findTool, toolArguments } from '../../mcp/tools.js';
import { BoardError } from '../../store/errors.js';
import {
  HINT_EXIT_CODES,
  HINT_REASONS,
  hintFor,
  hintStep,
  renderHint,
  type HintContext,
  type HintSurface,
} from '../hints.js';
import { splitCommandLine } from './command-line.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every reason the board can throw, with its exit code, pinned. Adding a
 * reason to the source without a hint fails "the source reasons are
 * exactly the pinned list" below; so does removing one.
 */
const PINNED: Readonly<Record<string, number>> = {
  'already-assigned': 4,
  'ambiguous-id': 1,
  'ambiguous-remote': 1,
  'board-not-a-repository': 2,
  'board-not-found': 2,
  busy: 5,
  'checklist-index': 4,
  'decision-path-missing': 1,
  'detached-head': 3,
  'duplicate-create': 4,
  'forbidden-host': 1,
  'gh-missing': 1,
  'git-missing': 1,
  'id-too-short': 1,
  integrity: 5,
  'invalid-transition': 4,
  'malformed-event': 1,
  'malformed-task-ref': 1,
  'malformed-tasks': 1,
  'method-not-allowed': 1,
  'missing-actor': 1,
  'missing-status': 1,
  'needs-task-link': 4,
  'needs-task-or-adhoc': 1,
  'no-cache': 5,
  'no-disposition': 1,
  'no-targets': 1,
  'not-assignee': 4,
  'not-found': 1,
  'path-outside-tree': 1,
  'port-in-use': 1,
  'schema-mismatch': 5,
  'secret-like': 1,
  'streaming-command': 1,
  'sync-conflict': 3,
  'sync-failed': 3,
  'sync-in-progress': 3,
  'tasks-not-found': 1,
  'too-many-streams': 1,
  'unauthorized': 1,
  'unknown-cursor': 1,
  'unknown-ticket': 4,
  'unpromoted-decision': 1,
  'unsupported-source': 1,
  usage: 1,
};

/**
 * `new BoardError(...)` calls whose reason is not a string literal, and
 * where their reasons come from: these are the only ones allowed.
 */
const DYNAMIC_REASONS: readonly string[] = [
  'cli/parse.ts: group.reason', // ExclusiveGroup.reason, read from the registry below
  'store/transaction.ts: decision.reason', // an operation's refusal (none returns one today)
  'store/transaction.ts: reason', // a fold RejectionReason, read from fold.ts below
];

/** Every non-test TypeScript file under src/, relative to src/. */
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') {
        out.push(...sources(path));
      }
    } else if (name.endsWith('.ts')) {
      out.push(relative(SRC, path));
    }
  }
  return out;
}

/** `text` without block and line comments (enough for this source). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface SourceScan {
  /** reason -> exit codes it is thrown with. */
  reasons: Map<string, Set<number>>;
  /** `file: expression` of every non-literal reason. */
  dynamic: string[];
}

function add(map: Map<string, Set<number>>, reason: string, exitCode: number): void {
  const codes = map.get(reason) ?? new Set<number>();
  codes.add(exitCode);
  map.set(reason, codes);
}

/** Derives the reasons from the source and the registry. */
function scan(): SourceScan {
  const reasons = new Map<string, Set<number>>();
  const dynamic: string[] = [];
  for (const file of sources()) {
    const text = code(readFileSync(join(SRC, file), 'utf8'));
    for (const match of text.matchAll(/new BoardError\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,/g)) {
      const [, exit = '', reason = ''] = match;
      const literal = /^'([a-z-]+)'$/.exec(reason);
      if (literal !== null && /^[1-5]$/.test(exit)) {
        add(reasons, literal[1] ?? '', Number(exit));
      } else {
        dynamic.push(`${file}: ${reason}`);
      }
    }
  }
  const fold = readFileSync(join(SRC, 'events', 'fold.ts'), 'utf8');
  const union = /export type RejectionReason =([^;]+);/.exec(fold)?.[1] ?? '';
  for (const match of union.matchAll(/'([a-z-]+)'/g)) {
    add(reasons, match[1] ?? '', 4);
  }
  for (const command of COMMANDS) {
    for (const exit of command.exitCodes) {
      if (exit.reason !== undefined) {
        add(reasons, exit.reason, exit.code);
      }
    }
    for (const group of command.exclusive) {
      add(reasons, group.reason, 1);
    }
  }
  return { reasons, dynamic };
}

const ASCII_LINE = /^[\x20-\x7e]+$/;

/** The CLI steps of a hint: every `'agentboard ...'` in it, without the quotes. */
function cliSteps(hint: string): string[] {
  return [...hint.matchAll(/'(agentboard [^']*)'/g)].map((m) => m[1] ?? '');
}

/** The MCP tool steps of a hint: every `board_x {...}` in it. */
function toolSteps(hint: string): { tool: string; args: unknown }[] {
  return [...hint.matchAll(/\b(board_[a-z_]+) (\{[^}]*\})/g)].map((m) => ({
    tool: m[1] ?? '',
    args: JSON.parse(m[2] ?? '') as unknown,
  }));
}

/** The command of a CLI step, parsed with the real parser (throws when it does not parse). */
function parseStep(step: string): { command: string; values: Record<string, unknown> } {
  const words = splitCommandLine(step);
  expect(words[0]).toBe('agentboard');
  const parsed = parseArgs(words.slice(1));
  return { command: parsed.command.name, values: { ...parsed.values } };
}

/** A command that can produce `reason`, for a realistic context. */
function commandFor(reason: string): string {
  const special: Record<string, string> = {
    'malformed-event': 'comment',
    'duplicate-create': 'new',
    'streaming-command': 'watch',
    busy: 'list',
    'no-cache': 'rebuild',
    'schema-mismatch': 'rebuild',
    integrity: 'show',
    'missing-actor': 'comment',
    usage: 'claim',
    // The web server's refusals (add-board-web group 3) are reported by serve.
    unauthorized: 'serve',
    'forbidden-host': 'serve',
    'not-found': 'serve',
    'method-not-allowed': 'serve',
    'too-many-streams': 'serve',
  };
  const found = COMMANDS.find((c) => c.exitCodes.some((e) => e.reason === reason));
  return special[reason] ?? found?.name ?? 'show';
}

function ctx(
  surface: HintSurface,
  command: string | null,
  extra: { id?: string; actor?: string } = {},
): HintContext {
  return { surface, command, ...extra };
}

const SURFACES: readonly HintSurface[] = ['cli', 'mcp'];

describe('the reasons', () => {
  it('finds the reasons of the source (sanity of the scan)', () => {
    const { reasons } = scan();
    for (const known of ['usage', 'missing-actor', 'already-assigned', 'no-disposition']) {
      expect(reasons.has(known), known).toBe(true);
    }
  });

  it('has no reason expression but the known dynamic ones', () => {
    expect(scan().dynamic.sort()).toEqual([...DYNAMIC_REASONS].sort());
  });

  it('the source reasons are exactly the pinned list, each with one exit code', () => {
    const { reasons } = scan();
    const derived = Object.fromEntries(
      [...reasons.entries()].map(([reason, codes]) => [reason, [...codes].sort()]),
    );
    expect(derived).toEqual(
      Object.fromEntries(Object.entries(PINNED).map(([reason, exit]) => [reason, [exit]])),
    );
  });

  it('scenario: no reason without a hint (HINT_REASONS is every pinned reason, sorted)', () => {
    expect(HINT_REASONS).toEqual(Object.keys(PINNED).sort());
  });

  it('HINT_EXIT_CODES gives each reason its exit code', () => {
    expect(HINT_EXIT_CODES).toEqual(PINNED);
  });
});

describe('renderHint for every reason', () => {
  const cases = Object.keys(PINNED).flatMap((reason) =>
    SURFACES.map((surface) => [reason, surface] as const),
  );

  it.each(cases)('%s on %s: one plain ASCII line with its values filled in', (reason, surface) => {
    const known = renderHint(
      reason,
      ctx(surface, commandFor(reason), {
        id: '01J9K3',
        ...(reason === 'missing-actor' ? {} : { actor: 'impl-1' }),
      }),
    );
    const unknown = renderHint(reason, ctx(surface, null));
    for (const hint of [known, unknown]) {
      expect(hint, reason).not.toBeNull();
      const text = hint ?? '';
      expect(text).toMatch(ASCII_LINE);
      expect(text).toBe(text.trim());
      expect(text.startsWith('hint:')).toBe(false);
    }
    expect(known).not.toContain('<id>');
    if (reason !== 'missing-actor') {
      expect(known).not.toContain('<actor>');
    }
  });

  it.each(cases)('%s on %s: every suggested command parses', (reason, surface) => {
    for (const context of [
      ctx(surface, commandFor(reason), { id: '01J9K3', actor: 'impl-1' }),
      ctx(surface, null),
    ]) {
      const hint = renderHint(reason, context) ?? '';
      for (const step of cliSteps(hint)) {
        const { command } = parseStep(step);
        if (surface === 'mcp') {
          // Over MCP, only a command that is not a tool is written as a command line.
          expect(findTool(`board_${command.replace(/[ -]/g, '_')}`), step).toBeUndefined();
        }
      }
      if (surface === 'cli') {
        expect(toolSteps(hint), hint).toEqual([]);
      }
      for (const { tool, args } of toolSteps(hint)) {
        const found = findTool(tool);
        expect(found, tool).toBeDefined();
        if (found !== undefined) {
          expect(
            () => toolArguments(found.command, args),
            `${tool} ${JSON.stringify(args)}`,
          ).not.toThrow();
        }
      }
    }
  });

  it.each(Object.keys(PINNED).filter((r) => PINNED[r] === 1 || PINNED[r] === 4))(
    '%s (exit 1 or 4) names a command on both surfaces',
    (reason) => {
      for (const surface of SURFACES) {
        for (const context of [
          ctx(surface, commandFor(reason), { id: '01J9K3' }),
          ctx(surface, null),
        ]) {
          const hint = renderHint(reason, context) ?? '';
          expect(
            cliSteps(hint).length + toolSteps(hint).length,
            `${surface}: ${hint}`,
          ).toBeGreaterThan(0);
        }
      }
    },
  );

  it('is null for no reason and for a reason it does not know', () => {
    expect(renderHint(null, ctx('cli', 'claim'))).toBeNull();
    expect(renderHint('no-such-reason', ctx('mcp', 'claim'))).toBeNull();
  });
});

describe('hint contracts (CLI)', () => {
  const cli = (
    reason: string,
    command: string | null,
    extra: { id?: string; actor?: string } = {},
  ) => renderHint(reason, ctx('cli', command, extra)) ?? '';

  it('scenario: already-assigned names show <id> and inbox --as <the caller>', () => {
    const hint = cli('already-assigned', 'claim', { id: '01J9K3', actor: 'reviewer' });
    expect(hint).toContain("'agentboard show 01J9K3'");
    expect(hint).toContain("'agentboard inbox --as reviewer'");
  });

  it('already-assigned without a known id or actor uses the placeholders', () => {
    const hint = cli('already-assigned', null);
    expect(hint).toContain("'agentboard show <id>'");
    expect(hint).toContain("'agentboard inbox --as <actor>'");
  });

  it('scenario: missing actor names --as and AGENTBOARD_ACTOR, not the MCP server', () => {
    const hint = cli('missing-actor', 'comment', { id: '01J9K3' });
    expect(hint).toContain('--as <actor>');
    expect(hint).toContain('AGENTBOARD_ACTOR');
    expect(hint).not.toContain('agentboard mcp');
  });

  it('scenario: needs-task-link names link with a task reference', () => {
    expect(cli('needs-task-link', 'move', { id: '01J9K3', actor: 'impl' })).toContain(
      "'agentboard link 01J9K3 --task <source>:<ref>#<item> --as impl'",
    );
  });

  it('scenario: the decision rule on close names --decision-recorded-in <path>', () => {
    const none = cli('no-disposition', 'close', { actor: 'orch' });
    expect(none).toContain("'agentboard close <id> --decision-recorded-in <path> --as orch'");
    expect(none).toContain("'agentboard close <id> --no-decision --as orch'");

    const unpromoted = cli('unpromoted-decision', 'close', { id: '01J9K3', actor: 'orch' });
    expect(unpromoted).toContain("'agentboard show 01J9K3'");
    expect(unpromoted).toContain(
      "'agentboard close 01J9K3 --decision-recorded-in <path> --as orch'",
    );
    expect(unpromoted).toContain('RETRACTED:');

    expect(cli('decision-path-missing', 'close', { id: '01J9K3', actor: 'orch' })).toContain(
      "'agentboard close 01J9K3 --decision-recorded-in <path> --as orch'",
    );
  });

  it('usage points to the help of the command, or to the overview', () => {
    expect(cli('usage', 'claim')).toContain("'agentboard help claim'");
    expect(cli('usage', 'checklist tick')).toContain("'agentboard help checklist tick'");
    expect(cli('usage', null)).toContain("'agentboard help'");
    const help = cli('usage', 'help');
    expect(help).toContain("'agentboard help'");
    expect(help).not.toContain("'agentboard help help'");
  });

  it.each([
    ['missing-status', 'move', ["'agentboard move 01J9K3 <status> --as impl'"]],
    ['unknown-cursor', 'inbox', ["'agentboard inbox --as impl"]],
    ['id-too-short', 'show', ["'agentboard list'"]],
    ['ambiguous-id', 'show', ["'agentboard list'"]],
    ['unknown-ticket', 'show', ["'agentboard list'"]],
    ['duplicate-create', 'new', ["'agentboard list'"]],
    ['invalid-transition', 'move', ["'agentboard show 01J9K3'", "'agentboard help move'"]],
    ['not-assignee', 'release', ["'agentboard show 01J9K3'"]],
    ['checklist-index', 'checklist tick', ["'agentboard show 01J9K3'"]],
    ['secret-like', 'comment', ['--allow-secret-like']],
    ['malformed-task-ref', 'new', ['<source>:<ref>#<item>', '--change <name> --group <n>']],
    [
      'needs-task-or-adhoc',
      'new',
      ['--task <source>:<ref>#<item>', '--change <name> --group <n>', '--adhoc <reason>'],
    ],
    ['unsupported-source', 'import-change', ["'agentboard new ", 'openspec']],
    [
      'tasks-not-found',
      'import-change',
      ['tasks', "'agentboard import-change <change> --as impl'"],
    ],
    [
      'malformed-tasks',
      'import-change',
      ['tasks', "'agentboard import-change <change> --as impl'"],
    ],
    ['git-missing', 'sync', ['PATH']],
    ['gh-missing', 'close-merged', ['PATH', 'gh auth login']],
    ['ambiguous-remote', 'sync', ['origin', "'agentboard sync'"]],
    ['board-not-found', 'list', ["'agentboard init'", 'AGENTBOARD_DIR']],
    ['board-not-a-repository', 'sync', ["'agentboard help sync'"]],
    ['sync-in-progress', 'sync', ["'agentboard sync'"]],
    ['detached-head', 'sync', ["'agentboard sync'"]],
    ['sync-conflict', 'sync', ['git rebase --continue', "'agentboard sync'"]],
    ['sync-failed', 'sync', ["'agentboard sync'"]],
    ['integrity', 'show', ["'agentboard rebuild --check'"]],
    ['no-cache', 'rebuild', ["'agentboard rebuild'"]],
    ['schema-mismatch', 'rebuild', ["'agentboard rebuild'"]],
    ['malformed-event', 'comment', ["'agentboard version'"]],
    ['streaming-command', 'watch', ["'agentboard watch"]],
    ['streaming-command', 'serve', ["'agentboard serve'"]],
    // add-board-web group 3: serve and the web server's refusals.
    ['port-in-use', 'serve', ["'agentboard serve --port 0'", '--port']],
    [
      'unauthorized',
      'serve',
      ['printed at start-up', 'Authorization: Bearer <token>', "'agentboard help serve'"],
    ],
    ['forbidden-host', 'serve', ['127.0.0.1', 'localhost', "'agentboard help serve'"]],
    [
      'not-found',
      'serve',
      [
        '/api/session',
        '/api/board',
        '/api/tickets/<ticket>',
        '/api/events',
        '/api/actors',
        '/api/stream',
        "'agentboard help serve'",
      ],
    ],
    ['method-not-allowed', 'serve', ['read-only', 'GET', "'agentboard help serve'"]],
    ['too-many-streams', 'serve', ['64', 'reconnect', "'agentboard help serve'"]],
    ['unknown-cursor', 'serve', ['after', '/api/events', "'agentboard help serve'"]],
  ])('%s (from %s) contains %j', (reason, command, fragments) => {
    const hint = cli(reason, command, { id: '01J9K3', actor: 'impl' });
    for (const fragment of fragments) {
      expect(hint).toContain(fragment);
    }
  });

  it('unknown-cursor from serve (the events API) does not send the caller to inbox', () => {
    const hint = cli('unknown-cursor', 'serve', { actor: 'impl' });
    expect(hint).not.toContain('inbox');
    expect(hint).not.toContain('--since');
  });

  it('secret-like suggests --allow-secret-like only to a command that has it', () => {
    for (const command of ['new', 'comment', 'handoff']) {
      expect(cli('secret-like', command, { id: '01J9K3' }), command).toContain(
        '--allow-secret-like',
      );
    }
    const imported = cli('secret-like', 'import-change');
    expect(imported).not.toContain('--allow-secret-like');
    expect(imported).toContain('tasks');
    expect(renderHint('secret-like', ctx('mcp', 'import-change'))).not.toContain(
      'allow-secret-like',
    );
  });

  it('path-outside-tree names the flag of the command, or both', () => {
    expect(cli('path-outside-tree', 'close', { id: '01J9K3' })).toContain(
      '--decision-recorded-in <path>',
    );
    expect(cli('path-outside-tree', 'link', { id: '01J9K3' })).toContain('--decision <path>');
    const unknown = cli('path-outside-tree', null);
    expect(unknown).toContain('--decision-recorded-in <path>');
    expect(unknown).toContain('--decision <path>');
  });
});

describe('hint contracts (MCP)', () => {
  const mcp = (
    reason: string,
    command: string | null,
    extra: { id?: string; actor?: string } = {},
  ) => renderHint(reason, ctx('mcp', command, extra)) ?? '';

  it('scenario: already-assigned names board_show and board_inbox as tool calls', () => {
    const hint = mcp('already-assigned', 'claim', { id: '01J9K3', actor: 'reviewer' });
    expect(hint).toContain('board_show {"id":"01J9K3"}');
    expect(hint).toContain('board_inbox {"as":"reviewer"}');
    expect(hint).not.toContain("'agentboard show");
    expect(hint).not.toContain("'agentboard inbox");
  });

  it('scenario: missing actor names the as argument and agentboard mcp --as, not AGENTBOARD_ACTOR', () => {
    const hint = mcp('missing-actor', 'comment', { id: '01J9K3' });
    expect(hint).toContain('as argument');
    expect(hint).toContain("'agentboard mcp --as <actor>'");
    expect(hint).not.toContain('AGENTBOARD_ACTOR');
    expect(hint).not.toBe(renderHint('missing-actor', ctx('cli', 'comment', { id: '01J9K3' })));
  });

  it('scenario: needs-task-link names board_link with a task reference', () => {
    expect(mcp('needs-task-link', 'move', { id: '01J9K3', actor: 'impl' })).toContain(
      'board_link {"id":"01J9K3","task":"<source>:<ref>#<item>","as":"impl"}',
    );
  });

  it('scenario: the decision rule on close names board_close with decision-recorded-in', () => {
    const hint = mcp('unpromoted-decision', 'close', { id: '01J9K3', actor: 'orch' });
    expect(hint).toContain(
      'board_close {"id":"01J9K3","decision-recorded-in":"<path>","as":"orch"}',
    );
    expect(hint).toContain('RETRACTED:');
    expect(mcp('no-disposition', 'close', { actor: 'orch' })).toContain(
      'board_close {"id":"<id>","no-decision":true,"as":"orch"}',
    );
  });

  it('usage names the tool and tools/list; an unknown tool names tools/list', () => {
    const known = mcp('usage', 'claim');
    expect(known).toContain('board_claim');
    expect(known).toContain('tools/list');
    expect(mcp('usage', null)).toContain('tools/list');
  });

  it('a step of a command that is not a tool keeps its command line form', () => {
    expect(mcp('board-not-found', 'list')).toContain("'agentboard init'");
    expect(mcp('sync-conflict', 'sync')).toContain("'agentboard sync'");
  });
});

describe('hintStep', () => {
  it.each([
    [
      'claim',
      [
        ['id', '01J9K3'],
        ['as', 'impl'],
      ],
      "'agentboard claim 01J9K3 --as impl'",
    ],
    [
      'move',
      [
        ['id', '01J9K3'],
        ['status', '<status>'],
        ['as', 'impl'],
      ],
      "'agentboard move 01J9K3 <status> --as impl'",
    ],
    [
      'inbox',
      [
        ['as', 'impl'],
        ['peek', true],
      ],
      "'agentboard inbox --as impl --peek'",
    ],
    [
      'comment',
      [
        ['id', '01J9K3'],
        ['text', 'RETRACTED: <why>'],
        ['as', 'impl'],
      ],
      '\'agentboard comment 01J9K3 "RETRACTED: <why>" --as impl\'',
    ],
    [
      'checklist tick',
      [
        ['id', '01J9K3'],
        ['index', '0'],
        ['as', 'impl'],
      ],
      "'agentboard checklist tick 01J9K3 0 --as impl'",
    ],
    ['help', [['topic', 'move']], "'agentboard help move'"],
    ['sync', [], "'agentboard sync'"],
  ] as const)('cli: %s %j is %s', (command, args, expected) => {
    expect(hintStep('cli', command, args)).toBe(expected);
    expect(() => parseStep(expected.slice(1, -1))).not.toThrow();
  });

  it.each([
    ['inbox', [['as', 'reviewer']], 'board_inbox {"as":"reviewer"}'],
    [
      'close',
      [
        ['id', '01J9K3'],
        ['no-decision', true],
        ['as', 'impl'],
      ],
      'board_close {"id":"01J9K3","no-decision":true,"as":"impl"}',
    ],
    [
      'checklist tick',
      [
        ['id', '01J9K3'],
        ['index', '0'],
        ['as', 'impl'],
      ],
      'board_checklist_tick {"id":"01J9K3","index":0,"as":"impl"}',
    ],
    [
      'import-change',
      [
        ['name', 'add-x'],
        ['as', 'orch'],
      ],
      'board_import_change {"name":"add-x","as":"orch"}',
    ],
  ] as const)('mcp: %s %j is the tool call %s', (command, args, expected) => {
    expect(hintStep('mcp', command, args)).toBe(expected);
    const [{ tool, args: json } = { tool: '', args: null }] = toolSteps(expected);
    const found = findTool(tool);
    expect(found).toBeDefined();
    if (found !== undefined) {
      expect(() => toolArguments(found.command, json)).not.toThrow();
    }
  });

  it.each([
    ['sync', [], "'agentboard sync'"],
    ['init', [], "'agentboard init'"],
    ['mcp', [['as', '<actor>']], "'agentboard mcp --as <actor>'"],
    ['rebuild', [['check', true]], "'agentboard rebuild --check'"],
    ['help', [['topic', 'sync']], "'agentboard help sync'"],
  ] as const)('mcp: %s (not a tool) keeps the command line form %s', (command, args, expected) => {
    expect(hintStep('mcp', command, args)).toBe(expected);
  });
});

describe('hintFor', () => {
  it('is renderHint of a BoardError reason, null for other errors and no reason', () => {
    const context = ctx('cli', 'claim', { id: '01J9K3', actor: 'reviewer' });
    const error = new BoardError(4, 'already-assigned', 'held by impl');
    expect(hintFor(error, context)).toBe(renderHint('already-assigned', context));
    expect(hintFor(new BoardError(5, null, 'odd'), context)).toBeNull();
    expect(hintFor(new Error('disk on fire'), context)).toBeNull();
    expect(hintFor('a string', context)).toBeNull();
  });
});
