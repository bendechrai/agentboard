/**
 * The actor check of the web app against the built CLI (actor-secret-check
 * group 2, task 2.1; board-web-actions "Actor names from the server and
 * the browser are checked", scenarios "Serve started with a token", "Hand-
 * off to a token from the browser" and "Hand-off to an existing actor
 * style from the browser" against a real server). Run `npm run build`
 * first when running vitest directly.
 *
 * - `agentboard serve --as <refused>` (and `--as=<refused>`), plain and
 *   `--json`, exits 1 with reason `invalid-actor` and the CLI hint, before
 *   it listens: it exits on its own, prints no URL and no access token,
 *   writes nothing, needs no board and is refused before the port is
 *   tried; the refused name is in neither stdout nor stderr.
 * - A writable `agentboard serve --as ben` child refuses a hand-off to
 *   every refused name with 400 `invalid-actor` naming `the argument to`
 *   and the web hint, writes nothing, and the name appears in neither the
 *   response (body and headers) nor the child's stdout and stderr; it
 *   accepts a hand-off to every accepted name.
 */

import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { cliEnv } from '../cli/__tests__/cli-helpers.js';
import { expectActorRefusal, tree } from '../cli/__tests__/actor-check-helpers.js';
import { occupiedPort, until } from '../web/__tests__/web-helpers.js';
import {
  eventFiles,
  expectWebActorHint,
  headerText,
  post,
  refusal,
} from '../web/__tests__/action-helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  scratchDir,
  startCli,
  type CliProcess,
} from './harness/processes.js';
import {
  ACTORS_ACCEPTED,
  ACTORS_REFUSED,
  GITHUB_TOKEN,
  actorMessage,
  expectNoLeak,
  type RefusedActor,
} from './harness/secret-fixtures.js';

// Machines under load: these spawn the built CLI many times.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

/** The refused fixture whose value is `value`. */
function refused(value: string): RefusedActor {
  const found = ACTORS_REFUSED.find((r) => r.value === value);
  if (found === undefined) {
    throw new Error('no such refused fixture');
  }
  return found;
}

/** Creates a ticket through the built CLI as `orch`; returns its id. */
async function newTicket(root: string): Promise<string> {
  const out = await runCliAsync(
    ['new', 'Served', '--task', 'openspec:actor-secret-check#2', '--as', 'orch', '--json'],
    root,
  );
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

/** Checks that `text` shows no start-up line: no URL and no access token. */
function expectNoStartup(text: string): void {
  expect(text).not.toContain('http://');
  expect(text).not.toContain('#token=');
  expect(text).not.toContain('serving ');
  expect(text).not.toMatch(/"token"/);
}

describe('scenario: Serve started with a token', () => {
  it('serve --as <GitHub token>, plain and --json: exit 1 invalid-actor, no URL, nothing written', () => {
    const { root, boardDir } = boardProject();
    const before = tree(boardDir);
    const f = refused(GITHUB_TOKEN);
    const plain = expectActorRefusal(
      ['serve', '--as', f.value, '--port', '0', '--no-open'],
      root,
      actorMessage('--as', f),
      [f],
      { runner: 'child' },
    );
    expectNoStartup(plain.stdout + plain.stderr);
    expect(tree(boardDir)).toEqual(before);
  });

  it('every refused name, as --as and as --as=, plain and --json: the same refusal, nothing written', () => {
    const { root, boardDir } = boardProject();
    const before = tree(boardDir);
    for (const f of ACTORS_REFUSED) {
      for (const argv of [
        ['serve', '--as', f.value, '--port', '0', '--no-open'],
        ['serve', `--as=${f.value}`, '--port', '0', '--no-open'],
      ]) {
        const plain = expectActorRefusal(argv, root, actorMessage('--as', f), [f], {
          runner: 'child',
        });
        expectNoStartup(plain.stdout + plain.stderr);
      }
    }
    expect(tree(boardDir)).toEqual(before);
  });

  it('is refused before the board is looked for: invalid-actor where there is no board', () => {
    const root = scratchDir();
    const f = refused(GITHUB_TOKEN);
    expectActorRefusal(
      ['serve', '--as', f.value, '--no-open'],
      root,
      actorMessage('--as', f),
      [f],
      {
        runner: 'child',
        env: cliEnv({ AGENTBOARD_DIR: join(root, 'nowhere') }),
      },
    );
    expect(tree(root)).toEqual([]);
  });

  it('is refused before the port is tried: invalid-actor, not port-in-use', async () => {
    const { root } = boardProject();
    const port = await occupiedPort();
    const f = refused(GITHUB_TOKEN);
    expectActorRefusal(
      ['serve', '--as', f.value, '--port', String(port), '--no-open'],
      root,
      actorMessage('--as', f),
      [f],
      { runner: 'child' },
    );
  });
});

/** The parsed `--json` start-up line of a `serve` child. */
interface Startup {
  port: number;
  token: string;
  writable: boolean;
  actor: string | null;
}

async function startup(proc: CliProcess): Promise<Startup> {
  await until(
    () => proc.stdout().includes('\n'),
    15_000,
    `the start-up line (stderr: ${proc.stderr()})`,
  );
  return JSON.parse(proc.stdout().split('\n')[0] ?? '') as Startup;
}

describe('a real writable server (serve --as ben)', () => {
  it('scenario: Hand-off to a token from the browser: every refused to is 400 invalid-actor, nothing written, no echo anywhere', async () => {
    const { root, eventsDir } = boardProject();
    const id = await newTicket(root);
    const proc = startCli({ argv: ['serve', '--as', 'ben', '--port', '0', '--json'] }, root);
    const line = await startup(proc);
    expect(line).toMatchObject({ writable: true, actor: 'ben' });
    const before = eventFiles(eventsDir);
    const bodies: string[] = [];
    for (const f of ACTORS_REFUSED) {
      const result = await post(line, 'handoff', { id, to: f.value, status: 'review', note: 'n' });
      expectNoLeak(f.name, [result.body, headerText(result), proc.stdout(), proc.stderr()], [f]);
      const error = refusal(result, 400, 1, 'invalid-actor');
      expectNoLeak(`${f.name} parsed`, [error.message, error.hint ?? ''], [f]);
      expect(error.message).toBe(actorMessage('the argument to', f));
      expectWebActorHint(error.hint);
      bodies.push(result.body);
    }
    expect(eventFiles(eventsDir)).toEqual(before);
    process.kill(proc.pid, 'SIGINT');
    const result = await proc.exited;
    expect(result).toMatchObject({ code: 0, signal: null });
    expectNoLeak('server output', [result.stdout, result.stderr], ACTORS_REFUSED);
    expect(result.stdout.split('\n')).toEqual([JSON.stringify(line), '']);
    expect(result.stderr).toBe('');
    expect(bodies).toHaveLength(ACTORS_REFUSED.length);
  });

  it('scenario: Hand-off to an existing actor style from the browser: reviewer-3-2 and every accepted name', async () => {
    const { root } = boardProject();
    const id = await newTicket(root);
    const proc = startCli({ argv: ['serve', '--as', 'ben', '--port', '0', '--json'] }, root);
    const line = await startup(proc);
    // The first hand-off moves T1 to tests; the later ones only reassign.
    for (const name of ['reviewer-3-2', ...ACTORS_ACCEPTED]) {
      const result = await post(line, 'handoff', { id, to: name, status: 'tests', note: 'n' });
      expect(result.status, `${name}: ${result.body}`).toBe(200);
      const doc = JSON.parse(result.body) as { ticket: { assignee: string | null } };
      expect(doc.ticket.assignee, name).toBe(name);
    }
    process.kill(proc.pid, 'SIGINT');
    expect(await proc.exited).toMatchObject({ code: 0, signal: null });
  });
});
