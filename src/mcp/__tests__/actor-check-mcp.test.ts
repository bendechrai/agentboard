/**
 * The actor check over MCP (actor-secret-check task 1.3; board-cli
 * "Actor names are checked", scenarios "MCP server started with a token"
 * and "Token as the actor over MCP"; board-agent-guidance "Hint for a
 * refused actor"). Every call goes over a real stdio client to the built
 * server (`node dist/cli.js mcp`). Each refusal is checked for exit code
 * 1, reason `invalid-actor`, the exact message naming the MCP source, the
 * MCP form of the hint, no event written, and the refused name absent
 * from the whole tool result (text and structured content) and from the
 * server's stderr.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  boardProject,
  cliEnv,
  oneDocument,
  runCliAsync,
  type RunEnv,
} from '../../__tests__/harness/processes.js';
import {
  ACTORS_REFUSED,
  actorMessage,
  expectNoLeak,
  type RefusedActor,
  type SecretFixture,
} from '../../__tests__/harness/secret-fixtures.js';
import { expectActorRefusal } from '../../cli/__tests__/actor-check-helpers.js';
import { allNames } from '../../store/__tests__/helpers.js';
import { mcpChild, type McpChild } from './mcp-helpers.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface ToolError {
  exitCode: number;
  reason: string | null;
  message: string;
  hint: string | null;
}

interface CallResult {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/** The refused name of `name` in the actor tables. */
function refused(name: string): RefusedActor {
  const found = ACTORS_REFUSED.find((f) => f.name === name);
  if (found === undefined) {
    throw new Error(`no refused actor named ${name}`);
  }
  return found;
}

/** A board with one ticket created by `orch`, and its project root. */
async function boardWithTicket(): Promise<{ root: string; eventsDir: string; id: string }> {
  const project = boardProject();
  const root = realpathSync(project.root);
  const out = await runCliAsync(
    ['new', 'Actor check', '--task', 'openspec:actor-check#1', '--as', 'orch', '--json'],
    root,
  );
  expect(out.code, out.stderr).toBe(0);
  const id = (oneDocument(out) as { ticket: { id: string } }).ticket.id;
  return { root, eventsDir: project.eventsDir, id };
}

interface Served {
  root: string;
  eventsDir: string;
  id: string;
  child: McpChild;
}

/** A served board with one ticket; the server gets `env` and `args`. */
async function served(env: RunEnv = cliEnv(), args: readonly string[] = []): Promise<Served> {
  const b = await boardWithTicket();
  const child = await mcpChild(b.root, env, args);
  return { ...b, child };
}

/** Calls a tool and returns its raw result. */
async function call(s: Served, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await s.child.client.callTool({ name, arguments: args })) as CallResult;
}

/**
 * Checks the MCP hint of an `invalid-actor` refusal: one line with the
 * placeholder `<actor>` and the word `form`; for a refused actor it names
 * the `as` argument and `agentboard mcp --as <actor>`, for a refused `to`
 * the `to` argument; never `AGENTBOARD_ACTOR` advice to set it (a tool
 * caller cannot), so the hint does not say `set AGENTBOARD_ACTOR`.
 */
function expectMcpActorHint(hint: string | null, kind: 'actor' | 'to'): void {
  expect(hint).not.toBeNull();
  const text = hint ?? '';
  expect(text).not.toContain('\n');
  expect(text).toContain('<actor>');
  expect(text).toContain('form');
  if (kind === 'actor') {
    expect(text).toContain('as argument');
    expect(text).toContain('agentboard mcp --as <actor>');
  } else {
    expect(text).toContain('to argument');
  }
  expect(text).not.toContain('set AGENTBOARD_ACTOR');
}

/**
 * Calls `name` with `args`, expects the `invalid-actor` tool error with
 * exactly `message`, checks that no fixture leaked into the result or the
 * server's stderr and that no event was written. Returns the error.
 */
async function expectInvalidActor(
  s: Served,
  name: string,
  args: Record<string, unknown>,
  message: string,
  fixtures: readonly SecretFixture[],
  kind: 'actor' | 'to' = 'actor',
): Promise<ToolError> {
  const before = allNames(s.eventsDir);
  const result = await call(s, name, args);
  expectNoLeak(`${name} result`, [result], fixtures);
  expectNoLeak(`${name} server stderr`, [s.child.stderr()], fixtures);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  const error = result.structuredContent as unknown as ToolError;
  expect({ exitCode: error.exitCode, reason: error.reason, message: error.message }).toEqual({
    exitCode: 1,
    reason: 'invalid-actor',
    message,
  });
  expect(result.content).toEqual([
    {
      type: 'text',
      text: error.hint === null ? error.message : `${error.message}\nhint: ${error.hint}`,
    },
  ]);
  expectMcpActorHint(error.hint, kind);
  expect(allNames(s.eventsDir)).toEqual(before);
  return error;
}

/** Calls `name` and expects success; returns the structured content. */
async function expectOk(
  s: Served,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await call(s, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent ?? {};
}

/** The `actor` of the event file `hash`. */
function eventActor(eventsDir: string, hash: unknown): string {
  expect(typeof hash).toBe('string');
  const event = JSON.parse(readFileSync(join(eventsDir, `${String(hash)}.json`), 'utf8')) as {
    actor: string;
  };
  return event.actor;
}

describe('scenario: MCP server started with a token', () => {
  it('agentboard mcp --as <token> exits 1 invalid-actor without serving, plain and --json', async () => {
    const b = await boardWithTicket();
    for (const f of [
      refused('github-token'),
      refused('aws-key-id'),
      refused('hex-40'),
      refused('space'),
    ]) {
      expectActorRefusal(['mcp', '--as', f.value], b.root, actorMessage('--as', f), [f], {
        runner: 'child',
      });
    }
  });

  it('a server whose AGENTBOARD_ACTOR is a token still starts (the variable is checked per call)', async () => {
    const f = refused('github-token');
    const s = await served(cliEnv({ AGENTBOARD_ACTOR: f.value }));
    await expectOk(s, 'board_show', { id: s.id });
    expectNoLeak('server stderr', [s.child.stderr()], [f]);
  });
});

describe('scenario: Token as the actor over MCP', () => {
  it('board_comment with as set to each refused name: the argument as', async () => {
    const s = await served();
    for (const f of ACTORS_REFUSED) {
      await expectInvalidActor(
        s,
        'board_comment',
        { id: s.id, text: 'hi', as: f.value },
        actorMessage('the argument as', f),
        [f],
      );
      await expectInvalidActor(
        s,
        'board_comment',
        { id: s.id, text: 'hi', as: f.value, 'allow-secret-like': true },
        actorMessage('the argument as', f),
        [f],
      );
    }
  });

  it('board_claim with no as on a server whose AGENTBOARD_ACTOR is a token: AGENTBOARD_ACTOR', async () => {
    for (const f of [
      refused('github-token'),
      refused('aws-key-id'),
      refused('hex-40'),
      refused('space'),
    ]) {
      const s = await served(cliEnv({ AGENTBOARD_ACTOR: f.value }));
      await expectInvalidActor(
        s,
        'board_claim',
        { id: s.id },
        actorMessage('AGENTBOARD_ACTOR', f),
        [f],
      );
      await expectInvalidActor(s, 'board_inbox', {}, actorMessage('AGENTBOARD_ACTOR', f), [f]);
    }
  });

  it('board_handoff with to set to a token and a valid as: the argument to, the ticket unchanged', async () => {
    const s = await served();
    const before = await expectOk(s, 'board_show', { id: s.id });
    for (const f of ACTORS_REFUSED) {
      await expectInvalidActor(
        s,
        'board_handoff',
        { id: s.id, to: f.value, status: 'review', note: 'n', as: 'impl-1' },
        actorMessage('the argument to', f),
        [f],
        'to',
      );
    }
    expect(await expectOk(s, 'board_show', { id: s.id })).toEqual(before);
  });

  it('with both as and to refused, the actor is refused first (the argument as)', async () => {
    const s = await served();
    const as = refused('aws-key-id');
    const to = refused('github-token');
    await expectInvalidActor(
      s,
      'board_handoff',
      { id: s.id, to: to.value, status: 'todo', note: 'n', as: as.value },
      actorMessage('the argument as', as),
      [as, to],
    );
  });

  it('read tools refuse a refused as too (board_show, board_list)', async () => {
    const s = await served();
    for (const f of [refused('github-token'), refused('hex-40'), refused('space')]) {
      await expectInvalidActor(
        s,
        'board_show',
        { id: s.id, as: f.value },
        actorMessage('the argument as', f),
        [f],
      );
      await expectInvalidActor(
        s,
        'board_list',
        { as: f.value },
        actorMessage('the argument as', f),
        [f],
      );
    }
  });

  it('a valid call after a refused one on the same server succeeds and records its actor', async () => {
    const s = await served();
    const f = refused('github-token');
    await expectInvalidActor(
      s,
      'board_comment',
      { id: s.id, text: 'hi', as: f.value },
      actorMessage('the argument as', f),
      [f],
    );
    const ok = await expectOk(s, 'board_comment', { id: s.id, text: 'hi', as: 'impl-1' });
    expect(eventActor(s.eventsDir, ok.hash)).toBe('impl-1');
    expectNoLeak('server stderr', [s.child.stderr()], [f]);
  });
});

describe('fallbacks that are not used are not checked', () => {
  it('a call with a valid as on a server whose AGENTBOARD_ACTOR is a token records the as', async () => {
    const f = refused('github-token');
    const s = await served(cliEnv({ AGENTBOARD_ACTOR: f.value }));
    const ok = await expectOk(s, 'board_comment', { id: s.id, text: 'hi', as: 'ben@laptop' });
    expect(eventActor(s.eventsDir, ok.hash)).toBe('ben@laptop');
  });

  it('the server --as takes precedence over a token AGENTBOARD_ACTOR', async () => {
    const f = refused('github-token');
    const s = await served(cliEnv({ AGENTBOARD_ACTOR: f.value }), ['--as', 'orch']);
    const ok = await expectOk(s, 'board_comment', { id: s.id, text: 'hi' });
    expect(eventActor(s.eventsDir, ok.hash)).toBe('orch');
    expectNoLeak('server stderr', [s.child.stderr()], [f]);
  });

  it('a read tool with no as ignores a token AGENTBOARD_ACTOR, even when it fails', async () => {
    const f = refused('github-token');
    const s = await served(cliEnv({ AGENTBOARD_ACTOR: f.value }));
    await expectOk(s, 'board_list', {});
    const result = await call(s, 'board_show', { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as unknown as ToolError).reason).toBe('unknown-ticket');
    expectNoLeak('board_show result', [result, s.child.stderr()], [f]);
  });
});

describe('accepted names over MCP', () => {
  it('each style is recorded exactly as given', async () => {
    const s = await served();
    for (const name of [
      'Ben',
      'ben.dechrai',
      'test_author',
      'ben@laptop',
      '0',
      `a${'b'.repeat(31)}`,
      'reviewer-3-2',
    ]) {
      const ok = await expectOk(s, 'board_comment', { id: s.id, text: 'hi', as: name });
      expect(eventActor(s.eventsDir, ok.hash), name).toBe(name);
    }
    await expectOk(s, 'board_handoff', {
      id: s.id,
      to: 'ben@laptop',
      status: 'todo',
      note: 'n',
      as: 'orch',
    });
    const shown = await expectOk(s, 'board_show', { id: s.id });
    expect((shown.ticket as { assignee: string }).assignee).toBe('ben@laptop');
  });

  it('the reserved actor keeps reason usage', async () => {
    const s = await served();
    const result = await call(s, 'board_comment', { id: s.id, text: 'x', as: 'agentboard' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as unknown as ToolError).reason).toBe('usage');
  });
});

describe('a failed call names no unchecked actor in its hint', () => {
  it('board_close with no disposition and as set to a token: the hint writes <actor>', async () => {
    const s = await served();
    for (const f of ACTORS_REFUSED) {
      const result = await call(s, 'board_close', { id: s.id, as: f.value });
      expect(result.isError).toBe(true);
      expectNoLeak(f.name, [result, s.child.stderr()], [f]);
      const error = result.structuredContent as unknown as ToolError;
      if (error.reason !== 'invalid-actor') {
        expect(error.hint ?? '').toContain('<actor>');
      }
    }
  });

  it('board_close with no disposition on a server whose AGENTBOARD_ACTOR is a token: <actor>', async () => {
    const f = refused('github-token');
    const s = await served(cliEnv({ AGENTBOARD_ACTOR: f.value }));
    const result = await call(s, 'board_close', { id: s.id });
    expect(result.isError).toBe(true);
    expectNoLeak(f.name, [result, s.child.stderr()], [f]);
    expect((result.structuredContent as unknown as ToolError).hint ?? '').toContain('<actor>');
  });
});
