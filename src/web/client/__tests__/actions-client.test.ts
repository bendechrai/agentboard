/**
 * The client of the write actions (board-web-actions: "Action endpoints",
 * "Cross-site request forgery protection"; add-board-web-actions design.md of add-board-web-actions:
 * "Status codes", "The page"): `postAction` sends a same-origin JSON `POST`
 * with the bearer header and nothing else, and turns every answer (a success,
 * an `ErrorDocument` refusal, a body that is not one, a network failure) into
 * an `ActionResult` without ever rejecting. No DOM is needed: these run in the
 * Node environment.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_NAMES,
  actionHeaders,
  actionPath,
  postAction,
  type ActionResult,
} from '../actions.js';
import { apiHeaders, type ClientDeps, type Connection, type ErrorDocument } from '../api.js';
import { E, FakeClock, T1, TOKEN, errorDoc, fakeDeps, FakeApi, model } from './client-helpers.js';

const TICKET = model([E.create(T1, { title: 'A' }, { wall: 1_000_000 })]).tickets[T1];
const HASH = 'b'.repeat(64);

interface Sent {
  input: string;
  init: RequestInit | undefined;
}

/** A connection whose `fetch` records the request and answers with `respond`. */
function conn(respond: () => Promise<Response>): { conn: Connection; sent: Sent[] } {
  const sent: Sent[] = [];
  const base = fakeDeps(new FakeApi(model([])), new FakeClock(0));
  const deps: ClientDeps = {
    ...base,
    fetch: (input, init) => {
      sent.push({ input, init });
      return respond();
    },
  };
  return { conn: { deps, token: TOKEN }, sent };
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  );
}

function refusalOf(result: ActionResult): { status: number; error: ErrorDocument } {
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return result;
}

describe('actionPath and actionHeaders', () => {
  it('names every action under /api/actions/', () => {
    expect(ACTION_NAMES.map((name) => actionPath(name))).toEqual([
      '/api/actions/claim',
      '/api/actions/release',
      '/api/actions/move',
      '/api/actions/comment',
      '/api/actions/handoff',
      '/api/actions/link',
      '/api/actions/checklist-tick',
      '/api/actions/checklist-untick',
      '/api/actions/close',
    ]);
  });

  it('adds only the JSON content type to the API headers', () => {
    expect(actionHeaders(TOKEN)).toEqual({
      ...apiHeaders(TOKEN),
      'Content-Type': 'application/json',
    });
    expect(Object.keys(actionHeaders(TOKEN)).sort()).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
    ]);
    expect(actionHeaders(TOKEN)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});

describe('postAction', () => {
  it('posts the JSON body with the bearer header and no other request option', async () => {
    const { conn: c, sent } = conn(() => jsonResponse(200, { hash: HASH, ticket: TICKET }));
    await postAction(c, 'handoff', { id: T1, to: 'impl-2', status: 'tests', note: 'n' });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.input).toBe('/api/actions/handoff');
    expect(request?.input).not.toContain(TOKEN);
    expect(Object.keys(request?.init ?? {}).sort()).toEqual(['body', 'headers', 'method']);
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.headers).toEqual(actionHeaders(TOKEN));
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      id: T1,
      to: 'impl-2',
      status: 'tests',
      note: 'n',
    });
  });

  it('posts a close with exactly the disposition given', async () => {
    const { conn: c, sent } = conn(() => jsonResponse(200, { hash: HASH, ticket: TICKET }));
    await postAction(c, 'close', { id: T1, 'no-decision': true });
    await postAction(c, 'close', { id: T1, 'decision-recorded-in': 'docs/adr/x.md' });
    expect(sent.map((s) => JSON.parse(String(s.init?.body)) as unknown)).toEqual([
      { id: T1, 'no-decision': true },
      { id: T1, 'decision-recorded-in': 'docs/adr/x.md' },
    ]);
  });

  it('resolves a success with its document', async () => {
    const doc = { hash: HASH, ticket: TICKET, reminder: { message: 'tick the task' } };
    const { conn: c } = conn(() => jsonResponse(200, doc));
    const result = await postAction(c, 'checklist-tick', { id: T1, index: 0 });
    expect(result).toEqual({ ok: true, status: 200, document: doc });
  });

  it('resolves a success with a null hash (nothing written)', async () => {
    const { conn: c } = conn(() => jsonResponse(200, { hash: null, ticket: TICKET }));
    expect(await postAction(c, 'claim', { id: T1 })).toEqual({
      ok: true,
      status: 200,
      document: { hash: null, ticket: TICKET },
    });
  });

  it.each([
    [
      409,
      errorDoc(
        'already-assigned',
        `ticket ${T1} is assigned to impl-1`,
        'agentboard inbox --as ben',
      ),
    ],
    [400, errorDoc('unpromoted-decision', 'open decision', 'agentboard close x')],
    [503, errorDoc('busy', 'the board is busy', null)],
    [401, errorDoc('unauthorized', 'missing or invalid access token')],
    [403, errorDoc('csrf-failed', 'csrf')],
    [405, errorDoc('read-only', 'read-only', 'agentboard serve --as <actor>')],
  ])('resolves a %i refusal with its error document', async (status, doc) => {
    const { conn: c } = conn(() => jsonResponse(status, doc));
    expect(await postAction(c, 'claim', { id: T1 })).toEqual({ ok: false, status, error: doc });
  });

  it('makes up a document for a refusal whose body is not one', async () => {
    const { conn: c } = conn(() => Promise.resolve(new Response('<html>', { status: 502 })));
    const { status, error } = refusalOf(await postAction(c, 'release', { id: T1 }));
    expect(status).toBe(502);
    expect(error.error.exitCode).toBe(1);
    expect(error.error.reason).toBeNull();
    expect(error.error.hint).toBeNull();
    expect(error.error.message).toContain('release');
    expect(error.error.message).toContain('502');
  });

  it('makes up a document for JSON that is not an error document', async () => {
    const { conn: c } = conn(() => jsonResponse(500, { oops: true }));
    const { status, error } = refusalOf(await postAction(c, 'move', { id: T1, status: 'tests' }));
    expect(status).toBe(500);
    expect(error.error).toMatchObject({ exitCode: 1, reason: null, hint: null });
    expect(error.error.message).toContain('move');
  });

  it('treats a 200 whose body is not JSON as a refusal', async () => {
    const { conn: c } = conn(() => Promise.resolve(new Response('not json', { status: 200 })));
    const { status, error } = refusalOf(await postAction(c, 'comment', { id: T1, text: 'x' }));
    expect(status).toBe(200);
    expect(error.error).toMatchObject({ exitCode: 1, reason: null, hint: null });
    expect(error.error.message).toContain('JSON');
  });

  it('resolves a network failure with status 0, never rejecting', async () => {
    const { conn: c } = conn(() => Promise.reject(new Error('connection refused')));
    const { status, error } = refusalOf(await postAction(c, 'link', { id: T1, pr: '42' }));
    expect(status).toBe(0);
    expect(error.error).toMatchObject({ exitCode: 1, reason: null, hint: null });
    expect(error.error.message).toContain('link');
    expect(error.error.message).toContain('connection refused');
  });
});
