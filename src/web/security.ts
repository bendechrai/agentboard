/**
 * The per-request security checks of `agentboard serve` (board-web:
 * "Access token", "Host header check", "No cross-origin access and
 * security headers", "Read-only server"; design.md: "An access token on
 * every request, carried by a per-port cookie", "Host header check and no
 * cross-origin access"; add-board-web task 3.1).
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
 * - Every accepted token form is checked for every request; the request is
 *   authenticated when any accepted form carries the token. A `token`
 *   query parameter counts only on `GET /` (path exactly `/`), and there a
 *   valid one is always answered with the 303, whatever else the request
 *   carries. An invalid query token on `GET /` is not a refusal by itself:
 *   a valid cookie or bearer token on the same request still
 *   authenticates it.
 * - The Host check comes first, then the token, then the method, then the
 *   route. So a request without a valid token is 401 whatever its method,
 *   including an `OPTIONS` preflight (browsers never send credentials on
 *   one); an authenticated `OPTIONS` is 405. Neither ever carries an
 *   `Access-Control-Allow-*` header.
 * - `HEAD` is refused with 405 like every method but `GET`.
 */

import type { IncomingHttpHeaders } from 'node:http';

import type { BoardError } from '../store/errors.js';

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
  throw new Error('not implemented');
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
  void given;
  void token;
  throw new Error('not implemented');
}

/**
 * The name of the session cookie of the server on `port`:
 * `agentboard-<port>` (the port in decimal). Browsers do not isolate
 * cookies by port, so the name carries it and two servers on one machine
 * never overwrite each other's cookie. Pure.
 */
export function cookieName(port: number): string {
  void port;
  throw new Error('not implemented');
}

/**
 * The `Set-Cookie` value sent with the 303 answer to the entry URL:
 * `agentboard-<port>=<token>; HttpOnly; SameSite=Strict; Path=/`. No
 * `Max-Age` and no `Expires` (a session cookie), no `Domain`, and no
 * `Secure` (the server speaks plain HTTP on loopback). Pure.
 */
export function sessionCookie(port: number, token: string): string {
  void port;
  void token;
  throw new Error('not implemented');
}

/**
 * True exactly when `host` (the `Host` header as received) is
 * `127.0.0.1:<port>` or `localhost:<port>`, compared as exact strings:
 * no other name or address (not `[::1]`, not `127.0.0.2`), no missing
 * port, no other port, no trailing dot, no surrounding space, no other
 * letter case. A missing header (undefined) or a repeated one (an array)
 * is false. Pure.
 */
export function hostAllowed(host: string | readonly string[] | undefined, port: number): boolean {
  void host;
  void port;
  throw new Error('not implemented');
}

/**
 * True for the API paths: `/api` and every path beginning with `/api/`
 * (the stream `/api/stream` included). Refusals on these paths are JSON
 * `ErrorDocument`s and their responses carry `Cache-Control: no-store`;
 * every other path is the page or an asset. Pure.
 */
export function isApiPath(path: string): boolean {
  void path;
  throw new Error('not implemented');
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
  void api;
  throw new Error('not implemented');
}

/** How the token was presented. */
export type TokenForm = 'query' | 'cookie' | 'bearer';

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
}

/** What the checks compare with. */
export interface Guard {
  /** The port the server listens on. */
  readonly port: number;
  /** The access token of this server run. */
  readonly token: string;
}

/**
 * The token forms of `head` that carry `guard.token`, each compared with
 * `tokensEqual`, in the order query, cookie, bearer:
 * - `query`: only when the method is `GET` and the path is exactly `/`:
 *   the first `token` query parameter;
 * - `cookie`: the value of the cookie named `cookieName(guard.port)` in
 *   the `Cookie` header (cookies are `name=value` pairs separated by `;`
 *   and optional spaces; other cookies, including another port's
 *   `agentboard-<other>`, are ignored);
 * - `bearer`: an `Authorization` header `Bearer <token>` (the scheme
 *   `Bearer`, one space, the token).
 * Empty when none does. Pure.
 */
export function presentedTokens(head: RequestHead, guard: Guard): TokenForm[] {
  void head;
  void guard;
  throw new Error('not implemented');
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
   * The entry URL with a valid token: answer `303 See Other` with
   * `Location: /` and `Set-Cookie: <setCookie>`.
   */
  | { readonly kind: 'enter'; readonly setCookie: string }
  /** Authenticated `GET`: route `path` (the URL path, not decoded) with `query`. */
  | {
      readonly kind: 'route';
      readonly path: string;
      readonly query: URLSearchParams;
      readonly api: boolean;
    };

/**
 * Every check of one request, in this order (design.md: "Order of checks
 * for every request: Host, then token, then method, then route"):
 * 1. `hostAllowed(headers.host, port)`, else refuse 403 with
 *    `BoardError(1, 'forbidden-host')`; no other header is looked at.
 * 2. `presentedTokens(head, guard)` non-empty, else refuse 401 with
 *    `BoardError(1, 'unauthorized')` whose message tells the user to open
 *    the URL printed at start-up. The message never contains a token (not
 *    the server's, not the one presented).
 * 3. The method is `GET`, else refuse 405 with `BoardError(1,
 *    'method-not-allowed')`.
 * 4. When the presented forms include `query` (so this is `GET /` with a
 *    valid `token` parameter): `enter` with `sessionCookie(port, token)`.
 * 5. Otherwise `route` with the path and query of `head.url`.
 * `api` is `isApiPath` of the path. Pure.
 */
export function checkRequest(head: RequestHead, guard: Guard): Verdict {
  void head;
  void guard;
  throw new Error('not implemented');
}
