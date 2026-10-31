/**
 * Error hints, in process (board-agent-guidance: "Error hints"): the set of
 * reasons derived from the source and pinned, a hint for every reason on both
 * surfaces, the contract of each hint, the rendering of suggested commands
 * (`hintStep`), and the drift guard that every command a hint suggests parses
 * with the real parser (CLI) or the tool argument validator (MCP). The CLI and
 * MCP scenarios are in src/cli/__tests__/hints-cli.test.ts and
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
  // A host-model board whose link to the host is broken (add-board-sharing).
  'board-link-broken': 2,
  'board-not-a-repository': 2,
  // A host-model board whose worktree has a branch checked out (add-board-sharing group 3).
  'board-on-branch': 3,
  'board-not-found': 2,
  // The refusals of the write actions.
  'body-too-large': 1,
  // An existing board already shared through the host repository (add-board-sharing group 4).
  'board-in-host': 1,
  busy: 5,
  'checklist-index': 4,
  'csrf-failed': 1,
  'decision-path-missing': 1,
  'detached-head': 3,
  'duplicate-create': 4,
  'forbidden-host': 1,
  'gh-missing': 1,
  'git-missing': 1,
  // A host-model board on a git older than 2.32 (add-board-sharing group 3).
  'git-too-old': 1,
  // The fold rejections of leases, the queue and grants (add-claim-leases).
  'holder-changed': 4,
  'id-too-short': 1,
  integrity: 5,
  // An actor name that fails the actor check (actor-secret-check task 1.1).
  'invalid-actor': 1,
  'invalid-queue': 4,
  'invalid-transition': 4,
  'malformed-event': 1,
  'malformed-task-ref': 1,
  'malformed-tasks': 1,
  'method-not-allowed': 1,
  'missing-actor': 1,
  'missing-status': 1,
  // The scope disposition at merge and close (add-adhoc-ticket-lifecycle):
  // `needs-task-link` is no longer a reason.
  'needs-scope-disposition': 4,
  'already-linked': 4,
  'needs-task-or-adhoc': 1,
  'no-cache': 5,
  'no-disposition': 1,
  // init --into-host on a board not found through a git repository (add-board-sharing group 5).
  'no-host-repository': 1,
  'no-targets': 1,
  'not-a-tty': 1,
  // The repository given to init --remote has a branch without events/ (add-board-sharing group 4).
  'not-a-board': 1,
  'not-assignee': 4,
  'not-found': 1,
  'path-outside-tree': 1,
  'port-in-use': 1,
  queued: 4,
  'read-only': 1,
  // The re-import refusals and the stale renumber or supersede.
  'reconcile-ambiguous': 4,
  'reconcile-blocked': 4,
  // The existing standalone board has a remote with another URL (add-board-sharing group 4).
  'remote-mismatch': 1,
  // The repository given to init --remote cannot be read (add-board-sharing group 4).
  'remote-unreachable': 3,
  'schema-mismatch': 5,
  'secret-like': 1,
  'streaming-command': 1,
  'sync-conflict': 3,
  'sync-failed': 3,
  'stale-grant': 4,
  'stale-import': 4,
  'sync-in-progress': 3,
  'tasks-not-found': 1,
  'too-many-streams': 1,
  unauthorized: 1,
  'unknown-cursor': 1,
  'unknown-ticket': 4,
  'unpromoted-decision': 1,
  'unsupported-source': 1,
  // init --into-host on a standalone board with events not committed or not pushed (add-board-sharing group 5).
  unsynced: 4,
  usage: 1,
  // claim --wait stopped by SIGINT or SIGTERM (add-claim-leases task 4.1, listed in claim's exit codes).
  'wait-interrupted': 4,
  // claim --wait gave up at its --timeout (add-claim-leases; thrown by task 4.1, listed in claim's exit codes).
  'wait-timeout': 4,
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
    // The web server's refusals are reported by serve.
    unauthorized: 'serve',
    'forbidden-host': 'serve',
    'not-found': 'serve',
    'method-not-allowed': 'serve',
    'too-many-streams': 'serve',
    // The write action refusals too.
    'read-only': 'serve',
    'csrf-failed': 'serve',
    'body-too-large': 'serve',
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
    // missing-actor has no actor to write; invalid-actor always writes the
    // placeholder, since its context actor is the refused name or unchecked
    // (actor-secret-check design.md "Rulings of the group 1 test author").
    if (reason !== 'missing-actor' && reason !== 'invalid-actor') {
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

  it.each(['holder-changed', 'invalid-queue', 'stale-grant'])(
    '%s hints show <id> (board-cli: "Lease and queue hints")',
    (reason) => {
      expect(cli(reason, 'release', { id: '01J9K3', actor: 'orch' })).toContain(
        "'agentboard show 01J9K3'",
      );
      expect(cli(reason, null)).toContain("'agentboard show <id>'");
    },
  );

  it('scenario: missing actor names --as and AGENTBOARD_ACTOR, not the MCP server', () => {
    const hint = cli('missing-actor', 'comment', { id: '01J9K3' });
    expect(hint).toContain('--as <actor>');
    expect(hint).toContain('AGENTBOARD_ACTOR');
    expect(hint).not.toContain('agentboard mcp');
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
    ['ambiguous-remote', 'init', ['origin', "'agentboard init'"]],
    ['board-not-found', 'list', ["'agentboard init'", 'AGENTBOARD_DIR']],
    ['board-not-a-repository', 'sync', ["'agentboard help sync'"]],
    ['sync-in-progress', 'sync', ["'agentboard sync'"]],
    ['detached-head', 'sync', ["'agentboard sync'"]],
    ['board-on-branch', 'sync', ['switch --detach refs/agentboard/board', "'agentboard sync'"]],
    ['git-too-old', 'sync', ['2.32', "'agentboard sync'"]],
    ['sync-conflict', 'sync', ['git rebase --continue', "'agentboard sync'"]],
    ['sync-failed', 'sync', ["'agentboard sync'"]],
    // init --remote <url> (add-board-sharing group 4).
    ['remote-unreachable', 'init', ['create', 'access', "'agentboard init --remote <url>'"]],
    ['not-a-board', 'init', ['events', "'agentboard init --remote <url>'"]],
    ['remote-mismatch', 'init', ['remote set-url', "'agentboard remote'"]],
    ['board-in-host', 'init', ['refs/agentboard/board', "'agentboard remote'"]],
    // init --into-host (add-board-sharing group 5).
    ['unsynced', 'init', ["'agentboard sync'", "'agentboard init --into-host'"]],
    ['no-host-repository', 'init', ['git repository', "'agentboard init --into-host'"]],
    ['git-too-old', 'init', ['2.32', "'agentboard init --into-host'"]],
    // A move stops on a rebase (step 3) or on a cherry-pick (the replay of
    // an adopted worktree), so the init branch names both --continue commands.
    [
      'sync-in-progress',
      'init',
      ['git rebase --continue', 'git cherry-pick --continue', "'agentboard init --into-host'"],
    ],
    [
      'sync-conflict',
      'init',
      ['git rebase --continue', 'git cherry-pick --continue', "'agentboard init --into-host'"],
    ],
    ['integrity', 'show', ["'agentboard rebuild --check'"]],
    ['no-cache', 'rebuild', ["'agentboard rebuild'"]],
    ['schema-mismatch', 'rebuild', ["'agentboard rebuild'"]],
    ['malformed-event', 'comment', ["'agentboard version'"]],
    ['streaming-command', 'watch', ["'agentboard watch"]],
    ['streaming-command', 'serve', ["'agentboard serve'"]],
    // serve and the web server's refusals.
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
    // The write action refusals.
    [
      'read-only',
      'serve',
      ['read-only', "'agentboard serve --as impl'", "'agentboard help serve'"],
    ],
    [
      'csrf-failed',
      'serve',
      ['Content-Type: application/json', 'Origin', "'agentboard help serve'"],
    ],
    ['body-too-large', 'serve', ['64 KiB', "'agentboard help serve'"]],
    // top without an interactive terminal.
    ['not-a-tty', 'top', ['terminal', "'agentboard list'", "'agentboard watch --as impl'"]],
    ['streaming-command', 'top', ["'agentboard top'"]],
  ])('%s (from %s) contains %j', (reason, command, fragments) => {
    const hint = cli(reason, command, { id: '01J9K3', actor: 'impl' });
    for (const fragment of fragments) {
      expect(hint).toContain(fragment);
    }
  });

  it('scenario: Read-only server refuses actions (the hint names agentboard serve --as <actor>)', () => {
    const hint = cli('read-only', 'serve');
    expect(hint).toContain("'agentboard serve --as <actor>'");
    expect(hint.endsWith("'agentboard help serve'")).toBe(true);
    expect(cli('csrf-failed', 'serve').endsWith("'agentboard help serve'")).toBe(true);
    expect(cli('body-too-large', 'serve').endsWith("'agentboard help serve'")).toBe(true);
  });

  it('unknown-cursor from serve (the events API) does not send the caller to inbox', () => {
    const hint = cli('unknown-cursor', 'serve', { actor: 'impl' });
    expect(hint).not.toContain('inbox');
    expect(hint).not.toContain('--since');
  });

  it('secret-like suggests --allow-secret-like only to a command that has it', () => {
    for (const command of ['new', 'comment', 'handoff', 'move', 'close']) {
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

  it.each(['holder-changed', 'invalid-queue', 'stale-grant'])(
    '%s hints board_show {id}',
    (reason) => {
      expect(mcp(reason, 'release', { id: '01J9K3', actor: 'orch' })).toContain(
        'board_show {"id":"01J9K3"}',
      );
    },
  );

  it('scenario: missing actor names the as argument and agentboard mcp --as, not AGENTBOARD_ACTOR', () => {
    const hint = mcp('missing-actor', 'comment', { id: '01J9K3' });
    expect(hint).toContain('as argument');
    expect(hint).toContain("'agentboard mcp --as <actor>'");
    expect(hint).not.toContain('AGENTBOARD_ACTOR');
    expect(hint).not.toBe(renderHint('missing-actor', ctx('cli', 'comment', { id: '01J9K3' })));
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

describe('re-import hints', () => {
  const hint = (surface: HintSurface, reason: string, actor?: string): string =>
    renderHint(reason, ctx(surface, 'import-change', actor === undefined ? {} : { actor })) ?? '';

  it('reconcile-blocked names import-change --dry-run and --force', () => {
    const text = hint('cli', 'reconcile-blocked', 'orch');
    expect(text).toContain("'agentboard import-change <change> --dry-run --as orch'");
    expect(text).toContain("'agentboard import-change <change> --force --as orch'");
    expect(hint('cli', 'reconcile-blocked')).toContain(
      "'agentboard import-change <change> --dry-run --as <actor>'",
    );
  });

  it('reconcile-ambiguous names import-change --dry-run and editing a title in the tasks file', () => {
    const text = hint('cli', 'reconcile-ambiguous', 'orch');
    expect(text).toContain("'agentboard import-change <change> --dry-run --as orch'");
    expect(text).toContain('tasks');
    expect(text).toContain('title');
    expect(text).not.toContain('--force');
  });

  it('stale-import names import-change --dry-run', () => {
    const text = renderHint('stale-import', ctx('cli', null, { actor: 'orch' })) ?? '';
    expect(text).toContain("'agentboard import-change <change> --dry-run --as orch'");
  });

  it('over MCP the steps are board_import_change calls with dry-run and force', () => {
    const blocked = hint('mcp', 'reconcile-blocked', 'orch');
    expect(blocked).toContain('board_import_change {"name":"<change>","dry-run":true,"as":"orch"}');
    expect(blocked).toContain('board_import_change {"name":"<change>","force":true,"as":"orch"}');
    const found = findTool('board_import_change');
    expect(found).toBeDefined();
    if (found !== undefined) {
      expect(() =>
        toolArguments(found.command, { name: '<change>', 'dry-run': true, as: 'orch' }),
      ).not.toThrow();
      expect(() =>
        toolArguments(found.command, { name: '<change>', force: true, as: 'orch' }),
      ).not.toThrow();
    }
  });

  it('every re-import hint is one plain ASCII line', () => {
    for (const surface of SURFACES) {
      for (const reason of ['reconcile-blocked', 'reconcile-ambiguous', 'stale-import']) {
        const text = hint(surface, reason, 'orch');
        expect(text.length).toBeGreaterThan(0);
        expect(text).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });
});

describe('the hints of the board sharing reasons (add-board-sharing group 1)', () => {
  it('board-link-broken names agentboard init as the repair, on both surfaces, in CLI form', () => {
    for (const surface of SURFACES) {
      for (const context of [ctx(surface, 'sync'), ctx(surface, null)]) {
        const hint = renderHint('board-link-broken', context) ?? '';
        expect(hint, surface).not.toBe('');
        expect(cliSteps(hint).map((step) => parseStep(step).command)).toContain('init');
        expect(toolSteps(hint)).toEqual([]);
      }
    }
  });

  it('board-on-branch names git -C .board switch --detach refs/agentboard/board, then sync (group 3)', () => {
    for (const surface of SURFACES) {
      for (const context of [ctx(surface, 'sync'), ctx(surface, null)]) {
        const hint = renderHint('board-on-branch', context) ?? '';
        expect(hint, surface).toContain('git -C .board switch --detach refs/agentboard/board');
        expect(cliSteps(hint).map((step) => parseStep(step).command)).toContain('sync');
        expect(toolSteps(hint)).toEqual([]);
      }
    }
  });

  it('git-too-old says the host model needs git 2.32 or later and to upgrade git (group 3)', () => {
    for (const surface of SURFACES) {
      for (const context of [ctx(surface, 'sync'), ctx(surface, 'init'), ctx(surface, null)]) {
        const hint = renderHint('git-too-old', context) ?? '';
        expect(hint, surface).toContain('2.32');
        expect(hint).toMatch(/upgrade/i);
        expect(toolSteps(hint)).toEqual([]);
      }
    }
  });

  it('ambiguous-remote says to set agentboard.remote, then sync', () => {
    for (const surface of SURFACES) {
      for (const context of [ctx(surface, 'sync'), ctx(surface, 'init'), ctx(surface, null)]) {
        const hint = renderHint('ambiguous-remote', context) ?? '';
        expect(hint, surface).toContain('git config agentboard.remote <name>');
        expect(cliSteps(hint).map((step) => parseStep(step).command)).toContain('sync');
      }
    }
  });
});

describe('the hints of the scope disposition (add-adhoc-ticket-lifecycle task 2.2)', () => {
  const WARNING = 'do not create an issue or task only to satisfy this';
  const MOVE_TASK = "'agentboard move 01J9K3 merged --task <source>:<ref>#<item> --as orch'";
  const MOVE_UNPLANNED = '\'agentboard move 01J9K3 merged --unplanned "<reason>" --as orch\'';
  const cli = (
    reason: string,
    command: string | null,
    extra: Omit<HintContext, 'surface' | 'command'> = {},
  ): string => renderHint(reason, { surface: 'cli', command, ...extra }) ?? '';
  const mcp = (
    reason: string,
    command: string | null,
    extra: Omit<HintContext, 'surface' | 'command'> = {},
  ): string => renderHint(reason, { surface: 'mcp', command, ...extra }) ?? '';
  const known = { id: '01J9K3', actor: 'orch' };

  it('scenario: missing disposition hint from move names both forms, each parsing to move', () => {
    const hint = cli('needs-scope-disposition', 'move', known);
    expect(hint).toContain(MOVE_TASK);
    expect(hint).toContain(MOVE_UNPLANNED);
    expect(hint).toContain(WARNING);
    expect(hint).toContain('--change <name> --group <n>');
    expect(parseStep(MOVE_TASK.slice(1, -1))).toEqual({
      command: 'move',
      values: { id: '01J9K3', status: 'merged', task: '<source>:<ref>#<item>', as: 'orch' },
    });
    expect(parseStep(MOVE_UNPLANNED.slice(1, -1))).toEqual({
      command: 'move',
      values: { id: '01J9K3', status: 'merged', unplanned: '<reason>', as: 'orch' },
    });
    expect(cliSteps(hint).map((step) => parseStep(step).command)).toEqual(['move', 'move']);
  });

  it('a hand-off into merged points at move with both forms', () => {
    const hint = cli('needs-scope-disposition', 'handoff', known);
    expect(hint).toContain(MOVE_TASK);
    expect(hint).toContain(MOVE_UNPLANNED);
    expect(hint).toContain(WARNING);
  });

  it('with no known command, id or actor, the placeholders are used', () => {
    const hint = cli('needs-scope-disposition', null);
    expect(hint).toContain("'agentboard move <id> merged --task <source>:<ref>#<item> --as <actor>'");
    expect(hint).toContain('\'agentboard move <id> merged --unplanned "<reason>" --as <actor>\'');
  });

  it('from close, repeats the decision flag the caller gave with each disposition', () => {
    const noDecision = cli('needs-scope-disposition', 'close', {
      ...known,
      closeDecision: { flag: 'no-decision' },
    });
    const taskStep = 'agentboard close 01J9K3 --no-decision --task <source>:<ref>#<item> --as orch';
    const unplannedStep = 'agentboard close 01J9K3 --no-decision --unplanned "<reason>" --as orch';
    expect(noDecision).toContain(`'${taskStep}'`);
    expect(noDecision).toContain(`'${unplannedStep}'`);
    expect(noDecision).toContain(WARNING);
    expect(parseStep(taskStep)).toEqual({
      command: 'close',
      values: { id: '01J9K3', 'no-decision': true, task: '<source>:<ref>#<item>', as: 'orch' },
    });
    expect(parseStep(unplannedStep)).toEqual({
      command: 'close',
      values: { id: '01J9K3', 'no-decision': true, unplanned: '<reason>', as: 'orch' },
    });
    expect(noDecision).not.toContain("'agentboard move");

    const recorded = cli('needs-scope-disposition', 'close', {
      ...known,
      closeDecision: { flag: 'decision-recorded-in', path: 'docs/adr/0013.md' },
    });
    expect(recorded).toContain(
      "'agentboard close 01J9K3 --decision-recorded-in docs/adr/0013.md --task <source>:<ref>#<item> --as orch'",
    );
    expect(recorded).toContain(
      '\'agentboard close 01J9K3 --decision-recorded-in docs/adr/0013.md --unplanned "<reason>" --as orch\'',
    );
    for (const step of cliSteps(recorded)) {
      expect(parseStep(step).values['decision-recorded-in']).toBe('docs/adr/0013.md');
    }

    // Unknown decision flag: the no-decision form, still parsing.
    const unknown = cli('needs-scope-disposition', 'close', known);
    expect(unknown).toContain(`'${taskStep}'`);
    expect(unknown).toContain(`'${unplannedStep}'`);
  });

  it('over MCP, the forms are tool calls with the task and unplanned arguments', () => {
    const move = mcp('needs-scope-disposition', 'move', known);
    expect(move).toContain(
      'board_move {"id":"01J9K3","status":"merged","task":"<source>:<ref>#<item>","as":"orch"}',
    );
    expect(move).toContain('board_move {"id":"01J9K3","status":"merged","unplanned":"<reason>","as":"orch"}');
    expect(move).toContain(WARNING);
    expect(cliSteps(move)).toEqual([]);
    for (const { tool, args } of toolSteps(move)) {
      const found = findTool(tool);
      expect(found).toBeDefined();
      if (found !== undefined) {
        expect(() => toolArguments(found.command, args)).not.toThrow();
      }
    }
    expect(mcp('needs-scope-disposition', 'handoff', known)).toContain('board_move {');
    const close = mcp('needs-scope-disposition', 'close', {
      ...known,
      closeDecision: { flag: 'no-decision' },
    });
    expect(close).toContain(
      'board_close {"id":"01J9K3","no-decision":true,"task":"<source>:<ref>#<item>","as":"orch"}',
    );
    expect(close).toContain(
      'board_close {"id":"01J9K3","no-decision":true,"unplanned":"<reason>","as":"orch"}',
    );
    const recorded = mcp('needs-scope-disposition', 'close', {
      ...known,
      closeDecision: { flag: 'decision-recorded-in', path: 'docs/adr/0013.md' },
    });
    expect(recorded).toContain(
      'board_close {"id":"01J9K3","decision-recorded-in":"docs/adr/0013.md","task":"<source>:<ref>#<item>","as":"orch"}',
    );
  });

  it('already-linked hints the command without --unplanned, and show <id>', () => {
    const move = cli('already-linked', 'move', known);
    expect(move).toContain("'agentboard move 01J9K3 merged --as orch'");
    expect(move).toContain("'agentboard show 01J9K3'");
    expect(move).not.toContain('--unplanned "<reason>"');
    expect(move).toContain('--unplanned');
    const close = cli('already-linked', 'close', { ...known, closeDecision: { flag: 'no-decision' } });
    expect(close).toContain("'agentboard close 01J9K3 --no-decision --as orch'");
    expect(close).toContain("'agentboard show 01J9K3'");
    const recorded = cli('already-linked', 'close', {
      ...known,
      closeDecision: { flag: 'decision-recorded-in', path: 'docs/adr/0013.md' },
    });
    expect(recorded).toContain(
      "'agentboard close 01J9K3 --decision-recorded-in docs/adr/0013.md --as orch'",
    );
    expect(cli('already-linked', null)).toContain("'agentboard move <id> merged --as <actor>'");
    for (const hint of [move, close, recorded]) {
      for (const step of cliSteps(hint)) {
        expect(() => parseStep(step), step).not.toThrow();
      }
    }
  });

  it('already-linked over MCP names the tool call without the unplanned argument', () => {
    const move = mcp('already-linked', 'move', known);
    expect(move).toContain('board_move {"id":"01J9K3","status":"merged","as":"orch"}');
    expect(move).toContain('board_show {"id":"01J9K3"}');
    expect(move).toContain('unplanned argument');
    expect(
      mcp('already-linked', 'close', { ...known, closeDecision: { flag: 'no-decision' } }),
    ).toContain('board_close {"id":"01J9K3","no-decision":true,"as":"orch"}');
  });

  it('scenario: no reason without a hint (the two reasons are in the set, needs-task-link is not)', () => {
    expect(HINT_REASONS).toContain('needs-scope-disposition');
    expect(HINT_REASONS).toContain('already-linked');
    expect(HINT_REASONS).not.toContain('needs-task-link');
    expect(Object.keys(PINNED)).not.toContain('needs-task-link');
    expect(scan().reasons.has('needs-task-link')).toBe(false);
    expect(HINT_EXIT_CODES['needs-scope-disposition']).toBe(4);
    expect(HINT_EXIT_CODES['already-linked']).toBe(4);
  });
});

describe('the hints of the move into the host repository (add-board-sharing group 5)', () => {
  it('unsynced says to sync first, then run init --into-host again, on both surfaces, in CLI form', () => {
    for (const surface of SURFACES) {
      for (const context of [ctx(surface, 'init'), ctx(surface, null)]) {
        const hint = renderHint('unsynced', context) ?? '';
        expect(hint, surface).not.toBe('');
        const steps = cliSteps(hint).map((step) => parseStep(step));
        expect(steps.map((step) => step.command)).toEqual(['sync', 'init']);
        expect(steps[1]?.values['into-host']).toBe(true);
        expect(toolSteps(hint)).toEqual([]);
      }
    }
  });

  it('no-host-repository names a git repository, AGENTBOARD_DIR and the main checkout, then init --into-host', () => {
    for (const surface of SURFACES) {
      for (const context of [ctx(surface, 'init'), ctx(surface, null)]) {
        const hint = renderHint('no-host-repository', context) ?? '';
        expect(hint, surface).toContain('git repository');
        expect(hint).toContain('AGENTBOARD_DIR');
        expect(hint).toMatch(/main checkout/);
        const steps = cliSteps(hint).map((step) => parseStep(step));
        expect(steps.map((step) => step.command)).toContain('init');
        expect(steps.some((step) => step.values['into-host'] === true)).toBe(true);
        expect(toolSteps(hint)).toEqual([]);
      }
    }
  });
});
