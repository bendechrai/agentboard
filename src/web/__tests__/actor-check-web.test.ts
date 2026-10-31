/**
 * The actor check on the web (actor-secret-check group 2, task 2.1;
 * board-web-actions "Actor names from the server and the browser are
 * checked"; board-agent-guidance "Guide states the actor form", the web
 * form of the `invalid-actor` hint). In process: a writable server as
 * `ben` with its stderr captured, `runAction` and `actionContext`.
 *
 * - The `to` of `POST /api/actions/handoff` is checked with the source
 *   `the argument to` (a web body's properties are the MCP argument
 *   names: design.md "Messages"; `RunContext.surface` is `mcp` for a web
 *   action), before the status, the ticket or the board is looked at:
 *   400, exit 1, reason `invalid-actor`, the exact message, the web hint,
 *   nothing written, and the refused name absent from the response body,
 *   its headers and the server's output.
 * - The web hint (group 2 test author ruling): one line with the
 *   placeholder `<actor>`, the word `form` and the form in the words of
 *   `--as` help, the step `'agentboard serve --as <actor>'` and `the new
 *   assignee in the to argument`; never `AGENTBOARD_ACTOR` (the browser
 *   cannot set it), `--to`, `agentboard mcp` or `as argument` (a web body
 *   refuses `as`).
 * - The browser has no override: `allow-secret-like` and `as` in the body
 *   stay refused with `usage`, repeating nothing.
 * - Every accepted name (the fixture tables, every board actor) is a valid
 *   `to`, and a valid `serve --as`; `--to agentboard` is not newly
 *   refused, `serve --as agentboard` keeps its reserved refusal.
 * - `serve` ignores `AGENTBOARD_ACTOR` and never repeats it.
 */

import { createServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import {
  ACTORS_ACCEPTED,
  ACTORS_REFUSED,
  GITHUB_TOKEN,
  actorMessage,
  expectNoLeak,
  type RefusedActor,
} from '../../__tests__/harness/secret-fixtures.js';
import { cliEnv, type RunEnv } from '../../cli/__tests__/cli-helpers.js';
import { runCliAsync, type AsyncCliIo } from '../../cli/main.js';
import { actionContext, runAction } from '../actions.js';
import { startServer } from '../server.js';
import {
  actionServer,
  eventFiles,
  expectWebActorHint,
  headerText,
  newEvents,
  newTicket,
  post,
  refusal,
  showTicket,
} from './action-helpers.js';
import { freePort, open, project, until, type HttpResult } from './web-helpers.js';

// Machines under load: the tables post and start servers many times.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

/** A writable server as `ben` with T1, its stderr captured. */
async function writable(): Promise<{
  server: Awaited<ReturnType<typeof actionServer>>['server'];
  root: string;
  eventsDir: string;
  id: string;
  output: () => string;
}> {
  let output = '';
  const { server, root, eventsDir } = await actionServer({
    actor: 'ben',
    stderr: (text) => {
      output += text;
    },
  });
  const id = newTicket(root);
  return { server, root, eventsDir, id, output: () => output };
}

/**
 * Checks a 400 `invalid-actor` refusal of the `to` `refused`: the exact
 * message naming `the argument to`, the web hint, and the refused name in
 * neither the body (raw, and the parsed message and hint), the headers nor
 * the server's output.
 */
function expectToRefusal(result: HttpResult, refused: RefusedActor, output: string): void {
  expectNoLeak(`${refused.name} response`, [result.body, headerText(result), output], [refused]);
  const error = refusal(result, 400, 1, 'invalid-actor');
  expectNoLeak(`${refused.name} parsed`, [error.message, error.hint ?? ''], [refused]);
  expect(error.message).toBe(actorMessage('the argument to', refused));
  expect(error.message).not.toContain('--to');
  expectWebActorHint(error.hint);
}

describe('scenario: Hand-off to a token from the browser', () => {
  it('the spec body with a GitHub token as to: 400 invalid-actor, nothing written, no echo', async () => {
    const s = await writable();
    const refused = ACTORS_REFUSED.find((r) => r.value === GITHUB_TOKEN);
    expect(refused).toBeDefined();
    const f = refused as RefusedActor;
    const before = eventFiles(s.eventsDir);
    const result = await post(s.server, 'handoff', {
      id: s.id,
      to: f.value,
      status: 'review',
      note: 'n',
    });
    expectToRefusal(result, f, s.output());
    expect(eventFiles(s.eventsDir)).toEqual(before);
    expect(showTicket(s.root, s.id).assignee).toBeNull();
  });

  it('every refused name (by pattern and by form) as to: the same refusal, nothing written', async () => {
    const s = await writable();
    const before = eventFiles(s.eventsDir);
    for (const f of ACTORS_REFUSED) {
      const result = await post(s.server, 'handoff', {
        id: s.id,
        to: f.value,
        status: 'tests',
        note: 'n',
      });
      expectToRefusal(result, f, s.output());
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });

  it('to is checked before the status, the note and the ticket', async () => {
    const s = await writable();
    const before = eventFiles(s.eventsDir);
    const f = ACTORS_REFUSED[0] as RefusedActor;
    for (const body of [
      // A status no hand-off takes.
      { id: s.id, to: f.value, status: 'nonsense', note: 'n' },
      // A move the ticket cannot make (todo to merged).
      { id: s.id, to: f.value, status: 'merged', note: 'n' },
      // A ticket that does not exist.
      { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', to: f.value, status: 'tests', note: 'n' },
      // A note that is secret-like itself.
      { id: s.id, to: f.value, status: 'tests', note: `key ${GITHUB_TOKEN}` },
    ]) {
      expectToRefusal(await post(s.server, 'handoff', body), f, s.output());
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });

  it('the browser has no override: allow-secret-like and as stay refused with usage, repeating nothing', async () => {
    const s = await writable();
    const before = eventFiles(s.eventsDir);
    for (const f of ACTORS_REFUSED) {
      for (const [body, property] of [
        [
          { id: s.id, to: f.value, status: 'tests', note: 'n', 'allow-secret-like': true },
          'allow-secret-like',
        ],
        [{ id: s.id, to: 'reviewer-1', status: 'tests', note: 'n', as: f.value }, 'as'],
      ] as const) {
        const result = await post(s.server, 'handoff', body);
        expectNoLeak(`${f.name} ${property}`, [result.body, headerText(result), s.output()], [f]);
        expect(refusal(result, 400, 1, 'usage').message).toContain(`the property ${property}`);
      }
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });

  it('runAction answers the same refusal without a server', () => {
    const { root, eventsDir, boardDir } = project();
    const id = newTicket(root);
    const board = open(boardDir);
    const before = eventFiles(eventsDir);
    for (const f of ACTORS_REFUSED) {
      const result = runAction(
        { board, actor: 'ben', root, env: cliEnv() },
        'handoff',
        JSON.stringify({ id, to: f.value, status: 'tests', note: 'n' }),
      );
      expect(result.status).toBe(400);
      const doc = result.body as {
        error: { exitCode: number; reason: string; message: string; hint: string | null };
      };
      expectNoLeak(f.name, [doc.error.message, doc.error.hint ?? ''], [f]);
      expect(doc.error).toMatchObject({ exitCode: 1, reason: 'invalid-actor' });
      expect(doc.error.message).toBe(actorMessage('the argument to', f));
      expectWebActorHint(doc.error.hint);
    }
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('the hint of a refused to names the web ways to pass a name, not the CLI or MCP ones', () => {
    const { root, boardDir } = project();
    const id = newTicket(root);
    const board = open(boardDir);
    const f = ACTORS_REFUSED[0] as RefusedActor;
    const result = runAction(
      { board, actor: 'ben', root, env: cliEnv() },
      'handoff',
      JSON.stringify({ id, to: f.value, status: 'tests', note: 'n' }),
    );
    const doc = result.body as { error: { hint: string | null } };
    expectWebActorHint(doc.error.hint);
  });

  it('the run context of an action gives its arguments as an MCP-shaped body (surface mcp)', () => {
    const { root, boardDir } = project();
    const board = open(boardDir);
    expect(actionContext({ board, actor: 'ben', root, env: cliEnv() }).surface).toBe('mcp');
  });
});

describe('to is checked before the status (review round 1)', () => {
  it('a refused to with a status no hand-off takes, for a ticket that does not exist: invalid-actor naming the argument to', async () => {
    const s = await writable();
    const before = eventFiles(s.eventsDir);
    for (const f of ACTORS_REFUSED) {
      const result = await post(s.server, 'handoff', {
        id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
        to: f.value,
        status: 'nonsense',
        note: 'n',
      });
      expectToRefusal(result, f, s.output());
    }
    expect(eventFiles(s.eventsDir)).toEqual(before);
  });
});

/** Does nothing listen on 127.0.0.1:`port`? */
async function portIsFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

describe('startServer refuses a server actor that fails the check (review round 1)', () => {
  it('a token or a name outside the form: BoardError(1, invalid-actor) naming --as, before listening, repeating nothing', async () => {
    const { root, boardDir, eventsDir } = project();
    const board = open(boardDir);
    const before = eventFiles(eventsDir);
    const cases = [
      ACTORS_REFUSED.find((r) => r.value === GITHUB_TOKEN),
      ACTORS_REFUSED.find((r) => r.name === 'space'),
      ...ACTORS_REFUSED,
    ] as RefusedActor[];
    for (const f of cases) {
      let output = '';
      const port = await freePort();
      let thrown: unknown = undefined;
      try {
        const server = await startServer(board, {
          actor: f.value,
          port,
          root,
          env: cliEnv(),
          stderr: (text) => {
            output += text;
          },
        });
        await server.close();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, f.name).toBeInstanceOf(Error);
      const error = thrown as { exitCode?: number; reason?: string; message: string };
      expect(error.exitCode, f.name).toBe(1);
      expect(error.reason, f.name).toBe('invalid-actor');
      expect(error.message).toBe(actorMessage('--as', f));
      expectNoLeak(f.name, [error.message, output], [f]);
      expect(await portIsFree(port), f.name).toBe(true);
    }
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('the empty actor keeps its usage refusal and an accepted name still starts', async () => {
    const { root, boardDir } = project();
    const board = open(boardDir);
    await expect(startServer(board, { actor: '', root, env: cliEnv() })).rejects.toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
    const server = await startServer(board, { actor: 'reviewer-3-2', root, env: cliEnv() });
    await server.close();
  });
});

describe('scenario: Hand-off to an existing actor style from the browser', () => {
  it('a hand-off of T1 to reviewer-3-2: 200 and T1 is assigned to reviewer-3-2', async () => {
    const s = await writable();
    const before = eventFiles(s.eventsDir);
    const result = await post(s.server, 'handoff', {
      id: s.id,
      to: 'reviewer-3-2',
      status: 'tests',
      note: 'n',
    });
    expect(result.status, result.body).toBe(200);
    expect(showTicket(s.root, s.id).assignee).toBe('reviewer-3-2');
    const written = newEvents(s.eventsDir, before);
    expect(written).toHaveLength(1);
    expect(written[0]?.event.actor).toBe('ben');
  });

  it('every accepted name (the fixture tables, every board actor, agentboard included) is a valid to', async () => {
    const s = await writable();
    // The first hand-off moves T1 to tests; the later ones only reassign.
    for (const name of ACTORS_ACCEPTED) {
      const result = await post(s.server, 'handoff', {
        id: s.id,
        to: name,
        status: 'tests',
        note: 'n',
      });
      expect(result.status, `${name}: ${result.body}`).toBe(200);
      expect(showTicket(s.root, s.id).assignee, name).toBe(name);
    }
  });
});

/** A running in-process `agentboard <argv>` with a stop signal. */
interface Running {
  stdout(): string;
  stderr(): string;
  stop(): void;
  readonly done: Promise<number>;
}

function start(argv: readonly string[], cwd: string, env: RunEnv = cliEnv()): Running {
  let stdout = '';
  let stderr = '';
  const controller = new AbortController();
  const io: AsyncCliIo = {
    argv,
    cwd,
    // CI keeps a plain serve from opening a browser.
    env: { ...env, CI: '1' },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stopSignal: () => controller.signal,
  };
  const done = runCliAsync(io).then((code) => Number(code));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      controller.abort();
    },
    done,
  };
}

describe('serve --as with an accepted name', () => {
  it('every accepted name but the reserved one starts a writable server as that actor', async () => {
    const { root } = project();
    for (const name of ACTORS_ACCEPTED.filter((n) => n !== 'agentboard')) {
      const running = start(['serve', '--as', name, '--port', '0', '--json', '--no-open'], root);
      await until(() => running.stdout().includes('\n'), 10_000, `the start-up line of ${name}`);
      const doc = JSON.parse(running.stdout().split('\n')[0] ?? '') as {
        writable: boolean;
        actor: string | null;
      };
      expect(doc, name).toMatchObject({ writable: true, actor: name });
      running.stop();
      expect(await running.done, name).toBe(0);
    }
  });

  it('serve --as agentboard keeps its reserved refusal (usage, not invalid-actor)', async () => {
    const { root } = project();
    const running = start(['serve', '--as', 'agentboard', '--port', '0', '--json'], root);
    expect(await running.done).toBe(1);
    const doc = JSON.parse(running.stdout().trim()) as { error: { reason: string } };
    expect(doc.error.reason).toBe('usage');
  });
});

describe('serve ignores AGENTBOARD_ACTOR and never repeats it', () => {
  it('a token in AGENTBOARD_ACTOR: read-only, actor null, and the token in no output or refusal', async () => {
    const { root } = project();
    const env = cliEnv({ AGENTBOARD_ACTOR: GITHUB_TOKEN });
    const f = ACTORS_REFUSED.find((r) => r.value === GITHUB_TOKEN) as RefusedActor;
    const running = start(['serve', '--port', '0', '--json', '--no-open'], root, env);
    await until(() => running.stdout().includes('\n'), 10_000, 'the start-up line');
    const doc = JSON.parse(running.stdout().split('\n')[0] ?? '') as {
      port: number;
      token: string;
      writable: boolean;
      actor: string | null;
    };
    expect(doc).toMatchObject({ writable: false, actor: null });
    const result = await post({ port: doc.port, token: doc.token }, 'handoff', {
      id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
      to: 'reviewer-1',
      status: 'tests',
      note: 'n',
    });
    refusal(result, 405, 1, 'read-only');
    running.stop();
    expect(await running.done).toBe(0);
    expectNoLeak(
      'serve',
      [running.stdout(), running.stderr(), result.body, headerText(result)],
      [f],
    );
  });
});
