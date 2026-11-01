/**
 * Every surface picks up the provider patterns of secret-prefix-patterns
 * (task 1.2; board-cli "No secrets on the board", scenarios "Bare provider
 * key refused", "Every surface uses the same patterns", "Override writes a
 * prefixed key", "Near-misses stay accepted", "Prefix inside a word",
 * "Assigned key names both patterns", "Short key that fits the actor
 * form"; board-cli "Actor names are checked", scenario "Short prefixed key
 * as the actor"). No production change beyond task 1.1 is expected: every
 * caller shares `src/board/secrets.ts`.
 *
 * Free text: `comment`, `new`, `handoff --note`, `release --force
 * --reason` (bypass hint) and `import-change` (no bypass hint), in process
 * and against the built CLI, plain and `--json`; the web app's comment and
 * hand-off actions against a real server (400); `board_comment` over a
 * real stdio MCP client. Actor names: `--as` (with and without
 * `--allow-secret-like`), `AGENTBOARD_ACTOR`, `--to`, `agentboard mcp
 * --as`, `agentboard serve --as`, and the MCP `as`, `to` and server
 * `AGENTBOARD_ACTOR`. The hook's actor resolution is pinned in
 * `src/board/__tests__/hook-run.test.ts` (`NOT_ACTORS`), and every table
 * loop of the actor-secret-check tests runs over the provider keys added
 * to `ACTORS_REFUSED_BY_PATTERN`.
 *
 * Every refusal is checked with `expectNoLeak` on every output, and for
 * nothing written.
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { expectActorRefusal } from '../cli/__tests__/actor-check-helpers.js';
import {
  cliEnv,
  oneJson,
  project,
  run,
  written,
  type Run,
  type RunEnv,
} from '../cli/__tests__/cli-helpers.js';
import { runWith, type Runner } from '../cli/__tests__/no-echo-helpers.js';
import { mcpChild, type McpChild } from '../mcp/__tests__/mcp-helpers.js';
import { allNames } from '../store/__tests__/helpers.js';
import {
  actionServer,
  eventFiles,
  headerText,
  newTicket,
  post,
  refusal,
} from '../web/__tests__/action-helpers.js';
import { boardProject, oneDocument, runCliAsync } from './harness/processes.js';
import {
  ASSIGNED_STRIPE_KEY,
  GLPAT_20,
  NEAR_MISSES,
  NEW_PATTERN_KEYS,
  PREFIX_INSIDE_A_WORD,
  RK_LIVE_16,
  RK_LIVE_24,
  SCENARIO_BARE_KEYS,
  SK_TEST_24,
  providerKey,
  type ProviderKey,
} from './harness/provider-key-fixtures.js';
import {
  actorFormMessage,
  actorPatternMessage,
  expectNoLeak,
  type SecretFixture,
} from './harness/secret-fixtures.js';

// Machines under load: these spawn the built CLI and servers many times.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const RUNNERS: readonly Runner[] = ['in-process', 'child'];

/** A provider key as a no-echo fixture: every 8-character run of it is secret. */
function asFixture(label: string, value: string): SecretFixture {
  return { name: label, value, secret: value };
}

/** `k` as a no-echo fixture. */
function fixtureOf(k: ProviderKey): SecretFixture {
  return asFixture(k.label, k.value);
}

/** The exact `secret-like` message naming `names`, with or without the bypass hint. */
function secretMessage(names: string, bypass: boolean): string {
  return (
    `refused: the text matches the secret pattern(s) ${names}; the board is not a secret store` +
    (bypass ? ' (pass --allow-secret-like if this is not a secret)' : '')
  );
}

/**
 * Runs `argv` plain and with `--json` and checks the `secret-like`
 * refusal on both: exit 1, nothing on stdout (plain), the exact message
 * naming `names` and one hint line that suggests `--allow-secret-like`
 * exactly when `bypass`; the `--json` document carries the same; no
 * fixture of `fixtures` in any output.
 */
function expectSecretRefusal(
  argv: readonly string[],
  root: string,
  names: string,
  bypass: boolean,
  fixtures: readonly SecretFixture[],
  options: { runner?: Runner; env?: RunEnv } = {},
): void {
  const runner = options.runner ?? 'in-process';
  const env = options.env ?? cliEnv();
  const what = `${runner} ${argv[0] ?? ''}`;
  const plain = runWith(runner, argv, root, env);
  const json = runWith(runner, [...argv, '--json'], root, env);
  expectNoLeak(`${what} (plain)`, [plain.stdout, plain.stderr], fixtures);
  expectNoLeak(`${what} (--json)`, [json.stdout, json.stderr], fixtures);
  const message = secretMessage(names, bypass);
  expect(plain.code, plain.stderr).toBe(1);
  expect(plain.stdout).toBe('');
  const prefix = `agentboard: ${message}\nhint: `;
  expect(plain.stderr.startsWith(prefix), plain.stderr).toBe(true);
  const hint = plain.stderr.slice(prefix.length, -1);
  expect(hint).not.toContain('\n');
  if (bypass) {
    expect(hint).toContain('--allow-secret-like');
  } else {
    expect(hint).not.toContain('--allow-secret-like');
  }
  expect(json.code, json.stderr).toBe(1);
  expect(json.stderr).toBe(plain.stderr);
  expect(oneJson(json)).toEqual({
    error: { exitCode: 1, reason: 'secret-like', message, hint },
  });
}

/** A board with one ticket created by `orch`. */
function board(): { root: string; eventsDir: string; id: string } {
  const { root, boardDir } = project();
  const out = run(['new', 'Prefixes', '--task', 'openspec:x#1', '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return { root, eventsDir: join(boardDir, 'events'), id: written(out).id };
}

/** Expects `out` to have written (exit 0). */
function expectWritten(out: Run, what: string): void {
  expect(out.code, `${what}: ${out.stderr}`).toBe(0);
}

/** The representative keys the surface tests use: one short (actor form), and three long. */
const SURFACE_KEYS: readonly ProviderKey[] = [
  providerKey('gitlab glpat- + 20'),
  providerKey('stripe sk_live_ + 24'),
  providerKey('slack xoxb-'),
  providerKey('jwt 20 . 24 . 43'),
];

describe('scenario: Bare provider key refused (comment, through the CLI)', () => {
  it('each scenario value, bare and between spaces, in process: exit 1 secret-like naming only its pattern, no event', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const k of SCENARIO_BARE_KEYS) {
      for (const text of [k.value, `see ${k.value} here`]) {
        expectSecretRefusal(['comment', b.id, text, '--as', 'impl-1'], b.root, k.pattern, true, [
          fixtureOf(k),
        ]);
      }
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });

  it('against the built CLI, for a short, a dotted and a hyphenated key', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const label of [
      'gitlab glpat- + 20',
      'jwt 20 . 24 . 43',
      'anthropic sk-ant-api03- + 95',
    ]) {
      const k = providerKey(label);
      expectSecretRefusal(
        ['comment', b.id, k.value, '--as', 'impl-1'],
        b.root,
        k.pattern,
        true,
        [fixtureOf(k)],
        { runner: 'child' },
      );
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });
});

describe('scenarios: Prefixed key after a separator or quote; Short key; Assigned key (comment)', () => {
  it.each(RUNNERS)('%s: each is refused naming the pattern(s), nothing written', (runner) => {
    const b = board();
    const before = allNames(b.eventsDir);
    const cases: [string, string, SecretFixture][] = [
      [`"${GLPAT_20}`, 'gitlab-token', asFixture('quoted glpat', GLPAT_20)],
      [
        providerKey('slack rotating xoxe.xoxp-1- + 140').value,
        'slack-token',
        fixtureOf(providerKey('slack rotating xoxe.xoxp-1- + 140')),
      ],
      [RK_LIVE_16, 'stripe-secret-key', asFixture('rk_live_ + 16', RK_LIVE_16)],
      [
        ASSIGNED_STRIPE_KEY,
        'stripe-secret-key, generic-secret-assignment',
        asFixture('assigned stripe key', ASSIGNED_STRIPE_KEY.slice('STRIPE_KEY='.length)),
      ],
    ];
    for (const [text, names, f] of cases) {
      expectSecretRefusal(['comment', b.id, text, '--as', 'impl-1'], b.root, names, true, [f], {
        runner,
      });
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });
});

describe('scenario: Every surface uses the same patterns (CLI)', () => {
  it.each(RUNNERS)(
    '%s: new title, hand-off note and release --force --reason: bypass hint, nothing written',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      for (const k of SURFACE_KEYS) {
        const f = [fixtureOf(k)];
        expectSecretRefusal(
          ['new', `rotate ${k.value}`, '--task', 'openspec:x#2', '--as', 'orch'],
          b.root,
          k.pattern,
          true,
          f,
          { runner },
        );
        expectSecretRefusal(
          [
            'handoff',
            b.id,
            '--to',
            'impl-1',
            '--status',
            'review',
            '--note',
            `use ${k.value}`,
            '--as',
            'orch',
          ],
          b.root,
          k.pattern,
          true,
          f,
          { runner },
        );
        expectSecretRefusal(
          ['release', b.id, '--force', '--reason', `gone ${k.value}`, '--as', 'orch'],
          b.root,
          k.pattern,
          true,
          f,
          { runner },
        );
      }
      expect(allNames(b.eventsDir)).toEqual(before);
    },
  );

  it.each(RUNNERS)(
    '%s: import-change with a key in a task line or a unit title: no bypass hint, nothing written',
    (runner) => {
      for (const k of SURFACE_KEYS) {
        for (const tasks of [
          `## 1. One\n- [ ] 1.1 configure ${k.value} in CI\n`,
          `## 1. Rotate ${k.value}\n- [ ] 1.1 a\n`,
        ]) {
          const { root, boardDir } = project();
          mkdirSync(join(root, 'openspec', 'changes', 'prefixes'), { recursive: true });
          writeFileSync(join(root, 'openspec', 'changes', 'prefixes', 'tasks.md'), tasks);
          const eventsDir = join(boardDir, 'events');
          const before = allNames(eventsDir);
          expectSecretRefusal(
            ['import-change', 'prefixes', '--as', 'orch'],
            root,
            k.pattern,
            false,
            [fixtureOf(k)],
            { runner },
          );
          expect(allNames(eventsDir)).toEqual(before);
        }
      }
    },
  );
});

describe('scenario: Override writes a prefixed key', () => {
  it.each(RUNNERS)(
    '%s: comment holding glpat- and 20 characters with --allow-secret-like is written',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      const out = runWith(
        runner,
        [
          'comment',
          b.id,
          `the GitLab token is ${GLPAT_20}`,
          '--allow-secret-like',
          '--as',
          'impl-1',
        ],
        b.root,
        cliEnv(),
      );
      expectWritten(out, 'comment --allow-secret-like');
      expect(allNames(b.eventsDir)).toHaveLength(before.length + 1);
    },
  );

  it('every new pattern is written with --allow-secret-like, in process', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const k of NEW_PATTERN_KEYS) {
      expectWritten(
        run(['comment', b.id, `x ${k.value}`, '--allow-secret-like', '--as', 'impl-1'], b.root),
        k.label,
      );
    }
    expect(allNames(b.eventsDir)).toHaveLength(before.length + NEW_PATTERN_KEYS.length);
  });
});

describe('scenarios: Near-misses stay accepted; Prefix inside a word (comment)', () => {
  it('each near-miss and each key glued to a letter or digit is written, in process', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    const accepted = [...NEAR_MISSES, ...PREFIX_INSIDE_A_WORD];
    for (const k of accepted) {
      expectWritten(
        run(['comment', b.id, `see ${k.value} here`, '--as', 'impl-1'], b.root),
        k.label,
      );
    }
    expect(allNames(b.eventsDir)).toHaveLength(before.length + accepted.length);
  });

  it('against the built CLI, for the Stripe publishable keys and a glued Stripe secret key', () => {
    const b = board();
    for (const label of ['pk_live_ + 24', 'pk_test_ + 24', 'de then sk_live_ + 24']) {
      const k = [...NEAR_MISSES, ...PREFIX_INSIDE_A_WORD].find((a) => a.label === label);
      expect(k, label).toBeDefined();
      expectWritten(
        runWith(
          'child',
          ['comment', b.id, `see ${k?.value ?? ''} here`, '--as', 'impl-1'],
          b.root,
          cliEnv(),
        ),
        label,
      );
    }
  });
});

describe('scenario: Every surface uses the same patterns (web actions against a real server)', () => {
  it('comment and hand-off note: 400 secret-like naming the pattern, nothing echoed, nothing written', async () => {
    let output = '';
    const { server, root, eventsDir } = await actionServer({
      actor: 'ben',
      stderr: (text) => {
        output += text;
      },
    });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    for (const k of SURFACE_KEYS) {
      const f = [fixtureOf(k)];
      for (const [action, body] of [
        ['comment', { id, text: `oops ${k.value}` }],
        ['handoff', { id, to: 'impl-1', status: 'review', note: `use ${k.value}` }],
      ] as const) {
        const result = await post(server, action, body);
        expectNoLeak(`${action} ${k.label}`, [result.body, headerText(result), output], f);
        const error = refusal(result, 400, 1, 'secret-like');
        expect(error.message).toBe(secretMessage(k.pattern, true));
      }
    }
    expect(eventFiles(eventsDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// MCP, over a real stdio client to the built server.

interface CallResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

interface ToolError {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
}

/** A board with one ticket created through the built CLI, and an MCP server on it. */
async function mcpServed(
  env: RunEnv = cliEnv(),
): Promise<{ root: string; eventsDir: string; id: string; child: McpChild }> {
  const p = boardProject();
  const root = realpathSync(p.root);
  const out = await runCliAsync(
    ['new', 'Prefixes', '--task', 'openspec:x#1', '--as', 'orch', '--json'],
    root,
  );
  expect(out.code, out.stderr).toBe(0);
  const id = (oneDocument(out) as { ticket: { id: string } }).ticket.id;
  return { root, eventsDir: p.eventsDir, id, child: await mcpChild(root, env) };
}

/** Calls `name` and checks the tool error `reason` with exactly `message`; nothing leaked or written. */
async function expectToolError(
  s: { eventsDir: string; child: McpChild },
  name: string,
  args: Record<string, unknown>,
  reason: string,
  message: string,
  fixtures: readonly SecretFixture[],
): Promise<void> {
  const before = allNames(s.eventsDir);
  const result = (await s.child.client.callTool({ name, arguments: args })) as CallResult;
  expectNoLeak(`${name} result`, [result], fixtures);
  expectNoLeak(`${name} server stderr`, [s.child.stderr()], fixtures);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  const error = result.structuredContent as unknown as ToolError;
  expect({ exitCode: error.exitCode, reason: error.reason, message: error.message }).toEqual({
    exitCode: 1,
    reason,
    message,
  });
  expect(allNames(s.eventsDir)).toEqual(before);
}

describe('scenario: Every surface uses the same patterns (MCP free text)', () => {
  it('board_comment with a key in its text: secret-like naming the pattern; with allow-secret-like it is written', async () => {
    const s = await mcpServed();
    for (const k of SURFACE_KEYS) {
      await expectToolError(
        s,
        'board_comment',
        { id: s.id, text: `oops ${k.value}`, as: 'impl-1' },
        'secret-like',
        secretMessage(k.pattern, true),
        [fixtureOf(k)],
      );
    }
    const before = allNames(s.eventsDir);
    const ok = (await s.child.client.callTool({
      name: 'board_comment',
      arguments: { id: s.id, text: `x ${GLPAT_20}`, as: 'impl-1', 'allow-secret-like': true },
    })) as CallResult;
    expect(ok.isError, JSON.stringify(ok.structuredContent)).not.toBe(true);
    expect(allNames(s.eventsDir)).toHaveLength(before.length + 1);
  });
});

// ---------------------------------------------------------------------------
// Actor names (board-cli "Actor names are checked", scenario "Short
// prefixed key as the actor").

/** An actor-form key and the pattern its refusal names. */
interface ActorKey {
  readonly f: SecretFixture;
  readonly pattern: string;
}

/** `rk_live_` and 24 letters and digits: the scenario's key for `AGENTBOARD_ACTOR`. */
const RK_LIVE_ACTOR: ActorKey = {
  f: asFixture('rk_live_ + 24', RK_LIVE_24),
  pattern: 'stripe-secret-key',
};

/** The three keys of the scenario, each with the pattern its refusal names. */
const ACTOR_KEYS: readonly ActorKey[] = [
  RK_LIVE_ACTOR,
  { f: asFixture('sk_test_ + 24', SK_TEST_24), pattern: 'stripe-secret-key' },
  { f: asFixture('glpat- + 20', GLPAT_20), pattern: 'gitlab-token' },
];

describe('scenario: Short prefixed key as the actor (CLI)', () => {
  it.each(RUNNERS)(
    'comment T1 "hi" --as <key> (%s), plain and --json, with and without --allow-secret-like: invalid-actor naming the pattern, no event',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      for (const { f, pattern } of ACTOR_KEYS) {
        for (const extra of [[], ['--allow-secret-like']]) {
          expectActorRefusal(
            ['comment', b.id, 'hi', ...extra, '--as', f.value],
            b.root,
            actorPatternMessage('--as', pattern),
            [f],
            { runner },
          );
        }
      }
      expect(allNames(b.eventsDir)).toEqual(before);
    },
  );

  it.each(RUNNERS)(
    'claim T1 with AGENTBOARD_ACTOR=rk_live_ and 24 (%s): source AGENTBOARD_ACTOR',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      const { f, pattern } = RK_LIVE_ACTOR;
      expectActorRefusal(
        ['claim', b.id],
        b.root,
        actorPatternMessage('AGENTBOARD_ACTOR', pattern),
        [f],
        {
          runner,
          env: cliEnv({ AGENTBOARD_ACTOR: f.value }),
        },
      );
      expect(allNames(b.eventsDir)).toEqual(before);
    },
  );

  it('handoff --to <key>: source --to, ticket unchanged', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const { f, pattern } of ACTOR_KEYS) {
      expectActorRefusal(
        ['handoff', b.id, '--to', f.value, '--status', 'review', '--note', 'n', '--as', 'impl-1'],
        b.root,
        actorPatternMessage('--to', pattern),
        [f],
        { hint: 'to' },
      );
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });

  it('agentboard mcp --as <key> and agentboard serve --as <key> exit 1 invalid-actor without starting', () => {
    const b = board();
    for (const { f, pattern } of ACTOR_KEYS) {
      expectActorRefusal(
        ['mcp', '--as', f.value],
        b.root,
        actorPatternMessage('--as', pattern),
        [f],
        {
          runner: 'child',
        },
      );
      expectActorRefusal(
        ['serve', '--as', f.value, '--port', '0', '--no-open'],
        b.root,
        actorPatternMessage('--as', pattern),
        [f],
        { runner: 'child' },
      );
    }
  });
});

describe('scenario: Short prefixed key as the actor (MCP)', () => {
  it('board_comment with as set to each key, with and without allow-secret-like: the argument as', async () => {
    const s = await mcpServed();
    for (const { f, pattern } of ACTOR_KEYS) {
      for (const extra of [{}, { 'allow-secret-like': true }]) {
        await expectToolError(
          s,
          'board_comment',
          { id: s.id, text: 'hi', as: f.value, ...extra },
          'invalid-actor',
          actorPatternMessage('the argument as', pattern),
          [f],
        );
      }
    }
  });

  it('board_handoff with to set to each key: the argument to', async () => {
    const s = await mcpServed();
    for (const { f, pattern } of ACTOR_KEYS) {
      await expectToolError(
        s,
        'board_handoff',
        { id: s.id, to: f.value, status: 'review', note: 'n', as: 'impl-1' },
        'invalid-actor',
        actorPatternMessage('the argument to', pattern),
        [f],
      );
    }
  });

  it('board_claim with no as on a server whose AGENTBOARD_ACTOR is rk_live_ and 24: AGENTBOARD_ACTOR', async () => {
    const { f, pattern } = RK_LIVE_ACTOR;
    const s = await mcpServed(cliEnv({ AGENTBOARD_ACTOR: f.value }));
    await expectToolError(
      s,
      'board_claim',
      { id: s.id },
      'invalid-actor',
      actorPatternMessage('AGENTBOARD_ACTOR', pattern),
      [f],
    );
  });
});

// ---------------------------------------------------------------------------
// Review round 1, R1 (board-cli scenario "Very long input is checked
// without error"): the two surfaces that accept about 6 MiB in one string
// (the MCP stdio transport allows 10 MiB; a tasks.md line is unbounded)
// refuse or write it normally, never with exit 5. The CLI argument limit
// (128 KiB) and the web body limit (64 KiB) keep such input off the other
// surfaces.

/** About 6 MiB. */
const MIB6 = 6 * 1024 * 1024;

describe('scenario: Very long input is checked without error (surfaces)', () => {
  it('MCP board_comment with as set to eyJ and 6 MiB of A: invalid-actor for the form, not exit 5', async () => {
    const s = await mcpServed();
    const before = allNames(s.eventsDir);
    const result = (await s.child.client.callTool({
      name: 'board_comment',
      arguments: { id: s.id, text: 'hi', as: `eyJ${'A'.repeat(MIB6)}` },
    })) as CallResult;
    const text = JSON.stringify(result);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(/A{64}/.test(text)).toBe(false);
    expect(/A{64}/.test(s.child.stderr())).toBe(false);
    expect(result.isError).toBe(true);
    const error = result.structuredContent as unknown as ToolError;
    expect({ exitCode: error.exitCode, reason: error.reason, message: error.message }).toEqual({
      exitCode: 1,
      reason: 'invalid-actor',
      message: actorFormMessage('the argument as'),
    });
    expect(allNames(s.eventsDir)).toEqual(before);
  });

  it('import-change with a 6 MiB task line after SG. imports it (exit 0), in process', () => {
    const { root, boardDir } = project();
    mkdirSync(join(root, 'openspec', 'changes', 'long-line'), { recursive: true });
    writeFileSync(
      join(root, 'openspec', 'changes', 'long-line', 'tasks.md'),
      `## 1. One\n- [ ] 1.1 SG.${'A'.repeat(MIB6)}\n`,
    );
    const out = run(['import-change', 'long-line', '--as', 'orch', '--json'], root);
    expect(out.code, out.stderr.slice(0, 500)).toBe(0);
    expect(allNames(join(boardDir, 'events')).length).toBeGreaterThan(0);
  });

  it('import-change with a 6 MiB task line after eyJ that ends in a key is refused secret-like, not exit 5', () => {
    const { root, boardDir } = project();
    mkdirSync(join(root, 'openspec', 'changes', 'long-key'), { recursive: true });
    writeFileSync(
      join(root, 'openspec', 'changes', 'long-key', 'tasks.md'),
      `## 1. One\n- [ ] 1.1 eyJ${'A'.repeat(MIB6)} then ${GLPAT_20}\n`,
    );
    const before = allNames(join(boardDir, 'events'));
    const out = run(['import-change', 'long-key', '--as', 'orch', '--json'], root);
    expect(out.code, out.stderr.slice(0, 500)).toBe(1);
    expect((oneJson(out) as { error: { reason: string; message: string } }).error).toMatchObject({
      reason: 'secret-like',
      message: secretMessage('gitlab-token', false),
    });
    expect(/A{64}/.test(out.stdout + out.stderr)).toBe(false);
    expect(allNames(join(boardDir, 'events'))).toEqual(before);
  });
});
