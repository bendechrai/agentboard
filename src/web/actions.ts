/**
 * The write actions of `agentboard serve --as <actor>` (board-web-actions:
 * "Write mode is opt-in with an explicit actor", "Action endpoints",
 * "Close from the browser", "Secret-like text is refused", "Cross-site
 * request forgery protection"; board-web: "Read-only server"; design.md of
 * add-board-web-actions: "One endpoint per command, MCP-shaped bodies, the
 * MCP conversion", "Status codes", "Close paths relative to the tree root",
 * "No secret-like override in the browser", "CSRF protection: structural,
 * with defence in depth"; add-board-web-actions tasks 1.2 and 1.3).
 *
 * `POST /api/actions/<action>` runs one registry command, converted from
 * the MCP-shaped JSON body by `toolArguments` (`src/mcp/tools.ts`) and run
 * by the command's own `run` in its single `BEGIN IMMEDIATE` transaction,
 * with a `RunContext` whose board is the server's open board, whose actor
 * is the server's `--as` and whose `cwd` is the root of the working tree
 * `serve` was started in. So validation, refusals and the event written
 * are exactly the CLI's and the MCP server's.
 *
 * Order of the checks of an action request in the server
 * (`src/web/server.ts`), each refusal writing nothing:
 * 1. Host, bearer token, method and path (`checkRequest`,
 *    `src/web/security.ts`): 403 `forbidden-host`, 401 `unauthorized`,
 *    405 `method-not-allowed`. Only `POST` to a path beginning with
 *    `ACTIONS_PREFIX` passes as an action.
 * 2. `csrfRefusal` (content type, then `Origin`): 403 `csrf-failed`.
 * 3. The body size: a `Content-Length` above `ACTION_BODY_LIMIT` is
 *    refused at once, and a body (of any transfer coding) is read only up
 *    to the limit; one byte more is 413 `body-too-large` (the rest of the
 *    body is not read; the connection may be closed after the response).
 * 4. `runAction` with the body text: 405 `read-only` on a server without
 *    an actor, 404 `not-found` for another action name, then the body and
 *    the command (see `runAction`).
 * So every `POST`, whatever server and whatever action name, passes the
 * CSRF rules and the size limit before anything else is decided about it
 * (task 1.3: "ahead of every action, after the Host and bearer token
 * checks"), and the `read-only` scenario of board-web ("an authenticated
 * same-origin `POST`") is answered after them.
 *
 * Decisions recorded here (test author, add-board-web-actions group 1):
 * - The CSRF check is applied, in this order, before the read-only check
 *   and before the action name is looked up, so a request failing it is
 *   403 `csrf-failed` on every server and for every name.
 * - More than one `Origin` header is refused as `csrf-failed`, whatever
 *   the values, as more than one `Host` or `Authorization` header is
 *   refused: `node:http` keeps only the first in `req.headers`.
 * - More than one `Content-Type` header (as `headersDistinct` counts them)
 *   is refused as `csrf-failed`.
 * - The media type `application/json`, the parameter name `charset` and
 *   its value `utf-8` are compared without regard to ASCII letter case
 *   (RFC 9110 section 8.3.1); the value may be quoted, and optional
 *   whitespace around the `;` is allowed. Any other charset (`utf-16`,
 *   `iso-8859-1`, `utf8`, ...), any parameter other than `charset`, or a
 *   second parameter, is refused: the body is always decoded as UTF-8.
 * - The refused body properties `as`, `json` and `allow-secret-like` are
 *   refused whenever present, whatever their value (`"as": ""` and
 *   `"allow-secret-like": false` included).
 * - A body that is not valid JSON (an empty body included), or valid JSON
 *   that is not one object (`null`, an array, a number, a string, a
 *   boolean), is 400 `usage` with the message "the request body must be
 *   one JSON object".
 * - For an action, `unknown-ticket` is exit 4 and therefore 409, as the
 *   spec's status rule says ("409 for exit 4"); only the `GET` routes
 *   answer it with 404.
 * - The hint of a refusal of the command (from `toolArguments` or the
 *   command's `run`) is rendered with `{ surface: 'cli', command: <the
 *   registry command>, id: <the body's id when a non-empty string>,
 *   actor: <the server's actor> }`, so a claim refused `already-assigned`
 *   hints `'agentboard inbox --as <server actor>'`. The server's own
 *   refusals (`read-only`, `csrf-failed`, `body-too-large`, `not-found`)
 *   are rendered with `API_HINT_CONTEXT` (command `serve`, no actor).
 */

import { realpathSync } from 'node:fs';

import { worktreeRoot } from '../board/paths.js';
import { LazyBoard, errorDocument, runContext } from '../cli/main.js';
import { findCommand } from '../cli/registry.js';
import type { ArgValues, CommandSpec, Env, RunContext } from '../cli/types.js';
import type { HintContext } from '../guidance/hints.js';
import { toolArguments } from '../mcp/tools.js';
import type { Board } from '../store/board.js';
import { BoardError } from '../store/errors.js';
import { API_HINT_CONTEXT, type ApiResult } from './api.js';
import type { RequestHead } from './security.js';

/**
 * The action names, in registry order: each is the registry command name
 * with the space written as `-` (`checklist tick` is `checklist-tick`).
 */
export const ACTION_NAMES = [
  'claim',
  'release',
  'move',
  'comment',
  'handoff',
  'link',
  'checklist-tick',
  'checklist-untick',
  'close',
] as const;

/** One action name. */
export type ActionName = (typeof ACTION_NAMES)[number];

/** Largest accepted body of an action request, in bytes: 64 KiB. */
export const ACTION_BODY_LIMIT = 65536;

/**
 * Body properties refused with 400 `usage` even though the command's MCP
 * tool accepts them: the actor is the server's, `--json` is implied, and
 * the browser has no secret-like override.
 */
export const REFUSED_PROPERTIES: readonly string[] = ['as', 'json', 'allow-secret-like'];

/**
 * The registry command of an action name: `claim` is the command `claim`,
 * `checklist-tick` the command `checklist tick`, and so on for every name
 * in `ACTION_NAMES`; undefined for any other string (`new`, `show`,
 * `checklist tick`, `checklist_tick`, `Claim`, `serve`, the empty string,
 * ...). The returned object is the registry entry itself (`findCommand`).
 * Pure.
 */
export function actionCommand(action: string): CommandSpec | undefined {
  if (!(ACTION_NAMES as readonly string[]).includes(action)) {
    return undefined;
  }
  return findCommand(action.replace('-', ' '));
}

/**
 * True exactly when `value` is one `Content-Type` value whose media type
 * is `application/json`, optionally followed by the one parameter
 * `charset=utf-8`: `application/json`, `application/json; charset=utf-8`,
 * `application/json;charset=UTF-8`, `application/json; charset="utf-8"`,
 * `Application/JSON` (case-insensitive type, parameter name and charset
 * value, the value optionally quoted, optional whitespace around `;`).
 * False for undefined, an empty array, an array of two or more values, any
 * other media type (`application/x-www-form-urlencoded`,
 * `multipart/form-data`, `text/plain`, `application/jsonx`,
 * `application/json-patch+json`), any other charset (`utf-16`,
 * `UTF-16LE`, `iso-8859-1`, `us-ascii`, `utf8`, an empty value), since the
 * body is always decoded as UTF-8, any parameter other than `charset`
 * (`application/json; boundary=x`) and two parameters. `value` is `req.headersDistinct['content-type']` (an
 * array of every value received) or a single string. Pure.
 */
export function contentTypeAllowed(value: string | readonly string[] | undefined): boolean {
  const single = onlyValue(value);
  if (single === undefined) {
    return false;
  }
  const [type, ...parameters] = single.split(';');
  if (type === undefined || type.trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    return false;
  }
  if (parameters.length === 0) {
    return true;
  }
  return parameters.length === 1 && CHARSET_PARAMETER.test(parameters[0]?.trim() ?? '');
}

/** The one media type an action body may have. */
const JSON_MEDIA_TYPE = 'application/json';

/** The one parameter allowed after it: `charset=utf-8`, the value optionally quoted. */
const CHARSET_PARAMETER = /^charset=(?:utf-8|"utf-8")$/i;

/**
 * The value of a header that must occur exactly once: the string itself,
 * or the only element of a one-element array; undefined for no header or
 * a repeated one.
 */
function onlyValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return value?.length === 1 ? value[0] : undefined;
}

/**
 * The `Origin` rule: true when `origin` is undefined or an empty array (no
 * `Origin` header: not a browser, accepted), or when it holds exactly one
 * value that is exactly `http://127.0.0.1:<port>` or
 * `http://localhost:<port>` and names the same host as `host`, the single
 * value of the `Host` header (`127.0.0.1:<port>` goes with
 * `http://127.0.0.1:<port>`, `localhost:<port>` with
 * `http://localhost:<port>`). False for anything else: another scheme,
 * host, port or letter case, a trailing slash or path, `null`, an empty
 * value, two or more `Origin` headers (even equal ones), and an allowed
 * origin whose host differs from `host` (`Origin: http://localhost:<port>`
 * with `Host: 127.0.0.1:<port>`). `origin` and `host` are the
 * `headersDistinct` arrays or single strings. Pure.
 */
export function originAllowed(
  origin: string | readonly string[] | undefined,
  host: string | readonly string[] | undefined,
  port: number,
): boolean {
  if (origin === undefined || (typeof origin !== 'string' && origin.length === 0)) {
    return true;
  }
  const given = onlyValue(origin);
  const named = onlyValue(host);
  if (given === undefined || named === undefined) {
    return false;
  }
  return LOOPBACK_NAMES.some(
    (name) => given === `http://${name}:${String(port)}` && named === `${name}:${String(port)}`,
  );
}

/** The host names of the page's own origin. */
const LOOPBACK_NAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/**
 * The CSRF rules of every `POST` (board-web-actions: "Cross-site request
 * forgery protection"), after the Host and token checks: null when
 * `contentTypeAllowed(head.headersDistinct['content-type'])` and
 * `originAllowed(head.headersDistinct.origin, head.headersDistinct.host,
 * port)` both hold; otherwise `BoardError(1, 'csrf-failed')` whose message
 * names what failed (the content type, checked first, or the `Origin`) and
 * never contains a header value it refused beyond the name of the rule.
 * An absent `headersDistinct` counts as no header at all (so no content
 * type: refused). No cookie, no CSRF token and no custom header is looked
 * at. Pure.
 */
export function csrfRefusal(head: RequestHead, port: number): BoardError | null {
  const headers = head.headersDistinct;
  if (!contentTypeAllowed(headers?.['content-type'])) {
    return new BoardError(
      1,
      'csrf-failed',
      'an action must be sent as one Content-Type: application/json header (optionally with charset=utf-8)',
    );
  }
  if (!originAllowed(headers?.origin, headers?.host, port)) {
    return new BoardError(
      1,
      'csrf-failed',
      'an action sent with an Origin header must come from the page of this server, at the same address as the Host header',
    );
  }
  return null;
}

/**
 * The HTTP status of a refusal thrown while converting or running an
 * action's command (board-web-actions: "Action endpoints"): 503 for a
 * `BoardError` with reason `busy`; else 400 for exit class 1, 409 for
 * exit class 4, and 500 for every other exit class and for anything that
 * is not a `BoardError`. Pure.
 */
export function actionStatus(error: unknown): number {
  if (!(error instanceof BoardError)) {
    return 500;
  }
  if (error.reason === 'busy') {
    return 503;
  }
  return error.exitCode === 1 ? 400 : error.exitCode === 4 ? 409 : 500;
}

/**
 * The parsed arguments of an action body for `command`: throws
 * `BoardError(1, 'usage')` naming the property when `body` is a JSON
 * object holding any of `REFUSED_PROPERTIES` (whatever its value), and
 * otherwise returns `toolArguments(command, body)` (`src/mcp/tools.ts`),
 * with its own refusals, reasons and messages (a body that is not an
 * object, an unknown property, a wrong type, a missing argument, an
 * exclusive group given twice or not at all). Pure.
 */
export function actionArguments(command: CommandSpec, body: unknown): ArgValues {
  if (isObject(body)) {
    for (const name of REFUSED_PROPERTIES) {
      if (Object.hasOwn(body, name)) {
        throw new BoardError(
          1,
          'usage',
          `the property ${name} is not accepted: ${REFUSED_WHY[name] ?? ''}`,
        );
      }
    }
  }
  return toolArguments(command, body);
}

/** Why each refused property is refused (the text of the `usage` message). */
const REFUSED_WHY: Readonly<Record<string, string>> = {
  as: 'every action is written as the actor the server was started with (agentboard serve --as <actor>)',
  json: 'the response is always the JSON document',
  'allow-secret-like':
    'the web app has no override for secret-like text; use the CLI for a false positive',
};

/** A JSON object (not an array, not null). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The root of the working tree that contains `cwd`: the output of `git
 * rev-parse --show-toplevel` run in `cwd` with `env` (realpath), or the
 * realpath of `cwd` itself when that fails (not in a git repository, git
 * missing). The `cwd` of every action (design.md: "Close paths relative to
 * the tree root").
 */
export function actionRoot(cwd: string, env: Env): string {
  return realpathSync(worktreeRoot(cwd, env) ?? cwd);
}

/** What an action runs with: fixed for the life of the server. */
export interface ActionContext {
  /** The server's open board; every action writes through it. */
  readonly board: Board;
  /**
   * The server's `--as` actor, recorded on every event written; null on a
   * read-only server (every action is then refused `read-only`).
   */
  readonly actor: string | null;
  /**
   * The root of the working tree `serve` was started in (`actionRoot`):
   * the `cwd` of the run context, so a relative decision path is relative
   * to it.
   */
  readonly root: string;
  /** The environment of the run context (for `git` in decision paths). */
  readonly env: Env;
}

/**
 * The `RunContext` of an action (shared shape with the CLI's and the MCP
 * server's contexts, `runContext` in `src/cli/main.ts`): `cwd` is
 * `ctx.root`, `env` is `ctx.env`, `actor` is `ctx.actor`, `boardDir()`
 * returns `ctx.board.dir` and `board()` returns `ctx.board` itself, whatever
 * options it is given (the server's board is already open and caught up;
 * the transaction catches up again under the write lock), never opening or
 * closing anything. Pure.
 */
export function actionContext(ctx: ActionContext): RunContext {
  return runContext(ctx.root, ctx.env, ctx.actor, new ServerBoard(ctx.board));
}

/**
 * The server's open board as the `LazyBoard` of a run context (shared with
 * the CLI and the MCP server, `runContext`): already open, so `get`
 * returns it whatever options it is given. The inherited `close` only
 * closes a board the base class opened itself, which never happens here
 * (`get` is overridden), so it leaves the server's board open; the server
 * closes its board when it stops.
 */
class ServerBoard extends LazyBoard {
  private readonly open: Board;

  constructor(board: Board) {
    super(
      () => board.dir,
      () => undefined,
    );
    this.open = board;
  }

  override get(): Board {
    return this.open;
  }
}

/**
 * The response to `POST /api/actions/<action>` with the body `text` (the
 * request body decoded as UTF-8), once the request passed the Host, token,
 * method, CSRF and size checks. Never throws. In order:
 * 1. `ctx.actor` null: 405 with `BoardError(1, 'read-only')`, whose
 *    message says the server was started without `--as` (the hint names
 *    `'agentboard serve --as <actor>'`).
 * 2. `actionCommand(action)` undefined: 404 with `BoardError(1,
 *    'not-found')` naming the actions.
 * 3. `text` parsed as JSON; a parse failure (an empty text included), or a
 *    value that is not one JSON object (`null`, an array, a number, a
 *    string, a boolean), is 400 with `BoardError(1, 'usage')` and the
 *    message "the request body must be one JSON object", before any
 *    argument conversion.
 * 4. `actionArguments(command, body)`.
 * 5. `command.run(actionContext(ctx), values)`: the command's own
 *    operation in its single `BEGIN IMMEDIATE` transaction.
 * Success: `{ status: 200, body: output.json }`, the document the CLI
 * prints with `--json` (for a write, `{ hash, ticket }`, with `hash` null
 * when nothing was written, as for a claim by the current holder; for a
 * checklist tick or untick, also its `reminder`). Warnings of the output
 * are not part of the response.
 * Failure in steps 3 to 5: `{ status: actionStatus(error), body:
 * errorDocument(error, context) }` with the command's hint context (see
 * the module comment); in steps 1 and 2, the status given there and
 * `errorDocument(error, API_HINT_CONTEXT)`. A failure writes no event.
 */
export function runAction(ctx: ActionContext, action: string, text: string): ApiResult {
  if (ctx.actor === null || ctx.actor === '') {
    return {
      status: 405,
      body: errorDocument(
        new BoardError(
          1,
          'read-only',
          'this server is read-only: it was started without --as, so it accepts no action',
        ),
        API_HINT_CONTEXT,
      ),
    };
  }
  const command = actionCommand(action);
  if (command === undefined) {
    return {
      status: 404,
      body: errorDocument(
        new BoardError(
          1,
          'not-found',
          `no such action; the actions are ${ACTION_NAMES.join(', ')}`,
        ),
        API_HINT_CONTEXT,
      ),
    };
  }
  let context: HintContext = { surface: 'cli', command: command.name, actor: ctx.actor };
  try {
    const notObject = new BoardError(1, 'usage', 'the request body must be one JSON object');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw notObject;
    }
    if (!isObject(body)) {
      throw notObject;
    }
    if (typeof body.id === 'string' && body.id !== '') {
      context = { ...context, id: body.id };
    }
    const values = actionArguments(command, body);
    const output = command.run(actionContext(ctx), values);
    return { status: 200, body: output.json };
  } catch (error) {
    return { status: actionStatus(error), body: errorDocument(error, context) };
  }
}
