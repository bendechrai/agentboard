/**
 * The write actions over HTTP, in process (board-web-actions: "Write mode
 * is opt-in with an explicit actor", "Action endpoints", "Close from the
 * browser", "Secret-like text is refused", "Cross-site request forgery
 * protection"; board-web: "Read-only server", "JSON API", as modified by
 * add-board-web-actions; add-board-web-actions tasks 1.1 to 1.3).
 *
 * Every server listens on 127.0.0.1 with port 0. Every refused request is
 * checked to leave the events directory exactly as it was.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderHint } from '../../guidance/hints.js';
import { VERSION } from '../../version.js';
import type { AppendMessage } from '../../view/types.js';
import { ACTION_NAMES } from '../actions.js';
import { API_HINT_CONTEXT } from '../api.js';
import {
  actionServer,
  cliOk,
  env,
  eventFiles,
  newEvents,
  newTicket,
  post,
  refusal,
  showTicket,
} from './action-helpers.js';
import {
  corsHeaders,
  expectSecurityHeaders,
  get,
  json,
  openStream,
  rawRequest,
  request,
  type HttpResult,
  type StreamClient,
} from './web-helpers.js';

/** The appends received by `client`. */
function appends(client: StreamClient): AppendMessage[] {
  return client
    .events()
    .filter((e) => e.event === 'append')
    .map((e) => JSON.parse(e.data) as AppendMessage);
}

/** Moves `id` to `merged` through the CLI as `orch`. */
function toMerged(root: string, id: string): void {
  for (const status of ['tests', 'implementing', 'review', 'merged']) {
    cliOk(root, ['move', id, status, '--as', 'orch']);
  }
}

/** Asserts the headers of every action response: security headers, JSON, no cookie, no CORS. */
function expectActionHeaders(result: HttpResult): void {
  expectSecurityHeaders(result.headers, true);
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(corsHeaders(result.headers)).toEqual([]);
  expect(Object.keys(result.headers).filter((name) => name.includes('csrf'))).toEqual([]);
}

describe('/api/session', () => {
  it('reports writable true and the actor of a server started with an actor, and no csrf field', async () => {
    const { server, boardDir } = await actionServer({ actor: 'ben' });
    const result = await get(server, '/api/session');
    expect(result.status).toBe(200);
    expect(result.headers['set-cookie']).toBeUndefined();
    const body = json(result) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['version', 'boardDir', 'writable', 'actor']);
    expect(body).toEqual({ version: VERSION, boardDir, writable: true, actor: 'ben' });
    expect(result.body.toLowerCase()).not.toContain('csrf');
    expect(result.body).not.toContain(server.token);
  });

  it('reports writable false and actor null for a read-only server, and no csrf field', async () => {
    for (const actor of [undefined, null]) {
      const { server, boardDir } = await actionServer(actor === undefined ? {} : { actor });
      const result = await get(server, '/api/session');
      const body = json(result) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['version', 'boardDir', 'writable', 'actor']);
      expect(body).toEqual({ version: VERSION, boardDir, writable: false, actor: null });
      expect(result.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses an empty actor before listening', async () => {
    await expect(actionServer({ actor: '' })).rejects.toMatchObject({
      exitCode: 1,
      reason: 'usage',
    });
  });
});

describe('scenario: Read-only server refuses actions (and Environment actor does not enable writes)', () => {
  it.each([...ACTION_NAMES])(
    'answers an authenticated same-origin POST /api/actions/%s with 405 read-only, and writes nothing',
    async (action) => {
      const { server, root, eventsDir } = await actionServer();
      const id = newTicket(root);
      const before = eventFiles(eventsDir);
      const result = await post(server, action, { id });
      const error = refusal(result, 405, 1, 'read-only');
      expect(error.hint).toBe(renderHint('read-only', API_HINT_CONTEXT));
      expect(error.hint).toContain("'agentboard serve --as <actor>'");
      expectActionHeaders(result);
      expect(eventFiles(eventsDir)).toEqual(before);
    },
  );

  it('checks the CSRF rules first: a form post to a read-only server is 403 csrf-failed', async () => {
    const { server, root, eventsDir } = await actionServer();
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    refusal(
      await post(server, 'comment', `id=${id}&text=hi`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      403,
      1,
      'csrf-failed',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });
});

describe('Action endpoints', () => {
  it('scenario: Claim from the browser', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'claim', { id: id.slice(0, 10) });
    expect(result.status, result.body).toBe(200);
    expectActionHeaders(result);
    const doc = json(result) as { hash: string; ticket: { id: string; assignee: string } };
    expect(doc.ticket).toMatchObject({ id, assignee: 'ben' });
    expect(newEvents(eventsDir, before).map((e) => [e.hash, e.event.kind, e.event.actor])).toEqual([
      [doc.hash, 'ticket.claim', 'ben'],
    ]);
    expect(showTicket(root, id).assignee).toBe('ben');
    expect(result.body).not.toContain(server.token);
  });

  it('scenario: Refusal with its hint', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    cliOk(root, ['claim', id, '--as', 'impl-1']);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'claim', { id });
    const error = refusal(result, 409, 4, 'already-assigned');
    expectActionHeaders(result);
    expect(error.message).toContain('impl-1');
    expect(error.hint).toBe(
      renderHint('already-assigned', { surface: 'cli', command: 'claim', id, actor: 'ben' }),
    );
    expect(error.hint).toContain('agentboard inbox --as ben');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('scenario: Invalid transition', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    refusal(await post(server, 'move', { id, status: 'merged' }), 409, 4, 'invalid-transition');
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).status).toBe('todo');
  });

  it('scenario: Actor cannot be chosen by the browser', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    refusal(await post(server, 'claim', { id, as: 'impl-1' }), 400, 1, 'usage');
    refusal(await post(server, 'move', { id, status: 'tests', as: 'ben' }), 400, 1, 'usage');
    refusal(await post(server, 'claim', { id, json: true }), 400, 1, 'usage');
    refusal(
      await post(server, 'comment', { id, text: 'hi', 'allow-secret-like': true }),
      400,
      1,
      'usage',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).assignee).toBeNull();
  });

  it('writes every event as the server actor, whatever AGENTBOARD_ACTOR says', async () => {
    const { server, root, eventsDir } = await actionServer({
      actor: 'ben',
      env: env({ AGENTBOARD_ACTOR: 'impl-9' }),
    });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    for (const [action, body] of [
      ['claim', { id }],
      ['move', { id, status: 'tests' }],
      ['comment', { id, text: 'from the page' }],
      ['checklist-tick', { id, index: 0 }],
      ['checklist-untick', { id, index: 0 }],
      ['link', { id, pr: '12' }],
      ['handoff', { id, to: 'impl-1', status: 'implementing', note: 'yours' }],
    ] as const) {
      const result = await post(server, action, body);
      expect(result.status, `${action}: ${result.body}`).toBe(200);
    }
    const written = newEvents(eventsDir, before);
    expect(written).toHaveLength(7);
    expect(new Set(written.map((e) => e.event.actor))).toEqual(new Set(['ben']));
    const ticket = showTicket(root, id);
    expect(ticket).toMatchObject({ status: 'implementing', assignee: 'impl-1' });
  });

  it.each([
    'new',
    'show',
    'list',
    'import-change',
    'close-merged',
    'sync',
    'rebuild',
    'init',
    'serve',
    'checklist_tick',
    'checklist%20tick',
    'Claim',
    'claim/extra',
    '',
  ])('answers POST /api/actions/%s with 404 not-found and writes nothing', async (action) => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(server, action, { id, title: 'x' });
    const error = refusal(result, 404, 1, 'not-found');
    expect(error.hint).toBe(renderHint('not-found', API_HINT_CONTEXT));
    expectActionHeaders(result);
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses a body that is not JSON with 400 usage', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    newTicket(root);
    const before = eventFiles(eventsDir);
    refusal(await post(server, 'comment', '{"id": '), 400, 1, 'usage');
    refusal(await post(server, 'comment', ''), 400, 1, 'usage');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('answers a GET of an action path with 405 and Allow: POST, and a POST elsewhere with Allow: GET', async () => {
    const { server, eventsDir } = await actionServer({ actor: 'ben' });
    const before = eventFiles(eventsDir);
    const getAction = await get(server, '/api/actions/comment');
    refusal(getAction, 405, 1, 'method-not-allowed');
    expect(getAction.headers.allow).toBe('POST');
    const postBoard = await request(server.port, '/api/board', {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    refusal(postBoard, 405, 1, 'method-not-allowed');
    expect(postBoard.headers.allow).toBe('GET');
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = await post(server, 'comment', {}, { method });
      refusal(result, 405, 1, 'method-not-allowed');
      expect(result.headers.allow).toBe('POST');
      expect(corsHeaders(result.headers)).toEqual([]);
    }
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('answers an unauthenticated preflight of an action with 401 and no CORS header', async () => {
    const { server } = await actionServer({ actor: 'ben' });
    const result = await request(server.port, '/api/actions/comment', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    refusal(result, 401, 1, 'unauthorized');
    expect(corsHeaders(result.headers)).toEqual([]);
  });
});

describe('Close from the browser', () => {
  it('scenario: Decision path relative to the tree root', async () => {
    const { server, root } = await actionServer({ actor: 'ben' });
    mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(root, 'docs', 'adr', '0006-web.md'), '# ADR\n');
    const id = newTicket(root);
    toMerged(root, id);
    const result = await post(server, 'close', {
      id,
      'decision-recorded-in': 'docs/adr/0006-web.md',
    });
    expect(result.status, result.body).toBe(200);
    const ticket = showTicket(root, id);
    expect(ticket.closed).toBe(true);
    expect(ticket.disposition).toEqual({ decision: 'docs/adr/0006-web.md' });
  });

  it('scenario: Unpromoted decision', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    cliOk(root, ['comment', id, 'DECISION: use sessions', '--as', 'impl-1']);
    toMerged(root, id);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'close', { id, 'no-decision': true });
    const error = refusal(result, 400, 1, 'unpromoted-decision');
    expect(error.message).toContain('DECISION: use sessions');
    expect(error.hint).toBe(
      renderHint('unpromoted-decision', { surface: 'cli', command: 'close', id, actor: 'ben' }),
    );
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).closed).toBe(false);
  });

  it('refuses a missing decision record, a path outside the tree, and no or two dispositions', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    toMerged(root, id);
    const before = eventFiles(eventsDir);
    refusal(
      await post(server, 'close', { id, 'decision-recorded-in': 'docs/adr/0099.md' }),
      400,
      1,
      'decision-path-missing',
    );
    refusal(
      await post(server, 'close', { id, 'decision-recorded-in': '../outside.md' }),
      400,
      1,
      'path-outside-tree',
    );
    refusal(await post(server, 'close', { id }), 400, 1, 'no-disposition');
    refusal(
      await post(server, 'close', {
        id,
        'decision-recorded-in': 'docs/adr/0099.md',
        'no-decision': true,
      }),
      400,
      1,
      'usage',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).closed).toBe(false);
  });
});

describe('Secret-like text is refused', () => {
  it('scenario: PEM header from the browser', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const pem = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const before = eventFiles(eventsDir);
    const result = await post(server, 'comment', { id, text: `oops ${pem} MIIEvQIBADAN` });
    const error = refusal(result, 400, 1, 'secret-like');
    expect(error.message).toContain('pem-private-key');
    expect(result.body).not.toContain('BEGIN');
    expect(result.body).not.toContain('MIIEvQIBADAN');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses a secret in a hand-off note, and offers no override', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const key = ['AKIA', 'Z7EXAMPLEFAKE234'].join('');
    const before = eventFiles(eventsDir);
    const result = await post(server, 'handoff', {
      id,
      to: 'impl-1',
      status: 'tests',
      note: `use ${key}`,
    });
    const error = refusal(result, 400, 1, 'secret-like');
    expect(error.message).toContain('aws-access-key-id');
    expect(result.body).not.toContain(key);
    refusal(
      await post(server, 'handoff', {
        id,
        to: 'impl-1',
        status: 'tests',
        note: `use ${key}`,
        'allow-secret-like': true,
      }),
      400,
      1,
      'usage',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });
});

describe('a write through the server reaches an open stream', () => {
  it(
    'delivers a comment posted to the server as an append within 3 seconds',
    { timeout: 30_000 },
    async () => {
      const { server, root } = await actionServer({ actor: 'ben' });
      const id = newTicket(root);
      const client = await openStream(server);
      await client.until((c) => appends(c).length > 0, 5000, 'the first event');
      const result = await post(server, 'comment', { id, text: 'written by the page' });
      expect(result.status, result.body).toBe(200);
      const written = Date.now();
      const { hash } = json(result) as { hash: string };
      await client.until(
        (c) => appends(c).some((m) => m.events.some((e) => e.hash === hash)),
        3000,
        'the comment',
      );
      expect(Date.now() - written).toBeLessThan(3000);
      const append = appends(client).find((m) => m.events.some((e) => e.hash === hash));
      expect(append?.events.map((e) => [e.kind, e.actor])).toEqual([['ticket.comment', 'ben']]);
    },
  );
});

describe('Cross-site request forgery protection', () => {
  it('scenario: Cross-site post with the token', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'forged' },
      { headers: { Origin: 'https://attacker.example' } },
    );
    refusal(result, 403, 1, 'csrf-failed');
    expectActionHeaders(result);
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('scenario: Cross-site form post without the token (the token in a cookie is ignored)', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'comment', `id=${id}&text=forged`, {
      headers: {
        Authorization: null,
        Cookie: `agentboard-${String(server.port)}=${server.token}; token=${server.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://attacker.example',
      },
    });
    refusal(result, 401, 1, 'unauthorized');
    expectActionHeaders(result);
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses a same-origin JSON post carrying the token only in a cookie with 401', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'cookie only' },
      {
        headers: {
          Authorization: null,
          Cookie: `agentboard-${String(server.port)}=${server.token}`,
        },
      },
    );
    refusal(result, 401, 1, 'unauthorized');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses the token in a query parameter with 401', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await request(server.port, `/api/actions/comment?token=${server.token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${String(server.port)}`,
      },
      body: JSON.stringify({ id, text: 'query token' }),
    });
    refusal(result, 401, 1, 'unauthorized');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses a rebinding Host before anything else, with 403 forbidden-host', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'rebound' },
      {
        host: `attacker.example:${String(server.port)}`,
        headers: { Origin: `http://attacker.example:${String(server.port)}` },
      },
    );
    refusal(result, 403, 1, 'forbidden-host');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it.each([
    [
      'application/x-www-form-urlencoded (scenario: Form encoding refused)',
      'application/x-www-form-urlencoded',
    ],
    ['multipart/form-data', 'multipart/form-data; boundary=x'],
    ['text/plain', 'text/plain'],
    ['text/plain with a charset', 'text/plain; charset=utf-8'],
    ['application/json with another parameter', 'application/json; boundary=x'],
    ['a JSON-like type', 'application/json-patch+json'],
  ])('refuses %s from the same origin with 403 csrf-failed', async (_what, contentType) => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'typed' },
      { headers: { 'Content-Type': contentType } },
    );
    const error = refusal(result, 403, 1, 'csrf-failed');
    expect(error.hint).toBe(renderHint('csrf-failed', API_HINT_CONTEXT));
    expectActionHeaders(result);
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses a request without a Content-Type with 403 csrf-failed', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    refusal(
      await post(server, 'comment', { id, text: 'untyped' }, { headers: { 'Content-Type': null } }),
      403,
      1,
      'csrf-failed',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it.each([
    ['another port on 127.0.0.1', (port: number) => `http://127.0.0.1:${String(port + 1)}`],
    ['another port on localhost', (port: number) => `http://localhost:${String(port + 1)}`],
    ['a null origin', () => 'null'],
    ['localhost while the Host is 127.0.0.1', (port: number) => `http://localhost:${String(port)}`],
    ['https on the same address', (port: number) => `https://127.0.0.1:${String(port)}`],
    ['a trailing slash', (port: number) => `http://127.0.0.1:${String(port)}/`],
    ['another site', () => 'https://attacker.example'],
  ])('refuses an Origin of %s with 403 csrf-failed', async (_what, origin) => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'cross' },
      { headers: { Origin: origin(server.port) } },
    );
    refusal(result, 403, 1, 'csrf-failed');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses an Origin of 127.0.0.1 while the Host is localhost', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    refusal(
      await post(
        server,
        'comment',
        { id, text: 'cross' },
        {
          host: `localhost:${String(server.port)}`,
        },
      ),
      403,
      1,
      'csrf-failed',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('accepts the localhost origin with the localhost Host, and a charset parameter', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'from localhost' },
      {
        host: `localhost:${String(server.port)}`,
        headers: {
          Origin: `http://localhost:${String(server.port)}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    );
    expect(result.status, result.body).toBe(200);
    expect(newEvents(eventsDir, before)).toHaveLength(1);
  });

  it('refuses two Origin headers, the first one allowed, with 403 csrf-failed', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const body = JSON.stringify({ id, text: 'two origins' });
    const port = String(server.port);
    const raw = await rawRequest(
      server.port,
      [
        'POST /api/actions/comment HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Authorization: Bearer ${server.token}`,
        'Content-Type: application/json',
        `Origin: http://127.0.0.1:${port}`,
        'Origin: https://attacker.example',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
    expect(raw.status).toBe(403);
    expect((JSON.parse(raw.body) as { error: { reason: string } }).error.reason).toBe(
      'csrf-failed',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('scenario: Script without Origin', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const result = await post(
      server,
      'comment',
      { id, text: 'from a script' },
      { headers: { Origin: null } },
    );
    expect(result.status, result.body).toBe(200);
    expectActionHeaders(result);
    const written = newEvents(eventsDir, before);
    expect(written.map((e) => [e.event.kind, e.event.actor, e.event.body])).toEqual([
      ['ticket.comment', 'ben', { text: 'from a script' }],
    ]);
    expect(showTicket(root, id).comments.map((c) => c.text)).toEqual(['from a script']);
  });

  it('scenario: Body too large (65 KiB, with a Content-Length)', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const body = JSON.stringify({ id, text: 'x '.repeat(65 * 512) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(65 * 1024);
    const result = await post(server, 'comment', body);
    const error = refusal(result, 413, 1, 'body-too-large');
    expect(error.hint).toBe(renderHint('body-too-large', API_HINT_CONTEXT));
    expectActionHeaders(result);
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('refuses a chunked body over 64 KiB with 413 body-too-large', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const body = JSON.stringify({ id, text: 'y'.repeat(70_000) });
    const result = await post(server, 'comment', body, {
      headers: { 'Transfer-Encoding': 'chunked' },
    });
    refusal(result, 413, 1, 'body-too-large');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('accepts a body of exactly 64 KiB, and refuses one byte more', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const sized = (bytes: number): string => {
      const empty = JSON.stringify({ id, text: '' });
      return JSON.stringify({ id, text: 'z'.repeat(bytes - Buffer.byteLength(empty)) });
    };
    expect(Buffer.byteLength(sized(65536))).toBe(65536);
    const before = eventFiles(eventsDir);
    refusal(await post(server, 'comment', sized(65537)), 413, 1, 'body-too-large');
    expect(eventFiles(eventsDir)).toEqual(before);
    const accepted = await post(server, 'comment', sized(65536));
    expect(accepted.status, accepted.body.slice(0, 500)).toBe(200);
    expect(newEvents(eventsDir, before)).toHaveLength(1);
  });

  it('checks the content type and the Origin before the body size', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const big = JSON.stringify({ id, text: 'x'.repeat(70_000) });
    refusal(
      await post(server, 'comment', big, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      403,
      1,
      'csrf-failed',
    );
    refusal(
      await post(server, 'comment', big, { headers: { Origin: 'https://attacker.example' } }),
      403,
      1,
      'csrf-failed',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('checks the CSRF rules before the action name', async () => {
    const { server, eventsDir } = await actionServer({ actor: 'ben' });
    const before = eventFiles(eventsDir);
    refusal(
      await post(
        server,
        'new',
        { title: 'x' },
        { headers: { Origin: 'https://attacker.example' } },
      ),
      403,
      1,
      'csrf-failed',
    );
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('keeps serving after a refused oversized body', async () => {
    const { server, root } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    expect(await sendOversized(server.port, server.token, 1024 * 1024)).toBe(413);
    const result = await post(server, 'comment', { id, text: 'still here' });
    expect(result.status, result.body).toBe(200);
  });

  it('sends no Set-Cookie and no CSRF header on any action response', async () => {
    const { server, root } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const results = [
      await post(server, 'claim', { id }),
      await post(server, 'claim', { id, as: 'x' }),
      await post(server, 'nope', {}),
      await post(server, 'comment', {}, { headers: { Origin: 'null' } }),
      await post(server, 'comment', {}, { headers: { Authorization: null } }),
      await post(server, 'comment', JSON.stringify({ id, text: 'x'.repeat(70_000) })),
      await get(server, '/api/session'),
      await get(server, '/api/actions/claim'),
    ];
    for (const result of results) {
      expect(result.headers['set-cookie']).toBeUndefined();
      expect(Object.keys(result.headers).filter((name) => name.includes('csrf'))).toEqual([]);
      expect(result.body).not.toContain(server.token);
    }
  });
});

describe('no cookie and no CSRF token anywhere (add-board-web-actions task 1.1)', () => {
  it('sends no Set-Cookie and no csrf header or field on any route of a writable server', async () => {
    const { server, root } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const auth = { Authorization: `Bearer ${server.token}` };
    const results: [string, HttpResult][] = [];
    for (const path of [
      '/',
      '/app.js',
      '/app.css',
      '/nope.js',
      '/api/session',
      '/api/board',
      `/api/tickets/${id}`,
      '/api/tickets/01ZZZZZZZZZZZZZZZZZZZZZZZZ',
      '/api/events',
      '/api/events?after=nope',
      '/api/actors',
      '/api/nope',
    ]) {
      results.push([`GET ${path}`, await request(server.port, path, { headers: auth })]);
    }
    results.push(['GET /api/board without a token', await request(server.port, '/api/board')]);
    results.push([
      'GET /api/board with a foreign Host',
      await request(server.port, '/api/board', { headers: auth, host: 'attacker.example' }),
    ]);
    results.push([
      'POST /api/board',
      await request(server.port, '/api/board', { method: 'POST', headers: auth }),
    ]);
    results.push(['POST comment', await post(server, 'comment', { id, text: 'cookie-free' })]);
    const stream = await openStream(server);
    for (const [what, result] of results) {
      expect(result.headers['set-cookie'], what).toBeUndefined();
      expect(
        Object.keys(result.headers).filter((name) => name.toLowerCase().includes('csrf')),
        what,
      ).toEqual([]);
      expect(result.body.toLowerCase(), what).not.toContain('csrf');
    }
    expect(stream.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(stream.headers).filter((name) => name.includes('csrf'))).toEqual([]);
  });
});

/**
 * Posts a same-origin, authenticated action whose declared and sent body
 * is `size` bytes, writing it in pieces and ignoring a reset once the
 * response has arrived; resolves with the status.
 */
function sendOversized(port: number, token: string, size: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let data = '';
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0);
        if (status === 0) {
          reject(new Error(`no response: ${data}`));
        } else {
          resolve(status);
        }
      }
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        done();
      }
    });
    socket.on('close', done);
    socket.on('error', done);
    socket.write(
      [
        'POST /api/actions/comment HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        `Origin: http://127.0.0.1:${String(port)}`,
        `Content-Length: ${String(size)}`,
        '',
        '',
      ].join('\r\n'),
    );
    const piece = 'a'.repeat(16 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (sent < size && !socket.destroyed) {
        sent += piece.length;
        if (!socket.write(piece)) {
          socket.once('drain', pump);
          return;
        }
      }
    };
    pump();
  });
}
