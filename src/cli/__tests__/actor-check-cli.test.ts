/**
 * The actor check on the CLI (actor-secret-check task 1.2; board-cli
 * "Actor is explicit" and "Actor names are checked"): every board-cli
 * scenario of task 1.2, in process (`runCli`) and against the built CLI,
 * plain and with `--json`. Every refusal is checked for exit 1, reason
 * `invalid-actor`, the exact message naming its source, a hint writing
 * `<actor>`, no event or temporary file written, and the refused name in
 * no output.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ACTORS_ACCEPTED,
  ACTORS_REFUSED,
  ACTORS_REFUSED_BY_FORM,
  AWS_KEY_ID,
  GITHUB_TOKEN,
  HEX_32,
  HEX_40,
  TOTP_SEED,
  actorFormMessage,
  actorMessage,
  actorPatternMessage,
  expectNoLeak,
  fixture,
  type RefusedActor,
} from '../../__tests__/harness/secret-fixtures.js';
import { tempDir } from '../../board/__tests__/helpers.js';
import { allNames } from '../../store/__tests__/helpers.js';
import { COMMANDS } from '../registry.js';
import { parseArgs } from '../parse.js';
import { expectActorRefusal, expectCliActorHint, tree } from './actor-check-helpers.js';
import { cliEnv, oneJson, project, run, written, type RunEnv } from './cli-helpers.js';
import { runWith, type Runner } from './no-echo-helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const RUNNERS: readonly Runner[] = ['in-process', 'child'];

/** The scenario's token fixtures (GitHub-style, AWS-style key id, 40 hex characters). */
const SCENARIO_TOKENS: readonly RefusedActor[] = ACTORS_REFUSED.filter((f) =>
  ['github-token', 'aws-key-id', 'hex-40'].includes(f.name),
);

/** The refused name of `name` in the actor tables. */
function refused(name: string): RefusedActor {
  const found = ACTORS_REFUSED.find((f) => f.name === name);
  if (found === undefined) {
    throw new Error(`no refused actor named ${name}`);
  }
  return found;
}

/** A board with one ticket, created by `orch`. */
function board(): { root: string; eventsDir: string; id: string } {
  const { root, boardDir } = project();
  const out = run(['new', 'Actor check', '--task', 'openspec:x#1', '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return { root, eventsDir: join(boardDir, 'events'), id: written(out).id };
}

/** The `actor` of the event file `hash` (and its `ts.actor`, which must agree). */
function eventActor(eventsDir: string, hash: string | null): string {
  expect(hash).not.toBeNull();
  const event = JSON.parse(readFileSync(join(eventsDir, `${String(hash)}.json`), 'utf8')) as {
    actor: string;
    ts: { actor: string };
  };
  expect(event.ts.actor).toBe(event.actor);
  return event.actor;
}

/** The ticket of `show <id> --json` of `root`. */
function showJson(root: string, id: string): Record<string, unknown> {
  const out = run(['show', id, '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneJson(out) as { ticket: Record<string, unknown> }).ticket;
}

/** An environment whose board directory does not exist (inside `root`, so nothing escapes it). */
function noBoardEnv(root: string, extra: RunEnv = {}): RunEnv {
  return cliEnv({ AGENTBOARD_DIR: join(root, 'nowhere'), ...extra });
}

describe('scenario: Read command with a refused actor', () => {
  it.each(RUNNERS)(
    'show T1 --as <github token> (%s): exit 1 invalid-actor, no ticket, no token',
    (runner) => {
      const b = board();
      const f = refused('github-token');
      expectActorRefusal(
        ['show', b.id, '--as', f.value],
        b.root,
        actorPatternMessage('--as', 'github-token'),
        [f],
        { runner },
      );
    },
  );

  it('list, inbox, health, show with every refused name: refused, nothing printed', () => {
    const b = board();
    for (const f of ACTORS_REFUSED) {
      for (const argv of [['show', b.id], ['list'], ['inbox'], ['health']]) {
        expectActorRefusal([...argv, '--as', f.value], b.root, actorMessage('--as', f), [f]);
      }
    }
  });
});

describe('scenario: Token as the actor of a write', () => {
  it.each(RUNNERS)(
    'comment T1 "hi" --as <token> (%s), with and without --allow-secret-like: refused, no event',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      for (const f of SCENARIO_TOKENS) {
        for (const extra of [[], ['--allow-secret-like']]) {
          expectActorRefusal(
            ['comment', b.id, 'hi', ...extra, '--as', f.value],
            b.root,
            actorMessage('--as', f),
            [f],
            { runner },
          );
        }
      }
      expect(allNames(b.eventsDir)).toEqual(before);
    },
  );

  it('the GitHub-style and AWS-style tokens get the pattern message, the hex string the form message', () => {
    expect(actorMessage('--as', refused('github-token'))).toBe(
      actorPatternMessage('--as', 'github-token'),
    );
    expect(actorMessage('--as', refused('aws-key-id'))).toBe(
      actorPatternMessage('--as', 'aws-access-key-id'),
    );
    expect(actorMessage('--as', refused('hex-40'))).toBe(actorFormMessage('--as'));
  });

  it('every refused name, as --as and as --as=<name>: refused, no event, no temporary file', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const f of ACTORS_REFUSED) {
      expectActorRefusal(
        ['comment', b.id, 'hi', '--as', f.value],
        b.root,
        actorMessage('--as', f),
        [f],
      );
      expectActorRefusal(
        ['comment', b.id, 'hi', `--as=${f.value}`],
        b.root,
        actorMessage('--as', f),
        [f],
      );
      expectActorRefusal(
        ['new', 'A title', '--adhoc', 'a reason', '--as', f.value],
        b.root,
        actorMessage('--as', f),
        [f],
      );
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });

  it('is refused before the board is opened: with no board the exit is 1 invalid-actor, not 2', () => {
    const root = tempDir();
    for (const f of SCENARIO_TOKENS) {
      expectActorRefusal(
        ['comment', '01J9K3', 'hi', '--as', f.value],
        root,
        actorMessage('--as', f),
        [f],
        {
          env: noBoardEnv(root),
        },
      );
    }
    expect(tree(root)).toEqual([]);
  });

  it('the refused --as wins over a valid AGENTBOARD_ACTOR', () => {
    const b = board();
    const f = refused('github-token');
    expectActorRefusal(
      ['comment', b.id, 'hi', '--as', f.value],
      b.root,
      actorMessage('--as', f),
      [f],
      {
        env: cliEnv({ AGENTBOARD_ACTOR: 'impl-1' }),
      },
    );
  });
});

describe('scenario: Token in the environment', () => {
  it.each(RUNNERS)(
    'claim T1 with AGENTBOARD_ACTOR=<github token> (%s): source AGENTBOARD_ACTOR',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      const f = refused('github-token');
      expectActorRefusal(
        ['claim', b.id],
        b.root,
        'refused: the actor name given with AGENTBOARD_ACTOR matches the secret pattern(s) github-token; an actor name is recorded on every event and shared with the board, so choose another name (--allow-secret-like does not apply to actor names)',
        [f],
        { runner, env: cliEnv({ AGENTBOARD_ACTOR: f.value }) },
      );
      expect(allNames(b.eventsDir)).toEqual(before);
    },
  );

  it('every refused name in AGENTBOARD_ACTOR, for a writing and a cursor-tracking command', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const f of ACTORS_REFUSED) {
      const env = cliEnv({ AGENTBOARD_ACTOR: f.value });
      expectActorRefusal(
        ['comment', b.id, 'hi'],
        b.root,
        actorMessage('AGENTBOARD_ACTOR', f),
        [f],
        { env },
      );
      expectActorRefusal(['inbox'], b.root, actorMessage('AGENTBOARD_ACTOR', f), [f], { env });
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });

  it('an unused AGENTBOARD_ACTOR is not checked: --as given takes precedence and is recorded', () => {
    const b = board();
    for (const f of SCENARIO_TOKENS) {
      const out = run(
        ['comment', b.id, 'hi', '--as', 'impl-1', '--json'],
        b.root,
        cliEnv({ AGENTBOARD_ACTOR: f.value }),
      );
      expect(out.code, out.stderr).toBe(0);
      expect(eventActor(b.eventsDir, written(out).hash)).toBe('impl-1');
      expectNoLeak('comment with --as', [out.stdout, out.stderr], [f]);
    }
  });

  it('an accepted AGENTBOARD_ACTOR is used and recorded exactly', () => {
    const b = board();
    const out = run(
      ['comment', b.id, 'hi', '--json'],
      b.root,
      cliEnv({ AGENTBOARD_ACTOR: 'ben@laptop' }),
    );
    expect(out.code, out.stderr).toBe(0);
    expect(eventActor(b.eventsDir, written(out).hash)).toBe('ben@laptop');
  });
});

describe('scenario: Read command ignores the environment actor', () => {
  it.each(RUNNERS)(
    'list exits 0 and show <unknown-id> exits 4 unknown-ticket (%s), no token',
    (runner) => {
      const b = board();
      for (const f of SCENARIO_TOKENS) {
        const env = cliEnv({ AGENTBOARD_ACTOR: f.value });
        const list = runWith(runner, ['list'], b.root, env);
        expect(list.code, list.stderr).toBe(0);
        const show = runWith(runner, ['show', '01ZZZZZZZZZZZZZZZZZZZZZZZZ', '--json'], b.root, env);
        expect(show.code, show.stderr).toBe(4);
        expect((oneJson(show) as { error: { reason: string } }).error.reason).toBe(
          'unknown-ticket',
        );
        expectNoLeak('read commands', [list.stdout, list.stderr, show.stdout, show.stderr], [f]);
      }
    },
  );

  it('show, health, help and version are unaffected by any refused AGENTBOARD_ACTOR', () => {
    const b = board();
    for (const f of ACTORS_REFUSED) {
      const env = cliEnv({ AGENTBOARD_ACTOR: f.value });
      for (const argv of [
        ['show', b.id],
        ['health'],
        ['help'],
        ['version'],
        ['list', '--assignee', 'orch'],
      ]) {
        const out = run(argv, b.root, env);
        expect(out.code, `${argv.join(' ')}: ${out.stderr}`).toBe(0);
        expectNoLeak(argv.join(' '), [out.stdout, out.stderr], [f]);
      }
    }
  });

  it('an ignored AGENTBOARD_ACTOR that passes the check is not repeated either: top (built CLI) writes <actor>', () => {
    // reviewer-ac1-2 finding 1: top ignores the variable, so its hint
    // (which suggests watch --as <actor>) must not repeat it, even when it
    // passes the check (32 hex characters, the residual-risk class). Built
    // CLI only: in process, runCli cannot stream and hints the executable.
    const runner: Runner = 'child';
    const b = board();
    for (const value of [HEX_32, TOTP_SEED, 'impl-1']) {
      const env = cliEnv({ AGENTBOARD_ACTOR: value });
      for (const json of [false, true]) {
        const out = runWith(runner, json ? ['top', '--json'] : ['top'], b.root, env);
        expect(out.code).toBe(1);
        const hint = /^hint: (.*)$/m.exec(out.stderr)?.[1] ?? '';
        expect(hint).toContain('watch --as <actor>');
        expect(out.stderr).not.toContain(value);
        expect(out.stdout).not.toContain(value);
      }
    }
  });

  it('an AGENTBOARD_ACTOR that a command uses and that passes is still repeated (unchanged)', () => {
    const b = board();
    const out = run(['close', b.id], b.root, cliEnv({ AGENTBOARD_ACTOR: HEX_32 }));
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`--as ${HEX_32}`);
  });

  it('a failing read command does not repeat an ignored AGENTBOARD_ACTOR in its hint', () => {
    const b = board();
    for (const f of ACTORS_REFUSED) {
      const env = cliEnv({ AGENTBOARD_ACTOR: f.value });
      for (const argv of [
        ['show', '01ZZZZ'],
        ['show', '01'],
        ['list', '--status', 'nope'],
        ['show'],
      ]) {
        const out = run([...argv, '--json'], b.root, env);
        expect(out.code).not.toBe(0);
        expectNoLeak(argv.join(' '), [out.stdout, out.stderr], [f]);
      }
    }
  });
});

describe('scenario: Names outside the actor form', () => {
  it.each(RUNNERS)(
    'a writing command with each name outside the form (%s): the form message',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      const names =
        runner === 'child'
          ? ACTORS_REFUSED_BY_FORM.filter((f) =>
              [
                '33-characters',
                'space',
                'slash',
                'leading-hyphen',
                'leading-dot',
                'leading-underscore',
                'non-ascii-letter',
                'esc',
              ].includes(f.name),
            )
          : ACTORS_REFUSED_BY_FORM;
      for (const f of names) {
        expectActorRefusal(
          ['comment', b.id, 'hi', '--as', f.value],
          b.root,
          actorFormMessage('--as'),
          [f],
          {
            runner,
          },
        );
      }
      expect(allNames(b.eventsDir)).toEqual(before);
    },
  );
});

describe('scenario: Existing actor styles are accepted', () => {
  it('every accepted name (the board, the docs, the other styles) is recorded exactly as given', () => {
    const b = board();
    for (const name of ACTORS_ACCEPTED.filter((a) => a !== 'agentboard')) {
      const out = run(['comment', b.id, 'hi', '--as', name, '--json'], b.root);
      expect(out.code, `${name}: ${out.stderr}`).toBe(0);
      expect(eventActor(b.eventsDir, written(out).hash)).toBe(name);
    }
  });

  it.each(RUNNERS)('the scenario names, against %s', (runner) => {
    const b = board();
    for (const name of [
      'orch',
      'orchestrator',
      'impl-1',
      'reviewer-3-2',
      'test-author-ne2',
      'implementer-dm2',
      'merger-2',
      'ben',
      'a',
      '0',
      'Ben',
      'ben.dechrai',
      'test_author',
      'ben@laptop',
      `a${'b'.repeat(31)}`,
    ]) {
      const out = runWith(
        runner,
        ['comment', b.id, 'hi', '--as', name, '--json'],
        b.root,
        cliEnv(),
      );
      expect(out.code, `${name}: ${out.stderr}`).toBe(0);
      expect(eventActor(b.eventsDir, written(out).hash)).toBe(name);
    }
  });

  it('handoff --to an accepted name assigns the ticket to it exactly', () => {
    const b = board();
    for (const name of [
      'reviewer-3-2',
      'Ben',
      'ben.dechrai',
      'test_author',
      'ben@laptop',
      `a${'b'.repeat(31)}`,
      '0',
    ]) {
      const out = run(
        [
          'handoff',
          b.id,
          '--to',
          name,
          '--status',
          'todo',
          '--note',
          'n',
          '--as',
          'orch',
          '--json',
        ],
        b.root,
      );
      expect(out.code, `${name}: ${out.stderr}`).toBe(0);
      expect(showJson(b.root, b.id).assignee).toBe(name);
    }
  });
});

describe('scenario: Reserved actor keeps its refusal', () => {
  it('comment T1 "x" --as agentboard exits 1 usage, not invalid-actor, and writes nothing', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    const out = run(['comment', b.id, 'x', '--as', 'agentboard', '--json'], b.root);
    expect(out.code).toBe(1);
    expect((oneJson(out) as { error: { reason: string } }).error.reason).toBe('usage');
    expect(allNames(b.eventsDir)).toEqual(before);
  });

  it('AGENTBOARD_ACTOR=agentboard for a writing command is still usage', () => {
    const b = board();
    const out = run(['claim', b.id, '--json'], b.root, cliEnv({ AGENTBOARD_ACTOR: 'agentboard' }));
    expect(out.code).toBe(1);
    expect((oneJson(out) as { error: { reason: string } }).error.reason).toBe('usage');
  });

  it('handoff --to agentboard is not newly refused (the reserved rule concerns the event actor)', () => {
    const b = board();
    const out = run(
      ['handoff', b.id, '--to', 'agentboard', '--status', 'todo', '--note', 'n', '--as', 'orch'],
      b.root,
    );
    expect(out.code, out.stderr).toBe(0);
  });
});

describe('scenario: Hand-off to a token', () => {
  it.each(RUNNERS)(
    'handoff T1 --to <token> ... --as impl-1 (%s): source --to, ticket unchanged',
    (runner) => {
      const b = board();
      const before = allNames(b.eventsDir);
      const shown = showJson(b.root, b.id);
      for (const f of SCENARIO_TOKENS) {
        expectActorRefusal(
          ['handoff', b.id, '--to', f.value, '--status', 'review', '--note', 'n', '--as', 'impl-1'],
          b.root,
          actorMessage('--to', f),
          [f],
          { runner, hint: 'to' },
        );
      }
      expect(allNames(b.eventsDir)).toEqual(before);
      expect(showJson(b.root, b.id)).toEqual(shown);
    },
  );

  it('every refused name as --to, with and without --allow-secret-like, and as --to=<name>', () => {
    const b = board();
    const before = allNames(b.eventsDir);
    for (const f of ACTORS_REFUSED) {
      for (const to of [['--to', f.value], [`--to=${f.value}`]]) {
        for (const extra of [[], ['--allow-secret-like']]) {
          expectActorRefusal(
            ['handoff', b.id, ...to, '--status', 'todo', '--note', 'n', ...extra, '--as', 'impl-1'],
            b.root,
            actorMessage('--to', f),
            [f],
            { hint: 'to' },
          );
        }
      }
    }
    expect(allNames(b.eventsDir)).toEqual(before);
  });

  it('a refused --to is refused before the board is opened (no board: exit 1, not 2)', () => {
    const root = tempDir();
    const f = refused('github-token');
    expectActorRefusal(
      ['handoff', '01J9K3', '--to', f.value, '--status', 'review', '--note', 'n', '--as', 'impl-1'],
      root,
      actorMessage('--to', f),
      [f],
      { env: noBoardEnv(root), hint: 'to' },
    );
  });

  it('with both --as and --to refused, the actor is refused first (source --as)', () => {
    const b = board();
    const as = refused('aws-key-id');
    const to = refused('github-token');
    expectActorRefusal(
      ['handoff', b.id, '--to', to.value, '--status', 'todo', '--note', 'n', '--as', as.value],
      b.root,
      actorMessage('--as', as),
      [as, to],
    );
  });
});

describe('scenario: Failed parse names no unchecked actor', () => {
  it.each(RUNNERS)('close --unplanned --as <token> and close T1 --as <token> (%s)', (runner) => {
    const b = board();
    for (const f of SCENARIO_TOKENS) {
      for (const argv of [
        ['close', '--unplanned', '--as', f.value],
        ['close', b.id, '--as', f.value],
        ['close', b.id, `--as=${f.value}`],
      ]) {
        for (const json of [false, true]) {
          const out = runWith(runner, json ? [...argv, '--json'] : argv, b.root, cliEnv());
          expect(out.code).toBe(1);
          expectNoLeak(`close (${String(argv.length)} args)`, [out.stdout, out.stderr], [f]);
          const hint = /^hint: (.*)$/m.exec(out.stderr)?.[1] ?? '';
          if (hint.includes('--as')) {
            expect(hint, `close (${String(argv.length)} args)`).not.toMatch(/--as (?!<actor>)/);
          }
        }
      }
    }
  });

  it('close T1 with no disposition and --as <token>: the hint writes --as <actor>', () => {
    const b = board();
    for (const f of ACTORS_REFUSED) {
      const out = run(['close', b.id, '--as', f.value], b.root);
      expect(out.code).toBe(1);
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
      expect(out.stderr).toContain('--as <actor>');
    }
  });

  it('close T1 with no disposition and a refused AGENTBOARD_ACTOR: the hint writes --as <actor>', () => {
    const b = board();
    for (const f of ACTORS_REFUSED) {
      const out = run(['close', b.id], b.root, cliEnv({ AGENTBOARD_ACTOR: f.value }));
      expect(out.code).toBe(1);
      expectNoLeak(f.name, [out.stdout, out.stderr], [f]);
      expect(out.stderr).toContain('--as <actor>');
    }
  });

  it('a failed parse with an accepted --as still names it (unchanged)', () => {
    const b = board();
    const out = run(['close', b.id, '--as', 'orch'], b.root);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('--as orch');
    const env = run(['close', b.id], b.root, cliEnv({ AGENTBOARD_ACTOR: 'ben.dechrai' }));
    expect(env.code).toBe(1);
    expect(env.stderr).toContain('--as ben.dechrai');
  });

  it('any other refusal of a run whose --as is refused is the actor refusal (checked before the board)', () => {
    const b = board();
    const f = refused('github-token');
    // A bad ticket id with a refused actor: the actor is checked first.
    expectActorRefusal(
      ['comment', '01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'hi', '--as', f.value],
      b.root,
      actorMessage('--as', f),
      [f],
    );
  });
});

/**
 * One parsing command line per registry command, with a refused `--as`
 * appended by the test. Each parses (checked below), so a refusal can come
 * only from the actor check.
 */
const EVERY_COMMAND: Readonly<Record<string, readonly string[]>> = {
  init: ['init'],
  new: ['new', 'A title', '--adhoc', 'a reason'],
  show: ['show', '01J9K3'],
  list: ['list'],
  claim: ['claim', '01J9K3'],
  renew: ['renew', '01J9K3'],
  unqueue: ['unqueue', '01J9K3'],
  release: ['release', '01J9K3'],
  move: ['move', '01J9K3', 'tests'],
  comment: ['comment', '01J9K3', 'hi'],
  handoff: ['handoff', '01J9K3', '--to', 'reviewer', '--status', 'review', '--note', 'n'],
  link: ['link', '01J9K3', '--pr', '1'],
  'checklist tick': ['checklist', 'tick', '01J9K3', '1'],
  'checklist untick': ['checklist', 'untick', '01J9K3', '1'],
  close: ['close', '01J9K3', '--no-decision'],
  inbox: ['inbox'],
  watch: ['watch'],
  serve: ['serve'],
  top: ['top'],
  health: ['health'],
  rebuild: ['rebuild'],
  sync: ['sync'],
  remote: ['remote'],
  'import-change': ['import-change', 'some-change'],
  'close-merged': ['close-merged'],
  'config set': ['config', 'set', 'queue.window', '5m'],
  'config get': ['config', 'get', 'queue.window'],
  mcp: ['mcp'],
  hook: ['hook', 'stop'],
  'agents install': ['agents', 'install'],
  'agents check': ['agents', 'check'],
  version: ['version'],
  help: ['help'],
};

describe('--as is checked on every command, before anything is read or written', () => {
  it('the table names every registry command, and each line parses with an accepted --as', () => {
    expect(Object.keys(EVERY_COMMAND).sort()).toEqual(COMMANDS.map((c) => c.name).sort());
    for (const [name, argv] of Object.entries(EVERY_COMMAND)) {
      expect(parseArgs([...argv, '--as', 'impl-1']).command.name, name).toBe(name);
    }
  });

  it.each(Object.entries(EVERY_COMMAND))(
    '%s --as <token>: exit 1 invalid-actor, the directory untouched (init and agents install too)',
    (_name, argv) => {
      const root = tempDir();
      const env = noBoardEnv(root);
      for (const f of [refused('github-token'), refused('hex-40'), refused('space')]) {
        expectActorRefusal([...argv, '--as', f.value], root, actorMessage('--as', f), [f], { env });
      }
      expect(tree(root)).toEqual([]);
    },
  );

  it('init and agents install with a refused --as, against the built CLI, touch nothing', () => {
    const root = tempDir();
    const f = refused('github-token');
    for (const argv of [['init'], ['agents', 'install']]) {
      expectActorRefusal([...argv, '--as', f.value], root, actorMessage('--as', f), [f], {
        runner: 'child',
        env: noBoardEnv(root),
      });
    }
    expect(tree(root)).toEqual([]);
  });

  it('an empty --as is not a given actor: a writing command falls back as before (missing-actor)', () => {
    const b = board();
    const out = run(['comment', b.id, 'hi', '--as', '', '--json'], b.root);
    expect(out.code).toBe(1);
    expect((oneJson(out) as { error: { reason: string } }).error.reason).toBe('missing-actor');
    const read = run(['show', b.id, '--as', ''], b.root);
    expect(read.code, read.stderr).toBe(0);
  });
});

describe('list --assignee is a filter, never checked', () => {
  it('accepts any text, a token or a name outside the form, and exits 0', () => {
    const b = board();
    for (const value of [GITHUB_TOKEN, AWS_KEY_ID, HEX_40, 'Ben Dechrai', 'claude/opus']) {
      const out = run(['list', '--assignee', value, '--json'], b.root);
      expect(out.code, out.stderr).toBe(0);
      expect(oneJson(out)).toEqual([]);
    }
  });
});

describe('the hint of every refusal names how to pass an actor, with <actor>', () => {
  it('a refused --as and a refused AGENTBOARD_ACTOR: --as <actor> and AGENTBOARD_ACTOR', () => {
    const b = board();
    const f = fixture('github-token');
    const out = run(['comment', b.id, 'hi', '--as', f.value, '--json'], b.root);
    expectCliActorHint((oneJson(out) as { error: { hint: string | null } }).error.hint, 'actor');
    const env = run(
      ['comment', b.id, 'hi', '--json'],
      b.root,
      cliEnv({ AGENTBOARD_ACTOR: f.value }),
    );
    expectCliActorHint((oneJson(env) as { error: { hint: string | null } }).error.hint, 'actor');
  });
});
