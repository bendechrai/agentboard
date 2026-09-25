/**
 * The write actions in process, without HTTP (board-web-actions: "Write
 * mode is opt-in with an explicit actor", "Action endpoints", "Close from
 * the browser", "Secret-like text is refused", "Cross-site request forgery
 * protection"; add-board-web-actions tasks 1.2 and 1.3): the action names
 * and their registry commands, the content type and `Origin` rules, the
 * status mapping, the argument conversion (the MCP `toolArguments`, plus
 * the refused `as`, `json` and `allow-secret-like`), the working tree root,
 * the run context, and `runAction` on a real board, including `busy`.
 *
 * Over HTTP the same behaviours are in actions-http.test.ts; the event
 * parity with the CLI is in actions-parity.test.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMANDS, findCommand } from '../../cli/registry.js';
import { renderHint, type HintContext } from '../../guidance/hints.js';
import { toolArguments } from '../../mcp/tools.js';
import { BoardError } from '../../store/errors.js';
import { gitRepo } from '../../store/__tests__/helpers.js';
import {
  ACTION_BODY_LIMIT,
  ACTION_NAMES,
  REFUSED_PROPERTIES,
  actionArguments,
  actionCommand,
  actionContext,
  actionRoot,
  actionStatus,
  contentTypeAllowed,
  csrfRefusal,
  originAllowed,
  runAction,
  type ActionContext,
} from '../actions.js';
import { API_HINT_CONTEXT, type ApiResult } from '../api.js';
import type { RequestHead } from '../security.js';
import { cliOk, env, eventFiles, newEvents, newTicket, showTicket } from './action-helpers.js';
import { open, project, scratch } from './web-helpers.js';

const PORT = 4477;
const HOST = `127.0.0.1:${String(PORT)}`;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const LOCAL_ORIGIN = `http://localhost:${String(PORT)}`;

/** The registry name of an action (`checklist-tick` is `checklist tick`). */
function commandName(action: string): string {
  return action.replace('-', ' ');
}

/** The registry command of an action name, which must exist. */
function commandOf(action: string): NonNullable<ReturnType<typeof findCommand>> {
  const command = findCommand(commandName(action));
  if (command === undefined) {
    throw new Error(`no command ${action}`);
  }
  return command;
}

/** What a thrown BoardError looks like, or the thrown value itself. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof BoardError) {
      return { exitCode: error.exitCode, reason: error.reason, message: error.message };
    }
    return error;
  }
  return 'did not throw';
}

describe('ACTION_NAMES and actionCommand', () => {
  it('are the nine actions of the spec, each the registry command of the same name', () => {
    expect([...ACTION_NAMES].sort()).toEqual(
      [
        'comment',
        'move',
        'claim',
        'release',
        'handoff',
        'checklist-tick',
        'checklist-untick',
        'link',
        'close',
      ].sort(),
    );
    for (const action of ACTION_NAMES) {
      const command = actionCommand(action);
      expect(command, action).toBe(findCommand(commandName(action)));
      expect(command?.writes, action).toBe(true);
    }
  });

  it('lists the actions in registry order', () => {
    const order = COMMANDS.map((c) => c.name);
    const indexes = ACTION_NAMES.map((action) => order.indexOf(commandName(action)));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it.each([
    'new',
    'show',
    'list',
    'inbox',
    'watch',
    'serve',
    'top',
    'health',
    'rebuild',
    'sync',
    'import-change',
    'close-merged',
    'mcp',
    'init',
    'version',
    'help',
    'checklist tick',
    'checklist_tick',
    'checklist',
    'checklist-',
    'Claim',
    'claim ',
    ' claim',
    '',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ])('has no command for %j', (name) => {
    expect(actionCommand(name)).toBeUndefined();
  });

  it('refuses as, json and allow-secret-like', () => {
    expect([...REFUSED_PROPERTIES].sort()).toEqual(['allow-secret-like', 'as', 'json']);
  });

  it('limits a body to 64 KiB', () => {
    expect(ACTION_BODY_LIMIT).toBe(64 * 1024);
  });
});

describe('contentTypeAllowed', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=utf-8',
    'application/json; charset=UTF-8',
    'application/json ; charset=utf-8',
    'Application/JSON',
    'application/json; Charset=utf-8',
    'application/json; charset=Utf-8',
    'application/json; charset="utf-8"',
    'application/json; charset="UTF-8"',
  ])('accepts %j', (value) => {
    expect(contentTypeAllowed(value)).toBe(true);
    expect(contentTypeAllowed([value])).toBe(true);
  });

  it.each([
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
    'text/plain; charset=utf-8',
    'application/jsonx',
    'application/json-patch+json',
    'application/ld+json',
    'application/json; boundary=x',
    'application/json; charset=utf-8; boundary=x',
    'application/json; charset=utf-8; charset=utf-8',
    'application/json; charset=utf-16',
    'application/json; charset=UTF-16LE',
    'application/json; charset="utf-16"',
    'application/json; charset=iso-8859-1',
    'application/json; charset=us-ascii',
    'application/json; charset=utf8',
    'application/json; charset=utf-8x',
    'application/json; charset=',
    'json',
    'application/',
    '',
  ])('refuses %j', (value) => {
    expect(contentTypeAllowed(value)).toBe(false);
    expect(contentTypeAllowed([value])).toBe(false);
  });

  it('refuses no header and two headers, even two JSON ones', () => {
    expect(contentTypeAllowed(undefined)).toBe(false);
    expect(contentTypeAllowed([])).toBe(false);
    expect(contentTypeAllowed(['application/json', 'application/json'])).toBe(false);
    expect(contentTypeAllowed(['application/json', 'text/plain'])).toBe(false);
    expect(contentTypeAllowed(['text/plain', 'application/json'])).toBe(false);
  });
});

describe('originAllowed', () => {
  it('scenario: Script without Origin: no Origin header is accepted', () => {
    expect(originAllowed(undefined, HOST, PORT)).toBe(true);
    expect(originAllowed([], [HOST], PORT)).toBe(true);
  });

  it('accepts the origin naming the same host as Host', () => {
    expect(originAllowed(ORIGIN, HOST, PORT)).toBe(true);
    expect(originAllowed([ORIGIN], [HOST], PORT)).toBe(true);
    expect(originAllowed(LOCAL_ORIGIN, `localhost:${String(PORT)}`, PORT)).toBe(true);
    expect(originAllowed([LOCAL_ORIGIN], [`localhost:${String(PORT)}`], PORT)).toBe(true);
  });

  it('refuses a mismatch between Origin and Host', () => {
    expect(originAllowed(LOCAL_ORIGIN, HOST, PORT)).toBe(false);
    expect(originAllowed(ORIGIN, `localhost:${String(PORT)}`, PORT)).toBe(false);
  });

  it.each([
    ['another site', 'https://attacker.example'],
    ['another site on the port', `http://attacker.example:${String(PORT)}`],
    ['another port on 127.0.0.1', `http://127.0.0.1:${String(PORT + 1)}`],
    ['another port on localhost', `http://localhost:${String(PORT + 1)}`],
    ['no port', 'http://127.0.0.1'],
    ['https', `https://127.0.0.1:${String(PORT)}`],
    ['null', 'null'],
    ['empty', ''],
    ['a trailing slash', `${ORIGIN}/`],
    ['a path', `${ORIGIN}/api`],
    ['upper case', `HTTP://127.0.0.1:${String(PORT)}`],
    ['127.0.0.2', `http://127.0.0.2:${String(PORT)}`],
    ['::1', `http://[::1]:${String(PORT)}`],
    ['surrounding space', ` ${ORIGIN}`],
    ['a trailing dot', `http://localhost.:${String(PORT)}`],
  ])('refuses %s', (_what, origin) => {
    expect(originAllowed(origin, HOST, PORT)).toBe(false);
    expect(originAllowed([origin], [HOST], PORT)).toBe(false);
  });

  it('refuses two Origin headers, whichever comes first, even equal ones', () => {
    expect(originAllowed([ORIGIN, 'https://attacker.example'], [HOST], PORT)).toBe(false);
    expect(originAllowed(['https://attacker.example', ORIGIN], [HOST], PORT)).toBe(false);
    expect(originAllowed([ORIGIN, ORIGIN], [HOST], PORT)).toBe(false);
  });

  it('refuses an allowed origin when the Host is missing or repeated', () => {
    expect(originAllowed(ORIGIN, undefined, PORT)).toBe(false);
    expect(originAllowed([ORIGIN], [HOST, HOST], PORT)).toBe(false);
  });
});

/** A request head as the server passes it. */
function head(headers: Record<string, string | string[]>, method = 'POST'): RequestHead {
  const distinct: Record<string, string[]> = { host: [HOST] };
  const single: Record<string, string> = { host: HOST };
  for (const [name, value] of Object.entries(headers)) {
    distinct[name] = Array.isArray(value) ? value : [value];
    single[name] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return { method, url: '/api/actions/comment', headers: single, headersDistinct: distinct };
}

const TOKEN = 'A'.repeat(43);
const BEARER = { authorization: `Bearer ${TOKEN}` };
const JSON_TYPE = { 'content-type': 'application/json' };

describe('csrfRefusal', () => {
  it('passes a same-origin JSON request and a JSON request without Origin', () => {
    expect(csrfRefusal(head({ ...BEARER, ...JSON_TYPE, origin: ORIGIN }), PORT)).toBeNull();
    expect(csrfRefusal(head({ ...BEARER, ...JSON_TYPE }), PORT)).toBeNull();
    expect(
      csrfRefusal(
        head({ ...BEARER, 'content-type': 'application/json; charset=utf-8', origin: ORIGIN }),
        PORT,
      ),
    ).toBeNull();
  });

  it.each([
    ['form encoding', { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }],
    ['multipart', { 'content-type': 'multipart/form-data; boundary=x', origin: ORIGIN }],
    ['text/plain', { 'content-type': 'text/plain', origin: ORIGIN }],
    ['no content type', { origin: ORIGIN }],
    ['no content type and no Origin', {}],
    ['a cross-site Origin', { ...JSON_TYPE, origin: 'https://attacker.example' }],
    ['another port', { ...JSON_TYPE, origin: `http://127.0.0.1:${String(PORT + 1)}` }],
    ['a null Origin', { ...JSON_TYPE, origin: 'null' }],
    ['Origin and Host differing', { ...JSON_TYPE, origin: LOCAL_ORIGIN }],
    ['two Origin headers', { ...JSON_TYPE, origin: [ORIGIN, 'https://attacker.example'] }],
    [
      'two Content-Type headers',
      { 'content-type': ['application/json', 'text/plain'], origin: ORIGIN },
    ],
  ])('refuses %s with csrf-failed (exit 1)', (_what, headers) => {
    const error = csrfRefusal(head({ ...BEARER, ...headers }), PORT);
    expect(error).toBeInstanceOf(BoardError);
    expect({ exitCode: error?.exitCode, reason: error?.reason }).toEqual({
      exitCode: 1,
      reason: 'csrf-failed',
    });
    expect(error?.message).not.toContain('attacker.example');
    expect(error?.message).not.toContain(TOKEN);
  });

  it('counts a head without headersDistinct as having no content type', () => {
    const bare: RequestHead = {
      method: 'POST',
      url: '/api/actions/comment',
      headers: { host: HOST, 'content-type': 'application/json' },
    };
    expect(csrfRefusal(bare, PORT)?.reason).toBe('csrf-failed');
  });

  it('needs no CSRF token or custom header, and a cookie does not help or hurt', () => {
    const cookie = { cookie: `agentboard-${String(PORT)}=${TOKEN}` };
    expect(csrfRefusal(head({ ...JSON_TYPE, origin: ORIGIN, ...cookie }), PORT)).toBeNull();
    expect(
      csrfRefusal(
        head({ 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...cookie }),
        PORT,
      )?.reason,
    ).toBe('csrf-failed');
  });
});

describe('actionStatus', () => {
  it.each([
    [new BoardError(1, 'usage', 'x'), 400],
    [new BoardError(1, 'secret-like', 'x'), 400],
    [new BoardError(1, 'unpromoted-decision', 'x'), 400],
    [new BoardError(1, 'id-too-short', 'x'), 400],
    [new BoardError(4, 'already-assigned', 'x'), 409],
    [new BoardError(4, 'invalid-transition', 'x'), 409],
    [new BoardError(4, 'unknown-ticket', 'x'), 409],
    [new BoardError(4, 'not-assignee', 'x'), 409],
    [new BoardError(5, 'busy', 'x'), 503],
    [new BoardError(5, 'integrity', 'x'), 500],
    [new BoardError(2, 'board-not-found', 'x'), 500],
    [new BoardError(3, 'sync-conflict', 'x'), 500],
    [new Error('boom'), 500],
    ['a string', 500],
    [undefined, 500],
  ])('maps %s to %i', (error, status) => {
    expect(actionStatus(error)).toBe(status);
  });
});

/** A body for each action that `toolArguments` accepts. */
const VALID_BODIES: readonly [string, Record<string, unknown>][] = [
  ['claim', { id: '01J9K3AB' }],
  ['release', { id: '01J9K3AB' }],
  ['move', { id: '01J9K3AB', status: 'tests' }],
  ['move', { id: '01J9K3AB' }],
  ['comment', { id: '01J9K3AB', text: '--not a flag' }],
  ['handoff', { id: '01J9K3AB', to: 'impl-1', status: 'tests', note: 'over to you' }],
  ['link', { id: '01J9K3AB', pr: '42' }],
  ['link', { id: '01J9K3AB', decision: 'docs/adr/0001.md' }],
  ['link', { id: '01J9K3AB', change: 'add-x', group: '2' }],
  ['link', { id: '01J9K3AB', task: 'openspec:add-x#2' }],
  ['checklist-tick', { id: '01J9K3AB', index: 1 }],
  ['checklist-untick', { id: '01J9K3AB', index: 0 }],
  ['close', { id: '01J9K3AB', 'no-decision': true }],
  ['close', { id: '01J9K3AB', 'decision-recorded-in': 'docs/adr/0001.md' }],
];

/** Bodies `toolArguments` refuses, with the refusal the action must give too. */
const INVALID_BODIES: readonly [string, unknown][] = [
  ['claim', {}],
  ['claim', { id: 5 }],
  ['claim', { id: '01J9K3AB', extra: 'x' }],
  ['claim', []],
  ['claim', 'text'],
  ['claim', 7],
  ['claim', null],
  ['move', { status: 'tests' }],
  ['comment', { id: '01J9K3AB' }],
  ['handoff', { id: '01J9K3AB', to: 'impl-1' }],
  ['checklist-tick', { id: '01J9K3AB', index: '1' }],
  ['checklist-tick', { id: '01J9K3AB', index: 1.5 }],
  ['close', { id: '01J9K3AB' }],
  ['close', { id: '01J9K3AB', 'no-decision': false }],
  ['close', { id: '01J9K3AB', 'decision-recorded-in': 'docs/x.md', 'no-decision': true }],
  ['link', { id: '01J9K3AB' }],
  ['link', { id: '01J9K3AB', pr: '1', decision: 'docs/x.md' }],
  ['link', { id: '01J9K3AB', change: 'add-x' }],
];

describe('actionArguments', () => {
  it.each(VALID_BODIES)('%s %j: exactly what toolArguments gives', (action, body) => {
    const command = commandOf(action);
    expect(actionArguments(command, body)).toEqual(toolArguments(command, body));
  });

  it.each(INVALID_BODIES)('%s %j: the same refusal as toolArguments', (action, body) => {
    const command = commandOf(action);
    const expected = thrown(() => toolArguments(command, body));
    expect(expected).toMatchObject({ exitCode: 1 });
    expect(thrown(() => actionArguments(command, body))).toEqual(expected);
  });

  it('refuses no-disposition with the close rule, as the CLI does', () => {
    expect(thrown(() => actionArguments(commandOf('close'), { id: '01J9K3AB' }))).toMatchObject({
      exitCode: 1,
      reason: 'no-disposition',
    });
  });

  it.each([
    ['claim', { id: '01J9K3AB', as: 'impl-1' }, 'as'],
    ['claim', { id: '01J9K3AB', as: 'ben' }, 'as'],
    ['claim', { id: '01J9K3AB', as: '' }, 'as'],
    ['move', { id: '01J9K3AB', status: 'tests', as: 'impl-1' }, 'as'],
    ['claim', { id: '01J9K3AB', json: true }, 'json'],
    ['claim', { id: '01J9K3AB', json: false }, 'json'],
    ['comment', { id: '01J9K3AB', text: 'hi', 'allow-secret-like': true }, 'allow-secret-like'],
    ['comment', { id: '01J9K3AB', text: 'hi', 'allow-secret-like': false }, 'allow-secret-like'],
    [
      'handoff',
      { id: '01J9K3AB', to: 'x', status: 'tests', note: 'n', 'allow-secret-like': true },
      'allow-secret-like',
    ],
  ])('%s %j: refused with usage naming %s', (action, body, property) => {
    const refused = thrown(() => actionArguments(commandOf(action), body)) as {
      exitCode: number;
      reason: string;
      message: string;
    };
    expect(refused).toMatchObject({ exitCode: 1, reason: 'usage' });
    expect(refused.message).toContain(property);
  });
});

describe('actionRoot', () => {
  it('is the git working tree root for a directory inside it', { timeout: 20_000 }, () => {
    const root = gitRepo(join(scratch(), 'repo'));
    const src = join(root, 'src', 'deep');
    mkdirSync(src, { recursive: true });
    expect(actionRoot(src, env())).toBe(root);
    expect(actionRoot(root, env())).toBe(root);
  });

  it('is the directory itself outside git', { timeout: 20_000 }, () => {
    const dir = join(scratch(), 'plain', 'src');
    mkdirSync(dir, { recursive: true });
    expect(actionRoot(dir, env())).toBe(dir);
  });
});

/** A board with a server-side action context (`actor` null: read-only). */
function context(actor: string | null, extra: Partial<ActionContext> = {}) {
  const dirs = project();
  const board = open(dirs.boardDir);
  const ctx: ActionContext = { board, actor, root: dirs.root, env: env(), ...extra };
  return { ctx, ...dirs };
}

/** `runAction` with a JSON body. */
function act(ctx: ActionContext, action: string, body: unknown): ApiResult {
  return runAction(ctx, action, typeof body === 'string' ? body : JSON.stringify(body));
}

interface ErrorBody {
  error: { exitCode: number; reason: string | null; message: string; hint: string | null };
}

/** Asserts a refusal result and returns its error. */
function refusedWith(
  result: ApiResult,
  status: number,
  exitCode: number,
  reason: string,
): ErrorBody['error'] {
  expect(result.status).toBe(status);
  const body = result.body as ErrorBody;
  expect(body.error.exitCode).toBe(exitCode);
  expect(body.error.reason).toBe(reason);
  return body.error;
}

/** The CLI hint context of a refused action by the server's actor `ben`. */
function cliContext(command: string, id?: string): HintContext {
  return { surface: 'cli', command, actor: 'ben', ...(id === undefined ? {} : { id }) };
}

describe('actionContext', () => {
  it('runs on the server board as the server actor, with the tree root as cwd', () => {
    const { ctx, root } = context('ben', { env: env({ AGENTBOARD_ACTOR: 'impl-1' }) });
    const run = actionContext(ctx);
    expect(run.cwd).toBe(root);
    expect(run.actor).toBe('ben');
    expect(run.env).toBe(ctx.env);
    expect(run.boardDir()).toBe(ctx.board.dir);
    expect(run.board()).toBe(ctx.board);
    expect(run.board({ catchUp: false })).toBe(ctx.board);
  });
});

describe('runAction on a read-only server', () => {
  it.each([...ACTION_NAMES, 'new', 'nope'])(
    '%s is 405 read-only with a hint naming agentboard serve --as <actor>, and writes nothing',
    (action) => {
      const { ctx, root, eventsDir } = context(null);
      const id = newTicket(root);
      const before = eventFiles(eventsDir);
      const error = refusedWith(act(ctx, action, { id }), 405, 1, 'read-only');
      expect(error.hint).toBe(renderHint('read-only', API_HINT_CONTEXT));
      expect(error.hint).toContain("'agentboard serve --as <actor>'");
      expect(error.message).toContain('--as');
      expect(eventFiles(eventsDir)).toEqual(before);
    },
  );
});

describe('runAction on a writable server', () => {
  it('claims as the server actor, ignoring AGENTBOARD_ACTOR in its env', () => {
    const { ctx, root, eventsDir } = context('ben', {
      env: env({ AGENTBOARD_ACTOR: 'impl-1' }),
    });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = act(ctx, 'claim', { id: id.slice(0, 10) });
    expect(result.status).toBe(200);
    const doc = result.body as { hash: string; ticket: { id: string; assignee: string } };
    expect(doc.ticket.assignee).toBe('ben');
    const written = newEvents(eventsDir, before);
    expect(written.map((e) => [e.hash, e.event.kind, e.event.actor, e.event.ts.actor])).toEqual([
      [doc.hash, 'ticket.claim', 'ben', 'ben'],
    ]);
    expect(showTicket(root, id).assignee).toBe('ben');
  });

  it('answers a claim by the holder with 200, hash null and no event', () => {
    const { ctx, root, eventsDir } = context('ben');
    const id = newTicket(root);
    expect(act(ctx, 'claim', { id }).status).toBe(200);
    const before = eventFiles(eventsDir);
    const again = act(ctx, 'claim', { id });
    expect(again.status).toBe(200);
    expect((again.body as { hash: unknown }).hash).toBeNull();
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('is 404 not-found for any other action name, with the serve hint', () => {
    const { ctx, root, eventsDir } = context('ben');
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    for (const action of ['new', 'show', 'checklist tick', 'Claim', '', 'import-change']) {
      const error = refusedWith(act(ctx, action, { id }), 404, 1, 'not-found');
      expect(error.hint).toBe(renderHint('not-found', API_HINT_CONTEXT));
    }
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it.each(['', '{', 'not json', '{"id": }', '{"id": "x"} trailing'])(
    'refuses the body %j, which is not JSON, with 400 usage',
    (text) => {
      const { ctx, eventsDir } = context('ben');
      const before = eventFiles(eventsDir);
      const error = refusedWith(runAction(ctx, 'claim', text), 400, 1, 'usage');
      expect(error.hint).toBe(renderHint('usage', cliContext('claim')));
      expect(eventFiles(eventsDir)).toEqual(before);
    },
  );

  it.each(['[]', '[{"id":"x"}]', '"text"', '7', 'null', 'true'])(
    'refuses the JSON body %s, which is not one object, with 400 usage',
    (text) => {
      const { ctx, eventsDir } = context('ben');
      const before = eventFiles(eventsDir);
      const error = refusedWith(runAction(ctx, 'claim', text), 400, 1, 'usage');
      expect(error.message).toBe('the request body must be one JSON object');
      expect(eventFiles(eventsDir)).toEqual(before);
    },
  );

  it('scenario: Actor cannot be chosen by the browser', () => {
    const { ctx, root, eventsDir } = context('ben');
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    for (const as of ['impl-1', 'ben', '']) {
      const error = refusedWith(act(ctx, 'claim', { id, as }), 400, 1, 'usage');
      expect(error.message).toContain('as');
      expect(error.hint).toBe(renderHint('usage', cliContext('claim', id)));
    }
    refusedWith(act(ctx, 'claim', { id, json: true }), 400, 1, 'usage');
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).assignee).toBeNull();
  });

  it('scenario: Refusal with its hint (already-assigned, 409, hint for the server actor)', () => {
    const { ctx, root, eventsDir } = context('ben');
    const id = newTicket(root);
    cliOk(root, ['claim', id, '--as', 'impl-1']);
    const before = eventFiles(eventsDir);
    const prefix = id.slice(0, 12);
    const error = refusedWith(act(ctx, 'claim', { id: prefix }), 409, 4, 'already-assigned');
    expect(error.message).toContain('impl-1');
    expect(error.hint).toBe(renderHint('already-assigned', cliContext('claim', prefix)));
    expect(error.hint).toContain("'agentboard inbox --as ben'");
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it.each([
    [
      'invalid-transition',
      (id: string) => ['move', { id, status: 'merged' }] as const,
      409,
      4,
      'invalid-transition',
    ],
    [
      'unknown ticket',
      () => ['comment', { id: '01CAAAAAAAAAAAAAAAAAAAAAAA', text: 'hi' }] as const,
      409,
      4,
      'unknown-ticket',
    ],
    ['short id', () => ['claim', { id: '01J' }] as const, 400, 1, 'id-too-short'],
    ['not the assignee', (id: string) => ['release', { id }] as const, 409, 4, 'not-assignee'],
    [
      'checklist index',
      (id: string) => ['checklist-tick', { id, index: 9 }] as const,
      409,
      4,
      'checklist-index',
    ],
    [
      'close from todo',
      (id: string) => ['close', { id, 'no-decision': true }] as const,
      409,
      4,
      'invalid-transition',
    ],
    ['no disposition', (id: string) => ['close', { id }] as const, 400, 1, 'no-disposition'],
  ])(
    '%s: refused with its status and CLI hint, writing nothing',
    (_what, make, status, exit, reason) => {
      const { ctx, root, eventsDir } = context('ben');
      const id = newTicket(root);
      const [action, body] = make(id);
      const before = eventFiles(eventsDir);
      const error = refusedWith(act(ctx, action, body), status, exit, reason);
      expect(error.hint).toBe(
        renderHint(reason, cliContext(commandName(action), (body as { id: string }).id)),
      );
      expect(eventFiles(eventsDir)).toEqual(before);
    },
  );

  it('scenario: PEM header from the browser (comment and hand-off note)', () => {
    const { ctx, root, eventsDir } = context('ben');
    const id = newTicket(root);
    cliOk(root, ['claim', id, '--as', 'ben']);
    const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const before = eventFiles(eventsDir);
    for (const [action, body] of [
      ['comment', { id, text: `here it is ${pem} MIIEvQ` }],
      ['handoff', { id, to: 'impl-1', status: 'tests', note: `key ${pem}` }],
    ] as const) {
      const result = act(ctx, action, body);
      const error = refusedWith(result, 400, 1, 'secret-like');
      expect(error.message).toContain('pem-private-key');
      expect(JSON.stringify(result.body)).not.toContain('BEGIN');
      expect(JSON.stringify(result.body)).not.toContain('MIIEvQ');
    }
    // No override from the browser.
    refusedWith(act(ctx, 'comment', { id, text: pem, 'allow-secret-like': true }), 400, 1, 'usage');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('answers a checklist tick with the document the CLI prints, reminder included', () => {
    const { ctx, root } = context('ben');
    const id = newTicket(root);
    const result = act(ctx, 'checklist-tick', { id, index: 1 });
    expect(result.status).toBe(200);
    const doc = result.body as {
      hash: string;
      ticket: { checklist: { done: boolean }[] };
      reminder: unknown;
    };
    expect(doc.ticket.checklist.map((item) => item.done)).toEqual([false, true]);
    expect(Object.keys(doc)).toContain('reminder');
  });

  it(
    'closes with a decision path relative to the tree root, not to the start directory',
    { timeout: 20_000 },
    () => {
      const root = gitRepo(join(scratch(), 'repo'));
      const boardDir = join(root, '.board');
      mkdirSync(join(boardDir, 'events'), { recursive: true });
      mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      const id = newTicket(root);
      cliOk(root, ['move', id, 'blocked', '--as', 'orch']);
      writeFileSync(join(root, 'docs', 'adr', '0006-web.md'), '# ADR\n');
      const board = open(boardDir);
      const ctx: ActionContext = {
        board,
        actor: 'ben',
        root: actionRoot(join(root, 'src'), env()),
        env: env(),
      };
      const result = act(ctx, 'close', { id, 'decision-recorded-in': 'docs/adr/0006-web.md' });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const ticket = showTicket(root, id);
      expect(ticket.closed).toBe(true);
      expect(ticket.disposition).toEqual({ decision: 'docs/adr/0006-web.md' });
    },
  );

  it('is 503 busy when the cache stays locked, and writes nothing', { timeout: 40_000 }, () => {
    const { ctx, root, boardDir, eventsDir } = context('ben');
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const holder = new DatabaseSync(join(boardDir, 'cache.sqlite'));
    try {
      holder.exec('BEGIN IMMEDIATE');
      const error = refusedWith(act(ctx, 'comment', { id, text: 'hi' }), 503, 5, 'busy');
      expect(error.hint).toBe(renderHint('busy', cliContext('comment', id)));
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    expect(eventFiles(eventsDir)).toEqual(before);
  });
});
