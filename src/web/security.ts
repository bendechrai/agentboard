/**
 * The per-request security checks of `agentboard serve` (board-web:
 * "Access token", "Host header check", "No cross-origin access and
 * security headers", "Read-only server"; design.md: "An access token on
 * every API request, sent only as a bearer header", "Host header check and
 * no cross-origin access"; add-board-web task 3.1, reworked in round 2
 * after the security review: no cookie, no `?token=` entry URL, exactly
 * one Host header).
 *
 * Every function here is a pure function of the request line and headers
 * (plus the server's port and token), except `newToken`, which draws
 * random bytes. The server (`src/web/server.ts`) calls `checkRequest`
 * before any route and adds `securityHeaders` to every response, so the
 * whole policy is in this one audited module.
 *
 * Decisions recorded here (test author, add-board-web group 3):
 * - The HTTP refusal reasons (`unauthorized`, `forbidden-host`,
 *   `method-not-allowed`, and in the server `not-found` and
 *   `too-many-streams`) are `BoardError`s of exit class 1, like every
 *   other refusal of a request the caller got wrong; they carry the CLI
 *   hint of their reason (`src/guidance/hints.ts`) in the `ErrorDocument`.
 * - The token is accepted in exactly one form, `Authorization: Bearer
 *   <token>`, and only API paths (`isApiPath`, the stream included) need
 *   it. A `token` query parameter and every cookie are ignored on every
 *   path, and nothing here produces a cookie. The page and the static
 *   assets need no token (they hold no board data).
 * - The Host check comes first (exactly one `Host` header, on every path),
 *   then, on API paths only, the token, then the method, then the route.
 *   So an API request without a valid token is 401 whatever its method,
 *   including an `OPTIONS` preflight (browsers never send credentials on
 *   one), and an authenticated `OPTIONS` is 405; a non-API request with a
 *   method other than `GET` is 405 without any token. None ever carries an
 *   `Access-Control-Allow-*` header.
 * - `HEAD` is refused with 405 like every method but `GET`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { BoardError } from '../store/errors.js';

/** Random bytes in a token. */
export const TOKEN_BYTES = 32;

/** Characters of a token: 32 bytes in unpadded base64url. */
export const TOKEN_LENGTH = 43;

/**
 * The Content-Security-Policy of every response, exactly as board-web
 * states it.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The one method the server answers. */
export const ALLOWED_METHOD = 'GET';

/**
 * A new access token: `TOKEN_BYTES` bytes from the operating system's
 * cryptographic random source (`node:crypto` `randomBytes`), encoded as
 * unpadded base64url, so exactly `TOKEN_LENGTH` characters from
 * `[A-Za-z0-9_-]`. A new token at every call (every server start).
 */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * True exactly when `given` equals `token`. The comparison of the bytes is
 * constant time: both are encoded as UTF-8 and, when their byte lengths
 * are equal, compared with `crypto.timingSafeEqual`; when the lengths
 * differ the result is false (without calling `timingSafeEqual`, which
 * throws on unequal lengths, and without comparing any content). Never
 * throws. Pure.
 */
export function tokensEqual(given: string, token: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * True exactly when the request carries one `Host` header whose value is
 * `127.0.0.1:<port>` or `localhost:<port>`, compared as exact strings:
 * no other name or address (not `[::1]`, not `127.0.0.2`), no missing
 * port, no other port, no trailing dot, no surrounding space, no other
 * letter case. `host` is either the single value, or every value of the
 * header as received (`req.headersDistinct.host`, where `node:http` keeps
 * each repeated header); an array is allowed only when it holds exactly
 * one allowed value. Undefined (no header), an empty array and an array of
 * two or more values (even equal ones) are false. Pure.
 */
export function hostAllowed(host: string | readonly string[] | undefined, port: number): boolean {
  let value: string;
  if (typeof host === 'string') {
    value = host;
  } else if (host?.length === 1 && typeof host[0] === 'string') {
    value = host[0];
  } else {
    return false;
  }
  const suffix = `:${String(port)}`;
  return value === `127.0.0.1${suffix}` || value === `localhost${suffix}`;
}

/**
 * True for the API paths: `/api` and every path beginning with `/api/`
 * (the stream `/api/stream` included). Refusals on these paths are JSON
 * `ErrorDocument`s and their responses carry `Cache-Control: no-store`;
 * every other path is the page or an asset. Pure.
 */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * The headers every response carries, whatever its status (board-web: "No
 * cross-origin access and security headers"):
 * `Content-Security-Policy` (`CONTENT_SECURITY_POLICY`),
 * `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
 * `X-Frame-Options: DENY`, plus `Cache-Control: no-store` when `api` is
 * true (every API and stream response, errors included). Keys are in this
 * exact case. Never an `Access-Control-Allow-*` header. Pure; a new object
 * at every call.
 */
export function securityHeaders(api: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
  if (api) {
    headers['Cache-Control'] = 'no-store';
  }
  return headers;
}

/** How the token was presented: only ever `Authorization: Bearer`. */
export type TokenForm = 'bearer';

/** A request as the checks see it. */
export interface RequestHead {
  /** The request method as received (`GET`, `POST`, ...). */
  readonly method: string;
  /**
   * The request target as received (`/api/board?limit=5`): an
   * origin-form path with an optional query.
   */
  readonly url: string;
  /** The request headers, as `node:http` gives them (lower-case names). */
  readonly headers: IncomingHttpHeaders;
  /**
   * Every value of every header, as `node:http` gives them in
   * `req.headersDistinct` (lower-case names, repeated headers kept). The
   * Host check reads `headersDistinct.host`; when this field is absent the
   * request counts as having no `Host` header (403). The server always
   * passes it.
   */
  readonly headersDistinct?: NodeJS.Dict<string[]>;
}

/** What the checks compare with. */
export interface Guard {
  /** The port the server listens on. */
  readonly port: number;
  /** The access token of this server run. */
  readonly token: string;
}

/**
 * `['bearer']` when `head` has an `Authorization` header `Bearer <token>`
 * (the scheme `Bearer`, one space, the token) whose token equals
 * `guard.token` by `tokensEqual`; otherwise empty. A `token` query
 * parameter and every cookie are ignored, on every path and method. Pure.
 */
export function presentedTokens(head: RequestHead, guard: Guard): TokenForm[] {
  const authorization = head.headers.authorization;
  if (
    typeof authorization === 'string' &&
    authorization.startsWith(BEARER_PREFIX) &&
    tokensEqual(authorization.slice(BEARER_PREFIX.length), guard.token)
  ) {
    return ['bearer'];
  }
  return [];
}

/** The outcome of `checkRequest`. */
export type Verdict =
  /**
   * Refuse the request with `status` and `error` (an `ErrorDocument` on an
   * API path, a short plain text page otherwise; see `server.ts`). A 405
   * also carries `Allow: GET`.
   */
  | {
      readonly kind: 'refuse';
      readonly status: 401 | 403 | 405;
      /** `BoardError` exit 1 with reason `unauthorized`, `forbidden-host` or `method-not-allowed`. */
      readonly error: BoardError;
      /** `isApiPath(path)`. */
      readonly api: boolean;
    }
  /**
   * A `GET` that passed the checks (an API path with a valid bearer token,
   * or any other path): route `path` (the URL path, not decoded) with
   * `query`.
   */
  | {
      readonly kind: 'route';
      readonly path: string;
      readonly query: URLSearchParams;
      readonly api: boolean;
    };

/**
 * Every check of one request, in this order (design.md: "Order of checks
 * for every request: Host, then (on `/api/*` only) token, then method,
 * then route"):
 * 1. `hostAllowed(headersDistinct.host, port)` (exactly one allowed Host
 *    header; `headers.host` is not used, because `node:http` keeps only
 *    the first of repeated headers there), else refuse 403 with
 *    `BoardError(1, 'forbidden-host')`, on every path; no other header is
 *    looked at.
 * 2. On an API path only: `presentedTokens(head, guard)` non-empty (a
 *    valid bearer token), else refuse 401 with `BoardError(1,
 *    'unauthorized')` whose message tells the user to open the URL printed
 *    at start-up. The message never contains a token (not the server's,
 *    not the one presented). Other paths skip this step.
 * 3. The method is `GET`, else refuse 405 with `BoardError(1,
 *    'method-not-allowed')`.
 * 4. `route` with the path and query of `head.url` (a `token` query
 *    parameter is left in `query` and means nothing).
 * `api` is `isApiPath` of the path. Never returns `enter`. Pure.
 */
export function checkRequest(head: RequestHead, guard: Guard): Verdict {
  const { path, query } = splitTarget(head.url);
  const api = isApiPath(path);
  if (!hostAllowed(head.headersDistinct?.host, guard.port)) {
    return {
      kind: 'refuse',
      status: 403,
      error: new BoardError(
        1,
        'forbidden-host',
        `the request must carry exactly one Host header, 127.0.0.1:${String(guard.port)} or localhost:${String(guard.port)}`,
      ),
      api,
    };
  }
  if (api && presentedTokens(head, guard).length === 0) {
    return {
      kind: 'refuse',
      status: 401,
      error: new BoardError(
        1,
        'unauthorized',
        'no valid access token: open the URL printed by agentboard serve at start-up, or send Authorization: Bearer <token>',
      ),
      api,
    };
  }
  if (head.method !== ALLOWED_METHOD) {
    return {
      kind: 'refuse',
      status: 405,
      error: new BoardError(
        1,
        'method-not-allowed',
        'the agentboard web server is read-only and answers only GET',
      ),
      api,
    };
  }
  return { kind: 'route', path, query: new URLSearchParams(query), api };
}

/** The scheme and space of a bearer `Authorization` header. */
const BEARER_PREFIX = 'Bearer ';

/**
 * The path (everything before the first `?`) and the query (everything
 * after it, empty when there is none) of a request target. The path is not
 * decoded or normalised.
 */
function splitTarget(url: string): { path: string; query: string } {
  const mark = url.indexOf('?');
  return mark < 0
    ? { path: url, query: '' }
    : { path: url.slice(0, mark), query: url.slice(mark + 1) };
}
