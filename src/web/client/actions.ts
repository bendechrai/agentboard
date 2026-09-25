/**
 * The web client's side of the write actions of `agentboard serve --as
 * <actor>` (board-web-actions: "Action endpoints", "Action controls in the
 * web app", "Cross-site request forgery protection"; design.md of
 * add-board-web-actions: "One endpoint per command, MCP-shaped bodies, the
 * MCP conversion", "Status codes", "The page"; add-board-web-actions task
 * 2.1). `src/web/actions.ts` holds the server's contract.
 *
 * Every action is `POST /api/actions/<action>` on the page's own origin,
 * with the JSON body the command's MCP tool takes, `Content-Type:
 * application/json` and the same `Authorization: Bearer <token>` header as
 * every other API request (`apiHeaders`, `api.ts`). No cookie, no CSRF
 * token and no other custom header is sent; the token is never put in the
 * URL or the body; the body never holds `as`, `json` or
 * `allow-secret-like` (the server refuses them).
 *
 * Decisions recorded here (test author, add-board-web-actions group 2):
 * - `postAction` never rejects: every outcome, a network failure included,
 *   is an `ActionResult`, so a control always has something to show.
 * - A refusal whose body is not an `ErrorDocument` gets a document of its
 *   own: exit code 1, reason null, hint null and a message naming the
 *   action and the status (or, with no response, the network failure).
 * - A 401 is returned like any other refusal; the caller (the ticket
 *   view) reports it to the app, which discards the token and shows the
 *   message to open the URL printed by `agentboard serve`, as for a 401
 *   of any other request.
 * - A 200 whose body is not JSON is a refusal with status 200 and a
 *   message saying the body is not JSON (nothing is applied).
 * - The shapes the client relies on are declared here, structurally, so
 *   the client project imports no module that needs Node.
 */

import type { Ticket } from '../../events/fold.js';
import type { Status } from '../../events/schema.js';
import type { Connection, ErrorDocument } from './api.js';

/**
 * The action names, in the server's order (`ACTION_NAMES` of
 * `src/web/actions.ts`): each is the registry command name with the space
 * written as `-`.
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

/**
 * The body of each action: the command's MCP tool arguments, named as in
 * its input schema. `id` is always the ticket's full id.
 */
export interface ActionBodies {
  claim: { id: string };
  release: { id: string };
  move: { id: string; status: Status };
  comment: { id: string; text: string };
  handoff: { id: string; to: string; status: Status; note: string };
  /** Exactly one of a task reference (`<source>:<ref>#<item>`), a pull request or a decision path. */
  link:
    { id: string; task: string } | { id: string; pr: string } | { id: string; decision: string };
  /** `index` counted from 0, as `agentboard checklist tick`. */
  'checklist-tick': { id: string; index: number };
  'checklist-untick': { id: string; index: number };
  /** Exactly one disposition. */
  close: { id: string; 'decision-recorded-in': string } | { id: string; 'no-decision': true };
}

/** The tasks-file reminder of a checklist tick (`TaskReminder` of the CLI's `--json`). */
export interface ActionReminder {
  message: string;
}

/**
 * The document of a successful action: what the CLI prints with `--json`
 * for the command (`WriteOutcome`, and for a checklist tick or untick
 * `ChecklistOutcome`, whose `reminder` is null for an untick). `hash` is
 * null when nothing was written (a claim by the current holder).
 */
export interface ActionSuccess {
  hash: string | null;
  /** The ticket after the action. */
  ticket: Ticket;
  /** Present only for `checklist-tick` and `checklist-untick`. */
  reminder?: ActionReminder | null;
}

/** The outcome of one action request. */
export type ActionResult =
  | { ok: true; status: number; document: ActionSuccess }
  | {
      ok: false;
      /** The HTTP status, or 0 when no response was received. */
      status: number;
      /** The response's `ErrorDocument`, or one made up as the module comment says. */
      error: ErrorDocument;
    };

/** `/api/actions/<action>`. Pure. */
export function actionPath(action: ActionName): string {
  void action;
  throw new Error('not implemented');
}

/**
 * The headers of an action request: `apiHeaders(token)` (`Accept:
 * application/json` and `Authorization: Bearer <token>`) plus
 * `Content-Type: application/json`, and nothing else. Pure.
 */
export function actionHeaders(token: string): Record<string, string> {
  void token;
  throw new Error('not implemented');
}

/**
 * Posts one action: `conn.deps.fetch(actionPath(action), { method:
 * 'POST', headers: actionHeaders(conn.token), body: JSON.stringify(body)
 * })`, with no other request option (no `credentials`, no `mode`). Resolves
 * with:
 * - a 2xx response with a JSON body: `{ ok: true, status, document }`;
 * - any other response: `{ ok: false, status, error }` with the body when
 *   it is an `ErrorDocument` (for example 409 `already-assigned`, 400
 *   `unpromoted-decision`, 503 `busy`, 401 `unauthorized`), else a made-up
 *   document (module comment);
 * - `fetch` rejecting: `{ ok: false, status: 0, error }` with exit code 1,
 *   reason null, hint null and a message naming the action and the
 *   failure.
 * Never rejects.
 */
export async function postAction<A extends ActionName>(
  conn: Connection,
  action: A,
  body: ActionBodies[A],
): Promise<ActionResult> {
  await Promise.resolve();
  void conn;
  void action;
  void body;
  throw new Error('not implemented');
}
