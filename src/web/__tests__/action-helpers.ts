/**
 * Shared fixtures for the write action tests: a writable or read-only server on
 * a temporary project, tickets made through the in-process CLI, an action
 * poster that sets exactly the headers a test asks for, and helpers to read the
 * event files and the `ErrorDocument` of a refusal.
 *
 * The page of a writable server would send, for every action, exactly:
 * `Authorization: Bearer <token>`, `Content-Type: application/json` and
 * (as a browser does on every POST) `Origin: http://127.0.0.1:<port>`.
 * `post` sends those by default; a test overrides or removes any of them.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import { cliEnv, oneJson, run, type RunEnv } from '../../cli/__tests__/cli-helpers.js';
import { canonicalDecode, canonicalEncode } from '../../events/canonical.js';
import type { Ticket } from '../../events/fold.js';
import type { RunningServer, ServerOptions } from '../server.js';
import {
  json,
  open,
  project,
  request,
  serve,
  type Endpoint,
  type HttpResult,
} from './web-helpers.js';

/** The task every test ticket is linked to. */
export const TASK = 'openspec:add-board-web-actions#1';

/** The environment of every in-process CLI run and of every server: no actor, clean git. */
export function env(extra: RunEnv = {}): RunEnv {
  return cliEnv(extra);
}

/** Runs the CLI in process in `root` and asserts exit 0; returns the parsed `--json` document. */
export function cliOk(root: string, argv: readonly string[], runEnv: RunEnv = env()): unknown {
  const out = run([...argv, '--json'], root, runEnv);
  expect(out.code, `${argv.join(' ')}: ${out.stderr}`).toBe(0);
  return oneJson(out);
}

/** Creates a ticket (with a two-line checklist) through the CLI as `orch`; returns its id. */
export function newTicket(root: string, title = 'Served ticket'): string {
  const doc = cliOk(root, [
    'new',
    title,
    '--task',
    TASK,
    '--checklist',
    'one',
    '--checklist',
    'two',
    '--as',
    'orch',
  ]) as { ticket: { id: string } };
  return doc.ticket.id;
}

/** The ticket as `agentboard show <id> --json` reports it. */
export function showTicket(root: string, id: string): Ticket {
  return (cliOk(root, ['show', id]) as { ticket: Ticket }).ticket;
}

/** A project with a board, opened, and a server on it (`actor` makes it writable). */
export async function actionServer(options: ServerOptions = {}): Promise<{
  server: RunningServer;
  root: string;
  boardDir: string;
  eventsDir: string;
}> {
  const dirs = project();
  const board = open(dirs.boardDir);
  const server = await serve(board, { root: dirs.root, env: env(), ...options });
  return { server, ...dirs };
}

/** Options of `post`. */
export interface PostOptions {
  /**
   * Headers to add or replace (names in any case, matched without regard
   * to case against the defaults); a null value removes that header.
   */
  headers?: Record<string, string | null>;
  /** The `Host` header; default `127.0.0.1:<port>`. */
  host?: string;
  /** The method; default `POST`. */
  method?: string;
}

/** The headers the page of `server` sends with an action. */
export function pageHeaders(server: Endpoint): Record<string, string> {
  return {
    Authorization: `Bearer ${server.token}`,
    'Content-Type': 'application/json',
    Origin: `http://127.0.0.1:${String(server.port)}`,
  };
}

/**
 * Posts `body` (a string as is, anything else as JSON) to
 * `/api/actions/<action>` of `server` with `pageHeaders` adjusted by
 * `options.headers`.
 */
export function post(
  server: Endpoint,
  action: string,
  body: unknown,
  options: PostOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  const overrides = options.headers ?? {};
  const overridden = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(pageHeaders(server))) {
    if (!overridden.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== null) {
      headers[name] = value;
    }
  }
  return request(server.port, `/api/actions/${action}`, {
    method: options.method ?? 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(options.host === undefined ? {} : { host: options.host }),
  });
}

/** The event file names of an events directory, sorted (temporaries excluded). */
export function eventFiles(eventsDir: string): string[] {
  return readdirSync(eventsDir)
    .filter((name) => !name.startsWith('.'))
    .sort();
}

/** One event file, decoded. */
export interface DecodedEvent {
  readonly hash: string;
  readonly event: {
    v: number;
    kind: string;
    ticket?: string;
    actor: string;
    ts: { wall: number; counter: number; actor: string };
    body: unknown;
  };
  /** `canonicalEncode(event.body)`. */
  readonly bodyBytes: Buffer;
}

/** Decodes the event file `<eventsDir>/<name>`. */
export function readEvent(eventsDir: string, name: string): DecodedEvent {
  const event = canonicalDecode(readFileSync(join(eventsDir, name))) as DecodedEvent['event'];
  return {
    hash: name.replace(/\.json$/, ''),
    event,
    bodyBytes: Buffer.from(canonicalEncode(event.body)),
  };
}

/** The event files of `eventsDir` that are not in `before`, decoded. */
export function newEvents(eventsDir: string, before: readonly string[]): DecodedEvent[] {
  const known = new Set(before);
  return eventFiles(eventsDir)
    .filter((name) => !known.has(name))
    .map((name) => readEvent(eventsDir, name));
}

/** The `ErrorDocument.error` of a JSON refusal with `status`, `exitCode` and `reason`. */
export function refusal(
  result: HttpResult,
  status: number,
  exitCode: number,
  reason: string,
): { exitCode: number; reason: string; message: string; hint: string | null } {
  expect(result.status, result.body).toBe(status);
  const doc = json(result) as {
    error: { exitCode: number; reason: string; message: string; hint: string | null };
  };
  expect(Object.keys(doc)).toEqual(['error']);
  expect(doc.error.exitCode).toBe(exitCode);
  expect(doc.error.reason).toBe(reason);
  return doc.error;
}
