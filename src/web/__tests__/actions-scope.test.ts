/**
 * The scope disposition through the write actions (board-web-actions: "Action
 * controls in the web app", scenarios "Merge an ad hoc ticket from the
 * browser" and "Missing disposition from the browser"; "Secret-like text is
 * refused", scenario "Secret-like unplanned reason from the browser"; ADR
 * 0013; ADR 0009): `task` and `unplanned` posted to `/api/actions/move` and
 * `/api/actions/close` of a writable server over HTTP with the per-run
 * token, the two events written in order as the server's actor, the CLI's
 * refusals (`needs-scope-disposition`, `already-linked`, `secret-like`,
 * `usage`) with the hint rendered for the server's actor, no override from
 * the browser, nothing written on a refusal, and the event bodies
 * byte-identical to the CLI's for the same arguments.
 *
 * Every server listens on 127.0.0.1 with port 0.
 */

import { describe, expect, it } from 'vitest';

import { run } from '../../cli/__tests__/cli-helpers.js';
import type { Ticket } from '../../events/fold.js';
import { renderHint, type HintContext } from '../../guidance/hints.js';
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
  type DecodedEvent,
} from './action-helpers.js';
import { json } from './web-helpers.js';

/** The hint context the server renders a refusal of `command` with, for `id`. */
function cliContext(command: string, id: string): HintContext {
  return { surface: 'cli', command, actor: 'ben', id };
}

/** Creates an ad hoc ticket through the CLI as `orch`; returns its id. */
function newAdhoc(root: string, title = 'Hotfix one', reason = 'found in prod'): string {
  const doc = cliOk(root, ['new', title, '--adhoc', reason, '--as', 'orch']) as {
    ticket: { id: string };
  };
  return doc.ticket.id;
}

/** Moves `id` from `todo` to `review` through the CLI as `impl-1`. */
function toReview(root: string, id: string): void {
  for (const status of ['tests', 'implementing', 'review']) {
    cliOk(root, ['move', id, status, '--as', 'impl-1']);
  }
}

/** Blocks `id` from `todo` through the CLI as `impl-1`. */
function toBlocked(root: string, id: string): void {
  cliOk(root, ['move', id, 'blocked', '--as', 'impl-1']);
}

/** The events of `eventsDir` beyond `before`, in timestamp order (wall, then counter). */
function written(eventsDir: string, before: readonly string[]): DecodedEvent[] {
  return newEvents(eventsDir, before).sort(
    (a, b) => a.event.ts.wall - b.event.ts.wall || a.event.ts.counter - b.event.ts.counter,
  );
}

/** The lines of `agentboard show <id>` as the CLI prints them. */
function showLines(root: string, id: string): string[] {
  const out = run(['show', id], root, env());
  expect(out.code, out.stderr).toBe(0);
  return out.stdout.split('\n');
}

/** The document of a successful write: `hash`, `events` and the ticket. */
interface WriteDocument {
  hash: string | null;
  events: string[];
  ticket: Ticket;
}

const PEM = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

describe('scenario: Merge an ad hoc ticket from the browser', () => {
  it('posts status merged with the unplanned reason, is answered 200, and show has the line unplanned: hotfix (by ben)', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    expect(showTicket(root, id)).toMatchObject({ status: 'review', task: null, unplanned: null });
    const before = eventFiles(eventsDir);

    const result = await post(server, 'move', { id, status: 'merged', unplanned: 'hotfix' });
    expect(result.status, result.body).toBe(200);
    const doc = json(result) as WriteDocument;
    expect(doc.ticket).toMatchObject({
      id,
      status: 'merged',
      adhoc: 'found in prod',
      task: null,
      unplanned: { reason: 'hotfix', actor: 'ben' },
    });

    // The disposition, then the move, both as the server's actor.
    const events = written(eventsDir, before);
    expect(events.map((e) => e.event.kind)).toEqual(['ticket.unplanned', 'ticket.move']);
    expect(events.map((e) => e.event.actor)).toEqual(['ben', 'ben']);
    expect(events.map((e) => e.event.ticket)).toEqual([id, id]);
    expect(events[0]?.event.body).toEqual({ reason: 'hotfix' });
    expect(events[1]?.event.body).toEqual({ to: 'merged' });
    expect(doc.events).toEqual(events.map((e) => e.hash));
    expect(doc.hash).toBe(events[1]?.hash);

    expect(showLines(root, id)).toContain('unplanned: hotfix (by ben)');
    expect(showTicket(root, id)).toMatchObject({ status: 'merged', unplanned: { reason: 'hotfix' } });
  });

  it('links a task reference from the browser instead, writing ticket.link then the move', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    const before = eventFiles(eventsDir);
    const task = 'openspec:add-board-web-actions#2';

    const result = await post(server, 'move', { id, status: 'merged', task });
    expect(result.status, result.body).toBe(200);
    const doc = json(result) as WriteDocument;
    expect(doc.ticket).toMatchObject({
      status: 'merged',
      adhoc: null,
      unplanned: null,
      task: { source: 'openspec', ref: 'add-board-web-actions', item: '2' },
    });
    const events = written(eventsDir, before);
    expect(events.map((e) => e.event.kind)).toEqual(['ticket.link', 'ticket.move']);
    expect(events[0]?.event.body).toEqual({
      task: { source: 'openspec', ref: 'add-board-web-actions', item: '2' },
    });
    expect(showLines(root, id).some((line) => line.startsWith('unplanned:'))).toBe(false);
  });

  it('writes event bodies byte-identical to the CLI for the same arguments', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const fromPage = newAdhoc(root, 'From the page');
    const fromCli = newAdhoc(root, 'From the CLI');
    toReview(root, fromPage);
    toReview(root, fromCli);
    const before = eventFiles(eventsDir);

    const result = await post(server, 'move', {
      id: fromPage,
      status: 'merged',
      unplanned: 'production hotfix',
    });
    expect(result.status, result.body).toBe(200);
    const page = written(eventsDir, before);
    const afterPage = eventFiles(eventsDir);
    cliOk(root, ['move', fromCli, 'merged', '--unplanned', 'production hotfix', '--as', 'ben'], env());
    const cli = written(eventsDir, afterPage);

    expect(page).toHaveLength(2);
    expect(cli).toHaveLength(2);
    for (let i = 0; i < 2; i += 1) {
      expect(page[i]?.event.kind).toBe(cli[i]?.event.kind);
      expect(page[i]?.event.actor).toBe(cli[i]?.event.actor);
      expect(page[i]?.bodyBytes.equals(cli[i]?.bodyBytes ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it('a ticket disposed earlier needs nothing more from the browser', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    cliOk(root, ['link', id, '--task', 'openspec:add-board-web-actions#3', '--as', 'orch']);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'move', { id, status: 'merged' });
    expect(result.status, result.body).toBe(200);
    const events = written(eventsDir, before);
    expect(events.map((e) => e.event.kind)).toEqual(['ticket.move']);
  });
});

describe('scenario: Missing disposition from the browser', () => {
  it('is 409 needs-scope-disposition with the hint for the server actor, and writes nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    const before = eventFiles(eventsDir);

    const result = await post(server, 'move', { id, status: 'merged' });
    const error = refusal(result, 409, 4, 'needs-scope-disposition');
    expect(error.hint).toBe(renderHint('needs-scope-disposition', cliContext('move', id)));
    expect(error.hint).toContain('--as ben');
    expect(error.hint).toContain('--unplanned');
    expect(error.hint).toContain('--task');
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id)).toMatchObject({ status: 'review', unplanned: null });
  });

  it('is 409 already-linked for an unplanned reason on a linked ticket, and writes nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    toReview(root, id);
    const before = eventFiles(eventsDir);

    const result = await post(server, 'move', { id, status: 'merged', unplanned: 'hotfix' });
    const error = refusal(result, 409, 4, 'already-linked');
    expect(error.hint).toBe(renderHint('already-linked', cliContext('move', id)));
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).status).toBe('review');
  });

  it('is 400 usage for a disposition with a target other than merged, or for both dispositions, and writes nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    const before = eventFiles(eventsDir);

    refusal(await post(server, 'move', { id, status: 'tests', unplanned: 'hotfix' }), 400, 1, 'usage');
    expect(showTicket(root, id).status).toBe('todo');
    toReview(root, id);
    const inReview = eventFiles(eventsDir);
    refusal(
      await post(server, 'move', {
        id,
        status: 'merged',
        task: 'openspec:add-board-web-actions#2',
        unplanned: 'hotfix',
      }),
      400,
      1,
      'usage',
    );
    refusal(await post(server, 'move', { id, status: 'merged', unplanned: '' }), 400, 1, 'usage');
    refusal(
      await post(server, 'move', { id, status: 'merged', task: 'not a ref' }),
      400,
      1,
      'malformed-task-ref',
    );
    expect(eventFiles(eventsDir)).toEqual(inReview);
    expect(inReview.length).toBe(before.length + 3);
    expect(showTicket(root, id)).toMatchObject({ status: 'review', unplanned: null });
  });

  it('the fold order holds over HTTP: invalid-transition before needs-scope-disposition', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    const before = eventFiles(eventsDir);
    refusal(await post(server, 'move', { id, status: 'merged' }), 409, 4, 'invalid-transition');
    expect(eventFiles(eventsDir)).toEqual(before);
  });
});

describe('scenario: Secret-like unplanned reason from the browser', () => {
  it('is 400 secret-like naming pem-private-key, never echoes the text, and writes nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    const before = eventFiles(eventsDir);

    const result = await post(server, 'move', { id, status: 'merged', unplanned: PEM });
    const error = refusal(result, 400, 1, 'secret-like');
    expect(error.message).toContain('pem-private-key');
    expect(result.body).not.toContain('BEGIN');
    expect(result.body).not.toContain('PRIVATE');
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id)).toMatchObject({ status: 'review', unplanned: null });
  });

  it('offers no override: allow-secret-like is 400 usage on move and on close, and writes nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    const before = eventFiles(eventsDir);
    for (const value of [true, false]) {
      const result = await post(server, 'move', {
        id,
        status: 'merged',
        unplanned: PEM,
        'allow-secret-like': value,
      });
      const error = refusal(result, 400, 1, 'usage');
      expect(error.message).toContain('allow-secret-like');
      expect(result.body).not.toContain('BEGIN');
    }
    const blocked = newAdhoc(root, 'Blocked one', 'spike');
    toBlocked(root, blocked);
    const afterBlock = eventFiles(eventsDir);
    refusal(
      await post(server, 'close', {
        id: blocked,
        'no-decision': true,
        unplanned: 'fine',
        'allow-secret-like': true,
      }),
      400,
      1,
      'usage',
    );
    expect(eventFiles(eventsDir)).toEqual(afterBlock);
    expect(afterBlock.length).toBe(before.length + 2);
    expect(showTicket(root, id).status).toBe('review');
    expect(showTicket(root, blocked).closed).toBe(false);
  });

  it('refuses an AWS key id in a close reason the same way', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root, 'Blocked one', 'spike');
    toBlocked(root, id);
    const key = ['AKIA', 'Z7EXAMPLEFAKE234'].join('');
    const before = eventFiles(eventsDir);
    const result = await post(server, 'close', {
      id,
      'no-decision': true,
      unplanned: `abandoned, see ${key}`,
    });
    const error = refusal(result, 400, 1, 'secret-like');
    expect(error.message).toContain('aws-access-key-id');
    expect(result.body).not.toContain(key);
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).closed).toBe(false);
  });
});

describe('close with a scope disposition from the browser', () => {
  it('closes a blocked ad hoc ticket with no-decision and an unplanned reason, writing the disposition then the close', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root, 'Spike', 'try the parser');
    toBlocked(root, id);
    const before = eventFiles(eventsDir);

    const result = await post(server, 'close', {
      id,
      'no-decision': true,
      unplanned: 'abandoned: superseded',
    });
    expect(result.status, result.body).toBe(200);
    const doc = json(result) as WriteDocument;
    expect(doc.ticket).toMatchObject({
      closed: true,
      status: 'blocked',
      unplanned: { reason: 'abandoned: superseded', actor: 'ben' },
    });
    const events = written(eventsDir, before);
    expect(events.map((e) => e.event.kind)).toEqual(['ticket.unplanned', 'ticket.close']);
    expect(events.map((e) => e.event.actor)).toEqual(['ben', 'ben']);
    expect(events[0]?.event.body).toEqual({ reason: 'abandoned: superseded' });
    expect(events[1]?.event.body).toEqual({ noDecision: true });
    expect(doc.events).toEqual(events.map((e) => e.hash));
    expect(showLines(root, id)).toContain('unplanned: abandoned: superseded (by ben)');
  });

  it('is 409 needs-scope-disposition without one, with the close hint for the server actor, and writes nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root, 'Spike', 'try the parser');
    toBlocked(root, id);
    const before = eventFiles(eventsDir);

    const result = await post(server, 'close', { id, 'no-decision': true });
    const error = refusal(result, 409, 4, 'needs-scope-disposition');
    expect(error.hint).toBe(renderHint('needs-scope-disposition', cliContext('close', id)));
    expect(error.hint).toContain('--as ben');
    expect(eventFiles(eventsDir)).toEqual(before);
    expect(showTicket(root, id).closed).toBe(false);
  });

  it('is 409 already-linked for an unplanned reason on a linked ticket, before the decision guard', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    cliOk(root, ['comment', id, 'DECISION: keep sqlite', '--as', 'orch']);
    toBlocked(root, id);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'close', { id, 'no-decision': true, unplanned: 'x' });
    refusal(result, 409, 4, 'already-linked');
    expect(eventFiles(eventsDir)).toEqual(before);
  });

  it('a merged ticket disposed from the browser closes without a disposition', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newAdhoc(root);
    toReview(root, id);
    expect((await post(server, 'move', { id, status: 'merged', unplanned: 'hotfix' })).status).toBe(200);
    const before = eventFiles(eventsDir);
    const result = await post(server, 'close', { id, 'no-decision': true });
    expect(result.status, result.body).toBe(200);
    expect(written(eventsDir, before).map((e) => e.event.kind)).toEqual(['ticket.close']);
    expect(showTicket(root, id)).toMatchObject({ closed: true, unplanned: { reason: 'hotfix' } });
  });
});

describe('a read-only server', () => {
  it('refuses a move with a disposition 405 read-only before looking at the body', async () => {
    const { server, root, eventsDir } = await actionServer();
    const id = newAdhoc(root);
    toReview(root, id);
    const before = eventFiles(eventsDir);
    refusal(await post(server, 'move', { id, status: 'merged', unplanned: 'hotfix' }), 405, 1, 'read-only');
    expect(eventFiles(eventsDir)).toEqual(before);
  });
});
